/* eslint-disable @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-floating-promises, @typescript-eslint/no-misused-promises, @typescript-eslint/no-unnecessary-type-assertion -- Obsidian's API surface and several untyped third-party libraries force dynamic dispatch; floating promises are intentional in DOM/event handlers; matching enable at end of file */
import { ItemView, WorkspaceLeaf, WorkspaceSplit, Menu, Notice, TFile, TFolder, Modal, Setting, MarkdownRenderer, normalizePath } from 'obsidian';
import * as obsidian from 'obsidian';
import { Scene, SceneFilter, SortConfig, BoardGroupBy, SceneStatus, SceneTemplate, getStatusOrder, getStatusConfig, resolveStatusCfg } from '../models/Scene';
import { openConfirmModal } from '../components/ConfirmModal';
import { SceneManager } from '../services/SceneManager';
import { SceneCardComponent } from '../components/SceneCard';
import { FiltersComponent } from '../components/Filters';
import { InspectorComponent } from '../components/Inspector';
import { QuickAddModal } from '../components/QuickAddModal';
import { renderViewSwitcher } from '../components/ViewSwitcher';
import { VirtualScroller } from '../components/VirtualScroller';
import { enableDragToPan } from '../components/DragToPan';
import { SplitSceneModal, MergeSceneModal } from '../components/SplitMergeModals';
import { isMobile, applyMobileClass, enableTouchDrag } from '../components/MobileAdapter';
import { BOARD_VIEW_TYPE } from '../constants';
import { cleanStickyNoteColor, resolveStickyNoteColors, resolveStickyNoteFontColor } from '../settings';
import { attachTooltip } from '../components/Tooltip';
import { resolveImagePath } from '../components/ImagePicker';
import { CorkboardCanvasService, type CorkboardPos } from '../services/CorkboardCanvasService';
import type SceneCardsPlugin from '../main';
import { compareActChapter, parseActChapterInput, getActDisplayLabel } from '../utils/actChapter';
import { t } from '../utils/i18n';

type BoardMode = 'kanban' | 'corkboard';

/**
 * Board View - Kanban-style scene card board
 */
export class BoardView extends ItemView {
    private plugin: SceneCardsPlugin;
    private sceneManager: SceneManager;
    private cardComponent: SceneCardComponent;
    private filtersComponent: FiltersComponent | null = null;
    private inspectorComponent: InspectorComponent | null = null;
    private currentFilter: SceneFilter = { activeState: 'active' };
    private currentSort: SortConfig = { field: 'sequence', direction: 'asc' };
    private groupBy: BoardGroupBy = 'act';
    private selectedScene: Scene | null = null;
    private selectedScenes: Set<string> = new Set();
    private boardEl: HTMLElement | null = null;
    private bulkBarEl: HTMLElement | null = null;
    private rootContainer: HTMLElement | null = null;
    private _pendingRefresh: number | null = null;
    private boardMode: BoardMode = 'corkboard';
    private corkboardPositions: Map<string, { x: number; y: number; z: number; w?: number; h?: number }> = new Map();
    private corkboardJustDragged: Set<string> = new Set();
    private corkboardPersistTimer: number | null = null;
    private corkboardLoadedProjectFile: string | null = null;
    private _corkboardProjectLoaded = false;
    private dragToPanCleanup: (() => void) | null = null;
    private corkboardInteractionCleanup: (() => void) | null = null;
    private corkboardCamera = { x: 220, y: 140, zoom: 1 };
    /** Inertia animation frame handle */
    private corkboardInertiaRaf: number | null = null;
    /** Smooth zoom animation frame handle */
    private corkboardZoomRaf: number | null = null;
    /** Accumulated target zoom for smooth chasing */
    private corkboardZoomTarget: number | null = null;
    /** Pivot point (viewport-local) for current zoom gesture */
    private corkboardZoomPivot = { vx: 0, vy: 0 };
    private quickNoteLastCreatedAt = 0;
    private quickNoteChainIndex = 0;
    /** Active virtual scrollers — cleaned up on re-render */
    private scrollers: VirtualScroller<Scene>[] = [];
    /** Saved column scroll positions across refreshes (keyed by group title) */
    private columnScrollPositions: Map<string, number> = new Map();
    /**
     * File path of the scene whose corkboard note editor is currently
     * focused. While set, `refresh()` and `restoreColumnScrollPositions()`
     * skip their rebuild so the textarea isn't torn down mid-edit
     * (issue #190: editing a corkboard note at certain zoom levels kicked
     * focus out and hid the text being typed).
     */
    private editingNotePath: string | null = null;
    /** Corkboard notes the user has expanded this session (default: collapsed). */
    private expandedCorkboardNotes: Set<string> = new Set();
    /** Native Obsidian Canvas leaf hosted inside corkboard mode (ephemeral). */
    private corkboardCanvasLeaf: WorkspaceLeaf | null = null;
    /** Detached WorkspaceSplit that owns the embedded Canvas leaf. */
    private corkboardCanvasHostEl: HTMLElement | null = null;
    private corkboardCanvasFilePath: string | null = null;
    private corkboardCanvasService: CorkboardCanvasService;
    private corkboardCanvasResizeObserver: ResizeObserver | null = null;
    /** Unwrap native Canvas delete hooks installed for park-instead-of-delete. */
    private corkboardCanvasDeleteCleanup: (() => void) | null = null;
    /** Snapshot selection before Canvas toolbars clear it during a remove click. */
    private corkboardLastManagedSelectionPaths: string[] = [];
    /** When native Canvas host fails, fall back to the legacy DOM corkboard. */
    private corkboardNativeFailed = false;
    private corkboardCanvasSyncTimer: number | null = null;
    private corkboardGeometryCleanup: (() => void) | null = null;
    private corkboardPositionsPersistKey = '';
    /** Fingerprint of visible paths — remount Canvas when membership changes. */
    private corkboardVisibilityKey = '';
    /** Serialize native corkboard sync/mount so a later write cannot leave a stale live view. */
    private corkboardHostSyncChain: Promise<void> = Promise.resolve();

    constructor(leaf: WorkspaceLeaf, plugin: SceneCardsPlugin, sceneManager: SceneManager) {
        super(leaf);
        this.plugin = plugin;
        this.sceneManager = sceneManager;
        this.cardComponent = new SceneCardComponent(plugin);
        this.corkboardCanvasService = new CorkboardCanvasService(plugin.app, plugin);
        // Restore last used board mode and groupBy
        const s = plugin.settings;
        this.boardMode = s.lastBoardMode || (s.defaultBoardMode === 'kanban' ? 'kanban' : 'corkboard');
        this.groupBy = (s.lastBoardGroupBy as BoardGroupBy) || 'act';
    }

    getViewType(): string {
        return BOARD_VIEW_TYPE;
    }

    getDisplayText(): string {
        return this.plugin?.getActiveProjectDisplayName() || 'NarrativeLab';
    }

    getIcon(): string {
        return 'layout-grid';
    }

    async onOpen(): Promise<void> {
        this.plugin.storyLeaf = this.leaf;
        // Opening the board always starts with parked/inactive content hidden.
        this.currentFilter.activeState = 'active';
        const container = this.containerEl.children[1] as HTMLElement;
        container.empty();
        container.addClass('story-line-board-container');
        applyMobileClass(container);
        this.rootContainer = container;

        await this.sceneManager.initialize();
        this.renderView(container);
    }

    async onClose(): Promise<void> {
        if (this.corkboardInteractionCleanup) {
            this.corkboardInteractionCleanup();
            this.corkboardInteractionCleanup = null;
        }
        if (this.dragToPanCleanup) {
            this.dragToPanCleanup();
            this.dragToPanCleanup = null;
        }
        if (this.corkboardPersistTimer) {
            window.clearTimeout(this.corkboardPersistTimer);
            this.corkboardPersistTimer = null;
        }
        if (this.corkboardCanvasSyncTimer) {
            window.clearInterval(this.corkboardCanvasSyncTimer);
            this.corkboardCanvasSyncTimer = null;
        }
        if (this.corkboardGeometryCleanup) {
            try { this.corkboardGeometryCleanup(); } catch { /* ignore */ }
            this.corkboardGeometryCleanup = null;
        }
        await this.pullPositionsFromNativeCanvas();
        this.teardownNativeCorkboardCanvas();
        await this.persistCorkboardLayout();
    }

    /**
     * Render the entire board view
     */
    private renderView(container: HTMLElement): void {
        this.teardownNativeCorkboardCanvas();
        this.ensureCorkboardLayoutLoaded();
        container.empty();

        // Toolbar
        const toolbar = container.createDiv('story-line-toolbar');
        this.renderToolbar(toolbar);

        // Main content area (board + inspector)
        const mainArea = container.createDiv('story-line-main-area');

        // Filters
        const filterContainer = mainArea.createDiv('story-line-filters-container');
        filterContainer.toggleClass('is-corkboard-mode', this.boardMode === 'corkboard');
        filterContainer.toggleClass('is-kanban-mode', this.boardMode === 'kanban');
        this.filtersComponent = new FiltersComponent(
            filterContainer,
            this.sceneManager,
            (filter, sort) => {
                this.currentFilter = filter;
                this.currentSort = sort;
                // Filter chips / inactive toggle change corkboard membership.
                this.corkboardVisibilityKey = '';
                this.corkboardCanvasFilePath = null;
                this.refreshBoard();
            },
            this.plugin,
            {
                initialFilter: this.currentFilter,
                initialSort: this.currentSort,
            },
        );
        this.filtersComponent.render();

        // In Kanban mode, add Group by dropdown to the filter bar
        if (this.boardMode === 'kanban') {
            const filterBar = filterContainer.querySelector('.story-line-filter-bar') as HTMLElement | null;
            if (filterBar) {
                const searchWrapper = filterBar.querySelector('.story-line-search-wrapper');
                const groupContainer = createDiv('story-line-group-control');
                groupContainer.createSpan({ text: t('Group by: ') });
                const groupSelect = groupContainer.createEl('select', { cls: 'dropdown' });
                const groupOptions: { value: BoardGroupBy; label: string }[] = [
                    { value: 'act', label: 'Act' },
                    { value: 'chapter', label: 'Chapter' },
                    { value: 'status', label: 'Status' },
                    { value: 'pov', label: 'POV' },
                ];
                // Append user-defined scene custom fields (dropdown / multi-select only)
                if (this.plugin.fieldTemplates) {
                    const sceneTpls = this.plugin.fieldTemplates.getAll()
                        .filter(t => (t.category || 'character') === 'scene')
                        .filter(t => t.type === 'dropdown' || t.type === 'multi-select');
                    for (const tpl of sceneTpls) {
                        groupOptions.push({ value: `cf:${tpl.id}`, label: tpl.label });
                    }
                }
                groupOptions.forEach(opt => {
                    const option = groupSelect.createEl('option', { text: opt.label, value: opt.value });
                    if (opt.value === this.groupBy) option.selected = true;
                });
                groupSelect.addEventListener('change', () => {
                    this.groupBy = groupSelect.value as BoardGroupBy;
                    this.plugin.settings.lastBoardGroupBy = this.groupBy;
                    this.plugin.saveSettings();
                    this.refreshBoard();
                });
                if (searchWrapper && searchWrapper.nextSibling) {
                    filterBar.insertBefore(groupContainer, searchWrapper.nextSibling);
                } else {
                    filterBar.appendChild(groupContainer);
                }
            }
        }

        // Board
        this.boardEl = mainArea.createDiv('story-line-board');
        this.configureDragToPan();

        // Bulk action bar (hidden until 2+ selected)
        this.bulkBarEl = mainArea.createDiv('story-line-bulk-bar');
        this.bulkBarEl.setCssStyles({ display: 'none' });

        this.refreshBoard();

        // Inspector sidebar
        const inspectorEl = mainArea.createDiv('story-line-inspector-panel');
        inspectorEl.setCssStyles({ display: 'none' });
        this.inspectorComponent = new InspectorComponent(
            inspectorEl,
            this.plugin,
            this.sceneManager,
            {
                onEdit: (scene) => this.openScene(scene),
                onDelete: (scene) => this.deleteScene(scene),
                onRefresh: () => this.refreshBoard(),
                onStatusChange: async (scene, status) => {
                    await this.sceneManager.updateScene(scene.filePath, { status });
                    this.refreshBoard();
                },
            }
        );
    }

    /**
     * Render the toolbar
     */
    private renderToolbar(toolbar: HTMLElement): void {
        // Title + project selector row
        const titleRow = toolbar.createDiv('story-line-title-row');
        titleRow.createEl('h3', {
            cls: 'story-line-view-title',
            text: this.plugin.getActiveProjectDisplayName()
        });
        // project name shown in top-center only; no inline project selector here

        // View switcher tabs
        renderViewSwitcher(toolbar, BOARD_VIEW_TYPE, this.plugin, this.leaf);

        const controls = toolbar.createDiv('story-line-toolbar-controls is-board-controls');

        const modeToggle = controls.createDiv('story-line-board-mode-toggle');
        const corkboardBtn = modeToggle.createEl('button', {
            cls: `story-line-board-mode-btn ${this.boardMode === 'corkboard' ? 'active' : ''}`,
            text: t('Corkboard')
        });
        const kanbanBtn = modeToggle.createEl('button', {
            cls: `story-line-board-mode-btn ${this.boardMode === 'kanban' ? 'active' : ''}`,
            text: t('Kanban')
        });
        corkboardBtn.addEventListener('click', () => {
            if (this.boardMode !== 'corkboard') {
                this.boardMode = 'corkboard';
                this.corkboardNativeFailed = false; // retry native Canvas host
                this.plugin.settings.lastBoardMode = 'corkboard';
                this.plugin.saveSettings();
                if (this.rootContainer) this.renderView(this.rootContainer);
            }
        });
        kanbanBtn.addEventListener('click', () => {
            if (this.boardMode !== 'kanban') {
                this.boardMode = 'kanban';
                this.plugin.settings.lastBoardMode = 'kanban';
                this.plugin.saveSettings();
                if (this.rootContainer) this.renderView(this.rootContainer);
            }
        });

        if (this.boardMode === 'corkboard') {
            const toggleWrap = controls.createEl('label', { cls: 'sl-toggle-wrap' });
            toggleWrap.createSpan({ cls: 'sl-toggle-label', text: t('Scenes') });
            const cb = toggleWrap.createEl('input', { type: 'checkbox' });
            cb.checked = this.plugin.settings.showScenesInCorkboard;
            toggleWrap.createSpan({ cls: 'sl-toggle-track' });
            cb.addEventListener('change', async () => {
                this.plugin.settings.showScenesInCorkboard = cb.checked;
                await this.plugin.saveSettings();
                // Membership changed — force corkboard.canvas rewrite + remount.
                this.corkboardVisibilityKey = '';
                this.corkboardCanvasFilePath = null;
                this.refreshBoard();
            });
        }

        if (this.boardMode === 'kanban') {
            const notesToggleWrap = controls.createEl('label', { cls: 'sl-toggle-wrap' });
            notesToggleWrap.createSpan({ cls: 'sl-toggle-label', text: t('Notes') });
            const notesCb = notesToggleWrap.createEl('input', { type: 'checkbox' });
            notesCb.checked = this.plugin.settings.showNotesInKanban;
            notesToggleWrap.createSpan({ cls: 'sl-toggle-track' });
            notesCb.addEventListener('change', async () => {
                this.plugin.settings.showNotesInKanban = notesCb.checked;
                await this.plugin.saveSettings();
                this.refresh();
            });
        }

        // Add scene button — capture mode at creation time so the handler
        // always routes correctly even if boardMode changes between renders.
        const isCorkboardMode = this.boardMode === 'corkboard';
        const addBtn = controls.createEl('button', {
            cls: 'mod-cta story-line-add-btn',
            text: isCorkboardMode ? t('+ New Note') : t('+ New Scene')
        });
        addBtn.addEventListener('click', () => {
            if (isCorkboardMode) {
                void this.openQuickAddIdea();
            } else {
                this.openQuickAdd();
            }
        });

        // Issue #220 — "New Chapter" button, shown in Kanban mode when
        // grouping by chapter, so inserting a chapter is one click away.
        if (!isCorkboardMode && this.groupBy === 'chapter') {
            const addChBtn = controls.createEl('button', {
                cls: 'mod-cta story-line-add-btn',
                text: t('+ New Chapter')
            });
            addChBtn.addEventListener('click', async () => {
                const newNum = await this.sceneManager.insertChapter();
                await this.sceneManager.initialize();
                this.refreshBoard();
                new Notice(t('Added Chapter {n}. Group by Chapter to see it.', { n: newNum }));
            });
        }

        // Add image note button (corkboard only)
        if (this.boardMode === 'corkboard') {
            const imgBtn = controls.createEl('button', {
                cls: 'clickable-icon',
            });
            obsidian.setIcon(imgBtn, 'image-plus');
            attachTooltip(imgBtn, t('New Image Note'));
            imgBtn.addEventListener('click', () => {
                void this.openImageNotePicker();
            });

            const openCanvasBtn = controls.createEl('button', {
                cls: 'clickable-icon',
            });
            obsidian.setIcon(openCanvasBtn, 'external-link');
            attachTooltip(openCanvasBtn, t('Open corkboard Canvas in tab'));
            openCanvasBtn.addEventListener('click', () => {
                void this.openCorkboardCanvasInTab();
            });
        }

        // Icon button group
        const iconGroup = controls.createDiv('story-line-icon-group');

        // Act/chapter structure lives on the Order (次序) view, next to swimlanes.

        // Resequence button (kanban only)
        if (this.boardMode !== 'corkboard') {
            const reseqBtn = iconGroup.createEl('button', {
                cls: 'clickable-icon',
            });
            if (typeof obsidian.setIcon === 'function') {
                obsidian.setIcon(reseqBtn, 'list-ordered');
            } else {
                console.error('obsidian.setIcon is not defined when setting reseqBtn');
            }
            attachTooltip(reseqBtn, t('Resequence all scenes'));
            reseqBtn.addEventListener('click', async () => {
                // #118: sequence is a single, globally unique counter.
                // SceneManager.globalResequence() sorts by act → chapter →
                // current sequence and writes flat 1..N. `chapter` is left
                // untouched so existing chapter assignments are preserved.
                await this.sceneManager.globalResequence();
                await this.sceneManager.initialize();
                this.refreshBoard();
            });
        }

        // Undo button
        const undoBtn = iconGroup.createEl('button', {
            cls: 'clickable-icon',
        });
        obsidian.setIcon(undoBtn, 'undo');
        attachTooltip(undoBtn, t('Undo (Ctrl+Z)'));
        undoBtn.addEventListener('click', async () => {
            await this.sceneManager.undoManager.undo();
        });

        // Redo button
        const redoBtn = iconGroup.createEl('button', {
            cls: 'clickable-icon',
        });
        obsidian.setIcon(redoBtn, 'redo');
        attachTooltip(redoBtn, t('Redo (Ctrl+Shift+Z)'));
        redoBtn.addEventListener('click', async () => {
            await this.sceneManager.undoManager.redo();
        });

        // Refresh button
        const refreshBtn = iconGroup.createEl('button', {
            cls: 'clickable-icon',
        });
        if (typeof obsidian.setIcon === 'function') {
            obsidian.setIcon(refreshBtn, 'refresh-cw');
        } else {
            console.error('obsidian.setIcon is not defined when setting refreshBtn');
        }
        attachTooltip(refreshBtn, t('Refresh'));
        refreshBtn.addEventListener('click', async () => {
            await this.sceneManager.initialize();
            this.refreshBoard();
        });

        // Archive button
        const archiveBtn = iconGroup.createEl('button', {
            cls: 'clickable-icon',
        });
        obsidian.setIcon(archiveBtn, 'archive');
        attachTooltip(archiveBtn, t('Archived Scenes'));
        archiveBtn.addEventListener('click', () => this.openArchiveModal());

    }

    /**
     * Save scroll positions of all Kanban column bodies before a re-render.
     */
    private saveColumnScrollPositions(): void {
        this.columnScrollPositions.clear();
        if (!this.boardEl) return;
        const columns = this.boardEl.querySelectorAll('.story-line-column');
        columns.forEach((col) => {
            const group = col.getAttribute('data-group');
            const body = col.querySelector('.story-line-column-body') as HTMLElement | null;
            if (group && body) {
                this.columnScrollPositions.set(group, body.scrollTop);
            }
        });
    }

    /**
     * Restore previously saved scroll positions after a re-render.
     * Skipped while a corkboard note editor is focused (issue #190).
     */
    private restoreColumnScrollPositions(): void {
        if (this.editingNotePath) return;
        if (!this.boardEl || this.columnScrollPositions.size === 0) return;
        const columns = this.boardEl.querySelectorAll('.story-line-column');
        columns.forEach((col) => {
            const group = col.getAttribute('data-group');
            const body = col.querySelector('.story-line-column-body') as HTMLElement | null;
            if (group && body && this.columnScrollPositions.has(group)) {
                body.scrollTop = this.columnScrollPositions.get(group)!;
            }
        });
    }

    /**
     * Render the board columns
     */
    private renderBoard(): void {
        if (!this.boardEl) return;
        this.teardownNativeCorkboardCanvas();
        this.boardEl.removeClass('story-line-corkboard');
        this.boardEl.removeClass('is-native-canvas-host');
        this.boardEl.empty();

        // Destroy previous virtual scrollers
        for (const vs of this.scrollers) vs.destroy();
        this.scrollers = [];

        // Pass defined acts/chapters so empty containers still render as
        // drop targets (issue #220 — newly inserted chapters were invisible
        // until a scene was dragged into them).
        const definedActs = this.sceneManager.getDefinedActs();
        const definedChapters = this.sceneManager.getDefinedChapters();
        const groups = this.sceneManager.queryService.getScenesGroupedByWithEmpty(
            this.groupBy,
            this.currentFilter,
            this.currentSort,
            definedActs,
            definedChapters
        );

        // Sort group keys
        const sortedKeys = this.sortGroupKeys(Array.from(groups.keys()));

        if (sortedKeys.length === 0) {
            const empty = this.boardEl.createDiv('story-line-empty');
            empty.createEl('p', { text: t('No scenes found.') });
            empty.createEl('p', { text: t('Click "+ New Scene" to create your first scene, or check your Scene folder setting.') });
            return;
        }

        for (const key of sortedKeys) {
            let scenes = groups.get(key) || [];
            if (!this.plugin.settings.showNotesInKanban) {
                scenes = scenes.filter(scene => !this.isCorkboardNoteScene(scene));
                const isNoActColumn = this.groupBy === 'act' && key.trim().toLowerCase() === 'no act';
                if (isNoActColumn && scenes.length === 0) {
                    continue;
                }
            }
            this.renderColumn(this.boardEl, key, scenes);
        }
    }

