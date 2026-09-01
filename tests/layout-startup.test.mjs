import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';
import test from 'node:test';
import esbuild from 'esbuild';

const root = fileURLToPath(new URL('../', import.meta.url));
const result = await esbuild.build({
    stdin: {
        contents: `export * from './utils/mutationRoots';
            export * from './utils/coalescedTask';
            export * from './utils/startupDiagnostics';`,
        resolveDir: root, loader: 'ts',
    },
    bundle: true, format: 'cjs', write: false,
});
const context = vm.createContext({ module: { exports: {} }, performance });
vm.runInContext(result.outputFiles[0].text, context);
const { addedMutationRoots, matchingElements, outermostElements, CoalescedTask, StartupDiagnostics } = context.module.exports;

test('navigator restore resolves before layout-ready and cancels stale mounts after close/reopen', async () => {
    const source = await readFile(new URL('../views/NavigatorView.ts', import.meta.url), 'utf8');
    const onOpen = source.slice(source.indexOf('    async onOpen()'), source.indexOf('    private mountNavigator()'));
    const closeStart = source.indexOf('    async onClose()');
    const onClose = source.slice(closeStart, source.indexOf('    /**', closeStart));
    const readyCallbacks = [];
    const timers = new Map();
    let nextTimer = 0;
    let mounts = 0;
    const workspace = { layoutReady: false, onLayoutReady: callback => readyCallbacks.push(callback) };
    const sandbox = vm.createContext({
        workspace, StartupDiagnostics, t: text => text,
        window: {
            setTimeout: callback => { timers.set(++nextTimer, callback); return nextTimer; },
            clearTimeout: id => timers.delete(id),
        },
        mount: () => { assert.equal(workspace.layoutReady, true); mounts++; },
    });
    const compiled = await esbuild.transform(`class Probe {
        app = {workspace}; plugin = {startupDiagnostics: new StartupDiagnostics()};
        contentEl = {empty() {}, createDiv() {}};
        refreshClosed = true; refreshGeneration = 0; mountTimer = null;
        mounted = false; filterDebounceTimer = null;
        restorePrimarySectionState() {} mountNavigator() { mount(); }
        ${onOpen} ${onClose}
    }; globalThis.Probe = Probe;`, { loader: 'ts', target: 'es2020' });
    vm.runInContext(compiled.code, sandbox);
    const view = new sandbox.Probe();
    // This await must complete while layoutReady is still false: no restore deadlock.
    await view.onOpen();
    assert.equal(timers.size, 0);
    assert.equal(mounts, 0);
    await view.onClose();
    await view.onOpen();
    workspace.layoutReady = true;
    readyCallbacks.forEach(callback => callback());
    assert.equal(timers.size, 1, 'old generation must not enqueue another mount');
    for (const [id, callback] of [...timers]) { timers.delete(id); callback(); }
    assert.equal(mounts, 1);
    await view.onOpen();
    assert.equal(timers.size, 1);
    await view.onClose();
    assert.equal(timers.size, 0, 'closing before next task cancels mounting');
});

test('automatic and manual navigator opening share one leaf and never await layout restoration', async () => {
    const source = await readFile(new URL('../main.ts', import.meta.url), 'utf8');
    const methods = source.slice(source.indexOf('    openNavigator(opts?'), source.indexOf('    private async revealOrOpenRightSidebarView('));
    const callbacks = [];
    const leaves = [];
    let created = 0;
    let revealed = 0;
    let finishOpen;
    const workspace = {
        layoutReady: false,
        onLayoutReady: callback => callbacks.push(callback),
        getLeavesOfType: () => leaves,
        getLeftLeaf: fresh => {
            assert.equal(fresh, true);
            created++;
            const leaf = { setViewState: async state => {
                assert.equal(state.active, false);
                await new Promise(resolve => { finishOpen = resolve; });
                leaves.push(leaf);
            } };
            return leaf;
        },
        revealLeaf: async () => { revealed++; },
    };
    const sandbox = vm.createContext({ workspace, StartupDiagnostics, console, NAVIGATOR_VIEW_TYPE: 'navigator' });
    const compiled = await esbuild.transform(`class Probe {
        app = {workspace}; startupDiagnostics = new StartupDiagnostics();
        navigatorDisposed = false; navigatorOpenScheduled = false;
        navigatorRevealRequested = false; navigatorOpenPromise = null;
        ${methods}
    }; globalThis.Probe = Probe;`, { loader: 'ts', target: 'es2020' });
    vm.runInContext(compiled.code, sandbox);
    const plugin = new sandbox.Probe();
    await plugin.openNavigator({ quiet: true });
    await plugin.openNavigator({ quiet: true });
    assert.equal(callbacks.length, 1);
    assert.equal(created, 0);
    workspace.layoutReady = true;
    callbacks[0]();
    const quiet = plugin.openNavigator({ quiet: true });
    const manual = plugin.openNavigator();
    assert.equal(quiet, manual);
    await Promise.resolve();
    assert.equal(created, 1);
    finishOpen();
    await manual;
    assert.equal(revealed, 1);
    await plugin.openNavigator({ quiet: true });
    assert.equal(created, 1);
    assert.equal(revealed, 1, 'quiet startup preserves restored focus');
    plugin.navigatorDisposed = true;
    await plugin.openNavigator();
    assert.equal(revealed, 1);
});

