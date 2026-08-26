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

test('System folders are hidden by exact name at any depth', () => {
    assert.equal(shouldHideFileExplorerFolder('System'), true);
    assert.equal(shouldHideFileExplorerFolder('Novel/System'), true);
    assert.equal(shouldHideFileExplorerFolder('Novel/system/'), true);
    assert.equal(shouldHideFileExplorerFolder('Novel/Systems'), false);
});

test('Library folders are hidden by exact name at any depth', () => {
    assert.equal(shouldHideFileExplorerFolder('Library'), true);
    assert.equal(shouldHideFileExplorerFolder('Novel/Library'), true);
    assert.equal(shouldHideFileExplorerFolder('Series/library/'), true);
    assert.equal(shouldHideFileExplorerFolder('Novel/Library Notes'), false);
    assert.equal(shouldHideFileExplorerFolder('Novel/Libraries'), false);
});

test('Canvas folders are hidden by exact name at any depth', () => {
    assert.equal(shouldHideFileExplorerFolder('Canvas'), true);
    assert.equal(shouldHideFileExplorerFolder('Novel/Canvas'), true);
    assert.equal(shouldHideFileExplorerFolder('Novel/canvas/'), true);
    assert.equal(shouldHideFileExplorerFolder('Novel/Canvas Notes'), false);
    assert.equal(shouldHideFileExplorerFolder('Novel/Canvases'), false);
});

test('folder and file visibility rules can be enabled independently', () => {
    const rules = {
        systemFolder: false,
        libraryFolder: true,
        canvasFolder: false,
        seriesMetadata: false,
        unsupportedFiles: true,
    };
    assert.equal(shouldHideFileExplorerFolder('Novel/System', rules), false);
    assert.equal(shouldHideFileExplorerFolder('Novel/Library', rules), true);
    assert.equal(shouldHideFileExplorerFolder('Novel/Canvas', rules), false);
    assert.equal(shouldHideFileExplorerFile('Novel/series.json', () => false, rules), false);
    assert.equal(shouldHideFileExplorerFile('Novel/export.docx', () => false, rules), true);
    assert.equal(shouldHideFileExplorerFile('Novel/chapter.md', () => true, rules), false);
});

test('series.json is always hidden even when JSON has a registered view', () => {
    assert.equal(shouldHideFileExplorerFile('series.json', () => true), true);
    assert.equal(shouldHideFileExplorerFile('Novel/SERIES.JSON', () => true), true);
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
    assert.match(observer, /mutations\.some[\s\S]*?this\.updateFileExplorerVisibility\(\)/);
    assert.doesNotMatch(observer, /requestAnimationFrame|scheduleRefresh/);
    assert.doesNotMatch(mainTs, /fileExplorerVisibilityFrame/);
    assert.match(mainTs, /await this\.loadSettings\(\);\s*this\.updateFileExplorerVisibilityModeClass\(\)/);
    assert.match(mainTs, /sl-narrative-lab-hide-file-explorer-internals/);
    const classes = {
        System: 'sl-narrative-lab-hide-system-folder',
        Library: 'sl-narrative-lab-hide-library-folder',
        Canvas: 'sl-narrative-lab-hide-canvas-folder',
    };
    for (const [folder, className] of Object.entries(classes)) {
        assert.match(styles, new RegExp(`${className}[\\s\\S]*?nav-folder:has`));
        assert.match(styles, new RegExp(`data-path="${folder}" i`));
        assert.match(styles, new RegExp(`data-path\\$="/${folder}" i`));
    }
    assert.match(styles, /sl-narrative-lab-hide-series-metadata[\s\S]*?series\.json/);
    assert.match(styles, /data-path="series\.json" i/);
});
