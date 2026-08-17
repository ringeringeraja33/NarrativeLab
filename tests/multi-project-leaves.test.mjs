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

test('Open Project reuses the same project tab and opens a new tab only for another project', () => {
    assert.match(mainTs, /async openBoardForProject\(/);
    assert.match(mainTs, /private findProjectScopedLeaf\(projectFile: string\)/);
    assert.match(mainTs, /getLeafNarrativeLabProjectFile\(item\) === normalized/);
    assert.match(mainTs, /leaf = this\.findProjectScopedLeaf\(projectFile\)/);
    assert.match(mainTs, /workspace\.getLeaf\('tab'\)/);
    assert.match(mainTs, /countProjectScopedLeaves/);
    assert.match(mainTs, /hasScopedLeaves \? workspace\.getLeaf\('tab'\) : workspace\.getLeaf\(false\)/);
    assert.match(mainTs, /syncActiveProjectFromLeaf/);
    assert.match(mainTs, /bound !== targetProject/);
    assert.match(mainTs, /refreshPlotGridViews\(filePath\)/);
    assert.match(navigatorView, /openBoardForProject\(project\)/);
    assert.match(navigatorView, /openProjectFromNavigator\(project\)/);
    assert.doesNotMatch(navigatorView, /activateView\(BOARD_VIEW_TYPE\)/);
    const switchProject = mainTs.slice(
        mainTs.indexOf("id: 'switch-project'"),
        mainTs.indexOf("id: 'manage-ncanvas-files'"),
    );
    assert.match(switchProject, /openBoardForProject\(project\)/);
    assert.doesNotMatch(switchProject, /setActiveProject\(project\)/);
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

test('Project-scoped main tabs display only the project name', () => {
    assert.match(boardView, /if \(project\?\.title\) return project\.title/);
    for (const source of projectViews) {
        const start = source.indexOf('getDisplayText(): string');
        const end = source.indexOf('getIcon()', start);
        const displayText = source.slice(start, end);
        assert.match(displayText, /return title \|\|/);
        assert.doesNotMatch(displayText, /NarrativeLab\s*[-—]\s*\$\{title\}/);
    }
});

test('Structure and Library in-place switches cannot erase the project binding', () => {
    assert.match(structureSwitcher, /preservedNarrativeLabLeafState\(leaf\)/);
    assert.match(codexView, /preservedNarrativeLabLeafState\(this\.leaf\)/);
    assert.doesNotMatch(structureSwitcher, /state:\s*\{\}/);
});

test('navigation and plot-grid link rewrites stay on the owning project', () => {
    assert.match(mainTs, /findProjectFileForVaultPath/);
    assert.match(mainTs, /findBoundLeafOfType/);
    assert.match(mainTs, /async activateView\(viewType: string, projectFile\?: string \| null\)/);
    assert.match(mainTs, /async openPlotGridAppearance[\s\S]*?activateView\(PLOTGRID_VIEW_TYPE, projectFile\)/);
    assert.match(mainTs, /async showEntityDetails[\s\S]*?activateView\(CHARACTER_VIEW_TYPE, projectFile\)/);
    assert.doesNotMatch(
        mainTs.slice(mainTs.indexOf('private async updatePlotGridLinkedSceneIds'), mainTs.indexOf('private debounce<')),
        /await this\.savePlotGrid\(data\);/,
    );
    assert.match(mainTs, /savePlotGrid\(data, \{ projectFilePath: projectFile \}\)/);
    const view = projectViews[0];
    assert.match(view, /const sourcePath = this\.getTargetProjectFile\(\)/);
    assert.doesNotMatch(view, /collectConnectedNotes[\s\S]*?activeProject\?\.filePath/);
});

test('in-view titles follow the leaf-bound project, not the focused tab', () => {
    assert.match(mainTs, /getProjectDisplayName\(projectFile\?: string \| null\)/);
    assert.match(mainTs, /never borrow another tab's active project/);
    assert.match(mainTs, /const projectLabel = this\.getProjectDisplayName\(bound\)/);
    assert.match(mainTs, /setActiveProject\(project, \{ fromLeafFocus: true \}\)/);
    assert.match(mainTs, /stashProjectRuntime/);
    assert.match(mainTs, /restoreProjectRuntime/);
    assert.match(boardView, /getProjectDisplayName\(this\.boundProjectFile\)/);
    for (const source of projectViews) {
        assert.match(source, /getProjectDisplayName\(this\.getBoundProjectFile\(\)\)|resolveProjectTitle\(/);
        assert.doesNotMatch(source, /getActiveProjectDisplayName\(\)/);
    }
});

test('Library Archive/Browse and category chrome stay per project', () => {
    assert.match(codexView, /getLibraryContentMode\(this\.plugin, this\.getBoundProjectFile\(\)\)/);
    assert.match(codexView, /setLibraryContentMode\(this\.plugin, 'profile', this\.getBoundProjectFile\(\)\)/);
    assert.match(codexTabs, /getLeafNarrativeLabProjectFile\(leaf\)/);
    assert.match(codexTabs, /rememberLibraryCategory\(plugin, categoryId, projectFile\)/);
    assert.match(viewSwitcher, /resolveLibraryViewType\(plugin, projectFile\)/);
    assert.doesNotMatch(codexView, /getLibraryContentMode\(this\.plugin\) ===/);
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
