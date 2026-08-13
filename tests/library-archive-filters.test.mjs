import assert from 'node:assert/strict';
import test from 'node:test';
import { build } from 'esbuild';

const result = await build({
    entryPoints: ['components/LibraryFilterChips.ts'],
    bundle: true,
    format: 'esm',
    platform: 'node',
    write: false,
    plugins: [{
        name: 'stub-obsidian-ui',
        setup(b) {
            b.onResolve({ filter: /.*/ }, (args) => {
                if (args.path === 'obsidian') return { path: 'obsidian', namespace: 'stub' };
                if (args.path.endsWith('/Tooltip') || args.path.endsWith('\\Tooltip')) {
                    return { path: 'tooltip', namespace: 'stub' };
                }
                if (args.path.includes('i18n')) return { path: 'i18n', namespace: 'stub' };
                if (args.path.endsWith('/main') || args.path.endsWith('\\main')) {
                    return { path: 'main', namespace: 'stub' };
                }
                return null;
            });
            b.onLoad({ filter: /.*/, namespace: 'stub' }, (args) => {
                if (args.path === 'obsidian') {
                    return {
                        contents: `
                            export class Menu {
                                addItem() { return this; }
                                showAtMouseEvent() {}
                            }
                            export function setIcon() {}
                            export default {};
                        `,
                        loader: 'js',
                    };
                }
                if (args.path === 'i18n') {
                    return {
                        contents: `export function t(s, vars) {
                            if (!vars) return s;
                            return s.replace(/\\{(\\w+)\\}/g, (_, k) => vars[k] ?? '');
                        }`,
                        loader: 'js',
                    };
                }
                return { contents: 'export function attachTooltip() {} export default {};', loader: 'js' };
            });
        },
    }],
});

const source = result.outputFiles[0].text;
const mod = await import(`data:text/javascript;base64,${Buffer.from(source).toString('base64')}`);
const {
    ARCHIVE_FILTER_HASHTAGS_KEY,
    buildArchiveFilterFieldOptions,
    collectArchiveFilterLabels,
    collectDelimitedTags,
    collectEntityFilterKeys,
    collectHashtagsFromText,
    readEntityFilterValue,
} = mod;

test('collectDelimitedTags splits comma lists case-insensitively', () => {
    const into = new Map();
    collectDelimitedTags(into, '导师, Boss, Evomon');
    assert.equal(into.get('导师'), '导师');
    assert.equal(into.get('boss'), 'Boss');
    assert.equal(into.get('evomon'), 'Evomon');
});

test('collectHashtagsFromText finds CJK and Latin tags', () => {
    const into = new Map();
    collectHashtagsFromText(into, '他是 #道馆弟子 也是 #Boss');
    assert.equal(into.get('道馆弟子'), '道馆弟子');
    assert.equal(into.get('boss'), 'Boss');
});

test('buildArchiveFilterFieldOptions always includes hashtags virtual field', () => {
    const opts = buildArchiveFilterFieldOptions([
        { fields: [{ key: 'name', label: 'Name' }, { key: 'role', label: 'Role' }] },
    ]);
    assert.equal(opts[0].key, ARCHIVE_FILTER_HASHTAGS_KEY);
    assert.ok(opts.some(o => o.key === 'role'));
    assert.ok(!opts.some(o => o.key === 'name'));
});

test('collectArchiveFilterLabels uses only selected fields', () => {
    const entities = [
        { role: '导师', occupation: '商人', props: 'carries #神秘人 gear' },
        { role: 'Boss', occupation: '守卫者', props: 'plain text' },
    ];
    const byRole = collectArchiveFilterLabels(entities, ['role'], (e) =>
        String(e.role || '').split(',').map(s => s.trim()).filter(Boolean));
    assert.deepEqual([...byRole.keys()].sort(), ['boss', '导师']);

    const byOcc = collectArchiveFilterLabels(entities, ['occupation']);
    assert.deepEqual([...byOcc.keys()].sort(), ['商人', '守卫者']);

    const byHash = collectArchiveFilterLabels(entities, [ARCHIVE_FILTER_HASHTAGS_KEY]);
    assert.deepEqual([...byHash.keys()], ['神秘人']);
});

test('readEntityFilterValue resolves custom composite keys', () => {
    const entity = {
        custom: { 'Extra :: Faction': '和平先驱' },
    };
    assert.equal(readEntityFilterValue(entity, 'Faction'), '和平先驱');
    assert.equal(
        collectEntityFilterKeys(entity, ['Faction'])[0],
        '和平先驱',
    );
});
