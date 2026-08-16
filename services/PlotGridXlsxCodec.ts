/**
 * Concept Grid ↔ Excel (.xlsx) codec.
 *
 * Interop layout (Excel / Univer / NarrativeLab):
 * - `Library/datasheet.xlsx` — visible page sheets only (row 0 = column labels,
 *   col 0 = row labels). Safe to open in Microsoft Excel or Univer.
 * - `System/datasheet.nlmeta.json` — NarrativeLab metadata (links, ids, styles),
 *   alongside other System/*.json project files.
 *
 * Legacy workbooks may still embed a veryHidden `_nl_meta` sheet; load migrates
 * that into the sidecar and rewrites a clean xlsx on the next save.
 * A brief-lived `Library/datasheet.nlmeta.json` is also migrated into System/.
 */
import ExcelJS from 'exceljs';

/** Same ArrayBuffer reused across inspect/decode/count — parse Excel once per open. */
let _plotGridWorkbookCache: { data: ArrayBuffer | Uint8Array; wb: ExcelJS.Workbook } | null = null;

async function loadExcelWorkbook(data: ArrayBuffer | Uint8Array): Promise<ExcelJS.Workbook> {
    if (_plotGridWorkbookCache && _plotGridWorkbookCache.data === data) {
        return _plotGridWorkbookCache.wb;
    }
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(data);
    _plotGridWorkbookCache = { data, wb };
    return wb;
}

/** Drop the parsed workbook so the next datasheet open does not keep it resident. */
export function releasePlotGridWorkbookCache(): void {
    _plotGridWorkbookCache = null;
}
import type {
    CellData,
    ColumnMeta,
    ConceptGridDocument,
    ConceptGridPage,
    RowMeta,
    UniverSheetSnapshotExtras,
    UniverWorkbookResource,
} from '../models/PlotGridData';
import {
    createEmptyConceptGridDocument,
    createEmptyConceptGridPage,
    normalizeConceptGridDocument,
    normalizeUniverSheetExtras,
    normalizeUniverStyleMap,
    normalizeUniverWorkbookResources,
} from '../models/PlotGridData';
import { t } from '../utils/i18n';

export const PLOTGRID_XLSX_FILENAME = 'datasheet.xlsx';
/** Sidecar next to datasheet.xlsx — NarrativeLab links / ids / styles. */
export const PLOTGRID_NLMETA_FILENAME = 'datasheet.nlmeta.json';
/** Previous canonical filename under System/ — migrated to Library/datasheet.xlsx */
export const LEGACY_PLOTGRID_XLSX_FILENAME = 'plotgrid.xlsx';
/** Brief-lived subfolder used before settling on System/plotgrid.xlsx */
export const PLOTGRID_FOLDER = 'PlotGrid';
export const NL_META_SHEET = '_nl_meta';
/** Bump when meta cell payload shape changes (v2 stores display `content`). */
const META_SCHEMA = 2;
/** Excel shared-string / cell text hard limit (OOXML). Exceeding it makes Excel repair sharedStrings.xml. */
export const EXCEL_MAX_CELL_CHARS = 32767;

/** Canonical path: `{projectBase}/Library/datasheet.xlsx` */
export function plotGridXlsxPath(projectBaseFolder: string): string {
    const base = projectBaseFolder.replace(/\/+$/, '');
    return `${base}/Library/${PLOTGRID_XLSX_FILENAME}`.replace(/\\/g, '/');
}

/** Canonical sidecar: `{systemFolder}/datasheet.nlmeta.json` */
export function plotGridNlMetaPath(systemFolder: string): string {
    const base = systemFolder.replace(/\/+$/, '');
    return `${base}/${PLOTGRID_NLMETA_FILENAME}`.replace(/\\/g, '/');
}

/** Brief-lived Library sidecar before settling on System/datasheet.nlmeta.json */
export function legacyLibraryPlotGridNlMetaPath(projectBaseFolder: string): string {
    const base = projectBaseFolder.replace(/\/+$/, '');
    return `${base}/Library/${PLOTGRID_NLMETA_FILENAME}`.replace(/\\/g, '/');
}

/** Former canonical path: `{systemFolder}/plotgrid.xlsx` */
export function legacySystemPlotGridXlsxPath(systemFolder: string): string {
    const base = systemFolder.replace(/\/+$/, '');
    return `${base}/${LEGACY_PLOTGRID_XLSX_FILENAME}`.replace(/\\/g, '/');
}

/** Short-lived path: `{systemFolder}/PlotGrid/plotgrid.xlsx` */
export function legacyPlotGridFolderXlsxPath(systemFolder: string): string {
    const base = systemFolder.replace(/\/+$/, '');
    return `${base}/${PLOTGRID_FOLDER}/${LEGACY_PLOTGRID_XLSX_FILENAME}`.replace(/\\/g, '/');
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
    /** Univer plugin snapshots (images, notes, CF, validation, filter…). */
    univerResources?: UniverWorkbookResource[];
    /** Univer workbook.styles registry. */
    univerStyles?: Record<string, unknown>;
    /** sheet name → page id */
    pageIds: Record<string, string>;
    pages: Record<string, {
        id: string;
        zoom?: number;
        stickyHeaders?: boolean;
        frozenColumns?: number;
        frozenRows?: number;
        cornerLabel?: string;
        headerRowHeight?: number;
        labelColumnWidth?: number;
        hidden?: boolean;
        tabColor?: string;
        univerExtras?: UniverSheetSnapshotExtras;
        rows: RowMeta[];
        columns: ColumnMeta[];
        cells: Record<string, Pick<CellData, 'id' | 'linkedSceneId' | 'linkedViaWikilink' | 'formula' | 'manualContent' | 'bgColor' | 'textColor' | 'bold' | 'italic' | 'align' | 'univerStyle'> & {
            /** Canonical cell display / Markdown text (schema ≥ 2). */
            content?: string;
            /** Original Markdown source when the visible xlsx cell stores rendered link text. */
            markdownSource?: string;
        }>;
    }>;
}

export interface PlotGridXlsxEncodeOptions {
    /** Current Obsidian vault name, used to make linked cells clickable from Excel. */
    vaultName?: string;
    /**
     * When true, also embed a veryHidden `_nl_meta` sheet (legacy single-file).
     * Default false — Excel/Univer see only data sheets; NL meta lives in the sidecar.
     */
    embedMetaSheet?: boolean;
}

export interface DecodePlotGridXlsxOptions {
    /** Prefer sidecar / caller-supplied meta over any embedded `_nl_meta`. */
    meta?: PlotGridNlMeta | null;
}

function obsidianOpenUri(linkedPath: string, vaultName?: string): string {
    const params: string[] = [];
    if (vaultName?.trim()) params.push(`vault=${encodeURIComponent(vaultName.trim())}`);
    params.push(`file=${encodeURIComponent(linkedPath.replace(/\\/g, '/'))}`);
    return `obsidian://open?${params.join('&')}`;
}

function obsidianFileFromCellValue(value: unknown): string | undefined {
    if (!value || typeof value !== 'object') return undefined;
    const hyperlink = (value as Record<string, unknown>).hyperlink;
    if (typeof hyperlink !== 'string' || !hyperlink.toLowerCase().startsWith('obsidian://')) return undefined;
    try {
        const uri = new URL(hyperlink);
        if (uri.protocol !== 'obsidian:' || uri.hostname.toLowerCase() !== 'open') return undefined;
        const file = uri.searchParams.get('file')?.trim().replace(/\\/g, '/').replace(/^\/+/, '');
        if (!file) return undefined;
        return /\.[^/]+$/.test(file) ? file : `${file}.md`;
    } catch {
        return undefined;
    }
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

/** Strip characters illegal in XML 1.0 text nodes (keep tab/LF/CR). */
export function sanitizeExcelXmlText(value: string): string {
    // eslint-disable-next-line no-control-regex -- XML 1.0 explicitly forbids these code points.
    return String(value || '').replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, '');
}

/** Clamp a visible cell string to Excel's per-cell limit after XML sanitization. */
export function clampExcelCellText(value: string): string {
    const cleaned = sanitizeExcelXmlText(value);
    return cleaned.length > EXCEL_MAX_CELL_CHARS
        ? cleaned.slice(0, EXCEL_MAX_CELL_CHARS)
        : cleaned;
}

