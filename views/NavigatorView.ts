/* eslint-disable @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-argument, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-return, @typescript-eslint/no-floating-promises, @typescript-eslint/no-misused-promises, @typescript-eslint/no-unnecessary-type-assertion, @typescript-eslint/no-redundant-type-constituents, @typescript-eslint/no-unused-vars, no-unused-vars, no-useless-escape, no-control-regex, no-empty -- Obsidian's API surface and several untyped third-party libraries force dynamic dispatch; floating promises are intentional in DOM/event handlers; matching enable at end of file */
import { ItemView, WorkspaceLeaf, Menu, Modal, Notice, Setting, TFile, setIcon } from 'obsidian';
import type SceneCardsPlugin from '../main';
import { ManuscriptView } from './ManuscriptView';
import { resolveTagColor, getPlotlineHSL } from '../settings';
import { attachTooltip } from '../components/Tooltip';
import { SceneCardComponent } from '../components/SceneCard';
import { QuickAddModal } from '../components/QuickAddModal';
import { compareActChapter, getActDisplayLabel } from '../utils/actChapter';
import { SceneManager } from '../services/SceneManager';
import { MANUSCRIPT_VIEW_TYPE, NAVIGATOR_VIEW_TYPE } from '../constants';
import { Scene, getStatusOrder, resolveStatusCfg } from '../models/Scene';
import type { ProjectDraft, StoryLineProject } from '../models/StoryLineProject';
import { RESEARCH_TYPE_CONFIG, type ResearchPost } from '../models/Research';
import { t } from '../utils/i18n';

/**
 * Sort modes available in the navigator.
 */
type NavSortMode = 'reading' | 'chapter' | 'chronological' | 'status' | 'recent' | 'words' | 'title';

const SORT_LABELS: Record<NavSortMode, string> = {
    reading: 'Reading order (by act)',
    chapter: 'By chapter',
    chronological: 'Chronological order',
    status: 'Status',
    recent: 'Recently edited',
    words: 'Word count',
    title: 'Title A-Z',
};

const SORT_ICONS: Record<NavSortMode, string> = {
    reading: 'book-open',
    chapter: 'book-marked',
    chronological: 'list-ordered',
    status: 'circle-dot',
    recent: 'clock',
    words: 'hash',
    title: 'a-large-small',
};

/**
 * NavigatorView — Longform-style collapsible project binder.
 *
 * Tree: Projects → (active) Notes / Scenes / Research.
 * Draft + plotline filters live inside Scenes. Other projects are siblings.
 */
export class NavigatorView extends ItemView {
    private plugin: SceneCardsPlugin;
    private sceneManager: SceneManager;

    // State
    private sortMode: NavSortMode = 'reading';
    private filterText = '';
    private plotlineFilter: string | null = null;
    private pinnedScenes: Set<string> = new Set();
    private collapsedActs: Set<string> = new Set();
    private collapsedChapters: Set<string> = new Set();
    /** Collapsed binder nodes: project:{path} | plotlines | drafts | scenes | draft:{id} | act:… | chapter:… */
    private collapsedNodes: Set<string> = new Set(['plotlines']);

    // DOM refs
    private searchInput: HTMLInputElement | null = null;
    private listEl: HTMLElement | null = null;
    private progressBar: HTMLElement | null = null;
    private progressLabel: HTMLElement | null = null;
    private sortBtn: HTMLElement | null = null;
    /** Last scene clicked in the binder (visual selection). */
    private selectedScenePath: string | null = null;

    constructor(leaf: WorkspaceLeaf, plugin: SceneCardsPlugin, sceneManager: SceneManager) {
        super(leaf);
        this.plugin = plugin;
        this.sceneManager = sceneManager;
    }

    getViewType(): string {
        return NAVIGATOR_VIEW_TYPE;
    }

    getDisplayText(): string {
        return t('NarrativeLab Navigator');
    }

    getIcon(): string {
        return 'compass';
    }

    async onOpen(): Promise<void> {
        const container = this.containerEl.children[1] as HTMLElement;
        container.empty();
        container.addClass('sl-navigator');

        // ── Toolbar: search + sort + scene details (single row) ──
        const toolbar = container.createDiv('sl-nav-toolbar');

        const searchWrap = toolbar.createDiv('sl-nav-search-wrap');
        const searchIcon = searchWrap.createSpan('sl-nav-search-icon');
        setIcon(searchIcon, 'search');
        this.searchInput = searchWrap.createEl('input', {
            type: 'text',
            placeholder: t('Filter scenes…'),
            cls: 'sl-nav-search',
        });
        this.searchInput.addEventListener('input', () => {
            this.filterText = this.searchInput?.value.toLowerCase() ?? '';
            this.renderList();
        });

        this.sortBtn = toolbar.createDiv('sl-nav-icon-btn');
        setIcon(this.sortBtn, SORT_ICONS[this.sortMode]);
        attachTooltip(this.sortBtn, t('Sort'));
        this.sortBtn.addEventListener('click', (e) => {
            const menu = new Menu();
            for (const mode of Object.keys(SORT_LABELS) as NavSortMode[]) {
                menu.addItem((item) => {
                    item.setTitle(t(SORT_LABELS[mode]));
                    item.setIcon(SORT_ICONS[mode]);
                    if (mode === this.sortMode) item.setChecked(true);
                    item.onClick(() => {
                        this.sortMode = mode;
                        if (this.sortBtn) setIcon(this.sortBtn, SORT_ICONS[mode]);
                        this.renderList();
                    });
                });
            }
            menu.showAtMouseEvent(e as MouseEvent);
        });

        const detailsBtn = toolbar.createDiv('sl-nav-icon-btn');
        setIcon(detailsBtn, 'panel-right');
        attachTooltip(detailsBtn, t('Scene Details'));
        detailsBtn.addEventListener('click', () => {
            void this.plugin.openSceneInspector();
        });

        // ── Binder tree (projects → plotlines / drafts / scenes) ──
        this.listEl = container.createDiv('sl-nav-list');

        // ── Bottom bar: progress ──
        const bottomBar = container.createDiv('sl-nav-bottom');
        this.progressBar = bottomBar.createDiv('sl-nav-progress-bar');
        this.progressBar.createDiv('sl-nav-progress-fill');
        this.progressLabel = bottomBar.createDiv('sl-nav-progress-label');

        this.refresh();
    }

