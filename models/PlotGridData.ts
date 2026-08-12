/* eslint-disable @typescript-eslint/no-redundant-type-constituents -- Obsidian's API surface and several untyped third-party libraries force dynamic dispatch; floating promises are intentional in DOM/event handlers; matching enable at end of file */
import { t } from '../utils/i18n';

export interface CellData {
    id: string;
    content: string;
    bgColor: string;
    textColor: string;
    bold: boolean;
    italic: boolean;
    align: 'left' | 'center' | 'right';
    linkedSceneId?: string;
    /** Link was inferred from [[wikilink]] text and may be cleared with that text. */
    linkedViaWikilink?: boolean;
    /** Univer/Excel formula, including the leading '='. */
    formula?: string;
    /** When true, sync will not overwrite this cell's content */
    manualContent?: boolean;
}

export interface ColumnMeta {
    id: string;
    label: string;
    width: number;
    bgColor: string;
    textColor?: string;
    bold?: boolean;
    italic?: boolean;
    /** Background color for the header cell only (independent of column color) */
    headerBgColor?: string;
    /** 'auto' = created by Sync from Scenes, 'manual' = user-created */
    sourceType?: 'auto' | 'manual';
    /** For auto columns: the character name, tag, or location this column represents */
    sourceId?: string;
    /** What dimension auto columns represent (codex categories use 'codex:catId') */
    sourceKind?: 'characters' | 'tags' | 'locations' | string;
}

export interface RowMeta {
    id: string;
    label: string;
    height: number;
    bgColor: string;
    textColor?: string;
    bold?: boolean;
    italic?: boolean;
    /** Background color for the header cell only (independent of row color) */
    headerBgColor?: string;
    /** 'auto' = created by Sync from Scenes, 'manual' = user-created */
    sourceType?: 'auto' | 'manual';
    /** For auto rows: the scene filePath this row represents */
    sourceId?: string;
}

/** Single-page grid payload (legacy v1 shape and active-page working set). */
export interface PlotGridData {
    rows: RowMeta[];
    columns: ColumnMeta[];
    cells: Record<string, CellData>;
    zoom: number;
    stickyHeaders?: boolean;
    /** Number of leading worksheet columns frozen (includes the row-label column). */
    frozenColumns?: number;
    /** Number of leading worksheet rows frozen (includes the column-label row). */
    frozenRows?: number;
    /** Text in the sheet corner cell (A1) — row/column header intersection. */
    cornerLabel?: string;
}

/** One page inside a multi-page Concept Grid document. */
export interface ConceptGridPage extends PlotGridData {
    id: string;
    title: string;
}

/** Persisted Concept Grid document (v2). */
export interface ConceptGridDocument {
    version: 2;
    pages: ConceptGridPage[];
    activePageId: string;
    sidebarCollapsed?: boolean;
}

function makePageId(): string {
    return 'page-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 8);
}

export function createEmptyConceptGridPage(title?: string): ConceptGridPage {
    return {
        id: makePageId(),
        title: title ?? t('Page {n}', { n: 1 }),
        rows: [],
        columns: [],
        cells: {},
        zoom: 1,
        stickyHeaders: true,
        frozenColumns: 1,
        frozenRows: 1,
        cornerLabel: '',
    };
}

export function createEmptyConceptGridDocument(): ConceptGridDocument {
    const page = createEmptyConceptGridPage();
    return {
        version: 2,
        pages: [page],
        activePageId: page.id,
        sidebarCollapsed: false,
    };
}

function isConceptGridDocument(value: unknown): value is ConceptGridDocument {
    if (!value || typeof value !== 'object') return false;
    const doc = value as ConceptGridDocument;
    return doc.version === 2 && Array.isArray(doc.pages);
}

function isLegacyPlotGridData(value: unknown): value is PlotGridData {
    if (!value || typeof value !== 'object') return false;
    const data = value as PlotGridData & { version?: number; pages?: unknown };
    if (data.version === 2 || Array.isArray(data.pages)) return false;
    return Array.isArray(data.rows) || Array.isArray(data.columns) || typeof data.cells === 'object';
}

function normalizeCells(value: unknown): Record<string, CellData> {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
    const cells: Record<string, CellData> = {};
    for (const [key, rawCell] of Object.entries(value)) {
        if (!rawCell || typeof rawCell !== 'object' || Array.isArray(rawCell)) continue;
        const cell = rawCell as Partial<CellData>;
        const align = cell.align === 'center' || cell.align === 'right' ? cell.align : 'left';
        cells[key] = {
            id: key,
            content: typeof cell.content === 'string' ? cell.content : '',
            bgColor: typeof cell.bgColor === 'string' ? cell.bgColor : '',
            textColor: typeof cell.textColor === 'string' ? cell.textColor : '',
            bold: cell.bold === true,
            italic: cell.italic === true,
            align,
            linkedSceneId: typeof cell.linkedSceneId === 'string' ? cell.linkedSceneId : undefined,
            linkedViaWikilink: cell.linkedViaWikilink === true ? true : undefined,
            formula: typeof cell.formula === 'string' ? cell.formula : undefined,
            manualContent: cell.manualContent === true ? true : undefined,
        };
    }
    return cells;
}

