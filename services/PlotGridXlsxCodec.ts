/**
 * Concept Grid ↔ Excel (.xlsx) codec.
 *
 * Visible sheets = pages (row 0 = column labels, col 0 = row labels).
 * Hidden sheet `_nl_meta` stores NarrativeLab metadata (cell links, sourceIds, …)
 * as a single JSON blob so Excel edits to values do not wipe links.
 */
import ExcelJS from 'exceljs';
import type {
    CellData,
    ColumnMeta,
    ConceptGridDocument,
    ConceptGridPage,
    RowMeta,
} from '../models/PlotGridData';
import {
    createEmptyConceptGridDocument,
    normalizeConceptGridDocument,
} from '../models/PlotGridData';

export const PLOTGRID_XLSX_FILENAME = 'plotgrid.xlsx';
/** Brief-lived subfolder used before settling on System/plotgrid.xlsx */
export const PLOTGRID_FOLDER = 'PlotGrid';
export const NL_META_SHEET = '_nl_meta';
const META_SCHEMA = 1;

/** Canonical path: `{systemFolder}/plotgrid.xlsx` */
export function plotGridXlsxPath(systemFolder: string): string {
    const base = systemFolder.replace(/\/+$/, '');
    return `${base}/${PLOTGRID_XLSX_FILENAME}`.replace(/\\/g, '/');
}

/** Short-lived path: `{systemFolder}/PlotGrid/plotgrid.xlsx` */
export function legacyPlotGridFolderXlsxPath(systemFolder: string): string {
    const base = systemFolder.replace(/\/+$/, '');
    return `${base}/${PLOTGRID_FOLDER}/${PLOTGRID_XLSX_FILENAME}`.replace(/\\/g, '/');
}

/** Legacy CSV-mirror folder: `{systemFolder}/PlotGrid` */
export function plotGridFolderPath(systemFolder: string): string {
    const base = systemFolder.replace(/\/+$/, '');
    return `${base}/${PLOTGRID_FOLDER}`.replace(/\\/g, '/');
}

export interface PlotGridNlMeta {
    schema: number;
    activePageId: string;
    sidebarCollapsed?: boolean;
    /** sheet name → page id */
    pageIds: Record<string, string>;
    pages: Record<string, {
        id: string;
        zoom?: number;
        stickyHeaders?: boolean;
        rows: RowMeta[];
        columns: ColumnMeta[];
        cells: Record<string, Pick<CellData, 'id' | 'linkedSceneId' | 'formula' | 'manualContent' | 'bgColor' | 'textColor' | 'bold' | 'italic' | 'align'>>;
    }>;
}

function sanitizeSheetName(title: string, used: Set<string>): string {
    let base = (title || 'Page').replace(/[:\\/?*[\]]/g, '-').slice(0, 28).trim() || 'Page';
    if (base.toLowerCase() === NL_META_SHEET.toLowerCase()) base = 'Page';
    let name = base;
    let n = 2;
    while (used.has(name.toLowerCase())) {
        name = `${base.slice(0, 24)}_${n++}`;
    }
    used.add(name.toLowerCase());
    return name;
}

function cellValueText(value: unknown): string {
    if (value == null) return '';
    if (typeof value === 'string') return value;
    if (typeof value === 'number' || typeof value === 'boolean') return String(value);
    if (value instanceof Date) return value.toISOString();
    if (typeof value !== 'object') return '';

    const record = value as Record<string, unknown>;
    if (typeof record.text === 'string') return record.text;
    if (Array.isArray(record.richText)) {
        return record.richText
            .map(part => (
                part && typeof part === 'object' && typeof (part as Record<string, unknown>).text === 'string'
                    ? (part as Record<string, unknown>).text as string
                    : ''
            ))
            .join('');
    }
    if ('result' in record) return cellValueText(record.result);
    if (typeof record.error === 'string') return record.error;
    return '';
}

function cellKey(rowId: string, colId: string): string {
    return `${rowId}-${colId}`;
}

function defaultCell(partial?: Partial<CellData>): CellData {
    return {
        id: partial?.id || `cell-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`,
        content: partial?.content || '',
        bgColor: partial?.bgColor || '',
        textColor: partial?.textColor || '',
        bold: !!partial?.bold,
        italic: !!partial?.italic,
        align: partial?.align || 'left',
        linkedSceneId: partial?.linkedSceneId,
        formula: partial?.formula,
        manualContent: partial?.manualContent,
    };
}

