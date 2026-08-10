import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const [corkboard, boardView, seriesManager, sceneManager, categoryTabs, i18nAudit, templateCenter, applyModal, quickAdd, characterView, storyGraph, nativeLibraryBase, libraryCategorySync, codexView, libraryModeBar] = await Promise.all([
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
]);

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
    // Do not assume vault.modify reloads an already-hosted Canvas view.
    assert.doesNotMatch(boardView, /Obsidian reloads file nodes/);
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
    assert.match(i18nAudit, /UI literal bypasses t\(\)/);
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
