import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { build, transform } from 'esbuild';

const root = fileURLToPath(new URL('../', import.meta.url));
const main = (await readFile(new URL('../main.ts', import.meta.url), 'utf8')).replace(/\r\n/g, '\n');
const scene = (await readFile(new URL('../services/SceneManager.ts', import.meta.url), 'utf8')).replace(/\r\n/g, '\n');
const t = (key, args = {}) => key.replace(/\{(\w+)\}/g, (_, name) => String(args[name] ?? name));
const normalizePath = value => String(value).replace(/\\/g, '/').replace(/^\/+|\/+$/g, '');
const bundled = await build({
    stdin: {
        contents: `export * from './services/ProjectDocumentBase'; export { deriveProjectFoldersFromFilePath } from './models/StoryLineProject'; export { TFile } from 'obsidian';`,
        resolveDir: root, loader: 'ts',
    },
    bundle: true, write: false, format: 'esm',
    plugins: [{ name: 'test-host', setup(b) {
        b.onResolve({ filter: /^obsidian$/ }, () => ({ path: 'obsidian', namespace: 'test-host' }));
        b.onResolve({ filter: /utils\/i18n$/ }, () => ({ path: 'i18n', namespace: 'test-host' }));
        b.onLoad({ filter: /.*/, namespace: 'test-host' }, args => ({ contents: args.path === 'obsidian'
            ? `export const normalizePath = ${normalizePath.toString()}; export class TFile { constructor(path, content = '') { this.path = path; this.content = content; } }`
            : `export const t = ${t.toString()};` }));
    } }],
});
const api = await import(`data:text/javascript;base64,${Buffer.from(bundled.outputFiles[0].text).toString('base64')}`);
const { TFile, deriveProjectFoldersFromFilePath: folders } = api;

class Element {
    constructor(text = '') { this.text = text; this.children = []; this.events = {}; }
    setText(value) { this.text = value; }
    empty() { this.children = []; }
    addClass() {}
    createEl(tag, options = {}) {
        const child = new Element(options.text);
        child.tag = tag; child.options = options;
        this.children.push(child); return child;
    }
    createDiv(options = {}) { return this.createEl('div', options); }
    createSpan(options = {}) { return this.createEl('span', options); }
    addEventListener(name, fn) { this.events[name] = fn; }
    all() { return [this, ...this.children.flatMap(child => child.all())]; }
}

class Control {
    inputEl = { focus() {}, select() {} };
    setButtonText(value) { this.label = value; return this; }
    setDisabled(value) { this.disabled = value; return this; }
    setValue(value) { this.value = value; return this; }
    setPlaceholder() { return this; }
    setClass() { return this; }
    setCta() { return this; }
    onClick(fn) { this.click = fn; return this; }
    onChange(fn) { this.change = fn; return this; }
}

class Setting {
    constructor(el) { this.el = el; el.settings ??= []; el.settings.push(this); this.buttons = []; }
    setName(value) { this.name = value; return this; }
    setDesc(value) { this.desc = value; return this; }
    addText(fn) { this.input = new Control(); fn(this.input); return this; }
    addButton(fn) { const button = new Control(); this.buttons.push(button); fn(button); return this; }
}

function modalHarness() {
    const notices = [], opened = [];
    class Modal {
        constructor(app) { this.app = app; this.contentEl = new Element(); this.titleEl = new Element(); }
        close() { this.closed = true; }
    }
    const source = main.slice(main.indexOf('class SeriesManagementModal'), main.lastIndexOf('/* eslint-enable'));
    return transform(source, { loader: 'ts', target: 'es2022' }).then(({ code }) => {
        const ModalClass = new Function('Modal', 'Setting', 'Notice', 't', 'normalizePath', 'deriveProjectFoldersFromFilePath', 'setIcon', 'openStackedModal', 'window',
            `${code}; return SeriesManagementModal;`)(Modal, Setting, class { constructor(message) { notices.push(message); } }, t, normalizePath, folders, () => {}, modal => opened.push(modal), { setTimeout() {} });
        const selected = { title: '博客', filePath: 'Projects/博客/博客.md' };
        const active = { title: '小说', filePath: 'Projects/小说/小说.md' };
        const calls = [];
        const plugin = {
            seriesManager: { discoverSeries: async () => [], checkLinkSettings() {} },
            sceneManager: {
                activeProject: active,
                getProjects: () => [selected, active], isProjectInValidSeries: () => false,
                renameProject: async (project, title) => calls.push(['rename', project, title]),
                deleteProject: async project => { calls.push(['delete', project]); return true; },
            },
            refreshOpenViews: async () => calls.push(['refresh']),
        };
        const modal = new ModalClass({}, plugin);
        return { modal, opened, notices, selected, active, plugin, calls };
    });
}