/** Build NL meta from a ConceptGridDocument (no cell display text). */
export function buildNlMeta(doc: ConceptGridDocument, sheetNames: string[]): PlotGridNlMeta {
    const pageIds: Record<string, string> = {};
    const pages: PlotGridNlMeta['pages'] = {};
    doc.pages.forEach((page, i) => {
        const sheetName = sheetNames[i] || page.title;
        pageIds[sheetName] = page.id;
        const cells: PlotGridNlMeta['pages'][string]['cells'] = {};
        for (const [key, cell] of Object.entries(page.cells || {})) {
            if (!cell) continue;
            cells[key] = {
                id: cell.id,
                linkedSceneId: cell.linkedSceneId,
                formula: cell.formula,
                manualContent: cell.manualContent,
                bgColor: cell.bgColor,
                textColor: cell.textColor,
                bold: cell.bold,
                italic: cell.italic,
                align: cell.align,
            };
        }
        pages[page.id] = {
            id: page.id,
            zoom: page.zoom,
            stickyHeaders: page.stickyHeaders,
            rows: page.rows.map(r => ({ ...r })),
            columns: page.columns.map(c => ({ ...c })),
            cells,
        };
    });
    return {
        schema: META_SCHEMA,
        activePageId: doc.activePageId,
        sidebarCollapsed: doc.sidebarCollapsed,
        pageIds,
        pages,
    };
}

/** Encode ConceptGridDocument → xlsx ArrayBuffer. */
export async function encodePlotGridXlsx(raw: unknown): Promise<ArrayBuffer> {
    const doc = normalizeConceptGridDocument(raw);
    const wb = new ExcelJS.Workbook();
    wb.creator = 'NarrativeLab';
    wb.created = new Date();

    const usedNames = new Set<string>();
    const sheetNames: string[] = [];

    for (const page of doc.pages) {
        const name = sanitizeSheetName(page.title, usedNames);
        sheetNames.push(name);
        const sheet = wb.addWorksheet(name, page.stickyHeaders === false
            ? undefined
            : { views: [{ state: 'frozen', xSplit: 1, ySplit: 1 }] });

        const cols = page.columns || [];
        const rows = page.rows || [];

        // Header row: blank corner + column labels
        sheet.getCell(1, 1).value = '';
        cols.forEach((col, ci) => {
            const cell = sheet.getCell(1, ci + 2);
            cell.value = col.label || '';
            if (col.headerBgColor || col.bgColor) {
                cell.fill = {
                    type: 'pattern',
                    pattern: 'solid',
                    fgColor: { argb: cssToArgb(col.headerBgColor || col.bgColor) },
                };
            }
            if (col.width > 0) sheet.getColumn(ci + 2).width = Math.max(8, col.width / 8);
        });

        rows.forEach((row, ri) => {
            const header = sheet.getCell(ri + 2, 1);
            header.value = row.label || '';
            if (row.headerBgColor || row.bgColor) {
                header.fill = {
                    type: 'pattern',
                    pattern: 'solid',
                    fgColor: { argb: cssToArgb(row.headerBgColor || row.bgColor) },
                };
            }
            if (row.height > 0) sheet.getRow(ri + 2).height = Math.max(12, row.height * 0.75);

            cols.forEach((col, ci) => {
                const data = page.cells[cellKey(row.id, col.id)];
                const excelCell = sheet.getCell(ri + 2, ci + 2);
                excelCell.value = data?.formula
                    ? { formula: data.formula.replace(/^=/, ''), result: data.content || undefined }
                    : (data?.content ?? '');
                if (data?.bgColor) {
                    excelCell.fill = {
                        type: 'pattern',
                        pattern: 'solid',
                        fgColor: { argb: cssToArgb(data.bgColor) },
                    };
                }
                if (data?.textColor) {
                    excelCell.font = {
                        ...(excelCell.font || {}),
                        color: { argb: cssToArgb(data.textColor) },
                        bold: data.bold,
                        italic: data.italic,
                    };
                } else if (data?.bold || data?.italic) {
                    excelCell.font = {
                        ...(excelCell.font || {}),
                        bold: data.bold,
                        italic: data.italic,
                    };
                }
                if (data?.align) {
                    excelCell.alignment = { horizontal: data.align };
                }
            });
        });

        // Ensure at least a small grid for empty pages
        if (rows.length === 0 && cols.length === 0) {
            sheet.getCell(1, 1).value = '';
        }
    }

    const meta = buildNlMeta(doc, sheetNames);
    const metaSheet = wb.addWorksheet(NL_META_SHEET, { state: 'veryHidden' });
    metaSheet.getCell(1, 1).value = JSON.stringify(meta);

    const buffer = await wb.xlsx.writeBuffer();
    if (buffer instanceof ArrayBuffer) return buffer;
    const bytes = new Uint8Array(buffer);
    const copy = new Uint8Array(bytes.byteLength);
    copy.set(bytes);
    return copy.buffer;
}

