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
                frozenColumns: 2,
                frozenRows: 3,
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
                        formula: '="meets mentor"',
                        bgColor: '#112233',
                        textColor: '#fefefe',
                        bold: true,
                        italic: true,
                        align: 'right',
                        linkedSceneId: 'Scenes/opening.md',
                        linkedViaWikilink: true,
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
        assert.equal(decoded.pages[0].cells['r1-c1'].formula, '="meets mentor"');
        assert.equal(decoded.pages[0].cells['r1-c1'].linkedSceneId, 'Scenes/opening.md');
        assert.equal(decoded.pages[0].cells['r1-c1'].linkedViaWikilink, true);
        assert.equal(decoded.pages[0].cells['r1-c1'].manualContent, true);
        assert.equal(decoded.pages[0].rows[0].sourceId, 'Scenes/a.md');
        assert.equal(decoded.pages[0].columns[0].sourceId, 'Characters/hero.md');

        const univer = codec.documentToUniverWorkbookData(decoded);
        const sheet = univer.sheets['page-1'];
        assert.deepEqual(sheet.freeze, { startRow: 3, startColumn: 2, ySplit: 3, xSplit: 2 });
        assert.equal(sheet.rowData[1].h, 40);
        assert.equal(sheet.columnData[1].w, 120);
        assert.equal(sheet.cellData[1][1].f, '="meets mentor"');
        assert.equal(sheet.cellData[1][1].v, 'meets mentor', 'native rich text must not alter workbook cell text');
        assert.equal(sheet.cellData[1][1].custom.narrativeLabSource, 'meets mentor');
        assert.equal(sheet.cellData[1][1].s.bg.rgb, '#112233');
        assert.equal(sheet.cellData[1][1].s.ht, 3);

        // Univer merge must keep linkedSceneId while updating display text
        const merged = codec.mergeUniverCellDataIntoDocument(decoded, 'page-1', {
            0: { 0: { v: '' }, 1: { v: 'Hero' } },
            1: { 0: { v: 'Scene 1' }, 1: { v: 'updated text', s: 'style-1' } },
        }, {
            'style-1': { bg: { rgb: '#abcdef' }, cl: { rgb: '#010203' }, bl: 0, it: 0, ht: 2 },
        }, {
            1: { h: 64 },
        }, {
            1: { w: 180 },
        });
        assert.equal(merged.pages[0].cells['r1-c1'].content, 'updated text');
        assert.equal(merged.pages[0].cells['r1-c1'].linkedSceneId, 'Scenes/opening.md');
        assert.equal(merged.pages[0].cells['r1-c1'].manualContent, true);
        assert.equal(merged.pages[0].cells['r1-c1'].bgColor, '#abcdef');

        const rich = codec.plotGridSourceToUniverRichText(
            '**Bold** [[Characters/Hero|Hero]] <em>italic</em>',
            '#765ac1',
        );
        assert.equal(rich.displayText, 'Bold Hero italic');
        assert.equal(rich.cellDocument.body.dataStream, 'Bold Hero italic\r\n');
        assert.ok(rich.cellDocument.body.textRuns.some(run => run.ts.bl === 1));
        assert.ok(rich.cellDocument.body.textRuns.some(run => run.ts.cl?.rgb === '#765ac1'));
        assert.ok(rich.cellDocument.body.textRuns.some(run => run.ts.it === 1));
        assert.equal(merged.pages[0].cells['r1-c1'].align, 'center');
        assert.equal(merged.pages[0].rows[0].height, 64);
        assert.equal(merged.pages[0].columns[0].width, 180);

        // Cleared cells omitted from sparse Univer snapshots must wipe content (keep links).
        const cleared = codec.mergeUniverCellDataIntoDocument(merged, 'page-1', {
            0: { 0: { v: '' }, 1: { v: 'Hero' } },
            1: { 0: { v: 'Scene 1' } },
        });
        assert.equal(cleared.pages[0].cells['r1-c1'].content, '');
        assert.equal(cleared.pages[0].cells['r1-c1'].formula, undefined);
        assert.equal(cleared.pages[0].cells['r1-c1'].linkedSceneId, 'Scenes/opening.md');

        // Empty reserved matrix must not expand row/col extents
        const same = codec.mergeUniverCellDataIntoDocument(decoded, 'page-1', {
            0: { 0: { v: '' }, 1: { v: 'Hero' } },
            1: { 0: { v: 'Scene 1' }, 1: { v: 'meets mentor' } },
            40: { 15: { v: '' } },
        });
        assert.equal(same.pages[0].rows.length, 1);
        assert.equal(same.pages[0].columns.length, 1);

        const reorderDoc = {
            version: 2,
            activePageId: 'page-1',
            pages: [{
                id: 'page-1', title: 'Reorder', zoom: 1, stickyHeaders: true,
                rows: [
                    { id: 'r1', label: 'R1', height: 30, bgColor: '' },
                    { id: 'r2', label: 'R2', height: 30, bgColor: '' },
                ],
                columns: [
                    { id: 'c1', label: 'C1', width: 100, bgColor: '' },
                    { id: 'c2', label: 'C2', width: 100, bgColor: '' },
                ],
                cells: {
                    'r1-c1': { id: 'r1-c1', content: 'A', bgColor: '', textColor: '', bold: false, italic: false, align: 'left', linkedSceneId: 'Notes/A.md' },
                    'r2-c2': { id: 'r2-c2', content: 'B', bgColor: '', textColor: '', bold: false, italic: false, align: 'left', linkedSceneId: 'Notes/B.md' },
                },
            }],
        };
        const rowsMoved = codec.moveConceptGridAxis(reorderDoc, 'page-1', 'rows', 1, 1, 3);
        assert.deepEqual(rowsMoved.pages[0].rows.map(row => row.id), ['r2', 'r1']);
        assert.equal(rowsMoved.pages[0].cells['r1-c1'].linkedSceneId, 'Notes/A.md');
        const columnsMoved = codec.moveConceptGridAxis(rowsMoved, 'page-1', 'columns', 1, 1, 3);
        assert.deepEqual(columnsMoved.pages[0].columns.map(column => column.id), ['c2', 'c1']);
        assert.equal(columnsMoved.pages[0].cells['r2-c2'].linkedSceneId, 'Notes/B.md');

        const normalizedIds = codec.mergeUniverCellDataIntoDocument({
            ...reorderDoc,
            pages: [{
                ...reorderDoc.pages[0],
                cells: {
                    'r1-c1': { ...reorderDoc.pages[0].cells['r1-c1'], id: 'legacy-mismatched-id' },
                },
            }],
        }, 'page-1', { 0: { 0: { v: '' } }, 1: { 1: { v: 'Updated' } } });
        assert.equal(normalizedIds.pages[0].cells['r1-c1'].id, 'r1-c1');
        assert.equal(normalizedIds.pages[0].cells['r1-c1'].content, 'Updated');
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

