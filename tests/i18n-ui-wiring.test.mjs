import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const [
    codexView,
    inspector,
    customSections,
    wikilink,
    filters,
    boardView,
    researchView,
    characterView,
    locationView,
    i18nExtra,
    libraryCategorySync,
    settings,
    styles,
] = await Promise.all([
    readFile(new URL('../views/CodexView.ts', import.meta.url), 'utf8'),
    readFile(new URL('../components/Inspector.ts', import.meta.url), 'utf8'),
    readFile(new URL('../components/CustomSectionsRenderer.ts', import.meta.url), 'utf8'),
    readFile(new URL('../components/WikilinkSuggest.ts', import.meta.url), 'utf8'),
    readFile(new URL('../components/Filters.ts', import.meta.url), 'utf8'),
    readFile(new URL('../views/BoardView.ts', import.meta.url), 'utf8'),
    readFile(new URL('../views/ResearchView.ts', import.meta.url), 'utf8'),
    readFile(new URL('../views/CharacterView.ts', import.meta.url), 'utf8'),
    readFile(new URL('../views/LocationView.ts', import.meta.url), 'utf8'),
    readFile(new URL('../utils/i18n-extra.zh.ts', import.meta.url), 'utf8'),
    readFile(new URL('../services/LibraryCategorySync.ts', import.meta.url), 'utf8'),
    readFile(new URL('../settings.ts', import.meta.url), 'utf8'),
    readFile(new URL('../styles.css', import.meta.url), 'utf8'),
]);

test('built-in schema chrome goes through t(); player-authored labels stay verbatim', () => {
    // Built-in Codex section titles (from schema English keys)
    assert.match(codexView, /codex-section-title profile-section-title',\s*text:\s*t\(cat\.title\)/);
    assert.match(codexView, /text:\s*t\(catDef\.label\)\.replace/);
    // Built-in field rows still translate schema keys
    assert.match(codexView, /const displayLabel = t\(label\);/);

    // Player-authored universal / custom labels must NOT be wrapped in t()
    assert.match(codexView, /codex-field-label',\s*text:\s*tpl\.label\s*\}/);
    assert.doesNotMatch(codexView, /codex-field-label',\s*text:\s*t\(tpl\.label\)/);
    assert.match(inspector, /inspector-label',\s*text:\s*tpl\.label\s*\}/);
    assert.match(characterView, /character-field-label',\s*text:\s*tpl\.label\s*\}/);
    assert.match(locationView, /location-field-label',\s*text:\s*tpl\.label\s*\}/);
    assert.match(customSections, /text:\s*sec\.title\s*\}/);
    assert.match(customSections, /text:\s*fname\s*\}/);
    assert.doesNotMatch(customSections, /text:\s*t\(sec\.title\)/);
    assert.doesNotMatch(customSections, /text:\s*t\(fname\)/);
    // Only the empty-placeholder chrome fallback is translated
    assert.match(customSections, /t\('Value for \{field\}'/);
});

test('Library tab defaults use t(); explicit renames stay verbatim', () => {
    const fn = libraryCategorySync.slice(
        libraryCategorySync.indexOf('export function resolveLibraryCategoryLabel'),
        libraryCategorySync.indexOf('function setLibraryCategoryDisplayMetadata'),
    );
    assert.match(fn, /return t\(english\);/);
    assert.match(fn, /return customLabel;/);
    assert.match(fn, /return projectFolder;/);
});

test('chrome-only UI strings still use t()', () => {
    assert.match(inspector, /text:\s*t\(cfg\.label\)/);
    assert.match(inspector, /t\(catDef\.label\)\}:`/);
    assert.match(wikilink, /setPlaceholder\(t\('Search notes…'\)\)/);
    assert.match(i18nExtra, /'Search notes…':\s*'搜索笔记…'/);
    assert.match(researchView, /t\(RESEARCH_TYPE_CONFIG\[rtype\]\.label\)/);
    assert.match(boardView, /label:\s*t\('Act'\)/);
    // Scene custom-field group labels are player-authored
    assert.match(boardView, /label:\s*tpl\.label\s*\}/);
    assert.match(filters, /text:\s*tpl\.label\s*\}/);
});

test('settings collapsibles share one framed section component', () => {
    for (const label of ['Image & frame sizes', 'Focus Mode Settings', 'Timeline Drag-Scroll']) {
        assert.match(
            settings,
            new RegExp(`createEl\\('details', \\{ cls: 'story-line-color-section' \\}\\);[\\s\\S]{0,160}summary', \\{ text: t\\('${label.replace(/[.*+?^${}()|[\\]\\]/g, '\\$&')}'\\)`),
        );
    }
    assert.doesNotMatch(settings, /story-line-timeline-scroll-section/);
    assert.match(styles, /\.story-line-color-section\s*\{[^}]*border:[^;]+;[^}]*border-radius:/s);
});
