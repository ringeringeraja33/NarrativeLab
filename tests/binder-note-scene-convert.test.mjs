import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const [sceneManager, researchManager, navigatorView, mainTs, i18n] = await Promise.all([
    readFile(new URL('../services/SceneManager.ts', import.meta.url), 'utf8'),
    readFile(new URL('../services/ResearchManager.ts', import.meta.url), 'utf8'),
    readFile(new URL('../views/NavigatorView.ts', import.meta.url), 'utf8'),
    readFile(new URL('../main.ts', import.meta.url), 'utf8'),
    readFile(new URL('../utils/i18n.ts', import.meta.url), 'utf8'),
]);

test('SceneManager converts notes, scenes, and research in all directions', () => {
    assert.match(sceneManager, /async convertNoteToScene\(/);
    assert.match(sceneManager, /async convertSceneToNote\(/);
    assert.match(sceneManager, /async convertFileToResearch\(/);
    assert.match(sceneManager, /writeBinderRoleFrontmatter/);
    assert.match(sceneManager, /role: 'scene' \| 'note' \| 'research'/);
    assert.match(sceneManager, /inResearch/);
    assert.match(sceneManager, /ensureResearchFileIndexed/);
});

test('ResearchManager adopts files moved into Research/', () => {
    assert.match(researchManager, /async ensureResearchFileIndexed\(/);
    assert.match(researchManager, /async adoptMovedResearchFile\(/);
    assert.match(researchManager, /async handleFileRename\(/);
    assert.match(researchManager, /forgetPath\(/);
    assert.match(researchManager, /type !== 'research' && type !== 'scene'/);
});

test('Navigator supports three-way binder drag conversion', () => {
    assert.match(navigatorView, /makeBinderFolderDropTarget\(notesNode\.header, 'notes'\)/);
    assert.match(navigatorView, /makeBinderFolderDropTarget\(scenesNode\.header, 'scenes'\)/);
    assert.match(navigatorView, /makeBinderFolderDropTarget\(researchNode\.header, 'research'\)/);
    assert.match(navigatorView, /target: 'notes' \| 'scenes' \| 'research'/);
    assert.match(navigatorView, /convertFileToResearch/);
    assert.match(navigatorView, /Convert to Research/);
    assert.match(navigatorView, /sl-nav-research-row[\s\S]*?row\.draggable = !post\.isLinked/);
});

test('vault rename/create/delete refresh ResearchManager', () => {
    assert.match(mainTs, /researchManager\?\.handleFileChange/);
    assert.match(mainTs, /researchManager\?\.handleFileCreate/);
    assert.match(mainTs, /researchManager\?\.handleFileDelete/);
    assert.match(mainTs, /researchManager\?\.handleFileRename/);
});

test('binder conversion i18n covers research', () => {
    assert.match(i18n, /This file is already a research post/);
    assert.match(i18n, /Converted "\{name\}" to research/);
    assert.match(i18n, /Convert to Research/);
});
