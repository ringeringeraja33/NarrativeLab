import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const [nativeLibraryBase, storyLineProject, sceneManager] = await Promise.all([
    readFile(new URL('../components/NativeLibraryBase.ts', import.meta.url), 'utf8'),
    readFile(new URL('../models/StoryLineProject.ts', import.meta.url), 'utf8'),
    readFile(new URL('../services/SceneManager.ts', import.meta.url), 'utf8'),
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
