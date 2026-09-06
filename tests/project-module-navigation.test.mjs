import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile } from 'node:fs/promises';
import { build, transform } from 'esbuild';
import ts from 'typescript';

const bundle = await build({ stdin: { contents: `export * from './models/ProjectCapabilities'; export * from './models/ProjectPages'; export * from './services/ProjectCapabilityService';`, resolveDir: process.cwd(), loader: 'ts' }, bundle: true, write: false, format: 'esm' });
const api = await import(`data:text/javascript;base64,${Buffer.from(bundle.outputFiles[0].text).toString('base64')}`);
const { normalizeProjectCapabilities: normalize, moduleEnabled: enabled, toggleProjectModule: toggle, PROJECT_PAGES } = api;
const custom = modules => normalize({ version: 2, preset: 'custom', modules });

test('v1 grouped boards and structure migrate without losing any former subview', () => {
    const legacy = normalize({ version: 1, preset: 'custom', modules: ['board', 'structure'] });
    for (const id of ['flatCanvas', 'columnBoard', 'timeline', 'trackComparison', 'plotList', 'subwayMap', 'chapterTemplates', 'scenes']) assert.ok(enabled(legacy, id), id);
    assert.equal(legacy.version, 2);
    assert.ok(!legacy.modules.some(id => ['board', 'structure', 'plotlines'].includes(id)));
    assert.deepEqual(normalize(legacy), legacy);
});

test('a v2 disabled page never reappears from a stale legacy alias', () => {
    const caps = custom(['flatCanvas', 'board', 'structure', 'plotlines']);
    assert.equal(enabled(caps, 'flatCanvas'), true);
    for (const id of ['columnBoard', 'timeline', 'plotList', 'subwayMap']) assert.equal(enabled(caps, id), false);
});

for (const id of ['flatCanvas', 'columnBoard', 'timeline', 'trackComparison', 'plotList', 'subwayMap', 'canvas']) {
    test(`${id} has an independent capability and unique workspace page`, () => {
        const caps = custom([id]);
        const pages = PROJECT_PAGES.filter(page => enabled(caps, page.module));
        assert.deepEqual(pages.map(page => page.module), [id]);
        assert.equal(enabled(custom(toggle(caps.modules, id, false)), id), false);
    });
}

test('chapter templates remain optional but do not occupy a navigation page', () => {
    const caps = custom(['chapterTemplates']);
    assert.ok(enabled(caps, 'chapterTemplates'));
    assert.ok(!PROJECT_PAGES.some(page => page.module === 'chapterTemplates'));
    assert.equal(enabled(custom(toggle(caps.modules, 'chapterTemplates', false)), 'chapterTemplates'), false);
});

test('generic card boards need Notes, not Scenes or Library', () => {
    const caps = custom(['flatCanvas', 'columnBoard']);
    assert.ok(enabled(caps, 'notes'));
    for (const id of ['scenes', 'library', 'table', 'canvas']) assert.equal(enabled(caps, id), false);
    assert.equal(enabled(caps, 'board'), true, 'shared storage owner stays active');
    assert.deepEqual(toggle(caps.modules, 'notes', false), []);
});

test('project tab preferences are deduplicated, retained and isolated', () => {
    const a = normalize({ ...custom(['flatCanvas', 'columnBoard']), navigation: { order: ['columnBoard', 'bogus', 'flatCanvas', 'columnBoard'], hidden: ['flatCanvas'], defaultPage: 'columnBoard' } });
    assert.deepEqual(a.navigation, { order: ['columnBoard', 'flatCanvas'], hidden: ['flatCanvas'], defaultPage: 'columnBoard' });
    assert.equal(custom(['manuscript']).navigation, undefined);
    assert.ok(enabled(a, 'flatCanvas'), 'hiding is not disabling');
    assert.deepEqual(normalize(a), a);
});

test('dragged tab order keeps unseen pages after the visible strip', () => {
    assert.deepEqual(api.mergeProjectPageOrder(['manuscript', 'table', 'timeline'], ['table', 'manuscript']),
        ['table', 'manuscript', 'timeline', ...PROJECT_PAGES.map(page => page.module).filter(id => !['table', 'manuscript', 'timeline'].includes(id))]);
    assert.deepEqual(api.sortByProjectPageOrder(
        [{ type: 'narrative-lab-plotgrid' }, { type: 'narrative-lab-manuscript' }],
        ['table', 'manuscript'],
    ).map(item => item.type), ['narrative-lab-plotgrid', 'narrative-lab-manuscript']);
});