    /**
     * Corkboard mode: host Obsidian's native Canvas editor
     * (`Canvas/{project title}.canvas`) inline — real CanvasView, not a DOM mock.
     * Falls back to the legacy DOM corkboard only if Canvas cannot be mounted.
     */
    private renderCorkboard(): void {
        if (!this.boardEl) return;
        for (const vs of this.scrollers) vs.destroy();
        this.scrollers = [];

        if (this.corkboardNativeFailed) {
            this.renderLegacyCorkboard();
            return;
        }

        void this.ensureNativeCorkboardHost();
    }

    private getVisibleCorkboardPaths(): string[] {
        let scenes = this.sceneManager.queryService.getFilteredScenes(this.currentFilter, this.currentSort);
        if (!this.plugin.settings.showScenesInCorkboard) {
            scenes = scenes.filter(scene => this.isCorkboardNoteScene(scene));
        }
        // Re-check vault frontmatter so a stale scene cache cannot keep parked
        // items on the corkboard after `active: false` is written.
        const activeState = this.currentFilter.activeState ?? 'active';
        if (activeState === 'active') {
            scenes = scenes.filter(scene => !this.isCorkboardPathInactive(scene.filePath, scene));
        } else if (activeState === 'inactive') {
            scenes = scenes.filter(scene => this.isCorkboardPathInactive(scene.filePath, scene));
        }
        const researchFiles = this.getCorkboardResearchFiles();
        return [
            ...scenes.map(s => s.filePath),
            ...researchFiles.map(r => r.file.path),
        ];
    }

    /** Prefer live metadata cache over an in-memory Scene snapshot for `active`. */
    private isCorkboardPathInactive(filePath: string, scene?: Scene): boolean {
        const file = this.app.vault.getAbstractFileByPath(filePath);
        if (file instanceof TFile) {
            const fm = this.app.metadataCache.getFileCache(file)?.frontmatter;
            if (fm && Object.prototype.hasOwnProperty.call(fm, 'active')) {
                return fm.active !== true && fm.active !== 'true' && fm.active !== 1;
            }
            if (fm && Object.prototype.hasOwnProperty.call(fm, 'inactive')) {
                return fm.inactive === true || fm.inactive === 'true' || fm.inactive === 1;
            }
        }
        return scene?.inactive === true;
    }

    private positionsRecordFromMap(): Record<string, CorkboardPos> {
        const payload: Record<string, CorkboardPos> = {};
        for (const [path, pos] of this.corkboardPositions.entries()) {
            payload[path] = {
                x: pos.x,
                y: pos.y,
                z: pos.z,
                ...(pos.w ? { w: pos.w } : {}),
                ...(pos.h ? { h: pos.h } : {}),
            };
        }
        return payload;
    }

    private teardownNativeCorkboardCanvas(): void {
        if (this.corkboardCanvasDeleteCleanup) {
            try { this.corkboardCanvasDeleteCleanup(); } catch { /* ignore */ }
            this.corkboardCanvasDeleteCleanup = null;
        }
        if (this.corkboardGeometryCleanup) {
            try { this.corkboardGeometryCleanup(); } catch { /* ignore */ }
            this.corkboardGeometryCleanup = null;
        }
        if (this.corkboardCanvasSyncTimer) {
            window.clearInterval(this.corkboardCanvasSyncTimer);
            this.corkboardCanvasSyncTimer = null;
        }
        if (this.corkboardCanvasResizeObserver) {
            try { this.corkboardCanvasResizeObserver.disconnect(); } catch { /* ignore */ }
            this.corkboardCanvasResizeObserver = null;
        }
        if (this.corkboardCanvasLeaf) {
            const leaf = this.corkboardCanvasLeaf;
            this.corkboardCanvasLeaf = null;
            // Unload the Canvas view before detach — abrupt detach leaves Bases /
            // file embeds evaluating null file handles ("reading 'path'").
            try {
                void leaf.setViewState({ type: 'empty', state: {} });
            } catch { /* ignore */ }
            try { leaf.detach(); } catch { /* ignore */ }
        }
        // Keep hostEl when still connected so callers can remount into it.
        if (!this.corkboardCanvasHostEl?.isConnected) {
            this.corkboardCanvasHostEl = null;
        }
        this.corkboardCanvasFilePath = null;
    }

    private kickNativeCorkboardLayout(): void {
        const view = this.corkboardCanvasLeaf?.view as {
            onResize?: () => void;
            canvas?: { requestFrame?: () => void };
        } | null;
        try {
            view?.onResize?.();
            view?.canvas?.requestFrame?.();
        } catch { /* best effort */ }
    }

    private async pullPositionsFromNativeCanvas(): Promise<void> {
        const path = this.corkboardCanvasService.getCanvasPath();
        if (!path) return;
        try {
            const data = await this.corkboardCanvasService.readCanvas(path);
            const fromCanvas = this.corkboardCanvasService.positionsFromCanvas(data);
            for (const [filePath, pos] of Object.entries(fromCanvas)) {
                this.corkboardPositions.set(filePath, {
                    x: pos.x,
                    y: pos.y,
                    z: pos.z ?? 1,
                    ...(pos.w ? { w: pos.w } : {}),
                    ...(pos.h ? { h: pos.h } : {}),
                });
            }
        } catch (e) {
            console.warn('[NarrativeLab] Failed to read corkboard canvas positions:', e);
        }
    }

    /**
     * True while the user is typing inside a native Canvas file-card embed.
     * Remounting or rewriting membership mid-edit races Obsidian's autosave and
     * surfaces "UNKNOWN: unknown error, open" on Windows.
     */
    private isNativeCorkboardEditorFocused(): boolean {
        const host = this.corkboardCanvasHostEl;
        if (!host) return false;
        const active = host.ownerDocument?.activeElement as HTMLElement | null;
        if (!active || !host.contains(active)) return false;
        if (active.closest('textarea, input, [contenteditable="true"], .cm-editor, .cm-content, .markdown-source-view, .markdown-preview-view')) {
            return true;
        }
        return active.isContentEditable
            || active.tagName === 'TEXTAREA'
            || active.tagName === 'INPUT';
    }

    private async syncNativeCorkboardFile(
        opts?: { force?: boolean },
    ): Promise<{ file: TFile | null; membershipChanged: boolean; visible: string[] }> {
        this.ensureCorkboardLayoutLoaded();
        const canvasPath = this.corkboardCanvasService.getCanvasPath();
        if (!canvasPath) return { file: null, membershipChanged: false, visible: [] };

        const visible = this.getVisibleCorkboardPaths();
        // Auto-layout missing positions so new notes land on-canvas
        visible.forEach((path, index) => {
            if (this.corkboardPositions.has(path)) return;
            const col = index % 4;
            const row = Math.floor(index / 4);
            this.corkboardPositions.set(path, {
                x: col * 320 + (this.quickNoteChainIndex % 5) * 24,
                y: row * 230 + (this.quickNoteChainIndex % 5) * 24,
                z: this.corkboardPositions.size + 1,
                w: 280,
                h: 200,
            });
        });
        // Include display toggles in the fingerprint so Scenes on/off always remounts
        // even when the visible path set happens to look identical.
        const visibilityKey = [
            this.plugin.settings.showScenesInCorkboard ? 'scenes:1' : 'scenes:0',
            this.currentFilter.activeState ?? 'active',
            ...visible.slice().sort(),
        ].join('\0');
        const visibilityChanged = visibilityKey !== this.corkboardVisibilityKey;
        if (visibilityChanged) {
            this.corkboardVisibilityKey = visibilityKey;
            this.corkboardCanvasFilePath = null; // remount after toggle/filter
        }

        const existing = this.app.vault.getAbstractFileByPath(canvasPath);
        // Fast path: already hosting this canvas and membership unchanged — do not
        // rewrite the corkboard .canvas (that remounts every file-card preview).
        if (!opts?.force
            && !visibilityChanged
            && existing instanceof TFile
            && this.corkboardCanvasLeaf
            && this.corkboardCanvasFilePath === existing.path) {
            // Live Canvas can still drift from disk (unsaved in-memory nodes).
            this.pruneLiveCorkboardToVisible(visible);
            return { file: existing, membershipChanged: false, visible };
        }

        // Defer membership rewrite/remount while an embed editor is focused —
        // tearing down Canvas mid-keystroke locks the note on Windows.
        if (!opts?.force && this.isNativeCorkboardEditorFocused()) {
            return {
                file: existing instanceof TFile ? existing : null,
                membershipChanged: false,
                visible,
            };
        }

        // Capture live geometry, then detach BEFORE rewriting membership so a
        // dirty CanvasView cannot autosave stale nodes over the filtered file.
        this.captureLiveCorkboardPositions();
        if (this.corkboardCanvasLeaf) {
            this.teardownNativeCorkboardCanvas();
        } else {
            await this.pullPositionsFromNativeCanvas();
        }
        const file = await this.corkboardCanvasService.ensureCanvasFile(
            visible,
            this.positionsRecordFromMap()
        );
        // Always remount after a membership rewrite — vault.modify is suppressed for
        // open-view refresh, so Obsidian's embedded Canvas will not reload on its own.
        this.corkboardCanvasFilePath = null;
        if (this._corkboardProjectLoaded) this.schedulePersistCorkboardLayout();
        return { file, membershipChanged: true, visible };
    }

    /** Read file-card geometry from the live embedded Canvas when available. */
    private captureLiveCorkboardPositions(): void {
        const view = this.corkboardCanvasLeaf?.view as {
            canvas?: {
                nodes?: Map<string, unknown> | Record<string, unknown>;
            };
        } | null;
        const canvas = view?.canvas;
        if (!canvas?.nodes) return;
        const nodes = canvas.nodes instanceof Map
            ? [...canvas.nodes.values()]
            : Object.values(canvas.nodes);
        let z = 1;
        for (const node of nodes) {
            const path = this.getCanvasNodeFilePath(node);
            if (!path) continue;
            const n = node as { x?: unknown; y?: unknown; width?: unknown; height?: unknown };
            const x = Number(n.x);
            const y = Number(n.y);
            if (!Number.isFinite(x) || !Number.isFinite(y)) continue;
            const w = Number(n.width);
            const h = Number(n.height);
            this.corkboardPositions.set(normalizePath(path), {
                x,
                y,
                z: z++,
                ...(Number.isFinite(w) && w > 0 ? { w } : {}),
                ...(Number.isFinite(h) && h > 0 ? { h } : {}),
            });
        }
    }

    /**
     * Drop NL-managed file cards that are no longer in the filtered set from the
     * live Canvas instance. Used when remount is skipped or still catching up.
     */
    private pruneLiveCorkboardToVisible(visible: string[]): void {
        const view = this.corkboardCanvasLeaf?.view as {
            canvas?: {
                nodes?: Map<string, unknown> | Record<string, unknown>;
                removeNode?: (node: unknown) => void;
                requestFrame?: () => void;
            };
        } | null;
        const canvas = view?.canvas;
        if (!canvas?.nodes) return;

        const visibleSet = new Set(visible.map(p => normalizePath(p)));
        const nodes = canvas.nodes instanceof Map
            ? [...canvas.nodes.values()]
            : Object.values(canvas.nodes);
        let removed = false;
        for (const node of nodes) {
            const path = this.getCanvasNodeFilePath(node);
            if (!path) continue;
            const normalized = normalizePath(path);
            if (!this.corkboardCanvasService.isNlManagedPath(normalized)) continue;
            if (visibleSet.has(normalized)) continue;
            try {
                if (typeof canvas.removeNode === 'function') {
                    canvas.removeNode(node);
                } else if (canvas.nodes instanceof Map) {
                    const id = (node as { id?: string })?.id;
                    if (id) canvas.nodes.delete(id);
                }
                removed = true;
            } catch { /* best effort */ }
        }
        if (removed) {
            try { canvas.requestFrame?.(); } catch { /* best effort */ }
        }
    }

    private async ensureNativeCorkboardHost(): Promise<void> {
        const run = async (): Promise<void> => {
            await this.ensureNativeCorkboardHostUnqueued();
        };
        const queued = this.corkboardHostSyncChain.then(run, run);
        this.corkboardHostSyncChain = queued.then(() => undefined, () => undefined);
        await queued;
    }

    private async ensureNativeCorkboardHostUnqueued(): Promise<void> {
        if (!this.boardEl) return;

        if (this.corkboardInteractionCleanup) {
            this.corkboardInteractionCleanup();
            this.corkboardInteractionCleanup = null;
        }

        if (!this.boardEl.hasClass('is-native-canvas-host') || !this.corkboardCanvasHostEl?.isConnected) {
            this.teardownNativeCorkboardCanvas();
            this.boardEl.empty();
            this.boardEl.addClass('story-line-corkboard');
            this.boardEl.addClass('is-native-canvas-host');
            this.corkboardCanvasHostEl = this.boardEl.createDiv('story-line-corkboard-native-host');
        }

        try {
            const synced = await this.syncNativeCorkboardFile();
            if (!synced.file) throw new Error('No active project Canvas folder');
            await this.mountNativeCorkboardCanvas(
                this.corkboardCanvasHostEl!,
                synced.file,
                { forceReload: synced.membershipChanged },
            );
            this.pruneLiveCorkboardToVisible(synced.visible);
        } catch (err) {
            console.error('[NarrativeLab] Native corkboard Canvas failed:', err);
            const originalPreserved = err instanceof Error
                && err.message.includes('original file was not changed');
            if (!originalPreserved) {
                // Last resort: ephemeral WorkspaceLeaf constructor (unofficial).
                try {
                    const synced = await this.syncNativeCorkboardFile();
                    if (!synced.file || !this.boardEl) throw err;
                    this.boardEl.empty();
                    this.boardEl.addClass('story-line-corkboard');
                    this.boardEl.addClass('is-native-canvas-host');
                    this.corkboardCanvasHostEl = this.boardEl.createDiv('story-line-corkboard-native-host');
                    await this.mountNativeCorkboardCanvasViaLeafCtor(this.corkboardCanvasHostEl, synced.file);
                    this.pruneLiveCorkboardToVisible(synced.visible);
                    return;
                } catch (err2) {
                    console.error('[NarrativeLab] Corkboard Canvas leaf-ctor fallback failed:', err2);
                }
            }
            this.corkboardNativeFailed = true;
            this.teardownNativeCorkboardCanvas();
            this.corkboardCanvasHostEl = null;
            this.boardEl.empty();
            this.boardEl.removeClass('is-native-canvas-host');
            const banner = this.boardEl.createDiv('story-line-corkboard-native-fallback');
            banner.createEl('p', {
                text: originalPreserved
                    ? t('The corkboard Canvas is unreadable. NarrativeLab did not change it. Repair or restore the .canvas file, then reload the view.')
                    : t('Could not embed Obsidian Canvas. Using legacy corkboard. Open the .canvas file in a tab for full Canvas features.'),
            });
            const openBtn = banner.createEl('button', {
                cls: 'mod-cta',
                text: t('Open corkboard Canvas in tab'),
            });
            openBtn.addEventListener('click', () => { void this.openCorkboardCanvasInTab(); });
            this.renderLegacyCorkboard();
        }
    }

    /** Unofficial fallback when WorkspaceSplit embedding is unavailable. */
    private async mountNativeCorkboardCanvasViaLeafCtor(host: HTMLElement, file: TFile): Promise<void> {
        this.teardownNativeCorkboardCanvas();
        host.empty();

        const WorkspaceLeafCtor = (obsidian as unknown as {
            WorkspaceLeaf?: new (app: typeof this.app) => WorkspaceLeaf;
        }).WorkspaceLeaf;
        if (typeof WorkspaceLeafCtor !== 'function') {
            throw new Error('WorkspaceLeaf constructor unavailable');
        }

        let leaf: WorkspaceLeaf | null = null;
        leaf = new WorkspaceLeafCtor(this.app);
        await leaf.setViewState({
            type: 'canvas',
            state: { file: file.path },
            active: false,
        });
        const view = leaf.view as (InstanceType<typeof ItemView> & {
            containerEl?: HTMLElement;
            canvas?: { zoomToFit?: () => void };
        }) | null;
        const viewEl = view?.containerEl
            || (leaf as unknown as { containerEl?: HTMLElement }).containerEl;
        if (!viewEl) throw new Error('Canvas view element not found');
        if (view?.getViewType?.() !== 'canvas') {
            throw new Error(`Expected canvas view, got ${view?.getViewType?.() ?? 'none'}`);
        }

        host.addClass('is-live');
        host.appendChild(viewEl);
        this.corkboardCanvasLeaf = leaf;
        this.corkboardCanvasHostEl = host;
        this.corkboardCanvasFilePath = file.path;
        this.markCorkboardCanvasLeaf(leaf);
        this.installCorkboardCanvasParkHook(leaf);

        if (typeof ResizeObserver !== 'undefined') {
            this.corkboardCanvasResizeObserver = new ResizeObserver(() => {
                this.kickNativeCorkboardLayout();
            });
            this.corkboardCanvasResizeObserver.observe(host);
        }

        window.setTimeout(() => {
            this.kickNativeCorkboardLayout();
            try { view?.canvas?.zoomToFit?.(); } catch { /* best effort */ }
            this.installCorkboardCanvasParkHook(leaf);
        }, 80);
        this.schedulePullFromNativeCanvas();
    }

    private async mountNativeCorkboardCanvas(
        host: HTMLElement,
        file: TFile,
        opts?: { forceReload?: boolean },
    ): Promise<void> {
        if (!opts?.forceReload
            && this.corkboardCanvasLeaf
            && this.corkboardCanvasFilePath === file.path) {
            // Membership unchanged — keep the live view and just reflow.
            window.setTimeout(() => this.kickNativeCorkboardLayout(), 40);
            return;
        }

        this.teardownNativeCorkboardCanvas();
        host.empty();

        // Same embedding strategy as ManuscriptView / InfoPanel: a detached
        // WorkspaceSplit + createLeafInParent + openFile. This hosts the real
        // CanvasView (pan/zoom/edges/groups), unlike a static canvas embed.
        const split = new (WorkspaceSplit as unknown as new (
            workspace: unknown,
            dir: string
        ) => WorkspaceSplit)(this.app.workspace, 'vertical');
        const splitEl = (split as unknown as { containerEl: HTMLElement }).containerEl;
        splitEl.addClass('story-line-corkboard-native-split');
        host.addClass('is-live');
        host.appendChild(splitEl);

        let leaf: WorkspaceLeaf | null = null;
        try {
            leaf = this.app.workspace.createLeafInParent(split, 0);
            await leaf.openFile(file);

            const deferredLeaf = leaf as WorkspaceLeaf & {
                isDeferred?: boolean;
                loadIfDeferred?: () => Promise<void>;
            };
            if (deferredLeaf.isDeferred && typeof deferredLeaf.loadIfDeferred === 'function') {
                await deferredLeaf.loadIfDeferred();
            }

            const viewType = leaf.view?.getViewType?.();
            if (viewType !== 'canvas') {
                throw new Error(`Expected canvas view, got ${viewType ?? 'none'}`);
            }

            this.corkboardCanvasLeaf = leaf;
            this.corkboardCanvasHostEl = host;
            this.corkboardCanvasFilePath = file.path;
            this.markCorkboardCanvasLeaf(leaf);
            this.installCorkboardCanvasParkHook(leaf);

            if (typeof ResizeObserver !== 'undefined') {
                this.corkboardCanvasResizeObserver = new ResizeObserver(() => {
                    this.kickNativeCorkboardLayout();
                });
                this.corkboardCanvasResizeObserver.observe(host);
            }

            window.setTimeout(() => {
                this.kickNativeCorkboardLayout();
                const view = leaf?.view as { canvas?: { zoomToFit?: () => void } } | null;
                try { view?.canvas?.zoomToFit?.(); } catch { /* best effort */ }
                // Canvas may finish constructing after openFile — re-bind delete hook.
                this.installCorkboardCanvasParkHook(leaf);
            }, 80);

            // Periodically mirror native Canvas geometry back into board.json
            this.schedulePullFromNativeCanvas();
        } catch (err) {
            if (leaf) {
                try { leaf.detach(); } catch { /* ignore */ }
            }
            try { splitEl.remove(); } catch { /* ignore */ }
            this.corkboardCanvasLeaf = null;
            this.corkboardCanvasFilePath = null;
            throw err instanceof Error ? err : new Error(String(err));
        }
    }

    /** Tag corkboard Canvas leaves so CSS can hide Properties on file cards. */
    private markCorkboardCanvasLeaf(leaf: WorkspaceLeaf | null): void {
        const candidates: Array<HTMLElement | null | undefined> = [
            (leaf as unknown as { containerEl?: HTMLElement })?.containerEl
                ?.querySelector?.('.workspace-leaf-content') as HTMLElement | null,
            (leaf?.view as { containerEl?: HTMLElement } | null)?.containerEl,
            this.corkboardCanvasHostEl?.querySelector('.workspace-leaf-content') as HTMLElement | null,
            this.corkboardCanvasHostEl,
        ];
        for (const el of candidates) {
            el?.addClass('sl-corkboard-canvas-leaf');
        }
    }

