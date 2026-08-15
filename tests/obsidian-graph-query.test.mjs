import assert from 'node:assert/strict';
import test from 'node:test';
import { build } from 'esbuild';

const result = await build({
    entryPoints: ['utils/obsidianGraphQuery.ts'],
    bundle: true,
    format: 'esm',
    platform: 'node',
    write: false,
});
const source = result.outputFiles[0].text;
const {
    buildProjectFileGraphQuery,
    buildProjectGraphQuery,
    quoteGraphSearchTerm,
} = await import(`data:text/javascript;base64,${Buffer.from(source).toString('base64')}`);

test('quotes paths that contain spaces or CJK', () => {
    assert.equal(quoteGraphSearchTerm('Library'), '"Library"');
    assert.equal(quoteGraphSearchTerm('苏荷的白马/Library'), '"苏荷的白马/Library"');
    assert.equal(quoteGraphSearchTerm('My Project/Scenes'), '"My Project/Scenes"');
});

test('project graph query is a path: OR of Library and Scenes', () => {
    assert.equal(
        buildProjectGraphQuery(['Book/Library', 'Book/Scenes']),
        'path:"Book/Library" OR path:"Book/Scenes"',
    );
    assert.equal(buildProjectGraphQuery(['Book/Library']), 'path:"Book/Library"');
    assert.equal(buildProjectGraphQuery(['', 'Book/Library', 'Book/Library']), 'path:"Book/Library"');
});

test('node highlight keeps the same path: scope and adds file:', () => {
    assert.equal(
        buildProjectFileGraphQuery(
            ['Book/Library', 'Book/Scenes'],
            'Book/Library/Characters/Lawrence.md',
        ),
        '(path:"Book/Library" OR path:"Book/Scenes") file:"Lawrence"',
    );
});
