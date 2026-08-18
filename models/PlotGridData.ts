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
    /** Full Univer IStyleData (borders, wrap, nfmt, font…) so remounts keep formatting. */
    univerStyle?: Record<string, unknown>;
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

/** One mention of an entity inside Concept Grid / datasheet.xlsx. */
export interface PlotGridAppearanceHit {
    pageId: string;
    pageTitle: string;
    rowId: string;
    rowLabel: string;
    /** Vault path of Library/datasheet.xlsx */
    filePath: string;
    /** Scene file when the row is auto-synced from Scenes */
    scenePath?: string;
    /** Column where the mention was found (best-effort) */
    columnId?: string;
    columnLabel?: string;
    /** 0-based index in page.rows — for Univer setActiveCell */
    rowIndex: number;
    /** 0-based index in page.columns when known */
    columnIndex?: number;
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
    /** Height of Univer row 0 (column-header / first sheet row). */
    headerRowHeight?: number;
    /** Width of Univer column 0 (row-label / first sheet column). */
    labelColumnWidth?: number;
}

/**
 * Univer IWorksheetData fields NarrativeLab does not model itself.
 * mergeData / gridlines / hidden row flags must survive remount + save.
 */
export interface UniverSheetSnapshotExtras {
    mergeData?: unknown[];
    defaultColumnWidth?: number;
    defaultRowHeight?: number;
    defaultStyle?: unknown;
    rowHeader?: unknown;
    columnHeader?: unknown;
    showGridlines?: number | boolean;
    gridlinesColor?: string;
    rightToLeft?: number | boolean;
    custom?: Record<string, unknown>;
    rowFlags?: Record<string, Record<string, unknown>>;
    columnFlags?: Record<string, Record<string, unknown>>;
}

/** One page inside a multi-page Concept Grid document. */
export interface ConceptGridPage extends PlotGridData {
    id: string;
    title: string;
    /** When true the worksheet is hidden in Univer / Excel (not deleted). */
    hidden?: boolean;
    /** Worksheet tab color as `#rrggbb` (Univer / Excel tabColor). */
    tabColor?: string;
    /** Opaque Univer sheet fields (merges, gridlines, hidden axes…). */
    univerExtras?: UniverSheetSnapshotExtras;
}

/** Opaque Univer plugin snapshot (drawings, CF, validation, notes, filter…). */
export interface UniverWorkbookResource {
    name: string;
    data: string;
}

/** Persisted Concept Grid document (v2). */
export interface ConceptGridDocument {
    version: 2;
    pages: ConceptGridPage[];
    activePageId: string;
    sidebarCollapsed?: boolean;
    /**
     * Univer workbook.resources minus NarrativeLab's own meta blob.
     * Images / notes / validation live here so a remount or save cannot drop them.
     */
    univerResources?: UniverWorkbookResource[];
    /** Univer workbook.styles registry (cells may reference style ids). */
    univerStyles?: Record<string, unknown>;
    /** Transient proof that missing pages came from explicit sheet-delete commands. */
    explicitlyRemovedPageIds?: string[];
}

const NL_UNIVER_META_RESOURCE = 'NARRATIVELAB_PLOTGRID_META';

export function normalizeUniverWorkbookResources(raw: unknown): UniverWorkbookResource[] | undefined {
    if (!Array.isArray(raw)) return undefined;
    const next: UniverWorkbookResource[] = [];
    for (const item of raw) {
        if (!item || typeof item !== 'object') continue;
        const name = typeof (item as { name?: unknown }).name === 'string'
            ? (item as { name: string }).name.trim()
            : '';
        const data = (item as { data?: unknown }).data;
        if (!name || name === NL_UNIVER_META_RESOURCE) continue;
        if (typeof data !== 'string' || !data) continue;
        next.push({ name, data });
    }
    return next.length ? next : undefined;
}

function cloneJsonValue<T>(value: T): T {
    return value == null ? value : JSON.parse(JSON.stringify(value)) as T;
}

function normalizeJsonObject(raw: unknown): Record<string, unknown> | undefined {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return undefined;
    return cloneJsonValue(raw as Record<string, unknown>);
}

function normalizeFlagMap(raw: unknown): Record<string, Record<string, unknown>> | undefined {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return undefined;
    const next: Record<string, Record<string, unknown>> = {};
    for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
        const item = normalizeJsonObject(value);
        if (item) next[key] = item;
    }
    return Object.keys(next).length ? next : undefined;
}