    /**
     * On the project corkboard, Canvas "Remove"/Delete should park NL notes
     * (active: false) instead of deleting vault files or fighting membership sync.
     * Native groups / text / media must still be deletable — only exclusively
     * managed file-cards are parked; mixed selections park cards then run
     * native delete for the remaining non-managed nodes (e.g. Untitled group).
     */
    private installCorkboardCanvasParkHook(leaf: WorkspaceLeaf | null): void {
        if (this.corkboardCanvasDeleteCleanup) {
            try { this.corkboardCanvasDeleteCleanup(); } catch { /* ignore */ }
            this.corkboardCanvasDeleteCleanup = null;
        }
        const view = leaf?.view as {
            canvas?: {
                selection?: Set<unknown> | unknown[];
                nodes?: Map<string, unknown> | Record<string, unknown>;
                deleteSelection?: (...args: unknown[]) => unknown;
                [key: string]: unknown;
            };
            containerEl?: HTMLElement;
        } | null;
        const canvas = view?.canvas;
        if (!canvas || typeof canvas.deleteSelection !== 'function') return;

        const origDelete = canvas.deleteSelection.bind(canvas);
        let parking = false;
        let removeSelectionCaptured = false;
        let lastCapturedHadNonManaged = false;

        const parkThenSync = async (paths: string[]): Promise<void> => {
            if (parking || paths.length === 0) return;
            parking = true;
            try {
                for (const path of paths) {
                    await this.parkCorkboardPath(path);
                }
                this.corkboardLastManagedSelectionPaths = [];
                new Notice(
                    paths.length === 1
                        ? t('Parked as inactive. File kept in the vault.')
                        : t('Parked {n} items as inactive. Files kept in the vault.', { n: paths.length }),
                );
                this.corkboardVisibilityKey = '';
                await this.ensureNativeCorkboardHost();
            } finally {
                parking = false;
            }
        };

        const deselectManagedCards = (managedPaths: string[]): void => {
            const managed = new Set(managedPaths.map(p => normalizePath(p)));
            const selection = canvas.selection;
            if (!(selection instanceof Set) && !Array.isArray(selection)) return;
            const resolveNode = (value: unknown): unknown => {
                if (typeof value !== 'string') return value;
                if (canvas.nodes instanceof Map) return canvas.nodes.get(value) ?? value;
                if (canvas.nodes && typeof canvas.nodes === 'object') return canvas.nodes[value] ?? value;
                return value;
            };
            const keep: unknown[] = [];
            const selected = selection instanceof Set ? [...selection] : selection;
            for (const selectedValue of selected) {
                const node = resolveNode(selectedValue);
                const path = this.getCanvasNodeFilePath(node);
                if (path && managed.has(normalizePath(path))) continue;
                keep.push(selectedValue);
            }
            if (selection instanceof Set) {
                selection.clear();
                for (const item of keep) selection.add(item);
            } else {
                selection.length = 0;
                selection.push(...keep);
            }
        };

        const runDeleteOrPark = (...args: unknown[]): unknown => {
            const info = this.classifyCorkboardSelection(canvas);
            if (info.managedPaths.length > 0 && !info.hasNonManaged) {
                // Exclusively managed file cards → park, never vault-delete.
                void parkThenSync(info.managedPaths);
                return undefined;
            }
            if (info.managedPaths.length > 0 && info.hasNonManaged) {
                // Mixed: keep groups/text in selection, park managed cards.
                deselectManagedCards(info.managedPaths);
                const result = origDelete(...args);
                void parkThenSync(info.managedPaths);
                return result;
            }
            // Pure groups / text / media / unmanaged → native delete.
            return origDelete(...args);
        };

        canvas.deleteSelection = (...args: unknown[]) => runDeleteOrPark(...args);

        // Capture menu trash ("移除") in case it bypasses deleteSelection.
        const root = this.corkboardCanvasHostEl ?? view?.containerEl ?? null;
        const selectedInfo = (allowCapturedSnapshot = false): {
            managedPaths: string[];
            hasNonManaged: boolean;
        } => {
            const current = this.classifyCorkboardSelection(canvas);
            if (current.managedPaths.length > 0 || current.hasNonManaged) return current;
            if (allowCapturedSnapshot && removeSelectionCaptured) {
                return {
                    managedPaths: this.corkboardLastManagedSelectionPaths,
                    hasNonManaged: lastCapturedHadNonManaged,
                };
            }
            return { managedPaths: [], hasNonManaged: false };
        };
        const isRemoveControl = (element: HTMLElement | null): boolean => {
            const btn = element?.closest?.('button, .clickable-icon, .menu-item') as HTMLElement | null;
            if (!btn) return false;
            const label = [
                btn.getAttribute('aria-label'),
                btn.getAttribute('title'),
                btn.textContent,
            ].filter(Boolean).join(' ').toLowerCase();
            return /remove|delete|trash|移除|删除/.test(label)
                || !!btn.querySelector?.('.lucide-trash, .lucide-trash-2, svg.lucide-trash, svg.lucide-trash-2');
        };
        const onPointerDownCapture = (event: PointerEvent) => {
            // Capture the current selection synchronously only for the remove
            // control that is about to consume it. Other pointer actions must
            // clear stale snapshots when Canvas ends with no selection.
            const before = this.classifyCorkboardSelection(canvas);
            const removeControl = isRemoveControl(event.target as HTMLElement | null);
            if (removeControl) {
                this.corkboardLastManagedSelectionPaths = before.managedPaths;
                lastCapturedHadNonManaged = before.hasNonManaged;
                removeSelectionCaptured = before.managedPaths.length > 0 || before.hasNonManaged;
                return;
            }
            window.setTimeout(() => {
                const current = this.classifyCorkboardSelection(canvas);
                if (current.managedPaths.length > 0 || current.hasNonManaged) {
                    this.corkboardLastManagedSelectionPaths = current.managedPaths;
                    lastCapturedHadNonManaged = current.hasNonManaged;
                } else {
                    this.corkboardLastManagedSelectionPaths = [];
                    lastCapturedHadNonManaged = false;
                }
                removeSelectionCaptured = false;
            }, 0);
        };
        const onClickCapture = (event: Event) => {
            const target = event.target as HTMLElement | null;
            if (!isRemoveControl(target)) return;
            const info = selectedInfo(true);
            removeSelectionCaptured = false;
            // Only hijack the click when the selection is exclusively managed
            // cards. Groups / mixed selections must reach native Canvas delete.
            if (info.managedPaths.length === 0 || info.hasNonManaged) return;
            event.preventDefault();
            event.stopPropagation();
            void parkThenSync(info.managedPaths);
        };
        const onKeyDownCapture = (event: KeyboardEvent) => {
            if (event.key !== 'Delete' && event.key !== 'Backspace') return;
            const target = event.target as HTMLElement | null;
            if (target?.closest('input, textarea, [contenteditable="true"]')) return;
            const info = selectedInfo(false);
            // Exclusively managed → park here so native delete never vault-deletes.
            // Groups / mixed → let the event reach canvas.deleteSelection (patched).
            if (info.managedPaths.length === 0 || info.hasNonManaged) return;
            event.preventDefault();
            event.stopPropagation();
            void parkThenSync(info.managedPaths);
        };
        root?.addEventListener('pointerdown', onPointerDownCapture, true);
        root?.addEventListener('click', onClickCapture, true);
        root?.addEventListener('keydown', onKeyDownCapture, true);

        this.corkboardCanvasDeleteCleanup = () => {
            if (canvas.deleteSelection !== origDelete) {
                canvas.deleteSelection = origDelete;
            }
            root?.removeEventListener('pointerdown', onPointerDownCapture, true);
            root?.removeEventListener('click', onClickCapture, true);
            root?.removeEventListener('keydown', onKeyDownCapture, true);
        };
    }

    private classifyCorkboardSelection(canvas: {
        selection?: Set<unknown> | unknown[];
        nodes?: Map<string, unknown> | Record<string, unknown>;
    }): { managedPaths: string[]; hasNonManaged: boolean } {
        const selected = canvas.selection instanceof Set
            ? [...canvas.selection]
            : Array.isArray(canvas.selection) ? canvas.selection : [];
        const managedPaths: string[] = [];
        let hasNonManaged = false;
        const resolveNode = (value: unknown): unknown => {
            if (typeof value !== 'string') return value;
            if (canvas.nodes instanceof Map) return canvas.nodes.get(value) ?? value;
            if (canvas.nodes && typeof canvas.nodes === 'object') return canvas.nodes[value] ?? value;
            return value;
        };
        for (const selectedValue of selected) {
            const node = resolveNode(selectedValue);
            if (!node || typeof node !== 'object') {
                // Unknown selection entry — treat as non-managed so native delete can run.
                hasNonManaged = true;
                continue;
            }
            const path = this.getCanvasNodeFilePath(node);
            if (path && this.corkboardCanvasService.isNlManagedPath(path)) {
                managedPaths.push(path);
                continue;
            }
            // Groups, text, media, links, and unmanaged files.
            hasNonManaged = true;
        }

        // Compatibility fallback: some Canvas builds leave selection empty while
        // marking nodeEl as selected. Only use this when there is no explicit
        // selection — otherwise an empty "Untitled group" selection would be
        // mistaken for nearby focused cards and suppress native group delete.
        if (selected.length === 0 && canvas.nodes) {
            const nodes = canvas.nodes instanceof Map
                ? [...canvas.nodes.values()]
                : Object.values(canvas.nodes);
            for (const node of nodes) {
                if (!node || typeof node !== 'object') continue;
                const nodeEl = (node as { nodeEl?: HTMLElement; containerEl?: HTMLElement }).nodeEl
                    ?? (node as { containerEl?: HTMLElement }).containerEl;
                if (!nodeEl?.matches?.('.is-selected, .is-focused, .mod-active')) continue;
                const path = this.getCanvasNodeFilePath(node);
                if (path && this.corkboardCanvasService.isNlManagedPath(path)) {
                    managedPaths.push(path);
                } else {
                    hasNonManaged = true;
                }
            }
        }
        return {
            managedPaths: [...new Set(managedPaths)],
            hasNonManaged,
        };
    }

    private getCanvasNodeFilePath(node: unknown): string | null {
        if (!node || typeof node !== 'object') return null;
        const n = node as {
            file?: string | TFile | { path?: string };
            unknownData?: { file?: string };
            type?: string;
        };
        if (typeof n.file === 'string' && n.file.trim()) return normalizePath(n.file);
        if (n.file && typeof n.file === 'object' && typeof n.file.path === 'string') {
            return normalizePath(n.file.path);
        }
        if (typeof n.unknownData?.file === 'string' && n.unknownData.file.trim()) {
            return normalizePath(n.unknownData.file);
        }
        return null;
    }

    /** Mark a corkboard item inactive; keep the vault file. */
    private async parkCorkboardPath(path: string): Promise<void> {
        const normalized = normalizePath(path);
        const scene = this.sceneManager.getScene(normalized);
        if (scene) {
            if (!scene.inactive) {
                await this.sceneManager.updateScene(normalized, { inactive: true });
            }
            return;
        }
        const file = this.app.vault.getAbstractFileByPath(normalized);
        if (!(file instanceof TFile)) return;
        await this.app.fileManager.processFrontMatter(file, (fm) => {
            fm.active = false;
            delete fm.inactive;
        });
    }

    /** Mirror Canvas geometry into board.json after user interaction (not every 2s). */
    private schedulePullFromNativeCanvas(): void {
        this.ensureCorkboardGeometryListeners();
    }

    private ensureCorkboardGeometryListeners(): void {
        if (this.corkboardGeometryCleanup || !this.corkboardCanvasHostEl) return;
        const host = this.corkboardCanvasHostEl;
        const pull = () => {
            if (!this.corkboardCanvasLeaf || this.boardMode !== 'corkboard') return;
            if (this.isNativeCorkboardEditorFocused()) return;
            void (async () => {
                await this.pullPositionsFromNativeCanvas();
                await this.persistCorkboardLayout();
            })();
        };
        const onPointerUp = () => { pull(); };
        host.addEventListener('pointerup', onPointerUp, true);
        // Slow safety net while the tab is visible (was 2s; now 15s).
        this.corkboardCanvasSyncTimer = window.setInterval(pull, 15000);
        this.corkboardGeometryCleanup = () => {
            host.removeEventListener('pointerup', onPointerUp, true);
            if (this.corkboardCanvasSyncTimer) {
                window.clearInterval(this.corkboardCanvasSyncTimer);
                this.corkboardCanvasSyncTimer = null;
            }
        };
    }

    private async openCorkboardCanvasInTab(): Promise<void> {
        try {
            const synced = await this.syncNativeCorkboardFile();
            if (!synced.file) {
                new Notice(t('No active project'));
                return;
            }
            const leaf = this.app.workspace.getLeaf('tab');
            await leaf.openFile(synced.file);
            this.markCorkboardCanvasLeaf(leaf);
            // Canvas may rebuild its content after openFile — re-tag shortly after.
            window.setTimeout(() => this.markCorkboardCanvasLeaf(leaf), 100);
        } catch (e) {
            new Notice(t('Could not open corkboard Canvas: ') + String(e));
        }
    }

    /** Legacy DOM corkboard (pre-native Canvas). Kept as fallback. */
    private renderLegacyCorkboard(): void {
        if (!this.boardEl) return;

        if (this.corkboardInteractionCleanup) {
            this.corkboardInteractionCleanup();
            this.corkboardInteractionCleanup = null;
        }

        // When falling back mid-host, preserve banner if present
        const banner = this.boardEl.querySelector('.story-line-corkboard-native-fallback');
        this.boardEl.empty();
        this.boardEl.addClass('story-line-corkboard');
        if (banner) this.boardEl.appendChild(banner);

        // Destroy previous virtual scrollers (used by Kanban mode)
        for (const vs of this.scrollers) vs.destroy();
        this.scrollers = [];

        let scenes = this.sceneManager.queryService.getFilteredScenes(this.currentFilter, this.currentSort);
        if (!this.plugin.settings.showScenesInCorkboard) {
            scenes = scenes.filter(scene => this.isCorkboardNoteScene(scene));
        }
        const activeState = this.currentFilter.activeState ?? 'active';
        if (activeState === 'active') {
            scenes = scenes.filter(scene => !this.isCorkboardPathInactive(scene.filePath, scene));
        } else if (activeState === 'inactive') {
            scenes = scenes.filter(scene => this.isCorkboardPathInactive(scene.filePath, scene));
        }
        const researchFiles = this.getCorkboardResearchFiles();
        // Only render nodes for visible scenes, but keep positions for
        // filtered-out scenes so they don't lose their layout.

        const currentMaxZ = () => {
            let max = 0;
            for (const pos of this.corkboardPositions.values()) {
                if ((pos.z ?? 0) > max) max = pos.z ?? 0;
            }
            return max;
        };

        if (scenes.length === 0 && researchFiles.length === 0) {
            const empty = this.boardEl.createDiv('story-line-empty');
            empty.createEl('p', { text: t('No scenes found.') });
            empty.createEl('p', { text: t('Click "+ New Scene" to create your first scene, or adjust your filters.') });
            return;
        }

        const viewport = this.boardEl.createDiv('story-line-corkboard-viewport');
        const canvas = viewport.createDiv('story-line-corkboard-canvas');

        this.corkboardInteractionCleanup = this.enableCorkboardCameraInteraction(viewport, canvas);
        this.applyCorkboardCamera(canvas);

        // ── Drag-and-drop images onto the corkboard ──
        this.attachCorkboardImageDrop(viewport);

        scenes.forEach((scene, index) => {
          try {
            const existing = this.corkboardPositions.get(scene.filePath);
            const col = index % 4;
            const row = Math.floor(index / 4);
            const pos = existing || {
                x: col * 320,
                y: row * 230,
                z: currentMaxZ() + 1,
            };
            if (!existing) {
                this.corkboardPositions.set(scene.filePath, pos);
                if (this._corkboardProjectLoaded) this.schedulePersistCorkboardLayout();
            } else if (!Number.isFinite(existing.z)) {
                pos.z = currentMaxZ() + 1;
                this.corkboardPositions.set(scene.filePath, pos);
                if (this._corkboardProjectLoaded) this.schedulePersistCorkboardLayout();
            }

            const node = canvas.createDiv('story-line-corkboard-node');
            node.setCssStyles({
                left: `${pos.x}px`,
                top: `${pos.y}px`,
                zIndex: String(pos.z ?? 1),
                ...(pos.w && pos.w > 0 ? { width: `${pos.w}px` } : {}),
            });
            if (this.isCorkboardNoteScene(scene)) {
                node.addClass('story-line-corkboard-note-node');
            }

            const cardEl = this.cardComponent.render(scene, node, {
                compact: false,
                onSelect: (s, event) => {
                    if (this.corkboardJustDragged.has(s.filePath)) return;
                    this.selectScene(s, event);
                },
                onDoubleClick: (s) => {
                    if (this.isCorkboardNoteScene(s)) return;
                    this.openScene(s);
                },
                onContextMenu: (s, event) => {
                    if (this.isCorkboardNoteScene(s)) {
                        this.showCorkboardNoteMenu(s, event);
                    } else {
                        this.showContextMenu(s, event);
                    }
                },
                draggable: false,
            });
            cardEl.addClass('story-line-corkboard-card');

            if (this.selectedScenes.has(scene.filePath)) {
                cardEl.addClass('selected');
            }

            // Persisted height only applies while the note is expanded.
            // Collapsed notes stay title-sized (default); expand restores height.
            if (
                pos.h && pos.h > 0
                && this.isCorkboardNoteScene(scene)
                && this.expandedCorkboardNotes.has(scene.filePath)
            ) {
                cardEl.setCssStyles({ height: `${pos.h}px` });
            }

            this.attachCorkboardNoteEditor(cardEl, scene);

            this.attachCorkboardDrag(node, scene.filePath);
          } catch (err) {
            console.error(`[NarrativeLab] Failed to render corkboard scene "${scene.filePath}":`, err);
          }
        });

        researchFiles.forEach((item, researchIndex) => {
            const index = scenes.length + researchIndex;
            const existing = this.corkboardPositions.get(item.file.path);
            const col = index % 4;
            const row = Math.floor(index / 4);
            const pos = existing || {
                x: col * 320,
                y: row * 230,
                z: currentMaxZ() + 1,
            };
            if (!existing) {
                this.corkboardPositions.set(item.file.path, pos);
                if (this._corkboardProjectLoaded) this.schedulePersistCorkboardLayout();
            }

            const node = canvas.createDiv('story-line-corkboard-node story-line-corkboard-research-node');
            node.setCssStyles({
                left: `${pos.x}px`,
                top: `${pos.y}px`,
                zIndex: String(pos.z ?? 1),
                width: `${pos.w && pos.w > 0 ? pos.w : 220}px`,
            });

            const card = node.createDiv({
                cls: 'story-line-corkboard-research-card',
                attr: {
                    'data-path': item.file.path,
                    role: 'button',
                    tabindex: '0',
                    title: t('Double-click to open'),
                },
            });
            card.createDiv({
                cls: 'story-line-corkboard-research-title',
                text: item.title,
            });

            const selectCard = () => {
                if (this.corkboardJustDragged.has(item.file.path)) return;
                this.selectedScene = null;
                this.selectedScenes.clear();
                this.boardEl?.querySelectorAll('.selected').forEach(el => el.removeClass('selected'));
                card.addClass('selected');
                this.inspectorComponent?.hide();
                this.updateBulkBar();
            };
            const openFile = () => {
                void this.app.workspace.getLeaf('tab').openFile(item.file);
            };

            card.addEventListener('click', (event) => {
                event.stopPropagation();
                selectCard();
            });
            card.addEventListener('dblclick', (event) => {
                event.preventDefault();
                event.stopPropagation();
                openFile();
            });
            card.addEventListener('keydown', (event: KeyboardEvent) => {
                if (event.key !== 'Enter') return;
                event.preventDefault();
                openFile();
            });

            this.attachCorkboardDrag(node, item.file.path);
        });
    }

    private getCorkboardResearchFiles(): Array<{ file: TFile; title: string }> {
        const folder = this.sceneManager.activeProject?.researchFolder;
        if (!folder) return [];

        const normalizedFolder = normalizePath(folder).replace(/\/+$/, '');
        const root = this.app.vault.getAbstractFileByPath(normalizedFolder);
        if (!(root instanceof TFolder)) return [];

        const files: TFile[] = [];
        const walk = (dir: TFolder) => {
            for (const child of dir.children) {
                if (child instanceof TFile && child.extension.toLowerCase() === 'md') {
                    files.push(child);
                } else if (child instanceof TFolder) {
                    walk(child);
                }
            }
        };
        walk(root);

        const activeState = this.currentFilter.activeState ?? 'active';
        return files
            .filter(file => {
                const frontmatter = this.app.metadataCache.getFileCache(file)?.frontmatter;
                const active = Object.prototype.hasOwnProperty.call(frontmatter || {}, 'active')
                    ? frontmatter?.active === true
                    : frontmatter?.inactive !== true;
                const inactive = !active;
                if (activeState === 'active') return !inactive;
                if (activeState === 'inactive') return inactive;
                return true;
            })
            .map(file => {
                const frontmatter = this.app.metadataCache.getFileCache(file)?.frontmatter;
                const title = typeof frontmatter?.title === 'string' && frontmatter.title.trim()
                    ? frontmatter.title.trim()
                    : file.basename;
                return { file, title };
            })
            .sort((a, b) => a.title.localeCompare(b.title, undefined, { sensitivity: 'base' }));
    }

