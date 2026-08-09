import assert from 'node:assert/strict';
import test from 'node:test';
import { build } from 'esbuild';

const result = await build({
    entryPoints: ['utils/libraryEntityName.ts'],
    bundle: true,
    format: 'esm',
    platform: 'node',
    write: false,
});
const source = result.outputFiles[0].text;
const { resolveLibraryEntityName, fileTitleFromPath } = await import(
    `data:text/javascript;base64,${Buffer.from(source).toString('base64')}`
);

test('fileTitleFromPath strips folder and extension', () => {
    assert.equal(fileTitleFromPath('Library/Worlds/巨石岭.md'), '巨石岭');
});

test('uses frontmatter name when present', () => {
    assert.equal(
        resolveLibraryEntityName('主城', 'Library/Worlds/主城-backup.md'),
        '主城',
    );
});

test('falls back to file title when name missing or placeholder', () => {
    assert.equal(
        resolveLibraryEntityName('', 'Library/Worlds/远征群岛（世界2）.md'),
        '远征群岛（世界2）',
    );
    assert.equal(
        resolveLibraryEntityName('Untitled', 'Library/Worlds/远征群岛（世界2）.md'),
        '远征群岛（世界2）',
    );
    assert.equal(
        resolveLibraryEntityName('未命名', 'Library/Worlds/落日镇.md'),
        '落日镇',
    );
    assert.equal(
        resolveLibraryEntityName([''], 'Library/Worlds/花海潭.md'),
        '花海潭',
    );
});

test('accepts title when name is empty', () => {
    assert.equal(
        resolveLibraryEntityName('', 'Library/Worlds/x.md', '显示标题'),
        '显示标题',
    );
});

test('unwraps wikilink names', () => {
    assert.equal(
        resolveLibraryEntityName('[[Folder/渡鸦山|渡鸦山]]', 'Library/Worlds/other.md'),
        '渡鸦山',
    );
});
