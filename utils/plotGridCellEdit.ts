import type { CellData } from '../models/PlotGridData';

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
 * - Header labels (row/col 0) stay in Univer.
 * - Formula cells stay in Univer.
 * - Linked / wikilink cells always use the Markdown editor.
 * - Unlinked plain cells stay in Univer (click-to-edit in place).
 * - When `markdownEditMode` is on, all other data cells also use the Markdown editor.
 */
export function cellRequiresMarkdownEditor(
    cell: CellData | null | undefined,
    row: number,
    col: number,
    markdownEditMode: boolean,
): boolean {
    if (row < 1 || col < 1) return false;
    if (cellLooksLikeFormula(cell)) return false;
    // Only real note links force the Markdown editor — plain cells stay in-place.
    if (cellHasNoteLink(cell)) return true;
    return !!markdownEditMode;
}
