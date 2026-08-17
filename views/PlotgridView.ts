/* eslint-disable @typescript-eslint/no-floating-promises, @typescript-eslint/no-misused-promises, @typescript-eslint/no-unnecessary-type-assertion, @typescript-eslint/no-unused-vars -- Obsidian's API surface and several untyped third-party libraries force dynamic dispatch; floating promises are intentional in DOM/event handlers; matching enable at end of file */
import { WorkspaceLeaf, Menu, TFile, Notice, MarkdownRenderer, Component } from 'obsidian';
import * as obsidian from 'obsidian';
import {
    CellData,
    PlotGridData,
    ConceptGridDocument,
    ConceptGridPage,
    createEmptyConceptGridDocument,
    getActiveConceptGridPage,
    isDefaultEmptyConceptGrid,
    isIncompleteConceptGridPull,
    conceptGridDocumentsSharePage,
    normalizeConceptGridDocument,
} from '../models/PlotGridData';
import { getActiveUiLanguage, t } from '../utils/i18n';
import { showMenuSafely } from '../utils/obsidianMenu';
import {
    loadPlotGridUniverModule,
    type PlotGridUniverContextAction,
    type PlotGridUniverHost,
} from '../utils/loadPlotGridUniver';
import { conceptGridContentFingerprint } from '../services/PlotGridXlsxCodec';
import {
    AXIS_CORNER_CELL_ID,
    axisColumnCellId,
    axisRowCellId,
    cellHasNoteLink,
    cellRequiresMarkdownEditor,
    getPlotGridCellAtUniverCoords,
    syncAxisLabelFromCell,
    univerCoordsForPlotGridCell,
    unwrapAllNoteLinks,
    unwrapMatchingNoteLinks,
} from '../utils/plotGridCellEdit';
import { SceneManager } from '../services/SceneManager';
import { renderViewSwitcher } from '../components/ViewSwitcher';
import { isMobile } from '../components/MobileAdapter';
import { PLOTGRID_VIEW_TYPE } from '../constants';
import { attachTooltip } from '../components/Tooltip';
import type SceneCardsPlugin from '../main';
import { openConfirmModal } from '../components/ConfirmModal';
import { WikilinkSuggest } from '../components/WikilinkSuggest';
import {
    applyMarkdownInputAction,
    installObsidianMarkdownShortcuts,
    type MarkdownInputAction,
} from '../utils/markdownInput';
import { installTextareaUndoHistory, replaceTextareaValue } from '../utils/textareaHistory';
import { ProjectBoundItemView } from './ProjectBoundItemView';
import { deriveProjectFoldersFromFilePath } from '../models/StoryLineProject';

// Basic Plot Grid implementation (ground-up) following the supplied guide.
// This file implements the core model, rendering, editing, and persistence.

function nextPaint(): Promise<void> {
    return new Promise(resolve => {
        window.requestAnimationFrame(() => {
            window.requestAnimationFrame(() => resolve());
        });
    });
}

function makeId(prefix = '') {
    return prefix + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 8);
}

export class PlotgridView extends ProjectBoundItemView {
    plugin: SceneCardsPlugin | undefined;
    /** Full multi-page document persisted to Library/datasheet.xlsx */
    // eslint-disable-next-line obsidianmd/prefer-active-doc -- Concept Grid data model, not the browser Document.
    document: ConceptGridDocument = createEmptyConceptGridDocument();
    /** False until loadData finishes — persist must not write the default empty grid. */
    private hasHydratedDocument = false;
    /** Active page working set (same object reference as the page in `document`). */
    data: PlotGridData = getActiveConceptGridPage(this.document);
    saveDebounce: number | null = null;

    private bodyEl: HTMLDivElement | null = null;
    private wrapperEl: HTMLDivElement | null = null;
    private scrollAreaEl: HTMLDivElement | null = null;
    private canvasEl: HTMLDivElement | null = null;
    /** Covers Univer's empty default workbook until the real sheet paints. */
    private loadingEl: HTMLDivElement | null = null;
    /** Active data cell, kept in sync with Univer selection. */
    private selectedRow: number | null = null;
    private selectedCol: number | null = null;
    /** Embedded Univer Sheets is the canonical grid UI. */
    private univerHost: PlotGridUniverHost | null = null;
    private univerMountPromise: Promise<void> | null = null;
    private univerLoadFailed = false;
    private univerLoadError: unknown = null;
    private lastUniverSel: { sheetId: string; row: number; col: number } | null = null;
    private univerViewStateSig = '';
    /** System/ folder the in-memory document was loaded from — used to block cross-project saves. */
    private loadedSystemFolder: string | null = null;
    /** Project manifest this workbook belongs to; disk I/O never follows another active tab. */
    private loadedProjectFile: string | null = null;
    /** Floating cell editors keyed by cell id (multiple may be open at once). */
    private cellEditorWindows = new Map<string, HTMLElement & {
        __nlCellEditorCleanup?: () => void;
        __nlCellEditorFlush?: () => void;
        __nlCellEditorFocus?: (opts?: { insertWikilink?: boolean }) => void;
        __nlCellEditorSetContent?: (value: string, resetLink?: boolean) => void;
    }>();
    private cellEditorZSeq = 10000;

    constructor(leaf: WorkspaceLeaf, plugin?: SceneCardsPlugin) {
        super(leaf);
        this.plugin = plugin;
        this.ensureProjectBinding(plugin?.sceneManager?.activeProject?.filePath);
    }

    getViewType(): string {
        return PLOTGRID_VIEW_TYPE;
    }

    getDisplayText(): string {
        const manager = this.plugin?.sceneManager;
        const title = this.resolveProjectTitle(manager?.getProjects() ?? [], manager?.activeProject);
        return title || t('Concept Grid');
    }

    async onOpen(): Promise<void> {
        if (this.plugin) this.captureProjectBinding(this.plugin.sceneManager);
        // Render into the same inner container used by other views so styles match
        const container = this.containerEl.children[1] as HTMLElement;
        container.empty();
        container.addClass('story-line-board-container');

        // Concept Grid is desktop-only — show friendly message on mobile
        if (isMobile) {
            const msg = container.createDiv('sl-mobile-unavailable');
            msg.createEl('h3', { text: t('Concept Grid') });
            msg.createEl('p', { text: t('The plot grid requires a larger screen. Use the Board view to manage scenes on mobile.') });
            return;
        }

        this.containerEl.addClass('plot-grid-root');

        this.univerLoadFailed = false;
        this.univerLoadError = null;
        this.buildLayout(container);
        this.renderToolbar();
        const peeked = this.plugin?.peekPlotGridDoc?.(this.getTargetProjectFile()) ?? null;
        if (peeked && !isDefaultEmptyConceptGrid(normalizeConceptGridDocument(peeked))) {
            this.document = normalizeConceptGridDocument(peeked);
            this.bindActivePage();
            this.hasHydratedDocument = true;
        }
        this.showSpreadsheetLoading();
        await this.loadData();
        if (!container.isConnected) return;
        this.renderToolbar();
        this.renderGrid({ forcePush: true });

        this.registerEvent(this.app.workspace.on('active-leaf-change', leaf => {
            if (leaf === this.leaf) this.univerHost?.relayout();
        }));

        // Watch for file renames to update linkedSceneId paths AND row sourceIds
        this.registerEvent(this.app.vault.on('rename', (file, oldPath) => {
            if (file instanceof TFile) {
                let changed = false;
                for (const page of this.document.pages) {
                    for (const key of Object.keys(page.cells || {})) {
                        const c = page.cells[key];
                        if (c && c.linkedSceneId === oldPath) { c.linkedSceneId = file.path; changed = true; }
                    }
                    for (const row of page.rows || []) {
                        if (row.sourceType === 'auto' && row.sourceId === oldPath) {
                            row.sourceId = file.path;
                            changed = true;
                        }
                    }
                }
                if (changed) { this.scheduleSave(); this.renderGrid(); }
            }
        }));

        // Linked file deleted externally — keep linkedSceneId, fall back to plain-text UI
        this.registerEvent(this.app.vault.on('delete', (file) => {
            if (!(file instanceof TFile)) return;
            const scMgr = this.plugin?.sceneManager as SceneManager | undefined;
            // Prefer scene body while still indexed (handler order is not guaranteed)
            const scene = scMgr?.getScene(file.path);
            let touched = false;
            for (const page of this.document.pages) {
                for (const c of Object.values(page.cells || {})) {
                    if (!c || c.linkedSceneId !== file.path) continue;
                    if (scene?.corkboardNote) {
                        const body = (scene.body || '').trim();
                        if (body && !(c.content || '').trim()) {
                            c.content = body;
                            c.manualContent = true;
                        }
                    }
                    touched = true;
                }
            }
            if (touched) {
                this.scheduleSave();
                this.renderGrid({ forcePush: true });
            }
        }));
    }

    /** Tear down Univer so the next render remounts the correct project workbook. */
    private disposeUniverHost(options: { persist?: boolean } = {}): void {
        this.lastUniverSel = null;
        if (options.persist !== false) {
            try {
                this.univerHost?.flush();
            } catch { /* ignore */ }
        }
        // Invalidate in-flight mounts only after flush so onDocumentChange still applies.
        this.univerMountGeneration += 1;
        try {
            this.univerHost?.dispose();
        } catch { /* ignore */ }
        this.univerHost = null;
        this.univerMountPromise = null;
        this.univerStructureSig = '';
        this.univerViewStateSig = '';
        this.resetUniverCanvasLayout();
    }

    /** Flush Univer into memory and write datasheet.xlsx for the bound System folder. */
    private async persistBoundPlotGrid(): Promise<void> {
        if (!this.hasHydratedDocument) return;
        const projectFile = this.loadedProjectFile;
        this.closeAllCellEditors();
        this.flushUniverIntoDocument({ acceptCleared: true });
        this.cancelPendingSave();
        if (!projectFile || !this.plugin || typeof this.plugin.savePlotGrid !== 'function') return;
        try {
            await this.plugin.savePlotGrid(this.document, {
                projectFilePath: projectFile,
                fromLiveEditor: true,
            });
        } catch (error) {
            console.error('[NarrativeLab] Plot Grid persist failed:', error);
        }
    }

    async onClose(): Promise<void> {
        // Floating Markdown drafts must enter the model before Univer's final pull.
        const projectFile = this.loadedProjectFile;
        this.closeAllCellEditors();
        this.flushUniverIntoDocument({ acceptCleared: true });
        this.cancelPendingSave();
        if (
            this.hasHydratedDocument
            && projectFile
            && this.plugin
            && typeof this.plugin.savePlotGrid === 'function'
        ) {
            try {
                await this.plugin.savePlotGrid(this.document, {
                    projectFilePath: projectFile,
                    fromLiveEditor: true,
                });
            } catch (error) {
                console.error('[NarrativeLab] Final Plot Grid save failed:', error);
            }
        }
        this.disposeUniverHost({ persist: false });
        this.hideSpreadsheetLoading();
        // disposeUniverHost performs one last pull; the explicit save above is
        // authoritative, so do not leave a second autosave running after close.
        this.cancelPendingSave();
        this.loadedSystemFolder = null;
        this.loadedProjectFile = null;
    }

    onResize(): void {
        this.univerHost?.relayout();
    }

    private closeAllCellEditors(): void {
        for (const win of [...this.cellEditorWindows.values()]) {
            try { win.__nlCellEditorFlush?.(); } catch { /* ignore */ }
            try { win.__nlCellEditorCleanup?.(); } catch { /* ignore */ }
            win.remove();
        }
        this.cellEditorWindows.clear();
    }

    private bringCellEditorToFront(win: HTMLElement, pinned = false): void {
        this.cellEditorZSeq += 1;
        // Stay below Obsidian modals / FuzzySuggestModal (--layer-modal ≈ 50).
        // The previous 10000+ stacking hid note pickers behind this window.
        const base = pinned ? 44 : 34;
        win.style.zIndex = String(base + (this.cellEditorZSeq % 10));
    }

