import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const result = await build({
    entryPoints: [path.join(root, 'utils/univerContextMenu.ts')],
    bundle: true,
    format: 'esm',
    platform: 'node',
    write: false,
});
const {
    pointInRect,
    pointInMenuCorridor,
    isUniverContextMenuTarget,
} = await import(
    `data:text/javascript;base64,${Buffer.from(result.outputFiles[0].text).toString('base64')}`
);

test('pointInRect includes padding', () => {
    const rect = { left: 10, top: 10, right: 40, bottom: 30 };
    assert.equal(pointInRect(10, 10, rect), true);
    assert.equal(pointInRect(9, 10, rect), false);
    assert.equal(pointInRect(9, 10, rect, 1), true);
    assert.equal(pointInRect(41, 20, rect, 0), false);
});

test('pointInMenuCorridor covers the gap between a row and its flyout', () => {
    const parent = { left: 100, top: 80, right: 260, bottom: 112 };
    const submenu = { left: 278, top: 80, right: 420, bottom: 220 };
    assert.equal(pointInMenuCorridor(270, 96, parent, submenu), true);
    assert.equal(pointInMenuCorridor(200, 96, parent, submenu), true);
    assert.equal(pointInMenuCorridor(300, 150, parent, submenu), true);
    assert.equal(pointInMenuCorridor(10, 10, parent, submenu), false);
});

test('pointInMenuCorridor covers a left-opening flyout', () => {
    const parent = { left: 400, top: 80, right: 560, bottom: 112 };
    const submenu = { left: 220, top: 80, right: 380, bottom: 200 };
    assert.equal(pointInMenuCorridor(390, 96, parent, submenu), true);
    assert.equal(pointInMenuCorridor(100, 96, parent, submenu), false);
});

test('isUniverContextMenuTarget is false without a DOM element', () => {
    assert.equal(isUniverContextMenuTarget(null), false);
    assert.equal(isUniverContextMenuTarget({}), false);
});

test('plot-grid host starts the flyout hover assist only while the menu is open', async () => {
    const host = await fs.readFile(path.join(root, 'services/PlotGridUniverHost.ts'), 'utf8');
    const css = await fs.readFile(path.join(root, 'styles.css'), 'utf8');
    const menu = await fs.readFile(path.join(root, 'utils/obsidianMenu.ts'), 'utf8');
    assert.match(host, /startHoverAssist/);
    assert.match(host, /endHoverAssist/);
    assert.match(host, /installUniverContextMenuHoverAssist/);
    assert.match(host, /registerConnectedNotesHoverSubmenu/);
    assert.match(css, /narrativelab-univer-submenu-retired/);
    assert.doesNotMatch(css, /z-index:\s*2147483000/);
    assert.match(menu, /isUniverContextMenuTarget/);
});
