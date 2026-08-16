import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const [navigatorView, i18nViews] = await Promise.all([
    readFile(new URL('../views/NavigatorView.ts', import.meta.url), 'utf8'),
    readFile(new URL('../utils/i18n-views.zh.ts', import.meta.url), 'utf8'),
]);

test('navigator filter and sort apply to the project/series tree', () => {
    assert.match(navigatorView, /buildNavigatorRoots/);
    assert.match(navigatorView, /projectMatchesFilter/);
    assert.match(navigatorView, /sortProjectList/);
    assert.match(navigatorView, /Filter projects & scenes…/);
    assert.match(navigatorView, /case 'chapter':/);
    assert.match(navigatorView, /sortMode !== 'reading' && this\.sortMode !== 'chapter'/);
    assert.match(navigatorView, /filterDebounceTimer/);
    assert.match(navigatorView, /sceneMatchesFilter/);
    assert.match(navigatorView, /getAllScenes\(\)\.some/);
    assert.match(navigatorView, /collapsedActs\.clear\(\)/);
    assert.match(navigatorView, /No projects or scenes match the current filter/);
    assert.match(i18nViews, /'Filter projects & scenes…':\s*'筛选项目与场景…'/);
    assert.match(i18nViews, /'No projects or scenes match the current filter\.'/);
});

test('inactive series titles use the same muted style as inactive projects', () => {
    assert.match(navigatorView, /sl-nav-series-root is-active-project/);
    assert.match(navigatorView, /sl-nav-series-root is-inactive-project/);
});

test('series-nested project folders indent one step past the project row', () => {
    assert.match(navigatorView, /this\.renderActiveProjectContents\(node\.body, depth \+ 1\)/);
    assert.match(navigatorView, /private renderActiveProjectContents\(parent: HTMLElement, folderDepth: number\)/);
    assert.match(navigatorView, /this\.renderNotesFolder\(parent, folderDepth\)/);
    assert.match(navigatorView, /this\.renderScenesFolder\(parent, folderDepth\)/);
    assert.match(navigatorView, /this\.renderResearchFolder\(parent, folderDepth\)/);
    assert.match(navigatorView, /this\.renderPlotlinesFolder\(scenesNode\.body, draftScenes, folderDepth \+ 1\)/);
    assert.doesNotMatch(navigatorView, /depth: 1,\s*cls: 'sl-nav-primary-folder'/);
});
