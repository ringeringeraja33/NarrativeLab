/* eslint-disable @typescript-eslint/no-floating-promises, @typescript-eslint/no-misused-promises, @typescript-eslint/no-unnecessary-type-assertion, @typescript-eslint/no-unused-vars -- Obsidian's API surface and several untyped third-party libraries force dynamic dispatch; floating promises are intentional in DOM/event handlers; matching enable at end of file */
import { WorkspaceLeaf, Menu, Modal, TFile, Notice, MarkdownRenderer, Component } from 'obsidian';
import * as obsidian from 'obsidian';
import {
    CellData,
    PlotGridData,
    ConceptGridDocument,
    ConceptGridPage,
    cloneConceptGridPage,
    createEmptyConceptGridDocument,
    createEmptyConceptGridPage,
    getActiveConceptGridPage,
    normalizeConceptGridDocument,
} from '../models/PlotGridData';
import { getActiveUiLanguage, t } from '../utils/i18n';
import {
    loadPlotGridUniverModule,
    type PlotGridUniverContextAction,
    type PlotGridUniverHost,
} from '../utils/loadPlotGridUniver';
import { conceptGridContentFingerprint } from '../services/PlotGridXlsxCodec';
import { cellRequiresMarkdownEditor } from '../utils/plotGridCellEdit';
import { SceneManager } from '../services/SceneManager';
import { CharacterManager } from '../services/CharacterManager';
import { InspectorComponent } from '../components/Inspector';
import { LinkScanner } from '../services/LinkScanner';
import { renderViewSwitcher } from '../components/ViewSwitcher';
import { isMobile } from '../components/MobileAdapter';
import { PLOTGRID_VIEW_TYPE } from '../constants';
import { resolveTagColor, getPlotlineHSL, contrastTextColor } from '../settings';
import { attachTooltip } from '../components/Tooltip';
import type SceneCardsPlugin from '../main';
import { Scene } from '../models/Scene';
import { openConfirmModal } from '../components/ConfirmModal';
import { WikilinkSuggest } from '../components/WikilinkSuggest';
import {
    applyMarkdownInputAction,
    installObsidianMarkdownShortcuts,
    type MarkdownInputAction,
} from '../utils/markdownInput';
import { ProjectBoundItemView } from './ProjectBoundItemView';
import { deriveProjectFoldersFromFilePath } from '../models/StoryLineProject';

// Use the shared view-type constant from `constants.ts` so the ViewSwitcher
// can correctly detect and style the active tab.
// (Local legacy constant removed.)

// Basic Plot Grid implementation (ground-up) following the supplied guide.
// This file implements the core model, rendering, editing, and persistence.

const ROW_HEADER_WIDTH = 120;

function makeId(prefix = '') {
    return prefix + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 8);
}

export class PlotgridView extends ProjectBoundItemView {
    plugin: SceneCardsPlugin | undefined;
    /** Full multi-page document persisted to plotgrid.json */
    // eslint-disable-next-line obsidianmd/prefer-active-doc -- Concept Grid data model, not the browser Document.
    document: ConceptGridDocument = createEmptyConceptGridDocument();
    /** Active page working set (same object reference as the page in `document`). */
    data: PlotGridData = getActiveConceptGridPage(this.document);
    saveDebounce: number | null = null;