/** Normalize vault JSON (v1 single-page or v2 multi-page) into a ConceptGridDocument. */
export function normalizeConceptGridDocument(raw: unknown): ConceptGridDocument {
    if (isConceptGridDocument(raw)) {
        const pages = (raw.pages.length > 0 ? raw.pages : [createEmptyConceptGridPage()]).map((page, index) => ({
            id: page.id || makePageId(),
            title: (page.title || t('Page {n}', { n: index + 1 })).trim() || t('Page {n}', { n: index + 1 }),
            rows: Array.isArray(page.rows) ? page.rows : [],
            columns: Array.isArray(page.columns) ? page.columns : [],
            cells: normalizeCells(page.cells),
            zoom: typeof page.zoom === 'number' ? page.zoom : 1,
            stickyHeaders: typeof page.stickyHeaders === 'boolean' ? page.stickyHeaders : true,
            frozenColumns: Math.max(1, Math.floor(page.frozenColumns ?? 1)),
            frozenRows: Math.max(1, Math.floor(page.frozenRows ?? 1)),
            cornerLabel: typeof page.cornerLabel === 'string' ? page.cornerLabel : '',
        }));
        const firstPage = pages[0] ?? createEmptyConceptGridPage();
        const activePageId = pages.some(p => p.id === raw.activePageId)
            ? raw.activePageId
            : firstPage.id;
        return {
            version: 2,
            pages,
            activePageId,
            sidebarCollapsed: Boolean(raw.sidebarCollapsed),
        };
    }

    if (isLegacyPlotGridData(raw)) {
        const page: ConceptGridPage = {
            id: makePageId(),
            title: t('Page {n}', { n: 1 }),
            rows: Array.isArray(raw.rows) ? raw.rows : [],
            columns: Array.isArray(raw.columns) ? raw.columns : [],
            cells: normalizeCells(raw.cells),
            zoom: typeof raw.zoom === 'number' ? raw.zoom : 1,
            stickyHeaders: typeof raw.stickyHeaders === 'boolean' ? raw.stickyHeaders : true,
            frozenColumns: Math.max(1, Math.floor(raw.frozenColumns ?? 1)),
            frozenRows: Math.max(1, Math.floor(raw.frozenRows ?? 1)),
            cornerLabel: typeof (raw as { cornerLabel?: unknown }).cornerLabel === 'string'
                ? (raw as { cornerLabel: string }).cornerLabel
                : '',
        };
        return {
            version: 2,
            pages: [page],
            activePageId: page.id,
            sidebarCollapsed: false,
        };
    }

    return createEmptyConceptGridDocument();
}

export function getActiveConceptGridPage(doc: ConceptGridDocument): ConceptGridPage {
    return doc.pages.find(p => p.id === doc.activePageId) ?? doc.pages[0] ?? createEmptyConceptGridPage();
}

/** Count cells that hold display text or a formula. */
export function countConceptGridFilledCells(doc: ConceptGridDocument): number {
    let count = 0;
    for (const page of doc.pages || []) {
        for (const cell of Object.values(page.cells || {})) {
            if (!cell) continue;
            if ((cell.content || '').trim() || (cell.formula || '').trim()) count += 1;
        }
    }
    return count;
}

/**
 * True when the workbook has no real grid body.
 * Structure-only pages (row/column headers but no filled cells) count as empty
 * so migration/autosave cannot overwrite a richer datasheet.xlsx.
 */
export function isConceptGridDocumentEmpty(doc: ConceptGridDocument): boolean {
    const hasRows = doc.pages.some(page => (page.rows?.length ?? 0) > 0);
    if (!hasRows) return true;
    return countConceptGridFilledCells(doc) === 0;
}

export function cloneConceptGridPage(page: ConceptGridPage, title?: string): ConceptGridPage {
    const cells: Record<string, CellData> = {};
    for (const [key, cell] of Object.entries(page.cells || {})) {
        cells[key] = { ...cell, id: key };
    }
    return {
        id: makePageId(),
        title: title ?? `${page.title} copy`,
        rows: (page.rows || []).map(r => ({ ...r })),
        columns: (page.columns || []).map(c => ({ ...c })),
        cells,
        zoom: page.zoom ?? 1,
        stickyHeaders: page.stickyHeaders,
        frozenColumns: page.frozenColumns,
        frozenRows: page.frozenRows,
        cornerLabel: page.cornerLabel,
    };
}
/* eslint-enable @typescript-eslint/no-redundant-type-constituents -- end of file-wide suppression block opened at line 1 */