function element(parentElement = null) {
    return { nodeType: 1, parentElement, isConnected: true };
}

test('project scan skips indexed ordinary notes but still reads unindexed and saved projects', async () => {
    const source = await readFile(new URL('../services/SceneManager.ts', import.meta.url), 'utf8');
    const start = source.indexOf('    private async scanProjectsInner()');
    const method = source.slice(start, source.indexOf('    /**', start));
    class TFile { constructor(path) { this.path = path; } }
    const indexed = Array.from({ length: 1000 }, (_, i) => new TFile(`notes/${i}.md`));
    indexed.push(new TFile('known.md'), new TFile('new.md'), new TFile('saved.md'));
    const reads = [];
    const app = {
        vault: {
            configDir: '.obsidian', getMarkdownFiles: () => indexed,
            getAbstractFileByPath: path => indexed.find(file => file.path === path),
            adapter: { read: async path => { reads.push(path); return 'project'; } },
        },
        metadataCache: { getFileCache: file => file.path === 'new.md' ? null : {} },
    };
    const sandbox = vm.createContext({
        app, TFile, normalizePath: path => path, PROJECT_SCAN_SKIP_FOLDERS: new Set(),
        mapPool: async (values, _limit, fn) => Promise.all(values.map(fn)),
    });
    const compiled = await esbuild.transform(`class Probe {
        app = app; projects = new Map(); _activeProject = null;
        plugin = {settings: {storyLineRoot: '', activeProjectFile: 'saved.md'}};
        applyLegacyFolders() {} applyActiveProjectLocale() {}
        projectFromMetadataCache(file) { return file.path === 'known.md' ? {filePath: file.path} : null; }
        parseProjectContent(content, path) { return {filePath: path}; }
        getProjects() { return [...this.projects.values()]; }
        ${method}
    }; globalThis.Probe = Probe;`, { loader: 'ts', target: 'es2020' });
    vm.runInContext(compiled.code, sandbox);
    const manager = new sandbox.Probe();
    const projects = await manager.scanProjectsInner();
    assert.deepEqual(reads, ['new.md', 'saved.md']);
    assert.equal(projects.length, 3);
    assert.equal(manager._activeProject.filePath, 'saved.md');
});

test('mutation roots deduplicate nested/repeated additions and ignore detached branches', () => {
    const parent = element();
    const child = element(parent);
    const detached = { ...element(), isConnected: false };
    const text = { nodeType: 3, parentElement: child };
    const roots = addedMutationRoots([{ addedNodes: [child, parent, text, parent, detached] }]);
    assert.equal(roots.length, 1);
    assert.equal(roots[0], parent);
    assert.equal(outermostElements([parent, child]).length, 1);
    assert.equal(addedMutationRoots([{ addedNodes: [], removedNodes: [parent] }]).length, 0);
});

test('standalone inserted inputs and file titles include the root itself', () => {
    const root = { matches: () => true, querySelectorAll: () => [] };
    assert.equal(matchingElements(root, 'input')[0], root);
});

