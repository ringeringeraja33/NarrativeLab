import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const [mainTs, boardView, navigatorView, viewSwitcher, leafState, corkboard, codexTabs, projectBoundView, structureSwitcher, codexView, ...projectViews] = await Promise.all([
    readFile(new URL('../main.ts', import.meta.url), 'utf8'),
    readFile(new URL('../views/BoardView.ts', import.meta.url), 'utf8'),
    readFile(new URL('../views/NavigatorView.ts', import.meta.url), 'utf8'),
    readFile(new URL('../components/ViewSwitcher.ts', import.meta.url), 'utf8'),
    readFile(new URL('../utils/narrativeLabLeafState.ts', import.meta.url), 'utf8'),
    readFile(new URL('../services/CorkboardCanvasService.ts', import.meta.url), 'utf8'),
    readFile(new URL('../components/CodexCategoryTabs.ts', import.meta.url), 'utf8'),
    readFile(new URL('../views/ProjectBoundItemView.ts', import.meta.url), 'utf8'),
    readFile(new URL('../components/StructureModeSwitcher.ts', import.meta.url), 'utf8'),
    readFile(new URL('../views/CodexView.ts', import.meta.url), 'utf8'),
    ...[
        'PlotgridView.ts',
        'TimelineView.ts',
        'StorylineView.ts',
        'CharacterView.ts',
        'LocationView.ts',
        'CodexView.ts',
        'StatsView.ts',
        'ManuscriptView.ts',
        'ResearchView.ts',
    ].map(name => readFile(new URL(`../views/${name}`, import.meta.url), 'utf8')),
]);

test('NarrativeLab leaf state binds tabs to a project file', () => {
    assert.match(leafState, /NARRATIVE_LAB_PROJECT_FILE_STATE_KEY/);
    assert.match(leafState, /getLeafNarrativeLabProjectFile/);
    assert.match(leafState, /preservedNarrativeLabLeafState/);
});

test('Open Project opens a per-project Board tab instead of reusing the first leaf', () => {
    assert.match(mainTs, /async openBoardForProject\(/);
    assert.match(mainTs, /workspace\.getLeaf\('tab'\)/);
    assert.match(mainTs, /countProjectScopedLeaves/);
    assert.match(mainTs, /hasScopedLeaves \? workspace\.getLeaf\('tab'\) : workspace\.getLeaf\(false\)/);
    assert.match(mainTs, /syncActiveProjectFromLeaf/);
    assert.match(mainTs, /bound && activePath && bound !== activePath/);
    assert.match(navigatorView, /openBoardForProject\(project\)/);
    assert.match(navigatorView, /openProjectFromNavigator\(project\)/);
    assert.doesNotMatch(navigatorView, /activateView\(BOARD_VIEW_TYPE\)/);
});

test('Leaf project binding falls back to view.getBoundProjectFile', () => {
    assert.match(leafState, /getBoundProjectFile/);
});

test('CodexCategoryTabs preserves project binding when switching to uncategorized', () => {
    assert.match(codexTabs, /preservedNarrativeLabLeafState\(leaf\)/);
    assert.doesNotMatch(
        codexTabs.slice(codexTabs.indexOf('uncategorizedTab.addEventListener')),
        /state:\s*\{\s*\}/,
    );
});

test('BoardView persists project binding and skips foreign-project refresh', () => {
    assert.match(boardView, /boundProjectFile/);
    assert.match(boardView, /getBoundProjectFile/);
    assert.match(boardView, /getState\(\): Record<string, unknown>/);
    assert.match(boardView, /async setState\(/);
    assert.match(boardView, /this\.boundProjectFile !== activePath/);
});

test('corkboard canvas I/O is scoped to the Board leaf project, not global activeProject', () => {
    assert.match(boardView, /resolveCorkboardProjectFile/);
    assert.match(boardView, /isForeignActiveProject/);
    assert.match(boardView, /getBoundCorkboardCanvasPath/);
    assert.match(boardView, /Refusing to write foreign corkboard snapshot/);
    assert.match(corkboard, /getCanvasPath\(projectFilePath/);
    assert.match(corkboard, /isNlManagedPath\(path: string, projectFilePath/);
});

test('ViewSwitcher preserves project binding across in-leaf view changes', () => {
    assert.match(viewSwitcher, /preservedNarrativeLabLeafState\(leaf\)/);
    assert.doesNotMatch(
        viewSwitcher.slice(viewSwitcher.indexOf('entry.type !== activeViewType')),
        /state:\s*\{\s*\}/,
    );
});

test('Every project-scoped main view persists its leaf project binding', () => {
    assert.match(projectBoundView, /getBoundProjectFile\(\): string \| null/);
    assert.match(projectBoundView, /getState\(\): Record<string, unknown>/);
    assert.match(projectBoundView, /async setState\(/);
    assert.match(projectBoundView, /NARRATIVE_LAB_PROJECT_FILE_STATE_KEY/);
    assert.match(projectBoundView, /resolveProjectTitle/);
    for (const source of projectViews) {
        assert.match(source, /extends ProjectBoundItemView/);
        assert.match(source, /ensureProjectBinding\(/);
        assert.match(source, /resolveProjectTitle\(/);
    }
});

test('Structure and Library in-place switches cannot erase the project binding', () => {
    assert.match(structureSwitcher, /preservedNarrativeLabLeafState\(leaf\)/);
    assert.match(codexView, /preservedNarrativeLabLeafState\(this\.leaf\)/);
    const activateInPlace = mainTs.slice(
        mainTs.indexOf('async activateViewInPlace('),
        mainTs.indexOf('async openQuickAdd('),
    );
    assert.match(activateInPlace, /preservedNarrativeLabLeafState\(leaf\)/);
    assert.doesNotMatch(structureSwitcher, /state:\s*\{\}/);
});

test('Global refresh skips leaves bound to another project', () => {
    const refresh = mainTs.slice(
        mainTs.indexOf('private async doRefreshOpenViews('),
        mainTs.indexOf('private async refreshPlotGridViews('),
    );
    assert.match(refresh, /getLeafNarrativeLabProjectFile\(leaf\)/);
    assert.match(refresh, /bound && \(!activePath \|\| bound !== activePath\)/);
    assert.match(refresh, /continue/);
});
