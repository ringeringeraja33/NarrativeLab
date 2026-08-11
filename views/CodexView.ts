/* eslint-disable @typescript-eslint/no-floating-promises, @typescript-eslint/no-misused-promises, @typescript-eslint/no-unnecessary-type-assertion, @typescript-eslint/no-unused-vars -- Obsidian's API surface and several untyped third-party libraries force dynamic dispatch; floating promises are intentional in DOM/event handlers; matching enable at end of file */
import { App, ItemView, WorkspaceLeaf, Menu, Modal, Setting, Notice, TFile, normalizePath } from 'obsidian';
import * as obsidian from 'obsidian';
import type SceneCardsPlugin from '../main';
import { SceneManager } from '../services/SceneManager';
import { CodexManager } from '../services/CodexManager';
import { CodexEntry, CodexCategoryDef, CodexFieldCategory, CodexFieldDef, BUILTIN_CODEX_CATEGORIES, UNCATEGORIZED_CATEGORY_ID, makeCustomCodexCategory, makeProfileCodexCategory, makeUncategorizedCodexCategory, CODEX_ICON_OPTIONS, withLinkingSection } from '../models/Codex';
import { CHARACTER_CATEGORIES } from '../models/Character';
import { LOCATION_CATEGORIES, WORLD_CATEGORIES } from '../models/Location';
import { CODEX_VIEW_TYPE, CHARACTER_VIEW_TYPE, LOCATION_VIEW_TYPE } from '../constants';
import { renderViewSwitcher } from '../components/ViewSwitcher';
import { promptDeleteCategory, renderCodexCategoryTabs } from '../components/CodexCategoryTabs';
import { applyMobileClass, isMobile } from '../components/MobileAdapter';
import {
    getLibraryContentMode,
    renderLibraryStoryGraph,
    setLibraryContentMode,
    syncStoryGraphLibraryNodeTypes,
} from '../components/LibraryModeBar';
import type { StoryGraph } from '../components/StoryGraph';
import { pickImage as pickImageModal, resolveImagePath } from '../components/ImagePicker';
import { AddFieldModal } from '../components/AddFieldModal';
import { attachTooltip } from '../components/Tooltip';
import { openConfirmModal } from '../components/ConfirmModal';
import {
    collectDelimitedTags,
    collectHashtagsFromText,
    renderLibraryFilterChips,
} from '../components/LibraryFilterChips';
import {
    CUSTOM_SECTION_KEY_SEP,
    renderCustomSectionsAtSlot,
    renderAddCustomSectionButton,
    type CustomSectionsHost,
} from '../components/CustomSectionsRenderer';
import type { UniversalFieldTemplate } from '../services/FieldTemplateService';
import { t } from '../utils/i18n';
import { coerceString } from '../utils/narrow';
import { setLibraryCategoryProfileSetting } from '../utils/libraryCategoryTransactions';
import {
    applyCategoryFolderLabels,
    ensureSeededLibraryCategoryLabels,
    isSeedLibraryCategoryLabel,
    reconcileLibraryCategoriesForActiveProject,
    renameLibraryCategory,
    resolveLibraryCategoryLabel,
    sanitizeLibraryFolderName,
} from '../services/LibraryCategorySync';
import { VirtualScroller } from '../components/VirtualScroller';
import {
    ALL_LIBRARY_CATEGORY_ID,
    disposeNativeLibraryBase,
    renderNativeLibraryBase,
} from '../components/NativeLibraryBase';
import {
    LIBRARY_BROWSE_PAGE_SIZE,
    compareLibraryTableValues,
    evaluateLibraryTableFormula,
    getLibraryBrowseLayout,
    getLibraryFilePropertyOptions,
    getLibraryFilePropertyValue,
    getLibraryNotePropertyOptions,
    getLibraryNotePropertyValue,
    getLibraryTableColumns,
    getLibraryTableFormulas,
    getLibraryTableSort,
    pageSlice,
    renderLibraryBrowseToolbar,
    renderLibraryTableHeader,
    setLibraryTableColumns,
    setLibraryTableSort,
} from '../components/LibraryBrowseLayout';

/** One row in the Library list (codex entry or hub Character/Location shortcut). */
type CodexListRow =
    | { kind: 'entry'; entry: CodexEntry; catDef: CodexCategoryDef }
    | { kind: 'hub'; name: string; icon: string; badge: string; onClick: () => void };

type ManagedCodexCategory = {
    id: string;
    label: string;
    icon: string;
    showInSidebar?: boolean;
    hasProfilePage?: boolean;
    preset?: boolean;
};

type CategoryManagerState = {
    enabled: Set<string>;
    categories: ManagedCodexCategory[];
    deletedPresets: Set<string>;
};

const FIXED_LIBRARY_CATEGORY_IDS = ['characters', 'locations', UNCATEGORIZED_CATEGORY_ID] as const;

function makeEntityFieldsDefinition(
    id: string,
    label: string,
    icon: string,
    sourceCategories: Array<{
        title: string;
        icon: string;
        fields: Array<{ key: string | number | symbol; label: string; placeholder: string; multiline?: boolean }>;
    }>,
): CodexCategoryDef {
    const categories = sourceCategories.map(category => ({
        title: category.title,
        icon: category.icon,
        fields: category.fields.map(field => ({
            key: String(field.key),
            label: field.label,
            placeholder: field.placeholder,
            multiline: field.multiline,
        })),
    }));
    return {
        id,
        label,
        icon,
        folder: label,
        categories,
        fieldKeys: Array.from(new Set(categories.flatMap(category => category.fields.map(field => field.key)))),
        builtIn: true,
    };
}

/**
 * Codex View — central hub for all codex categories.
 *
 * Shows category tabs (Characters, Locations, Items, …) across the top,
 * with a grid of entry cards below.  Clicking a card opens a detail editor
 * panel (split into form + side panel), following the same pattern as
 * CharacterView and LocationView.
 *
 * Characters and Locations tabs simply switch to their dedicated views.
 */
export class CodexView extends ItemView {
    private plugin: SceneCardsPlugin;
    private sceneManager: SceneManager;
    private codexManager: CodexManager;
    private rootContainer: HTMLElement | null = null;
    private storyGraph: StoryGraph | null = null;

    /** File path of the currently-selected entry, or null for overview */
    private selectedEntry: string | null = null;
    /** Active category tab id */
    private activeCategory: string = '';
    /** Category whose optional card/profile overview is currently open. */
    private profileOverviewCategoryId: string | null = null;
    private sortBy: 'name' | 'modified' | 'created' | 'type' = 'name';
    /** Active type/tag filters (lowercased). Empty = no filter. */
    private activeTagFilters: Set<string> = new Set();
    /** Sections collapsed in detail view */
    private collapsedSections: Set<string> = new Set();
    /** Search filter text */
    private searchText: string = '';
    /** Bases-style Search control expanded (default on so the field stays discoverable) */
    private browseSearchOpen = true;
    /** Bases-style Filter chips panel open (default on) */
    private browseFilterOpen = true;
    /** Debounce handle for Library search typing */
    private _searchTimer: number | null = null;
    /** Windowed list scroller for large Library overviews */
    private listScroller: VirtualScroller<CodexListRow> | null = null;
    /** How many cards/table rows to show (grows via Load more) */
    private browseShown = LIBRARY_BROWSE_PAGE_SIZE;

    // ── Auto-save state ────────────────────────────────
    private _saveTimer: number | null = null;
    private _lastSaveTime = 0;
    private _pendingDraft: CodexEntry | null = null;
    /** Last seen plugin.libraryCategoriesStructureEpoch (forces tab rebuild). */
    private _libraryCategoriesEpoch = 0;
    private static SAVE_DEBOUNCE_MS = 600;
    private static SAVE_REFRESH_GRACE_MS = 1500;

    /** Issue #102 — dropdowns portaled to <body> so position:fixed escapes
     *  ancestors with transform/contain. Cleaned up on each re-render. */
    private _portaledDropdowns: HTMLElement[] = [];
    private clearPortaledDropdowns(): void {
        for (const el of this._portaledDropdowns) { try { el.remove(); } catch { /* noop */ } }
        this._portaledDropdowns = [];
    }

    constructor(leaf: WorkspaceLeaf, plugin: SceneCardsPlugin, sceneManager: SceneManager) {
        super(leaf);
        this.plugin = plugin;
        this.sceneManager = sceneManager;
        this.codexManager = plugin.codexManager;
    }

    getViewType(): string { return CODEX_VIEW_TYPE; }
    getDisplayText(): string {
        const title = this.plugin?.sceneManager?.activeProject?.title;
        return title ? `NarrativeLab — ${title}` : 'NarrativeLab';
    }
    getIcon(): string { return 'book-open'; }

    async onOpen(): Promise<void> {
        this.plugin.storyLeaf = this.leaf;
        const container = this.containerEl.children[1] as HTMLElement;
        container.empty();
        container.addClass('story-line-codex-container');
        applyMobileClass(container);
        this.rootContainer = container;

        await this.sceneManager.initialize();

        // Load Library data once — skip if a recent refreshOpenViews already did.
        this.codexManager.initCategories(
            this.plugin.settings.codexEnabledCategories,
            this.resolveCustomDefs(),
        );
        if (!this.plugin.entitiesFresh()) {
            await this.plugin.reloadEntities();
        }

        // Reset to hub state — no category pre-selected
        this.activeCategory = '';
        this.selectedEntry = null;
        this.profileOverviewCategoryId = null;

        this.renderView(container);
    }

    async onClose(): Promise<void> {
        if (this._searchTimer !== null) {
            window.clearTimeout(this._searchTimer);
            this._searchTimer = null;
        }
        this.destroyListScroller();
        await this.flushPendingSave();
        activeDocument.querySelectorAll('.gallery-lightbox-window').forEach(w => w.remove());
        this.clearPortaledDropdowns();
    }

    private destroyListScroller(): void {
        this.listScroller?.destroy();
        this.listScroller = null;
    }

    /**
     * Public method so the ViewSwitcher dropdown can navigate directly
     * to a specific codex category tab.
     */
    setActiveCategory(categoryId: string): void {
        this.activeCategory = categoryId;
        this.selectedEntry = null;
        this.profileOverviewCategoryId = null;
        this.activeTagFilters.clear();
        this.browseShown = LIBRARY_BROWSE_PAGE_SIZE;
        if (this.rootContainer) this.renderView(this.rootContainer);
    }

    /**
     * Navigate directly to a codex entry's detail view by file path.
     */
    async navigateToEntry(filePath: string): Promise<void> {
        this.codexManager.initCategories(
            this.plugin.settings.codexEnabledCategories,
            this.resolveCustomDefs(),
        );
        let entry = this.codexManager.getEntry(filePath);
        if (!entry) {
            await this.plugin.reloadEntities();
            entry = this.codexManager.getEntry(filePath);
        }
        if (!entry) {
            new Notice(t('Library entry not found in the active project.'));
            return;
        }
        this.activeCategory = entry.type;
        this.selectedEntry = filePath;
        if (this.rootContainer) {
            this.renderView(this.rootContainer);
        }
    }

    /** Called by refreshOpenViews after entities are already reloaded. */
    async refresh(): Promise<void> {
        // Grace period — skip re-render if we just saved ourselves
        if (this.selectedEntry && (Date.now() - this._lastSaveTime) < CodexView.SAVE_REFRESH_GRACE_MS) {
            return;
        }
        const categoriesEpoch = this.plugin.libraryCategoriesStructureEpoch;
        const categoriesChanged = categoriesEpoch !== this._libraryCategoriesEpoch;
        this._libraryCategoriesEpoch = categoriesEpoch;
        // Native Bases already live-update rows. Remounting the embed on every
        // vault event makes the whole Library table flash — but new Library
        // folders must rebuild the category tab bar.
        if (
            !categoriesChanged
            && !this.selectedEntry
            && getLibraryContentMode(this.plugin) === 'browse'
            && this.rootContainer?.querySelector('.library-native-base-embed')
        ) {
            const title = this.plugin.getActiveProjectDisplayName();
            this.rootContainer.querySelectorAll('.story-line-view-title')
                .forEach(el => { el.textContent = title; });
            return;
        }
        // Keep Story Graph mounted so wheel zoom / pan are not reset by vault refresh.
        if (
            !categoriesChanged
            && !this.selectedEntry
            && getLibraryContentMode(this.plugin) === 'story-graph'
            && this.storyGraph
            && this.rootContainer?.querySelector('.story-graph-page')
        ) {
            const title = this.plugin.getActiveProjectDisplayName();
            this.rootContainer.querySelectorAll('.story-line-view-title')
                .forEach(el => { el.textContent = title; });
            return;
        }
        if (this.rootContainer) this.renderView(this.rootContainer);
    }

    // ══════════════════════════════════════════════════
    //  Render — main entry
    // ══════════════════════════════════════════════════

    private renderView(container: HTMLElement): void {
        disposeNativeLibraryBase(this);
        this.destroyListScroller();
        this.clearPortaledDropdowns(); // issue #102 — don't leak portaled popups across re-renders
        container.empty();

        // ── Toolbar ────────────────────────────────────
        const toolbar = container.createDiv('story-line-toolbar');
        const titleRow = toolbar.createDiv('story-line-title-row');
        titleRow.createEl('h3', { cls: 'story-line-view-title', text: this.plugin.getActiveProjectDisplayName() });
        renderViewSwitcher(toolbar, CODEX_VIEW_TYPE, this.plugin, this.leaf);

        // Same tab bar placement as CharacterView / LocationView (outside content)
        const profileAvailable = this.activeCategoryHasProfilePage();
        const profileActive = this.isProfileOverviewMode();
        const profileLabel = profileAvailable
            ? t('{name} Profiles', {
                name: resolveLibraryCategoryLabel(
                    this.plugin,
                    this.activeCategory,
                    this.codexManager.getCategoryDef(this.activeCategory)?.label || this.activeCategory,
                ),
            })
            : '';
        renderCodexCategoryTabs(container, {
            activeId: this.activeCategory || '',
            leaf: this.leaf,
            plugin: this.plugin,
            showModeToggle: !this.selectedEntry,
            onModeChange: () => {
                this.profileOverviewCategoryId = null;
                if (this.rootContainer) this.renderView(this.rootContainer);
            },
            profileMode: !this.selectedEntry && profileAvailable
                ? {
                    label: profileLabel,
                    active: profileActive,
                    onClick: () => {
                        this.profileOverviewCategoryId = this.activeCategory;
                        setLibraryContentMode(this.plugin, 'browse');
                        if (this.rootContainer) this.renderView(this.rootContainer);
                    },
                }
                : undefined,
            onCategoriesChanged: () => {
                if (this.rootContainer) this.renderView(this.rootContainer);
            },
            renderBeforeModeActions: this.selectedEntry || this.activeCategory !== UNCATEGORIZED_CATEGORY_ID
                ? undefined
                : (actions) => {
                const newUncategorizedBtn = actions.createEl('button', {
                    cls: 'character-mode-btn codex-new-uncategorized-tab',
                    attr: { type: 'button', 'aria-label': t('New uncategorized entry') },
                });
                const icon = newUncategorizedBtn.createSpan();
                obsidian.setIcon(icon, 'file-plus-2');
                newUncategorizedBtn.createSpan({ text: t('New uncategorized entry') });
                newUncategorizedBtn.addEventListener('click', () => this.promptNewUncategorizedEntry());
            },
            // Custom Categories button is always rendered by renderCodexCategoryTabs.
        });

        // ── Content area ───────────────────────────────
        const content = container.createDiv('story-line-codex-content');

        if (this.storyGraph) {
            this.storyGraph.destroy();
            this.storyGraph = null;
        }

        if (this.selectedEntry) {
            this.renderDetail(content);
        } else if (getLibraryContentMode(this.plugin) === 'story-graph' && !isMobile) {
            this.storyGraph = renderLibraryStoryGraph(content, this.plugin, () => {
                if (this.rootContainer) this.renderView(this.rootContainer);
            });
        } else {
            this.renderOverview(content);
        }
    }