    async onClose(): Promise<void> {
        // nothing to clean up
    }

    /**
     * Called by refreshOpenViews() to re-render the navigator.
     */
    refresh(): void {
        void (async () => {
            try {
                await this.plugin.researchManager?.scan();
            } catch {
                /* research folder may not exist yet */
            }
            this.renderList();
            this.renderProgress();
        })();
    }

    // ────────────────────────────────────────────────────────
    // Binder tree: Projects → Plotlines / Drafts / Scenes
    // ────────────────────────────────────────────────────────

    private async switchToProject(project: StoryLineProject): Promise<void> {
        const current = this.sceneManager.activeProject;
        if (current?.filePath === project.filePath) {
            this.toggleNode(`project:${project.filePath}`);
            return;
        }
        this.plotlineFilter = null;
        this.selectedScenePath = null;
        try {
            await this.sceneManager.setActiveProject(project);
            this.collapsedNodes.delete(`project:${project.filePath}`);
            await this.plugin.refreshOpenViews();
        } catch (err) {
            new Notice(t('Failed to open project: ') + String(err));
        }
    }

    private isCollapsed(key: string): boolean {
        return this.collapsedNodes.has(key);
    }

    private toggleNode(key: string): void {
        if (this.collapsedNodes.has(key)) this.collapsedNodes.delete(key);
        else this.collapsedNodes.add(key);
        this.renderList();
    }

    private setNavDepth(el: HTMLElement, depth: number): void {
        // Indent distance = depth × --sl-nav-indent-step (styles.css)
        el.style.setProperty('--sl-nav-depth', String(Math.max(0, depth)));
    }

    /** Fixed gutter so folder / file titles at the same depth share one text column. */
    private appendNavToggle(parent: HTMLElement, glyph: string): HTMLElement {
        const el = parent.createSpan('sl-nav-gutter-toggle');
        el.textContent = glyph;
        return el;
    }

    private appendNavIconSlot(parent: HTMLElement): HTMLElement {
        return parent.createSpan('sl-nav-gutter-icon');
    }

    private appendNavSeqSlot(parent: HTMLElement, text = ''): HTMLElement {
        const el = parent.createSpan('sl-nav-gutter-seq');
        if (text) el.textContent = text;
        return el;
    }

    private renderFolderHeader(
        parent: HTMLElement,
        opts: {
            key: string;
            label: string;
            icon?: string;
            count?: number;
            depth?: number;
            cls?: string;
            /** When false, never render a body (e.g. inactive project rows). */
            expandable?: boolean;
            onActivate?: () => void;
            onContextMenu?: (e: MouseEvent) => void;
            trailing?: (el: HTMLElement) => void;
        }
    ): { header: HTMLElement; expanded: boolean; body: HTMLElement | null } {
        const expandable = opts.expandable !== false;
        const expanded = expandable && !this.isCollapsed(opts.key);
        const depth = opts.depth ?? 0;
        const header = parent.createDiv({ cls: `sl-nav-folder ${opts.cls || ''}`.trim() });
        this.setNavDepth(header, depth);

        this.appendNavToggle(header, expandable ? (expanded ? '▾' : '▸') : ' ');
        const iconSlot = this.appendNavIconSlot(header);
        if (opts.icon) {
            iconSlot.addClass('has-icon');
            setIcon(iconSlot, opts.icon);
        }
        // Reserve seq column when this folder sits beside scene/note rows (depth ≥ 2).
        if (depth >= 2) this.appendNavSeqSlot(header);
        header.createSpan({ text: opts.label, cls: 'sl-nav-folder-label' });
        if (opts.count !== undefined) {
            header.createSpan({ text: String(opts.count), cls: 'sl-nav-folder-count' });
        }
        opts.trailing?.(header);

        header.addEventListener('click', (e) => {
            e.stopPropagation();
            if (opts.onActivate) opts.onActivate();
            else this.toggleNode(opts.key);
        });
        if (opts.onContextMenu) {
            header.addEventListener('contextmenu', (e) => {
                e.preventDefault();
                e.stopPropagation();
                opts.onContextMenu?.(e);
            });
        }

        const body = expanded ? parent.createDiv('sl-nav-folder-body') : null;
        return { header, expanded, body };
    }