    private attachCorkboardNoteEditor(cardEl: HTMLElement, scene: Scene): void {
        // Only explicit corkboard notes get inline note editor
        if (!this.isCorkboardNoteScene(scene)) return;

        cardEl.addClass('story-line-corkboard-note-card');
        this.applyCorkboardNoteColor(cardEl, scene);

        cardEl.createDiv({
            cls: 'story-line-corkboard-note-filename',
            text: this.getCorkboardNoteFileName(scene),
        });

        // Canvas-style title bar. The chevron remains the explicit
        // NarrativeLab expand/collapse control; clicking the node selects it.
        const titleBar = cardEl.createDiv({
            cls: 'story-line-corkboard-note-titlebar',
        });
        const chevron = titleBar.createEl('button', {
            cls: 'story-line-corkboard-note-chevron clickable-icon',
            attr: { type: 'button' },
        });
        const titleText = titleBar.createSpan({ cls: 'story-line-corkboard-note-title-text' });
        titleText.setText(this.getCorkboardNoteDisplayTitle(scene));
        const collapsedPreview = cardEl.createDiv('story-line-corkboard-note-collapsed-preview');
        const refreshCollapsedPreview = () => {
            const text = this.getCorkboardNotePreviewText(scene);
            collapsedPreview.setText(text);
            collapsedPreview.toggleClass('is-empty', text.length === 0);
        };
        refreshCollapsedPreview();

        let isExpanded = this.expandedCorkboardNotes.has(scene.filePath);
        const applyExpandState = () => {
            cardEl.toggleClass('is-collapsed', !isExpanded);
            cardEl.toggleClass('is-expanded', isExpanded);
            obsidian.setIcon(chevron, isExpanded ? 'chevron-down' : 'chevron-right');
            titleBar.setAttribute('aria-expanded', String(isExpanded));
            titleBar.setAttribute('title', isExpanded ? t('Collapse note') : t('Expand note'));
            if (!isExpanded) {
                cardEl.setCssStyles({ height: '' });
            } else {
                const pos = this.corkboardPositions.get(scene.filePath);
                if (pos?.h && pos.h > 0) {
                    cardEl.setCssStyles({ height: `${pos.h}px` });
                }
            }
        };
        const setExpanded = (expanded: boolean) => {
            isExpanded = expanded;
            if (expanded) this.expandedCorkboardNotes.add(scene.filePath);
            else this.expandedCorkboardNotes.delete(scene.filePath);
            applyExpandState();
        };
        const toggleExpand = (event: Event) => {
            event.preventDefault();
            event.stopPropagation();
            if (this.corkboardJustDragged.has(scene.filePath)) return;
            setExpanded(!isExpanded);
        };
        chevron.addEventListener('click', toggleExpand);
        titleBar.addEventListener('click', toggleExpand);
        applyExpandState();

        // ── Image note rendering ───────────────────────────
        if (scene.corkboardNoteImage) {
            cardEl.addClass('story-line-corkboard-image-note');
            this.renderImageNoteContent(cardEl, scene);
            return;
        }

        const editorWrap = cardEl.createDiv('story-line-corkboard-note-editor');

        // Show plotgrid origin label if present
        if (scene.plotgridOrigin) {
            const originEl = editorWrap.createDiv('story-line-corkboard-note-origin');
            const originIcon = originEl.createSpan({ cls: 'story-line-corkboard-note-origin-icon' });
            obsidian.setIcon(originIcon, 'sticky-note');
            originEl.createSpan({ text: scene.plotgridOrigin });
        }

        const textarea = editorWrap.createEl('textarea', {
            cls: 'story-line-corkboard-note-text',
            attr: {
                placeholder: t('Write your note…'),
                rows: '6',
            },
        });
        textarea.value = scene.body || '';

        // Track the last known committed body so we can detect a suspicious
        // empty write caused by the textarea being cleared/detached mid-edit
        // (the root cause of disappearing corkboard notes — issue: notes lost
        // text while images survived). We never overwrite a non-empty body
        // with an empty value from a detached/stale textarea.
        let lastCommittedBody = scene.body || '';
        let editorAttached = true;

        const preview = editorWrap.createDiv('story-line-corkboard-note-preview markdown-rendered');
        let isEditing = false;
        let commitInProgress = false;
        let outsidePointerHandler: ((event: PointerEvent) => void) | null = null;

        const detachOutsideClose = () => {
            if (!outsidePointerHandler) return;
            activeDocument.removeEventListener('pointerdown', outsidePointerHandler, true);
            outsidePointerHandler = null;
        };

        /** Mark the editor as torn down so saveBody() refuses to write a stale value. */
        const markDetached = () => {
            editorAttached = false;
            detachOutsideClose();
            // Clear the active-edit flag so refreshes resume.
            if (this.editingNotePath === scene.filePath) {
                this.editingNotePath = null;
            }
        };

        const renderPreview = async () => {
            preview.empty();
            const source = textarea.value.trim();
            if (!source) {
                preview.createDiv({ cls: 'story-line-corkboard-note-preview-empty', text: t('Write your note…') });
                return;
            }
            await MarkdownRenderer.render(this.app, source, preview, scene.filePath, this);
            // Issue #226 — decode literal "&nbsp;" entities left in text nodes
            // by markdown-it's HTML encoding of U+00A0 (French guillemets).
            this.decodeNbspEntities(preview);
        };

        const placeCaretFromClick = (clientX: number, clientY: number) => {
            const doc = activeDocument as Document & {
                caretPositionFromPoint?: (x: number, y: number) => { offsetNode: Node; offset: number } | null;
            };

            let offset: number | null = null;
            const textNode = textarea.firstChild;

            if (typeof doc.caretPositionFromPoint === 'function') {
                const pos = doc.caretPositionFromPoint(clientX, clientY);
                if (pos && (pos.offsetNode === textNode || pos.offsetNode === textarea)) {
                    offset = pos.offset;
                }
            }

            if (offset === null) {
                const rect = textarea.getBoundingClientRect();
                const yRatio = Math.max(0, Math.min(1, (clientY - rect.top) / Math.max(1, rect.height)));
                offset = Math.round(textarea.value.length * yRatio);
            }

            const clamped = Math.max(0, Math.min(textarea.value.length, offset));
            textarea.setSelectionRange(clamped, clamped);
        };

        const setEditing = (editing: boolean, clickPoint?: { x: number; y: number }) => {
            isEditing = editing;
            cardEl.toggleClass('is-editing', editing);
            if (editing) {
                // Track the actively-edited note so refresh() skips rebuilds
                // that would tear down the textarea mid-edit (issue #190).
                this.editingNotePath = scene.filePath;
                preview.setCssStyles({ display: 'none' });
                textarea.setCssStyles({ display: 'block' });
                autoGrow();
                textarea.focus();
                if (clickPoint) {
                    window.requestAnimationFrame(() => {
                        placeCaretFromClick(clickPoint.x, clickPoint.y);
                    });
                }

                // Issue #178 — on iOS the soft keyboard pushes the note
                // off-screen. Pan the corkboard camera so the note sits in
                // the upper portion of the viewport (above the keyboard).
                this.panCorkboardToRevealNote(cardEl);

                outsidePointerHandler = (event: PointerEvent) => {
                    const target = event.target as Node | null;
                    if (!isEditing) return;
                    if (target && cardEl.contains(target)) return;
                    void commitAndClose();
                };
                window.setTimeout(() => {
                    if (outsidePointerHandler) {
                        activeDocument.addEventListener('pointerdown', outsidePointerHandler, true);
                    }
                }, 0);
            } else {
                detachOutsideClose();
                textarea.setCssStyles({ display: 'none' });
                preview.setCssStyles({ display: 'block' });
                // Clear the active-edit flag so refreshes resume. Only clear
                // if this editor still owns the flag (a newer editor may
                // have already set it).
                if (this.editingNotePath === scene.filePath) {
                    this.editingNotePath = null;
                }
            }
        };

        const autoGrow = () => {
            textarea.setCssStyles({
                height: 'auto'
            });
            textarea.setCssStyles({
                height: `${Math.max(96, textarea.scrollHeight)}px`,
            });
        };
        autoGrow();

        const saveBody = async () => {
            // If the editor DOM has been detached (e.g. by a refreshBoard
            // rebuild), the textarea may report a stale/empty value. Guard
            // against destroying a non-empty note body in that case.
            if (!editorAttached || !textarea.isConnected) return;
            const next = textarea.value;
            // Never overwrite a non-empty body with an empty value unless the
            // user explicitly cleared it within the same editing session —
            // protects against the disappearing-notes race.
            if (!next && lastCommittedBody) {
                // Treat as a no-op save; the in-memory body is preserved.
                return;
            }
            if (lastCommittedBody === next) return;
            await this.sceneManager.updateScene(scene.filePath, { body: next });
            scene.body = next;
            lastCommittedBody = next;
            titleText.setText(this.getCorkboardNoteDisplayTitle(scene));
            refreshCollapsedPreview();
        };

        const commitAndClose = async () => {
            if (!isEditing || commitInProgress) return;
            commitInProgress = true;
            await saveBody();
            await renderPreview();
            setEditing(false);
            commitInProgress = false;
        };

        textarea.addEventListener('input', () => {
            autoGrow();
        });

        textarea.addEventListener('blur', () => {
            void commitAndClose();
        });

        textarea.addEventListener('keydown', (event: KeyboardEvent) => {
            if (event.key === 'Escape') {
                event.preventDefault();
                void commitAndClose();
            }
        });

        preview.addEventListener('click', (event: MouseEvent) => {
            const target = event.target as HTMLElement;
            const link = target.closest('a');
            if (link) {
                const href = link.getAttribute('data-href') || link.getAttribute('href');
                if (href && link.hasClass('internal-link')) {
                    event.preventDefault();
                    event.stopPropagation();
                    this.app.workspace.openLinkText(href, scene.filePath, true);
                    return;
                }
                if (href && !href.startsWith('#')) {
                    return; // let external links behave normally
                }
            }
            if (isMobile) {
                if (!isExpanded) setExpanded(true);
                setEditing(true, { x: event.clientX, y: event.clientY });
            }
        });

        // Match native Canvas: one click selects/moves the node; double-click
        // enters text editing. Touch keeps the single-tap editor above.
        cardEl.addEventListener('dblclick', (event: MouseEvent) => {
            const target = event.target as HTMLElement;
            if (target.closest('a, button, input, textarea, select, img, .story-line-corkboard-note-resize-handle')) {
                return;
            }
            event.preventDefault();
            event.stopPropagation();
            if (!isExpanded) setExpanded(true);
            setEditing(true, { x: event.clientX, y: event.clientY });
        });

        void (async () => {
            await renderPreview();
            setEditing(false);
        })();

        // Watch for the card being removed from the DOM (happens on every
        // refreshBoard rebuild). When that occurs, flush any in-flight edit
        // synchronously and mark the editor detached so a later blur/pointer
        // handler cannot write a stale empty body over the real note content.
        const detachObserver = new MutationObserver(() => {
            if (!cardEl.isConnected) {
                detachObserver.disconnect();
                // Best-effort flush of the current textarea value before we
                // mark detached — but only if it still holds meaningful text.
                if (isEditing && textarea.isConnected && textarea.value && textarea.value !== lastCommittedBody) {
                    void (async () => {
                        await saveBody();
                        markDetached();
                    })();
                } else {
                    markDetached();
                }
            }
        });
        detachObserver.observe(cardEl.ownerDocument.body, { childList: true, subtree: true });

        const footer = editorWrap.createDiv('story-line-corkboard-note-actions');
        const convertBtn = footer.createEl('button', {
            cls: 'story-line-corkboard-convert-btn',
            attr: {
                title: t('Convert to scene'),
            },
        });
        obsidian.setIcon(convertBtn, 'clapperboard');
        convertBtn.addEventListener('click', async () => {
            await saveBody();
            await this.convertCorkboardNoteToScene(scene);
        });

        const resizeHandle = cardEl.createDiv('story-line-corkboard-note-resize-handle');
        resizeHandle.addEventListener('pointerdown', (e: PointerEvent) => {
            e.preventDefault();
            e.stopPropagation();

            const startY = e.clientY;
            const startX = e.clientX;
            const zoom = this.corkboardCamera.zoom || 1;
            const nodeEl = cardEl.closest('.story-line-corkboard-node') as HTMLElement | null;
            const startWidth = (nodeEl?.getBoundingClientRect().width || cardEl.getBoundingClientRect().width) / zoom;
            const startHeight = cardEl.getBoundingClientRect().height / zoom;
            const minWidth = 240;
            const minHeight = 220;

            const onMove = (moveEvent: PointerEvent) => {
                const nextWidth = Math.max(minWidth, startWidth + (moveEvent.clientX - startX) / zoom);
                const nextHeight = Math.max(minHeight, startHeight + (moveEvent.clientY - startY) / zoom);
                nodeEl?.setCssStyles({ width: `${nextWidth}px` });
                cardEl.setCssStyles({ height: `${nextHeight}px` });
            };

            const onUp = () => {
                window.removeEventListener('pointermove', onMove);
                window.removeEventListener('pointerup', onUp);
                const finalHeight = parseFloat(cardEl.style.height);
                const finalWidth = nodeEl ? parseFloat(nodeEl.style.width) : 0;
                if (finalHeight > 0 || finalWidth > 0) {
                    const pos = this.corkboardPositions.get(scene.filePath);
                    if (pos) {
                        if (finalWidth > 0) pos.w = finalWidth;
                        if (finalHeight > 0) pos.h = finalHeight;
                        this.schedulePersistCorkboardLayout();
                    }
                }
            };

            window.addEventListener('pointermove', onMove);
            window.addEventListener('pointerup', onUp);
        });
    }

    private async convertCorkboardNoteToScene(scene: Scene): Promise<void> {
        const oldPath = scene.filePath;
        const newPath = await this.sceneManager.moveNoteToSceneFolder(oldPath);
        if (!newPath) return;
        // Update corkboard position key if the file moved
        if (newPath !== oldPath) {
            const pos = this.corkboardPositions.get(oldPath);
            if (pos) {
                this.corkboardPositions.delete(oldPath);
                this.corkboardPositions.set(newPath, pos);
                this.schedulePersistCorkboardLayout();
            }
        }
        scene.corkboardNote = false;
        scene.plotgridOrigin = undefined;
        scene.filePath = newPath;
        this.refreshBoard();
    }

    /**
     * Duplicate a corkboard sticky note, preserving its body and color.
     */
    private async duplicateCorkboardNote(scene: Scene): Promise<void> {
        const file = await this.sceneManager.createScene({
            status: 'idea',
            corkboardNote: true,
            body: scene.body || '',
            corkboardNoteColor: scene.corkboardNoteColor,
        });

        // Position the duplicate offset from the original
        const origPos = this.corkboardPositions.get(scene.filePath);
        const pos = origPos
            ? {
                x: origPos.x + 30,
                y: origPos.y + 30,
                z: this.getCurrentMaxCorkboardZ() + 1,
                ...(origPos.w ? { w: origPos.w } : {}),
                ...(origPos.h ? { h: origPos.h } : {}),
            }
            : this.getNextQuickNotePosition();
        this.corkboardPositions.set(file.path, pos);
        this.schedulePersistCorkboardLayout();

        this.refreshBoard();
        new Notice(t('Note duplicated'));
    }

    private isCorkboardNoteScene(scene: Scene): boolean {
        const value: unknown = (scene as Scene & { corkboardNote?: unknown }).corkboardNote;
        if (value === true) return true;
        if (value === false || value === undefined || value === null) return false;
        if (typeof value === 'string') return value.trim().toLowerCase() === 'true';
        if (typeof value === 'number') return value === 1;
        return false;
    }

    /** Frontmatter title shown prominently inside the sticky note. */
    private getCorkboardNoteDisplayTitle(scene: Scene): string {
        return scene.title?.trim() || t('Untitled note');
    }

    /** Vault filename shown as the small Canvas-style label above the note. */
    private getCorkboardNoteFileName(scene: Scene): string {
        const name = scene.filePath.split('/').pop() || scene.filePath;
        return name.replace(/\.md$/i, '');
    }

