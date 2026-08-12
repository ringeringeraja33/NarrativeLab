import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import esbuild from 'esbuild';

const require = createRequire(import.meta.url);
const ExcelJS = require('exceljs');
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
                    { id: 'c2', label: 'Character', width: 120, bgColor: '' },
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
                    'r1-c2': {
                        id: 'r1-c2',
                        content: '[[Characters/Falcon|游隼]]',
                        bgColor: '',
                        textColor: '',
                        bold: false,
                        italic: false,
                        align: 'left',
                        linkedSceneId: 'Characters/Falcon.md',
                        linkedViaWikilink: true,
                        manualContent: true,
                    },
                },
            }],
        };

        const binary = await codec.encodePlotGridXlsx(doc, { vaultName: 'Narrative Lab' });
        assert.ok(binary.byteLength > 100, 'xlsx should be non-trivial');

        const workbook = new ExcelJS.Workbook();
        await workbook.xlsx.load(binary);
        // Clean interop xlsx: Excel/Univer must not see an embedded meta sheet.
        assert.equal(workbook.getWorksheet('_nl_meta'), undefined);
        const nativeLink = workbook.getWorksheet('Act I').getCell(2, 3).value;
        assert.equal(nativeLink.text, '游隼');
        assert.equal(nativeLink.hyperlink, 'obsidian://open?vault=Narrative%20Lab&file=Characters%2FFalcon.md');
        assert.equal(workbook.getWorksheet('Act I').getCell(2, 3).font.underline, true);
        assert.equal(workbook.getWorksheet('Act I').getCell(2, 2).value.formula, '"meets mentor"', 'real formulas must win over hyperlinks');

        const sidecarMeta = codec.buildNlMetaForDocument(doc);
        assert.equal(sidecarMeta.schema, 2);
        assert.equal(sidecarMeta.pages['page-1'].cells['r1-c1'].content, 'meets mentor');

        const decoded = await codec.decodePlotGridXlsx(binary, { meta: sidecarMeta });
        assert.equal(decoded.pages.length, 1);
        assert.equal(decoded.pages[0].cells['r1-c1'].content, 'meets mentor');
        assert.equal(decoded.pages[0].cells['r1-c1'].formula, '="meets mentor"');
        assert.equal(decoded.pages[0].cells['r1-c1'].linkedSceneId, 'Scenes/opening.md');
        assert.equal(decoded.pages[0].cells['r1-c1'].linkedViaWikilink, true);
        assert.equal(decoded.pages[0].cells['r1-c1'].manualContent, true);
        assert.equal(decoded.pages[0].cells['r1-c2'].content, '[[Characters/Falcon|游隼]]');
        assert.equal(decoded.pages[0].cells['r1-c2'].linkedSceneId, 'Characters/Falcon.md');
        assert.equal(decoded.pages[0].cells['r1-c2'].linkedViaWikilink, true);
        assert.equal(decoded.pages[0].rows[0].sourceId, 'Scenes/a.md');
        assert.equal(decoded.pages[0].columns[0].sourceId, 'Characters/hero.md');
        assert.equal(decoded.pages[0].cells['r1-c1'].content, 'meets mentor');

        // Legacy single-file embed still round-trips when requested.
        const legacyBinary = await codec.encodePlotGridXlsx(doc, { embedMetaSheet: true });
        const legacyBook = new ExcelJS.Workbook();
        await legacyBook.xlsx.load(legacyBinary);
        const metaSheet = legacyBook.getWorksheet('_nl_meta');
        assert.ok(metaSheet);
        const embeddedMeta = JSON.parse(codec.readChunkedMetaText(metaSheet));
        assert.equal(embeddedMeta.schema, 2);

        // Simulate Univer opening datasheet.xlsx and leaving only meta JSON in a
        // sheet named "datasheet" (real page sheets gone).
        const ruined = new ExcelJS.Workbook();
        const dump = ruined.addWorksheet('datasheet');
        codec.writeChunkedMetaText(dump, JSON.stringify(sidecarMeta));
        ruined.addWorksheet('references');
        const ruinedBin = await ruined.xlsx.writeBuffer();
        assert.equal(await codec.plotGridXlsxNeedsRewrite(ruinedBin), true);
        const fromDump = await codec.decodePlotGridXlsx(ruinedBin);
        assert.equal(fromDump.pages.length, 1);
        assert.equal(fromDump.pages[0].title, 'Act I');
        assert.equal(fromDump.pages[0].cells['r1-c1'].content, 'meets mentor');
        assert.equal(fromDump.pages[0].cells['r1-c2'].content, '[[Characters/Falcon|游隼]]');

        // A normal Excel file without NarrativeLab metadata can still recover
        // Obsidian links from the native cell hyperlink.
        const withoutMeta = await workbook.xlsx.writeBuffer();
        const recovered = await codec.decodePlotGridXlsx(withoutMeta);
        const recoveredLink = Object.values(recovered.pages[0].cells)
            .find(cell => cell.linkedSceneId === 'Characters/Falcon.md');
        assert.ok(recoveredLink);
        assert.equal(recoveredLink.content, '[[Characters/Falcon|游隼]]');
        assert.equal(recoveredLink.linkedViaWikilink, true);

        const univer = codec.documentToUniverWorkbookData(decoded);
        const sheet = univer.sheets['page-1'];
        assert.deepEqual(sheet.freeze, { startRow: 3, startColumn: 2, ySplit: 3, xSplit: 2 });
        assert.equal(sheet.rowData[1].h, 40);
        assert.equal(sheet.rowData[1].ia, 0, 'manual row height must disable Univer auto-height');
        assert.equal(sheet.columnData[1].w, 120);

        decoded.pages[0].headerRowHeight = 44;
        decoded.pages[0].labelColumnWidth = 96;
        const axisWorkbook = codec.documentToUniverWorkbookData(decoded);
        const axisSheet = Object.values(axisWorkbook.sheets)[0];
        assert.equal(axisSheet.rowData[0].h, 44);
        assert.equal(axisSheet.rowData[0].ia, 0);
        assert.equal(axisSheet.columnData[0].w, 96);

        const axisMerged = codec.mergeUniverCellDataIntoDocument(structuredClone(decoded), 'page-1', {
            0: { 0: { v: 'agent num' }, 1: { v: 'Hero' } },
            1: { 0: { v: 'Scene 1' }, 1: { v: 'ok' } },
        }, undefined, {
            0: { h: 52 },
            1: { h: 40 },
        }, {
            0: { w: 110 },
            1: { w: 120 },
        });
        assert.equal(axisMerged.pages[0].headerRowHeight, 52);
        assert.equal(axisMerged.pages[0].labelColumnWidth, 110);
        assert.match(
            codec.conceptGridContentFingerprint(axisMerged),
            /headerH:52/,
        );
        assert.match(
            codec.conceptGridContentFingerprint(axisMerged),
            /labelW:110/,
        );
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

        // Header / corner edits often land in Univer rich-text `p` (not plain `v`).
        const headerRich = codec.mergeUniverCellDataIntoDocument(structuredClone(decoded), 'page-1', {
            0: {
                0: { p: { body: { dataStream: 'Corner\r\n' } } },
                1: { p: { body: { dataStream: 'Heroine\r\n' } }, s: { bg: { rgb: '#ffcc00' }, bl: 1 } },
            },
            1: {
                0: { p: { body: { dataStream: 'Act I\r\n' } }, s: { cl: { rgb: '#112233' }, it: 1 } },
                1: { v: 'meets mentor' },
            },
        });
        assert.equal(headerRich.pages[0].cornerLabel, 'Corner');
        assert.equal(headerRich.pages[0].columns[0].label, 'Heroine');
        assert.equal(headerRich.pages[0].columns[0].headerBgColor, '#ffcc00');
        assert.equal(headerRich.pages[0].columns[0].bold, true);
        assert.equal(headerRich.pages[0].rows[0].label, 'Act I');
        assert.equal(headerRich.pages[0].rows[0].textColor, '#112233');
        assert.equal(headerRich.pages[0].rows[0].italic, true);
        assert.match(
            codec.conceptGridContentFingerprint(headerRich),
            /corner:Corner/,
            'corner edits must dirty the content fingerprint so autosave runs',
        );
        headerRich.pages[0].columns[0].width = 240;
        headerRich.pages[0].rows[0].height = 48;
        assert.match(
            codec.conceptGridContentFingerprint(headerRich),
            /:240:/,
            'column width must dirty the content fingerprint so resize autosave runs',
        );
        assert.match(
            codec.conceptGridContentFingerprint(headerRich),
            /:48:/,
            'row height must dirty the content fingerprint so resize autosave runs',
        );

        const sized = structuredClone(headerRich);
        sized.pages[0].columns[0].width = 120;
        sized.pages[0].rows[0].height = 32;
        codec.preserveConceptGridAxisSizes(sized, headerRich);
        assert.equal(sized.pages[0].columns[0].width, 240);
        assert.equal(sized.pages[0].rows[0].height, 48);

        // Cleared cells omitted from sparse Univer snapshots wipe content only when
        // clearMissing is opted in (after the cell editor has closed).
        const kept = codec.mergeUniverCellDataIntoDocument(merged, 'page-1', {
            0: { 0: { v: '' }, 1: { v: 'Hero' } },
            1: { 0: { v: 'Scene 1' } },
        });
        assert.equal(kept.pages[0].cells['r1-c1'].content, 'updated text', 'polling must not clear omitted cells');
        const cleared = codec.mergeUniverCellDataIntoDocument(merged, 'page-1', {
            0: { 0: { v: '' }, 1: { v: 'Hero' } },
            1: { 0: { v: 'Scene 1' } },
        }, undefined, undefined, undefined, { clearMissing: true });
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
        assert.equal(same.pages[0].columns.length, 2);

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

