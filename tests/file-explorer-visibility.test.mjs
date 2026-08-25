import assert from 'node:assert/strict';
import test from 'node:test';
import { build } from 'esbuild';

const result = await build({
    entryPoints: ['./utils/fileExplorerVisibility.ts'],
    bundle: true,
    format: 'esm',
    platform: 'node',
    write: false,
});
const {
    shouldHideFileExplorerFile,
    shouldHideFileExplorerFolder,
} = await import(
    `data:text/javascript;base64,${Buffer.from(result.outputFiles[0].text).toString('base64')}`
);

test('System folders are hidden by exact name at any depth', () => {
    assert.equal(shouldHideFileExplorerFolder('System'), true);
    assert.equal(shouldHideFileExplorerFolder('Novel/System'), true);
    assert.equal(shouldHideFileExplorerFolder('Novel/system/'), true);
    assert.equal(shouldHideFileExplorerFolder('Novel/Systems'), false);
});

test('series.json is always hidden even when JSON has a registered view', () => {
    assert.equal(shouldHideFileExplorerFile('series.json', () => true), true);
    assert.equal(shouldHideFileExplorerFile('Novel/SERIES.JSON', () => true), true);
});

test('registered file types remain visible and unopenable types are hidden', () => {
    assert.equal(shouldHideFileExplorerFile('Novel/chapter.md', ext => ext === 'md'), false);
    assert.equal(shouldHideFileExplorerFile('Novel/export.docx', ext => ext === 'md'), true);
    assert.equal(shouldHideFileExplorerFile('Novel/no-extension', () => true), true);
});

test('NarrativeLab canvas formats remain visible in registry fallback mode', () => {
    assert.equal(shouldHideFileExplorerFile('Novel/board.ncanvas'), false);
    assert.equal(shouldHideFileExplorerFile('Novel/board.narrativecanvas'), false);
});