test('tab groups flatten drag order without dropping later pages', () => {
    assert.deepEqual(api.PROJECT_TAB_GROUPS.map(group => group.id), ['manuscript', 'organize', 'planning', 'library', 'presentation']);
    assert.deepEqual(api.flattenTabGroupOrder(['planning', 'manuscript'], ['manuscript', 'flatCanvas', 'timeline', 'plotList']), [
        'timeline', 'plotList', 'trackComparison', 'subwayMap', 'manuscript',
        ...PROJECT_PAGES.map(page => page.module).filter(id => !['timeline', 'plotList', 'trackComparison', 'subwayMap', 'manuscript'].includes(id)),
    ]);
    assert.deepEqual(api.sortTabGroups([...api.PROJECT_TAB_GROUPS], ['timeline', 'manuscript']).map(group => group.id),
        ['planning', 'manuscript', 'organize', 'library', 'presentation']);
});

test('capability persistence rolls back memory on failure and never deletes files', async () => {
    const before = custom(['flatCanvas']);
    const project = { filePath: 'Projects/论文/论文.md', capabilities: before };
    const calls = [];
    const service = new api.ProjectCapabilityService({
        ensureProjectModuleStorage: async (_project, caps) => calls.push(caps),
        saveProjectFrontmatter: async () => { throw new Error('disk full'); },
    });
    await assert.rejects(service.apply(project, custom(['columnBoard'])), /disk full/);
    assert.equal(project.capabilities, before);
    assert.equal(calls.length, 1);
});

test('tab order writes skip module storage and roll back on failure', async () => {
    const before = custom(['flatCanvas']);
    const project = { filePath: 'Projects/论文/论文.md', capabilities: before };
    const calls = [];
    const failing = new api.ProjectCapabilityService({
        ensureProjectModuleStorage: async () => calls.push('storage'),
        saveProjectFrontmatter: async () => { throw new Error('disk full'); },
    });
    await assert.rejects(failing.applyNavigation(project, { order: ['flatCanvas'], hidden: [] }), /disk full/);
    assert.equal(project.capabilities, before);
    assert.deepEqual(calls, []);
    const ok = new api.ProjectCapabilityService({
        ensureProjectModuleStorage: async () => calls.push('storage'),
        saveProjectFrontmatter: async () => calls.push('save'),
    });
    await ok.applyNavigation(project, { order: ['flatCanvas'], hidden: [] });
    assert.deepEqual(calls, ['save']);
    assert.deepEqual(project.capabilities.navigation.order, ['flatCanvas']);
});

const mainText = await readFile('main.ts', 'utf8');
const mainAst = ts.createSourceFile('main.ts', mainText, ts.ScriptTarget.Latest, true);
const mainClass = mainAst.statements.find(node => ts.isClassDeclaration(node) && node.name?.text === 'SceneCardsPlugin');
const method = mainClass.members.find(node => node.name?.getText(mainAst) === 'updateProjectModules').getText(mainAst);
const { code } = await transform(`class Probe { ${method} }; export { Probe };`, { loader: 'ts', format: 'cjs' });
function lifecycleFixture(failure) {
    const calls = [], target = { filePath: 'Projects/论文/论文.md' };
    const a = { getViewState: () => ({ type: 'column', state: { narrativeLabProjectFile: target.filePath } }), view: { getViewType: () => 'column', prepareForModuleDisable: async () => { calls.push('flush'); if (failure === 'flush') throw Error('save failed'); } }, async setViewState(state) { calls.push(state.type); } };
    const b = { getViewState: () => ({ type: 'column', state: { narrativeLabProjectFile: 'Other/Other.md' } }), view: { getViewType: () => 'column' }, async setViewState() { throw Error('wrong project'); } };
    const module = { exports: {} };
    new Function('module', 'moduleEnabled', 'normalizePath', 'getLeafNarrativeLabProjectFile', 'narrativeLabLeafState', 'PROJECT_OVERVIEW_VIEW_TYPE', 't', code)(module, enabled, path => path, leaf => leaf.getViewState().state.narrativeLabProjectFile, (path, extra) => ({ narrativeLabProjectFile: path, ...extra }), 'overview', key => key);
    const probe = new module.exports.Probe();
    Object.assign(probe, {
        app: { workspace: { iterateAllLeaves: fn => [a, b].forEach(fn) } },
        moduleForView: () => 'columnBoard',
        sceneManager: { activeProject: target, setActiveProject: async () => calls.push('reload') },
        flushWritingTrackers() {}, settleWritingTrackerChanges: async () => {}, saveProjectSystemData: async () => calls.push('system-save'),
        capabilityService: { apply: async () => { calls.push('apply'); if (failure === 'apply') throw Error('manifest failed'); } },
    });
    return { probe, calls, target };
}
test('disabling flushes under old capabilities, saves, then shows a project-bound disabled page', async () => {
    const f = lifecycleFixture();
    await f.probe.updateProjectModules(f.target, custom([]));
    assert.deepEqual(f.calls, ['flush', 'empty', 'system-save', 'apply', 'overview', 'reload']);
});
test('failed editor save prevents capability mutation or tab unloading', async () => {
    const f = lifecycleFixture('flush');
    await assert.rejects(f.probe.updateProjectModules(f.target, custom([])), /save failed/);
    assert.deepEqual(f.calls, ['flush']);
    assert.equal(f.probe.moduleUpdateInProgress, false);
});
test('failed manifest save restores suspended leaves', async () => {
    const f = lifecycleFixture('apply');
    await assert.rejects(f.probe.updateProjectModules(f.target, custom([])), /manifest failed/);
    assert.deepEqual(f.calls, ['flush', 'empty', 'system-save', 'apply', 'column']);
});

