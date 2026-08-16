import type { CellData } from '../models/PlotGridData';

export const AXIS_CORNER_CELL_ID = '__nl-axis-corner';
const AXIS_COL_PREFIX = '__nl-axis-col-';
const AXIS_ROW_PREFIX = '__nl-axis-row-';

export function axisColumnCellId(columnId: string): string {
    return `${AXIS_COL_PREFIX}${columnId}`;
}

export function axisRowCellId(rowId: string): string {
    return `${AXIS_ROW_PREFIX}${rowId}`;
}

export function isAxisCellId(id: string | undefined): boolean {
    if (!id) return false;
    return id === AXIS_CORNER_CELL_ID
        || id.startsWith(AXIS_COL_PREFIX)
        || id.startsWith(AXIS_ROW_PREFIX);
}

type PlotGridAxisPage = {
    cornerLabel?: string;
    rows: Array<{ id: string; label: string }>;
    columns: Array<{ id: string; label: string }>;
    cells: Record<string, CellData>;
};

/** Lookup a body or axis cell from Univer 0-based coordinates. Does not create cells. */
export function getPlotGridCellAtUniverCoords(
    page: PlotGridAxisPage | null | undefined,
    row: number,
    col: number,
): CellData | null {
    if (!page || row < 0 || col < 0) return null;
    if (row === 0 && col === 0) return page.cells[AXIS_CORNER_CELL_ID] || null;
    if (row === 0) {
        const column = page.columns[col - 1];
        return column ? page.cells[axisColumnCellId(column.id)] || null : null;
    }
    if (col === 0) {
        const rowMeta = page.rows[row - 1];
        return rowMeta ? page.cells[axisRowCellId(rowMeta.id)] || null : null;
    }
    const rowMeta = page.rows[row - 1];
    const colMeta = page.columns[col - 1];
    if (!rowMeta || !colMeta) return null;
    return page.cells[`${rowMeta.id}-${colMeta.id}`] || null;
}

export function univerCoordsForPlotGridCell(
    page: PlotGridAxisPage,
    cell: CellData,
): { row: number; col: number } | null {
    if (cell.id === AXIS_CORNER_CELL_ID || page.cells[AXIS_CORNER_CELL_ID] === cell) {
        return { row: 0, col: 0 };
    }
    if (cell.id.startsWith(AXIS_COL_PREFIX)) {
        const columnId = cell.id.slice(AXIS_COL_PREFIX.length);
        const colIndex = page.columns.findIndex(column => column.id === columnId);
        if (colIndex >= 0) return { row: 0, col: colIndex + 1 };
    }
    if (cell.id.startsWith(AXIS_ROW_PREFIX)) {
        const rowId = cell.id.slice(AXIS_ROW_PREFIX.length);
        const rowIndex = page.rows.findIndex(row => row.id === rowId);
        if (rowIndex >= 0) return { row: rowIndex + 1, col: 0 };
    }
    for (let rowIndex = 0; rowIndex < page.rows.length; rowIndex++) {
        for (let colIndex = 0; colIndex < page.columns.length; colIndex++) {
            const key = `${page.rows[rowIndex].id}-${page.columns[colIndex].id}`;
            const found = page.cells[key];
            if (found === cell || found?.id === cell.id) {
                return { row: rowIndex + 1, col: colIndex + 1 };
            }
        }
    }
    return null;
}

/** Keep row/column/corner labels aligned with axis-cell Markdown source. */
export function syncAxisLabelFromCell(page: PlotGridAxisPage, cell: CellData): void {
    if (cell.id === AXIS_CORNER_CELL_ID) {
        page.cornerLabel = cell.content || '';
        return;
    }
    if (cell.id.startsWith(AXIS_COL_PREFIX)) {
        const columnId = cell.id.slice(AXIS_COL_PREFIX.length);
        const column = page.columns.find(item => item.id === columnId);
        if (column) column.label = cell.content || '';
        return;
    }
    if (cell.id.startsWith(AXIS_ROW_PREFIX)) {
        const rowId = cell.id.slice(AXIS_ROW_PREFIX.length);
        const row = page.rows.find(item => item.id === rowId);
        if (row) row.label = cell.content || '';
    }
}