function cssToArgb(css: string): string {
    const raw = (css || '').trim();
    if (!raw) return 'FFFFFFFF';
    let hex = raw.replace(/^#/, '');
    if (hex.length === 3) hex = hex.split('').map(c => c + c).join('');
    if (hex.length === 6) return `FF${hex.toUpperCase()}`;
    if (hex.length === 8) return hex.toUpperCase();
    // rgb(r,g,b)
    const m = raw.match(/rgba?\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)/i);
    if (m) {
        const to = (n: string) => Number(n).toString(16).padStart(2, '0');
        return `FF${to(m[1])}${to(m[2])}${to(m[3])}`.toUpperCase();
    }
    return 'FFFFFFFF';
}

function argbToCss(argb?: string): string {
    if (!argb || argb.length < 6) return '';
    const hex = argb.length === 8 ? argb.slice(2) : argb;
    return `#${hex.toLowerCase()}`;
}

/** Decode xlsx ArrayBuffer → ConceptGridDocument. */
export async function decodePlotGridXlsx(data: ArrayBuffer | Uint8Array): Promise<ConceptGridDocument> {
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(data);

    let meta: PlotGridNlMeta | null = null;
    const metaWs = wb.getWorksheet(NL_META_SHEET);
    if (metaWs) {
        const raw = metaWs.getCell(1, 1).value;
        const text = typeof raw === 'string'
            ? raw
            : (raw && typeof raw === 'object' && 'text' in raw ? String((raw as { text: string }).text) : '');
        if (text) {
            try {
                meta = JSON.parse(text) as PlotGridNlMeta;
            } catch { /* ignore corrupt meta */ }
        }
    }

    const pages: ConceptGridPage[] = [];
    const usedIds = new Set<string>();

    wb.eachSheet((sheet) => {
        if (sheet.name === NL_META_SHEET) return;
        const pageId = meta?.pageIds?.[sheet.name]
            || `page-${sheet.name}-${Date.now().toString(36)}`;
        const stableId = usedIds.has(pageId) ? `${pageId}-${pages.length}` : pageId;
        usedIds.add(stableId);

        const pageMeta = meta?.pages?.[stableId] || meta?.pages?.[pageId];
        const columns: ColumnMeta[] = pageMeta?.columns?.length
            ? pageMeta.columns.map(c => ({ ...c }))
            : [];
        const rows: RowMeta[] = pageMeta?.rows?.length
            ? pageMeta.rows.map(r => ({ ...r }))
            : [];

        // Discover grid size from sheet
        const rowCount = Math.max(sheet.rowCount || 0, rows.length + 1);
        const colCount = Math.max(sheet.columnCount || 0, columns.length + 1);

        // If meta missing column/row defs, rebuild from header labels
        if (columns.length === 0) {
            for (let ci = 2; ci <= colCount; ci++) {
                const label = cellValueText(sheet.getCell(1, ci).value).trim();
                if (!label && ci > 2) continue;
                columns.push({
                    id: `col-${ci - 2}-${Date.now().toString(36)}`,
                    label: label || `Col ${ci - 1}`,
                    width: 120,
                    bgColor: '',
                });
            }
        }
        if (rows.length === 0) {
            for (let ri = 2; ri <= rowCount; ri++) {
                const label = cellValueText(sheet.getCell(ri, 1).value).trim();
                const hasData = columns.some((_, ci) => {
                    const v = sheet.getCell(ri, ci + 2).value;
                    return cellValueText(v).trim() !== '';
                });
                if (!label && !hasData && ri > 2) continue;
                rows.push({
                    id: `row-${ri - 2}-${Date.now().toString(36)}`,
                    label: label || `Row ${ri - 1}`,
                    height: 32,
                    bgColor: '',
                });
            }
        }

        // Sync header labels from sheet (Excel may have renamed them)
        columns.forEach((col, ci) => {
            const v = sheet.getCell(1, ci + 2).value;
            const label = cellValueText(v).trim();
            if (label) col.label = label;
        });
        rows.forEach((row, ri) => {
            const v = sheet.getCell(ri + 2, 1).value;
            const label = cellValueText(v).trim();
            if (label) row.label = label;
        });

        const cells: Record<string, CellData> = {};
        rows.forEach((row, ri) => {
            columns.forEach((col, ci) => {
                const key = cellKey(row.id, col.id);
                const excelCell = sheet.getCell(ri + 2, ci + 2);
                const rawValue = excelCell.value;
                const formulaValue = rawValue && typeof rawValue === 'object' && 'formula' in rawValue
                    ? rawValue as ExcelJS.CellFormulaValue
                    : null;
                const content = formulaValue
                    ? cellValueText(formulaValue.result)
                    : cellValueText(rawValue);
                const saved = pageMeta?.cells?.[key];
                const fill = excelCell.fill && excelCell.fill.type === 'pattern'
                    ? argbToCss(excelCell.fill.fgColor?.argb)
                    : '';
                cells[key] = defaultCell({
                    id: saved?.id,
                    content,
                    linkedSceneId: saved?.linkedSceneId,
                    formula: formulaValue?.formula ? `=${formulaValue.formula}` : saved?.formula,
                    manualContent: saved?.manualContent,
                    bgColor: fill || saved?.bgColor || '',
                    textColor: saved?.textColor || '',
                    bold: saved?.bold ?? !!excelCell.font?.bold,
                    italic: saved?.italic ?? !!excelCell.font?.italic,
                    align: saved?.align || (excelCell.alignment?.horizontal as CellData['align']) || 'left',
                });
            });
        });

        pages.push({
            id: stableId,
            title: sheet.name,
            rows,
            columns,
            cells,
            zoom: pageMeta?.zoom ?? 1,
            stickyHeaders: pageMeta?.stickyHeaders !== false,
        });
    });

    if (pages.length === 0) {
        return createEmptyConceptGridDocument();
    }

    const preferredActive = meta?.activePageId;
    const activePageId = preferredActive && pages.some(p => p.id === preferredActive)
        ? preferredActive
        : pages[0].id;

    return normalizeConceptGridDocument({
        version: 2,
        pages,
        activePageId,
        sidebarCollapsed: !!meta?.sidebarCollapsed,
    });
}