    private columnIndexToLetters(index1: number): string {
        let n = Math.max(1, Math.floor(index1));
        let letters = '';
        while (n > 0) {
            const rem = (n - 1) % 26;
            letters = String.fromCharCode(65 + rem) + letters;
            n = Math.floor((n - 1) / 26);
        }
        return letters;
    }

    private formatCellEditorCoords(row: number, col: number): string {
        return `${this.columnIndexToLetters(col + 1)}${row + 1}`;
    }

    private resolveCellEditorHeading(cell: CellData): string {
        const coords = this.findCellUniverCoords(cell);
        const address = coords ? this.formatCellEditorCoords(coords.row, coords.col) : '';
        const key = cell.id;
        let rowLabel = '';
        let colLabel = '';
        for (const page of this.document.pages) {
            for (const row of page.rows || []) {
                for (const col of page.columns || []) {
                    if (`${row.id}-${col.id}` !== key) continue;
                    rowLabel = (row.label || '').trim();
                    colLabel = (col.label || '').trim();
                    break;
                }
                if (rowLabel || colLabel) break;
            }
            if (rowLabel || colLabel) break;
        }
        const labels = [rowLabel, colLabel].filter(Boolean).join(' · ');
        if (address && labels) return `${address} · ${labels}`;
        if (address) return address;
        if (labels) return labels;
        return t('Cell editor');
    }

    private getTargetProjectFile(): string {
        return this.getBoundProjectFile()
            || this.loadedProjectFile
            || this.plugin?.sceneManager?.activeProject?.filePath
            || '';
    }

    private getActiveSystemFolder(): string {
        const projectFile = this.getTargetProjectFile();
        return projectFile
            ? `${deriveProjectFoldersFromFilePath(projectFile).baseFolder}/System`
            : '';
    }

    /** Commit the active native sheet into the authoritative NL document. */
    private flushUniverIntoDocument(options: { acceptCleared?: boolean } = {}): void {
        void options.acceptCleared;
        const host = this.univerHost;
        if (!host) return;
        try {
            host.flush();
            const next = normalizeConceptGridDocument(host.getDocument());
            // Insert-sheet / mid-dispose snapshots can omit existing worksheets
            // and look like an empty workbook. Never replace a real grid with that.
            if (isIncompleteConceptGridPull(this.document, next)) return;
            // A dispose/remount can yield the default placeholder. Persist,
            // autosave, and tab-close pass acceptCleared so user deletes win —
            // but still refuse wiping a filled workbook down to the placeholder.
            if (
                isDefaultEmptyConceptGrid(next)
                && !isDefaultEmptyConceptGrid(this.document)
            ) {
                return;
            }
            this.document = next;
            this.bindActivePage();
        } catch (error) {
            console.warn('[NarrativeLab] Could not flush spreadsheet state:', error);
        }
    }

    /** Undo Univer host layout so the next mount measures a clean flex canvas. */
    private resetUniverCanvasLayout(): void {
        this.wrapperEl?.removeClass('is-univer-mode');
        this.scrollAreaEl?.removeClass('is-univer-host');
        this.scrollAreaEl?.setCssStyles({
            overflow: 'auto',
            position: 'relative',
            flex: '1 1 0',
            minHeight: '0',
            minWidth: '0',
            cursor: 'grab',
            display: 'block',
        });
        if (this.canvasEl) {
            this.canvasEl.removeClass('plot-grid-univer-canvas');
            this.canvasEl.removeClass('plot-grid-univer-host');
            this.canvasEl.setCssStyles({
                position: 'relative',
                top: '',
                right: '',
                bottom: '',
                left: '',
                inset: '',
                width: '100%',
                height: '',
                minHeight: '',
                overflow: '',
            });
        }
    }

    private cancelPendingSave(): void {
        if (this.saveDebounce) {
            window.clearTimeout(this.saveDebounce);
            this.saveDebounce = null;
        }
    }

    private async loadData() {
        try {
            const projectFile = this.getTargetProjectFile();
            const folder = this.getActiveSystemFolder();
            const projectChanged = this.loadedProjectFile != null
                && projectFile.length > 0
                && this.loadedProjectFile !== projectFile;
            if (projectChanged) {
                // Never flush the previous project's pending autosave into the new System/ folder.
                // Persist the outgoing workbook first — dispose alone used to cancel the
                // debounce and drop in-Univer edits that had not pulled yet.
                await this.persistBoundPlotGrid();
                this.hasHydratedDocument = false;
                this.univerLoadFailed = false;
                this.univerLoadError = null;
                this.disposeUniverHost({ persist: false });
            }

            let loaded: ConceptGridDocument | null = null;
            if (this.plugin && typeof this.plugin.loadPlotGrid === 'function') {
                loaded = await this.plugin.loadPlotGrid(projectFile);
            } else {
                loaded = null;
            }
            if (loaded) {
                this.document = normalizeConceptGridDocument(loaded);
                this.hasHydratedDocument = true;
            } else {
                this.document = createEmptyConceptGridDocument();
                // Existing datasheet.xlsx (including unreadable) must not be
                // treated as a hydrated empty model — persist/autosave/close
                // would write the default grid over it.
                const existed = projectFile
                    ? await this.plugin?.plotGridXlsxExists?.(projectFile)
                    : false;
                this.hasHydratedDocument = existed !== true;
            }
            this.bindActivePage();
            this.loadedProjectFile = projectFile || this.loadedProjectFile;
            this.loadedSystemFolder = folder || this.loadedSystemFolder;
            // Auto-repair broken linkedSceneId paths (e.g. after project migration)
            this.repairLinkedScenePaths();
            // Strip legacy auto-sync markers ("✓", "★ POV", "POV: …") that
            // older builds wrote into cell.content. The pill row inside each
            // cell now carries that information instead, so the marker text
            // would just show up twice and clutter the top of the cell.
            this.stripLegacyAutoMarkers();
        } catch (error) {
            console.error('[NarrativeLab] Failed to load Plot Grid:', error);
            new Notice(t('Spreadsheet failed to load'));
            this.document = createEmptyConceptGridDocument();
            this.bindActivePage();
            this.hasHydratedDocument = false;
        }
    }

    private bindActivePage(): void {
        if (!this.document.pages.length) {
            this.document = createEmptyConceptGridDocument();
        }
        const page = getActiveConceptGridPage(this.document);
        this.document.activePageId = page.id;
        this.data = page;
    }

    private getActivePage(): ConceptGridPage {
        return getActiveConceptGridPage(this.document);
    }

    /**
     * Remove auto-generated presence/POV marker text left over in
     * `cell.content` by earlier sync runs. Only touches cells whose content
     * is exactly one of the known marker strings AND that aren't flagged as
     * `manualContent`, so user-typed text is never destroyed.
     */
    private stripLegacyAutoMarkers(): void {
        const markerRe = /^(✓|★\s*POV|POV:\s.+)$/;
        let dirty = false;
        for (const page of this.document.pages) {
            for (const key of Object.keys(page.cells || {})) {
                const cell = page.cells[key];
                if (!cell || cell.manualContent) continue;
                const text = (cell.content || '').trim();
                if (text && markerRe.test(text)) {
                    cell.content = '';
                    dirty = true;
                }
            }
        }
        if (dirty) this.scheduleSave();
    }

    /**
     * Repair linkedSceneId references that point to moved files.
     * Missing vault files keep the path so the cell can stay linked as plain text
     * until the note is restored or the cell is converted again.
     */
    private repairLinkedScenePaths(): void {
        const scMgr = this.plugin?.sceneManager as SceneManager | undefined;
        if (!scMgr) return;

        let dirty = false;
        for (const page of this.document.pages) {
            for (const key of Object.keys(page.cells || {})) {
                const cell = page.cells[key];
                if (!cell) continue;
                if (!cell.linkedSceneId) continue;

                // NL scene/note still indexed at this path
                if (scMgr.getScene(cell.linkedSceneId)) continue;
                // Any vault markdown still present (Research / arbitrary note)
                if (this.resolveLinkedVaultFile(cell.linkedSceneId)) continue;

                // Try to find a moved scene/note by filename — only inside this
                // workbook's project tree so same-name notes in other books cannot
                // steal the link.
                const fileName = cell.linkedSceneId.split('/').pop();
                if (!fileName) continue;

                const projectPrefix = (this.loadedSystemFolder || this.getActiveSystemFolder())
                    .replace(/[/\\]+System[/\\]?$/i, '')
                    .replace(/\/+$/, '');
                const allScenes = scMgr.getAllScenes();
                const scoped = projectPrefix
                    ? allScenes.filter(s => {
                        const path = s.filePath.replace(/\\/g, '/');
                        return path === projectPrefix
                            || path.startsWith(`${projectPrefix}/`);
                    })
                    : allScenes;
                const matches = scoped.filter(s =>
                    s.filePath.endsWith('/' + fileName) || s.filePath === fileName,
                );
                if (matches.length === 1) {
                    cell.linkedSceneId = matches[0].filePath;
                    dirty = true;
                }
                // else: keep broken path — UI falls back to plain text, link preserved
            }
        }
        if (dirty) this.scheduleSave();
    }

    private scheduleSave() {
        const plugin = this.plugin;
        if (!plugin || !this.hasHydratedDocument) return;
        // Never autosave while Univer's in-cell editor / IME is live — writing the
        // vault triggers refreshPlotGridViews and remounts the workbook mid-keystroke.
        // Closing/switching the view performs an explicit final flush, so autosave
        // must never force-close a user who is still typing a long cell value.
        if (this.univerHost?.isEditorBusy()) {
            if (this.saveDebounce) window.clearTimeout(this.saveDebounce);
            this.saveDebounce = window.setTimeout(() => this.scheduleSave(), 250);
            return;
        }
        // Capture the System/ folder this in-memory document belongs to.
        const folderAtSchedule = this.loadedSystemFolder || this.getActiveSystemFolder();
        const projectAtSchedule = this.loadedProjectFile || this.getTargetProjectFile();
        if (this.saveDebounce) window.clearTimeout(this.saveDebounce);
        // debounce and call plugin-level save API if available
        const timerId = window.setTimeout(async () => {
            try {
                if (!this.hasHydratedDocument) return;
                if (this.univerHost?.isEditorBusy()) {
                    this.scheduleSave();
                    return;
                }
                if (!projectAtSchedule) return;
                // Always write to the folder this workbook was loaded from. If the
                // global active project changed, path-scoped save keeps edits in
                // the bound book instead of aborting or bleeding into another project.
                void folderAtSchedule;
                if (this.univerHost && this.cellEditorWindows.size === 0) {
                    this.flushUniverIntoDocument({ acceptCleared: true });
                }
                if (typeof plugin.savePlotGrid === 'function') {
                    await plugin.savePlotGrid(this.document, {
                        projectFilePath: projectAtSchedule,
                        fromLiveEditor: true,
                    });
                }
            } catch (error) {
                // The plugin-level writer already retries transient file locks.
                // Keep the failure observable without showing repeated toasts.
                console.error('[NarrativeLab] Plot Grid autosave failed:', error);
            } finally {
                // Also clear on project-switch early returns. A stale timer id
                // made refresh logic think a save was still pending forever.
            if (this.saveDebounce === timerId) this.saveDebounce = null;
            }
        }, 800);
        this.saveDebounce = timerId;
    }

    private buildLayout(container: HTMLElement) {
        this.bodyEl = container.createDiv('concept-grid-body');
        this.bodyEl.setCssStyles({
            display: 'flex',
            flexDirection: 'column',
            height: '100%',
            width: '100%',
            minHeight: '0',
        });

        // Main grid area. Univer's own footer owns worksheet tabs.
        this.wrapperEl = this.bodyEl.createDiv('plot-grid-wrapper concept-grid-main');
        this.wrapperEl.setCssStyles({
            display: 'flex',
            flexDirection: 'column',
            flex: '1 1 auto',
            minWidth: '0',
            minHeight: '0',
            overflow: 'hidden',
        });
        const toolbar = this.wrapperEl.createDiv('story-line-toolbar plot-grid-toolbar');
        toolbar.setCssStyles({ flex: '0 0 auto' });

        // Work row containing the Univer sheet.
        const workArea = this.wrapperEl.createDiv('plot-grid-work-area');

        this.scrollAreaEl = workArea.createDiv('plot-grid-scroll-area');
        this.scrollAreaEl.setCssStyles({
            flex: '1 1 0',
            overflow: 'auto',
            position: 'relative',
            minWidth: '0',
            minHeight: '0',
        });
        this.canvasEl = this.scrollAreaEl.createDiv('plot-grid-canvas');
        this.canvasEl.setCssStyles({ position: 'relative' });
        // Use CSS zoom instead of transform: scale() — transforms break position: sticky
        this.canvasEl.setCssStyles({
            width: '100%',
            boxSizing: 'border-box',
        });
    }