function dialogControls(dialog) {
    const settings = dialog.contentEl.settings;
    return { input: settings.find(s => s.input).input, buttons: settings.flatMap(s => s.buttons) };
}

test('standalone project rows expose rename, delete and convert without changing the active project', async () => {
    const h = await modalHarness();
    await h.modal.render();
    assert.equal(h.modal.titleEl.text, 'Manage projects');
    const buttons = h.modal.contentEl.all().filter(e => e.tag === 'button');
    assert.deepEqual(buttons.map(e => e.text), ['Open Project', 'Project settings', 'Rename', 'Delete', 'Convert to Series…', 'Open Project', 'Project settings', 'Rename', 'Delete', 'Convert to Series…']);
    buttons.find(button => button.text === 'Rename').events.click();
    const { input, buttons: controls } = dialogControls(h.opened.at(-1));
    input.change('研究随笔');
    await controls.find(b => b.label === 'Rename').click();
    assert.deepEqual(h.calls[0], ['rename', h.selected, '研究随笔']);
    assert.equal(h.plugin.sceneManager.activeProject, h.active);
});

test('delete requires the clicked project title and suppresses repeated submissions', async () => {
    const h = await modalHarness();
    h.modal.confirmDeleteProject(h.selected);
    const dialog = h.opened.at(-1);
    const { input, buttons } = dialogControls(dialog);
    const button = buttons.find(b => b.label === 'Delete');
    assert.equal(button.disabled, true);
    input.change(h.active.title);
    await button.click();
    assert.deepEqual(h.calls, []);
    input.change(h.selected.title);
    assert.equal(button.disabled, false);
    let finish;
    h.plugin.sceneManager.deleteProject = project => {
        h.calls.push(['delete', project]);
        return new Promise(resolve => { finish = resolve; });
    };
    const pending = button.click();
    await button.click();
    assert.deepEqual(h.calls, [['delete', h.selected]]);
    assert.equal(button.disabled, true);
    finish(true); await pending;
    assert.equal(dialog.closed, true);
    assert.ok(dialog.contentEl.all().some(e => e.text === 'Projects/博客'));
});

test('cancel performs no write and deletion failure keeps the dialog retryable', async () => {
    const h = await modalHarness();
    h.modal.confirmDeleteProject(h.selected);
    let dialog = h.opened.at(-1);
    await dialogControls(dialog).buttons.find(b => b.label === 'Cancel').click();
    assert.equal(dialog.closed, true);
    assert.deepEqual(h.calls, []);
    h.modal.confirmDeleteProject(h.selected, '小说集');
    dialog = h.opened.at(-1);
    const { input, buttons } = dialogControls(dialog);
    input.change(h.selected.title);
    h.plugin.sceneManager.deleteProject = async () => { throw new Error('Locked folder'); };
    await buttons.find(b => b.label === 'Delete').click();
    assert.equal(dialog.closed, undefined);
    assert.equal(buttons.find(b => b.label === 'Delete').disabled, false);
    assert.match(h.notices.at(-1), /Locked folder/);
    assert.ok(dialog.contentEl.all().some(e => e.text.includes('shared series Library and other projects will be kept')));
});

const renameSource = scene.slice(scene.indexOf('    async renameProject('), scene.indexOf('    /**\n     * Delete a project')).replace(
    "await import('./CorkboardCanvasService')", '({ CorkboardCanvasService: class { async renameCanvasForProject() {} } })',
);
const rebaseSource = scene.slice(scene.indexOf('    async handleProjectTreeFolderRename('), scene.indexOf('    /** Keep draft reading-order'));
const renamedClass = await transform(`class Manager { ${renameSource} ${rebaseSource} }`, { loader: 'ts', target: 'es2022' });

