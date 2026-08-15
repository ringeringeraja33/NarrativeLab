import assert from 'node:assert/strict';
import test from 'node:test';
import { build } from 'esbuild';

const result = await build({
    entryPoints: ['utils/conceptGridSheetName.ts'],
    bundle: true,
    format: 'esm',
    platform: 'node',
    write: false,
});
const source = result.outputFiles[0].text;
const {
    CONCEPT_GRID_SHEET_NAME_FORBIDDEN,
    CONCEPT_GRID_SHEET_NAME_MAX_LENGTH,
    validateConceptGridSheetName,
} = await import(`data:text/javascript;base64,${Buffer.from(source).toString('base64')}`);

test('accepts a unique worksheet name', () => {
    assert.equal(
        validateConceptGridSheetName('Act I', { existingTitles: ['Page 1'], currentTitle: 'Page 1' }),
        null,
    );
});

test('keeps the current name without treating it as a duplicate', () => {
    assert.equal(
        validateConceptGridSheetName('页面 3', { existingTitles: ['页面 3', '页面 4'], currentTitle: '页面 3' }),
        null,
    );
});

test('rejects empty, duplicate, forbidden, and oversized names', () => {
    assert.equal(
        validateConceptGridSheetName('   ', { existingTitles: [] }),
        'Sheet name cannot be empty.',
    );
    assert.equal(
        validateConceptGridSheetName('页面 3', { existingTitles: ['页面 3'], currentTitle: '页面 4' }),
        'A sheet with this name already exists.',
    );
    assert.equal(
        validateConceptGridSheetName('Act/I', { existingTitles: [] }),
        'Sheet names cannot contain: {chars}',
    );
    assert.ok(CONCEPT_GRID_SHEET_NAME_FORBIDDEN.includes('/'));
    assert.equal(
        validateConceptGridSheetName('x'.repeat(CONCEPT_GRID_SHEET_NAME_MAX_LENGTH + 1), { existingTitles: [] }),
        'Sheet name is too long.',
    );
});
