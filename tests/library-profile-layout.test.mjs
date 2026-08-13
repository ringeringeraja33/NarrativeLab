import assert from 'node:assert/strict';
import test from 'node:test';
import { build } from 'esbuild';

const result = await build({
    entryPoints: ['utils/libraryProfileLayout.ts'],
    bundle: true,
    format: 'esm',
    platform: 'node',
    write: false,
    plugins: [{
        name: 'stub-ui',
        setup(b) {
            b.onResolve({ filter: /.*/ }, (args) => {
                if (args.path === 'obsidian') return { path: 'obsidian', namespace: 'stub' };
                if (args.path.includes('ConfirmModal')) return { path: 'confirm', namespace: 'stub' };
                if (args.path.includes('i18n')) return { path: 'i18n', namespace: 'stub' };
                if (args.path.includes('settings')) return { path: 'settings', namespace: 'stub' };
                return null;
            });
            b.onLoad({ filter: /.*/, namespace: 'stub' }, (args) => {
                if (args.path === 'obsidian') {
                    return { contents: 'export function setIcon(){} export default {};', loader: 'js' };
                }
                if (args.path === 'i18n') {
                    return { contents: 'export function t(s, vars){ if(!vars) return s; return s.replace(/\\{(\\w+)\\}/g,(_,k)=>vars[k]??""); }', loader: 'js' };
                }
                if (args.path === 'confirm') {
                    return { contents: 'export function openConfirmModal(){}', loader: 'js' };
                }
                return { contents: 'export {};', loader: 'js' };
            });
        },
    }],
});

const source = result.outputFiles[0].text;
const mod = await import(`data:text/javascript;base64,${Buffer.from(source).toString('base64')}`);
const {
    emptyLibraryProfileLayout,
    filterRemovedBuiltinFields,
    isCoreProfileField,
    libraryProfileLayoutFromUnknown,
    removeBuiltinProfileField,
    restoreBuiltinProfileField,
} = mod;

test('name is a core undeletable field', () => {
    assert.equal(isCoreProfileField('name'), true);
    assert.equal(isCoreProfileField('role'), false);
});

test('filterRemovedBuiltinFields drops removed keys only', () => {
    const settings = {
        removedBuiltinFields: { character: ['fears', 'belief'] },
    };
    const fields = [
        { key: 'name', label: 'Name' },
        { key: 'role', label: 'Role' },
        { key: 'fears', label: 'Fears' },
        { key: 'belief', label: 'Belief' },
    ];
    assert.deepEqual(
        filterRemovedBuiltinFields(fields, settings, 'character').map(f => f.key),
        ['name', 'role'],
    );
});

test('removeBuiltinProfileField refuses core fields and restores cleanly', async () => {
    const settings = { removedBuiltinFields: {}, hiddenFields: { character: ['role'] } };
    await removeBuiltinProfileField(settings, 'character', 'name', async () => {});
    assert.deepEqual(settings.removedBuiltinFields.character || [], []);

    await removeBuiltinProfileField(settings, 'character', 'role', async () => {});
    assert.deepEqual(settings.removedBuiltinFields.character, ['role']);
    assert.deepEqual(settings.hiddenFields.character, []);

    await restoreBuiltinProfileField(settings, 'character', 'role', async () => {});
    assert.deepEqual(settings.removedBuiltinFields.character, []);
});

test('libraryProfileLayoutFromUnknown requires useful payload', () => {
    assert.equal(libraryProfileLayoutFromUnknown({}), null);
    assert.equal(libraryProfileLayoutFromUnknown(null), null);
    const parsed = libraryProfileLayoutFromUnknown({
        version: 1,
        hiddenFields: { character: ['fears'] },
    });
    assert.ok(parsed);
    assert.deepEqual(parsed.hiddenFields.character, ['fears']);
    assert.deepEqual(emptyLibraryProfileLayout().characterCustomSections, []);
});
