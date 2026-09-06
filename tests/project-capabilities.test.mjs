import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import esbuild from 'esbuild';

const root = fileURLToPath(new URL('../', import.meta.url));
const result = await esbuild.build({
    stdin: { contents: `export * from './models/ProjectCapabilities'; export * from './services/DocumentSourceService';`, resolveDir: root, loader: 'ts' },
    bundle: true, format: 'esm', write: false,
});
const source = `data:text/javascript;base64,${Buffer.from(result.outputFiles[0].text).toString('base64')}`;
const capabilities = await import(source);

test('legacy projects retain every module', () => {
    const normalized = capabilities.normalizeProjectCapabilities(undefined);
    assert.equal(normalized.preset, 'legacy-full');
    assert.deepEqual(normalized.modules, [...capabilities.PROJECT_MODULE_IDS]);
});

test('research paper excludes narrative services but keeps research tools', () => {
    const preset = capabilities.capabilitiesForPreset('research-paper');
    for (const module of ['manuscript', 'outline', 'library', 'table', 'flatCanvas', 'columnBoard', 'research', 'citations']) {
        assert.ok(preset.modules.includes(module), module);
    }
    for (const module of ['scenes', 'board', 'plotlines', 'timeline', 'characters', 'locations', 'canvas']) {
        assert.ok(!preset.modules.includes(module), module);
    }
    assert.equal(preset.wordCountProfile, 'academic');
    assert.equal(preset.navigation?.defaultPage, 'library');
    assert.deepEqual(preset.navigation?.order, ['library', 'manuscript', 'flatCanvas', 'columnBoard', 'table']);
    assert.equal(capabilities.libraryCategoryPack(preset), 'academic');
    assert.equal(capabilities.libraryCategoryPack(capabilities.capabilitiesForPreset('literature-review')), 'academic');
    assert.equal(capabilities.libraryCategoryPack(capabilities.capabilitiesForPreset('novel')), 'narrative');
    assert.equal(capabilities.libraryCategoryPack(capabilities.capabilitiesForPreset('essay')), 'academic');
});

test('dependencies are added without enabling unrelated modules', () => {
    assert.deepEqual(capabilities.resolveModuleDependencies(['flatCanvas']), ['notes', 'flatCanvas']);
    assert.deepEqual(capabilities.resolveModuleDependencies(['columnBoard']), ['notes', 'columnBoard']);
    assert.deepEqual(capabilities.resolveModuleDependencies(['characters']), ['library', 'characters']);
    assert.deepEqual(capabilities.resolveModuleDependencies(['writingTracker']), ['writingTracker']);
});

test('unknown module ids are discarded safely', () => {
    const normalized = capabilities.normalizeProjectCapabilities({
        preset: 'custom', modules: ['manuscript', 'made-up-module'], wordCountProfile: 'academic',
    });
    assert.deepEqual(normalized.modules, ['manuscript']);
});

test('research presets drop presentation canvas while custom projects keep it', () => {
    const migrated = capabilities.normalizeProjectCapabilities({
        version: 2, preset: 'research-paper',
        modules: ['manuscript', 'notes', 'library', 'table', 'canvas', 'citations'],
    });
    assert.ok(!migrated.modules.includes('canvas'));
    assert.ok(migrated.modules.includes('flatCanvas'));
    assert.ok(migrated.modules.includes('columnBoard'));
    const withOrder = capabilities.normalizeProjectCapabilities({
        version: 2, preset: 'literature-review',
        modules: ['manuscript', 'notes', 'library', 'table'],
        navigation: { order: ['library', 'manuscript', 'table'], hidden: [] },
    });
    assert.deepEqual(withOrder.navigation?.order, ['library', 'manuscript', 'flatCanvas', 'columnBoard', 'table']);
    const custom = capabilities.normalizeProjectCapabilities({
        version: 2, preset: 'custom', modules: ['manuscript', 'library', 'canvas'],
    });
    assert.ok(custom.modules.includes('canvas'));
});

test('document sources are replaceable and removable without scene dependencies', async () => {
    const registry = new capabilities.DocumentSourceService();
    const sourceA = { id: 'draft', label: 'Draft', listDocuments: async () => [], readText: async () => 'A' };
    const sourceB = { id: 'draft', label: 'Folder', listDocuments: async () => [], readText: async () => 'B' };
    const removeA = registry.register(sourceA);
    registry.register(sourceB);
    removeA();
    assert.equal(registry.get('draft'), sourceB);
    assert.deepEqual(registry.list(), [sourceB]);
});

