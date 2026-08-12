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
        frozenColumns?: number;
        frozenRows?: number;
        rows: RowMeta[];
        columns: ColumnMeta[];
        cells: Record<string, Pick<CellData, 'id' | 'linkedSceneId' | 'linkedViaWikilink' | 'formula' | 'manualContent' | 'bgColor' | 'textColor' | 'bold' | 'italic' | 'align'>>;
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

type UniverTextStyle = {
    bl?: 0 | 1;
    it?: 0 | 1;
    ul?: { s: 0 | 1 };
    st?: { s: 0 | 1 };
    cl?: { rgb: string };
    bg?: { rgb: string };
    ff?: string;
};

type UniverTextRun = { st: number; ed: number; ts: UniverTextStyle };
type RichSegment = { text: string; style: UniverTextStyle };

export const PLOTGRID_SOURCE_FIELD = 'narrativeLabSource';

function decodeHtmlEntities(value: string): string {
    const named: Record<string, string> = {
        amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: '\u00a0',
    };
    return value.replace(/&(#x[\da-f]+|#\d+|[a-z]+);/gi, (match, entity: string) => {
        if (entity[0] === '#') {
            const hex = entity[1]?.toLowerCase() === 'x';
            const point = Number.parseInt(entity.slice(hex ? 2 : 1), hex ? 16 : 10);
            return Number.isFinite(point) ? String.fromCodePoint(point) : match;
        }
        return named[entity.toLowerCase()] ?? match;
    });
}

function mergeTextStyle(base: UniverTextStyle, patch: UniverTextStyle): UniverTextStyle {
    return { ...base, ...patch };
}