    private renderList(): void {
        if (!this.listEl) return;
        this.listEl.empty();

        const projects = this.sceneManager.getProjects()
            .slice()
            .sort((a, b) => a.title.localeCompare(b.title, undefined, { sensitivity: 'base' }));
        const active = this.sceneManager.activeProject;

        if (projects.length === 0) {
            const empty = this.listEl.createDiv('sl-nav-empty');
            empty.textContent = t('No active project');
            return;
        }

        // Active project on top, then the rest alphabetically
        const ordered = active
            ? [active, ...projects.filter(p => p.filePath !== active.filePath)]
            : projects;

        for (const project of ordered) {
            const isActive = !!active && project.filePath === active.filePath;
            const key = `project:${project.filePath}`;
            const node = this.renderFolderHeader(this.listEl, {
                key,
                label: project.title,
                icon: isActive ? 'book-open' : 'book',
                cls: isActive
                    ? 'sl-nav-project-root is-active-project'
                    : 'sl-nav-project-root is-inactive-project',
                depth: 0,
                expandable: isActive,
                onActivate: () => { void this.switchToProject(project); },
            });

            if (isActive && node.expanded && node.body) {
                this.renderActiveProjectContents(node.body);
            }
        }
    }

    private renderPlotlinesFolder(parent: HTMLElement): void {
        const tags = this.sceneManager.queryService.getAllTags().sort();
        if (tags.length === 0) return;

        const label = this.plotlineFilter
            ? `${t('Plotlines')}: ${this.plotlineFilter}`
            : t('Plotlines');
        const plotNode = this.renderFolderHeader(parent, {
            key: 'plotlines',
            label,
            icon: 'waypoints',
            count: tags.length,
            depth: 2,
            cls: this.plotlineFilter ? 'sl-nav-plotlines-folder has-filter' : 'sl-nav-plotlines-folder',
        });
        if (!plotNode.expanded || !plotNode.body) return;

        const scheme = this.plugin.settings.colorScheme;
        const tagColors = this.plugin.settings.tagColors || {};
        const hslAdj = getPlotlineHSL(this.plugin.settings);
        const list = plotNode.body.createDiv('sl-nav-plotline-list');

        const paintPlotlineRow = (row: HTMLElement, color: string) => {
            this.setNavDepth(row, 3);
            this.appendNavToggle(row, ' ');
            const icon = this.appendNavIconSlot(row);
            const dot = icon.createSpan('sl-nav-plotline-dot');
            dot.setCssStyles({ background: color });
            this.appendNavSeqSlot(row);
        };

        const allRow = list.createDiv('sl-nav-plotline-item');
        if (!this.plotlineFilter) allRow.addClass('is-active');
        paintPlotlineRow(allRow, 'var(--text-faint)');
        allRow.createSpan({ text: t('All'), cls: 'sl-nav-plotline-name' });
        allRow.addEventListener('click', () => {
            this.plotlineFilter = null;
            this.renderList();
        });

        for (let i = 0; i < tags.length; i++) {
            const tag = tags[i];
            const color = resolveTagColor(tag, i, scheme, tagColors, hslAdj);
            const row = list.createDiv('sl-nav-plotline-item');
            if (this.plotlineFilter === tag) row.addClass('is-active');
            paintPlotlineRow(row, color);
            row.createSpan({ text: tag, cls: 'sl-nav-plotline-name' });
            const count = this.sceneManager.getAllScenes()
                .filter(s => !s.corkboardNote && !s.inactive && s.tags?.includes(tag)).length;
            row.createSpan({ text: String(count), cls: 'sl-nav-plotline-count' });
            row.addEventListener('click', () => {
                this.plotlineFilter = this.plotlineFilter === tag ? null : tag;
                // Keep plotlines open while a filter is active
                this.collapsedNodes.delete('plotlines');
                this.renderList();
            });
        }
    }

    private renderActiveProjectContents(parent: HTMLElement): void {
        // Primary binder: Notes → Scenes → Research
        this.renderNotesFolder(parent);
        this.renderScenesFolder(parent);
        this.renderResearchFolder(parent);
    }

    private renderScenesFolder(parent: HTMLElement): void {
        const drafts = this.sceneManager.getDrafts();
        const activeDraft = this.sceneManager.getActiveDraft();

        let scenes = this.sceneManager.getScenesForDraft();
        if (this.plotlineFilter) {
            scenes = scenes.filter(s => s.tags?.includes(this.plotlineFilter!));
        }
        if (this.filterText) {
            scenes = scenes.filter(s =>
                s.title.toLowerCase().includes(this.filterText) ||
                (s.pov?.toLowerCase().includes(this.filterText)) ||
                (s.tags?.some(tag => tag.toLowerCase().includes(this.filterText)))
            );
        }
        scenes = this.sortScenes(scenes);

        // Always "Scenes" — draft variants are equal; switch via the layers menu when needed.
        const scenesNode = this.renderFolderHeader(parent, {
            key: 'scenes',
            label: t('Scenes'),
            icon: 'file-text',
            count: scenes.length,
            depth: 1,
            cls: 'sl-nav-primary-folder',
            onContextMenu: (e) => this.showScenesFolderMenu(e),
            trailing: (el) => {
                if (drafts.length > 1) {
                    const draftBtn = el.createSpan('sl-nav-folder-action is-always');
                    setIcon(draftBtn, 'layers');
                    const activeLabel = activeDraft
                        ? t(this.sceneManager.draftDisplayTitle(activeDraft))
                        : t('Drafts');
                    attachTooltip(draftBtn, activeLabel);
                    draftBtn.addEventListener('click', (ev) => {
                        ev.stopPropagation();
                        this.showDraftPickerMenu(ev as MouseEvent);
                    });
                }
                const add = el.createSpan('sl-nav-folder-action is-always');
                setIcon(add, 'plus');
                attachTooltip(add, t('Create new scene'));
                add.addEventListener('click', (ev) => {
                    ev.stopPropagation();
                    this.openNewScene();
                });
            },
        });
        if (!scenesNode.expanded || !scenesNode.body) return;

        // Plotline filter stays nested under Scenes (secondary)
        this.renderPlotlinesFolder(scenesNode.body);

        if (scenes.length === 0) {
            const empty = scenesNode.body.createDiv('sl-nav-empty');
            if (this.filterText || this.plotlineFilter) {
                empty.textContent = t('No matching scenes');
            } else {
                empty.createSpan({ text: t('No scenes yet') });
                const addLink = empty.createEl('button', {
                    cls: 'sl-nav-empty-action',
                    text: t('Create new scene'),
                    attr: { type: 'button' },
                });
                addLink.addEventListener('click', () => this.openNewScene());
            }
            return;
        }

        if (this.sortMode === 'reading') {
            this.renderGroupedByAct(scenes, scenesNode.body, 2);
        } else if (this.sortMode === 'chapter') {
            this.renderGroupedByChapter(scenes, scenesNode.body, 2);
        } else {
            for (const scene of scenes) {
                this.renderSceneRow(scenesNode.body, scene, 2);
            }
        }
    }

