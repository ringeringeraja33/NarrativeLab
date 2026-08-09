
/**
 * Real-time CSV mirrors for Concept Grid pages under System/PlotGrid/.
 *
 * Layout (Excel / Tablite / CSV Editor friendly):
 *   ,Col 1,Col 2
 *   Row 1,a,b
 *   Row 2,c,d
 *
 * Linked cells with empty content are stored as [[path]] so vault links survive
 * round-trips. plotgrid.json remains the canonical rich state; CSV is the
 * editable text source companions for each page.
 */
import { normalizePath, TFile } from 'obsidian';
import type SceneCardsPlugin from '../main';
import type { CellData, ConceptGridDocument, ConceptGridPage } from '../models/PlotGridData';
import { createEmptyConceptGridPage } from '../models/PlotGridData';

interface PlotGridCsvIndex {
    /** pageId → relative filename inside System/PlotGrid/ */
    files: Record<string, string>;
}

function makeId(prefix: string): string {
    return prefix + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 8);
}

function csvEscape(value: string): string {
    if (/[",\n\r]/.test(value)) {
        return `"${value.replace(/"/g, '""')}"`;
    }
    return value;
}

/** RFC 4180-ish parser that supports quoted commas/newlines. */
export function parseCsv(text: string): string[][] {
    let src = text;
    if (src.charCodeAt(0) === 0xFEFF) src = src.slice(1);
    // Excel often prefixes "sep=,"
    if (/^sep=.(\r?\n)/i.test(src)) {
        src = src.replace(/^sep=.(\r?\n)/i, '');
    }

    const rows: string[][] = [];
    let row: string[] = [];
    let cell = '';
    let inQuotes = false;

    for (let i = 0; i < src.length; i++) {
        const ch = src[i];
        if (inQuotes) {
            if (ch === '"') {
                if (src[i + 1] === '"') {
                    cell += '"';
                    i++;
                } else {
                    inQuotes = false;
                }
            } else {
                cell += ch;
            }
            continue;
        }
        if (ch === '"') {
            inQuotes = true;
            continue;
        }
        if (ch === ',') {
            row.push(cell);
            cell = '';
            continue;
        }
        if (ch === '\n') {
            row.push(cell);
            rows.push(row);
            row = [];
            cell = '';
            continue;
        }
        if (ch === '\r') continue;
        cell += ch;
    }
    // trailing cell/row
    if (cell.length > 0 || row.length > 0) {
        row.push(cell);
        rows.push(row);
    }
    // drop trailing empty rows
    while (rows.length > 0 && rows[rows.length - 1].every(c => !c.trim())) {
        rows.pop();
    }
    return rows;
}

function cellExportValue(cell: CellData | undefined): string {
    if (!cell) return '';
    const content = (cell.content || '').replace(/\r\n/g, '\n');
    if (content.trim()) return content;
    if (cell.linkedSceneId) return `[[${cell.linkedSceneId}]]`;
    return '';
}

function parseImportCell(raw: string): { content: string; linkedSceneId?: string } {
    const text = (raw || '').replace(/\r\n/g, '\n');
    const m = text.trim().match(/^\[\[([^\]]+)\]\]$/);
    if (m) {
        const path = m[1].split('|')[0].trim();
        return { content: '', linkedSceneId: path || undefined };
    }
    return { content: text };
}

export function pageToCsv(page: ConceptGridPage): string {
    const cols = page.columns || [];
    const rows = page.rows || [];
    const matrix: string[][] = [];

    matrix.push(['', ...cols.map(c => c.label || '')]);
    for (const row of rows) {
        const line = [row.label || ''];
        for (const col of cols) {
            line.push(cellExportValue(page.cells[`${row.id}-${col.id}`]));
        }
        matrix.push(line);
    }

    const body = matrix.map(r => r.map(csvEscape).join(',')).join('\r\n');
    // BOM + sep hint keeps Excel / Chinese Excel happy when opened externally.
    return `\uFEFFsep=,\r\n${body}\r\n`;
}

/**
 * Apply a CSV matrix onto an existing page (mutates in place).
 * Overlapping row/col indices keep their ids/styles; extras are created; missing are removed.
 */
