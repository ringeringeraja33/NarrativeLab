/* eslint-disable @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-argument, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-floating-promises, @typescript-eslint/no-misused-promises, @typescript-eslint/no-unnecessary-type-assertion, @typescript-eslint/no-redundant-type-constituents, @typescript-eslint/no-unused-vars -- Obsidian's API surface and several untyped third-party libraries force dynamic dispatch; floating promises are intentional in DOM/event handlers; matching enable at end of file */
import { App, ItemView, WorkspaceLeaf, Menu, Modal, TFile, Notice, MarkdownRenderer, Component } from 'obsidian';
import * as obsidian from 'obsidian';
import {
    CellData,
    ColumnMeta,
    RowMeta,
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
import { loadPlotGridUniverModule, type PlotGridUniverHost } from '../utils/loadPlotGridUniver';
import { conceptGridContentFingerprint } from '../services/PlotGridXlsxCodec';
import { LocationManager } from '../services/LocationManager';
import type { SceneFilter, SortConfig } from '../models/Scene';
import { SceneManager } from '../services/SceneManager';
import { CharacterManager } from '../services/CharacterManager';
import { coerceString } from '../utils/narrow';
import { InspectorComponent } from '../components/Inspector';
import { openManageSnapshotsModal } from '../components/ViewSnapshotModal';
import { LinkScanner } from '../services/LinkScanner';
import { renderViewSwitcher } from '../components/ViewSwitcher';
import { FiltersComponent } from '../components/Filters';
import { enableDragToPan } from '../components/DragToPan';
import { isMobile } from '../components/MobileAdapter';
import { PLOTGRID_VIEW_TYPE } from '../constants';
import { resolveTagColor, getPlotlineHSL, resolveStickyNoteColors, contrastTextColor } from '../settings';
import { compareActChapter, getActDisplayLabel } from '../utils/actChapter';
import { attachTooltip } from '../components/Tooltip';
import type SceneCardsPlugin from '../main';
import { Scene, getStatusOrder, resolveStatusCfg } from '../models/Scene';
import { openConfirmModal } from '../components/ConfirmModal';

// Use the shared view-type constant from `constants.ts` so the ViewSwitcher
// can correctly detect and style the active tab.
// (Local legacy constant removed.)

// Basic Plot Grid implementation (ground-up) following the supplied guide.
// This file implements the core model, rendering, editing, and persistence.

const ROW_HEADER_WIDTH = 120;
const COL_HEADER_HEIGHT = 40;

function makeId(prefix = '') {
    return prefix + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 8);
}

export class PlotgridView extends ItemView {
    plugin: SceneCardsPlugin | undefined;
    /** Full multi-page document persisted to plotgrid.json */
    // eslint-disable-next-line obsidianmd/prefer-active-doc -- Concept Grid data model, not the browser Document.
    document: ConceptGridDocument = createEmptyConceptGridDocument();
    /** Active page working set (same object reference as the page in `document`). */
    data: PlotGridData = this.document.pages[0];
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
    private filtersComponent: FiltersComponent | null = null;
    private currentFilter: SceneFilter = {};
    private currentSort: SortConfig = { field: 'sequence', direction: 'asc' };
    /** Simple undo stack for plot grid cell operations (active page only) */
    private undoStack: PlotGridData[] = [];
    private static readonly MAX_UNDO = 20;

    /** Prefer embedded Univer Sheets; fall back to legacy DOM grid on load failure. */
    private preferUniver = true;
    private univerHost: PlotGridUniverHost | null = null;
    private univerMountPromise: Promise<void> | null = null;
    private univerLoadFailed = false;
    private univerContextMenuBound = false;
    private lastUniverSel: { sheetId: string; row: number; col: number } | null = null;
    /** System/ folder the in-memory document was loaded from — used to block cross-project saves. */
    private loadedSystemFolder: string | null = null;
    private dragToPanCleanup: (() => void) | null = null;

    constructor(leaf: WorkspaceLeaf, plugin?: SceneCardsPlugin) {
        super(leaf);
        this.plugin = plugin;
    }

    getViewType(): string {
        return PLOTGRID_VIEW_TYPE;
    }

