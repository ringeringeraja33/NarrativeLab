import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const [
    mainTs,
    sceneManager,
    queryService,
    undoManager,
    libraryModeBar,
    settings,
    floatingUtil,
    floatingManager,
    floatingUi,
    navigatorView,
    manuscriptView,
    projectBound,
    timelineView,
    storylineView,
    statsView,
    characterView,
    locationView,
    codexView,
    researchView,
    inspectorView,
    detailsView,
    notesView,
    synopsisView,
] = await Promise.all([
    readFile(new URL('../main.ts', import.meta.url), 'utf8'),
    readFile(new URL('../services/SceneManager.ts', import.meta.url), 'utf8'),
    readFile(new URL('../services/SceneQueryService.ts', import.meta.url), 'utf8'),
    readFile(new URL('../services/UndoManager.ts', import.meta.url), 'utf8'),
    readFile(new URL('../components/LibraryModeBar.ts', import.meta.url), 'utf8'),
    readFile(new URL('../settings.ts', import.meta.url), 'utf8'),
    readFile(new URL('../utils/floatingStickyNote.ts', import.meta.url), 'utf8'),
    readFile(new URL('../services/FloatingStickyNoteManager.ts', import.meta.url), 'utf8'),
    readFile(new URL('../components/FloatingStickyNote.ts', import.meta.url), 'utf8'),
    readFile(new URL('../views/NavigatorView.ts', import.meta.url), 'utf8'),
    readFile(new URL('../views/ManuscriptView.ts', import.meta.url), 'utf8'),
    readFile(new URL('../views/ProjectBoundItemView.ts', import.meta.url), 'utf8'),
    readFile(new URL('../views/TimelineView.ts', import.meta.url), 'utf8'),
    readFile(new URL('../views/StorylineView.ts', import.meta.url), 'utf8'),
    readFile(new URL('../views/StatsView.ts', import.meta.url), 'utf8'),
    readFile(new URL('../views/CharacterView.ts', import.meta.url), 'utf8'),
    readFile(new URL('../views/LocationView.ts', import.meta.url), 'utf8'),
    readFile(new URL('../views/CodexView.ts', import.meta.url), 'utf8'),
    readFile(new URL('../views/ResearchView.ts', import.meta.url), 'utf8'),
    readFile(new URL('../views/SceneInspectorView.ts', import.meta.url), 'utf8'),
    readFile(new URL('../views/DetailsView.ts', import.meta.url), 'utf8'),
    readFile(new URL('../views/NotesView.ts', import.meta.url), 'utf8'),
    readFile(new URL('../views/SynopsisView.ts', import.meta.url), 'utf8'),
]);

const switchProject = sceneManager.slice(
    sceneManager.indexOf('async setActiveProject('),
    sceneManager.indexOf('async renameProject('),
);

const isolate = mainTs.slice(
    mainTs.indexOf('isolateProjectTransientState()'),
    mainTs.indexOf('rebindWritingTrackerSession()'),
);

const scanPlotGrid = mainTs.slice(
    mainTs.indexOf('async scanPlotGridCells()'),
    mainTs.indexOf('async openPlotGridAppearance('),
);

test('project switch isolates transient caches after indexes load and before views refresh', () => {
    assert.match(switchProject, /isolateProjectTransientState\(\)/);
    assert.match(switchProject, /rebindWritingTrackerSession\(\)/);
    assert.ok(
        switchProject.indexOf('isolateProjectTransientState()')
            < switchProject.indexOf('refreshViewsOnly()'),
        'tab-focus switch must isolate before views read the live indexes',
    );
    assert.ok(
        switchProject.indexOf('isolateProjectTransientState()')
            < switchProject.indexOf('refreshOpenViews()'),
        'explicit switch must isolate before views refresh',
    );
    assert.match(sceneManager, /Never call isolateProjectTransientState\(\) from inside this loop/);
});

test('isolateProjectTransientState clears scanner, undo, stems, plotgrid, notes, and navigator', () => {
    assert.match(isolate, /invalidatePlotGridScanCache\(\)/);
    assert.match(isolate, /linkScanner\.invalidateAll\(\)/);
    assert.match(isolate, /linkScanner\.rebuildLookups\(this\.settings\.characterAliases\)/);
    assert.match(isolate, /linkScanner\.scanAll\(this\.sceneManager\.getAllScenes\(\)\)/);
    assert.match(isolate, /undoManager\.clear\(\)/);
    assert.match(isolate, /queryService\.clearCaches\(\)/);
    assert.match(isolate, /rebuildSceneTitleToStemMap\(\)/);
    assert.match(isolate, /clearPendingStoryGraphWikilinks\(\)/);
    assert.match(isolate, /clearLastManuscriptState\(\)/);
    assert.match(isolate, /syncVisibleNotesForProject/);
    assert.match(isolate, /resetProjectTransientUi/);
    assert.match(undoManager, /clear\(\): void/);
    assert.match(queryService, /clearCaches\(\): void/);
    assert.match(sceneManager, /rebuildSceneTitleToStemMap\(\): void/);
});