    private showDraftPickerMenu(e: MouseEvent): void {
        const menu = new Menu();
        const drafts = this.sceneManager.getDrafts();
        const activeId = this.sceneManager.getActiveDraft()?.id;
        for (const draft of drafts) {
            menu.addItem(item => {
                item.setTitle(t(this.sceneManager.draftDisplayTitle(draft)));
                item.setIcon('layers');
                if (draft.id === activeId) item.setChecked(true);
                item.onClick(async () => {
                    if (draft.id === activeId) return;
                    await this.sceneManager.setActiveDraft(draft.id);
                    this.plugin.refreshOpenViews();
                });
            });
        }
        menu.addSeparator();
        menu.addItem(item => {
            item.setTitle(t('New draft'));
            item.setIcon('plus');
            item.onClick(() => this.promptNewDraft());
        });
        const active = this.sceneManager.getActiveDraft();
        if (active?.folder) {
            menu.addItem(item => {
                item.setTitle(t('Rename draft'));
                item.setIcon('pencil');
                item.onClick(() => this.promptRenameDraft(active));
            });
        }
        menu.showAtMouseEvent(e);
    }

    private renderNotesFolder(parent: HTMLElement): void {
        let notes = this.sceneManager.getAllScenes().filter(s => s.corkboardNote);
        if (this.filterText) {
            notes = notes.filter(s =>
                s.title.toLowerCase().includes(this.filterText) ||
                (s.tags?.some(tag => tag.toLowerCase().includes(this.filterText)))
            );
        }
        notes = notes.slice().sort((a, b) =>
            a.title.localeCompare(b.title, undefined, { sensitivity: 'base' })
        );

        const notesNode = this.renderFolderHeader(parent, {
            key: 'notes',
            label: t('Notes'),
            icon: 'sticky-note',
            count: notes.length,
            depth: 1,
            cls: 'sl-nav-primary-folder',
            trailing: (el) => {
                const add = el.createSpan('sl-nav-folder-action is-always');
                setIcon(add, 'plus');
                attachTooltip(add, t('New note'));
                add.addEventListener('click', (ev) => {
                    ev.stopPropagation();
                    this.promptNewNote();
                });
            },
        });
        if (!notesNode.expanded || !notesNode.body) return;

        if (notes.length === 0) {
            const empty = notesNode.body.createDiv('sl-nav-empty');
            empty.createSpan({ text: this.filterText ? t('No matching notes') : t('No notes yet') });
            return;
        }

        for (const note of notes) {
            this.renderNoteRow(notesNode.body, note, 2);
        }
    }

    private renderNoteRow(parent: HTMLElement, note: Scene, depth = 2): void {
        const row = parent.createDiv({
            cls: `sl-nav-row sl-nav-note-row${this.selectedScenePath === note.filePath ? ' is-selected' : ''}`,
        });
        this.setNavDepth(row, depth);
        this.appendNavToggle(row, ' ');
        const icon = this.appendNavIconSlot(row);
        icon.addClass('has-icon');
        setIcon(icon, 'sticky-note');
        this.appendNavSeqSlot(row);
        row.createSpan({ text: note.title || t('Untitled note'), cls: 'sl-nav-title' });

        row.addEventListener('click', () => {
            void this.openSceneFromNav(note);
        });
        row.addEventListener('contextmenu', (e) => {
            e.preventDefault();
            const menu = new Menu();
            menu.addItem(item => {
                item.setTitle(t('Open in new tab'));
                item.setIcon('file-plus');
                item.onClick(async () => {
                    const file = this.app.vault.getAbstractFileByPath(note.filePath);
                    if (file instanceof TFile) {
                        await this.app.workspace.getLeaf('tab').openFile(file, {
                            state: { mode: 'source', source: false },
                        });
                    }
                });
            });
            menu.addItem(item => {
                item.setTitle(t('Delete Note'));
                item.setIcon('trash');
                item.onClick(async () => {
                    await this.sceneManager.deleteScene(note.filePath);
                    this.plugin.refreshOpenViews();
                });
            });
            menu.showAtMouseEvent(e);
        });
    }

