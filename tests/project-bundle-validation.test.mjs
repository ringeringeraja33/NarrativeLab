import assert from 'node:assert/strict';
import test from 'node:test';
import { build } from 'esbuild';

const result = await build({
    entryPoints: ['utils/projectBundleValidation.ts'],
    bundle: true,
    format: 'esm',
    platform: 'node',
    write: false,
});
const source = result.outputFiles[0].text;
const module = await import(`data:text/javascript;base64,${Buffer.from(source).toString('base64')}`);

test('normalizes safe project bundle paths', () => {
    assert.equal(module.normalizeProjectBundleRelativePath('System\\plotgrid.json'), 'System/plotgrid.json');
    assert.equal(module.normalizeProjectBundleRelativePath('Library/人物.md'), 'Library/人物.md');
});

test('rejects absolute and traversal paths', () => {
    for (const path of ['', '/etc/passwd', 'C:/vault/file.md', '../file.md', 'Scenes/../file.md', 'Scenes//file.md']) {
        assert.throws(() => module.normalizeProjectBundleRelativePath(path));
    }
});

test('identifies both current and legacy root project manifests', () => {
    assert.equal(module.isRootProjectManifest('Book.md', '---\ntype: narrative-lab\n---\n'), true);
    assert.equal(module.isRootProjectManifest('Old.md', '---\ntype: storyline\n---\n'), true);
    assert.equal(module.isRootProjectManifest('Scenes/Book.md', '---\ntype: narrative-lab\n---\n'), false);
    assert.equal(module.isRootProjectManifest('Note.md', '---\ntype: scene\n---\n'), false);
});
