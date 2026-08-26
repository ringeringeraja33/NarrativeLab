import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { build } from 'esbuild';

const result = await build({
    stdin: {
        contents: await readFile(new URL('../utils/libraryProfileLayout.ts', import.meta.url), 'utf8'),
        loader: 'ts',
        resolveDir: '/',
    },
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
                if (args.path.includes('customFieldInputHeight')) return { path: 'input-height', namespace: 'source' };
                return null;
            });
            b.onLoad({ filter: /.*/, namespace: 'source' }, async () => ({
                contents: await readFile(new URL('../utils/customFieldInputHeight.ts', import.meta.url), 'utf8'),
                loader: 'ts',
            }));
            b.onLoad({ filter: /.*/, namespace: 'stub' }, (args) => {
                if (args.path === 'obsidian') {
                    return { contents: 'export function setIcon(){} export class Modal{} export class Setting{} export default {};', loader: 'js' };
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
const propertyOrderResult = await build({
    stdin: {
        contents: await readFile(new URL('../utils/libraryProfilePropertyOrder.ts', import.meta.url), 'utf8'),
        loader: 'ts',
    },
    bundle: true,
    format: 'esm',
    platform: 'node',
    write: false,
});
const propertyOrderSource = propertyOrderResult.outputFiles[0].text;
const propertyOrderMod = await import(`data:text/javascript;base64,${Buffer.from(propertyOrderSource).toString('base64')}`);
const characterResult = await build({
    entryPoints: ['models/Character.ts'],
    bundle: true,
    format: 'esm',
    platform: 'node',
    write: false,
});
const characterSource = characterResult.outputFiles[0].text;
const characterMod = await import(`data:text/javascript;base64,${Buffer.from(characterSource).toString('base64')}`);
const {
    emptyLibraryProfileLayout,
    filterRemovedBuiltinFields,
    getLibraryProfileOrientation,
    getOrderedProfileSectionIds,
    isCoreProfileField,
    libraryProfileLayoutFromUnknown,
    removeBuiltinProfileField,
    restoreBuiltinProfileField,
    sanitizeCustomFieldInputHeightMap,
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
    assert.deepEqual(emptyLibraryProfileLayout().profileFieldInputHeights, {});
});

test('character tagline can read built-in, universal, and custom fields', () => {
    const base = {
        filePath: 'Library/Characters/Asura.md',
        type: 'character',
        name: 'Asura',
        personality: 'calm',
        occupation: 'pilot',
        universalFields: { motto: ['Never', 'Yield'] },
        custom: {
            faction: 'Northern Fleet',
            'Combat :: Signature': 'Counterattack',
        },
    };
    assert.equal(characterMod.resolveCharacterCardSnippet(base), 'calm');
    assert.equal(characterMod.resolveCharacterCardSnippet({ ...base, tagline: 'occupation' }), 'pilot');
    assert.equal(characterMod.resolveCharacterCardSnippet({ ...base, tagline: 'universal:motto' }), 'Never, Yield');
    assert.equal(characterMod.resolveCharacterCardSnippet({ ...base, tagline: 'custom:faction' }), 'Northern Fleet');
    assert.equal(
        characterMod.resolveCharacterCardSnippet({ ...base, tagline: 'custom:Combat :: Signature' }),
        'Counterattack',
    );
    assert.equal(characterMod.resolveCharacterCardSnippet({ ...base, tagline: 'custom:missing' }), 'calm');
});

test('character tagline selector lists universal and per-character custom fields', async () => {
    const source = await readFile('views/CharacterView.ts', 'utf8');
    assert.match(source, /fieldTemplates\.getAll\(\)/);
    assert.match(source, /CHARACTER_TAGLINE_UNIVERSAL_PREFIX/);
    assert.match(source, /CHARACTER_TAGLINE_CUSTOM_PREFIX/);
    assert.match(source, /CUSTOM_SECTION_KEY_SEP/);
});

test('custom field input heights load cleanly and clamp unsafe values', () => {
    assert.deepEqual(sanitizeCustomFieldInputHeightMap({
        normal: 180.4,
        tooSmall: 2,
        tooLarge: 5000,
        invalid: '240',
        infinite: Infinity,
    }), {
        normal: 180,
        tooSmall: 34,
        tooLarge: 1200,
    });

    const parsed = libraryProfileLayoutFromUnknown({
        version: 1,
        profileFieldInputHeights: { 'universal::field-1': 246 },
        profileFieldOverrides: {
            character: {
                voice: { label: 'Voice texture', placeholder: 'Rasp, cadence…' },
                empty: { label: '  ', placeholder: 42 },
            },
        },
    });
    assert.deepEqual(parsed?.profileFieldInputHeights, { 'universal::field-1': 246 });
    assert.deepEqual(parsed?.profileFieldOverrides, {
        character: { voice: { label: 'Voice texture', placeholder: 'Rasp, cadence…' } },
    });
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

test('profile section order is shared, sanitized, and appends newly introduced sections', () => {
    const settings = {
        profileSectionOrders: {
            character: ['Background and Arc', 'Custom Fields', 'Background and Arc', 'stale'],
        },
    };
    assert.deepEqual(
        getOrderedProfileSectionIds(settings, 'character', [
            'Personality and Appearance',
            'Background and Arc',
            'Custom Fields',
        ]),
        ['Background and Arc', 'Custom Fields', 'Personality and Appearance'],
    );
    assert.deepEqual(
        getOrderedProfileSectionIds({}, 'location', ['Overview', 'Connections']),
        ['Overview', 'Connections'],
    );
});

test('frontmatter ordering preserves values and unknown keys while ordering nested mappings', () => {
    propertyOrderMod.setLibraryProfilePropertyOrderProvider(() => ({
        orderedKeys: ['name', 'goal', 'voice_key'],
        visibleKeys: ['name', 'goal'],
        customKeys: ['Arc :: Turning point', 'Alias'],
        universalFieldIds: ['voice-id', 'mood-id'],
    }));
    const result = propertyOrderMod.orderLibraryEntityFrontmatter({
        created: '2026-01-01',
        unknown: 42,
        goal: 'Escape',
        type: 'character',
        name: 'Lupus',
        custom: { Alias: 'Wolf', 'Arc :: Turning point': 'Truth' },
        universalFields: { 'mood-id': 'grim', 'voice-id': 'quiet' },
        modified: '2026-08-25',
    }, 'character');
    assert.deepEqual(Object.keys(result), [
        'type', 'name', 'goal', 'custom', 'universalFields', 'modified', 'created', 'unknown',
    ]);
    assert.deepEqual(Object.keys(result.custom), ['Arc :: Turning point', 'Alias']);
    assert.deepEqual(Object.keys(result.universalFields), ['voice-id', 'mood-id']);
    assert.equal(result.unknown, 42);
});

test('flat custom fields can move without disturbing custom-section slots', () => {
    const source = {
        Alpha: 'a',
        'Arc :: Beat': 'section',
        Beta: 'b',
        Gamma: 'g',
    };
    const moved = propertyOrderMod.moveMappingEntry(
        source,
        'Gamma',
        -1,
        key => !key.includes(' :: '),
    );
    assert.deepEqual(Object.keys(moved), ['Alpha', 'Arc :: Beat', 'Gamma', 'Beta']);
    assert.equal(moved.Gamma, 'g');
    assert.equal(moved['Arc :: Beat'], 'section');
});

test('profile ordering is wired through editors, YAML writers, and native Base views', async () => {
    const [character, location, codex, characterManager, locationManager, codexManager, nativeBase, main] = await Promise.all([
        readFile('views/CharacterView.ts', 'utf8'),
        readFile('views/LocationView.ts', 'utf8'),
        readFile('views/CodexView.ts', 'utf8'),
        readFile('services/CharacterManager.ts', 'utf8'),
        readFile('services/LocationManager.ts', 'utf8'),
        readFile('services/CodexManager.ts', 'utf8'),
        readFile('components/NativeLibraryBase.ts', 'utf8'),
        readFile('main.ts', 'utf8'),
    ]);
    for (const view of [character, location, codex]) {
        assert.match(view, /getOrderedProfileSectionIds/);
        assert.match(view, /attachProfileSectionOrderControls/);
        assert.match(view, /Custom Fields/);
    }
    for (const manager of [characterManager, locationManager, codexManager]) {
        assert.match(manager, /orderLibraryEntityFrontmatter/);
    }
    assert.match(nativeBase, /getProfileTableOrder/);
    assert.match(nativeBase, /visibleKeys/);
    assert.match(main, /setLibraryProfilePropertyOrderProvider/);
    assert.match(main, /resolveLibraryProfilePropertyOrder/);
});

test('built-in, legacy custom, and user-defined sections share one header action style', async () => {
    const [character, location, codex, customSections, layout, css] = await Promise.all([
        readFile('views/CharacterView.ts', 'utf8'),
        readFile('views/LocationView.ts', 'utf8'),
        readFile('views/CodexView.ts', 'utf8'),
        readFile('components/CustomSectionsRenderer.ts', 'utf8'),
        readFile('utils/libraryProfileLayout.ts', 'utf8'),
        readFile('styles.css', 'utf8'),
    ]);
    for (const view of [character, location, codex]) {
        assert.match(view, /createProfileSectionAction/);
        assert.match(view, /profile-section-add-field-btn/);
    }
    assert.match(customSections, /getProfileSectionActions/);
    assert.match(customSections, /profile-section-action-btn profile-section-add-field-btn/);
    assert.doesNotMatch(customSections, /text: t\('\+ Add field to this section'\)/);
    assert.match(layout, /getProfileSectionActions/);
    assert.match(layout, /createProfileSectionAction/);
    assert.match(css, /\.profile-section-actions \.profile-section-action-btn/);
});

test('all custom profile text renderers support remembered vertical resizing', async () => {
    const [character, location, codex, customSections, css] = await Promise.all([
        readFile('views/CharacterView.ts', 'utf8'),
        readFile('views/LocationView.ts', 'utf8'),
        readFile('views/CodexView.ts', 'utf8'),
        readFile('components/CustomSectionsRenderer.ts', 'utf8'),
        readFile('styles.css', 'utf8'),
    ]);
    for (const source of [character, location, codex]) {
        assert.match(source, /bindResizableCustomFieldInput/);
        assert.match(source, /tpl\.type === 'textarea' \|\| tpl\.type === 'text'/);
    }
    assert.match(customSections, /bindCustomTextArea/);
    assert.match(customSections, /createEl\('textarea'/);
    assert.match(css, /textarea\.nl-resizable-custom-field/);
});

test('built-in and universal profile fields share the five-action toolbar', async () => {
    const [character, location, codex, layout, css] = await Promise.all([
        readFile('views/CharacterView.ts', 'utf8'),
        readFile('views/LocationView.ts', 'utf8'),
        readFile('views/CodexView.ts', 'utf8'),
        readFile('utils/libraryProfileLayout.ts', 'utf8'),
        readFile('styles.css', 'utf8'),
    ]);
    for (const source of [character, location, codex]) {
        assert.match(source, /attachBuiltinFieldEditControl/);
        assert.match(source, /attachUniversalProfileFieldControls/);
        assert.match(source, /universalProfileFieldKey/);
    }
    assert.match(layout, /profile-field-edit-btn/);
    assert.match(layout, /field-hide-btn/);
    assert.match(layout, /field-remove-btn/);
    assert.match(css, /Unified five-action field toolbar/);
});