    private renderResearchFolder(parent: HTMLElement): void {
        const mgr = this.plugin.researchManager;
        if (!mgr) return;

        let posts = mgr.getAllPosts();
        if (this.filterText) {
            const q = this.filterText;
            posts = posts.filter(p =>
                p.title.toLowerCase().includes(q) ||
                p.tags.some(tag => tag.toLowerCase().includes(q))
            );
        }
        posts = posts.slice().sort((a, b) =>
            a.title.localeCompare(b.title, undefined, { sensitivity: 'base' })
        );

        const researchNode = this.renderFolderHeader(parent, {
            key: 'research',
            label: t('Research'),
            icon: 'library-big',
            count: posts.length,
            depth: 1,
            cls: 'sl-nav-primary-folder',
            trailing: (el) => {
                const add = el.createSpan('sl-nav-folder-action is-always');
                setIcon(add, 'plus');
                attachTooltip(add, t('New research post'));
                add.addEventListener('click', (ev) => {
                    ev.stopPropagation();
                    this.promptNewResearch();
                });
            },
        });
        if (!researchNode.expanded || !researchNode.body) return;

        if (posts.length === 0) {
            const empty = researchNode.body.createDiv('sl-nav-empty');
            empty.createSpan({
                text: this.filterText ? t('No matching research') : t('No research posts yet'),
            });
            return;
        }

        for (const post of posts) {
            this.renderResearchRow(researchNode.body, post, 2);
        }
    }

    private renderResearchRow(parent: HTMLElement, post: ResearchPost, depth = 2): void {
        const row = parent.createDiv('sl-nav-row sl-nav-research-row');
        this.setNavDepth(row, depth);
        this.appendNavToggle(row, ' ');
        const icon = this.appendNavIconSlot(row);
        icon.addClass('has-icon');
        setIcon(icon, RESEARCH_TYPE_CONFIG[post.researchType]?.icon || 'file-text');
        this.appendNavSeqSlot(row);
        row.createSpan({ text: post.title || t('Untitled'), cls: 'sl-nav-title' });
        if (post.subfolder) {
            row.createSpan({ text: post.subfolder, cls: 'sl-nav-folder-count' });
        }

        row.addEventListener('click', () => {
            void this.openVaultFile(post.filePath);
        });
        row.addEventListener('contextmenu', (e) => {
            e.preventDefault();
            const menu = new Menu();
            menu.addItem(item => {
                item.setTitle(t('Open in new tab'));
                item.setIcon('file-plus');
                item.onClick(async () => {
                    const file = this.app.vault.getAbstractFileByPath(post.filePath);
                    if (file instanceof TFile) {
                        await this.app.workspace.getLeaf('tab').openFile(file, {
                            state: { mode: 'source', source: false },
                        });
                    }
                });
            });
            menu.addItem(item => {
                item.setTitle(t('Open Research panel'));
                item.setIcon('library-big');
                item.onClick(() => { void this.plugin.openResearch(); });
            });
            menu.showAtMouseEvent(e);
        });
    }

    private async openVaultFile(filePath: string): Promise<void> {
        const file = this.app.vault.getAbstractFileByPath(filePath);
        if (!(file instanceof TFile)) return;
        await this.app.workspace.getLeaf(false).openFile(file, {
            state: { mode: 'source', source: false },
        });
    }

    private promptNewNote(): void {
        new DraftNameModal(this.app, t('New note'), t('Untitled note'), async (name) => {
            const file = await this.sceneManager.createScene({
                title: name,
                status: 'idea',
                corkboardNote: true,
            });
            this.selectedScenePath = file.path;
            this.collapsedNodes.delete('notes');
            this.plugin.refreshOpenViews();
            await this.app.workspace.getLeaf('tab').openFile(file, {
                state: { mode: 'source', source: false },
            });
        }).open();
    }

    private promptNewResearch(): void {
        new DraftNameModal(this.app, t('New research post'), t('Untitled'), async (name) => {
            const post = await this.plugin.researchManager.createPost(name, 'note');
            this.collapsedNodes.delete('research');
            await this.plugin.researchManager.scan();
            this.renderList();
            await this.openVaultFile(post.filePath);
        }).open();
    }

    private showScenesFolderMenu(e: MouseEvent): void {
        const menu = new Menu();
        menu.addItem(item => {
            item.setTitle(t('Create new scene'));
            item.setIcon('plus');
            item.onClick(() => this.openNewScene());
        });
        menu.addSeparator();
        menu.addItem(item => {
            item.setTitle(t('Drafts'));
            item.setIcon('layers');
            item.onClick(() => this.showDraftPickerMenu(e));
        });
        menu.addItem(item => {
            item.setTitle(t('New draft'));
            item.setIcon('plus');
            item.onClick(() => this.promptNewDraft());
        });
        menu.showAtMouseEvent(e);
    }

    /** Quick-add a scene into the active project (and scoped draft if needed). */
    private openNewScene(): void {
        if (!this.sceneManager.activeProject) {
            new Notice(t('No active project'));
            return;
        }
        const modal = new QuickAddModal(
            this.app,
            this.plugin,
            this.sceneManager,
            async (sceneData, openAfter) => {
                const file = await this.sceneManager.createScene(sceneData);
                const draft = this.sceneManager.getActiveDraft();
                const project = this.sceneManager.activeProject;
                // Scoped drafts keep an explicit path list — append so the new
                // scene appears in the binder for the active draft.
                if (project && draft?.scenePaths && draft.scenePaths.length > 0
                    && !draft.scenePaths.includes(file.path)) {
                    draft.scenePaths = [...draft.scenePaths, file.path];
                    await this.sceneManager.saveProjectFrontmatter(project);
                }
                this.selectedScenePath = file.path;
                this.collapsedNodes.delete('scenes');
                this.plugin.refreshOpenViews();
                if (openAfter) {
                    await this.app.workspace.getLeaf('tab').openFile(file, {
                        state: { mode: 'source', source: false },
                    });
                }
            }
        );
        modal.open();
    }

