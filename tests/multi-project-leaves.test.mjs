import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const [mainTs, boardView, navigatorView, viewSwitcher, leafState, corkboard] = await Promise.all([
    readFile(new URL('../main.ts', import.meta.url), 'utf8'),
    readFile(new URL('../views/BoardView.ts', import.meta.url), 'utf8'),
    readFile(new URL('../views/NavigatorView.ts', import.meta.url), 'utf8'),
    readFile(new URL('../components/ViewSwitcher.ts', import.meta.url), 'utf8'),
    readFile(new URL('../utils/narrativeLabLeafState.ts', import.meta.url), 'utf8'),
    readFile(new URL('../services/CorkboardCanvasService.ts', import.meta.url), 'utf8'),
]);

test('NarrativeLab leaf state binds tabs to a project file', () => {
    assert.match(leafState, /NARRATIVE_LAB_PROJECT_FILE_STATE_KEY/);
    assert.match(leafState, /getLeafNarrativeLabProjectFile/);
    assert.match(leafState, /preservedNarrativeLabLeafState/);
});

test('Open Project opens a per-project Board tab instead of reusing the first leaf', () => {
    assert.match(mainTs, /async openBoardForProject\(/);
    assert.match(mainTs, /workspace\.getLeaf\('tab'\)/);
    assert.match(mainTs, /syncActiveProjectFromLeaf/);
    assert.match(mainTs, /bound && activePath && bound !== activePath/);
    assert.match(navigatorView, /openBoardForProject\(project\)/);
    assert.doesNotMatch(navigatorView, /activateView\(BOARD_VIEW_TYPE\)/);
});

test('BoardView persists project binding and skips foreign-project refresh', () => {
    assert.match(boardView, /boundProjectFile/);
    assert.match(boardView, /getBoundProjectFile/);
    assert.match(boardView, /getState\(\): Record<string, unknown>/);
    assert.match(boardView, /async setState\(/);
    assert.match(boardView, /this\.boundProjectFile !== activePath/);
});

test('corkboard canvas I/O is scoped to the Board leaf project, not global activeProject', () => {
    assert.match(boardView, /resolveCorkboardProjectFile/);
    assert.match(boardView, /isForeignActiveProject/);
    assert.match(boardView, /getBoundCorkboardCanvasPath/);
    assert.match(boardView, /Refusing to write foreign corkboard snapshot/);
    assert.match(corkboard, /getCanvasPath\(projectFilePath/);
    assert.match(corkboard, /isNlManagedPath\(path: string, projectFilePath/);
});

test('ViewSwitcher preserves project binding across in-leaf view changes', () => {
    assert.match(viewSwitcher, /preservedNarrativeLabLeafState\(leaf\)/);
    assert.doesNotMatch(
        viewSwitcher.slice(viewSwitcher.indexOf('entry.type !== activeViewType')),
        /state:\s*\{\s*\}/,
    );
});
