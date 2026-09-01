import assert from 'node:assert/strict';
import test from 'node:test';
import { build } from 'esbuild';
import { readFile } from 'node:fs/promises';

const result = await build({
    entryPoints: ['./utils/fileExplorerVisibility.ts'],
    bundle: true,
    format: 'esm',
    platform: 'node',
    write: false,
});
const {
    shouldHideFileExplorerFile,
    shouldHideFileExplorerFolder,
} = await import(
    `data:text/javascript;base64,${Buffer.from(result.outputFiles[0].text).toString('base64')}`
);

const managedFolders = new Set([
    'novel/system',
    'novel/library',
    'novel/canvas',
    'series/library',
]);
const managedSeriesFiles = new Set(['series/series.json']);

test('only registered project System folders are hidden', () => {
    assert.equal(shouldHideFileExplorerFolder('System', undefined, managedFolders), false);
    assert.equal(shouldHideFileExplorerFolder('Novel/System', undefined, managedFolders), true);
    assert.equal(shouldHideFileExplorerFolder('Novel/system/', undefined, managedFolders), true);
    assert.equal(shouldHideFileExplorerFolder('Novel/Systems', undefined, managedFolders), false);
});

test('user-created root Library stays visible while managed Libraries are hidden', () => {
    assert.equal(shouldHideFileExplorerFolder('Library', undefined, managedFolders), false);
    assert.equal(shouldHideFileExplorerFolder('Novel/Library', undefined, managedFolders), true);
    assert.equal(shouldHideFileExplorerFolder('Series/library/', undefined, managedFolders), true);
    assert.equal(shouldHideFileExplorerFolder('Novel/Library Notes', undefined, managedFolders), false);
    assert.equal(shouldHideFileExplorerFolder('Novel/Libraries', undefined, managedFolders), false);
});

test('only registered project Canvas folders are hidden', () => {
    assert.equal(shouldHideFileExplorerFolder('Canvas', undefined, managedFolders), false);
    assert.equal(shouldHideFileExplorerFolder('Novel/Canvas', undefined, managedFolders), true);
    assert.equal(shouldHideFileExplorerFolder('Novel/canvas/', undefined, managedFolders), true);
    assert.equal(shouldHideFileExplorerFolder('Novel/Canvas Notes', undefined, managedFolders), false);
    assert.equal(shouldHideFileExplorerFolder('Novel/Canvases', undefined, managedFolders), false);
});

test('folder and file visibility rules can be enabled independently', () => {
    const rules = {
        systemFolder: false,
        libraryFolder: true,
        canvasFolder: false,
        seriesMetadata: false,
        unsupportedFiles: true,
    };
    assert.equal(shouldHideFileExplorerFolder('Novel/System', rules, managedFolders), false);
    assert.equal(shouldHideFileExplorerFolder('Novel/Library', rules, managedFolders), true);
    assert.equal(shouldHideFileExplorerFolder('Novel/Canvas', rules, managedFolders), false);
    assert.equal(shouldHideFileExplorerFile('Series/series.json', () => false, rules, managedSeriesFiles), false);
    assert.equal(shouldHideFileExplorerFile('Novel/export.docx', () => false, rules), true);
    assert.equal(shouldHideFileExplorerFile('Novel/chapter.md', () => true, rules), false);
});

test('only registered series metadata is hidden when JSON has a registered view', () => {
    assert.equal(shouldHideFileExplorerFile('series.json', () => true, undefined, managedSeriesFiles), false);
    assert.equal(shouldHideFileExplorerFile('Series/SERIES.JSON', () => true, undefined, managedSeriesFiles), true);
});

test('registered file types remain visible and unopenable types are hidden', () => {
    assert.equal(shouldHideFileExplorerFile('Novel/chapter.md', ext => ext === 'md'), false);
    assert.equal(shouldHideFileExplorerFile('Novel/export.docx', ext => ext === 'md'), true);
    assert.equal(shouldHideFileExplorerFile('Novel/no-extension', () => true), true);
});

test('NarrativeLab canvas formats remain visible in registry fallback mode', () => {
    assert.equal(shouldHideFileExplorerFile('Novel/board.ncanvas'), false);
    assert.equal(shouldHideFileExplorerFile('Novel/board.narrativecanvas'), false);
});

test('ribbon eye button toggles and persists all file explorer visibility rules', async () => {
    const mainTs = await readFile(new URL('../main.ts', import.meta.url), 'utf8');
    assert.match(mainTs, /fileExplorerVisibilityRibbonEl = this\.addRibbonIcon/);
    assert.match(mainTs, /t\('Show hidden project files'\)/);
    const toggle = mainTs.slice(
        mainTs.indexOf('private async toggleFileExplorerVisibility'),
        mainTs.indexOf('private observeFileExplorerVisibility'),
    );
    assert.match(toggle, /hideUnsupportedFilesInExplorer = !previous/);
    assert.match(toggle, /await this\.saveSettings\(\)/);
    assert.match(toggle, /this\.updateFileExplorerVisibility\(\)/);
    assert.match(toggle, /hideUnsupportedFilesInExplorer = previous/);
});

test('settings expose each file explorer visibility rule separately', async () => {
    const settings = await readFile(new URL('../settings.ts', import.meta.url), 'utf8');
    for (const key of [
        'hideSystemFolderInExplorer',
        'hideLibraryFolderInExplorer',
        'hideCanvasFolderInExplorer',
        'hideSeriesMetadataInExplorer',
        'hideUnopenableFilesInExplorer',
    ]) {
        assert.match(settings, new RegExp(`${key}: true`));
        assert.match(settings, new RegExp(`'${key}'`));
    }
    assert.match(settings, /Master switch for the rules below/);
});

test('new file-tree rows are hidden before the next paint', async () => {
    const [mainTs, styles] = await Promise.all([
        readFile(new URL('../main.ts', import.meta.url), 'utf8'),
        readFile(new URL('../styles.css', import.meta.url), 'utf8'),
    ]);
    const observer = mainTs.slice(
        mainTs.indexOf('private observeFileExplorerVisibility'),
        mainTs.indexOf('private enableNativeTooltipSuppression'),
    );
    assert.match(observer, /new MutationObserver\(mutations => \{/);
    assert.match(observer, /addedMutationRoots\(mutations\)/);
    assert.match(observer, /this\.updateFileExplorerVisibility\(roots\)/);
    assert.match(observer, /this\.observedFileExplorers\.has\(explorer\)/);
    assert.doesNotMatch(observer, /requestAnimationFrame|scheduleRefresh/);
    assert.doesNotMatch(mainTs, /fileExplorerVisibilityFrame/);
    assert.match(mainTs, /await this\.loadSettings\(\);\s*this\.updateFileExplorerVisibilityModeClass\(\)/);
    assert.match(mainTs, /sl-narrative-lab-hide-file-explorer-internals/);
    assert.match(mainTs, /fileExplorerVisibilityScope\(\)/);
    assert.match(mainTs, /scope\.folderPaths/);
    assert.match(mainTs, /scope\.seriesMetadataPaths/);
    assert.doesNotMatch(styles, /data-path="Library" i/);
    assert.doesNotMatch(styles, /data-path\$="\/Library" i/);
    assert.doesNotMatch(styles, /data-path="series\.json" i/);
    assert.match(styles, /sl-narrative-lab-hidden-file-tree-item/);
});