/** Write a JSON blob across column A so no single shared string exceeds Excel's limit. */
export function writeChunkedMetaText(sheet: ExcelJS.Worksheet, text: string): void {
    const payload = sanitizeExcelXmlText(text);
    const chunkSize = EXCEL_MAX_CELL_CHARS;
    if (!payload) {
        sheet.getCell(1, 1).value = '';
        return;
    }
    let row = 1;
    for (let offset = 0; offset < payload.length; offset += chunkSize) {
        sheet.getCell(row, 1).value = payload.slice(offset, offset + chunkSize);
        row += 1;
    }
}

/** Reassemble meta JSON from A1..An (also accepts legacy single-cell blobs). */
export function readChunkedMetaText(sheet: ExcelJS.Worksheet): string {
    const parts: string[] = [];
    const maxRows = Math.max(sheet.rowCount || 0, 1);
    for (let row = 1; row <= maxRows; row++) {
        const part = cellValueText(sheet.getCell(row, 1).value);
        if (!part && row > 1) break;
        if (part) parts.push(part);
        // Legacy / truncated: stop after first empty once we've started collecting
        // (single-cell meta files only use A1).
        if (row === 1 && !part) break;
    }
    return parts.join('');
}

/** True when text looks like a NarrativeLab `_nl_meta` JSON payload. */
export function looksLikeNlMetaJson(text: string): boolean {
    const trimmed = (text || '').trim();
    if (!trimmed.startsWith('{') || !trimmed.includes('"schema"')) return false;
    if (!trimmed.includes('"activePageId"') || !trimmed.includes('"pages"')) return false;
    return true;
}

/** Parse NarrativeLab workbook meta JSON; returns null when invalid. */
export function tryParseNlMeta(text: string): PlotGridNlMeta | null {
    if (!looksLikeNlMetaJson(text)) return null;
    try {
        const parsed = JSON.parse(text) as PlotGridNlMeta;
        if (!parsed || typeof parsed !== 'object') return null;
        if (typeof parsed.schema !== 'number' || !parsed.pages || typeof parsed.pages !== 'object') {
            return null;
        }
        return parsed;
    } catch {
        return null;
    }
}

function sheetLooksLikeNlMetaDump(sheet: ExcelJS.Worksheet): boolean {
    if (sheet.name === NL_META_SHEET) return true;
    const text = readChunkedMetaText(sheet);
    return !!tryParseNlMeta(text);
}

function titleForMetaPage(meta: PlotGridNlMeta, pageId: string): string {
    for (const [sheetName, id] of Object.entries(meta.pageIds || {})) {
        if (id === pageId) return sheetName;
    }
    return meta.pages[pageId]?.id || pageId;
}

/**
 * Rebuild a ConceptGridDocument from `_nl_meta` alone.
 * Used when Excel sheets were wiped/replaced by an external Univer/Excel save.
 */
export function documentFromNlMeta(meta: PlotGridNlMeta): ConceptGridDocument {
    const pageIds = Object.keys(meta.pages || {});
    // Prefer pageIds order when present; otherwise object key order.
    const orderedIds: string[] = [];
    const seen = new Set<string>();
    for (const id of Object.values(meta.pageIds || {})) {
        if (meta.pages[id] && !seen.has(id)) {
            orderedIds.push(id);
            seen.add(id);
        }
    }
    for (const id of pageIds) {
        if (!seen.has(id)) {
            orderedIds.push(id);
            seen.add(id);
        }
    }

    const pages: ConceptGridPage[] = orderedIds.map((pageId) => {
        const pageMeta = meta.pages[pageId];
        const rows = (pageMeta?.rows || []).map(r => ({ ...r }));
        const columns = (pageMeta?.columns || []).map(c => ({ ...c }));
        const cells: Record<string, CellData> = {};
        for (const [key, saved] of Object.entries(pageMeta?.cells || {})) {
            if (!saved) continue;
            cells[key] = defaultCell({
                id: key,
                content: saved.content || saved.markdownSource || '',
                linkedSceneId: saved.linkedSceneId,
                linkedViaWikilink: saved.linkedViaWikilink,
                formula: saved.formula,
                manualContent: saved.manualContent,
                bgColor: saved.bgColor || '',
                textColor: saved.textColor || '',
                bold: saved.bold,
                italic: saved.italic,
                align: saved.align || 'left',
                univerStyle: saved.univerStyle,
            });
        }
        return {
            id: pageId,
            title: titleForMetaPage(meta, pageId),
            rows,
            columns,
            cells,
            zoom: pageMeta?.zoom ?? 1,
            stickyHeaders: pageMeta?.stickyHeaders !== false,
            frozenColumns: Math.max(1, Math.floor(pageMeta?.frozenColumns ?? 1)),
            frozenRows: Math.max(1, Math.floor(pageMeta?.frozenRows ?? 1)),
            cornerLabel: pageMeta?.cornerLabel || '',
            headerRowHeight: typeof pageMeta?.headerRowHeight === 'number' && pageMeta.headerRowHeight > 0
                ? Math.round(pageMeta.headerRowHeight)
                : 0,
            labelColumnWidth: typeof pageMeta?.labelColumnWidth === 'number' && pageMeta.labelColumnWidth > 0
                ? Math.round(pageMeta.labelColumnWidth)
                : 0,
            hidden: pageMeta?.hidden === true,
            tabColor: typeof pageMeta?.tabColor === 'string' ? pageMeta.tabColor : '',
            univerExtras: normalizeUniverSheetExtras(pageMeta?.univerExtras),
        };
    }).filter(page =>
        page.rows.length > 0
        || page.columns.length > 0
        || Object.keys(page.cells).length > 0
        || Boolean(page.univerExtras),
    );

    if (pages.length === 0) return createEmptyConceptGridDocument();

    const activePageId = meta.activePageId && pages.some(p => p.id === meta.activePageId)
        ? meta.activePageId
        : pages[0].id;

    return normalizeConceptGridDocument({
        version: 2,
        pages,
        activePageId,
        sidebarCollapsed: !!meta.sidebarCollapsed,
        univerResources: normalizeUniverWorkbookResources(meta.univerResources),
        univerStyles: normalizeUniverStyleMap(meta.univerStyles),
    });
}

/**
 * True when an external Univer/Excel open+save replaced NarrativeLab sheets with
 * meta JSON dumps (or unrelated empty sheets), or when a legacy `_nl_meta` sheet
 * is still embedded (should migrate to the sidecar).
 */
export async function plotGridXlsxNeedsRewrite(data: ArrayBuffer | Uint8Array): Promise<boolean> {
    const wb = await loadExcelWorkbook(data);

    if (wb.getWorksheet(NL_META_SHEET)) return true;

    const parsedMeta: PlotGridNlMeta[] = [];
    wb.eachSheet((sheet) => {
        if (parsedMeta.length > 0) return;
        const candidate = tryParseNlMeta(readChunkedMetaText(sheet));
        if (candidate) parsedMeta.push(candidate);
    });
    const meta = parsedMeta[0] ?? null;
    if (!meta || Object.keys(meta.pages || {}).length === 0) return false;

    let dataSheetCount = 0;
    let metaDumpCount = 0;
    let titlesOverlap = false;
    wb.eachSheet((sheet) => {
        if (sheetLooksLikeNlMetaDump(sheet)) {
            metaDumpCount += 1;
            return;
        }
        dataSheetCount += 1;
        if (meta?.pageIds?.[sheet.name]) titlesOverlap = true;
    });

    if (dataSheetCount === 0 && metaDumpCount > 0) return true;
    if (metaDumpCount > 0 && !titlesOverlap) return true;
    return false;
}

/** Count non-empty data cells in visible (non-meta) Excel sheets. */
export async function countPlotGridXlsxFilledCells(
    data: ArrayBuffer | Uint8Array,
): Promise<number> {
    const wb = await loadExcelWorkbook(data);
    let count = 0;
    wb.eachSheet((sheet) => {
        if (sheetLooksLikeNlMetaDump(sheet)) return;
        sheet.eachRow((row, rowNumber) => {
            row.eachCell((cell, colNumber) => {
                // Skip corner + header labels when counting "body" richness? Keep all —
                // headers alone are weak signal; body cells dominate.
                if (rowNumber === 1 || colNumber === 1) return;
                const text = cellValueText(cell.value).trim();
                if (text) count += 1;
            });
        });
    });
    return count;
}

