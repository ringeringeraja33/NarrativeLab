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
    assert.match(settings, /lastLibraryContentMode:\s*'profile'/);
    assert.match(settings, /lastLibraryCategoryId:\s*'characters'/);
});

test('settings remember Structure sub-tab', () => {
    assert.match(settings, /lastStructureMode:\s*'timeline'\s*\|\s*'tracks'\s*\|\s*'plot-list'\s*\|\s*'subway'/);
    assert.match(settings, /lastStructureMode:\s*'timeline'/);
});

test('Library content mode includes profile and persists to settings', () => {
    assert.match(modeBar, /export type LibraryContentMode = 'profile' \| 'browse' \| 'story-graph'/);
    assert.match(modeBar, /lastLibraryContentMode/);
    assert.match(modeBar, /rememberLibraryCategory/);
    assert.match(modeBar, /resolveLibraryViewType/);
    assert.match(modeBar, /void plugin\.saveSettings\(\)/);
});

test('Character and Location profile tabs save profile mode, not browse', () => {
    assert.match(characterView, /mode\.id === 'base'\s*\?\s*'browse'\s*:\s*'profile'/);
    assert.match(locationView, /mode\.id === 'base'\s*\?\s*'browse'\s*:\s*'profile'/);
    assert.match(characterView, /rememberLibraryCategory\(this\.plugin, 'characters'\)/);
    assert.match(locationView, /rememberLibraryCategory\(this\.plugin, 'locations'\)/);
});

test('Location profile labels go through i18n', () => {
    assert.match(locationView, /text:\s*t\(category\.title\)/);
    assert.match(locationView, /text:\s*t\(field\.label\)/);
    assert.match(locationView, /placeholder:\s*t\(field\.placeholder\)/);
    assert.match(locationView, /text:\s*t\(typeName\)/);
});

test('Uncategorized New sits in the browse toolbar like other Library tabs', () => {
    assert.match(codexView, /promptNewUncategorizedEntry\(\)/);
    assert.match(codexView, /onNew: this\.activeCategory === UNCATEGORIZED_CATEGORY_ID/);
    assert.doesNotMatch(codexView, /codex-new-uncategorized-tab/);
    assert.doesNotMatch(codexView, /renderBeforeModeActions:/);
});

test('Uncategorized gallery matches Location Profiles chrome', () => {
    assert.match(codexView, /UNCATEGORIZED_CATEGORY_ID\) return true/);
    assert.match(codexView, /t\('Uncategorized Profiles'\)/);
    assert.doesNotMatch(codexView, /codex-overview-heading/);
    assert.match(codexView, /showLayoutToggle: !this\.isProfileOverviewMode\(\)/);
    assert.match(codexView, /t\('All projects'\)/);
    assert.match(locationView, /showLayoutToggle: false/);
    assert.match(locationView, /t\('All projects'\)/);
});

test('Codex profile mode and category restore from memory', () => {
    assert.match(codexView, /setLibraryContentMode\(this\.plugin, 'profile'\)/);
    assert.match(codexView, /getLibraryContentMode\(this\.plugin\) === 'profile'/);
    assert.match(codexView, /getRememberedLibraryCategory/);
    assert.match(codexView, /rememberLibraryCategory\(this\.plugin, categoryId/);
});

test('Library view switcher and category tabs restore the last category', () => {
    assert.match(viewSwitcher, /resolveLibraryViewType\(plugin\)/);
    assert.match(categoryTabs, /switchTo\(leaf, plugin, CHARACTER_VIEW_TYPE, 'characters'\)/);
    assert.match(categoryTabs, /switchTo\(leaf, plugin, LOCATION_VIEW_TYPE, 'locations'\)/);
    assert.match(categoryTabs, /rememberLibraryCategory\(plugin, cat\.id\)/);
});

test('Structure top tab restores the last Structure sub-tab', async () => {
    const modes = await readFile(new URL('../components/StructureModeSwitcher.ts', import.meta.url), 'utf8');
    assert.match(modes, /export function rememberStructureMode/);
    assert.match(modes, /export function resolveStructureViewType/);
    assert.match(modes, /export function getRememberedStructureMode/);
    assert.match(viewSwitcher, /resolveStructureViewType\(plugin\)/);
    assert.match(viewSwitcher, /entry\.type === TIMELINE_VIEW_TYPE/);
});