    // ══════════════════════════════════════════════════
    //  Overview — heading + search + card grid
    // ══════════════════════════════════════════════════

    private renderOverview(container: HTMLElement): void {
        container.empty();
        if (getLibraryContentMode(this.plugin) === 'browse' && !this.isProfileOverviewMode()) {
            void renderNativeLibraryBase(
                container,
                this.plugin,
                this.activeCategory || ALL_LIBRARY_CATEGORY_ID,
                this,
            );
            return;
        }

        // ── Category heading (when a specific category is selected) ──
        if (this.activeCategory) {
            const catDef = this.codexManager.getCategoryDef(this.activeCategory);
            if (catDef) {
                container.createEl('h3', {
                    cls: 'codex-overview-heading',
                    text: catDef.id === UNCATEGORIZED_CATEGORY_ID
                        ? t('Uncategorized entries')
                        : catDef.label,
                });
            }
        }

        // ── Bases-style browse chrome ───────────────────
        const layoutKey = this.activeCategory || 'library-hub';
        const catDefForProps = this.activeCategory
            ? this.codexManager.getCategoryDef(this.activeCategory)
            : undefined;
        const cachedNoteProperties = catDefForProps
            ? getLibraryNotePropertyOptions(
                this.plugin,
                this.codexManager.getEntries(catDefForProps.id).map(entry => entry.filePath),
            )
            : [];
        const propertyOpts = catDefForProps
            ? [
                ...cachedNoteProperties,
                ...getLibraryFilePropertyOptions(),
            ]
            : undefined;
        const savedCols = getLibraryTableColumns(this.plugin, layoutKey);
        const selectedProps = savedCols !== undefined
            ? savedCols
            : (catDefForProps ? this.defaultTableColumns(catDefForProps) : []);

        const listContainer = container.createDiv('codex-list-container');
        const { searchInput, chipHost } = renderLibraryBrowseToolbar(container, {
            plugin: this.plugin,
            categoryId: layoutKey,
            sortOptions: [
                { value: 'name', label: t('Name') },
                { value: 'modified', label: t('Last edited') },
                { value: 'created', label: t('Date created') },
                { value: 'type', label: t('Type') },
            ],
            sortBy: this.sortBy,
            onSortChange: (value) => {
                this.sortBy = value as 'type' | 'name' | 'created' | 'modified';
                this.renderList(listContainer);
            },
            searchText: this.searchText,
            searchPlaceholder: t('Search entries…'),
            searchOpen: this.browseSearchOpen,
            onSearchOpenChange: (open) => {
                this.browseSearchOpen = open;
                if (this.rootContainer) this.renderView(this.rootContainer);
            },
            onSearchChange: (value) => {
                this.searchText = value;
                this.renderList(listContainer);
            },
            filterOpen: this.browseFilterOpen,
            filterCount: this.activeTagFilters.size,
            onFilterOpenChange: (open) => {
                this.browseFilterOpen = open;
                if (this.rootContainer) this.renderView(this.rootContainer);
            },
            properties: propertyOpts,
            selectedProperties: selectedProps,
            onPropertiesChange: async (keys) => {
                await setLibraryTableColumns(this.plugin, layoutKey, keys);
                this.renderList(listContainer);
            },
            onNew: this.activeCategory === UNCATEGORIZED_CATEGORY_ID
                ? undefined
                : () => this.promptNewEntry(),
            newLabel: t('New'),
            onLayoutChange: () => {
                this.browseShown = LIBRARY_BROWSE_PAGE_SIZE;
                this.renderList(listContainer);
            },
            showLayoutToggle: !this.isProfileOverviewMode(),
        });

        // Keep list after chrome in DOM order
        container.appendChild(listContainer);

        if (searchInput) {
            const hadFocus = activeDocument.activeElement?.closest('.story-line-codex-container') != null
                || activeDocument.activeElement?.classList.contains('library-browse-search-input');
            if (hadFocus || this.browseSearchOpen) {
                window.setTimeout(() => {
                    searchInput.focus();
                    searchInput.selectionStart = searchInput.selectionEnd = searchInput.value.length;
                }, 0);
            }
        }

        renderLibraryFilterChips(
            chipHost,
            this.collectTypeTagsForFilter(),
            this.activeTagFilters,
            () => {
                if (this.activeTagFilters.size > 0) this.browseFilterOpen = true;
                this.renderList(listContainer);
            },
        );

        this.renderList(listContainer);
    }

    /** Type field values + #hashtags from entry text fields. */
    private collectTypeTagsForFilter(): Map<string, string> {
        const isHub = !this.activeCategory;
        const catDef = isHub ? undefined : this.codexManager.getCategoryDef(this.activeCategory);
        const entries: CodexEntry[] = isHub
            ? this.codexManager.getAllEntries()
            : (catDef ? this.codexManager.getEntries(this.activeCategory) : []);
        const tags = new Map<string, string>();
        for (const entry of entries) {
            const def = isHub ? this.codexManager.getCategoryDef(entry.type) : catDef;
            if (!def) continue;
            collectDelimitedTags(tags, this.getTypeField(entry, def));
            for (const fieldKey of def.fieldKeys) {
                const val = entry[fieldKey];
                if (typeof val === 'string') collectHashtagsFromText(tags, val);
            }
            if (typeof entry.description === 'string') collectHashtagsFromText(tags, entry.description);
            if (typeof entry.notes === 'string') collectHashtagsFromText(tags, entry.notes);
        }
        return tags;
    }

    private collectEntryFilterKeys(entry: CodexEntry, def: CodexCategoryDef | undefined): string[] {
        const keys: string[] = [];
        const pushHashtags = (text: string) => {
            const re = /#([A-Za-z\u00C0-\u024F\u0400-\u04FF\u4E00-\u9FFF][\w\u00C0-\u024F\u0400-\u04FF\u4E00-\u9FFF-]*)/g;
            let m: RegExpExecArray | null;
            while ((m = re.exec(text)) !== null) keys.push(m[1].toLowerCase());
        };
        if (def) {
            const typeVal = this.getTypeField(entry, def);
            if (typeVal) {
                for (const part of String(typeVal).split(',').map(s => s.trim()).filter(Boolean)) {
                    keys.push(part.toLowerCase());
                }
            }
            for (const fieldKey of def.fieldKeys) {
                const val = entry[fieldKey];
                if (typeof val === 'string' && val.includes('#')) pushHashtags(val);
            }
        }
        if (typeof entry.description === 'string') pushHashtags(entry.description);
        if (typeof entry.notes === 'string') pushHashtags(entry.notes);
        return keys;
    }

    private renderList(container: HTMLElement): void {
        this.destroyListScroller();
        container.empty();
        const isHub = !this.activeCategory;
        const catDef = isHub ? undefined : this.codexManager.getCategoryDef(this.activeCategory);

        // Hub (no category): show every Library entry; category tab: that category only
        let entries: CodexEntry[] = isHub
            ? this.codexManager.getAllEntries()
            : (catDef ? this.codexManager.getEntries(this.activeCategory) : []);

        // Resolve catDef per-entry helper for hub mode
        const getCatDef = (entry: CodexEntry) =>
            isHub ? this.codexManager.getCategoryDef(entry.type) : catDef;

        // Filter by search query (name + type/tags)
        if (this.searchText) {
            const q = this.searchText.toLowerCase();
            entries = entries.filter(e => {
                if (e.name.toLowerCase().includes(q)) return true;
                return this.collectEntryFilterKeys(e, getCatDef(e)).some(k => k.includes(q));
            });
        }

        // Filter by type/tag chips (OR) — type field + #hashtags
        if (this.activeTagFilters.size > 0) {
            entries = entries.filter(e => {
                const def = getCatDef(e);
                return this.collectEntryFilterKeys(e, def)
                    .some(tag => this.activeTagFilters.has(tag));
            });
        }

        // Sort
        entries = [...entries].sort((a, b) => {
            switch (this.sortBy) {
                case 'modified':
                    return (b.modified ?? '').localeCompare(a.modified ?? '');
                case 'created':
                    return (b.created ?? '').localeCompare(a.created ?? '');
                case 'type': {
                    const cdA = getCatDef(a);
                    const cdB = getCatDef(b);
                    const tA = cdA ? this.getTypeField(a, cdA) : '';
                    const tB = cdB ? this.getTypeField(b, cdB) : '';
                    return tA.localeCompare(tB) || a.name.localeCompare(b.name);
                }
                default:
                    return a.name.localeCompare(b.name);
            }
        });

        // Hub mode: never mount every character/location row up front — that
        // froze large Libraries. Show aggregate shortcuts; expand individuals
        // only while the user is actively searching.
        const hubExtras: Extract<CodexListRow, { kind: 'hub' }>[] = [];
        if (isHub) {
            const q = this.searchText.trim().toLowerCase();
            const charCount = this.plugin.characterManager?.getAllCharacters().length ?? 0;
            const locCount = this.plugin.locationManager?.getAllLocations().length ?? 0;

            if (!q) {
                if (charCount > 0) {
                    hubExtras.push({
                        kind: 'hub',
                        name: t('Characters'),
                        icon: 'users',
                        badge: String(charCount),
                        onClick: () => this.switchToView(CHARACTER_VIEW_TYPE),
                    });
                }
                if (locCount > 0) {
                    hubExtras.push({
                        kind: 'hub',
                        name: t('Locations'),
                        icon: 'map-pin',
                        badge: String(locCount),
                        onClick: () => this.switchToView(LOCATION_VIEW_TYPE),
                    });
                }
            } else {
                // Search: list matches (VirtualScroller windows the DOM).
                if (this.plugin.characterManager) {
                    for (const ch of this.plugin.characterManager.getAllCharacters()) {
                        if (ch.name.toLowerCase().includes(q)) {
                            hubExtras.push({
                                kind: 'hub',
                                name: ch.name,
                                icon: 'users',
                                badge: t('Character'),
                                onClick: () => this.switchToView(CHARACTER_VIEW_TYPE),
                            });
                        }
                    }
                }
                if (this.plugin.locationManager) {
                    for (const loc of this.plugin.locationManager.getAllLocations()) {
                        if (loc.name.toLowerCase().includes(q)) {
                            hubExtras.push({
                                kind: 'hub',
                                name: loc.name,
                                icon: 'map-pin',
                                badge: t('Location'),
                                onClick: () => this.switchToView(LOCATION_VIEW_TYPE),
                            });
                        }
                    }
                }
                hubExtras.sort((a, b) => a.name.localeCompare(b.name));
            }
        }

        if (entries.length === 0 && hubExtras.length === 0) {
            if (isHub) {
                container.createEl('p', {
                    cls: 'codex-empty-state',
                    text: this.searchText ? t('No matching entries.') : t('No Library entries yet.'),
                });
            } else if (catDef) {
                const empty = container.createDiv('codex-empty-state');
                empty.createEl('p', { text: t('No {kind} yet.', { kind: t(catDef.label).toLowerCase() }) });
                const createBtn = empty.createEl('button', {
                    cls: 'mod-cta',
                    text: t('Create first {kind}', { kind: t(catDef.label).toLowerCase().replace(/s$/, '') }),
                });
                createBtn.addEventListener('click', () => this.promptNewEntry());
            }
            return;
        }

        const rows: CodexListRow[] = [];
        for (const entry of entries) {
            const entryCatDef = getCatDef(entry);
            if (entryCatDef) rows.push({ kind: 'entry', entry, catDef: entryCatDef });
        }
        rows.push(...hubExtras);

        const layoutKey = this.activeCategory || 'library-hub';
        const layout = this.isProfileOverviewMode()
            ? 'cards'
            : getLibraryBrowseLayout(this.plugin, layoutKey);

        if (layout === 'cards') {
            this.renderBrowseCards(container, rows);
            return;
        }
        if (layout === 'table' && !isHub) {
            const cat = catDef || (entries[0] ? getCatDef(entries[0]) : undefined);
            if (cat) {
                this.renderBrowseTable(container, entries, cat);
                return;
            }
        }

        const list = container.createDiv('codex-entry-list');
        this.listScroller = new VirtualScroller<CodexListRow>({
            container: list,
            itemHeight: 36,
            items: rows,
            overscan: 8,
            // Start windowing early — large Libraries stall hard when every row is mounted.
            threshold: 20,
            renderItem: (row, _index, parent) => {
                if (row.kind === 'entry') {
                    return this.renderListItem(parent, row.entry, row.catDef);
                }
                const hubRow = parent.createDiv('codex-entry-row');
                const iconEl = hubRow.createSpan({ cls: 'codex-entry-icon' });
                obsidian.setIcon(iconEl, row.icon);
                hubRow.createSpan({ cls: 'codex-entry-name', text: row.name });
                hubRow.createSpan({ cls: 'codex-entry-type-badge', text: row.badge });
                hubRow.addEventListener('click', row.onClick);
                return hubRow;
            },
        });
        this.listScroller.mount();
    }

    private openEntry(entry: CodexEntry): void {
        this.activeCategory = entry.type;
        this.selectedEntry = entry.filePath;
        if (this.rootContainer) this.renderView(this.rootContainer);
    }

    private activeCategoryHasProfilePage(): boolean {
        if (!this.activeCategory || this.activeCategory === UNCATEGORIZED_CATEGORY_ID) return false;
        return this.plugin.settings.codexCustomCategories
            ?.find(category => category.id === this.activeCategory)
            ?.hasProfilePage === true;
    }

    private isProfileOverviewMode(): boolean {
        return getLibraryContentMode(this.plugin) === 'browse'
            && this.profileOverviewCategoryId === this.activeCategory
            && this.activeCategoryHasProfilePage();
    }

    private renderBrowseCards(container: HTMLElement, rows: CodexListRow[]): void {
        const { visible, hasMore } = pageSlice(rows, this.browseShown);
        const grid = container.createDiv('codex-entry-cards');
        for (const row of visible) {
            if (row.kind === 'hub') {
                const card = grid.createDiv('codex-entry-card codex-entry-card-hub');
                const iconEl = card.createDiv('codex-entry-card-icon');
                obsidian.setIcon(iconEl, row.icon);
                card.createEl('h4', { text: row.name });
                card.createSpan({ cls: 'codex-entry-type-badge', text: row.badge });
                card.addEventListener('click', row.onClick);
                continue;
            }
            const { entry, catDef } = row;
            const card = grid.createDiv('codex-entry-card');
            const cover = card.createDiv('codex-entry-card-cover');
            if (entry.image) {
                const src = resolveImagePath(this.app, entry.image);
                if (src) {
                    cover.createEl('img', { attr: { src, alt: '', loading: 'lazy' } });
                } else {
                    obsidian.setIcon(cover, catDef.icon);
                }
            } else {
                obsidian.setIcon(cover, catDef.icon);
            }
            card.createEl('h4', { text: entry.name || t('Untitled') });
            const typeVal = this.getTypeField(entry, catDef);
            if (typeVal) card.createSpan({ cls: 'codex-entry-type-badge', text: typeVal });
            card.addEventListener('click', () => this.openEntry(entry));
        }
        if (hasMore) {
            const more = container.createEl('button', {
                cls: 'mod-cta library-browse-load-more',
                text: t('Load more'),
            });
            more.addEventListener('click', () => {
                this.browseShown += LIBRARY_BROWSE_PAGE_SIZE;
                this.renderList(container);
            });
        }
    }