/** Convert ConceptGridDocument to a minimal Univer IWorkbookData-like snapshot. */
export function documentToUniverWorkbookData(raw: unknown): Record<string, unknown> {
    const doc = normalizeConceptGridDocument(raw);
    const sheets: Record<string, unknown> = {};
    const sheetOrder: string[] = [];

    doc.pages.forEach((page, index) => {
        const id = page.id || `sheet-${index}`;
        sheetOrder.push(id);
        const cellData: Record<number, Record<number, { v: string; f?: string; s?: UniverStyleSnapshot }>> = {};
        const cols = page.columns || [];
        const rows = page.rows || [];

        cellData[0] = cellData[0] || {};
        cellData[0][0] = { v: '' };
        cols.forEach((col, ci) => {
            cellData[0][ci + 1] = {
                v: col.label || '',
                s: {
                    bg: (col.headerBgColor || col.bgColor) ? { rgb: col.headerBgColor || col.bgColor } : undefined,
                    cl: col.textColor ? { rgb: col.textColor } : undefined,
                    bl: col.bold ? 1 : undefined,
                    it: col.italic ? 1 : undefined,
                    ht: 2,
                },
            };
        });
        rows.forEach((row, ri) => {
            cellData[ri + 1] = cellData[ri + 1] || {};
            cellData[ri + 1][0] = {
                v: row.label || '',
                s: {
                    bg: (row.headerBgColor || row.bgColor) ? { rgb: row.headerBgColor || row.bgColor } : undefined,
                    cl: row.textColor ? { rgb: row.textColor } : undefined,
                    bl: row.bold ? 1 : undefined,
                    it: row.italic ? 1 : undefined,
                    ht: 2,
                },
            };
            cols.forEach((col, ci) => {
                const data = page.cells[cellKey(row.id, col.id)];
                cellData[ri + 1][ci + 1] = {
                    v: data?.content || '',
                    f: data?.formula,
                    s: {
                        bg: data?.bgColor ? { rgb: data.bgColor } : undefined,
                        cl: data?.textColor ? { rgb: data.textColor } : undefined,
                        bl: data?.bold ? 1 : undefined,
                        it: data?.italic ? 1 : undefined,
                        ht: data?.align === 'center' ? 2 : data?.align === 'right' ? 3 : 1,
                    },
                };
            });
        });

        const rowData: Record<number, { h: number }> = {};
        const columnData: Record<number, { w: number }> = {};
        rows.forEach((row, ri) => {
            if (row.height > 0) rowData[ri + 1] = { h: row.height };
        });
        cols.forEach((col, ci) => {
            if (col.width > 0) columnData[ci + 1] = { w: col.width };
        });

        sheets[id] = {
            id,
            name: page.title || `Page ${index + 1}`,
            tabColor: '',
            hidden: 0,
            rowCount: Math.max(50, rows.length + 20),
            columnCount: Math.max(20, cols.length + 10),
            zoomRatio: page.zoom || 1,
            freeze: page.stickyHeaders === false
                ? { startRow: 0, startColumn: 0, ySplit: 0, xSplit: 0 }
                : { startRow: 1, startColumn: 1, ySplit: 1, xSplit: 1 },
            cellData,
            rowData,
            columnData,
            showCellStatusBar: 0,
            status: 1,
        };
    });

    return {
        id: 'narrativelab-plotgrid',
        name: 'Concept Grid',
        appVersion: 'NarrativeLab',
        locale: 'zhCN',
        styles: {},
        sheetOrder,
        sheets,
        resources: [
            {
                name: 'NARRATIVELAB_PLOTGRID_META',
                data: JSON.stringify(buildNlMeta(doc, doc.pages.map(p => p.title))),
            },
        ],
    };
}