test('plain projects count writing Markdown without scanning research or module storage', async () => {
    const files = [
        ['Writing/Essay/Essay.md', 'manifest'],
        ['Writing/Essay/Draft.md', 'draft words'],
        ['Writing/Essay/Notes/Idea.md', 'idea words'],
        ['Writing/Essay/Research/Source.md', 'source words'],
        ['Writing/Essay/Library/Author.md', 'author words'],
        ['Other.md', 'outside'],
    ].map(([path, text]) => ({ path, basename: path.split('/').pop().replace(/\.md$/, ''), text }));
    const app = { vault: { getMarkdownFiles: () => files, cachedRead: async file => file.text } };
    const source = new capabilities.ProjectMarkdownDocumentSource(app, 'Writing/Essay', 'Writing/Essay/Essay.md');
    const documents = await source.listDocuments();
    assert.deepEqual(documents.map(document => document.path), [
        'Writing/Essay/Draft.md', 'Writing/Essay/Notes/Idea.md',
    ]);
});

test('project manifests persist capabilities while legacy manifests stay implicit', async () => {
    const sceneManager = await readFile(new URL('../services/SceneManager.ts', import.meta.url), 'utf8');
    assert.match(sceneManager, /capabilitiesVersion: capabilities\.version/);
    assert.match(sceneManager, /projectType: capabilities\.preset/);
    assert.match(sceneManager, /modules: capabilities\.modules/);
    assert.match(sceneManager, /: undefined,\s*definedActs:/s);
    assert.match(sceneManager, /if \(project\.capabilities\) \{\s*const capabilities/s);
    assert.match(sceneManager, /capabilities\.modules\.includes\('library'\)/);
    assert.match(sceneManager, /capabilities\.modules\.includes\('canvas'\)/);
    assert.match(sceneManager, /projectNavigation: capabilities\.navigation/);
    assert.match(sceneManager, /!capabilities\.modules\.includes\('scenes'\)/);
    assert.match(sceneManager, /草稿/);
    assert.match(sceneManager, /\$\{draftName\}\.md/);
});

test('disabled views and services are gated by their project capability', async () => {
    const [main, switcher, navigator] = await Promise.all([
        readFile(new URL('../main.ts', import.meta.url), 'utf8'),
        readFile(new URL('../components/ViewSwitcher.ts', import.meta.url), 'utf8'),
        readFile(new URL('../views/NavigatorView.ts', import.meta.url), 'utf8'),
    ]);
    assert.match(main, /isViewEnabled\(viewType/);
    assert.match(main, /closeAllDisabledProjectViews/);
    assert.match(main, /has\('scenes'\)/);
    assert.match(main, /has\('library'\)/);
    assert.match(main, /has\('writingTracker'\)/);
    assert.match(main, /libraryCategoryPack\(this\.capabilityService\.get\(this\.sceneManager\.activeProject\)\) === 'academic'/);
    assert.match(switcher, /plugin\.isViewEnabled\(entry\.type/);
    assert.match(navigator, /capabilityService\.isEnabled\('notes'/);
    assert.match(navigator, /capabilityService\.isEnabled\('scenes'/);
    assert.match(navigator, /capabilityService\.isEnabled\('research'/);
});

test('lightweight projects create and load only enabled System data', async () => {
    const [main, sceneManager, manuscript] = await Promise.all([
        readFile(new URL('../main.ts', import.meta.url), 'utf8'),
        readFile(new URL('../services/SceneManager.ts', import.meta.url), 'utf8'),
        readFile(new URL('../views/ManuscriptView.ts', import.meta.url), 'utf8'),
    ]);
    assert.match(sceneManager, /const needsSystemFolder = capabilities\.modules\.some/);
    assert.match(sceneManager, /capabilities\.modules\.includes\('writingTracker'\) \? \['stats\.json'\]/);
    assert.match(main, /wordcountPrepareOptions\(\)/);
    assert.match(sceneManager, /setWordcountProfile\(this\._activeProject\?\.capabilities\?\.wordCountProfile\)/);
    assert.doesNotMatch(sceneManager, /includes\('writingTracker'\) \|\| capabilities\.modules\.includes\('writingStats'\)/);
    assert.match(main, /const plotlines = plotlineDataEnabled \? await this\.readSystemJson\('plotlines\.json'\) : \{\}/);
    assert.match(main, /const characters = charactersEnabled \? await this\.readSystemJson\('characters\.json'\) : \{\}/);
    assert.match(main, /if \(canMigrate\('characters'\)\)/);
    assert.match(main, /if \(canMigrate\('writingTracker'\)\)/);
    assert.match(manuscript, /private captureAndPersistState\(\): void \{\s*if \(!this\.usesScenes\(\)\) return/);
});

test('disabled Library never enters category seeding, migration, or entity reload paths', async () => {
    const [main, categorySync, nativeBase] = await Promise.all([
        readFile(new URL('../main.ts', import.meta.url), 'utf8'),
        readFile(new URL('../services/LibraryCategorySync.ts', import.meta.url), 'utf8'),
        readFile(new URL('../components/NativeLibraryBase.ts', import.meta.url), 'utf8'),
    ]);
    assert.match(main, /const libraryEnabled = Boolean\(\s*activeProject && this\.capabilityService\.isEnabled\('library', activeProject\)/);
    assert.match(main, /const presetsSeeded = libraryEnabled && seedStorylinePresetCategories\(this\)/);
    assert.match(main, /if \(libraryEnabled && await reconcileLibraryCategoriesForActiveProject\(/);
    assert.match(main, /if \(!this\.capabilityService\.isEnabled\('library', project\)\) continue/);
    assert.match(main, /!this\.capabilityService\.isEnabled\('library', this\.sceneManager\.activeProject\)\) return false/);
    assert.match(categorySync, /!project \|\| !plugin\.capabilityService\.isEnabled\('library', project\)\) return false/);
    assert.match(nativeBase, /!project \|\| !plugin\.capabilityService\.isEnabled\('library', project\)\) return/);
});

test('manuscript provides document creation and editing when Scenes is disabled', async () => {
    const manuscript = await readFile(new URL('../views/ManuscriptView.ts', import.meta.url), 'utf8');
    assert.match(manuscript, /if \(!this\.usesScenes\(\)\) \{/);
    assert.match(manuscript, /text: t\('New document'\)/);
    assert.match(manuscript, /await this\.renderDocuments\(\)/);
    assert.match(manuscript, /new ProjectMarkdownDocumentSource\(/);
    assert.match(manuscript, /vault\.create\(path, `# \$\{cleaned\}\\n\\n`\)/);
    assert.match(manuscript, /await this\.mountEditor\(document\.el, document\.path\)/);
    assert.match(manuscript, /isEnabled\('scenes', this\.getBoundProject\(\)\)/);
    assert.match(manuscript, /ensureProjectDocumentBase\(this\.app, project\)/);
    assert.match(manuscript, /text: t\('Open as table'\)/);
    assert.match(manuscript, /getLeaf\('tab'\)\.openFile\(base\)/);
    assert.match(manuscript, /Open Library to add literature, claims, arguments, and facts\./);
    assert.match(manuscript, /nl-manuscript-doc-actions/);
    assert.match(manuscript, /chrome.hidden = documents.length === 0/);
    assert.doesNotMatch(manuscript, /void leaf\.openFile\(base\)/);
    assert.doesNotMatch(manuscript, /await this\.leaf\.openFile\(base\)/);
    assert.doesNotMatch(manuscript, /Opening project document list/);
});

test('project document Base includes writing files and excludes module storage', async () => {
    const base = await readFile(new URL('../services/ProjectDocumentBase.ts', import.meta.url), 'utf8');
    assert.match(base, /`writing-\$\{safeProjectName\}\.base`/);
    assert.match(base, /LEGACY_DOCUMENT_BASE_FILENAME = 'writing\.base'/);
    assert.match(base, /fileManager\.renameFile\(legacy, path\)/);
    assert.match(base, /file\.inFolder/);
    assert.match(base, /file\.path !=/);
    for (const folder of ['System', 'Library', 'Canvas', 'Attachments', 'Research', 'Notes', 'Scenes']) {
        assert.match(base, new RegExp(`'${folder}'`));
    }
    assert.match(base, /file\.name/);
    assert.match(base, /file\.mtime/);
});

test('generic writing hides narrative-only statistics and commands', async () => {
    const [main, stats, switcher] = await Promise.all([
        readFile(new URL('../main.ts', import.meta.url), 'utf8'),
        readFile(new URL('../views/StatsView.ts', import.meta.url), 'utf8'),
        readFile(new URL('../components/ViewSwitcher.ts', import.meta.url), 'utf8'),
    ]);
    for (const module of ['flatCanvas', 'timeline', 'table', 'plotList', 'characters', 'locations', 'library', 'scenes']) {
        assert.match(main, new RegExp(`moduleCommand\\('${module}'`), module);
    }
    assert.match(stats, /if \(!narrativeMode\) return/);
    assert.match(stats, /narrativeMode \? t\('Scenes'\) : t\('Documents'\)/);
    assert.match(stats, /isEnabled\('scenes', this\.getBoundProject\(\)\)/);
    const pages = await readFile(new URL('../models/ProjectPages.ts', import.meta.url), 'utf8');
    assert.match(pages, /label: 'Node-based presentation canvas'/);
    assert.doesNotMatch(switcher, /label: 'Play in Canvas'/);
});

test('settings hide configuration tabs for disabled project modules', async () => {
    const settings = await readFile(new URL('../settings.ts', import.meta.url), 'utf8');
    assert.match(settings, /enabled\('canvas'\).*id: 'canvas'/s);
    assert.match(settings, /enabled\('scenes'\).*id: 'scenes'.*id: 'templates'/s);
    assert.match(settings, /enabled\('writingTracker'\).*id: 'tracking'/s);
    assert.match(settings, /!tabs\.some\(tab => tab\.id === this\.settingsTabId\)/);
});