    private defaultTableColumns(catDef: CodexCategoryDef): string[] {
        const keys = catDef.fieldKeys.filter(k =>
            k !== 'name' && k !== 'image' && k !== 'gallery' && !k.toLowerCase().includes('notes'),
        );
        // Prefer short / type-like fields first
        const preferred = keys.filter(k =>
            k.endsWith('Type') || k === 'entryType' || k === 'description' || k === 'habitat' || k === 'origin',
        );
        const rest = keys.filter(k => !preferred.includes(k));
        return [...preferred, ...rest].slice(0, 5);
    }

    private renderBrowseTable(container: HTMLElement, entries: CodexEntry[], catDef: CodexCategoryDef): void {
        const layoutKey = this.activeCategory || catDef.id;
        const saved = getLibraryTableColumns(this.plugin, layoutKey);
        const columns = saved !== undefined ? saved : this.defaultTableColumns(catDef);
        const fileProperties = getLibraryFilePropertyOptions();
        const formulas = getLibraryTableFormulas(this.plugin, layoutKey);
        const propertyLabels = new Map<string, string>();
        for (const key of catDef.fieldKeys) propertyLabels.set(key, key);
        for (const property of fileProperties) propertyLabels.set(property.key, property.label);
        for (const formula of formulas) propertyLabels.set(`formula:${formula.id}`, formula.name);
        const resolveValue = (entry: CodexEntry, key: string): unknown => {
            if (key.startsWith('file.')) {
                return getLibraryFilePropertyValue(this.plugin, entry.filePath, key);
            }
            if (key === 'name') return entry.name;
            const direct = (entry as unknown as Record<string, unknown>)[key];
            if (direct !== undefined) return direct;
            const custom = entry.custom?.[key];
            return custom !== undefined
                ? custom
                : getLibraryNotePropertyValue(this.plugin, entry.filePath, key);
        };
        const valueForColumn = (entry: CodexEntry, key: string): unknown => {
            const formula = key.startsWith('formula:')
                ? formulas.find(value => value.id === key.slice('formula:'.length))
                : undefined;
            return formula
                ? evaluateLibraryTableFormula(formula.expression, property => resolveValue(entry, property))
                : resolveValue(entry, key);
        };
        const tableSort = getLibraryTableSort(this.plugin, layoutKey);
        const sortedEntries = [...entries];
        if (tableSort) {
            sortedEntries.sort((left, right) => {
                const result = compareLibraryTableValues(
                    valueForColumn(left, tableSort.key),
                    valueForColumn(right, tableSort.key),
                );
                return tableSort.direction === 'asc' ? result : -result;
            });
        }
        const { visible, hasMore } = pageSlice(sortedEntries, this.browseShown);

        const wrap = container.createDiv('library-base-table-wrap');
        const table = wrap.createEl('table', { cls: 'library-base-table' });
        const thead = table.createEl('thead');
        const hr = thead.createEl('tr');
        renderLibraryTableHeader(hr, 'name', 'name', tableSort, sort => {
            void setLibraryTableSort(this.plugin, layoutKey, sort).then(() => this.renderList(container));
        });
        for (const key of columns) {
            renderLibraryTableHeader(hr, propertyLabels.get(key) || key, key, tableSort, sort => {
                void setLibraryTableSort(this.plugin, layoutKey, sort).then(() => this.renderList(container));
            });
        }

        const tbody = table.createEl('tbody');
        for (const entry of visible) {
            const tr = tbody.createEl('tr');
            const nameTd = tr.createEl('td', { cls: 'library-base-table-name' });
            const nameLink = nameTd.createEl('button', {
                cls: 'library-base-table-name-btn',
                text: entry.name || t('Untitled'),
            });
            nameLink.addEventListener('click', () => this.openEntry(entry));

            for (const key of columns) {
                const td = tr.createEl('td');
                const formula = key.startsWith('formula:')
                    ? formulas.find(value => value.id === key.slice('formula:'.length))
                    : undefined;
                if (formula || key.startsWith('file.')) {
                    const value = formula
                        ? evaluateLibraryTableFormula(formula.expression, property => resolveValue(entry, property))
                        : resolveValue(entry, key);
                    const text = Array.isArray(value)
                        ? value.map(item => coerceString(item).trim()).filter(Boolean).join(', ')
                        : coerceString(value);
                    td.createSpan({
                        text,
                        cls: 'library-base-table-muted',
                    });
                    continue;
                }
                const field = catDef.categories.flatMap(c => c.fields).find(f => f.key === key);
                const multiline = !!field?.multiline;
                const raw = resolveValue(entry, key);
                const val = Array.isArray(raw)
                    ? raw.map(item => coerceString(item).trim()).filter(Boolean).join(', ')
                    : coerceString(raw);
                if (multiline) {
                    td.createSpan({ text: val.length > 80 ? val.slice(0, 80) + '…' : val, cls: 'library-base-table-muted' });
                    continue;
                }
                const inp = td.createEl('input', {
                    type: 'text',
                    cls: 'library-base-table-input',
                    attr: { value: val },
                });
                inp.value = val;
                inp.addEventListener('change', async () => {
                    const draft: CodexEntry = { ...entry, [key]: inp.value };
                    try {
                        await this.codexManager.saveEntry(draft);
                    } catch (e) {
                        new Notice(t('Save failed'));
                    }
                });
            }
        }

        // Column picker on header context
        hr.addEventListener('contextmenu', (evt) => {
            evt.preventDefault();
            const menu = new Menu();
            const allKeys = this.defaultTableColumns(catDef);
            // Expand to more field keys for menu
            const menuKeys = catDef.fieldKeys.filter(k => k !== 'name' && k !== 'image' && k !== 'gallery');
            for (const key of menuKeys) {
                const field = catDef.categories.flatMap(c => c.fields).find(f => f.key === key);
                const on = columns.includes(key);
                menu.addItem(item => item
                    .setTitle(field?.label || key)
                    .setChecked(on)
                    .onClick(async () => {
                        const next = on ? columns.filter(c => c !== key) : [...columns, key];
                        const finalCols = next.length ? next : allKeys.slice(0, 1);
                        await setLibraryTableColumns(this.plugin, layoutKey, finalCols);
                        this.renderList(container);
                    }));
            }
            menu.showAtMouseEvent(evt);
        });

        if (hasMore) {
            const more = container.createEl('button', {
                cls: 'mod-cta library-browse-load-more',
                text: t('Load more'),
            });
            more.addEventListener('click', () => {
                this.browseShown += LIBRARY_BROWSE_PAGE_SIZE;
                this.renderList(container);
            });
        }
    }

    private renderListItem(list: HTMLElement, entry: CodexEntry, catDef: CodexCategoryDef): HTMLElement {
        const row = list.createDiv('codex-entry-row');

        // Category icon
        const icon = row.createSpan({ cls: 'codex-entry-icon' });
        obsidian.setIcon(icon, catDef.icon);

        // Name
        row.createSpan({ cls: 'codex-entry-name', text: entry.name });

        // Type badge
        const typeVal = this.getTypeField(entry, catDef);
        if (typeVal) {
            row.createSpan({ cls: 'codex-entry-type-badge', text: typeVal });
        }

        // Completeness — deferred so large lists paint first
        const pctEl = row.createSpan({ cls: 'codex-entry-pct' });
        const fillPct = () => {
            const total = catDef.fieldKeys.length;
            if (total <= 0) return;
            const filled = this.countFilledFields(entry, catDef);
            pctEl.textContent = `${Math.round((filled / total) * 100)}%`;
        };
        const ric = (window as Window & { requestIdleCallback?: (cb: () => void) => number }).requestIdleCallback;
        if (typeof ric === 'function') ric(fillPct);
        else window.setTimeout(fillPct, 0);

        row.addEventListener('click', () => this.openEntry(entry));
        return row;
    }

    // ══════════════════════════════════════════════════
    //  Detail — editor panel
    // ══════════════════════════════════════════════════

    private renderDetail(container: HTMLElement): void {
        container.empty();
        const entry = this.codexManager.getEntry(this.selectedEntry!);
        if (!entry) {
            this.selectedEntry = null;
            this.renderOverview(container);
            return;
        }

        const catDef = this.codexManager.getCategoryDef(entry.type);
        if (!catDef) {
            this.selectedEntry = null;
            this.renderOverview(container);
            return;
        }

        const draft: CodexEntry = { ...entry };
        this._pendingDraft = draft;

        // ── Header ─────────────────────────────────────
        const header = container.createDiv('codex-detail-header');

        const backBtn = header.createEl('span', { cls: 'codex-back-link' });
        const backIcon = backBtn.createSpan();
        obsidian.setIcon(backIcon, 'circle-arrow-left');
        backBtn.createSpan({ text: t('All {kind}', { kind: t(catDef.label) }) });
        backBtn.addEventListener('click', async () => {
            await this.flushPendingSave();
            this.selectedEntry = null;
            if (this.rootContainer) this.renderView(this.rootContainer);
        });

        const headerRight = header.createDiv('codex-detail-header-right');

        // Open in editor
        const openBtn = headerRight.createEl('button', {
            cls: 'codex-detail-action-btn',
            attr: { 'aria-label': t('Open file') },
        });
        const openIcon = openBtn.createSpan();
        obsidian.setIcon(openIcon, 'file');
        attachTooltip(openBtn, t('Open file'));
        openBtn.addEventListener('click', () => {
            const file = this.app.vault.getAbstractFileByPath(entry.filePath);
            if (file) this.app.workspace.openLinkText(entry.filePath, '', true);
        });

        // Delete
        const deleteBtn = headerRight.createEl('button', {
            cls: 'codex-detail-action-btn codex-detail-delete-btn',
            attr: { 'aria-label': t('Delete') },
        });
        const deleteIcon = deleteBtn.createSpan();
        obsidian.setIcon(deleteIcon, 'trash');
        attachTooltip(deleteBtn, t('Delete'));
        deleteBtn.addEventListener('click', () => this.confirmDeleteEntry(entry));

        // ── Type label ─────────────────────────────────
        const typeLabel = container.createDiv('codex-detail-type-label');
        const typeIcon = typeLabel.createSpan({ cls: 'codex-detail-type-icon' });
        obsidian.setIcon(typeIcon, catDef.icon);
        typeLabel.createSpan({ text: catDef.label.replace(/s$/, '') });

        // ── Portrait / image ───────────────────────────
        const portraitArea = container.createDiv('codex-detail-portrait');
        if (draft.image) {
            const file = this.app.vault.getAbstractFileByPath(draft.image);
            if (file instanceof TFile) {
                const img = portraitArea.createEl('img', {
                    attr: { src: this.app.vault.getResourcePath(file) },
                });
                img.addClass('codex-detail-img');
            }
        } else {
            const placeholder = portraitArea.createDiv('codex-detail-portrait-placeholder');
            obsidian.setIcon(placeholder, 'image');
            placeholder.createEl('span', { text: t('Click to add image') });
        }
        portraitArea.addEventListener('click', () => {
            const attachmentSourcePath = this.sceneManager.getLibraryAttachmentFolder(catDef.id);
            pickImageModal(this.app, attachmentSourcePath, draft.image).then(async (picked) => {
                if (picked !== undefined) {
                    draft.image = picked;
                    this.scheduleSave(draft);
                    if (this.rootContainer) this.renderView(this.rootContainer);
                }
            });
        });

        // ── Layout: form + side ────────────────────────
        const layout = container.createDiv('codex-detail-layout');
        const formPanel = layout.createDiv('codex-detail-form');
        const sidePanel = layout.createDiv('codex-detail-side');

        // Render field categories interleaved with user-defined custom sections (#114)
        const customHost = this.buildCustomSectionsHost(draft, catDef.categories.length);
        renderCustomSectionsAtSlot(formPanel, customHost, 0);
        for (let i = 0; i < catDef.categories.length; i++) {
            this.renderFieldCategory(formPanel, catDef.categories[i], draft, catDef);
            renderCustomSectionsAtSlot(formPanel, customHost, i + 1);
        }

        // Custom fields section
        this.renderCustomFields(formPanel, draft);

        // "+ Add custom section" button at the bottom
        renderAddCustomSectionButton(formPanel, customHost);

        // Books (series-ready)
        this.renderBooksField(formPanel, draft);

        // Side panel — gallery + notes + references
        this.renderGallerySection(sidePanel, draft);
        this.renderNotesSection(sidePanel, draft);
        this.renderReferencesPanel(sidePanel, entry.name);

        // Show stale-entry warning if codex content changed since last review
        void this.renderStaleWarning(sidePanel, entry);
    }

    // ── Field category rendering ───────────────────────

    private renderFieldCategory(
        container: HTMLElement,
        cat: CodexFieldCategory,
        draft: CodexEntry,
        catDef: CodexCategoryDef,
    ): void {
        const sectionKey = `${catDef.id}-${cat.title}`;
        const isCollapsed = this.collapsedSections.has(sectionKey);

        const section = container.createDiv('codex-section');
        const sectionHeader = section.createDiv('codex-section-header');
        sectionHeader.addEventListener('click', (e) => {
            // Ignore clicks on the add-field button
            if ((e.target as HTMLElement).closest('.character-section-add-field-btn')) return;
            if (this.collapsedSections.has(sectionKey)) {
                this.collapsedSections.delete(sectionKey);
            } else {
                this.collapsedSections.add(sectionKey);
            }
            if (this.rootContainer) this.renderView(this.rootContainer);
        });

        const chevron = sectionHeader.createSpan({ cls: 'codex-section-chevron' });
        obsidian.setIcon(chevron, isCollapsed ? 'chevron-right' : 'chevron-down');

        const catIcon = sectionHeader.createSpan({ cls: 'codex-section-icon' });
        obsidian.setIcon(catIcon, cat.icon);

        sectionHeader.createSpan({ cls: 'codex-section-title', text: cat.title });

        // '+' button to add a universal field to this section
        const addFieldBtn = sectionHeader.createEl('button', {
            cls: 'character-section-add-field-btn',
            attr: { title: t('Add universal field to this section'), 'aria-label': t('Add universal field') },
        });
        obsidian.setIcon(addFieldBtn, 'plus');
        addFieldBtn.addEventListener('click', (e) => {
            e.stopPropagation();
            const sectionNames = catDef.categories.map(c => c.title);
            const existingSiblings = this.plugin.fieldTemplates
                .getBySection(cat.title, catDef.id)
                .map(t => ({ id: t.id, label: t.label }));
            // Snapshot the current built-in keys so moveAfter can resolve the
            // merged order even before the new field is rendered (issue #197).
            const builtInKeysForAdd = cat.fields
                .filter(f => !(this.plugin.settings.hiddenFields[catDef.id] ?? []).includes(f.key))
                .map(f => f.key);
            const modal = new AddFieldModal(
                this.app,
                cat.title,
                null,
                async (template, positionAfterId) => {
                    template.category = catDef.id;
                    await this.plugin.fieldTemplates.add(template);
                    if (positionAfterId !== undefined) {
                        await this.plugin.fieldTemplates.moveAfter(
                            cat.title, catDef.id, builtInKeysForAdd,
                            template.id, positionAfterId,
                        );
                    }
                    if (this.rootContainer) this.renderView(this.rootContainer);
                },
                undefined,
                sectionNames,
                existingSiblings,
            );
            modal.open();
        });

        if (!isCollapsed) {
            const body = section.createDiv('codex-section-body');

            // Filter hidden fields
            const hiddenKeys = this.plugin.settings.hiddenFields[catDef.id] ?? [];
            const visibleFields = cat.fields.filter(f => !hiddenKeys.includes(f.key));
            const hiddenFieldsInCat = cat.fields.filter(f => hiddenKeys.includes(f.key));

            // Render fields in user-defined merged order (built-in + universal).
            // Issue #92 follow-up — universal fields can be moved past built-ins
            // and built-ins themselves can be reordered via the up/down chevrons
            // that appear on hover.
            const universalFields = this.plugin.fieldTemplates.getBySection(cat.title, catDef.id);
            const fieldMap = new Map(visibleFields.map(f => [f.key, f]));
            const tplMap = new Map(universalFields.map(t => [t.id, t]));
            const builtInKeys = visibleFields.map(f => f.key);
            const merged = this.plugin.fieldTemplates.getMergedOrder(cat.title, catDef.id, builtInKeys);
            for (const entry of merged) {
                if (entry.kind === 'builtin') {
                    const f = fieldMap.get(entry.key);
                    if (f) this.renderField(body, f, draft, catDef, cat.title, builtInKeys);
                } else {
                    const t = tplMap.get(entry.key);
                    if (t) this.renderUniversalField(body, t, draft, builtInKeys);
                }
            }

            // Hidden fields toggle
            if (hiddenFieldsInCat.length > 0) {
                const toggleEl = body.createDiv('hidden-fields-toggle');
                toggleEl.createEl('a', {
                    text: t('Show {n} hidden field(s)', { n: hiddenFieldsInCat.length }),
                    cls: 'hidden-fields-toggle-link',
                });
                const hiddenContainer = body.createDiv('hidden-fields-container');
                hiddenContainer.setCssStyles({ display: 'none' });
                for (const field of hiddenFieldsInCat) {
                    this.renderField(hiddenContainer, field, draft, catDef);
                }
                let showing = false;
                toggleEl.addEventListener('click', () => {
                    showing = !showing;
                    hiddenContainer.setCssStyles({ display: showing ? '' : 'none' });
                    toggleEl.querySelector('a')!.textContent = showing
                        ? t('Hide {n} hidden field(s)', { n: hiddenFieldsInCat.length })
                        : t('Show {n} hidden field(s)', { n: hiddenFieldsInCat.length });
                });
            }
        }
    }

