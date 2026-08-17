import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const result = await build({
    entryPoints: [path.join(root, 'utils/univerSheetListReorder.ts')],
    bundle: true,
    format: 'esm',
    platform: 'node',
    write: false,
});
const {
    sheetListReorderTargetIndex,
    matchSheetListMenu,
} = await import(
    `data:text/javascript;base64,${Buffer.from(result.outputFiles[0].text).toString('base64')}`
);

test('sheetListReorderTargetIndex uses Univer splice-after-remove indices', () => {
    assert.equal(sheetListReorderTargetIndex(2, 0), 0);
    assert.equal(sheetListReorderTargetIndex(0, 4), 3);
    assert.equal(sheetListReorderTargetIndex(2, 1), 1);
    assert.equal(sheetListReorderTargetIndex(1, 1), 1);
    assert.equal(sheetListReorderTargetIndex(1, 2), 1);
});

test('matchSheetListMenu requires the same titles in workbook order', () => {
    const sheets = [
        { id: 'a', title: '1稿' },
        { id: 'b', title: '草案' },
        { id: 'c', title: '名词包装' },
    ];
    assert.deepEqual(matchSheetListMenu(['1稿', '草案', '名词包装'], sheets), sheets);
    assert.equal(matchSheetListMenu(['1稿', '草案'], sheets), null);
    assert.equal(matchSheetListMenu(['草案', '1稿', '名词包装'], sheets), null);
    assert.equal(matchSheetListMenu(['1稿'], [{ id: 'a', title: '1稿' }]), null);
});

test('plot-grid host injects sheet-list handles without touching tab drag', async () => {
    const host = await fs.readFile(path.join(root, 'services/PlotGridUniverHost.ts'), 'utf8');
    const css = await fs.readFile(path.join(root, 'styles.css'), 'utf8');
    const util = await fs.readFile(path.join(root, 'utils/univerSheetListReorder.ts'), 'utf8');
    assert.match(host, /installUniverSheetListReorder/);
    assert.match(host, /sheet\.command\.set-worksheet-order/);
    assert.doesNotMatch(host, /\[class\*="sheet-bar"\]/);
    assert.match(util, /data-slot="dropdown-menu-item"/);
    assert.match(util, /narrativelab-sheet-list-handle/);
    assert.match(util, /Bottom tab dragging is left to Univer/);
    assert.match(css, /narrativelab-sheet-list-handle/);
    assert.match(css, /narrativelab-sheet-list-drop-before/);
});