export function normalizeUniverStyleMap(raw: unknown): Record<string, unknown> | undefined {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return undefined;
    const next: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
        const name = key.trim();
        if (!name || value == null) continue;
        next[name] = cloneJsonValue(value);
    }
    return Object.keys(next).length ? next : undefined;
}

export function normalizeUniverSheetExtras(raw: unknown): UniverSheetSnapshotExtras | undefined {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return undefined;
    const src = raw as UniverSheetSnapshotExtras;
    const extras: UniverSheetSnapshotExtras = {};
    if (Array.isArray(src.mergeData) && src.mergeData.length) extras.mergeData = cloneJsonValue(src.mergeData);
    if (typeof src.defaultColumnWidth === 'number' && Number.isFinite(src.defaultColumnWidth)) {
        extras.defaultColumnWidth = src.defaultColumnWidth;
    }
    if (typeof src.defaultRowHeight === 'number' && Number.isFinite(src.defaultRowHeight)) {
        extras.defaultRowHeight = src.defaultRowHeight;
    }
    if (src.defaultStyle != null) extras.defaultStyle = cloneJsonValue(src.defaultStyle);
    if (src.rowHeader != null) extras.rowHeader = cloneJsonValue(src.rowHeader);
    if (src.columnHeader != null) extras.columnHeader = cloneJsonValue(src.columnHeader);
    if (typeof src.showGridlines === 'number' || typeof src.showGridlines === 'boolean') {
        extras.showGridlines = src.showGridlines;
    }
    if (typeof src.gridlinesColor === 'string' && src.gridlinesColor.trim()) {
        extras.gridlinesColor = src.gridlinesColor.trim();
    }
    if (typeof src.rightToLeft === 'number' || typeof src.rightToLeft === 'boolean') {
        extras.rightToLeft = src.rightToLeft;
    }
    const custom = normalizeJsonObject(src.custom);
    if (custom) extras.custom = custom;
    const rowFlags = normalizeFlagMap(src.rowFlags);
    if (rowFlags) extras.rowFlags = rowFlags;
    const columnFlags = normalizeFlagMap(src.columnFlags);
    if (columnFlags) extras.columnFlags = columnFlags;
    return Object.keys(extras).length ? extras : undefined;
}

function pageHasUniverExtras(page: ConceptGridPage): boolean {
    const extras = page.univerExtras;
    if (!extras) return false;
    return (extras.mergeData?.length ?? 0) > 0
        || Boolean(extras.rowFlags && Object.keys(extras.rowFlags).length)
        || Boolean(extras.columnFlags && Object.keys(extras.columnFlags).length)
        || extras.showGridlines != null
        || extras.rightToLeft != null
        || extras.defaultStyle != null
        || extras.rowHeader != null
        || extras.columnHeader != null;
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
        headerRowHeight: 0,
        labelColumnWidth: 0,
        hidden: false,
        tabColor: '',
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
            univerStyle: normalizeJsonObject(cell.univerStyle),
        };
    }
    return cells;
}