const WIKILINK_RE = /\[\[([^\]|#]+)(?:#[^\]|]+)?(?:\|([^\]]+))?\]\]/g;
const MARKDOWN_LINK_RE = /\[([^\]]+)\]\(([^)]*)\)/g;
const HTML_ANCHOR_RE = /<a\b[^>]*>([\s\S]*?)<\/a>/gi;

function isExternalHref(href: string): boolean {
    return /^(https?:|mailto:|tel:)/i.test(href.trim());
}

/** Visible label for a note link: alias, else the last path segment without `.md`. */
export function noteLinkDisplayLabel(target: string, alias?: string): string {
    const fromAlias = (alias || '').trim();
    if (fromAlias) return fromAlias;
    const trimmed = (target || '').trim().replace(/\\/g, '/');
    const base = trimmed.split('/').pop() || trimmed;
    return base.replace(/\.md$/i, '') || trimmed;
}

/**
 * Turn matching note links into plain text (keep the words, drop the link).
 * `matchesTarget` sees the wikilink path, markdown href, or HTML href.
 */
export function unwrapMatchingNoteLinks(
    source: string,
    matchesTarget: (target: string) => boolean,
): string {
    let next = String(source || '');
    next = next.replace(WIKILINK_RE, (full, target: string, alias?: string) => {
        const raw = String(target || '').trim();
        if (!raw || !matchesTarget(raw)) return full;
        return noteLinkDisplayLabel(raw, alias);
    });
    next = next.replace(MARKDOWN_LINK_RE, (full, text: string, href: string) => {
        const dest = String(href || '').trim();
        if (!dest || isExternalHref(dest) || !matchesTarget(dest)) return full;
        return String(text || '');
    });
    next = next.replace(HTML_ANCHOR_RE, (full, inner: string) => {
        const href = full.match(/\bhref\s*=\s*["']([^"']*)["']/i)?.[1] || '';
        if (!href || isExternalHref(href) || !matchesTarget(href)) return full;
        return String(inner || '').replace(/<[^>]+>/g, '');
    });
    return next.replace(/[ \t]{2,}/g, ' ').replace(/ ?\n ?/g, '\n');
}

/** Unwrap every vault note link in a cell; leave http(s)/mailto/tel links alone. */
export function unwrapAllNoteLinks(source: string): string {
    return unwrapMatchingNoteLinks(source, () => true);
}

export function cellHasNoteLink(cell: CellData | null | undefined): boolean {
    if (!cell) return false;
    if (cell.linkedSceneId?.trim()) return true;
    return /\[\[[^\]]+/.test(cell.content || '');
}

export function cellLooksLikeFormula(cell: CellData | null | undefined): boolean {
    if (!cell) return false;
    if (cell.formula?.trim()) return true;
    return /^\s*=/.test(cell.content || '');
}

/**
 * True when this data cell should use NarrativeLab's Markdown cell editor
 * instead of Univer's in-cell editor.
 *
 * - Formula cells stay in Univer.
 * - Linked / wikilink cells always use the Markdown editor.
 * - Axis cells (row 0 / column 0) use the same rules as body cells.
 * - Unlinked plain cells stay in Univer (click-to-edit in place).
 * - When `markdownEditMode` is on, all other cells also use the Markdown editor.
 */
export function cellRequiresMarkdownEditor(
    cell: CellData | null | undefined,
    _row: number,
    _col: number,
    markdownEditMode: boolean,
): boolean {
    if (cellLooksLikeFormula(cell)) return false;
    // Only real note links force the Markdown editor — plain cells stay in-place.
    if (cellHasNoteLink(cell)) return true;
    return !!markdownEditMode;
}