    private renderField(
        container: HTMLElement,
        field: CodexFieldDef,
        draft: CodexEntry,
        catDef: CodexCategoryDef,
        sectionTitle?: string,
        builtInKeys?: string[],
    ): void {
        const { key, label, placeholder, multiline, characterRef, toggle } = field;
        // Standard schema strings are translated; user-defined strings simply
        // fall through unchanged when they are not dictionary keys.
        const displayLabel = t(label);
        const displayPlaceholder = t(placeholder);
        const row = container.createDiv('codex-field-row');
        const labelEl = row.createEl('label', { cls: 'codex-field-label', text: displayLabel });

        // Up/down chevrons — reorder this built-in field within the section,
        // interleaved with universal fields. Only shown when we have the
        // section context to dispatch the move call.
        if (sectionTitle && builtInKeys) {
            this.addBuiltInMoveChevrons(labelEl, sectionTitle, catDef.id, builtInKeys, key);
        }

        // Hide/unhide toggle (skip 'name')
        if (key !== 'name') {
            const hiddenKeys = this.plugin.settings.hiddenFields[catDef.id] ?? [];
            const isHidden = hiddenKeys.includes(key);
            const hideBtn = labelEl.createEl('span', {
                cls: 'field-hide-btn',
                attr: { 'aria-label': isHidden ? t('Show this field') : t('Hide this field') },
            });
            obsidian.setIcon(hideBtn, isHidden ? 'eye' : 'eye-off');
            hideBtn.addEventListener('click', async (e) => {
                e.stopPropagation();
                const settings = this.plugin.settings;
                if (!settings.hiddenFields[catDef.id]) settings.hiddenFields[catDef.id] = [];
                const list = settings.hiddenFields[catDef.id];
                const idx = list.indexOf(key);
                if (idx >= 0) {
                    list.splice(idx, 1);
                } else {
                    list.push(key);
                }
                await this.plugin.saveSettings();
                if (this.rootContainer) this.renderView(this.rootContainer);
            });
        }

        const currentValue = draft[key] != null ? String(draft[key]) : '';

        if (toggle) {
            // Issue #223 — render an on/off toggle for boolean fields
            // (e.g. case-sensitive matching). Stored as a boolean in frontmatter.
            const toggleWrap = row.createDiv({ cls: 'codex-field-toggle-wrap' });
            const cb = toggleWrap.createEl('input', { type: 'checkbox' });
            cb.checked = draft[key] === true || currentValue === 'true';
            cb.addEventListener('change', () => {
                draft[key] = cb.checked;
                this.scheduleSave(draft);
            });
            return;
        }

        if (characterRef) {
            // Render a character dropdown
            const select = row.createEl('select', { cls: 'codex-field-input dropdown' });
            select.createEl('option', { text: displayPlaceholder || t('Select character…'), value: '' });

            const characters = this.plugin.characterManager
                .getAllCharacters()
                .map(c => c.name)
                .sort((a, b) => a.localeCompare(b));

            for (const name of characters) {
                const opt = select.createEl('option', { text: name, value: name });
                if (currentValue === name) opt.selected = true;
            }
            // If current value is set but not in characters list, keep it
            if (currentValue && !characters.includes(currentValue)) {
                const opt = select.createEl('option', { text: currentValue, value: currentValue });
                opt.selected = true;
            }
            select.addEventListener('change', () => {
                draft[key] = select.value;
                this.scheduleSave(draft);
            });
        } else if (multiline) {
            const textarea = row.createEl('textarea', {
                cls: 'codex-field-textarea',
                attr: { placeholder: displayPlaceholder, rows: '3' },
            });
            textarea.value = currentValue;
            textarea.addEventListener('input', () => {
                draft[key] = textarea.value;
                this.scheduleSave(draft);
                // Auto-grow
                textarea.setCssStyles({ height: "auto" });

                textarea.setCssStyles({ height: textarea.scrollHeight + 'px' });
            });
            // Initial auto-grow
            window.requestAnimationFrame(() => {
                textarea.setCssStyles({ height: "auto" });

                textarea.setCssStyles({ height: textarea.scrollHeight + 'px' });
            });
        } else {
            const input = row.createEl('input', {
                cls: 'codex-field-input',
                attr: { type: 'text', placeholder: displayPlaceholder },
            });
            input.value = currentValue;
            input.addEventListener('input', () => {
                draft[key] = input.value;
                this.scheduleSave(draft);
            });

            // Name field: cascade rename on blur
            if (key === 'name') {
                input.addEventListener('blur', async () => {
                    const newName = input.value.trim();
                    if (newName && newName !== draft.name) {
                        try {
                            const codexFolder = this.sceneManager.getCodexFolder();
                            const renamed = await this.codexManager.renameEntry(draft, newName, codexFolder);
                            this.selectedEntry = renamed.filePath;
                            if (this.rootContainer) this.renderView(this.rootContainer);
                        } catch (err) {
                            new Notice(t('Rename failed: {err}', { err: String(err) }));
                        }
                    }
                });
            }
        }
    }

    // ── Universal field rendering ──────────────────────

    /** Shared helper — attach up/down chevron buttons to a built-in field's
     *  label so it participates in the merged section ordering. */
    private addBuiltInMoveChevrons(
        labelEl: HTMLElement,
        section: string,
        category: string,
        builtInKeys: string[],
        fieldKey: string,
    ): void {
        const upBtn = labelEl.createEl('span', {
            cls: 'field-move-btn',
            attr: { title: t('Move field up'), 'aria-label': t('Move field up') },
        });
        obsidian.setIcon(upBtn, 'chevron-up');
        upBtn.addEventListener('click', async (e) => {
            e.stopPropagation();
            await this.plugin.fieldTemplates.moveEntryUp(section, category, builtInKeys, 'builtin', fieldKey);
            if (this.rootContainer) this.renderView(this.rootContainer);
        });

        const downBtn = labelEl.createEl('span', {
            cls: 'field-move-btn',
            attr: { title: t('Move field down'), 'aria-label': t('Move field down') },
        });
        obsidian.setIcon(downBtn, 'chevron-down');
        downBtn.addEventListener('click', async (e) => {
            e.stopPropagation();
            await this.plugin.fieldTemplates.moveEntryDown(section, category, builtInKeys, 'builtin', fieldKey);
            if (this.rootContainer) this.renderView(this.rootContainer);
        });
    }

    private renderUniversalField(
        parent: HTMLElement,
        tpl: UniversalFieldTemplate,
        draft: CodexEntry,
        builtInKeys?: string[],
    ): void {
        if (!draft.universalFields) draft.universalFields = {};
        const value = (draft.universalFields[tpl.id] ?? '') as string;

        const row = parent.createDiv('codex-field-row codex-universal-field-row');

        // Label with an edit icon
        const labelWrap = row.createDiv('codex-universal-label-wrap');
        labelWrap.createEl('label', { cls: 'codex-field-label', text: tpl.label });

        const editBtn = labelWrap.createEl('span', {
            cls: 'codex-universal-edit-btn',
            attr: { title: t('Edit or remove this universal field'), 'aria-label': t('Edit field') },
        });
        obsidian.setIcon(editBtn, 'pencil');
        editBtn.addEventListener('click', () => {
            const siblings = this.plugin.fieldTemplates
                .getBySection(tpl.section, tpl.category)
                .map(t => ({ id: t.id, label: t.label }));
            const modal = new AddFieldModal(
                this.app,
                tpl.section,
                tpl,
                async (updated, positionAfterId) => {
                    await this.plugin.fieldTemplates.update(tpl.id, updated);
                    if (positionAfterId !== undefined) {
                        await this.plugin.fieldTemplates.moveAfter(
                            tpl.section, tpl.category, builtInKeys ?? [],
                            tpl.id, positionAfterId,
                        );
                    }
                    if (this.rootContainer) this.renderView(this.rootContainer);
                },
                async () => {
                    await this.plugin.fieldTemplates.remove(tpl.id);
                    if (this.rootContainer) this.renderView(this.rootContainer);
                },
                undefined,
                siblings,
            );
            modal.open();
        });

        // Issue #92 — up/down move buttons (revealed on hover)
        const moveUpBtn = labelWrap.createEl('span', {
            cls: 'codex-universal-move-btn',
            attr: { title: t('Move field up'), 'aria-label': t('Move field up') },
        });
        obsidian.setIcon(moveUpBtn, 'chevron-up');
        moveUpBtn.addEventListener('click', async (e) => {
            e.stopPropagation();
            await this.plugin.fieldTemplates.moveEntryUp(
                tpl.section, tpl.category, builtInKeys ?? [], 'universal', tpl.id,
            );
            if (this.rootContainer) this.renderView(this.rootContainer);
        });

        const moveDownBtn = labelWrap.createEl('span', {
            cls: 'codex-universal-move-btn',
            attr: { title: t('Move field down'), 'aria-label': t('Move field down') },
        });
        obsidian.setIcon(moveDownBtn, 'chevron-down');
        moveDownBtn.addEventListener('click', async (e) => {
            e.stopPropagation();
            await this.plugin.fieldTemplates.moveEntryDown(
                tpl.section, tpl.category, builtInKeys ?? [], 'universal', tpl.id,
            );
            if (this.rootContainer) this.renderView(this.rootContainer);
        });

        // Input control based on template type
        if (tpl.type === 'multi-select') {
            const raw = draft.universalFields[tpl.id];
            const selected: string[] = Array.isArray(raw) ? [...raw] : (typeof raw === 'string' && raw ? [raw] : []);

            const allOptions = [...tpl.options];
            if (tpl.folderSource) {
                const folder = this.app.vault.getAbstractFileByPath(tpl.folderSource);
                if (folder && 'children' in folder) {
                    for (const child of (folder as obsidian.TFolder).children) {
                        if (child instanceof obsidian.TFile && child.extension === 'md') {
                            if (!allOptions.includes(child.basename)) allOptions.push(child.basename);
                        }
                    }
                }
            }
            allOptions.sort((a, b) => a.localeCompare(b));

            const msContainer = row.createDiv('universal-multi-select');
            const pillsEl = msContainer.createDiv('universal-multi-pills');
            const inputRow = msContainer.createDiv('universal-multi-input-row');
            const msInput = inputRow.createEl('input', {
                cls: 'universal-multi-input',
                type: 'text',
                attr: { placeholder: tpl.placeholder ? t(tpl.placeholder) : t('Type to add\u2026') },
            });
            // Issue #102 — portal dropdown to <body> so position:fixed coords are
            // relative to the viewport even when an ancestor uses `transform`,
            // `filter`, `contain` or other properties that establish a
            // containing block (which made the popup drift off the input).
            const msDropdown = activeDocument.body.createDiv('universal-multi-dropdown');
            msDropdown.setCssStyles({ display: 'none' });
            this._portaledDropdowns.push(msDropdown);

            const renderPills = () => {
                pillsEl.empty();
                for (const item of selected) {
                    const pill = pillsEl.createSpan({ cls: 'universal-multi-pill' });
                    pill.createSpan({ text: item });
                    const x = pill.createSpan({ cls: 'universal-multi-pill-x', text: '\u00d7' });
                    x.addEventListener('click', () => {
                        const idx = selected.indexOf(item);
                        if (idx >= 0) selected.splice(idx, 1);
                        draft.universalFields![tpl.id] = [...selected];
                        this.scheduleSave(draft);
                        renderPills();
                    });
                }
            };
            renderPills();

            const updateMsDropdown = (filter: string) => {
                msDropdown.empty();
                const lf = filter.toLowerCase();
                const available = allOptions.filter(o => !selected.includes(o) && o.toLowerCase().includes(lf));
                if (available.length === 0) { msDropdown.setCssStyles({ display: 'none' }); return; }
                msDropdown.setCssStyles({ display: '' });
                // Issue #91 — reposition via fixed coords so the popup escapes section overflow
                const r = msInput.getBoundingClientRect();
                const spaceBelow = window.innerHeight - r.bottom;
                const popupMax = 200;
                const flipUp = spaceBelow < 120 && r.top > spaceBelow;
                msDropdown.setCssStyles({
                    position: 'fixed',
                    left: r.left + 'px',
                    width: r.width + 'px',
                    top: flipUp ? '' : (r.bottom + 'px'),
                    bottom: flipUp ? (window.innerHeight - r.top) + 'px' : '',
                    maxHeight: Math.min(popupMax, flipUp ? r.top - 8 : spaceBelow - 8) + 'px',
                    zIndex: '1000',
                });
                for (const opt of available) {
                    const item = msDropdown.createDiv({ cls: 'universal-multi-dropdown-item', text: opt });
                    item.addEventListener('mousedown', (e) => {
                        e.preventDefault();
                        selected.push(opt);
                        draft.universalFields![tpl.id] = [...selected];
                        this.scheduleSave(draft);
                        renderPills();
                        msInput.value = '';
                        updateMsDropdown('');
                    });
                }
            };

            msInput.addEventListener('focus', () => updateMsDropdown(msInput.value));
            msInput.addEventListener('input', () => updateMsDropdown(msInput.value));
            msInput.addEventListener('blur', () => { window.setTimeout(() => { msDropdown.setCssStyles({ display: 'none' }); }, 200); });
            msInput.addEventListener('keydown', (e: KeyboardEvent) => {
                if (e.key === 'Enter' && msInput.value.trim()) {
                    e.preventDefault();
                    const val = msInput.value.trim();
                    if (!selected.includes(val)) {
                        selected.push(val);
                        draft.universalFields![tpl.id] = [...selected];
                        this.scheduleSave(draft);
                        renderPills();
                    }
                    msInput.value = '';
                    updateMsDropdown('');
                }
            });
        } else if (tpl.type === 'dropdown') {
            const select = row.createEl('select', { cls: 'codex-field-input dropdown' });
            select.createEl('option', { text: tpl.placeholder || t('Select…'), value: '' });

            const dropdownOptions = [...tpl.options];
            if (tpl.folderSource) {
                const folder = this.app.vault.getAbstractFileByPath(tpl.folderSource);
                if (folder && 'children' in folder) {
                    for (const child of (folder as obsidian.TFolder).children) {
                        if (child instanceof obsidian.TFile && child.extension === 'md') {
                            if (!dropdownOptions.includes(child.basename)) dropdownOptions.push(child.basename);
                        }
                    }
                }
                dropdownOptions.sort((a, b) => a.localeCompare(b));
            }

            for (const opt of dropdownOptions) {
                const el = select.createEl('option', { text: opt, value: opt });
                if (value === opt) el.selected = true;
            }
            if (value && !dropdownOptions.includes(value)) {
                const el = select.createEl('option', { text: value, value });
                el.selected = true;
            }
            select.addEventListener('change', () => {
                draft.universalFields![tpl.id] = select.value;
                this.scheduleSave(draft);
            });
        } else if (tpl.type === 'textarea') {
            const textarea = row.createEl('textarea', {
                cls: 'codex-field-textarea',
                attr: { placeholder: tpl.placeholder, rows: '2' },
            });
            textarea.value = value;
            const autoGrow = () => {
                textarea.setCssStyles({ height: 'auto' });
                textarea.setCssStyles({ height: Math.max(textarea.scrollHeight, 48) + 'px' });
            };
            window.setTimeout(autoGrow, 0);
            textarea.addEventListener('input', () => {
                draft.universalFields![tpl.id] = textarea.value;
                this.scheduleSave(draft);
                autoGrow();
            });
        } else if (tpl.type === 'checkbox') {
            const raw: unknown = draft.universalFields?.[tpl.id];
            const checked = raw === true || raw === 'true' || raw === 'yes';
            const wrap = row.createDiv('codex-field-checkbox-wrap');
            const cb = wrap.createEl('input', {
                cls: 'codex-field-checkbox',
                type: 'checkbox',
            });
            cb.checked = !!checked;
            cb.addEventListener('change', () => {
                draft.universalFields![tpl.id] = cb.checked ? 'true' : 'false';
                this.scheduleSave(draft);
            });
        } else {
            const input = row.createEl('input', {
                cls: 'codex-field-input',
                type: 'text',
                attr: { placeholder: tpl.placeholder },
            });
            input.value = value;
            input.addEventListener('input', () => {
                draft.universalFields![tpl.id] = input.value;
                this.scheduleSave(draft);
            });
        }
    }