test('plotgrid xlsx codec chunks oversized _nl_meta under Excel cell limit', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'nl-plotgrid-xlsx-meta-'));
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
        const fatNote = 'x'.repeat(4000);
        const cells = {};
        for (let i = 0; i < 12; i++) {
            const key = `r1-c${i}`;
            cells[key] = {
                id: key,
                content: `[[Library/Note${i}|${fatNote}]]`,
                bgColor: '',
                textColor: '',
                bold: false,
                italic: false,
                align: 'left',
                linkedSceneId: `Library/Note${i}.md`,
                linkedViaWikilink: true,
                manualContent: true,
                markdownSource: `[[Library/Note${i}|${fatNote}]]`,
            };
        }
        const columns = Array.from({ length: 12 }, (_, i) => ({
            id: `c${i}`,
            label: `Col ${i}`,
            width: 120,
            bgColor: '',
            sourceType: 'auto',
            sourceId: `Library/Col${i}.md`,
        }));
        const doc = {
            version: 2,
            activePageId: 'page-1',
            sidebarCollapsed: false,
            pages: [{
                id: 'page-1',
                title: 'Fat Meta',
                zoom: 1,
                stickyHeaders: true,
                rows: [{ id: 'r1', label: 'Row', height: 32, bgColor: '', sourceType: 'manual' }],
                columns,
                cells,
            }],
        };

        const binary = await codec.encodePlotGridXlsx(doc, { embedMetaSheet: true });
        const workbook = new ExcelJS.Workbook();
        await workbook.xlsx.load(binary);
        const metaSheet = workbook.getWorksheet('_nl_meta');
        assert.ok(metaSheet);
        let maxCell = 0;
        let joined = '';
        for (let row = 1; row <= Math.max(metaSheet.rowCount, 1); row++) {
            const text = metaSheet.getCell(row, 1).value;
            if (typeof text !== 'string' || !text) break;
            maxCell = Math.max(maxCell, text.length);
            joined += text;
        }
        assert.ok(joined.length > codec.EXCEL_MAX_CELL_CHARS, 'fixture must exceed Excel cell limit');
        assert.ok(maxCell <= codec.EXCEL_MAX_CELL_CHARS, `meta chunk ${maxCell} must stay <= ${codec.EXCEL_MAX_CELL_CHARS}`);
        assert.equal(metaSheet.getCell(2, 1).value?.length > 0, true, 'meta must span multiple cells');

        const decoded = await codec.decodePlotGridXlsx(binary);
        assert.equal(decoded.pages[0].cells['r1-c0'].linkedSceneId, 'Library/Note0.md');
        assert.equal(decoded.pages[0].cells['r1-c11'].linkedSceneId, 'Library/Note11.md');
        assert.match(decoded.pages[0].cells['r1-c0'].content, /Library\/Note0/);
    } finally {
        await rm(dir, { recursive: true, force: true });
    }
});