export function applyCsvToPage(page: ConceptGridPage, csvText: string): void {
    const matrix = parseCsv(csvText);
    if (matrix.length === 0) {
        page.rows = [];
        page.columns = [];
        page.cells = {};
        return;
    }

    const header = matrix[0] || [];
    const colCount = Math.max(0, header.length - 1);
    const dataRows = matrix.slice(1);

    // Columns
    const nextCols = [...(page.columns || [])];
    while (nextCols.length < colCount) {
        nextCols.push({
            id: makeId('c-'),
            label: '',
            width: 160,
            bgColor: '',
        });
    }
    if (nextCols.length > colCount) nextCols.length = colCount;
    for (let i = 0; i < colCount; i++) {
        nextCols[i].label = (header[i + 1] ?? '').trim() || nextCols[i].label || `Col ${i + 1}`;
    }
    page.columns = nextCols;

    // Rows
    const nextRows = [...(page.rows || [])];
    while (nextRows.length < dataRows.length) {
        nextRows.push({
            id: makeId('r-'),
            label: '',
            height: 80,
            bgColor: '',
        });
    }
    if (nextRows.length > dataRows.length) nextRows.length = dataRows.length;
    for (let i = 0; i < dataRows.length; i++) {
        nextRows[i].label = (dataRows[i][0] ?? '').trim() || nextRows[i].label || `Row ${i + 1}`;
    }
    page.rows = nextRows;

    // Cells
    const nextCells: Record<string, CellData> = {};
    for (let ri = 0; ri < page.rows.length; ri++) {
        const row = page.rows[ri];
        const line = dataRows[ri] || [];
        for (let ci = 0; ci < page.columns.length; ci++) {
            const col = page.columns[ci];
            const key = `${row.id}-${col.id}`;
            const prev = page.cells[key];
            const parsed = parseImportCell(line[ci + 1] ?? '');
            const cell: CellData = prev
                ? { ...prev }
                : {
                    id: makeId('cell-'),
                    content: '',
                    bgColor: '',
                    textColor: '',
                    bold: false,
                    italic: false,
                    align: 'left',
                };
            cell.content = parsed.content;
            if (parsed.linkedSceneId) {
                cell.linkedSceneId = parsed.linkedSceneId;
            } else if (!(line[ci + 1] ?? '').trim()) {
                // Fully empty CSV cell clears both text and link.
                cell.linkedSceneId = undefined;
            }
            // Non-empty text keeps any existing linkedSceneId (body edit of a linked cell).
            cell.manualContent = true;
            nextCells[key] = cell;
        }
    }
    page.cells = nextCells;
}

function pageIdSlug(pageId: string): string {
    const raw = pageId.replace(/^page-/, '');
    return raw.slice(-10).replace(/[^a-zA-Z0-9_-]/g, '') || 'page';
}