test('PlotgridView lazy-loads Univer host and edits links as Markdown text', async () => {
    const view = await readFile(new URL('../views/PlotgridView.ts', import.meta.url), 'utf8');
    assert.match(view, /loadPlotGridUniverModule/);
    assert.match(view, /createPlotGridUniverHost/);
    assert.match(view, /getAuthoritativeDocument/);
    assert.match(view, /syncMeta/);
    assert.match(view, /univerMountGeneration/);
    assert.match(view, /Remove wikilinks/);
    assert.match(view, /Insert wikilink/);
    assert.match(view, /openCellMarkdownEditor/);
    assert.match(view, /new WikilinkSuggest/);
    assert.doesNotMatch(view, /openNoteLinkModal|openSceneLinkModal/);
    assert.match(view, /getActiveDataCellFromUniver/);
    assert.match(view, /handleUniverContextMenuAction/);
    assert.match(view, /synchronizeWikilinkCells/);
    assert.match(view, /getFirstLinkpathDest/);
    assert.match(view, /linkedViaWikilink/);
    assert.doesNotMatch(view, /bindUniverContextMenu/);
    assert.match(view, /applyUniverViewState/);
    assert.match(view, /renderGrid\(\{ forcePush: true \}\)/);
    assert.match(view, /Query Univer first/);
    assert.match(view, /const dataRow = Math\.max\(1, sel\.row\)/);
    assert.match(view, /const dataCol = Math\.max\(1, sel\.col\)/);
    assert.match(view, /setActiveCell\(sel\.sheetId, dataRow, dataCol\)/);
    assert.doesNotMatch(view, /new FiltersComponent\(/);
    assert.doesNotMatch(view, /obsidian\.setIcon\(addRowBtn, 'rows-3'\)/);
    assert.doesNotMatch(view, /obsidian\.setIcon\(addColBtn, 'columns-3'\)/);
    assert.doesNotMatch(view, /autosizeCellsToContent|autoFitRows|plotgridAutoNote/);
    assert.doesNotMatch(view, /openManageSnapshotsModal|Manage View Snapshots/);
    assert.doesNotMatch(view, /Sync from Scenes|openSyncModal|performSync/);
    assert.match(view, /univerHost\?\.dispose|disposeUniverHost/);
    assert.match(view, /allowEmptyOverwrite:\s*true/);
    assert.doesNotMatch(view, /openActivePageCsv|plotGridCsvSync|Open page CSV/);
    // Cross-project isolation: track System folder and abort mismatched autosaves
    assert.match(view, /loadedSystemFolder/);
    assert.match(view, /folderAtSchedule/);
    assert.match(view, /projectChanged/);
});

test('wikilink suggestions follow the textarea caret inside editor modals', async () => {
    const suggest = await readFile(new URL('../components/WikilinkSuggest.ts', import.meta.url), 'utf8');
    assert.match(suggest, /getTextareaCaretRect/);
    assert.match(suggest, /selectionStart/);
    assert.match(suggest, /markerRect\.top - textarea\.scrollTop/);
    assert.match(suggest, /closest\('\.modal'\)/);
    assert.match(suggest, /openAbove/);
    assert.doesNotMatch(suggest, /top:\s*`\$\{Math\.round\(rect\.bottom/);
});

test('embedded Univer host exposes the legacy grid view controls', async () => {
    const host = await readFile(new URL('../services/PlotGridUniverHost.ts', import.meta.url), 'utf8');
    for (const method of ['setZoom', 'setFreeze', 'setActiveCell']) {
        assert.match(host, new RegExp(`${method}:`));
    }
    assert.doesNotMatch(host, /setHiddenRows|showRows|hideRows/);
    assert.doesNotMatch(host, /setRowAutoHeight|autoFitRows/);
    assert.match(host, /getActiveCell\?\./);
    assert.match(host, /getRow\?\.\(\)/);
    assert.match(host, /getColumn\?\.\(\)/);
    assert.equal((host.match(/contextMenu:\s*true/g) || []).length, 2);
    assert.match(host, /registerNarrativeLabContextMenu/);
    assert.match(host, /new Menu\(\)/);
    assert.match(host, /showAtPosition\(menuPosition\)/);
    assert.match(host, /removeEventListener\('contextmenu'/);
    assert.doesNotMatch(host, /createSubmenu\(/);
    assert.match(host, /contextMenu\.mainArea/);
    assert.match(host, /contextMenu\.others/);
    assert.match(host, /CellPointerDown/);
    assert.match(host, /applyDimensionMutation/);
    assert.match(host, /applyAxisMoveMutation/);
    assert.match(host, /sheet\.mutation\.move-rows/);
    assert.match(host, /sheet\.mutation\.move-columns/);
    assert.match(host, /sheet\.mutation\.set-worksheet-row-height/);
    assert.match(host, /sheet\.mutation\.set-worksheet-col-width/);
    assert.match(host, /event\?\.metaKey \|\| event\?\.ctrlKey/);
    assert.match(host, /p\.column \?\? p\.col/);
    assert.match(host, /UniverSheetsFilterPreset\(\)/);
    assert.doesNotMatch(host, /onCellRender/);
    assert.doesNotMatch(host, /refreshLinkMarkers/);
    assert.equal((host.match(/toolbar:\s*true/g) || []).length, 2);
    assert.equal((host.match(/formulaBar:\s*true/g) || []).length, 2);
    assert.match(host, /createNativeWorkbook\(liveDoc\)/);
    assert.match(host, /richText:\s*false/);
    assert.match(host, /retrying with native plain cells/);
    assert.match(host, /--link-color/);
    assert.doesNotMatch(host, /fillRect\(/);
    assert.doesNotMatch(host, /🔗/);
    assert.match(host, /mergeLocales\(sheetsCoreZhCN, sheetsFilterZhCN\)/);
    assert.equal((host.match(/ribbonType:\s*'simple'/g) || []).length, 2);
    assert.doesNotMatch(host, /contextMenu:\s*false/);
    assert.match(host, /moveFinancialFormulaMenuLast/);
    assert.match(host, /addUniverSubscriptionDisposer/);
    assert.match(host, /univerAPI\.removeEvent\?\./);
    assert.doesNotMatch(host, /suppressWatcher/);
    assert.match(host, /scheduleSuppressedDrain/);
    assert.match(host, /`\$\{InsertFunctionOperation\.id\}\.financial`/);
    assert.match(host, /FINANCIAL_FORMULA_MENU_ORDER\s*=\s*99/);
    assert.match(host, /\[TEXT_TO_NUMBER_TOOLBAR_MENU_ID\]:\s*\{\s*hidden:\s*true\s*\}/);
    const view = await readFile(new URL('../views/PlotgridView.ts', import.meta.url), 'utf8');
    assert.doesNotMatch(view, /resolveLinkedLabel/);
    assert.doesNotMatch(view, /falling back to DOM grid/);
    assert.match(view, /renderUniverLoadError/);
    assert.match(view, /Plot Grid autosave failed/);
    assert.match(view, /finally \{[\s\S]*?this\.saveDebounce === timerId/);
    assert.match(view, /this\.disposeUniverHost\(\);[\s\S]*?this\.cancelPendingSave\(\);/);
});