type UniverStyleSnapshot = {
    bg?: { rgb?: string } | null;
    cl?: { rgb?: string } | null;
    bl?: number | boolean | null;
    it?: number | boolean | null;
    ht?: number | null;
};
type UniverCellSnapshot = { v?: unknown; f?: unknown; s?: unknown } | undefined;

function resolveUniverStyle(
    raw: UniverCellSnapshot,
    styles?: Record<string, UniverStyleSnapshot>,
): UniverStyleSnapshot | null {
    if (!raw?.s) return null;
    if (typeof raw.s === 'string') return styles?.[raw.s] || null;
    if (typeof raw.s === 'object') return raw.s;
    return null;
}

/** Merge Univer cellData edits back into ConceptGridDocument (preserves links via existing meta). */
export function mergeUniverCellDataIntoDocument(
    doc: ConceptGridDocument,
    sheetId: string,
    cellData: Record<number, Record<number, UniverCellSnapshot>>,
    styles?: Record<string, UniverStyleSnapshot>,
    rowData?: Record<number, { h?: number; ah?: number }>,
    columnData?: Record<number, { w?: number }>,
): ConceptGridDocument {
    const page = doc.pages.find(p => p.id === sheetId);
    if (!page) return doc;

    // Do NOT expand extents from Univer's sparse/full matrix dump — that grows
    // the model to the sheet's reserved rowCount (e.g. 50) and causes remount loops.
    const cols = page.columns || [];
    const rows = page.rows || [];

    let changed = false;

    rows.forEach((row, index) => {
        const height = rowData?.[index + 1]?.h ?? rowData?.[index + 1]?.ah;
        if (typeof height === 'number' && height > 0 && Math.round(height) !== row.height) {
            row.height = Math.round(height);
            changed = true;
        }
    });
    cols.forEach((col, index) => {
        const width = columnData?.[index + 1]?.w;
        if (typeof width === 'number' && width > 0 && Math.round(width) !== col.width) {
            col.width = Math.round(width);
            changed = true;
        }
    });

    // Update headers
    cols.forEach((col, ci) => {
        const v = cellData[0]?.[ci + 1]?.v;
        if (v == null) return;
        const next = cellValueText(v);
        if (col.label !== next) {
            col.label = next;
            changed = true;
        }
    });
    rows.forEach((row, ri) => {
        const v = cellData[ri + 1]?.[0]?.v;
        if (v == null) return;
        const next = cellValueText(v);
        if (row.label !== next) {
            row.label = next;
            changed = true;
        }
    });

    rows.forEach((row, ri) => {
        cols.forEach((col, ci) => {
            const key = cellKey(row.id, col.id);
            const raw = cellData[ri + 1]?.[ci + 1];
            const existing = page.cells[key] || defaultCell({ id: key });
            // Univer omits emptied cells from sparse snapshots — treat missing as clear
            // when we already had content (full workbook.save() covers all non-empty cells).
            if (!raw || !('v' in raw)) {
                const rowBucket = cellData[ri + 1];
                // Prefer clearing when the row is present but the cell is gone. If the whole
                // row vanished after clearing its last cell, also clear when headers exist
                // (signals a real sheet snapshot rather than an empty stub).
                const headerPresent = cellData[0] != null;
                if ((existing.content || existing.formula) && (rowBucket != null || headerPresent)) {
                    page.cells[key] = {
                        ...existing,
                        id: existing.id || key,
                        content: '',
                        formula: undefined,
                        manualContent: true,
                    };
                    changed = true;
                }
                return;
            }
            const nextContent = cellValueText(raw.v);
            const style = resolveUniverStyle(raw, styles);
            const nextFormula = typeof raw.f === 'string' && raw.f.trim()
                ? (raw.f.startsWith('=') ? raw.f : `=${raw.f}`)
                : undefined;
            const nextCell: CellData = {
                ...existing,
                id: existing.id || key,
                content: nextContent,
                formula: nextFormula,
                manualContent: true,
                bgColor: style ? (style.bg?.rgb || '') : existing.bgColor,
                textColor: style ? (style.cl?.rgb || '') : existing.textColor,
                bold: style?.bl == null ? existing.bold : !!style.bl,
                italic: style?.it == null ? existing.italic : !!style.it,
                align: style?.ht === 2 ? 'center' : style?.ht === 3 ? 'right' : style?.ht === 1 ? 'left' : existing.align,
            };
            if (page.cells[key]
                && existing.content === nextCell.content
                && existing.formula === nextCell.formula
                && existing.bgColor === nextCell.bgColor
                && existing.textColor === nextCell.textColor
                && existing.bold === nextCell.bold
                && existing.italic === nextCell.italic
                && existing.align === nextCell.align) return;
            page.cells[key] = nextCell;
            changed = true;
        });
    });

    if (!changed) return doc;
    return { ...doc, pages: [...doc.pages] };
}

