import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const [corkboard, boardView, seriesManager, sceneManager, categoryTabs, i18nAudit, templateCenter, applyModal, quickAdd, characterView, storyGraph, nativeLibraryBase, libraryCategorySync, codexView, libraryModeBar, locationView, mainTs, styles, validator, statsView] = await Promise.all([
    readFile(new URL('../services/CorkboardCanvasService.ts', import.meta.url), 'utf8'),
    readFile(new URL('../views/BoardView.ts', import.meta.url), 'utf8'),
    readFile(new URL('../services/SeriesManager.ts', import.meta.url), 'utf8'),
    readFile(new URL('../services/SceneManager.ts', import.meta.url), 'utf8'),
    readFile(new URL('../components/CodexCategoryTabs.ts', import.meta.url), 'utf8'),
    readFile(new URL('../scripts/audit-i18n-coverage.mjs', import.meta.url), 'utf8'),
    readFile(new URL('../services/TemplateCenterService.ts', import.meta.url), 'utf8'),
    readFile(new URL('../components/BeatSheetApplyModal.ts', import.meta.url), 'utf8'),
    readFile(new URL('../components/QuickAddModal.ts', import.meta.url), 'utf8'),
    readFile(new URL('../views/CharacterView.ts', import.meta.url), 'utf8'),
    readFile(new URL('../components/StoryGraph.ts', import.meta.url), 'utf8'),
    readFile(new URL('../components/NativeLibraryBase.ts', import.meta.url), 'utf8'),
    readFile(new URL('../services/LibraryCategorySync.ts', import.meta.url), 'utf8'),
    readFile(new URL('../views/CodexView.ts', import.meta.url), 'utf8'),
    readFile(new URL('../components/LibraryModeBar.ts', import.meta.url), 'utf8'),
    readFile(new URL('../views/LocationView.ts', import.meta.url), 'utf8'),
    readFile(new URL('../main.ts', import.meta.url), 'utf8'),
    readFile(new URL('../styles.css', import.meta.url), 'utf8'),
    readFile(new URL('../services/Validator.ts', import.meta.url), 'utf8'),
    readFile(new URL('../views/StatsView.ts', import.meta.url), 'utf8'),
]);

test('CSS disclosure indicators are valid and cannot render corrupted text', () => {
    assert.doesNotMatch(styles, /content:\s*['"]\?\?;/);
    assert.equal((styles.match(/content:\s*'▶';/g) || []).length, 4);
    assert.match(styles, /data-narrative-lab-language='zh'[^}]+content:\s*'关'/s);
    assert.match(styles, /data-narrative-lab-language='zh'[^}]+content:\s*'开'/s);
});

test('Order and plotline tools share one Structure tab with five subviews', async () => {
    const [switcher, modes, timeline, storyline] = await Promise.all([
        readFile(new URL('../components/ViewSwitcher.ts', import.meta.url), 'utf8'),
        readFile(new URL('../components/StructureModeSwitcher.ts', import.meta.url), 'utf8'),
        readFile(new URL('../views/TimelineView.ts', import.meta.url), 'utf8'),
        readFile(new URL('../views/StorylineView.ts', import.meta.url), 'utf8'),
    ]);
    assert.match(switcher, /label: 'Structure'/);
    assert.doesNotMatch(switcher, /label: 'Order'/);
    assert.doesNotMatch(switcher, /label: 'Plotlines'/);
    for (const label of ['Timeline', 'Track comparison', 'Plot list', 'Subway map', 'Chapter templates']) {
        assert.match(modes, new RegExp(`label: '${label}'`));
    }
    assert.match(timeline, /renderStructureModeSwitcher/);
    assert.match(storyline, /renderStructureModeSwitcher/);
    assert.match(modes, /if \(localAction\) \{[\s\S]*?localAction\(\);[\s\S]*?return;/);
    assert.match(timeline, /await this\.sceneManager\.ensureInitialized\(\)/);
    assert.match(storyline, /await this\.sceneManager\.ensureInitialized\(\)/);
    assert.match(modes, /if \(switching\) return/);
    assert.match(modes, /'aria-pressed'/);
    assert.match(timeline, /private setZoomLevel/);
    assert.doesNotMatch(timeline, /private refreshTimeline/);
    assert.match(timeline, /window\.cancelAnimationFrame\(this\._pendingRefresh\)/);
    assert.match(storyline, /if \(this\.plotlineViewMode === mode\) return/);
    assert.match(storyline, /if \(this\.sortMode === mode\) return/);
    assert.match(storyline, /window\.cancelAnimationFrame\(this\._pendingRefresh\)/);
    assert.match(storyline, /scrollTop = scroll\.top/);
    assert.match(styles, /data-type="narrative-lab-timeline"[^}]+flex-wrap:\s*nowrap/s);
    assert.match(styles, /data-type="narrative-lab-timeline"[^}]+overflow-x:\s*auto/s);
});

