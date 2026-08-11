import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import esbuild from 'esbuild';

const require = createRequire(import.meta.url);
const projectRoot = join(dirname(fileURLToPath(import.meta.url)), '..');

test('plotgrid xlsx codec preserves cell links via _nl_meta round-trip', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'nl-plotgrid-xlsx-'));
    const outfile = join(dir, 'codec.cjs');
    try {
        await esbuild.build({
            absWorkingDir: projectRoot,
            entryPoints: [join(projectRoot, 'services/PlotGridXlsxCodec.ts')],
            bundle: true,
            platform: 'node',
            format: 'cjs',
            outfile,
            logLevel: 'silent',
        });

        const codec = require(outfile);
        const doc = {
            version: 2,
            activePageId: 'page-1',
            sidebarCollapsed: false,
            pages: [{
                id: 'page-1',
                title: 'Act I',
                zoom: 1,
                stickyHeaders: true,
                rows: [
                    { id: 'r1', label: 'Scene 1', height: 40, bgColor: '', sourceType: 'auto', sourceId: 'Scenes/a.md' },
                ],
                columns: [
                    { id: 'c1', label: 'Hero', width: 120, bgColor: '', sourceType: 'auto', sourceId: 'Characters/hero.md' },
                ],
                cells: {
                    'r1-c1': {
                        id: 'r1-c1',
                        content: 'meets mentor',
                        bgColor: '',
                        textColor: '',
                        bold: false,
                        italic: false,
                        align: 'left',
                        linkedSceneId: 'Scenes/opening.md',
                        manualContent: true,
                    },
                },
            }],
        };

        const binary = await codec.encodePlotGridXlsx(doc);
        assert.ok(binary.byteLength > 100, 'xlsx should be non-trivial');

        const decoded = await codec.decodePlotGridXlsx(binary);
        assert.equal(decoded.pages.length, 1);
        assert.equal(decoded.pages[0].cells['r1-c1'].content, 'meets mentor');
        assert.equal(decoded.pages[0].cells['r1-c1'].linkedSceneId, 'Scenes/opening.md');
        assert.equal(decoded.pages[0].cells['r1-c1'].manualContent, true);
        assert.equal(decoded.pages[0].rows[0].sourceId, 'Scenes/a.md');
        assert.equal(decoded.pages[0].columns[0].sourceId, 'Characters/hero.md');

        // Univer merge must keep linkedSceneId while updating display text
        const merged = codec.mergeUniverCellDataIntoDocument(decoded, 'page-1', {
            0: { 0: { v: '' }, 1: { v: 'Hero' } },
            1: { 0: { v: 'Scene 1' }, 1: { v: 'updated text' } },
        });
        assert.equal(merged.pages[0].cells['r1-c1'].content, 'updated text');
        assert.equal(merged.pages[0].cells['r1-c1'].linkedSceneId, 'Scenes/opening.md');

        // Cleared cells omitted from sparse Univer snapshots must wipe content (keep links).
        const cleared = codec.mergeUniverCellDataIntoDocument(merged, 'page-1', {
            0: { 0: { v: '' }, 1: { v: 'Hero' } },
            1: { 0: { v: 'Scene 1' } },
        });
        assert.equal(cleared.pages[0].cells['r1-c1'].content, '');
        assert.equal(cleared.pages[0].cells['r1-c1'].linkedSceneId, 'Scenes/opening.md');

        // Empty reserved matrix must not expand row/col extents
        const same = codec.mergeUniverCellDataIntoDocument(decoded, 'page-1', {
            0: { 0: { v: '' }, 1: { v: 'Hero' } },
            1: { 0: { v: 'Scene 1' }, 1: { v: 'meets mentor' } },
            40: { 15: { v: '' } },
        });
        assert.equal(same.pages[0].rows.length, 1);
        assert.equal(same.pages[0].columns.length, 1);
    } finally {
        await rm(dir, { recursive: true, force: true });
    }
});

test('main prefers System/plotgrid.xlsx and migrates legacy PlotGrid folder', async () => {
    const mainTs = await readFile(new URL('../main.ts', import.meta.url), 'utf8');
    assert.match(mainTs, /plotGridXlsxPath/);
    assert.match(mainTs, /legacyPlotGridFolderXlsxPath|cleanupLegacyPlotGridArtifacts/);
    assert.match(mainTs, /encodePlotGridXlsx/);
    assert.match(mainTs, /decodePlotGridXlsx/);
    assert.match(mainTs, /\.bak`|jsonPath.*bak|rename\(jsonPath/);
    assert.match(mainTs, /writeVaultBinaryResilient/);
    assert.match(mainTs, /backupCorruptPlotGridXlsx|_invalidPlotGridXlsxPaths/);
    assert.match(mainTs, /__.+\\.csv\$/);
    assert.doesNotMatch(mainTs, /PlotGridCsvSync/);
});

test('PlotgridView lazy-loads Univer host and keeps note link actions', async () => {
    const view = await readFile(new URL('../views/PlotgridView.ts', import.meta.url), 'utf8');
    assert.match(view, /loadPlotGridUniverModule/);
    assert.match(view, /createPlotGridUniverHost/);
    assert.match(view, /getAuthoritativeDocument/);
    assert.match(view, /syncMeta/);
    assert.match(view, /univerMountGeneration/);
    assert.match(view, /Link Note…/);
    assert.match(view, /Unlink Note/);
    assert.match(view, /getActiveDataCellFromUniver/);
    assert.match(view, /univerHost\?\.dispose|disposeUniverHost/);
    assert.match(view, /allowEmptyOverwrite:\s*true/);
    assert.doesNotMatch(view, /openActivePageCsv|plotGridCsvSync|Open page CSV/);
    // Cross-project isolation: track System folder and abort mismatched autosaves
    assert.match(view, /loadedSystemFolder/);
    assert.match(view, /folderAtSchedule/);
    assert.match(view, /projectChanged/);
});