    private switchPage(pageId: string): void {
        if (!this.document.pages.some(p => p.id === pageId)) return;
        this.flushUniverIntoDocument({ acceptCleared: true });
        if (!this.document.pages.some(p => p.id === pageId)) return;
        this.document.activePageId = pageId;
        this.bindActivePage();
        try {
            this.univerHost?.setActiveSheet(pageId);
            this.univerHost?.syncMeta(this.document);
        } catch { /* ignore an unavailable host during initial mount */ }
        this.scheduleSave();
        this.renderToolbar();
        this.renderGrid();
    }

    /** Jump to a datasheet page/row from a Library archive appearance link. */
    navigateToAppearance(hit: {
        pageId: string;
        rowId?: string;
        rowIndex?: number;
        columnIndex?: number;
    }): void {
        if (hit.pageId) this.switchPage(hit.pageId);
        const page = this.document.pages.find(p => p.id === hit.pageId)
            || this.document.pages.find(p => p.id === this.document.activePageId);
        if (!page) return;
        let rowIndex = typeof hit.rowIndex === 'number' ? hit.rowIndex : -1;
        if (rowIndex < 0 && hit.rowId) {
            rowIndex = page.rows.findIndex(r => r.id === hit.rowId);
        }
        const colIndex = typeof hit.columnIndex === 'number' && hit.columnIndex >= 0
            ? hit.columnIndex
            : 0;
        if (rowIndex < 0) return;
        // Univer coords: row/col 0 are NarrativeLab header axes; data starts at 1.
        window.setTimeout(() => {
            try {
                this.univerHost?.setActiveSheet(page.id);
                this.univerHost?.setActiveCell(page.id, rowIndex + 1, colIndex + 1);
                this.univerHost?.focus();
            } catch { /* best effort */ }
        }, 80);
    }

    private renderToolbar() {
        if (!this.wrapperEl) return;
        const toolbar = this.wrapperEl.querySelector('.plot-grid-toolbar') as HTMLDivElement | null;
        if (!toolbar) return;
        toolbar.empty();

        const titleRow = toolbar.createDiv('story-line-title-row');
        const projectTitle = this.plugin?.getProjectDisplayName(this.getBoundProjectFile()) || '';
        titleRow.createEl('h3', {
            cls: 'story-line-view-title',
            text: projectTitle,
        });
        // Show active project title next to the main label (no dropdown / new button here)
        // project name shown in top-center only; no inline project selector here

        // View switcher tabs
        if (this.plugin) {
            renderViewSwitcher(toolbar, PLOTGRID_VIEW_TYPE, this.plugin, this.leaf);
        }

        const controls = toolbar.createDiv('story-line-toolbar-controls is-plotgrid-controls');

        // Stats / Converter / Playmode stay on the title/tab row. This control
        // row is created last and takes the full next line, left-aligned.

        const left = controls.createDiv('plot-grid-toolbar-left');
        left.setCssStyles({
            display: 'flex',
            alignItems: 'center',
            gap: '2px',
        });

        const actions = controls.createDiv('plot-grid-toolbar-actions');
        actions.setCssStyles({
            display: 'flex',
            gap: '2px',
        });

        // Toolbar icon styling lives in styles.css under `.plot-grid-toolbar`.

        // Cell Markdown and wikilink actions live in one editor window.
        const editCellBtn = left.createEl('button', { cls: 'clickable-icon' });
        obsidian.setIcon(editCellBtn, 'square-pen');
        attachTooltip(editCellBtn, t('Open cell editor'));
        editCellBtn.addEventListener('click', () => { this.openCellEditorForActiveCell(); });

        const markdownMode = this.plugin?.settings?.plotGridMarkdownEditMode === true;
        const modeBtn = left.createEl('button', {
            cls: `clickable-icon${markdownMode ? ' is-active' : ''}`,
        });
        obsidian.setIcon(modeBtn, 'notebook-pen');
        attachTooltip(
            modeBtn,
            markdownMode
                ? t('Markdown edit mode on — all data cells open the cell editor')
                : t('Markdown edit mode off — plain cells edit in place; linked cells use the cell editor'),
        );
        modeBtn.addEventListener('click', () => {
            if (!this.plugin) return;
            this.plugin.settings.plotGridMarkdownEditMode = !markdownMode;
            void this.plugin.saveSettings();
            this.renderToolbar();
        });

        // Sticky headers toggle — pin row/col labels while scrolling the grid
        const selectedFreezeColumns = this.lastUniverSel?.col != null
            ? Math.max(1, this.lastUniverSel.col + 1)
            : this.selectedCol != null
                ? Math.max(1, this.selectedCol + 2)
                : 1;
        const selectedFreezeRows = this.lastUniverSel?.row != null
            ? Math.max(1, this.lastUniverSel.row + 1)
            : this.selectedRow != null
                ? Math.max(1, this.selectedRow + 2)
                : 1;
        const currentFreezeBoundarySelected = (this.data.frozenColumns ?? 1) === selectedFreezeColumns
            && (this.data.frozenRows ?? 1) === selectedFreezeRows;
        const stickyLabel = this.data.stickyHeaders !== false && currentFreezeBoundarySelected
            ? t('Disable sticky headers')
            : t('Freeze through selected cell');
        const stickyBtn = left.createEl('button', { cls: 'clickable-icon' });
        obsidian.setIcon(stickyBtn, this.data.stickyHeaders !== false ? 'pin' : 'pin-off');
        attachTooltip(stickyBtn, stickyLabel);
        stickyBtn.addEventListener('click', () => {
            const sameBoundary = currentFreezeBoundarySelected;
            if (this.data.stickyHeaders !== false && sameBoundary) {
                this.data.stickyHeaders = false;
            } else {
                this.data.stickyHeaders = true;
                this.data.frozenColumns = selectedFreezeColumns;
                this.data.frozenRows = selectedFreezeRows;
            }
            this.scheduleSave();
            this.renderToolbar();
            this.renderGrid();
        });

        // Cell text formatting is Markdown-only (no Bold/Italic/align toolbar).

        const zoomOut = actions.createEl('button', { cls: 'clickable-icon' });
        obsidian.setIcon(zoomOut, 'zoom-out');
        attachTooltip(zoomOut, t('Zoom out'));
        zoomOut.addEventListener('click', () => this.setZoom(Math.max(0.3, this.data.zoom - 0.1)));

        const zoomLabel = actions.createEl('span', { cls: 'plot-grid-zoom-label', text: Math.round(this.data.zoom * 100) + '%' });
        // Keep the label fixed width so the control doesn't jump when digits change (e.g. 100% -> 99%)
        zoomLabel.setCssStyles({
            display: 'inline-block',
            width: '40px',
            minWidth: '40px',
            textAlign: 'center',
            alignSelf: 'center',
            cursor: 'text',
        });
        zoomLabel.title = t('Click to edit zoom %');
        zoomLabel.addEventListener('click', (ev) => {
            ev.stopPropagation();
            const inp = activeDocument.createElement('input');
            inp.type = 'text';
            inp.value = Math.round(this.data.zoom * 100).toString();
            inp.setCssStyles({ width: '56px' });
            inp.addEventListener('keydown', (ke) => {
                if (ke.key === 'Enter') {
                    const v = Number(inp.value);
                    if (!isNaN(v) && v > 0) this.setZoom(Math.min(200, Math.max(30, v)) / 100);
                    this.renderToolbar();
                } else if (ke.key === 'Escape') this.renderToolbar();
            });
            inp.addEventListener('blur', () => this.renderToolbar());
            zoomLabel.replaceWith(inp);
            inp.focus();
            inp.select();
        });

        const resetZoomBtn = actions.createEl('button', { cls: 'clickable-icon' });
        obsidian.setIcon(resetZoomBtn, 'maximize-2');
        attachTooltip(resetZoomBtn, t('Reset zoom'));
        resetZoomBtn.addEventListener('click', () => this.setZoom(1));

        const zoomIn = actions.createEl('button', { cls: 'clickable-icon' });
        obsidian.setIcon(zoomIn, 'zoom-in');
        attachTooltip(zoomIn, t('Zoom in'));
        zoomIn.addEventListener('click', () => this.setZoom(Math.min(2.0, this.data.zoom + 0.1)));

        actions.appendChild(zoomOut);
        actions.appendChild(zoomLabel);
        actions.appendChild(zoomIn);
        actions.appendChild(resetZoomBtn);

        // Icons are rendered exclusively via `obsidian.setIcon()` above —
        // the previous `lucide.createIcons()` bootstrap was dead code and
        // also caused the bundler to pull the entire `lucide` icon set
        // (including a `Bitcoin` icon) into `main.js`, which tripped the
        // Obsidian plugin reviewer's crypto-wallet heuristic.

        // Ensure icon-only appearance: remove any visible button edges and set icon size
        try {
            const btns = toolbar.querySelectorAll('.icon-button');
            btns.forEach((b) => {
                const btn = b as HTMLElement;
                btn.setCssStyles({
                    background: 'transparent',
                    backgroundColor: 'transparent',
                    backgroundImage: 'none',
                    border: 'none',
                    boxShadow: 'none',
                    outline: 'none',
                    minWidth: '0',
                    width: 'auto',
                    height: 'auto',
                    padding: '2px',
                    borderRadius: '0',
                });
                // set the inner lucide holder and svg size
                const holder = btn.querySelector('i[data-lucide]') as HTMLElement | null;
                if (holder) {
                    holder.setCssStyles({
                        display: 'inline-flex',
                        alignItems: 'center',
                        justifyContent: 'center',
                        background: 'transparent',
                        transition: 'transform 120ms ease, background-color 120ms ease, opacity 120ms ease',
                    });
                    const svg = holder.querySelector('svg') as SVGElement | null;
                    if (svg) {
                        // Do not hard-set width/height — allow the app's icon sizing to control pixel dimensions so it matches BoardView
                        const svgEl = svg as unknown as { setCssStyles: (s: Record<string, string>) => void };
                        svgEl.setCssStyles({ transition: 'transform 120ms ease, opacity 120ms ease' });
                        svgEl.setCssStyles({ opacity: '0.95' });
                        svgEl.setCssStyles({ display: 'block' });
                    }
                }
                // add hover and active feedback for each button
                btn.addEventListener('mouseenter', () => {
                    try {
                        btn.setCssStyles({
                            backgroundColor: 'var(--sl-hover-overlay)',
                            borderRadius: '6px',
                        });
                        const holder = btn.querySelector('i[data-lucide]') as HTMLElement | null;
                        if (holder) holder.setCssStyles({ transform: 'scale(1.08)' });
                    } catch (e) { /* cosmetic, safe to ignore */ }
                });
                btn.addEventListener('mouseleave', () => {
                    try {
                        btn.setCssStyles({
                            background: 'transparent',
                            backgroundColor: 'transparent',
                            borderRadius: '0',
                        });
                        const holder = btn.querySelector('i[data-lucide]') as HTMLElement | null;
                        if (holder) holder.setCssStyles({ transform: '' });
                    } catch (e) { /* cosmetic, safe to ignore */ }
                });
                btn.addEventListener('mousedown', () => {
                    try {
                        const holder = btn.querySelector('i[data-lucide]') as HTMLElement | null;
                        if (holder) holder.setCssStyles({ transform: 'scale(0.96)' });
                    } catch (e) { /* cosmetic, safe to ignore */ }
                });
                btn.addEventListener('mouseup', () => {
                    try {
                        const holder = btn.querySelector('i[data-lucide]') as HTMLElement | null;
                        if (holder) holder.setCssStyles({ transform: '' });
                    } catch (e) { /* cosmetic, safe to ignore */ }
                });
            });
        } catch (e) { /* safe no-op */ }
    }