test('column link badge stays in flow and cannot cover the scene title', () => {
    const rule = styles.match(/\.story-line-column-body\.story-line-column-body \.scene-card-detected-badge\s*\{[^}]+\}/)?.[0] || '';
    assert.match(rule, /position:\s*static/);
    assert.match(rule, /width:\s*fit-content/);
    assert.doesNotMatch(rule, /(?:^|\n)\s*(?:position:\s*absolute|left:\s*100px|top:\s*6px)/);
});

test('unreadable corkboard Canvas files abort without being rewritten', () => {
    assert.match(corkboard, /The original file was not changed/);
    assert.doesNotMatch(corkboard, /catch\s*\{\s*return \{ nodes: \[\], edges: \[\] \}/);
    assert.doesNotMatch(corkboard, /Fall through and rewrite if current content is unreadable/);
    assert.doesNotMatch(corkboard, /If exactly one \.canvas remains/);
    assert.match(corkboard, /Never adopt an arbitrary lone \.canvas/);
});

test('corkboard parking cannot reuse an old selection', () => {
    assert.match(boardView, /allowCapturedSnapshot && removeSelectionCaptured/);
    assert.match(boardView, /removeSelectionCaptured = before\.managedPaths\.length > 0 \|\| before\.hasNonManaged/);
    assert.match(boardView, /classifyCorkboardSelection/);
    assert.match(boardView, /hasNonManaged/);
    // Pure groups must reach native delete; only exclusively managed cards are parked.
    assert.match(boardView, /info\.managedPaths\.length === 0 \|\| info\.hasNonManaged/);
    assert.match(boardView, /selected\.length === 0 && canvas\.nodes/);
});

test('corkboard group deletion is not blocked by managed-card parking', () => {
    assert.match(boardView, /deselectManagedCards/);
    assert.match(boardView, /info\.managedPaths\.length > 0 && info\.hasNonManaged/);
    assert.match(boardView, /deselectManagedCards\(info\.managedPaths\)/);
});

test('corkboard membership changes force remount instead of stale live Canvas', () => {
    assert.match(boardView, /membershipChanged/);
    assert.match(boardView, /forceReload: synced\.membershipChanged/);
    assert.match(boardView, /pruneLiveCorkboardToVisible/);
    assert.match(boardView, /corkboardHostSyncChain/);
    assert.match(boardView, /isCorkboardPathInactive/);
    assert.match(boardView, /captureLiveCorkboardPositions/);
    assert.match(boardView, /teardownNativeCorkboardCanvas\(\)/);
    assert.match(boardView, /showScenesInCorkboard \? 'scenes:1' : 'scenes:0'/);
    // Skip disk rewrite when membership fingerprint is unchanged (even without a live leaf).
    assert.match(boardView, /Fast path: membership unchanged/);
    assert.match(boardView, /isCorkboardCanvasBusy/);
    assert.match(boardView, /prepareCorkboardCanvasDetach/);
    assert.match(boardView, /requestSave[\s\S]*cancel/);
    // Do not assume vault.modify reloads an already-hosted Canvas view.
    assert.doesNotMatch(boardView, /Obsidian reloads file nodes/);
});

test('corkboard canvas writes are queued and retried on Windows locks', () => {
    assert.match(corkboard, /enqueueWrite/);
    assert.match(corkboard, /modifyWithRetry/);
    assert.match(corkboard, /attempt < 8/);
});

test('series migrations journal transfers and roll back every move path', () => {
    assert.match(seriesManager, /interface LibraryTransferJournal/);
    assert.match(seriesManager, /rollbackMovedLibraryFiles/);
    assert.match(seriesManager, /rollbackCopiedLibraryFiles/);
    assert.match(seriesManager, /readBinary\(filePath\)/);
    assert.match(seriesManager, /writeBinary\(destFile, content\)/);
    assert.match(seriesManager, /filesHaveSameBytes/);
    assert.match(seriesManager, /trashDuplicateLibraryFiles/);
    assert.doesNotMatch(seriesManager, /skip unreadable/);
    assert.doesNotMatch(seriesManager, /moveFolderRecursive/);
    assert.match(seriesManager, /rolling back series dissolve/);
});

test('failed project trash restores series metadata', () => {
    assert.match(sceneManager, /seriesMetadataRollback/);
    assert.match(sceneManager, /Failed to restore series metadata after project deletion failed/);
});

test('series category deletion warns that every project is affected', () => {
    assert.match(categoryTabs, /This category is stored in the shared series Library/);
});

test('translation audit checks UI sinks that bypass t()', () => {
    assert.match(i18nAudit, /uiSinkMethods/);
    assert.match(i18nAudit, /setAttribute/);
    assert.match(i18nAudit, /uiPropertyNames/);
    assert.match(i18nAudit, /confirmModalPropertyNames/);
    assert.match(i18nAudit, /openConfirmModal/);
    assert.match(i18nAudit, /PropertyAccessExpression/);
    assert.match(i18nAudit, /UI literal bypasses t\(\)/);
});

test('plot diagnostics and their categories use the active UI language', () => {
    assert.match(validator, /import \{ t \} from '\.\.\/utils\/i18n'/);
    assert.doesNotMatch(validator, /message:\s*`/);
    assert.match(statsView, /createEl\('h5', \{ text: t\(cat\) \}\)/);
});

test('template replacement never deletes scenes and requires an explicit handling mode', () => {
    assert.match(sceneManager, /existingScenes === 'uncategorized'/);
    assert.match(sceneManager, /existingScenes === 'remap'/);
    assert.match(applyModal, /Existing scene files are never deleted/);
    const applyBlock = sceneManager.slice(sceneManager.indexOf('async applyBeatSheet'), sceneManager.indexOf('async createScenesFromBeats'));
    assert.doesNotMatch(applyBlock, /deleteScene|trash|vault\.delete/);
    assert.match(applyModal, /Merge with current structure/);
    assert.match(applyModal, /Keep existing numbering/);
    assert.match(applyModal, /Remap to the new structure/);
    assert.match(applyModal, /Move to uncategorized/);
});

test('project templates stay under System/Templates and feed scene creation', () => {
    assert.match(templateCenter, /PROJECT_TEMPLATES_FOLDER = 'Templates'/);
    assert.match(templateCenter, /getProjectSystemFolder\(\)/);
    assert.doesNotMatch(templateCenter, /\/Library\//);
    assert.match(templateCenter, /\.tmp/);
    assert.match(templateCenter, /\.bak/);
    assert.match(quickAdd, /templateCenter\.getSceneTemplates\(\)/);
    assert.match(quickAdd, /localizeSceneTemplate/);
});

test('beat placeholders are idempotent and accept scene template content', () => {
    assert.match(sceneManager, /existingBeatKeys\.has\(beatKey\)/);
    assert.match(sceneManager, /sceneTemplate\?\.bodyTemplate/);
    assert.match(sceneManager, /sceneTemplate\?\.defaultFields/);
});

test('character field drafts survive re-renders and undo failures cannot block saves', () => {
    assert.match(characterView, /Stable working copy reused across internal detail re-renders/);
    assert.match(characterView, /this\.editingDraft\s*&&/);
    assert.match(characterView, /Undo history is optional; it must never block the actual save/);
    assert.match(characterView, /await this\.characterManager\.saveCharacter\(draft\)/);
    assert.match(characterView, /this\.pendingSaveDraft !== null/);
    assert.match(characterView, /layout\.addEventListener\('focusout', commitFocusedField\)/);
});

test('library entity saves refresh stamp cache so reload cannot resurrect pre-save parses', async () => {
    const [characterManager, locationManager, codexManager, entityCache] = await Promise.all([
        readFile(new URL('../services/CharacterManager.ts', import.meta.url), 'utf8'),
        readFile(new URL('../services/LocationManager.ts', import.meta.url), 'utf8'),
        readFile(new URL('../services/CodexManager.ts', import.meta.url), 'utf8'),
        readFile(new URL('../services/EntityFileCache.ts', import.meta.url), 'utf8'),
    ]);
    assert.match(entityCache, /export function rememberEntityAfterSave/);
    assert.match(characterManager, /rememberEntityAfterSave\(this\.app, 'character'/);
    assert.match(locationManager, /rememberEntityAfterSave\(this\.app, 'location'/);
    assert.match(codexManager, /rememberEntityAfterSave\(this\.app, `codex:\$\{catId\}`/);
    assert.match(characterView, /resolveCharacterCardSnippet/);
    assert.match(characterView, /attr: \{ value: opt\.key \}/);
});

test('story graph legend rows filter independently without remounting the canvas', () => {
    assert.match(storyGraph, /private legendNodeKeys = new Set<string>\(\)/);
    assert.match(storyGraph, /private legendEdgeKeys = new Set<string>\(\)/);
    const nodeToggle = storyGraph.slice(
        storyGraph.indexOf('private toggleNodeLegendKey'),
        storyGraph.indexOf('private setEntityLegendFocus'),
    );
    const edgeToggle = storyGraph.slice(
        storyGraph.indexOf('private setEdgeLegendFocus'),
        storyGraph.indexOf('private nodeMatchesLegendSelection'),
    );
    assert.doesNotMatch(nodeToggle, /legendEdgeKeys\.clear/);
    assert.doesNotMatch(edgeToggle, /legendNodeKeys\.clear/);
    assert.match(nodeToggle, /applyLegendFilters/);
    assert.match(edgeToggle, /applyLegendFilters/);
    assert.match(storyGraph, /Include unlinked documents/);
    assert.match(storyGraph, /visibleEdgeSet/);
    // Wheel zoom must not bubble to Obsidian leaf scroll (causes viewport jump-back).
    assert.match(storyGraph, /e\.stopPropagation\(\)/);
});

test('library story-graph refresh keeps the canvas mounted', () => {
    assert.match(characterView, /characterOverviewMode === 'story-graph'/);
    assert.match(characterView, /querySelector\('\.story-graph-page'\)/);
    assert.match(codexView, /getLibraryContentMode\(this\.plugin\) === 'story-graph'/);
    assert.match(codexView, /querySelector\('\.story-graph-page'\)/);
    assert.match(locationView, /locationOverviewMode === 'story-graph'/);
    assert.match(locationView, /querySelector\('\.story-graph-page'\)/);
});

test('project switching remounts project-bound Library embeds', () => {
    const switchProject = sceneManager.slice(
        sceneManager.indexOf('async setActiveProject('),
        sceneManager.indexOf('async renameProject('),
    );
    assert.match(switchProject, /loadProjectSystemData\(\)/);
    assert.match(switchProject, /libraryCategoriesStructureEpoch \+= 1/);
    assert.ok(
        switchProject.indexOf('libraryCategoriesStructureEpoch += 1')
            > switchProject.indexOf('loadProjectSystemData()'),
        'the epoch changes only after the new project settings are loaded',
    );
});

test('add-relation modal can create character or wikilink kinds', () => {
    assert.match(libraryModeBar, /function openAddStoryGraphRelationModal/);
    assert.match(libraryModeBar, /addOption\('wikilink', t\('Wikilink category'\)\)/);
    assert.match(libraryModeBar, /addOption\('character', t\('Character relation'\)\)/);
    assert.match(libraryModeBar, /onLegendAdd: \(\) => openAddStoryGraphRelationModal/);
    assert.match(libraryModeBar, /RELATION_BASE_TYPE_BY_CATEGORY/);
});

test('plotgrid saves are queued, retried, and do not toast on every failure', () => {
    const save = mainTs.slice(
        mainTs.indexOf('async savePlotGrid('),
        mainTs.indexOf('async loadPlotGrid('),
    );
    assert.match(save, /_systemJsonWriteQueues/);
    assert.match(save, /writeVaultBinaryResilient/);
    assert.match(save, /encodePlotGridXlsx/);
    assert.match(save, /ensureVaultFolder/);
    assert.match(save, /_reportedInvalidPlotGridXlsxPaths\.has\(path\)/);
    assert.equal((save.match(/new Notice\(/g) || []).length, 1, 'corrupt workbook warning is deduplicated');
    assert.match(mainTs, /getBasePath\?\./);
});

test('editable Base field and Library category names stay language-neutral', () => {
    assert.match(nativeLibraryBase, /propertyConfig\.displayName = key/);
    assert.match(nativeLibraryBase, /ensureRawNotePropertyDisplayNames\(config/);
    assert.match(libraryCategorySync, /return english;/);
    assert.doesNotMatch(
        libraryCategorySync.slice(
            libraryCategorySync.indexOf('export function resolveLibraryCategoryLabel'),
            libraryCategorySync.indexOf('function setLibraryCategoryDisplayMetadata'),
        ),
        /seedUiLanguage|localizeForLanguage/,
    );
});

test('custom profile categories expose a working profile overview mode', () => {
    assert.match(categoryTabs, /profileMode\?: LibraryProfileModeAction/);
    assert.match(libraryModeBar, /data-mode': 'profile'/);
    assert.match(codexView, /activeCategoryHasProfilePage/);
    assert.match(codexView, /profileOverviewCategoryId = this\.activeCategory/);
    assert.match(codexView, /showLayoutToggle: !this\.isProfileOverviewMode\(\)/);
    assert.match(codexView, /this\.isProfileOverviewMode\(\)\s*\? 'cards'/);
});

test('plot-grid text keeps Markdown source and renders rich text with native wikilinks', async () => {
    const [plotgrid, univerHost, codec, markdownInput] = await Promise.all([
        readFile(new URL('../views/PlotgridView.ts', import.meta.url), 'utf8'),
        readFile(new URL('../services/PlotGridUniverHost.ts', import.meta.url), 'utf8'),
        readFile(new URL('../services/PlotGridXlsxCodec.ts', import.meta.url), 'utf8'),
        readFile(new URL('../utils/markdownInput.ts', import.meta.url), 'utf8'),
    ]);
    assert.match(plotgrid, /openCellMarkdownEditor/);
    assert.match(plotgrid, /new WikilinkSuggest/);
    assert.match(plotgrid, /MarkdownRenderer\.render/);
    assert.match(plotgrid, /commit\(this\.textarea\.value\)/);
    assert.doesNotMatch(plotgrid, /openNoteLinkModal|openSceneLinkModal/);
    assert.doesNotMatch(univerHost, /onCellRender|canvasMarkdownSegments|fillRect\(/);
    assert.match(univerHost, /--link-color/);
    assert.match(codec, /plotGridSourceToUniverRichText/);
    assert.match(codec, /PLOTGRID_SOURCE_FIELD/);
    assert.match(codec, /cellDocument/);
    const contextMenu = univerHost.slice(
        univerHost.indexOf('function registerNarrativeLabContextMenu'),
        univerHost.indexOf('function linkedCellAt'),
    );
    assert.doesNotMatch(contextMenu, /link-note|unlink-note|open-linked-note/);
    assert.match(markdownInput, /getHotkeys/);
    assert.match(markdownInput, /insert-wikilink/);
});

test('NarrativeCanvas textareas inherit the configured Obsidian Markdown shortcuts', async () => {
    const [canvasApp, canvasHost] = await Promise.all([
        readFile(new URL('../canvas-runtime/app.js', import.meta.url), 'utf8'),
        readFile(new URL('../canvas-runtime/main.js', import.meta.url), 'utf8'),
    ]);
    assert.match(canvasApp, /handleObsidianMarkdownShortcut/);
    assert.match(canvasApp, /target\.tagName !== "TEXTAREA"/);
    assert.match(canvasApp, /NarrativeCanvasHost\?\.getMarkdownShortcutAction/);
    assert.match(canvasHost, /getMarkdownShortcutAction\(event\)/);
    assert.match(canvasHost, /hotkeyManager/);
    assert.match(canvasHost, /editor:insert-wikilink/);
});