function renameHarness({ title = '博客', filePath = 'Projects/博客/博客.md', seriesId } = {}) {
    const project = { title, filePath, seriesId, ...folders(filePath), coverImage: `${folders(filePath).baseFolder}/Attachments/封面.png` };
    const files = new Map();
    const calls = [];
    const addFolder = path => files.set(path, { path });
    const addFile = (path, content = '') => { const file = new TFile(path, content); files.set(path, file); return file; };
    addFolder(project.baseFolder);
    addFile(filePath);
    const app = {
        vault: {
            adapter: { exists: async path => files.has(path) },
            getAbstractFileByPath: path => files.get(path) ?? null,
            process: async (file, fn) => { file.content = fn(file.content); },
        },
        fileManager: { renameFile: async (file, destination) => {
            if (files.has(destination)) throw new Error('Target exists');
            const source = file.path;
            calls.push(['move', source, destination]);
            for (const [path, entry] of [...files]) {
                if (path === source || path.startsWith(`${source}/`)) {
                    files.delete(path);
                    entry.path = destination + path.slice(source.length);
                    files.set(entry.path, entry);
                }
            }
            if (!(file instanceof TFile)) await manager.handleProjectTreeFolderRename(source, destination);
        } },
    };
    const metadata = { name: 'Series', bookOrder: [project.baseFolder.split('/').pop(), 'Other'] };
    const plugin = {
        settings: { activeProjectFile: 'Other/Other.md' },
        quiesceProjectLeavesForFolderMove: async (from, to, renames) => {
            calls.push(['suspend', from, to]);
            return async moved => calls.push(['resume', moved, renames]);
        },
        saveSettings: async () => calls.push(['saveSettings']),
        saveData: async () => calls.push(['saveData']),
        seriesManager: {
            loadSeriesMetadata: async folder => { calls.push(['loadSeries', folder]); return metadata; },
            saveSeriesMetadata: async (folder, value) => calls.push(['saveSeries', folder, [...value.bookOrder]]),
        },
    };
    const Manager = new Function('normalizePath', 'TFile', 'deriveProjectFoldersFromFilePath', 'projectDocumentBasePath', 'renameProjectDocumentBase', 'ensureVaultFolder', 'plotGridXlsxPath', 'LIBRARY_BASE_PREFIX', 't',
        `${renamedClass.code}; return Manager;`)(normalizePath, TFile, folders, api.projectDocumentBasePath, api.renameProjectDocumentBase,
        async (_, path) => { if (!files.has(path)) addFolder(path); }, (root, name) => `${root}/Table/datasheet-${name}.xlsx`, 'library', t);
    const manager = new Manager();
    Object.assign(manager, {
        app, plugin, projects: new Map([[filePath, project]]),
        managedProjectRenameRoots: new Set(), deletedProjectRoots: new Set(), scenes: new Map(),
        bumpVersion() {}, initialize: async () => calls.push(['initialize']),
        getSeriesFolderForProject: p => p.seriesId ? folders(p.filePath).baseFolder.split('/').slice(0, -1).join('/') : null,
        saveProjectFrontmatter: async p => calls.push(['frontmatter', p.filePath, p.title]),
    });
    return { app, project, manager, files, calls, addFile, addFolder, plugin, metadata };
}