/** Fingerprint of cell display text + headers (for dirty checks). */
export function conceptGridContentFingerprint(doc: ConceptGridDocument): string {
    const parts: string[] = [doc.activePageId || ''];
    for (const page of doc.pages) {
        parts.push(page.id, page.title || '');
        for (const row of page.rows || []) parts.push(`r:${row.id}:${row.label || ''}`);
        for (const col of page.columns || []) parts.push(`c:${col.id}:${col.label || ''}`);
        for (const [key, cell] of Object.entries(page.cells || {})) {
            if (!cell) continue;
            parts.push(`${key}=${cell.content || ''}::${cell.formula || ''}`);
        }
    }
    return parts.join('\n');
}

export function emptyWorkbookDocument(): ConceptGridDocument {
    return createEmptyConceptGridDocument();
}

/** Ensure page has matching row/col slots when adding from Univer UI. */
export function ensureGridExtents(
    page: ConceptGridPage,
    maxRowIndex: number,
    maxColIndex: number,
): void {
    // maxRowIndex/maxColIndex are 0-based including header at 0
    while (page.columns.length < Math.max(0, maxColIndex)) {
        page.columns.push({
            id: `col-${Date.now().toString(36)}-${page.columns.length}`,
            label: `Col ${page.columns.length + 1}`,
            width: 120,
            bgColor: '',
            sourceType: 'manual',
        });
    }
    while (page.rows.length < Math.max(0, maxRowIndex)) {
        page.rows.push({
            id: `row-${Date.now().toString(36)}-${page.rows.length}`,
            label: `Row ${page.rows.length + 1}`,
            height: 32,
            bgColor: '',
            sourceType: 'manual',
        });
    }
}