function normalizeAxisSize(value: unknown, fallback = 0): number {
    const n = typeof value === 'number' ? value : Number(value);
    if (!Number.isFinite(n) || n <= 0) return fallback;
    return Math.round(n);
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
            headerRowHeight: normalizeAxisSize(page.headerRowHeight),
            labelColumnWidth: normalizeAxisSize(page.labelColumnWidth),
            hidden: page.hidden === true,
            tabColor: typeof page.tabColor === 'string' ? page.tabColor.trim() : '',
            univerExtras: normalizeUniverSheetExtras(page.univerExtras),
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
            univerResources: normalizeUniverWorkbookResources(raw.univerResources),
            univerStyles: normalizeUniverStyleMap(raw.univerStyles),
            explicitlyRemovedPageIds: Array.isArray(raw.explicitlyRemovedPageIds)
                ? [...new Set(raw.explicitlyRemovedPageIds.filter((id): id is string => (
                    typeof id === 'string' && !!id
                )))]
                : undefined,
        };
    }

    if (isLegacyPlotGridData(raw)) {
        const legacy = raw as PlotGridData & {
            headerRowHeight?: unknown;
            labelColumnWidth?: unknown;
            cornerLabel?: unknown;
        };
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
            cornerLabel: typeof legacy.cornerLabel === 'string' ? legacy.cornerLabel : '',
            headerRowHeight: normalizeAxisSize(legacy.headerRowHeight),
            labelColumnWidth: normalizeAxisSize(legacy.labelColumnWidth),
            hidden: false,
            tabColor: '',
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

/** Placeholder workbook — no user axis yet. Header-only sheets are not this. */
export function isDefaultEmptyConceptGrid(doc: ConceptGridDocument): boolean {
    return !(doc.pages || []).some(page =>
        (page.rows?.length ?? 0) > 0 || (page.columns?.length ?? 0) > 0,
    );
}

/** True when a page has axes or any filled cell — dropping it would lose user work. */
export function pageHasPersistableContent(page: ConceptGridPage): boolean {
    if ((page.rows?.length ?? 0) > 0 || (page.columns?.length ?? 0) > 0) return true;
    return Object.values(page.cells || {}).some(cell =>
        !!(cell && ((cell.content || '').trim() || (cell.formula || '').trim())),
    );
}

/**
 * Univer insert/copy-sheet snapshots sometimes omit existing worksheets while
 * the new tabs are already present. A fast edit/save can also drop several
 * existing tabs with no new ids. Applying either pull wipes the workbook.
 */
export function isIncompleteConceptGridPull(
    previous: ConceptGridDocument,
    next: ConceptGridDocument,
): boolean {
    if (countConceptGridFilledCells(previous) > 0
        && isDefaultEmptyConceptGrid(next)
        && !isDefaultEmptyConceptGrid(previous)) {
        return true;
    }
    const nextIds = new Set((next.pages || []).map(page => page.id));
    const explicitlyRemoved = new Set(next.explicitlyRemovedPageIds || []);
    const lostFilledCount = (previous.pages || []).filter(page =>
        !nextIds.has(page.id)
        && !explicitlyRemoved.has(page.id)
        && pageHasPersistableContent(page),
    ).length;
    // Only page ids stamped by explicit remove-sheet commands may disappear.
    return lostFilledCount > 0;
}

/**
 * True when a Univer workbook.save() snapshot is our document, not the
 * blank default workbook Univer paints before createWorkbook settles.
 */
export function workbookSnapshotBelongsToDocument(
    saved: { sheets?: Record<string, { id?: string } | undefined> } | null | undefined,
    doc: ConceptGridDocument,
): boolean {
    if (!saved?.sheets) return false;
    if (isDefaultEmptyConceptGrid(doc)) return true;
    const ids = new Set<string>();
    for (const [key, sheet] of Object.entries(saved.sheets)) {
        if (key) ids.add(key);
        if (typeof sheet?.id === 'string' && sheet.id) ids.add(sheet.id);
    }
    return (doc.pages || []).some(page => ids.has(page.id));
}

/** Reject a pull that swapped in a foreign workbook (no shared page ids). */
export function conceptGridDocumentsSharePage(
    previous: ConceptGridDocument,
    next: ConceptGridDocument,
): boolean {
    if (isDefaultEmptyConceptGrid(previous)) return true;
    const ids = new Set((next.pages || []).map(page => page.id));
    return (previous.pages || []).some(page => ids.has(page.id));
}

/**
 * Refuse a placeholder workbook over an existing file.
 * `fromLiveEditor` used to bypass this, so a lagging Univer snapshot could
 * write the default empty grid (or stub plugin resources) over real cells.
 * Reset Grid still passes allowEmptyOverwrite. Clearing cells on a sheet that
 * still has rows/columns is not a default-empty document and may save.
 */
export function shouldRefuseEmptyPlotGridWrite(
    incoming: ConceptGridDocument,
    options: {
        allowEmptyOverwrite?: boolean;
        fromLiveEditor?: boolean;
        existed: boolean;
        existingFilledCells?: number;
    },
): boolean {
    if (options.allowEmptyOverwrite || !options.existed) return false;
    if (isDefaultEmptyConceptGrid(incoming)) return true;
    if (options.fromLiveEditor) return false;
    if ((incoming.univerResources?.length ?? 0) > 0) return false;
    if (incoming.univerStyles && Object.keys(incoming.univerStyles).length > 0) return false;
    if ((incoming.pages || []).some(pageHasUniverExtras)) return false;
    return false;
}
/* eslint-enable @typescript-eslint/no-redundant-type-constituents -- end of file-wide suppression block opened at line 1 */
