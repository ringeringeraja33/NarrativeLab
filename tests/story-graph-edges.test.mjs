import assert from 'node:assert/strict';
import test from 'node:test';
import { build } from 'esbuild';

const result = await build({
    entryPoints: ['utils/storyGraphEdges.ts'],
    bundle: true,
    format: 'esm',
    platform: 'node',
    write: false,
});
const source = result.outputFiles[0].text;
const { suppressDefaultReferenceEdges } = await import(
    `data:text/javascript;base64,${Buffer.from(source).toString('base64')}`
);

test('keeps default reference when it is the only edge on a pair', () => {
    const edges = [
        { source: 'a', target: 'b', kind: 'wikilink' },
        { source: 'c', target: 'd', kind: 'wikilink' },
    ];
    assert.deepEqual(suppressDefaultReferenceEdges(edges), edges);
});

test('hides default reference when a character relation exists on the pair', () => {
    const edges = [
        { source: 'char::a', target: 'char::b', kind: 'wikilink' },
        { source: 'char::b', target: 'char::a', kind: 'mentor' },
    ];
    const next = suppressDefaultReferenceEdges(edges);
    assert.equal(next.length, 1);
    assert.equal(next[0].kind, 'mentor');
});

test('hides default reference when a categorized wikilink exists on the pair', () => {
    const edges = [
        { source: 'a', target: 'b', kind: 'wikilink' },
        { source: 'b', target: 'a', kind: 'wikilink', relationCategoryId: 'skills' },
    ];
    const next = suppressDefaultReferenceEdges(edges);
    assert.equal(next.length, 1);
    assert.equal(next[0].relationCategoryId, 'skills');
});

test('does not hide categorized wikilinks or character relations', () => {
    const edges = [
        { source: 'a', target: 'b', kind: 'wikilink', relationCategoryId: 'skills' },
        { source: 'a', target: 'b', kind: 'family' },
    ];
    assert.deepEqual(suppressDefaultReferenceEdges(edges), edges);
});

test('right-click connect queues the drop menu instead of showing it on mouseup', async () => {
    const { readFile } = await import('node:fs/promises');
    const source = await readFile(new URL('../components/StoryGraph.ts', import.meta.url), 'utf8');
    assert.match(source, /queueConnectDropMenu/);
    assert.match(source, /pendingConnectMenu/);
    assert.match(source, /story-graph-connect-chooser/);
    assert.match(source, /sg-avatar-clip-/);
    assert.doesNotMatch(source, /sg-clip-\$\{node\.id\.replace/);
    assert.match(source, /mountConnectChooser/);
    assert.doesNotMatch(source, /cls: 'menu story-graph-connect-chooser'/);
    assert.match(source, /connectClickFrom && this\.connectClickFrom\.id !== node\.id/);
    assert.doesNotMatch(source, /this\.showConnectDropMenu\(ue/);
    assert.match(source, /revealWikilink/);
});

test('large Story Graphs use the expanded limit and report omitted nodes', async () => {
    const { readFile } = await import('node:fs/promises');
    const [graph, modeBar] = await Promise.all([
        readFile(new URL('../components/StoryGraph.ts', import.meta.url), 'utf8'),
        readFile(new URL('../components/LibraryModeBar.ts', import.meta.url), 'utf8'),
    ]);
    assert.match(graph, /const MAX_STORY_NODES = 300/);
    assert.match(graph, /onNodeLimitExceeded\?\.\(total, MAX_STORY_NODES\)/);
    assert.match(modeBar, /Story Graph node limit reached/);
    assert.doesNotMatch(modeBar, /DEFAULT_FILTERS|setStoryGraphFilters/);
});

test('an empty legend selection displays no Story Graph nodes or edges', async () => {
    const { readFile } = await import('node:fs/promises');
    const graph = await readFile(new URL('../components/StoryGraph.ts', import.meta.url), 'utf8');
    assert.match(graph, /if \(this\.legendNodeKeys\.size === 0\) return false/);
    assert.match(graph, /const hasNodeSelection = this\.legendNodeKeys\.size > 0/);
    assert.match(graph, /const hasEdgeSelection = this\.legendEdgeKeys\.size > 0/);
    assert.match(graph, /:\s*\[\];/);
    assert.doesNotMatch(graph, /new Set\(this\.nodes\.map\(node => node\.id\)\)/);
    assert.match(graph, /syncSimulationWithLegend\(filtersActive\)/);
    assert.doesNotMatch(graph, /this\.buildSVG\(\);\s*this\.runSimulation\(\)/);
});

test('profile associations are mirrored, graph-backed, rename-safe, and never delete note prose', async () => {
    const { readFile } = await import('node:fs/promises');
    const [panel, refs, modeBar, graph, characterView, locationView, codexView, main] = await Promise.all([
        readFile(new URL('../components/LibraryRelationsPanel.ts', import.meta.url), 'utf8'),
        readFile(new URL('../utils/storyGraphRefs.ts', import.meta.url), 'utf8'),
        readFile(new URL('../components/LibraryModeBar.ts', import.meta.url), 'utf8'),
        readFile(new URL('../components/StoryGraph.ts', import.meta.url), 'utf8'),
        readFile(new URL('../views/CharacterView.ts', import.meta.url), 'utf8'),
        readFile(new URL('../views/LocationView.ts', import.meta.url), 'utf8'),
        readFile(new URL('../views/CodexView.ts', import.meta.url), 'utf8'),
        readFile(new URL('../main.ts', import.meta.url), 'utf8'),
    ]);
    assert.match(panel, /upsertManagedStoryGraphRelation/);
    assert.match(panel, /migrateFocusPair/);
    assert.match(panel, /focusNotes\(focusBundleFor/);
    assert.match(panel, /relatedPaths/);
    assert.match(panel, /library-relations-icon-button is-confirm/);
    assert.match(panel, /Open related note: \{name\}/);
    assert.match(panel, /workspace\.openLinkText\(otherPath, currentPath, true\)/);
    assert.match(panel, /relatedFile instanceof obsidian\.TFile/);
    assert.doesNotMatch(panel, /Repair a missing mirror/);
    assert.match(refs, /await writeManagedRelationMirror\(app, normalized\.sourcePath/);
    assert.match(refs, /await writeManagedRelationMirror\(app, normalized\.targetPath/);
    assert.match(refs, /processManagedRelationFrontmatter/);
    assert.match(refs, /rebaseStoryGraphRelationPaths/);
    assert.match(refs, /if \(edge\.managedRelationId\)[\s\S]*?removeManagedStoryGraphRelation/);
    assert.match(refs, /if \(ref\.managed\) \{[\s\S]*?kept\.push\(ref\)/);
    assert.match(modeBar, /add\(sourcePath, ref\.targetPath, ref\.id\)/);
    assert.match(graph, /managedRelationId: link\.managedRelationId/);
    assert.match(main, /rebaseStoryGraphRelationPaths\(this, oldPath, file\.path/);
    for (const view of [characterView, locationView, codexView]) {
        assert.match(view, /renderLibraryRelationsPanel\(sidePanel/);
    }
});
