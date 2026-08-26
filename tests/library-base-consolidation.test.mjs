import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const [nativeLibraryBase, storyLineProject, sceneManager, entityFileCache, codexManager, characterManager, locationManager, transactions, characterView, locationView, codexView] = await Promise.all([
    readFile(new URL('../components/NativeLibraryBase.ts', import.meta.url), 'utf8'),
    readFile(new URL('../models/StoryLineProject.ts', import.meta.url), 'utf8'),
    readFile(new URL('../services/SceneManager.ts', import.meta.url), 'utf8'),
    readFile(new URL('../services/EntityFileCache.ts', import.meta.url), 'utf8'),
    readFile(new URL('../services/CodexManager.ts', import.meta.url), 'utf8'),
    readFile(new URL('../services/CharacterManager.ts', import.meta.url), 'utf8'),
    readFile(new URL('../services/LocationManager.ts', import.meta.url), 'utf8'),
    readFile(new URL('../utils/libraryCategoryTransactions.ts', import.meta.url), 'utf8'),
    readFile(new URL('../views/CharacterView.ts', import.meta.url), 'utf8'),
    readFile(new URL('../views/LocationView.ts', import.meta.url), 'utf8'),
    readFile(new URL('../views/CodexView.ts', import.meta.url), 'utf8'),
]);
const libraryModeBar = await readFile(new URL('../components/LibraryModeBar.ts', import.meta.url), 'utf8');

test('canonical Library Base lives under per-project Library/library-*.base', () => {
    assert.match(storyLineProject, /LIBRARY_BASE_PREFIX = 'library'/);
    assert.match(storyLineProject, /LIBRARY_BASE_LEGACY_FILENAME = 'library\.base'/);
    assert.match(storyLineProject, /LEGACY_SYSTEM_LIBRARY_BASE = `System\/library\.base`/);
    assert.match(nativeLibraryBase, /\$\{libraryRoot\}\/\$\{LIBRARY_BASE_PREFIX\}-/);
    assert.match(nativeLibraryBase, /getCodexFolder/);
    assert.match(nativeLibraryBase, /narrativeLabLibraryBase/);
    assert.match(nativeLibraryBase, /narrativeLabCategoryId/);
});