    // ── Custom fields ──────────────────────────────────

    /** Composite-key separator used to namespace fields inside user-defined
     *  custom sections (#114). Re-exported from the shared helper so existing
     *  call-sites within this file keep working. */
    private static readonly CUSTOM_SECTION_KEY_SEP = CUSTOM_SECTION_KEY_SEP;

    private renderCustomFields(container: HTMLElement, draft: CodexEntry): void {
        // Merge per-category template fields into draft.custom so they appear
        // automatically for new entries (#115)
        const template = this.plugin.settings.codexCategoryFieldTemplates?.[draft.type] || [];
        if (template.length > 0) {
            if (!draft.custom) draft.custom = {};
            for (const name of template) {
                if (!(name in draft.custom)) draft.custom[name] = '';
            }
        }

        const section = container.createDiv('codex-section');
        const header = section.createDiv('codex-section-header');
        const chevron = header.createSpan({ cls: 'codex-section-chevron' });

        const sectionKey = 'custom-fields';
        const isCollapsed = this.collapsedSections.has(sectionKey);
        obsidian.setIcon(chevron, isCollapsed ? 'chevron-right' : 'chevron-down');

        const icon = header.createSpan({ cls: 'codex-section-icon' });
        obsidian.setIcon(icon, 'plus-circle');
        header.createSpan({ cls: 'codex-section-title', text: t('Custom Fields') });

        header.addEventListener('click', () => {
            if (this.collapsedSections.has(sectionKey)) {
                this.collapsedSections.delete(sectionKey);
            } else {
                this.collapsedSections.add(sectionKey);
            }
            if (this.rootContainer) this.renderView(this.rootContainer);
        });

        if (isCollapsed) return;

        const body = section.createDiv('codex-section-body');
        const custom = draft.custom || {};

        for (const [fieldName, fieldValue] of Object.entries(custom)) {
            // Skip composite keys belonging to user-defined custom sections (#114)
            if (fieldName.includes(CodexView.CUSTOM_SECTION_KEY_SEP)) continue;
            const row = body.createDiv('codex-field-row codex-custom-field-row');
            row.createEl('label', { cls: 'codex-field-label', text: fieldName });

            const input = row.createEl('input', {
                cls: 'codex-field-input',
                attr: { type: 'text', placeholder: t('Value for {field}', { field: fieldName }) },
            });
            input.value = fieldValue;
            input.addEventListener('input', () => {
                if (!draft.custom) draft.custom = {};
                draft.custom[fieldName] = input.value;
                this.scheduleSave(draft);
            });

            const removeBtn = row.createEl('button', {
                cls: 'codex-custom-field-remove',
                attr: { 'aria-label': t('Remove field') },
            });
            obsidian.setIcon(removeBtn, 'x');
            removeBtn.addEventListener('click', () => {
                const tplMap = this.plugin.settings.codexCategoryFieldTemplates;
                const inTemplate = !!(tplMap && tplMap[draft.type] && tplMap[draft.type].includes(fieldName));
                const doRemove = (alsoFromTemplate: boolean) => {
                    if (draft.custom) {
                        delete draft.custom[fieldName];
                        if (Object.keys(draft.custom).length === 0) draft.custom = undefined;
                    }
                    if (alsoFromTemplate && tplMap && tplMap[draft.type]) {
                        tplMap[draft.type] = tplMap[draft.type].filter(n => n !== fieldName);
                        if (tplMap[draft.type].length === 0) delete tplMap[draft.type];
                        void this.plugin.saveSettings();
                    }
                    this.scheduleSave(draft);
                    if (this.rootContainer) this.renderView(this.rootContainer);
                };
                if (inTemplate) {
                    // Confirm whether to remove from template (all entries) or just this entry
                    openConfirmModal(this.app, {
                        title: t('Remove Template Field'),
                        message: `"${fieldName}" is a template field for this category. Remove it from all entries in this category, or cancel to remove it from this entry only?`,
                        confirmLabel: 'Remove from all entries',
                        cancelLabel: 'This entry only',
                        onConfirm: () => doRemove(true),
                        onCancel: () => doRemove(false),
                    });
                } else {
                    doRemove(false);
                }
            });
        }

        // Add custom field button
        const addRow = body.createDiv('codex-add-custom-field-row');
        const addBtn = addRow.createEl('button', { cls: 'codex-add-custom-btn', text: t('+ Add custom field') });
        addBtn.addEventListener('click', () => {
            const modal = new AddCustomFieldModal(this.app, (name, applyToAll) => {
                if (!draft.custom) draft.custom = {};
                if (!(name in draft.custom)) draft.custom[name] = '';
                if (applyToAll) {
                    if (!this.plugin.settings.codexCategoryFieldTemplates) {
                        this.plugin.settings.codexCategoryFieldTemplates = {};
                    }
                    const tpl = this.plugin.settings.codexCategoryFieldTemplates[draft.type] || [];
                    if (!tpl.includes(name)) {
                        tpl.push(name);
                        this.plugin.settings.codexCategoryFieldTemplates[draft.type] = tpl;
                        void this.plugin.saveSettings();
                    }
                }
                this.scheduleSave(draft);
                if (this.rootContainer) this.renderView(this.rootContainer);
            });
            modal.open();
        });
    }

    // ── User-defined custom sections (#114) ────────────

    /**
     * Build the {@link CustomSectionsHost} used to interleave user-defined
     * custom sections with the category-defined built-in sections. The host
     * is rebuilt per-render so it always reflects the latest settings list
     * for the current Codex category.
     */
    private buildCustomSectionsHost(
        draft: CodexEntry,
        builtinSectionCount: number,
    ): CustomSectionsHost<CodexEntry> {
        if (!this.plugin.settings.codexCategoryCustomSections) {
            this.plugin.settings.codexCategoryCustomSections = {};
        }
        const allSections = this.plugin.settings.codexCategoryCustomSections;
        if (!allSections[draft.type]) allSections[draft.type] = [];
        const sections = allSections[draft.type] as import('../components/CustomSectionsRenderer').CustomSection[];
        return {
            app: this.app,
            draft,
            sections,
            builtinSectionCount,
            collapsedSections: this.collapsedSections,
            collapseKeyPrefix: `codex::${draft.type}`,
            cssPrefix: 'codex',
            scheduleSave: (d) => this.scheduleSave(d),
            persistSections: () => {
                allSections[draft.type] = sections;
                if (sections.length === 0) delete allSections[draft.type];
                void this.plugin.saveSettings();
            },
            requestRerender: () => {
                if (this.rootContainer) this.renderView(this.rootContainer);
            },
        };
    }

    // ── Books (series-ready) ───────────────────────────

    private renderBooksField(container: HTMLElement, draft: CodexEntry): void {
        const series = this.plugin.settings.series;
        if (!series) return; // Only show if project is part of a series

        const section = container.createDiv('codex-section');
        const header = section.createDiv('codex-section-header');
        const chevron = header.createSpan({ cls: 'codex-section-chevron' });

        const sectionKey = 'books';
        const isCollapsed = this.collapsedSections.has(sectionKey);
        obsidian.setIcon(chevron, isCollapsed ? 'chevron-right' : 'chevron-down');

        const icon = header.createSpan({ cls: 'codex-section-icon' });
        obsidian.setIcon(icon, 'library-big');
        header.createSpan({ cls: 'codex-section-title', text: t('Appears In (Projects)') });

        header.addEventListener('click', () => {
            if (this.collapsedSections.has(sectionKey)) {
                this.collapsedSections.delete(sectionKey);
            } else {
                this.collapsedSections.add(sectionKey);
            }
            if (this.rootContainer) this.renderView(this.rootContainer);
        });

        if (isCollapsed) return;

        const body = section.createDiv('codex-section-body');
        const books = draft.books || [];

        for (let i = 0; i < books.length; i++) {
            const row = body.createDiv('codex-field-row');
            const input = row.createEl('input', {
                cls: 'codex-field-input',
                attr: { type: 'text', placeholder: t('Project title') },
            });
            input.value = books[i];
            const idx = i;
            input.addEventListener('input', () => {
                if (!draft.books) draft.books = [];
                draft.books[idx] = input.value;
                this.scheduleSave(draft);
            });
        }

        const addBtn = body.createEl('button', { cls: 'codex-add-custom-btn', text: t('+ Add project') });
        addBtn.addEventListener('click', () => {
            if (!draft.books) draft.books = [];
            draft.books.push('');
            this.scheduleSave(draft);
            if (this.rootContainer) this.renderView(this.rootContainer);
        });
    }

    // ── Gallery section ────────────────────────────────

    private renderGallerySection(container: HTMLElement, draft: CodexEntry): void {
        const MAX_GALLERY = 10;
        const SECTION_KEY = '__Gallery';

        const wrapper = container.createDiv('character-gallery');
        const gallery = draft.gallery ?? [];

        // Collapsible header with add button
        const isCollapsed = this.collapsedSections.has(SECTION_KEY);
        const header = wrapper.createDiv('character-gallery-header');
        const chevron = header.createSpan('location-section-chevron');
        obsidian.setIcon(chevron, isCollapsed ? 'chevron-right' : 'chevron-down');
        header.createEl('h4', { text: t('Gallery') });

        // Add button in header
        if (gallery.length < MAX_GALLERY) {
            const addBtn = header.createEl('button', {
                cls: 'character-section-add-field-btn',
                attr: { title: t('Add image ({n}/{max})', { n: gallery.length, max: MAX_GALLERY }), 'aria-label': t('Add gallery image') },
            });
            obsidian.setIcon(addBtn, 'plus');
            addBtn.addEventListener('click', (e) => {
                e.stopPropagation();
                const categoryId = draft.type || this.activeCategory || 'items';
                const attachmentSourcePath = this.sceneManager.getLibraryAttachmentFolder(String(categoryId));
                pickImageModal(this.app, attachmentSourcePath).then(async (picked) => {
                    if (picked !== undefined) {
                        if (!draft.gallery) draft.gallery = [];
                        draft.gallery.push({ path: picked, caption: '' });
                        this.scheduleSave(draft);
                        if (this.rootContainer) this.renderView(this.rootContainer);
                    }
                });
            });
        }

        const body = wrapper.createDiv('character-gallery-body');
        if (isCollapsed) body.setCssStyles({ display: 'none' });

        header.addEventListener('click', (e) => {
            if ((e.target as HTMLElement).closest('.character-section-add-field-btn')) return;
            if (this.collapsedSections.has(SECTION_KEY)) {
                this.collapsedSections.delete(SECTION_KEY);
                body.setCssStyles({ display: '' });
                obsidian.setIcon(chevron, 'chevron-down');
            } else {
                this.collapsedSections.add(SECTION_KEY);
                body.setCssStyles({ display: 'none' });
                obsidian.setIcon(chevron, 'chevron-right');
            }
        });

        // Active (large) image display
        const viewer = body.createDiv('character-gallery-viewer');
        const captionEl = body.createDiv('character-gallery-caption');
        let activeIndex = gallery.length > 0 ? 0 : -1;

        const renderViewer = () => {
            viewer.empty();
            captionEl.empty();
            if (activeIndex >= 0 && activeIndex < gallery.length) {
                const entry = gallery[activeIndex];
                const src = resolveImagePath(this.app, entry.path);
                if (src) {
                    const img = viewer.createEl('img', {
                        cls: 'character-gallery-img',
                        attr: { src, alt: entry.caption || t('Gallery image') },
                    });
                    img.setCssStyles({ cursor: 'pointer' });
                    img.addEventListener('click', () => {
                        const galleryWidth = wrapper.offsetWidth;
                        this.openGalleryLightbox(gallery, activeIndex, galleryWidth);
                    });
                    img.onerror = () => {
                        img.remove();
                        const ph = viewer.createDiv('character-gallery-placeholder');
                        obsidian.setIcon(ph, 'image-off');
                    };
                } else {
                    const ph = viewer.createDiv('character-gallery-placeholder');
                    obsidian.setIcon(ph, 'image-off');
                }

                // Editable caption
                const captionInput = captionEl.createEl('input', {
                    cls: 'character-gallery-caption-input',
                    attr: { type: 'text', placeholder: t('Add caption\u2026'), value: entry.caption || '' },
                });
                const idx = activeIndex;
                captionInput.addEventListener('input', () => {
                    gallery[idx].caption = captionInput.value;
                    draft.gallery = gallery.length ? [...gallery] : undefined;
                    this.scheduleSave(draft);
                });

                // Remove button for active image
                const removeBtn = captionEl.createEl('button', {
                    cls: 'character-gallery-remove-btn',
                    attr: { title: t('Remove this image') },
                });
                obsidian.setIcon(removeBtn, 'x');
                removeBtn.addEventListener('click', () => {
                    gallery.splice(idx, 1);
                    draft.gallery = gallery.length ? [...gallery] : undefined;
                    this.scheduleSave(draft);
                    activeIndex = gallery.length > 0 ? Math.min(idx, gallery.length - 1) : -1;
                    renderViewer();
                    renderThumbs();
                });
            } else {
                const ph = viewer.createDiv('character-gallery-empty');
                ph.textContent = t('No images yet');
            }
        };

        // Navigation row: prev | thumbs | next
        const nav = body.createDiv('character-gallery-nav');
        const prevBtn = nav.createEl('button', { cls: 'character-gallery-arrow', attr: { title: t('Previous') } });
        obsidian.setIcon(prevBtn, 'chevron-left');
        prevBtn.addEventListener('click', () => {
            if (gallery.length === 0) return;
            activeIndex = (activeIndex - 1 + gallery.length) % gallery.length;
            renderViewer();
            renderThumbs();
        });

        const thumbStrip = nav.createDiv('character-gallery-thumbs');

        const nextBtn = nav.createEl('button', { cls: 'character-gallery-arrow', attr: { title: t('Next') } });
        obsidian.setIcon(nextBtn, 'chevron-right');
        nextBtn.addEventListener('click', () => {
            if (gallery.length === 0) return;
            activeIndex = (activeIndex + 1) % gallery.length;
            renderViewer();
            renderThumbs();
        });

        const renderThumbs = () => {
            thumbStrip.empty();
            for (let i = 0; i < gallery.length; i++) {
                const thumb = thumbStrip.createDiv(`character-gallery-thumb-item ${i === activeIndex ? 'active' : ''}`);
                const src = resolveImagePath(this.app, gallery[i].path);
                if (src) {
                    thumb.createEl('img', { attr: { src } });
                } else {
                    obsidian.setIcon(thumb, 'image-off');
                }
                thumb.addEventListener('click', () => {
                    activeIndex = i;
                    renderViewer();
                    renderThumbs();
                });
            }
        };

        renderViewer();
        renderThumbs();
    }

