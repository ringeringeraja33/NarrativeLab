import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const [corkboard, boardView, seriesManager, sceneManager, categoryTabs, i18nAudit, templateCenter, applyModal, quickAdd, characterView, storyGraph, nativeLibraryBase, libraryCategorySync, codexView, libraryModeBar, libraryBrowseLayout, locationView, mainTs, styles, validator, statsView] = await Promise.all([
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
    readFile(new URL('../components/LibraryBrowseLayout.ts', import.meta.url), 'utf8'),
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
    assert.match(corkboard, /adapter\.exists\(path\)/);
    assert.match(corkboard, /adapter\.read\(path\)/);
    assert.match(corkboard, /canvasWeight\(parsed\) > 0 && this\.canvasWeight\(data\) === 0/);
    assert.match(corkboard, /ensureVaultFolder\(this\.app, dir\)/);
});

test('unreadable board.json is not cleared then autosaved empty', () => {
    const load = sceneManager.slice(
        sceneManager.indexOf('async loadCorkboardPositions()'),
        sceneManager.indexOf('async setCorkboardPositions('),
    );
    const save = sceneManager.slice(
        sceneManager.indexOf('async setCorkboardPositions('),
        sceneManager.indexOf('async saveProjectFrontmatter('),
    );
    assert.match(load, /this\._invalidBoardJson = true/);
    assert.doesNotMatch(load, /catch \{\s*(?:if \(this\._activeProject\) )?this\._activeProject\.corkboardPositions = \{\}/);
    assert.match(save, /this\._invalidBoardJson/);
    assert.match(save, /isDeletedProjectPath\(sysFolder\)/);
});

test('unreadable field-templates.json cannot be overwritten by a later save', async () => {
    const fieldTemplates = await readFile(new URL('../services/FieldTemplateService.ts', import.meta.url), 'utf8');
    const load = fieldTemplates.slice(
        fieldTemplates.indexOf('async load()'),
        fieldTemplates.indexOf('async save()'),
    );
    const save = fieldTemplates.slice(fieldTemplates.indexOf('async save()'));
    assert.match(load, /this\._invalidFile = true/);
    assert.doesNotMatch(load, /this\.templates = \[\];\s*this\.sectionOrders = \{\};\s*\}/);
    assert.match(save, /if \(this\._invalidFile\) return/);
    assert.match(save, /isTombstonedProjectPath\(systemFolder\)/);
});

test('Library reconcile cannot trash custom category folders after a local move', () => {
    assert.match(libraryCategorySync, /Folders are the source of truth/);
    assert.match(libraryCategorySync, /isLeftoverSeedLibraryFolder/);
    assert.match(libraryCategorySync, /isLibraryCategoryFolderEmpty\(child\)/);
    assert.doesNotMatch(libraryCategorySync, /Orphan folder — keep notes as Uncategorized/);
    assert.match(libraryCategorySync, /snapshot\.names\.size === 0/);
    assert.match(mainTs, /presetsSeeded \|\| migratingLibraryCategories/);
    assert.match(mainTs, /presetsSeeded \|\| !stored/);
    assert.match(mainTs, /_invalidSystemJsonPaths\.has\(catPath\)/);
});

test('creating a project cannot wipe leftover System JSON with empty objects', () => {
    const create = sceneManager.slice(
        sceneManager.indexOf('async createProject('),
        sceneManager.indexOf('new Notice(t(\'Project "{title}" created\''),
    );
    assert.match(create, /if \(await this\.app\.vault\.adapter\.exists\(vfPath\)\) continue/);
    assert.doesNotMatch(create, /vault\.modify\(existing, contents\)/);
});

test('legacy plotgrid migration will not overwrite an unreadable System file', () => {
    const migrate = mainTs.slice(
        mainTs.indexOf('Phase 3: migrate per-project data'),
        mainTs.indexOf('Migration: plotlines write failed'),
    );
    assert.match(migrate, /isDeletedProjectPath\(sysFolder\)/);
    assert.match(migrate, /catch \{ existingHasData = true; \}/);
    assert.doesNotMatch(migrate, /unreadable — allow overwrite/);
});

