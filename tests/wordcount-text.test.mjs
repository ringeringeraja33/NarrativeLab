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
const { prepareTextForWordcount, wordcountOptionsForProfile } = await import(
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

const SAMPLE = [
    'The claim is settled (Smith 2020, p. 12). See [@doe2019]. Body stays.',
    'In 2020 the war ended.',
    '[^1]: Secret footnote',
    '- [ ] planning beat',
    'Shown earlier [1].',
    '这一判断成立（张三，2020）。',
    '## References',
    'Doe, J. 2019. Book title.',
].join('\n');

test('academic profile drops citations, footnotes, checklists, and references', () => {
    const cleaned = prepareTextForWordcount(SAMPLE, wordcountOptionsForProfile('academic'));
    assert.match(cleaned, /The claim is settled/);
    assert.match(cleaned, /Body stays/);
    assert.match(cleaned, /In 2020 the war ended/);
    assert.match(cleaned, /这一判断成立/);
    assert.doesNotMatch(cleaned, /Smith 2020/);
    assert.doesNotMatch(cleaned, /doe2019|@doe/);
    assert.doesNotMatch(cleaned, /Secret footnote/);
    assert.doesNotMatch(cleaned, /planning beat/);
    assert.doesNotMatch(cleaned, /Book title/);
    assert.doesNotMatch(cleaned, /张三/);
    assert.doesNotMatch(cleaned, /Shown earlier \d/);
});

test('narrative keeps citations and footnotes but drops checklists', () => {
    const cleaned = prepareTextForWordcount(SAMPLE, wordcountOptionsForProfile('narrative'));
    assert.match(cleaned, /Smith 2020/);
    assert.match(cleaned, /Secret footnote/);
    assert.match(cleaned, /Book title/);
    assert.doesNotMatch(cleaned, /planning beat/);
});

test('general keeps checklists and citations; custom follows plugin switches', () => {
    assert.match(prepareTextForWordcount(SAMPLE, wordcountOptionsForProfile('general')), /planning beat/);
    assert.match(prepareTextForWordcount(SAMPLE, wordcountOptionsForProfile('general')), /Smith 2020/);
    assert.match(
        prepareTextForWordcount('Visible %%hidden%%', wordcountOptionsForProfile('custom', {
            excludeComments: false,
            excludeChecklists: false,
        })),
        /hidden/,
    );
    assert.equal(
        prepareTextForWordcount('Keep this\n- [ ] todo note\nDone', wordcountOptionsForProfile('custom', {
            excludeComments: true,
            excludeChecklists: true,
        })),
        'Keep this Done',
    );
});