/** Read NarrativeLab meta from an embedded `_nl_meta` sheet or a JSON dump sheet. */
export async function extractEmbeddedNlMeta(
    data: ArrayBuffer | Uint8Array,
): Promise<PlotGridNlMeta | null> {
    const wb = await loadExcelWorkbook(data);
    const metaWs = wb.getWorksheet(NL_META_SHEET);
    if (metaWs) {
        const embedded = tryParseNlMeta(readChunkedMetaText(metaWs));
        if (embedded) return embedded;
    }
    let found: PlotGridNlMeta | null = null;
    wb.eachSheet((sheet) => {
        if (found || sheet.name === NL_META_SHEET) return;
        found = tryParseNlMeta(readChunkedMetaText(sheet));
    });
    return found;
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

type UniverStyleSnapshot = {
    bg?: { rgb?: string } | null;
    cl?: { rgb?: string } | null;
    bl?: number | boolean | null;
    it?: number | boolean | null;
    ht?: number | null;
    [key: string]: unknown;
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
    if (typeof raw.s === 'object') return raw.s as UniverStyleSnapshot;
    return null;
}

function cloneStyleObject(style: UniverStyleSnapshot | Record<string, unknown> | null | undefined): Record<string, unknown> | undefined {
    if (!style || typeof style !== 'object') return undefined;
    try {
        return JSON.parse(JSON.stringify(style)) as Record<string, unknown>;
    } catch {
        return undefined;
    }
}

function mergeOwnedUniverCellStyle(data?: CellData): UniverStyleSnapshot {
    const base = cloneStyleObject(data?.univerStyle) || {};
    return {
        ...base,
        bg: data?.bgColor ? { rgb: data.bgColor } : (base.bg as UniverStyleSnapshot['bg']),
        cl: data?.textColor ? { rgb: data.textColor } : (base.cl as UniverStyleSnapshot['cl']),
        bl: data?.bold ? 1 : 0,
        it: data?.italic ? 1 : 0,
        ht: data?.align === 'center' ? 2 : data?.align === 'right' ? 3 : 1,
    };
}

function axisFlagsAt(
    flags: Record<string, Record<string, unknown>> | undefined,
    index: number,
): Record<string, unknown> | undefined {
    if (!flags) return undefined;
    return flags[String(index)] || flags[index as unknown as string];
}

function extractAxisFlags(
    data: Record<number, Record<string, unknown>> | undefined,
): Record<string, Record<string, unknown>> | undefined {
    if (!data) return undefined;
    const next: Record<string, Record<string, unknown>> = {};
    for (const [key, raw] of Object.entries(data)) {
        if (!raw || typeof raw !== 'object') continue;
        const flags: Record<string, unknown> = {};
        if (raw.hd != null) flags.hd = raw.hd;
        if (raw.s != null) flags.s = raw.s;
        if (raw.custom != null) flags.custom = raw.custom;
        if (Object.keys(flags).length) next[key] = flags;
    }
    return Object.keys(next).length ? next : undefined;
}

export function extractUniverSheetExtras(sheet: Record<string, unknown> | UniverSheetChromeSnapshot | undefined): UniverSheetSnapshotExtras | undefined {
    if (!sheet) return undefined;
    return normalizeUniverSheetExtras({
        mergeData: sheet.mergeData,
        defaultColumnWidth: sheet.defaultColumnWidth,
        defaultRowHeight: sheet.defaultRowHeight,
        defaultStyle: sheet.defaultStyle,
        rowHeader: sheet.rowHeader,
        columnHeader: sheet.columnHeader,
        showGridlines: sheet.showGridlines,
        gridlinesColor: sheet.gridlinesColor,
        rightToLeft: sheet.rightToLeft,
        custom: sheet.custom,
        rowFlags: extractAxisFlags(sheet.rowData as Record<number, Record<string, unknown>> | undefined),
        columnFlags: extractAxisFlags(sheet.columnData as Record<number, Record<string, unknown>> | undefined),
    });
}

export function applyUniverFreezeToPage(page: ConceptGridPage, freeze: unknown): boolean {
    if (!freeze || typeof freeze !== 'object') return false;
    const raw = freeze as { startRow?: unknown; startColumn?: unknown; ySplit?: unknown; xSplit?: unknown };
    const y = Number(raw.ySplit ?? raw.startRow ?? 0);
    const x = Number(raw.xSplit ?? raw.startColumn ?? 0);
    if (!Number.isFinite(y) || !Number.isFinite(x)) return false;
    let changed = false;
    if (y <= 0 && x <= 0) {
        if (page.stickyHeaders !== false) {
            page.stickyHeaders = false;
            changed = true;
        }
        return changed;
    }
    if (page.stickyHeaders === false) {
        page.stickyHeaders = true;
        changed = true;
    }
    const frozenRows = Math.max(1, Math.floor(y || 1));
    const frozenColumns = Math.max(1, Math.floor(x || 1));
    if (page.frozenRows !== frozenRows) {
        page.frozenRows = frozenRows;
        changed = true;
    }
    if (page.frozenColumns !== frozenColumns) {
        page.frozenColumns = frozenColumns;
        changed = true;
    }
    return changed;
}

function applyExcelMerges(
    sheet: ExcelJS.Worksheet,
    extras: UniverSheetSnapshotExtras | undefined,
    maxRow: number,
    maxCol: number,
): void {
    for (const item of extras?.mergeData || []) {
        if (!item || typeof item !== 'object') continue;
        const range = item as { startRow?: unknown; endRow?: unknown; startColumn?: unknown; endColumn?: unknown };
        const startRow = Number(range.startRow);
        const endRow = Number(range.endRow ?? range.startRow);
        const startCol = Number(range.startColumn);
        const endCol = Number(range.endColumn ?? range.startColumn);
        if (![startRow, endRow, startCol, endCol].every(Number.isFinite)) continue;
        if (endRow < startRow || endCol < startCol) continue;
        // Merges past the written grid inflate Excel rowCount and look like new NL rows.
        if (startRow > maxRow || startCol > maxCol) continue;
        try {
            sheet.mergeCells(
                startRow + 1,
                startCol + 1,
                Math.min(endRow, maxRow) + 1,
                Math.min(endCol, maxCol) + 1,
            );
        } catch { /* overlapping / already merged */ }
    }
}

function excelA1ToUniverCell(a1: string): { row: number; col: number } | null {
    const match = /^([A-Z]+)(\d+)$/i.exec(a1.trim());
    if (!match) return null;
    let col = 0;
    for (const ch of match[1].toUpperCase()) col = col * 26 + (ch.charCodeAt(0) - 64);
    const row = Number(match[2]);
    if (!Number.isFinite(row) || row < 1 || col < 1) return null;
    return { row: row - 1, col: col - 1 };
}

function excelMergesToUniver(sheet: ExcelJS.Worksheet): unknown[] | undefined {
    const refs = (sheet as ExcelJS.Worksheet & { model?: { merges?: string[] } }).model?.merges;
    if (!Array.isArray(refs) || refs.length === 0) return undefined;
    const merges: unknown[] = [];
    for (const ref of refs) {
        if (typeof ref !== 'string' || !ref.includes(':')) continue;
        const [startRef, endRef] = ref.split(':');
        const start = excelA1ToUniverCell(startRef || '');
        const end = excelA1ToUniverCell(endRef || '');
        if (!start || !end) continue;
        merges.push({
            startRow: Math.min(start.row, end.row),
            endRow: Math.max(start.row, end.row),
            startColumn: Math.min(start.col, end.col),
            endColumn: Math.max(start.col, end.col),
        });
    }
    return merges.length ? merges : undefined;
}

/** Prefer Univer rich-text `p` (live edits) over plain `v`. Null when neither is present. */
function univerCellPlainText(raw: UniverCellSnapshot | null): string | null {
    if (!raw || (!('v' in raw) && !('p' in raw))) return null;
    // An explicit empty `v` is a committed clear (Delete / Backspace / unlink).
    // Univer often leaves a stale `p` document behind; that must not resurrect text.
    if ('v' in raw && cellValueText(raw.v) === '') return '';
    const richText = univerDocumentPlainText(raw.p);
    return richText || cellValueText(raw.v);
}

function univerCellHasPersistableValue(raw: UniverCellSnapshot | null | undefined): boolean {
    if (!raw) return false;
    if (typeof raw.f === 'string' && raw.f.trim()) return true;
    const text = univerCellPlainText(raw);
    return Boolean(text && text.trim());
}

/** Grow NL axes to cover typed Univer cells. Empty reserved matrix cells do not count. */
function ensureOccupiedGridExtents(
    page: ConceptGridPage,
    cellData: Record<number, Record<number, UniverCellSnapshot>>,
): boolean {
    let maxRow = 0;
    let maxCol = 0;
    for (const [rowKey, bucket] of Object.entries(cellData || {})) {
        const row = Number(rowKey);
        if (!Number.isFinite(row) || !bucket) continue;
        for (const [colKey, raw] of Object.entries(bucket)) {
            const col = Number(colKey);
            if (!Number.isFinite(col) || !univerCellHasPersistableValue(raw)) continue;
            if (row > maxRow) maxRow = row;
            if (col > maxCol) maxCol = col;
        }
    }
    if (maxRow <= 0 && maxCol <= 0) return false;
    const beforeRows = page.rows.length;
    const beforeCols = page.columns.length;
    ensureGridExtents(page, maxRow, maxCol);
    return page.rows.length !== beforeRows || page.columns.length !== beforeCols;
}

/** Apply Univer cell style onto a row/column header meta (label cells at row0/col0). */
function applyHeaderStyleFromUniver(
    target: {
        headerBgColor?: string;
        textColor?: string;
        bold?: boolean;
        italic?: boolean;
    },
    raw: UniverCellSnapshot | null,
    styles?: Record<string, UniverStyleSnapshot>,
): boolean {
    if (!raw) return false;
    const style = resolveUniverStyle(raw, styles);
    if (!style) return false;
    let changed = false;
    const bg = style.bg?.rgb || '';
    if ((target.headerBgColor || '') !== bg) {
        target.headerBgColor = bg;
        changed = true;
    }
    const text = style.cl?.rgb || '';
    if ((target.textColor || '') !== text) {
        target.textColor = text;
        changed = true;
    }
    const bold = !!(style.bl);
    if (!!target.bold !== bold) {
        target.bold = bold;
        changed = true;
    }
    const italic = !!(style.it);
    if (!!target.italic !== italic) {
        target.italic = italic;
        changed = true;
    }
    return changed;
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
        univerStyle: partial?.univerStyle,
    };
}