    private bodyEl: HTMLDivElement | null = null;
    private sidebarEl: HTMLDivElement | null = null;
    private wrapperEl: HTMLDivElement | null = null;
    private scrollAreaEl: HTMLDivElement | null = null;
    private canvasEl: HTMLDivElement | null = null;
    /** Active cell (focus); kept in sync with selFocus for inspector / legacy callers */
    private selectedRow: number | null = null;
    private selectedCol: number | null = null;
    /** Rectangular selection: anchor corner + focus (active) corner */
    private selAnchor: { r: number; c: number } | null = null;
    private selFocus: { r: number; c: number } | null = null;
    private isSelecting = false;
    private selectPointerId: number | null = null;
    private inspectorComponent: InspectorComponent | null = null;
    private inspectorEl: HTMLElement | null = null;
    /** Simple undo stack for plot grid cell operations (active page only) */
    private undoStack: PlotGridData[] = [];
    private static readonly MAX_UNDO = 20;

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
        return title ? `NarrativeLab - ${title}` : t('Concept Grid');
    }

    async onOpen(): Promise<void> {
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
        await this.loadData();
        if (!container.isConnected) return;

        this.buildLayout(container);
        this.renderPageSidebar();
        this.renderToolbar();
        // keep main scroll area untouched (no forced scrolling)
        this.renderGrid();

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
                this.refreshOpenCellInspector();
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
        const projectFile = this.loadedProjectFile;
        this.closeAllCellEditors();
        this.flushUniverIntoDocument();
        this.cancelPendingSave();
        if (!projectFile || !this.plugin || typeof this.plugin.savePlotGrid !== 'function') return;
        try {
            await this.plugin.savePlotGrid(this.document, { projectFilePath: projectFile });
        } catch (error) {
            console.error('[NarrativeLab] Plot Grid persist failed:', error);
        }
    }

    async onClose(): Promise<void> {
        // Floating Markdown drafts must enter the model before Univer's final pull.
        const projectFile = this.loadedProjectFile;
        this.closeAllCellEditors();
        this.flushUniverIntoDocument();
        this.cancelPendingSave();
        if (projectFile && this.plugin && typeof this.plugin.savePlotGrid === 'function') {
            try {
                await this.plugin.savePlotGrid(this.document, { projectFilePath: projectFile });
            } catch (error) {
                console.error('[NarrativeLab] Final Plot Grid save failed:', error);
            }
        }
        this.disposeUniverHost({ persist: false });
        // disposeUniverHost performs one last pull; the explicit save above is
        // authoritative, so do not leave a second autosave running after close.
        this.cancelPendingSave();
        this.loadedSystemFolder = null;
        this.loadedProjectFile = null;
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

    private resolveCellEditorHeading(cell: CellData): string {
        const key = cell.id;
        for (const page of this.document.pages) {
            for (const row of page.rows || []) {
                for (const col of page.columns || []) {
                    if (`${row.id}-${col.id}` !== key) continue;
                    const rowLabel = (row.label || '').trim() || '—';
                    const colLabel = (col.label || '').trim() || '—';
                    return `${rowLabel} · ${colLabel}`;
                }
            }
        }
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
    private flushUniverIntoDocument(): void {
        const host = this.univerHost;
        if (!host) return;
        try {
            host.flush();
            this.document = normalizeConceptGridDocument(host.getDocument());
            this.bindActivePage();
        } catch (error) {
            console.warn('[NarrativeLab] Could not flush spreadsheet state:', error);
        }
    }

    /** Undo Univer absolute/fill styles so the legacy DOM grid can lay out again. */
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
                this.univerLoadFailed = false;
                this.univerLoadError = null;
                this.disposeUniverHost({ persist: false });
                this.hideCellInspector();
                this.undoStack = [];
            }

            let loaded: ConceptGridDocument | null = null;
            if (this.plugin && typeof this.plugin.loadPlotGrid === 'function') {
                loaded = await this.plugin.loadPlotGrid(projectFile);
            } else {
                loaded = null;
            }
            this.document = loaded
                ? normalizeConceptGridDocument(loaded)
                : createEmptyConceptGridDocument();
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

                // Try to find a moved scene/note by filename
                const fileName = cell.linkedSceneId.split('/').pop();
                if (!fileName) continue;

                const allScenes = scMgr.getAllScenes();
                const match = allScenes.find(s => s.filePath.endsWith('/' + fileName) || s.filePath === fileName);
                if (match) {
                    cell.linkedSceneId = match.filePath;
                    dirty = true;
                }
                // else: keep broken path — UI falls back to plain text, link preserved
            }
        }
        if (dirty) this.scheduleSave();
    }

    private scheduleSave() {
        const plugin = this.plugin;
        if (!plugin) return;
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
                if (this.univerHost?.isEditorBusy()) {
                    this.scheduleSave();
                    return;
                }
                const currentFolder = this.getActiveSystemFolder();
                if (folderAtSchedule && currentFolder && folderAtSchedule !== currentFolder) {
                    // Active project changed — do not write the previous workbook into the new folder.
                    return;
                }
                // Pull latest Univer cells/sizes into memory before disk write —
                // otherwise deferred pulls leave this.document stale and "save" drops edits.
                if (this.univerHost) {
                    try {
                        this.univerHost.flush();
                        this.document = normalizeConceptGridDocument(this.univerHost.getDocument());
                        this.bindActivePage();
                    } catch { /* ignore */ }
                }
                if (typeof plugin.savePlotGrid === 'function') {
                    await plugin.savePlotGrid(this.document, { projectFilePath: projectAtSchedule });
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

    /** Push a deep clone of the current grid data onto the undo stack. */
    private pushPlotGridUndo(): void {
        const snapshot: PlotGridData = {
            rows: this.data.rows.map(r => ({ ...r })),
            columns: this.data.columns.map(c => ({ ...c })),
            cells: {},
            zoom: this.data.zoom,
            stickyHeaders: this.data.stickyHeaders,
            frozenColumns: this.data.frozenColumns,
            frozenRows: this.data.frozenRows,
        };
        for (const [k, v] of Object.entries(this.data.cells)) {
            snapshot.cells[k] = { ...v };
        }
        this.undoStack.push(snapshot);
        if (this.undoStack.length > PlotgridView.MAX_UNDO) {
            this.undoStack.shift();
        }
    }

    /** Pop the last undo snapshot and restore it. */
    undoPlotGridMove(): void {
        if (this.undoStack.length === 0) {
            new Notice(t('Nothing to undo on the plot grid.'));
            return;
        }
        const snapshot = this.undoStack.pop()!;
        const page = this.getActivePage();
        page.rows = snapshot.rows;
        page.columns = snapshot.columns;
        page.cells = snapshot.cells;
        page.zoom = snapshot.zoom;
        page.stickyHeaders = snapshot.stickyHeaders;
        page.frozenColumns = snapshot.frozenColumns;
        page.frozenRows = snapshot.frozenRows;
        this.data = page;
        this.scheduleSave();
        this.renderGrid({ forcePush: true });
        new Notice(t('Plot grid move undone.'));
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

        // Main grid area (fills remaining height above the sheet tabs)
        this.wrapperEl = this.bodyEl.createDiv('plot-grid-wrapper concept-grid-main');
        this.wrapperEl.setCssStyles({
            display: 'flex',
            flexDirection: 'column',
            // Must NOT be height:100% — that pushes the bottom sheet bar off-screen.
            flex: '1 1 auto',
            minWidth: '0',
            minHeight: '0',
            overflow: 'hidden',
        });
        // make focusable for keyboard navigation
        this.wrapperEl.tabIndex = 0;
        this.wrapperEl.addEventListener('keydown', (e) => this.onKeyDown(e as KeyboardEvent));
        // Drag-select: track pointer across cells (capture may leave the original cell)
        this.registerDomEvent(activeDocument, 'pointermove', (e: PointerEvent) => this.onSelectPointerMove(e));
        this.registerDomEvent(activeDocument, 'pointerup', (e: PointerEvent) => this.onSelectPointerUp(e));
        this.registerDomEvent(activeDocument, 'pointercancel', (e: PointerEvent) => this.onSelectPointerUp(e));

        const toolbar = this.wrapperEl.createDiv('story-line-toolbar plot-grid-toolbar');
        toolbar.setCssStyles({ flex: '0 0 auto' });

        // Work row: grid scroll + docked cell inspector side-by-side (no overlay).
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

        // Docked inspector — shrinks the grid instead of covering cells
        this.inspectorEl = workArea.createDiv('story-line-inspector-panel pg-cell-inspector');
        this.inspectorEl.setCssStyles({ display: 'none' });
        const sceneManager = this.plugin?.sceneManager as SceneManager | undefined;
        if (sceneManager && this.plugin) {
            this.inspectorComponent = new InspectorComponent(
                this.inspectorEl,
                this.plugin,
                sceneManager,
                {
                    onEdit: (scene) => this.openScene(scene),
                    onDelete: (scene) => this.deleteScene(scene),
                    onRefresh: () => this.renderGrid(),
                    onStatusChange: async (scene, status) => {
                        await sceneManager.updateScene(scene.filePath, { status });
                        this.renderGrid();
                    },
                }
            );
        }

        // Excel-style worksheet tabs along the bottom edge
        this.sidebarEl = this.bodyEl.createDiv('concept-grid-sheet-bar');
    }

    private renderPageSidebar(): void {
        if (!this.sidebarEl) return;
        this.sidebarEl.empty();
        this.sidebarEl.setAttribute('aria-label', t('Concept Grid pages'));

        const list = this.sidebarEl.createDiv('concept-grid-page-list');
        let activeTab: HTMLElement | null = null;
        let draggedPageId: string | null = null;
        let blockClickAfterDrag = false;
        const clearDropIndicators = (): void => {
            list.querySelectorAll('.is-drop-before, .is-drop-after').forEach(el => {
                el.removeClass('is-drop-before', 'is-drop-after');
            });
        };

        this.document.pages.forEach((page, index) => {
            const isActive = page.id === this.document.activePageId;
            const tab = list.createEl('button', {
                cls: `concept-grid-page-tab${isActive ? ' is-active' : ''}`,
                attr: {
                    type: 'button',
                    'aria-pressed': String(isActive),
                    title: page.title,
                    'data-page-id': page.id,
                    draggable: 'true',
                },
            });
            tab.createSpan({
                cls: 'concept-grid-page-tab-label',
                text: page.title || `${t('Page')} ${index + 1}`,
            });

            tab.addEventListener('click', (event) => {
                if (blockClickAfterDrag) {
                    event.preventDefault();
                    event.stopPropagation();
                    return;
                }
                if (page.id !== this.document.activePageId) this.switchPage(page.id);
            });
            tab.addEventListener('dblclick', (evt) => {
                evt.preventDefault();
                evt.stopPropagation();
                this.renamePage(page.id);
            });
            tab.addEventListener('contextmenu', (evt) => {
                evt.preventDefault();
                const menu = new Menu();
                menu.addItem(item => item.setTitle(t('Rename page')).onClick(() => this.renamePage(page.id)));
                menu.addItem(item => item.setTitle(t('Duplicate page')).onClick(() => this.duplicatePage(page.id)));
                menu.addSeparator();
                menu.addItem(item => {
                    item.setTitle(t('Delete page'));
                    item.setDisabled(this.document.pages.length <= 1);
                    item.onClick(() => this.deletePage(page.id));
                });
                menu.showAtMouseEvent(evt);
            });
            tab.addEventListener('dragstart', (event) => {
                if (tab.querySelector('.concept-grid-page-tab-rename')) {
                    event.preventDefault();
                    return;
                }
                draggedPageId = page.id;
                blockClickAfterDrag = true;
                tab.addClass('is-dragging');
                if (event.dataTransfer) {
                    event.dataTransfer.effectAllowed = 'move';
                    event.dataTransfer.setData('text/plain', page.id);
                }
            });
            tab.addEventListener('dragover', (event) => {
                if (!draggedPageId || draggedPageId === page.id) return;
                event.preventDefault();
                if (event.dataTransfer) event.dataTransfer.dropEffect = 'move';
                clearDropIndicators();
                const rect = tab.getBoundingClientRect();
                tab.addClass(event.clientX < rect.left + rect.width / 2
                    ? 'is-drop-before'
                    : 'is-drop-after');
            });
            tab.addEventListener('drop', (event) => {
                if (!draggedPageId || draggedPageId === page.id) return;
                event.preventDefault();
                event.stopPropagation();
                const rect = tab.getBoundingClientRect();
                const placeAfter = event.clientX >= rect.left + rect.width / 2;
                this.reorderPage(draggedPageId, page.id, placeAfter);
                draggedPageId = null;
                clearDropIndicators();
            });
            tab.addEventListener('dragend', () => {
                draggedPageId = null;
                tab.removeClass('is-dragging');
                clearDropIndicators();
                window.setTimeout(() => { blockClickAfterDrag = false; }, 0);
            });

            if (isActive) activeTab = tab;
        });

        const addBtn = this.sidebarEl.createEl('button', {
            cls: 'clickable-icon concept-grid-add-page-btn',
            attr: {
                type: 'button',
                'aria-label': t('New page'),
                title: t('New page'),
            },
        });
        obsidian.setIcon(addBtn, 'plus');
        addBtn.addEventListener('click', (e) => {
            e.stopPropagation();
            this.createPage();
        });

        const tabToScroll = activeTab as HTMLElement | null;
        tabToScroll?.scrollIntoView({ block: 'nearest', inline: 'nearest' });
    }

    private switchPage(pageId: string): void {
        if (!this.document.pages.some(p => p.id === pageId)) return;
        this.flushUniverIntoDocument();
        if (!this.document.pages.some(p => p.id === pageId)) return;
        this.document.activePageId = pageId;
        this.bindActivePage();
        try {
            this.univerHost?.setActiveSheet(pageId);
            this.univerHost?.syncMeta(this.document);
        } catch { /* ignore an unavailable host during initial mount */ }
        this.undoStack = [];
        this.clearSelection();
        this.hideCellInspector();
        this.scheduleSave();
        if (!this.updatePageTabSelection()) this.renderPageSidebar();
        this.renderToolbar();
        this.renderGrid();
    }

    /** Update active-tab styling without replacing the DOM, so double-click rename remains reliable. */
    private updatePageTabSelection(): boolean {
        if (!this.sidebarEl) return false;
        const tabs = Array.from(
            this.sidebarEl.querySelectorAll<HTMLButtonElement>('.concept-grid-page-tab'),
        );
        if (tabs.length !== this.document.pages.length) return false;
        let activeTab: HTMLButtonElement | null = null;
        for (const tab of tabs) {
            const active = tab.dataset.pageId === this.document.activePageId;
            tab.toggleClass('is-active', active);
            tab.setAttribute('aria-pressed', String(active));
            if (active) activeTab = tab;
        }
        activeTab?.scrollIntoView({ block: 'nearest', inline: 'nearest' });
        return activeTab !== null;
    }

    /** Move a worksheet before/after another worksheet and persist the new page order. */
    private reorderPage(sourcePageId: string, targetPageId: string, placeAfter: boolean): void {
        this.flushUniverIntoDocument();
        const source = this.document.pages.find(page => page.id === sourcePageId);
        if (!source || sourcePageId === targetPageId) return;
        const remaining = this.document.pages.filter(page => page.id !== sourcePageId);
        const targetIndex = remaining.findIndex(page => page.id === targetPageId);
        if (targetIndex < 0) return;
        remaining.splice(targetIndex + (placeAfter ? 1 : 0), 0, source);
        this.document.pages = remaining;
        this.bindActivePage();
        this.scheduleSave();
        this.renderPageSidebar();
        this.renderGrid({ forcePush: true });
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
            const htmlCell = this.canvasEl?.querySelector(
                `.plot-grid-cell[data-row="${rowIndex}"][data-col="${colIndex}"]`,
            ) as HTMLElement | null;
            htmlCell?.scrollIntoView({ block: 'center', inline: 'nearest' });
            htmlCell?.addClass('is-appearance-flash');
            window.setTimeout(() => htmlCell?.removeClass('is-appearance-flash'), 1600);
        }, 80);
    }

    private createPage(): void {
        this.flushUniverIntoDocument();
        const page = createEmptyConceptGridPage(t('Page {n}', { n: this.document.pages.length + 1 }));
        this.document.pages.push(page);
        this.switchPage(page.id);
    }

    private duplicatePage(pageId: string): void {
        this.flushUniverIntoDocument();
        const source = this.document.pages.find(p => p.id === pageId);
        if (!source) return;
        const copy = cloneConceptGridPage(source, `${source.title} ${t('copy')}`);
        const index = this.document.pages.findIndex(p => p.id === pageId);
        this.document.pages.splice(index + 1, 0, copy);
        this.switchPage(copy.id);
    }

    private renamePage(pageId: string): void {
        this.flushUniverIntoDocument();
        const page = this.document.pages.find(p => p.id === pageId);
        if (!page) return;
        const applyTitle = (next: string): void => {
            const title = next.trim();
            if (!title || title === page.title) return;
            page.title = title;
            try {
                this.univerHost?.setSheetTitle(page.id, title);
                this.univerHost?.syncMeta(this.document);
            } catch { /* ignore */ }
            this.scheduleSave();
            this.renderPageSidebar();
        };

        // Prefer inline rename on the tab (Excel-like). Fall back to a modal.
        const labelEl = this.sidebarEl?.querySelector(
            `.concept-grid-page-tab[data-page-id="${CSS.escape(pageId)}"] .concept-grid-page-tab-label`,
        ) as HTMLElement | null;
        if (labelEl) {
            this.beginInlinePageRename(labelEl, page, applyTitle);
            return;
        }

        const modal = new Modal(this.app);
        modal.titleEl.setText(t('Rename page'));
        const inp = modal.contentEl.createEl('input', { type: 'text', cls: 'plot-grid-rename-input' });
        inp.setCssStyles({ width: '100%' });
        inp.value = page.title;
        const commit = () => {
            applyTitle(inp.value);
            modal.close();
        };
        inp.addEventListener('keydown', (ke) => {
            if (ke.key === 'Enter') commit();
            else if (ke.key === 'Escape') modal.close();
        });
        const btn = modal.contentEl.createEl('button', { text: t('OK'), cls: 'mod-cta' });
        btn.setCssStyles({ marginTop: '8px' });
        btn.addEventListener('click', () => commit());
        modal.open();
        inp.focus();
        inp.select();
    }

    private beginInlinePageRename(
        labelEl: HTMLElement,
        page: { id: string; title: string },
        applyTitle: (next: string) => void,
    ): void {
        if (labelEl.querySelector('input')) return;
        const original = page.title || labelEl.textContent || '';
        const input = labelEl.ownerDocument.createElement('input');
        input.type = 'text';
        input.className = 'concept-grid-page-tab-rename';
        input.value = original;
        input.setAttribute('aria-label', t('Rename page'));
        labelEl.textContent = '';
        labelEl.appendChild(input);
        let finished = false;
        const finish = (commit: boolean) => {
            if (finished) return;
            finished = true;
            const next = input.value;
            input.remove();
            labelEl.textContent = commit && next.trim() ? next.trim() : original;
            if (commit) applyTitle(next);
            else this.renderPageSidebar();
        };
        input.addEventListener('keydown', (event) => {
            event.stopPropagation();
            if (event.key === 'Enter') {
                event.preventDefault();
                finish(true);
            } else if (event.key === 'Escape') {
                event.preventDefault();
                finish(false);
            }
        });
        input.addEventListener('blur', () => finish(true));
        input.addEventListener('click', (event) => event.stopPropagation());
        input.addEventListener('mousedown', (event) => event.stopPropagation());
        window.setTimeout(() => {
            input.focus();
            input.select();
        }, 0);
    }

    private deletePage(pageId: string): void {
        if (this.document.pages.length <= 1) {
            new Notice(t('At least one page is required.'));
            return;
        }
        const page = this.document.pages.find(p => p.id === pageId);
        if (!page) return;
        openConfirmModal(this.app, {
            title: t('Delete page'),
            message: t('Delete page "{title}"? This cannot be undone.', { title: page.title }),
            confirmLabel: t('Delete'),
            onConfirm: () => {
                this.flushUniverIntoDocument();
                const index = this.document.pages.findIndex(p => p.id === pageId);
                if (index < 0) return;
                this.document.pages.splice(index, 1);
                if (this.document.activePageId === pageId) {
                    const next = this.document.pages[Math.max(0, index - 1)] || this.document.pages[0];
                    if (!next) return;
                    this.document.activePageId = next.id;
                }
                this.bindActivePage();
                this.undoStack = [];
                this.scheduleSave();
                this.renderPageSidebar();
                this.renderToolbar();
                this.renderGrid();
            },
        });
    }

    private renderToolbar() {
        if (!this.wrapperEl) return;
        const toolbar = this.wrapperEl.querySelector('.plot-grid-toolbar') as HTMLDivElement | null;
        if (!toolbar) return;
        toolbar.empty();

        const titleRow = toolbar.createDiv('story-line-title-row');
        const projectTitle = this.plugin?.getActiveProjectDisplayName() || '';
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

        const controls = toolbar.createDiv('story-line-toolbar-controls');
        // add a small left margin so there's a bit more space between the view switcher and action buttons
        controls.setCssStyles({ marginLeft: '24px' });

        // Plot-grid controls sit before the shared Stats / Converter / Playmode
        // group. Reappend that group so it is the rightmost toolbar item; its
        // existing left border becomes the single separator between the groups.
        const trailingActions = toolbar.querySelector(':scope > .story-line-view-actions');
        if (trailingActions) toolbar.appendChild(trailingActions);

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
            marginLeft: 'auto',
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
        if (this.univerHost) {
            this.univerHost.setZoom(this.document.activePageId, z);
            this.univerHost.syncMeta(this.document);
        } else if (this.canvasEl && this.scrollAreaEl) {
            // Use CSS zoom instead of transform: scale() to preserve position: sticky
            (this.canvasEl.style as unknown as Record<string, unknown>).zoom = String(z);
            const totalWidth = this.computeTotalWidth();
            this.canvasEl.setCssStyles({ width: totalWidth + 'px' });
        }
        this.scheduleSave();
        const toolbar = this.wrapperEl?.querySelector('.plot-grid-toolbar') || this.wrapperEl?.querySelector('.story-line-toolbar');
        const label = toolbar?.querySelector('.plot-grid-zoom-label') as HTMLElement | null;
        if (label) label.textContent = Math.round(z * 100) + '%';
    }

    private computeTotalWidth() {
        return ROW_HEADER_WIDTH + this.data.columns.reduce((s, c) => s + c.width, 0);
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
                        // Ensure the NL cell exists, then open the Markdown editor.
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
                        menu.showAtPosition(position);
                    },
                    onDocumentChange: (doc) => {
                        if (mountGen !== this.univerMountGeneration) return;
                        this.document = normalizeConceptGridDocument(doc);
                        this.synchronizeWikilinkCells();
                        this.bindActivePage();
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
                                this.renderPageSidebar();
                                this.scheduleSave();
                            }
                        }
                        this.selectedRow = info.row > 0 ? info.row - 1 : null;
                        this.selectedCol = info.col > 0 ? info.col - 1 : null;
                        this.selFocus = (this.selectedRow != null && this.selectedCol != null)
                            ? { r: this.selectedRow, c: this.selectedCol }
                            : null;
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
                    window.dispatchEvent(new Event('resize'));
                });
            } catch (e) {
                if (mountGen !== this.univerMountGeneration) return;
                console.error('[NarrativeLab] Univer Plot Grid failed to initialize', e);
                this.univerLoadFailed = true;
                this.univerLoadError = e;
                this.univerHost = null;
                this.renderUniverLoadError();
            } finally {
                if (mountGen === this.univerMountGeneration) {
                    this.univerMountPromise = null;
                }
            }
        })();

        await this.univerMountPromise;
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
            text: t('NarrativeLab did not replace Univer with the legacy grid. Try loading it again.'),
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
            if (!cell.linkedSceneId) {
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
        const sourcePath = this.plugin?.sceneManager?.activeProject?.filePath ?? '';
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
        const linkedScene = this.plugin?.sceneManager?.getScene(path);
        if (linkedScene) this.openScene(linkedScene);
        else this.openVaultFile(path);
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
        menu.showAtPosition(position);
    }

    /** Read-only cell lookup (Univer coords; does not expand the grid). */
    private getDataCellAt(sheetId: string, row: number, col: number): CellData | null {
        if (row < 1 || col < 1) return null;
        const page = this.document.pages.find(p => p.id === sheetId);
        const rowMeta = page?.rows[row - 1];
        const colMeta = page?.columns[col - 1];
        if (!page || !rowMeta || !colMeta) return null;
        return page.cells[`${rowMeta.id}-${colMeta.id}`] || null;
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
        // Univer uses row 0 / column 0 for NarrativeLab's editable labels (A1 is
        // the corner). Never steal selection away from those cells — remapping to
        // B2 aborted in-cell edits and made A1 feel uneditable.
        if (sel.row < 1 || sel.col < 1) return null;
        const dataRow = sel.row;
        const dataCol = sel.col;
        let expanded = false;
        while (page.rows.length < dataRow) {
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
        while (page.columns.length < dataCol) {
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
        const row = livePage.rows[dataRow - 1];
        const col = livePage.columns[dataCol - 1];
        if (!row || !col) return null;
                const key = `${row.id}-${col.id}`;
        if (!livePage.cells[key]) {
            livePage.cells[key] = {
                            id: key,
                            content: '',
                            bgColor: '',
                            textColor: '',
                            bold: false,
                            italic: false,
                align: 'left',
            };
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
        const cell = this.getActivePlotGridCell();
        if (!cell) {
            new Notice(t('Select a cell first'));
            return;
        }
        this.openCellMarkdownEditor(cell);
    }

    private openCellMarkdownEditor(cell: CellData, options: { insertWikilink?: boolean } = {}): void {
        const cellKey = cell.id || `${Date.now()}`;
        const existing = this.cellEditorWindows.get(cellKey);
        if (existing?.isConnected) {
            existing.__nlCellEditorFocus?.(options);
            return;
        }
        if (existing) this.cellEditorWindows.delete(cellKey);

        const editorApp = this.app;
        const sourcePath = this.getTargetProjectFile();
        // Structural link draft; content lives in the textarea and autosaves.
        let editorLinkedSceneId: string | undefined = cell.linkedSceneId;
        let autosaveTimer: number | null = null;
        const persistDraft = (opts: { pushGrid?: boolean } = {}): void => {
            if (!textarea) return;
            const liveCell = this.ensureCellInData(cell);
            const value = textarea.value;
            const linkChanged = (editorLinkedSceneId || undefined) !== (liveCell.linkedSceneId || undefined);
            const contentChanged = liveCell.content !== value || !liveCell.manualContent;
            if (!contentChanged && !linkChanged) return;
            liveCell.content = value;
            liveCell.manualContent = true;
            if (linkChanged) {
                liveCell.linkedSceneId = editorLinkedSceneId;
                if (!editorLinkedSceneId) liveCell.linkedViaWikilink = undefined;
            }
            this.synchronizeWikilinkCells();
            this.scheduleSave();
            if (opts.pushGrid) {
                this.renderGrid({ forcePush: true });
            } else {
                try { this.univerHost?.refreshLinkMarkers(); } catch { /* ignore */ }
            }
            this.refreshOpenCellInspector();
        };
        const scheduleAutosave = (): void => {
            if (autosaveTimer) window.clearTimeout(autosaveTimer);
            autosaveTimer = window.setTimeout(() => {
                autosaveTimer = null;
                persistDraft({ pushGrid: false });
            }, 500);
        };
        const flushAutosave = (): void => {
            if (autosaveTimer) {
                window.clearTimeout(autosaveTimer);
                autosaveTimer = null;
            }
            persistDraft({ pushGrid: true });
        };

        type EditorWin = HTMLElement & {
            __nlCellEditorCleanup?: () => void;
            __nlCellEditorFlush?: () => void;
            __nlCellEditorFocus?: (opts?: { insertWikilink?: boolean }) => void;
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
            const next = textarea.value.replace(
                /\[\[([^\]|#]+)(?:#[^\]|]+)?(?:\|([^\]]+))?\]\]/g,
                (full, target: string) => (draftMatchesNote(target, note.path) ? '' : full),
            ).replace(/[ \t]{2,}/g, ' ').replace(/ ?\n ?/g, '\n');
            textarea.value = next;
            if (editorLinkedSceneId && notePathKey(editorLinkedSceneId) === notePathKey(note.path)) {
                editorLinkedSceneId = undefined;
            } else if (editorLinkedSceneId && draftMatchesNote(editorLinkedSceneId, note.path)) {
                editorLinkedSceneId = undefined;
            }
            textarea.dispatchEvent(new Event('input', { bubbles: true }));
            refreshLinkedNotesBar();
        };
        const addConnectedNoteViaPicker = (): void => {
            void setPreview(false).then(() => {
                if (!textarea) return;
                const current = textarea.value;
                const prefix = current && !/\s$/.test(current) ? ' ' : '';
                textarea.value = `${current}${prefix}[[`;
                const end = textarea.value.length;
                textarea.setSelectionRange(end, end);
                textarea.focus();
                textarea.dispatchEvent(new Event('input', { bubbles: true }));
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
            renderer.unload();
            if (this.cellEditorWindows.get(cellKey) === win) this.cellEditorWindows.delete(cellKey);
            delete win.__nlCellEditorCleanup;
            delete win.__nlCellEditorFlush;
            delete win.__nlCellEditorFocus;
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
            textarea.value = `${current}${prefix}[[`;
            const end = textarea.value.length;
            textarea.setSelectionRange(end, end);
            textarea.dispatchEvent(new Event('input', { bubbles: true }));
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
    async refresh(): Promise<void> {
        try {
            const projectFile = this.getTargetProjectFile();
            const projectChanged = this.loadedProjectFile != null
                && projectFile.length > 0
                && this.loadedProjectFile !== projectFile;

            if (projectChanged) {
                // Always reload on project switch — never skip for pending saves / focus.
                await this.persistBoundPlotGrid();
                this.disposeUniverHost({ persist: false });
            } else {
                // Pull pending Univer edits into memory before deciding whether disk
                // reload is safe. Otherwise a vault refresh can overwrite the grid
                // while edits still live only inside Univer (pre-debounce).
                if (this.univerHost) {
                    // Never flush/reload while typing — flush blurs the editor and
                    // load+render remounts the workbook (viewport jump).
                    if (this.univerHost.isEditorBusy()) return;
                    try { this.univerHost.flush(); } catch { /* ignore */ }
                }
                // If a save is pending, skip reloading from disk (would overwrite in-memory changes)
                if (this.saveDebounce) return;
                // Pending sync after flush should have scheduled save; still guard.
                if (this.univerHost?.hasPendingSync()) return;
                // Floating Markdown editors mount on <body> — vault refresh must not wipe them.
                for (const win of this.cellEditorWindows.values()) {
                    if (win.isConnected) return;
                }
                // If a cell is being edited, skip refresh to avoid destroying the textarea.
                if (this.canvasEl?.querySelector('.plot-grid-cell.editing')) return;
                // Focused inputs in the grid or inspector still own uncommitted drafts.
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

            this.renderPageSidebar();
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

    private getSelectionRect(): { r0: number; r1: number; c0: number; c1: number } | null {
        if (!this.selAnchor || !this.selFocus) return null;
        return {
            r0: Math.min(this.selAnchor.r, this.selFocus.r),
            r1: Math.max(this.selAnchor.r, this.selFocus.r),
            c0: Math.min(this.selAnchor.c, this.selFocus.c),
            c1: Math.max(this.selAnchor.c, this.selFocus.c),
        };
    }

    private forEachSelectedCell(fn: (r: number, c: number, key: string, cell: CellData) => void): void {
        const rect = this.getSelectionRect();
        if (!rect) return;
        for (let r = rect.r0; r <= rect.r1; r++) {
            for (let c = rect.c0; c <= rect.c1; c++) {
                const row = this.data.rows[r];
                const col = this.data.columns[c];
                if (!row || !col) continue;
                const key = `${row.id}-${col.id}`;
                const cell = this.data.cells[key];
                if (cell) fn(r, c, key, cell);
            }
        }
    }

    private setSelection(anchor: { r: number; c: number } | null, focus: { r: number; c: number } | null): void {
        this.selAnchor = anchor;
        this.selFocus = focus;
        if (focus) {
            this.selectedRow = focus.r;
            this.selectedCol = focus.c;
        } else {
            this.selectedRow = null;
            this.selectedCol = null;
        }
        this.applySelectionVisuals();
    }

    private clearSelection(): void {
        this.isSelecting = false;
        this.selectPointerId = null;
        this.setSelection(null, null);
    }

    private applySelectionVisuals() {
        if (!this.canvasEl) return;
        this.canvasEl.querySelectorAll('.plot-grid-cell.in-selection, .plot-grid-cell.is-active, .plot-grid-cell.selected').forEach(n => {
            n.classList.remove('in-selection', 'is-active', 'selected');
        });
        this.canvasEl.querySelectorAll('.plot-grid-row-header.selected, .plot-grid-col-header.selected').forEach(n => {
            n.classList.remove('selected');
        });

        const rect = this.getSelectionRect();
        if (!rect) return;

        for (let r = rect.r0; r <= rect.r1; r++) {
            for (let c = rect.c0; c <= rect.c1; c++) {
                const el = this.getCellElement(r, c);
                if (el) el.classList.add('in-selection');
            }
            const rowHeader = this.canvasEl.querySelectorAll('.plot-grid-row-header')[r] as HTMLElement | undefined;
            if (rowHeader) rowHeader.classList.add('selected');
        }
        for (let c = rect.c0; c <= rect.c1; c++) {
            const colHeader = this.canvasEl.querySelectorAll('.plot-grid-col-header')[c] as HTMLElement | undefined;
            if (colHeader) colHeader.classList.add('selected');
        }

        const activeR = this.selectedRow ?? this.selFocus?.r;
        const activeC = this.selectedCol ?? this.selFocus?.c;
        if (activeR != null && activeC != null) {
            const active = this.getCellElement(activeR, activeC);
            if (active) {
                active.classList.add('is-active', 'selected');
            }
        }
    }

    private selectCell(el: HTMLElement, extend = false) {
        const r = Number(el.getAttribute('data-row'));
        const c = Number(el.getAttribute('data-col'));
        if (Number.isNaN(r) || Number.isNaN(c)) return;
        if (extend && this.selAnchor) {
            this.setSelection(this.selAnchor, { r, c });
        } else {
            this.setSelection({ r, c }, { r, c });
        }
        el.scrollIntoView({ block: 'nearest', inline: 'nearest' });
    }

    private getCellElement(row: number, col: number): HTMLElement | null {
        return (this.canvasEl?.querySelector(`.plot-grid-cell[data-row="${row}"][data-col="${col}"]`) as HTMLElement) ?? null;
    }

    private cellCoordsFromPoint(clientX: number, clientY: number): { r: number; c: number } | null {
        const el = activeDocument.elementFromPoint(clientX, clientY) as HTMLElement | null;
        const cell = el?.closest?.('.plot-grid-cell') as HTMLElement | null;
        if (!cell || !this.canvasEl?.contains(cell)) return null;
        const r = Number(cell.getAttribute('data-row'));
        const c = Number(cell.getAttribute('data-col'));
        if (Number.isNaN(r) || Number.isNaN(c)) return null;
        return { r, c };
    }

    private onSelectPointerMove(ev: PointerEvent): void {
        if (!this.isSelecting) return;
        if (this.selectPointerId !== null && ev.pointerId !== this.selectPointerId) return;
        const coords = this.cellCoordsFromPoint(ev.clientX, ev.clientY);
        if (!coords || !this.selAnchor) return;
        if (this.selFocus && this.selFocus.r === coords.r && this.selFocus.c === coords.c) return;
        this.setSelection(this.selAnchor, coords);
    }

    private onSelectPointerUp(ev: PointerEvent): void {
        if (!this.isSelecting) return;
        if (this.selectPointerId !== null && ev.pointerId !== this.selectPointerId) return;
        this.isSelecting = false;
        this.selectPointerId = null;
        this.refreshSelectionInspector();
    }

    private moveSelection(dx: number, dy: number, extend = false) {
        if (!this.selFocus) {
            if (this.data.rows.length > 0 && this.data.columns.length > 0) {
                this.setSelection({ r: 0, c: 0 }, { r: 0, c: 0 });
            }
            this.refreshSelectionInspector();
            return;
        }
        const nr = Math.max(0, Math.min(this.data.rows.length - 1, this.selFocus.r + dy));
        const nc = Math.max(0, Math.min(this.data.columns.length - 1, this.selFocus.c + dx));
        if (extend && this.selAnchor) {
            this.setSelection(this.selAnchor, { r: nr, c: nc });
        } else {
            this.setSelection({ r: nr, c: nc }, { r: nr, c: nc });
        }
        const el = this.getCellElement(nr, nc);
        if (el) el.scrollIntoView({ block: 'nearest', inline: 'nearest' });
        this.refreshSelectionInspector();
    }

    private beginEditAtFocus(seedChar?: string): void {
        if (this.selectedRow === null || this.selectedCol === null) return;
        const el = this.getCellElement(this.selectedRow, this.selectedCol);
        const row = this.data.rows[this.selectedRow];
        const column = this.data.columns[this.selectedCol];
        if (!row || !column) return;
        const key = `${row.id}-${column.id}`;
        const cell = this.data.cells[key];
        if (el && cell) this.enterEditMode(el, cell, el.querySelector('div') as HTMLElement, seedChar);
    }

    private clearSelectionContents(): void {
        const rect = this.getSelectionRect();
        if (!rect) return;
        this.pushPlotGridUndo();
        this.forEachSelectedCell((_r, _c, _key, cell) => {
            cell.content = '';
            cell.manualContent = true;
        });
        this.scheduleSave();
        this.renderGrid();
    }

    private selectionToTsv(): string {
        const rect = this.getSelectionRect();
        if (!rect) return '';
        const lines: string[] = [];
        for (let r = rect.r0; r <= rect.r1; r++) {
            const cols: string[] = [];
            for (let c = rect.c0; c <= rect.c1; c++) {
                const row = this.data.rows[r];
                const col = this.data.columns[c];
                const cell = row && col ? this.data.cells[`${row.id}-${col.id}`] : undefined;
                const text = (cell?.content || '').replace(/\r\n/g, '\n').replace(/\t/g, ' ');
                cols.push(text);
            }
            lines.push(cols.join('\t'));
        }
        return lines.join('\n');
    }

    private async copySelectionToClipboard(): Promise<void> {
        const tsv = this.selectionToTsv();
        if (!tsv && !this.getSelectionRect()) return;
        try {
            await navigator.clipboard.writeText(tsv);
        } catch {
            // Fallback for restricted clipboard APIs
            const ta = activeDocument.createElement('textarea');
            ta.value = tsv;
            ta.classList.add('pg-clipboard-helper');
            activeDocument.body.appendChild(ta);
            ta.select();
            try {
                // execCommand remains the only sync fallback when Clipboard API is blocked
                // eslint-disable-next-line @typescript-eslint/no-deprecated
                activeDocument.execCommand('copy');
            } catch { /* noop */ }
            ta.remove();
        }
    }

    private async cutSelectionToClipboard(): Promise<void> {
        await this.copySelectionToClipboard();
        this.clearSelectionContents();
    }

    private async pasteTsvFromClipboard(): Promise<void> {
        if (!this.selFocus) return;
        let text = '';
        try {
            text = await navigator.clipboard.readText();
        } catch {
            new Notice(t('Could not read clipboard'));
            return;
        }
        if (text == null) return;
        // Normalize line endings; keep trailing empty row only if present as final \n after content
        const normalized = text.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
        if (!normalized) return;
        const rows = normalized.split('\n');
        // Drop a single trailing empty line from Excel-style copies
        if (rows.length > 1 && rows[rows.length - 1] === '') rows.pop();
        if (!rows.length) return;

        this.pushPlotGridUndo();
        const startR = this.selFocus.r;
        const startC = this.selFocus.c;
        let maxCols = 1;
        for (let i = 0; i < rows.length; i++) {
            const tr = startR + i;
            if (tr >= this.data.rows.length) break;
            const sourceRow = rows[i];
            if (sourceRow === undefined) continue;
            const cols = sourceRow.split('\t');
            maxCols = Math.max(maxCols, cols.length);
            for (let j = 0; j < cols.length; j++) {
                const tc = startC + j;
                if (tc >= this.data.columns.length) break;
                const row = this.data.rows[tr];
                const col = this.data.columns[tc];
                if (!row || !col) continue;
                const cell = this.data.cells[`${row.id}-${col.id}`];
                if (!cell) continue;
                cell.content = cols[j] ?? '';
                cell.manualContent = true;
            }
        }
        const pastedRows = Math.min(rows.length, this.data.rows.length - startR);
        const pastedCols = Math.min(maxCols, this.data.columns.length - startC);
        const endR = startR + Math.max(1, pastedRows) - 1;
        const endC = startC + Math.max(1, pastedCols) - 1;
        this.setSelection({ r: startR, c: startC }, { r: endR, c: endC });
        this.scheduleSave();
        this.renderGrid();
    }

    private onKeyDown(e: KeyboardEvent) {
        if (!this.wrapperEl) return;
        // Embedded Univer owns keyboard + IME. Intercepting keys (arrows, type-to-edit,
        // clipboard shortcuts) steals focus from the sheet editor and makes the
        // candidate window jump / vanish.
        if (this.univerHost) return;
        const target = e.target as HTMLElement | null;
        // Inputs/textareas handle their own keys (do not intercept).
        if (target?.closest('input, textarea, [contenteditable="true"]')) {
            return;
        }
        if (this.canvasEl?.querySelector('.plot-grid-cell.editing')) {
            return;
        }
        // Header rename: if focus was stolen by the wrapper, give keystrokes back.
        const headerInput = this.canvasEl?.querySelector(
            '.plot-grid-header-editing input',
        ) as HTMLInputElement | null;
        if (headerInput) {
            headerInput.focus();
            if (
                e.key.length === 1
                && !e.ctrlKey && !e.metaKey && !e.altKey
                && !e.isComposing
            ) {
                e.preventDefault();
                const start = headerInput.selectionStart ?? headerInput.value.length;
                const end = headerInput.selectionEnd ?? headerInput.value.length;
                headerInput.value =
                    headerInput.value.slice(0, start) + e.key + headerInput.value.slice(end);
                const pos = start + e.key.length;
                headerInput.setSelectionRange(pos, pos);
            } else if (e.key === 'Enter') {
                e.preventDefault();
                headerInput.blur();
            } else if (e.key === 'Escape') {
                e.preventDefault();
                headerInput.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
            }
            return;
        }

        const mod = e.ctrlKey || e.metaKey;

        if (mod && (e.key === 'a' || e.key === 'A')) {
            e.preventDefault();
            if (this.data.rows.length && this.data.columns.length) {
                this.setSelection(
                    { r: 0, c: 0 },
                    { r: this.data.rows.length - 1, c: this.data.columns.length - 1 },
                );
                this.refreshSelectionInspector();
            }
            return;
        }
        if (mod && (e.key === 'c' || e.key === 'C')) {
            e.preventDefault();
            void this.copySelectionToClipboard();
            return;
        }
        if (mod && (e.key === 'x' || e.key === 'X')) {
            e.preventDefault();
            void this.cutSelectionToClipboard();
            return;
        }
        if (mod && (e.key === 'v' || e.key === 'V')) {
            e.preventDefault();
            void this.pasteTsvFromClipboard();
            return;
        }
        if (mod && (e.key === 'z' || e.key === 'Z') && !e.shiftKey) {
            e.preventDefault();
            this.undoPlotGridMove();
            return;
        }

        switch (e.key) {
            case 'ArrowRight':
                e.preventDefault(); this.moveSelection(1, 0, e.shiftKey); break;
            case 'ArrowLeft':
                e.preventDefault(); this.moveSelection(-1, 0, e.shiftKey); break;
            case 'ArrowDown':
                e.preventDefault(); this.moveSelection(0, 1, e.shiftKey); break;
            case 'ArrowUp':
                e.preventDefault(); this.moveSelection(0, -1, e.shiftKey); break;
            case 'Tab':
                e.preventDefault(); this.moveSelection(e.shiftKey ? -1 : 1, 0, false); break;
            case 'Enter':
                e.preventDefault();
                if (this.beginSelectedHeaderEdit()) break;
                this.beginEditAtFocus();
                break;
            case 'F2':
                e.preventDefault();
                if (this.beginSelectedHeaderEdit()) break;
                this.beginEditAtFocus();
                break;
            case 'Delete':
            case 'Backspace':
                e.preventDefault();
                this.clearSelectionContents();
                break;
            default: {
                // Type-to-edit: printable character replaces cell/header content
                if (mod || e.altKey) break;
                if (e.key.length === 1 && !e.isComposing) {
                    e.preventDefault();
                    if (this.beginSelectedHeaderEdit(e.key)) break;
                    this.beginEditAtFocus(e.key);
                }
                break;
            }
        }
    }

    /** True when the current selection is an entire column (header click). */
    private isFullColumnSelection(): number | null {
        const rect = this.getSelectionRect();
        if (!rect || this.data.rows.length === 0) return null;
        if (rect.c0 === rect.c1 && rect.r0 === 0 && rect.r1 === this.data.rows.length - 1) {
            return rect.c0;
        }
        return null;
    }

    /** True when the current selection is an entire row (header click). */
    private isFullRowSelection(): number | null {
        const rect = this.getSelectionRect();
        if (!rect || this.data.columns.length === 0) return null;
        if (rect.r0 === rect.r1 && rect.c0 === 0 && rect.c1 === this.data.columns.length - 1) {
            return rect.r0;
        }
        return null;
    }

    /** Start renaming the selected row/column header; returns true if handled. */
    private beginSelectedHeaderEdit(seedChar?: string): boolean {
        const colIdx = this.isFullColumnSelection();
        if (colIdx !== null) {
            this.beginHeaderLabelEdit('col', colIdx, seedChar);
            return true;
        }
        const rowIdx = this.isFullRowSelection();
        if (rowIdx !== null) {
            this.beginHeaderLabelEdit('row', rowIdx, seedChar);
            return true;
        }
        return false;
    }

    /** Inline rename for a row or column header label. */
    private beginHeaderLabelEdit(
        kind: 'col' | 'row',
        index: number,
        seedChar?: string,
    ): void {
        if (!this.canvasEl) return;
        const selector = kind === 'col' ? '.plot-grid-col-header' : '.plot-grid-row-header';
        const headers = this.canvasEl.querySelectorAll(selector);
        const el = headers[index] as HTMLElement | undefined;
        if (!el) return;

        const target = kind === 'col' ? this.data.columns[index] : this.data.rows[index];
        if (!target) return;

        // Avoid nesting editors / fighting drag-reorder while typing.
        if (el.querySelector('input')) return;
        el.draggable = false;
        el.addClass('plot-grid-header-editing');

        // Same as cell edit: wrapper must not steal focus/keystrokes while renaming.
        if (this.wrapperEl) this.wrapperEl.tabIndex = -1;

        const inp = activeDocument.createElement('input');
        inp.type = 'text';
        inp.value = seedChar !== undefined ? seedChar : (target.label || '');
        inp.setAttr('aria-label', kind === 'col' ? t('Rename Column') : t('Rename Row'));
        inp.setCssStyles({
            width: '100%',
            height: '100%',
            minHeight: '28px',
            boxSizing: 'border-box',
            margin: '0',
            border: 'none',
            outline: '2px solid var(--interactive-accent)',
            background: 'var(--background-primary)',
            color: 'var(--text-normal)',
            font: 'inherit',
            textAlign: 'center',
            zIndex: '30',
            position: 'relative',
            pointerEvents: 'auto',
        });
        el.empty();
        el.appendChild(inp);

        let finished = false;
        const restoreFocusability = () => {
            if (this.wrapperEl) this.wrapperEl.tabIndex = 0;
        };
        const finish = (commit: boolean) => {
            if (finished) return;
            finished = true;
            restoreFocusability();
            if (commit) {
                const next = inp.value.trim();
                if (next) target.label = next;
                this.scheduleSave();
            }
            this.renderGrid();
            // Restore grid keyboard nav after rename.
            window.requestAnimationFrame(() => {
                this.wrapperEl?.focus({ preventScroll: true });
            });
        };

        const stop = (event: Event) => event.stopPropagation();
        inp.addEventListener('mousedown', stop);
        inp.addEventListener('mouseup', stop);
        inp.addEventListener('click', stop);
        inp.addEventListener('dblclick', stop);
        inp.addEventListener('pointerdown', stop);
        inp.addEventListener('keydown', (ke) => {
            ke.stopPropagation();
            if (ke.key === 'Enter') {
                ke.preventDefault();
                finish(true);
            } else if (ke.key === 'Escape') {
                ke.preventDefault();
                finish(false);
            }
        });
        // Defer blur-commit so clicking another header doesn't race with focus restore.
        inp.addEventListener('blur', () => {
            window.setTimeout(() => {
                if (finished) return;
                // Still focused inside this editor (e.g. IME) — don't commit yet.
                if (activeDocument.activeElement === inp) return;
                finish(true);
            }, 0);
        });

        window.requestAnimationFrame(() => {
            inp.focus();
            if (seedChar !== undefined) {
                const len = inp.value.length;
                inp.setSelectionRange(len, len);
            } else {
                inp.select();
            }
        });
    }


    /** Render Markdown into a Concept Grid cell (or other preview host). */
    private async renderMarkdownInto(el: HTMLElement, markdown: string, sourcePath = ''): Promise<void> {
        el.empty();
        if (!markdown.trim()) return;
        await MarkdownRenderer.render(this.app, markdown, el, sourcePath, this);
    }

    /** Open a scene file in a new tab */
    private async openScene(scene: Scene): Promise<void> {
        const file = this.app.vault.getAbstractFileByPath(scene.filePath);
        if (file instanceof TFile) {
            const leaf = this.app.workspace.getLeaf('tab');
            await leaf.openFile(file, { state: { mode: 'source', source: false } });
        } else {
            new Notice(t('Could not find file: {path}', { path: scene.filePath }));
        }
    }

    /** Delete a scene and refresh the grid */
    private async deleteScene(scene: Scene): Promise<void> {
        const scMgr = this.plugin?.sceneManager as SceneManager | undefined;
        if (!scMgr) return;
        await scMgr.deleteScene(scene.filePath);
        // Keep linkedSceneId so convert/relink can inherit the relationship.
        // Cell falls back to plain-text UI while the file is missing.
        for (const c of Object.values(this.data.cells)) {
            if (c.linkedSceneId !== scene.filePath) continue;
            if (scene.corkboardNote) {
                const body = (scene.body || '').trim();
                if (body && !(c.content || '').trim()) {
                    c.content = body;
                    c.manualContent = true;
                }
            }
        }
        this.scheduleSave();
        this.renderGrid();
        // Rebuild cell details so the Note/Scene tab disappears immediately
        this.refreshOpenCellInspector();
    }

    /**
     * If the cell-details panel is open, rebuild it from the current selection.
     * Used after delete/unlink so the Note/Scene tab is removed at once.
     */
    private refreshOpenCellInspector(): void {
        if (!this.inspectorEl) return;
        if (this.inspectorEl.style.display === 'none') return;
        this.refreshSelectionInspector();
    }

    /** Show single- or multi-cell details for the current rectangular selection. */
    private refreshSelectionInspector(): void {
        if (!this.inspectorEl) return;
        const items: Array<{ r: number; c: number; key: string; cell: CellData }> = [];
        this.forEachSelectedCell((r, c, key, cell) => {
            items.push({ r, c, key, cell });
        });
        if (items.length === 0) {
            this.hideCellInspector();
            return;
        }
        if (items.length === 1) {
            const item = items[0];
            if (!item) return;
            this.showCellInspector(item.r, item.c, item.cell);
            return;
        }
        this.showMultiCellInspector(items);
    }

    private enterEditMode(cellEl: HTMLElement, cell: CellData, _contentEl: HTMLElement, seedChar?: string) {
        cellEl.classList.add('editing');
        cellEl.empty();
        const ta = cellEl.createEl('textarea');
        // Type-to-edit replaces content with the typed character; F2/Enter keeps existing text
        ta.value = seedChar !== undefined ? seedChar : (cell.content || '');
        ta.placeholder = t('Markdown supported…');
        ta.setCssStyles({
            width: '100%',
            height: '100%',
            border: 'none',
            padding: '6px 8px',
            boxSizing: 'border-box',
            resize: 'none',
            background: 'transparent',
            color: 'inherit',
            font: 'inherit',
            outline: 'none',
        });
        // Prevent clicks inside textarea from propagating to cell/wrapper
        ta.addEventListener('mousedown', (e) => e.stopPropagation());
        ta.addEventListener('click', (e) => e.stopPropagation());
        ta.addEventListener('dblclick', (e) => e.stopPropagation());

        // Remove wrapper focusability while editing so it can't steal focus
        if (this.wrapperEl) this.wrapperEl.tabIndex = -1;

        let committed = false;
        const restoreFocusability = () => {
            if (this.wrapperEl) this.wrapperEl.tabIndex = 0;
        };
        const commit = () => {
            if (committed) return;
            committed = true;
            restoreFocusability();
            cell.content = ta.value;
            // Mark as manually edited so sync won't overwrite
            cell.manualContent = true;
                this.scheduleSave();
                this.renderGrid();
        };
        const cancel = () => {
            if (committed) return;
            committed = true;
            restoreFocusability();
            this.renderGrid();
        };

        // Use requestAnimationFrame + focus to guarantee it happens after the current event cycle
        window.requestAnimationFrame(() => {
            ta.focus();
            const len = ta.value.length;
            ta.setSelectionRange(len, len);
        });

        ta.addEventListener('keydown', (e) => {
            e.stopPropagation();
            if (e.key === 'Escape') {
                e.preventDefault();
                cancel();
            } else if (e.key === 'Tab') {
                e.preventDefault();
                // commit and move to next cell
                commit();
                const curR = Number(cellEl.getAttribute('data-row'));
                const curC = Number(cellEl.getAttribute('data-col'));
                let nr = curR;
                let nc = curC + (e.shiftKey ? -1 : 1);
                if (nc >= this.data.columns.length) { nc = 0; nr = Math.min(this.data.rows.length - 1, curR + 1); }
                if (nc < 0) { nc = Math.max(0, this.data.columns.length - 1); nr = Math.max(0, curR - 1); }
                window.setTimeout(() => {
                    const newEl = this.getCellElement(nr, nc);
                    const row = this.data.rows[nr];
                    const column = this.data.columns[nc];
                    if (!row || !column) return;
                    const key = `${row.id}-${column.id}`;
                    const newCell = this.data.cells[key];
                    if (newEl && newCell) { this.selectCell(newEl); this.enterEditMode(newEl, newCell, newEl.querySelector('div') as HTMLElement); }
                }, 20);
            } else if ((e.key === 'Enter' && (e.ctrlKey || e.metaKey)) || (e.key === 'Enter' && !e.shiftKey)) {
                e.preventDefault();
                commit();
            }
        });

        ta.addEventListener('blur', () => {
            commit();
        });
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

    /** Keep Obsidian-style [[wikilinks]] in worksheet text connected to vault notes. */
    private synchronizeWikilinkCells(): void {
        const sourcePath = this.plugin?.sceneManager?.activeProject?.filePath ?? '';
        for (const page of this.document.pages) {
            for (const cell of Object.values(page.cells || {})) {
                if (!cell) continue;
                const match = cell.content.match(/\[\[([^\]|#]+)(?:#[^\]|]+)?(?:\|[^\]]+)?\]\]/);
                if (!match) {
                    if (cell.linkedViaWikilink) {
                        cell.linkedSceneId = undefined;
                        cell.linkedViaWikilink = undefined;
                    }
                    continue;
                }
                if (cell.linkedSceneId && !cell.linkedViaWikilink) continue;
                const target = match[1]?.trim();
                if (!target) continue;
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
        try { this.univerHost?.syncMeta(this.document); } catch { /* ignore */ }
        this.scheduleSave();
        this.renderGrid({ forcePush: true });
        this.refreshOpenCellInspector();
    }

    private unlinkCell(cellKey: string): void {
        // Prefer active page; also clear on the page that owns the key when using Univer selection.
        let cleared = false;
        const activeCell = this.data.cells[cellKey];
        if (activeCell) {
            if (activeCell.linkedViaWikilink) {
                activeCell.content = (activeCell.content || '')
                    .replace(/\[\[([^\]|#]+)(?:#[^\]|]+)?(?:\|([^\]]+))?\]\]/g, (_match, target: string, alias?: string) => alias || target);
            }
            activeCell.linkedSceneId = undefined;
            activeCell.linkedViaWikilink = undefined;
            cleared = true;
        }
        if (!cleared) {
            for (const page of this.document.pages) {
                const cell = page.cells[cellKey];
                if (cell) {
                    if (cell.linkedViaWikilink) {
                        cell.content = (cell.content || '')
                            .replace(/\[\[([^\]|#]+)(?:#[^\]|]+)?(?:\|([^\]]+))?\]\]/g, (_match, target: string, alias?: string) => alias || target);
                    }
                    cell.linkedSceneId = undefined;
                    cell.linkedViaWikilink = undefined;
                    cleared = true;
                    break;
                }
            }
        }
        try { this.univerHost?.syncMeta(this.document); } catch { /* ignore */ }
        this.scheduleSave();
        if (!this.univerHost) this.renderGrid();
        this.refreshOpenCellInspector();
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

    // ────────────────────────────────────────────────────
    //  Cell Inspector — shows characters, locations,
    //  tags, and linked scene info for the selected cell(s)
    // ────────────────────────────────────────────────────

    /** Stack compact detail cards for every cell in a multi-cell selection. */
    private showMultiCellInspector(
        items: Array<{ r: number; c: number; key: string; cell: CellData }>,
    ): void {
        if (!this.inspectorEl) return;

        if (this.inspectorComponent) this.inspectorComponent.hide();

        const el = this.inspectorEl;
        el.empty();
        this.openCellInspectorPanel();
        el.addClass('story-line-inspector');

        const header = el.createDiv('inspector-header');
        header.createEl('h3', { text: t('Cell Details ({n})', { n: items.length }) });
        const closeBtn = header.createEl('button', { cls: 'clickable-icon inspector-close', text: '×' });
        closeBtn.addEventListener('click', () => this.hideCellInspector());

        const stack = el.createDiv('pg-multi-cell-stack');
        const scMgr = this.plugin?.sceneManager as SceneManager | undefined;
        const focusR = this.selFocus?.r ?? this.selectedRow;
        const focusC = this.selFocus?.c ?? this.selectedCol;

        for (const item of items) {
            const { r: rowIndex, c: colIndex, key: cellKey } = item;
            const row = this.data.rows[rowIndex];
            const col = this.data.columns[colIndex];
            const getCell = (): CellData => this.data.cells[cellKey] ?? item.cell;

            const card = stack.createDiv('pg-multi-cell-card');
            if (focusR === rowIndex && focusC === colIndex) {
                card.addClass('is-active');
            }

            const title = card.createDiv('pg-multi-cell-card-title');
            title.createSpan({
                text: `${row?.label || t('Row {n}', { n: rowIndex + 1 })} · ${col?.label || t('Col {n}', { n: colIndex + 1 })}`,
            });

            const textSection = card.createDiv('inspector-section');
            textSection.createSpan({ cls: 'inspector-label', text: t('Content:') });
            const textArea = textSection.createEl('textarea', { cls: 'inspector-cell-textarea' });
            textArea.value = getCell().content || '';
            textArea.rows = 4;
            installObsidianMarkdownShortcuts(this.app, textArea);
            textArea.setCssStyles({
                width: '100%',
                resize: 'vertical',
                marginTop: '4px',
                padding: '6px 8px',
                border: '1px solid var(--background-modifier-border)',
                borderRadius: '4px',
                background: 'var(--background-primary)',
                color: 'var(--text-normal)',
                font: 'inherit',
                fontSize: '13px',
            });

            const scanContainer = card.createDiv('inspector-scan-results');
            this.updateCellInspectorScan(scanContainer, getCell());

            let textSaveTimer: number | null = null;
            let mdPreviewTimer: number | null = null;
            const syncCellMarkdownPreview = () => {
                const gridCellEl = this.getCellElement(rowIndex, colIndex);
                const contentDiv = gridCellEl?.querySelector('.plot-grid-cell-content') as HTMLElement | null;
                if (!contentDiv) return;
                void this.renderMarkdownInto(contentDiv, textArea.value || '');
            };
            textArea.addEventListener('input', () => {
                const liveCell = getCell();
                liveCell.content = textArea.value;
                liveCell.manualContent = true;
                if (mdPreviewTimer) window.clearTimeout(mdPreviewTimer);
                mdPreviewTimer = window.setTimeout(syncCellMarkdownPreview, 120);
                if (textSaveTimer) window.clearTimeout(textSaveTimer);
                textSaveTimer = window.setTimeout(() => {
                    this.scheduleSave();
                    this.updateCellInspectorScan(scanContainer, liveCell);
                }, 600);
            });
            textArea.addEventListener('blur', () => {
                if (textSaveTimer) { window.clearTimeout(textSaveTimer); textSaveTimer = null; }
                if (mdPreviewTimer) { window.clearTimeout(mdPreviewTimer); mdPreviewTimer = null; }
                const liveCell = getCell();
                liveCell.content = textArea.value;
                liveCell.manualContent = true;
                syncCellMarkdownPreview();
                this.updateCellInspectorScan(scanContainer, liveCell);
                this.scheduleSave();
            });

            const liveForLink = getCell();
            const linkedScene = (liveForLink.linkedSceneId && scMgr)
                ? scMgr.getScene(liveForLink.linkedSceneId)
                : undefined;
            const isLinkedNote = !!(linkedScene && linkedScene.corkboardNote);

            if (linkedScene) {
                const linkSection = card.createDiv('inspector-section');
                linkSection.createSpan({
                    cls: 'inspector-label',
                    text: isLinkedNote ? t('Linked Note:') : t('Linked Scene:'),
                });
                const sceneLink = linkSection.createEl('a', {
                    cls: 'inspector-scene-link',
                    text: linkedScene.title
                        || linkedScene.filePath.split('/').pop()?.replace(/\.md$/i, '')
                        || 'Untitled',
                });
                sceneLink.setCssStyles({
                    display: 'block',
                    marginTop: '4px',
                    cursor: 'pointer',
                    color: 'var(--text-accent)',
                });
                sceneLink.addEventListener('click', () => {
                    const f = this.app.vault.getAbstractFileByPath(linkedScene.filePath) as TFile | null;
                    if (f) this.app.workspace.getLeaf('tab').openFile(f, { state: { mode: 'source', source: false } });
                });
                const unlinkBtn = linkSection.createEl('button', {
                    text: isLinkedNote ? t('Unlink Note') : t('Unlink Scene'),
                    attr: { type: 'button' },
                });
                unlinkBtn.setCssStyles({ marginTop: '6px' });
                unlinkBtn.addEventListener('click', () => {
                    const c = this.data.cells[cellKey];
                    if (c) c.linkedSceneId = undefined;
                    this.scheduleSave();
                    this.renderGrid();
                    this.refreshSelectionInspector();
                });
            }
        }
    }

    private showCellInspector(rowIndex: number, colIndex: number, cell: CellData): void {
        if (!this.inspectorEl) return;

        // Hide the scene-inspector if it was showing
        if (this.inspectorComponent) this.inspectorComponent.hide();

        const el = this.inspectorEl;
        el.empty();
        this.openCellInspectorPanel();
        el.addClass('story-line-inspector');

        const row = this.data.rows[rowIndex];
        const col = this.data.columns[colIndex];

        // Stable key so we can always resolve the canonical cell in this.data
        const cellKey = `${row?.id}-${col?.id}`;
        const getCell = (): CellData => this.data.cells[cellKey] ?? cell;

        // Resolve linked scene / vault file from live cell data
        const scMgr = this.plugin?.sceneManager as SceneManager | undefined;
        const liveForLink = this.data.cells[cellKey] ?? cell;
        const linkedPath = liveForLink.linkedSceneId;
        const linkedScene = (linkedPath && scMgr) ? scMgr.getScene(linkedPath) : undefined;
        const linkedVaultFile = this.resolveLinkedVaultFile(linkedPath);
        const isLinkedNote = !!(linkedScene && linkedScene.corkboardNote);
        // Any linked path counts — not only NL Notes/Scenes (Research / arbitrary .md too)
        const hasVaultLink = !!linkedPath;

        // ── Header ──
        const header = el.createDiv('inspector-header');
        header.createEl('h3', { text: t('Cell Details') });
        const closeBtn = header.createEl('button', { cls: 'clickable-icon inspector-close', text: '×' });
        closeBtn.addEventListener('click', () => this.hideCellInspector());

        // ── Tab bar (only when a scene/note is linked) ──
        let cellBody: HTMLElement;
        let sceneBody: HTMLElement | null = null;
        let cellInspectorInstance: InspectorComponent | null = null;

        if (linkedScene) {
            const tabBar = el.createDiv('sl-cell-tab-bar');
            const cellTab = tabBar.createDiv({ cls: 'sl-cell-tab sl-cell-tab-active', text: t('Cell') });
            const sceneTab = tabBar.createDiv({
                cls: 'sl-cell-tab',
                text: isLinkedNote ? t('Note') : t('Scene'),
            });

            // Small dot on Scene tab to indicate linked scene
            sceneTab.createSpan({ cls: 'sl-cell-tab-dot' });

            cellBody = el.createDiv('sl-cell-tab-body');
            sceneBody = el.createDiv('sl-cell-tab-body');
            sceneBody.setCssStyles({ display: 'none' });

            const switchTab = (active: 'cell' | 'scene') => {
                if (active === 'cell') {
                    cellTab.addClass('sl-cell-tab-active');
                    sceneTab.removeClass('sl-cell-tab-active');
                    cellBody.setCssStyles({ display: '' });
                    sceneBody!.setCssStyles({ display: 'none' });
                } else {
                    cellTab.removeClass('sl-cell-tab-active');
                    sceneTab.addClass('sl-cell-tab-active');
                    cellBody.setCssStyles({ display: 'none' });
                    sceneBody!.setCssStyles({ display: '' });
                    // Lazy-render scene inspector on first switch
                                    if (!cellInspectorInstance && scMgr && this.plugin) {
                                        cellInspectorInstance = new InspectorComponent(
                                            sceneBody!,
                                            this.plugin,
                                            scMgr,
                                            {
                                                onEdit: (scene) => this.openScene(scene),
                                                onDelete: (scene) => { void this.deleteScene(scene); },
                                                onRefresh: () => {
                                                    this.renderGrid();
                                                    this.refreshOpenCellInspector();
                                                },
                                                onStatusChange: async (scene, status) => {
                                                    await scMgr.updateScene(scene.filePath, { status });
                                                    this.renderGrid();
                                                },
                                            }
                                        );
                                        cellInspectorInstance.show(linkedScene);
                                    }
                }
            };

            cellTab.addEventListener('click', () => switchTab('cell'));
            sceneTab.addEventListener('click', () => switchTab('scene'));
        } else {
            cellBody = el.createDiv('sl-cell-tab-body');
        }

        // ── Cell tab content ──

        // Row / Column label
        const posSection = cellBody.createDiv('inspector-section');
        posSection.createSpan({ cls: 'inspector-label', text: t('Row: ') });
        posSection.createSpan({ text: row?.label || t('Row {n}', { n: rowIndex + 1 }) });
        const colSection = cellBody.createDiv('inspector-section');
        colSection.createSpan({ cls: 'inspector-label', text: t('Column: ') });
        colSection.createSpan({ text: col?.label || t('Col {n}', { n: colIndex + 1 }) });

        // ── Cell text (editable) ──
        const textSection = cellBody.createDiv('inspector-section');
        textSection.createSpan({ cls: 'inspector-label', text: t('Content:') });
        const textArea = textSection.createEl('textarea', { cls: 'inspector-cell-textarea' });
        textArea.value = cell.content || '';
        textArea.rows = 8;
        installObsidianMarkdownShortcuts(this.app, textArea);
        textArea.setCssStyles({
            width: '100%',
            resize: 'vertical',
            marginTop: '4px',
            padding: '6px 8px',
            border: '1px solid var(--background-modifier-border)',
            borderRadius: '4px',
            background: 'var(--background-primary)',
            color: 'var(--text-normal)',
            font: 'inherit',
            fontSize: '13px',
        });

        // ── Scan results container ──
        const scanContainer = cellBody.createDiv('inspector-scan-results');
        this.updateCellInspectorScan(scanContainer, cell);

        let textSaveTimer: number | null = null;
        let mdPreviewTimer: number | null = null;
        const syncCellMarkdownPreview = () => {
            if (this.selectedRow === null || this.selectedCol === null) return;
            const gridCellEl = this.getCellElement(this.selectedRow, this.selectedCol);
            const contentDiv = gridCellEl?.querySelector('.plot-grid-cell-content') as HTMLElement | null;
            if (!contentDiv) return;
            void this.renderMarkdownInto(contentDiv, textArea.value || '');
        };
        textArea.addEventListener('input', () => {
            const liveCell = getCell();
            liveCell.content = textArea.value;
            liveCell.manualContent = true;
            cell.content = textArea.value;
            cell.manualContent = true;
            // Live-preview Markdown in the grid cell (do NOT use textContent — that strips formatting).
            if (mdPreviewTimer) window.clearTimeout(mdPreviewTimer);
            mdPreviewTimer = window.setTimeout(syncCellMarkdownPreview, 120);
            if (textSaveTimer) window.clearTimeout(textSaveTimer);
            textSaveTimer = window.setTimeout(() => {
                this.scheduleSave();
                this.updateCellInspectorScan(scanContainer, liveCell);
            }, 600);
        });
        textArea.addEventListener('blur', () => {
            if (textSaveTimer) { window.clearTimeout(textSaveTimer); textSaveTimer = null; }
            if (mdPreviewTimer) { window.clearTimeout(mdPreviewTimer); mdPreviewTimer = null; }
            const liveCell = getCell();
            liveCell.content = textArea.value;
            liveCell.manualContent = true;
            cell.content = textArea.value;
            cell.manualContent = true;
            syncCellMarkdownPreview();
            this.updateCellInspectorScan(scanContainer, liveCell);
                this.scheduleSave();
        });

        // ── Linked note / scene + actions ──
        const linkSection = cellBody.createDiv('inspector-section');
        const actions = linkSection.createDiv('pg-cell-link-actions');

        const syncTextarea = () => {
            const liveCell = getCell();
            liveCell.content = textArea.value;
            liveCell.manualContent = true;
            return liveCell;
        };

        const makeAccentBtn = (
            parent: HTMLElement,
            label: string,
            title: string,
            onClick: () => void | Promise<void>,
        ) => {
            const btn = parent.createEl('button', {
                cls: 'mod-cta pg-cell-cta-btn',
                text: label,
                attr: { type: 'button', title },
            });
            btn.addEventListener('click', () => { void onClick(); });
            return btn;
        };

        if (linkedScene || hasVaultLink) {
            const treatAsNote = isLinkedNote || !linkedScene;
            linkSection.createSpan({
                cls: 'inspector-label',
                text: treatAsNote ? t('Linked Note:') : t('Linked Scene:'),
            });
            const linkLabel = linkedScene
                ? (linkedScene.title
                    || linkedScene.filePath.split('/').pop()?.replace(/\.md$/i, '')
                    || 'Untitled')
                : (linkedVaultFile?.basename
                    || linkedPath!.split('/').pop()?.replace(/\.md$/i, '')
                    || linkedPath!);
            const sceneLink = linkSection.createEl('a', {
                cls: 'inspector-scene-link',
                text: linkedVaultFile || linkedScene
                    ? linkLabel
                    : `${linkLabel} (${t('Linked file not found')})`,
            });
            sceneLink.setCssStyles({
                display: 'block',
                marginTop: '4px',
                cursor: 'pointer',
                color: 'var(--text-accent)',
            });
            linkSection.appendChild(actions);
            sceneLink.addEventListener('click', () => {
                this.openVaultFile((linkedScene?.filePath || linkedPath) as string);
            });

            const unlinkBtn = actions.createEl('button', {
                text: treatAsNote ? t('Unlink Note') : t('Unlink Scene'),
                attr: {
                    type: 'button',
                    title: treatAsNote
                        ? t('Keep the note file; only remove it from this cell')
                        : t('Keep the scene file; only remove it from this cell'),
                },
            });
            unlinkBtn.addEventListener('click', () => {
                this.unlinkCell(cellKey);
                this.refreshOpenCellInspector();
                if (treatAsNote) new Notice(t('Note unlinked from cell'));
            });
        } else {
            // Unlinked — open the same Markdown editor used by the toolbar.
            const linkRow = actions.createDiv('pg-cell-link-row');
            makeAccentBtn(linkRow, t('Open cell editor'), t('Type [[ to search vault notes'), () => {
                syncTextarea();
                    const c = this.ensureCellInData(this.data.cells[cellKey] ?? cell);
                this.openCellMarkdownEditor(c, { insertWikilink: true });
            });
        }

        // Convert stays available for plain/linked cells (link path is inherited / replaced).
        const convertGroup = actions.createDiv('pg-cell-convert-group');
        makeAccentBtn(
            convertGroup,
            t('Convert to Notes'),
            t('Create a Notes/ file from this cell and link it'),
            async () => {
                const liveCell = syncTextarea();
                if (!this.cellConvertBody(liveCell)) {
                    new Notice(t('Add some content before converting'));
                    textArea.focus();
                    return;
                }
                await this.convertCellToNotes(liveCell);
                this.showCellInspector(rowIndex, colIndex, this.data.cells[cellKey] ?? liveCell);
            },
        );
        makeAccentBtn(
            convertGroup,
            t('Convert to Scene'),
            t('Create a Scenes/ file from this cell and link it'),
            async () => {
                const liveCell = syncTextarea();
                if (!this.cellConvertBody(liveCell)) {
                    new Notice(t('Add some content before converting'));
                    textArea.focus();
                    return;
                }
                await this.convertCellToScene(liveCell);
                this.showCellInspector(rowIndex, colIndex, this.data.cells[cellKey] ?? liveCell);
            },
        );
        makeAccentBtn(
            convertGroup,
            t('Convert to Research'),
            t('Create a Research/ file from this cell and link it'),
            async () => {
                const liveCell = syncTextarea();
                if (!this.cellConvertBody(liveCell)) {
                    new Notice(t('Add some content before converting'));
                    textArea.focus();
                    return;
                }
                await this.convertCellToResearch(liveCell);
                this.showCellInspector(rowIndex, colIndex, this.data.cells[cellKey] ?? liveCell);
            },
        );
    }

    /**
     * Scan cell content for characters, locations, and #tags,
     * then render the results into the given container element.
     */
    private updateCellInspectorScan(container: HTMLElement, cell: CellData): void {
        container.empty();

        const text = cell.content || '';
        if (!text.trim()) return;

        const scanner = this.plugin?.linkScanner as LinkScanner | undefined;
        if (!scanner) return;

        const result = scanner.scanText(text);

        // ── Characters found ──
        if (result.characters.length > 0) {
            const section = container.createDiv('inspector-section');
            section.createSpan({ cls: 'inspector-label', text: t('Characters:') });
            const chipList = section.createDiv('inspector-chip-list');
            chipList.setCssStyles({
                display: 'flex',
                flexWrap: 'wrap',
                gap: '4px',
                marginTop: '4px',
            });
            // Deduplicate via alias map
            const aliasMap = (this.plugin?.characterManager as CharacterManager | undefined)
                ?.buildAliasMap(this.plugin?.settings.characterAliases) ?? new Map<string, string>();
            const seen = new Set<string>();
            for (const name of result.characters) {
                const canonical = aliasMap.get(name.toLowerCase()) || name;
                const key = canonical.toLowerCase();
                if (seen.has(key)) continue;
                seen.add(key);
                const chip = chipList.createSpan({ cls: 'inspector-chip', text: canonical });
                chip.setCssStyles({
                    padding: '2px 10px',
                    borderRadius: '10px',
                    fontSize: '12px',
                    background: 'var(--background-modifier-border)',
                    cursor: 'pointer',
                    color: 'var(--text-normal)',
                });
                chip.addEventListener('click', () => {
                    // Try to open the character file
                    const charMgr = this.plugin?.characterManager as CharacterManager | undefined;
                    const char = charMgr?.getAllCharacters().find(c => c.name.toLowerCase() === key);
                    if (char) {
                        const f = this.app.vault.getAbstractFileByPath(char.filePath) as TFile | null;
                        if (f) this.app.workspace.getLeaf('tab').openFile(f, { state: { mode: 'source', source: false } });
                    }
                });
            }
        }

        // ── Locations found ──
        if (result.locations.length > 0) {
            const section = container.createDiv('inspector-section');
            section.createSpan({ cls: 'inspector-label', text: t('Locations:') });
            const chipList = section.createDiv('inspector-chip-list');
            chipList.setCssStyles({
                display: 'flex',
                flexWrap: 'wrap',
                gap: '4px',
                marginTop: '4px',
            });
            // Deduplicate locations
            const seen = new Set<string>();
            for (const name of result.locations) {
                const key = name.toLowerCase();
                if (seen.has(key)) continue;
                seen.add(key);
                const chip = chipList.createSpan({ cls: 'inspector-chip', text: name });
                chip.setCssStyles({
                    padding: '2px 10px',
                    borderRadius: '10px',
                    fontSize: '12px',
                    background: 'var(--background-modifier-border)',
                    color: 'var(--text-normal)',
                });
            }
        }

        // ── Tags found ──
        if (result.tags.length > 0) {
            const section = container.createDiv('inspector-section');
            section.createSpan({ cls: 'inspector-label', text: t('Tags:') });
            const tagList = section.createDiv('inspector-tag-list');
            tagList.setCssStyles({
                display: 'flex',
                flexWrap: 'wrap',
                gap: '4px',
                marginTop: '4px',
            });
            const tagColors = this.plugin?.settings.tagColors || {};
            const scheme = this.plugin?.settings.colorScheme || 'mocha';
            const allTagsSorted = [...result.tags].sort();
            for (const tag of result.tags) {
                const chip = tagList.createSpan({ cls: 'inspector-tag-chip', text: `#${tag}` });
                chip.setCssStyles({
                    padding: '2px 8px',
                    borderRadius: '10px',
                    fontSize: '12px',
                });
                const chipColor = resolveTagColor(tag, allTagsSorted.indexOf(tag), scheme, tagColors, getPlotlineHSL(this.plugin!.settings));
                chip.setCssStyles({
                    background: chipColor,
                    color: contrastTextColor(chipColor),
                });
            }
        }
    }

    /** Show the docked inspector beside the grid (flex row, not overlay). */
    private openCellInspectorPanel(): void {
        if (!this.inspectorEl) return;
        this.inspectorEl.setCssStyles({ display: 'flex' });
        this.wrapperEl?.addClass('is-inspector-open');
    }

    private hideCellInspector(): void {
        if (this.inspectorEl) {
            this.inspectorEl.empty();
            this.inspectorEl.setCssStyles({ display: 'none' });
        }
        this.wrapperEl?.removeClass('is-inspector-open');
    }
}

export default PlotgridView;
/* eslint-enable @typescript-eslint/no-floating-promises, @typescript-eslint/no-misused-promises, @typescript-eslint/no-unnecessary-type-assertion, @typescript-eslint/no-unused-vars -- end of file-wide suppression block opened at line 1 */
