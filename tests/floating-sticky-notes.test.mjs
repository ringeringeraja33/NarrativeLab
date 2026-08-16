import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { build } from 'esbuild';

const result = await build({
    entryPoints: ['utils/floatingStickyNote.ts'],
    bundle: true,
    format: 'esm',
    platform: 'node',
    write: false,
});
const source = result.outputFiles[0].text;
const {
    parseFloatingStickyNotes,
    hexToRgba,
    clampStickyNoteZoom,
    clampStickyNoteOpacity,
    staggerStickyNoteOrigin,
    nextStickyNoteColor,
    joinVaultMarkdownPath,
    shouldPromptStickyNoteClose,
    FLOATING_NOTES_FILENAME,
    FLOATING_NOTES_HIDDEN_CLASS,
    FLOATING_NOTE_CLASS,
} = await import(`data:text/javascript;base64,${Buffer.from(source).toString('base64')}`);

const [mainTs, settings, manager, noteUi, styles] = await Promise.all([
    readFile(new URL('../main.ts', import.meta.url), 'utf8'),
    readFile(new URL('../settings.ts', import.meta.url), 'utf8'),
    readFile(new URL('../services/FloatingStickyNoteManager.ts', import.meta.url), 'utf8'),
    readFile(new URL('../components/FloatingStickyNote.ts', import.meta.url), 'utf8'),
    readFile(new URL('../styles.css', import.meta.url), 'utf8'),
]);

test('parseFloatingStickyNotes drops invalid entries and keeps ids', () => {
    const notes = parseFloatingStickyNotes([
        { id: 'a1', top: '10px', left: '10px', width: '320px', height: '420px', color: '#FFF8CC', isEditing: true },
        { id: 12, top: '10px' },
        {},
        { id: 'b2', top: '20px', left: '20px', width: '200px', height: '200px', color: '#D8EAFD' },
    ]);
    assert.equal(notes.length, 2);
    assert.equal(notes[0].id, 'a1');
    assert.equal(notes[0].isEditing, true);
    assert.equal(notes[1].id, 'b2');
    assert.deepEqual(parseFloatingStickyNotes({}), []);
});

test('hex, zoom, opacity, stagger, and path helpers', () => {
    assert.equal(hexToRgba('#FFF8CC', 0.5), 'rgba(255, 248, 204, 0.5)');
    assert.equal(hexToRgba('abc', 1), 'rgba(170, 187, 204, 1)');
    assert.equal(clampStickyNoteZoom(9), 4);
    assert.equal(clampStickyNoteZoom(0.1), 0.5);
    assert.equal(clampStickyNoteOpacity(0.1), 0.4);
    assert.deepEqual(staggerStickyNoteOrigin(0), { top: '140px', left: '140px' });
    assert.deepEqual(staggerStickyNoteOrigin(2), { top: '196px', left: '196px' });
    assert.equal(joinVaultMarkdownPath('Notes', 'Idea'), 'Notes/Idea.md');
    assert.equal(joinVaultMarkdownPath('', 'Idea.md'), 'Idea.md');
    assert.deepEqual(
        nextStickyNoteColor([{ color: '#111111' }, { color: '#222222' }], 1),
        { color: '#222222', nextIndex: 0 },
    );
});

test('close prompt only for unsaved vault files or dirty linked files', () => {
    assert.equal(shouldPromptStickyNoteClose({ content: '', lastSavedContent: '' }), false);
    assert.equal(shouldPromptStickyNoteClose({ content: 'idea', lastSavedContent: '' }), true);
    assert.equal(shouldPromptStickyNoteClose({
        filePath: 'Notes/a.md',
        content: 'idea',
        lastSavedContent: 'idea',
    }), false);
    assert.equal(shouldPromptStickyNoteClose({
        filePath: 'Notes/a.md',
        content: 'idea!',
        lastSavedContent: 'idea',
    }), true);
});

test('plugin wires floating sticky notes like Web Novel Assistant', () => {
    assert.match(mainTs, /create-floating-sticky-note/);
    assert.match(mainTs, /toggle-floating-sticky-notes/);
    assert.match(mainTs, /this\.floatingStickyNotes\.restoreFloatingNotes\(\)/);
    assert.match(mainTs, /addRibbonIcon\('sticky-note'/);
    assert.match(settings, /showFloatingStickyNotes: boolean/);
    assert.match(settings, /floatingStickyNoteAutoSave: boolean/);
    assert.match(settings, /t\('Floating sticky notes'\)/);
    assert.match(manager, /FLOATING_NOTES_FILENAME/);
    assert.match(manager, /adapter\.write\(this\.getNotesFilePath\(\)/);
    assert.match(noteUi, /cls: `\$\{FLOATING_NOTE_CLASS\} story-line-floating-sticky-note`/);
    assert.match(noteUi, /MarkdownRenderer\.render/);
    assert.match(noteUi, /addDropdown/);
    assert.match(noteUi, /StickyNoteFolderSuggest/);
    assert.match(noteUi, /stickyNoteSaveFolderChoices/);
    assert.match(styles, /body\.narrativelab-floating-notes-hidden \.nl-floating-sticky-note/);
    assert.match(styles, /button\.nl-floating-sticky-btn:hover/);
    assert.match(styles, /background-color: rgba\(0, 0, 0, 0\.08\) !important/);
    assert.doesNotMatch(styles, /nl-floating-sticky-note:hover \{[^}]*background-color:\s*var\(--note-bg-color\)/);
    assert.equal(FLOATING_NOTES_FILENAME, 'floating-notes.json');
    assert.equal(FLOATING_NOTES_HIDDEN_CLASS, 'narrativelab-floating-notes-hidden');
    assert.equal(FLOATING_NOTE_CLASS, 'nl-floating-sticky-note');
});