/** Build NL meta from a ConceptGridDocument (includes cell display text for recovery). */
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
                content: cell.content || '',
                linkedSceneId: cell.linkedSceneId,
                linkedViaWikilink: cell.linkedViaWikilink,
                markdownSource: cell.linkedSceneId ? cell.content : undefined,
                formula: cell.formula,
                manualContent: cell.manualContent,
                bgColor: cell.bgColor,
                textColor: cell.textColor,
                bold: cell.bold,
                italic: cell.italic,
                align: cell.align,
                univerStyle: cell.univerStyle,
            };
        }
        pages[page.id] = {
            id: page.id,
            zoom: page.zoom,
            stickyHeaders: page.stickyHeaders,
            frozenColumns: page.frozenColumns,
            frozenRows: page.frozenRows,
            cornerLabel: page.cornerLabel || '',
            headerRowHeight: page.headerRowHeight || 0,
            labelColumnWidth: page.labelColumnWidth || 0,
            hidden: page.hidden === true,
            tabColor: page.tabColor || '',
            univerExtras: normalizeUniverSheetExtras(page.univerExtras),
            rows: page.rows.map(r => ({ ...r })),
            columns: page.columns.map(c => ({ ...c })),
            cells,
        };
    });
    return {
        schema: META_SCHEMA,
        activePageId: doc.activePageId,
        sidebarCollapsed: doc.sidebarCollapsed,
        univerResources: normalizeUniverWorkbookResources(doc.univerResources),
        univerStyles: normalizeUniverStyleMap(doc.univerStyles),
        pageIds,
        pages,
    };
}

/** Stable Excel sheet names for each Concept Grid page (matches encode). */
export function sheetNamesForDocument(raw: unknown): string[] {
    const doc = normalizeConceptGridDocument(raw);
    const usedNames = new Set<string>();
    return doc.pages.map(page => sanitizeSheetName(page.title, usedNames));
}

/** Build sidecar / embeddable meta for a document. */
export function buildNlMetaForDocument(raw: unknown): PlotGridNlMeta {
    const doc = normalizeConceptGridDocument(raw);
    return buildNlMeta(doc, sheetNamesForDocument(doc));
}

/** Pretty-printed sidecar JSON for System/datasheet.nlmeta.json. */
export function serializePlotGridNlMeta(raw: unknown): string {
    return `${JSON.stringify(buildNlMetaForDocument(raw), null, 2)}\n`;
}

