import assert from 'node:assert/strict';
import test from 'node:test';
import { build } from 'esbuild';

const result = await build({
    entryPoints: ['utils/libraryCategoryTransactions.ts'],
    bundle: true,
    format: 'esm',
    platform: 'node',
    write: false,
});
const source = result.outputFiles[0].text;
const {
    allocateLibraryCategoryId,
    areCaseEquivalentVaultPaths,
    buildLibraryPathScopeFilter,
    collectReferencedLibraryCategoryIds,
    findLibraryCategoriesMissingFolders,
    planLibraryFolderRename,
    shouldEnableAdoptedLibraryCategory,
} = await import(
    `data:text/javascript;base64,${Buffer.from(source).toString('base64')}`
);

test('case-only Base aliases are treated as the same vault path', () => {
    assert.equal(
        areCaseEquivalentVaultPaths(
            'Project/Bases/library-characters.base',
            'Project/Bases/library-Characters.base',
        ),
        true,
    );
    assert.equal(
        areCaseEquivalentVaultPaths(
            'Project/Bases/library-locations.base',
            'Project/Bases/library-Skills.base',
        ),
        false,
    );
});

test('distinct folders with the same slug receive distinct category ids', () => {
    assert.equal(allocateLibraryCategoryId('story-ideas', []), 'story-ideas');
    assert.equal(
        allocateLibraryCategoryId('story-ideas', ['story-ideas', 'story-ideas-2']),
        'story-ideas-3',
    );
});

test('Base folder filters use path boundaries and include shared plus local roots', () => {
    assert.deepEqual(
        buildLibraryPathScopeFilter([
            'Series/Library/Characters',
            'Book/Library/Characters/',
            'Series/Library/Characters',
        ]),
        {
            or: [
                'if(file, file.inFolder("Series/Library/Characters"), false)',
                'if(file, file.inFolder("Book/Library/Characters"), false)',
            ],
        },
    );
    assert.equal(
        buildLibraryPathScopeFilter(['Library/角色']),
        'if(file, file.inFolder("Library/角色"), false)',
    );
});

const state = (root, oldKind, newKind) => ({
    root,
    oldPath: `${root}/Old`,
    newPath: `${root}/New`,
    rootKind: 'folder',
    oldKind,
    newKind,
});

test('preflights every shared and local Library root before rename', () => {
    const plan = planLibraryFolderRename([
        state('Series/Library', 'folder', 'missing'),
        state('Book/Library', 'folder', 'folder'),
    ]);
    assert.deepEqual(plan, {
        ok: false,
        reason: 'target-conflict',
        path: 'Book/Library/New',
    });
});

test('recovers a rename already completed in one Library root', () => {
    const plan = planLibraryFolderRename([
        state('Series/Library', 'missing', 'folder'),
        state('Book/Library', 'folder', 'missing'),
    ]);
    assert.equal(plan.ok, true);
    assert.deepEqual(plan.operations, [{
        oldPath: 'Book/Library/Old',
        newPath: 'Book/Library/New',
        action: 'rename',
    }]);
});

test('creates a missing category folder only after successful preflight', () => {
    const plan = planLibraryFolderRename([
        state('Series/Library', 'missing', 'missing'),
        state('Book/Library', 'folder', 'missing'),
    ]);
    assert.equal(plan.ok, true);
    assert.deepEqual(plan.operations.map(operation => operation.action), ['create', 'rename']);
});

test('removes category state when every folder alias is absent', () => {
    const missing = findLibraryCategoriesMissingFolders(
        {
            skills: ['Skills', '技能'],
            items: ['Items'],
            characters: ['Characters'],
        },
        ['Items', 'Characters'],
        ['characters'],
    );
    assert.deepEqual(missing, ['skills']);
});

test('keeps a category when any shared or local folder alias still exists', () => {
    const missing = findLibraryCategoriesMissingFolders(
        { skills: ['Skills', '技能'] },
        ['技能'],
    );
    assert.deepEqual(missing, []);
});

test('does not keep orphan Bases from an unreferenced custom definition', () => {
    const referenced = collectReferencedLibraryCategoryIds({
        alwaysCategoryIds: ['all', 'characters', 'locations'],
        optionalFixedCategoryIds: ['uncategorized'],
        hiddenFixedCategoryIds: ['uncategorized'],
        enabledCategoryIds: ['skills'],
        mappedCategoryIds: ['characters', 'locations', 'skills'],
    });
    assert.deepEqual(referenced, ['all', 'characters', 'locations', 'skills']);
    assert.equal(referenced.includes('items'), false);
    assert.equal(referenced.includes('uncategorized'), false);
});

test('adopting a Library folder does not resurrect a hidden or deleted category tab', () => {
    assert.equal(shouldEnableAdoptedLibraryCategory({
        alreadyEnabled: false,
        alreadyRegistered: true,
        deleted: false,
    }), false);
    assert.equal(shouldEnableAdoptedLibraryCategory({
        alreadyEnabled: true,
        alreadyRegistered: true,
        deleted: false,
    }), true);
    assert.equal(shouldEnableAdoptedLibraryCategory({
        alreadyEnabled: false,
        alreadyRegistered: false,
        deleted: false,
    }), true);
    assert.equal(shouldEnableAdoptedLibraryCategory({
        alreadyEnabled: false,
        alreadyRegistered: false,
        deleted: true,
    }), false);
    assert.equal(shouldEnableAdoptedLibraryCategory({
        alreadyEnabled: true,
        alreadyRegistered: true,
        deleted: true,
    }), false);
});
