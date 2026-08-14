import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
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
    getLibraryProfileOrientation,
    isCoreProfileField,
    libraryProfileLayoutFromUnknown,
    removeBuiltinProfileField,
    restoreBuiltinProfileField,
    setLibraryProfileOrientation,
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
    assert.deepEqual(emptyLibraryProfileLayout().profileOrientations, {});
});

test('profile orientation defaults to horizontal and persists per category', async () => {
    const {
        getLibraryProfileOrientation,
        setLibraryProfileOrientation,
    } = mod;
    const settings = { profileOrientations: {} };
    assert.equal(getLibraryProfileOrientation(settings, 'evomon'), 'horizontal');
    await setLibraryProfileOrientation(settings, 'evomon', 'vertical', async () => {});
    assert.equal(getLibraryProfileOrientation(settings, 'evomon'), 'vertical');
    assert.equal(getLibraryProfileOrientation(settings, 'character'), 'horizontal');
});

test('profile orientation defaults to horizontal and persists per category', async () => {
    const settings = { profileOrientations: {} };
    assert.equal(getLibraryProfileOrientation(settings, 'character'), 'horizontal');

    let saved = 0;
    await setLibraryProfileOrientation(settings, 'character', 'vertical', async () => { saved += 1; });
    assert.equal(getLibraryProfileOrientation(settings, 'character'), 'vertical');
    assert.equal(getLibraryProfileOrientation(settings, 'location'), 'horizontal');
    assert.equal(saved, 1);
});

test('profile orientation rolls back when project persistence fails', async () => {
    const settings = { profileOrientations: { character: 'horizontal' } };
    await assert.rejects(
        setLibraryProfileOrientation(settings, 'character', 'vertical', async () => {
            throw new Error('write failed');
        }),
        /write failed/,
    );
    assert.equal(settings.profileOrientations.character, 'horizontal');
});

test('profile orientation loader rejects invalid values', () => {
    const parsed = libraryProfileLayoutFromUnknown({
        version: 1,
        profileOrientations: {
            character: 'vertical',
            location: 'diagonal',
            npc: 'horizontal',
        },
    });
    assert.deepEqual(parsed?.profileOrientations, {
        character: 'vertical',
        npc: 'horizontal',
    });
});

test('all archive detail views expose the shared orientation control', async () => {
    const [character, location, codex, css] = await Promise.all([
        readFile('views/CharacterView.ts', 'utf8'),
        readFile('views/LocationView.ts', 'utf8'),
        readFile('views/CodexView.ts', 'utf8'),
        readFile('styles.css', 'utf8'),
    ]);
    for (const source of [character, location, codex]) {
        assert.match(source, /renderLibraryProfileOrientationToggle/);
        assert.match(source, /getLibraryProfileOrientation/);
    }
    assert.match(css, /character-detail-layout--vertical/);
    assert.match(css, /location-detail-layout\.is-vertical/);
    assert.match(css, /codex-detail-layout\.is-vertical/);
});