test('category tabs embed a view fragment instead of switching Base files', () => {
    assert.match(nativeLibraryBase, /!\[\[\$\{linkPath\}#\$\{linkView\}\]\]/);
    assert.match(nativeLibraryBase, /function getLibraryBasePath/);
    assert.doesNotMatch(nativeLibraryBase, /function getNativeBasePath/);
});

test('native Base keeps the sibling Profiles / Base switch available', () => {
    const renderBody = nativeLibraryBase.slice(
        nativeLibraryBase.indexOf('export async function renderNativeLibraryBase'),
        nativeLibraryBase.indexOf('// Hook the live Bases view'),
    );
    assert.doesNotMatch(renderBody, /container\.empty\(\)/);
    assert.match(renderBody, /:scope > \.library-native-base-embed/);
    for (const view of [characterView, locationView, codexView]) {
        assert.match(view, /renderLibraryModeToolbar\(\s*container,/);
        assert.match(view, /renderNativeLibraryBase\(\s*container,/);
    }
});

test('Story Graph keeps the sibling Profiles / Base switch available', () => {
    const renderBody = libraryModeBar.slice(
        libraryModeBar.indexOf('export function renderLibraryStoryGraph'),
        libraryModeBar.indexOf('function showRelationEdgeMenu'),
    );
    assert.doesNotMatch(renderBody, /container\.empty\(\)/);
    assert.match(renderBody, /library-story-graph-host story-graph-page/);
    assert.match(renderBody, /const page = container\.createDiv/);
    assert.match(renderBody, /page\.createDiv\('story-graph-container'\)/);
});

test('new projects no longer create an empty Bases folder', () => {
    assert.doesNotMatch(
        sceneManager.slice(
            sceneManager.indexOf('// Authored canvas'),
            sceneManager.indexOf('// Create default data files inside System/'),
        ),
        /ensureFolder\(normalizePath\(folders\.basesFolder\)\)/,
    );
});

test('legacy Base trash never blocks project open on missing files', () => {
    assert.match(nativeLibraryBase, /Never block project open on Base migration/);
    assert.match(nativeLibraryBase, /ENOENT\|no such file\|does not exist/);
    assert.match(nativeLibraryBase, /if \(!\(await pathExists\(plugin, normalized\)\)\) return;/);
});

test('System/library.base is migrated into Library/ then trashed', () => {
    assert.match(nativeLibraryBase, /getLegacySystemLibraryBasePath/);
    assert.match(nativeLibraryBase, /Lift the whole previous System\/library\.base/);
    assert.match(
        nativeLibraryBase,
        /await trashBasePath\(plugin, getLegacySystemLibraryBasePath\(plugin\)\);/,
    );
});

test('Browse Properties/Sort changes are persisted into library.base', () => {
    assert.match(nativeLibraryBase, /hookLiveBasesView/);
    assert.match(nativeLibraryBase, /persistLayoutSnapshot/);
    assert.match(nativeLibraryBase, /applyLiveLayoutsToConfig/);
    assert.match(nativeLibraryBase, /schedulePersistLiveLayout/);
    assert.match(nativeLibraryBase, /flushEmbedLayout/);
    assert.match(nativeLibraryBase, /if \(key === 'order'\)/);
    assert.match(nativeLibraryBase, /if \(key === 'sort'\)/);
    assert.match(nativeLibraryBase, /if \(key === 'columnSize'\)/);
    assert.match(nativeLibraryBase, /if \(key === 'groupBy'\)/);
    assert.match(nativeLibraryBase, /view\.sort = snapshot\.sort\.map/);
    assert.match(nativeLibraryBase, /view\.order = snapshot\.order\.slice\(\)/);
    assert.match(nativeLibraryBase, /view\.groupBy = cloneGroupBy/);
    assert.match(nativeLibraryBase, /lastLayoutAt/);
    assert.match(nativeLibraryBase, /newestByCategory/);
    assert.match(nativeLibraryBase, /syncLibraryProfileVisibilityFromBase\(categoryId, authoritativeSnapshot\.order\)/);
    assert.match(nativeLibraryBase, /narrativeLabHiddenCustomProperties/);
    assert.match(nativeLibraryBase, /updateBaseHiddenCustomProperties\(/);
    assert.match(nativeLibraryBase, /effectiveProfileOrder\(view, profileOrder\)/);
    assert.match(nativeLibraryBase, /managedPropertyIds\.has\(propertyId\)/);
    assert.match(nativeLibraryBase, /`file\.name` is mandatory in the profile editor/);
    assert.match(nativeLibraryBase, /const result = new Set<string>\(\)/);
    assert.match(nativeLibraryBase, /snapshotPatchForConfigSet\(key, value\)/);
    assert.match(nativeLibraryBase, /pendingLayout/);
    assert.match(nativeLibraryBase, /const renderedOrder = view\.data\?\.properties/);
    assert.match(nativeLibraryBase, /Array\.isArray\(renderedOrder\) \? renderedOrder : configOrder/);
    assert.match(nativeLibraryBase, /normalizeSnapshotPropertyIds\(snapshot, config\)/);
    assert.match(nativeLibraryBase, /known\.has\(noteId\) \? noteId : raw/);
    assert.match(nativeLibraryBase, /isLatestLayoutRevision\(basePath, categoryId, revision\)/);
    assert.match(nativeLibraryBase, /if \(at <= 0\) continue/);
    assert.match(nativeLibraryBase, /if \(profileOrder && persistedOrderChanged\)/);
    assert.match(nativeLibraryBase, /if \(!persistedOrderChanged\) return/);
    assert.match(nativeLibraryBase, /interactionSnapshot = snapshotBasesViewLayout\(state\.liveView\)/);
    assert.match(nativeLibraryBase, /attempt < 12 && layoutSnapshotsEqual\(snapshot, baseline\)/);
    assert.match(nativeLibraryBase, /if \(layoutSnapshotsEqual\(snapshot, baseline\)\) return/);
    assert.match(nativeLibraryBase, /menuOrderBaseline/);
    assert.match(nativeLibraryBase, /menuOrderAccepted/);
    assert.match(nativeLibraryBase, /baseOrdersEquivalent\(patch\.order, baseline\)/);
    assert.match(nativeLibraryBase, /return;[\s\S]*?originalSet\.call\(config, key, value\)/);
    assert.match(nativeLibraryBase, /\[0, 16, 50, 120, 250\]\.map/);
    assert.match(nativeLibraryBase, /activeDocument\.addEventListener\('pointerdown', onDocumentPointerDown, true\)/);
    assert.match(nativeLibraryBase, /activeDocument\.removeEventListener\('pointerdown', onDocumentPointerDown, true\)/);
    const firstBaseWrite = nativeLibraryBase.indexOf('await plugin.app.vault.create(basePath, yaml);', nativeLibraryBase.indexOf('async function persistLayoutSnapshot'));
    const visibilitySync = nativeLibraryBase.indexOf('syncLibraryProfileVisibilityFromBase(categoryId, authoritativeSnapshot.order)');
    assert.ok(firstBaseWrite >= 0 && visibilitySync > firstBaseWrite, 'Base YAML must be durable before profile saving can remount the embed');
});

test('Library profile and browse rows expose the canonical Base as a native Obsidian view', async () => {
    const browseLayout = await readFile(new URL('../components/LibraryBrowseLayout.ts', import.meta.url), 'utf8');
    assert.match(nativeLibraryBase, /export async function openNativeLibraryBase/);
    assert.match(nativeLibraryBase, /`\$\{resolved\.basePath\}#\$\{viewName\}`/);
    assert.match(nativeLibraryBase, /renderOpenNativeLibraryBaseAction/);
    assert.match(browseLayout, /renderTrailingActions/);
    for (const view of [characterView, locationView, codexView]) {
        assert.match(view, /renderOpenNativeLibraryBaseAction/);
    }
});

test('native Base mode toolbar stays compact while keeping its trailing action aligned', async () => {
    const styles = await readFile(new URL('../styles.css', import.meta.url), 'utf8');
    assert.match(styles, /\.library-mode-only-chrome\s*\{[^}]*margin-bottom:\s*2px/s);
    assert.match(styles, /\.library-mode-only-chrome \.library-browse-toolbar\s*\{[^}]*min-height:\s*26px[^}]*margin-bottom:\s*0[^}]*flex-wrap:\s*nowrap/s);
    assert.match(styles, /:has\(> \.library-native-base-embed\)[\s\S]*?padding-top:\s*5px/);
});

test('native Base mirrors horizontal scrolling at the bottom of the Library pane', () => {
    assert.match(nativeLibraryBase, /mountBottomHorizontalScrollbar/);
    assert.match(nativeLibraryBase, /library-native-base-bottom-scroll/);
    assert.match(nativeLibraryBase, /source\.scrollLeft = rail\.scrollLeft/);
    assert.match(nativeLibraryBase, /rail\.style\.bottom/);
    assert.match(nativeLibraryBase, /requestAnimationFrame\(updateNow\)/);
    assert.match(nativeLibraryBase, /attributeFilter: \['class', 'style'\]/);
});

test('Library Base folder filters use file.inFolder and only the native New control', () => {
    assert.match(nativeLibraryBase, /single-library-base-v5-null-file-guard/);
    assert.match(nativeLibraryBase, /guardLibraryBaseFileFilter/);
    assert.match(nativeLibraryBase, /!file\.inFolder\(/);
    assert.doesNotMatch(nativeLibraryBase, /has-nl-new|library-native-base-actions|hideBasesNativeNewButtons/);
});

test('native Base New reuses each Profiles page category-aware creation flow', () => {
    assert.match(nativeLibraryBase, /wireNativeBaseNewAction\(host, onNew\)/);
    assert.match(nativeLibraryBase, /event\.stopImmediatePropagation\(\)/);
    assert.match(nativeLibraryBase, /event\.composedPath\(\)/);
    assert.match(nativeLibraryBase, /candidate instanceof Element/);
    assert.match(nativeLibraryBase, /'pointerdown', 'mousedown', 'pointerup', 'mouseup', 'click'/);
    assert.doesNotMatch(nativeLibraryBase, /target instanceof HTMLElement/);
    assert.doesNotMatch(nativeLibraryBase, /vault\.on\('create'|availableNotePath/);
    assert.match(characterView, /renderNativeLibraryBase\([\s\S]*?\(\) => this\.promptNewCharacter\(\)/);
    assert.match(locationView, /renderNativeLibraryBase\([\s\S]*?event => this\.showNewLocationMenu\(event\)/);
    assert.match(codexView, /this\.activeCategory === UNCATEGORIZED_CATEGORY_ID[\s\S]*?this\.promptNewEntry\(\)/);
});

test('Library Base excludes Excalidraw markdown drawings', () => {
    assert.match(nativeLibraryBase, /file\.basename\.lower\(\)\.endsWith\(\"\.excalidraw\"\) == false/);
    assert.match(nativeLibraryBase, /isExcalidrawFilePath\(file\.path\)/);
    assert.match(transactions, /if\(file,/);
});

test('every Library entity loader ignores Excalidraw files', () => {
    assert.match(entityFileCache, /name\.endsWith\('\.excalidraw'\) \|\| name\.endsWith\('\.excalidraw\.md'\)/);
    assert.match(entityFileCache, /isLibraryEntityMarkdownFile\(child\)/);
    assert.match(entityFileCache, /!isExcalidrawFilePath\(f\)/);
    for (const manager of [codexManager, characterManager, locationManager]) {
        assert.match(manager, /if \(isExcalidrawFilePath\(filePath\)\) return false;/);
    }
});