    private setZoom(z: number) {
        this.data.zoom = z;
        try {
            this.univerHost?.setZoom(this.document.activePageId, z);
            this.univerHost?.syncMeta(this.document);
        } catch { /* host may still be mounting */ }
        this.scheduleSave();
        const toolbar = this.wrapperEl?.querySelector('.plot-grid-toolbar') || this.wrapperEl?.querySelector('.story-line-toolbar');
        const label = toolbar?.querySelector('.plot-grid-zoom-label') as HTMLElement | null;
        if (label) label.textContent = Math.round(z * 100) + '%';
    }

    private univerStructureSig = '';
    private univerMountGeneration = 0;

    /** Structure fingerprint — exclude activePageId so tab switches don't remount. */
    private getUniverStructureSig(): string {
        const folder = this.loadedSystemFolder || this.getActiveSystemFolder();
        return `${folder}::` + this.document.pages.map(p =>
            `${p.id}|${p.title || ''}|${(p.rows || []).map(r => r.id).join(',')}|${(p.columns || []).map(c => c.id).join(',')}`,
        ).join('||');
    }

    private renderGrid(options: { forcePush?: boolean } = {}) {
        if (!this.canvasEl || !this.scrollAreaEl) return;

        this.ensureDefaults();

        if (this.univerLoadFailed) {
            this.renderUniverLoadError();
            return;
        }
        // Never mount Univer on the default empty placeholder while the real
        // workbook is still loading — that paints "页面 1" and then autosave
        // can lag behind the cells the user types into it.
        if (!this.hasHydratedDocument) {
            this.showSpreadsheetLoading();
            return;
        }
        const sig = this.getUniverStructureSig();
        const push = !!this.univerHost && (options.forcePush === true || sig !== this.univerStructureSig);
        if (push) this.univerViewStateSig = '';
        void this.ensureUniverHost({ pushDocument: push }).then(() => {
            if (!this.univerHost) return;
            this.univerStructureSig = this.getUniverStructureSig();
            // Only re-apply sheet/freeze/zoom when we remounted or view state
            // actually changed — setActiveSheet on every render jumps the viewport.
            if (push) {
                try {
                    this.univerHost.setActiveSheet(this.document.activePageId);
                } catch { /* ignore */ }
            }
            this.applyUniverViewState();
        });
    }

    private async ensureUniverHost(options: { pushDocument?: boolean } = {}): Promise<void> {
        if (!this.canvasEl || !this.plugin) return;
        if (this.univerLoadFailed) {
            this.renderUniverLoadError();
            return;
        }

        if (this.univerHost) {
            if (options.pushDocument) {
                try {
                    // Do not flush before push — flush+setDocument fought each other.
                    this.univerHost.setDocument(this.document);
                } catch (e) {
                    console.warn('[NarrativeLab] Univer setDocument failed:', e);
                }
            }
            return;
        }

        if (this.univerMountPromise) {
            await this.univerMountPromise;
            // Class-field narrowing treats univerHost as null after the early return above;
            // re-read via a local cast after the async mount completes.
            const host = this.univerHost as PlotGridUniverHost | null;
            if (host && options.pushDocument) {
                host.setDocument(this.document);
            }
            return;
        }

        const mountGen = ++this.univerMountGeneration;
        this.univerMountPromise = (async () => {
            try {
                this.wrapperEl?.addClass('is-univer-mode');
                this.scrollAreaEl?.addClass('is-univer-host');
                this.canvasEl!.empty();
                this.canvasEl!.addClass('plot-grid-univer-canvas');
                // Flex-fill (not absolute) — absolute + 0-height parent collapses the sheet.
                this.canvasEl!.setCssStyles({
                    position: 'relative',
                    flex: '1 1 auto',
                    width: '100%',
                    height: '100%',
                    minHeight: '0',
                    inset: '',
                });
                this.scrollAreaEl?.setCssStyles({
                    overflow: 'hidden',
                    position: 'relative',
                    display: 'flex',
                    flexDirection: 'column',
                    flex: '1 1 0',
                    minHeight: '0',
                    minWidth: '0',
                    cursor: 'default',
                });
                this.showSpreadsheetLoading();
                // Only wait for layout when the flex host has not received a height yet.
                if (this.canvasEl && this.canvasEl.clientHeight < 48) {
                    this.canvasEl.setCssStyles({ minHeight: '240px' });
                    await nextPaint();
                }
                if (mountGen !== this.univerMountGeneration || !this.canvasEl) {
                    return;
                }

                const mod = await loadPlotGridUniverModule(this.plugin!);
                if (mountGen !== this.univerMountGeneration || !this.canvasEl) {
                    return;
                }
                const locale = getActiveUiLanguage() === 'zh' ? 'zh' : 'en';
                const host = mod.createPlotGridUniverHost({
                    container: this.canvasEl,
                    initialDocument: this.document,
                    locale,
                    getAuthoritativeDocument: () => this.document,
                    isExternalEditorBusy: () => this.cellEditorWindows.size > 0,
                    onReady: () => {
                        if (mountGen !== this.univerMountGeneration) return;
                        this.hideSpreadsheetLoading();
                    },
                    shouldBlockUniverCellEdit: (sheetId, row, col) => {
                        const cell = this.getDataCellAt(sheetId, row, col);
                        const mode = this.plugin?.settings?.plotGridMarkdownEditMode === true;
                        return cellRequiresMarkdownEditor(cell, row, col, mode);
                    },
                    onRequestMarkdownCellEdit: (info) => {
                        if (mountGen !== this.univerMountGeneration) return;
                        this.lastUniverSel = {
                            sheetId: info.sheetId,
                            row: info.row,
                            col: info.col,
                        };
                        // Pull Univer first so Clear contents / Clear all are in cell.content
                        // before the Markdown editor reads it.
                        this.flushUniverIntoDocument({ acceptCleared: true });
                        const cell = this.getActiveDataCellFromUniver();
                        if (cell) this.openCellMarkdownEditor(cell);
                    },
                    onContextMenuAction: (action) => {
                        if (mountGen !== this.univerMountGeneration) return;
                        void this.handleUniverContextMenuAction(action);
                    },
                    onShowConnectedNotes: (position) => {
                        if (mountGen !== this.univerMountGeneration) return;
                        this.showConnectedNotesMenu(position);
                    },
                    getConnectedNotes: () => {
                        if (mountGen !== this.univerMountGeneration) return [];
                        return this.collectConnectedNotes(this.getActiveDataCellFromUniver());
                    },
                    onOpenConnectedNote: (path) => {
                        if (mountGen !== this.univerMountGeneration) return;
                        this.openConnectedNote(path);
                    },
                    onContextMenuRequest: (position) => {
                        if (mountGen !== this.univerMountGeneration) return;
                        const menu = new Menu();
                        this.appendConnectedNotesMenuItems(menu);
                        menu.addSeparator();
                        const cell = this.getActiveDataCellFromUniver();
                        const linkedPath = cell?.linkedSceneId || '';
                        if (linkedPath) {
                            menu.addItem(item => item
                                .setTitle(t('Unlink Note'))
                                .setIcon('unlink')
                                .onClick(() => void this.handleUniverContextMenuAction('unlink-note')));
                        } else {
                            menu.addItem(item => item
                                .setTitle(t('Link Note…'))
                                .setIcon('link')
                                .onClick(() => void this.handleUniverContextMenuAction('link-note')));
                        }
                        menu.addSeparator();
                        const add = (title: string, icon: string, action: PlotGridUniverContextAction) => {
                            menu.addItem(item => item
                                .setTitle(t(title))
                                .setIcon(icon)
                                .onClick(() => void this.handleUniverContextMenuAction(action)));
                        };
                        add('Convert to Notes', 'notebook-pen', 'convert-to-notes');
                        add('Convert to Scene', 'clapperboard', 'convert-to-scene');
                        add('Convert to Research', 'search', 'convert-to-research');
                        menu.addSeparator();
                        add('Reset spreadsheet', 'rotate-ccw', 'reset-grid');
                        showMenuSafely(menu, position);
                    },
                    onDocumentChange: (doc) => {
                        if (mountGen !== this.univerMountGeneration) return;
                        const next = normalizeConceptGridDocument(doc);
                        if (!conceptGridDocumentsSharePage(this.document, next)) return;
                        if (isIncompleteConceptGridPull(this.document, next)) return;
                        if (
                            isDefaultEmptyConceptGrid(next)
                            && !isDefaultEmptyConceptGrid(this.document)
                        ) return;
                        this.document = next;
                        this.synchronizeWikilinkCells();
                        this.bindActivePage();
                        this.syncOpenCellEditorsFromDocument();
                        // Univer already applied sheet-bar / cell mutations.
                        // Keep the structure sig current so a later toolbar
                        // render does not remount and wipe those edits.
                        this.univerStructureSig = this.getUniverStructureSig();
                        this.scheduleSave();
                    },
                    onSelectionChange: (info) => {
                        if (mountGen !== this.univerMountGeneration) return;
                        this.lastUniverSel = info;
                        if (info.sheetId && info.sheetId !== this.document.activePageId) {
                            const page = this.document.pages.find(p => p.id === info.sheetId);
                            if (page) {
                                this.document.activePageId = page.id;
                                this.bindActivePage();
                                this.scheduleSave();
                            }
                        }
                        this.selectedRow = info.row > 0 ? info.row - 1 : null;
                        this.selectedCol = info.col > 0 ? info.col - 1 : null;
                    },
                });
                if (mountGen !== this.univerMountGeneration) {
                    try { host.dispose(); } catch { /* ignore */ }
                    return;
                }
                this.univerHost = host;
                this.univerStructureSig = this.getUniverStructureSig();
                this.applyUniverViewState();
                try { host.refreshLinkMarkers(); } catch { /* ignore */ }
                // Let layout settle, then nudge Univer to measure the filled host.
                window.requestAnimationFrame(() => {
                    window.requestAnimationFrame(() => {
                        window.dispatchEvent(new Event('resize'));
                    });
                });
                await nextPaint();
                if (mountGen !== this.univerMountGeneration) return;
                // Overlay stays until onReady (real sheets, not Univer's blank
                // default). Fall back so a hung reveal cannot block the view.
                window.setTimeout(() => {
                    if (mountGen !== this.univerMountGeneration) return;
                    this.hideSpreadsheetLoading();
                }, 2500);
            } catch (e) {
                if (mountGen !== this.univerMountGeneration) return;
                console.error('[NarrativeLab] Univer Plot Grid failed to initialize', e);
                this.univerLoadFailed = true;
                this.univerLoadError = e;
                this.univerHost = null;
                this.hideSpreadsheetLoading();
                this.renderUniverLoadError();
            } finally {
                if (mountGen === this.univerMountGeneration) {
                    this.univerMountPromise = null;
                }
            }
        })();

        await this.univerMountPromise;
    }

    private showSpreadsheetLoading(): void {
        if (!this.scrollAreaEl) return;
        if (this.loadingEl?.isConnected) return;
        const panel = this.scrollAreaEl.createDiv('plot-grid-univer-loading');
        panel.createEl('p', { text: t('Loading spreadsheet…') });
        this.loadingEl = panel;
    }

    private hideSpreadsheetLoading(): void {
        this.loadingEl?.remove();
        this.loadingEl = null;
    }