    // ── Notes section ──────────────────────────────────

    private renderNotesSection(container: HTMLElement, draft: CodexEntry): void {
        const section = container.createDiv('codex-side-section entity-notes-section');
        const header = section.createDiv('entity-notes-header');
        const icon = header.createSpan('entity-notes-icon');
        obsidian.setIcon(icon, 'notebook-pen');
        header.createEl('h4', { cls: 'entity-notes-title', text: t('Notes') });
        header.createSpan({ cls: 'entity-notes-format', text: t('Markdown') });

        const textarea = section.createEl('textarea', {
            cls: 'codex-notes-textarea',
            attr: { placeholder: t('Write additional notes…'), rows: '12', 'aria-label': t('Notes') },
        });
        textarea.value = draft.notes || '';
        textarea.addEventListener('input', () => {
            draft.notes = textarea.value;
            this.scheduleSave(draft);
        });
    }

    // ══════════════════════════════════════════════════
    //  Actions
    // ══════════════════════════════════════════════════

    private promptNewUncategorizedEntry(): void {
        const modal = new Modal(this.app);
        modal.titleEl.setText(t('New uncategorized entry'));

        let nameValue = '';
        const create = async () => {
            const name = nameValue.trim();
            if (!name) return;
            modal.close();
            await this.createUncategorizedEntry(name);
        };

        new Setting(modal.contentEl)
            .setName(t('Name'))
            .addText(text => {
                text.setPlaceholder(t('Entry name'));
                text.onChange(value => { nameValue = value; });
                text.inputEl.addEventListener('keydown', (event) => {
                    if (event.key === 'Enter') {
                        event.preventDefault();
                        void create();
                    }
                });
                window.setTimeout(() => text.inputEl.focus(), 50);
            });

        new Setting(modal.contentEl)
            .addButton(button => button
                .setButtonText(t('Create'))
                .setCta()
                .onClick(() => void create()));

        modal.open();
    }

    private async createUncategorizedEntry(name: string): Promise<void> {
        try {
            const libraryFolder = normalizePath(this.sceneManager.getCodexFolder());
            const entry = await this.codexManager.createEntry(
                libraryFolder,
                UNCATEGORIZED_CATEGORY_ID,
                name,
            );
            this.activeCategory = UNCATEGORIZED_CATEGORY_ID;
            this.selectedEntry = entry.filePath;
            new Notice(t('Created {name}', { name }));
            if (this.rootContainer) this.renderView(this.rootContainer);
        } catch (error) {
            new Notice(t('Failed to create entry: {err}', { err: String(error) }));
        }
    }

    private promptNewEntry(): void {
        const catDef = this.codexManager.getCategoryDef(this.activeCategory);
        if (!catDef) {
            new Notice(t('Select a category first'));
            return;
        }

        const modal = new Modal(this.app);
        modal.titleEl.setText(t('New {kind}', { kind: t(catDef.label).replace(/s$/, '') }));

        let nameValue = '';
        new Setting(modal.contentEl)
            .setName(t('Name'))
            .addText(text => {
                text.setPlaceholder(t('Enter {kind} name', { kind: t(catDef.label).toLowerCase().replace(/s$/, '') }));
                text.onChange(v => { nameValue = v; });
                // Allow Enter to create
                text.inputEl.addEventListener('keydown', async (e) => {
                    if (e.key === 'Enter' && nameValue.trim()) {
                        e.preventDefault();
                        modal.close();
                        await this.createEntry(nameValue.trim());
                    }
                });
                // Auto-focus
                window.setTimeout(() => text.inputEl.focus(), 50);
            });

        new Setting(modal.contentEl)
            .addButton(btn => btn
                .setButtonText(t('Create'))
                .setCta()
                .onClick(async () => {
                    if (!nameValue.trim()) return;
                    modal.close();
                    await this.createEntry(nameValue.trim());
                }));

        modal.open();
    }

    private async createEntry(name: string): Promise<void> {
        try {
            const codexFolder = this.sceneManager.getCodexFolder();
            const entry = await this.codexManager.createEntry(codexFolder, this.activeCategory, name);
            this.selectedEntry = entry.filePath;
            new Notice(t('Created {name}', { name }));
            if (this.rootContainer) this.renderView(this.rootContainer);
        } catch (err) {
            new Notice(t('Failed to create entry: {err}', { err: String(err) }));
        }
    }

    private confirmDeleteEntry(entry: CodexEntry): void {
        const modal = new Modal(this.app);
        modal.titleEl.setText(t('Delete entry'));
        modal.contentEl.createEl('p', {
            text: t('Are you sure you want to delete "{name}"? This cannot be undone.', { name: entry.name }),
        });
        new Setting(modal.contentEl)
            .addButton(btn => btn
                .setButtonText(t('Delete'))
                .setClass('mod-warning')
                .onClick(async () => {
                    modal.close();
                    try {
                        await this.codexManager.deleteEntry(entry.filePath);
                        this.selectedEntry = null;
                        if (this.rootContainer) this.renderView(this.rootContainer);
                    } catch (err) {
                        new Notice(t('Delete failed: {err}', { err: String(err) }));
                    }
                }))
            .addButton(btn => btn.setButtonText(t('Cancel')).onClick(() => modal.close()));
        modal.open();
    }

    private renderReferencesPanel(container: HTMLElement, entityName: string): void {
        const index = this.plugin.linkScanner.buildEntityIndex();
        const refs = index.get(entityName.toLowerCase());
        if (!refs || refs.length === 0) return;

        const section = container.createDiv('codex-references-panel');
        section.createEl('h3', { text: t('Referenced By') });

        const groups: Record<string, typeof refs> = {};
        for (const ref of refs) {
            const label = ref.type === 'codex' && ref.codexCategory
                ? ref.codexCategory
                : ref.type;
            if (!groups[label]) groups[label] = [];
            groups[label].push(ref);
        }

        for (const [groupLabel, groupRefs] of Object.entries(groups)) {
            const groupEl = section.createDiv('reference-group');
            groupEl.createEl('h4', { text: groupLabel.charAt(0).toUpperCase() + groupLabel.slice(1) });
            const list = groupEl.createEl('ul', { cls: 'reference-list' });
            for (const ref of groupRefs) {
                const li = list.createEl('li');
                const link = li.createEl('a', { text: ref.name, cls: 'reference-link' });
                link.addEventListener('click', (e) => {
                    e.preventDefault();
                    this.app.workspace.openLinkText(ref.filePath, '', false);
                });
            }
        }
    }

    // ── Stale codex entry warning ──────────────────────

    private async renderStaleWarning(container: HTMLElement, entry: CodexEntry): Promise<void> {
        const staleEntries = await this.plugin.getStaleCodexEntries();
        const match = staleEntries.find(s => s.entry.filePath === entry.filePath);
        if (!match || match.affectedScenes.length === 0) return;

        const section = container.createDiv('codex-stale-warning');
        const header = section.createDiv('codex-stale-header');
        const icon = header.createSpan();
        obsidian.setIcon(icon, 'alert-triangle');
        header.createSpan({ text: t('Modified — {n} scene(s) may need review', { n: match.affectedScenes.length }) });

        const list = section.createEl('ul', { cls: 'codex-stale-scene-list' });
        for (const ref of match.affectedScenes) {
            const li = list.createEl('li');
            const link = li.createEl('a', { text: ref.name, cls: 'reference-link' });
            link.addEventListener('click', (e) => {
                e.preventDefault();
                this.app.workspace.openLinkText(ref.filePath, '', false);
            });
        }

        const reviewBtn = section.createEl('button', {
            text: t('Mark as reviewed'),
            cls: 'codex-stale-reviewed-btn',
        });
        reviewBtn.addEventListener('click', async () => {
            await this.plugin.markCodexEntryReviewed(entry.filePath);
            section.remove();
            new Notice(t('Entry marked as reviewed'));
        });
    }

    // ══════════════════════════════════════════════════
    //  Category management modal
    // ══════════════════════════════════════════════════

    /**
     * Icon button + popover grid of Lucide icons (shows the glyph, not the name).
     */
    private bindCodexIconPicker(
        host: HTMLElement,
        getValue: () => string,
        setValue: (icon: string) => void,
    ): HTMLButtonElement {
        host.empty();
        const btn = host.createEl('button', {
            cls: 'codex-category-manager-icon-btn clickable-icon',
            attr: { type: 'button', 'aria-label': t('Icon') },
        });
        const paint = () => {
            btn.empty();
            obsidian.setIcon(btn, getValue() || 'file-text');
        };
        paint();

        btn.addEventListener('click', (evt) => {
            evt.preventDefault();
            evt.stopPropagation();
            activeDocument.querySelectorAll('.codex-icon-picker-pop').forEach(el => el.remove());

            const pop = activeDocument.body.createDiv('codex-icon-picker-pop');
            const current = getValue() || 'file-text';
            for (const option of CODEX_ICON_OPTIONS) {
                const optBtn = pop.createEl('button', {
                    cls: `codex-icon-picker-option${option.value === current ? ' is-active' : ''}`,
                    attr: {
                        type: 'button',
                        'aria-label': t(option.label),
                        title: t(option.label),
                    },
                });
                obsidian.setIcon(optBtn, option.value);
                optBtn.addEventListener('click', (e) => {
                    e.preventDefault();
                    e.stopPropagation();
                    setValue(option.value);
                    paint();
                    pop.remove();
                });
            }

            const rect = btn.getBoundingClientRect();
            const pad = 8;
            pop.setCssStyles({
                left: `${Math.min(rect.left, window.innerWidth - 280)}px`,
                top: `${Math.min(rect.bottom + 4, window.innerHeight - 220)}px`,
            });

            const dismiss = (e: MouseEvent) => {
                if (e.target instanceof Node && (pop.contains(e.target) || btn.contains(e.target))) return;
                pop.remove();
                activeDocument.removeEventListener('mousedown', dismiss, true);
            };
            window.setTimeout(() => {
                activeDocument.addEventListener('mousedown', dismiss, true);
            }, pad);
        });

        return btn;
    }

    /**
     * Open the Library category manager modal.
     * Prefer the module export `openManageLibraryCategoriesModal` from other views.
     */
    openManageCategoriesModal(): void {
        const modal = new Modal(this.app);
        modal.modalEl.addClass('codex-category-manager-modal');
        modal.titleEl.setText(t('Manage Library Categories'));
        modal.open();
        void ensureSeededLibraryCategoryLabels(this.plugin).then(() => {
            this.renderCategoryManager(modal.contentEl, modal);
        });
    }