test('plotgrid mention cache is keyed by the active project file', () => {
    assert.match(mainTs, /_plotGridScanCache: \{\s*projectFile: string;/);
    assert.match(scanPlotGrid, /cached\.projectFile === projectFile/);
    assert.match(scanPlotGrid, /projectFile, at: Date\.now\(\), result/);
});

test('story-graph filters and layout are keyed per project, not a global plugin field', () => {
    assert.match(settings, /storyGraphFilters\?:/);
    assert.match(libraryModeBar, /export function clearPendingStoryGraphWikilinks/);
    assert.match(libraryModeBar, /getStoryGraphFilters\(\s*plugin: SceneCardsPlugin,\s*projectFile\?:/);
    assert.match(libraryModeBar, /setStoryGraphFilters\(\s*plugin: SceneCardsPlugin,\s*filters: StoryGraphFilterState,\s*projectFile\?:/);
    assert.doesNotMatch(libraryModeBar, /libraryStoryGraphFilters/);
    assert.match(libraryModeBar, /resolveLibraryUiProjectFile\(plugin, projectFile\) \|\| '__global__'/);
    assert.match(characterView, /renderLibraryStoryGraph\([\s\S]*this\.getBoundProjectFile\(\)\)/);
    assert.match(locationView, /renderLibraryStoryGraph\([\s\S]*this\.getBoundProjectFile\(\)\)/);
    assert.match(codexView, /renderLibraryStoryGraph\([\s\S]*this\.getBoundProjectFile\(\)\)/);
});

test('floating sticky notes stamp and filter by projectFile', () => {
    assert.match(floatingUtil, /projectFile\?: string/);
    assert.match(floatingUtil, /export function stickyNoteBelongsToProject/);
    assert.match(floatingManager, /syncVisibleNotesForProject\(projectFile: string \| null\)/);
    assert.match(floatingManager, /stickyNoteBelongsToProject/);
    assert.match(floatingUi, /projectFile: this\.plugin\.sceneManager\.activeProject\?\.filePath/);
});

test('navigator and manuscript drop the previous book\'s session chrome', () => {
    assert.match(navigatorView, /resetProjectTransientUi\(\): void/);
    assert.match(navigatorView, /this\.plotlineFilter = null/);
    assert.match(navigatorView, /this\.selectedScenePath = null/);
    assert.match(manuscriptView, /export function clearLastManuscriptState/);
});

test('project-bound views skip refresh when the live project is a different book', () => {
    assert.match(projectBound, /isBoundToActiveProject\(sceneManager: SceneManager\)/);
    for (const [name, source] of [
        ['TimelineView', timelineView],
        ['StorylineView', storylineView],
        ['StatsView', statsView],
        ['CharacterView', characterView],
        ['LocationView', locationView],
        ['CodexView', codexView],
        ['ManuscriptView', manuscriptView],
        ['ResearchView', researchView],
    ]) {
        assert.match(source, /isBoundToActiveProject/, `${name} must skip foreign-project refresh`);
    }
});

test('sidebar inspectors hide a scene that is not in the new project index', () => {
    assert.match(mainTs, /SCENE_INSPECTOR_VIEW_TYPE,/);
    assert.match(mainTs, /DETAILS_VIEW_TYPE,/);
    assert.match(mainTs, /NOTES_VIEW_TYPE,/);
    assert.match(mainTs, /SYNOPSIS_VIEW_TYPE,/);
    assert.match(inspectorView, /refresh\(\): void/);
    assert.match(detailsView, /refresh\(\): void/);
    assert.match(notesView, /refresh\(\): void/);
    assert.match(synopsisView, /refresh\(\): void/);
    assert.match(inspectorView, /!this\.sceneManager\.getScene\(current\.filePath\)/);
    assert.match(detailsView, /!this\.sceneManager\.getScene\(current\.filePath\)/);
    assert.match(notesView, /!this\.sceneManager\.getScene\(this\.currentScenePath\)/);
    assert.match(synopsisView, /!this\.sceneManager\.getScene\(current\.filePath\)/);
});