    private renderUniverLoadError(): void {
        if (!this.canvasEl) return;
        this.wrapperEl?.addClass('is-univer-mode');
        this.scrollAreaEl?.addClass('is-univer-host');
        this.canvasEl.empty();
        this.canvasEl.addClass('plot-grid-univer-canvas');
        const panel = this.canvasEl.createDiv('plot-grid-univer-error');
        panel.createEl('h3', { text: t('Spreadsheet failed to load') });
        panel.createEl('p', {
            text: t('The spreadsheet could not initialize. Try loading it again.'),
        });
        if (this.univerLoadError instanceof Error && this.univerLoadError.message) {
            panel.createEl('code', { text: this.univerLoadError.message });
        }
        const retry = panel.createEl('button', {
            cls: 'mod-cta',
            text: t('Reload spreadsheet'),
        });
        retry.addEventListener('click', () => {
            this.univerLoadFailed = false;
            this.univerLoadError = null;
            this.univerMountPromise = null;
            this.renderGrid({ forcePush: true });
        });
    }

    /** Keep legacy NarrativeLab view controls effective without remounting Univer. */
    private applyUniverViewState(): void {
        const host = this.univerHost;
        if (!host) return;
        const page = this.getActivePage();
        const stateSig = [
            page.id,
            page.zoom || 1,
            page.stickyHeaders !== false ? 1 : 0,
            page.frozenColumns ?? 1,
            page.frozenRows ?? 1,
        ].join('|');
        if (stateSig === this.univerViewStateSig) return;
        this.univerViewStateSig = stateSig;
        host.setActiveSheet(page.id);
        host.setZoom(page.id, page.zoom || 1);
        host.setFreeze(
            page.id,
            page.stickyHeaders !== false,
            page.frozenColumns ?? 1,
            page.frozenRows ?? 1,
        );
    }

    private async handleUniverContextMenuAction(action: PlotGridUniverContextAction): Promise<void> {
        if (action === 'reset-grid') {
            const page = this.getActivePage();
            openConfirmModal(this.app, {
                title: t('Reset Grid'),
                message: t('Are you sure you want to reset the Grid? Resetting will delete everything.'),
                confirmLabel: t('Reset'),
                onConfirm: () => {
                    this.cancelPendingSave();
                    page.rows = [];
                    page.columns = [];
                    page.cells = {};
                    page.zoom = 1;
                    this.data = page;
                    this.univerStructureSig = '';
                    void this.plugin?.savePlotGrid?.(this.document, {
                        allowEmptyOverwrite: true,
                        projectFilePath: this.loadedProjectFile || this.getTargetProjectFile(),
                    });
                    this.renderGrid({ forcePush: true });
                },
            });
                    return;
                }
        const cell = this.getActiveDataCellFromUniver();
        if (!cell) {
            new Notice(t('Select a cell first'));
            return;
        }
        if (action === 'open-linked-note') {
            const notes = this.collectConnectedNotes(cell);
            const primary = notes[0]?.path || cell.linkedSceneId;
            if (!primary) {
                new Notice(t('No linked note'));
                return;
            }
            this.openConnectedNote(primary);
            return;
        }
        if (action === 'unlink-note') {
            if (!cellHasNoteLink(cell)) {
                new Notice(t('No linked note'));
                return;
            }
            this.unlinkCell(cell.id);
            new Notice(t('Note unlinked from cell'));
            return;
        }
        if (action === 'link-note') {
            this.openCellMarkdownEditor(cell, { insertWikilink: true });
            return;
        }
        if (action === 'convert-to-notes') await this.convertCellToNotes(cell);
        else if (action === 'convert-to-scene') await this.convertCellToScene(cell);
        else await this.convertCellToResearch(cell);
    }