    private promptNewDraft(): void {
        const n = this.sceneManager.getDrafts().length + 1;
        new DraftNameModal(this.app, t('New draft'), `${t('Draft')} ${n}`, async (name) => {
            await this.sceneManager.createDraft(name, true);
            this.collapsedNodes.delete('drafts');
            this.plugin.refreshOpenViews();
        }).open();
    }

    private promptRenameDraft(draft: ProjectDraft): void {
        const current = this.sceneManager.draftDisplayTitle(draft);
        new DraftNameModal(this.app, t('Rename draft'), current, async (name) => {
            await this.sceneManager.renameDraft(draft.id, name);
            this.plugin.refreshOpenViews();
        }).open();
    }

    private renderGroupedByAct(scenes: Scene[], parent: HTMLElement, depth = 0): void {
        const ungroupedKey = '__ungrouped__';
        // Stable keys (not translated labels) so collapse state survives language/UI passes.
        const groups = new Map<string, Scene[]>();
        const labels = new Map<string, string>();
        for (const scene of scenes) {
            const actKey = scene.act !== undefined && scene.act !== null && scene.act !== ''
                ? `act:${String(scene.act)}`
                : ungroupedKey;
            if (!groups.has(actKey)) {
                groups.set(actKey, []);
                labels.set(
                    actKey,
                    actKey === ungroupedKey ? t('Ungrouped') : t(getActDisplayLabel(scene.act))
                );
            }
            groups.get(actKey)!.push(scene);
        }

        if (groups.size === 1 && groups.has(ungroupedKey)) {
            for (const scene of scenes) {
                this.renderSceneRow(parent, scene, depth);
            }
            return;
        }

        for (const [actKey, actScenes] of groups) {
            const actLabel = labels.get(actKey) ?? actKey;
            const isCollapsed = this.collapsedActs.has(actKey);

            const header = parent.createDiv('sl-nav-act-header');
            this.setNavDepth(header, depth);
            this.appendNavToggle(header, isCollapsed ? '▸' : '▾');
            this.appendNavIconSlot(header);
            this.appendNavSeqSlot(header);
            header.createSpan({ text: actLabel, cls: 'sl-nav-act-label' });
            const count = header.createSpan({ cls: 'sl-nav-act-count' });
            count.textContent = `${actScenes.length}`;

            header.addEventListener('click', () => {
                if (this.collapsedActs.has(actKey)) this.collapsedActs.delete(actKey);
                else this.collapsedActs.add(actKey);
                this.renderList();
            });

            if (!isCollapsed) {
                for (const scene of actScenes) {
                    this.renderSceneRow(parent, scene, depth + 1);
                }
            }
        }
    }

    /**
     * Issue #113 — "By chapter" grouping. Scenes are grouped under chapter
     * headers only; the Act level is hidden entirely (the user picked this
     * mode precisely to flatten Acts away). Scenes are visually nested
     * inside their chapter's container so they read as children, not peers.
     */
    private renderGroupedByChapter(scenes: Scene[], parent: HTMLElement, depth = 0): void {
        const groups = new Map<string, Scene[]>();
        for (const scene of scenes) {
            const ch = scene.chapter !== undefined && scene.chapter !== null && String(scene.chapter).trim() !== ''
                ? `Chapter ${scene.chapter}`
                : 'Unassigned';
            if (!groups.has(ch)) groups.set(ch, []);
            groups.get(ch)!.push(scene);
        }

        if (groups.size === 1 && groups.has('Unassigned')) {
            for (const scene of scenes) {
                this.renderSceneRow(parent, scene, depth);
            }
            return;
        }

        for (const [chKey, chScenes] of groups) {
            const isCollapsed = this.collapsedChapters.has(chKey);

            const header = parent.createDiv('sl-nav-chapter-header');
            this.setNavDepth(header, depth);
            this.appendNavToggle(header, isCollapsed ? '▸' : '▾');
            this.appendNavIconSlot(header);
            this.appendNavSeqSlot(header);
            header.createSpan({ text: chKey, cls: 'sl-nav-chapter-label' });
            const count = header.createSpan({ cls: 'sl-nav-chapter-count' });
            count.textContent = `${chScenes.length}`;

            header.addEventListener('click', () => {
                if (this.collapsedChapters.has(chKey)) {
                    this.collapsedChapters.delete(chKey);
                } else {
                    this.collapsedChapters.add(chKey);
                }
                this.renderList();
            });

            if (!isCollapsed) {
                const body = parent.createDiv('sl-nav-chapter-body');
                for (const scene of chScenes) {
                    this.renderSceneRow(body, scene, depth + 1);
                }
            }
        }
    }