    private renderCategoryManager(
        el: HTMLElement,
        modal: Modal,
        existingState?: CategoryManagerState,
    ): void {
        el.empty();
        el.addClass('codex-category-manager');

        const hiddenFixed = new Set(this.plugin.settings.libraryHiddenFixedCategories || []);
        const state = existingState || {
            enabled: new Set([
                ...this.plugin.settings.codexEnabledCategories,
                ...FIXED_LIBRARY_CATEGORY_IDS.filter(id => !hiddenFixed.has(id)),
            ]),
            categories: (this.plugin.settings.codexCustomCategories || []).map(category => ({ ...category })),
            deletedPresets: new Set(this.plugin.settings.codexDeletedPresetCategories || []),
        };
        const presetIds = new Set(BUILTIN_CODEX_CATEGORIES.map(category => category.id));
        const fixedIds = new Set<string>(FIXED_LIBRARY_CATEGORY_IDS);
        const deletedPresetIds = state.deletedPresets;

        el.createEl('h4', { text: t('Custom Categories') });
        el.createEl('p', {
            cls: 'setting-item-description',
            text: t('Show or hide categories, edit names and icons, choose profile pages, and manage fields. Preset categories can also be deleted.'),
        });

        const displayLabel = (id: string, fallback: string) => {
            const draft = state.categories.find(category => category.id === id)?.label?.trim();
            if (draft) return draft;
            return resolveLibraryCategoryLabel(this.plugin, id, fallback);
        };
        const list = el.createDiv('codex-category-manager-list');
        const header = list.createDiv('codex-category-manager-row codex-category-manager-header');
        header.createSpan({ cls: 'codex-category-manager-check', text: '' });
        header.createSpan({ cls: 'codex-category-manager-icon-select', text: t('Icon') });
        header.createSpan({ cls: 'codex-category-manager-name', text: t('Category name') });
        header.createSpan({ cls: 'codex-category-manager-preset', text: t('Type') });
        header.createSpan({ cls: 'codex-category-manager-profile-col', text: t('Profile page') });
        header.createSpan({ cls: 'codex-category-manager-fields-col', text: t('Fields') });
        header.createSpan({ cls: 'codex-category-manager-actions-col', text: '' });
        const rows: Array<{
            id: string;
            label: string;
            icon: string;
            preset: boolean;
            undeletable?: boolean;
            definition: CodexCategoryDef;
            fieldsDefinition?: CodexCategoryDef;
            draft?: ManagedCodexCategory;
        }> = [
            {
                id: 'characters',
                label: displayLabel('characters', 'Characters'),
                icon: state.categories.find(category => category.id === 'characters')?.icon || 'users',
                preset: true,
                undeletable: true,
                definition: makeCustomCodexCategory('characters', 'Characters', 'users'),
                fieldsDefinition: makeEntityFieldsDefinition(
                    'character',
                    'Characters',
                    'users',
                    CHARACTER_CATEGORIES,
                ),
            },
            {
                id: 'locations',
                label: displayLabel('locations', 'Locations'),
                icon: state.categories.find(category => category.id === 'locations')?.icon || 'map-pin',
                preset: true,
                undeletable: true,
                definition: makeCustomCodexCategory('locations', 'Locations', 'map-pin'),
                fieldsDefinition: makeEntityFieldsDefinition(
                    'location',
                    'Locations',
                    'map-pin',
                    [...WORLD_CATEGORIES, ...LOCATION_CATEGORIES],
                ),
            },
            ...BUILTIN_CODEX_CATEGORIES
                .filter(category =>
                    !deletedPresetIds.has(category.id)
                    && (
                        state.enabled.has(category.id)
                        || state.categories.some(item => item.id === category.id)
                        || !!this.plugin.sceneManager.activeProject?.libraryFolders?.[category.id]
                    ))
                .map(category => {
                    const override = state.categories.find(item => item.id === category.id);
                    return {
                        id: category.id,
                        label: displayLabel(category.id, category.label),
                        icon: override?.icon || category.icon,
                        preset: true,
                        definition: withLinkingSection(category),
                        draft: override,
                    };
                }),
            ...state.categories
                .filter(category => !presetIds.has(category.id) && !fixedIds.has(category.id))
                .map(category => ({
                    id: category.id,
                    label: category.label || displayLabel(category.id, category.label),
                    icon: category.icon,
                    preset: false,
                    definition: category.hasProfilePage
                        ? makeProfileCodexCategory(category.id, category.label, category.icon)
                        : makeCustomCodexCategory(category.id, category.label, category.icon),
                    draft: category,
                })),
            {
                id: UNCATEGORIZED_CATEGORY_ID,
                label: displayLabel(UNCATEGORIZED_CATEGORY_ID, t('Uncategorized entries')),
                icon: state.categories.find(category => category.id === UNCATEGORIZED_CATEGORY_ID)?.icon
                    || 'file-question',
                preset: true,
                undeletable: true,
                definition: makeUncategorizedCodexCategory(),
            },
        ];

        const baseTabOrder = [
            'characters',
            'locations',
            ...Array.from(state.enabled).filter(id => !fixedIds.has(id)),
        ].filter(id => state.enabled.has(id) && rows.some(category => category.id === id));
        const storedOrder = this.plugin.settings.libraryCategoryOrder || [];
        const storedOrderIndex = new Map(storedOrder.map((id, index) => [id, index]));
        baseTabOrder.sort((left, right) => {
            const leftIndex = storedOrderIndex.get(left);
            const rightIndex = storedOrderIndex.get(right);
            if (leftIndex === undefined && rightIndex === undefined) return 0;
            if (leftIndex === undefined) return 1;
            if (rightIndex === undefined) return -1;
            return leftIndex - rightIndex;
        });
        if (state.enabled.has(UNCATEGORIZED_CATEGORY_ID)) {
            baseTabOrder.push(UNCATEGORIZED_CATEGORY_ID);
        }
        const tabOrderIndex = new Map(baseTabOrder.map((id, index) => [id, index]));
        rows.sort((left, right) => {
            const leftIndex = tabOrderIndex.get(left.id);
            const rightIndex = tabOrderIndex.get(right.id);
            if (leftIndex !== undefined && rightIndex !== undefined) return leftIndex - rightIndex;
            if (leftIndex !== undefined) return -1;
            if (rightIndex !== undefined) return 1;
            return 0;
        });

        for (const category of rows) {
            const row = list.createDiv('codex-category-manager-row');
            const toggle = row.createEl('input', { attr: { type: 'checkbox' } }) as HTMLInputElement;
            toggle.checked = state.enabled.has(category.id);
            toggle.setAttribute('aria-label', t('Show or hide category'));
            toggle.addEventListener('change', () => {
                if (toggle.checked) state.enabled.add(category.id);
                else state.enabled.delete(category.id);
                this.renderCategoryManager(el, modal, state);
            });

            const ensureDraft = (): ManagedCodexCategory => {
                let draft = state.categories.find(item => item.id === category.id);
                if (!draft) {
                    draft = {
                        id: category.id,
                        label: category.label,
                        icon: category.icon,
                        preset: category.preset,
                    };
                    state.categories.push(draft);
                }
                return draft;
            };

            const iconHost = row.createDiv({
                cls: 'codex-category-manager-icon-select',
                attr: { 'aria-label': t('Icon') },
            });
            this.bindCodexIconPicker(
                iconHost,
                () => ensureDraft().icon || category.icon,
                (icon) => { ensureDraft().icon = icon; },
            );

            const nameInput = row.createEl('input', {
                cls: 'codex-category-manager-name',
                attr: {
                    type: 'text',
                    value: category.label,
                    'aria-label': t('Category name'),
                },
            }) as HTMLInputElement;
            nameInput.addEventListener('input', () => {
                ensureDraft().label = nameInput.value;
            });

            if (category.undeletable) {
                row.createSpan({ cls: 'codex-category-manager-preset', text: t('Fixed') });
            } else if (category.preset) {
                row.createSpan({ cls: 'codex-category-manager-preset', text: t('Preset') });
            } else {
                row.createSpan({ cls: 'codex-category-manager-preset is-custom', text: t('Custom') });
            }

            const fixedProfile = category.id === 'characters' || category.id === 'locations';
            const profileUnavailable = category.id === UNCATEGORIZED_CATEGORY_ID;
            const profileToggle = row.createEl('input', {
                cls: 'codex-category-manager-profile-toggle',
                attr: { type: 'checkbox', 'aria-label': t('Include profile page') },
            }) as HTMLInputElement;
            profileToggle.checked = fixedProfile || category.draft?.hasProfilePage === true;
            profileToggle.disabled = fixedProfile || profileUnavailable;
            profileToggle.title = fixedProfile
                ? t('Profile page is always enabled for Characters and Locations.')
                : profileUnavailable
                    ? t('Profile page is unavailable for Uncategorized entries.')
                    : t('Include profile page');
            profileToggle.addEventListener('change', () => {
                state.categories = setLibraryCategoryProfileSetting(
                    state.categories,
                    {
                        id: category.id,
                        label: nameInput.value.trim() || category.label,
                        icon: ensureDraft().icon || category.icon,
                        preset: category.preset,
                    },
                    profileToggle.checked,
                );
                this.renderCategoryManager(el, modal, state);
            });

            const fieldsBtn = row.createEl('button', {
                cls: 'codex-category-manager-fields',
                text: t('Fields'),
            });
            fieldsBtn.addEventListener('click', () => {
                this.openCategoryFieldsModal(
                    category.fieldsDefinition || category.definition,
                    state.categories.find(item => item.id === category.id)?.label
                        || nameInput.value
                        || category.label,
                );
            });

            if (category.undeletable) {
                row.createSpan({ cls: 'codex-category-manager-protected' });
            } else {
                const deleteBtn = row.createEl('button', {
                    cls: 'codex-category-delete-btn',
                    attr: { 'aria-label': t('Delete Library category') },
                });
                obsidian.setIcon(deleteBtn, 'trash');
                deleteBtn.addEventListener('click', () => {
                    const persisted = category.preset
                        || (this.plugin.settings.codexCustomCategories || [])
                            .some(item => item.id === category.id);
                    const finishDelete = () => {
                        state.enabled.delete(category.id);
                        state.categories = state.categories.filter(item => item.id !== category.id);
                        if (category.preset) state.deletedPresets.add(category.id);
                        this.codexManager.initCategories(
                            Array.from(state.enabled).filter(id => !fixedIds.has(id)),
                            state.categories.map(item =>
                                item.hasProfilePage
                                    ? makeProfileCodexCategory(item.id, item.label, item.icon)
                                    : makeCustomCodexCategory(item.id, item.label, item.icon)),
                        );
                        if (this.activeCategory === category.id) {
                            this.activeCategory = UNCATEGORIZED_CATEGORY_ID;
                            this.selectedEntry = null;
                        }
                        this.renderCategoryManager(el, modal, state);
                        if (this.rootContainer) this.renderView(this.rootContainer);
                    };
                    if (!persisted) {
                        finishDelete();
                        return;
                    }
                    promptDeleteCategory(this.plugin, category.id, finishDelete);
                });
            }
        }

        // Deleted presets stay in state.deletedPresets so they do not reappear —
        // there is no restore zone.

        // Add another category in the same list.
        const addSection = el.createDiv('codex-category-manager-add');
        let newLabel = '';
        let newIcon = 'file-text';
        let newHasProfilePage = false;
        let newLabelInput: HTMLInputElement | null = null;

        new Setting(addSection)
            .setName(t('Category name'))
            .addText(text => {
                text.setPlaceholder(t('e.g. Factions, Artifacts, Magic…'));
                text.onChange(v => { newLabel = v; });
                newLabelInput = text.inputEl;
            });

        const iconSetting = new Setting(addSection).setName(t('Icon'));
        iconSetting.settingEl.addClass('codex-category-manager-add-icon');
        iconSetting.controlEl.empty();
        const addIconHost = iconSetting.controlEl.createDiv('codex-category-manager-icon-select');
        this.bindCodexIconPicker(
            addIconHost,
            () => newIcon,
            (icon) => { newIcon = icon; },
        );

        new Setting(addSection)
            .setName(t('Include profile page'))
            .setDesc(t('Like Characters and Locations: richer profile fields, card browse, and links in the scene inspector.'))
            .addToggle(toggle => toggle
                .setValue(newHasProfilePage)
                .onChange(v => { newHasProfilePage = v; }));

        new Setting(addSection)
            .addButton(btn => btn
                .setButtonText(t('Add Category'))
                .setCta()
                .onClick(() => {
                    void (async () => {
                        // Read value directly from input as a fallback in case the change
                        // event hasn't fired yet (issue #115)
                        if (newLabelInput) {
                            newLabel = newLabelInput.value || newLabel;
                        }
                        const label = newLabel.trim();
                        if (!label) {
                            new Notice(t('Please enter a label'));
                            return;
                        }
                        // Prefer slug from Latin label; CJK-only labels get a stable custom-* id.
                        let id = label.toLowerCase().replace(/\s+/g, '-').replace(/[^a-z0-9-]/g, '');
                        if (!id) id = `custom-${Date.now().toString(36)}`;
                        if (id === UNCATEGORIZED_CATEGORY_ID) {
                            new Notice(t('That category id is reserved'));
                            return;
                        }
                        if (
                            BUILTIN_CODEX_CATEGORIES.some(c => c.id === id)
                            || state.categories.some(c => c.id === id)
                            || fixedIds.has(id)
                        ) {
                            new Notice(t('Category already exists'));
                            return;
                        }
                        // Explicit recreate clears a prior "deleted preset" tombstone.
                        state.deletedPresets.delete(id);
                        state.categories.push({
                            id,
                            label,
                            icon: newHasProfilePage && newIcon === 'file-text' ? 'user' : newIcon,
                            hasProfilePage: newHasProfilePage || undefined,
                            showInSidebar: newHasProfilePage || undefined,
                        });
                        state.enabled.add(id);
                        const ok = await this.persistLibraryCategoryManagerState(state);
                        if (!ok) {
                            // Roll back in-memory draft if vault write failed.
                            state.categories = state.categories.filter(c => c.id !== id);
                            state.enabled.delete(id);
                            return;
                        }
                        new Notice(t('Category added'));
                        this.renderCategoryManager(el, modal, state);
                    })();
                }));

        // Save & close
        new Setting(el)
            .addButton(btn => btn
                .setButtonText(t('Save'))
                .setCta()
                .onClick(async () => {
                    const ok = await this.persistLibraryCategoryManagerState(state);
                    if (!ok) return;
                    const cats = this.codexManager.getCategories();
                    if (this.activeCategory && !cats.find(c => c.id === this.activeCategory) && cats.length > 0) {
                        this.activeCategory = cats[0].id;
                    }
                    modal.close();
                    if (this.rootContainer) this.renderView(this.rootContainer);
                }));
    }

    /**
     * Persist category manager draft: settings, Library/<Name> folders, tab order,
     * and live P2 tab bars. Safe for brand-new categories (no premature rename).
     */
    private async persistLibraryCategoryManagerState(state: CategoryManagerState): Promise<boolean> {
        const fixedIds = new Set<string>(FIXED_LIBRARY_CATEGORY_IDS);
        const project = this.plugin.sceneManager.activeProject;
        if (!project) {
            new Notice(t('No active project'));
            return false;
        }

        this.plugin.settings.codexCustomCategories = state.categories
            .filter(category => category.label.trim())
            .map(category => ({ ...category, label: category.label.trim() }));
        this.plugin.settings.codexEnabledCategories = Array.from(state.enabled)
            .filter(id => !fixedIds.has(id));
        this.plugin.settings.libraryHiddenFixedCategories =
            FIXED_LIBRARY_CATEGORY_IDS.filter(id => !state.enabled.has(id));
        this.plugin.settings.codexDeletedPresetCategories = Array.from(state.deletedPresets);

        if (!this.plugin.settings.libraryBrowseLayout) {
            this.plugin.settings.libraryBrowseLayout = {};
        }
        const sidebar = new Set(this.plugin.settings.codexSidebarCategories || []);
        for (const category of state.categories) {
            if (!category.hasProfilePage) {
                sidebar.delete(category.id);
                continue;
            }
            if (!this.plugin.settings.libraryBrowseLayout[category.id]) {
                this.plugin.settings.libraryBrowseLayout[category.id] = 'cards';
            }
            if (state.enabled.has(category.id)) sidebar.add(category.id);
            else sidebar.delete(category.id);
        }
        this.plugin.settings.codexSidebarCategories = Array.from(sidebar);

        // Keep P2 order in sync — append newly enabled ids.
        const order = [...(this.plugin.settings.libraryCategoryOrder || [])];
        for (const id of this.plugin.settings.codexEnabledCategories) {
            if (!order.includes(id)) order.push(id);
        }
        this.plugin.settings.libraryCategoryOrder = order.filter(id =>
            fixedIds.has(id) || this.plugin.settings.codexEnabledCategories.includes(id),
        );

        await this.plugin.saveSettings();

        if (!project.libraryFolders) project.libraryFolders = {};
        project.libraryFolders.characters =
            project.libraryFolders.characters
            || this.plugin.sceneManager.getLibraryFolderName('characters');
        project.libraryFolders.locations =
            project.libraryFolders.locations
            || this.plugin.sceneManager.getLibraryFolderName('locations');

        for (const category of state.categories) {
            if (category.id === UNCATEGORIZED_CATEGORY_ID) continue;
            if (!state.enabled.has(category.id) && !fixedIds.has(category.id)) continue;

            const desiredName = sanitizeLibraryFolderName(category.label.trim());
            if (!desiredName) continue;

            // Seeded zh/en labels stay display-only — keep English vault folders.
            if (isSeedLibraryCategoryLabel(category.id, desiredName)) {
                if (!project.libraryFolders[category.id]?.trim()) {
                    project.libraryFolders[category.id] =
                        this.plugin.sceneManager.getLibraryFolderName(category.id);
                }
                continue;
            }

            const currentName = this.plugin.sceneManager.getLibraryFolderName(category.id);
            if (currentName === desiredName) {
                project.libraryFolders[category.id] = desiredName;
                continue;
            }

            // renameLibraryCategory covers project + series Library roots.
            // Only fall back to a mapping-only write when no folder exists anywhere.
            const renamed = await renameLibraryCategory(this.plugin, category.id, desiredName);
            if (!renamed
                && this.plugin.sceneManager.getLibraryFolderName(category.id) !== desiredName) {
                // Conflict / missing source — keep going so other cats still land.
                const anyFolderExists = [
                    normalizePath(project.codexFolder),
                    this.plugin.sceneManager.getSeriesFolder()
                        ? normalizePath(this.plugin.sceneManager.getSeriesCodexFolder())
                        : '',
                ].filter(Boolean).some((lib) => {
                    const oldPath = normalizePath(`${lib}/${currentName}`);
                    return !!this.app.vault.getAbstractFileByPath(oldPath);
                });
                if (!anyFolderExists) {
                    project.libraryFolders[category.id] = desiredName;
                }
            }
        }

        await this.plugin.sceneManager.saveProjectFrontmatter(project);
        this.codexManager.initCategories(
            this.plugin.settings.codexEnabledCategories,
            this.resolveCustomDefs(),
        );
        applyCategoryFolderLabels(this.plugin);
        // Vault Library/ folders win across folders, tabs, and Bases.
        await reconcileLibraryCategoriesForActiveProject(this.plugin, { createMissingRegistered: true });
        this.codexManager.initCategories(
            this.plugin.settings.codexEnabledCategories,
            this.resolveCustomDefs(),
        );
        applyCategoryFolderLabels(this.plugin);
        if (syncStoryGraphLibraryNodeTypes(this.plugin)) {
            await this.plugin.saveSettings();
        }
        this.plugin.libraryCategoriesStructureEpoch += 1;
        await this.plugin.reloadEntities();
        if (this.rootContainer) this.renderView(this.rootContainer);
        else void this.plugin.refreshOpenViews();
        return true;
    }