test('whole-project rename moves the folder, manifest and Base, preserving custom Base settings', async () => {
    const h = renameHarness();
    const content = api.buildProjectDocumentBase(h.project) + 'custom: "保留我的列"\n';
    h.addFile(api.projectDocumentBasePath(h.project), content);
    h.addFile('Projects/博客/我的文稿.md', '正文保持原样');
    await h.manager.renameProject(h.project, '研究随笔');
    assert.equal(h.project.filePath, 'Projects/研究随笔/研究随笔.md');
    assert.equal(h.project.coverImage, 'Projects/研究随笔/Attachments/封面.png');
    assert.ok(!h.calls.some(call => call[0] === 'frontmatter' && call[1].includes('研究随笔/博客')));
    const base = h.files.get('Projects/研究随笔/writing-研究随笔.base');
    assert.ok(base);
    assert.match(base.content, /file\.inFolder\("Projects\/研究随笔"\)/);
    assert.match(base.content, /file\.path != "Projects\/研究随笔\/研究随笔.md"/);
    assert.ok(base.content.endsWith('custom: "保留我的列"\n'));
    assert.equal(h.files.get('Projects/研究随笔/我的文稿.md').content, '正文保持原样');
    assert.equal(h.calls.at(-1)[0], 'resume');
    assert.equal(h.calls.at(-1)[1], true);
    assert.equal(h.calls.at(-1)[2]['Projects/博客/博客.md'], h.project.filePath);
    assert.equal(h.plugin.settings.activeProjectFile, 'Other/Other.md');
});

test('rename does not generate a document Base when none exists', async () => {
    const h = renameHarness();
    await h.manager.renameProject(h.project, '新名称');
    assert.equal([...h.files.keys()].some(path => path.endsWith('.base')), false);
});

test('legacy writing.base is migrated during rename and path-prefix neighbours are untouched', async () => {
    const h = renameHarness();
    h.addFile('Projects/博客/writing.base', api.buildProjectDocumentBase(h.project) + 'other: "Projects/博客集/资料.md"\n');
    await h.manager.renameProject(h.project, '新名称');
    assert.match(h.files.get('Projects/新名称/writing-新名称.base').content, /Projects\/博客集\/资料.md/);
});

test('root-level and legacy sibling manifests are renamed into the correct folder', async () => {
    for (const path of ['博客/博客.md', '博客.md', 'Projects/博客.md']) {
        const h = renameHarness({ filePath: path });
        await h.manager.renameProject(h.project, '新名称');
        assert.equal(h.project.filePath, path.startsWith('Projects/') ? 'Projects/新名称/新名称.md' : '新名称/新名称.md');
        assert.ok(h.files.has(h.project.filePath));
        assert.ok(!h.files.has(path));
    }
});

test('folder, manifest and document Base conflicts abort before any move', async () => {
    for (const collision of ['Projects/新名称', 'Projects/博客/新名称.md', 'Projects/博客/writing-新名称.base']) {
        const h = renameHarness();
        h.addFile(api.projectDocumentBasePath(h.project), 'original base');
        h.addFile(collision, 'existing file');
        await assert.rejects(h.manager.renameProject(h.project, '新名称'), /path already exists/);
        assert.deepEqual(h.calls, []);
        assert.equal(h.files.get(collision).content, 'existing file');
    }
});

test('invalid filesystem names abort before any move', async () => {
    for (const name of ['', '..', '...', 'CON', 'LPT1.txt']) {
        const h = renameHarness();
        await assert.rejects(h.manager.renameProject(h.project, name), /valid project name/);
        assert.deepEqual(h.calls, []);
    }
});

test('renaming an inactive series member updates its own series', async () => {
    const h = renameHarness({ filePath: 'Projects/系列甲/博客/博客.md', seriesId: '系列甲' });
    h.manager.getSeriesFolder = () => { throw new Error('Must not read active series'); };
    await h.manager.renameProject(h.project, '新名称');
    assert.deepEqual(h.calls.find(call => call[0] === 'saveSeries'), ['saveSeries', 'Projects/系列甲', ['新名称', 'Other']]);
});

test('failed manifest rename restores the original folder and resumes the original tabs', async () => {
    const h = renameHarness();
    const move = h.app.fileManager.renameFile;
    h.app.fileManager.renameFile = async (file, destination) => {
        if (destination.endsWith('/新名称.md')) throw new Error('Locked manifest');
        await move(file, destination);
    };
    await assert.rejects(h.manager.renameProject(h.project, '新名称'), /Locked manifest/);
    assert.ok(h.files.has('Projects/博客/博客.md'));
    assert.ok(!h.files.has('Projects/新名称'));
    assert.equal(h.calls.at(-1)[0], 'resume');
    assert.equal(h.calls.at(-1)[1], false);
});