export function sanitizeCsvBaseName(title: string, pageId: string): string {
    const base = (title || 'Page')
        .trim()
        .replace(/[\\/:*?"<>|]/g, '-')
        .replace(/\s+/g, ' ')
        .slice(0, 60)
        .trim() || 'Page';
    return `${base}__${pageIdSlug(pageId)}`;
}

export class PlotGridCsvSync {
    /** Paths we are currently writing — ignore vault modify echoes. */
    private writing = new Set<string>();
    private index: PlotGridCsvIndex = { files: {} };

    constructor(private plugin: SceneCardsPlugin) {}

    getFolder(): string {
        return normalizePath(`${this.plugin.getProjectSystemFolder()}/PlotGrid`);
    }

    private indexPath(): string {
        return normalizePath(`${this.getFolder()}/_index.json`);
    }

    private async ensureFolder(): Promise<void> {
        const folder = this.getFolder();
        const adapter = this.plugin.app.vault.adapter;
        if (!await adapter.exists(folder)) {
            await this.plugin.app.vault.createFolder(folder);
        }
    }

    private async loadIndex(): Promise<void> {
        const adapter = this.plugin.app.vault.adapter;
        const path = this.indexPath();
        try {
            if (!await adapter.exists(path)) {
                this.index = { files: {} };
                return;
            }
            const raw = JSON.parse(await adapter.read(path)) as PlotGridCsvIndex;
            this.index = { files: raw?.files && typeof raw.files === 'object' ? raw.files : {} };
        } catch {
            this.index = { files: {} };
        }
    }

    private async saveIndex(): Promise<void> {
        await this.ensureFolder();
        const adapter = this.plugin.app.vault.adapter;
        const path = this.indexPath();
        this.writing.add(path);
        try {
            await adapter.write(path, JSON.stringify(this.index, null, 2));
        } finally {
            window.setTimeout(() => this.writing.delete(path), 400);
        }
    }

    absolutePathForFile(fileName: string): string {
        return normalizePath(`${this.getFolder()}/${fileName}`);
    }

    /** Resolve (and remember) the CSV path for a page. */
    async resolvePageCsvPath(page: ConceptGridPage): Promise<string> {
        await this.loadIndex();
        const desired = `${sanitizeCsvBaseName(page.title, page.id)}.csv`;
        const prev = this.index.files[page.id];
        if (prev && prev !== desired) {
            // Rename on disk when the title changes.
            const adapter = this.plugin.app.vault.adapter;
            const oldPath = this.absolutePathForFile(prev);
            const newPath = this.absolutePathForFile(desired);
            try {
                if (await adapter.exists(oldPath) && !(await adapter.exists(newPath))) {
                    this.writing.add(oldPath);
                    this.writing.add(newPath);
                    await adapter.rename(oldPath, newPath);
                    window.setTimeout(() => {
                        this.writing.delete(oldPath);
                        this.writing.delete(newPath);
                    }, 400);
                } else if (await adapter.exists(oldPath) && await adapter.exists(newPath)) {
                    // Prefer new name; drop stale file.
                    this.writing.add(oldPath);
                    await adapter.remove(oldPath);
                    window.setTimeout(() => this.writing.delete(oldPath), 400);
                }
            } catch { /* non-fatal */ }
        }
        this.index.files[page.id] = desired;
        await this.saveIndex();
        return this.absolutePathForFile(desired);
    }

    async writePageCsv(page: ConceptGridPage): Promise<string> {
        await this.ensureFolder();
        const path = await this.resolvePageCsvPath(page);
        const adapter = this.plugin.app.vault.adapter;
        const contents = pageToCsv(page);
        this.writing.add(path);
        try {
            await adapter.write(path, contents);
        } finally {
            window.setTimeout(() => this.writing.delete(path), 400);
        }
        return path;
    }

    /**
     * Mirror every page to CSV and prune orphans from previous page ids.
     * Called from savePlotGrid (debounced with the JSON write).
     */
    async syncDocument(doc: ConceptGridDocument): Promise<void> {
        await this.ensureFolder();
        await this.loadIndex();

        for (const page of doc.pages) {
            await this.writePageCsv(page);
        }

        // Drop index entries for deleted pages + remove their files.
        const adapter = this.plugin.app.vault.adapter;
        for (const [pageId, fileName] of Object.entries({ ...this.index.files })) {
            if (doc.pages.some(p => p.id === pageId)) continue;
            delete this.index.files[pageId];
            const path = this.absolutePathForFile(fileName);
            try {
                if (await adapter.exists(path)) {
                    this.writing.add(path);
                    await adapter.remove(path);
                    window.setTimeout(() => this.writing.delete(path), 400);
                }
            } catch { /* ignore */ }
        }
        await this.saveIndex();

        // Also remove stray *.csv in the folder that are no longer indexed.
        try {
            const listing = await adapter.list(this.getFolder());
            for (const filePath of listing.files || []) {
                if (!filePath.endsWith('.csv')) continue;
                const name = filePath.split('/').pop() || '';
                const indexed = Object.values(this.index.files).includes(name);
                if (!indexed) {
                    // Don't delete unknown user-dropped CSVs that aren't ours — only
                    // delete files matching our "__slug.csv" naming pattern.
                    if (!/__.+\.csv$/i.test(name)) continue;
                    this.writing.add(filePath);
                    await adapter.remove(filePath);
                    window.setTimeout(() => this.writing.delete(filePath), 400);
                }
            }
        } catch { /* ignore */ }
    }

    isWriting(path: string): boolean {
        return this.writing.has(normalizePath(path));
    }

    isPlotGridCsvPath(path: string): boolean {
        const folder = this.getFolder().toLowerCase() + '/';
        const p = normalizePath(path).toLowerCase();
        return p.startsWith(folder) && p.endsWith('.csv');
    }

    async findPageIdForCsvPath(path: string): Promise<string | null> {
        await this.loadIndex();
        const name = normalizePath(path).split('/').pop() || '';
        for (const [pageId, fileName] of Object.entries(this.index.files)) {
            if (fileName === name) return pageId;
        }
        // Fallback: match __slug suffix to page id slug
        const m = name.match(/__([^.]+)\.csv$/i);
        if (!m) return null;
        const slug = m[1];
        const doc = await this.plugin.loadPlotGrid();
        if (!doc) return null;
        const hit = doc.pages.find(p => pageIdSlug(p.id) === slug);
        return hit?.id ?? null;
    }

    /** Read CSV from disk into the given page object. */
    async importPageFromDisk(page: ConceptGridPage): Promise<boolean> {
        const path = await this.resolvePageCsvPath(page);
        const adapter = this.plugin.app.vault.adapter;
        if (!await adapter.exists(path)) return false;
        let txt = await adapter.read(path);
        applyCsvToPage(page, txt);
        return true;
    }

    /** Ensure CSV exists, return vault TFile if available. */
    async ensurePageCsvFile(page: ConceptGridPage): Promise<TFile | null> {
        const path = await this.writePageCsv(page);
        const abstract = this.plugin.app.vault.getAbstractFileByPath(path);
        return abstract instanceof TFile ? abstract : null;
    }
}

/** Create a blank page shaped from CSV (used for import-as-new-page). */
export function pageFromCsv(csvText: string, title?: string): ConceptGridPage {
    const page = createEmptyConceptGridPage(title);
    applyCsvToPage(page, csvText);
    return page;
}
