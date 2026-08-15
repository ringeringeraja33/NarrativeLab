import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const result = await build({
    entryPoints: [path.join(root, 'utils/obsidianMenu.ts')],
    bundle: true,
    format: 'esm',
    platform: 'node',
    write: false,
    external: ['obsidian'],
});
const source = result.outputFiles[0].text;
const {
    menuShowShouldGateOnTrailingContextMenu,
    menuShowShouldShieldTrailingPointerEvents,
} = await import(
    `data:text/javascript;base64,${Buffer.from(source).toString('base64')}`
);

test('gates right mouseup/pointerup so trailing contextmenu cannot dismiss the menu', () => {
    assert.equal(
        menuShowShouldGateOnTrailingContextMenu({ type: 'mouseup', button: 2 }),
        true,
    );
    assert.equal(
        menuShowShouldGateOnTrailingContextMenu({ type: 'pointerup', button: 2 }),
        true,
    );
    assert.equal(
        menuShowShouldGateOnTrailingContextMenu({ type: 'mousedown', button: 2 }),
        true,
    );
});

test('does not wait for another contextmenu when already handling contextmenu or left click', () => {
    assert.equal(
        menuShowShouldGateOnTrailingContextMenu({ type: 'contextmenu', button: 2 }),
        false,
    );
    assert.equal(
        menuShowShouldGateOnTrailingContextMenu({ type: 'click', button: 0 }),
        false,
    );
    assert.equal(
        menuShowShouldGateOnTrailingContextMenu({ x: 10, y: 20 }),
        false,
    );
});

test('shields auxclick after a contextmenu so the menu is not treated as outside-click', () => {
    assert.equal(
        menuShowShouldShieldTrailingPointerEvents({ type: 'contextmenu', button: 2 }),
        true,
    );
    assert.equal(
        menuShowShouldShieldTrailingPointerEvents({ type: 'mouseup', button: 2 }),
        true,
    );
    assert.equal(
        menuShowShouldShieldTrailingPointerEvents({ type: 'click', button: 0 }),
        false,
    );
    assert.equal(
        menuShowShouldShieldTrailingPointerEvents({ x: 10, y: 20 }),
        false,
    );
});

test('plugin sources show Obsidian menus through showMenuSafely', async () => {
    const skip = new Set([
        path.join(root, 'utils', 'obsidianMenu.ts'),
    ]);
    const hits = [];
    async function walk(dir) {
        for (const entry of await fs.readdir(dir, { withFileTypes: true })) {
            const full = path.join(dir, entry.name);
            if (entry.isDirectory()) {
                if (entry.name === 'node_modules' || entry.name === 'canvas-runtime') continue;
                await walk(full);
                continue;
            }
            if (!entry.name.endsWith('.ts')) continue;
            if (skip.has(full)) continue;
            const text = await fs.readFile(full, 'utf8');
            if (/\.showAtMouseEvent\(/.test(text) || /menu\.showAtPosition\(/.test(text)) {
                hits.push(path.relative(root, full));
            }
        }
    }
    await walk(path.join(root, 'components'));
    await walk(path.join(root, 'views'));
    await walk(path.join(root, 'services'));
    await walk(path.join(root, 'utils'));
    for (const file of ['main.ts', 'settings.ts']) {
        const text = await fs.readFile(path.join(root, file), 'utf8');
        if (/\.showAtMouseEvent\(/.test(text) || /menu\.showAtPosition\(/.test(text)) {
            hits.push(file);
        }
    }
    assert.deepEqual(hits, []);
});
