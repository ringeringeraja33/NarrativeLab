import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const [navigatorView, settings, mainTs, styles] = await Promise.all([
    readFile(new URL('../views/NavigatorView.ts', import.meta.url), 'utf8'),
    readFile(new URL('../settings.ts', import.meta.url), 'utf8'),
    readFile(new URL('../main.ts', import.meta.url), 'utf8'),
    readFile(new URL('../styles.css', import.meta.url), 'utf8'),
]);

test('Navigator primary sections render in Notes, Scenes, Research order', () => {
    const renderPrimary = navigatorView.slice(
        navigatorView.indexOf('private renderActiveProjectContents'),
        navigatorView.indexOf('private renderScenesFolder'),
    );
    const scenesAt = renderPrimary.indexOf('this.renderScenesFolder');
    const notesAt = renderPrimary.indexOf('this.renderNotesFolder');
    const researchAt = renderPrimary.indexOf('this.renderResearchFolder');
    assert.ok(notesAt >= 0 && notesAt < scenesAt && scenesAt < researchAt);
});

test('Navigator leaf titles use compact indentation without empty sequence gutters', () => {
    assert.match(styles, /--sl-nav-indent-step:\s*8px/);
    const folderHeader = navigatorView.slice(
        navigatorView.indexOf('private renderFolderHeader'),
        navigatorView.indexOf('private binderTextMatches'),
    );
    const noteRow = navigatorView.slice(
        navigatorView.indexOf('private renderNoteRow'),
        navigatorView.indexOf('private renderResearchFolder'),
    );
    const researchRow = navigatorView.slice(
        navigatorView.indexOf('private renderResearchRow'),
        navigatorView.indexOf('private promptNewResearch'),
    );
    const sceneRow = navigatorView.slice(navigatorView.indexOf('private renderSceneRow'));
    assert.doesNotMatch(folderHeader, /appendNavSeqSlot/);
    assert.doesNotMatch(noteRow, /appendNavSeqSlot/);
    assert.doesNotMatch(researchRow, /appendNavSeqSlot/);
    assert.match(sceneRow, /appendNavSeqSlot/);
});

test('Navigator restores Notes and Scenes but opens Research collapsed', () => {
    assert.match(settings, /navigatorCollapsedSections: Array<'notes' \| 'scenes'>/);
    assert.match(settings, /navigatorCollapsedSections: \[\]/);
    assert.match(navigatorView, /new Set\(\['plotlines', 'research'\]\)/);
    assert.match(navigatorView, /async onOpen\(\): Promise<void> \{\s*this\.restorePrimarySectionState\(\)/);
    assert.match(navigatorView, /const REMEMBERED_PRIMARY_SECTIONS = \['notes', 'scenes'\] as const/);
    assert.match(navigatorView, /this\.collapsedNodes\.add\('research'\)/);
    assert.match(navigatorView, /this\.persistPrimarySectionState\(key\)/);
    assert.match(navigatorView, /if \(key !== 'notes' && key !== 'scenes'\) return/);
    assert.match(navigatorView, /collapsedNodes\.delete\('notes'\);\s*this\.persistPrimarySectionState\('notes'\)/);
    assert.match(navigatorView, /collapsedNodes\.delete\('scenes'\);\s*this\.persistPrimarySectionState\('scenes'\)/);
    assert.match(navigatorView, /void this\.plugin\.saveSettings\(\)/);
    assert.doesNotMatch(navigatorView, /REMEMBERED_PRIMARY_SECTIONS = \[[^\]]*research/);
    assert.match(mainTs, /section === 'notes' \|\| section === 'scenes'/);
});

test('Navigator search and filters reveal matching file ancestors transiently', () => {
    assert.match(navigatorView, /private autoExpandedNodes: Set<string> = new Set\(\)/);
    assert.match(navigatorView, /private updateFilterExpansions\(activeProject: StoryLineProject \| null \| undefined\)/);
    assert.match(navigatorView, /this\.updateFilterExpansions\(active\)/);
    assert.match(navigatorView, /this\.autoExpandedNodes\.add\('notes'\)/);
    assert.match(navigatorView, /this\.autoExpandedNodes\.add\('scenes'\)/);
    assert.match(navigatorView, /this\.autoExpandedNodes\.add\('research'\)/);
    assert.match(navigatorView, /this\.autoExpandedNodes\.add\(`project:\$\{activeProject\.filePath\}`\)/);
    assert.match(navigatorView, /!this\.autoExpandedActs\.has\(actKey\)/);
    assert.match(navigatorView, /!this\.autoExpandedChapters\.has\(chKey\)/);
    assert.match(navigatorView, /this\.collapsedNodes\.has\(key\) && !this\.autoExpandedNodes\.has\(key\)/);
});

test('active series can be collapsed without search erasing the manual choice', () => {
    const renderList = navigatorView.slice(
        navigatorView.indexOf('private renderList'),
        navigatorView.indexOf('private renderPlotlinesFolder'),
    );
    assert.match(renderList, /if \(this\.filterText\) this\.autoExpandedNodes\.add\(root\.key\)/);
    assert.match(renderList, /onActivate: \(\) => this\.toggleNode\(root\.key\)/);
    assert.doesNotMatch(renderList, /containsActive\) this\.collapsedNodes\.delete\(root\.key\)/);
});
