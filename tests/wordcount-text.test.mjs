import assert from 'node:assert/strict';
import test from 'node:test';
import { build } from 'esbuild';

const result = await build({
    entryPoints: ['utils/wordcountText.ts'],
    bundle: true,
    format: 'esm',
    platform: 'node',
    write: false,
});
const { prepareTextForWordcount } = await import(
    `data:text/javascript;base64,${Buffer.from(result.outputFiles[0].text).toString('base64')}`
);

test('comment blocks are dropped while surrounding prose remains', () => {
    const cleaned = prepareTextForWordcount('Hello %%secret draft%% world <!-- html note --> there');
    assert.equal(cleaned, 'Hello world there');
});

test('markdown and HTML syntax are not counted as words', () => {
    const cleaned = prepareTextForWordcount([
        '# Title',
        'This is **bold** and *italic* and `code`.',
        'See [the link](https://example.com/path) and [[Notes/Hero.md|Hero]].',
        '<p>Inner <em>text</em></p>',
        '- list item',
        '```js',
        'const ignore = 1;',
        '```',
        '![cover](https://cdn.example/x.png)',
    ].join('\n'));
    assert.equal(
        cleaned,
        'Title This is bold and italic and code. See the link and Hero. Inner text list item',
    );
    assert.doesNotMatch(cleaned, /https?:\/\//);
    assert.doesNotMatch(cleaned, /const ignore/);
    assert.doesNotMatch(cleaned, /<p>|<\/em>|##|\*\*/);
});

test('checklist lines stay unless the exclusion is on', () => {
    const body = 'Keep this\n- [ ] todo note\nDone';
    assert.match(prepareTextForWordcount(body), /todo note/);
    assert.equal(prepareTextForWordcount(body, { excludeChecklists: true }), 'Keep this Done');
});