/** Encode ConceptGridDocument → xlsx ArrayBuffer. */
export async function encodePlotGridXlsx(raw: unknown, options: PlotGridXlsxEncodeOptions = {}): Promise<ArrayBuffer> {
    const doc = normalizeConceptGridDocument(raw);
    const wb = new ExcelJS.Workbook();
    wb.creator = 'NarrativeLab';
    wb.created = new Date();

    const usedNames = new Set<string>();
    const sheetNames: string[] = [];

    for (const page of doc.pages) {
        const name = sanitizeSheetName(page.title, usedNames);
        sheetNames.push(name);
        const sheet = wb.addWorksheet(name, {
            state: page.hidden ? 'hidden' : 'visible',
            properties: page.tabColor
                ? { tabColor: { argb: cssToArgb(page.tabColor) } }
                : undefined,
            views: page.stickyHeaders === false
                ? undefined
                : [{
                    state: 'frozen',
                    xSplit: Math.max(1, page.frozenColumns ?? 1),
                    ySplit: Math.max(1, page.frozenRows ?? 1),
                }],
        });

        const cols = page.columns || [];
        const rows = page.rows || [];

        // Header row: corner + column labels
        sheet.getCell(1, 1).value = clampExcelCellText(page.cornerLabel || '');
        if ((page.labelColumnWidth || 0) > 0) {
            sheet.getColumn(1).width = Math.max(8, (page.labelColumnWidth || 0) / 8);
        }
        if ((page.headerRowHeight || 0) > 0) {
            sheet.getRow(1).height = Math.max(12, (page.headerRowHeight || 0) * 0.75);
        }
        cols.forEach((col, ci) => {
            const cell = sheet.getCell(1, ci + 2);
            cell.value = clampExcelCellText(col.label || '');
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
            header.value = clampExcelCellText(row.label || '');
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
                const nativeHyperlink = data?.linkedSceneId && !data.formula
                    ? obsidianOpenUri(data.linkedSceneId, options.vaultName)
                    : '';
                if (data?.formula) {
                    const formulaResult = data.content
                        ? clampExcelCellText(String(data.content))
                        : undefined;
                    excelCell.value = { formula: data.formula.replace(/^=/, ''), result: formulaResult };
                } else if (nativeHyperlink) {
                    const linkText = clampExcelCellText(
                        plotGridSourceToUniverRichText(data.content || '').displayText
                        || data.content
                        || data.linkedSceneId
                        || '',
                    );
                    excelCell.value = {
                        text: linkText,
                        hyperlink: nativeHyperlink,
                        tooltip: clampExcelCellText(data.linkedSceneId || '').slice(0, 255),
                    };
                } else {
                    excelCell.value = clampExcelCellText(data?.content ?? '');
                }
                if (data?.bgColor) {
                    excelCell.fill = {
                        type: 'pattern',
                        pattern: 'solid',
                        fgColor: { argb: cssToArgb(data.bgColor) },
                    };
                }
                if (data?.textColor || nativeHyperlink) {
                    excelCell.font = {
                        ...(excelCell.font || {}),
                        color: { argb: data?.textColor ? cssToArgb(data.textColor) : 'FF0563C1' },
                        bold: data.bold,
                        italic: data.italic,
                        underline: nativeHyperlink ? true : undefined,
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
        applyExcelMerges(sheet, page.univerExtras, rows.length, cols.length);
    }

    // Default: no embedded meta — Excel/Univer only see data sheets.
    if (options.embedMetaSheet === true) {
        const meta = buildNlMeta(doc, sheetNames);
        const metaSheet = wb.addWorksheet(NL_META_SHEET, { state: 'veryHidden' });
        writeChunkedMetaText(metaSheet, JSON.stringify(meta));
    }

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
export async function decodePlotGridXlsx(
    data: ArrayBuffer | Uint8Array,
    options: DecodePlotGridXlsxOptions = {},
): Promise<ConceptGridDocument> {
    const wb = await loadExcelWorkbook(data);

    let meta: PlotGridNlMeta | null = options.meta ?? null;
    if (!meta) {
        const metaWs = wb.getWorksheet(NL_META_SHEET);
        if (metaWs) {
            meta = tryParseNlMeta(readChunkedMetaText(metaWs));
        }
        // External Univer/Excel saves often unhide or rename `_nl_meta`. Recover by
        // scanning sheet A1..An for NarrativeLab meta JSON.
        if (!meta) {
            wb.eachSheet((sheet) => {
                if (meta) return;
                meta = tryParseNlMeta(readChunkedMetaText(sheet));
            });
        }
    }

    const pages: ConceptGridPage[] = [];
    const usedIds = new Set<string>();
    let dataSheetCount = 0;
    let metaDumpSheetCount = 0;

    wb.eachSheet((sheet) => {
        if (sheetLooksLikeNlMetaDump(sheet)) {
            metaDumpSheetCount += 1;
            return;
        }
        dataSheetCount += 1;
        const pageId = meta?.pageIds?.[sheet.name]
            || `page-${sheet.name}-${Date.now().toString(36)}`;
        const stableId = usedIds.has(pageId) ? `${pageId}-${pages.length}` : pageId;
        usedIds.add(stableId);

        const pageMeta = meta?.pages?.[stableId] || meta?.pages?.[pageId];
        let columns: ColumnMeta[] = pageMeta?.columns?.length
            ? pageMeta.columns.map(c => ({ ...c }))
            : [];
        let rows: RowMeta[] = pageMeta?.rows?.length
            ? pageMeta.rows.map(r => ({ ...r }))
            : [];

        // Discover grid size from sheet
        const rowCount = Math.max(sheet.rowCount || 0, rows.length + 1);
        const colCount = Math.max(sheet.columnCount || 0, columns.length + 1);

        // The visible xlsx is authoritative for structure. A fast page switch
        // can leave the sidecar one save behind after native row/column splices;
        // align old stable ids to live headers/content instead of truncating the
        // workbook back to stale metadata extents.
        const liveColumnCount = Math.max(0, (sheet.columnCount || 0) - 1);
        if (columns.length > 0 && liveColumnCount !== columns.length) {
            const candidates = columns;
            const used = new Set<number>();
            const usedIds = new Set(candidates.map(column => column.id));
            const nextId = (index: number): string => {
                let id = `col-xlsx-${Date.now().toString(36)}-${index}`;
                while (usedIds.has(id)) id += 'x';
                usedIds.add(id);
                return id;
            };
            columns = Array.from({ length: liveColumnCount }, (_, index) => {
                const label = cellValueText(sheet.getCell(1, index + 2).value).trim();
                const matches = candidates
                    .map((column, candidateIndex) => ({ column, candidateIndex }))
                    .filter(candidate => !used.has(candidate.candidateIndex)
                        && candidate.column.label.trim() === label)
                    .sort((a, b) => Math.abs(a.candidateIndex - index) - Math.abs(b.candidateIndex - index));
                const match = matches[0];
                const liveWidth = sheet.getColumn(index + 2).width;
                if (match) {
                    used.add(match.candidateIndex);
                    return {
                        ...match.column,
                        label,
                        width: typeof liveWidth === 'number' && liveWidth > 0
                            ? Math.round(liveWidth * 8)
                            : match.column.width,
                    };
                }
                return {
                    id: nextId(index),
                    label,
                    width: typeof liveWidth === 'number' && liveWidth > 0
                        ? Math.round(liveWidth * 8)
                        : 120,
                    bgColor: '',
                    sourceType: 'manual',
                };
            });
        }

        const liveRowCount = Math.max(0, (sheet.rowCount || 0) - 1);
        if (rows.length > 0 && liveRowCount !== rows.length) {
            const candidates = rows;
            const used = new Set<number>();
            const usedIds = new Set(candidates.map(row => row.id));
            const visibleMetaCell = (row: RowMeta, column: ColumnMeta): string => {
                const saved = pageMeta?.cells?.[cellKey(row.id, column.id)];
                const source = saved?.content || saved?.markdownSource || '';
                return plotGridSourceToUniverRichText(source).displayText.trim();
            };
            const metaSignature = (row: RowMeta): string => JSON.stringify([
                row.label.trim(),
                ...columns.map(column => visibleMetaCell(row, column)),
            ]);
            const liveSignature = (index: number): string => JSON.stringify([
                cellValueText(sheet.getCell(index + 2, 1).value).trim(),
                ...columns.map((_, columnIndex) => (
                    cellValueText(sheet.getCell(index + 2, columnIndex + 2).value).trim()
                )),
            ]);
            const nextId = (index: number): string => {
                let id = `row-xlsx-${Date.now().toString(36)}-${index}`;
                while (usedIds.has(id)) id += 'x';
                usedIds.add(id);
                return id;
            };
            rows = Array.from({ length: liveRowCount }, (_, index) => {
                const signature = liveSignature(index);
                const parsed = JSON.parse(signature) as string[];
                const label = parsed[0] || '';
                let matchIndex = candidates.findIndex((candidate, candidateIndex) => (
                    !used.has(candidateIndex) && metaSignature(candidate) === signature
                ));
                if (matchIndex < 0 && label) {
                    matchIndex = candidates.findIndex((candidate, candidateIndex) => (
                        !used.has(candidateIndex) && candidate.label.trim() === label
                    ));
                }
                const liveHeight = sheet.getRow(index + 2).height;
                if (matchIndex >= 0) {
                    used.add(matchIndex);
                    const match = candidates[matchIndex];
                    return {
                        ...match,
                        label,
                        height: typeof liveHeight === 'number' && liveHeight > 0
                            ? Math.round(liveHeight / 0.75)
                            : match.height,
                    };
                }
                return {
                    id: nextId(index),
                    label,
                    height: typeof liveHeight === 'number' && liveHeight > 0
                        ? Math.round(liveHeight / 0.75)
                        : 32,
                    bgColor: '',
                    sourceType: 'manual',
                };
            });
        }

        // If meta missing column/row defs, rebuild from header labels
        if (columns.length === 0) {
            for (let ci = 2; ci <= colCount; ci++) {
                const label = cellValueText(sheet.getCell(1, ci).value).trim();
                if (!label && ci > 2) continue;
                columns.push({
                    id: `col-${ci - 2}-${Date.now().toString(36)}`,
                    label,
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
                    label,
                    height: 32,
                    bgColor: '',
                });
            }
        }

        // Sync header labels from sheet when Excel renamed them. Keep meta labels
        // when the sheet cell is blank (external saves often omit empty headers).
        columns.forEach((col, ci) => {
            const label = cellValueText(sheet.getCell(1, ci + 2).value).trim();
            if (label) col.label = label;
        });
        rows.forEach((row, ri) => {
            const label = cellValueText(sheet.getCell(ri + 2, 1).value).trim();
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
                const hyperlinkPath = obsidianFileFromCellValue(rawValue);
                const linkedSceneId = saved?.linkedSceneId || hyperlinkPath;
                const restoredMarkdown = saved?.markdownSource
                    && plotGridSourceToUniverRichText(saved.markdownSource).displayText === content
                    ? saved.markdownSource
                    : undefined;
                const recoveredWikilink = !saved?.linkedSceneId && hyperlinkPath
                    ? `[[${hyperlinkPath.replace(/\.md$/i, '')}|${content || hyperlinkPath.replace(/\.md$/i, '').split('/').pop() || hyperlinkPath}]]`
                    : undefined;
                const fill = excelCell.fill && excelCell.fill.type === 'pattern'
                    ? argbToCss(excelCell.fill.fgColor?.argb)
                    : '';
                // Prefer live Excel text; fall back to meta content when a cell was wiped.
                const metaContent = saved?.content || saved?.markdownSource || '';
                cells[key] = defaultCell({
                    id: key,
                    content: restoredMarkdown || recoveredWikilink || content || metaContent,
                    linkedSceneId,
                    linkedViaWikilink: restoredMarkdown
                        ? saved?.linkedViaWikilink
                        : (recoveredWikilink ? true : (saved?.linkedSceneId ? false : saved?.linkedViaWikilink)),
                    formula: formulaValue?.formula ? `=${formulaValue.formula}` : saved?.formula,
                    manualContent: saved?.manualContent,
                    bgColor: fill || saved?.bgColor || '',
                    textColor: saved?.textColor || '',
                    bold: saved?.bold ?? !!excelCell.font?.bold,
                    italic: saved?.italic ?? !!excelCell.font?.italic,
                    align: saved?.align || (excelCell.alignment?.horizontal as CellData['align']) || 'left',
                    univerStyle: saved?.univerStyle,
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
            // Sheet is canonical for visible A1; meta is only a fallback.
            cornerLabel: cellValueText(sheet.getCell(1, 1).value)
                || pageMeta?.cornerLabel
                || '',
            headerRowHeight: typeof pageMeta?.headerRowHeight === 'number' && pageMeta.headerRowHeight > 0
                ? Math.round(pageMeta.headerRowHeight)
                : (typeof sheet.getRow(1).height === 'number' && (sheet.getRow(1).height || 0) > 0
                    ? Math.round((sheet.getRow(1).height || 0) / 0.75)
                    : 0),
            labelColumnWidth: typeof pageMeta?.labelColumnWidth === 'number' && pageMeta.labelColumnWidth > 0
                ? Math.round(pageMeta.labelColumnWidth)
                : (typeof sheet.getColumn(1).width === 'number' && (sheet.getColumn(1).width || 0) > 0
                    ? Math.round((sheet.getColumn(1).width || 0) * 8)
                    : 0),
            hidden: sheet.state === 'hidden' || sheet.state === 'veryHidden' || pageMeta?.hidden === true,
            tabColor: argbToCss(sheet.properties?.tabColor?.argb) || pageMeta?.tabColor || '',
            univerExtras: normalizeUniverSheetExtras(pageMeta?.univerExtras) || normalizeUniverSheetExtras({
                mergeData: excelMergesToUniver(sheet),
            }),
        });
    });

    // Univer/Excel re-save wiped NarrativeLab sheets and left only meta JSON dumps.
    if (meta && (pages.length === 0 || (dataSheetCount === 0 && metaDumpSheetCount > 0))) {
        return documentFromNlMeta(meta);
    }

    if (pages.length === 0) {
        return createEmptyConceptGridDocument();
    }

    // Meta describes real pages (e.g. 角色) but Excel only kept junk sheets
    // like "datasheet"/"references" after an external Univer open+save.
    if (meta) {
        const fromMeta = documentFromNlMeta(meta);
        const metaMeaningful = fromMeta.pages.some(p =>
            (p.rows?.length || 0) > 0 && (p.columns?.length || 0) > 0);
        const liveHasText = pages.some(page =>
            Object.values(page.cells || {}).some(cell => !!(cell?.content || '').trim()));
        const metaTitles = new Set(Object.keys(meta.pageIds || {}));
        const liveTitles = new Set(pages.map(p => p.title));
        const titlesOverlap = [...metaTitles].some(title => liveTitles.has(title));
        if (metaMeaningful && !liveHasText && !titlesOverlap) {
            return fromMeta;
        }
        const metaPageCount = Object.keys(meta.pages || {}).length;
        const metaCellCount = Object.values(meta.pages || {}).reduce(
            (n, page) => n + Object.keys(page?.cells || {}).length,
            0,
        );
        const metaHasText = Object.values(meta.pages || {}).some(page =>
            Object.values(page?.cells || {}).some(cell =>
                !!(cell?.content || cell?.markdownSource || '').trim()));
        if (metaPageCount > pages.length && metaCellCount > 0 && !liveHasText && metaHasText) {
            return fromMeta;
        }
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
        univerResources: normalizeUniverWorkbookResources(meta?.univerResources),
        univerStyles: normalizeUniverStyleMap(meta?.univerStyles),
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
        headerRow[0] = { v: page.cornerLabel || '' };
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
                    s: mergeOwnedUniverCellStyle(data),
                };
            });
        });

        // ia:0 locks manual row height. Univer prefers auto-height (ah) when ia is
        // null/1, so a later column-resize auto-fit would wipe custom row heights.
        const extras = normalizeUniverSheetExtras(page.univerExtras);
        const rowData: Record<number, Record<string, unknown>> = {};
        const columnData: Record<number, Record<string, unknown>> = {};
        if ((page.headerRowHeight || 0) > 0) {
            rowData[0] = { h: page.headerRowHeight || 0, ia: 0, ...axisFlagsAt(extras?.rowFlags, 0) };
        } else if (axisFlagsAt(extras?.rowFlags, 0)) {
            rowData[0] = { ...axisFlagsAt(extras?.rowFlags, 0) };
        }
        if ((page.labelColumnWidth || 0) > 0) {
            columnData[0] = { w: page.labelColumnWidth || 0, ...axisFlagsAt(extras?.columnFlags, 0) };
        } else if (axisFlagsAt(extras?.columnFlags, 0)) {
            columnData[0] = { ...axisFlagsAt(extras?.columnFlags, 0) };
        }
        rows.forEach((row, ri) => {
            const flags = axisFlagsAt(extras?.rowFlags, ri + 1);
            if (row.height > 0) rowData[ri + 1] = { h: row.height, ia: 0, ...flags };
            else if (flags) rowData[ri + 1] = { ...flags };
        });
        cols.forEach((col, ci) => {
            const flags = axisFlagsAt(extras?.columnFlags, ci + 1);
            if (col.width > 0) columnData[ci + 1] = { w: col.width, ...flags };
            else if (flags) columnData[ci + 1] = { ...flags };
        });

        sheets[id] = {
            id,
            name: page.title || `Page ${index + 1}`,
            tabColor: page.tabColor || '',
            hidden: page.hidden ? 1 : 0,
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
            ...(extras?.mergeData ? { mergeData: extras.mergeData } : {}),
            ...(extras?.defaultColumnWidth != null ? { defaultColumnWidth: extras.defaultColumnWidth } : {}),
            ...(extras?.defaultRowHeight != null ? { defaultRowHeight: extras.defaultRowHeight } : {}),
            ...(extras?.defaultStyle != null ? { defaultStyle: extras.defaultStyle } : {}),
            ...(extras?.rowHeader != null ? { rowHeader: extras.rowHeader } : {}),
            ...(extras?.columnHeader != null ? { columnHeader: extras.columnHeader } : {}),
            ...(extras?.showGridlines != null ? { showGridlines: extras.showGridlines } : {}),
            ...(extras?.gridlinesColor ? { gridlinesColor: extras.gridlinesColor } : {}),
            ...(extras?.rightToLeft != null ? { rightToLeft: extras.rightToLeft } : {}),
            ...(extras?.custom ? { custom: extras.custom } : {}),
        };
    });

    return {
        id: 'narrativelab-plotgrid',
        name: 'Concept Grid',
        appVersion: 'NarrativeLab',
        locale: 'zhCN',
        styles: normalizeUniverStyleMap(doc.univerStyles) || {},
        sheetOrder,
        sheets,
        resources: [
            {
                name: 'NARRATIVELAB_PLOTGRID_META',
                data: JSON.stringify(buildNlMeta(doc, doc.pages.map(p => p.title))),
            },
            ...(normalizeUniverWorkbookResources(doc.univerResources) || []),
        ],
    };
}

/** Univer workbook.save() fields that describe a worksheet tab. */
export type UniverSheetChromeSnapshot = {
    id?: string;
    name?: string;
    tabColor?: string;
    hidden?: number | boolean | string;
    zoomRatio?: number;
    freeze?: unknown;
    mergeData?: unknown;
    defaultColumnWidth?: unknown;
    defaultRowHeight?: unknown;
    defaultStyle?: unknown;
    rowHeader?: unknown;
    columnHeader?: unknown;
    showGridlines?: unknown;
    gridlinesColor?: unknown;
    rightToLeft?: unknown;
    custom?: unknown;
    rowData?: Record<number, Record<string, unknown>>;
    columnData?: Record<number, Record<string, unknown>>;
};

function normalizeUniverTabColor(value: unknown): string {
    if (typeof value !== 'string') return '';
    const raw = value.trim();
    if (!raw) return '';
    if (raw.startsWith('#') && raw.length === 9) return `#${raw.slice(3)}`;
    if (raw.startsWith('#')) return raw;
    if (/^[0-9a-fA-F]{6}$/.test(raw)) return `#${raw}`;
    if (/^[0-9a-fA-F]{8}$/.test(raw)) return `#${raw.slice(2)}`;
    return raw;
}

function isUniverSheetHidden(value: unknown): boolean {
    if (value === true || value === 1 || value === 2) return true;
    if (typeof value === 'string') {
        const n = Number(value);
        return value === 'hidden' || value === 'veryHidden' || n === 1 || n === 2;
    }
    return false;
}

/**
 * Apply Univer sheet-bar mutations (name / hide / tab color / order / add / delete)
 * onto the NarrativeLab document. Cell link metadata on matching page ids is kept.
 */
export function reconcileUniverSheetsIntoDocument(
    raw: ConceptGridDocument,
    sheets: Record<string, UniverSheetChromeSnapshot> | undefined,
    sheetOrder?: string[],
    activeSheetId?: string,
): ConceptGridDocument {
    if (!sheets) return raw;
    const order = (sheetOrder?.length ? [...sheetOrder] : Object.keys(sheets)).filter((id) => {
        const sheet = sheets[id];
        const name = (sheet?.name || id).trim();
        return name.toLowerCase() !== NL_META_SHEET.toLowerCase();
    });
    if (order.length === 0) return raw;

    const doc = structuredClone(raw);
    const byId = new Map(doc.pages.map(page => [page.id, page]));
    const nextPages: ConceptGridPage[] = [];
    for (const id of order) {
        const sheet = sheets[id] || { id };
        const name = (sheet.name || '').trim();
        const existing = byId.get(id);
        if (existing) {
            if (name) existing.title = name;
            existing.hidden = isUniverSheetHidden(sheet.hidden);
            existing.tabColor = normalizeUniverTabColor(sheet.tabColor);
            if (typeof sheet.zoomRatio === 'number' && Number.isFinite(sheet.zoomRatio) && sheet.zoomRatio > 0) {
                existing.zoom = sheet.zoomRatio;
            }
            applyUniverFreezeToPage(existing, sheet.freeze);
            existing.univerExtras = extractUniverSheetExtras(sheet);
            nextPages.push(existing);
            continue;
        }
        const page = createEmptyConceptGridPage(name || undefined);
        page.id = id;
        if (name) page.title = name;
        page.hidden = isUniverSheetHidden(sheet.hidden);
        page.tabColor = normalizeUniverTabColor(sheet.tabColor);
        if (typeof sheet.zoomRatio === 'number' && Number.isFinite(sheet.zoomRatio) && sheet.zoomRatio > 0) {
            page.zoom = sheet.zoomRatio;
        }
        applyUniverFreezeToPage(page, sheet.freeze);
        page.univerExtras = extractUniverSheetExtras(sheet);
        nextPages.push(page);
    }
    if (nextPages.length === 0) return raw;
    doc.pages = nextPages;
    if (activeSheetId && doc.pages.some(page => page.id === activeSheetId)) {
        doc.activePageId = activeSheetId;
    } else if (!doc.pages.some(page => page.id === doc.activePageId)) {
        const visible = doc.pages.find(page => !page.hidden) ?? doc.pages[0];
        if (visible) doc.activePageId = visible.id;
    }
    return doc;
}

export type MergeUniverCellDataOptions = {
    /**
     * When true, cells present in the NarrativeLab model but omitted from Univer's
     * sparse snapshot are cleared. Unsafe while a cell editor / IME session is open
     * (the active cell is often missing from mid-edit saves). Prefer false for
     * polling; use true only after the editor has closed.
     */
    clearMissing?: boolean;
    /** When false, skip row/column size merges (sizes come from resize mutations). */
    mergeDimensions?: boolean;
};

/** Merge Univer cellData edits back into ConceptGridDocument (preserves links via existing meta). */
export function mergeUniverCellDataIntoDocument(
    doc: ConceptGridDocument,
    sheetId: string,
    cellData: Record<number, Record<number, UniverCellSnapshot>>,
    styles?: Record<string, UniverStyleSnapshot>,
    rowData?: Record<number, { h?: number; ah?: number }>,
    columnData?: Record<number, { w?: number }>,
    options: MergeUniverCellDataOptions = {},
): ConceptGridDocument {
    const clearMissing = options.clearMissing === true;
    const mergeDimensions = options.mergeDimensions !== false;
    const page = doc.pages.find(p => p.id === sheetId);
    if (!page) return doc;

    let changed = ensureOccupiedGridExtents(page, cellData);
    // Do NOT expand from empty reserved cells — Univer always dumps ~50×20.
    // Occupied cells above already grew the model so in-sheet typing persists.
    const cols = page.columns || [];
    const rows = page.rows || [];

    if (mergeDimensions) {
        const headerHeight = rowData?.[0]?.h ?? rowData?.[0]?.ah;
        if (typeof headerHeight === 'number' && headerHeight > 0
            && Math.round(headerHeight) !== (page.headerRowHeight || 0)) {
            page.headerRowHeight = Math.round(headerHeight);
            changed = true;
        }
        const labelWidth = columnData?.[0]?.w;
        if (typeof labelWidth === 'number' && labelWidth > 0
            && Math.round(labelWidth) !== (page.labelColumnWidth || 0)) {
            page.labelColumnWidth = Math.round(labelWidth);
            changed = true;
        }
        rows.forEach((row, index) => {
            // Prefer explicit height over auto-height so column-resize auto-fit
            // snapshots cannot silently shrink manually sized rows.
            const height = rowData?.[index + 1]?.h
                ?? (rowData?.[index + 1]?.ah);
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
    }

    // Update corner (A1) + headers — same rich-text path as body cells so
    // mid-edit Univer `p` snapshots (and cleared labels) persist.
    {
        const corner = cellData[0]?.[0];
        const next = univerCellPlainText(corner);
        if (next != null && (page.cornerLabel || '') !== next) {
            page.cornerLabel = next;
            changed = true;
        } else if (clearMissing && next == null && (page.cornerLabel || '')) {
            page.cornerLabel = '';
            changed = true;
        }
    }
    cols.forEach((col, ci) => {
        const raw = cellData[0]?.[ci + 1];
        const next = univerCellPlainText(raw);
        if (next != null && col.label !== next) {
            col.label = next;
            changed = true;
        } else if (clearMissing && next == null && col.label) {
            col.label = '';
            changed = true;
        }
        if (applyHeaderStyleFromUniver(col, raw, styles)) changed = true;
    });
    rows.forEach((row, ri) => {
        const raw = cellData[ri + 1]?.[0];
        const next = univerCellPlainText(raw);
        if (next != null && row.label !== next) {
            row.label = next;
            changed = true;
        } else if (clearMissing && next == null && row.label) {
            row.label = '';
            changed = true;
        }
        if (applyHeaderStyleFromUniver(row, raw, styles)) changed = true;
    });

    rows.forEach((row, ri) => {
        cols.forEach((col, ci) => {
            const key = cellKey(row.id, col.id);
            const rowBucket = cellData[ri + 1] as Record<number, UniverCellSnapshot | null> | undefined;
            const raw = rowBucket?.[ci + 1];
            const existing = page.cells[key] || defaultCell({ id: key });
            // Mid-edit workbook.save() often omits the active cell. Treating that as a
            // clear wipes content and, after remount, interrupts IME (pinyin flies away).
            // Univer "Clear all" writes an explicit null into the matrix; "Clear contents"
            // writes `{ v: null, p: null, custom: null }`. Those are committed clears even
            // when the surrounding snapshot is still sparse.
            if (raw == null || (!('v' in raw) && !('p' in raw))) {
                const explicitNull = rowBucket != null
                    && (ci + 1) in rowBucket
                    && !raw;
                if (!clearMissing && !explicitNull) return;
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
            const displayText = univerCellPlainText(raw) || '';
            const storedSource = typeof raw.custom?.[PLOTGRID_SOURCE_FIELD] === 'string'
                ? raw.custom[PLOTGRID_SOURCE_FIELD]
                : '';
            // Preserve Markdown/HTML while Univer's native rich text still
            // represents it. A direct in-cell edit intentionally becomes plain
            // text; syntax-rich edits belong in the focused cell editor.
            // Empty display never keeps a leftover Markdown/wikilink source.
            const nextContent = !displayText
                ? ''
                : (storedSource
                    && plotGridSourceToUniverRichText(storedSource).displayText === displayText
                    ? storedSource
                    : displayText);
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
                univerStyle: cloneStyleObject(style) || existing.univerStyle,
            };
            if (page.cells[key]
                && existing.content === nextCell.content
                && existing.formula === nextCell.formula
                && existing.bgColor === nextCell.bgColor
                && existing.textColor === nextCell.textColor
                && existing.bold === nextCell.bold
                && existing.italic === nextCell.italic
                && existing.align === nextCell.align
                && JSON.stringify(existing.univerStyle || null) === JSON.stringify(nextCell.univerStyle || null)) return;
            page.cells[key] = nextCell;
            changed = true;
        });
    });

    if (!changed) return doc;
    return { ...doc, pages: [...doc.pages] };
}

/** Fingerprint of cell display text + headers + axis sizes (for dirty checks). */
export function conceptGridContentFingerprint(doc: ConceptGridDocument): string {
    const parts: string[] = [doc.activePageId || ''];
    for (const page of doc.pages) {
        parts.push(
            page.id,
            page.title || '',
            `corner:${page.cornerLabel || ''}`,
            `headerH:${page.headerRowHeight || 0}`,
            `labelW:${page.labelColumnWidth || 0}`,
            `hidden:${page.hidden ? 1 : 0}`,
            `tab:${page.tabColor || ''}`,
            `freeze:${page.stickyHeaders === false ? 0 : 1}:${page.frozenRows || 0}:${page.frozenColumns || 0}`,
        );
        for (const row of page.rows || []) {
            parts.push(
                `r:${row.id}:${row.label || ''}:${row.height || 0}:${row.headerBgColor || ''}:${row.textColor || ''}:${row.bold ? 1 : 0}:${row.italic ? 1 : 0}`,
            );
        }
        for (const col of page.columns || []) {
            parts.push(
                `c:${col.id}:${col.label || ''}:${col.width || 0}:${col.headerBgColor || ''}:${col.textColor || ''}:${col.bold ? 1 : 0}:${col.italic ? 1 : 0}`,
            );
        }
        for (const [key, cell] of Object.entries(page.cells || {})) {
            if (!cell) continue;
            parts.push(`${key}=${cell.content || ''}::${cell.formula || ''}`);
            if (cell.univerStyle) parts.push(`style:${key}:${JSON.stringify(cell.univerStyle)}`);
        }
        if (page.univerExtras) parts.push(`extras:${page.id}:${JSON.stringify(page.univerExtras)}`);
    }
    for (const resource of doc.univerResources || []) {
        parts.push(`res:${resource.name}:${resource.data.length}:${resource.data.slice(0, 48)}`);
    }
    if (doc.univerStyles) parts.push(`styles:${JSON.stringify(doc.univerStyles)}`);
    return parts.join('\n');
}

/**
 * Copy matching row heights / column widths from `source` onto `target`.
 * Used so mid-drag resize values in the host snapshot are not wiped by a
 * cell-only pull or syncMeta that still carries stale axis sizes.
 */
export function preserveConceptGridAxisSizes(
    target: ConceptGridDocument,
    source: ConceptGridDocument,
): void {
    for (const page of target.pages) {
        const srcPage = source.pages.find(item => item.id === page.id);
        if (!srcPage) continue;
        if ((srcPage.headerRowHeight || 0) > 0) page.headerRowHeight = srcPage.headerRowHeight;
        if ((srcPage.labelColumnWidth || 0) > 0) page.labelColumnWidth = srcPage.labelColumnWidth;
        page.rows.forEach((row, index) => {
            const src = srcPage.rows[index];
            if (!src || src.id !== row.id) return;
            if (typeof src.height === 'number' && src.height > 0) row.height = src.height;
        });
        page.columns.forEach((col, index) => {
            const src = srcPage.columns[index];
            if (!src || src.id !== col.id) return;
            if (typeof src.width === 'number' && src.width > 0) col.width = src.width;
        });
    }
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

/** Whether a sidecar describes the same visible page/axis structure as a document. */
export function plotGridNlMetaStructureMatchesDocument(
    meta: PlotGridNlMeta | null | undefined,
    raw: unknown,
): boolean {
    if (!meta) return false;
    const doc = normalizeConceptGridDocument(raw);
    const metaPageIds = Object.keys(meta.pages || {});
    if (metaPageIds.length !== doc.pages.length) return false;
    for (const page of doc.pages) {
        const saved = meta.pages?.[page.id];
        if (!saved) return false;
        if ((meta.pageIds || {})[page.title] !== page.id) return false;
        if ((saved.rows || []).map(row => row.id).join('\n')
            !== (page.rows || []).map(row => row.id).join('\n')) return false;
        if ((saved.columns || []).map(column => column.id).join('\n')
            !== (page.columns || []).map(column => column.id).join('\n')) return false;
    }
    return true;
}

export type ConceptGridAxisSpliceAction = 'insert' | 'remove';

/**
 * Mirror Univer's native row/column insert and remove mutations in the
 * NarrativeLab model. Worksheet index 0 is the semantic header axis, so body
 * rows/columns begin at index 1.
 */
export function spliceConceptGridAxis(
    raw: ConceptGridDocument,
    sheetId: string,
    axis: 'rows' | 'columns',
    action: ConceptGridAxisSpliceAction,
    worksheetStart: number,
    worksheetCount: number,
): ConceptGridDocument {
    if (!Number.isInteger(worksheetStart) || !Number.isInteger(worksheetCount)
        || worksheetStart < 1 || worksheetCount < 1) return raw;

    const sourcePage = raw.pages.find(item => item.id === sheetId);
    if (!sourcePage) return raw;
    const sourceItems = axis === 'rows' ? sourcePage.rows : sourcePage.columns;
    const modelStart = worksheetStart - 1;

    // Inserting into Univer's unused reserved tail does not change the visible
    // NarrativeLab extent. Removing there is likewise a no-op.
    if (action === 'insert' ? modelStart > sourceItems.length : modelStart >= sourceItems.length) {
        return raw;
    }

    const doc = structuredClone(raw);
    const page = doc.pages.find(item => item.id === sheetId)!;
    const nonce = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;

    if (action === 'insert') {
        if (axis === 'rows') {
            const inserted: RowMeta[] = Array.from({ length: worksheetCount }, (_, index) => ({
                id: `row-${nonce}-${index}`,
                label: '',
                height: 32,
                bgColor: '',
                sourceType: 'manual',
            }));
            page.rows.splice(modelStart, 0, ...inserted);
        } else {
            const inserted: ColumnMeta[] = Array.from({ length: worksheetCount }, (_, index) => ({
                id: `col-${nonce}-${index}`,
                label: '',
                width: 120,
                bgColor: '',
                sourceType: 'manual',
            }));
            page.columns.splice(modelStart, 0, ...inserted);
        }
        return doc;
    }

    if (axis === 'rows') {
        const removed = page.rows.splice(modelStart, worksheetCount);
        for (const row of removed) {
            for (const column of page.columns) delete page.cells[cellKey(row.id, column.id)];
        }
    } else {
        const removed = page.columns.splice(modelStart, worksheetCount);
        for (const column of removed) {
            for (const row of page.rows) delete page.cells[cellKey(row.id, column.id)];
        }
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
    const nonce = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
    while (page.columns.length < Math.max(0, maxColIndex)) {
        const index = page.columns.length + 1;
        page.columns.push({
            id: `col-${nonce}-${page.columns.length}`,
            label: t('Col {n}', { n: index }),
            width: 120,
            bgColor: '',
            sourceType: 'manual',
        });
    }
    while (page.rows.length < Math.max(0, maxRowIndex)) {
        const index = page.rows.length + 1;
        page.rows.push({
            id: `row-${nonce}-${page.rows.length}`,
            label: t('Row {n}', { n: index }),
            height: 32,
            bgColor: '',
            sourceType: 'manual',
        });
    }
}
