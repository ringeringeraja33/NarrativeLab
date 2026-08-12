import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const [nativeLibraryBase, storyLineProject, sceneManager, entityFileCache, codexManager, characterManager, locationManager] = await Promise.all([
    readFile(new URL('../components/NativeLibraryBase.ts', import.meta.url), 'utf8'),
    readFile(new URL('../models/StoryLineProject.ts', import.meta.url), 'utf8'),
    readFile(new URL('../services/SceneManager.ts', import.meta.url), 'utf8'),
    readFile(new URL('../services/EntityFileCache.ts', import.meta.url), 'utf8'),
    readFile(new URL('../services/CodexManager.ts', import.meta.url), 'utf8'),
    readFile(new URL('../services/CharacterManager.ts', import.meta.url), 'utf8'),
    readFile(new URL('../services/LocationManager.ts', import.meta.url), 'utf8'),
]);

test('canonical Library Base lives under Library/library.base', () => {
    assert.match(storyLineProject, /LIBRARY_BASE_FILENAME = 'library\.base'/);
    assert.match(storyLineProject, /LEGACY_SYSTEM_LIBRARY_BASE = `System\/library\.base`/);
    assert.match(nativeLibraryBase, /\$\{libraryRoot\}\/\$\{LIBRARY_BASE_FILENAME\}/);
    assert.match(nativeLibraryBase, /getCodexFolder/);
    assert.match(nativeLibraryBase, /narrativeLabLibraryBase/);
    assert.match(nativeLibraryBase, /narrativeLabCategoryId/);
});

test('category tabs embed a view fragment instead of switching Base files', () => {
    assert.match(nativeLibraryBase, /!\[\[\$\{linkPath\}#\$\{linkView\}\]\]/);
    assert.match(nativeLibraryBase, /function getLibraryBasePath/);
    assert.doesNotMatch(nativeLibraryBase, /function getNativeBasePath/);
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
    assert.match(nativeLibraryBase, /key === 'order' \|\| key === 'sort' \|\| key === 'columnSize' \|\| key === 'groupBy'/);
    assert.match(nativeLibraryBase, /view\.sort = snapshot\.sort\.map/);
    assert.match(nativeLibraryBase, /view\.order = snapshot\.order\.slice\(\)/);
    assert.match(nativeLibraryBase, /view\.groupBy = cloneGroupBy/);
    assert.match(nativeLibraryBase, /lastLayoutAt/);
    assert.match(nativeLibraryBase, /newestByCategory/);
});

test('Library Base folder filters use file.inFolder and only the native New control', () => {
    assert.match(nativeLibraryBase, /single-library-base-v4-ignore-excalidraw/);
    assert.match(nativeLibraryBase, /!file\.inFolder\(/);
    assert.doesNotMatch(nativeLibraryBase, /has-nl-new|library-native-base-actions|hideBasesNativeNewButtons/);
});

test('native Base New routes the created note into the active Library category folder', () => {
    assert.match(nativeLibraryBase, /routeNativeBaseNewNotes\(host, plugin, resolved\.folderPath\)/);
    assert.match(nativeLibraryBase, /plugin\.app\.vault\.on\('create'/);
    assert.match(nativeLibraryBase, /plugin\.app\.fileManager\.renameFile\(file, destination\)/);
    assert.match(nativeLibraryBase, /availableNotePath/);
});

test('Library Base excludes Excalidraw markdown drawings', () => {
    assert.match(nativeLibraryBase, /file\.basename\.lower\(\)\.endsWith\(\"\.excalidraw\"\) == false/);
    assert.match(nativeLibraryBase, /isExcalidrawFilePath\(file\.path\)/);
});

test('every Library entity loader ignores Excalidraw files', () => {
    assert.match(entityFileCache, /name\.endsWith\('\.excalidraw'\) \|\| name\.endsWith\('\.excalidraw\.md'\)/);
    assert.match(entityFileCache, /isLibraryEntityMarkdownFile\(child\)/);
    assert.match(entityFileCache, /!isExcalidrawFilePath\(f\)/);
    for (const manager of [codexManager, characterManager, locationManager]) {
        assert.match(manager, /if \(isExcalidrawFilePath\(filePath\)\) return false;/);
    }
});
