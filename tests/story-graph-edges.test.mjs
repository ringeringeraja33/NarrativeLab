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
    assert.doesNotMatch(source, /this\.showConnectDropMenu\(ue/);
    assert.match(source, /revealWikilink/);
});