    getDisplayText(): string {
        const title = this.plugin?.sceneManager?.activeProject?.title;
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
        await this.loadData();

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
                this.renderGrid();
                this.refreshOpenCellInspector();
            }
        }));
    }

    /** Tear down Univer so the next render remounts the correct project workbook. */
    private disposeUniverHost(): void {
        this.lastUniverSel = null;
        try {
            this.univerHost?.flush();
        } catch { /* ignore */ }
        // Invalidate in-flight mounts only after flush so onDocumentChange still applies.
        this.univerMountGeneration += 1;
        try {
            this.univerHost?.dispose();
        } catch { /* ignore */ }
        this.univerHost = null;
        this.univerMountPromise = null;
        this.univerStructureSig = '';
        this.resetCanvasLayoutForLegacy();
    }

    async onClose(): Promise<void> {
        try {
            this.dragToPanCleanup?.();
        } catch { /* ignore */ }
        this.dragToPanCleanup = null;

        // Commit Univer edits, then persist to the folder this view was bound to.
        const folder = this.loadedSystemFolder;
        try {
            this.univerHost?.flush();
        } catch { /* ignore */ }
        this.cancelPendingSave();
        if (folder && this.plugin && typeof this.plugin.savePlotGrid === 'function') {
            const current = this.getActiveSystemFolder();
            if (!current || current === folder) {
                try {
                    await this.plugin.savePlotGrid(this.document);
                } catch { /* ignore */ }
            }
        }
        this.disposeUniverHost();
        this.loadedSystemFolder = null;
    }

    private getActiveSystemFolder(): string {
        try {
            return this.plugin?.getProjectSystemFolder?.() ?? '';
        } catch {
            return '';
        }
    }

    /** Undo Univer absolute/fill styles so the legacy DOM grid can lay out again. */
    private resetCanvasLayoutForLegacy(): void {
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
            const folder = this.getActiveSystemFolder();
            const projectChanged = this.loadedSystemFolder != null
                && folder.length > 0
                && this.loadedSystemFolder !== folder;
            if (projectChanged) {
                // Never flush the previous project's pending autosave into the new System/ folder.
                this.cancelPendingSave();
                this.univerLoadFailed = false;
                this.disposeUniverHost();
                this.hideCellInspector();
                this.undoStack = [];
            }

            let loaded: ConceptGridDocument | null = null;
            if (this.plugin && typeof this.plugin.loadPlotGrid === 'function') {
                loaded = await this.plugin.loadPlotGrid();
            } else {
                loaded = null;
            }
            this.document = loaded
                ? normalizeConceptGridDocument(loaded)
                : createEmptyConceptGridDocument();
            this.bindActivePage();
            this.loadedSystemFolder = folder || this.loadedSystemFolder;
            // Auto-repair broken linkedSceneId paths (e.g. after project migration)
            this.repairLinkedScenePaths();
            // Strip legacy auto-sync markers ("✓", "★ POV", "POV: …") that
            // older builds wrote into cell.content. The pill row inside each
            // cell now carries that information instead, so the marker text
            // would just show up twice and clutter the top of the cell.
            this.stripLegacyAutoMarkers();
        } catch (e) {
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
        // Capture the System/ folder this in-memory document belongs to.
        const folderAtSchedule = this.loadedSystemFolder || this.getActiveSystemFolder();
        if (this.saveDebounce) window.clearTimeout(this.saveDebounce);
        // debounce and call plugin-level save API if available
        const timerId = window.setTimeout(async () => {
            try {
                const currentFolder = this.getActiveSystemFolder();
                if (folderAtSchedule && currentFolder && folderAtSchedule !== currentFolder) {
                    // Active project changed — do not write the previous workbook into the new folder.
                    return;
                }
                if (typeof plugin.savePlotGrid === 'function') await plugin.savePlotGrid(this.document);
                plugin.viewSnapshotService.scheduleAutoSave();
            } catch (e) {
                // ignore save errors
            }
            // Only clear if no newer timer was set during the async save
            if (this.saveDebounce === timerId) this.saveDebounce = null;
        }, 500);
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
        this.data = page;
        this.scheduleSave();
        this.renderGrid();
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

        // Filter bar (shared component, same as Board/Timeline)
        const filterContainer = this.wrapperEl.createDiv('story-line-filters-container');
        const filterSceneMgr = this.plugin?.sceneManager as SceneManager | undefined;
        if (filterSceneMgr && this.plugin) {
            this.filtersComponent = new FiltersComponent(
                filterContainer,
                filterSceneMgr,
                (filter, sort) => {
                    this.currentFilter = filter;
                    if (sort) this.currentSort = sort;
                    this.renderGrid();
                },
                this.plugin,
                {
                    showSort: false,
                    // Concept Grid cells are freeform — not necessarily scenes.
                    searchPlaceholder: t('Search grid…'),
                    filterLabel: t('Filter'),
                    filterTooltip: t('Filter rows by linked scene (act, chapter, status, and more)'),
                },
            );
            this.filtersComponent.render();
        }

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
        // Drag-to-pan is for the legacy DOM grid only — Univer owns its own scroll/selection.
        if (!this.preferUniver) {
            this.dragToPanCleanup = enableDragToPan(this.scrollAreaEl);
        }

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

        this.document.pages.forEach((page, index) => {
            const isActive = page.id === this.document.activePageId;
            const tab = list.createEl('button', {
                cls: `concept-grid-page-tab${isActive ? ' is-active' : ''}`,
                attr: {
                    type: 'button',
                    'aria-pressed': String(isActive),
                    title: page.title,
                },
            });
            tab.createSpan({
                cls: 'concept-grid-page-tab-label',
                text: page.title || `${t('Page')} ${index + 1}`,
            });

            tab.addEventListener('click', () => {
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
        this.document.activePageId = pageId;
        this.bindActivePage();
        this.undoStack = [];
        this.clearSelection();
        this.hideCellInspector();
        this.scheduleSave();
        this.renderPageSidebar();
        this.renderToolbar();
        this.renderGrid();
    }

    private createPage(): void {
        const page = createEmptyConceptGridPage(t('Page {n}', { n: this.document.pages.length + 1 }));
        this.document.pages.push(page);
        this.switchPage(page.id);
    }

    private duplicatePage(pageId: string): void {
        const source = this.document.pages.find(p => p.id === pageId);
        if (!source) return;
        const copy = cloneConceptGridPage(source, `${source.title} ${t('copy')}`);
        const index = this.document.pages.findIndex(p => p.id === pageId);
        this.document.pages.splice(index + 1, 0, copy);
        this.switchPage(copy.id);
    }

    private renamePage(pageId: string): void {
        const page = this.document.pages.find(p => p.id === pageId);
        if (!page) return;
        const modal = new Modal(this.app);
        modal.titleEl.setText(t('Rename page'));
        const inp = modal.contentEl.createEl('input', { type: 'text', cls: 'plot-grid-rename-input' });
        inp.setCssStyles({ width: '100%' });
        inp.value = page.title;
        const commit = () => {
            const next = inp.value.trim();
            if (next) page.title = next;
            this.scheduleSave();
            this.renderPageSidebar();
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
                const index = this.document.pages.findIndex(p => p.id === pageId);
                if (index < 0) return;
                this.document.pages.splice(index, 1);
                if (this.document.activePageId === pageId) {
                    const next = this.document.pages[Math.max(0, index - 1)] || this.document.pages[0];
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

        // Sync from Scenes button
        const syncBtn = left.createEl('button', { cls: 'clickable-icon' });
        obsidian.setIcon(syncBtn, 'refresh-cw');
        attachTooltip(syncBtn, t('Sync from Scenes'));
        syncBtn.addEventListener('click', () => { this.openSyncModal(); });

        // Cell → Markdown note actions (Univer selection / legacy active cell)
        const linkNoteBtn = left.createEl('button', { cls: 'clickable-icon' });
        obsidian.setIcon(linkNoteBtn, 'link');
        attachTooltip(linkNoteBtn, t('Link Note…'));
        linkNoteBtn.addEventListener('click', () => { this.linkNoteForActiveCell(); });

        const openNoteBtn = left.createEl('button', { cls: 'clickable-icon' });
        obsidian.setIcon(openNoteBtn, 'file-text');
        attachTooltip(openNoteBtn, t('Open Note'));
        openNoteBtn.addEventListener('click', () => { this.openNoteForActiveCell(); });

        const unlinkNoteBtn = left.createEl('button', { cls: 'clickable-icon' });
        obsidian.setIcon(unlinkNoteBtn, 'unlink');
        attachTooltip(unlinkNoteBtn, t('Unlink Note'));
        unlinkNoteBtn.addEventListener('click', () => { this.unlinkNoteForActiveCell(); });

        // Separator between Sync and Add Row/Column
        const syncSep = left.createDiv();
        syncSep.setCssStyles({
            width: '1px',
            height: '18px',
            background: 'var(--background-modifier-border)',
            margin: '0 4px',
        });

        // Add Row / Add Column buttons
        const addRowBtn = left.createEl('button', { cls: 'clickable-icon' });
        obsidian.setIcon(addRowBtn, 'rows-3');
        attachTooltip(addRowBtn, t('Add Row'));
        addRowBtn.addEventListener('click', () => { this.addRow(); });

        const addColBtn = left.createEl('button', { cls: 'clickable-icon' });
        obsidian.setIcon(addColBtn, 'columns-3');
        attachTooltip(addColBtn, t('Add Column'));
        addColBtn.addEventListener('click', () => { this.addColumn(); });

        // Sticky headers toggle — pin row/col labels while scrolling the grid
        const stickyLabel = this.data.stickyHeaders !== false
            ? t('Disable sticky headers')
            : t('Enable sticky headers');
        const stickyBtn = left.createEl('button', { cls: 'clickable-icon' });
        obsidian.setIcon(stickyBtn, this.data.stickyHeaders !== false ? 'pin' : 'pin-off');
        attachTooltip(stickyBtn, stickyLabel);
        stickyBtn.addEventListener('click', () => {
            this.data.stickyHeaders = !(this.data.stickyHeaders !== false);
            this.scheduleSave();
            this.renderToolbar();
            this.renderGrid();
        });

        const fitCellsBtn = left.createEl('button', { cls: 'clickable-icon' });
        obsidian.setIcon(fitCellsBtn, 'scan');
        attachTooltip(fitCellsBtn, t('Fit row heights to content'));
        fitCellsBtn.addEventListener('click', () => { void this.autosizeCellsToContent(); });

        // Auto-Note toggle
        if (this.plugin) {
            const autoNoteLabel = this.plugin.settings.plotgridAutoNote
                ? t('Auto-Note: On')
                : t('Auto-Note: Off');
            const autoNoteBtn = left.createEl('button', {
                cls: `clickable-icon ${this.plugin.settings.plotgridAutoNote ? 'is-active' : ''}`,
            });
            obsidian.setIcon(autoNoteBtn, 'sticky-note');
            attachTooltip(autoNoteBtn, autoNoteLabel);
            if (this.plugin.settings.plotgridAutoNote) {
                autoNoteBtn.setCssStyles({ color: 'var(--interactive-accent)' });
            }
            autoNoteBtn.addEventListener('click', async () => {
                this.plugin!.settings.plotgridAutoNote = !this.plugin!.settings.plotgridAutoNote;
                await this.plugin!.saveSettings();
                this.renderToolbar();
            });
        }

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

        // ── View Snapshots ──
        const snapManage = actions.createDiv({ cls: 'clickable-icon' });
        obsidian.setIcon(snapManage, 'history');
        attachTooltip(snapManage, t('Manage View Snapshots'));
        snapManage.addEventListener('click', () => {
            if (this.plugin) openManageSnapshotsModal(this.plugin.app, this.plugin.viewSnapshotService);
        });

        actions.appendChild(zoomOut);
        actions.appendChild(zoomLabel);
        actions.appendChild(zoomIn);
        actions.appendChild(resetZoomBtn);
        actions.appendChild(snapManage);

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
        if (this.canvasEl && this.scrollAreaEl) {
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

    private async autosizeCellsToContent(): Promise<void> {
        if (!this.canvasEl || this.data.rows.length === 0 || this.data.columns.length === 0) return;

        await this.waitForPlotGridLayout();

        const minRowHeight = 40;
        const maxRowHeight = 900;

        let changed = false;
        for (let pass = 0; pass < 4; pass++) {
            if (!this.canvasEl) break;

            const requiredRowHeights = new Map<number, number>();

            const cellElements: HTMLElement[] = Array.from(
                this.canvasEl.querySelectorAll<HTMLElement>('.plot-grid-cell[data-row][data-col]'),
            );
            for (const cellEl of cellElements) {
                const rowIndex = Number(cellEl.dataset.row);
                if (!Number.isInteger(rowIndex)) continue;
                if (!this.data.rows[rowIndex]) continue;

                const requiredHeight = Math.min(maxRowHeight, Math.max(minRowHeight, this.measureCellHeight(cellEl)));
                requiredRowHeights.set(rowIndex, Math.max(requiredRowHeights.get(rowIndex) ?? minRowHeight, requiredHeight));
            }

            let passChanged = false;
            for (const [rowIndex, requiredHeight] of requiredRowHeights) {
                const nextHeight = Math.round(requiredHeight);
                if (this.data.rows[rowIndex].height !== nextHeight) {
                    this.data.rows[rowIndex].height = nextHeight;
                    passChanged = true;
                }
            }

            if (!passChanged) break;
            changed = true;
            this.renderGrid();
            await this.waitForPlotGridLayout();
        }

        if (!changed) {
            new Notice(t('Plot Grid row heights already fit their content'));
            return;
        }

        this.scheduleSave();
        new Notice(t('Plot Grid row heights resized to fit content'));
    }

    private async waitForPlotGridLayout(): Promise<void> {
        await new Promise<void>((resolve) => {
            window.requestAnimationFrame(() => window.requestAnimationFrame(() => resolve()));
        });
    }

    private measureCellHeight(cellEl: HTMLElement): number {
        let requiredHeight = cellEl.scrollHeight + 2;
        const descendants = Array.from(cellEl.querySelectorAll<HTMLElement>('*'));
        for (const descendant of descendants) {
            if (descendant.scrollHeight > descendant.clientHeight) {
                requiredHeight = Math.max(requiredHeight, cellEl.offsetHeight + descendant.scrollHeight - descendant.clientHeight + 2);
            }
        }
        return requiredHeight;
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

    private renderGrid() {
        if (!this.canvasEl || !this.scrollAreaEl) return;

        this.ensureDefaults();

        // Univer Sheets path (canonical UI). Only remount/push when page structure changes.
        if (this.preferUniver && !this.univerLoadFailed) {
            const sig = this.getUniverStructureSig();
            const push = !!this.univerHost && sig !== this.univerStructureSig;
            void this.ensureUniverHost({ pushDocument: push }).then(() => {
                if (this.univerHost) {
                    this.univerStructureSig = this.getUniverStructureSig();
                    // Page tab switch: activate sheet without remount.
                    try {
                        this.univerHost.setActiveSheet(this.document.activePageId);
                    } catch { /* ignore */ }
                }
            });
            return;
        }

        this.renderLegacyDomGrid();
    }

    private async ensureUniverHost(options: { pushDocument?: boolean } = {}): Promise<void> {
        if (!this.canvasEl || !this.plugin) return;
        if (this.univerLoadFailed) {
            this.renderLegacyDomGrid();
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
                this.dragToPanCleanup?.();
                this.dragToPanCleanup = null;

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
                    document: this.document,
                    locale,
                    getAuthoritativeDocument: () => this.document,
                    onDocumentChange: (doc) => {
                        if (mountGen !== this.univerMountGeneration) return;
                        this.document = normalizeConceptGridDocument(doc);
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
                this.bindUniverContextMenu();
                // Let layout settle, then nudge Univer to measure the filled host.
                window.requestAnimationFrame(() => {
                    window.dispatchEvent(new Event('resize'));
                });
            } catch (e) {
                if (mountGen !== this.univerMountGeneration) return;
                console.error('[NarrativeLab] Univer Plot Grid failed; falling back to DOM grid', e);
                this.univerLoadFailed = true;
                this.univerHost = null;
                this.resetCanvasLayoutForLegacy();
                this.renderLegacyDomGrid();
            } finally {
                if (mountGen === this.univerMountGeneration) {
                    this.univerMountPromise = null;
                }
            }
        })();

        await this.univerMountPromise;
    }

    private bindUniverContextMenu(): void {
        if (this.univerContextMenuBound || !this.canvasEl) return;
        this.univerContextMenuBound = true;
        this.registerDomEvent(this.canvasEl, 'contextmenu', (evt: MouseEvent) => {
            if (!this.univerHost) return;
            const cell = this.getActiveDataCellFromUniver();
            if (!cell) return;
            evt.preventDefault();
            evt.stopPropagation();
            const menu = new Menu();
            menu.addItem(item => item.setTitle(t('Link Note…')).setIcon('link').onClick(() => {
                this.openNoteLinkModal((path) => this.linkFileToCell(cell, path));
            }));
            if (cell.linkedSceneId) {
                const path = cell.linkedSceneId;
                menu.addItem(item => item.setTitle(t('Open Note')).setIcon('file-text').onClick(() => {
                    this.openVaultFile(path);
                }));
                menu.addItem(item => item.setTitle(t('Unlink Note')).setIcon('unlink').onClick(() => {
                    this.unlinkCell(cell.id);
                }));
            }
            menu.showAtMouseEvent(evt);
        });
    }

    /** Map Univer sheet coords (including header row/col at 0) → data CellData. */
    private getActiveDataCellFromUniver(): CellData | null {
        const sel = this.lastUniverSel || this.univerHost?.getActiveCell() || null;
        if (!sel) return null;
        if (sel.row <= 0 || sel.col <= 0) return null;
        // Never fall back to the active page — unknown sheetId after project switch
        // would mutate the wrong grid at the same coordinates.
        const page = this.document.pages.find(p => p.id === sel.sheetId);
        if (!page) return null;
        const row = page.rows[sel.row - 1];
        const col = page.columns[sel.col - 1];
        if (!row || !col) return null;
        const key = `${row.id}-${col.id}`;
        if (!page.cells[key]) {
            page.cells[key] = {
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
        if (page.id === this.document.activePageId) this.data = page;
        return page.cells[key];
    }

    private linkNoteForActiveCell(): void {
        const cell = this.univerHost
            ? this.getActiveDataCellFromUniver()
            : (this.selectedRow != null && this.selectedCol != null
                ? this.data.cells[`${this.data.rows[this.selectedRow]?.id}-${this.data.columns[this.selectedCol]?.id}`]
                : null);
        if (!cell) {
            new Notice(t('Select a cell first'));
            return;
        }
        this.openNoteLinkModal((path) => this.linkFileToCell(cell, path));
    }

    private openNoteForActiveCell(): void {
        const cell = this.univerHost
            ? this.getActiveDataCellFromUniver()
            : (this.selectedRow != null && this.selectedCol != null
                ? this.data.cells[`${this.data.rows[this.selectedRow]?.id}-${this.data.columns[this.selectedCol]?.id}`]
                : null);
        if (!cell?.linkedSceneId) {
            new Notice(t('No linked note'));
            return;
        }
        this.openVaultFile(cell.linkedSceneId);
    }

    private unlinkNoteForActiveCell(): void {
        const cell = this.univerHost
            ? this.getActiveDataCellFromUniver()
            : (this.selectedRow != null && this.selectedCol != null
                ? this.data.cells[`${this.data.rows[this.selectedRow]?.id}-${this.data.columns[this.selectedCol]?.id}`]
                : null);
        if (!cell?.linkedSceneId) {
            new Notice(t('No linked note'));
            return;
        }
        this.unlinkCell(cell.id);
    }

    private renderLegacyDomGrid() {
        if (!this.canvasEl || !this.scrollAreaEl) return;

        // Preserve scroll position across re-renders so the view doesn't jump
        const prevScrollTop = this.scrollAreaEl.scrollTop;
        const prevScrollLeft = this.scrollAreaEl.scrollLeft;

        this.ensureDefaults();
        this.canvasEl.empty();

        let colTemplate = [ROW_HEADER_WIDTH + 'px', ...this.data.columns.map((c) => c.width + 'px')].join(' ');

        // ── Determine which rows are visible (filter support) ──
        // Also build a sort-order index if the user changed the sort dropdown
        const sceneManager = this.plugin?.sceneManager as SceneManager | undefined;
        const activeProject = sceneManager?.activeProject;
        const hasFilter = this.currentFilter && Object.keys(this.currentFilter).some(
            k => { const v = (this.currentFilter as unknown as Record<string, unknown>)[k]; return v !== undefined && v !== '' && !(Array.isArray(v) && v.length === 0); }
        );
        let filteredPaths: Set<string> | null = null;
        if (hasFilter && sceneManager) {
            filteredPaths = new Set(
                sceneManager.queryService.getFilteredScenes(this.currentFilter, undefined).map(s => s.filePath)
            );
        }

        // Build a row display order based on current sort field
        const rowIndices = this.data.rows.map((_, i) => i);
        if (sceneManager && this.currentSort) {
            const field = this.currentSort.field;
            const dir = this.currentSort.direction === 'desc' ? -1 : 1;
            // Issue #76 \u2014 reading-order fields use the shared act \u2192 chapter
            // \u2192 sequence comparator (string-aware so non-numeric acts/chapters
            // like "Prologue" or "1.1" sort correctly). Other fields fall
            // back to the previous generic comparator.
            const isReadingOrder = field === 'sequence' || field === 'chapter' || field === 'act';
            rowIndices.sort((ai, bi) => {
                const rowA = this.data.rows[ai];
                const rowB = this.data.rows[bi];
                const sceneA = rowA.sourceId ? sceneManager.getScene(rowA.sourceId) : null;
                const sceneB = rowB.sourceId ? sceneManager.getScene(rowB.sourceId) : null;
                if (!sceneA && !sceneB) return 0;
                if (!sceneA) return 1;
                if (!sceneB) return -1;
                if (isReadingOrder) {
                    let cmp = compareActChapter(sceneA.act, sceneB.act);
                    if (cmp === 0 && (field === 'sequence' || field === 'chapter')) {
                        cmp = compareActChapter(sceneA.chapter, sceneB.chapter);
                    }
                    if (cmp === 0 && field === 'sequence') {
                        cmp = (sceneA.sequence ?? 9999) - (sceneB.sequence ?? 9999);
                    }
                    return cmp * dir;
                }
                const valA = (sceneA as unknown as Record<string, unknown>)[field];
                const valB = (sceneB as unknown as Record<string, unknown>)[field];
                if (valA == null && valB == null) return 0;
                if (valA == null) return 1;
                if (valB == null) return -1;
                if (typeof valA === 'number' && typeof valB === 'number') return (valA - valB) * dir;
                return coerceString(valA).localeCompare(coerceString(valB)) * dir;
            });
        }

        const visibleRows = new Set<number>();
        for (const ri of rowIndices) {
            const row = this.data.rows[ri];
            if (!filteredPaths) { visibleRows.add(ri); continue; }
            // Manual rows always visible
            if (!row.sourceId || row.sourceType !== 'auto') { visibleRows.add(ri); continue; }
            if (filteredPaths.has(row.sourceId)) visibleRows.add(ri);
        }

        // ── Build act/chapter divider positions (visible rows only) ──
        const dividersBefore = new Map<number, Array<{type: 'act'|'chapter', label: string}>>();
        {
            let prevAct: string | number | undefined;
            let prevChapter: string | number | undefined;
            for (const ri of rowIndices) {
                if (!visibleRows.has(ri)) continue;
                const row = this.data.rows[ri];
                if (row.sourceType !== 'auto' || !row.sourceId || !sceneManager) continue;
                const scene = sceneManager.getScene(row.sourceId);
                if (!scene) continue;
                const dividers: Array<{type: 'act'|'chapter', label: string}> = [];
                if (scene.act !== undefined && String(scene.act) !== String(prevAct)) {
                    const actNum = typeof scene.act === 'number' ? scene.act : parseInt(String(scene.act), 10);
                    const actLabels = (activeProject as unknown as { actLabels?: Record<number, string> })?.actLabels;
                    const rawActLabel = !isNaN(actNum) ? (actLabels?.[actNum] || '') : '';
                    const cleanActLabel = rawActLabel.replace(/^(Act|Prologue|Epilogue)\s*\d*\s*[—:]\s*/i, '');
                    const actDisplay = getActDisplayLabel(scene.act);
                    dividers.push({ type: 'act', label: cleanActLabel ? `${actDisplay}: ${cleanActLabel}` : actDisplay });
                    prevChapter = undefined;
                }
                if (scene.chapter !== undefined && String(scene.chapter) !== String(prevChapter)) {
                    const chNum = typeof scene.chapter === 'number' ? scene.chapter : parseInt(String(scene.chapter), 10);
                    const chapterLabels = (activeProject as unknown as { chapterLabels?: Record<number, string> })?.chapterLabels;
                    const rawChLabel = !isNaN(chNum) ? (chapterLabels?.[chNum] || '') : '';
                    const cleanChLabel = rawChLabel.replace(/^Ch(?:apter)?\s*\d+\s*[—:]\s*/i, '');
                    dividers.push({ type: 'chapter', label: cleanChLabel ? `Ch ${scene.chapter}: ${cleanChLabel}` : `Chapter ${scene.chapter}` });
                }
                if (dividers.length > 0) dividersBefore.set(ri, dividers);
                prevAct = scene.act;
                prevChapter = scene.chapter;
            }
        }

        // Build row template including divider rows (visible only)
        const rowHeightParts: string[] = [];
        for (const ri of rowIndices) {
            if (!visibleRows.has(ri)) continue;
            const divs = dividersBefore.get(ri);
            if (divs) for (const d of divs) rowHeightParts.push(d.type === 'act' ? '32px' : '26px');
            rowHeightParts.push(this.data.rows[ri].height + 'px');
        }
        let rowTemplate = [COL_HEADER_HEIGHT + 'px', ...rowHeightParts].join(' ');

        // If there are no columns/rows yet, use flexible templates so the empty-state message
        // can span the full available width instead of being constrained to the single header column.
        if (this.data.columns.length === 0) colTemplate = '1fr';
        if (this.data.rows.length === 0) rowTemplate = '1fr';

        this.canvasEl.setCssStyles({
            display: 'grid',
            gridTemplateColumns: colTemplate,
            gridTemplateRows: rowTemplate,
        });
        // If there are no columns, allow the canvas to stretch to the container width.
        if (this.data.columns.length === 0) this.canvasEl.setCssStyles({ width: '100%' });
        else this.canvasEl.setCssStyles({ width: this.computeTotalWidth() + 'px' });

        const corner = this.canvasEl.createDiv('plot-grid-corner');
        corner.setAttr('data-type', 'corner');
        corner.setCssStyles({
            position: (this.data.stickyHeaders === false) ? 'relative' : 'sticky',
            top: '0',
            left: '0',
            zIndex: '11',
            background: 'var(--background-modifier-hover)',
            border: '1px solid var(--sl-border-subtle)',
        });

        // corner context menu (Reset grid moved here)
        corner.addEventListener('contextmenu', (evt) => {
            evt.preventDefault();
            const menu = new Menu();
            menu.addItem((it) => it.setTitle(t('Reset Grid')).onClick(() => {
                class ConfirmModal extends Modal {
                    onConfirm: () => void;
                    constructor(app: App, onConfirm: () => void) { super(app); this.onConfirm = onConfirm; }
                    onOpen() {
                        const { contentEl } = this;
                        contentEl.createEl('h3', { text: t('Reset Grid') });
                        contentEl.createEl('p', { text: t('Are you sure you want to reset the Grid? Resetting will delete everything.') });
                        const btns = contentEl.createDiv();
                        const ok = btns.createEl('button', { text: t('Reset') });
                        ok.addEventListener('click', () => { this.onConfirm(); this.close(); });
                        const cancel = btns.createEl('button', { text: t('Cancel') });
                        cancel.addEventListener('click', () => this.close());
                    }
                }
                const modal = new ConfirmModal(this.app, () => {
                    // Cancel any in-flight debounced save BEFORE clearing the
                    // grid. Otherwise the pending save (holding the pre-reset
                    // state) fires after the reset and resurrects the grid —
                    // the "grid disappears then reappears on its own" bug.
                    if (this.saveDebounce) {
                        window.clearTimeout(this.saveDebounce);
                        this.saveDebounce = null;
                    }
                    // Mutate the active page inside `document` — that is what save serializes.
                    const page = this.getActivePage();
                    page.rows = [];
                    page.columns = [];
                    page.cells = {};
                    page.zoom = 1;
                    this.data = page;
                    this.univerStructureSig = '';
                    try { this.univerHost?.syncMeta(this.document); } catch { /* ignore */ }
                    void this.plugin?.savePlotGrid?.(this.document, { allowEmptyOverwrite: true });
                    this.renderGrid();
                });
                modal.open();
            }));
            menu.showAtMouseEvent(evt);
        });

        for (let ci = 0; ci < this.data.columns.length; ci++) {
            const col = this.data.columns[ci];
            const el = this.canvasEl.createDiv('plot-grid-col-header');
            el.setCssStyles({
                position: (this.data.stickyHeaders === false) ? 'relative' : 'sticky',
                top: '0',
                zIndex: '10',
                background: col.headerBgColor || col.bgColor || 'var(--background-secondary)',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                border: '1px solid var(--sl-border-subtle)',
                userSelect: 'none',
            });
            el.textContent = col.label;
            if (col.textColor) el.setCssStyles({ color: col.textColor });
            else { const _bg = col.headerBgColor || col.bgColor; if (_bg && _bg.startsWith('#')) el.setCssStyles({ color: contrastTextColor(_bg) }); }
            if (col.bold) el.setCssStyles({ fontWeight: '600' });
            if (col.italic) el.setCssStyles({ fontStyle: 'italic' });

            // Double-click (or F2 / type after selecting the header) renames the column.
            el.addEventListener('dblclick', (ev) => {
                ev.preventDefault();
                ev.stopPropagation();
                this.selectColumnHeader(ci, false, { focusWrapper: false });
                this.beginHeaderLabelEdit('col', ci);
            });

            // Click selects whole column (Shift extends). Ctrl/Cmd+click opens synced entity.
            el.addEventListener('click', (ev) => {
                ev.stopPropagation();
                if (el.hasClass('plot-grid-header-editing')) return;
                if (col.sourceType === 'auto' && col.sourceId && col.sourceKind !== 'tags' && (ev.ctrlKey || ev.metaKey)) {
                    this.navigateToColumnEntity(col);
                    return;
                }
                this.selectColumnHeader(ci, ev.shiftKey);
            });
            if (col.sourceType === 'auto' && col.sourceKind && col.sourceKind !== 'tags') {
                el.title = t('{label} (Ctrl/Cmd+click to open)', { label: col.label });
                el.setCssStyles({ cursor: 'pointer' });
            }

            // enable drag-to-reorder for columns
            el.draggable = true;
            el.addEventListener('dragstart', (ev) => {
                ev.dataTransfer?.setData('text/plain', `col:${ci}`);
            });
            el.addEventListener('dragover', (ev) => { ev.preventDefault(); });
            el.addEventListener('drop', (ev) => {
                ev.preventDefault();
                const data = ev.dataTransfer?.getData('text/plain');
                if (!data) return;
                const [type, idxStr] = data.split(':');
                const srcIdx = Number(idxStr);
                if (type === 'col' && !Number.isNaN(srcIdx) && srcIdx !== ci) {
                    this.moveColumn(srcIdx, ci);
                }
            });

            // resize handle for column
            const colHandle = el.createDiv('plot-col-resize-handle');
            colHandle.setCssStyles({
                position: 'absolute',
                right: '0',
                top: '0',
                bottom: '0',
                width: '6px',
                cursor: 'col-resize',
            });
            colHandle.draggable = false;
            colHandle.addEventListener('mousedown', (ev) => { ev.stopPropagation(); this.startColResize(ev as MouseEvent, ci); });

            // column header context menu
            el.addEventListener('contextmenu', (evt) => {
                evt.preventDefault();
                const menu = new Menu();
                menu.addItem((item) => item.setTitle(t('Rename Column')).onClick(() => {
                    const modal = new Modal(this.app);
                    modal.titleEl.setText(t('Rename Column'));
                    const inp = modal.contentEl.createEl('input', { type: 'text', cls: 'plot-grid-rename-input' });
                    inp.setCssStyles({ width: '100%' });
                    inp.value = col.label;
                    const commitRename = () => {
                        const liveCol = this.data.columns[ci];
                        if (liveCol) liveCol.label = inp.value || liveCol.label;
                        this.scheduleSave(); this.renderGrid(); modal.close();
                    };
                    inp.addEventListener('keydown', (ke) => { if (ke.key === 'Enter') commitRename(); });
                    const btn = modal.contentEl.createEl('button', { text: t('OK'), cls: 'mod-cta' });
                    btn.setCssStyles({ marginTop: '8px' });
                    btn.addEventListener('click', () => commitRename());
                    modal.open();
                    inp.focus();
                    inp.select();
                }));
                menu.addItem((item) => item.setTitle(this.data.stickyHeaders !== false ? t('Disable sticky headers') : t('Enable sticky headers')).onClick(() => { this.data.stickyHeaders = !(this.data.stickyHeaders !== false); this.scheduleSave(); this.renderToolbar(); this.renderGrid(); }));
                menu.addItem((item) => item.setTitle(t('Set Column Colour…')).onClick(() => {
                    const header = this.canvasEl?.querySelectorAll('.plot-grid-col-header')[ci] as HTMLElement | undefined;
                    const els: HTMLElement[] = [];
                    for (let ri = 0; ri < this.data.rows.length; ri++) { const e = this.getCellElement(ri, ci); if (e) els.push(e); }
                    const prevs = els.map(e => e.style.background);
                    const prevHeaderBg = header ? header.style.background : null;
                    this.chooseColor(this.data.columns[ci].bgColor || this.defaultBgColor(), (c) => { if (c === null) { els.forEach((e,i) => e.setCssStyles({ background: prevs[i] })); if (header && prevHeaderBg !== null) header.setCssStyles({ background: prevHeaderBg }); return; } this.data.columns[ci].bgColor = c || ''; this.scheduleSave(); this.renderGrid(); for (let ri=0; ri<this.data.rows.length; ri++) this.flashElement(this.getCellElement(ri, ci)); }, (preview) => { if (preview === null) { els.forEach((e,i) => e.setCssStyles({ background: prevs[i] })); if (header && prevHeaderBg !== null) header.setCssStyles({ background: prevHeaderBg }); } else { els.forEach(e => e.setCssStyles({ background: preview })); if (header) header.setCssStyles({ background: preview }); } });
                }));
                menu.addItem((item) => item.setTitle(t('Set Header Colour…')).onClick(() => {
                    const header = this.canvasEl?.querySelectorAll('.plot-grid-col-header')[ci] as HTMLElement | undefined;
                    const prevHeaderBg = header ? header.style.background : null;
                    this.chooseColor(this.data.columns[ci].headerBgColor || this.data.columns[ci].bgColor || this.defaultBgColor(), (c) => {
                        if (c === null) { if (header && prevHeaderBg !== null) header.setCssStyles({ background: prevHeaderBg }); return; }
                        this.data.columns[ci].headerBgColor = c || '';
                        this.scheduleSave(); this.renderGrid();
                        if (header) this.flashElement(header);
                    }, (preview) => {
                        if (preview === null) { if (header && prevHeaderBg !== null) header.setCssStyles({ background: prevHeaderBg }); }
                        else { if (header) header.setCssStyles({ background: preview }); }
                    });
                }));
                menu.addSeparator();
                menu.addItem((item) => item.setTitle(t('Insert Column Left')).onClick(() => this.insertColumnAt(ci, true)));
                menu.addItem((item) => item.setTitle(t('Insert Column Right')).onClick(() => this.insertColumnAt(ci, false)));
                menu.addSeparator();
                menu.addItem((item) => {
                    const selectedCols = this.getSelectedColumnIndices();
                    const colsToDelete = selectedCols.includes(ci) && selectedCols.length > 1
                        ? selectedCols
                        : [ci];
                    const n = colsToDelete.length;
                    item.setTitle(n > 1 ? t('Delete Columns ({n})', { n }) : t('Delete Column'))
                        .onClick(() => this.confirmDeleteColumns(colsToDelete));
                });
                menu.showAtMouseEvent(evt);
            });
        }

        for (const ri of rowIndices) {
            if (!visibleRows.has(ri)) continue; // skip filtered-out rows
            // ── Act/chapter dividers ──
            const divs = dividersBefore.get(ri);
            if (divs) {
                const colCount = this.data.columns.length + 1;
                for (const d of divs) {
                    const divEl = this.canvasEl.createDiv(`plot-grid-divider plot-grid-divider-${d.type}`);
                    divEl.setCssStyles({
                        gridColumn: `1 / ${colCount + 1}`,
                        position: (this.data.stickyHeaders === false) ? 'relative' : 'sticky',
                        left: '0',
                        zIndex: '8',
                    });
                    const icon = divEl.createSpan('plot-grid-divider-icon');
                    obsidian.setIcon(icon, d.type === 'act' ? 'bookmark' : 'hash');
                    divEl.createSpan({ text: d.label, cls: 'plot-grid-divider-label' });
                }
            }

            const row = this.data.rows[ri];
            const rowEl = this.canvasEl.createDiv('plot-grid-row-header');
            rowEl.setCssStyles({
                position: (this.data.stickyHeaders === false) ? 'relative' : 'sticky',
                left: '0',
                zIndex: '9',
                background: row.headerBgColor || row.bgColor || 'var(--background-secondary)',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                border: '1px solid var(--sl-border-subtle)',
                userSelect: 'none',
            });
            rowEl.textContent = row.label;
            if (row.textColor) rowEl.setCssStyles({ color: row.textColor });
            else { const _bg = row.headerBgColor || row.bgColor; if (_bg && _bg.startsWith('#')) rowEl.setCssStyles({ color: contrastTextColor(_bg) }); }
            if (row.bold) rowEl.setCssStyles({ fontWeight: '600' });
            if (row.italic) rowEl.setCssStyles({ fontStyle: 'italic' });

            // Status color indicator on left border
            if (row.sourceType === 'auto' && row.sourceId && sceneManager) {
                const rowScene = sceneManager.getScene(row.sourceId);
                if (rowScene) {
                    const statusCfg = resolveStatusCfg(rowScene.status || 'idea');
                    rowEl.setCssStyles({ borderLeft: `4px solid ${statusCfg.color}` });
                }
            }

            // Double-click (or F2 / type after selecting the header) renames the row.
            let clickTimer: number | null = null;
            rowEl.addEventListener('dblclick', (ev) => {
                ev.preventDefault();
                ev.stopPropagation();
                if (clickTimer) { window.clearTimeout(clickTimer); clickTimer = null; }
                this.selectRowHeader(ri, false, { focusWrapper: false });
                this.beginHeaderLabelEdit('row', ri);
            });

            // Click selects whole row (Shift extends). Ctrl/Cmd+click opens synced scene.
            // Delay open so double-click (edit label) doesn't also open the file.
            rowEl.addEventListener('click', (ev) => {
                ev.stopPropagation();
                if (rowEl.hasClass('plot-grid-header-editing')) return;
                if (row.sourceType === 'auto' && row.sourceId && (ev.ctrlKey || ev.metaKey)) {
                    if (clickTimer) window.clearTimeout(clickTimer);
                    clickTimer = window.setTimeout(() => {
                        clickTimer = null;
                        const file = this.app.vault.getAbstractFileByPath(row.sourceId!) as TFile | null;
                        if (file) this.app.workspace.getLeaf('tab').openFile(file, { state: { mode: 'source', source: false } });
                    }, 250);
                    return;
                }
                this.selectRowHeader(ri, ev.shiftKey);
            });
            if (row.sourceType === 'auto' && row.sourceId) {
                rowEl.title = t('{label} (Ctrl/Cmd+click to open)', { label: row.label });
                rowEl.setCssStyles({ cursor: 'pointer' });
            }

            // enable drag-to-reorder for rows
            rowEl.draggable = true;
            rowEl.addEventListener('dragstart', (ev) => {
                ev.dataTransfer?.setData('text/plain', `row:${ri}`);
            });
            rowEl.addEventListener('dragover', (ev) => { ev.preventDefault(); });
            rowEl.addEventListener('drop', (ev) => {
                ev.preventDefault();
                const data = ev.dataTransfer?.getData('text/plain');
                if (!data) return;
                const [type, idxStr] = data.split(':');
                const srcIdx = Number(idxStr);
                if (type === 'row' && !Number.isNaN(srcIdx) && srcIdx !== ri) {
                    this.moveRow(srcIdx, ri);
                }
            });

            // resize handle for row
            const rowHandle = rowEl.createDiv('plot-row-resize-handle');
            rowHandle.setCssStyles({
                position: 'absolute',
                left: '0',
                right: '0',
                bottom: '0',
                height: '6px',
                cursor: 'row-resize',
            });
            rowHandle.draggable = false;
            rowHandle.addEventListener('mousedown', (ev) => { ev.stopPropagation(); this.startRowResize(ev as MouseEvent, ri); });

            // row header context menu
            rowEl.addEventListener('contextmenu', (evt) => {
                evt.preventDefault();
                const menu = new Menu();
                menu.addItem((item) => item.setTitle(t('Rename Row')).onClick(() => {
                    const modal = new Modal(this.app);
                    modal.titleEl.setText(t('Rename Row'));
                    const inp = modal.contentEl.createEl('input', { type: 'text', cls: 'plot-grid-rename-input' });
                    inp.setCssStyles({ width: '100%' });
                    inp.value = row.label;
                    const commitRename = () => {
                        const liveRow = this.data.rows[ri];
                        if (liveRow) liveRow.label = inp.value || liveRow.label;
                        this.scheduleSave(); this.renderGrid(); modal.close();
                    };
                    inp.addEventListener('keydown', (ke) => { if (ke.key === 'Enter') commitRename(); });
                    const btn = modal.contentEl.createEl('button', { text: t('OK'), cls: 'mod-cta' });
                    btn.setCssStyles({ marginTop: '8px' });
                    btn.addEventListener('click', () => commitRename());
                    modal.open();
                    inp.focus();
                    inp.select();
                }));
                menu.addItem((item) => item.setTitle(this.data.stickyHeaders !== false ? t('Disable sticky headers') : t('Enable sticky headers')).onClick(() => { this.data.stickyHeaders = !(this.data.stickyHeaders !== false); this.scheduleSave(); this.renderToolbar(); this.renderGrid(); }));
                menu.addItem((item) => item.setTitle(t('Set Row Colour…')).onClick(() => {
                    const els: HTMLElement[] = [];
                    for (let ci = 0; ci < this.data.columns.length; ci++) { const e = this.getCellElement(ri, ci); if (e) els.push(e); }
                    const prevs = els.map(e => e.style.background);
                    const header = this.canvasEl?.querySelectorAll('.plot-grid-row-header')[ri] as HTMLElement | undefined;
                    const prevHeaderBg = header ? header.style.background : null;
                    this.chooseColor(this.data.rows[ri].bgColor || this.defaultBgColor(), (c) => { if (c === null) { els.forEach((e,i) => e.setCssStyles({ background: prevs[i] })); if (header && prevHeaderBg !== null) header.setCssStyles({ background: prevHeaderBg }); return; } this.data.rows[ri].bgColor = c || ''; this.scheduleSave(); this.renderGrid(); for (let ci=0; ci<this.data.columns.length; ci++) this.flashElement(this.getCellElement(ri, ci)); }, (preview) => { if (preview === null) { els.forEach((e,i) => e.setCssStyles({ background: prevs[i] })); if (header && prevHeaderBg !== null) header.setCssStyles({ background: prevHeaderBg }); } else { els.forEach(e => e.setCssStyles({ background: preview })); if (header) header.setCssStyles({ background: preview }); } });
                }));
                menu.addItem((item) => item.setTitle(t('Set Header Colour…')).onClick(() => {
                    const header = this.canvasEl?.querySelectorAll('.plot-grid-row-header')[ri] as HTMLElement | undefined;
                    const prevHeaderBg = header ? header.style.background : null;
                    this.chooseColor(this.data.rows[ri].headerBgColor || this.data.rows[ri].bgColor || this.defaultBgColor(), (c) => {
                        if (c === null) { if (header && prevHeaderBg !== null) header.setCssStyles({ background: prevHeaderBg }); return; }
                        this.data.rows[ri].headerBgColor = c || '';
                        this.scheduleSave(); this.renderGrid();
                        if (header) this.flashElement(header);
                    }, (preview) => {
                        if (preview === null) { if (header && prevHeaderBg !== null) header.setCssStyles({ background: prevHeaderBg }); }
                        else { if (header) header.setCssStyles({ background: preview }); }
                    });
                }));
                menu.addSeparator();
                menu.addItem((item) => item.setTitle(t('Insert Row Above')).onClick(() => this.insertRowAt(ri, true)));
                menu.addItem((item) => item.setTitle(t('Insert Row Below')).onClick(() => this.insertRowAt(ri, false)));
                menu.addSeparator();
                menu.addItem((item) => {
                    const selectedRows = this.getSelectedRowIndices();
                    const rowsToDelete = selectedRows.includes(ri) && selectedRows.length > 1
                        ? selectedRows
                        : [ri];
                    const n = rowsToDelete.length;
                    item.setTitle(n > 1 ? t('Delete Rows ({n})', { n }) : t('Delete Row'))
                        .onClick(() => this.confirmDeleteRows(rowsToDelete));
                });
                menu.showAtMouseEvent(evt);
            });

            for (let ci = 0; ci < this.data.columns.length; ci++) {
                const col = this.data.columns[ci];
                const key = `${row.id}-${col.id}`;
                let cell = this.data.cells[key];
                if (!cell) {
                    cell = {
                            id: key,
                            content: '',
                            bgColor: '',
                            textColor: '',
                            bold: false,
                            italic: false,
                            align: 'center',
                        };
                    this.data.cells[key] = cell;
                }
                // ensure older cells have an align value
                if (!cell.align) cell.align = 'center';

                const cellEl = this.canvasEl.createDiv('plot-grid-cell');
                // expose coordinates
                cellEl.setAttr('data-row', String(ri));
                cellEl.setAttr('data-col', String(ci));
                cellEl.setCssStyles({
                    minHeight: row.height + 'px',
                    border: '1px solid var(--sl-grid-border)',
                    padding: '6px 8px',
                    boxSizing: 'border-box',
                    whiteSpace: 'pre-wrap',
                    overflow: 'hidden',
                    cursor: 'default',
                    display: 'flex',
                    flexDirection: 'column',
                    justifyContent: 'center',
                });

                const bg = cell.bgColor || row.bgColor || col.bgColor || '';
                if (bg) {
                    cellEl.setCssStyles({ background: bg });
                    // Auto-contrast text when no explicit textColor is set
                    if (!cell.textColor && bg.startsWith('#')) {
                        cellEl.setCssStyles({ color: contrastTextColor(bg) });
                    }
                }
                if (cell.textColor) cellEl.setCssStyles({ color: cell.textColor });
                if (cell.bold) cellEl.setCssStyles({ fontWeight: '600' });
                if (cell.italic) cellEl.setCssStyles({ fontStyle: 'italic' });
                cellEl.setCssStyles({ textAlign: cell.align });

                const contentEl = cellEl.createDiv({ cls: 'plot-grid-cell-content markdown-rendered' });
                contentEl.setCssStyles({ flex: '1 1 auto' });
                if (cell.content) {
                    void this.renderMarkdownInto(contentEl, cell.content);
                }

                // Plain-text cells are not HTML5-draggable — left-drag is range select.
                // Linked note/scene cards remain draggable from their own handles below.

                // linked scene: render mini card or badge
                if (cell.linkedSceneId) {
                    const scMgr = this.plugin?.sceneManager as SceneManager | undefined;
                    const scene = scMgr?.getScene(cell.linkedSceneId) as Scene | undefined;
                    if (scene) {
                        // Check if this is a corkboard note
                        const isCorkboardNote = (scene as Scene & { corkboardNote?: unknown }).corkboardNote === true;

                        if (isCorkboardNote) {
                            // Default: no fill (border only). Tint only when a color was set via right-click.
                            const noteColor = this.normalizeHexColor(
                                (scene as unknown as Record<string, unknown>).corkboardNoteColor as string | undefined,
                            );
                            cellEl.addClass('pg-cell-note');
                            if (noteColor) {
                                cellEl.addClass('pg-cell-note-tinted');
                                cellEl.setCssStyles({
                                    background: noteColor,
                                    color: contrastTextColor(noteColor),
                                });
                            }

                            // Hide standard content div — replace with note body
                            contentEl.setCssStyles({ display: 'none' });

                            // "Note" label + optional origin so it's visually distinct from plain cell text
                            const noteLabel = cellEl.createDiv('pg-cell-note-label');
                            const noteIcon = noteLabel.createSpan({ cls: 'pg-cell-note-icon' });
                            obsidian.setIcon(noteIcon, 'sticky-note');
                            if (scene.plotgridOrigin) {
                                noteLabel.createSpan({ text: scene.plotgridOrigin });
                            } else {
                                noteLabel.createSpan({ text: t('Note') });
                            }

                            // Render note content directly in the cell
                            const noteBody = cellEl.createDiv('pg-cell-note-body markdown-rendered');
                            if (scene.body && scene.body.trim()) {
                                const noteComp = new Component(); noteComp.load();
                                void MarkdownRenderer.render(this.app, scene.body.trim(), noteBody, scene.filePath, noteComp);
                            }

                            // Drag from note chrome only so cell left-drag can still range-select
                            for (const handle of [noteLabel, noteBody]) {
                                handle.draggable = true;
                                handle.setCssStyles({ cursor: 'grab' });
                                handle.addEventListener('dragstart', (ev) => {
                                    ev.dataTransfer?.setData('text/scene-path', scene.filePath);
                                    ev.dataTransfer?.setData('text/cell-source', key);
                                    cellEl.addClass('dragging');
                                });
                                handle.addEventListener('dragend', () => {
                                    cellEl.removeClass('dragging');
                                });
                            }
                        } else {
                        // Render mini scene card inside the cell
                        const miniCard = cellEl.createDiv('plot-grid-mini-card');

                        // Status icon + title row
                        const titleRow = miniCard.createDiv('pg-mini-title-row');
                        const statusCfg = resolveStatusCfg(scene.status || 'idea');
                        const statusIcon = titleRow.createSpan({ cls: 'pg-mini-status-icon' });
                        obsidian.setIcon(statusIcon, statusCfg.icon);
                        statusIcon.title = t(statusCfg.label);
                        titleRow.createSpan({ cls: 'pg-mini-title', text: scene.title || t('Untitled') });

                        // Meta row: description snippet
                        const metaRow = miniCard.createDiv('pg-mini-meta markdown-rendered');
                        if (scene.body && scene.body.trim()) {
                            const snippet = scene.body.trim().length > 120
                                ? scene.body.trim().substring(0, 120) + '…'
                                : scene.body.trim();
                            const metaComp = new Component(); metaComp.load();
                            void MarkdownRenderer.render(this.app, snippet, metaRow, scene.filePath, metaComp);
                        } else if (scene.conflict) {
                            const metaComp = new Component(); metaComp.load();
                            void MarkdownRenderer.render(this.app, scene.conflict, metaRow, scene.filePath, metaComp);
                        }

                        // Keep cell content visible above the scene preview if there's text
                        if (cell.content) {
                            contentEl.setCssStyles({
                                order: '-1',
                                marginBottom: '4px',
                                fontSize: '11px',
                                color: cell.textColor || 'var(--text-normal)',
                            });
                        } else {
                            contentEl.setCssStyles({ display: 'none' });
                        }

                        // Make the mini card draggable so it can be moved between cells
                        miniCard.draggable = true;
                        miniCard.addEventListener('dragstart', (ev) => {
                            ev.dataTransfer?.setData('text/scene-path', scene.filePath);
                            ev.dataTransfer?.setData('text/cell-source', key);
                            miniCard.addClass('dragging');
                        });
                        miniCard.addEventListener('dragend', () => {
                            miniCard.removeClass('dragging');
                        });
                        } // end else (regular scene mini-card)
                    } else {
                        const vaultFile = this.resolveLinkedVaultFile(cell.linkedSceneId);
                        if (vaultFile) {
                            // Linked vault file that is not an NL scene/note (e.g. Research)
                            const badge = cellEl.createDiv('plot-grid-linked-badge');
                            badge.textContent = '🔗';
                            badge.title = cell.linkedSceneId;
                            badge.setCssStyles({
                                position: 'absolute',
                                top: '4px',
                                right: '6px',
                                cursor: 'pointer',
                            });
                            badge.addEventListener('click', (ev) => {
                                ev.stopPropagation();
                                this.openVaultFile(cell.linkedSceneId as string);
                            });
                            const sub = cellEl.createDiv('plot-grid-linked-subtitle');
                            sub.textContent = vaultFile.basename;
                            sub.setCssStyles({
                                fontSize: '11px',
                                color: 'var(--text-muted)',
                            });
                        } else {
                            // File deleted — stay plain-text; keep linkedSceneId for inheritance
                            cellEl.addClass('pg-cell-link-missing');
                            cellEl.title = `${t('Linked file not found')}: ${cell.linkedSceneId}`;
                        }
                    }
                }

                // ── Codex entity tags ──────────────────────────
                if (this.plugin?.linkScanner) {
                    const seenLower = new Set<string>();
                    const mentions: { name: string; type: string }[] = [];

                    const addMentions = (result: { links: Array<{ name: string; type: string }> }) => {
                        for (const link of result.links) {
                            if (link.type === 'other') continue;
                            const low = link.name.toLowerCase();
                            if (!seenLower.has(low)) {
                                seenLower.add(low);
                                mentions.push({ name: link.name, type: link.type });
                            }
                        }
                    };

                    // Resolve linked scene up-front so we can inject the
                    // POV character as a dedicated first pill below.
                    const scMgr2 = this.plugin.sceneManager as SceneManager | undefined;
                    const linkedScene = cell.linkedSceneId ? scMgr2?.getScene(cell.linkedSceneId) : undefined;

                    // Scan linked scene body (uses cache)
                    if (linkedScene) addMentions(this.plugin.linkScanner.scan(linkedScene));

                    // Scan cell text
                    if (cell.content?.trim()) {
                        addMentions(this.plugin.linkScanner.scanText(cell.content));
                    }

                    const povName = (linkedScene?.pov || '').trim();

                    // Sort: characters first, then locations, then everything
                    // else, preserving discovery order within each group.
                    const typeRank = (t: string): number => {
                        if (t === 'character') return 0;
                        if (t === 'location') return 1;
                        return 2;
                    };
                    const sortedMentions = mentions
                        .map((m, idx) => ({ m, idx }))
                        .sort((a, b) => {
                            const r = typeRank(a.m.type) - typeRank(b.m.type);
                            return r !== 0 ? r : a.idx - b.idx;
                        })
                        .map(x => x.m);

                    // Pull the POV character (if present) out of the list so we
                    // can render it as the very first pill, with an amber
                    // accent. If the POV isn't in the mention list at all we
                    // still inject it explicitly.
                    let povHandled = false;
                    if (povName) {
                        const povIdx = sortedMentions.findIndex(
                            m => m.type === 'character' && m.name.toLowerCase() === povName.toLowerCase()
                        );
                        if (povIdx >= 0) {
                            sortedMentions.splice(povIdx, 1);
                        }
                        povHandled = true;
                    }

                    if (povHandled || sortedMentions.length > 0) {
                        const tagsEl = cellEl.createDiv('pg-codex-tags');
                        if (povHandled) {
                            const povPill = tagsEl.createSpan({
                                cls: 'pg-codex-tag pg-codex-tag-character pg-codex-tag-pov',
                            });
                            povPill.textContent = t('POV: {name}', { name: povName });
                        }
                        for (const m of sortedMentions) {
                            const pill = tagsEl.createSpan({ cls: `pg-codex-tag pg-codex-tag-${m.type}` });
                            pill.textContent = m.name;
                        }
                    }
                }

                cellEl.addEventListener('dblclick', (ev) => {
                    ev.stopPropagation();
                    this.enterEditMode(cellEl, cell, contentEl);
                });

                // Intercept internal-link clicks before cell-level handlers
                cellEl.addEventListener('click', (ev) => {
                    const target = ev.target as HTMLElement;
                    const link = target.closest('a.internal-link') as HTMLAnchorElement | null;
                    if (link) {
                        ev.preventDefault();
                        ev.stopPropagation();
                        const href = link.getAttribute('data-href') || link.getAttribute('href');
                        if (href) {
                            const sourcePath = cell.linkedSceneId || '';
                            this.app.workspace.openLinkText(href, sourcePath, true);
                        }
                    }
                }, true);

                // Left-drag = rectangular range select (not HTML5 drag)
                cellEl.addEventListener('pointerdown', (ev) => {
                    this.onCellPointerDown(ev as PointerEvent, ri, ci);
                });

                // context menu for cell (batch-aware when a rectangle is selected)
                cellEl.addEventListener('contextmenu', (evt) => {
                    evt.preventDefault();
                    this.ensureSelectionIncludes(ri, ci);
                    const selCount = this.countSelectedCells();
                    const multi = selCount > 1;
                    const menu = new Menu();
                    const scMgr = this.plugin?.sceneManager as SceneManager | undefined;
                    const linkedScene = cell.linkedSceneId ? scMgr?.getScene(cell.linkedSceneId) : undefined;

                    if (multi) {
                        // ── Batch actions for the whole selection ──
                        menu.addItem((it) => it
                            .setTitle(t('Edit Cells ({n})…', { n: selCount }))
                            .setIcon('pencil')
                            .onClick(() => this.openFillSelectionModal(cell.content || '')));
                        menu.addItem((it) => it
                            .setTitle(t('Clear Cell Content ({n})', { n: selCount }))
                            .setIcon('eraser')
                            .onClick(() => this.clearSelectionContents()));
                        menu.addSeparator();
                        menu.addItem((it) => it
                            .setTitle(t('Link Note ({n})…', { n: selCount }))
                            .setIcon('link')
                            .onClick(() => {
                                this.openNoteLinkModal((path) => {
                                    this.pushPlotGridUndo();
                                    let linked = 0;
                                    this.forEachSelectedCell((_r, _c, _key, c) => {
                                        if (c.linkedSceneId) return;
                                        c.linkedSceneId = path;
                                        linked++;
                                    });
                                    this.scheduleSave();
                                    this.renderGrid();
                                    this.refreshSelectionInspector();
                                    new Notice(t('Linked {n} cells', { n: linked }));
                                });
                            }));
                        if (scMgr) {
                            menu.addItem((it) => it
                                .setTitle(t('Convert to Notes ({n})', { n: selCount }))
                                .setIcon('sticky-note')
                                .onClick(async () => { await this.convertSelectedCells('notes'); }));
                            menu.addItem((it) => it
                                .setTitle(t('Convert to Scene ({n})', { n: selCount }))
                                .setIcon('file-text')
                                .onClick(async () => { await this.convertSelectedCells('scene'); }));
                            menu.addItem((it) => it
                                .setTitle(t('Convert to Research ({n})', { n: selCount }))
                                .setIcon('book-open')
                                .onClick(async () => { await this.convertSelectedCells('research'); }));
                        }
                        menu.addSeparator();
                        menu.addItem((it) => it
                            .setTitle(t('Unlink ({n})', { n: selCount }))
                            .setIcon('unlink')
                            .onClick(() => {
                                this.pushPlotGridUndo();
                                let n = 0;
                                this.forEachSelectedCell((_r, _c, _key, c) => {
                                    if (!c.linkedSceneId) return;
                                    c.linkedSceneId = undefined;
                                    n++;
                                });
                                this.scheduleSave();
                                this.renderGrid();
                                this.refreshSelectionInspector();
                                new Notice(t('Unlinked {n} cells', { n }));
                            }));
                    } else if (linkedScene && linkedScene.corkboardNote) {
                        // ── Corkboard Note actions ──
                        const note = linkedScene;
                        const notePresets = resolveStickyNoteColors(this.plugin!.settings);
                        notePresets.forEach((preset) => {
                            menu.addItem(item => item
                                .setTitle(t('Color: {label}', { label: preset.label }))
                                .setIcon('palette')
                                .onClick(() => { void this.setNoteColor(note, preset.color, key); }));
                        });
                        menu.addItem(item => item
                            .setTitle(t('Color: Custom…'))
                            .setIcon('pipette')
                            .onClick(() => { this.openNoteColorModal(linkedScene, key); }));
                        menu.addItem(item => item
                            .setTitle(t('Color: None'))
                            .setIcon('rotate-ccw')
                            .onClick(() => { void this.setNoteColor(linkedScene, undefined, key); }));

                        menu.addSeparator();
                        menu.addItem((it) => it.setTitle(t('Duplicate Note')).setIcon('copy').onClick(async () => {
                            await scMgr?.duplicateScene(linkedScene.filePath);
                            this.renderGrid();
                        }));
                        menu.addItem((it) => it.setTitle(t('Delete Note')).setIcon('trash').onClick(async () => {
                            openConfirmModal(this.app, {
                                title: t('Delete Note'),
                                message: `Delete note "${linkedScene.title || 'Note'}"?`,
                                confirmLabel: 'Delete',
                                onConfirm: async () => {
                                    await this.deleteScene(linkedScene);
                                },
                            });
                        }));

                        menu.addSeparator();
                        menu.addItem((it) => it.setTitle(t('Convert to Scene')).setIcon('clapperboard').onClick(async () => {
                            const oldPath = linkedScene.filePath;
                            const newPath = await scMgr?.moveNoteToSceneFolder(oldPath);
                            if (!newPath) return;
                            linkedScene.corkboardNote = false;
                            linkedScene.plotgridOrigin = undefined;
                            linkedScene.filePath = newPath;
                            // Update plot grid cell reference if the file moved
                            if (newPath !== oldPath) {
                                const c = this.data.cells[key];
                                if (c) { c.linkedSceneId = newPath; this.scheduleSave(); }
                            }
                            this.renderGrid();
                            this.refreshOpenCellInspector();
                        }));
                        menu.addItem((it) => it.setTitle(t('Edit Cell Text')).onClick(() => this.enterEditMode(cellEl, cell, contentEl)));
                        menu.addItem((it) => it.setTitle(t('Unlink Note')).setIcon('unlink').onClick(() => {
                            this.unlinkCell(key);
                        }));
                    } else if (linkedScene) {
                        // ── Regular Scene actions ──
                        menu.addItem((it) => it.setTitle(t('Open Scene')).setIcon('file-text').onClick(() => this.openScene(linkedScene)));
                        menu.addItem((it) => it.setTitle(t('Show in Inspector')).setIcon('info').onClick(() => {
                            if (this.plugin?.isSceneInspectorOpen()) {
                                this.inspectorComponent?.hide();
                                this.app.workspace.trigger('storyline:scene-focus', linkedScene.filePath);
                            } else {
                                this.inspectorComponent?.show(linkedScene);
                            }
                        }));
                        menu.addSeparator();
                        // Status submenu
                        const statuses = getStatusOrder();
                        statuses.forEach(s => {
                            menu.addItem((it) => it.setTitle(t('Status: {status}', { status: t(resolveStatusCfg(s).label) }))
                                .setChecked(linkedScene.status === s)
                                .onClick(async () => {
                                    await scMgr?.updateScene(linkedScene.filePath, { status: s });
                                    this.renderGrid();
                                }));
                        });
                        menu.addSeparator();
                        menu.addItem((it) => it.setTitle(t('Duplicate Scene')).setIcon('copy').onClick(async () => {
                            await scMgr?.duplicateScene(linkedScene.filePath);
                            this.renderGrid();
                        }));
                        menu.addItem((it) => it.setTitle(t('Edit Cell Text')).onClick(() => this.enterEditMode(cellEl, cell, contentEl)));
                        menu.addItem((it) => it.setTitle(t('Unlink Scene')).setIcon('unlink').onClick(() => {
                            this.unlinkCell(key);
                        }));
                        menu.addItem((it) => it.setTitle(t('Delete Scene')).setIcon('trash').onClick(async () => {
                            openConfirmModal(this.app, {
                                title: t('Delete Scene'),
                                message: `Delete scene "${linkedScene.title || 'Untitled'}"?`,
                                confirmLabel: 'Delete',
                                onConfirm: async () => {
                                    await this.deleteScene(linkedScene);
                                },
                            });
                        }));
                    } else if (cell.linkedSceneId) {
                        // Linked vault file that is not an NL scene/note (e.g. Research, arbitrary .md),
                        // or a deleted file whose path we still keep on the cell.
                        const linkedFile = this.resolveLinkedVaultFile(cell.linkedSceneId);
                        if (linkedFile) {
                            menu.addItem((it) => it.setTitle(t('Open Note')).setIcon('file-text').onClick(() => {
                                this.openVaultFile(cell.linkedSceneId as string);
                            }));
                        } else {
                            menu.addItem((it) => it.setTitle(t('Linked file not found')).setDisabled(true));
                        }
                        menu.addItem((it) => it.setTitle(t('Edit Cell Text')).onClick(() => this.enterEditMode(cellEl, cell, contentEl)));
                        menu.addSeparator();
                        if (scMgr) {
                            menu.addItem((it) => it.setTitle(t('Convert to Notes')).setIcon('sticky-note').onClick(async () => {
                                await this.convertCellToNotes(this.data.cells[key] ?? cell);
                            }));
                            menu.addItem((it) => it.setTitle(t('Convert to Scene')).setIcon('file-text').onClick(async () => {
                                await this.convertCellToScene(this.data.cells[key] ?? cell);
                            }));
                            menu.addItem((it) => it.setTitle(t('Convert to Research')).setIcon('book-open').onClick(async () => {
                                await this.convertCellToResearch(this.data.cells[key] ?? cell);
                            }));
                        }
                        menu.addItem((it) => it.setTitle(t('Unlink Note')).setIcon('unlink').onClick(() => {
                            this.unlinkCell(key);
                        }));
                    } else {
                        // No linked scene — edit + link / convert into project folders
                        menu.addItem((it) => it.setTitle(t('Edit Cell')).onClick(() => this.enterEditMode(cellEl, cell, contentEl)));
                        menu.addSeparator();
                        menu.addItem((it) => it.setTitle(t('Link Note…')).setIcon('link').onClick(() => {
                            this.openNoteLinkModal((path) => {
                                this.linkFileToCell(this.data.cells[key] ?? cell, path);
                            });
                        }));
                        if (scMgr) {
                            menu.addItem((it) => it.setTitle(t('Convert to Notes')).setIcon('sticky-note').onClick(async () => {
                                await this.convertCellToNotes(this.data.cells[key] ?? cell);
                            }));
                            menu.addItem((it) => it.setTitle(t('Convert to Scene')).setIcon('file-text').onClick(async () => {
                                await this.convertCellToScene(this.data.cells[key] ?? cell);
                            }));
                            menu.addItem((it) => it.setTitle(t('Convert to Research')).setIcon('book-open').onClick(async () => {
                                await this.convertCellToResearch(this.data.cells[key] ?? cell);
                            }));
                        }
                        menu.addSeparator();
                        menu.addItem((it) => it.setTitle(t('Clear Cell Content')).onClick(() => {
                            this.clearSelectionContents();
                        }));
                    }

                    // Cell colour — applies to the whole selection
                    menu.addSeparator();
                    menu.addItem((it) => it
                        .setTitle(multi ? t('Set Cell Colour ({n})…', { n: selCount }) : t('Set Cell Colour…'))
                        .setIcon('palette')
                        .onClick(() => this.openCellBgColorPicker(key, cellEl, ri, ci)));
                    menu.addItem((it) => it
                        .setTitle(multi ? t('Set Cell Text Colour ({n})…', { n: selCount }) : t('Set Cell Text Colour…'))
                        .setIcon('type')
                        .onClick(() => this.openCellTextColorPicker(key, cellEl)));
                    menu.addItem((it) => it
                        .setTitle(multi ? t('Clear Cell Colour ({n})', { n: selCount }) : t('Clear Cell Colour'))
                        .setIcon('rotate-ccw')
                        .onClick(() => {
                            this.pushPlotGridUndo();
                            this.forEachSelectedCell((_r, _c, _key, c) => {
                                c.bgColor = '';
                                c.textColor = '';
                            });
                            this.scheduleSave();
                            this.renderGrid();
                        }));

                    menu.addSeparator();
                    menu.addItem((it) => it.setTitle(t('Insert Row Above')).onClick(() => this.insertRowAt(ri, true)));
                    menu.addItem((it) => it.setTitle(t('Insert Row Below')).onClick(() => this.insertRowAt(ri, false)));
                    menu.addItem((it) => it.setTitle(t('Insert Column Left')).onClick(() => this.insertColumnAt(ci, true)));
                    menu.addItem((it) => it.setTitle(t('Insert Column Right')).onClick(() => this.insertColumnAt(ci, false)));
                    menu.addSeparator();
                    {
                        const rowIndices = this.getSelectedRowIndices();
                        const colIndices = this.getSelectedColumnIndices();
                        const rowN = rowIndices.length || 1;
                        const colN = colIndices.length || 1;
                        const rowsToDelete = rowIndices.length ? rowIndices : [ri];
                        const colsToDelete = colIndices.length ? colIndices : [ci];
                        menu.addItem((it) => it
                            .setTitle(rowN > 1 ? t('Delete Rows ({n})', { n: rowN }) : t('Delete Row'))
                            .setIcon('trash')
                            .onClick(() => this.confirmDeleteRows(rowsToDelete)));
                        menu.addItem((it) => it
                            .setTitle(colN > 1 ? t('Delete Columns ({n})', { n: colN }) : t('Delete Column'))
                            .setIcon('trash')
                            .onClick(() => this.confirmDeleteColumns(colsToDelete)));
                    }
                    menu.showAtMouseEvent(evt);
                });

                // Drag-drop: accept scene cards being dragged into cells
                cellEl.addEventListener('dragover', (ev) => {
                    ev.preventDefault();
                    cellEl.addClass('plot-grid-drop-target');
                });
                cellEl.addEventListener('dragleave', () => {
                    cellEl.removeClass('plot-grid-drop-target');
                });
                cellEl.addEventListener('drop', (ev) => {
                    ev.preventDefault();
                    cellEl.removeClass('plot-grid-drop-target');
                    const sourceKey = ev.dataTransfer?.getData('text/cell-source');
                    const scenePath = ev.dataTransfer?.getData('text/scene-path');
                    if (sourceKey && sourceKey !== key) {
                        // Cell-to-cell move: transfer content from source to target
                        const src = this.data.cells[sourceKey];
                        const tgt = this.data.cells[key];
                        if (src && tgt) {
                            const targetHasContent = tgt.linkedSceneId || tgt.content || tgt.manualContent;
                            const doMove = () => {
                                // Snapshot cells for undo before modifying
                                this.pushPlotGridUndo();
                                tgt.linkedSceneId = src.linkedSceneId;
                                tgt.content = src.content;
                                tgt.manualContent = src.manualContent;
                                src.linkedSceneId = undefined;
                                src.content = '';
                                src.manualContent = undefined;
                                this.scheduleSave();
                                this.renderGrid();
                            };
                            if (targetHasContent) {
                                openConfirmModal(this.app, {
                                    title: t('Overwrite Cell'),
                                    message: 'The target cell already has content. Overwrite it?',
                                    confirmLabel: 'Overwrite',
                                    onConfirm: doMove,
                                });
                            } else {
                                doMove();
                            }
                        }
                    } else if (scenePath) {
                        // External scene drop (e.g., from scene list)
                        const c = this.data.cells[key]; if (c) c.linkedSceneId = scenePath;
                        this.scheduleSave();
                        this.renderGrid();
                    }
                });
            }
        }

        this.setZoom(this.data.zoom || 1);

        if (this.data.rows.length === 0 && this.data.columns.length === 0) {
            const msg = this.canvasEl.createDiv('plot-grid-empty');
            msg.setCssStyles({
                position: 'relative',
                width: '100%',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                padding: '24px',
                boxSizing: 'border-box',
                maxWidth: '100%',
                textAlign: 'left',
            });
            msg.textContent = t("Use 'Add Row' and 'Add Column' to begin building your plot grid.");
        }

        // reapply selection visuals after render
        this.applySelectionVisuals();

        // Restore scroll position after DOM rebuild
        window.requestAnimationFrame(() => {
            if (this.scrollAreaEl) {
                this.scrollAreaEl.scrollTop = prevScrollTop;
                this.scrollAreaEl.scrollLeft = prevScrollLeft;
            }
        });
    }
    async refresh(): Promise<void> {
        try {
            const folder = this.getActiveSystemFolder();
            const projectChanged = this.loadedSystemFolder != null
                && folder.length > 0
                && this.loadedSystemFolder !== folder;

            if (projectChanged) {
                // Always reload on project switch — never skip for pending saves / focus.
                this.cancelPendingSave();
                this.disposeUniverHost();
            } else {
                // If a save is pending, skip reloading from disk (would overwrite in-memory changes)
                if (this.saveDebounce) return;
                // If a cell is being edited, skip refresh to avoid destroying the textarea
                if (this.canvasEl?.querySelector('.plot-grid-cell.editing')) return;
                // If any input/textarea in the grid or inspector is focused, skip refresh to avoid losing edits
                if (this.wrapperEl?.querySelector('input:focus, textarea:focus')) return;
            }

            const beforeFp = this.univerHost
                ? conceptGridContentFingerprint(this.document)
                : '';
            await this.loadData();
            // If the view hasn't been opened yet, `wrapperEl` will be null — skip rendering
            if (!this.wrapperEl) return;
            this.renderPageSidebar();
            this.renderToolbar();
            // Content-only disk changes must push into Univer (structure sig alone skips remount).
            if (this.univerHost && !projectChanged) {
                const afterFp = conceptGridContentFingerprint(this.document);
                if (afterFp !== beforeFp) {
                    try {
                        this.univerHost.setDocument(this.document);
                        this.univerStructureSig = this.getUniverStructureSig();
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

    private countSelectedCells(): number {
        let n = 0;
        this.forEachSelectedCell(() => { n++; });
        return n;
    }

    private isCellInSelection(r: number, c: number): boolean {
        const rect = this.getSelectionRect();
        if (!rect) return false;
        return r >= rect.r0 && r <= rect.r1 && c >= rect.c0 && c <= rect.c1;
    }

    /** Keep the current rectangle; pin active/focus for visuals without shrinking the range. */
    private ensureSelectionIncludes(r: number, c: number): void {
        if (!this.isCellInSelection(r, c)) {
            this.setSelection({ r, c }, { r, c });
            return;
        }
        const rect = this.getSelectionRect();
        if (!rect) {
            this.setSelection({ r, c }, { r, c });
            return;
        }
        this.selAnchor = { r: rect.r0, c: rect.c0 };
        this.selFocus = { r: rect.r1, c: rect.c1 };
        this.selectedRow = r;
        this.selectedCol = c;
        this.applySelectionVisuals();
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

    private flashElement(el: HTMLElement | null) {
        if (!el) return;
        const orig = el.style.transition || '';
        el.setCssStyles({ transition: 'background-color 160ms ease' });
        const prevBg = el.style.background;
        el.setCssStyles({ background: 'var(--sl-grid-flash)' });
        window.setTimeout(() => { el.setCssStyles({ background: prevBg }); window.setTimeout(() => { el.setCssStyles({ transition: orig }); }, 200); }, 180);
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

    private isDragHandleTarget(target: EventTarget | null): boolean {
        if (!(target instanceof HTMLElement)) return false;
        return !!target.closest('.plot-grid-mini-card, .pg-cell-note-label, .pg-cell-note-body, .pg-cell-note-icon');
    }

    private onCellPointerDown(ev: PointerEvent, ri: number, ci: number): void {
        if (ev.button !== 0) return;
        if (this.canvasEl?.querySelector('.plot-grid-cell.editing')) return;

        // Note/scene card: select cell but let HTML5 drag own the gesture
        if (this.isDragHandleTarget(ev.target)) {
            if (ev.shiftKey && this.selAnchor) {
                this.setSelection(this.selAnchor, { r: ri, c: ci });
            } else {
                this.setSelection({ r: ri, c: ci }, { r: ri, c: ci });
            }
            this.refreshSelectionInspector();
            this.wrapperEl?.focus({ preventScroll: true });
            return;
        }

        ev.preventDefault();
        this.isSelecting = true;
        this.selectPointerId = ev.pointerId;
        try {
            (ev.currentTarget as HTMLElement).setPointerCapture(ev.pointerId);
        } catch { /* noop */ }

        if (ev.shiftKey && this.selAnchor) {
            this.setSelection(this.selAnchor, { r: ri, c: ci });
        } else {
            this.setSelection({ r: ri, c: ci }, { r: ri, c: ci });
        }
        this.refreshSelectionInspector();
        this.wrapperEl?.focus({ preventScroll: true });
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
        const key = `${this.data.rows[this.selectedRow].id}-${this.data.columns[this.selectedCol].id}`;
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
            const cols = rows[i].split('\t');
            maxCols = Math.max(maxCols, cols.length);
            for (let j = 0; j < cols.length; j++) {
                const tc = startC + j;
                if (tc >= this.data.columns.length) break;
                const row = this.data.rows[tr];
                const col = this.data.columns[tc];
                const cell = this.data.cells[`${row.id}-${col.id}`];
                if (!cell) continue;
                cell.content = cols[j];
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

    private selectRowHeader(index: number, extend = false, opts?: { focusWrapper?: boolean }) {
        if (index < 0 || index >= this.data.rows.length || this.data.columns.length === 0) return;
        const lastC = this.data.columns.length - 1;
        if (extend && this.selAnchor && this.selFocus) {
            const rect = this.getSelectionRect()!;
            this.setSelection(
                { r: this.selAnchor.r, c: rect.c0 },
                { r: index, c: rect.c1 },
            );
        } else {
            this.setSelection({ r: index, c: 0 }, { r: index, c: lastC });
        }
        this.refreshSelectionInspector();
        if (opts?.focusWrapper !== false) {
            this.wrapperEl?.focus({ preventScroll: true });
        }
    }

    private selectColumnHeader(index: number, extend = false, opts?: { focusWrapper?: boolean }) {
        if (index < 0 || index >= this.data.columns.length || this.data.rows.length === 0) return;
        const lastR = this.data.rows.length - 1;
        if (extend && this.selAnchor && this.selFocus) {
            const rect = this.getSelectionRect()!;
            this.setSelection(
                { r: rect.r0, c: this.selAnchor.c },
                { r: rect.r1, c: index },
            );
        } else {
            this.setSelection({ r: 0, c: index }, { r: lastR, c: index });
        }
        this.refreshSelectionInspector();
        if (opts?.focusWrapper !== false) {
            this.wrapperEl?.focus({ preventScroll: true });
        }
    }

    private moveArrayItem<T>(arr: T[], from: number, to: number) {
        const item = arr.splice(from, 1)[0];
        arr.splice(to, 0, item);
    }

    private moveColumn(from: number, to: number) {
        if (from === to) return;
        this.moveArrayItem(this.data.columns, from, to);
        // adjust selectedCol if needed
        if (this.selectedCol === from) this.selectedCol = to;
        else if (this.selectedCol !== null) {
            if (from < to && this.selectedCol > from && this.selectedCol <= to) this.selectedCol--;
            else if (from > to && this.selectedCol >= to && this.selectedCol < from) this.selectedCol++;
        }
        this.scheduleSave();
        this.renderGrid();
    }

    private moveRow(from: number, to: number) {
        if (from === to) return;
        this.moveArrayItem(this.data.rows, from, to);
        if (this.selectedRow === from) this.selectedRow = to;
        else if (this.selectedRow !== null) {
            if (from < to && this.selectedRow > from && this.selectedRow <= to) this.selectedRow--;
            else if (from > to && this.selectedRow >= to && this.selectedRow < from) this.selectedRow++;
        }
        this.scheduleSave();
        this.renderGrid();
    }

    /** Resolve a CSS custom property to its computed hex value */
    private resolveThemeColor(varName: string, fallback: string): string {
        const val = getComputedStyle(activeDocument.body).getPropertyValue(varName).trim();
        return val || fallback;
    }

    /** Open colour picker for the current selection's background. */
    private openCellBgColorPicker(cellKey: string, cellEl: HTMLElement, ri: number, ci: number): void {
        const targets: Array<{ cell: CellData; el: HTMLElement; r: number; c: number }> = [];
        this.forEachSelectedCell((r, c, key, cell) => {
            const el = this.getCellElement(r, c) || (key === cellKey ? cellEl : null);
            if (el) targets.push({ cell, el, r, c });
        });
        if (targets.length === 0) {
            const cell = this.data.cells[cellKey];
            if (cell) targets.push({ cell, el: cellEl, r: ri, c: ci });
        }
        const seed = targets[0];
        if (!seed) return;
        const prevs = targets.map(t => t.el.style.background);
        this.chooseColor(seed.cell.bgColor || this.defaultBgColor(), (c) => {
            if (c === null) {
                targets.forEach((t, i) => t.el.setCssStyles({ background: prevs[i] }));
                return;
            }
            this.pushPlotGridUndo();
            for (const t of targets) t.cell.bgColor = c || '';
            this.scheduleSave();
            this.renderGrid();
            for (const t of targets) this.flashElement(this.getCellElement(t.r, t.c));
        }, (preview) => {
            if (preview === null) {
                targets.forEach((t, i) => t.el.setCssStyles({ background: prevs[i] }));
            } else {
                for (const t of targets) {
                    t.el.setCssStyles({ background: preview || '' });
                    if (preview && preview.startsWith('#') && !t.cell.textColor) {
                        t.el.setCssStyles({ color: contrastTextColor(preview) });
                    }
                }
            }
        });
    }

    /** Open colour picker for the current selection's text colour. */
    private openCellTextColorPicker(cellKey: string, cellEl: HTMLElement): void {
        const targets: Array<{ cell: CellData; el: HTMLElement }> = [];
        this.forEachSelectedCell((_r, _c, key, cell) => {
            const el = this.getCellElement(_r, _c) || (key === cellKey ? cellEl : null);
            if (el) targets.push({ cell, el });
        });
        if (targets.length === 0) {
            const cell = this.data.cells[cellKey];
            if (cell) targets.push({ cell, el: cellEl });
        }
        const seed = targets[0];
        if (!seed) return;
        const prevs = targets.map(t => t.el.style.color);
        this.chooseColor(seed.cell.textColor || this.defaultTextColor(), (c) => {
            if (c === null) {
                targets.forEach((t, i) => t.el.setCssStyles({ color: prevs[i] }));
                return;
            }
            this.pushPlotGridUndo();
            for (const t of targets) t.cell.textColor = c || '';
            this.scheduleSave();
            this.renderGrid();
        }, (preview) => {
            if (preview === null) targets.forEach((t, i) => t.el.setCssStyles({ color: prevs[i] }));
            else targets.forEach(t => t.el.setCssStyles({ color: preview || '' }));
        });
    }

    /** Set the same text content for every cell in the selection. */
    private openFillSelectionModal(seedText = ''): void {
        const n = this.countSelectedCells();
        if (n <= 0) return;
        const applyFill = (text: string) => {
            this.pushPlotGridUndo();
            this.forEachSelectedCell((_r, _c, _key, cell) => {
                cell.content = text;
                cell.manualContent = true;
            });
            this.scheduleSave();
            this.renderGrid();
            this.refreshSelectionInspector();
            new Notice(t('Updated {n} cells', { n }));
        };
        class FillSelectionModal extends Modal {
            onOpen() {
                const { contentEl } = this;
                contentEl.empty();
                contentEl.createEl('h3', { text: t('Edit Cells ({n})…', { n }) });
                contentEl.createEl('p', {
                    cls: 'mod-muted',
                    text: t('Replace content in all selected cells.'),
                });
                const ta = contentEl.createEl('textarea', { cls: 'pg-fill-selection-textarea' });
                ta.value = seedText;
                ta.rows = 8;
                ta.setCssStyles({
                    width: '100%',
                    resize: 'vertical',
                    marginTop: '8px',
                    padding: '8px',
                    boxSizing: 'border-box',
                });
                const actions = contentEl.createDiv({ cls: 'modal-button-container' });
                actions.setCssStyles({
                    display: 'flex',
                    justifyContent: 'flex-end',
                    gap: '8px',
                    marginTop: '12px',
                });
                const cancel = actions.createEl('button', { text: t('Cancel') });
                cancel.addEventListener('click', () => this.close());
                const apply = actions.createEl('button', { cls: 'mod-cta', text: t('Apply') });
                apply.addEventListener('click', () => {
                    applyFill(ta.value);
                    this.close();
                });
                window.setTimeout(() => {
                    ta.focus();
                    ta.select();
                }, 0);
            }
        }
        new FillSelectionModal(this.app).open();
    }

    /** Get a theme-aware default background color for the color picker */
    private defaultBgColor(): string {
        return this.resolveThemeColor('--background-primary', '#ffffff');
    }

    /** Get a theme-aware default text color for the color picker */
    private defaultTextColor(): string {
        return this.resolveThemeColor('--text-normal', '#000000');
    }

    /** Get palette colors resolved from CSS variables */
    private getThemePalette(): string[] {
        return [
            this.resolveThemeColor('--sl-palette-1', '#fde8d8'),
            this.resolveThemeColor('--sl-palette-2', '#fdf6d8'),
            this.resolveThemeColor('--sl-palette-3', '#d8f5e0'),
            this.resolveThemeColor('--sl-palette-4', '#d8eafd'),
            this.resolveThemeColor('--sl-palette-5', '#ead8fd'),
            this.resolveThemeColor('--sl-palette-6', '#fdd8e8'),
            this.resolveThemeColor('--sl-palette-7', '#d8f5f5'),
            this.resolveThemeColor('--sl-palette-8', '#f5d8d8'),
            this.resolveThemeColor('--sl-palette-9', '#e8e8e8'),
            '',
        ];
    }

    private chooseColor(initial: string | undefined, cb: (color: string | null) => void, preview?: (color: string | null) => void) {
        const app = this.app;
        const palette = this.getThemePalette();
        const checkerLight = this.resolveThemeColor('--sl-checker-light', '#fff');
        const checkerDark = this.resolveThemeColor('--sl-checker-dark', '#ddd');
        class ColorPickerModal extends Modal {
            initVal: string;
            inputEl: HTMLInputElement | null = null;
            hexEl: HTMLInputElement | null = null;
            onChoose: (c: string | null) => void;
            onPreview?: (c: string | null) => void;
            constructor(app: App, init: string, onChoose: (c: string | null) => void, onPreview?: (c: string | null) => void) { super(app); this.initVal = init; this.onChoose = onChoose; this.onPreview = onPreview; }
            onOpen() {
                const { contentEl } = this;
                const titleEl = contentEl.createEl('h3', { text: t('Choose color') });
                titleEl.setCssStyles({ margin: '4px 0 8px 0' });
                const row = contentEl.createDiv();
                this.inputEl = row.createEl('input') as HTMLInputElement;
                this.inputEl.type = 'color';
                // avoid assigning an empty string to a color input (invalid)
                const defaultColor = (this.initVal && /^#?[0-9a-fA-F]{6}$/.test(this.initVal)) ? (this.initVal.startsWith('#') ? this.initVal : `#${this.initVal}`) : getComputedStyle(activeDocument.body).getPropertyValue('--background-primary').trim() || '#ffffff';
                this.inputEl.value = defaultColor;
                this.inputEl.setCssStyles({
                    width: '48px',
                    height: '32px',
                    marginRight: '8px',
                });

                this.hexEl = row.createEl('input') as HTMLInputElement;
                this.hexEl.type = 'text';
                this.hexEl.value = this.initVal && this.initVal !== '' ? (this.initVal.startsWith('#') ? this.initVal : `#${this.initVal}`) : '';
                this.hexEl.setCssStyles({
                    width: '120px',
                    marginRight: '8px',
                });

                const previewSwatch = row.createDiv('color-preview');
                previewSwatch.setCssStyles({
                    width: '36px',
                    height: '36px',
                    border: '1px solid var(--background-modifier-border)',
                    background: this.inputEl.value,
                    marginRight: '10px',
                    borderRadius: '6px',
                });

                // track the currently selected color separately from the color input value
                let selectedColor: string | '' = (this.initVal && this.initVal !== '') ? (this.initVal.startsWith('#') ? this.initVal : `#${this.initVal}`) : '';

                // preset palette swatches (resolved from theme)
                const swatchRow = contentEl.createDiv('color-swatch-row');
                swatchRow.setCssStyles({
                    display: 'flex',
                    flexWrap: 'wrap',
                    gap: '6px',
                    marginTop: '6px',
                });
                for (const col of palette) {
                    const s = swatchRow.createDiv('palette-swatch');
                    s.setCssStyles({
                        width: '20px',
                        height: '20px',
                        borderRadius: '4px',
                        border: '1px solid var(--background-modifier-border)',
                        cursor: 'pointer',
                    });
                    s.title = col || 'No color';
                    s.setCssStyles({ background: col || 'transparent' });
                    if (!col) { s.setCssStyles({ backgroundImage: `linear-gradient(45deg,${checkerLight} 25%, ${checkerDark} 25%, ${checkerDark} 50%, ${checkerLight} 50%, ${checkerLight} 75%, ${checkerDark} 75%, ${checkerDark} 100%)` }); s.setCssStyles({ backgroundSize: '8px 8px' }); }
                    s.addEventListener('click', () => {
                        if (col) {
                            selectedColor = col;
                            // update inputs where valid
                            try { this.inputEl!.value = col; } catch (e) { /* input may not exist */ }
                            if (this.hexEl) this.hexEl.value = col;
                            previewSwatch.setCssStyles({ background: col });
                            if (this.onPreview) this.onPreview(col);
                        } else {
                            // select explicit "no color"
                            selectedColor = '';
                            // do not try to write an empty value to the color input (invalid)
                            if (this.hexEl) this.hexEl.value = '';
                            previewSwatch.setCssStyles({ background: 'transparent' });
                            if (this.onPreview) this.onPreview('');
                        }
                    });
                }

                // tighten modal layout and reduce top spacing; also set modal container size
                contentEl.setCssStyles({
                    maxWidth: '90vw',
                    padding: '8px 12px',
                    marginTop: '0',
                });
                const modalEl = (this as unknown as Record<string, unknown>).modalEl as HTMLElement;
                if (modalEl) {
                    modalEl.setCssStyles({
                        width: '300px',
                        maxWidth: '90vw',
                    });
                    // center and move the modal slightly higher; nudge left to better center in the app
                    modalEl.setCssStyles({
                        left: '50%',
                        top: '4%',
                        transform: 'translate(-52%, -6%)',
                        right: 'auto',
                        boxSizing: 'border-box',
                        margin: '0',
                    });
                }

                this.inputEl.addEventListener('input', () => {
                    const val = this.inputEl!.value;
                    selectedColor = val;
                    if (this.hexEl) this.hexEl.value = val;
                    previewSwatch.setCssStyles({ background: val });
                    if (this.onPreview) this.onPreview(val);
                });
                this.hexEl.addEventListener('input', () => {
                    const v = this.hexEl!.value;
                    if (v === '') {
                        selectedColor = '';
                        previewSwatch.setCssStyles({ background: 'transparent' });
                        if (this.onPreview) this.onPreview('');
                    } else if (/^#?[0-9a-fA-F]{6}$/.test(v)) {
                        const norm = v.startsWith('#') ? v : `#${v}`;
                        selectedColor = norm;
                        try { this.inputEl!.value = norm; } catch (e) { /* input may not exist */ }
                        previewSwatch.setCssStyles({ background: norm });
                        if (this.onPreview) this.onPreview(norm);
                    }
                });

                const btns = contentEl.createDiv();
                btns.setCssStyles({
                    marginTop: '8px',
                    display: 'flex',
                    width: '100%',
                    justifyContent: 'flex-end',
                    gap: '12px',
                    paddingRight: '6px',
                });

                const ok = btns.createEl('button', { text: t('OK') });
                ok.addEventListener('click', () => { this.onChoose(selectedColor === '' ? '' : selectedColor); this.close(); });
                const cancel = btns.createEl('button', { text: t('Cancel') });
                cancel.addEventListener('click', () => { if (this.onPreview) this.onPreview(null); this.onChoose(null); this.close(); });

                // Make the modal draggable by its header
                const headerEl = contentEl.querySelector('h3');
                if (modalEl && headerEl) {
                    headerEl.setCssStyles({ cursor: 'move' });
                    let dragging = false;
                    let startX = 0, startY = 0, origLeft = 0, origTop = 0;
                    const onDown = (ev: MouseEvent) => {
                        ev.preventDefault();
                        dragging = true;
                        const rect = modalEl.getBoundingClientRect();
                        startX = ev.clientX; startY = ev.clientY;
                        origLeft = rect.left; origTop = rect.top;
                        modalEl.setCssStyles({
                            position: 'fixed',
                            left: origLeft + 'px',
                            top: origTop + 'px',
                            transform: '',
                        });
                        activeDocument.addEventListener('mousemove', onMove);
                        activeDocument.addEventListener('mouseup', onUp);
                    };
                    const onMove = (ev: MouseEvent) => {
                        if (!dragging) return;
                        const dx = ev.clientX - startX;
                        const dy = ev.clientY - startY;
                        modalEl.setCssStyles({
                            left: (origLeft + dx) + 'px',
                            top: (origTop + dy) + 'px',
                        });
                    };
                    const onUp = () => {
                        dragging = false;
                        activeDocument.removeEventListener('mousemove', onMove);
                        activeDocument.removeEventListener('mouseup', onUp);
                    };
                    // allow dragging by header text
                    headerEl.addEventListener('mousedown', onDown);
                    // also allow dragging by clicking the top rounded area of the modal
                    modalEl.addEventListener('mousedown', (ev: MouseEvent) => {
                        // ignore clicks originating inside the content (e.g. inputs, buttons)
                        const target = ev.target as HTMLElement;
                        if (target.closest('h3') || target.closest('input') || target.closest('button') || target.closest('.color-swatch-row')) return;
                        const rect = modalEl.getBoundingClientRect();
                        const y = ev.clientY - rect.top;
                        // treat clicks within the top 56px as the draggable area
                        if (y >= 0 && y <= 56) {
                            onDown(ev);
                        }
                    });

                    // show move cursor when hovering the top rounded area
                    modalEl.addEventListener('mousemove', (ev: MouseEvent) => {
                        const target = ev.target as HTMLElement;
                        const rect = modalEl.getBoundingClientRect();
                        const y = ev.clientY - rect.top;
                        if (y >= 0 && y <= 56 && !target.closest('input') && !target.closest('button') && !target.closest('.color-swatch-row')) {
                            modalEl.setCssStyles({ cursor: 'move' });
                        } else {
                            modalEl.setCssStyles({ cursor: '' });
                        }
                    });
                    modalEl.addEventListener('mouseleave', () => { modalEl.setCssStyles({ cursor: '' }); });
                }
            }
        }

        const modal = new ColorPickerModal(app, initial || this.defaultBgColor(), cb, preview);
        modal.open();
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

    /** Navigate to the entity represented by a column (character / location file) */
    private navigateToColumnEntity(col: ColumnMeta): void {
        if (!col.sourceId) return;
        const name = col.sourceId.toLowerCase();

        if (col.sourceKind === 'characters' || !col.sourceKind) {
            const charMgr = this.plugin?.characterManager as CharacterManager | undefined;
            if (charMgr) {
                const match = charMgr.getAllCharacters().find(c => c.name.toLowerCase() === name);
                if (match) {
                    const file = this.app.vault.getAbstractFileByPath(match.filePath) as TFile | null;
                    if (file) { this.app.workspace.getLeaf('tab').openFile(file, { state: { mode: 'source', source: false } }); return; }
                }
            }
        }

        if (col.sourceKind === 'locations' || !col.sourceKind) {
            const locMgr = this.plugin?.locationManager as LocationManager | undefined;
            if (locMgr) {
                const allLocs = [...locMgr.getAllWorlds(), ...locMgr.getAllLocations()];
                const match = allLocs.find(l => l.name.toLowerCase() === name);
                if (match) {
                    const file = this.app.vault.getAbstractFileByPath(match.filePath) as TFile | null;
                    if (file) { this.app.workspace.getLeaf('tab').openFile(file, { state: { mode: 'source', source: false } }); return; }
                }
            }
        }

        // Codex categories
        if (col.sourceKind?.startsWith('codex:')) {
            const catId = col.sourceKind.slice(6);
            const codexMgr = this.plugin?.codexManager;
            if (codexMgr) {
                const entry = codexMgr.findByName(catId, col.sourceId || '');
                if (entry) {
                    const file = this.app.vault.getAbstractFileByPath(entry.filePath) as TFile | null;
                    if (file) { this.app.workspace.getLeaf('tab').openFile(file, { state: { mode: 'source', source: false } }); return; }
                }
            }
        }

        // Tags have no backing file to navigate to
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
            this.showCellInspector(items[0].r, items[0].c, items[0].cell);
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

        const hadContentBefore = !!(cell.content && cell.content.trim());
        const hadLinkedScene = !!cell.linkedSceneId;

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
            // Auto-Note: if toggled on and new non-empty text entered into an unlinked cell
            const hasNewContent = !!(ta.value && ta.value.trim());
            if (this.plugin?.settings.plotgridAutoNote && hasNewContent && !hadLinkedScene && !hadContentBefore) {
                // Let autoCreateNoteFromCell handle save + render to avoid race
                void this.autoCreateNoteFromCell(cell);
            } else {
                this.scheduleSave();
                this.renderGrid();
            }
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
                    const key = `${this.data.rows[nr].id}-${this.data.columns[nc].id}`;
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

    /* ── Note color helpers (mirrors BoardView) ── */

    private normalizeHexColor(value: string | undefined): string | undefined {
        if (!value) return undefined;
        const trimmed = value.trim();
        const short = trimmed.match(/^#([0-9a-fA-F]{3})$/);
        if (short) {
            const [r, g, b] = short[1].split('');
            return `#${r}${r}${g}${g}${b}${b}`.toUpperCase();
        }
        const full = trimmed.match(/^#([0-9a-fA-F]{6})$/);
        if (full) return `#${full[1].toUpperCase()}`;
        return undefined;
    }

    private async setNoteColor(scene: Scene, color: string | undefined, _cellKey: string): Promise<void> {
        const scMgr = this.plugin?.sceneManager as SceneManager | undefined;
        const normalized = this.normalizeHexColor(color);
        await scMgr?.updateScene(scene.filePath, { corkboardNoteColor: normalized });
        scene.corkboardNoteColor = normalized;
        this.renderGrid();
    }

    private openNoteColorModal(scene: Scene, cellKey: string): void {
        const modal = new Modal(this.app);
        modal.titleEl.setText(t('Custom note color'));
        const current = this.normalizeHexColor(scene.corkboardNoteColor) ?? '#FFF8CC';
        const row = modal.contentEl.createDiv('story-line-note-color-modal-row');
        row.createEl('label', { text: t('Pick color') });
        const picker = row.createEl('input', {
            attr: { type: 'color', value: current },
        });
        new obsidian.Setting(modal.contentEl)
            .addButton(btn => { btn.setButtonText(t('Cancel')).onClick(() => modal.close()); })
            .addButton(btn => {
                btn.setButtonText(t('Apply')).setCta().onClick(async () => {
                    await this.setNoteColor(scene, picker.value, cellKey);
                    modal.close();
                });
            });
        modal.open();
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

    private ensureCellInData(cell: CellData): CellData {
        const existing = this.data.cells[cell.id];
        if (existing) return existing;
        this.data.cells[cell.id] = cell;
        return cell;
    }

    private linkFileToCell(cell: CellData, filePath: string): void {
        const liveCell = this.ensureCellInData(cell);
        liveCell.linkedSceneId = filePath;
        // Keep host meta aligned so the next Univer pull does not erase the link.
        try { this.univerHost?.syncMeta(this.document); } catch { /* ignore */ }
        this.scheduleSave();
        // Meta-only change — avoid remounting Univer (would drop caret/selection).
        if (!this.univerHost) this.renderGrid();
        this.refreshOpenCellInspector();
    }

    private unlinkCell(cellKey: string): void {
        // Prefer active page; also clear on the page that owns the key when using Univer selection.
        let cleared = false;
        if (this.data.cells[cellKey]) {
            this.data.cells[cellKey].linkedSceneId = undefined;
            cleared = true;
        }
        if (!cleared) {
            for (const page of this.document.pages) {
                if (page.cells[cellKey]) {
                    page.cells[cellKey].linkedSceneId = undefined;
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

    /**
     * Auto-Note / Convert to Notes: create a corkboard note in Notes/
     * from a cell's text and link it back to the cell.
     */
    private async autoCreateNoteFromCell(cell: CellData): Promise<void> {
        await this.convertCellToNotes(cell);
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

    private async convertSelectedCells(kind: 'notes' | 'scene' | 'research'): Promise<void> {
        const cells: CellData[] = [];
        this.forEachSelectedCell((_r, _c, _key, cell) => {
            if (this.cellConvertBody(cell)) cells.push(cell);
        });
        if (cells.length === 0) {
            new Notice(t('Add some content before converting'));
            return;
        }
        this.pushPlotGridUndo();
        let n = 0;
        for (const cell of cells) {
            const ok = kind === 'notes'
                ? await this.convertCellToNotes(cell, { quiet: true })
                : kind === 'scene'
                    ? await this.convertCellToScene(cell, { quiet: true })
                    : await this.convertCellToResearch(cell, { quiet: true });
            if (ok) n++;
        }
        this.scheduleSave();
        this.renderGrid();
        this.refreshSelectionInspector();
        new Notice(t('Converted {n} cells', { n }));
    }

    /** Vault-wide file picker — any markdown note can be linked to a cell. */
    private openNoteLinkModal(onChoose: (path: string) => void) {
        this.openSceneLinkModal(onChoose);
    }

    // Legacy name kept for any remaining call sites
    private openSceneLinkModal(onChoose: (path: string) => void) {
        const app = this.app;
        class NoteLinkModal extends Modal {
            onChoose: (path: string) => void;
            listEl: HTMLDivElement | null = null;
            inputEl: HTMLInputElement | null = null;
            constructor(app: App, onChoose: (p: string) => void) {
                super(app);
                this.onChoose = onChoose;
            }
            onOpen() {
                const { contentEl } = this;
                contentEl.createEl('h3', { text: t('Link Note') });
                this.inputEl = contentEl.createEl('input');
                this.inputEl.placeholder = t('Search files...');
                this.inputEl.setCssStyles({ width: '100%' });
                this.inputEl.addEventListener('input', () => this.renderList());
                this.listEl = contentEl.createDiv('scene-link-list');
                this.listEl.setCssStyles({
                    maxHeight: '300px',
                    overflow: 'auto',
                });
                this.renderList();
            }
            renderList() {
                if (!this.listEl || !this.inputEl) return;
                this.listEl.empty();
                const q = this.inputEl.value.toLowerCase();
                const files = this.app.vault.getMarkdownFiles().filter((f: TFile) =>
                    f.path.toLowerCase().includes(q) || f.basename.toLowerCase().includes(q));
                for (const f of files) {
                    const row = this.listEl.createDiv('scene-link-row');
                    row.setCssStyles({
                        padding: '6px 8px',
                        cursor: 'pointer',
                    });
                    row.setText(f.path);
                    row.addEventListener('click', () => {
                        this.onChoose(f.path);
                        this.close();
                    });
                }
                if (files.length === 0) this.listEl.createDiv({ text: t('No files found'), cls: 'muted' });
            }
        }

        const modal = new NoteLinkModal(app, onChoose);
        modal.open();
    }

    // ── Sync from Scenes ────────────────────────────────────────────────

    private openSyncModal() {
        const scMgr = this.plugin?.sceneManager as SceneManager | undefined;
        if (!scMgr) { new Notice(t('Scene manager not available')); return; }
        const scenes = scMgr.getAllScenes();
        if (scenes.length === 0) { new Notice(t('No scenes found in the active project')); return; }

        // Capture outer-class reference for use inside the nested Modal subclass below.
        // eslint-disable-next-line @typescript-eslint/no-this-alias -- nested Modal class needs access to the outer view instance for callbacks
        const view = this;
        class SyncModal extends Modal {
            constructor(app: App) { super(app); }
            onOpen() {
                const { contentEl } = this;
                contentEl.createEl('h3', { text: t('Sync from Scenes') });
                contentEl.createEl('p', {
                    text: t('Auto-populate the grid with rows from scenes and columns from story data. Manual changes will be preserved.'),
                    cls: 'setting-item-description',
                });

                // Column source selector
                const colSourceLabel = contentEl.createEl('label', { text: t('Columns from:') });
                colSourceLabel.setCssStyles({
                    display: 'block',
                    marginTop: '12px',
                    marginBottom: '4px',
                    fontWeight: '600',
                });

                const colSourceSelect = contentEl.createEl('select');
                colSourceSelect.setCssStyles({
                    width: '100%',
                    marginBottom: '12px',
                });
                colSourceSelect.createEl('option', { text: t('Characters'), value: 'characters' });
                colSourceSelect.createEl('option', { text: t('Plotlines (tags)'), value: 'tags' });
                colSourceSelect.createEl('option', { text: t('Locations'), value: 'locations' });
                // Add codex categories that appear in sidebar
                const codexMgr = view.plugin?.codexManager;
                const sidebarCats = (view.plugin as unknown as { settings?: { codexSidebarCategories?: string[] } })?.settings?.codexSidebarCategories;
                if (codexMgr && sidebarCats) {
                    for (const catId of sidebarCats) {
                        const catDef = codexMgr.getCategoryDef(catId);
                        if (catDef) {
                            colSourceSelect.createEl('option', { text: catDef.label, value: `codex:${catId}` });
                        }
                    }
                }

                // Row sorting info
                const sortInfo = contentEl.createEl('p', {
                    text: t('Rows will be ordered by Act → Chapter → Sequence.'),
                    cls: 'setting-item-description',
                });
                sortInfo.setCssStyles({ marginBottom: '12px' });

                // How to handle existing data
                const modeLabel = contentEl.createEl('label', { text: t('Merge mode:') });
                modeLabel.setCssStyles({
                    display: 'block',
                    marginBottom: '4px',
                    fontWeight: '600',
                });

                const modeSelect = contentEl.createEl('select');
                modeSelect.setCssStyles({
                    width: '100%',
                    marginBottom: '16px',
                });
                modeSelect.createEl('option', { text: t('Merge — keep manual rows/columns, add missing'), value: 'merge' });
                modeSelect.createEl('option', { text: t('Replace — rebuild from scenes (manual data cleared)'), value: 'replace' });

                const btns = contentEl.createDiv();
                btns.setCssStyles({
                    display: 'flex',
                    justifyContent: 'flex-end',
                    gap: '8px',
                });

                const cancelBtn = btns.createEl('button', { text: t('Cancel') });
                cancelBtn.addEventListener('click', () => this.close());

                const syncBtn = btns.createEl('button', { text: t('Sync'), cls: 'mod-cta' });
                syncBtn.addEventListener('click', () => {
                    const colSource = colSourceSelect.value;
                    const mode = modeSelect.value as 'merge' | 'replace';
                    view.performSync(colSource, mode);
                    this.close();
                });
            }
        }

        const modal = new SyncModal(this.app);
        modal.open();
    }

    /**
     * Perform the actual sync: create rows from scenes, columns from the chosen
     * dimension, and fill cells where data exists.
     */
    private performSync(colSource: string, mode: 'merge' | 'replace') {
        const scMgr = this.plugin?.sceneManager as SceneManager | undefined;
        if (!scMgr) return;

        const scenes = scMgr.getAllScenes().slice().sort((a, b) => {
            // Sort by act → chapter → sequence using the shared numeric-aware
            // comparator (handles string acts like "1.1" / "Prologue").
            const actCmp = compareActChapter(a.act, b.act);
            if (actCmp !== 0) return actCmp;
            const chCmp = compareActChapter(a.chapter, b.chapter);
            if (chCmp !== 0) return chCmp;
            return (a.sequence ?? 0) - (b.sequence ?? 0);
        });

        // Collect unique column values from scenes
        const colSet = new Set<string>();

        // Build character alias map to deduplicate names
        let aliasMap: Map<string, string> | null = null;
        if (colSource === 'characters') {
            const charMgr = this.plugin?.characterManager as CharacterManager | undefined;
            const manualAliases = (this.plugin as unknown as { settings?: { characterAliases?: Record<string, string> } })?.settings?.characterAliases;
            if (charMgr) {
                aliasMap = charMgr.buildAliasMap(manualAliases);
            }
        }

        /** Resolve a name to its canonical form via the alias map.
         *  Falls back to checking individual words (e.g. "Konstapel Bark" → try "Bark").
         */
        const resolve = (name: string): string => {
            if (!aliasMap) return name;
            // Exact match
            const exact = aliasMap.get(name.toLowerCase());
            if (exact) return exact;
            // Try each word (handles titles/ranks: "Konstapel Bark" → "Bark")
            const words = name.split(/\s+/);
            if (words.length > 1) {
                for (const word of words) {
                    const match = aliasMap.get(word.toLowerCase());
                    if (match) return match;
                }
            }
            return name;
        };

        for (const scene of scenes) {
            if (colSource === 'characters') {
                for (const c of scene.characters || []) colSet.add(resolve(c));
                if (scene.pov) colSet.add(resolve(scene.pov));
            } else if (colSource === 'tags') {
                for (const t of scene.tags || []) colSet.add(t);
            } else if (colSource === 'locations') {
                if (scene.location) colSet.add(scene.location);
            } else if (colSource.startsWith('codex:')) {
                const catId = colSource.slice(6);
                for (const n of scene.codexLinks?.[catId] || []) colSet.add(n);
            }
        }
        const colValues = Array.from(colSet).sort();

        if (mode === 'replace') {
            // Full rebuild
            this.data.rows = [];
            this.data.columns = [];
            this.data.cells = {};
        }

        // Build lookup of existing auto rows/columns by sourceId
        const existingRowMap = new Map<string, RowMeta>();
        for (const r of this.data.rows) {
            if (r.sourceType === 'auto' && r.sourceId) existingRowMap.set(r.sourceId, r);
        }
        const existingColMap = new Map<string, ColumnMeta>();
        for (const c of this.data.columns) {
            if (c.sourceType === 'auto' && c.sourceId) existingColMap.set(c.sourceId, c);
        }

        // ── Create / update rows (one per scene) ──────────────────
        const rowIds: Map<string, string> = new Map(); // scene filePath → row id
        for (const scene of scenes) {
            const existing = existingRowMap.get(scene.filePath);
            if (existing) {
                // Update label if scene was renamed
                existing.label = this.formatRowLabel(scene);
                rowIds.set(scene.filePath, existing.id);
            } else {
                const id = makeId('r-');
                const label = this.formatRowLabel(scene);
                const row: RowMeta = { id, label, height: 80, bgColor: '', sourceType: 'auto', sourceId: scene.filePath };
                // Insert at end (sorting is handled by scene order above)
                this.data.rows.push(row);
                rowIds.set(scene.filePath, id);
            }
        }

        // ── Remove orphaned auto rows (sourceId no longer matches any scene) ──
        const scenePathSet = new Set(scenes.map(s => s.filePath));
        const orphanRowIds = new Set<string>();
        this.data.rows = this.data.rows.filter(r => {
            if (r.sourceType === 'auto' && r.sourceId && !scenePathSet.has(r.sourceId)) {
                orphanRowIds.add(r.id);
                return false; // remove orphaned auto row
            }
            return true; // keep manual rows and valid auto rows
        });
        // Clean up cells belonging to removed orphan rows
        if (orphanRowIds.size > 0) {
            for (const key of Object.keys(this.data.cells)) {
                for (const orphanId of orphanRowIds) {
                    if (key.startsWith(orphanId + '-')) {
                        delete this.data.cells[key];
                        break;
                    }
                }
            }
        }

        // ── Create / update columns ────────────────────────────────
        const colIds: Map<string, string> = new Map(); // colValue → column id
        for (const val of colValues) {
            const existing = existingColMap.get(val);
            if (existing) {
                existing.label = val;
                existing.sourceKind = colSource;
                colIds.set(val, existing.id);
            } else {
                const id = makeId('c-');
                const col: ColumnMeta = { id, label: val, width: 160, bgColor: '', sourceType: 'auto', sourceId: val, sourceKind: colSource };
                this.data.columns.push(col);
                colIds.set(val, id);
            }
        }

        // ── Fill cells ────────────────────────────────────────────
        for (const scene of scenes) {
            const rowId = rowIds.get(scene.filePath);
            if (!rowId) continue;

            let sceneColValues: string[] = [];
            if (colSource === 'characters') {
                sceneColValues = (scene.characters || []).map(c => resolve(c));
                if (scene.pov) {
                    const resolvedPov = resolve(scene.pov);
                    if (!sceneColValues.includes(resolvedPov)) sceneColValues.push(resolvedPov);
                }
            } else if (colSource === 'tags') {
                sceneColValues = [...(scene.tags || [])];
            } else if (colSource === 'locations') {
                sceneColValues = scene.location ? [scene.location] : [];
            } else if (colSource.startsWith('codex:')) {
                const catId = colSource.slice(6);
                sceneColValues = [...(scene.codexLinks?.[catId] || [])];
            }

            for (const val of sceneColValues) {
                const colId = colIds.get(val);
                if (!colId) continue;
                const key = `${rowId}-${colId}`;
                let cell = this.data.cells[key];
                if (cell && cell.manualContent) continue; // don't overwrite manual edits

                const content = this.buildCellContent(scene, colSource, val, resolve);
                if (!cell) {
                    cell = {
                        id: key,
                        content,
                        bgColor: '',
                        textColor: '',
                        bold: false,
                        italic: false,
                        align: 'center',
                        linkedSceneId: scene.filePath,
                    };
                    this.data.cells[key] = cell;
                } else {
                    // Update auto-generated content but keep formatting
                    cell.content = content;
                    cell.linkedSceneId = scene.filePath;
                }
            }
        }

        this.scheduleSave();
        this.renderGrid();
        new Notice(t('Synced {scenes} scenes → {rows} rows, {cols} columns', { scenes: scenes.length, rows: this.data.rows.length, cols: this.data.columns.length }));
    }

    /** Format a row label from a scene */
    private formatRowLabel(scene: Scene): string {
        const parts: string[] = [];
        if (scene.act) parts.push(`A${scene.act}`);
        if (scene.chapter) parts.push(`Ch${scene.chapter}`);
        parts.push(scene.title || 'Untitled');
        return parts.join(' · ');
    }

    /** Build cell content: a short summary for the intersection.
     *  Presence cells are left empty (the linked-scene preview already
     *  carries the visual weight). The POV character gets a small textual
     *  marker so authors can tell at a glance whose head we're in. */
    private buildCellContent(scene: Scene, colSource: string, colValue: string, resolve?: (n: string) => string): string {
        if (colSource === 'characters') {
            const resolvedPov = scene.pov ? (resolve ? resolve(scene.pov) : scene.pov) : '';
            if (resolvedPov && resolvedPov === colValue) return `POV: ${colValue}`;
        }
        return '';
    }

    // ── End sync helpers ────────────────────────────────────────────

    private ensureDefaults() {
        this.data.rows = this.data.rows || [];
        this.data.columns = this.data.columns || [];
        this.data.cells = this.data.cells || {};
        if (typeof (this.data as unknown as Record<string, unknown>).stickyHeaders === 'undefined') (this.data as unknown as Record<string, unknown>).stickyHeaders = true;
    }

    private addRow() {
        const id = makeId('r-');
        const n = this.data.rows.length + 1;
        this.data.rows.push({ id, label: t('Row {n}', { n }), height: 80, bgColor: '' });
        this.scheduleSave();
        this.renderGrid();
    }

    private addColumn() {
        const id = makeId('c-');
        const n = this.data.columns.length + 1;
        this.data.columns.push({ id, label: t('Col {n}', { n }), width: 160, bgColor: '' });
        this.scheduleSave();
        this.renderGrid();
    }

    // Insert/Delete helpers
    private insertRowAt(index: number, above: boolean) {
        const id = makeId('r-');
        const label = t('Row {n}', { n: this.data.rows.length + 1 });
        const newRow = { id, label, height: 80, bgColor: '' };
        const pos = above ? index : index + 1;
        this.data.rows.splice(pos, 0, newRow);
        this.scheduleSave();
        this.renderGrid();
    }

    private insertColumnAt(index: number, left: boolean) {
        const id = makeId('c-');
        const label = t('Col {n}', { n: this.data.columns.length + 1 });
        const newCol = { id, label, width: 160, bgColor: '' };
        const pos = left ? index : index + 1;
        this.data.columns.splice(pos, 0, newCol);
        this.scheduleSave();
        this.renderGrid();
    }

    /** Unique row indices covered by the current selection rectangle. */
    private getSelectedRowIndices(): number[] {
        const rect = this.getSelectionRect();
        if (!rect) return [];
        const out: number[] = [];
        for (let r = rect.r0; r <= rect.r1; r++) {
            if (this.data.rows[r]) out.push(r);
        }
        return out;
    }

    /** Unique column indices covered by the current selection rectangle. */
    private getSelectedColumnIndices(): number[] {
        const rect = this.getSelectionRect();
        if (!rect) return [];
        const out: number[] = [];
        for (let c = rect.c0; c <= rect.c1; c++) {
            if (this.data.columns[c]) out.push(c);
        }
        return out;
    }

    private confirmDeleteRows(indices: number[]): void {
        const unique = [...new Set(indices)]
            .filter((i) => i >= 0 && i < this.data.rows.length)
            .sort((a, b) => a - b);
        if (!unique.length) return;
        if (unique.length === 1) {
            this.deleteRows(unique);
            return;
        }
        openConfirmModal(this.app, {
            title: t('Delete Rows ({n})', { n: unique.length }),
            message: t('Delete {n} selected rows?', { n: unique.length }),
            confirmLabel: t('Delete'),
            onConfirm: () => this.deleteRows(unique),
        });
    }

    private confirmDeleteColumns(indices: number[]): void {
        const unique = [...new Set(indices)]
            .filter((i) => i >= 0 && i < this.data.columns.length)
            .sort((a, b) => a - b);
        if (!unique.length) return;
        if (unique.length === 1) {
            this.deleteColumns(unique);
            return;
        }
        openConfirmModal(this.app, {
            title: t('Delete Columns ({n})', { n: unique.length }),
            message: t('Delete {n} selected columns?', { n: unique.length }),
            confirmLabel: t('Delete'),
            onConfirm: () => this.deleteColumns(unique),
        });
    }

    private deleteRows(indices: number[]): void {
        const sorted = [...new Set(indices)]
            .filter((i) => i >= 0 && i < this.data.rows.length)
            .sort((a, b) => b - a);
        if (!sorted.length) return;
        // Keep at least one row so the grid stays usable.
        if (sorted.length >= this.data.rows.length) {
            new Notice(t('Keep at least one row'));
            return;
        }
        this.pushPlotGridUndo();
        for (const index of sorted) {
            const row = this.data.rows[index];
            if (!row) continue;
            for (const key of Object.keys(this.data.cells)) {
                if (key.startsWith(row.id + '-')) delete this.data.cells[key];
            }
            this.data.rows.splice(index, 1);
        }
        this.clearSelection();
        this.scheduleSave();
        this.renderGrid();
        if (sorted.length > 1) new Notice(t('Deleted {n} rows', { n: sorted.length }));
    }

    private deleteColumns(indices: number[]): void {
        const sorted = [...new Set(indices)]
            .filter((i) => i >= 0 && i < this.data.columns.length)
            .sort((a, b) => b - a);
        if (!sorted.length) return;
        if (sorted.length >= this.data.columns.length) {
            new Notice(t('Keep at least one column'));
            return;
        }
        this.pushPlotGridUndo();
        for (const index of sorted) {
            const col = this.data.columns[index];
            if (!col) continue;
            for (const key of Object.keys(this.data.cells)) {
                if (key.endsWith('-' + col.id)) delete this.data.cells[key];
            }
            this.data.columns.splice(index, 1);
        }
        this.clearSelection();
        this.scheduleSave();
        this.renderGrid();
        if (sorted.length > 1) new Notice(t('Deleted {n} columns', { n: sorted.length }));
    }

    // Resizing logic
    private startColResize(e: MouseEvent, colIndex: number) {
        e.preventDefault();
        const startX = e.clientX;
        const origWidth = this.data.columns[colIndex].width;
        activeDocument.body.setCssStyles({ cursor: 'col-resize' });

        const onMove = (ev: MouseEvent) => {
            const delta = ev.clientX - startX;
            const newW = Math.max(60, Math.round(origWidth + delta));
            this.data.columns[colIndex].width = newW;
            // update grid template for live feedback
            if (this.canvasEl) {
                const colTemplate = [ROW_HEADER_WIDTH + 'px', ...this.data.columns.map((c) => c.width + 'px')].join(' ');
                this.canvasEl.setCssStyles({ gridTemplateColumns: colTemplate });
                const totalWidth = this.computeTotalWidth();
                this.canvasEl.setCssStyles({ width: totalWidth / this.data.zoom + 'px' });
            }
        };

        const onUp = () => {
            activeDocument.removeEventListener('mousemove', onMove);
            activeDocument.removeEventListener('mouseup', onUp);
            activeDocument.body.setCssStyles({ cursor: '' });
            this.scheduleSave();
            this.renderGrid();
        };

        activeDocument.addEventListener('mousemove', onMove);
        activeDocument.addEventListener('mouseup', onUp);
    }

    private startRowResize(e: MouseEvent, rowIndex: number) {
        e.preventDefault();
        const startY = e.clientY;
        const origH = this.data.rows[rowIndex].height;
        activeDocument.body.setCssStyles({ cursor: 'row-resize' });

        const onMove = (ev: MouseEvent) => {
            const delta = ev.clientY - startY;
            const newH = Math.max(40, Math.round(origH + delta));
            this.data.rows[rowIndex].height = newH;
            if (this.canvasEl) {
                const rowTemplate = [COL_HEADER_HEIGHT + 'px', ...this.data.rows.map((r) => r.height + 'px')].join(' ');
                this.canvasEl.setCssStyles({ gridTemplateRows: rowTemplate });
            }
        };

        const onUp = () => {
            activeDocument.removeEventListener('mousemove', onMove);
            activeDocument.removeEventListener('mouseup', onUp);
            activeDocument.body.setCssStyles({ cursor: '' });
            this.scheduleSave();
            this.renderGrid();
        };

        activeDocument.addEventListener('mousemove', onMove);
        activeDocument.addEventListener('mouseup', onUp);
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

        // Track initial cell state for auto-note (only create once per empty cell)
        const inspectorHadContent = !!(cell.content && cell.content.trim());
        const inspectorHadLinkedScene = !!cell.linkedSceneId;

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
            // Auto-Note from inspector: if toggled on and new text on a previously empty, unlinked cell
            const hasNewContent = !!(textArea.value && textArea.value.trim());
            if (this.plugin?.settings.plotgridAutoNote && hasNewContent && !inspectorHadLinkedScene && !inspectorHadContent && !liveCell.linkedSceneId) {
                // Let autoCreateNoteFromCell handle save + render to avoid race
                void this.autoCreateNoteFromCell(liveCell);
            } else {
                this.scheduleSave();
            }
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
            // Unlinked — offer Link Note…
            const linkRow = actions.createDiv('pg-cell-link-row');
            makeAccentBtn(linkRow, t('Link Note…'), t('Link any markdown file in the vault to this cell'), () => {
                syncTextarea();
                this.openNoteLinkModal((path) => {
                    const c = this.ensureCellInData(this.data.cells[cellKey] ?? cell);
                    this.linkFileToCell(c, path);
                    this.showCellInspector(rowIndex, colIndex, c);
                });
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
/* eslint-enable @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-argument, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-floating-promises, @typescript-eslint/no-misused-promises, @typescript-eslint/no-unnecessary-type-assertion, @typescript-eslint/no-redundant-type-constituents, @typescript-eslint/no-unused-vars -- end of file-wide suppression block opened at line 1 */