function markdownSegments(source: string, inherited: UniverTextStyle, linkColor: string): RichSegment[] {
    const segments: RichSegment[] = [];
    const input = source.replace(/!\[([^\]]*)\]\([^)]*\)/g, '$1');
    const token = /\[\[([^\]|#]+)(?:#[^\]|]+)?(?:\|([^\]]+))?\]\]|\[([^\]]+)\]\(([^)]*)\)|\*\*([^*]+)\*\*|__([^_]+)__|~~([^~]+)~~|==([^=]+)==|`([^`]+)`|\*([^*\n]+)\*|_([^_\n]+)_/g;
    let cursor = 0;
    let match: RegExpExecArray | null;
    const append = (text: string, style: UniverTextStyle = inherited) => {
        if (text) segments.push({ text: decodeHtmlEntities(text), style });
    };
    const appendParsed = (text: string, style: UniverTextStyle) => {
        segments.push(...markdownSegments(text, style, linkColor));
    };
    while ((match = token.exec(input))) {
        append(input.slice(cursor, match.index));
        if (match[1]) append(match[2] || match[1], mergeTextStyle(inherited, { cl: { rgb: linkColor } }));
        else if (match[3]) append(match[3], mergeTextStyle(inherited, { cl: { rgb: linkColor }, ul: { s: 1 } }));
        else if (match[5] || match[6]) appendParsed(match[5] || match[6] || '', mergeTextStyle(inherited, { bl: 1 }));
        else if (match[7]) appendParsed(match[7], mergeTextStyle(inherited, { st: { s: 1 } }));
        else if (match[8]) appendParsed(match[8], mergeTextStyle(inherited, { bg: { rgb: '#fff3a3' } }));
        else if (match[9]) append(match[9], mergeTextStyle(inherited, { ff: 'monospace', bg: { rgb: '#ececec' } }));
        else appendParsed(match[10] || match[11] || '', mergeTextStyle(inherited, { it: 1 }));
        cursor = match.index + match[0].length;
    }
    append(input.slice(cursor));
    return segments;
}

function styleFromHtmlTag(tagSource: string, current: UniverTextStyle, linkColor: string): UniverTextStyle {
    const tag = tagSource.match(/^<\s*([\w-]+)/)?.[1]?.toLowerCase() || '';
    let next = { ...current };
    if (tag === 'b' || tag === 'strong') next.bl = 1;
    if (tag === 'i' || tag === 'em') next.it = 1;
    if (tag === 's' || tag === 'del' || tag === 'strike') next.st = { s: 1 };
    if (tag === 'u') next.ul = { s: 1 };
    if (tag === 'mark') next.bg = { rgb: '#fff3a3' };
    if (tag === 'code') {
        next.ff = 'monospace';
        next.bg = { rgb: '#ececec' };
    }
    if (tag === 'a') {
        next.cl = { rgb: linkColor };
        next.ul = { s: 1 };
    }
    const css = tagSource.match(/\sstyle\s*=\s*["']([^"']*)["']/i)?.[1] || '';
    for (const declaration of css.split(';')) {
        const [rawName, ...rawValue] = declaration.split(':');
        const name = rawName?.trim().toLowerCase();
        const value = rawValue.join(':').trim();
        if (!name || !value) continue;
        if (name === 'font-weight' && (value === 'bold' || Number.parseInt(value, 10) >= 600)) next.bl = 1;
        else if (name === 'font-style' && value === 'italic') next.it = 1;
        else if (name === 'color') next.cl = { rgb: value };
        else if (name === 'background' || name === 'background-color') next.bg = { rgb: value };
        else if (name === 'font-family') next.ff = value.replace(/["']/g, '');
        else if (name === 'text-decoration' && value.includes('underline')) next.ul = { s: 1 };
        else if (name === 'text-decoration' && value.includes('line-through')) next.st = { s: 1 };
    }
    return next;
}

/** Convert Markdown/HTML source to Univer's native rich-text cell document. */
export function plotGridSourceToUniverRichText(source: string, linkColor = '#5e6ad2'): {
    displayText: string;
    cellDocument: Record<string, unknown>;
} {
    const normalized = String(source || '')
        .replace(/\r\n?/g, '\n')
        .replace(/<br\s*\/?>/gi, '\n')
        .replace(/<\/(?:p|div|section|article|h[1-6]|li|blockquote)>/gi, '$&\n');
    const segments: RichSegment[] = [];
    const stack: Array<{ tag: string; style: UniverTextStyle }> = [{ tag: '', style: {} }];
    const chunks = normalized.match(/<\/?[A-Za-z][^>]*>|[^<]+|</g) || [];
    for (const chunk of chunks) {
        if (!/^<\/?[A-Za-z]/.test(chunk)) {
            segments.push(...markdownSegments(chunk, stack.at(-1)?.style ?? {}, linkColor));
            continue;
        }
        if (/^<\//.test(chunk)) {
            const closing = chunk.match(/^<\/\s*([\w-]+)/)?.[1]?.toLowerCase() || '';
            for (let index = stack.length - 1; index > 0; index -= 1) {
                const popped = stack.pop();
                if (popped?.tag === closing) break;
            }
            continue;
        }
        if (/^<\s*(?:br|hr)\b/i.test(chunk)) continue;
        const tag = chunk.match(/^<\s*([\w-]+)/)?.[1]?.toLowerCase() || '';
        if (!tag || /\/$/.test(chunk.trim())) continue;
        stack.push({ tag, style: styleFromHtmlTag(chunk, stack.at(-1)?.style ?? {}, linkColor) });
    }

    // Clean Markdown block prefixes while retaining the cell's line breaks.
    const joined: RichSegment[] = [];
    for (const segment of segments) {
        let text = segment.text;
        if (joined.length === 0 || joined.at(-1)?.text.endsWith('\n')) {
            text = text.replace(/^\s*(?:#{1,6}|>|[-+*]|\d+\.)\s+/, '');
        }
        if (text) joined.push({ ...segment, text });
    }
    const displayText = joined.map(item => item.text).join('');
    const textRuns: UniverTextRun[] = [];
    let offset = 0;
    for (const segment of joined) {
        const length = segment.text.length;
        if (length > 0 && Object.keys(segment.style).length > 0) {
            textRuns.push({ st: offset, ed: offset + length, ts: segment.style });
        }
        offset += length;
    }
    const dataStream = `${displayText.replace(/\n/g, '\r')}\r\n`;
    const paragraphs: Array<{ startIndex: number }> = [];
    for (let index = 0; index < dataStream.length; index += 1) {
        if (dataStream[index] === '\r') paragraphs.push({ startIndex: index });
    }
    return {
        displayText,
        cellDocument: {
            id: `nl-rich-${Math.random().toString(36).slice(2, 10)}`,
            body: {
                dataStream,
                textRuns,
                paragraphs,
                customBlocks: [],
                customRanges: [],
                customDecorations: [],
                sectionBreaks: [],
                tables: [],
            },
            drawings: {},
            drawingsOrder: [],
            documentStyle: {},
        },
    };
}

function univerDocumentPlainText(value: unknown): string {
    if (!value || typeof value !== 'object') return '';
    const body = (value as { body?: { dataStream?: unknown } }).body;
    if (typeof body?.dataStream !== 'string') return '';
    return body.dataStream
        .replace(/\0$/, '')
        .replace(/\r\n$/, '')
        .replace(/\r/g, '\n');
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
        linkedViaWikilink: partial?.linkedViaWikilink,
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
                id: key,
                linkedSceneId: cell.linkedSceneId,
                linkedViaWikilink: cell.linkedViaWikilink,
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
            frozenColumns: page.frozenColumns,
            frozenRows: page.frozenRows,
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
            : { views: [{
                state: 'frozen',
                xSplit: Math.max(1, page.frozenColumns ?? 1),
                ySplit: Math.max(1, page.frozenRows ?? 1),
            }] });

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
        return `FF${to(m[1] ?? '0')}${to(m[2] ?? '0')}${to(m[3] ?? '0')}`.toUpperCase();
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
                    id: key,
                    content,
                    linkedSceneId: saved?.linkedSceneId,
                    linkedViaWikilink: saved?.linkedViaWikilink,
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
            frozenColumns: Math.max(1, Math.floor(
                pageMeta?.frozenColumns
                ?? (sheet.views?.[0] as { xSplit?: number } | undefined)?.xSplit
                ?? 1,
            )),
            frozenRows: Math.max(1, Math.floor(
                pageMeta?.frozenRows
                ?? (sheet.views?.[0] as { ySplit?: number } | undefined)?.ySplit
                ?? 1,
            )),
        });
    });

    if (pages.length === 0) {
        return createEmptyConceptGridDocument();
    }

    const preferredActive = meta?.activePageId;
    const firstPage = pages[0];
    if (!firstPage) return createEmptyConceptGridDocument();
    const activePageId = preferredActive && pages.some(p => p.id === preferredActive)
        ? preferredActive
        : firstPage.id;

    return normalizeConceptGridDocument({
        version: 2,
        pages,
        activePageId,
        sidebarCollapsed: !!meta?.sidebarCollapsed,
    });
}

/** Convert ConceptGridDocument to a minimal Univer IWorkbookData-like snapshot. */
export function documentToUniverWorkbookData(
    raw: unknown,
    options: { linkColor?: string; richText?: boolean } = {},
): Record<string, unknown> {
    const doc = normalizeConceptGridDocument(raw);
    const sheets: Record<string, unknown> = {};
    const sheetOrder: string[] = [];

    doc.pages.forEach((page, index) => {
        const id = page.id || `sheet-${index}`;
        sheetOrder.push(id);
        const cellData: Record<number, Record<number, {
            v: string;
            f?: string;
            p?: Record<string, unknown>;
            custom?: Record<string, unknown>;
            s?: UniverStyleSnapshot;
        }>> = {};
        const cols = page.columns || [];
        const rows = page.rows || [];

        const headerRow = cellData[0] ?? (cellData[0] = {});
        headerRow[0] = { v: '' };
        cols.forEach((col, ci) => {
            headerRow[ci + 1] = {
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
            const bodyRow = cellData[ri + 1] ?? (cellData[ri + 1] = {});
            bodyRow[0] = {
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
                const source = data?.content || '';
                const rich = !data?.formula && source
                    ? plotGridSourceToUniverRichText(source, options.linkColor)
                    : null;
                bodyRow[ci + 1] = {
                    // `p` is rendered and edited by Univer itself. The canonical
                    // Markdown/HTML source remains in `custom` for round trips.
                    v: rich?.displayText ?? source,
                    f: data?.formula,
                    p: options.richText === false ? undefined : rich?.cellDocument,
                    custom: source ? { [PLOTGRID_SOURCE_FIELD]: source } : undefined,
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
                : {
                    startRow: Math.max(1, page.frozenRows ?? 1),
                    startColumn: Math.max(1, page.frozenColumns ?? 1),
                    ySplit: Math.max(1, page.frozenRows ?? 1),
                    xSplit: Math.max(1, page.frozenColumns ?? 1),
                },
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
type UniverCellSnapshot = {
    v?: unknown;
    f?: unknown;
    p?: unknown;
    custom?: Record<string, unknown>;
    s?: unknown;
} | undefined;

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
            if (!raw || (!('v' in raw) && !('p' in raw))) {
                const rowBucket = cellData[ri + 1];
                // Prefer clearing when the row is present but the cell is gone. If the whole
                // row vanished after clearing its last cell, also clear when headers exist
                // (signals a real sheet snapshot rather than an empty stub).
                const headerPresent = cellData[0] != null;
                if ((existing.content || existing.formula) && (rowBucket != null || headerPresent)) {
                    page.cells[key] = {
                        ...existing,
                        id: key,
                        content: '',
                        formula: undefined,
                        manualContent: true,
                    };
                    changed = true;
                }
                return;
            }
            const richText = univerDocumentPlainText(raw.p);
            const displayText = richText || cellValueText(raw.v);
            const storedSource = typeof raw.custom?.[PLOTGRID_SOURCE_FIELD] === 'string'
                ? raw.custom[PLOTGRID_SOURCE_FIELD]
                : '';
            // Preserve Markdown/HTML while Univer's native rich text still
            // represents it. A direct in-cell edit intentionally becomes plain
            // text; syntax-rich edits belong in the focused cell editor.
            const nextContent = storedSource
                && plotGridSourceToUniverRichText(storedSource).displayText === displayText
                ? storedSource
                : displayText;
            const style = resolveUniverStyle(raw, styles);
            const nextFormula = typeof raw.f === 'string' && raw.f.trim()
                ? (raw.f.startsWith('=') ? raw.f : `=${raw.f}`)
                : undefined;
            const nextCell: CellData = {
                ...existing,
                id: key,
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

/** Mirror Univer row/column drag moves in NarrativeLab metadata (links use row/column ids). */
export function moveConceptGridAxis(
    raw: ConceptGridDocument,
    sheetId: string,
    axis: 'rows' | 'columns',
    worksheetFrom: number,
    worksheetCount: number,
    worksheetTarget: number,
): ConceptGridDocument {
    const doc = structuredClone(raw);
    const page = doc.pages.find(item => item.id === sheetId);
    if (!page || worksheetFrom < 1 || worksheetTarget < 1 || worksheetCount < 1) return doc;
    const items = axis === 'rows' ? page.rows : page.columns;
    const from = worksheetFrom - 1;
    const target = worksheetTarget - 1;
    if (from >= items.length || from + worksheetCount > items.length) return doc;
    if (from <= target && from + worksheetCount > target) return doc;
    const insertion = from > target ? target : target - worksheetCount;
    if (axis === 'rows') {
        const moved = page.rows.splice(from, worksheetCount);
        page.rows.splice(Math.max(0, Math.min(page.rows.length, insertion)), 0, ...moved);
    } else {
        const moved = page.columns.splice(from, worksheetCount);
        page.columns.splice(Math.max(0, Math.min(page.columns.length, insertion)), 0, ...moved);
    }
    return doc;
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
