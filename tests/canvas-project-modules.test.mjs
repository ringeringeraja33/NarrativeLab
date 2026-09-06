import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import ts from 'typescript';

const sources = Object.fromEntries(await Promise.all(['canvas-runtime/app.js', 'canvas-runtime/main.js', 'main.ts', 'components/ViewSwitcher.ts'].map(async path =>
    [path, await readFile(new URL(`../${path}`, import.meta.url), 'utf8')])));
const declarations = new Map();
function declaration(path, name, method = false) {
    const key = `${path}:${name}:${method}`;
    if (declarations.has(key)) return declarations.get(key);
    const source = ts.createSourceFile(path, sources[path], ts.ScriptTarget.Latest, true);
    let found;
    function visit(node) {
        if ((method ? ts.isMethodDeclaration(node) : ts.isFunctionDeclaration(node)) && node.name?.getText(source) === name) { found ??= node; return; }
        ts.forEachChild(node, visit);
    }
    visit(source);
    assert.ok(found, `${name} exists in ${path}`);
    const text = found.getText(source);
    declarations.set(key, text);
    return text;
}
function bindFunctions(names, env) {
    return new Function(...Object.keys(env), names.map(name => declaration('canvas-runtime/app.js', name)).join('\n') + `\nreturn {${names.join(',')}};`)(...Object.values(env));
}
function bindMethod(name, env = {}, path = 'canvas-runtime/main.js') {
    const text = ts.transpileModule(`class Subject { ${declaration(path, name, true)} }`, { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText;
    return new Function(...Object.keys(env), `${text}; return Subject.prototype.${name};`)(...Object.values(env));
}
const copy = value => structuredClone(value);
const normalizeVaultPath = path => String(path || '').replaceAll('\\', '/');
const isPathUnderLibraryRoots = (path, roots) => roots.some(root => path.startsWith(`${root}/`));
class TFile { constructor(path, name = '资料') { this.path = path; this.extension = 'md'; this.stat = { mtime: 1, size: 12 }; this.name = name; } }
class TFolder { constructor(children) { this.children = children; } }
function appHarness(project, host) {
    const state = { project: copy(project), theme: 'light' }, confirmations = [], calls = [];
    const env = {
        state, window: host ? { NarrativeCanvasHost: host } : {},
        getCharacters: () => state.project.characters,
        getCharacterById: id => state.project.characters.find(entry => entry.id === id),
        getCharacterBacklinkGroups: entry => [{ items: state.project.nodes.filter(node => node.cast?.some(ref => ref.characterId === entry.id)) }],
        normalizeCharacter: copy, normalizeCharacters: copy, normalizeNodeCast: value => copy(value || []),
        invalidateCharacterRenderContext() {}, renderCharacterAwareSurfaces() {},
        setProjectDirty: value => { state.hasUnsavedChanges = value; },
        setStatus: text => calls.push(['status', text]), t: text => text,
        showGenericConfirm: options => confirmations.push(options),
        getHistorySnapshot: () => copy(state.project), commitHistoryFromSnapshot: before => calls.push(['history', before]),
        saveCurrentState: async () => { calls.push(['save']); return true; },
        normalizeProject: copy, cloneProject: copy, getSavedSidebarState: () => ({}),
        SAVED_STATE_VERSION: 1, DEFAULT_CANVAS_ZOOM: 1, CODEX_ALL_FILTER: 'all',
    };
    const api = bindFunctions(['isProjectLibraryEnabled', 'isProjectLibraryEntry', 'canvasReferenceEntries', 'preserveLegacyLibraryEntry', 'removeCanvasReference',
        'migrateCanvasLibraryEntry', 'performCanvasLibraryMigration', 'prepareForNavigation', 'reloadCodexFiles', 'buildSavedStateForProject'], env);
    return { api, env, state, confirmations, calls };
}
const legacy = { id: 'legacy', name: '论据', notes: '旧的材料', kind: 'Lore', codexFile: '' };
const shared = { id: 'shared', name: '论据', notes: '唯一原文', extraFields: [{ key: 'year', value: 2026 }], codexFile: 'Book/Library/论据.md', kind: 'Lore' };
const project = { characters: [legacy, shared], nodes: [{ id: 'node', text: '正文不变', cast: [{ characterId: 'legacy', role: '支持', note: '页码 12' }] }], libraryEntryIds: ['shared'] };

test('canvas serialization stores external references without duplicating source bodies or fields', () => {
    const h = appHarness(project, {});
    const saved = h.api.buildSavedStateForProject(h.state.project).project;
    assert.deepEqual(saved.characters[1], { id: 'shared', name: '论据', kind: 'Lore', codexFile: shared.codexFile });
    assert.equal(saved.characters[0].notes, legacy.notes);
    assert.equal(h.state.project.characters[1].notes, shared.notes);
    assert.equal(saved.libraryReferencesVersion, 1);
});
test('web project Library keeps one canonical body in its project save', () => {
    const h = appHarness(project);
    const saved = h.api.buildSavedStateForProject(h.state.project).project;
    assert.equal(saved.characters[1].notes, shared.notes);
    assert.deepEqual(saved.libraryEntryIds, ['shared']);
});
test('removing a reference keeps the original file and node text, preserving legacy copies', () => {
    const h = appHarness(project, { deleteCodexEntryFile() { assert.fail('Must not delete source files'); } });
    h.api.removeCanvasReference('legacy');
    h.confirmations.shift().onConfirm();
    assert.equal(h.state.project.nodes[0].text, '正文不变');
    assert.deepEqual(h.state.project.nodes[0].cast, []);
    assert.equal(h.state.project.legacyLibraryEntries[0].notes, legacy.notes);
    assert.equal(h.state.project.characters[0].notes, shared.notes);
    h.api.removeCanvasReference('shared'); h.confirmations.shift().onConfirm();
    assert.deepEqual(h.state.project.characters, []);
});
test('removing a web reference retains canonical project Library data', () => {
    const h = appHarness(project);
    h.api.removeCanvasReference('shared'); h.confirmations.shift().onConfirm();
    assert.ok(h.state.project.characters.some(entry => entry.id === 'shared'));
    assert.ok(!h.api.canvasReferenceEntries().some(entry => entry.id === 'shared'));
});
test('a delayed remove confirmation cannot change another project', () => {
    const h = appHarness(project); h.api.removeCanvasReference('legacy');
    const other = { characters: [], nodes: [] }; h.state.project = other;
    h.confirmations.shift().onConfirm();
    assert.deepEqual(other, { characters: [], nodes: [] });
});
test('web same-name migration requires confirmation, preserves the legacy copy and node relationship fields', async () => {
    const h = appHarness(project);
    await h.api.migrateCanvasLibraryEntry('legacy');
    assert.equal(h.state.project.characters.length, 2);
    assert.equal(h.confirmations.length, 1);
    await h.confirmations.shift().onConfirm();
    assert.deepEqual(h.state.project.characters.map(entry => entry.id), ['shared']);
    assert.equal(h.state.project.characters[0].notes, shared.notes);
    assert.equal(h.state.project.legacyLibraryEntries[0].notes, legacy.notes);
    assert.deepEqual(h.state.project.nodes[0].cast, [{ characterId: 'shared', role: '支持', note: '页码 12' }]);
});
test('migration is deduplicated and navigation waits for migration before saving', async () => {
    let finish, writes = 0;
    const h = appHarness(project, { migrateLibraryEntry: () => { writes++; return new Promise(resolve => { finish = resolve; }); } });
    const first = h.api.migrateCanvasLibraryEntry('legacy');
    const second = h.api.migrateCanvasLibraryEntry('legacy');
    const navigation = h.api.prepareForNavigation();
    assert.equal(writes, 1); assert.equal(h.calls.length, 0);
    finish({ entry: shared });
    await Promise.all([first, second, navigation]);
    assert.equal(h.calls.filter(([type]) => type === 'save').length, 1);
    assert.equal(h.state.project.legacyLibraryEntries[0].notes, legacy.notes);
});
test('disabled Library performs no migration or reference reads', async () => {
    const h = appHarness(project, { isProjectLibraryEnabled: () => false, migrateLibraryEntry() { assert.fail(); }, loadCodexEntries() { assert.fail(); } });
    await h.api.migrateCanvasLibraryEntry('legacy');
    assert.equal(await h.api.reloadCodexFiles(), false);
    assert.deepEqual(h.state.project, project);
});
test('reference refresh reads only referenced files, preserves missing sources and rejects stale project results', async () => {
    let finish, options;
    const h = appHarness(project, { getCurrentProjectPath: () => 'Book/Canvas/a.ncanvas', loadCodexEntries: input => { options = input; return new Promise(resolve => { finish = resolve; }); } });
    let work = h.api.reloadCodexFiles();
    assert.deepEqual(options.references.map(entry => entry.id), ['shared']);
    finish([]); await work;
    assert.equal(h.state.project.characters.find(entry => entry.id === 'shared').referenceMissing, true);
    work = h.api.reloadCodexFiles();
    const next = { characters: [], nodes: [] }; h.state.project = next;
    finish([shared]); assert.equal(await work, false);
    assert.deepEqual(next, { characters: [], nodes: [] });
});
test('normal canvas saves never enter the Library write path', async () => {
    const sync = bindMethod('syncCodexFiles');
    const result = await sync.call({ getCurrentProjectPath: () => 'Book/Canvas/a.ncanvas', getCodexLibraryRootsForProject() { assert.fail('Automatic Library write attempted'); } }, { project });
    assert.deepEqual(result, []);
});
test('disabled host Library returns before probing any vault roots', () => {
    const getRoots = bindMethod('getCodexLibraryRootsForProject');
    assert.deepEqual(getRoots.call({ isNarrativeLabLibraryEnabled: () => false }, 'Book/Canvas/a.ncanvas'), []);
});
test('host reference loading uses direct file reads without enumerating Library children', async () => {
    const files = new Map([[shared.codexFile, new TFile(shared.codexFile)]]), reads = [];
    const load = bindMethod('loadCodexEntries', { normalizeVaultPath, isPathUnderLibraryRoots, TFile, TFolder,
        getVaultFile: (_, path) => files.get(path), getVaultFolder() { assert.fail('Full Library traversal'); },
        parseCodexMarkdownFile: path => ({ ...shared, codexFile: path }), getCodexStructuredFingerprint: () => 'fingerprint' });
    const host = { getCodexLibraryRootsForProject: () => ['Book/Library'], codexFileCache: new Map(), app: { vault: { cachedRead: async file => { reads.push(file.path); return '正文'; } } } };
    assert.deepEqual(await load.call(host, 'Book/Canvas/a.ncanvas', { references: [] }), []);
    const result = await load.call(host, 'Book/Canvas/a.ncanvas', { references: [shared, shared, { codexFile: 'Other/Library/no.md' }] });
    assert.equal(result.length, 1); assert.deepEqual(reads, [shared.codexFile]);
});
function migrationHarness(entries = []) {
    const writes = [];
    const host = { getCurrentProjectPath: () => 'Book/Canvas/a.ncanvas', isNarrativeLabLibraryEnabled: () => true,
        loadCodexEntries: async () => entries, getCodexFolderForProject: () => 'Book/Library',
        resolveCodexCategoryFolder: root => `${root}/Lore`, uniqueProjectPath: async path => path,
        app: { vault: { create: async (path, text) => writes.push({ path, text }) } } };
    const migrate = bindMethod('migrateLibraryEntry', { crypto: { randomUUID: () => 'stable-new-id' }, normalizeCodexEntryForMarkdown: copy,
        ensureVaultFolder: async () => {}, joinVaultPath: (...parts) => parts.join('/'), sanitizeFileName: text => text,
        buildCodexMarkdown: entry => `---\nid: ${entry.id}\n---\n${entry.markdownBody}` });
    return { host, writes, migrate: (entry, options) => migrate.call(host, entry, options) };
}
test('host migration refuses same-name overwrites and only links after explicit confirmation', async () => {
    const h = migrationHarness([shared]);
    assert.deepEqual(await h.migrate(legacy), { conflict: shared }); assert.equal(h.writes.length, 0);
    assert.deepEqual(await h.migrate(legacy, { reuseId: shared.id }), { entry: shared }); assert.equal(h.writes.length, 0);
});
test('host migration creates a new UTF-8 note with a stable ID; collisions fail without overwrite', async () => {
    const h = migrationHarness();
    const result = await h.migrate(legacy);
    assert.equal(result.entry.id, 'stable-new-id');
    assert.equal(h.writes[0].path, 'Book/Library/Lore/论据.md');
    assert.ok(h.writes[0].text.includes('旧的材料'));
    h.host.app.vault.create = async () => { throw new Error('File already exists'); };
    await assert.rejects(h.migrate(legacy), /already exists/);
});
test('host migration rechecks module and project after asynchronous loading', async () => {
    const h = migrationHarness();
    h.host.loadCodexEntries = async () => { h.host.isNarrativeLabLibraryEnabled = () => false; return []; };
    await assert.rejects(h.migrate(legacy), /Enable/); assert.equal(h.writes.length, 0);
    const other = migrationHarness();
    other.host.loadCodexEntries = async () => { other.host.getCurrentProjectPath = () => 'Other/a.ncanvas'; return []; };
    await assert.rejects(other.migrate(legacy), /Project changed/); assert.equal(other.writes.length, 0);
});
test('project canvas tab restores only its own remembered file; empty projects open the creation manager', async () => {
    const open = bindMethod('openProjectCanvasTab', { NCANVAS_LIBRARY_VIEW_TYPE: 'canvas-manager' }, 'main.ts');
    const a = { filePath: 'A/A.md' }, b = { filePath: 'B/B.md' }, leaf = {}, calls = [];
    const host = { sceneManager: { activeProject: b, getProjects: () => [a, b] }, isViewEnabled: () => true,
        settings: { narrativeCanvasPathByProject: { 'A/A.md': 'A/2.ncanvas', 'B/B.md': 'B/1.ncanvas' } },
        getNcanvasPathsForProject: () => ({ candidates: ['A/1.ncanvas', 'A/2.ncanvas'] }),
        ensureCanvasModuleReady: async () => ({ openProjectFile: async (...args) => calls.push(['open', ...args]) }),
        rememberNcanvasPath: async (...args) => calls.push(['remember', ...args]),
        openNCanvasLibrary: async (...args) => calls.push(['manager', ...args]) };
    await open.call(host, a.filePath, leaf, 'B/1.ncanvas');
    assert.deepEqual(calls[0], ['open', 'A/2.ncanvas', leaf]);
    host.getNcanvasPathsForProject = () => ({ candidates: [] }); calls.length = 0;
    await open.call(host, a.filePath, leaf);
    assert.deepEqual(calls, [['manager', a.filePath, leaf]]);
    host.isViewEnabled = () => false; calls.length = 0;
    await open.call(host, a.filePath, leaf); assert.deepEqual(calls, []);
});
test('failed saves cancel canvas navigation before changing the project path', async () => {
    const open = bindMethod('openProjectFile', { window: { NarrativeCanvasApp: { prepareForNavigation: async () => false } } });
    await assert.rejects(open.call({ setCurrentProjectPath() { assert.fail('Changed path before saving'); } }, 'B/a.ncanvas'), /Navigation was cancelled/);
});
test('Library file events do no work when the module is disabled', () => {
    const schedule = bindMethod('scheduleCodexReloadForFile');
    schedule.call({ getCurrentProjectPath: () => 'Book/a.ncanvas', isNarrativeLabLibraryEnabled: () => false }, {});
});
test('web reference picker mounts inside the app element and closes without touching data', async () => {
    let mounted, opened = false;
    const search = { value: '', addEventListener() {}, focus() {} }, list = { addEventListener() {} };
    const dialog = { querySelector: selector => selector === 'input' ? search : list, addEventListener() {}, showModal() { opened = true; } };
    const project = { characters: [], nodes: [] };
    const api = bindFunctions(['showLibraryReferencePicker'], { state: { project }, window: {},
        isProjectLibraryEnabled: () => true, getCharacters: () => [], isProjectLibraryEntry: () => true,
        document: { createElement: () => dialog }, dom: { root: { appendChild: element => { mounted = element; } }, scope: { appendChild() { assert.fail('Cannot append a second root to Document'); } } },
        t: text => text, escapeAttr: text => text });
    await api.showLibraryReferencePicker();
    assert.equal(mounted, dialog); assert.equal(opened, true); assert.deepEqual(project, { characters: [], nodes: [] });
});
test('out-of-order canvas loads never apply the previous project to the new tab', async () => {
    const state = { project: { nodes: [] } }, requests = [], applied = [];
    let path = 'A/a.ncanvas';
    const host = { getCurrentProjectPath: () => path, loadProject: () => new Promise(resolve => requests.push(resolve)) };
    const api = bindFunctions(['loadFromVault'], { state, window: { NarrativeCanvasHost: host },
        parseSavedPayload: value => value, applySavedState: value => { applied.push(value.title); return true; },
        setProjectDirty() {}, ensureOfficialSampleLibraryEntries() {}, reloadCodexFiles: async () => {}, seedMissingLibraryFiles: async () => {} });
    const first = api.loadFromVault(false); await Promise.resolve();
    path = 'B/b.ncanvas'; const second = api.loadFromVault(false); await Promise.resolve();
    requests[1]({ title: 'B' }); await second;
    requests[0]({ title: 'A' }); await first;
    assert.deepEqual(applied, ['B']);
});
test('host-only visibility rules do not resurrect a disabled web Library tab', () => {
    const library = { dataset: { action: 'open-project-library' } }, nav = { dataset: {} };
    const env = { dom: { webOnlyActions: [library, nav] }, window: {} };
    const api = bindFunctions(['updateWebOnlyActionVisibility'], env);
    api.updateWebOnlyActionVisibility(false);
    assert.equal(library.hidden, true); assert.equal(nav.hidden, false);
    api.updateWebOnlyActionVisibility(true); assert.equal(library.hidden, false);
    env.window.NarrativeCanvasHost = {};
    api.updateWebOnlyActionVisibility(true);
    assert.equal(library.hidden, true); assert.equal(nav.hidden, true);
});
test('Canvas is a capability-gated peer tab with list, creation and management actions', async () => {
    const source = sources['components/ViewSwitcher.ts'];
    const pages = await readFile(new URL('../models/ProjectPages.ts', import.meta.url), 'utf8');
    assert.match(source, /VIEW_ENTRIES.*PROJECT_PAGES/);
    assert.match(pages, /type: NCANVAS_LIBRARY_VIEW_TYPE/);
    assert.match(source, /openNewProjectCanvasModal/); assert.match(source, /Manage canvases/);
    assert.doesNotMatch(source, /const PLAYMODE_ENTRY/);
    assert.match(source, /plugin\.isViewEnabled\(entry.type/);
    assert.match(pages, /id: 'presentation'/);
    assert.match(pages, /modules: \['canvas'\]/);
});
test('node inspector merges library and vault associations without creating or deleting sources', async () => {
    const html = await readFile(new URL('../canvas-runtime/index.html', import.meta.url), 'utf8');
    const app = sources['canvas-runtime/app.js'];
    const panel = declaration('canvas-runtime/app.js', 'renderNodePanel');
    const field = declaration('canvas-runtime/app.js', 'renderNodeAssociatedMaterialsField');
    const row = declaration('canvas-runtime/app.js', 'renderAssociatedMaterialRow');
    const charactersPage = declaration('canvas-runtime/app.js', 'renderCharactersPage');
    const selectFile = declaration('canvas-runtime/app.js', 'selectFile');
    assert.match(panel, /renderNodeAssociatedMaterialsField/);
    assert.match(panel, /renderNodeAdvancedSettings/);
    assert.doesNotMatch(panel, /add-codex-entry/);
    assert.doesNotMatch(field, /nc-empty-state/);
    assert.match(declaration('canvas-runtime/app.js', 'associateVaultMaterial'), /renderCharacterAwareSurfaces\(node\)/);
    assert.match(row, /Open original/);
    assert.match(row, /Remove association/);
    assert.match(app, /"Associated materials": "关联资料"/);
    assert.match(html, /data-file-id="characters"[^>]*\bhidden\b/);
    assert.doesNotMatch(charactersPage, /renderCanvasReferences\(\)/);
    assert.match(selectFile, /openProjectLibrary/);
    const api = bindFunctions(['normalizeAssociatedMaterialPath', 'findLibraryEntryByPath', 'getNodeAssociatedMaterials'], {
        getNodeVaultFiles: node => node.vaultFiles || [],
        normalizeNodeCast: value => value || [],
        getCharacterById: id => id === 'shared' ? shared : null,
        getCharacters: () => [shared],
        t: text => text,
        getCodexKindLabel: kind => kind,
        normalizeNodeVaultFileReference: value => String(value || '').trim(),
    });
    const items = api.getNodeAssociatedMaterials({
        vaultFiles: [{ path: shared.codexFile }, { path: 'Notes/direct.md' }],
        cast: [{ characterId: 'shared', role: 'Referenced' }],
    });
    assert.deepEqual(items.map(item => [item.kind, item.path]), [['library', shared.codexFile], ['vault', 'Notes/direct.md']]);
    assert.equal(api.findLibraryEntryByPath(shared.codexFile)?.id, 'shared');
});