    private renderSceneRow(parent: HTMLElement, scene: Scene, depth = 0): void {
        const row = parent.createDiv('sl-nav-row');
        row.dataset.scenePath = scene.filePath;
        this.setNavDepth(row, depth);
        const isPinned = this.pinnedScenes.has(scene.filePath);
        if (isPinned) row.addClass('is-pinned');
        if (this.selectedScenePath === scene.filePath) row.addClass('is-selected');

        // Same gutters as folders/notes at this depth → titles share one column.
        this.appendNavToggle(row, ' ');
        const iconSlot = this.appendNavIconSlot(row);
        const dot = iconSlot.createSpan('sl-nav-status-dot');
        const statusCfg = resolveStatusCfg(scene.status || 'idea');
        dot.setCssStyles({ background: statusCfg.color });
        dot.setAttribute('aria-label', t(statusCfg.label));

        this.appendNavSeqSlot(
            row,
            scene.sequence !== undefined ? String(scene.sequence) : ''
        );

        const title = row.createSpan('sl-nav-title');
        title.textContent = scene.title;

        // Word count
        if (scene.wordcount && scene.wordcount > 0) {
            const wc = row.createSpan('sl-nav-wc');
            wc.textContent = scene.wordcount >= 1000
                ? `${(scene.wordcount / 1000).toFixed(1)}k`
                : `${scene.wordcount}`;
        }

        // Click: scroll in Manuscript only when that view is active; otherwise open the note.
        // (Previously any existing Manuscript leaf — even hidden in another split — swallowed
        // the click with a silent scroll, so the binder looked dead.)
        row.addEventListener('click', () => {
            void this.openSceneFromNav(scene);
        });

        // Context menu
        row.addEventListener('contextmenu', (e) => {
            e.preventDefault();
            const menu = new Menu();

            menu.addItem((item) => {
                item.setTitle(isPinned ? 'Unpin' : 'Pin to top');
                item.setIcon(isPinned ? 'pin-off' : 'pin');
                item.onClick(() => {
                    if (isPinned) {
                        this.pinnedScenes.delete(scene.filePath);
                    } else {
                        this.pinnedScenes.add(scene.filePath);
                    }
                    this.renderList();
                });
            });

            menu.addItem((item) => {
                item.setTitle(t('Open in new tab'));
                item.setIcon('file-plus');
                item.onClick(async () => {
                    const file = this.app.vault.getAbstractFileByPath(scene.filePath);
                    if (file instanceof TFile) {
                        await this.app.workspace.getLeaf('tab').openFile(file, { state: { mode: 'source', source: false } });
                    }
                });
            });

            menu.addSeparator();

            // Scene color picker
            menu.addItem((item) => {
                item.setTitle(scene.color ? 'Change Color' : 'Set Color');
                item.setIcon('palette');
                item.onClick(() => {
                    SceneCardComponent.openColorPicker(this.app, scene, this.sceneManager, () => this.renderList());
                });
            });

            // Archive
            menu.addItem((item) => {
                item.setTitle(t('Archive Scene'));
                item.setIcon('archive');
                item.onClick(async () => {
                    await this.sceneManager.archiveScene(scene.filePath);
                    this.renderList();
                });
            });

            // Status submenu
            const statuses = getStatusOrder();
            for (const status of statuses) {
                menu.addItem((item) => {
                    const cfg = resolveStatusCfg(status);
                    item.setTitle(cfg.label);
                    item.setIcon(cfg.icon);
                    if (scene.status === status) item.setChecked(true);
                    item.onClick(async () => {
                        await this.sceneManager.updateScene(scene.filePath, { status });
                        this.plugin.refreshOpenViews();
                    });
                });
            }

            menu.showAtMouseEvent(e);
        });
    }

    /**
     * Open / focus a scene from the binder.
     * Manuscript scroll is used only when Manuscript is the active leaf and the
     * scene block is present; otherwise we open the markdown file so the click
     * always produces a visible result.
     */
    private async openSceneFromNav(scene: Scene): Promise<void> {
        this.selectedScenePath = scene.filePath;
        this.applySceneSelection();

        const activeView = this.app.workspace.getActiveViewOfType(ItemView);
        const manuscriptIsActive = activeView?.getViewType() === MANUSCRIPT_VIEW_TYPE;
        if (manuscriptIsActive) {
            const leaf = this.app.workspace.getLeavesOfType(MANUSCRIPT_VIEW_TYPE)[0];
            const manuscriptView = leaf?.view as ManuscriptView | undefined;
            if (manuscriptView?.scrollToScene(scene.filePath)) {
                this.app.workspace.setActiveLeaf(leaf, { focus: true });
                return;
            }
        }

        const file = this.app.vault.getAbstractFileByPath(scene.filePath);
        if (!(file instanceof TFile)) {
            new Notice(t('Could not find file: {path}', { path: scene.filePath }));
            return;
        }
        // Issue #224 — focus an already-open tab for this file instead of opening a duplicate.
        const existingLeaf = this.app.workspace.getLeavesOfType('markdown')
            .find(l => l.getViewState()?.state?.file === scene.filePath);
        if (existingLeaf) {
            this.app.workspace.setActiveLeaf(existingLeaf, { focus: true });
        } else {
            await this.app.workspace.getLeaf('tab').openFile(file, {
                state: { mode: 'source', source: false },
            });
        }
    }

    /** Update `.is-selected` on scene rows without a full list rebuild. */
    private applySceneSelection(): void {
        if (!this.listEl) return;
        this.listEl.querySelectorAll('.sl-nav-row.is-selected').forEach(el => {
            el.removeClass('is-selected');
        });
        if (!this.selectedScenePath) return;
        const row = this.listEl.querySelector(
            `.sl-nav-row[data-scene-path="${CSS.escape(this.selectedScenePath)}"]`
        );
        row?.addClass('is-selected');
    }

