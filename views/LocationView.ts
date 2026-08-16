/* eslint-disable @typescript-eslint/no-floating-promises, @typescript-eslint/no-misused-promises, @typescript-eslint/no-unnecessary-type-assertion -- Obsidian event handlers intentionally launch async work and use compatibility assertions; matching enable at end of file */
import { ButtonComponent, Menu, Modal, Notice, Setting, TFile, TextComponent, WorkspaceLeaf } from 'obsidian';
import * as obsidian from 'obsidian';
import { LOCATION_VIEW_TYPE } from '../constants';
import { Scene, resolveStatusCfg } from '../models/Scene';
import { coerceString } from '../utils/narrow';
import {
    StoryWorld, StoryLocation, WorldOrLocation,
    WORLD_CATEGORIES, LOCATION_CATEGORIES, LOCATION_TYPES,
    LocationFieldCategory, LocationFieldDef,
} from '../models/Location';
import { SceneManager } from '../services/SceneManager';
import { LocationManager } from '../services/LocationManager';
import { renderViewSwitcher } from '../components/ViewSwitcher';
import { absorbCoverIntoGallery, libraryCoverPath, pickImage as pickImageModal, resolveImagePath, syncLibraryCoverFromGallery } from '../components/ImagePicker';
import { AddFieldModal } from '../components/AddFieldModal';
import {
    isCustomSectionKey,
    renderCustomSectionsAtSlot,
    renderAddCustomSectionButton,
    type CustomSectionsHost,
} from '../components/CustomSectionsRenderer';
import type { UniversalFieldTemplate } from '../services/FieldTemplateService';
import { isLibraryEntityMarkdownFile } from '../services/EntityFileCache';
import { formatActChapterPrefix } from '../utils/actChapter';
import { t } from '../utils/i18n';
import { showMenuSafely } from '../utils/obsidianMenu';
import { ProjectBoundItemView } from './ProjectBoundItemView';
import {
    attachBuiltinFieldVisibilityControls,
    attachBuiltinSectionRemoveControl,
    filterRemovedBuiltinFields,
    getHiddenFieldKeys,
    getLibraryProfileOrientation,
    isBuiltinSectionRemoved,
    renderRemovedBuiltinFieldsToggle,
    renderRemovedBuiltinSectionsToggle,
} from '../utils/libraryProfileLayout';

import type SceneCardsPlugin from '../main';
import { CharacterManager } from '../services/CharacterManager';
import { RenameConfirmModal } from '../components/RenameConfirmModal';

import { applyMobileClass, isMobile } from '../components/MobileAdapter';
import { attachTooltip } from '../components/Tooltip';
import { mountLibraryEntityBoardAction } from '../components/LibraryEntityBoardAction';
import { renderLibraryProfileOrientationToggle } from '../components/LibraryProfileOrientationToggle';
import { renderNativeLibraryBase, disposeNativeLibraryBase } from '../components/NativeLibraryBase';
import { renderCodexCategoryTabs } from '../components/CodexCategoryTabs';
import {
    ARCHIVE_FILTER_HASHTAGS_KEY,
    buildArchiveFilterFieldOptions,
    collectArchiveFilterLabels,
    collectEntityFilterKeys,
    renderLibraryArchiveFilterBar,
} from '../components/LibraryFilterChips';
import {
    getLibraryContentMode,
    rememberLibraryCategory,
    renderLibraryStoryGraphAction,
    setLibraryContentMode,
    renderLibraryStoryGraph,
} from '../components/LibraryModeBar';
import type { StoryGraph } from '../components/StoryGraph';
import {
    renderLibraryBrowseToolbar,
    renderLibraryModeToolbar,
} from '../components/LibraryBrowseLayout';
/**
 * Location View — hierarchical World → Location browser with inline editing.
 *
 * Overview: collapsible tree showing worlds, their locations, orphan locations.
 * Detail: editable profile for a world or location with scene side-panel.
 */
