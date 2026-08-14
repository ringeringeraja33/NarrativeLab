import assert from 'node:assert/strict';
import test from 'node:test';
import { build } from 'esbuild';
import { readFile } from 'node:fs/promises';

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

test('new projects bootstrap fixed folders before preset migration', () => {
    assert.deepEqual(
        { ...DEFAULT_PROJECT_LIBRARY_FOLDERS },
        { characters: 'Characters', locations: 'Locations' },
    );
    assert.deepEqual([...DEFAULT_PROJECT_LIBRARY_HIDDEN_CATEGORIES], ['uncategorized']);
});

test('first project load restores all original Storyline presets once', async () => {
    const source = await readFile('services/LibraryCategorySync.ts', 'utf8');
    const main = await readFile('main.ts', 'utf8');
    assert.match(source, /STORYLINE_PRESET_SEED_VERSION = 1/);
    assert.match(source, /for \(const preset of BUILTIN_CODEX_CATEGORIES\)/);
    assert.match(source, /if \(deleted\.has\(preset\.id\)\) continue/);
    assert.match(source, /enabled\.add\(preset\.id\)/);
    assert.match(source, /hasProfilePage: true/);
    assert.match(main, /seedStorylinePresetCategories\(this\)/);
    assert.match(main, /presetsSeeded \? \{ createMissingRegistered: true \} : \{\}/);
});

test('Library search and filter controls start closed', async () => {
    for (const path of ['views/CharacterView.ts', 'views/LocationView.ts', 'views/CodexView.ts']) {
        const source = await readFile(path, 'utf8');
        assert.match(source, /private browseSearchOpen = false/);
        assert.match(source, /private browseFilterOpen = false/);
    }
});

test('profile layout maps horizontal to columns and vertical to stacked sections', async () => {
    const css = await readFile('styles.css', 'utf8');
    const codex = await readFile('views/CodexView.ts', 'utf8');
    const location = await readFile('views/LocationView.ts', 'utf8');
    assert.match(css, /\.character-detail-board-track\s*\{[\s\S]*?flex-direction: row/);
    assert.match(css, /\.story-line-codex-content\.codex-detail--board/);
    assert.match(codex, /horizontalProfile \? ' character-detail-board-track' : ' character-detail-vertical-track'/);
    assert.match(location, /horizontalProfile \? ' character-detail-board-track' : ' character-detail-vertical-track'/);
    assert.match(codex, /text: t\(cat\.title\)/);
    assert.match(location, /text: t\(category\.title\)/);
});

test('new project paths use Library rather than Codex', () => {
    const fromTitle = deriveProjectFolders('Writing', 'Book');
    assert.equal(fromTitle.codexFolder, 'Writing/Book/Library');
    assert.equal(fromTitle.characterFolder, 'Writing/Book/Library/Characters');
    assert.equal(fromTitle.locationFolder, 'Writing/Book/Library/Locations');

    const fromFile = deriveProjectFoldersFromFilePath('Writing/Book/Book.md');
    assert.equal(fromFile.codexFolder, 'Writing/Book/Library');
});