    private sortScenes(scenes: Scene[]): Scene[] {
        // Pinned scenes always come first
        const pinned = scenes.filter(s => this.pinnedScenes.has(s.filePath));
        const unpinned = scenes.filter(s => !this.pinnedScenes.has(s.filePath));

        const sortFn = (a: Scene, b: Scene): number => {
            switch (this.sortMode) {
                case 'reading': {
                    // Reading order: act → chapter → sequence.
                    // compareActChapter handles numeric vs string acts ("1.1", "Prologue")
                    // and sorts missing values last.
                    const actCmp = compareActChapter(a.act, b.act);
                    if (actCmp !== 0) return actCmp;
                    const chapterCmp = compareActChapter(a.chapter, b.chapter);
                    if (chapterCmp !== 0) return chapterCmp;
                    return (a.sequence ?? 9999) - (b.sequence ?? 9999);
                }
                case 'chronological': {
                    // Prefer chronologicalOrder, then storyDate+storyTime, then sequence
                    if (a.chronologicalOrder != null || b.chronologicalOrder != null) {
                        return (a.chronologicalOrder ?? 9999) - (b.chronologicalOrder ?? 9999);
                    }
                    if (a.storyDate || b.storyDate) {
                        const aKey = (a.storyDate || '') + ' ' + (a.storyTime || '');
                        const bKey = (b.storyDate || '') + ' ' + (b.storyTime || '');
                        const cmp = aKey.localeCompare(bKey);
                        if (cmp !== 0) return cmp;
                    }
                    return (a.sequence ?? 9999) - (b.sequence ?? 9999);
                }
                case 'status': {
                    const order = getStatusOrder();
                    return order.indexOf(a.status || 'idea') - order.indexOf(b.status || 'idea');
                }
                case 'recent': {
                    // Use file system mtime (more accurate for content edits)
                    // than YAML 'modified' which only updates on metadata changes
                    const aFile = this.app.vault.getAbstractFileByPath(a.filePath);
                    const bFile = this.app.vault.getAbstractFileByPath(b.filePath);
                    const aMtime = (aFile instanceof TFile) ? aFile.stat.mtime : 0;
                    const bMtime = (bFile instanceof TFile) ? bFile.stat.mtime : 0;
                    // Fallback to YAML modified if file lookup fails
                    const aTime = aMtime || (a.modified ? new Date(a.modified).getTime() : 0);
                    const bTime = bMtime || (b.modified ? new Date(b.modified).getTime() : 0);
                    return bTime - aTime; // newest first
                }
                case 'words':
                    return (b.wordcount || 0) - (a.wordcount || 0);
                case 'title':
                    return a.title.localeCompare(b.title);
                default:
                    return 0;
            }
        };

        pinned.sort(sortFn);
        unpinned.sort(sortFn);
        return [...pinned, ...unpinned];
    }

    // ────────────────────────────────────────────────────────
    // Progress bar
    // ────────────────────────────────────────────────────────

    private renderProgress(): void {
        if (!this.progressBar || !this.progressLabel) return;

        const stats = this.sceneManager.queryService.getStatistics();
        const totalWords = stats.totalWords;
        const targetWords = stats.totalTargetWords;

        if (targetWords > 0) {
            const pct = Math.min(100, Math.round((totalWords / targetWords) * 100));
            const fill = this.progressBar.querySelector('.sl-nav-progress-fill') as HTMLElement;
            if (fill) fill.setCssStyles({ width: `${pct}%` });
            this.progressLabel.textContent = `${this.formatWords(totalWords)} / ${this.formatWords(targetWords)} (${pct}%)`;
        } else {
            const fill = this.progressBar.querySelector('.sl-nav-progress-fill') as HTMLElement;
            if (fill) fill.setCssStyles({ width: '0%' });
            const totalScenes = this.sceneManager.getAllScenes().filter(s => !s.corkboardNote && !s.inactive).length;
            this.progressLabel.textContent = `${this.formatWords(totalWords)} words · ${totalScenes} scenes`;
        }
    }

    private formatWords(n: number): string {
        if (n >= 1000) return `${(n / 1000).toFixed(1)}k`;
        return String(n);
    }
}

/** Small modal for naming / renaming a draft. */
class DraftNameModal extends Modal {
    private titleText: string;
    private initial: string;
    private onSubmit: (name: string) => void | Promise<void>;
    private value: string;

    constructor(app: import('obsidian').App, titleText: string, initial: string, onSubmit: (name: string) => void | Promise<void>) {
        super(app);
        this.titleText = titleText;
        this.initial = initial;
        this.value = initial;
        this.onSubmit = onSubmit;
    }

    onOpen(): void {
        this.titleEl.setText(this.titleText);
        new Setting(this.contentEl)
            .setName(t('Name'))
            .addText(text => {
                text.setValue(this.initial);
                text.inputEl.focus();
                text.inputEl.select();
                text.onChange(v => { this.value = v; });
                text.inputEl.addEventListener('keydown', async (e) => {
                    if (e.key === 'Enter') {
                        e.preventDefault();
                        await this.submit();
                    }
                });
            });
        new Setting(this.contentEl)
            .addButton(btn => btn.setButtonText(t('Cancel')).onClick(() => this.close()))
            .addButton(btn => btn.setButtonText(t('Save')).setCta().onClick(() => this.submit()));
    }

    private async submit(): Promise<void> {
        const name = this.value.trim();
        if (!name) return;
        this.close();
        await this.onSubmit(name);
    }
}
/* eslint-enable @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-argument, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-return, @typescript-eslint/no-floating-promises, @typescript-eslint/no-misused-promises, @typescript-eslint/no-unnecessary-type-assertion, @typescript-eslint/no-redundant-type-constituents, @typescript-eslint/no-unused-vars, no-unused-vars, no-useless-escape, no-control-regex, no-empty -- end of file-wide suppression block opened at line 1 */