    private openCategoryFieldsModal(category: CodexCategoryDef, categoryLabel: string): void {
        const modal = new Modal(this.app);
        modal.titleEl.setText(t('{name} fields', { name: categoryLabel }));
        const content = modal.contentEl;
        content.addClass('codex-category-fields-manager');

        content.createEl('p', {
            cls: 'setting-item-description',
            text: t('Choose which preset fields are visible, and add default custom fields for every entry in this category.'),
        });

        const hidden = new Set(this.plugin.settings.hiddenFields?.[category.id] || []);
        const seen = new Set<string>();
        for (const section of category.categories) {
            const fields = section.fields.filter(field => field.key !== 'name' && !seen.has(field.key));
            if (fields.length === 0) continue;
            content.createEl('h5', { text: t(section.title) });
            for (const field of fields) {
                seen.add(field.key);
                const row = content.createDiv('codex-category-field-row');
                const toggle = row.createEl('input', {
                    attr: { type: 'checkbox' },
                }) as HTMLInputElement;
                toggle.checked = !hidden.has(field.key);
                row.createSpan({ text: t(field.label) });
                toggle.addEventListener('change', () => {
                    if (toggle.checked) hidden.delete(field.key);
                    else hidden.add(field.key);
                });
            }
        }

        content.createEl('h5', { text: t('Additional fields') });
        content.createEl('p', {
            cls: 'setting-item-description',
            text: t('Enter one field name per line. New entries will include these fields automatically.'),
        });
        const textarea = content.createEl('textarea', {
            cls: 'codex-category-fields-textarea',
        });
        textarea.value = (this.plugin.settings.codexCategoryFieldTemplates?.[category.id] || []).join('\n');

        new Setting(content)
            .addButton(button => button
                .setButtonText(t('Save'))
                .setCta()
                .onClick(async () => {
                    if (!this.plugin.settings.hiddenFields) this.plugin.settings.hiddenFields = {};
                    this.plugin.settings.hiddenFields[category.id] = Array.from(hidden);
                    if (!this.plugin.settings.codexCategoryFieldTemplates) {
                        this.plugin.settings.codexCategoryFieldTemplates = {};
                    }
                    this.plugin.settings.codexCategoryFieldTemplates[category.id] = Array.from(new Set(
                        textarea.value
                            .split(/\r?\n/)
                            .map(name => name.trim())
                            .filter(Boolean),
                    ));
                    await this.plugin.saveSettings();
                    modal.close();
                    if (this.rootContainer) this.renderView(this.rootContainer);
                }));
        modal.open();
    }

    // ══════════════════════════════════════════════════
    //  Helpers
    // ══════════════════════════════════════════════════

    private resolveCustomDefs() {
        return this.plugin.settings.codexCustomCategories.map(cc =>
            cc.hasProfilePage
                ? makeProfileCodexCategory(cc.id, cc.label, cc.icon)
                : makeCustomCodexCategory(cc.id, cc.label, cc.icon)
        );
    }

    private switchToView(viewType: string): void {
        try {
            this.leaf.setViewState({ type: viewType, active: true, state: {} });
            this.plugin.app.workspace.revealLeaf(this.leaf);
        } catch {
            this.plugin.activateView(viewType);
        }
    }

    private getTypeField(entry: CodexEntry, catDef: CodexCategoryDef): string {
        // Issue #209 — prefer the shared `entryType` field (available on all
        // categories via the Linking & Matching section) so custom categories
        // and entries without a category-specific Type field still show a badge.
        if (entry.entryType && typeof entry.entryType === 'string') {
            return entry.entryType;
        }
        // Look for fields ending in 'Type' (itemType, creatureType, etc.)
        for (const key of catDef.fieldKeys) {
            if (key.endsWith('Type') && entry[key]) return String(entry[key]);
        }
        return '';
    }

    private countFilledFields(entry: CodexEntry, catDef: CodexCategoryDef): number {
        let count = 0;
        for (const key of catDef.fieldKeys) {
            const val = entry[key];
            if (val !== undefined && val !== null && val !== '' &&
                !(Array.isArray(val) && val.length === 0)) {
                count++;
            }
        }
        return count;
    }

    // ── Auto-save ──────────────────────────────────────

    private scheduleSave(draft: CodexEntry): void {
        this._pendingDraft = draft;
        if (this._saveTimer) window.clearTimeout(this._saveTimer);
        this._saveTimer = window.setTimeout(async () => {
            this._saveTimer = null;
            await this.executeSave(draft);
        }, CodexView.SAVE_DEBOUNCE_MS);
    }

    private async executeSave(draft: CodexEntry): Promise<void> {
        try {
            await this.codexManager.saveEntry(draft);
            this._lastSaveTime = Date.now();
            this._pendingDraft = null;
        } catch (err) {
            console.error('NarrativeLab Codex: save failed', err);
        }
    }

    private async flushPendingSave(): Promise<void> {
        if (this._saveTimer) {
            window.clearTimeout(this._saveTimer);
            this._saveTimer = null;
        }
        if (this._pendingDraft) {
            await this.executeSave(this._pendingDraft);
        }
    }

    /**
     * Open a non-modal, draggable/resizable floating window showing a gallery image.
     * Mirrors the lightbox in CharacterView / LocationView so codex entries
     * (items, etc.) can also expand thumbnails to a larger view.
     */
    private openGalleryLightbox(
        gallery: Array<{ path: string; caption: string }>,
        startIndex: number,
        galleryWidth: number,
    ): void {
        activeDocument.querySelector('.gallery-lightbox-window')?.remove();

        let currentIndex = startIndex;
        const winWidth = Math.min(Math.round(galleryWidth * 2), window.innerWidth - 40);
        const winHeight = Math.round((winWidth * 3) / 4) + 36 + 28;

        const win = activeDocument.body.createDiv('gallery-lightbox-window');
        win.setCssStyles({
            width: `${winWidth}px`,
            height: `${winHeight}px`,
        });

        const titlebar = win.createDiv('gallery-lightbox-titlebar');
        const titleText = titlebar.createSpan({ cls: 'gallery-lightbox-title' });
        const closeBtn = titlebar.createEl('button', { cls: 'gallery-lightbox-close', attr: { title: t('Close') } });
        obsidian.setIcon(closeBtn, 'x');
        closeBtn.addEventListener('click', () => { cleanup(); win.remove(); });

        const contentRow = win.createDiv('gallery-lightbox-content-row');

        const prevBtn = contentRow.createEl('button', { cls: 'gallery-lightbox-nav-btn', attr: { title: t('Previous') } });
        obsidian.setIcon(prevBtn, 'chevron-left');
        prevBtn.addEventListener('click', () => {
            currentIndex = (currentIndex - 1 + gallery.length) % gallery.length;
            renderContent();
        });

        const imgContainer = contentRow.createDiv('gallery-lightbox-content');

        const nextBtn = contentRow.createEl('button', { cls: 'gallery-lightbox-nav-btn', attr: { title: t('Next') } });
        obsidian.setIcon(nextBtn, 'chevron-right');
        nextBtn.addEventListener('click', () => {
            currentIndex = (currentIndex + 1) % gallery.length;
            renderContent();
        });

        const captionEl = win.createDiv('gallery-lightbox-caption');
        const resizeHandle = win.createDiv('gallery-lightbox-resize-handle');

        const zoomLevels = new Map<number, number>();
        const getZoom = () => zoomLevels.get(currentIndex) ?? 1;
        const setZoom = (z: number) => { zoomLevels.set(currentIndex, z); };

        const renderContent = () => {
            const entry = gallery[currentIndex];
            const src = resolveImagePath(this.app, entry.path);
            titleText.textContent = entry.caption || `Image ${currentIndex + 1} of ${gallery.length}`;
            imgContainer.empty();
            if (src) {
                const img = imgContainer.createEl('img', { attr: { src, alt: entry.caption || t('Gallery image') } });
                img.setCssStyles({ transformOrigin: 'center center' });
                const z = getZoom();
                if (z !== 1) img.setCssStyles({ transform: `scale(${z})` });
            }
            captionEl.textContent = entry.caption || '';
            captionEl.setCssStyles({ display: entry.caption ? '' : 'none' });
            prevBtn.setCssStyles({ display: gallery.length > 1 ? '' : 'none' });
            nextBtn.setCssStyles({ display: gallery.length > 1 ? '' : 'none' });
        };
        renderContent();

        imgContainer.addEventListener('wheel', (e: WheelEvent) => {
            e.preventDefault();
            const delta = e.deltaY > 0 ? -0.1 : 0.1;
            const newZoom = Math.max(0.5, Math.min(5, getZoom() + delta));
            setZoom(newZoom);
            const img = imgContainer.querySelector('img');
            if (img) img.setCssStyles({ transform: `scale(${newZoom})` });
        }, { passive: false });

        let pinchStartDist = 0;
        let pinchStartZoom = 1;
        imgContainer.addEventListener('touchstart', (e: TouchEvent) => {
            if (e.touches.length === 2) {
                const dx = e.touches[0].clientX - e.touches[1].clientX;
                const dy = e.touches[0].clientY - e.touches[1].clientY;
                pinchStartDist = Math.hypot(dx, dy);
                pinchStartZoom = getZoom();
            }
        }, { passive: true });
        imgContainer.addEventListener('touchmove', (e: TouchEvent) => {
            if (e.touches.length === 2) {
                e.preventDefault();
                const dx = e.touches[0].clientX - e.touches[1].clientX;
                const dy = e.touches[0].clientY - e.touches[1].clientY;
                const dist = Math.hypot(dx, dy);
                const scale = dist / pinchStartDist;
                const newZoom = Math.max(0.5, Math.min(5, pinchStartZoom * scale));
                setZoom(newZoom);
                const img = imgContainer.querySelector('img');
                if (img) img.setCssStyles({ transform: `scale(${newZoom})` });
            }
        }, { passive: false });

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

        let isResizing = false;
        let resizeStartX = 0;
        let resizeStartY = 0;
        let startW = 0;
        let startH = 0;
        resizeHandle.addEventListener('pointerdown', (e: PointerEvent) => {
            isResizing = true;
            resizeStartX = e.clientX;
            resizeStartY = e.clientY;
            startW = win.offsetWidth;
            startH = win.offsetHeight;
            resizeHandle.setPointerCapture(e.pointerId);
            e.preventDefault();
            e.stopPropagation();
        });
        resizeHandle.addEventListener('pointermove', (e: PointerEvent) => {
            if (!isResizing) return;
            const newW = Math.max(200, startW + (e.clientX - resizeStartX));
            const newH = Math.max(150, startH + (e.clientY - resizeStartY));
            win.setCssStyles({
                width: `${newW}px`,
                height: `${newH}px`,
            });
        });
        resizeHandle.addEventListener('pointerup', () => { isResizing = false; });
        resizeHandle.addEventListener('lostpointercapture', () => { isResizing = false; });

        const onKey = (e: KeyboardEvent) => {
            if (e.key === 'Escape') { cleanup(); win.remove(); }
        };
        activeDocument.addEventListener('keydown', onKey);
        const cleanup = () => { activeDocument.removeEventListener('keydown', onKey); };
    }
}

// ═══════════════════════════════════════════════════
//  Small modal for adding a custom field
// ═══════════════════════════════════════════════════

class AddCustomFieldModal extends Modal {
    private callback: (name: string, applyToAll: boolean) => void;

    constructor(app: App, callback: (name: string, applyToAll: boolean) => void) {
        super(app);
        this.callback = callback;
    }

    onOpen(): void {
        this.titleEl.setText(t('Add Custom Field'));
        let fieldName = '';
        let applyToAll = true;
        let nameInput: HTMLInputElement | null = null;
        new Setting(this.contentEl)
            .setName(t('Field name'))
            .addText(text => {
                text.setPlaceholder(t('e.g. Rarity, Alignment…'));
                text.onChange(v => { fieldName = v; });
                nameInput = text.inputEl;
                text.inputEl.addEventListener('keydown', (e) => {
                    if (e.key === 'Enter') {
                        const v = (nameInput?.value || fieldName).trim();
                        if (v) {
                            e.preventDefault();
                            this.close();
                            this.callback(v, applyToAll);
                        }
                    }
                });
                window.setTimeout(() => text.inputEl.focus(), 50);
            });

        new Setting(this.contentEl)
            .setName(t('Add to all entries in this category'))
            .setDesc(t('When enabled, this field becomes a template for the category and appears on every existing and future entry of this type.'))
            .addToggle(t => t.setValue(applyToAll).onChange(v => { applyToAll = v; }));

        new Setting(this.contentEl)
            .addButton(btn => btn
                .setButtonText(t('Add'))
                .setCta()
                .onClick(() => {
                    const v = (nameInput?.value || fieldName).trim();
                    if (v) {
                        this.close();
                        this.callback(v, applyToAll);
                    }
                }));
    }
}

/**
 * Open the Library “Custom Categories” manager from any Library view
 * (Characters, Locations, Codex) without requiring an open CodexView leaf.
 */
export function openManageLibraryCategoriesModal(
    plugin: SceneCardsPlugin,
    onDone?: () => void,
): void {
    // Prototype host: private fields are only assignable via a loose cast.
    const host = Object.create(CodexView.prototype) as {
        plugin: SceneCardsPlugin;
        app: App;
        codexManager: CodexManager;
        rootContainer: HTMLElement | null;
        activeCategory: string;
        selectedEntry: string | null;
        renderView: (container: HTMLElement) => void;
        openManageCategoriesModal: () => void;
    };
    host.plugin = plugin;
    host.app = plugin.app;
    host.codexManager = plugin.codexManager;
    // Truthy stand-in so save/delete paths that check rootContainer still refresh.
    host.rootContainer = activeDocument.createElement('div');
    host.activeCategory = '';
    host.selectedEntry = null;
    host.renderView = () => {
        onDone?.();
        void plugin.refreshOpenViews();
    };
    host.openManageCategoriesModal();
}

/* eslint-enable @typescript-eslint/no-floating-promises, @typescript-eslint/no-misused-promises, @typescript-eslint/no-unnecessary-type-assertion, @typescript-eslint/no-unused-vars -- end of file-wide suppression block opened at line 1 */