test('creation and settings share the grouped picker; writing counters are the final two rows', async () => {
    const picker = await readFile('components/ProjectModulePicker.ts', 'utf8');
    assert.match(picker, /Narrative planning'[\s\S]*?Narrative content'[\s\S]*?Materials and research'/);
    assert.match(picker, /Writing progress', icon: 'chart-no-axes-column', modules: \['writingTracker', 'writingStats'\]/);
    assert.match(mainText, /renderProjectModulePicker\(moduleChoices/);
    assert.match(mainText, /const labels = \[t\('Project basics'\), t\('Choose modules'\), t\('Review and create'\)\]/);
    assert.doesNotMatch(mainText, /const browseBtn/);
    const styles = await readFile('styles.css', 'utf8');
    const rule = styles.match(/\.nl-project-module-choices\s*\{[^}]+\}/)[0];
    assert.doesNotMatch(rule, /max-height|overflow-y:\s*auto/);
    const cell = styles.match(/\.nl-project-module-picker \.nl-module-grid > \.setting-item \{[^}]+\}/)[0];
    assert.match(cell, /padding:\s*10px 14px/);
    assert.match(cell, /flex-flow:\s*row nowrap/);
    assert.match(styles, /\.nl-project-module-picker \.nl-module-grid \.setting-item-control \{[\s\S]*?position:\s*static !important/);
    assert.match(styles, /\.nl-project-module-picker \.nl-module-grid \.setting-item-description \{[\s\S]*?overflow-wrap:\s*anywhere/);
    assert.match(styles, /\.nl-module-group \{[^}]*padding:\s*14px 16px 16px/s);
    assert.match(styles, /\.nl-module-grid \{[\s\S]*?grid-template-columns:\s*repeat\(2,/);
    assert.doesNotMatch(styles, /\.nl-module-grid > \.setting-item:last-child:nth-child\(odd\)/);
    assert.doesNotMatch(styles, /\.nl-module-group-tracking \.nl-module-grid \{[^}]*grid-template-columns:\s*1fr/);
});

test('tab bar drag reorders without disabling modules', async () => {
    const switcher = await readFile('components/ViewSwitcher.ts', 'utf8');
    assert.match(switcher, /tab\.draggable = true/);
    assert.match(switcher, /updateProjectTabOrder/);
    assert.match(switcher, /flattenTabGroupOrder/);
    assert.match(switcher, /PROJECT_TAB_GROUPS/);
    assert.match(mainText, /async updateProjectTabOrder/);
    const orderFn = mainText.slice(mainText.indexOf('async updateProjectTabOrder'), mainText.indexOf('closeDisabledProjectViews'));
    assert.doesNotMatch(orderFn, /prepareForModuleDisable/);
    assert.match(orderFn, /applyNavigation/);
});