    private collectConnectedNotes(cell: CellData | null | undefined): Array<{ path: string; name: string }> {
        if (!cell) return [];
        const seen = new Set<string>();
        const out: Array<{ path: string; name: string }> = [];
        const sourcePath = this.getTargetProjectFile();
        const addPath = (rawPath: string, displayName?: string) => {
            const path = rawPath.replace(/\\/g, '/').trim();
            if (!path) return;
            const key = path.toLowerCase();
            if (seen.has(key)) return;
            seen.add(key);
            const file = this.resolveLinkedVaultFile(path);
            const name = displayName?.trim()
                || file?.basename
                || path.split('/').pop()?.replace(/\.md$/i, '')
                || path;
            out.push({ path: file?.path || path, name });
        };
        if (cell.linkedSceneId) addPath(cell.linkedSceneId);
        const re = /\[\[([^\]|#]+)(?:#[^\]|]+)?(?:\|([^\]]+))?\]\]/g;
        let match: RegExpExecArray | null;
        while ((match = re.exec(cell.content || ''))) {
            const target = match[1]?.trim();
            if (!target) continue;
            let file = this.app.metadataCache.getFirstLinkpathDest(target, sourcePath);
            if (!file) {
                const direct = this.app.vault.getAbstractFileByPath(target)
                    ?? this.app.vault.getAbstractFileByPath(`${target}.md`);
                if (direct instanceof TFile) file = direct;
            }
            if (file instanceof TFile) addPath(file.path, match[2] || file.basename);
            else addPath(target.endsWith('.md') ? target : `${target}.md`, match[2] || target.split('/').pop());
        }
        return out;
    }

    private openConnectedNote(path: string): void {
        this.openVaultFile(path);
    }

    private appendConnectedNotesMenuItems(menu: Menu): void {
        const notes = this.collectConnectedNotes(this.getActiveDataCellFromUniver());
        menu.addItem(item => {
            item.setTitle(t('Connected notes'));
            item.setIcon('files');
            item.setDisabled(true);
            item.setSection('nl-connected');
        });
        if (notes.length === 0) {
            menu.addItem(item => {
                item.setTitle(t('No connected notes'));
                item.setDisabled(true);
                item.setSection('nl-connected');
            });
                    return;
                }
        for (const note of notes) {
            menu.addItem(item => {
                item.setTitle(note.name);
                item.setIcon('file-text');
                item.setSection('nl-connected');
                item.onClick(() => this.openConnectedNote(note.path));
            });
        }
    }

    private showConnectedNotesMenu(position: { x: number; y: number }): void {
        const menu = new Menu();
        this.appendConnectedNotesMenuItems(menu);
        showMenuSafely(menu, position);
    }

    /** Read-only cell lookup (Univer coords; does not expand the grid). */
    private getDataCellAt(sheetId: string, row: number, col: number): CellData | null {
        const page = this.document.pages.find(p => p.id === sheetId);
        return getPlotGridCellAtUniverCoords(page, row, col);
    }

    private emptyGridCell(id: string, content = ''): CellData {
        return {
            id,
            content,
            bgColor: '',
            textColor: '',
            bold: false,
            italic: false,
            align: 'left',
            manualContent: !!content,
        };
    }

    private ensureAxisCell(page: ConceptGridPage, id: string, label: string): CellData {
        const existing = page.cells[id];
        if (existing) {
            if (!existing.manualContent) existing.content = label || '';
            return existing;
        }
        const cell = this.emptyGridCell(id, label || '');
        page.cells[id] = cell;
        return cell;
    }

    /** Map Univer sheet coords (including header row/col at 0) → data CellData. */
    private getActiveDataCellFromUniver(): CellData | null {
        // Query Univer first: the event-backed selection can lag while the formula
        // editor is committing or when a context menu opens immediately after click.
        const sel = this.univerHost?.getActiveCell() || this.lastUniverSel || null;
        if (!sel) return null;
        // Never fall back to the active page — unknown sheetId after project switch
        // would mutate the wrong grid at the same coordinates.
        const page = this.document.pages.find(p => p.id === sel.sheetId);
        if (!page) return null;
        const dataRow = sel.row;
        const dataCol = sel.col;
        if (dataRow < 0 || dataCol < 0) return null;
        let expanded = false;
        while (dataRow >= 1 && page.rows.length < dataRow) {
            const index = page.rows.length + 1;
            page.rows.push({
                id: makeId('r-'),
                label: t('Row {n}', { n: index }),
                height: 80,
                bgColor: '',
                sourceType: 'manual',
            });
            expanded = true;
        }
        while (dataCol >= 1 && page.columns.length < dataCol) {
            const index = page.columns.length + 1;
            page.columns.push({
                id: makeId('c-'),
                label: t('Col {n}', { n: index }),
                width: 160,
                bgColor: '',
                sourceType: 'manual',
            });
            expanded = true;
        }
        if (expanded) {
            // Pull again after establishing NL row/column identities so text
            // already entered in a native Univer cell is not lost when linked.
            this.univerHost?.syncMeta(this.document);
            this.univerHost?.flush();
            this.univerStructureSig = this.getUniverStructureSig();
            this.scheduleSave();
        }
        const livePage = this.document.pages.find(p => p.id === sel.sheetId) || page;
        if (dataRow === 0 && dataCol === 0) {
            if (livePage.id === this.document.activePageId) this.data = livePage;
            return this.ensureAxisCell(livePage, AXIS_CORNER_CELL_ID, livePage.cornerLabel || '');
        }
        if (dataRow === 0) {
            const column = livePage.columns[dataCol - 1];
            if (!column) return null;
            if (livePage.id === this.document.activePageId) this.data = livePage;
            return this.ensureAxisCell(livePage, axisColumnCellId(column.id), column.label || '');
        }
        if (dataCol === 0) {
            const row = livePage.rows[dataRow - 1];
            if (!row) return null;
            if (livePage.id === this.document.activePageId) this.data = livePage;
            return this.ensureAxisCell(livePage, axisRowCellId(row.id), row.label || '');
        }
        const row = livePage.rows[dataRow - 1];
        const col = livePage.columns[dataCol - 1];
        if (!row || !col) return null;
                const key = `${row.id}-${col.id}`;
        if (!livePage.cells[key]) {
            livePage.cells[key] = this.emptyGridCell(key);
        }
        // Keep working set bound when selection is on active page
        if (livePage.id === this.document.activePageId) this.data = livePage;
        const cell = livePage.cells[key];
        if (!cell) throw new Error(`Failed to initialize plot-grid cell: ${key}`);
        return cell;
    }

    private getActivePlotGridCell(): CellData | null {
        const cell = this.univerHost
            ? this.getActiveDataCellFromUniver()
            : (this.selectedRow != null && this.selectedCol != null
                ? this.data.cells[`${this.data.rows[this.selectedRow]?.id}-${this.data.columns[this.selectedCol]?.id}`]
                : null);
        return cell || null;
    }

    private openCellEditorForActiveCell(): void {
        this.flushUniverIntoDocument({ acceptCleared: true });
        const cell = this.getActivePlotGridCell();
        if (!cell) {
            new Notice(t('Select a cell first'));
            return;
        }
        this.openCellMarkdownEditor(cell);
    }

    private findLivePlotGridCell(id: string): CellData | undefined {
        for (const page of this.document.pages) {
            const live = page.cells?.[id];
            if (live) return live;
        }
        return undefined;
    }

    /** Keep already-open Markdown editors aligned after Univer Clear contents / Clear all. */
    private syncOpenCellEditorsFromDocument(): void {
        for (const [id, win] of this.cellEditorWindows) {
            const live = this.findLivePlotGridCell(id);
            if (!live || !win.isConnected) continue;
            const textarea = win.querySelector('textarea.plot-grid-cell-editor-input');
            if (!(textarea instanceof HTMLTextAreaElement)) continue;
            if (textarea.value === (live.content || '')) continue;
            if (textarea.ownerDocument.activeElement === textarea) continue;
            win.__nlCellEditorSetContent?.(live.content || '');
        }
    }

    private openCellMarkdownEditor(cell: CellData, options: { insertWikilink?: boolean } = {}): void {
        this.flushUniverIntoDocument({ acceptCleared: true });
        cell = this.findLivePlotGridCell(cell.id) || cell;
        const coords = this.findCellUniverCoords(cell);
        if (coords && this.univerHost) {
            const liveText = this.univerHost.readLiveCellPlainText(coords.sheetId, coords.row, coords.col);
            // Univer Clear contents / Clear all empty the painted cell while the
            // NarrativeLab Markdown source can lag. The editor must follow the grid.
            if (liveText === '' && (cell.content || cell.formula)) {
                cell.content = '';
                cell.formula = undefined;
                cell.manualContent = true;
                const page = this.document.pages.find(item => item.cells[cell.id] === cell)
                    || this.document.pages.find(item => item.cells[cell.id])
                    || this.data;
                syncAxisLabelFromCell(page, cell);
            }
        }
        const cellKey = cell.id || `${Date.now()}`;
        const existing = this.cellEditorWindows.get(cellKey);
        if (existing?.isConnected) {
            existing.__nlCellEditorSetContent?.(cell.content || '');
            existing.__nlCellEditorFocus?.(options);
            return;
        }
        if (existing) this.cellEditorWindows.delete(cellKey);

        const editorApp = this.app;
        const sourcePath = this.getTargetProjectFile();
        // Structural link draft; content lives in the textarea and autosaves.
        let editorLinkedSceneId: string | undefined = cell.linkedSceneId;
        let autosaveTimer: number | null = null;
        const persistDraft = (): void => {
            if (!textarea) return;
            const liveCell = this.ensureCellInData(cell);
            const value = textarea.value;
            const linkChanged = (editorLinkedSceneId || undefined) !== (liveCell.linkedSceneId || undefined);
            const contentChanged = liveCell.content !== value || !liveCell.manualContent;
            if (!contentChanged && !linkChanged) return;
            const hadNoteLink = cellHasNoteLink(liveCell);
            liveCell.content = value;
            liveCell.manualContent = true;
            if (linkChanged) {
                liveCell.linkedSceneId = editorLinkedSceneId;
                if (!editorLinkedSceneId) liveCell.linkedViaWikilink = undefined;
            }
            this.synchronizeWikilinkCell(liveCell);
            if (hadNoteLink && !cellHasNoteLink(liveCell)) liveCell.textColor = '';
            const page = this.document.pages.find(item => Object.values(item.cells || {}).includes(liveCell)
                || item.cells[liveCell.id] === liveCell)
                || this.data;
            syncAxisLabelFromCell(page, liveCell);
            this.pushCellSourceToUniver(liveCell);
            this.scheduleSave();
        };
        const scheduleAutosave = (): void => {
            if (autosaveTimer) window.clearTimeout(autosaveTimer);
            autosaveTimer = window.setTimeout(() => {
                autosaveTimer = null;
                persistDraft();
            }, 500);
        };
        const flushAutosave = (): void => {
            if (autosaveTimer) {
                window.clearTimeout(autosaveTimer);
                autosaveTimer = null;
            }
            persistDraft();
        };

        type EditorWin = HTMLElement & {
            __nlCellEditorCleanup?: () => void;
            __nlCellEditorFlush?: () => void;
            __nlCellEditorFocus?: (opts?: { insertWikilink?: boolean }) => void;
            __nlCellEditorSetContent?: (value: string, resetLink?: boolean) => void;
        };
        const win = activeDocument.body.createDiv('plot-grid-cell-editor-window') as EditorWin;
        win.dataset.cellKey = cellKey;
        const winWidth = Math.min(720, window.innerWidth - 48);
        const winHeight = Math.min(480, window.innerHeight - 64);
        const cascade = (this.cellEditorWindows.size % 8) * 28;
        const left = Math.max(16, Math.round((window.innerWidth - winWidth) / 2) + cascade);
        const top = Math.max(16, Math.round((window.innerHeight - winHeight) / 2) + cascade);
        win.setCssStyles({
            left: `${left}px`,
            top: `${top}px`,
            transform: 'none',
            width: `${winWidth}px`,
            height: `${winHeight}px`,
        });
        this.cellEditorWindows.set(cellKey, win);
        this.bringCellEditorToFront(win);

        // Open in preview by default; switch to edit only when the user asks
        // (mode button / double-click preview) or when inserting a wikilink.
        let previewMode = !options.insertWikilink;
        let alwaysOnTop = false;
        let textarea: HTMLTextAreaElement | null = null;
        let previewEl: HTMLDivElement | null = null;
        let suggest: WikilinkSuggest | null = null;
        let removeShortcuts: (() => void) | null = null;
        let removeUndoHistory: (() => void) | null = null;
        const renderer = new Component();
        renderer.load();

        const titlebar = win.createDiv('plot-grid-cell-editor-titlebar');
        const titleBlock = titlebar.createDiv('plot-grid-cell-editor-title');
        titleBlock.createSpan({ cls: 'plot-grid-cell-editor-title-kicker', text: t('Editor') });
        titleBlock.createSpan({
            cls: 'plot-grid-cell-editor-title-text',
            text: this.resolveCellEditorHeading(cell),
        });
        const titleActions = titlebar.createDiv('plot-grid-cell-editor-title-actions');
        const pinBtn = titleActions.createEl('button', {
            cls: 'clickable-icon plot-grid-cell-editor-pin',
            attr: { type: 'button', title: t('Always on top'), 'aria-label': t('Always on top') },
        });
        obsidian.setIcon(pinBtn, 'pin');
        const closeBtn = titleActions.createEl('button', {
            cls: 'clickable-icon plot-grid-cell-editor-close',
            attr: { type: 'button', title: t('Close'), 'aria-label': t('Close') },
        });
        obsidian.setIcon(closeBtn, 'x');

        const meta = win.createDiv('plot-grid-cell-editor-meta');
        meta.createSpan({ cls: 'plot-grid-cell-editor-kicker', text: t('Markdown and HTML') });
        meta.createSpan({ cls: 'plot-grid-cell-editor-hint', text: t('Obsidian Markdown shortcuts are available') });

        const toolbar = win.createDiv({ cls: 'plot-grid-cell-editor-toolbar', attr: { role: 'toolbar' } });
        const insertOpenWikilink = (): void => {
            if (!textarea || previewMode) return;
            const start = textarea.selectionStart ?? textarea.value.length;
            const end = textarea.selectionEnd ?? start;
            const selected = textarea.value.slice(start, end);
            if (selected) {
                applyMarkdownInputAction(textarea, 'wikilink');
            } else {
                textarea.setRangeText('[[', start, end, 'end');
                textarea.dispatchEvent(new Event('input', { bubbles: true }));
            }
            textarea.focus();
            suggest?.refresh();
        };
        const addButton = (label: string, action: MarkdownInputAction, icon?: string): void => {
            const button = toolbar.createEl('button', {
                cls: 'clickable-icon plot-grid-cell-editor-format',
                attr: { type: 'button', title: label, 'aria-label': label },
            });
            if (icon) obsidian.setIcon(button, icon);
            else button.setText(label);
            button.addEventListener('mousedown', event => {
                event.preventDefault();
                if (!textarea || previewMode) return;
                if (action === 'wikilink') {
                    insertOpenWikilink();
                    return;
                }
                applyMarkdownInputAction(textarea, action);
                suggest?.refresh();
            });
        };
        addButton(t('Bold'), 'bold', 'bold');
        addButton(t('Italic'), 'italic', 'italic');
        addButton(t('Strikethrough'), 'strikethrough', 'strikethrough');
        addButton(t('Inline code'), 'inline-code', 'code');
        addButton(t('Highlight'), 'highlight', 'highlighter');
        toolbar.createDiv('plot-grid-cell-editor-separator');
        addButton('H1', 'heading-1');
        addButton('H2', 'heading-2');
        addButton('H3', 'heading-3');
        addButton(t('Blockquote'), 'blockquote', 'text-quote');
        addButton(t('Bulleted list'), 'bullet-list', 'list');
        addButton(t('Numbered list'), 'numbered-list', 'list-ordered');
        addButton(t('Checklist'), 'task-list', 'list-checks');
        toolbar.createDiv('plot-grid-cell-editor-separator');
        addButton(t('Wikilink'), 'wikilink', 'brackets');

        const modeButton = toolbar.createEl('button', {
            cls: 'plot-grid-cell-editor-mode',
            text: t('Preview'),
            attr: { type: 'button' },
        });

        const editorBody = win.createDiv('plot-grid-cell-editor-body');
        textarea = editorBody.createEl('textarea', {
            cls: 'plot-grid-cell-editor-input',
            attr: {
                spellcheck: 'true',
                placeholder: t('Write Markdown or HTML…'),
                'aria-label': t('Cell Markdown source'),
            },
        });
        textarea.value = cell.content || '';
        previewEl = editorBody.createDiv('plot-grid-cell-editor-preview markdown-rendered');
        previewEl.addEventListener('click', event => {
            const target = event.target;
            if (!(target instanceof Element)) return;
            const anchor = target.closest('a.internal-link');
            if (!(anchor instanceof HTMLAnchorElement) || !previewEl?.contains(anchor)) return;
            const linkText = anchor.dataset.href || anchor.getAttribute('href') || '';
            if (!linkText) return;
            event.preventDefault();
            event.stopPropagation();
            void editorApp.workspace.openLinkText(linkText, sourcePath, true);
        });
        // Double-click preview surface to edit.
        previewEl.addEventListener('dblclick', () => { void setPreview(false); });

        suggest = new WikilinkSuggest({
            app: editorApp,
            textareaEl: textarea,
            maxVisible: 10,
            sourcePath,
            preferModal: true,
        });
        removeShortcuts = installObsidianMarkdownShortcuts(editorApp, textarea);

        const setPreview = async (preview: boolean): Promise<void> => {
            if (!textarea || !previewEl) return;
            previewMode = preview;
            textarea.hidden = preview;
            previewEl.hidden = !preview;
            modeButton.setText(preview ? t('Edit') : t('Preview'));
            modeButton.toggleClass('is-active', preview);
            win.toggleClass('is-preview', preview);
            if (preview) {
                previewEl.empty();
                await MarkdownRenderer.render(
                    editorApp,
                    textarea.value,
                    previewEl,
                    sourcePath,
                    renderer,
                );
            } else {
                textarea.focus();
            }
        };

        modeButton.addEventListener('click', () => { void setPreview(!previewMode); });

        // Chrome outside the textarea also switches to preview (title/meta/blank toolbar).
        const maybePreviewFromChrome = (event: MouseEvent) => {
            if (previewMode) return;
            const target = event.target;
            if (!(target instanceof Element)) return;
            if (target.closest('button, a, textarea, input, .plot-grid-cell-editor-preview, .plot-grid-cell-editor-resize-handle')) {
                return;
            }
            if (target.closest('.plot-grid-cell-editor-titlebar, .plot-grid-cell-editor-meta, .plot-grid-cell-editor-toolbar, .plot-grid-cell-editor-links, .plot-grid-cell-editor-footer')) {
                void setPreview(true);
            }
        };
        win.addEventListener('mousedown', (event) => {
            this.bringCellEditorToFront(win, alwaysOnTop);
            maybePreviewFromChrome(event);
        });

        const notePathKey = (path: string): string => path.replace(/\\/g, '/').trim().toLowerCase();
        const draftMatchesNote = (rawTarget: string, notePath: string): boolean => {
            const target = rawTarget.trim();
            if (!target) return false;
            const want = notePathKey(notePath);
            let file = this.app.metadataCache.getFirstLinkpathDest(target, sourcePath);
            if (!file) {
                const direct = this.app.vault.getAbstractFileByPath(target)
                    ?? this.app.vault.getAbstractFileByPath(`${target}.md`);
                if (direct instanceof TFile) file = direct;
            }
            if (file instanceof TFile) return notePathKey(file.path) === want;
            const fallback = notePathKey(target.endsWith('.md') ? target : `${target}.md`);
            return fallback === want || notePathKey(target) === want;
        };

        const linksBar = win.createDiv('plot-grid-cell-editor-links');
        const removeConnectedNoteFromDraft = (note: { path: string; name: string }): void => {
            if (!textarea) return;
            const next = unwrapMatchingNoteLinks(textarea.value, target => draftMatchesNote(target, note.path));
            replaceTextareaValue(textarea, next);
            if (editorLinkedSceneId && notePathKey(editorLinkedSceneId) === notePathKey(note.path)) {
                editorLinkedSceneId = undefined;
            } else if (editorLinkedSceneId && draftMatchesNote(editorLinkedSceneId, note.path)) {
                editorLinkedSceneId = undefined;
            }
            refreshLinkedNotesBar();
            if (previewMode) void setPreview(true);
            persistDraft();
        };
        const addConnectedNoteViaPicker = (): void => {
            void setPreview(false).then(() => {
                if (!textarea) return;
                const current = textarea.value;
                const prefix = current && !/\s$/.test(current) ? ' ' : '';
                replaceTextareaValue(textarea, `${current}${prefix}[[`);
                textarea.focus();
                suggest?.refresh();
            });
        };
        const refreshLinkedNotesBar = (): void => {
            if (!textarea) return;
            const notes = this.collectConnectedNotes({
                ...cell,
                content: textarea.value,
                linkedSceneId: editorLinkedSceneId,
            });
            linksBar.empty();
            linksBar.createSpan({
                cls: 'plot-grid-cell-editor-links-label',
                text: t('Connected notes'),
            });
            if (notes.length === 0) {
                linksBar.createSpan({
                    cls: 'plot-grid-cell-editor-links-empty',
                    text: t('No connected notes'),
                });
            } else {
                const list = linksBar.createDiv('plot-grid-cell-editor-links-list');
                for (const note of notes) {
                    const chip = list.createDiv('plot-grid-cell-editor-link-chip');
                    const openBtn = chip.createEl('button', {
                        cls: 'plot-grid-cell-editor-link-chip-open',
                        attr: { type: 'button', title: note.path },
                    });
                    openBtn.createSpan({ text: note.name });
                    openBtn.addEventListener('click', (event) => {
                        event.preventDefault();
                        event.stopPropagation();
                        this.openConnectedNote(note.path);
                    });
                    const removeBtn = chip.createEl('button', {
                        cls: 'clickable-icon plot-grid-cell-editor-link-chip-remove',
                        attr: {
                            type: 'button',
                            title: t('Unlink Note'),
                            'aria-label': t('Unlink Note'),
                        },
                    });
                    obsidian.setIcon(removeBtn, 'x');
                    removeBtn.addEventListener('click', (event) => {
                        event.preventDefault();
                        event.stopPropagation();
                        removeConnectedNoteFromDraft(note);
                    });
                }
            }
            const addBtn = linksBar.createEl('button', {
                cls: 'clickable-icon plot-grid-cell-editor-links-add',
                attr: {
                    type: 'button',
                    title: t('Link Note…'),
                    'aria-label': t('Link Note…'),
                },
            });
            obsidian.setIcon(addBtn, 'plus');
            addBtn.addEventListener('click', (event) => {
                event.preventDefault();
                event.stopPropagation();
                addConnectedNoteViaPicker();
            });
        };

        const footer = win.createDiv('plot-grid-cell-editor-footer');
        const shortcutHint = footer.createSpan({ text: t('Type [[ to search vault notes') });
        shortcutHint.addClass('plot-grid-cell-editor-footer-hint');
        textarea.addEventListener('input', () => {
            refreshLinkedNotesBar();
            scheduleAutosave();
        });
        refreshLinkedNotesBar();

        const resizeHandle = win.createDiv('plot-grid-cell-editor-resize-handle');

        const isFrontmostEditor = (): boolean => {
            let best: HTMLElement | null = null;
            let bestZ = -1;
            for (const other of this.cellEditorWindows.values()) {
                if (!other.isConnected) continue;
                const z = Number.parseInt(other.style.zIndex || '0', 10) || 0;
                if (z >= bestZ) {
                    bestZ = z;
                    best = other;
                }
            }
            return best === win;
        };

        removeUndoHistory = installTextareaUndoHistory(textarea, {
            captureTarget: activeDocument.defaultView,
            shouldHandle: (event) => {
                if (!isFrontmostEditor()) return false;
                const target = event.target;
                if (target instanceof Node && win.contains(target)) return true;
                const active = activeDocument.activeElement;
                return !!(active && win.contains(active));
            },
        });

        const cleanup = (): void => {
            if (autosaveTimer) {
                window.clearTimeout(autosaveTimer);
                autosaveTimer = null;
            }
            activeDocument.removeEventListener('keydown', onKey);
            suggest?.destroy();
            suggest = null;
            removeShortcuts?.();
            removeShortcuts = null;
            removeUndoHistory?.();
            removeUndoHistory = null;
            renderer.unload();
            if (this.cellEditorWindows.get(cellKey) === win) this.cellEditorWindows.delete(cellKey);
            delete win.__nlCellEditorCleanup;
            delete win.__nlCellEditorFlush;
            delete win.__nlCellEditorFocus;
            delete win.__nlCellEditorSetContent;
        };
        const onKey = (e: KeyboardEvent) => {
            if (e.key !== 'Escape') return;
            if (!isFrontmostEditor()) return;
            closeWindow();
        };
        const closeWindow = (): void => {
            flushAutosave();
            cleanup();
            win.remove();
        };
        closeBtn.addEventListener('click', () => closeWindow());
        textarea.addEventListener('keydown', event => {
            if ((event.metaKey || event.ctrlKey) && event.key === 'Enter') {
                event.preventDefault();
                closeWindow();
            }
        });
        activeDocument.addEventListener('keydown', onKey);

        const insertWikilinkToken = (): void => {
            if (!textarea) return;
            const current = textarea.value;
            const prefix = current && !/\s$/.test(current) ? ' ' : '';
            replaceTextareaValue(textarea, `${current}${prefix}[[`);
            suggest?.refresh();
        };

        win.__nlCellEditorCleanup = cleanup;
        win.__nlCellEditorFlush = flushAutosave;
        win.__nlCellEditorFocus = (opts) => {
            this.bringCellEditorToFront(win, alwaysOnTop);
            void setPreview(false).then(() => {
                if (!textarea) return;
                textarea.focus();
                if (opts?.insertWikilink) insertWikilinkToken();
            });
        };
        win.__nlCellEditorSetContent = (value: string, resetLink = false) => {
            if (!textarea) return;
            replaceTextareaValue(textarea, value);
            if (resetLink) editorLinkedSceneId = undefined;
            refreshLinkedNotesBar();
            if (previewMode) void setPreview(true);
        };

        const applyAlwaysOnTop = (): void => {
            win.toggleClass('is-always-on-top', alwaysOnTop);
            pinBtn.setAttribute('title', alwaysOnTop ? t('Unpin') : t('Always on top'));
            pinBtn.setAttribute('aria-label', alwaysOnTop ? t('Unpin') : t('Always on top'));
            pinBtn.toggleClass('is-active', alwaysOnTop);
            this.bringCellEditorToFront(win, alwaysOnTop);
        };
        pinBtn.addEventListener('click', (event) => {
            event.stopPropagation();
            alwaysOnTop = !alwaysOnTop;
            applyAlwaysOnTop();
        });

        // Drag via titlebar — keep floating size/position (pin no longer docks full-width).
        let isDragging = false;
        let dragOffsetX = 0;
        let dragOffsetY = 0;
        titlebar.addEventListener('pointerdown', (e: PointerEvent) => {
            if ((e.target as HTMLElement).closest('button')) return;
            isDragging = true;
            this.bringCellEditorToFront(win, alwaysOnTop);
            const rect = win.getBoundingClientRect();
            dragOffsetX = e.clientX - rect.left;
            dragOffsetY = e.clientY - rect.top;
            win.setCssStyles({
                left: `${rect.left}px`,
                top: `${rect.top}px`,
                transform: 'none',
            });
            titlebar.setPointerCapture(e.pointerId);
            e.preventDefault();
        });
        titlebar.addEventListener('pointermove', (e: PointerEvent) => {
            if (!isDragging) return;
            win.setCssStyles({
                left: `${e.clientX - dragOffsetX}px`,
                top: `${e.clientY - dragOffsetY}px`,
            });
        });
        titlebar.addEventListener('pointerup', () => { isDragging = false; });
        titlebar.addEventListener('lostpointercapture', () => { isDragging = false; });

        // Resize from bottom-right corner.
        let isResizing = false;
        let resizeStartX = 0;
        let resizeStartY = 0;
        let startW = 0;
        let startH = 0;
        resizeHandle.addEventListener('pointerdown', (e: PointerEvent) => {
            isResizing = true;
            this.bringCellEditorToFront(win, alwaysOnTop);
            resizeStartX = e.clientX;
            resizeStartY = e.clientY;
            startW = win.offsetWidth;
            startH = win.offsetHeight;
            const rect = win.getBoundingClientRect();
            win.setCssStyles({
                left: `${rect.left}px`,
                top: `${rect.top}px`,
                transform: 'none',
            });
            resizeHandle.setPointerCapture(e.pointerId);
            e.preventDefault();
            e.stopPropagation();
        });
        resizeHandle.addEventListener('pointermove', (e: PointerEvent) => {
            if (!isResizing) return;
            const newW = Math.max(420, startW + (e.clientX - resizeStartX));
            const newH = Math.max(260, startH + (e.clientY - resizeStartY));
            win.setCssStyles({
                width: `${Math.min(newW, window.innerWidth - 16)}px`,
                height: `${Math.min(newH, window.innerHeight - 16)}px`,
            });
        });
        resizeHandle.addEventListener('pointerup', () => { isResizing = false; });
        resizeHandle.addEventListener('lostpointercapture', () => { isResizing = false; });

        if (options.insertWikilink && textarea) insertWikilinkToken();

        void setPreview(previewMode).then(() => {
            if (previewMode || !textarea) return;
            textarea.focus();
            const end = textarea.value.length;
            textarea.setSelectionRange(end, end);
            if (options.insertWikilink) textarea.dispatchEvent(new Event('input', { bubbles: true }));
        });
    }
    async refresh(options?: { reloadFromDisk?: boolean }): Promise<void> {
        try {
            const projectFile = this.getTargetProjectFile();
            const projectChanged = this.loadedProjectFile != null
                && projectFile.length > 0
                && this.loadedProjectFile !== projectFile;
            const reloadFromDisk = options?.reloadFromDisk === true;

            if (projectChanged) {
                // Always reload on project switch — never skip for pending saves / focus.
                await this.persistBoundPlotGrid();
                this.hasHydratedDocument = false;
                this.disposeUniverHost({ persist: false });
            } else if (!reloadFromDisk && this.univerHost && this.loadedProjectFile === projectFile) {
                // Generic view refresh / tab focus must not re-read datasheet.xlsx
                // or remount Univer. External xlsx edits call reloadFromDisk.
                this.renderToolbar();
                return;
            } else {
                // Pull pending Univer edits into memory before deciding whether disk
                // reload is safe. Otherwise a vault refresh can overwrite the grid
                // while edits still live only inside Univer (pre-debounce).
                if (this.univerHost) {
                    // Never flush/reload while typing — flush blurs the editor and
                    // load+render remounts the workbook (viewport jump).
                    if (this.univerHost.isEditorBusy()) return;
                    this.flushUniverIntoDocument({ acceptCleared: true });
                }
                // If a save is pending, skip reloading from disk (would overwrite in-memory changes)
                if (this.saveDebounce) return;
                // Pending sync after flush should have scheduled save; still guard.
                if (this.univerHost?.hasPendingSync()) return;
                // Floating Markdown editors mount on <body> — vault refresh must not wipe them.
                for (const win of this.cellEditorWindows.values()) {
                    if (win.isConnected) return;
                }
                // Focused inputs in the grid still own uncommitted drafts.
                if (this.wrapperEl?.querySelector('input:focus, textarea:focus')) return;
                // Univer in-cell / formula editor or IME — remounting clears composition.
                if (this.univerHost?.isEditorBusy()) return;
                if (this.scrollAreaEl?.querySelector('[contenteditable="true"]:focus, textarea:focus, input:focus')) return;
            }

            const beforeFp = conceptGridContentFingerprint(this.document);
            const beforeSig = this.getUniverStructureSig();
            await this.loadData();
            // If the view hasn't been opened yet, `wrapperEl` will be null — skip rendering
            if (!this.wrapperEl) return;

            const afterFp = conceptGridContentFingerprint(this.document);
            const afterSig = this.getUniverStructureSig();
            // Own autosave / no-op disk echo — do not rebuild toolbar or touch Univer.
            if (!projectChanged && beforeFp === afterFp && beforeSig === afterSig && this.univerHost) {
                return;
            }

            this.renderToolbar();
            // Content-only disk changes must push into Univer (structure sig alone skips remount).
            if (this.univerHost && !projectChanged) {
                if (afterFp !== beforeFp) {
                    try {
                        this.univerHost.setDocument(this.document);
                        this.univerStructureSig = this.getUniverStructureSig();
                        this.univerViewStateSig = '';
                    } catch { /* ignore */ }
                }
            }
            this.renderGrid();
        } catch (e) {
            // non-fatal
        }
    }

    /** First non-empty line of cell text, used as a file title. */
    private cellTitleFromContent(content: string, fallback: string): string {
        const first = content
            .trim()
            .split(/\r?\n/)
            .map(l => l.trim())
            .find(l => l.length > 0) || fallback;
        return first
            .replace(/^#{1,6}\s+/, '')
            .replace(/^[-*+]\s+/, '')
            .replace(/^>\s*/, '')
            .substring(0, 60) || fallback;
    }

    /** Resolve row/column labels for plotgridOrigin context. */
    private cellOriginLabel(cell: CellData): string | undefined {
        for (const row of this.data.rows) {
            for (const col of this.data.columns) {
                if (`${row.id}-${col.id}` === cell.id) {
                    const parts = [row.label, col.label].filter(Boolean);
                    return parts.length > 0 ? parts.join(' / ') : undefined;
                }
            }
        }
        return undefined;
    }

    /** Resolve a cell's linkedSceneId to a vault file (any markdown, not only NL scenes). */
    private resolveLinkedVaultFile(linkedPath?: string): TFile | null {
        if (!linkedPath) return null;
        const f = this.app.vault.getAbstractFileByPath(linkedPath);
        return f instanceof TFile ? f : null;
    }

    private findCellUniverCoords(cell: CellData): { sheetId: string; row: number; col: number } | null {
        for (const page of this.document.pages) {
            const coords = univerCoordsForPlotGridCell(page, cell);
            if (coords) return { sheetId: page.id, ...coords };
        }
        return this.lastUniverSel;
    }

    private pushCellSourceToUniver(cell: CellData): void {
        const coords = this.findCellUniverCoords(cell);
        if (!coords || !this.univerHost) {
            try { this.univerHost?.refreshLinkMarkers(); } catch { /* ignore */ }
            return;
        }
        try {
            this.univerHost.applyCellSource(coords.sheetId, coords.row, coords.col, cell.content || '');
        } catch {
            try { this.univerHost.refreshLinkMarkers(); } catch { /* ignore */ }
        }
    }

    private synchronizeWikilinkCell(cell: CellData): void {
        const sourcePath = this.getTargetProjectFile();
        const match = cell.content.match(/\[\[([^\]|#]+)(?:#[^\]|]+)?(?:\|[^\]]+)?\]\]/);
        if (!match) {
            if (cell.linkedViaWikilink) {
                cell.linkedSceneId = undefined;
                cell.linkedViaWikilink = undefined;
            }
            return;
        }
        if (cell.linkedSceneId && !cell.linkedViaWikilink) return;
        const target = match[1]?.trim();
        if (!target) return;
        let file = this.app.metadataCache.getFirstLinkpathDest(target, sourcePath);
        if (!file) {
            const direct = this.app.vault.getAbstractFileByPath(target)
                ?? this.app.vault.getAbstractFileByPath(`${target}.md`);
            if (direct instanceof TFile) file = direct;
        }
        if (file instanceof TFile) {
            cell.linkedSceneId = file.path;
            cell.linkedViaWikilink = true;
        }
    }

    /** Keep Obsidian-style [[wikilinks]] in worksheet text connected to vault notes. */
    private synchronizeWikilinkCells(): void {
        for (const page of this.document.pages) {
            for (const cell of Object.values(page.cells || {})) {
                if (cell) this.synchronizeWikilinkCell(cell);
            }
        }
        try { this.univerHost?.syncMeta(this.document); } catch { /* ignore */ }
    }

    private ensureCellInData(cell: CellData): CellData {
        for (const existing of Object.values(this.data.cells)) {
            if (existing === cell) return existing;
        }
        const existing = this.data.cells[cell.id];
        if (existing) return existing;
        this.data.cells[cell.id] = cell;
        return cell;
    }

    private linkFileToCell(cell: CellData, filePath: string): void {
        const liveCell = this.ensureCellInData(cell);
        liveCell.linkedSceneId = filePath;
        liveCell.linkedViaWikilink = true;
        if (!/\[\[[^\]]+\]\]/.test(liveCell.content || '')) {
            const file = this.resolveLinkedVaultFile(filePath);
            const target = filePath.replace(/\.md$/i, '');
            const label = file?.basename || target.split('/').pop() || target;
            const link = target === label ? `[[${target}]]` : `[[${target}|${label}]]`;
            liveCell.content = liveCell.content?.trim()
                ? `${liveCell.content.trim()} ${link}`
                : link;
            liveCell.manualContent = true;
        }
        // Keep host meta aligned so the next Univer pull does not erase the link.
        const page = this.document.pages.find(item => item.cells[liveCell.id] === liveCell) || this.data;
        syncAxisLabelFromCell(page, liveCell);
        try { this.univerHost?.syncMeta(this.document); } catch { /* ignore */ }
        this.pushCellSourceToUniver(liveCell);
        this.scheduleSave();
    }

    private unlinkCell(cellKey: string): void {
        // Prefer active page; also clear on the page that owns the key when using Univer selection.
        const applyUnlink = (cell: CellData, page: PlotGridData): void => {
            cell.content = unwrapAllNoteLinks(cell.content || '');
            cell.linkedSceneId = undefined;
            cell.linkedViaWikilink = undefined;
            cell.manualContent = true;
            cell.textColor = '';
            syncAxisLabelFromCell(page, cell);
            this.pushCellSourceToUniver(cell);
            const editor = this.cellEditorWindows.get(cell.id);
            editor?.__nlCellEditorSetContent?.(cell.content || '', true);
        };
        let cleared = false;
        const activeCell = this.data.cells[cellKey];
        if (activeCell) {
            applyUnlink(activeCell, this.data);
            cleared = true;
        }
        if (!cleared) {
            for (const page of this.document.pages) {
                const cell = page.cells[cellKey];
                if (cell) {
                    applyUnlink(cell, page);
                    cleared = true;
                    break;
                }
            }
        }
        try { this.univerHost?.syncMeta(this.document); } catch { /* ignore */ }
        this.scheduleSave();
        if (!this.univerHost) this.renderGrid();
    }

    private openVaultFile(path: string): void {
        const f = this.resolveLinkedVaultFile(path);
        if (f) this.app.workspace.getLeaf('tab').openFile(f, { state: { mode: 'source', source: false } });
        else new Notice(t('Linked file not found'));
    }

    /** Body text for convert — prefer cell content, else linked note/scene body. */
    private cellConvertBody(cell: CellData): string {
        const fromCell = (cell.content || '').trim();
        if (fromCell) return fromCell;
        if (!cell.linkedSceneId) return '';
        const scene = this.plugin?.sceneManager?.getScene(cell.linkedSceneId);
        return (scene?.body || '').trim();
    }

    private async convertCellToNotes(cell: CellData, opts?: { quiet?: boolean }): Promise<boolean> {
        const scMgr = this.plugin?.sceneManager as SceneManager | undefined;
        if (!scMgr) return false;

        const existing = cell.linkedSceneId ? scMgr.getScene(cell.linkedSceneId) : undefined;
        if (existing?.corkboardNote) {
            if (!opts?.quiet) new Notice(t('Already a Notes link'));
            return true;
        }
        // Linked corkboard-capable scene → move/flag as note via creating Notes file from body
        if (existing && !existing.corkboardNote) {
            // Scene → Notes: create note from scene body (or cell text) and re-link
            const body = this.cellConvertBody(cell) || (existing.title || '').trim();
            if (!body) {
                if (!opts?.quiet) new Notice(t('Add some content before converting'));
                return false;
            }
            const file = await scMgr.createScene({
                status: 'idea',
                corkboardNote: true,
                title: this.cellTitleFromContent(body, existing.title || t('Note')),
                body,
                plotgridOrigin: this.cellOriginLabel(cell),
            });
            this.linkFileToCell(cell, file.path);
            if (!opts?.quiet) new Notice(t('Converted cell to Notes'));
            return true;
        }

        const body = this.cellConvertBody(cell);
        if (!body) {
            if (!opts?.quiet) new Notice(t('Add some content before converting'));
            return false;
        }

        const file = await scMgr.createScene({
            status: 'idea',
            corkboardNote: true,
            title: this.cellTitleFromContent(body, t('Note')),
            body,
            plotgridOrigin: this.cellOriginLabel(cell),
        });
        // Replaces previous link path (including missing files) — relationship stays on the cell
        this.linkFileToCell(cell, file.path);
        if (!opts?.quiet) new Notice(t('Converted cell to Notes'));
        return true;
    }

    private async convertCellToScene(cell: CellData, opts?: { quiet?: boolean }): Promise<boolean> {
        const scMgr = this.plugin?.sceneManager as SceneManager | undefined;
        if (!scMgr) return false;

        const existing = cell.linkedSceneId ? scMgr.getScene(cell.linkedSceneId) : undefined;
        if (existing && !existing.corkboardNote) {
            if (!opts?.quiet) new Notice(t('Already a Scene link'));
            return true;
        }
        if (existing?.corkboardNote) {
            const oldPath = existing.filePath;
            const newPath = await scMgr.moveNoteToSceneFolder(oldPath);
            if (!newPath) return false;
            existing.corkboardNote = false;
            existing.plotgridOrigin = undefined;
            existing.filePath = newPath;
            this.linkFileToCell(cell, newPath);
            if (!opts?.quiet) new Notice(t('Converted cell to Scene'));
            return true;
        }

        const body = this.cellConvertBody(cell);
        if (!body) {
            if (!opts?.quiet) new Notice(t('Add some content before converting'));
            return false;
        }

        const file = await scMgr.createScene({
            status: 'idea',
            title: this.cellTitleFromContent(body, t('Untitled Scene')),
            body,
            plotgridOrigin: this.cellOriginLabel(cell),
        });
        this.linkFileToCell(cell, file.path);
        if (!opts?.quiet) new Notice(t('Converted cell to Scene'));
        return true;
    }

    private async convertCellToResearch(cell: CellData, opts?: { quiet?: boolean }): Promise<boolean> {
        const researchMgr = this.plugin?.researchManager;
        if (!researchMgr) {
            if (!opts?.quiet) new Notice(t('Research manager not available'));
            return false;
        }

        const body = this.cellConvertBody(cell);
        if (!body) {
            if (!opts?.quiet) new Notice(t('Add some content before converting'));
            return false;
        }

        const title = this.cellTitleFromContent(body, t('Untitled'));
        try {
            const post = await researchMgr.createPost(title, 'note', body);
            await researchMgr.scan();
            this.linkFileToCell(cell, post.filePath);
            if (!opts?.quiet) new Notice(t('Converted cell to Research'));
            return true;
        } catch (err) {
            if (!opts?.quiet) new Notice(t('Failed to create research post') + ': ' + String(err));
            return false;
        }
    }

    private ensureDefaults() {
        this.data.rows = this.data.rows || [];
        this.data.columns = this.data.columns || [];
        this.data.cells = this.data.cells || {};
        if (typeof (this.data as unknown as Record<string, unknown>).stickyHeaders === 'undefined') (this.data as unknown as Record<string, unknown>).stickyHeaders = true;
        if (typeof this.data.frozenColumns !== 'number') this.data.frozenColumns = 1;
        if (typeof this.data.frozenRows !== 'number') this.data.frozenRows = 1;
    }

}

export default PlotgridView;
/* eslint-enable @typescript-eslint/no-floating-promises, @typescript-eslint/no-misused-promises, @typescript-eslint/no-unnecessary-type-assertion, @typescript-eslint/no-unused-vars -- end of file-wide suppression block opened at line 1 */
