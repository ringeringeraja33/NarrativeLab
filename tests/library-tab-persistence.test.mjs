import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const [settings, modeBar, characterView, locationView, codexView, viewSwitcher, categoryTabs] = await Promise.all([
    readFile(new URL('../settings.ts', import.meta.url), 'utf8'),
    readFile(new URL('../components/LibraryModeBar.ts', import.meta.url), 'utf8'),
    readFile(new URL('../views/CharacterView.ts', import.meta.url), 'utf8'),
    readFile(new URL('../views/LocationView.ts', import.meta.url), 'utf8'),
    readFile(new URL('../views/CodexView.ts', import.meta.url), 'utf8'),
    readFile(new URL('../components/ViewSwitcher.ts', import.meta.url), 'utf8'),
    readFile(new URL('../components/CodexCategoryTabs.ts', import.meta.url), 'utf8'),
]);

test('settings remember Library category and content tab', () => {
    assert.match(settings, /lastLibraryContentMode:\s*'profile'\s*\|\s*'browse'\s*\|\s*'story-graph'/);
    assert.match(settings, /lastLibraryCategoryId:\s*string/);
    assert.match(settings, /libraryUiByProject:\s*Record<string,/);
    assert.match(settings, /lastLibraryContentMode:\s*'profile'/);
    assert.match(settings, /lastLibraryCategoryId:\s*'characters'/);
    assert.match(settings, /libraryUiByProject:\s*\{\}/);
});

test('settings remember Structure sub-tab', () => {
    assert.match(settings, /lastStructureMode:\s*'timeline'\s*\|\s*'tracks'\s*\|\s*'plot-list'\s*\|\s*'subway'/);
    assert.match(settings, /lastStructureMode:\s*'timeline'/);
});

test('Library content mode includes profile and persists to settings', () => {
    assert.match(modeBar, /export type LibraryContentMode = 'profile' \| 'browse' \| 'story-graph'/);
    assert.match(modeBar, /libraryUiByProject/);
    assert.match(modeBar, /rememberLibraryCategory/);
    assert.match(modeBar, /resolveLibraryViewType/);
    assert.match(modeBar, /void plugin\.saveSettings\(\)/);
});

test('Character and Location profile tabs save profile mode, not browse', () => {
    assert.match(characterView, /mode\.id === 'base'\s*\?\s*'browse'\s*:\s*'profile'/);
    assert.match(locationView, /mode\.id === 'base'\s*\?\s*'browse'\s*:\s*'profile'/);
    assert.match(characterView, /rememberLibraryCategory\(this\.plugin, 'characters', this\.getBoundProjectFile\(\)\)/);
    assert.match(locationView, /rememberLibraryCategory\(this\.plugin, 'locations', this\.getBoundProjectFile\(\)\)/);
});

test('Location profile labels go through i18n', () => {
    assert.match(locationView, /text:\s*t\(category\.title\)/);
    assert.match(locationView, /fieldOverride\?\.label \|\| t\(field\.label\)/);
    assert.match(locationView, /fieldOverride\?\.placeholder \|\| t\(field\.placeholder\)/);
    assert.match(locationView, /text:\s*t\(typeName\)/);
});

test('Uncategorized New sits in the browse toolbar like other Library tabs', () => {
    assert.match(codexView, /promptNewUncategorizedEntry\(\)/);
    assert.match(codexView, /onNew: this\.activeCategory === UNCATEGORIZED_CATEGORY_ID/);
    assert.doesNotMatch(codexView, /codex-new-uncategorized-tab/);
    assert.doesNotMatch(codexView, /renderBeforeModeActions:/);
});

test('Uncategorized gallery matches Location Profiles chrome', () => {
    assert.match(codexView, /catDef\.id === UNCATEGORIZED_CATEGORY_ID/);
    assert.match(codexView, /t\('Uncategorized entries'\)/);
    assert.match(codexView, /showLayoutToggle: false/);
    assert.match(locationView, /showLayoutToggle: false/);
    assert.match(locationView, /t\('All projects'\)/);
});

test('Codex profile mode and category restore from memory', () => {
    assert.match(codexView, /setLibraryContentMode\(this\.plugin, 'profile', this\.getBoundProjectFile\(\)\)/);
    assert.match(codexView, /getLibraryContentMode\(this\.plugin, this\.getBoundProjectFile\(\)\) === 'profile'/);
    assert.match(codexView, /getRememberedLibraryCategory/);
    assert.match(codexView, /rememberLibraryCategory\(this\.plugin, categoryId/);
});

test('Library category hide keeps folders without resurrecting tabs', async () => {
    const [sync, transactions] = await Promise.all([
        readFile(new URL('../services/LibraryCategorySync.ts', import.meta.url), 'utf8'),
        readFile(new URL('../utils/libraryCategoryTransactions.ts', import.meta.url), 'utf8'),
    ]);
    assert.match(transactions, /export function shouldEnableAdoptedLibraryCategory/);
    assert.match(sync, /shouldEnableAdoptedLibraryCategory/);
    assert.match(sync, /Deleted presets stay deleted even if their Library folder is still on disk/);
    assert.doesNotMatch(sync, /deleted\.delete\(id\)/);
    assert.match(categoryTabs, /enabledCodex\.has\(category\.id\)/);
    assert.match(codexView, /Hidden presets stay registered so Library\/ folders cannot resurrect their tabs/);
    assert.match(modeBar, /if \(!enabled\.has\(id\)\) return;/);
});

test('Library view switcher and category tabs restore the last category', () => {
    assert.match(viewSwitcher, /resolveLibraryViewType\(plugin, boundProject\)/);
    assert.match(categoryTabs, /switchTo\(leaf, plugin, CHARACTER_VIEW_TYPE, 'characters'\)/);
    assert.match(categoryTabs, /switchTo\(leaf, plugin, LOCATION_VIEW_TYPE, 'locations'\)/);
    assert.match(categoryTabs, /rememberLibraryCategory\(plugin, categoryId, projectFile\)/);
    assert.match(categoryTabs, /activateCategory\(cat\.id\)/);
});

test('Independent structure tabs use page identity instead of a global remembered subview', async () => {
    const pages = await readFile(new URL('../models/ProjectPages.ts', import.meta.url), 'utf8');
    for (const id of ['timeline', 'trackComparison', 'plotList', 'subwayMap']) assert.ok(pages.includes(`module: '${id}'`));
    assert.ok(!pages.includes("module: 'chapterTemplates'"));
    assert.doesNotMatch(viewSwitcher, /resolveStructureViewType\(plugin\)/);
    assert.match(viewSwitcher, /page\.type === activeViewType/);
});