test('refresh requests coalesce, serialize IO, and retain a trailing pass', async () => {
    const release = [];
    let calls = 0;
    let concurrent = 0;
    let peak = 0;
    const task = new CoalescedTask(async () => {
        calls++;
        peak = Math.max(peak, ++concurrent);
        await new Promise(resolve => release.push(resolve));
        concurrent--;
    });
    const first = task.request();
    for (let i = 0; i < 50; i++) assert.equal(task.request(), first);
    await Promise.resolve();
    assert.equal(calls, 1);
    for (let i = 0; i < 50; i++) task.request();
    release.shift()();
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(calls, 2);
    release.shift()();
    await first;
    assert.equal(peak, 1);
});

test('failed refresh can be retried and diagnostics record failures without replacing errors', async () => {
    const diagnostics = new StartupDiagnostics();
    let fail = true;
    const task = new CoalescedTask(async () => {
        if (fail) throw new Error('expected');
    });
    await assert.rejects(diagnostics.measureAsync('scan', () => task.request()), /expected/);
    fail = false;
    await diagnostics.measureAsync('scan', () => task.request());
    const end = diagnostics.start('once');
    end(); end();
    const report = diagnostics.snapshot();
    assert.equal(report.phases.find(row => row.phase === 'scan').calls, 2);
    assert.equal(report.phases.find(row => row.phase === 'once').calls, 1);
});

test('actual explorer observer scans only inserted rows and reuses its observer across layout events', async (t) => {
    const source = await readFile(new URL('../main.ts', import.meta.url), 'utf8');
    const filter = source.slice(source.indexOf('    public updateFileExplorerVisibility('), source.indexOf('    private updateFileExplorerVisibilityModeClass('));
    const observer = source.slice(source.indexOf('    private observeFileExplorerVisibility('), source.indexOf('    private enableNativeTooltipSuppression('));
    const compiled = await esbuild.transform(`class Probe {
        settings = {}; observedFileExplorers = new Set(); fileExplorerVisibilityObserver = null;
        startupDiagnostics = new StartupDiagnostics();
        updateFileExplorerVisibilityModeClass() {} updateFileExplorerVisibilityRibbon() {}
        fileExplorerVisibilityRules() { return {}; } canObsidianOpenExtension() { return true; }
        fileExplorerVisibilityScope() { return { folderPaths: new Set(), seriesMetadataPaths: new Set() }; }
        ${filter} ${observer}
    }; globalThis.Probe = Probe;`, { loader: 'ts', target: 'es2020' });
    let visits = 0;
    let observers = 0;
    let callback;
    const row = { classList: { toggle: () => { visits++; } } };
    const title = () => ({ ...element(), dataset: { path: 'test.md' },
        matches: selector => selector.startsWith('.nav-file-title'),
        closest: () => row, querySelectorAll: () => [],
    });
    const titles = Array.from({ length: 6000 }, title);
    const explorer = { matches: () => false, querySelectorAll: selector => selector.startsWith('.nav-file-title') ? titles : [] };
    const sandbox = vm.createContext({
        StartupDiagnostics, addedMutationRoots, matchingElements,
        shouldHideFileExplorerFolder: () => false, shouldHideFileExplorerFile: () => false,
        activeDocument: { querySelectorAll: () => [explorer] },
        MutationObserver: class {
            constructor(cb) { observers++; callback = cb; }
            observe() {} disconnect() {}
        },
    });
    vm.runInContext(compiled.code, sandbox);
    const plugin = new sandbox.Probe();
    plugin.observeFileExplorerVisibility();
    assert.equal(visits, 6000);
    for (let i = 0; i < 20; i++) plugin.observeFileExplorerVisibility();
    assert.equal(observers, 1);
    assert.equal(visits, 6000);
    for (let i = 0; i < 100; i++) callback([{ addedNodes: [title()] }]);
    assert.equal(visits, 6100);
    callback([{ addedNodes: [], removedNodes: [title()] }]);
    assert.equal(visits, 6100);
    plugin.updateFileExplorerVisibility();
    assert.equal(visits, 12100, 'explicit settings changes still recheck the full tree');
    t.diagnostic('6000 existing rows + 100 single-row insertions: 6100 row checks, not 606000 full-scan checks (synthetic DOM).');
});
