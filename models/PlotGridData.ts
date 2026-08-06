/* eslint-disable @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-argument, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-return, @typescript-eslint/no-floating-promises, @typescript-eslint/no-misused-promises, @typescript-eslint/no-unnecessary-type-assertion, @typescript-eslint/no-redundant-type-constituents, @typescript-eslint/no-unused-vars, no-unused-vars, no-useless-escape, no-control-regex, no-empty -- Obsidian's API surface and several untyped third-party libraries force dynamic dispatch; floating promises are intentional in DOM/event handlers; matching enable at end of file */
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

/** Normalize vault JSON (v1 single-page or v2 multi-page) into a ConceptGridDocument. */
export function normalizeConceptGridDocument(raw: unknown): ConceptGridDocument {
    if (isConceptGridDocument(raw)) {
        const pages = (raw.pages.length > 0 ? raw.pages : [createEmptyConceptGridPage()]).map((page, index) => ({
            id: page.id || makePageId(),
            title: (page.title || t('Page {n}', { n: index + 1 })).trim() || t('Page {n}', { n: index + 1 }),
            rows: Array.isArray(page.rows) ? page.rows : [],
            columns: Array.isArray(page.columns) ? page.columns : [],
            cells: page.cells && typeof page.cells === 'object' ? page.cells : {},
            zoom: typeof page.zoom === 'number' ? page.zoom : 1,
            stickyHeaders: typeof page.stickyHeaders === 'boolean' ? page.stickyHeaders : true,
        }));
        const activePageId = pages.some(p => p.id === raw.activePageId)
            ? raw.activePageId
            : pages[0].id;
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
            cells: raw.cells && typeof raw.cells === 'object' ? raw.cells : {},
            zoom: typeof raw.zoom === 'number' ? raw.zoom : 1,
            stickyHeaders: typeof raw.stickyHeaders === 'boolean' ? raw.stickyHeaders : true,
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

export function isConceptGridDocumentEmpty(doc: ConceptGridDocument): boolean {
    return !doc.pages.some(page => (page.rows?.length ?? 0) > 0);
}

export function cloneConceptGridPage(page: ConceptGridPage, title?: string): ConceptGridPage {
    const cells: Record<string, CellData> = {};
    for (const [key, cell] of Object.entries(page.cells || {})) {
        cells[key] = { ...cell };
    }
    return {
        id: makePageId(),
        title: title ?? `${page.title} copy`,
        rows: (page.rows || []).map(r => ({ ...r })),
        columns: (page.columns || []).map(c => ({ ...c })),
        cells,
        zoom: page.zoom ?? 1,
        stickyHeaders: page.stickyHeaders,
    };
}
/* eslint-enable @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-argument, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-return, @typescript-eslint/no-floating-promises, @typescript-eslint/no-misused-promises, @typescript-eslint/no-unnecessary-type-assertion, @typescript-eslint/no-redundant-type-constituents, @typescript-eslint/no-unused-vars, no-unused-vars, no-useless-escape, no-control-regex, no-empty -- end of file-wide suppression block opened at line 1 */
