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
                hidden: true,
                tabColor: '#c45c26',
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
        assert.equal(sidecarMeta.pages['page-1'].hidden, true);
        assert.equal(sidecarMeta.pages['page-1'].tabColor, '#c45c26');

        const decoded = await codec.decodePlotGridXlsx(binary, { meta: sidecarMeta });
        assert.equal(decoded.pages.length, 1);
        assert.equal(decoded.pages[0].hidden, true);
        assert.equal(decoded.pages[0].tabColor, '#c45c26');
        assert.equal(workbook.getWorksheet('Act I').state, 'hidden');
        assert.equal(workbook.getWorksheet('Act I').properties.tabColor.argb, 'FFC45C26');
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
        assert.equal(sheet.hidden, 1);
        assert.equal(sheet.tabColor, '#c45c26');
        assert.deepEqual(sheet.freeze, { startRow: 3, startColumn: 2, ySplit: 3, xSplit: 2 });

        const reconciled = codec.reconcileUniverSheetsIntoDocument(decoded, {
            'page-1': { id: 'page-1', name: 'Act I', hidden: 1, tabColor: '#c45c26' },
            'page-2': { id: 'page-2', name: 'Act II', hidden: 0, tabColor: '#336699' },
        }, ['page-2', 'page-1'], 'page-2');
        assert.equal(reconciled.pages.length, 2);
        assert.equal(reconciled.pages[0].id, 'page-2');
        assert.equal(reconciled.pages[0].title, 'Act II');
        assert.equal(reconciled.pages[0].tabColor, '#336699');
        assert.equal(reconciled.pages[1].cells['r1-c1'].linkedSceneId, 'Scenes/opening.md');
        assert.equal(reconciled.activePageId, 'page-2');
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

        // Explicit empty `v` must beat a leftover rich-text `p` (Delete / unlink).
        const staleRich = codec.mergeUniverCellDataIntoDocument(structuredClone(merged), 'page-1', {
            0: { 0: { v: '' }, 1: { v: 'Hero' } },
            1: {
                0: { v: 'Scene 1' },
                1: {
                    v: '',
                    p: { body: { dataStream: 'updated text\r\n' } },
                    custom: { narrativeLabSource: '[[Scenes/opening]]' },
                },
            },
        });
        assert.equal(staleRich.pages[0].cells['r1-c1'].content, '');
        assert.equal(staleRich.pages[0].cells['r1-c1'].linkedSceneId, 'Scenes/opening.md');

        // Univer "Clear contents" stores null v/p/custom; that is a committed clear
        // even when surrounding cells are still sparse (no clearMissing flag).
        const clearedContents = codec.mergeUniverCellDataIntoDocument(structuredClone(merged), 'page-1', {
            0: { 0: { v: '' }, 1: { v: 'Hero' } },
            1: {
                0: { v: 'Scene 1' },
                1: { v: null, p: null, f: null, custom: null },
            },
        });
        assert.equal(clearedContents.pages[0].cells['r1-c1'].content, '');
        assert.equal(clearedContents.pages[0].cells['r1-c1'].formula, undefined);
        assert.equal(clearedContents.pages[0].cells['r1-c1'].linkedSceneId, 'Scenes/opening.md');

        // Univer "Clear all" writes an explicit null into the matrix.
        const clearedAll = codec.mergeUniverCellDataIntoDocument(structuredClone(merged), 'page-1', {
            0: { 0: { v: '' }, 1: { v: 'Hero' } },
            1: {
                0: { v: 'Scene 1' },
                1: null,
            },
        });
        assert.equal(clearedAll.pages[0].cells['r1-c1'].content, '');
        assert.equal(clearedAll.pages[0].cells['r1-c1'].linkedSceneId, 'Scenes/opening.md');

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

        // Native Univer row/column splices must update stable NL axes before
        // sparse cellData is merged, otherwise blank rows retain old values and
        // the following rows appear duplicated after reopening the view.
        const rowInserted = codec.spliceConceptGridAxis(reorderDoc, 'page-1', 'rows', 'insert', 2, 1);
        assert.equal(rowInserted.pages[0].rows.length, 3);
        assert.equal(rowInserted.pages[0].rows[0].id, 'r1');
        assert.equal(rowInserted.pages[0].rows[1].label, '');
        assert.equal(rowInserted.pages[0].rows[2].id, 'r2');
        const rowMerged = codec.mergeUniverCellDataIntoDocument(rowInserted, 'page-1', {
            0: { 0: { v: '' }, 1: { v: 'C1' }, 2: { v: 'C2' } },
            1: { 0: { v: 'R1' }, 1: { v: 'A' } },
            // Worksheet row 2 is intentionally sparse/blank.
            3: { 0: { v: 'R2' }, 2: { v: 'B' } },
        }, undefined, undefined, undefined, { clearMissing: true });
        const insertedRowId = rowMerged.pages[0].rows[1].id;
        assert.equal(rowMerged.pages[0].cells[`${insertedRowId}-c1`], undefined);
        assert.equal(rowMerged.pages[0].cells['r2-c2'].content, 'B');
        const rowWorkbook = codec.documentToUniverWorkbookData(rowMerged);
        assert.equal(rowWorkbook.sheets['page-1'].cellData[2][2].v, '');
        assert.equal(rowWorkbook.sheets['page-1'].cellData[3][2].v, 'B');
        const rowRemoved = codec.spliceConceptGridAxis(rowMerged, 'page-1', 'rows', 'remove', 2, 1);
        assert.deepEqual(rowRemoved.pages[0].rows.map(row => row.id), ['r1', 'r2']);

        // If xlsx saved first and the sidecar is one debounce behind, decode
        // must recover the live blank row instead of mapping stale row ids by
        // position (which produced duplicate rows on the next view mount).
        const staleMeta = codec.buildNlMetaForDocument(reorderDoc);
        const liveRowBook = new ExcelJS.Workbook();
        const liveRowSheet = liveRowBook.addWorksheet('Reorder');
        liveRowSheet.getCell(1, 2).value = 'C1';
        liveRowSheet.getCell(1, 3).value = 'C2';
        liveRowSheet.getCell(2, 1).value = 'R1';
        liveRowSheet.getCell(2, 2).value = 'A';
        liveRowSheet.getRow(3).height = 24;
        liveRowSheet.getCell(4, 1).value = 'R2';
        liveRowSheet.getCell(4, 3).value = 'B';
        const recoveredStructure = await codec.decodePlotGridXlsx(
            await liveRowBook.xlsx.writeBuffer(),
            { meta: staleMeta },
        );
        assert.equal(recoveredStructure.pages[0].rows.length, 3);
        assert.equal(recoveredStructure.pages[0].rows[0].id, 'r1');
        assert.equal(recoveredStructure.pages[0].rows[1].label, '');
        assert.equal(recoveredStructure.pages[0].rows[2].id, 'r2');
        assert.equal(recoveredStructure.pages[0].cells['r1-c1'].content, 'A');
        assert.equal(recoveredStructure.pages[0].cells['r2-c2'].content, 'B');
        assert.equal(codec.plotGridNlMetaStructureMatchesDocument(staleMeta, recoveredStructure), false);
        assert.equal(codec.plotGridNlMetaStructureMatchesDocument(
            codec.buildNlMetaForDocument(recoveredStructure),
            recoveredStructure,
        ), true);

        const liveTrimmedBook = new ExcelJS.Workbook();
        const liveTrimmedSheet = liveTrimmedBook.addWorksheet('Reorder');
        liveTrimmedSheet.getCell(1, 2).value = 'C2';
        liveTrimmedSheet.getCell(2, 1).value = 'R2';
        liveTrimmedSheet.getCell(2, 2).value = 'B';
        const recoveredTrimmed = await codec.decodePlotGridXlsx(
            await liveTrimmedBook.xlsx.writeBuffer(),
            { meta: staleMeta },
        );
        assert.deepEqual(recoveredTrimmed.pages[0].columns.map(column => column.id), ['c2']);
        assert.deepEqual(recoveredTrimmed.pages[0].rows.map(row => row.id), ['r2']);
        assert.equal(recoveredTrimmed.pages[0].cells['r2-c2'].content, 'B');

        const columnInserted = codec.spliceConceptGridAxis(reorderDoc, 'page-1', 'columns', 'insert', 2, 1);
        assert.equal(columnInserted.pages[0].columns.length, 3);
        assert.equal(columnInserted.pages[0].columns[0].id, 'c1');
        assert.equal(columnInserted.pages[0].columns[1].label, '');
        assert.equal(columnInserted.pages[0].columns[2].id, 'c2');
        const insertedColumnId = columnInserted.pages[0].columns[1].id;
        const columnWithTransientCell = {
            ...columnInserted,
            pages: [{
                ...columnInserted.pages[0],
                cells: {
                    ...columnInserted.pages[0].cells,
                    [`r1-${insertedColumnId}`]: {
                        id: `r1-${insertedColumnId}`,
                        content: 'temporary', bgColor: '', textColor: '', bold: false, italic: false, align: 'left',
                    },
                },
            }],
        };
        const columnRemoved = codec.spliceConceptGridAxis(columnWithTransientCell, 'page-1', 'columns', 'remove', 2, 1);
        assert.deepEqual(columnRemoved.pages[0].columns.map(column => column.id), ['c1', 'c2']);
        assert.equal(columnRemoved.pages[0].cells[`r1-${insertedColumnId}`], undefined);
        assert.equal(columnRemoved.pages[0].cells['r2-c2'].linkedSceneId, 'Notes/B.md');

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
    assert.match(mainTs, /migratePlotGridToLibraryIfNeeded/);
    assert.match(mainTs, /Library\/datasheet\.xlsx|datasheet\.xlsx/);
    assert.match(mainTs, /encodePlotGridXlsx/);
    assert.match(mainTs, /decodePlotGridXlsx/);
    assert.match(mainTs, /releasePlotGridWorkbookCache/);
    assert.match(mainTs, /_plotGridDocCache/);
    assert.match(mainTs, /peekPlotGridDoc/);
    assert.match(mainTs, /rememberPlotGridDocCache/);
    assert.match(mainTs, /warmupPlotGridUniver/);
    assert.match(mainTs, /\.bak`|jsonPath.*bak|rename\(jsonPath/);
    assert.match(mainTs, /writeVaultBinaryResilient/);
    assert.match(mainTs, /backupCorruptPlotGridXlsx|_invalidPlotGridXlsxPaths/);
    assert.match(mainTs, /healthy, loaded workbook may legitimately become empty/);
    assert.match(mainTs, /isConceptGridDocumentEmpty\(document\)[\s\S]*?_invalidPlotGridXlsxPaths\.has\(path\)/);
    assert.match(mainTs, /options: \{ allowEmptyOverwrite\?: boolean; projectFilePath\?: string \}/);
    assert.match(mainTs, /deriveProjectFoldersFromFilePath\(projectFilePath\)\.baseFolder/);
    assert.match(mainTs, /loadPlotGrid\(projectFilePath\?: string\)/);
    assert.match(mainTs, /migratePlotGridToLibraryIfNeeded\(targetProjectFile\)/);
    assert.match(mainTs, /__.+\\.csv\$/);
    assert.doesNotMatch(mainTs, /PlotGridCsvSync/);
});

test('PlotgridView lazy-loads Univer host and edits links as Markdown text', async () => {
    const [view, styles] = await Promise.all([
        readFile(new URL('../views/PlotgridView.ts', import.meta.url), 'utf8'),
        readFile(new URL('../styles.css', import.meta.url), 'utf8'),
    ]);
    assert.match(view, /loadPlotGridUniverModule/);
    assert.match(view, /this\.buildLayout\(container\);[\s\S]*?this\.loadData\(\)/);
    assert.match(view, /peekPlotGridDoc/);
    assert.match(view, /showSpreadsheetLoading/);
    assert.match(view, /Loading spreadsheet…/);
    assert.match(view, /await nextPaint\(\)/);
    assert.match(view, /createPlotGridUniverHost/);
    assert.match(view, /onContextMenuRequest/);
    assert.match(view, /getAuthoritativeDocument/);
    assert.match(view, /syncMeta/);
    assert.match(view, /univerMountGeneration/);
    assert.match(view, /openCellMarkdownEditor/);
    assert.match(view, /unlinkCell/);
    assert.match(view, /unwrapAllNoteLinks/);
    assert.match(view, /unwrapMatchingNoteLinks/);
    assert.match(view, /this\.pushCellSourceToUniver\(cell\)/);
    assert.match(view, /__nlCellEditorSetContent/);
    assert.match(view, /if \(!cellHasNoteLink\(cell\)\)/);
    assert.doesNotMatch(view, /draftMatchesNote\(target, note.path\) \? '' : full/);
    assert.match(view, /isExternalEditorBusy/);
    assert.doesNotMatch(view, /scheduleUniverVisibilitySync/);
    assert.doesNotMatch(view, /persistDraft\(\{ pushGrid: true \}\)/);
    assert.match(view, /cellEditorWindows/);
    assert.match(view, /Always on top/);
    assert.doesNotMatch(view, /Replace any existing floating cell editor/);
    assert.doesNotMatch(view, /is-pinned-top/);
    assert.match(view, /Open cell editor/);
    assert.doesNotMatch(view, /toggleWikilinkForActiveCell/);
    assert.match(view, /is-plotgrid-controls/);
    assert.doesNotMatch(view, /appendChild\(trailingActions\)/);
    assert.doesNotMatch(view, /insertBefore\(controls, trailingActions\)/);
    assert.match(styles, /\.story-line-toolbar-controls\.is-plotgrid-controls\s*\{[^}]*justify-content:\s*flex-start/s);
    assert.match(styles, /\.plot-grid-toolbar-actions\s*\{[^}]*margin-left:\s*0/s);
    assert.doesNotMatch(view, /const syncSep/);
    assert.match(view, /installTextareaUndoHistory/);
    assert.match(view, /replaceTextareaValue/);
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
    assert.match(view, /AXIS_CORNER_CELL_ID|__nl-axis-corner/);
    assert.match(view, /axisColumnCellId|axisRowCellId/);
    assert.doesNotMatch(view, /sel\.row < 1 \|\| sel\.col < 1/);
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
    assert.match(view, /loadedProjectFile/);
    assert.match(view, /getBoundProjectFile\(\)/);
    assert.match(view, /folderAtSchedule/);
    assert.match(view, /projectChanged/);
    assert.match(view, /projectFilePath: projectAtSchedule/);
    assert.match(view, /loadPlotGrid\(projectFile\)/);
    // Every destructive/structural navigation commits native edits first.
    assert.match(view, /private switchPage[\s\S]*?this\.flushUniverIntoDocument\(\)/);
    assert.doesNotMatch(view, /private duplicatePage/);
    assert.doesNotMatch(view, /private createPage/);
    // Floating Markdown drafts must flush before the final close save.
    assert.match(view, /async onClose[\s\S]*?this\.closeAllCellEditors\(\);\s*this\.flushUniverIntoDocument\(\);[\s\S]*?savePlotGrid/);
});

test('cell editor undo stays in the textarea instead of the workspace stack', async () => {
    const [historySrc, view, mainTs, suggest] = await Promise.all([
        readFile(new URL('../utils/textareaHistory.ts', import.meta.url), 'utf8'),
        readFile(new URL('../views/PlotgridView.ts', import.meta.url), 'utf8'),
        readFile(new URL('../main.ts', import.meta.url), 'utf8'),
        readFile(new URL('../components/WikilinkSuggest.ts', import.meta.url), 'utf8'),
    ]);
    assert.match(historySrc, /export function isUndoKey/);
    assert.match(historySrc, /export function consumeTextareaUndoKey/);
    assert.match(historySrc, /export function isLocalTextUndoTarget/);
    assert.match(view, /applyCellSource/);
    assert.match(historySrc, /plot-grid-cell-editor-window/);
    assert.match(view, /installTextareaUndoHistory/);
    assert.match(view, /replaceTextareaValue/);
    assert.match(mainTs, /consumeTextareaUndoKey/);
    assert.match(mainTs, /isLocalTextUndoTarget\(\)/);
    assert.match(mainTs, /addEventListener\('keydown', onUndoKeyCapture, true\)/);
    assert.match(mainTs, /id: 'undo',[\s\S]*?checkCallback:/);
    assert.match(suggest, /setRangeText\(inserted, this\.triggerStart, replaceEnd, 'end'\)/);
    assert.doesNotMatch(suggest, /this\.textareaEl\.value = newValue/);

    const dir = await mkdtemp(join(tmpdir(), 'nl-textarea-history-'));
    const outfile = join(dir, 'history.cjs');
    try {
        await esbuild.build({
            absWorkingDir: projectRoot,
            entryPoints: [join(projectRoot, 'utils/textareaHistory.ts')],
            bundle: true,
            platform: 'node',
            format: 'cjs',
            outfile,
            logLevel: 'silent',
            external: ['obsidian'],
        });
        const history = require(outfile);
        assert.equal(history.isUndoKey({ ctrlKey: false, metaKey: true, altKey: false, shiftKey: false, key: 'z' }), true);
        assert.equal(history.isUndoKey({ ctrlKey: true, metaKey: false, altKey: false, shiftKey: false, key: 'z' }), true);
        assert.equal(history.isUndoKey({ ctrlKey: false, metaKey: true, altKey: false, shiftKey: true, key: 'z' }), false);
        assert.equal(history.isRedoKey({ ctrlKey: false, metaKey: true, altKey: false, shiftKey: true, key: 'z' }), true);
        assert.equal(history.isRedoKey({ ctrlKey: true, metaKey: false, altKey: false, shiftKey: false, key: 'y' }), true);
        assert.equal(history.isRedoKey({ ctrlKey: false, metaKey: true, altKey: false, shiftKey: false, key: 'z' }), false);
    } finally {
        await rm(dir, { recursive: true, force: true });
    }
});

test('Univer sheet bar chrome is persisted without dropping linked cells', async () => {
    const host = await readFile(new URL('../services/PlotGridUniverHost.ts', import.meta.url), 'utf8');
    const view = await readFile(new URL('../views/PlotgridView.ts', import.meta.url), 'utf8');
    const codecSrc = await readFile(new URL('../services/PlotGridXlsxCodec.ts', import.meta.url), 'utf8');
    assert.match(host, /reconcileUniverSheetsIntoDocument/);
    assert.match(host, /registerNarrativeLabContextMenu/);
    assert.match(host, /refreshLinkMarkers/);
    assert.match(view, /plot-grid-cell-editor-links/);
    assert.match(view, /addConnectedNoteViaPicker/);
    assert.match(codecSrc, /export function reconcileUniverSheetsIntoDocument/);
    assert.match(codecSrc, /hidden: page\.hidden \? 1 : 0/);
    assert.match(codecSrc, /tabColor: page\.tabColor/);
    assert.doesNotMatch(view, /this\.sidebarEl = this\.bodyEl\.createDiv\('concept-grid-sheet-bar'\)/);
});

test('integrated Univer host receives Obsidian UI through the community main bundle', async () => {
    const host = await readFile(new URL('../services/PlotGridUniverHost.ts', import.meta.url), 'utf8');
    const loader = await readFile(new URL('../utils/loadPlotGridUniver.ts', import.meta.url), 'utf8');
    const build = await readFile(new URL('../esbuild.config.mjs', import.meta.url), 'utf8');
    assert.doesNotMatch(host, /from ['"]obsidian['"]/);
    assert.match(host, /onContextMenuRequest/);
    assert.match(host, /applyCellSource/);
    assert.match(host, /getPlotGridCellAtUniverCoords\(page, row, col\)/);
    assert.match(host, /payload\.s = \{ cl: null \}/);
    assert.match(host, /isExternalEditorBusy/);
    assert.match(host, /event\?\.detail/);
    assert.match(loader, /import \{ createPlotGridUniverHost, warmupPlotGridUniver \}/);
    assert.doesNotMatch(loader, /window\.require|plotgrid-univer\.js/);
    assert.doesNotMatch(build, /services\/plotgrid-univer-entry|outfile:.*plotgrid-univer/);
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

test('embedded Univer host exposes the NarrativeLab grid controls', async () => {
    const host = await readFile(new URL('../services/PlotGridUniverHost.ts', import.meta.url), 'utf8');
    const view = await readFile(new URL('../views/PlotgridView.ts', import.meta.url), 'utf8');
    const codecSrc = await readFile(new URL('../services/PlotGridXlsxCodec.ts', import.meta.url), 'utf8');
    const styles = await readFile(new URL('../styles.css', import.meta.url), 'utf8');
    for (const method of ['setZoom', 'setFreeze', 'setActiveCell']) {
        assert.match(host, new RegExp(`${method}:`));
    }
    assert.doesNotMatch(host, /setHiddenRows|showRows|hideRows/);
    assert.doesNotMatch(host, /setRowAutoHeight|autoFitRows/);
    assert.match(host, /getActiveCell\?\./);
    assert.match(host, /getRow\?\.\(\)/);
    assert.match(host, /getColumn\?\.\(\)/);
    assert.equal((host.match(/contextMenu:\s*true/g) || []).length, 1);
    assert.match(host, /registerNarrativeLabContextMenu/);
    assert.match(host, /onContextMenuRequest/);
    assert.match(view, /new Menu\(\)/);
    assert.match(view, /showMenuSafely\(menu, position\)/);
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
    assert.match(host, /reconcileUniverSheetsIntoDocument/);
    assert.match(host, /Univer's sheet bar owns name/);
    assert.match(host, /setSheetTitle/);
    assert.doesNotMatch(host, /page\.title = sheetName/);
    assert.match(view, /Univer's own footer owns worksheet tabs/);
    assert.doesNotMatch(view, /concept-grid-sheet-bar/);
    assert.doesNotMatch(view, /validateConceptGridSheetName/);
    assert.doesNotMatch(view, /isPageTabRenaming/);
    assert.match(view, /reloadFromDisk/);
    assert.match(view, /getProjectDisplayName\(this\.getBoundProjectFile\(\)\)/);
    assert.match(host, /headerRowHeight/);
    assert.match(host, /labelColumnWidth/);
    assert.match(host, /worksheetRow === 0/);
    assert.match(host, /worksheetColumn === 0/);
    assert.match(codecSrc, /headerRowHeight/);
    assert.match(codecSrc, /labelColumnWidth/);
    assert.match(codecSrc, /rowData\[0\]/);
    assert.match(codecSrc, /columnData\[0\]/);
    assert.match(host, /applyAxisMoveMutation/);
    assert.match(host, /applyAxisStructureMutation/);
    assert.match(host, /sheet\.mutation\.insert-row/);
    assert.match(host, /sheet\.mutation\.remove-rows/);
    assert.match(host, /sheet\.mutation\.insert-col/);
    assert.match(host, /sheet\.mutation\.remove-col/);
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
    assert.match(host, /sheet\.command\.clear-selection-all/);
    assert.match(host, /sheet\.command\.clear-selection-content/);
    assert.match(host, /pendingAfterEdit = true/);
    assert.match(host, /schedulePull\(\{ clearMissing: true \}\)/);
    assert.match(host, /pendingAfterMenu/);
    assert.match(host, /data-u-context-menu-submenu/);
    assert.match(host, /isUniverContextMenuOpen/);
    assert.match(host, /desktop-context-menu/);
    assert.match(host, /retireOlderVisibleUniverSubmenus/);
    assert.match(host, /style\.visibility !== 'hidden'/);
    assert.match(host, /kickUniverSubmenuPosition/);
    assert.match(host, /dispatchEvent\(new Event\('scroll'\)\)/);
    assert.match(host, /MutationObserver/);
    assert.match(host, /menuHoldUntil/);
    assert.doesNotMatch(host, /addEventListener\('pointerover'/);
    assert.match(host, /pendingClearMissing \|\| pendingAfterEdit/);
    assert.doesNotMatch(host, /narrativelab-univer-submenu-stale/);
    assert.doesNotMatch(host, /pruneStackedUniverSubmenus/);
    assert.match(host, /narrativelab-univer-submenu-retired/);
    assert.match(styles, /narrativelab-univer-submenu-retired/);
    assert.doesNotMatch(styles, /narrativelab-univer-submenu-stale/);
    assert.match(host, /readLiveCellPlainText/);
    assert.match(view, /readLiveCellPlainText/);
    assert.match(host, /hasPendingSync/);
    assert.match(host, /tryCommitCellEditor|executeCommand\?\.\('sheet\.operation\.set-cell-edit-visible'/);
    assert.match(host, /clearMissing/);
    assert.match(host, /pendingClearMissing/);
    assert.match(host, /schedulePull\(\{ clearMissing: true, mergeDimensions: true \}\)/);
    assert.match(host, /mergeDimensions:\s*true/);
    assert.match(host, /mergeDimensions === true/);
    assert.match(host, /preserveConceptGridAxisSizes/);
    assert.match(host, /flushPendingDimensionNotify/);
    assert.match(host, /scheduleDimensionPull/);
    assert.match(host, /scheduleDimensionNotify/);
    assert.match(view, /univerHost\?\.isEditorBusy\(\)/);
    assert.match(view, /hasPendingSync\(\)/);
    assert.match(view, /Never autosave while Univer/);
    assert.doesNotMatch(view, /saveBusyRetries/);
    assert.match(view, /must never force-close a user who is still typing/);
    assert.match(view, /univerHost\.flush\(\)/);
    assert.match(view, /flushUniverIntoDocument\(\)/);
    assert.match(view, /syncOpenCellEditorsFromDocument/);
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
    assert.match(styles, /\.plot-grid-cell-editor-window button\.plot-grid-cell-editor-link-chip-open\s*\{[^}]*padding:\s*3px 8px/s);
    assert.match(view, /removeConnectedNoteFromDraft/);
    assert.match(view, /unwrapMatchingNoteLinks\(textarea\.value/);
    assert.match(view, /if \(previewMode\) void setPreview\(true\)/);
    assert.match(view, /addConnectedNoteViaPicker/);
    assert.match(view, /scheduleAutosave/);
    assert.match(view, /flushAutosave/);
    assert.match(view, /__nlCellEditorFlush/);
    assert.match(view, /persistDraft/);
    assert.doesNotMatch(view, /closeFooterBtn/);
    assert.doesNotMatch(view, /plot-grid-cell-editor-actions/);
    assert.equal((host.match(/toolbar:\s*true/g) || []).length, 1);
    assert.equal((host.match(/formulaBar:\s*true/g) || []).length, 1);
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
    assert.equal((host.match(/ribbonType:\s*'classic'/g) || []).length, 1);
    assert.match(host, /export function warmupPlotGridUniver/);
    assert.match(host, /sheetBar:\s*true/);
    assert.match(host, /statisticBar:\s*true/);
    assert.match(host, /zoomSlider:\s*true/);
    assert.doesNotMatch(host, /footer:\s*false/);
    assert.doesNotMatch(host, /ribbonType:\s*'simple'/);
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

test('first row and first column map to axis cells instead of being rejected', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'nl-plotgrid-axis-'));
    const outfile = join(dir, 'axis.cjs');
    try {
        await esbuild.build({
            absWorkingDir: projectRoot,
            entryPoints: [join(projectRoot, 'utils/plotGridCellEdit.ts')],
            bundle: true,
            platform: 'node',
            format: 'cjs',
            outfile,
            logLevel: 'silent',
        });
        const edit = require(outfile);
        const page = {
            cornerLabel: 'Corner',
            rows: [{ id: 'r1', label: 'Row 1' }],
            columns: [{ id: 'c1', label: 'Col 1' }],
            cells: {
                [edit.AXIS_CORNER_CELL_ID]: { id: edit.AXIS_CORNER_CELL_ID, content: 'Corner' },
                [edit.axisColumnCellId('c1')]: { id: edit.axisColumnCellId('c1'), content: 'Col 1' },
                [edit.axisRowCellId('r1')]: { id: edit.axisRowCellId('r1'), content: 'Row 1' },
                'r1-c1': { id: 'r1-c1', content: 'body' },
            },
        };
        assert.equal(edit.getPlotGridCellAtUniverCoords(page, 0, 0)?.content, 'Corner');
        assert.equal(edit.getPlotGridCellAtUniverCoords(page, 0, 1)?.content, 'Col 1');
        assert.equal(edit.getPlotGridCellAtUniverCoords(page, 1, 0)?.content, 'Row 1');
        assert.equal(edit.getPlotGridCellAtUniverCoords(page, 1, 1)?.content, 'body');
        assert.deepEqual(edit.univerCoordsForPlotGridCell(page, page.cells[edit.AXIS_CORNER_CELL_ID]), { row: 0, col: 0 });
        assert.deepEqual(edit.univerCoordsForPlotGridCell(page, page.cells[edit.axisRowCellId('r1')]), { row: 1, col: 0 });
        assert.equal(edit.cellRequiresMarkdownEditor(null, 0, 0, true), true);
        assert.equal(edit.cellRequiresMarkdownEditor({ content: 'plain' }, 0, 0, false), false);
        const linked = { content: '[[Note]]', linkedSceneId: 'Notes/Note.md' };
        assert.equal(edit.cellRequiresMarkdownEditor(linked, 0, 0, false), true);
        edit.syncAxisLabelFromCell(page, { id: edit.AXIS_CORNER_CELL_ID, content: 'New corner' });
        assert.equal(page.cornerLabel, 'New corner');
        assert.equal(edit.noteLinkDisplayLabel('Library/Games/Valorant.md'), 'Valorant');
        assert.equal(edit.noteLinkDisplayLabel('Games/Valorant', '游隼'), '游隼');
        assert.equal(
            edit.unwrapMatchingNoteLinks('100个if线 [[Valorant]]', (target) => target === 'Valorant'),
            '100个if线 Valorant',
        );
        assert.equal(
            edit.unwrapMatchingNoteLinks('keep [[Other]] and [[Games/Valorant|Valorant]]', (target) => target.includes('Valorant')),
            'keep [[Other]] and Valorant',
        );
        assert.equal(edit.unwrapAllNoteLinks('[[path/Note.md|Shown]] and text'), 'Shown and text');
        assert.equal(edit.unwrapAllNoteLinks('[Valorant](https://playvalorant.com)'), '[Valorant](https://playvalorant.com)');
        assert.equal(edit.unwrapAllNoteLinks('[Valorant](Valorant.md)'), 'Valorant');
    } finally {
        await rm(dir, { recursive: true, force: true });
    }
});
