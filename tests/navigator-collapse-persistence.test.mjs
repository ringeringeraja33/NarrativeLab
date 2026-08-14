import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const [navigatorView, settings, mainTs] = await Promise.all([
    readFile(new URL('../views/NavigatorView.ts', import.meta.url), 'utf8'),
    readFile(new URL('../settings.ts', import.meta.url), 'utf8'),
    readFile(new URL('../main.ts', import.meta.url), 'utf8'),
]);

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