test('main prefers Library/datasheet.xlsx and migrates legacy System plotgrid', async () => {
    const mainTs = await readFile(new URL('../main.ts', import.meta.url), 'utf8');
    assert.match(mainTs, /plotGridXlsxPath/);
    assert.match(mainTs, /plotGridNlMetaPath/);
    assert.match(mainTs, /legacyLibraryPlotGridNlMetaPath/);
    assert.match(mainTs, /serializePlotGridNlMeta/);
    assert.match(mainTs, /System\/datasheet\.nlmeta\.json|datasheet\.nlmeta\.json/);
    assert.match(mainTs, /legacySystemPlotGridXlsxPath/);
    assert.match(mainTs, /legacyPlotGridFolderXlsxPath|cleanupLegacyPlotGridArtifacts/);
    assert.match(mainTs, /getProjectLibraryFolder/);
    assert.match(mainTs, /migratePlotGridToLibraryIfNeeded/);
    assert.match(mainTs, /Library\/datasheet\.xlsx|datasheet\.xlsx/);
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
    assert.match(view, /onContextMenuRequest/);
    assert.match(view, /getAuthoritativeDocument/);
    assert.match(view, /syncMeta/);
    assert.match(view, /univerMountGeneration/);
    assert.match(view, /openCellMarkdownEditor/);
    assert.match(view, /cellEditorWindows/);
    assert.match(view, /Always on top/);
    assert.doesNotMatch(view, /Replace any existing floating cell editor/);
    assert.doesNotMatch(view, /is-pinned-top/);
    assert.match(view, /Open cell editor/);
    assert.doesNotMatch(view, /toggleWikilinkForActiveCell/);
    assert.match(view, /appendChild\(trailingActions\)/);
    assert.doesNotMatch(view, /const syncSep/);
    assert.match(view, /new WikilinkSuggest/);
    assert.match(view, /workspace\.openLinkText/);
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
    assert.match(view, /sel\.row < 1 \|\| sel\.col < 1/);
    assert.doesNotMatch(view, /setActiveCell\(sel\.sheetId, dataRow, dataCol\)/);
    assert.match(view, /scheduleSave\(\)/);
    assert.match(view, /info\.sheetId !== this\.document\.activePageId/);
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

test('lazy Univer host receives Obsidian UI through the main bundle', async () => {
    const host = await readFile(new URL('../services/PlotGridUniverHost.ts', import.meta.url), 'utf8');
    assert.doesNotMatch(host, /from ['"]obsidian['"]/);
    assert.match(host, /onContextMenuRequest/);
    assert.match(host, /event\?\.detail/);
});

test('wikilink suggestions follow the textarea caret inside editor modals', async () => {
    const suggest = await readFile(new URL('../components/WikilinkSuggest.ts', import.meta.url), 'utf8');
    assert.match(suggest, /getTextareaCaretRect/);
    assert.match(suggest, /selectionStart/);
    assert.match(suggest, /mirror\.scrollTop = textarea\.scrollTop/);
    assert.match(suggest, /plot-grid-cell-editor-window/);
    assert.match(suggest, /resolveDropdownZIndex/);
    assert.match(suggest, /2147483000/);
    assert.match(suggest, /refresh\(\)/);
    assert.match(suggest, /openAbove/);
    assert.doesNotMatch(suggest, /markerRect\.top - textarea\.scrollTop/);
    assert.doesNotMatch(suggest, /zIndex:\s*'9999'/);
    assert.doesNotMatch(suggest, /top:\s*`\$\{Math\.round\(rect\.bottom/);
});

test('embedded Univer host exposes the legacy grid view controls', async () => {
    const host = await readFile(new URL('../services/PlotGridUniverHost.ts', import.meta.url), 'utf8');
    const view = await readFile(new URL('../views/PlotgridView.ts', import.meta.url), 'utf8');
    const codecSrc = await readFile(new URL('../services/PlotGridXlsxCodec.ts', import.meta.url), 'utf8');
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
    assert.match(host, /onContextMenuRequest/);
    assert.match(view, /new Menu\(\)/);
    assert.match(view, /showAtPosition\(position\)/);
    assert.match(host, /removeEventListener\('contextmenu'/);
    assert.doesNotMatch(host, /title:\s*'NarrativeLab'/);
    assert.doesNotMatch(host, /createSubmenu\(\{\s*id:\s*'narrativelab\.plot-grid\.submenu'/);
    assert.match(host, /已连接笔记|Connected notes/);
    assert.match(host, /onShowConnectedNotes/);
    assert.doesNotMatch(host, /打开已链接笔记/);
    assert.match(view, /collectConnectedNotes|showConnectedNotesMenu/);
    assert.match(host, /contextMenu\.mainArea/);
    assert.match(host, /contextMenu\.others/);
    assert.match(host, /CellPointerDown/);
    assert.match(host, /NarrativeLab owns page titles|Do not overwrite NL titles/);
    assert.match(host, /setSheetTitle/);
    assert.doesNotMatch(host, /page\.title = sheetName/);
    assert.match(view, /setSheetTitle/);
    assert.match(view, /beginInlinePageRename|concept-grid-page-tab-rename/);
    assert.match(host, /headerRowHeight/);
    assert.match(host, /labelColumnWidth/);
    assert.match(host, /worksheetRow === 0/);
    assert.match(host, /worksheetColumn === 0/);
    assert.match(codecSrc, /headerRowHeight/);
    assert.match(codecSrc, /labelColumnWidth/);
    assert.match(codecSrc, /rowData\[0\]/);
    assert.match(codecSrc, /columnData\[0\]/);
    assert.match(host, /applyAxisMoveMutation/);
    assert.match(host, /sheet\.mutation\.move-rows/);
    assert.match(host, /sheet\.mutation\.move-columns/);
    assert.match(host, /sheet\.mutation\.set-worksheet-row-height/);
    assert.match(host, /sheet\.mutation\.set-worksheet-col-width/);
    assert.match(host, /sheet\.operation\.set-cell-edit-visible/);
    assert.match(host, /doc\.command\.ime-input/);
    assert.match(host, /isEditorBusy/);
    assert.match(host, /activeElement/);
    assert.match(host, /isContentEditable/);
    assert.match(host, /plot-grid-cell-editor-window/);
    assert.doesNotMatch(host, /active\.closest\('\[class\*="univer"\]'\)/);
    assert.match(host, /sheet\.mutation\.set-range-values/);
    assert.match(host, /pendingAfterEdit = true/);
    assert.match(host, /hasPendingSync/);
    assert.match(host, /tryCommitCellEditor|executeCommand\?\.\('sheet\.operation\.set-cell-edit-visible'/);
    assert.match(host, /clearMissing/);
    assert.match(host, /clearMissing:\s*false/);
    assert.match(host, /mergeDimensions:\s*true/);
    assert.match(host, /mergeDimensions === true/);
    assert.match(host, /preserveConceptGridAxisSizes/);
    assert.match(host, /flushPendingDimensionNotify/);
    assert.match(host, /scheduleDimensionPull/);
    assert.match(host, /scheduleDimensionNotify/);
    assert.match(view, /univerHost\?\.isEditorBusy\(\)/);
    assert.match(view, /hasPendingSync\(\)/);
    assert.match(view, /Never autosave while Univer/);
    assert.match(view, /saveBusyRetries/);
    assert.match(view, /univerHost\.flush\(\)/);
    assert.match(view, /cellEditorWindows\.values\(\)/);
    assert.match(view, /Own autosave \/ no-op disk echo/);
    assert.match(view, /Only re-apply sheet\/freeze\/zoom/);
    assert.match(view, /getDocument\(\)/);

    assert.match(view, /persistBoundPlotGrid/);
    assert.match(view, /disposeUniverHost\(\{\s*persist:\s*false\s*\}\)/);
    assert.match(host, /event\?\.metaKey \|\| event\?\.ctrlKey/);
    assert.match(host, /p\.column \?\? p\.col/);
    assert.match(host, /BeforeSheetEditStart/);
    assert.match(host, /shouldBlockUniverCellEdit/);
    assert.match(host, /onRequestMarkdownCellEdit/);
    assert.match(view, /plotGridMarkdownEditMode/);
    assert.match(view, /cellRequiresMarkdownEditor/);
    assert.match(host, /UniverSheetsFilterPreset\(\)/);
    assert.match(host, /onCellRender/);
    assert.match(host, /refreshLinkMarkers/);
    assert.match(host, /drawTinyLinkIcon|cellHasNoteLink/);
    assert.doesNotMatch(host, /LINK_DWELL_MS/);
    assert.doesNotMatch(host, /scheduleLinkDwell/);
    assert.doesNotMatch(host, /onShowConnectedNotesHover/);
    assert.doesNotMatch(view, /showLinkHoverCard/);
    assert.doesNotMatch(view, /plot-grid-link-hover/);
    assert.match(view, /plot-grid-cell-editor-links/);
    assert.match(view, /refreshLinkedNotesBar/);
    assert.match(view, /plot-grid-cell-editor-links-add/);
    assert.match(view, /plot-grid-cell-editor-link-chip-remove/);
    assert.match(view, /removeConnectedNoteFromDraft/);
    assert.match(view, /addConnectedNoteViaPicker/);
    assert.match(view, /scheduleAutosave/);
    assert.match(view, /flushAutosave/);
    assert.match(view, /__nlCellEditorFlush/);
    assert.match(view, /persistDraft/);
    assert.doesNotMatch(view, /closeFooterBtn/);
    assert.doesNotMatch(view, /plot-grid-cell-editor-actions/);
    assert.equal((host.match(/toolbar:\s*true/g) || []).length, 2);
    assert.equal((host.match(/formulaBar:\s*true/g) || []).length, 2);
    assert.match(host, /createNativeWorkbook\(liveDoc\)/);
    assert.match(host, /richText:\s*false/);
    assert.match(host, /retrying with native plain cells/);
    assert.match(host, /--link-color/);
    assert.doesNotMatch(host, /🔗/);
    assert.match(host, /withNarrativeLabZhTerminology\(sheetsCoreZhCN\)/);
    assert.match(host, /freeze:\s*'固定'/);
    assert.match(host, /freezeCell:\s*'固定至活动单元格/);
    assert.match(host, /freezeFirstCol:\s*'固定首列'/);
    assert.match(host, /freezeFirstRow:\s*'固定首行'/);
    assert.match(host, /cancelFreeze:\s*'取消固定'/);
    assert.equal((host.match(/ribbonType:\s*'simple'/g) || []).length, 2);
    assert.doesNotMatch(host, /contextMenu:\s*false/);
    assert.match(host, /moveFinancialFormulaMenuLast/);
    assert.match(host, /keepFilterInToolbar\(univerInstance\)/);
    assert.match(host, /\[RibbonPosition\.DATA\]:\s*\{\s*order:\s*FILTER_TOOLBAR_GROUP_ORDER/s);
    assert.match(host, /FILTER_TOOLBAR_GROUP_ORDER\s*=\s*-100/);
    assert.match(host, /addUniverSubscriptionDisposer/);
    assert.match(host, /univerAPI\.removeEvent\?\./);
    assert.doesNotMatch(host, /suppressWatcher/);
    assert.match(host, /scheduleSuppressedDrain/);
    assert.match(host, /`\$\{InsertFunctionOperation\.id\}\.financial`/);
    assert.match(host, /FINANCIAL_FORMULA_MENU_ORDER\s*=\s*99/);
    assert.match(host, /\[TEXT_TO_NUMBER_TOOLBAR_MENU_ID\]:\s*\{\s*hidden:\s*true\s*\}/);
    assert.doesNotMatch(view, /resolveLinkedLabel/);
    assert.doesNotMatch(view, /falling back to DOM grid/);
    assert.match(view, /renderUniverLoadError/);
    assert.match(view, /Plot Grid autosave failed/);
    assert.match(view, /finally \{[\s\S]*?this\.saveDebounce === timerId/);
    assert.match(view, /persistBoundPlotGrid\(\)/);
    assert.match(view, /disposeUniverHost\(\{\s*persist:\s*false\s*\}\)/);
    assert.match(view, /this\.cancelPendingSave\(\)/);
});