export class LocationView extends ProjectBoundItemView {
    private plugin: SceneCardsPlugin;
    private sceneManager: SceneManager;
    private locationManager: LocationManager;
    private selectedItem: string | null = null; // filePath of selected world/location
    private rootContainer: HTMLElement | null = null;
    private storyGraph: StoryGraph | null = null;
    private collapsedSections: Set<string> = new Set();
    private autoSaveTimer: number | null = null;
    /** The draft waiting to be saved (if any) */
    private pendingSaveDraft: WorldOrLocation | null = null;
    /** Snapshot of the item before any edits — used for undo recording */
    private undoSnapshot: WorldOrLocation | null = null;
    private _lastSaveTime = 0;
    private _libraryCategoriesEpoch = 0;
    private static readonly SAVE_REFRESH_GRACE_MS = 2000;
    /** Original name when the detail view was opened — used for cascade rename detection */
    private originalItemName: string | null = null;
    /** Original type (world vs location) when the detail view was opened */
    private originalItemType: 'world' | 'location' | null = null;
    /** Current search/filter text for overview tree */
    private searchText: string = '';
    /** Locations-specific top-level interface: card profiles, native browse, or graph. */
    private locationOverviewMode: 'editor' | 'base' | 'story-graph';
    private browseSearchOpen = false;
    private browseFilterOpen = false;
    /** Precomputed location-name → scene count for the current overview render */
    private _locationSceneCounts: Map<string, number> | null = null;
    /** Current sort mode for the overview tree */
    private sortBy: 'name' | 'modified' | 'created' | 'type' = 'name';
    /** Active locationType tag filters (lowercased). Empty = no filter. */
    private activeTagFilters: Set<string> = new Set();
    /**
     * When true and the active project belongs to a series, the tree hides
     * worlds and locations whose `books[]` field excludes the current book.
     */
    private bookFilterActive: boolean = false;

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
        this.ensureProjectBinding(sceneManager.activeProject?.filePath);
        // Use the plugin's shared LocationManager so entries scanned from
        // Additional Source Folders survive view refreshes.
        this.locationManager = plugin.locationManager;
        this.locationOverviewMode = 'editor';
    }

    getViewType(): string { return LOCATION_VIEW_TYPE; }

    getDisplayText(): string {
        const title = this.resolveProjectTitle(this.sceneManager.getProjects(), this.sceneManager.activeProject);
        return title || 'NarrativeLab';
    }

    getIcon(): string { return 'map-pin'; }

    private syncOverviewModeFromLibraryUi(): void {
        const mode = getLibraryContentMode(this.plugin, this.getBoundProjectFile());
        this.locationOverviewMode = mode === 'story-graph'
            ? 'story-graph'
            : mode === 'browse'
                ? 'base'
                : 'editor';
    }

    async onOpen(): Promise<void> {
        this.captureProjectBinding(this.sceneManager);
        this.plugin.storyLeaf = this.leaf;
        this.syncOverviewModeFromLibraryUi();
        rememberLibraryCategory(this.plugin, 'locations', this.getBoundProjectFile());
        const container = this.containerEl.children[1] as HTMLElement;
        container.empty();
        container.addClass('story-line-location-container');
        applyMobileClass(container);
        this.rootContainer = container;

        await this.sceneManager.initialize();
        if (!this.plugin.entitiesFresh()) {
            await this.plugin.reloadEntities();
        }
        if (this.rootContainer !== container || !container.isConnected) return;
        this.renderView(container);
    }

    async onClose(): Promise<void> {
        // Flush any pending auto-save so edits are not lost
        await this.flushPendingSave();
        // Remove any orphaned gallery lightbox windows
        activeDocument.querySelectorAll('.gallery-lightbox-window').forEach(el => el.remove());
        this.clearPortaledDropdowns(); // issue #102 — clean up portaled popups
    }

    // ── Main render ────────────────────────────────────

    private renderView(container: HTMLElement): void {
        disposeNativeLibraryBase(this);
        this.clearPortaledDropdowns();
        container.empty();

        const toolbar = container.createDiv('story-line-toolbar');
        const titleRow = toolbar.createDiv('story-line-title-row');
        titleRow.createEl('h3', { cls: 'story-line-view-title', text: this.plugin.getProjectDisplayName(this.getBoundProjectFile()) });

        renderViewSwitcher(toolbar, LOCATION_VIEW_TYPE, this.plugin, this.leaf);

        // ── Codex category tabs + Location Profiles / Browse / Story Graph ──
        const storyGraphActive = !this.selectedItem
            && this.locationOverviewMode === 'story-graph'
            && !isMobile;
        renderCodexCategoryTabs(container, {
            activeId: storyGraphActive ? 'story-graph' : 'locations-pseudo',
            leaf: this.leaf,
            plugin: this.plugin,
            renderLeadingTabs: (tabs) => renderLibraryStoryGraphAction(
                tabs,
                storyGraphActive,
                () => {
                    this.selectedItem = null;
                    this.locationOverviewMode = 'story-graph';
                    setLibraryContentMode(this.plugin, 'story-graph', this.getBoundProjectFile());
                    if (this.rootContainer) this.renderView(this.rootContainer);
                },
            ),
            onCategoryActivate: (categoryId) => {
                if (categoryId !== 'locations') return;
                this.selectedItem = null;
                this.locationOverviewMode = getLibraryContentMode(this.plugin, this.getBoundProjectFile()) === 'browse'
                    ? 'base'
                    : 'editor';
                if (this.rootContainer) this.renderView(this.rootContainer);
            },
            onCategoriesChanged: () => {
                if (this.rootContainer) this.renderView(this.rootContainer);
            },
        });

        const content = container.createDiv('story-line-location-content');

        if (this.storyGraph) {
            this.storyGraph.destroy();
            this.storyGraph = null;
        }

        if (this.selectedItem) {
            this.renderDetail(content);
        } else if (this.locationOverviewMode === 'story-graph' && !isMobile) {
            this.storyGraph = renderLibraryStoryGraph(content, this.plugin, () => {
                if (this.rootContainer) this.renderView(this.rootContainer);
            });
        } else {
            this.renderOverview(content);
        }
    }

    private renderLocationOverviewModes(parent: HTMLElement): void {
        const toggle = parent.createDiv('library-mode-toggle character-mode-toggle');
        const modes: Array<{
            id: 'editor' | 'base';
            label: string;
            icon: string;
        }> = [
            { id: 'editor', label: 'Location Profiles', icon: 'map-pin' },
            { id: 'base', label: 'Browse', icon: 'layout-grid' },
        ];
        for (const mode of modes) {
            const button = toggle.createEl('button', {
                cls: `character-mode-btn ${this.locationOverviewMode === mode.id ? 'active' : ''}`,
                attr: { type: 'button', 'aria-label': t(mode.label), 'data-mode': mode.id },
            });
            const icon = button.createSpan();
            obsidian.setIcon(icon, mode.icon);
            button.createSpan({ text: t(mode.label) });
            button.addEventListener('click', () => {
                if (this.locationOverviewMode === mode.id) return;
                this.locationOverviewMode = mode.id;
                setLibraryContentMode(
                    this.plugin,
                    mode.id === 'base' ? 'browse' : 'profile',
                    this.getBoundProjectFile(),
                );
                if (this.rootContainer) this.renderView(this.rootContainer);
            });
        }
    }

    /** Fields currently feeding the archive filter chips. */
    private archiveFilterFields: string[] = ['locationType', ARCHIVE_FILTER_HASHTAGS_KEY];

    /** True when item matches any active type/#tag filter (OR). */
    private itemMatchesTagFilters(item: WorldOrLocation): boolean {
        if (this.activeTagFilters.size === 0) return true;
        const keys = collectEntityFilterKeys(
            item as unknown as Record<string, unknown>,
            this.archiveFilterFields,
        );
        return keys.some(k => this.activeTagFilters.has(k));
    }

    // ── Overview: tree hierarchy ───────────────────────

    private renderOverview(container: HTMLElement): void {
        container.empty();
        if (this.locationOverviewMode === 'base') {
            renderLibraryModeToolbar(container, actions => this.renderLocationOverviewModes(actions));
            void renderNativeLibraryBase(container, this.plugin, 'locations', this);
            return;
        }

        const { searchInput, chipHost } = renderLibraryBrowseToolbar(container, {
            plugin: this.plugin,
            categoryId: 'locations',
            sortOptions: [
                { value: 'name', label: t('Name') },
                { value: 'modified', label: t('Last edited') },
                { value: 'created', label: t('Date created') },
                { value: 'type', label: t('Type') },
            ],
            sortBy: this.sortBy,
            onSortChange: (value) => {
                this.sortBy = value as 'type' | 'name' | 'created' | 'modified';
                this.renderOverview(container);
            },
            searchText: this.searchText,
            searchPlaceholder: t('Search locations…'),
            searchOpen: this.browseSearchOpen,
            onSearchOpenChange: (open) => {
                this.browseSearchOpen = open;
                this.renderOverview(container);
            },
            onSearchChange: (value) => {
                this.searchText = value;
                this.renderOverview(container);
            },
            filterOpen: this.browseFilterOpen,
            filterCount: this.activeTagFilters.size,
            onFilterOpenChange: (open) => {
                this.browseFilterOpen = open;
                this.renderOverview(container);
            },
            onNew: (ev) => {
                const menu = new Menu();
                menu.addItem(item => item.setTitle(t('New World')).onClick(() => this.promptNewWorld()));
                menu.addItem(item => item.setTitle(t('New Location')).onClick(() => this.promptNewLocation()));
                showMenuSafely(menu, ev);
            },
            newLabel: t('New'),
            // Location Profiles is card-only; Browse (native Base) owns table/list.
            showLayoutToggle: false,
            onLayoutChange: () => this.renderOverview(container),
            renderLeadingActions: (actionsEl) => this.renderLocationOverviewModes(actionsEl),
            appendExtra: (actionsEl) => {
                const currentBook = this.plugin.sceneManager.getCurrentBookTitle();
                const inSeries = !!this.plugin.sceneManager.getSeriesFolder();
                if (!inSeries || !currentBook) return;
                const filterToggle = actionsEl.createEl('button', {
                    cls: `codex-book-filter${this.bookFilterActive ? ' active' : ''}`,
                    text: this.bookFilterActive ? t('Showing: {book}', { book: currentBook }) : t('All projects'),
                });
                attachTooltip(filterToggle, this.bookFilterActive
                    ? t('Click to show all series locations')
                    : t('Click to hide entries not in “{book}”', { book: currentBook }));
                filterToggle.addEventListener('click', () => {
                    this.bookFilterActive = !this.bookFilterActive;
                    this.renderOverview(container);
                });
            },
        });

        const hadFocus = activeDocument.activeElement?.closest('.story-line-location-container') != null;
        if (searchInput && (hadFocus || this.browseSearchOpen)) {
            window.setTimeout(() => {
                searchInput.focus();
                searchInput.selectionStart = searchInput.selectionEnd = searchInput.value.length;
            }, 0);
        }

        // Collect filter chips from user-selected profile fields (default: Type + #hashtags).
        const allWorldsForTags = this.locationManager.getAllWorlds();
        const allOrphansForTags = this.locationManager.getOrphanLocations();
        const allItemsForTags: WorldOrLocation[] = [];
        for (const w of allWorldsForTags) {
            allItemsForTags.push(w);
            for (const loc of this.locationManager.getLocationsForWorld(w.name)) allItemsForTags.push(loc);
        }
        for (const loc of allOrphansForTags) allItemsForTags.push(loc);

        const availableFilterFields = buildArchiveFilterFieldOptions(
            [...LOCATION_CATEGORIES, ...WORLD_CATEGORIES],
            this.plugin.settings.locationCustomSections as Array<{ fields?: Array<string | { name: string; label?: string }> }> | undefined,
        );

        this.archiveFilterFields = renderLibraryArchiveFilterBar(chipHost, {
            plugin: this.plugin,
            categoryId: 'locations',
            availableFields: availableFilterFields,
            defaultFields: ['locationType', ARCHIVE_FILTER_HASHTAGS_KEY],
            collectLabels: (fields) => collectArchiveFilterLabels(
                allItemsForTags as unknown as Record<string, unknown>[],
                fields,
            ),
            active: this.activeTagFilters,
            onChange: () => {
                if (this.activeTagFilters.size > 0) this.browseFilterOpen = true;
                this.renderOverview(container);
            },
        });

        const q = this.searchText.toLowerCase();
        const currentBook = this.plugin.sceneManager.getCurrentBookTitle();

        const allWorlds = this.locationManager.getAllWorlds();
        const allOrphans = this.locationManager.getOrphanLocations();
        const scenes = this.sceneManager.getAllScenes().filter(scene => !scene.inactive);
        // One pass for scene counts — avoid O(locations × scenes) per tree node.
        this._locationSceneCounts = new Map<string, number>();
        for (const scene of scenes) {
            for (const name of scene.location || []) {
                const loc = name.toLowerCase();
                if (!loc) continue;
                this._locationSceneCounts.set(loc, (this._locationSceneCounts.get(loc) ?? 0) + 1);
            }
        }

        // Filter worlds: show a world if its name OR any child location name matches
        let worlds = q ? allWorlds.filter(w => {
            if (w.name.toLowerCase().includes(q)) return true;
            const locs = this.locationManager.getLocationsForWorld(w.name);
            return locs.some(l => l.name.toLowerCase().includes(q));
        }) : [...allWorlds];

        let orphanLocations = q
            ? allOrphans.filter(l => l.name.toLowerCase().includes(q))
            : [...allOrphans];

        // Book-membership filter (series mode only).
        if (this.bookFilterActive && currentBook) {
            const lower = currentBook.toLowerCase();
            const inBook = (item: WorldOrLocation) => {
                if (!item.books || item.books.length === 0) return true;
                return item.books.some(b => b.toLowerCase() === lower);
            };
            worlds = worlds.filter(w => {
                if (inBook(w)) return true;
                // Keep the world if any of its child locations are in the book.
                return this.locationManager.getLocationsForWorld(w.name).some(inBook);
            });
            orphanLocations = orphanLocations.filter(inBook);
        }

        // Type/tag filter (OR) — keep world if it or any child matches
        if (this.activeTagFilters.size > 0) {
            worlds = worlds.filter(w =>
                this.itemMatchesTagFilters(w)
                || this.locationManager.getLocationsForWorld(w.name).some(loc => this.itemMatchesTagFilters(loc)));
            orphanLocations = orphanLocations.filter(loc => this.itemMatchesTagFilters(loc));
        }

        // Apply sort
        const sortItems = <T extends { name: string; locationType?: string; modified?: string; created?: string }>(arr: T[]) => {
            if (this.sortBy === 'modified') {
                arr.sort((a, b) => (b.modified ?? '').localeCompare(a.modified ?? ''));
            } else if (this.sortBy === 'created') {
                arr.sort((a, b) => (b.created ?? '').localeCompare(a.created ?? ''));
            } else if (this.sortBy === 'type') {
                arr.sort((a, b) => {
                    const ta = a.locationType || '';
                    const tb = b.locationType || '';
                    if (ta !== tb) return ta.localeCompare(tb);
                    return a.name.toLowerCase().localeCompare(b.name.toLowerCase());
                });
            } else {
                arr.sort((a, b) => a.name.toLowerCase().localeCompare(b.name.toLowerCase()));
            }
        };
        sortItems(worlds);
        sortItems(orphanLocations);

        // Flat profile cards (same chrome as Character Profiles).
        const flat: WorldOrLocation[] = [];
        for (const world of worlds) {
            flat.push(world);
            for (const loc of this.locationManager.getLocationsForWorld(world.name)) {
                if (q && !loc.name.toLowerCase().includes(q) && !world.name.toLowerCase().includes(q)) continue;
                if (this.activeTagFilters.size > 0 && !this.itemMatchesTagFilters(loc) && !this.itemMatchesTagFilters(world)) continue;
                if (this.bookFilterActive && currentBook) {
                    const lower = currentBook.toLowerCase();
                    const inBook = !loc.books || loc.books.length === 0
                        || loc.books.some(b => b.toLowerCase() === lower);
                    if (!inBook) continue;
                }
                flat.push(loc);
            }
        }
        flat.push(...orphanLocations);
        sortItems(flat);

        // Locations from scenes that don't have files yet
        let unlinked: string[] = [];
        if (this.activeTagFilters.size === 0) {
            const allLocNames = new Set([
                ...this.locationManager.getAllLocations().map(l => l.name.toLowerCase()),
                ...allWorlds.map(w => w.name.toLowerCase()),
            ]);
            const sceneLocations = this.sceneManager.queryService.getUniqueValues('location');
            unlinked = sceneLocations.filter(n => !allLocNames.has(n.toLowerCase()));
            if (q) unlinked = unlinked.filter(n => n.toLowerCase().includes(q));
            unlinked.sort((a, b) => a.localeCompare(b));
        }

        if (flat.length === 0 && unlinked.length === 0 && !q && this.activeTagFilters.size === 0 && !this.bookFilterActive) {
            const empty = container.createDiv('location-empty-state');
            const emptyIcon = empty.createDiv('location-empty-icon');
            obsidian.setIcon(emptyIcon, 'map');
            empty.createEl('h4', { text: t('No worlds or locations yet') });
            empty.createEl('p', { text: t('Create a world or a location to get started.') });
            const actions = empty.createDiv('location-empty-actions');
            const createWorldBtn = actions.createEl('button', {
                cls: 'mod-cta',
                text: t('Create first world'),
            });
            createWorldBtn.addEventListener('click', () => this.promptNewWorld());
            const createLocBtn = actions.createEl('button', {
                cls: 'mod-cta',
                text: t('Create first location'),
            });
            createLocBtn.addEventListener('click', () => this.promptNewLocation());
            return;
        }

        if (flat.length === 0 && unlinked.length === 0) {
            const empty = container.createDiv('location-empty-state');
            empty.createEl('h4', { text: t('No matching locations') });
            empty.createEl('p', { text: t('Try clearing search or tag filters.') });
            return;
        }

        const listHost = container.createDiv('character-overview-list');
        const grid = listHost.createDiv('character-overview-grid');
        for (const item of flat) {
            this.renderLocationProfileCard(grid, item);
        }

        if (unlinked.length > 0) {
            if (flat.length > 0) {
                const divider = listHost.createDiv('character-unlinked-divider');
                divider.createEl('span', { text: t('Locations from scenes (no profile yet)') });
            }
            const unlinkedGrid = listHost.createDiv('character-overview-grid');
            for (const name of unlinked) {
                this.renderUnlinkedLocationCard(unlinkedGrid, name);
            }
        }
    }

    private renderLocationProfileCard(grid: HTMLElement, item: WorldOrLocation): void {
        const card = grid.createDiv('character-overview-card location-overview-card');

        const badges = card.createDiv('character-role-badges');
        if (item.type === 'world') {
            const badge = badges.createDiv('character-role-badge');
            badge.textContent = t('World');
            badge.addClass('role-supporting');
        } else if (item.locationType) {
            for (const part of String(item.locationType).split(',').map(s => s.trim()).filter(Boolean)) {
                const badge = badges.createDiv('character-role-badge');
                badge.textContent = part;
                badge.addClass('role-supporting');
            }
        } else {
            const badge = badges.createDiv('character-role-badge');
            badge.textContent = t('Location');
            badge.addClass('role-minor');
        }

        const portrait = card.createDiv('character-card-portrait');
        const placeholderIcon = item.type === 'world' ? 'globe' : 'map-pin';
        const coverPath = libraryCoverPath(item);
        if (coverPath) {
            const imgSrc = resolveImagePath(this.app, coverPath);
            if (imgSrc) {
                const img = portrait.createEl('img', {
                    cls: 'character-portrait-img',
                    attr: { src: imgSrc, alt: item.name, loading: 'lazy', decoding: 'async' },
                });
                img.onerror = () => {
                    img.remove();
                    const ph = portrait.createDiv('character-portrait-placeholder');
                    obsidian.setIcon(ph, placeholderIcon);
                };
            } else {
                const ph = portrait.createDiv('character-portrait-placeholder');
                obsidian.setIcon(ph, placeholderIcon);
            }
        } else {
            const ph = portrait.createDiv('character-portrait-placeholder');
            obsidian.setIcon(ph, placeholderIcon);
        }

        card.createEl('h4', { text: item.name });

        let snippet = '';
        if (item.type === 'location') {
            snippet = item.world || item.parent || item.atmosphere || item.description || '';
        } else {
            snippet = item.description || item.geography || item.culture || '';
        }
        if (snippet) {
            card.createEl('p', { cls: 'character-card-snippet', text: coerceString(snippet) });
        }

        const sceneCount = this._locationSceneCounts?.get(item.name.toLowerCase()) ?? 0;
        const stats = card.createDiv('character-card-stats');
        if (sceneCount > 0) {
            stats.createSpan({ text: t('{count} scenes', { count: sceneCount }) });
        } else {
            stats.createSpan({ cls: 'character-stat-none', text: t('No scenes yet') });
        }

        card.addEventListener('click', () => {
            this.selectedItem = item.filePath;
            if (this.rootContainer) this.renderView(this.rootContainer);
        });
        card.addEventListener('contextmenu', (e) => {
            e.preventDefault();
            this.showItemContextMenu(item, e);
        });
    }

    private renderUnlinkedLocationCard(grid: HTMLElement, name: string): void {
        const card = grid.createDiv('character-overview-card character-unlinked location-overview-card');
        const portrait = card.createDiv('character-card-portrait');
        const ph = portrait.createDiv('character-portrait-placeholder');
        obsidian.setIcon(ph, 'map-pin');
        card.createEl('h4', { text: name });
        const sceneCount = this._locationSceneCounts?.get(name.toLowerCase()) ?? 0;
        const stats = card.createDiv('character-card-stats');
        if (sceneCount > 0) {
            stats.createSpan({ text: t('{count} scenes', { count: sceneCount }) });
        } else {
            stats.createSpan({ cls: 'character-stat-none', text: t('No scenes yet') });
        }
        card.addEventListener('click', () => {
            void this.createLocationFromName(name);
        });
    }

    // ── Tree node context menu (promote/demote, book membership) ───────

    private showItemContextMenu(item: WorldOrLocation, e: MouseEvent): void {
        const menu = new obsidian.Menu();
        const sm = this.plugin.sceneManager;
        const seriesFolder = sm.getSeriesFolder();
        const seriesLocFolder = seriesFolder
            ? `${seriesFolder}/Library/Locations`
            : null;
        const projectLocFolder = sm.getProjectLocalLocationFolder();
        const currentBook = sm.getCurrentBookTitle();

        menu.addItem(it => it.setTitle(item.name).setDisabled(true));
        menu.addSeparator();

        if (seriesFolder && seriesLocFolder && projectLocFolder) {
            const inSeries = item.filePath.startsWith(seriesLocFolder + '/');
            if (inSeries) {
                menu.addItem(it =>
                    it.setTitle(t('Keep in current project only'))
                        .setIcon('arrow-down-from-line')
                        .onClick(() => this.moveItemTo(item, projectLocFolder, 'demoted')));
            } else {
                menu.addItem(it =>
                    it.setTitle(t('Promote to series (shared)'))
                        .setIcon('arrow-up-from-line')
                        .onClick(() => this.moveItemTo(item, seriesLocFolder, 'promoted')));
            }
            menu.addSeparator();
        }

        if (seriesFolder && currentBook) {
            const lower = currentBook.toLowerCase();
            const allBooks = !item.books || item.books.length === 0;
            const inBook = allBooks
                || (item.books?.some(b => b.toLowerCase() === lower) ?? false);

            if (allBooks) {
                menu.addItem(it =>
                    it.setTitle(t('Restrict to "{book}" only', { book: currentBook }))
                        .setIcon('book-marked')
                        .onClick(() => this.setItemBooks(item, [currentBook])));
            } else if (inBook) {
                menu.addItem(it =>
                    it.setTitle(t('Remove from "{book}"', { book: currentBook }))
                        .setIcon('book-x')
                        .onClick(() => this.setItemBooks(item,
                            (item.books || []).filter(b => b.toLowerCase() !== lower))));
            } else {
                menu.addItem(it =>
                    it.setTitle(t('Add to "{book}"', { book: currentBook }))
                        .setIcon('book-plus')
                        .onClick(() => this.setItemBooks(item,
                            [...(item.books || []), currentBook])));
            }
            menu.addItem(it =>
                it.setTitle(t('Share across all projects'))
                    .setIcon('books')
                    .setDisabled(allBooks)
                    .onClick(() => this.setItemBooks(item, [])));
        }

        showMenuSafely(menu, e);
    }

    private async moveItemTo(item: WorldOrLocation, target: string, verb: 'promoted' | 'demoted'): Promise<void> {
        try {
            await this.locationManager.moveItem(item, target);
            new Notice(verb === 'promoted'
                ? t('Moved "{name}" to the shared series Library', { name: item.name })
                : t('Moved "{name}" to the current project Library', { name: item.name }));
            await this.plugin.refreshOpenViews();
        } catch (err) {
            new Notice(t('Could not move: {err}', { err: (err as Error).message }));
        }
    }

    private async setItemBooks(item: WorldOrLocation, books: string[]): Promise<void> {
        try {
            const updated = { ...item, books: books.length ? books : undefined } as WorldOrLocation;
            if (updated.type === 'world') {
                await this.locationManager.saveWorld(updated);
            } else {
                await this.locationManager.saveLocation(updated);
            }
            await this.plugin.refreshOpenViews();
        } catch (err) {
            new Notice(t('Could not update project membership: {err}', { err: (err as Error).message }));
        }
    }

    // ── Detail view ────────────────────────────────────

    private renderDetail(container: HTMLElement): void {
        container.empty();
        const item = this.locationManager.getItem(this.selectedItem!);
        if (!item) {
            this.selectedItem = null;
            this.renderOverview(container);
            return;
        }

        const isWorld = item.type === 'world';
        const layoutKey = isWorld ? 'world' : 'location';
        const profileOrientation = getLibraryProfileOrientation(this.plugin.settings, layoutKey);
        const horizontalProfile = profileOrientation === 'horizontal';
        const draft: WorldOrLocation = { ...item, custom: { ...(item.custom || {}) }, universalFields: { ...(item.universalFields || {}) } };
        // Snapshot for undo — taken once when the detail view opens
        this.undoSnapshot = { ...item, custom: { ...(item.custom || {}) } };
        // Track original name for cascade rename detection
        this.originalItemName = item.name;
        this.originalItemType = item.type;

        const categories = isWorld ? WORLD_CATEGORIES : LOCATION_CATEGORIES;
        if (horizontalProfile) {
            for (const category of categories) this.collapsedSections.delete(category.title);
            this.collapsedSections.delete('Custom Fields');
            this.collapsedSections.delete('Hierarchy');
            for (const key of [...this.collapsedSections]) {
                if (key.startsWith('custom-section::location::')) this.collapsedSections.delete(key);
            }
        }

        // Header
        const header = container.createDiv('location-detail-header');
        const backBtn = header.createEl('span', { cls: 'codex-nav-back-link' });
        const backIcon = backBtn.createSpan();
        obsidian.setIcon(backIcon, 'circle-arrow-left');
        backBtn.createSpan({ text: t(' All Locations') });
        backBtn.addEventListener('click', () => {
            this.selectedItem = null;
            this.renderView(this.rootContainer!);
        });

        const headerRight = header.createDiv('location-detail-header-right');

        renderLibraryProfileOrientationToggle(headerRight, {
            settings: this.plugin.settings,
            categoryKey: layoutKey,
            save: () => this.plugin.saveSettings(),
            beforeChange: () => this.flushPendingSave(),
            onChanged: () => {
                if (this.rootContainer) this.renderDetail(this.rootContainer);
            },
        });

        mountLibraryEntityBoardAction(headerRight, {
            plugin: this.plugin,
            notePath: item.filePath,
            name: draft.name || item.name,
            image: libraryCoverPath(draft),
            onCreated: () => {
                if (this.rootContainer) this.renderView(this.rootContainer);
            },
        });

        // Open file button
        const openBtn = headerRight.createEl('button', {
            cls: 'codex-detail-action-btn',
            attr: { 'aria-label': t('Open file') },
        });
        const openIcon = openBtn.createSpan();
        obsidian.setIcon(openIcon, 'file');
        attachTooltip(openBtn, t('Open file'));
        openBtn.addEventListener('click', () => this.openFile(item));

        // Delete button
        const deleteBtn = headerRight.createEl('button', {
            cls: 'codex-detail-action-btn codex-detail-delete-btn',
            attr: { 'aria-label': t('Delete') },
        });
        const deleteIcon = deleteBtn.createSpan();
        obsidian.setIcon(deleteIcon, 'trash');
        attachTooltip(deleteBtn, t('Delete'));
        deleteBtn.addEventListener('click', () => this.confirmDelete(item));

        // Type label
        const typeLabel = container.createDiv('location-detail-type');
        obsidian.setIcon(typeLabel, isWorld ? 'globe' : 'map-pin');
        typeLabel.createSpan({ text: ` ${t(isWorld ? 'World' : 'Location')}` });

        // Layout: horizontal board columns, or stacked sections + side rail
        container.toggleClass('location-detail--board', horizontalProfile);
        container.toggleClass('location-detail--vertical', !horizontalProfile);
        const layout = container.createDiv(
            `location-detail-layout ${horizontalProfile ? 'location-detail-layout--board' : 'location-detail-layout--vertical'}`,
        );
        const formPanel = layout.createDiv(
            `location-detail-form${horizontalProfile ? ' character-detail-board-track' : ' character-detail-vertical-track'}`,
        );
        const sidePanel = layout.createDiv('location-detail-side');

        if (horizontalProfile) {
            formPanel.addEventListener('wheel', (e) => {
                if (e.deltaY === 0) return;
                if (formPanel.scrollWidth <= formPanel.clientWidth + 1) return;
                const inColumnBody = !!(e.target as HTMLElement | null)?.closest?.('.location-section-body');
                if (inColumnBody && !e.shiftKey) return;
                e.preventDefault();
                formPanel.scrollLeft += e.deltaY + e.deltaX;
            }, { passive: false });
        }

        // Categories interleaved with user-defined custom sections (#120)
        const customHost = this.buildCustomSectionsHost(draft, categories.length);
        // Slot 0: any custom sections positioned above the first built-in.
        renderCustomSectionsAtSlot(formPanel, customHost, 0);
        for (let i = 0; i < categories.length; i++) {
            const category = categories[i];
            if (isBuiltinSectionRemoved(this.plugin.settings, layoutKey, category.title)) {
                renderCustomSectionsAtSlot(formPanel, customHost, i + 1);
                continue;
            }
            this.renderCategory(formPanel, category, draft, { board: horizontalProfile });
            // Slot i+1: any custom sections after the i-th built-in.
            renderCustomSectionsAtSlot(formPanel, customHost, i + 1);
        }

        // For locations: world & parent dropdowns
        if (!isWorld) {
            this.renderLocationHierarchy(formPanel, draft as StoryLocation, { board: horizontalProfile });
        }

        // Custom fields
        this.renderCustomFields(formPanel, draft, { board: horizontalProfile });

        // "+ Add custom section" button at the bottom
        renderAddCustomSectionButton(formPanel, customHost);
        renderRemovedBuiltinSectionsToggle(formPanel, {
            settings: this.plugin.settings,
            categoryKey: layoutKey,
            sections: categories.map(c => ({ title: c.title, fields: c.fields })),
            save: () => this.plugin.saveSettings(),
            onChanged: () => {
                if (this.rootContainer) this.renderDetail(this.rootContainer);
            },
        });

        // Gallery (before side panel stats)
        this.renderGallery(sidePanel, draft);

        // Side panel
        if (isWorld) {
            this.renderWorldSidePanel(sidePanel, draft as StoryWorld);
        } else {
            this.renderLocationSidePanel(sidePanel, draft as StoryLocation);
        }

        // Cross-entity references
        this.renderReferencesPanel(sidePanel, item.name);
        this.renderNotesSection(sidePanel, draft);
    }

    private renderCategory(
        parent: HTMLElement,
        category: LocationFieldCategory,
        draft: WorldOrLocation,
        opts?: { board?: boolean },
    ): void {
        const board = !!opts?.board;
        const section = parent.createDiv('location-section');
        if (board) section.addClass('character-board-column');
        const isCollapsed = board ? false : this.collapsedSections.has(category.title);

        const sectionHeader = section.createDiv('location-section-header');
        const chevron = sectionHeader.createSpan('location-section-chevron');
        if (board) chevron.addClass('is-hidden');
        obsidian.setIcon(chevron, isCollapsed ? 'chevron-right' : 'chevron-down');
        const icon = sectionHeader.createSpan('location-section-icon');
        obsidian.setIcon(icon, category.icon);
        sectionHeader.createSpan({ text: t(category.title) });

        const layoutKey = draft.type === 'world' ? 'world' : 'location';
        attachBuiltinSectionRemoveControl(sectionHeader, {
            app: this.app,
            settings: this.plugin.settings,
            categoryKey: layoutKey,
            sectionTitle: category.title,
            sectionFields: category.fields,
            save: () => this.plugin.saveSettings(),
            onChanged: () => {
                if (this.rootContainer) this.renderDetail(this.rootContainer);
            },
        });

        // '+' button to add a universal field to this section
        const addFieldBtn = sectionHeader.createEl('button', {
            cls: 'character-section-add-field-btn',
            attr: { title: t('Add universal field to this section'), 'aria-label': t('Add universal field') },
        });
        obsidian.setIcon(addFieldBtn, 'plus');
        addFieldBtn.addEventListener('click', (e) => {
            e.stopPropagation();
            const isWorld = draft.type === 'world';
            const categories = isWorld ? WORLD_CATEGORIES : LOCATION_CATEGORIES;
            const sectionNames = categories.map(c => c.title);
            const existingSiblings = this.plugin.fieldTemplates
                .getBySection(category.title, 'location')
                .map(t => ({ id: t.id, label: t.label }));
            // Snapshot the current built-in keys so moveAfter can resolve the
            // merged order even before the new field is rendered (issue #197).
            const builtInKeysForAdd = filterRemovedBuiltinFields(
                category.fields,
                this.plugin.settings,
                'location',
            )
                .filter(f => !getHiddenFieldKeys(this.plugin.settings, 'location').includes(f.key))
                .map(f => f.key);
            const modal = new AddFieldModal(
                this.app,
                category.title,
                null,
                async (template, positionAfterId) => {
                    template.category = 'location';
                    await this.plugin.fieldTemplates.add(template);
                    if (positionAfterId !== undefined) {
                        await this.plugin.fieldTemplates.moveAfter(
                            category.title, 'location', builtInKeysForAdd,
                            template.id, positionAfterId,
                        );
                    }
                    if (this.rootContainer) {
                        this.renderDetail(this.rootContainer);
                    }
                },
                undefined,
                sectionNames,
                existingSiblings,
            );
            modal.open();
        });

        const sectionBody = section.createDiv('location-section-body');
        if (isCollapsed) sectionBody.setCssStyles({ display: 'none' });

        sectionHeader.addEventListener('click', (e) => {
            if (board) return;
            if ((e.target as HTMLElement).closest('.character-section-add-field-btn')) return;
            if ((e.target as HTMLElement).closest('.codex-section-actions, .builtin-section-remove-btn')) return;
            if (this.collapsedSections.has(category.title)) {
                this.collapsedSections.delete(category.title);
                sectionBody.setCssStyles({ display: '' });
                obsidian.setIcon(chevron, 'chevron-down');
            } else {
                this.collapsedSections.add(category.title);
                sectionBody.setCssStyles({ display: 'none' });
                obsidian.setIcon(chevron, 'chevron-right');
            }
        });

        // Built-in fields (skip removed + hidden ones)
        const sectionFields = filterRemovedBuiltinFields(category.fields, this.plugin.settings, 'location');
        const hiddenKeys = getHiddenFieldKeys(this.plugin.settings, 'location');
        const visibleFields = sectionFields.filter(f => !hiddenKeys.includes(f.key));
        const hiddenFieldsInCat = sectionFields.filter(f => hiddenKeys.includes(f.key));

        // Render in user-defined merged order (built-in + universal).
        const universalFields = this.plugin.fieldTemplates.getBySection(category.title, 'location');
        const fieldMap = new Map(visibleFields.map(f => [f.key, f]));
        const tplMap = new Map(universalFields.map(t => [t.id, t]));
        const builtInKeys = visibleFields.map(f => f.key);
        const merged = this.plugin.fieldTemplates.getMergedOrder(category.title, 'location', builtInKeys);
        for (const entry of merged) {
            if (entry.kind === 'builtin') {
                const f = fieldMap.get(entry.key);
                if (f) this.renderField(sectionBody, f, draft, category.title, builtInKeys);
            } else {
                const t = tplMap.get(entry.key);
                if (t) this.renderUniversalField(sectionBody, t, draft, builtInKeys);
            }
        }

        // Hidden fields toggle
        if (hiddenFieldsInCat.length > 0) {
            const toggleEl = sectionBody.createDiv('hidden-fields-toggle');
            toggleEl.createEl('a', {
                text: t('Show {n} hidden field(s)', { n: hiddenFieldsInCat.length }),
                cls: 'hidden-fields-toggle-link',
            });
            const hiddenContainer = sectionBody.createDiv('hidden-fields-container');
            hiddenContainer.setCssStyles({ display: 'none' });
            for (const field of hiddenFieldsInCat) {
                this.renderField(hiddenContainer, field, draft);
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

        renderRemovedBuiltinFieldsToggle(sectionBody, {
            settings: this.plugin.settings,
            categoryKey: 'location',
            sectionFields: category.fields,
            save: () => this.plugin.saveSettings(),
            onChanged: () => {
                if (this.rootContainer) this.renderDetail(this.rootContainer);
            },
        });
    }

    private renderField(parent: HTMLElement, field: LocationFieldDef, draft: WorldOrLocation, sectionTitle?: string, builtInKeys?: string[]): void {
        const row = parent.createDiv('location-field-row');
        const labelEl = row.createEl('label', { cls: 'location-field-label', text: t(field.label) });

        // Up/down chevrons — reorder this built-in field within the section.
        if (sectionTitle && builtInKeys) {
            this.addBuiltInMoveChevrons(labelEl, sectionTitle, 'location', builtInKeys, field.key);
        }

        // Hide / remove controls (name is always visible + undeletable)
        attachBuiltinFieldVisibilityControls(labelEl, {
            app: this.app,
            settings: this.plugin.settings,
            categoryKey: 'location',
            fieldKey: field.key,
            fieldLabel: field.label,
            save: () => this.plugin.saveSettings(),
            onChanged: () => {
                if (this.rootContainer) this.renderDetail(this.rootContainer);
            },
        });

        const value = coerceString((draft as unknown as Record<string, unknown>)[field.key]);

        if (field.key === 'locationType') {
            const select = row.createEl('select', { cls: 'location-field-input dropdown' });
            select.createEl('option', { text: t(field.placeholder), value: '' });
            // Built-in types
            for (const typeName of LOCATION_TYPES) {
                const opt = select.createEl('option', { text: t(typeName), value: typeName.toLowerCase() });
                if (String(value).toLowerCase() === typeName.toLowerCase()) opt.selected = true;
            }
            // User-defined custom types
            const customTypes = this.plugin.settings.customLocationTypes ?? [];
            if (customTypes.length > 0) {
                const sep = select.createEl('option', { text: '──────────', value: '' });
                sep.disabled = true;
                for (const typeName of customTypes) {
                    const opt = select.createEl('option', { text: typeName, value: typeName.toLowerCase() });
                    if (String(value).toLowerCase() === typeName.toLowerCase()) opt.selected = true;
                }
            }
            // Pre-existing value not in either list (legacy)
            const knownLower = [
                ...LOCATION_TYPES.map(typeName => typeName.toLowerCase()),
                ...customTypes.map(typeName => typeName.toLowerCase()),
            ];
            if (value && !knownLower.includes(String(value).toLowerCase())) {
                const opt = select.createEl('option', { text: String(value), value: String(value) });
                opt.selected = true;
            }
            // "+ Add custom type…" sentinel
            const ADD_SENTINEL = '__add_custom_type__';
            select.createEl('option', { text: t('+ Add custom type…'), value: ADD_SENTINEL });

            select.addEventListener('change', async () => {
                if (select.value === ADD_SENTINEL) {
                    const name = await this.promptCustomLocationType();
                    if (name) {
                        const list = this.plugin.settings.customLocationTypes ?? [];
                        if (!list.some(t => t.toLowerCase() === name.toLowerCase())) {
                            list.push(name);
                            this.plugin.settings.customLocationTypes = list;
                            await this.plugin.saveSettings();
                        }
                        (draft as unknown as Record<string, unknown>)[field.key] = name.toLowerCase();
                        await this.flushSave();
                        if (this.rootContainer) this.renderDetail(this.rootContainer);
                    } else {
                        // Re-select the previous value
                        select.value = String(value).toLowerCase();
                    }
                    return;
                }
                (draft as unknown as Record<string, unknown>)[field.key] = select.value;
                this.scheduleSave(draft);
            });
        } else if (field.multiline) {
            const textarea = row.createEl('textarea', {
                cls: 'location-field-textarea',
                attr: { placeholder: t(field.placeholder), rows: '3' },
            });
            textarea.value = value;
            textarea.addEventListener('input', () => {
                (draft as unknown as Record<string, unknown>)[field.key] = textarea.value;
                this.scheduleSave(draft);
            });
        } else {
            const input = row.createEl('input', {
                cls: 'location-field-input',
                type: 'text',
                attr: { placeholder: t(field.placeholder) },
            });
            input.value = value;
            input.addEventListener('input', () => {
                (draft as unknown as Record<string, unknown>)[field.key] = input.value;
                this.scheduleSave(draft);
            });

            // ── Cascade rename: check when leaving the Name field ──
            if (field.key === 'name') {
                input.addEventListener('blur', () => {
                    this.checkLocationRename(draft, input);
                });
            }
        }
    }

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
            if (this.rootContainer) this.renderDetail(this.rootContainer);
        });

        const downBtn = labelEl.createEl('span', {
            cls: 'field-move-btn',
            attr: { title: t('Move field down'), 'aria-label': t('Move field down') },
        });
        obsidian.setIcon(downBtn, 'chevron-down');
        downBtn.addEventListener('click', async (e) => {
            e.stopPropagation();
            await this.plugin.fieldTemplates.moveEntryDown(section, category, builtInKeys, 'builtin', fieldKey);
            if (this.rootContainer) this.renderDetail(this.rootContainer);
        });
    }

    private renderUniversalField(
        parent: HTMLElement,
        tpl: UniversalFieldTemplate,
        draft: WorldOrLocation,
        builtInKeys?: string[],
    ): void {
        if (!draft.universalFields) draft.universalFields = {};
        const value = (draft.universalFields[tpl.id] ?? '') as string;

        const row = parent.createDiv('location-field-row codex-universal-field-row');

        const labelWrap = row.createDiv('codex-universal-label-wrap');
        labelWrap.createEl('label', { cls: 'location-field-label', text: tpl.label });

        const editBtn = labelWrap.createEl('span', {
            cls: 'codex-universal-edit-btn',
            attr: { title: t('Edit or remove this universal field'), 'aria-label': t('Edit field') },
        });
        obsidian.setIcon(editBtn, 'pencil');
        editBtn.addEventListener('click', () => {
            const isWorld = draft.type === 'world';
            const categories = isWorld ? WORLD_CATEGORIES : LOCATION_CATEGORIES;
            const sectionNames = categories.map(c => c.title);
            const siblings = this.plugin.fieldTemplates
                .getBySection(tpl.section, tpl.category)
                .map(t => ({ id: t.id, label: t.label }));
            const modal = new AddFieldModal(
                this.app,
                tpl.section,
                tpl,
                async (updated, positionAfterId) => {
                    updated.category = 'location';
                    await this.plugin.fieldTemplates.update(tpl.id, updated);
                    if (positionAfterId !== undefined) {
                        await this.plugin.fieldTemplates.moveAfter(
                            tpl.section, tpl.category, builtInKeys ?? [],
                            tpl.id, positionAfterId,
                        );
                    }
                    if (this.rootContainer) this.renderDetail(this.rootContainer);
                },
                async () => {
                    await this.plugin.fieldTemplates.remove(tpl.id);
                    if (this.rootContainer) this.renderDetail(this.rootContainer);
                },
                sectionNames,
                siblings,
            );
            modal.open();
        });

        // Up/down move buttons — share field-move-btn styling for hover behavior.
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
            if (this.rootContainer) this.renderDetail(this.rootContainer);
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
            if (this.rootContainer) this.renderDetail(this.rootContainer);
        });

        if (tpl.type === 'multi-select') {
            const raw = draft.universalFields[tpl.id];
            const selected: string[] = Array.isArray(raw) ? [...raw] : (typeof raw === 'string' && raw ? [raw] : []);

            const allOptions = [...tpl.options];
            if (tpl.folderSource) {
                const folder = this.app.vault.getAbstractFileByPath(tpl.folderSource);
                if (folder && 'children' in folder) {
                    for (const child of (folder as obsidian.TFolder).children) {
                        if (child instanceof obsidian.TFile && isLibraryEntityMarkdownFile(child)) {
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
                attr: { placeholder: tpl.placeholder || t('Type to add\u2026') },
            });
            // Issue #102 — portal dropdown to <body> so position:fixed coords are
            // viewport-relative even when an ancestor uses transform/contain.
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
            const select = row.createEl('select', { cls: 'location-field-input dropdown' });
            select.createEl('option', { text: tpl.placeholder || t('Select…'), value: '' });

            const dropdownOptions = [...tpl.options];
            if (tpl.folderSource) {
                const folder = this.app.vault.getAbstractFileByPath(tpl.folderSource);
                if (folder && 'children' in folder) {
                    for (const child of (folder as obsidian.TFolder).children) {
                        if (child instanceof obsidian.TFile && isLibraryEntityMarkdownFile(child)) {
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
                cls: 'location-field-textarea',
                attr: { placeholder: tpl.placeholder || '', rows: '3' },
            });
            textarea.value = value;
            textarea.addEventListener('input', () => {
                draft.universalFields![tpl.id] = textarea.value;
                this.scheduleSave(draft);
            });
        } else if (tpl.type === 'checkbox') {
            const raw: unknown = draft.universalFields?.[tpl.id];
            const checked = raw === true || raw === 'true' || raw === 'yes';
            const wrap = row.createDiv('location-field-checkbox-wrap');
            const cb = wrap.createEl('input', {
                cls: 'location-field-checkbox',
                type: 'checkbox',
            });
            cb.checked = !!checked;
            cb.addEventListener('change', () => {
                draft.universalFields![tpl.id] = cb.checked ? 'true' : 'false';
                this.scheduleSave(draft);
            });
        } else {
            const input = row.createEl('input', {
                cls: 'location-field-input',
                type: 'text',
                attr: { placeholder: tpl.placeholder || '' },
            });
            input.value = value;
            input.addEventListener('input', () => {
                draft.universalFields![tpl.id] = input.value;
                this.scheduleSave(draft);
            });
        }
    }

    private renderLocationHierarchy(
        parent: HTMLElement,
        draft: StoryLocation,
        opts?: { board?: boolean },
    ): void {
        const board = !!opts?.board;
        const section = parent.createDiv('location-section');
        if (board) section.addClass('character-board-column');
        const sectionHeader = section.createDiv('location-section-header');
        const chevron = sectionHeader.createSpan('location-section-chevron');
        if (board) chevron.addClass('is-hidden');
        obsidian.setIcon(chevron, 'chevron-down');
        const icon = sectionHeader.createSpan('location-section-icon');
        obsidian.setIcon(icon, 'git-branch');
        sectionHeader.createSpan({ text: t('Hierarchy') });

        const body = section.createDiv('location-section-body');

        // World dropdown
        const worldRow = body.createDiv('location-field-row');
        worldRow.createEl('label', { cls: 'location-field-label', text: t('World') });
        const worldSelect = worldRow.createEl('select', { cls: 'location-field-input dropdown' });
        worldSelect.createEl('option', { text: t('None (standalone)'), value: '' });
        for (const w of this.locationManager.getAllWorlds()) {
            const opt = worldSelect.createEl('option', { text: w.name, value: w.name });
            if (draft.world === w.name) opt.selected = true;
        }
        worldSelect.addEventListener('change', () => {
            draft.world = worldSelect.value || undefined;
            this.scheduleSave(draft);
        });

        // Parent location dropdown
        const parentRow = body.createDiv('location-field-row');
        parentRow.createEl('label', { cls: 'location-field-label', text: t('Parent Location') });
        const parentSelect = parentRow.createEl('select', { cls: 'location-field-input dropdown' });
        parentSelect.createEl('option', { text: t('None (top-level)'), value: '' });
        const allLocations = this.locationManager.getAllLocations()
            .filter(l => l.filePath !== draft.filePath);
        for (const loc of allLocations) {
            const opt = parentSelect.createEl('option', { text: loc.name, value: loc.name });
            if (draft.parent === loc.name) opt.selected = true;
        }
        parentSelect.addEventListener('change', () => {
            draft.parent = parentSelect.value || undefined;
            this.scheduleSave(draft);
        });
    }

    private renderCustomFields(
        parent: HTMLElement,
        draft: WorldOrLocation,
        opts?: { board?: boolean },
    ): void {
        const board = !!opts?.board;
        const section = parent.createDiv('location-section');
        if (board) section.addClass('character-board-column');
        const title = 'Custom Fields';
        const isCollapsed = board ? false : this.collapsedSections.has(title);

        const sectionHeader = section.createDiv('location-section-header');
        const chevron = sectionHeader.createSpan('location-section-chevron');
        if (board) chevron.addClass('is-hidden');
        obsidian.setIcon(chevron, isCollapsed ? 'chevron-right' : 'chevron-down');
        const icon = sectionHeader.createSpan('location-section-icon');
        obsidian.setIcon(icon, 'plus-circle');
        sectionHeader.createSpan({ text: t(title) });

        const sectionBody = section.createDiv('location-section-body');
        if (isCollapsed) sectionBody.setCssStyles({ display: 'none' });

        if (!board) {
            sectionHeader.addEventListener('click', () => {
                if (this.collapsedSections.has(title)) {
                    this.collapsedSections.delete(title);
                    sectionBody.setCssStyles({ display: '' });
                    obsidian.setIcon(chevron, 'chevron-down');
                } else {
                    this.collapsedSections.add(title);
                    sectionBody.setCssStyles({ display: 'none' });
                    obsidian.setIcon(chevron, 'chevron-right');
                }
            });
        }

        const renderAll = () => {
            sectionBody.empty();
            const custom = draft.custom || {};

            for (const [key, val] of Object.entries(custom)) {
                // Skip composite keys belonging to user-defined custom sections (#120)
                if (isCustomSectionKey(key)) continue;
                const row = sectionBody.createDiv('location-field-row location-custom-row');
                const keyIn = row.createEl('input', {
                    cls: 'location-field-input location-custom-key',
                    type: 'text',
                    attr: { placeholder: t('Field name') },
                });
                keyIn.value = key;

                const valIn = row.createEl('input', {
                    cls: 'location-field-input location-custom-value',
                    type: 'text',
                    attr: { placeholder: t('Value') },
                });
                valIn.value = val;

                const removeBtn = row.createEl('button', { cls: 'location-custom-remove', attr: { title: t('Remove') } });
                obsidian.setIcon(removeBtn, 'x');

                keyIn.addEventListener('change', () => {
                    delete draft.custom![key];
                    const nk = keyIn.value.trim();
                    if (nk) draft.custom![nk] = valIn.value;
                    this.scheduleSave(draft);
                });
                valIn.addEventListener('input', () => {
                    const k = keyIn.value.trim();
                    if (k) { draft.custom![k] = valIn.value; this.scheduleSave(draft); }
                });
                removeBtn.addEventListener('click', () => {
                    delete draft.custom![key];
                    row.remove();
                    this.scheduleSave(draft);
                });
            }

            const addRow = sectionBody.createDiv('location-custom-add-row');
            const addBtn = addRow.createEl('button', { cls: 'location-custom-add-btn', text: t('+ Add Field') });
            addBtn.addEventListener('click', () => {
                if (!draft.custom) draft.custom = {};
                let n = Object.keys(draft.custom).length + 1;
                let nk = `field_${n}`;
                while (draft.custom[nk]) nk = `field_${++n}`;
                draft.custom[nk] = '';
                renderAll();
            });
        };

        renderAll();
    }

    // ── User-defined custom sections (#120) ────────────

    /**
     * Build the {@link CustomSectionsHost} used to interleave user-defined
     * custom sections with the built-in WORLD_CATEGORIES / LOCATION_CATEGORIES
     * in the detail form. Rebuilt per-render so it always reflects the latest
     * settings array reference.
     */
    private buildCustomSectionsHost(
        draft: WorldOrLocation,
        builtinSectionCount: number,
    ): CustomSectionsHost<WorldOrLocation> {
        if (!this.plugin.settings.locationCustomSections) {
            this.plugin.settings.locationCustomSections = [];
        }
        const sections = this.plugin.settings.locationCustomSections;
        return {
            app: this.app,
            draft,
            sections,
            builtinSectionCount,
            collapsedSections: this.collapsedSections,
            collapseKeyPrefix: 'location',
            cssPrefix: 'location',
            scheduleSave: (d) => this.scheduleSave(d),
            persistSections: () => { void this.plugin.saveSettings(); },
            requestRerender: () => {
                if (this.rootContainer) this.renderView(this.rootContainer);
            },
        };
    }

    private renderNotesSection(container: HTMLElement, draft: WorldOrLocation): void {
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

    // ── Side panels ────────────────────────────────────

    private renderWorldSidePanel(container: HTMLElement, world: StoryWorld): void {
        const locations = this.locationManager.getLocationsForWorld(world.name);
        const scenes = this.sceneManager.getAllScenes().filter(scene => !scene.inactive);

        // Location count
        const statsBox = container.createDiv('location-side-stats');
        statsBox.createEl('h4', { text: t('World Summary') });
        const statGrid = statsBox.createDiv('location-stat-grid');
        this.renderStat(statGrid, String(locations.length), 'Locations');

        // Collect scenes across all locations in this world
        const locNames = new Set(locations.map(l => l.name.toLowerCase()));
        const worldScenes = scenes.filter(s =>
            (s.location || []).some(name => locNames.has(name.toLowerCase())),
        );
        this.renderStat(statGrid, String(worldScenes.length), 'Scenes');

        // Location list
        if (locations.length > 0) {
            const listSection = container.createDiv('location-side-list');
            listSection.createEl('h4', { text: t('Locations in this World') });
            for (const loc of locations) {
                const item = listSection.createDiv('location-side-item');
                const icon = item.createSpan('location-side-item-icon');
                obsidian.setIcon(icon, 'map-pin');
                item.createSpan({ text: loc.name });
                if (loc.locationType) {
                    item.createSpan({ cls: 'location-type-badge-sm', text: loc.locationType });
                }
                item.addEventListener('click', () => {
                    this.selectedItem = loc.filePath;
                    this.renderView(this.rootContainer!);
                });
            }
        }

        // Add location to this world button
        const addBtn = container.createEl('button', { cls: 'location-add-to-world-btn', text: t('+ Add location to {name}', { name: world.name }) });
        addBtn.addEventListener('click', () => this.promptNewLocation(world.name));
    }

    private renderLocationSidePanel(container: HTMLElement, loc: StoryLocation): void {
        const scenes = this.sceneManager.queryService.getFilteredScenes(
            undefined,
            { field: 'sequence', direction: 'asc' }
        );
        const locLower = loc.name.toLowerCase();
        const locScenes = scenes.filter(s =>
            (s.location || []).some(name => name.toLowerCase() === locLower),
        );

        // Stats
        const statsBox = container.createDiv('location-side-stats');
        statsBox.createEl('h4', { text: t('Location Info') });

        if (loc.world) {
            const worldInfo = statsBox.createDiv('location-side-world-info');
            const worldIcon = worldInfo.createSpan();
            obsidian.setIcon(worldIcon, 'globe');
            worldInfo.createSpan({ text: ` ${loc.world}` });
        }

        if (loc.parent) {
            const parentInfo = statsBox.createDiv('location-side-parent-info');
            const parentIcon = parentInfo.createSpan();
            obsidian.setIcon(parentIcon, 'corner-down-right');
            parentInfo.createSpan({ text: t('Inside: {parent}', { parent: loc.parent }) });
        }

        const statGrid = statsBox.createDiv('location-stat-grid');
        this.renderStat(statGrid, String(locScenes.length), 'Scenes');

        // Child locations
        const children = this.locationManager.getChildLocations(loc.name);
        if (children.length > 0) {
            this.renderStat(statGrid, String(children.length), 'Sub-locations');
        }

        // Scene list
        if (locScenes.length > 0) {
            const listSection = container.createDiv('location-side-scenes');
            listSection.createEl('h4', { text: t('Scenes here') });
            for (const scene of locScenes) {
                const item = listSection.createDiv('location-side-scene-item');
                // Shared formatter handles string acts ("1.1", "Prologue")
                // and zero-pads pure-numeric values.
                const act = formatActChapterPrefix(scene.act, '??');
                const seq = scene.sequence !== undefined ? String(scene.sequence).padStart(2, '0') : '??';

                item.createSpan({ cls: 'scene-id', text: `[${act}-${seq}]` });
                item.createSpan({ cls: 'scene-title', text: ` ${scene.title}` });

                const statusCfg = resolveStatusCfg(scene.status || 'idea');
                const statusBadge = item.createSpan({
                    cls: 'scene-status-badge',
                    attr: { title: t(statusCfg.label) },
                });
                obsidian.setIcon(statusBadge, statusCfg.icon);

                item.addEventListener('click', () => this.openScene(scene));
            }
        }

        // Characters that appear here (canonicalized via alias map)
        const charMgr = this.plugin.characterManager as CharacterManager | undefined;
        const manualAliases = this.plugin.settings?.characterAliases;
        const aliasMap = charMgr ? charMgr.buildAliasMap(manualAliases) : null;
        const resolveName = (name: string): string => {
            if (!aliasMap) return name;
            const exact = aliasMap.get(name.toLowerCase());
            if (exact) return exact;
            // Try individual words (e.g. "Konstapel Bark" → try "Bark")
            const words = name.split(/\s+/);
            for (const word of words) {
                const match = aliasMap.get(word.toLowerCase());
                if (match) return match;
            }
            return name;
        };

        const charsHere = new Map<string, number>();
        for (const scene of locScenes) {
            if (scene.pov) {
                const resolved = resolveName(scene.pov);
                charsHere.set(resolved, (charsHere.get(resolved) || 0) + 1);
            }
            if (scene.characters) {
                for (const c of scene.characters) {
                    const resolved = resolveName(c);
                    if (resolved !== resolveName(scene.pov || '')) {
                        charsHere.set(resolved, (charsHere.get(resolved) || 0) + 1);
                    }
                }
            }
        }
        if (charsHere.size > 0) {
            const charSection = container.createDiv('location-side-chars');
            charSection.createEl('h4', { text: t('Characters here') });
            const sorted = Array.from(charsHere.entries()).sort((a, b) => b[1] - a[1]);
            for (const [name, count] of sorted) {
                const item = charSection.createDiv('location-side-char-item');
                const icon = item.createSpan();
                obsidian.setIcon(icon, 'user');
                item.createSpan({ text: ` ${name}` });
                item.createSpan({ cls: 'location-side-char-count', text: `${count}` });
            }
        }
    }

    private renderReferencesPanel(container: HTMLElement, entityName: string): void {
        const index = this.plugin.linkScanner.buildEntityIndex();
        const refs = index.get(entityName.toLowerCase());
        if (!refs || refs.length === 0) return;

        const section = container.createDiv('location-references-panel');
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

    private renderStat(parent: HTMLElement, value: string, label: string): void {
        const stat = parent.createDiv('location-stat-item');
        stat.createDiv({ cls: 'location-stat-value', text: value });
        stat.createDiv({ cls: 'location-stat-label', text: label });
    }

    // ── Auto-save ──────────────────────────────────────

    /**
     * Prompt the user for a custom location type name (e.g. "Planet",
     * "Star System"). Returns the trimmed name or null if cancelled.
     */
    private promptCustomLocationType(): Promise<string | null> {
        return new Promise(resolve => {
            let resolved = false;
            const modal = new Modal(this.app);
            modal.titleEl.setText(t('Add custom location type'));
            let name = '';
            new Setting(modal.contentEl)
                .setName(t('Type name'))
                .setDesc(t('e.g. Planet, Star System, Galaxy, Dimension…'))
                .addText((text: TextComponent) => {
                    text.setPlaceholder(t('Planet'));
                    text.onChange((v: string) => (name = v));
                    window.setTimeout(() => text.inputEl?.focus(), 0);
                    text.inputEl?.addEventListener('keydown', (e: KeyboardEvent) => {
                        if (e.key === 'Enter') {
                            e.preventDefault();
                            const trimmed = name.trim();
                            if (trimmed) {
                                resolved = true;
                                modal.close();
                                resolve(trimmed);
                            }
                        }
                    });
                });
            new Setting(modal.contentEl)
                .addButton((btn: ButtonComponent) => {
                    btn.setButtonText(t('Add')).setCta().onClick(() => {
                        const trimmed = name.trim();
                        if (!trimmed) {
                            new Notice(t('Please enter a type name.'));
                            return;
                        }
                        resolved = true;
                        modal.close();
                        resolve(trimmed);
                    });
                })
                .addButton((btn: ButtonComponent) => {
                    btn.setButtonText(t('Cancel')).onClick(() => {
                        resolved = true;
                        modal.close();
                        resolve(null);
                    });
                });
            modal.onClose = () => {
                if (!resolved) resolve(null);
            };
            modal.open();
        });
    }

    private scheduleSave(draft: WorldOrLocation): void {
        if (this.autoSaveTimer) window.clearTimeout(this.autoSaveTimer);
        this.pendingSaveDraft = draft;
        this.autoSaveTimer = window.setTimeout(async () => {
            try {
                const undoMgr = this.plugin.sceneManager?.undoManager;
                const undoToken = undoMgr && this.undoSnapshot
                    ? await undoMgr.beginUpdate(draft.filePath, t('Update "{name}"', { name: draft.name }), 'location')
                    : null;
                this._lastSaveTime = Date.now();
                try {
                    if (draft.type === 'world') {
                        await this.locationManager.saveWorld(draft as StoryWorld);
                    } else {
                        await this.locationManager.saveLocation(draft as StoryLocation);
                    }
                    await undoMgr?.commitUpdate(undoToken);
                } catch (error) {
                    await undoMgr?.commitUpdate(undoToken);
                    throw error;
                }
                this.undoSnapshot = { ...draft, custom: { ...(draft.custom || {}) } };
                this.pendingSaveDraft = null;
            } catch (e) {
                console.error('NarrativeLab: failed to save location/world', e);
            }
        }, 600);
    }

    /** Immediately flush any pending debounced save so the manager's data is
     *  up-to-date before a full re-render. */
    private async flushSave(): Promise<void> {
        if (this.autoSaveTimer !== null) {
            window.clearTimeout(this.autoSaveTimer);
            this.autoSaveTimer = null;
        }
        if (this.pendingSaveDraft) {
            const draft = this.pendingSaveDraft;
            this.pendingSaveDraft = null;
            try {
                const undoMgr = this.plugin.sceneManager?.undoManager;
                const undoToken = undoMgr && this.undoSnapshot
                    ? await undoMgr.beginUpdate(draft.filePath, t('Update "{name}"', { name: draft.name }), 'location')
                    : null;
                this._lastSaveTime = Date.now();
                try {
                    if (draft.type === 'world') {
                        await this.locationManager.saveWorld(draft as StoryWorld);
                    } else {
                        await this.locationManager.saveLocation(draft as StoryLocation);
                    }
                    await undoMgr?.commitUpdate(undoToken);
                } catch (error) {
                    await undoMgr?.commitUpdate(undoToken);
                    throw error;
                }
                this.undoSnapshot = { ...draft, custom: { ...(draft.custom || {}) } };
            } catch (e) {
                console.error('NarrativeLab: failed to flush-save location/world', e);
            }
        }
    }

    /**
     * Check if a world/location name changed and offer to cascade-update all references.
     * Called on blur of the Name input field.
     */
    private checkLocationRename(draft: WorldOrLocation, inputEl: HTMLInputElement): void {
        const oldName = this.originalItemName;
        const newName = draft.name?.trim();
        if (!oldName || !newName || oldName === newName) return;

        const service = this.plugin.cascadeRename;
        const isWorld = this.originalItemType === 'world';

        const preview = isWorld
            ? service.previewWorldRename(oldName, newName)
            : service.previewLocationRename(oldName, newName);
        const total = preview.sceneCount + preview.locationCount + preview.characterLocationCount;
        if (total === 0) {
            this.originalItemName = newName;
            return;
        }

        const summary = service.buildSummary(preview);
        const modal = new RenameConfirmModal(
            this.app,
            isWorld ? 'world' : 'location',
            oldName,
            newName,
            preview,
            summary,
            async () => {
                if (isWorld) {
                    await service.cascadeWorldRename(oldName, newName);
                } else {
                    await service.cascadeLocationRename(oldName, newName);
                }
                this.originalItemName = newName;
                new Notice(t('Updated {n} reference(s) from "{old}" to "{new}"', { n: total, old: oldName, new: newName }));
            },
            () => {
                // User cancelled — revert the name back
                draft.name = oldName;
                inputEl.value = oldName;
                this.scheduleSave(draft);
            },
        );
        modal.open();
    }

    /** Immediately flush any pending debounced save */
    private async flushPendingSave(): Promise<void> {
        if (this.autoSaveTimer) {
            window.clearTimeout(this.autoSaveTimer);
            this.autoSaveTimer = null;
        }
        if (this.pendingSaveDraft) {
            try {
                this._lastSaveTime = Date.now();
                const draft = this.pendingSaveDraft;
                if (draft.type === 'world') {
                    await this.locationManager.saveWorld(draft as StoryWorld);
                } else {
                    await this.locationManager.saveLocation(draft as StoryLocation);
                }
            } catch (e) {
                console.error('NarrativeLab: failed to flush location/world save on close', e);
            }
            this.pendingSaveDraft = null;
        }
    }

    // ── Actions ────────────────────────────────────────

    private promptNewWorld(): void {
        const modal = new Modal(this.app);
        modal.titleEl.setText(t('New World'));

        let name = '';
        new Setting(modal.contentEl)
            .setName(t('World name'))
            .addText(text => {
                text.setPlaceholder(t('Enter world name\u2026'))
                    .onChange(v => (name = v));
                window.setTimeout(() => text.inputEl.focus(), 50);
            });

        new Setting(modal.contentEl)
            .addButton(btn => {
                btn.setButtonText(t('Create')).setCta().onClick(async () => {
                    if (!name.trim()) { new Notice(t('Please enter a name.')); return; }
                    try {
                        const w = await this.locationManager.createWorld(
                            this.sceneManager.getLocationFolder(), name.trim()
                        );
                        this.selectedItem = w.filePath;
                        modal.close();
                        this.renderView(this.rootContainer!);
                        new Notice(t('World "{name}" created', { name: name.trim() }));
                    } catch (e) { new Notice(String(e)); }
                });
            });

        modal.open();
    }

    private promptNewLocation(worldName?: string): void {
        const modal = new Modal(this.app);
        modal.titleEl.setText(t('New Location'));

        let name = '';
        let selectedWorld = worldName || '';

        new Setting(modal.contentEl)
            .setName(t('Location name'))
            .addText(text => {
                text.setPlaceholder(t('Enter location name\u2026'))
                    .onChange(v => (name = v));
                window.setTimeout(() => text.inputEl.focus(), 50);
            });

        // World selector
        const worlds = this.locationManager.getAllWorlds();
        if (worlds.length > 0) {
            new Setting(modal.contentEl)
                .setName(t('World'))
                .setDesc(t('Which world does this location belong to?'))
                .addDropdown(dd => {
                    dd.addOption('', 'None (standalone)');
                    for (const w of worlds) {
                        dd.addOption(w.name, w.name);
                    }
                    if (selectedWorld) dd.setValue(selectedWorld);
                    dd.onChange(v => (selectedWorld = v));
                });
        }

        new Setting(modal.contentEl)
            .addButton(btn => {
                btn.setButtonText(t('Create')).setCta().onClick(async () => {
                    if (!name.trim()) { new Notice(t('Please enter a name.')); return; }
                    try {
                        const loc = await this.locationManager.createLocation(
                            this.sceneManager.getLocationFolder(),
                            name.trim(),
                            selectedWorld || undefined
                        );
                        this.selectedItem = loc.filePath;
                        modal.close();
                        this.renderView(this.rootContainer!);
                        new Notice(t('Location "{name}" created', { name: name.trim() }));
                    } catch (e) { new Notice(String(e)); }
                });
            });

        modal.open();
    }

    private async createLocationFromName(name: string): Promise<void> {
        try {
            const loc = await this.locationManager.createLocation(
                this.sceneManager.getLocationFolder(), name
            );
            this.selectedItem = loc.filePath;
            this.renderView(this.rootContainer!);
            new Notice(t('Location profile created for "{name}"', { name }));
        } catch (e) { new Notice(String(e)); }
    }

    private confirmDelete(item: WorldOrLocation): void {
        const modal = new Modal(this.app);
        modal.titleEl.setText(item.type === 'world' ? t('Delete World') : t('Delete Location'));
        modal.contentEl.createEl('p', {
            text: t('Are you sure you want to delete "{name}"? The file will be moved to trash.', { name: item.name })
        });

        new Setting(modal.contentEl)
            .addButton(btn => {
                btn.setButtonText(t('Delete')).setClass('mod-warning').onClick(async () => {
                    // Record undo before deleting
                    const undoMgr = this.plugin.sceneManager?.undoManager;
                    if (undoMgr) {
                        const file = this.app.vault.getAbstractFileByPath(item.filePath);
                        if (file instanceof TFile) {
                            const content = await this.app.vault.read(file);
                            undoMgr.recordDelete(item.filePath, content, `Delete ${item.type} "${item.name}"`, 'location');
                        }
                    }
                    await this.locationManager.deleteItem(item.filePath);
                    this.selectedItem = null;
                    modal.close();
                    this.renderView(this.rootContainer!);
                    new Notice(t('"{name}" deleted', { name: item.name }));
                });
            })
            .addButton(btn => btn.setButtonText(t('Cancel')).onClick(() => modal.close()));

        modal.open();
    }

    private async openFile(item: WorldOrLocation): Promise<void> {
        const file = this.app.vault.getAbstractFileByPath(item.filePath);
        if (file instanceof TFile) {
            const leaf = this.app.workspace.getLeaf('tab');
            await leaf.openFile(file, { state: { mode: 'source', source: false } });
        }
    }

    private async openScene(scene: Scene): Promise<void> {
        const file = this.app.vault.getAbstractFileByPath(scene.filePath);
        if (file instanceof TFile) {
            const leaf = this.app.workspace.getLeaf('tab');
            await leaf.openFile(file, { state: { mode: 'source', source: false } });
        } else {
            new Notice(t('Could not find file: {path}', { path: scene.filePath }));
        }
    }

    // ── Refresh ────────────────────────────────────────

    /**
     * Navigate directly to a location/world detail view by file path.
     */
    async navigateToItem(filePath: string): Promise<void> {
        let item = this.locationManager.getItem(filePath);
        if (!item) {
            await this.plugin.reloadEntities();
            item = this.locationManager.getItem(filePath);
        }
        if (!item) {
            new Notice(t('Location not found in the active project.'));
            return;
        }
        this.selectedItem = filePath;
        if (this.rootContainer) {
            this.renderView(this.rootContainer);
        }
    }

    async refresh(): Promise<void> {
        // refreshOpenViews already reloaded entities — only re-render here.
        if (
            this.selectedItem &&
            Date.now() - this._lastSaveTime < LocationView.SAVE_REFRESH_GRACE_MS
        ) {
            return;
        }
        const categoriesEpoch = this.plugin.libraryCategoriesStructureEpoch;
        const categoriesChanged = categoriesEpoch !== this._libraryCategoriesEpoch;
        this._libraryCategoriesEpoch = categoriesEpoch;
        // Keep the native Bases embed mounted — remounting flashes the table.
        // Still remount when Library folders are newly adopted into tabs.
        if (
            !categoriesChanged
            && !this.selectedItem
            && this.locationOverviewMode === 'base'
            && this.rootContainer?.querySelector('.library-native-base-embed')
        ) {
            const title = this.plugin.getProjectDisplayName(this.getBoundProjectFile());
            this.rootContainer.querySelectorAll('.story-line-view-title')
                .forEach(el => { el.textContent = title; });
            return;
        }
        // Keep Story Graph mounted so wheel zoom / pan are not reset by vault refresh.
        if (
            !categoriesChanged
            && !this.selectedItem
            && this.locationOverviewMode === 'story-graph'
            && this.storyGraph
            && this.rootContainer?.querySelector('.story-graph-page')
        ) {
            const title = this.plugin.getProjectDisplayName(this.getBoundProjectFile());
            this.rootContainer.querySelectorAll('.story-line-view-title')
                .forEach(el => { el.textContent = title; });
            return;
        }
        if (this.rootContainer) {
            this.renderView(this.rootContainer);
        }
    }

    // ── Image gallery carousel ─────────────────────────

    private renderGallery(container: HTMLElement, draft: WorldOrLocation): void {
        const MAX_GALLERY = 10;
        const SECTION_KEY = '__Gallery';

        const wrapper = container.createDiv('character-gallery');
        if (absorbCoverIntoGallery(draft)) this.scheduleSave(draft);
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
                attr: { title: t('Add image ({n}/{max})', { n: gallery.length, max: MAX_GALLERY }), 'aria-label': t('Add gallery image') }
            });
            obsidian.setIcon(addBtn, 'plus');
            addBtn.addEventListener('click', (e) => {
                e.stopPropagation();
                this.pickImage().then(async (picked) => {
                    if (picked && picked !== '') {
                        gallery.push({ path: picked, caption: '' });
                        draft.gallery = [...gallery];
                        syncLibraryCoverFromGallery(draft);
                        if (draft.type === 'world') {
                            await this.locationManager.saveWorld(draft as StoryWorld);
                        } else {
                            await this.locationManager.saveLocation(draft as StoryLocation);
                        }
                        // Re-render entire gallery section
                        wrapper.empty();
                        container.removeChild(wrapper);
                        this.renderGallery(container, draft);
                        // Move gallery before side panel stats
                        const statsPanel = container.querySelector('.location-side-stats');
                        if (statsPanel) {
                            const galleryEl = container.querySelector('.character-gallery');
                            if (galleryEl) container.insertBefore(galleryEl, statsPanel);
                        }
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
                        attr: { src, alt: entry.caption || t('Gallery image') }
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
                    attr: { type: 'text', placeholder: t('Add caption\u2026'), value: entry.caption || '' }
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
                    attr: { title: t('Remove this image') }
                });
                obsidian.setIcon(removeBtn, 'x');
                removeBtn.addEventListener('click', () => {
                    gallery.splice(idx, 1);
                    draft.gallery = gallery.length ? [...gallery] : undefined;
                    syncLibraryCoverFromGallery(draft);
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

        // Navigation row: prev | thumbs | next (hidden when there is only one image)
        const nav = body.createDiv('character-gallery-nav');
        const syncNav = () => {
            nav.toggleClass('is-single', gallery.length <= 1);
        };
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

        // Thumbnail strip
        const renderThumbs = () => {
            thumbStrip.empty();
            for (let i = 0; i < gallery.length; i++) {
                const thumb = thumbStrip.createDiv({
                    cls: `character-gallery-thumb${i === activeIndex ? ' active' : ''}`
                });
                const src = resolveImagePath(this.app, gallery[i].path);
                if (src) {
                    const timg = thumb.createEl('img', { attr: { src } });
                    timg.onerror = () => {
                        timg.remove();
                        obsidian.setIcon(thumb, 'image-off');
                    };
                } else {
                    obsidian.setIcon(thumb, 'image-off');
                }
                const idx = i;
                thumb.addEventListener('click', () => {
                    activeIndex = idx;
                    renderViewer();
                    renderThumbs();
                });
            }
            syncNav();
        };

        renderViewer();
        renderThumbs();
    }

    // ── Gallery lightbox ───────────────────────────────

    /**
     * Open a floating, draggable, resizable lightbox for gallery images.
     * Sized at 2× the gallery panel width. Has prev/next navigation.
     */
    private openGalleryLightbox(
        gallery: Array<{ path: string; caption: string }>,
        startIndex: number,
        galleryWidth: number
    ): void {
        // Close any existing lightbox
        activeDocument.querySelector('.gallery-lightbox-window')?.remove();

        let currentIndex = startIndex;
        const winWidth = Math.min(Math.round(galleryWidth * 2), window.innerWidth - 40);
        const winHeight = Math.round(winWidth * 3 / 4) + 36 + 28; // 4:3 content + titlebar + caption

        // Floating window directly on body (no overlay — non-blocking)
        const win = activeDocument.body.createDiv('gallery-lightbox-window');
        win.setCssStyles({
            width: `${winWidth}px`,
            height: `${winHeight}px`,
        });

        // Titlebar (draggable)
        const titlebar = win.createDiv('gallery-lightbox-titlebar');
        const titleText = titlebar.createSpan({ cls: 'gallery-lightbox-title' });
        const closeBtn = titlebar.createEl('button', { cls: 'gallery-lightbox-close', attr: { title: t('Close') } });
        obsidian.setIcon(closeBtn, 'x');
        closeBtn.addEventListener('click', () => { cleanup(); win.remove(); });

        // Content area with nav + image
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

        // Caption
        const captionEl = win.createDiv('gallery-lightbox-caption');

        // Resize handle
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
            // Hide nav buttons if only one image
            prevBtn.setCssStyles({ display: gallery.length > 1 ? '' : 'none' });
            nextBtn.setCssStyles({ display: gallery.length > 1 ? '' : 'none' });
        };
        renderContent();

        // ── Scroll / pinch to zoom ──
        imgContainer.addEventListener('wheel', (e: WheelEvent) => {
            e.preventDefault();
            const delta = e.deltaY > 0 ? -0.1 : 0.1;
            const newZoom = Math.max(0.5, Math.min(5, getZoom() + delta));
            setZoom(newZoom);
            const img = imgContainer.querySelector('img');
            if (img) img.setCssStyles({ transform: `scale(${newZoom})` });
        }, { passive: false });

        // Touch pinch-to-zoom
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

        // ── Drag logic ──
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

        // ── Resize logic ──
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

        // Close on Escape
        const onKey = (e: KeyboardEvent) => {
            if (e.key === 'Escape') {
                cleanup();
                win.remove();
            }
        };
        activeDocument.addEventListener('keydown', onKey);

        const cleanup = () => {
            activeDocument.removeEventListener('keydown', onKey);
        };
    }

    /**
     * Open a modal to pick/import an image file.
     * Returns the vault-relative path, empty string to clear, or undefined if cancelled.
     */
    private pickImage(currentImage?: string): Promise<string | undefined> {
        const attachmentSourcePath = this.sceneManager.getLibraryAttachmentFolder('locations');
        return pickImageModal(this.app, attachmentSourcePath, currentImage);
    }
}
/* eslint-enable @typescript-eslint/no-floating-promises, @typescript-eslint/no-misused-promises, @typescript-eslint/no-unnecessary-type-assertion -- end of file-wide suppression block opened at line 1 */