    /** Plain-text excerpt shown below the title while a note is collapsed. */
    private getCorkboardNotePreviewText(scene: Scene): string {
        const source = scene.corkboardNoteImage
            ? (scene.corkboardNoteCaption || '')
            : (scene.body || '');
        const lines = source
            .split(/\r?\n/)
            .map(line => line
                .trim()
                .replace(/^#{1,6}\s+/, '')
                .replace(/^[-*+]\s+/, '')
                .replace(/^\d+\.\s+/, '')
                .replace(/^>\s*/, '')
                .replace(/!\[(.*?)\]\(.*?\)/g, '$1')
                .replace(/\[(.*?)\]\(.*?\)/g, '$1')
                .replace(/\[\[(?:[^|\]]+\|)?([^\]]+)\]\]/g, '$1')
                .replace(/[*_~`]/g, '')
                .replace(/\s+/g, ' ')
                .trim())
            .filter(line => line.length > 0);

        if (lines.length === 0) return '';

        // The first 60 characters are already represented by the title. Keep
        // any overflow, then continue with the remaining lines.
        const excerptParts = [
            ...(lines[0].length > 60 ? [lines[0].slice(60)] : []),
            ...lines.slice(1),
        ];
        return excerptParts.join(' ').trim().slice(0, 500);
    }

    private attachCorkboardDrag(node: HTMLElement, scenePath: string): void {
        let dragging = false;
        let startClientX = 0;
        let startClientY = 0;
        let startX = 0;
        let startY = 0;
        let moved = false;
        let dragRaf: number | null = null;
        let pendingX = 0;
        let pendingY = 0;

        const applyDragPosition = () => {
            dragRaf = null;
            node.setCssStyles({
                left: `${pendingX}px`,
                top: `${pendingY}px`,
            });
            const current = this.corkboardPositions.get(scenePath);
            this.corkboardPositions.set(scenePath, {
                ...current,
                x: pendingX,
                y: pendingY,
                z: current?.z ?? 1,
            });
        };

        const onPointerMove = (e: PointerEvent) => {
            if (!dragging) return;

            const dx = e.clientX - startClientX;
            const dy = e.clientY - startClientY;
            if (!moved && Math.max(Math.abs(dx), Math.abs(dy)) >= 6) {
                moved = true;
                // Capture only after threshold so a stationary click still expands.
                try { node.setPointerCapture(e.pointerId); } catch { /* */ }
                node.addClass('is-dragging');
            }
            if (!moved) return;

            const zoom = this.corkboardCamera.zoom || 1;
            pendingX = startX + dx / zoom;
            pendingY = startY + dy / zoom;

            if (dragRaf === null) {
                dragRaf = window.requestAnimationFrame(applyDragPosition);
            }

            e.preventDefault();
            e.stopPropagation();
        };

        const onPointerUp = (e: PointerEvent) => {
            if (!dragging) return;
            dragging = false;
            node.removeClass('is-dragging');
            if (node.hasPointerCapture(e.pointerId)) {
                node.releasePointerCapture(e.pointerId);
            }
            // Flush any pending rAF
            if (dragRaf !== null) {
                cancelAnimationFrame(dragRaf);
                dragRaf = null;
                applyDragPosition();
            }

            if (moved) {
                this.corkboardJustDragged.add(scenePath);
                window.setTimeout(() => this.corkboardJustDragged.delete(scenePath), 180);
                this.schedulePersistCorkboardLayout();
            }
        };

        node.addEventListener('pointerdown', (e: PointerEvent) => {
            if (e.button !== 0) return;

            const target = e.target as HTMLElement;
            if (target.closest('button, a, input, textarea, select, img')) return;
            if (target.closest('.story-line-corkboard-note-preview, .story-line-corkboard-note-caption, .story-line-corkboard-note-caption-empty')) return;

            const noteCard = target.closest('.story-line-corkboard-note-card') as HTMLElement | null;
            if (noteCard) {
                const rect = noteCard.getBoundingClientRect();
                const resizeGripSize = 20;
                const isInResizeCorner = e.clientX >= rect.right - resizeGripSize && e.clientY >= rect.bottom - resizeGripSize;
                if (isInResizeCorner) return;
            }

            dragging = true;
            moved = false;
            startClientX = e.clientX;
            startClientY = e.clientY;

            const pos = this.corkboardPositions.get(scenePath) || {
                x: parseFloat(node.style.left || '0') || 0,
                y: parseFloat(node.style.top || '0') || 0,
                z: Number.parseInt(node.style.zIndex || '1', 10) || 1,
            };
            startX = pos.x;
            startY = pos.y;
            // Defer capture/preventDefault until move threshold (see onPointerMove).
        });

        node.addEventListener('pointermove', onPointerMove);
        node.addEventListener('pointerup', onPointerUp);
        node.addEventListener('pointercancel', onPointerUp);
    }

    private applyCorkboardCamera(canvas: HTMLElement): void {
        canvas.setCssStyles({ transform: `translate(${this.corkboardCamera.x}px, ${this.corkboardCamera.y}px) scale(${this.corkboardCamera.zoom})` });
    }

    /**
     * Pan the corkboard camera so the given note card is visible in the
     * upper portion of the viewport. Used when a note enters edit mode on
     * mobile, where the soft keyboard would otherwise push it off-screen.
     * Issue #178. No-op on desktop or when the card is already well-placed.
     */
    private panCorkboardToRevealNote(cardEl: HTMLElement): void {
        if (!isMobile) return;
        const viewport = cardEl.closest('.story-line-corkboard-viewport') as HTMLElement | null;
        const canvas = cardEl.closest('.story-line-corkboard-canvas') as HTMLElement | null;
        if (!viewport || !canvas) return;

        const vpRect = viewport.getBoundingClientRect();
        const cardRect = cardEl.getBoundingClientRect();
        const zoom = this.corkboardCamera.zoom || 1;

        // Reserve roughly the bottom 45% of the viewport for the keyboard.
        const safeBottom = vpRect.top + vpRect.height * 0.55;
        const safeTop = vpRect.top + 24;

        const cardTop = cardRect.top;
        const cardBottom = cardRect.bottom;

        // Already visible within the safe zone — nothing to do.
        if (cardTop >= safeTop && cardBottom <= safeBottom) return;

        // Compute how far (in screen px) we need to shift so the card's top
        // lands ~24px below the viewport top. Translate that back through
        // the zoom to a camera-space delta.
        const desiredCardTop = safeTop + 8;
        const dyScreen = desiredCardTop - cardTop;
        const dyCamera = dyScreen / zoom;

        this.corkboardCamera.y += dyCamera;
        this.applyCorkboardCamera(canvas);
    }

    /**
     * Animate zoom smoothly toward targetZoom over ~80ms.
     * Keeps the world point under the cursor stationary.
     */
    private zoomCorkboardAt(canvas: HTMLElement, viewport: HTMLElement, clientX: number, clientY: number, nextZoom: number): void {
        this.corkboardZoomTarget = Math.max(0.35, Math.min(2.8, nextZoom));
        const rect = viewport.getBoundingClientRect();
        this.corkboardZoomPivot.vx = clientX - rect.left;
        this.corkboardZoomPivot.vy = clientY - rect.top;

        // If an animation loop is already running it will pick up the
        // updated target — no need to restart it.
        if (this.corkboardZoomRaf !== null) return;

        const step = () => {
            const target = this.corkboardZoomTarget!;
            const cur = this.corkboardCamera.zoom;
            // Exponential lerp — converges smoothly regardless of how
            // many wheel ticks pile up. Slightly snappier so trackpad
            // pinch/scroll zoom doesn't feel laggy behind the gesture.
            const lerpFactor = 0.32;
            const newZoom = cur + (target - cur) * lerpFactor;

            // Keep the world point under the cursor stationary
            const { vx, vy } = this.corkboardZoomPivot;
            const worldX = (vx - this.corkboardCamera.x) / cur;
            const worldY = (vy - this.corkboardCamera.y) / cur;
            this.corkboardCamera.zoom = newZoom;
            this.corkboardCamera.x = vx - worldX * newZoom;
            this.corkboardCamera.y = vy - worldY * newZoom;
            this.applyCorkboardCamera(canvas);

            // Stop when close enough to the target
            if (Math.abs(newZoom - target) > 0.001) {
                this.corkboardZoomRaf = window.requestAnimationFrame(step);
            } else {
                // Snap to exact target on last frame
                const worldX2 = (vx - this.corkboardCamera.x) / newZoom;
                const worldY2 = (vy - this.corkboardCamera.y) / newZoom;
                this.corkboardCamera.zoom = target;
                this.corkboardCamera.x = vx - worldX2 * target;
                this.corkboardCamera.y = vy - worldY2 * target;
                this.applyCorkboardCamera(canvas);
                this.corkboardZoomRaf = null;
                this.corkboardZoomTarget = null;
            }
        };
        this.corkboardZoomRaf = window.requestAnimationFrame(step);
    }

    private enableCorkboardCameraInteraction(viewport: HTMLElement, canvas: HTMLElement): () => void {
        let isPanning = false;
        let panPointerId: number | null = null;
        let panStartX = 0;
        let panStartY = 0;
        let camStartX = 0;
        let camStartY = 0;

        const touchPoints = new Map<number, { x: number; y: number }>();
        let pinchPrevDistance = 0;
        let pinchPrevCenter: { x: number; y: number } | null = null;

        const isBackgroundTarget = (target: EventTarget | null): boolean => {
            const el = target as HTMLElement | null;
            if (!el) return true;
            return !el.closest('.story-line-corkboard-node, button, a, input, textarea, select');
        };

        const getTouchPair = (): [{ x: number; y: number }, { x: number; y: number }] | null => {
            const vals = Array.from(touchPoints.values());
            if (vals.length < 2) return null;
            return [vals[0], vals[1]];
        };

        // Velocity tracking for subtle inertia
        let lastMoveTime = 0;
        let velocityX = 0;
        let velocityY = 0;
        const VELOCITY_DECAY = 0.88;   // how quickly inertia fades (lower = faster stop)
        const VELOCITY_THRESHOLD = 0.3; // stop when velocity is negligible

        const recordVelocity = (dx: number, dy: number) => {
            const now = performance.now();
            const dt = now - lastMoveTime;
            lastMoveTime = now;
            if (dt > 0 && dt < 100) {
                velocityX = dx / dt * 16; // normalize to ~16ms frame
                velocityY = dy / dt * 16;
            }
        };

        const startInertia = () => {
            if (Math.abs(velocityX) < VELOCITY_THRESHOLD && Math.abs(velocityY) < VELOCITY_THRESHOLD) return;
            const inertiaStep = () => {
                velocityX *= VELOCITY_DECAY;
                velocityY *= VELOCITY_DECAY;
                if (Math.abs(velocityX) < VELOCITY_THRESHOLD && Math.abs(velocityY) < VELOCITY_THRESHOLD) {
                    this.corkboardInertiaRaf = null;
                    return;
                }
                this.corkboardCamera.x += velocityX;
                this.corkboardCamera.y += velocityY;
                this.applyCorkboardCamera(canvas);
                this.corkboardInertiaRaf = window.requestAnimationFrame(inertiaStep);
            };
            this.corkboardInertiaRaf = window.requestAnimationFrame(inertiaStep);
        };

        const onPointerDown = (e: PointerEvent) => {
            if (!isBackgroundTarget(e.target)) return;

            // Stop any running inertia when user grabs the canvas
            if (this.corkboardInertiaRaf !== null) {
                cancelAnimationFrame(this.corkboardInertiaRaf);
                this.corkboardInertiaRaf = null;
            }
            velocityX = 0;
            velocityY = 0;
            lastMoveTime = performance.now();

            if (e.pointerType === 'touch') {
                touchPoints.set(e.pointerId, { x: e.clientX, y: e.clientY });

                if (touchPoints.size === 1) {
                    isPanning = true;
                    panPointerId = e.pointerId;
                    panStartX = e.clientX;
                    panStartY = e.clientY;
                    camStartX = this.corkboardCamera.x;
                    camStartY = this.corkboardCamera.y;
                    viewport.classList.add('is-panning');
                } else if (touchPoints.size >= 2) {
                    isPanning = false;
                    panPointerId = null;
                    viewport.classList.remove('is-panning');
                    const pair = getTouchPair();
                    if (pair) {
                        const [a, b] = pair;
                        pinchPrevDistance = Math.hypot(b.x - a.x, b.y - a.y);
                        pinchPrevCenter = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
                    }
                }

                if (!viewport.hasPointerCapture(e.pointerId)) {
                    viewport.setPointerCapture(e.pointerId);
                }
                e.preventDefault();
                return;
            }

            const canPanMouse = e.button === 0 || e.button === 1;
            if (!canPanMouse) return;

            isPanning = true;
            panPointerId = e.pointerId;
            panStartX = e.clientX;
            panStartY = e.clientY;
            camStartX = this.corkboardCamera.x;
            camStartY = this.corkboardCamera.y;
            viewport.classList.add('is-panning');

            viewport.setPointerCapture(e.pointerId);
            e.preventDefault();
        };

        const onPointerMove = (e: PointerEvent) => {
            if (e.pointerType === 'touch' && touchPoints.has(e.pointerId)) {
                touchPoints.set(e.pointerId, { x: e.clientX, y: e.clientY });
            }

            if (touchPoints.size >= 2) {
                const pair = getTouchPair();
                if (!pair) return;
                const [a, b] = pair;
                const center = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
                const dist = Math.hypot(b.x - a.x, b.y - a.y);

                if (pinchPrevDistance > 0) {
                    const zoomFactor = dist / pinchPrevDistance;
                    this.zoomCorkboardAt(canvas, viewport, center.x, center.y, this.corkboardCamera.zoom * zoomFactor);
                }

                if (pinchPrevCenter) {
                    this.corkboardCamera.x += center.x - pinchPrevCenter.x;
                    this.corkboardCamera.y += center.y - pinchPrevCenter.y;
                    this.applyCorkboardCamera(canvas);
                }

                pinchPrevDistance = dist;
                pinchPrevCenter = center;
                e.preventDefault();
                return;
            }

            if (!isPanning || panPointerId !== e.pointerId) return;

            const dx = e.clientX - panStartX;
            const dy = e.clientY - panStartY;
            const prevCamX = this.corkboardCamera.x;
            const prevCamY = this.corkboardCamera.y;
            this.corkboardCamera.x = camStartX + dx;
            this.corkboardCamera.y = camStartY + dy;
            // Track velocity for inertia
            recordVelocity(this.corkboardCamera.x - prevCamX, this.corkboardCamera.y - prevCamY);
            this.applyCorkboardCamera(canvas);
            e.preventDefault();
        };

        const onPointerUp = (e: PointerEvent) => {
            touchPoints.delete(e.pointerId);

            if (touchPoints.size < 2) {
                pinchPrevDistance = 0;
                pinchPrevCenter = null;
            }

            if (panPointerId === e.pointerId) {
                isPanning = false;
                panPointerId = null;
                viewport.classList.remove('is-panning');
                // Kick off subtle inertia
                startInertia();
            }

            if (viewport.hasPointerCapture(e.pointerId)) {
                viewport.releasePointerCapture(e.pointerId);
            }
        };

        const onWheel = (e: WheelEvent) => {
            // Normalize delta across trackpad (pixel) vs mouse wheel (line/page).
            let dy = e.deltaY;
            if (e.deltaMode === WheelEvent.DOM_DELTA_LINE) dy *= 16;
            else if (e.deltaMode === WheelEvent.DOM_DELTA_PAGE) dy *= 120;
            // Trackpad pinches send many tiny pixel deltas — old 0.0012 felt
            // sticky. 0.0020 is noticeably freer without jumping. Clamp so a
            // single big flick can't explode the zoom.
            const clamped = Math.max(-90, Math.min(90, dy));
            const zoomFactor = Math.exp((-clamped) * 0.002);
            this.zoomCorkboardAt(canvas, viewport, e.clientX, e.clientY, this.corkboardCamera.zoom * zoomFactor);
            e.preventDefault();
        };

        viewport.addEventListener('pointerdown', onPointerDown);
        viewport.addEventListener('pointermove', onPointerMove);
        viewport.addEventListener('pointerup', onPointerUp);
        viewport.addEventListener('pointercancel', onPointerUp);
        viewport.addEventListener('wheel', onWheel, { passive: false });

        return () => {
            viewport.removeEventListener('pointerdown', onPointerDown);
            viewport.removeEventListener('pointermove', onPointerMove);
            viewport.removeEventListener('pointerup', onPointerUp);
            viewport.removeEventListener('pointercancel', onPointerUp);
            viewport.removeEventListener('wheel', onWheel as EventListener);
            viewport.classList.remove('is-panning');
            if (this.corkboardInertiaRaf !== null) {
                cancelAnimationFrame(this.corkboardInertiaRaf);
                this.corkboardInertiaRaf = null;
            }
            if (this.corkboardZoomRaf !== null) {
                cancelAnimationFrame(this.corkboardZoomRaf);
                this.corkboardZoomRaf = null;
            }
        };
    }

    /** Force BoardView to reload corkboard positions from SceneManager on next refresh. */
    invalidateCorkboardLayout(): void {
        this.corkboardLoadedProjectFile = '__invalidated__';
    }

    /** Flush any pending corkboard position writes to SceneManager immediately. */
    async flushPendingCorkboardPersist(): Promise<void> {
        if (this.corkboardPersistTimer) {
            window.clearTimeout(this.corkboardPersistTimer);
            this.corkboardPersistTimer = null;
            await this.persistCorkboardLayout();
        }
    }

    private ensureCorkboardLayoutLoaded(): void {
        const projectPath = this.sceneManager.activeProject?.filePath ?? null;
        if (projectPath === this.corkboardLoadedProjectFile) return;

        // Cancel pending persist from a prior render to prevent auto-layout
        // defaults from overwriting real positions loaded from board.json.
        if (this.corkboardPersistTimer) {
            window.clearTimeout(this.corkboardPersistTimer);
            this.corkboardPersistTimer = null;
        }

        this.corkboardLoadedProjectFile = projectPath;
        this.corkboardPositions.clear();
        this._corkboardProjectLoaded = !!projectPath;

        const saved = this.sceneManager.getCorkboardPositions();
        for (const [path, pos] of Object.entries(saved)) {
            const x = Number(pos?.x);
            const y = Number(pos?.y);
            const z = Number(pos?.z);
            if (!Number.isFinite(x) || !Number.isFinite(y)) continue;
            const h = Number(pos?.h);
            const w = Number(pos?.w);
            this.corkboardPositions.set(path, {
                x,
                y,
                z: Number.isFinite(z) ? z : 1,
                ...(Number.isFinite(w) && w > 0 ? { w } : {}),
                ...(Number.isFinite(h) && h > 0 ? { h } : {}),
            });
        }
    }

    private schedulePersistCorkboardLayout(): void {
        if (this.corkboardPersistTimer) {
            window.clearTimeout(this.corkboardPersistTimer);
        }
        this.corkboardPersistTimer = window.setTimeout(() => {
            this.corkboardPersistTimer = null;
            void this.persistCorkboardLayout();
        }, 500);
    }

    private async persistCorkboardLayout(): Promise<void> {
        const payload: Record<string, { x: number; y: number; z?: number; w?: number; h?: number }> = {};
        for (const [path, pos] of this.corkboardPositions.entries()) {
            payload[path] = {
                x: pos.x,
                y: pos.y,
                z: pos.z,
                ...(pos.w ? { w: pos.w } : {}),
                ...(pos.h ? { h: pos.h } : {}),
            };
        }
        const key = JSON.stringify(payload);
        if (key === this.corkboardPositionsPersistKey) return;
        this.corkboardPositionsPersistKey = key;
        await this.sceneManager.setCorkboardPositions(payload);
    }

    private showCorkboardNoteMenu(scene: Scene, event: MouseEvent): void {
        const scenePath = scene.filePath;
        const menu = new Menu();

        menu.addItem(item => item
            .setTitle(t('Top'))
            .setIcon('chevrons-up')
            .onClick(() => { this.moveCorkboardLayer(scenePath, 'top'); }));

        menu.addItem(item => item
            .setTitle(t('Move up'))
            .setIcon('arrow-up')
            .onClick(() => { this.moveCorkboardLayer(scenePath, 'up'); }));

        menu.addItem(item => item
            .setTitle(t('Down'))
            .setIcon('arrow-down')
            .onClick(() => { this.moveCorkboardLayer(scenePath, 'down'); }));

        menu.addItem(item => item
            .setTitle(t('Bottom'))
            .setIcon('chevrons-down')
            .onClick(() => { this.moveCorkboardLayer(scenePath, 'bottom'); }));

        menu.addSeparator();

        const notePresets = resolveStickyNoteColors(this.plugin.settings);
        notePresets.forEach((preset) => {
            menu.addItem(item => item
                .setTitle(t('Color: {label}', { label: preset.label }))
                .setIcon('palette')
                .onClick(() => { void this.setCorkboardNoteColor(scene, preset.color); }));
        });

        menu.addItem(item => item
            .setTitle(t('Color: Custom…'))
            .setIcon('pipette')
            .onClick(() => { this.openCorkboardNoteColorModal(scene); }));

        menu.addItem(item => item
            .setTitle(t('Color: None'))
            .setIcon('rotate-ccw')
            .onClick(() => { void this.setCorkboardNoteColor(scene, undefined); }));

        menu.addItem(item => item
            .setTitle(t('Sticky note font color (light notes)'))
            .setIcon('sun')
            .onClick(() => { this.openStickyNoteFontColorModal('light'); }));

        menu.addItem(item => item
            .setTitle(t('Sticky note font color (dark notes)'))
            .setIcon('moon')
            .onClick(() => { this.openStickyNoteFontColorModal('dark'); }));

        menu.addSeparator();
        menu.addItem(item => item
            .setTitle(t('Duplicate Note'))
            .setIcon('copy')
            .onClick(() => { void this.duplicateCorkboardNote(scene); }));

        // Image note controls
        menu.addSeparator();
        if (scene.corkboardNoteImage) {
            menu.addItem(item => item
                .setTitle(t('Change Image…'))
                .setIcon('image')
                .onClick(() => { void this.changeNoteImage(scene); }));
            menu.addItem(item => item
                .setTitle(t('Remove Image'))
                .setIcon('image-off')
                .onClick(async () => {
                    await this.sceneManager.updateScene(scene.filePath, {
                        corkboardNoteImage: undefined,
                        corkboardNoteCaption: undefined,
                    });
                    scene.corkboardNoteImage = undefined;
                    scene.corkboardNoteCaption = undefined;
                    this.refreshBoard();
                }));
        } else {
            menu.addItem(item => item
                .setTitle(t('Set Image…'))
                .setIcon('image-plus')
                .onClick(() => { void this.changeNoteImage(scene); }));
        }

        menu.addItem(item => item
            .setTitle(t('Delete Note'))
            .setIcon('trash')
            .onClick(async () => {
                await this.deleteScene(scene);
            }));

        if (!scene.corkboardNoteImage) {
            menu.addSeparator();
            menu.addItem(item => item
                .setTitle(t('Convert to Scene'))
                .setIcon('clapperboard')
                .onClick(() => { void this.convertCorkboardNoteToScene(scene); }));
        }

        menu.showAtMouseEvent(event);
    }

    private moveCorkboardLayer(scenePath: string, direction: 'top' | 'up' | 'down' | 'bottom'): void {
        const target = this.corkboardPositions.get(scenePath);
        if (!target) return;

        const entries = Array.from(this.corkboardPositions.entries());
        if (entries.length < 2) return;

        entries.sort((a, b) => (a[1].z ?? 0) - (b[1].z ?? 0));
        const index = entries.findIndex(([path]) => path === scenePath);
        if (index < 0) return;

        if (direction === 'top' && index < entries.length - 1) {
            const [entry] = entries.splice(index, 1);
            entries.push(entry);
        } else if (direction === 'bottom' && index > 0) {
            const [entry] = entries.splice(index, 1);
            entries.unshift(entry);
        } else if (direction === 'up' && index < entries.length - 1) {
            const tmp = entries[index + 1];
            entries[index + 1] = entries[index];
            entries[index] = tmp;
        } else if (direction === 'down' && index > 0) {
            const tmp = entries[index - 1];
            entries[index - 1] = entries[index];
            entries[index] = tmp;
        } else {
            return;
        }

        let z = 1;
        for (const [path, pos] of entries) {
            this.corkboardPositions.set(path, { ...pos, z });
            z += 1;
        }

        this.schedulePersistCorkboardLayout();
        this.refreshBoard();
    }

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

    private darkenHexColor(hex: string, factor: number): string {
        const normalized = this.normalizeHexColor(hex) ?? '#F6EDB4';
        const r = Number.parseInt(normalized.slice(1, 3), 16);
        const g = Number.parseInt(normalized.slice(3, 5), 16);
        const b = Number.parseInt(normalized.slice(5, 7), 16);

        const scale = Math.max(0, Math.min(1, 1 - factor));
        const nr = Math.round(r * scale);
        const ng = Math.round(g * scale);
        const nb = Math.round(b * scale);

        const toHex = (n: number) => n.toString(16).padStart(2, '0').toUpperCase();
        return `#${toHex(nr)}${toHex(ng)}${toHex(nb)}`;
    }
    private applyCorkboardNoteColor(cardEl: HTMLElement, scene: Scene): void {
        const base = this.normalizeHexColor(scene.corkboardNoteColor);
        if (!base) {
            // Default: no fill — CSS border-only look.
            cardEl.classList.remove('is-tinted');
            cardEl.style.removeProperty('--sl-note-bg');
            cardEl.style.removeProperty('--sl-note-accent');
            cardEl.style.removeProperty('--sl-note-accent-strong');
            cardEl.style.removeProperty('--sl-note-text');
            return;
        }
        const cleaned = cleanStickyNoteColor(base);
        const accentSoft = this.darkenHexColor(cleaned, 0.24);
        const accentStrong = this.darkenHexColor(cleaned, 0.34);
        cardEl.classList.add('is-tinted');
        cardEl.style.setProperty('--sl-note-bg', cleaned);
        cardEl.style.setProperty('--sl-note-accent', accentSoft);
        cardEl.style.setProperty('--sl-note-accent-strong', accentStrong);
        const fontColor = resolveStickyNoteFontColor(this.plugin.settings, cleaned);
        cardEl.style.setProperty('--sl-note-text', fontColor);
    }

    private async setCorkboardNoteColor(scene: Scene, color: string | undefined): Promise<void> {
        const normalized = color ? cleanStickyNoteColor(this.normalizeHexColor(color) ?? color) : undefined;
        await this.sceneManager.updateScene(scene.filePath, {
            corkboardNoteColor: normalized,
        });
        scene.corkboardNoteColor = normalized;

        const card = this.boardEl?.querySelector(`[data-path="${CSS.escape(scene.filePath)}"]`) as HTMLElement | null;
        if (card) {
            this.applyCorkboardNoteColor(card, scene);
        }
    }

    private openCorkboardNoteColorModal(scene: Scene): void {
        const modal = new Modal(this.app);
        modal.titleEl.setText(t('Custom note color'));

        const current = this.normalizeHexColor(scene.corkboardNoteColor) ?? '#FFF8CC';
        const row = modal.contentEl.createDiv('story-line-note-color-modal-row');
        row.createEl('label', { text: t('Pick color') });
        const picker = row.createEl('input', {
            attr: {
                type: 'color',
                value: current,
            },
        });

        new Setting(modal.contentEl)
            .addButton(btn => {
                btn.setButtonText(t('Cancel')).onClick(() => modal.close());
            })
            .addButton(btn => {
                btn.setButtonText(t('Apply')).setCta().onClick(async () => {
                    await this.setCorkboardNoteColor(scene, picker.value);
                    modal.close();
                });
            });

        modal.open();
    }

    /**
     * Issue #205 — modal to pick a global font color for sticky-note text.
     * Two buckets are supported: 'light' (text on light note backgrounds)
     * and 'dark' (text on dark note backgrounds). The font color is a
     * global setting, but it is convenient to expose it from the note's
     * context menu so users discover it next to the background color
     * controls.
     */
    private openStickyNoteFontColorModal(bucket: 'light' | 'dark'): void {
        const modal = new Modal(this.app);
        modal.titleEl.setText(t(bucket === 'light'
            ? 'Sticky note font color (light notes)'
            : 'Sticky note font color (dark notes)'));

        const currentValue = bucket === 'light'
            ? this.plugin.settings.stickyNoteFontColorLight
            : this.plugin.settings.stickyNoteFontColorDark;
        const fallback = bucket === 'light' ? '#000000' : '#FFFFFF';
        const row = modal.contentEl.createDiv('story-line-note-color-modal-row');
        row.createEl('label', { text: t('Pick font color') });
        const picker = row.createEl('input', {
            attr: {
                type: 'color',
                value: currentValue && /^#[0-9a-fA-F]{6}$/.test(currentValue) ? currentValue : fallback,
            },
        });

        const desc = modal.contentEl.createEl('p', { cls: 'setting-item-description' });
        desc.textContent = t(bucket === 'light'
            ? 'Used on bright note backgrounds. Applies to all sticky notes. Use "Auto" to derive the text color from each note\'s background.'
            : 'Used on dark note backgrounds. Applies to all sticky notes. Use "Auto" to derive the text color from each note\'s background.');

        new Setting(modal.contentEl)
            .addButton(btn => {
                btn.setButtonText(t('Auto')).onClick(async () => {
                    if (bucket === 'light') {
                        this.plugin.settings.stickyNoteFontColorLight = '';
                    } else {
                        this.plugin.settings.stickyNoteFontColorDark = '';
                    }
                    await this.plugin.saveSettings();
                    this.plugin.refreshOpenViews();
                    modal.close();
                });
            })
            .addButton(btn => {
                btn.setButtonText(t('Cancel')).onClick(() => modal.close());
            })
            .addButton(btn => {
                btn.setButtonText(t('Apply')).setCta().onClick(async () => {
                    const v = picker.value.toUpperCase();
                    if (bucket === 'light') {
                        this.plugin.settings.stickyNoteFontColorLight = v;
                    } else {
                        this.plugin.settings.stickyNoteFontColorDark = v;
                    }
                    await this.plugin.saveSettings();
                    this.plugin.refreshOpenViews();
                    modal.close();
                });
            });

        modal.open();
    }

    /**
     * Render a single board column
     */
    private renderColumn(board: HTMLElement, title: string, scenes: Scene[]): void {
        const column = board.createDiv('story-line-column');
        column.setAttribute('data-group', title);

        // Column header
        const header = column.createDiv('story-line-column-header');

        // Build display title with label if available
        const displayTitle = this.getColumnDisplayTitle(title);
        header.createSpan({
            cls: 'story-line-column-title',
            text: `${displayTitle} (${scenes.length})`
        });

        // Show description subtitle if available (for act / chapter columns)
        const columnDesc = this.getColumnDescription(title);
        if (columnDesc) {
            header.createDiv({
                cls: 'story-line-column-description',
                text: columnDesc,
            });
        }

        // Right-click context menu on column header
        if (this.groupBy === 'act' || this.groupBy === 'chapter') {
            header.addEventListener('contextmenu', (e) => {
                e.preventDefault();
                this.showColumnContextMenu(e, title, scenes);
            });
        }

        // Column body (scrollable)
        const body = column.createDiv('story-line-column-body');

        // Helper: render a single scene card with drag-drop handlers
        const renderSceneCard = (scene: Scene, _index: number, parent: HTMLElement): HTMLElement => {
            const cardEl = this.cardComponent.render(scene, parent, {
                compact: this.plugin.settings.compactCardView,
                onSelect: (s, event) => {
                    this.selectScene(s, event);
                },
                onDoubleClick: (s) => this.openScene(s),
                onContextMenu: (s, event) => this.showContextMenu(s, event),
                draggable: true,
            });

            // --- Per-card drop zone for reordering within a column ---
            cardEl.addEventListener('dragover', (e) => {
                e.preventDefault();
                e.stopPropagation();
                const rect = cardEl.getBoundingClientRect();
                const midY = rect.top + rect.height / 2;
                cardEl.removeClass('drop-above', 'drop-below');
                if (e.clientY < midY) {
                    cardEl.addClass('drop-above');
                } else {
                    cardEl.addClass('drop-below');
                }
            });
            cardEl.addEventListener('dragleave', () => {
                cardEl.removeClass('drop-above', 'drop-below');
            });
            cardEl.addEventListener('drop', async (e) => {
                e.preventDefault();
                e.stopPropagation();
                cardEl.removeClass('drop-above', 'drop-below');
                body.removeClass('drag-over');
                const filePath = e.dataTransfer?.getData('text/scene-path');
                if (!filePath || filePath === scene.filePath) return;

                const rect = cardEl.getBoundingClientRect();
                const midY = rect.top + rect.height / 2;
                const insertBefore = e.clientY < midY;

                await this.handleDropOnCard(filePath, scene, title, scenes, insertBefore);
            });

            // Mobile: touch-based drag-and-drop
            if (isMobile) {
                enableTouchDrag(cardEl, scene.filePath, async (targetEl, insertBefore) => {
                    const targetPath = targetEl.getAttribute('data-path');
                    if (!targetPath || targetPath === scene.filePath) return;
                    const targetScene = this.sceneManager.getScene(targetPath);
                    if (!targetScene) return;

                    // Resolve the *target* column (may differ from source)
                    const targetColumn = targetEl.closest('.story-line-column');
                    const targetGroupKey = targetColumn?.getAttribute('data-group') || title;
                    const groups = this.sceneManager.queryService.getScenesGroupedByWithEmpty(
                        this.groupBy, this.currentFilter, this.currentSort
                    );
                    const targetScenes = groups.get(targetGroupKey) || scenes;

                    await this.handleDropOnCard(scene.filePath, targetScene, targetGroupKey, targetScenes, insertBefore);
                });
            }

            return cardEl;
        };

        // Use VirtualScroller for large columns to avoid DOM bloat
        const scroller = new VirtualScroller<Scene>({
            container: body,
            itemHeight: this.plugin.settings.compactCardView ? 60 : (isMobile ? 140 : 110),
            items: scenes,
            renderItem: renderSceneCard,
            overscan: 5,
            threshold: 40,
        });
        scroller.mount();
        this.scrollers.push(scroller);

        // Column-level drop zone (for empty columns or drop at end)
        body.addEventListener('dragover', (e) => {
            e.preventDefault();
            body.addClass('drag-over');
        });
        body.addEventListener('dragleave', (e) => {
            // Only remove if actually leaving the body
            if (!body.contains(e.relatedTarget as Node)) {
                body.removeClass('drag-over');
            }
        });
        body.addEventListener('drop', async (e) => {
            e.preventDefault();
            body.removeClass('drag-over');
            const filePath = e.dataTransfer?.getData('text/scene-path');
            if (filePath) {
                await this.handleDrop(filePath, title, scenes);
            }
        });

        // Add scene button at bottom
        const addBtn = column.createEl('button', {
            cls: 'story-line-column-add',
            text: t('+ Add Scene')
        });
        addBtn.addEventListener('click', () => this.openQuickAdd(title));
    }

    /**
     * Handle dropping a card onto another card for precise reordering.
     *
     * Uses the same approach as TimelineView: splice the dragged scene into the
     * new visual position, then renumber sequences within each (act, chapter)
     * group so the displayed order matches.
     */
    private async handleDropOnCard(
        draggedPath: string,
        targetScene: Scene,
        columnTitle: string,
        columnScenes: Scene[],
        insertBefore: boolean
    ): Promise<void> {
        const updates: Partial<Scene> = {};

        // Assign group value (act/chapter/status/pov) based on column
        switch (this.groupBy) {
            case 'act': {
                // Allow non-numeric acts like "1.1" or "Prologue" through
                // parseActChapterInput, which keeps integers as numbers and
                // anything else as a trimmed string.
                const match = columnTitle.match(/^Act\s+(.+)$/);
                if (match) updates.act = parseActChapterInput(match[1]);
                break;
            }
            case 'chapter': {
                const match = columnTitle.match(/^Chapter\s+(.+)$/);
                if (match) updates.chapter = parseActChapterInput(match[1]);
                break;
            }
            case 'status': {
                const cfg = getStatusConfig();
                const statusId = Object.entries(cfg).find(([, v]) => v.label === columnTitle)?.[0] || columnTitle.toLowerCase();
                updates.status = statusId as SceneStatus;
                break;
            }
            case 'pov':
                updates.pov = columnTitle !== 'No POV' ? columnTitle : undefined;
                break;
        }

        // Build the visual order (same multi-key sort the display uses)
        const ordered = [...columnScenes].sort((a, b) => {
            const actCmp = compareActChapter(a.act, b.act);
            if (actCmp !== 0) return actCmp;
            const chCmp = compareActChapter(a.chapter, b.chapter);
            if (chCmp !== 0) return chCmp;
            return (a.sequence ?? 0) - (b.sequence ?? 0);
        });

        // Remove dragged scene from list
        const dragIdx = ordered.findIndex(s => s.filePath === draggedPath);
        if (dragIdx >= 0) ordered.splice(dragIdx, 1);

        // Find target position and insert
        const targetIdx = ordered.findIndex(s => s.filePath === targetScene.filePath);
        const insertIdx = targetIdx === -1
            ? ordered.length
            : insertBefore ? targetIdx : targetIdx + 1;

        const draggedScene = columnScenes.find(s => s.filePath === draggedPath);
        if (draggedScene) ordered.splice(insertIdx, 0, draggedScene);

        // When grouped by act, adopt the chapter from the nearest neighbor
        // so the card actually lands where the user dropped it.
        if (this.groupBy === 'act' && draggedScene) {
            const newIdx = ordered.indexOf(draggedScene);
            let neighborChapter: number | string | undefined;
            if (newIdx > 0) {
                neighborChapter = ordered[newIdx - 1].chapter;
            } else if (newIdx < ordered.length - 1) {
                neighborChapter = ordered[newIdx + 1].chapter;
            }
            if (neighborChapter !== undefined) {
                // Preserve the neighbor's chapter type — keeping a string
                // value like "1.1" intact instead of forcing it through Number().
                updates.chapter = neighborChapter;
            }
        }

        // #118: apply the moved scene's column updates plus a temporary
        // fractional sequence that positions it next to the target within
        // its (act, chapter) bucket, then globally flatten 1..N so the
        // sequence stays unique across the whole project. We do NOT
        // renumber other scenes locally — the global pass owns that.
        const sceneUpdates: Partial<Scene> = { ...updates };
        const targetSeq = targetScene.sequence ?? 0;
        sceneUpdates.sequence = insertBefore ? targetSeq - 0.5 : targetSeq + 0.5;
        await this.sceneManager.updateScene(draggedPath, sceneUpdates);
        await this.sceneManager.globalResequence();

        this.refreshBoard();
    }

    /**
     * Handle drag-and-drop of a scene to a new column
     */
    private async handleDrop(filePath: string, columnTitle: string, columnScenes: Scene[]): Promise<void> {
        const updates: Partial<Scene> = {};

        // Parse column title to extract value
        switch (this.groupBy) {
            case 'act': {
                const match = columnTitle.match(/^Act\s+(.+)$/);
                if (match) updates.act = parseActChapterInput(match[1]);
                break;
            }
            case 'chapter': {
                const match = columnTitle.match(/^Chapter\s+(.+)$/);
                if (match) updates.chapter = parseActChapterInput(match[1]);
                break;
            }
            case 'status': {
                const cfg = getStatusConfig();
                const statusId = Object.entries(cfg).find(([, v]) => v.label === columnTitle)?.[0] || columnTitle.toLowerCase();
                updates.status = statusId as SceneStatus;
                break;
            }
            case 'pov': {
                updates.pov = columnTitle !== 'No POV' ? columnTitle : undefined;
                break;
            }
        }

        // Build visual order and append dragged scene at the end
        const ordered = [...columnScenes].sort((a, b) => {
            const actCmp = compareActChapter(a.act, b.act);
            if (actCmp !== 0) return actCmp;
            const chCmp = compareActChapter(a.chapter, b.chapter);
            if (chCmp !== 0) return chCmp;
            return (a.sequence ?? 0) - (b.sequence ?? 0);
        });

        // When grouped by act, adopt chapter from last scene in column
        if (this.groupBy === 'act' && ordered.length > 0) {
            const last = ordered[ordered.length - 1];
            // Preserve the chapter's original type (don't coerce "1.1" to a float).
            if (last.chapter !== undefined) updates.chapter = last.chapter;
        }

        // #118: position the moved scene after the last scene in its new
        // column with a fractional sequence, then globally renumber 1..N
        // so the project keeps a single unique sequence counter.
        const lastSeq = ordered.length > 0
            ? (ordered[ordered.length - 1].sequence ?? 0)
            : 0;
        updates.sequence = lastSeq + 0.5;

        await this.sceneManager.updateScene(filePath, updates);
        await this.sceneManager.globalResequence();
        this.refreshBoard();
    }

    /**
     * Select a scene (show in inspector). Ctrl/Cmd+click for multi-select.
     */
    private selectScene(scene: Scene, event?: MouseEvent): void {
        const isMultiSelect = event && (event.ctrlKey || event.metaKey);

        if (isMultiSelect) {
            // Toggle this scene in multi-selection
            if (this.selectedScenes.has(scene.filePath)) {
                this.selectedScenes.delete(scene.filePath);
                const card = this.boardEl?.querySelector(`[data-path="${CSS.escape(scene.filePath)}"]`);
                if (card) card.removeClass('selected');
            } else {
                this.selectedScenes.add(scene.filePath);
                const card = this.boardEl?.querySelector(`[data-path="${CSS.escape(scene.filePath)}"]`);
                if (card) card.addClass('selected');
            }
            this.selectedScene = scene;
        } else {
            // Single select — clear multi-selection
            this.selectedScenes.clear();
            this.boardEl?.querySelectorAll('.scene-card.selected').forEach(el => {
                el.removeClass('selected');
            });

            this.selectedScene = scene;
            this.selectedScenes.add(scene.filePath);

            // Highlight selected card
            const card = this.boardEl?.querySelector(`[data-path="${CSS.escape(scene.filePath)}"]`);
            if (card) card.addClass('selected');
        }

        // Show inspector for last clicked scene
        if (this.plugin.isSceneInspectorOpen()) {
            this.inspectorComponent?.hide();
            this.app.workspace.trigger('storyline:scene-focus', scene.filePath);
        } else {
            this.inspectorComponent?.show(scene);
        }

        // Show/hide bulk action bar
        this.updateBulkBar();
    }

    /**
     * Update the bulk action bar based on current selection
     */
    private updateBulkBar(): void {
        if (!this.bulkBarEl) return;

        if (this.selectedScenes.size < 2) {
            this.bulkBarEl.setCssStyles({ display: 'none' });
            return;
        }

        this.bulkBarEl.empty();
        this.bulkBarEl.setCssStyles({ display: 'flex' });

        const count = this.selectedScenes.size;
        this.bulkBarEl.createSpan({
            cls: 'bulk-bar-label',
            text: t('{count} scenes selected', { count })
        });

        // Bulk status change
        const statusBtn = this.bulkBarEl.createEl('button', {
            cls: 'bulk-bar-btn',
            text: t('Set Status')
        });
        const statusIcon = statusBtn.createSpan();
        obsidian.setIcon(statusIcon, 'check-circle');
        statusBtn.addEventListener('click', (e) => {
            const menu = new Menu();
            const statuses = getStatusOrder();
            statuses.forEach(status => {
                menu.addItem(item => {
                    item.setTitle(t(resolveStatusCfg(status).label))
                        .onClick(async () => {
                            for (const fp of this.selectedScenes) {
                                await this.sceneManager.updateScene(fp, { status });
                            }
                            new Notice(t('Updated status to "{status}" for {count} scenes', { status: t(String(status)), count }));
                            this.selectedScenes.clear();
                            this.refreshBoard();
                            this.updateBulkBar();
                        });
                });
            });
            menu.showAtMouseEvent(e);
        });

        // Bulk move to act
        const actBtn = this.bulkBarEl.createEl('button', {
            cls: 'bulk-bar-btn',
            text: t('Move to Act')
        });
        const actIcon = actBtn.createSpan();
        obsidian.setIcon(actIcon, 'folder');
        actBtn.addEventListener('click', (e) => {
            const menu = new Menu();
            const acts = this.sceneManager.getDefinedActs();
            if (acts.length === 0) {
                // Fallback: use acts found in scenes
                const actValues = this.sceneManager.queryService.getUniqueValues('act');
                actValues.forEach(act => {
                    menu.addItem(item => {
                        item.setTitle(t(getActDisplayLabel(act)))
                            .onClick(async () => {
                                for (const fp of this.selectedScenes) {
                                    await this.sceneManager.updateScene(fp, { act: Number(act) || act });
                                }
                                new Notice(t('Moved {count} scenes to {act}', { count, act: t(getActDisplayLabel(act)) }));
                                this.selectedScenes.clear();
                                this.refreshBoard();
                                this.updateBulkBar();
                            });
                    });
                });
            } else {
                acts.forEach(act => {
                    menu.addItem(item => {
                        item.setTitle(t(getActDisplayLabel(act)))
                            .onClick(async () => {
                                for (const fp of this.selectedScenes) {
                                    await this.sceneManager.updateScene(fp, { act });
                                }
                                new Notice(t('Moved {count} scenes to {act}', { count, act: t(getActDisplayLabel(act)) }));
                                this.selectedScenes.clear();
                                this.refreshBoard();
                                this.updateBulkBar();
                            });
                    });
                });
            }
            menu.showAtMouseEvent(e);
        });

        // Bulk add tag
        const tagBtn = this.bulkBarEl.createEl('button', {
            cls: 'bulk-bar-btn',
            text: t('Add Tag')
        });
        const tagIcon = tagBtn.createSpan();
        obsidian.setIcon(tagIcon, 'tag');
        tagBtn.addEventListener('click', (e) => {
            const menu = new Menu();
            const tags = this.sceneManager.getPlotlines();

            tags.forEach(tag => {
                menu.addItem(item => {
                    item.setTitle(tag)
                        .onClick(async () => {
                            for (const fp of this.selectedScenes) {
                                const scene = this.sceneManager.getScene(fp);
                                if (scene) {
                                    const newTags = [...(scene.tags || [])];
                                    if (!newTags.includes(tag)) {
                                        newTags.push(tag);
                                        await this.sceneManager.updateScene(fp, { tags: newTags });
                                    }
                                }
                            }
                            new Notice(t('Added tag "{tag}" to {count} scenes', { tag, count }));
                            this.selectedScenes.clear();
                            this.refreshBoard();
                            this.updateBulkBar();
                        });
                });
            });

            // Option to enter a new tag
            menu.addSeparator();
            menu.addItem(item => {
                item.setTitle(t('New tag…'))
                    .setIcon('plus')
                    .onClick(() => {
                        const inputModal = new Modal(this.app);
                        inputModal.titleEl.setText(t('New tag'));
                        const { contentEl } = inputModal;
                        const input = contentEl.createEl('input', { type: 'text', attr: { placeholder: t('Enter new tag') } });
                        input.setCssStyles({ width: '100%' });
                        const btnRow = contentEl.createDiv({ cls: 'modal-button-container' });
                        const okBtn = btnRow.createEl('button', { text: t('Add'), cls: 'mod-cta' });
                        const cancelBtn = btnRow.createEl('button', { text: t('Cancel') });
                        const submit = () => {
                            const newTag = input.value.trim();
                            inputModal.close();
                            if (!newTag) return;
                            (async () => {
                                for (const fp of this.selectedScenes) {
                                    const scene = this.sceneManager.getScene(fp);
                                    if (scene) {
                                        const tags = [...(scene.tags || [])];
                                        if (!tags.includes(newTag)) {
                                            tags.push(newTag);
                                            await this.sceneManager.updateScene(fp, { tags });
                                        }
                                    }
                                }
                                new Notice(t('Added tag "{tag}" to {count} scenes', { tag: newTag, count }));
                                this.selectedScenes.clear();
                                this.refreshBoard();
                                this.updateBulkBar();
                            })();
                        };
                        okBtn.addEventListener('click', submit);
                        cancelBtn.addEventListener('click', () => inputModal.close());
                        input.addEventListener('keydown', (ev) => { if (ev.key === 'Enter') submit(); });
                        inputModal.open();
                        window.setTimeout(() => input.focus(), 0);
                    });
            });

            menu.showAtMouseEvent(e);
        });

        // Bulk delete
        const deleteBtn = this.bulkBarEl.createEl('button', {
            cls: 'bulk-bar-btn bulk-bar-delete',
            text: t('Delete')
        });
        const deleteIcon = deleteBtn.createSpan();
        obsidian.setIcon(deleteIcon, 'trash');
        deleteBtn.addEventListener('click', async () => {
            openConfirmModal(this.app, {
                title: t('Delete Scenes'),
                message: t('Delete {count} scenes? This cannot be undone.', { count }),
                confirmLabel: t('Delete'),
                onConfirm: async () => {
                    for (const fp of this.selectedScenes) {
                        await this.sceneManager.deleteScene(fp);
                    }
                    new Notice(t('Deleted {count} scenes', { count }));
                    this.selectedScenes.clear();
                    this.refreshBoard();
                    this.updateBulkBar();
                },
            });
        });

        // Clear selection
        const clearBtn = this.bulkBarEl.createEl('button', {
            cls: 'bulk-bar-btn bulk-bar-clear',
            text: t('× Clear')
        });
        clearBtn.addEventListener('click', () => {
            this.selectedScenes.clear();
            this.boardEl?.querySelectorAll('.scene-card.selected').forEach(el => {
                el.removeClass('selected');
            });
            this.updateBulkBar();
        });

        // Merge scenes (2+ selected)
        const mergeBtn = this.bulkBarEl.createEl('button', {
            cls: 'bulk-bar-btn',
            text: t('Merge')
        });
        const mergeIcon = mergeBtn.createSpan();
        obsidian.setIcon(mergeIcon, 'combine');
        mergeBtn.addEventListener('click', () => {
            // Collect selected scenes in sequence order
            const scenes = Array.from(this.selectedScenes)
                .map(fp => this.sceneManager.getScene(fp))
                .filter(Boolean) as Scene[];
            scenes.sort((a, b) => (a.sequence ?? 0) - (b.sequence ?? 0));

            if (scenes.length < 2) {
                new Notice(t('Select at least 2 scenes to merge'));
                return;
            }

            new MergeSceneModal(this.plugin, scenes, () => {
                this.selectedScenes.clear();
                this.refreshBoard();
                this.updateBulkBar();
            }).open();
        });
    }

    /**
     * Open a scene in the editor
     */
    private async openScene(scene: Scene): Promise<void> {
        const file = this.app.vault.getAbstractFileByPath(scene.filePath);
        if (file instanceof TFile) {
            const leaf = this.app.workspace.getLeaf('tab');
            await leaf.openFile(file, { state: { mode: 'source', source: false } });
        } else {
            new Notice(t('Could not find file: {path}', { path: scene.filePath }));
        }
    }

    /**
     * Delete a scene
     */
    private async deleteScene(scene: Scene): Promise<void> {
        // Corkboard / 平铺画布: trash means park (inactive), never vault-delete.
        if (this.boardMode === 'corkboard') {
            await this.parkCorkboardPath(scene.filePath);
            new Notice(t('Parked as inactive. File kept in the vault.'));
            this.corkboardVisibilityKey = '';
            if (!this.corkboardNativeFailed) {
                await this.ensureNativeCorkboardHost();
            } else {
                this.refreshBoard();
            }
            return;
        }
        await this.sceneManager.deleteScene(scene.filePath);
        this.refreshBoard();
    }

    /**
     * Show context menu for a scene
     */
    private showContextMenu(scene: Scene, event: MouseEvent): void {
        const menu = new Menu();

        if (this.boardMode === 'corkboard') {
            menu.addItem(item => item
                .setTitle(t('Top'))
                .setIcon('chevrons-up')
                .onClick(() => { this.moveCorkboardLayer(scene.filePath, 'top'); }));

            menu.addItem(item => item
                .setTitle(t('Move up'))
                .setIcon('arrow-up')
                .onClick(() => { this.moveCorkboardLayer(scene.filePath, 'up'); }));

            menu.addItem(item => item
                .setTitle(t('Down'))
                .setIcon('arrow-down')
                .onClick(() => { this.moveCorkboardLayer(scene.filePath, 'down'); }));

            menu.addItem(item => item
                .setTitle(t('Bottom'))
                .setIcon('chevrons-down')
                .onClick(() => { this.moveCorkboardLayer(scene.filePath, 'bottom'); }));

            menu.addSeparator();
        }

        menu.addItem(item => {
            item.setTitle(t('Edit Scene'))
                .setIcon('pencil')
                .onClick(() => this.openScene(scene));
        });

        menu.addItem(item => {
            item.setTitle(t('Duplicate Scene'))
                .setIcon('copy')
                .onClick(async () => {
                    await this.sceneManager.duplicateScene(scene.filePath);
                    this.refreshBoard();
                });
        });

        menu.addItem(item => {
            item.setTitle(t('Split Scene'))
                .setIcon('scissors')
                .onClick(() => {
                    new SplitSceneModal(this.plugin, scene, () => this.refreshBoard()).open();
                });
        });

        // Scene color picker
        menu.addItem(item => {
            item.setTitle(t(scene.color ? 'Change Color' : 'Set Color'))
                .setIcon('palette')
                .onClick(() => {
                    SceneCardComponent.openColorPicker(this.app, scene, this.sceneManager, () => this.refreshBoard());
                });
        });

        menu.addSeparator();

        // Status submenu
        const statuses = getStatusOrder();
        statuses.forEach(status => {
            menu.addItem(item => {
                item.setTitle(t('Status: {status}', { status: t(resolveStatusCfg(status).label) }))
                    .setChecked(scene.status === status)
                    .onClick(async () => {
                        await this.sceneManager.updateScene(scene.filePath, { status });
                        this.refreshBoard();
                    });
            });
        });

        menu.addSeparator();

        // Move to Act submenu
        const definedActs = this.sceneManager.getDefinedActs();
        if (definedActs.length > 0) {
            menu.addItem(item => {
                item.setTitle(t('Move to Act…'))
                    .setIcon('folder');
                // Build submenu manually via Menu
            });
            for (const act of definedActs) {
                menu.addItem(item => {
                    const rawActLabel = this.sceneManager.getActLabel(act);
                    const cleanActLabel = rawActLabel?.replace(/^(Act|Prologue|Epilogue)\s*\d*\s*[—:]\s*/i, '');
                    const actDisplay = getActDisplayLabel(act);
                    const display = cleanActLabel ? `${actDisplay} — ${cleanActLabel}` : actDisplay;
                    item.setTitle(display)
                        .setChecked(scene.act === act)
                        .onClick(async () => {
                            await this.sceneManager.updateScene(scene.filePath, { act });
                            this.refreshBoard();
                        });
                });
            }
        }

        // Move to Chapter submenu
        const definedChapters = this.sceneManager.getDefinedChapters();
        if (definedChapters.length > 0) {
            menu.addSeparator();
            for (const ch of definedChapters) {
                menu.addItem(item => {
                    const rawChLabel = this.sceneManager.getChapterLabel(ch);
                    const chLabel = rawChLabel?.replace(/^Ch(?:apter)?\s*\d+\s*[—:]\s*/i, '');
                    const display = chLabel ? `Ch ${ch} — ${chLabel}` : `Chapter ${ch}`;
                    item.setTitle(display)
                        .setChecked(scene.chapter === ch)
                        .onClick(async () => {
                            await this.sceneManager.updateScene(scene.filePath, { chapter: ch });
                            this.refreshBoard();
                        });
                });
            }
        }

        menu.addSeparator();

        menu.addItem(item => {
            item.setTitle(t('Save as Template'))
                .setIcon('file-plus')
                .onClick(async () => {
                    const tpl: SceneTemplate = {
                        name: `Template from "${scene.title || 'Untitled'}"`,
                        description: `Saved from scene "${scene.title || 'Untitled'}"`,
                        defaultFields: {
                            status: scene.status,
                            emotion: scene.emotion,
                            tags: scene.tags?.length ? [...scene.tags] : undefined,
                            conflict: scene.conflict,
                            target_wordcount: scene.target_wordcount,
                        },
                        bodyTemplate: scene.body || '',
                        scope: 'global',
                    };
                    await this.plugin.templateCenter.saveSceneTemplate(tpl);
                    new Notice(t('Scene template "{name}" saved', { name: tpl.name }));
                });
        });

        menu.addSeparator();

        menu.addItem(item => {
                item.setTitle(t(scene.inactive ? 'Mark Active' : 'Mark Inactive'))
                .setIcon(scene.inactive ? 'eye' : 'eye-off')
                .onClick(async () => {
                    await this.sceneManager.updateScene(scene.filePath, { inactive: !scene.inactive });
                    this.corkboardVisibilityKey = '';
                    this.corkboardCanvasFilePath = null;
                    this.refreshBoard();
                });
        });

        menu.addSeparator();

        menu.addItem(item => {
            item.setTitle(t('Archive Scene'))
                .setIcon('archive')
                .onClick(async () => {
                    await this.sceneManager.archiveScene(scene.filePath);
                    this.refreshBoard();
                });
        });

        menu.addItem(item => {
            if (this.boardMode === 'corkboard') {
                item.setTitle(t('Mark Inactive'))
                    .setIcon('eye-off')
                    .onClick(async () => { await this.deleteScene(scene); });
            } else {
                item.setTitle(t('Delete Scene'))
                    .setIcon('trash')
                    .onClick(async () => {
                        openConfirmModal(this.app, {
                            title: t('Delete Scene'),
                            message: t('Delete scene "{title}"?', { title: scene.title || t('Untitled') }),
                            confirmLabel: t('Delete'),
                            onConfirm: () => this.deleteScene(scene),
                        });
                    });
            }
        });

        menu.showAtMouseEvent(event);
    }

    /**
     * Open a modal listing archived scenes with restore buttons.
     */
    private async openArchiveModal(): Promise<void> {
        const modal = new Modal(this.app);
        modal.titleEl.setText(t('Archived Scenes'));

        const archived = await this.sceneManager.getArchivedScenes();
        if (archived.length === 0) {
            modal.contentEl.createEl('p', { text: t('No archived scenes.'), cls: 'setting-item-description' });
        } else {
            for (const item of archived) {
                const row = modal.contentEl.createDiv();
                row.setCssStyles({
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'space-between',
                    padding: '6px 0',
                    borderBottom: '1px solid var(--background-modifier-border)',
                });
                row.createSpan({ text: item.title });
                const restoreBtn = row.createEl('button', { text: t('Restore'), cls: 'mod-cta' });
                restoreBtn.setCssStyles({
                    fontSize: '11px',
                    padding: '2px 10px',
                });
                restoreBtn.addEventListener('click', async () => {
                    await this.sceneManager.restoreScene(item.filePath);
                    await this.sceneManager.initialize();
                    this.refreshBoard();
                    row.remove();
                    // Check if list is now empty
                    if (modal.contentEl.querySelectorAll('div').length === 0) {
                        modal.contentEl.empty();
                        modal.contentEl.createEl('p', { text: t('No archived scenes.'), cls: 'setting-item-description' });
                    }
                    new Notice(t('Scene restored'));
                });
            }
        }

        modal.open();
    }

    /**
     * Build a display title for a column header, including labels if available.
     */
    private getColumnDisplayTitle(groupKey: string): string {
        // Parse "Act N" or "Chapter N"
        const actMatch = groupKey.match(/^Act\s+(\d+)$/);
        if (actMatch) {
            const actNum = parseInt(actMatch[1], 10);
            const label = this.sceneManager.getActLabel(actNum);
            const actDisplay = getActDisplayLabel(actNum);
            return label ? `${actDisplay}: ${label}` : actDisplay;
        }
        const chMatch = groupKey.match(/^Chapter\s+(\d+)$/);
        if (chMatch) {
            const chNum = parseInt(chMatch[1], 10);
            const label = this.sceneManager.getChapterLabel(chNum);
            return label ? label : groupKey;
        }
        return groupKey;
    }

    /**
     * Get a description for a column header (act or chapter), if one has been set.
     */
    private getColumnDescription(groupKey: string): string | undefined {
        const actMatch = groupKey.match(/^Act\s+(\d+)$/);
        if (actMatch) {
            return this.sceneManager.getActDescription(parseInt(actMatch[1], 10));
        }
        const chMatch = groupKey.match(/^Chapter\s+(\d+)$/);
        if (chMatch) {
            return this.sceneManager.getChapterDescription(parseInt(chMatch[1], 10));
        }
        return undefined;
    }

    /**
     * Show context menu on a column header (right-click).
     * Allows deleting/renaming acts or chapters.
     */
    private showColumnContextMenu(event: MouseEvent, groupKey: string, scenes: Scene[]): void {
        const menu = new Menu();
        const actMatch = groupKey.match(/^Act\s+(\d+)$/);
        const chMatch = groupKey.match(/^Chapter\s+(\d+)$/);

        if (actMatch) {
            const actNum = parseInt(actMatch[1], 10);
            const currentLabel = this.sceneManager.getActLabel(actNum) || '';

            menu.addItem(item => {
                item.setTitle(t('Rename Act'))
                    .setIcon('pencil')
                    .onClick(() => {
                        this.openRenameModal('Act', actNum, currentLabel, async (newLabel) => {
                            await this.sceneManager.setActLabel(actNum, newLabel);
                            this.refreshBoard();
                        });
                    });
            });

            menu.addItem(item => {
                item.setTitle(t('Edit Description'))
                    .setIcon('file-text')
                    .onClick(() => {
                        const currentDesc = this.sceneManager.getActDescription(actNum) || '';
                        this.openDescriptionModal('Act', actNum, currentDesc, async (desc) => {
                            await this.sceneManager.setActDescription(actNum, desc);
                            this.refreshBoard();
                        });
                    });
            });

            menu.addItem(item => {
                item.setTitle(t('Delete Act'))
                    .setIcon('trash')
                    .onClick(() => {
                        const actDisplay = getActDisplayLabel(actNum);
                        if (scenes.length > 0) {
                            openConfirmModal(this.app, {
                                title: t('Delete Act'),
                                message: t('{act} contains {count} scenes. Deleting the act removes the column but keeps the scenes (they will become unassigned). Continue?', {
                                    act: actDisplay,
                                    count: scenes.length,
                                }),
                                onConfirm: async () => {
                                    // Unassign scenes from this act
                                    for (const s of scenes) {
                                        await this.sceneManager.updateScene(s.filePath, { act: undefined });
                                    }
                                    await this.sceneManager.removeAct(actNum);
                                    await this.sceneManager.setActLabel(actNum, '');
                                    this.refreshBoard();
                                    new Notice(t('Deleted {name}', { name: actDisplay }));
                                },
                            });
                        } else {
                            this.sceneManager.removeAct(actNum).then(() => {
                                this.sceneManager.setActLabel(actNum, '').then(() => {
                                    this.refreshBoard();
                                    new Notice(t('Deleted Act {n}', { n: actNum }));
                                });
                            });
                        }
                    });
            });

            // Add existing scenes to this act
            menu.addSeparator();
            menu.addItem(item => {
                item.setTitle(t('Add existing scenes…'))
                    .setIcon('plus-circle')
                    .onClick(() => {
                        this.openAssignScenesModal('act', actNum);
                    });
            });
        } else if (chMatch) {
            const chNum = parseInt(chMatch[1], 10);
            const currentLabel = this.sceneManager.getChapterLabel(chNum) || '';

            // Issue #220 — insert a new chapter before or after this column,
            // renumbering existing chapters (and their scenes) to make room.
            menu.addItem(item => {
                item.setTitle(t('Insert Chapter Before'))
                    .setIcon('arrow-up-from-line')
                    .onClick(async () => {
                        await this.sceneManager.insertChapter(chNum);
                        await this.sceneManager.initialize();
                        this.refreshBoard();
                        new Notice(t('Inserted new Chapter {n}', { n: chNum }));
                    });
            });

            menu.addItem(item => {
                item.setTitle(t('Insert Chapter After'))
                    .setIcon('arrow-down-from-line')
                    .onClick(async () => {
                        await this.sceneManager.insertChapter(chNum + 1);
                        await this.sceneManager.initialize();
                        this.refreshBoard();
                        new Notice(t('Inserted new Chapter {n}', { n: chNum + 1 }));
                    });
            });

            menu.addSeparator();

            menu.addItem(item => {
                item.setTitle(t('Rename Chapter'))
                    .setIcon('pencil')
                    .onClick(() => {
                        this.openRenameModal('Chapter', chNum, currentLabel, async (newLabel) => {
                            await this.sceneManager.setChapterLabel(chNum, newLabel);
                            this.refreshBoard();
                        });
                    });
            });

            menu.addItem(item => {
                item.setTitle(t('Edit Description'))
                    .setIcon('file-text')
                    .onClick(() => {
                        const currentDesc = this.sceneManager.getChapterDescription(chNum) || '';
                        this.openDescriptionModal('Chapter', chNum, currentDesc, async (desc) => {
                            await this.sceneManager.setChapterDescription(chNum, desc);
                            this.refreshBoard();
                        });
                    });
            });

            menu.addItem(item => {
                item.setTitle(t('Delete Chapter'))
                    .setIcon('trash')
                    .onClick(() => {
                        if (scenes.length > 0) {
                            openConfirmModal(this.app, {
                                title: t('Delete Chapter'),
                                message: t('Chapter {chapter} contains {count} scenes. Deleting the chapter removes the column but keeps the scenes (they will become unassigned). Continue?', {
                                    chapter: chNum,
                                    count: scenes.length,
                                }),
                                onConfirm: async () => {
                                    for (const s of scenes) {
                                        await this.sceneManager.updateScene(s.filePath, { chapter: undefined });
                                    }
                                    await this.sceneManager.removeChapter(chNum);
                                    await this.sceneManager.setChapterLabel(chNum, '');
                                    this.refreshBoard();
                                    new Notice(t('Deleted Chapter {n}', { n: chNum }));
                                },
                            });
                        } else {
                            this.sceneManager.removeChapter(chNum).then(() => {
                                this.sceneManager.setChapterLabel(chNum, '').then(() => {
                                    this.refreshBoard();
                                    new Notice(t('Deleted Chapter {n}', { n: chNum }));
                                });
                            });
                        }
                    });
            });

            // Add existing scenes to this chapter
            menu.addSeparator();
            menu.addItem(item => {
                item.setTitle(t('Add existing scenes…'))
                    .setIcon('plus-circle')
                    .onClick(() => {
                        this.openAssignScenesModal('chapter', chNum);
                    });
            });
        }

        menu.showAtMouseEvent(event);
    }

    /**
     * Open a modal to edit the description for an act or chapter.
     */
    private openDescriptionModal(type: string, num: number, current: string, onSave: (desc: string) => Promise<void>): void {
        const modal = new Modal(this.app);
        modal.titleEl.setText(t('{type} {num} Description', { type: t(type), num }));
        const { contentEl } = modal;

        let value = current;
        new Setting(contentEl)
            .setName(t('Description'))
            .setDesc(t('A short summary for {type} {num}. Leave blank to remove.', { type: t(type), num }));
        const textArea = contentEl.createEl('textarea', {
            cls: 'storyline-description-textarea',
        });
        textArea.value = current;
        textArea.placeholder = t('e.g. "Our heroes arrive in the capital…"');
        textArea.rows = 4;
        textArea.setCssStyles({
            width: '100%',
            resize: 'vertical',
        });
        textArea.addEventListener('input', () => { value = textArea.value; });
        window.setTimeout(() => textArea.focus(), 50);

        const btnRow = contentEl.createDiv('structure-close-row');
        const saveBtn = btnRow.createEl('button', { text: t('Save'), cls: 'mod-cta' });
        saveBtn.addEventListener('click', async () => {
            await onSave(value);
            modal.close();
        });
        const cancelBtn = btnRow.createEl('button', { text: t('Cancel') });
        cancelBtn.addEventListener('click', () => modal.close());

        modal.open();
    }

    /**
     * Open a small modal to rename an act or chapter label.
     */
    private openRenameModal(type: string, num: number, current: string, onSave: (label: string) => Promise<void>): void {
        const modal = new Modal(this.app);
        modal.titleEl.setText(t('Rename {type} {num}', { type: t(type), num }));
        const { contentEl } = modal;

        let value = current;
        new Setting(contentEl)
            .setName(t('Label'))
            .setDesc(t('Display name for {type} {num}. Leave blank to remove.', { type: t(type), num }))
            .addText(text => {
                text.setValue(current)
                    .setPlaceholder(t('e.g. "The Beginning"'))
                    .onChange(v => { value = v; });
                // Auto-focus
                window.setTimeout(() => text.inputEl.focus(), 50);
            });

        const btnRow = contentEl.createDiv('structure-close-row');
        const saveBtn = btnRow.createEl('button', { text: t('Save'), cls: 'mod-cta' });
        saveBtn.addEventListener('click', async () => {
            await onSave(value);
            modal.close();
        });
        const cancelBtn = btnRow.createEl('button', { text: t('Cancel') });
        cancelBtn.addEventListener('click', () => modal.close());

        modal.open();
    }

    /**
     * Open a modal to assign existing scenes to a chapter or act.
     * Shows a checklist of unassigned scenes (those without a chapter/act value).
     */
    private openAssignScenesModal(field: 'chapter' | 'act', value: number): void {
        const modal = new Modal(this.app);
        const rawChLbl = this.sceneManager.getChapterLabel(value);
        const cleanChLbl = rawChLbl?.replace(/^Ch(?:apter)?\s*\d+\s*[—:]\s*/i, '');
        const rawActLbl = this.sceneManager.getActLabel(value);
        const cleanActLbl = rawActLbl?.replace(/^(Act|Prologue|Epilogue)\s*\d*\s*[—:]\s*/i, '');
        const actDisplay = getActDisplayLabel(value);
        const label = field === 'chapter'
            ? `Chapter ${value}` + (cleanChLbl ? ` — ${cleanChLbl}` : '')
            : actDisplay + (cleanActLbl ? ` — ${cleanActLbl}` : '');
        modal.titleEl.setText(t('Add scenes to {label}', { label }));

        const { contentEl } = modal;
        contentEl.createEl('p', {
            cls: 'setting-item-description',
            text: t('Select scenes to assign to {label}. Only scenes not already in a {field} are shown.', { label, field: t(field) })
        });

        const allScenes = this.sceneManager.queryService.getFilteredScenes(
            undefined,
            { field: 'sequence', direction: 'asc' }
        );
        // Show scenes without a value for this field, plus scenes in other groups
        const candidates = allScenes.filter(s => {
            const current = field === 'chapter' ? s.chapter : s.act;
            return current === undefined || current !== value;
        });

        if (candidates.length === 0) {
            contentEl.createEl('p', { text: t('All scenes are already assigned.') });
            const closeRow = contentEl.createDiv('structure-close-row');
            closeRow.createEl('button', { text: t('Close'), cls: 'mod-cta' })
                .addEventListener('click', () => modal.close());
            modal.open();
            return;
        }

        const selectedPaths = new Set<string>();
        const listEl = contentEl.createDiv('assign-scene-list');
        listEl.setCssStyles({
            maxHeight: '400px',
            overflow: 'auto',
            margin: '8px 0',
        });

        for (const scene of candidates) {
            const row = listEl.createDiv('assign-scene-row');
            row.setCssStyles({
                display: 'flex',
                alignItems: 'center',
                gap: '8px',
                padding: '4px 0',
            });

            const cb = row.createEl('input', { type: 'checkbox' }) as HTMLInputElement;
            const currentVal = field === 'chapter' ? scene.chapter : scene.act;
            const info = currentVal !== undefined ? ` [${field} ${currentVal}]` : ' [unassigned]';
            row.createSpan({ text: `${scene.title}${info}` });

            cb.addEventListener('change', () => {
                if (cb.checked) selectedPaths.add(scene.filePath);
                else selectedPaths.delete(scene.filePath);
            });
        }

        const btnRow = contentEl.createDiv('structure-close-row');
        btnRow.setCssStyles({
            display: 'flex',
            gap: '8px',
            marginTop: '12px',
        });
        const assignBtn = btnRow.createEl('button', { text: t('Assign Selected'), cls: 'mod-cta' });
        assignBtn.addEventListener('click', async () => {
            if (selectedPaths.size === 0) {
                new Notice(t('No scenes selected'));
                return;
            }
            for (const fp of selectedPaths) {
                const updates: Partial<Scene> = {};
                if (field === 'chapter') updates.chapter = value;
                else updates.act = value;
                await this.sceneManager.updateScene(fp, updates);
            }
            new Notice(t('Assigned {count} scene(s) to {label}', { count: selectedPaths.size, label }));
            modal.close();
            this.refreshBoard();
        });
        const cancelBtn = btnRow.createEl('button', { text: t('Cancel') });
        cancelBtn.addEventListener('click', () => modal.close());

        modal.open();
    }

    /**
     * Issue #226 — replace literal "&nbsp;" / "&#160;" / "&#xA0;" strings
     * that appear in text nodes with an actual non-breaking space (U+00A0).
     * markdown-it encodes U+00A0 as an HTML entity; if the entity survives
     * into a text node it renders as visible text instead of a space.
     */
    private decodeNbspEntities(root: HTMLElement): void {
        const walker = activeDocument.createTreeWalker(root, NodeFilter.SHOW_TEXT);
        const targets: Text[] = [];
        let node: Node | null;
        while ((node = walker.nextNode())) {
            const t = node as Text;
            if (t.nodeValue && /&(nbsp|#160|#xA0);/i.test(t.nodeValue)) {
                targets.push(t);
            }
        }
        for (const t of targets) {
            t.nodeValue = t.nodeValue!
                .replace(/&nbsp;/gi, '\u00A0')
                .replace(/&#160;/gi, '\u00A0')
                .replace(/&#xA0;/gi, '\u00A0');
        }
    }

    /**
     * Open the Quick Add modal
     */
    private openQuickAdd(presetColumn?: string): void {
        // Build defaults based on groupBy and column title
        const defaults: Partial<Scene> = {};
        if (presetColumn) {
            if (this.groupBy === 'act') {
                // Accept any value after "Act " (numeric, decimal, or string)
                // and let parseActChapterInput decide whether to store it as
                // a number ("7" → 7) or a string ("1.1", "Prologue").
                const match = presetColumn.match(/^Act\s+(.+)$/);
                if (match) defaults.act = parseActChapterInput(match[1]);
            } else if (this.groupBy === 'chapter') {
                const match = presetColumn.match(/^Chapter\s+(.+)$/);
                if (match) defaults.chapter = parseActChapterInput(match[1]);
            } else if (this.groupBy === 'status') {
                // Build a label→id mapping from the dynamic status config
                const cfg = getStatusConfig();
                const statusMap: Record<string, string> = {};
                for (const [id, def] of Object.entries(cfg)) {
                    statusMap[def.label] = id;
                }
                const statusVal = statusMap[presetColumn] || presetColumn.toLowerCase();
                defaults.status = statusVal as SceneStatus;
            } else if (this.groupBy === 'pov') {
                if (presetColumn !== 'No POV') defaults.pov = presetColumn;
            }
        }

        const modal = new QuickAddModal(
            this.app,
            this.plugin,
            this.sceneManager,
            async (sceneData, openAfter) => {
                const file = await this.sceneManager.createScene(sceneData);
                this.refreshBoard();

                if (openAfter) {
                    await this.app.workspace.getLeaf('tab').openFile(file, { state: { mode: 'source', source: false } });
                }
            },
            defaults
        );
        modal.open();
    }

    private getCurrentMaxCorkboardZ(): number {
        let max = 0;
        for (const pos of this.corkboardPositions.values()) {
            if ((pos.z ?? 0) > max) max = pos.z ?? 0;
        }
        return max;
    }

    private getNextQuickNotePosition(): { x: number; y: number; z: number } {
        const now = Date.now();
        if (now - this.quickNoteLastCreatedAt <= 8000) {
            this.quickNoteChainIndex += 1;
        } else {
            this.quickNoteChainIndex = 0;
        }
        this.quickNoteLastCreatedAt = now;

        const offset = this.quickNoteChainIndex * 28;
        const viewport = this.boardEl?.querySelector('.story-line-corkboard-viewport') as HTMLElement | null;
        const zoom = this.corkboardCamera.zoom || 1;

        let centerWorldX = 0;
        let centerWorldY = 0;

        if (viewport) {
            const rect = viewport.getBoundingClientRect();
            centerWorldX = ((rect.width / 2) - this.corkboardCamera.x) / zoom;
            centerWorldY = ((rect.height / 2) - this.corkboardCamera.y) / zoom;
        } else {
            centerWorldX = (-this.corkboardCamera.x) / zoom;
            centerWorldY = (-this.corkboardCamera.y) / zoom;
        }

        return {
            x: centerWorldX - 140 + offset,
            y: centerWorldY - 110 + offset,
            z: this.getCurrentMaxCorkboardZ() + 1,
        };
    }

    /**
     * Refresh the board display
     */
    refreshBoard(): void {
        this.configureDragToPan();
        if (this.boardMode === 'corkboard') {
            this.ensureCorkboardLayoutLoaded();
            this.renderCorkboard();
        } else {
            this.saveColumnScrollPositions();
            this.renderBoard();
            // Restore scroll positions after DOM is rebuilt
            window.requestAnimationFrame(() => this.restoreColumnScrollPositions());
        }
        // Only refresh inspector if it was already visible
        if (this.selectedScene && this.inspectorComponent?.isVisible()) {
            const updated = this.sceneManager.getScene(this.selectedScene.filePath);
            if (updated) {
                this.selectedScene = updated;
                this.inspectorComponent?.show(updated);
            }
        }
    }

    /**
     * Full refresh called by the plugin on file changes
     */
    refresh(): void {
        if (!this.rootContainer) return;
        // Always sync the toolbar project label — refreshBoard() does not
        // rebuild the toolbar, so a stale "NarrativeLab" fallback would stick.
        this.rootContainer.querySelectorAll('.story-line-view-title').forEach(el => {
            el.textContent = this.plugin.getActiveProjectDisplayName();
        });
        // If a corkboard note editor is focused, skip the rebuild — tearing
        // down the textarea mid-edit loses focus and hides the text being
        // typed (issue #190). The cache version is still bumped so the next
        // refresh after editing ends will pick up changes.
        if (this.editingNotePath) {
            return;
        }
        if (this._pendingRefresh) { cancelAnimationFrame(this._pendingRefresh); }
        this._pendingRefresh = window.requestAnimationFrame(() => {
            this._pendingRefresh = null;
            if (!this.rootContainer) return;
            const prevSelectedPath = this.selectedScene?.filePath ?? null;
            const inspectorWasVisible = this.inspectorComponent?.isVisible() ?? false;

            // Re-sync after rAF in case the project finished loading mid-frame.
            this.rootContainer.querySelectorAll('.story-line-view-title').forEach(el => {
                el.textContent = this.plugin.getActiveProjectDisplayName();
            });

            if (this.boardEl) {
                this.refreshBoard();
            } else {
                this.saveColumnScrollPositions();
                this.renderView(this.rootContainer);
                window.requestAnimationFrame(() => this.restoreColumnScrollPositions());
            }

            if (prevSelectedPath) {
                const updated = this.sceneManager.getScene(prevSelectedPath);
                if (updated) {
                    this.selectedScene = updated;
                    this.selectedScenes.add(updated.filePath);
                    if (inspectorWasVisible) {
                        this.inspectorComponent?.show(updated);
                    }
                }
            }
        });
    }

    private configureDragToPan(): void {
        if (!this.boardEl) return;

        if (this.boardMode !== 'corkboard' && this.corkboardInteractionCleanup) {
            this.corkboardInteractionCleanup();
            this.corkboardInteractionCleanup = null;
        }

        if (this.dragToPanCleanup) {
            this.dragToPanCleanup();
            this.dragToPanCleanup = null;
        }

        if (this.boardMode === 'kanban') {
            this.dragToPanCleanup = enableDragToPan(this.boardEl);
        }
    }

    private async openQuickAddIdea(): Promise<void> {
        // Clear selection so the inspector doesn't pop open for the previous scene
        this.selectedScene = null;
        this.selectedScenes.clear();
        this.inspectorComponent?.hide();

        const file = await this.sceneManager.createScene({
            status: 'idea',
            corkboardNote: true,
        });

        const pos = this.getNextQuickNotePosition();
        this.corkboardPositions.set(file.path, pos);
        this.expandedCorkboardNotes.add(file.path);
        this.schedulePersistCorkboardLayout();

        await this.refreshCorkboardAfterNoteCreate();
    }

    /** After creating a Notes/ sticky, sync the project corkboard .canvas and remount if needed. */
    private async refreshCorkboardAfterNoteCreate(): Promise<void> {
        if (this.boardMode === 'corkboard' && !this.corkboardNativeFailed) {
            this.corkboardVisibilityKey = ''; // membership changed
            this.corkboardCanvasFilePath = null;
            await this.ensureNativeCorkboardHost();
            return;
        }
        this.refreshBoard();
    }

    // ── Image sticky note helpers ────────────────────────

    /**
     * Render the content for an image sticky note (image + caption + footer).
     */
    private renderImageNoteContent(cardEl: HTMLElement, scene: Scene): void {
        const editorWrap = cardEl.createDiv('story-line-corkboard-note-editor story-line-corkboard-image-editor');

        // Image element
        const imgSrc = resolveImagePath(this.app, scene.corkboardNoteImage!);
        const imgEl = editorWrap.createEl('img', {
            cls: 'story-line-corkboard-note-img',
            attr: { src: imgSrc, alt: scene.corkboardNoteCaption || t('Image note') },
        });

        // Click image → open lightbox
        imgEl.addEventListener('click', (e) => {
            e.stopPropagation();
            this.openImageLightbox(imgSrc, scene.corkboardNoteCaption);
        });

        // Caption (editable, supports markdown/wikilinks)
        const caption = scene.corkboardNoteCaption ?? '';
        const captionPreview = editorWrap.createDiv('story-line-corkboard-note-caption markdown-rendered');
        const captionInput = editorWrap.createEl('textarea', {
            cls: 'story-line-corkboard-note-caption-input',
            attr: { placeholder: t('Add a caption…'), rows: '2' },
        });
        captionInput.value = caption;
        captionInput.setCssStyles({ display: 'none' });

        const renderCaptionPreview = async () => {
            captionPreview.empty();
            const text = captionInput.value.trim();
            if (!text) {
                captionPreview.createSpan({ cls: 'story-line-corkboard-note-caption-empty', text: t('Add a caption…') });
                return;
            }
            await MarkdownRenderer.render(this.app, text, captionPreview, scene.filePath, this);
        };

        const saveCaptionAndClose = async () => {
            const next = captionInput.value;
            if ((scene.corkboardNoteCaption || '') !== next) {
                await this.sceneManager.updateScene(scene.filePath, { corkboardNoteCaption: next });
                scene.corkboardNoteCaption = next;
            }
            captionInput.setCssStyles({ display: 'none' });
            captionPreview.setCssStyles({ display: 'block' });
            cardEl.removeClass('is-editing');
            await renderCaptionPreview();
            const titleEl = cardEl.querySelector('.story-line-corkboard-note-title-text') as HTMLElement | null;
            if (titleEl) titleEl.setText(this.getCorkboardNoteDisplayTitle(scene));
        };

        const openCaptionEditor = () => {
            if (captionInput.style.display !== 'none') return;
            captionPreview.setCssStyles({ display: 'none' });
            captionInput.setCssStyles({ display: 'block' });
            cardEl.addClass('is-editing');
            captionInput.focus();

            // Listen for clicks outside the caption to close the editor
            const outsideHandler = (pe: PointerEvent) => {
                const target = pe.target as Node | null;
                if (target && editorWrap.contains(target)) return;
                activeDocument.removeEventListener('pointerdown', outsideHandler, true);
                void saveCaptionAndClose();
            };
            window.setTimeout(() => {
                activeDocument.addEventListener('pointerdown', outsideHandler, true);
            }, 0);
        };

        captionPreview.addEventListener('click', (e) => {
            // Allow internal links to work
            const link = (e.target as HTMLElement).closest('a');
            if (link) {
                const href = link.getAttribute('data-href') || link.getAttribute('href');
                if (href && link.hasClass('internal-link')) {
                    e.preventDefault();
                    e.stopPropagation();
                    this.app.workspace.openLinkText(href, scene.filePath, true);
                    return;
                }
                if (href && !href.startsWith('#')) return;
            }
            if (isMobile) openCaptionEditor();
        });
        captionPreview.addEventListener('dblclick', (e: MouseEvent) => {
            if ((e.target as HTMLElement).closest('a')) return;
            e.preventDefault();
            e.stopPropagation();
            openCaptionEditor();
        });

        captionInput.addEventListener('blur', () => { void saveCaptionAndClose(); });
        captionInput.addEventListener('keydown', (e: KeyboardEvent) => {
            if (e.key === 'Escape') { e.preventDefault(); void saveCaptionAndClose(); }
        });

        void renderCaptionPreview();

        // Resize handle
        const resizeHandle = cardEl.createDiv('story-line-corkboard-note-resize-handle');
        resizeHandle.addEventListener('pointerdown', (e: PointerEvent) => {
            e.preventDefault();
            e.stopPropagation();
            const startX = e.clientX;
            const startY = e.clientY;
            const zoom = this.corkboardCamera.zoom || 1;
            const nodeEl = cardEl.closest('.story-line-corkboard-node') as HTMLElement | null;
            const startWidth = (nodeEl?.getBoundingClientRect().width || cardEl.getBoundingClientRect().width) / zoom;
            const startHeight = cardEl.getBoundingClientRect().height / zoom;
            const minWidth = 240;
            const minHeight = 180;
            const onMove = (me: PointerEvent) => {
                nodeEl?.setCssStyles({
                    width: `${Math.max(minWidth, startWidth + (me.clientX - startX) / zoom)}px`,
                });
                cardEl.setCssStyles({ height: `${Math.max(minHeight, startHeight + (me.clientY - startY) / zoom)}px` });
            };
            const onUp = () => {
                window.removeEventListener('pointermove', onMove);
                window.removeEventListener('pointerup', onUp);
                const finalHeight = parseFloat(cardEl.style.height);
                const finalWidth = nodeEl ? parseFloat(nodeEl.style.width) : 0;
                if (finalHeight > 0 || finalWidth > 0) {
                    const pos = this.corkboardPositions.get(scene.filePath);
                    if (pos) {
                        if (finalWidth > 0) pos.w = finalWidth;
                        if (finalHeight > 0) pos.h = finalHeight;
                        this.schedulePersistCorkboardLayout();
                    }
                }
            };
            window.addEventListener('pointermove', onMove);
            window.addEventListener('pointerup', onUp);
        });
    }

    /**
     * Open a floating, draggable, resizable lightbox — same style as Location/Codex galleries.
     */
    private openImageLightbox(src: string, caption?: string): void {
        // Close any existing lightbox
        activeDocument.querySelector('.gallery-lightbox-window')?.remove();

        const winWidth = Math.min(600, window.innerWidth - 40);
        const winHeight = Math.round(winWidth * 3 / 4) + 36 + 28;

        const win = activeDocument.body.createDiv('gallery-lightbox-window');
        win.setCssStyles({
            width: `${winWidth}px`,
            height: `${winHeight}px`,
        });

        // Titlebar
        const titlebar = win.createDiv('gallery-lightbox-titlebar');
        titlebar.createSpan({ cls: 'gallery-lightbox-title', text: caption || t('Image') });
        const closeBtn = titlebar.createEl('button', { cls: 'gallery-lightbox-close', attr: { title: t('Close') } });
        obsidian.setIcon(closeBtn, 'x');
        closeBtn.addEventListener('click', () => { cleanup(); win.remove(); });

        // Image content
        const contentRow = win.createDiv('gallery-lightbox-content-row');
        const imgContainer = contentRow.createDiv('gallery-lightbox-content');
        if (src) {
            const img = imgContainer.createEl('img', { attr: { src, alt: caption || t('Image note') } });
            img.setCssStyles({ transformOrigin: 'center center' });
        }

        // Caption
        if (caption) {
            const captionEl = win.createDiv('gallery-lightbox-caption');
            captionEl.textContent = caption;
        }

        // Resize handle
        const resizeHandle = win.createDiv('gallery-lightbox-resize-handle');

        // Scroll to zoom
        let zoom = 1;
        imgContainer.addEventListener('wheel', (e: WheelEvent) => {
            e.preventDefault();
            const delta = e.deltaY > 0 ? -0.1 : 0.1;
            zoom = Math.max(0.5, Math.min(5, zoom + delta));
            const img = imgContainer.querySelector('img');
            if (img) img.setCssStyles({ transform: `scale(${zoom})` });
        }, { passive: false });

        // Drag titlebar
        let isDragging = false;
        let dragOffsetX = 0;
        let dragOffsetY = 0;
        titlebar.addEventListener('pointerdown', (e: PointerEvent) => {
            if ((e.target as HTMLElement).closest('.gallery-lightbox-close')) return;
            isDragging = true;
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

        // Resize handle
        let isResizing = false;
        let resizeStartX = 0, resizeStartY = 0, startW = 0, startH = 0;
        resizeHandle.addEventListener('pointerdown', (e: PointerEvent) => {
            isResizing = true;
            resizeStartX = e.clientX; resizeStartY = e.clientY;
            startW = win.offsetWidth; startH = win.offsetHeight;
            resizeHandle.setPointerCapture(e.pointerId);
            e.preventDefault(); e.stopPropagation();
        });
        resizeHandle.addEventListener('pointermove', (e: PointerEvent) => {
            if (!isResizing) return;
            win.setCssStyles({
                width: `${Math.max(200, startW + (e.clientX - resizeStartX))}px`,
                height: `${Math.max(150, startH + (e.clientY - resizeStartY))}px`,
            });
        });
        resizeHandle.addEventListener('pointerup', () => { isResizing = false; });
        resizeHandle.addEventListener('lostpointercapture', () => { isResizing = false; });

        // Escape to close
        const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') { cleanup(); win.remove(); } };
        activeDocument.addEventListener('keydown', onKey);
        const cleanup = () => { activeDocument.removeEventListener('keydown', onKey); };
    }

    /**
     * Open ImagePicker and create a new image sticky note with the selected image.
     */
    private async openImageNotePicker(): Promise<void> {
        const attachmentSourcePath = this.sceneManager.getAttachmentSourcePath() ?? '';
        const { pickImage } = await import('../components/ImagePicker');
        const imagePath = await pickImage(this.app, attachmentSourcePath);
        if (!imagePath) return;

        this.selectedScene = null;
        this.selectedScenes.clear();
        this.inspectorComponent?.hide();

        const file = await this.sceneManager.createScene({
            status: 'idea',
            corkboardNote: true,
            corkboardNoteImage: imagePath,
        });

        const pos = this.getNextQuickNotePosition();
        this.corkboardPositions.set(file.path, pos);
        this.expandedCorkboardNotes.add(file.path);
        this.schedulePersistCorkboardLayout();
        await this.refreshCorkboardAfterNoteCreate();
    }

    /**
     * Open ImagePicker to set or change the image on an existing sticky note.
     */
    private async changeNoteImage(scene: Scene): Promise<void> {
        const attachmentSourcePath = this.sceneManager.getAttachmentSourcePath() ?? '';
        const { pickImage } = await import('../components/ImagePicker');
        const imagePath = await pickImage(this.app, attachmentSourcePath, scene.corkboardNoteImage);
        if (!imagePath) return;

        await this.sceneManager.updateScene(scene.filePath, {
            corkboardNoteImage: imagePath,
        });
        scene.corkboardNoteImage = imagePath;
        this.refreshBoard();
    }

    /**
     * Create an image note from a vault path at given corkboard coordinates.
     */
    private async createImageNoteAtPosition(imagePath: string, worldX: number, worldY: number): Promise<void> {
        const file = await this.sceneManager.createScene({
            status: 'idea',
            corkboardNote: true,
            corkboardNoteImage: imagePath,
        });

        this.corkboardPositions.set(file.path, {
            x: worldX,
            y: worldY,
            z: this.getCurrentMaxCorkboardZ() + 1,
            w: 280,
            h: 200,
        });
        this.expandedCorkboardNotes.add(file.path);
        this.schedulePersistCorkboardLayout();
        await this.refreshCorkboardAfterNoteCreate();
    }

    /**
     * Import a dropped file through Obsidian's global attachment setting.
     */
    private async importExternalImageAndCreate(file: File, worldX: number, worldY: number): Promise<void> {
        const attachmentSourcePath = this.sceneManager.getAttachmentSourcePath() ?? '';
        const buffer = await file.arrayBuffer();
        const targetPath = normalizePath(await this.app.fileManager.getAvailablePathForAttachment(file.name, attachmentSourcePath));
        const parentParts = targetPath.split('/').slice(0, -1);
        let parent = '';
        for (const part of parentParts) {
            parent = parent ? `${parent}/${part}` : part;
            if (!await this.app.vault.adapter.exists(parent)) await this.app.vault.createFolder(parent);
        }

        await this.app.vault.createBinary(targetPath, buffer);
        new Notice(t('Image imported: {name}', { name: targetPath.split('/').pop() ?? '' }));
        await this.createImageNoteAtPosition(targetPath, worldX, worldY);
    }

    /**
     * Attach dragover / drop listeners so images can be dropped onto the corkboard.
     * Handles both vault-internal drags (Obsidian TFile) and external file drops.
     */
    private attachCorkboardImageDrop(viewport: HTMLElement): void {
        const IMAGE_EXTENSIONS = /\.(png|jpe?g|gif|webp|svg|bmp|avif)$/i;

        viewport.addEventListener('dragover', (e: DragEvent) => {
            if (!e.dataTransfer) return;

            // Accept vault file drags (Obsidian sets text/plain to the path)
            const plain = e.dataTransfer.getData('text/plain');
            if (plain && IMAGE_EXTENSIONS.test(plain)) {
                e.preventDefault();
                e.dataTransfer.dropEffect = 'copy';
                return;
            }

            // Accept external files
            if (e.dataTransfer.types.includes('Files')) {
                e.preventDefault();
                e.dataTransfer.dropEffect = 'copy';
            }
        });

        viewport.addEventListener('drop', (e: DragEvent) => {
            if (!e.dataTransfer) return;

            const rect = viewport.getBoundingClientRect();
            const zoom = this.corkboardCamera.zoom || 1;
            const worldX = (e.clientX - rect.left - this.corkboardCamera.x) / zoom;
            const worldY = (e.clientY - rect.top - this.corkboardCamera.y) / zoom;

            // 1. Try vault-internal drag (Obsidian internal drag sets text/plain)
            const plain = e.dataTransfer.getData('text/plain');
            if (plain && IMAGE_EXTENSIONS.test(plain)) {
                e.preventDefault();
                const file = this.app.vault.getAbstractFileByPath(plain);
                if (file instanceof TFile) {
                    void this.createImageNoteAtPosition(file.path, worldX, worldY);
                    return;
                }
            }

            // 2. Try external file drop
            const files = e.dataTransfer.files;
            if (files && files.length > 0) {
                for (let i = 0; i < files.length; i++) {
                    const f = files[i];
                    if (IMAGE_EXTENSIONS.test(f.name)) {
                        e.preventDefault();
                        void this.importExternalImageAndCreate(f, worldX + i * 30, worldY + i * 30);
                    }
                }
            }
        });
    }

    /**
     * Sort group keys intelligently
     */
    private sortGroupKeys(keys: string[]): string[] {
        return keys.sort((a, b) => {
            // "No X" / "No Act" / "No Chapter" groups always go last.
            const aNo = a.startsWith('No ');
            const bNo = b.startsWith('No ');
            if (aNo !== bNo) return aNo ? 1 : -1;

            // For "Act ..." or "Chapter ..." columns, compare the suffix using
            // the numeric-aware act/chapter comparator so "Act 2" sorts before
            // "Act 10" and hierarchical names like "Act 1.1" / "Act 1.10" /
            // "Act 2.1" stay in order.
            const actA = a.match(/^Act\s+(.+)$/);
            const actB = b.match(/^Act\s+(.+)$/);
            if (actA && actB) return compareActChapter(actA[1], actB[1]);

            const chA = a.match(/^Chapter\s+(.+)$/);
            const chB = b.match(/^Chapter\s+(.+)$/);
            if (chA && chB) return compareActChapter(chA[1], chB[1]);

            // Status / POV / mixed: locale string compare with numeric awareness.
            return a.localeCompare(b, undefined, { numeric: true, sensitivity: 'base' });
        });
    }
}
/* eslint-enable @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-floating-promises, @typescript-eslint/no-misused-promises, @typescript-eslint/no-unnecessary-type-assertion -- end of file-wide suppression block opened at line 1 */
