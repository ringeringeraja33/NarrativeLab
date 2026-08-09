import assert from 'node:assert/strict';
import test from 'node:test';
import { build } from 'esbuild';

const result = await build({
    entryPoints: ['models/StoryLineProject.ts'],
    bundle: true,
    format: 'esm',
    platform: 'node',
    write: false,
});
const source = result.outputFiles[0].text;
const {
    DEFAULT_PROJECT_LIBRARY_FOLDERS,
    DEFAULT_PROJECT_LIBRARY_HIDDEN_CATEGORIES,
    deriveProjectFolders,
    deriveProjectFoldersFromFilePath,
} = await import(`data:text/javascript;base64,${Buffer.from(source).toString('base64')}`);

test('new projects only seed Characters and Locations', () => {
    assert.deepEqual(
        { ...DEFAULT_PROJECT_LIBRARY_FOLDERS },
        { characters: 'Characters', locations: 'Locations' },
    );
    assert.deepEqual([...DEFAULT_PROJECT_LIBRARY_HIDDEN_CATEGORIES], ['uncategorized']);
});

test('new project paths use Library rather than Codex', () => {
    const fromTitle = deriveProjectFolders('Writing', 'Book');
    assert.equal(fromTitle.codexFolder, 'Writing/Book/Library');
    assert.equal(fromTitle.characterFolder, 'Writing/Book/Library/Characters');
    assert.equal(fromTitle.locationFolder, 'Writing/Book/Library/Locations');

    const fromFile = deriveProjectFoldersFromFilePath('Writing/Book/Book.md');
    assert.equal(fromFile.codexFolder, 'Writing/Book/Library');
});