test('System JSON saves refuse an empty stats ledger over a real history', () => {
    assert.match(mainTs, /shouldRefuseSparseSystemJsonWrite/);
    assert.match(mainTs, /statsPayloadHistorySize/);
    assert.match(mainTs, /Refusing to overwrite \$\{filename\} with an empty payload/);
    assert.match(mainTs, /await this\.ensureVaultFolder\(systemFolder\)/);
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

test('corkboard scene toggle applies live membership without remount', () => {
    assert.match(boardView, /applyCorkboardSceneVisibility/);
    assert.match(boardView, /applyLiveCorkboardMembership/);
    assert.match(boardView, /addLiveCorkboardMissing/);
    assert.match(boardView, /createFileNode/);
    const toggleAt = boardView.indexOf("text: t('Scenes')");
    assert.ok(toggleAt >= 0);
    const toggleBlock = boardView.slice(toggleAt, toggleAt + 800);
    assert.match(toggleBlock, /applyCorkboardSceneVisibility\(\)/);
    assert.doesNotMatch(toggleBlock, /await this\.plugin\.saveSettings/);
    assert.doesNotMatch(toggleBlock, /corkboardCanvasFilePath = null/);
    assert.doesNotMatch(toggleBlock, /refreshBoard\(\)/);
});

test('corkboard canvas writes are queued and retried on Windows locks', () => {
    assert.match(corkboard, /enqueueWrite/);
    assert.match(corkboard, /modifyWithRetry/);
    assert.match(corkboard, /attempt < 8/);
});

test('embedded corkboard undo routes by Canvas ownership without stealing text undo', () => {
    assert.match(mainTs, /resolveCorkboardUndoBoard\(event\?: KeyboardEvent\)/);
    assert.match(mainTs, /board\.ownsCorkboardShortcutEvent\(event\)/);
    assert.match(mainTs, /board\.getLastCorkboardInteractionAt\(\)/);
    assert.match(mainTs, /const corkboard = this\.resolveCorkboardUndoBoard\(evt\)/);
    assert.match(boardView, /ownsCorkboardShortcutEvent\(event\?: KeyboardEvent\)/);
    assert.match(boardView, /isCorkboardTextEditingTarget\(targetEl\)/);
    assert.match(boardView, /getLastCorkboardInteractionAt\(\)/);
    const routeAt = mainTs.indexOf('const corkboard = this.resolveCorkboardUndoBoard(evt)');
    const activeViewAt = mainTs.indexOf('getActiveViewOfType(ItemView)', routeAt);
    assert.ok(routeAt >= 0 && activeViewAt > routeAt);
});

test('series migrations journal transfers and roll back every move path', async () => {
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
    assert.match(seriesManager, /loadProjectFromPath/);
    assert.match(seriesManager, /resolveMovedProject/);
    assert.match(seriesManager, /readAlwaysUpdateLinks/);
    assert.match(seriesManager, /alwaysUpdate === false/);
    assert.match(seriesManager, /adapter\.rename\(src, dest\)/);
    const vaultFolders = await readFile(new URL('../utils/vaultFolders.ts', import.meta.url), 'utf8');
    assert.match(vaultFolders, /export function isUntrackedLibraryNoise/);
    assert.match(vaultFolders, /export function isProjectScopedLibraryArtifact/);
    assert.match(seriesManager, /isProjectScopedLibraryArtifact\(fileName\)/);
    assert.match(seriesManager, /isUntrackedLibraryNoise\(fileName\)/);
    assert.match(seriesManager, /isUntrackedLibraryNoise\(name\)/);
    assert.match(seriesManager, /name\.startsWith\('\.'\)/);
    assert.match(seriesManager, /adapter\.rmdir\(folder, false\)/);
    assert.doesNotMatch(seriesManager, /if \(!\(file instanceof TFile\)\) \{\s*throw new Error\(t\('Could not find the indexed Library file/);
    assert.match(sceneManager, /async loadProjectFromPath/);
});

test('series project-folder moves retry transient Windows locks without duplicating a completed rename', () => {
    assert.match(seriesManager, /private isTransientFilesystemError/);
    assert.match(seriesManager, /UNKNOWN\|EBUSY\|EPERM\|EACCES\|EAGAIN/);
    assert.match(seriesManager, /for \(let attempt = 0; attempt < 8; attempt\+\+\)/);
    assert.match(seriesManager, /if \(!sourceExists && destinationExists\) return/);
    assert.match(seriesManager, /Project files are temporarily busy\. Retrying the move…/);
    assert.match(seriesManager, /close Excel or another external editor/);
});

test('series moves quiesce project-bound tabs before rename and restore their rebased bindings', () => {
    assert.match(mainTs, /async quiesceProjectLeavesForFolderMove/);
    assert.match(mainTs, /await leaf\.setViewState\(\{ type: 'empty'/);
    assert.match(mainTs, /leaf\.view instanceof FileView/);
    assert.match(mainTs, /this\._projectMoveWriteGuards\.add\(source\)/);
    assert.match(mainTs, /await this\.settleProjectWritesForFolderMove\(source\)/);
    assert.match(mainTs, /nextState\.file = rebaseMovedPath\(nextState\.file\)/);
    assert.match(mainTs, /narrativeLabLeafState\(nextBinding, nextState\)/);
    assert.match(seriesManager, /await this\.plugin\.quiesceProjectLeavesForFolderMove\(originalBookFolder, targetBookFolder\)/);
    assert.match(seriesManager, /await this\.plugin\.quiesceProjectLeavesForFolderMove\(sourceBookFolder, targetBookFolder\)/);
    assert.match(seriesManager, /finally \{[\s\S]*await resumeProjectLeaves\(moveStuck\)/);
});

test('series folder moves fall back to a rollback-safe file-by-file transaction', () => {
    assert.match(seriesManager, /async moveProjectFolderByEntries/);
    assert.match(seriesManager, /project manifest moves last/);
    assert.match(seriesManager, /files\.sort\(\(a, b\)/);
    assert.match(seriesManager, /for \(const moved of \[\.\.\.movedFiles\]\.reverse\(\)\)/);
    assert.match(seriesManager, /handleProjectTreeFolderRename\(src, dest\)/);
    assert.match(seriesManager, /await this\.moveProjectFolderByEntries\(src, dest\)/);
});

test('adding a book to a series can create a new project in place', () => {
    const addFn = mainTs.slice(
        mainTs.indexOf('private async addBookToSeries'),
        mainTs.indexOf('/* eslint-enable'),
    );
    assert.match(addFn, /NEW_PROJECT_VALUE/);
    assert.match(addFn, /t\('New project'\)/);
    assert.match(addFn, /createProjectInSeries\(folder, newTitle\.trim\(\)\)/);
    assert.doesNotMatch(addFn, /No standalone projects found to add/);
    assert.match(seriesManager, /async createProjectInSeries\(/);
    assert.match(seriesManager, /createProject\(projectTitle, description, seriesFolder\)/);
});

test('series convert and dissolve open stacked child modals after the click settles', () => {
    assert.match(mainTs, /function openStackedModal/);
    assert.match(mainTs, /nl-stacked-modal/);
    assert.match(mainTs, /convertBtn\.addEventListener\('click', \(event\) => \{[\s\S]*stopPropagation\(\)[\s\S]*convertProjectToSeries/);
    assert.match(mainTs, /dissolveBtn\.addEventListener\('click', \(event\) => \{[\s\S]*stopPropagation\(\)[\s\S]*dissolveSeries/);
    const convertFn = mainTs.slice(
        mainTs.indexOf('private convertProjectToSeries'),
        mainTs.indexOf('private async dissolveSeries'),
    );
    assert.match(convertFn, /openStackedModal\(modal\)/);
    assert.doesNotMatch(convertFn, /modal\.open\(\)/);
    assert.match(convertFn, /createSeriesFromProject\(seriesName\.trim\(\), project\)/);
    assert.doesNotMatch(convertFn, /setActiveProject\(project\)/);
    assert.match(convertFn, /setValue\(seriesName\)/);
    const dissolveFn = mainTs.slice(
        mainTs.indexOf('private async dissolveSeries'),
        mainTs.indexOf('private async renameSeries'),
    );
    assert.match(dissolveFn, /openStackedModal\(modal\)/);
    assert.match(styles, /\.modal-container\.nl-stacked-modal/);
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
    assert.match(storyGraph, /if \(this\.legendNodeKeys\.size === 0\) return false/);
    // Wheel zoom must not bubble to Obsidian leaf scroll (causes viewport jump-back).
    assert.match(storyGraph, /e\.stopPropagation\(\)/);
});

test('library story-graph refresh keeps the canvas mounted', () => {
    assert.match(characterView, /characterOverviewMode === 'story-graph'/);
    assert.match(characterView, /querySelector\('\.story-graph-page'\)/);
    assert.match(codexView, /getLibraryContentMode\(this\.plugin, this\.getBoundProjectFile\(\)\) === 'story-graph'/);
    assert.match(codexView, /querySelector\('\.story-graph-page'\)/);
    assert.match(locationView, /locationOverviewMode === 'story-graph'/);
    assert.match(locationView, /querySelector\('\.story-graph-page'\)/);
});

test('Library Archive/Browse chrome is keyed by project, not a global plugin field', () => {
    assert.match(libraryModeBar, /libraryUiByProject/);
    assert.match(libraryModeBar, /resolveLibraryUiProjectFile/);
    assert.doesNotMatch(libraryModeBar, /p\.libraryContentMode/);
    assert.doesNotMatch(libraryModeBar, /libraryStoryGraphFilters/);
    assert.match(codexView, /getBoundProjectFile\(\)/);
});

test('project switching remounts project-bound Library embeds', () => {
    const switchProject = sceneManager.slice(
        sceneManager.indexOf('async setActiveProject('),
        sceneManager.indexOf('async renameProject('),
    );
    assert.match(switchProject, /loadProjectSystemData\(\)/);
    assert.match(switchProject, /fromLeafFocus/);
    assert.match(switchProject, /stashProjectRuntime/);
    assert.match(switchProject, /restoreProjectRuntime/);
    assert.match(switchProject, /adoptPlotlineRegistryForProject/);
    assert.ok(
        switchProject.indexOf('adoptPlotlineRegistryForProject')
            < switchProject.indexOf('loadProjectSystemData()'),
        'plotline registry must swap before System JSON load so a late save cannot mix projects',
    );
    assert.match(switchProject, /isolateProjectTransientState\(\)/);
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
    assert.match(save, /projectFilePath\?:/);
    assert.doesNotMatch(save, /Empty spreadsheet save blocked|_reportedInvalidPlotGridXlsxPaths\.has\(path\)/);
    assert.match(save, /shouldRefuseEmptyPlotGridWrite/);
    assert.match(save, /isIncompleteConceptGridPull\(cached\.doc, document\)/);
    assert.doesNotMatch(mainTs, /existingPlotGridFilledCount/);
    assert.match(mainTs, /plotGridXlsxExists/);
    assert.match(save, /_reportedPlotGridRecoveryNotices/);
    assert.ok(
        (save.match(/new Notice\(/g) || []).length <= 2,
        'save path only reports actionable journal-conflict and recovery warnings',
    );
    assert.match(mainTs, /getBasePath\?\./);
});

test('editable Base field names stay neutral while preset category labels localize', () => {
    assert.match(nativeLibraryBase, /propertyConfig\.displayName = key/);
    assert.match(nativeLibraryBase, /ensureRawNotePropertyDisplayNames\(config/);
    assert.match(libraryCategorySync, /return t\(english\);/);
    assert.doesNotMatch(
        libraryCategorySync.slice(
            libraryCategorySync.indexOf('export function resolveLibraryCategoryLabel'),
            libraryCategorySync.indexOf('function setLibraryCategoryDisplayMetadata'),
        ),
        /seedUiLanguage|localizeForLanguage/,
    );
});

test('custom profile categories expose a working profile overview mode', () => {
    assert.match(codexView, /private renderOverviewModes\(parent: HTMLElement\)/);
    assert.match(libraryModeBar, /data-mode': 'profile'/);
    assert.match(codexView, /setLibraryContentMode\(this\.plugin, 'profile', this\.getBoundProjectFile\(\)\)/);
    assert.match(codexView, /showLayoutToggle: false/);
    assert.match(codexView, /this\.isProfileOverviewMode\(\)\s*\? 'cards'/);
});

test('async embedded views cannot repaint or leak after navigation', async () => {
    const [manuscript, notesView, inspector, researchView, plotgridView, linkScanner] = await Promise.all([
        readFile(new URL('../views/ManuscriptView.ts', import.meta.url), 'utf8'),
        readFile(new URL('../views/NotesView.ts', import.meta.url), 'utf8'),
        readFile(new URL('../components/Inspector.ts', import.meta.url), 'utf8'),
        readFile(new URL('../views/ResearchView.ts', import.meta.url), 'utf8'),
        readFile(new URL('../views/PlotgridView.ts', import.meta.url), 'utf8'),
        readFile(new URL('../services/LinkScanner.ts', import.meta.url), 'utf8'),
    ]);

    assert.match(manuscript, /editorMountGeneration\+\+/);
    assert.match(manuscript, /mountGeneration !== this\.editorMountGeneration/);
    assert.match(manuscript, /leaf\.detach\(\);[\s\S]*?this\.mountingPaths\.delete\(filePath\)/);

    assert.match(notesView, /editorMountGeneration\+\+/);
    assert.match(notesView, /mountGeneration !== this\.editorMountGeneration/);
    assert.match(notesView, /this\.currentNotesPath !== notesPath/);

    assert.match(inspector, /assignDetectedLink/);
    assert.match(inspector, /resolvedType === 'location'/);
    assert.match(inspector, /sceneHasLocation\(scene, name\)/);
    assert.match(inspector, /const location = \[\.\.\.sceneLocationNames\(scene\), name\]/);
    assert.match(inspector, /renderTagPillInput\(\{[\s\S]*?values: sceneLocationNames\(scene\)/);
    assert.match(inspector, /link\.codexCategory \? `codex:\$\{link\.codexCategory\}`/);
    assert.match(inspector, /resolvedType === 'codex' \|\| resolvedType\.startsWith\('codex:'\)/);
    assert.match(inspector, /codexMgr\.getCategories\(\)/);
    assert.match(linkScanner, /codexCategory\?: string/);
    assert.match(linkScanner, /codexCategoryByName/);
    assert.match(linkScanner, /getCodexCategoryForName/);
    assert.match(inspector, /await obsidian\.MarkdownRenderer\.render/);
    assert.match(inspector, /renderGeneration !== this\.notesRenderGeneration/);
    assert.doesNotMatch(inspector, /foundIdx = lines\.indexOf\(line\)/);

    assert.match(researchView, /mountGeneration !== this\.mountGeneration \|\| !host\.isConnected/);
    assert.match(boardView, /mountGeneration !== this\.corkboardMountGeneration/);
    assert.match(boardView, /this\.boardMode === 'corkboard'/);

    for (const view of [characterView, locationView, codexView, boardView, manuscript, statsView]) {
        assert.match(view, /this\.rootContainer !== container \|\| !container\.isConnected/);
    }
    assert.match(plotgridView, /peekPlotGridDoc[\s\S]*?this\.loadData\(\)[\s\S]*?if \(!container\.isConnected\) return;/);
});

test('Story Graph is the first peer tab while profile and browse modes stay in the toolbar', () => {
    assert.doesNotMatch(categoryTabs, /renderLibraryModeToggle/);
    assert.match(categoryTabs, /renderLeadingTabs\?: \(container: HTMLElement\) => void/);
    assert.match(categoryTabs, /const tabs = parent\.createDiv\('codex-category-tabs'\);\s*renderLeadingTabs\?\.\(tabs\);\s*const renderedTabs/);
    assert.match(categoryTabs, /tabs\.insertBefore\(uncategorizedTab, categoryActions\)/);
    assert.match(categoryTabs, /getLibraryContentMode\(plugin, projectFile\) === 'story-graph'[\s\S]*?setLibraryContentMode/);
    assert.match(libraryBrowseLayout, /renderLeadingActions\?: \(actionsEl: HTMLElement\) => void/);
    assert.match(libraryBrowseLayout, /if \(opts\.renderLeadingActions\) \{[\s\S]*?library-browse-mode-actions[\s\S]*?const actions = toolbar\.createDiv\('library-browse-actions'\)/);
    assert.match(libraryBrowseLayout, /export function renderLibraryModeToolbar/);
    assert.match(characterView, /renderLeadingActions: \(actionsEl\) => this\.renderCharacterOverviewModes\(actionsEl\)/);
    assert.match(locationView, /renderLeadingActions: \(actionsEl\) => this\.renderLocationOverviewModes\(actionsEl\)/);
    assert.match(codexView, /renderLeadingActions: \(actionsEl\) => this\.renderOverviewModes\(actionsEl\)/);
    assert.doesNotMatch(libraryBrowseLayout, /renderTrailingActions/);
    assert.match(characterView, /renderLibraryModeToolbar\(container, actions => this\.renderCharacterOverviewModes\(actions\)\)/);
    assert.match(locationView, /renderLibraryModeToolbar\(container, actions => this\.renderLocationOverviewModes\(actions\)\)/);
    assert.match(codexView, /renderLibraryModeToolbar\(container, actions => this\.renderOverviewModes\(actions\)\)/);
    assert.doesNotMatch(characterView, /story-graph' && !isMobile\) \{\s*renderLibraryModeToolbar/);
    assert.doesNotMatch(locationView, /story-graph' && !isMobile\) \{\s*renderLibraryModeToolbar/);
    assert.doesNotMatch(codexView, /'story-graph' && !isMobile\) \{\s*renderLibraryModeToolbar/);
    assert.match(styles, /\.library-browse-toolbar\s*\{[^}]*justify-content:\s*flex-start/s);
    assert.match(styles, /\.library-browse-mode-actions\s*\{[^}]*margin-left:\s*0/s);
    assert.match(styles, /\.library-browse-toolbar \.library-layout-toggle\s*\{[^}]*margin-left:\s*0/s);
    assert.match(libraryModeBar, /export function renderLibraryStoryGraphAction/);
    assert.match(libraryModeBar, /cls: `codex-tab library-story-graph-tab/);
    assert.match(libraryModeBar, /createSpan\(\{ cls: 'codex-tab-icon' \}\)/);
    assert.match(characterView, /activeId: storyGraphActive \? 'story-graph' : 'characters-pseudo'[\s\S]*?renderLeadingTabs:[\s\S]*?renderLibraryStoryGraphAction/);
    assert.match(locationView, /activeId: storyGraphActive \? 'story-graph' : 'locations-pseudo'[\s\S]*?renderLeadingTabs:[\s\S]*?renderLibraryStoryGraphAction/);
    assert.match(codexView, /activeId: storyGraphActive \? 'story-graph' : this\.activeCategory \|\| ''[\s\S]*?renderLeadingTabs:[\s\S]*?renderLibraryStoryGraphAction/);
    assert.doesNotMatch(libraryModeBar, /options\?: \{ showStoryGraph\?: boolean \}/);
    assert.doesNotMatch(libraryModeBar, /options\?\.showStoryGraph/);
    assert.doesNotMatch(categoryTabs, /renderFarRightActions/);
    assert.doesNotMatch(styles, /\.codex-category-far-actions/);
    assert.match(styles, /\.codex-category-tabs\s*\{[^}]*justify-content:\s*flex-start/s);
    assert.match(styles, /\.codex-category-tabs \.library-story-graph-tab\s*\{[^}]*margin-left:\s*0/s);
    assert.match(styles, /\.codex-category-tabs \.codex-category-actions\s*\{[^}]*border-left:/s);
});

test('Library location archive uses one inner scroller and keeps scroll across refresh', () => {
    assert.match(styles, /\.story-line-location-container\s*\{[^}]*overflow:\s*hidden/s);
    assert.match(styles, /\.story-line-character-container\s*\{[^}]*overflow:\s*hidden/s);
    assert.match(styles, /\.story-line-location-content\s*\{[^}]*overscroll-behavior:\s*contain/s);
    assert.match(locationView, /querySelector\('\.story-line-location-content'\)[\s\S]*?scrollTop/);
    assert.match(locationView, /library-browse-search-input[\s\S]*?shouldFocusSearch/);
    assert.match(characterView, /library-browse-search-input[\s\S]*?shouldFocusSearch/);
    assert.doesNotMatch(locationView, /hadFocus \|\| this\.browseSearchOpen/);
    assert.doesNotMatch(characterView, /hadFocus \|\| this\.browseSearchOpen/);
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
    assert.match(plotgrid, /const value = textarea\.value/);
    assert.match(plotgrid, /liveCell\.content = value/);
    assert.match(plotgrid, /textarea\.addEventListener\('input',[\s\S]*scheduleAutosave\(\)/);
    assert.match(plotgrid, /flushAutosave[\s\S]*persistDraft\(\)/);
    assert.match(plotgrid, /pushCellSourceToUniver/);
    assert.doesNotMatch(plotgrid, /persistDraft\(\{ pushGrid: true \}\)/);
    assert.doesNotMatch(plotgrid, /openNoteLinkModal|openSceneLinkModal/);
    assert.doesNotMatch(univerHost, /canvasMarkdownSegments|fillText\(/);
    assert.match(univerHost, /onCellRender[\s\S]*drawTinyLinkIcon/);
    assert.match(univerHost, /--link-color/);
    assert.match(codec, /plotGridSourceToUniverRichText/);
    assert.match(codec, /PLOTGRID_SOURCE_FIELD/);
    assert.match(codec, /cellDocument/);
    const contextMenu = univerHost.slice(
        univerHost.indexOf('function registerNarrativeLabContextMenu'),
        univerHost.indexOf('function linkedCellAt'),
    );
    assert.match(contextMenu, /link-note/);
    assert.match(contextMenu, /unlink-note/);
    assert.match(contextMenu, /convert-to-research/);
    assert.match(contextMenu, /转为研究/);
    assert.doesNotMatch(contextMenu, /转为调研/);
    assert.match(contextMenu, /connectedTitle|Connected notes|已连接笔记/);
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

test('project picker paints the cached list before a vault rescan', () => {
    const picker = mainTs.slice(mainTs.indexOf('class ProjectSelectModal'), mainTs.indexOf('function openStackedModal'));
    assert.match(picker, /getProjects\(\)/);
    assert.match(picker, /fillSelect\(cached/);
    assert.match(picker, /Scanning…/);
    assert.match(picker, /void refreshSelect\(\)/);
    const fillIdx = picker.indexOf('fillSelect(cached');
    const scanIdx = picker.indexOf('void refreshSelect()');
    assert.ok(fillIdx >= 0 && scanIdx > fillIdx);
});

test('library galleries hide the duplicate thumb strip when only one image exists', () => {
    assert.match(characterView, /nav\.toggleClass\('is-single', gallery\.length <= 1\)/);
    assert.match(locationView, /nav\.toggleClass\('is-single', gallery\.length <= 1\)/);
    assert.match(codexView, /nav\.toggleClass\('is-single', gallery\.length <= 1\)/);
    assert.match(codexView, /cls: `character-gallery-thumb\$\{i === activeIndex \? ' active' : ''\}`/);
    assert.doesNotMatch(codexView, /character-gallery-thumb-item/);
    assert.match(styles, /\.character-gallery-nav\.is-single\s*\{[^}]*display:\s*none/s);
});

test('Story Graph opens native Graph beside it instead of merging canvases', () => {
    assert.match(storyGraph, /onOpenNativeGraph\?: \(\) => void/);
    assert.match(storyGraph, /onShowInNativeGraph\?: \(filePath: string, reveal: boolean\) => void/);
    assert.match(storyGraph, /t\('Open in Graph view'\)/);
    assert.match(storyGraph, /t\('Show in Graph view'\)/);
    assert.match(storyGraph, /this\.onShowInNativeGraph\?\.\(node\.filePath, false\)/);
    assert.match(libraryModeBar, /function projectNativeGraphFolders/);
    assert.match(libraryModeBar, /getCodexFolder\(\)/);
    assert.match(libraryModeBar, /getSceneFolder\(\)/);
    assert.match(libraryModeBar, /buildProjectGraphQuery\(projectNativeGraphFolders\(plugin\)\)/);
    assert.match(libraryModeBar, /buildProjectFileGraphQuery\(projectNativeGraphFolders\(plugin\), filePath\)/);
    assert.match(libraryModeBar, /openNativeGraphWithQuery\(plugin\.app, query, \{ reveal: true \}\)/);
    assert.match(libraryModeBar, /openNativeGraphWithQuery\(plugin\.app, query, \{ reveal \}\)/);
    assert.doesNotMatch(storyGraph, /setViewState\(\{ type: 'graph'/);
    assert.doesNotMatch(libraryModeBar, /localgraph/);
});

test('project scan keeps the previous list until the new map is ready', () => {
    assert.match(sceneManager, /scanProjectsInner/);
    assert.match(sceneManager, /projectFromMetadataCache/);
    assert.match(sceneManager, /this\.projects = next/);
    assert.doesNotMatch(sceneManager, /this\.projects\.clear\(\)/);
    assert.match(sceneManager, /getAbstractFileByPath\(path\) != null/);
    assert.match(sceneManager, /_scanProjectsPromise/);
});

test('startup overlaps independent project reads and defers Narrative Canvas', () => {
    assert.match(sceneManager, /Promise\.all\(\[\s*this\.scanFolderAdapter\(sceneFolder\),\s*this\.scanFolderAdapter\(notesFolder\),/s);
    assert.match(mainTs, /Promise\.all\(\[\s*this\.plotlineManager\.ensureSeeded\(\),\s*this\.fieldTemplates\.load\(\),\s*this\.templateCenter\.load\(\),\s*this\.sceneManager\.loadCorkboardPositions\(\),/s);
    assert.match(mainTs, /locationManager\.loadAll\(locFolder\)/);
    assert.match(mainTs, /characterManager\.loadCharacters\(charFolder\)/);
    assert.match(mainTs, /requestIdleCallback\(startEmbeddedCanvas/);
    assert.match(mainTs, /startEmbeddedCanvas/);
});

test('cancelled Arc Point filter no longer narrows scene queries', async () => {
    const [sceneModel, query] = await Promise.all([
        readFile(new URL('../models/Scene.ts', import.meta.url), 'utf8'),
        readFile(new URL('../services/SceneQueryService.ts', import.meta.url), 'utf8'),
    ]);
    assert.doesNotMatch(sceneModel, /arcAnchorFilter/);
    assert.doesNotMatch(query, /arcAnchorFilter/);
});

test('default view setting opens a project tab and unused portrait leftovers are gone', async () => {
    const [settings, plotgrid, projectModel] = await Promise.all([
        readFile(new URL('../settings.ts', import.meta.url), 'utf8'),
        readFile(new URL('../views/PlotgridView.ts', import.meta.url), 'utf8'),
        readFile(new URL('../models/StoryLineProject.ts', import.meta.url), 'utf8'),
    ]);
    assert.match(mainTs, /resolveDefaultProjectViewType/);
    assert.match(mainTs, /type: defaultType/);
    assert.match(settings, /characterCardPortraitSize/);
    assert.doesNotMatch(settings, /characterDetailPortraitSize/);
    assert.doesNotMatch(settings, /locationDetailPortraitWidth/);
    assert.doesNotMatch(mainTs, /--sl-character-detail-portrait-size/);
    assert.doesNotMatch(plotgrid, /computeTotalWidth/);
    assert.doesNotMatch(plotgrid, /ROW_HEADER_WIDTH/);
    assert.match(plotgrid, /datasheet-\*\.xlsx/);
    assert.doesNotMatch(projectModel, /LEGACY_CANVAS_FOLDER/);
    assert.doesNotMatch(styles, /\.codex-detail-portrait\s*\{/);
    assert.doesNotMatch(styles, /\.location-detail-portrait\s*\{/);
    assert.doesNotMatch(styles, /\.story-graph-focus-deep-col\s*\{/);
    assert.match(styles, /--sl-character-card-portrait-size/);
});
