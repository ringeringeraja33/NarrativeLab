/* eslint-disable @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-argument, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-return, @typescript-eslint/no-floating-promises, @typescript-eslint/no-misused-promises, @typescript-eslint/no-unnecessary-type-assertion, @typescript-eslint/no-redundant-type-constituents, @typescript-eslint/no-unused-vars, no-unused-vars, no-useless-escape, no-control-regex, no-empty -- Obsidian's API surface and several untyped third-party libraries force dynamic dispatch; floating promises are intentional in DOM/event handlers; matching enable at end of file */
import { ButtonComponent, ItemView, Menu, Modal, Notice, Setting, TFile, TextComponent, WorkspaceLeaf } from 'obsidian';
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
import { pickImage as pickImageModal, resolveImagePath } from '../components/ImagePicker';
import { AddFieldModal } from '../components/AddFieldModal';
import {
    isCustomSectionKey,
    renderCustomSectionsAtSlot,
    renderAddCustomSectionButton,
    type CustomSectionsHost,
} from '../components/CustomSectionsRenderer';
import type { UniversalFieldTemplate } from '../services/FieldTemplateService';
import { formatActChapterPrefix } from '../utils/actChapter';
import { t } from '../utils/i18n';

import type SceneCardsPlugin from '../main';
import { CharacterManager } from '../services/CharacterManager';
import { RenameConfirmModal } from '../components/RenameConfirmModal';

import { applyMobileClass, isMobile } from '../components/MobileAdapter';
import { attachTooltip } from '../components/Tooltip';
import { renderNativeLibraryBase } from '../components/NativeLibraryBase';
import { renderCodexCategoryTabs } from '../components/CodexCategoryTabs';
import {
    collectDelimitedTags,
    collectHashtagsFromText,
    renderLibraryFilterChips,
} from '../components/LibraryFilterChips';
import {
    getLibraryContentMode,
    renderLibraryStoryGraph,
} from '../components/LibraryModeBar';
import type { StoryGraph } from '../components/StoryGraph';
import {
    getLibraryBrowseLayout,
    getLibraryFilePropertyOptions,
    getLibraryFilePropertyValue,
    getLibraryNotePropertyOptions,
    getLibraryNotePropertyValue,
    getLibraryTableSort,
    getLibraryTableColumns,
    getLibraryTableFormulas,
    evaluateLibraryTableFormula,
    compareLibraryTableValues,
    pageSlice,
    renderLibraryBrowseToolbar,
    renderLibraryTableHeader,
    setLibraryTableColumns,
    setLibraryTableSort,
    LIBRARY_BROWSE_PAGE_SIZE,
} from '../components/LibraryBrowseLayout';

/**
 * Location View — hierarchical World → Location browser with inline editing.
 *
 * Overview: collapsible tree showing worlds, their locations, orphan locations.
 * Detail: editable profile for a world or location with scene side-panel.
 */
export class LocationView extends ItemView {
    private plugin: SceneCardsPlugin;
    private sceneManager: SceneManager;
    private locationManager: LocationManager;
    private selectedItem: string | null = null; // filePath of selected world/location
    private rootContainer: HTMLElement | null = null;
    private storyGraph: StoryGraph | null = null;
    private collapsedSections: Set<string> = new Set();
    private collapsedTreeNodes: Set<string> = new Set();
    private autoSaveTimer: number | null = null;
    /** The draft waiting to be saved (if any) */
    private pendingSaveDraft: WorldOrLocation | null = null;
    /** Snapshot of the item before any edits — used for undo recording */
    private undoSnapshot: WorldOrLocation | null = null;
    private _lastSaveTime = 0;
    private static readonly SAVE_REFRESH_GRACE_MS = 2000;
    /** Original name when the detail view was opened — used for cascade rename detection */
    private originalItemName: string | null = null;
    /** Original type (world vs location) when the detail view was opened */
    private originalItemType: 'world' | 'location' | null = null;
    /** Current search/filter text for overview tree */
    private searchText: string = '';
    private browseSearchOpen = true;
    private browseFilterOpen = true;
    private _searchTimer: number | null = null;
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
        // Use the plugin's shared LocationManager so entries scanned from
        // Additional Source Folders survive view refreshes.
        this.locationManager = plugin.locationManager;
    }

    getViewType(): string { return LOCATION_VIEW_TYPE; }

    getDisplayText(): string {
        const title = this.plugin?.sceneManager?.activeProject?.title;
        return title ? `NarrativeLab - ${title}` : 'NarrativeLab';
    }

    getIcon(): string { return 'map-pin'; }

    async onOpen(): Promise<void> {
        this.plugin.storyLeaf = this.leaf;
        const container = this.containerEl.children[1] as HTMLElement;
        container.empty();
        container.addClass('story-line-location-container');
        applyMobileClass(container);
        this.rootContainer = container;

        await this.sceneManager.initialize();
        if (!this.plugin.entitiesFresh()) {
            await this.plugin.reloadEntities();
        }
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
        this.clearPortaledDropdowns(); // issue #102 — don't leak portaled popups across re-renders
        container.empty();

        const toolbar = container.createDiv('story-line-toolbar');
        const titleRow = toolbar.createDiv('story-line-title-row');
        titleRow.createEl('h3', { cls: 'story-line-view-title', text: this.plugin.getActiveProjectDisplayName() });

        renderViewSwitcher(toolbar, LOCATION_VIEW_TYPE, this.plugin, this.leaf);

        // ── Codex category tabs + Browse / Story Graph ──
        renderCodexCategoryTabs(container, {
            activeId: 'locations-pseudo',
            leaf: this.leaf,
            plugin: this.plugin,
            showModeToggle: !this.selectedItem,
            onModeChange: () => {
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
        } else if (getLibraryContentMode(this.plugin) === 'story-graph' && !isMobile) {
            this.storyGraph = renderLibraryStoryGraph(content, this.plugin, () => {
                if (this.rootContainer) this.renderView(this.rootContainer);
            });
        } else {
            this.renderOverview(content);
        }
    }

    /** True when item matches any active type/#tag filter (OR). */
    private itemMatchesTagFilters(item: WorldOrLocation): boolean {
        if (this.activeTagFilters.size === 0) return true;
        if (item.type === 'location' && item.locationType) {
            for (const part of String(item.locationType).split(',').map(s => s.trim().toLowerCase()).filter(Boolean)) {
                if (this.activeTagFilters.has(part)) return true;
            }
        }
        const rec = item as unknown as Record<string, unknown>;
        for (const val of Object.values(rec)) {
            if (typeof val !== 'string' || !val.includes('#')) continue;
            const lower = val.toLowerCase();
            for (const key of this.activeTagFilters) {
                if (lower.includes(`#${key}`)) return true;
            }
        }
        return false;
    }

    /** Flat cards / table for Locations browse (list keeps the world tree). */
    private renderLocationBrowseAlt(
        container: HTMLElement,
        layout: 'cards' | 'table',
        items: WorldOrLocation[],
    ): void {
        let shown = LIBRARY_BROWSE_PAGE_SIZE;
        const host = container.createDiv('location-browse-alt');
        const paint = () => {
            host.empty();
            const { visible, hasMore } = pageSlice(items, shown);
            if (layout === 'cards') {
                const grid = host.createDiv('codex-entry-cards');
                for (const item of visible) {
                    const card = grid.createDiv('codex-entry-card');
                    const cover = card.createDiv('codex-entry-card-cover');
                    if (item.image) {
                        const src = resolveImagePath(this.app, item.image);
                        if (src) cover.createEl('img', { attr: { src, alt: '', loading: 'lazy' } });
                        else obsidian.setIcon(cover, item.type === 'world' ? 'globe' : 'map-pin');
                    } else {
                        obsidian.setIcon(cover, item.type === 'world' ? 'globe' : 'map-pin');
                    }
                    card.createEl('h4', { text: item.name });
                    if (item.type === 'location' && item.locationType) {
                        card.createSpan({ cls: 'codex-entry-type-badge', text: item.locationType });
                    } else if (item.type === 'world') {
                        card.createSpan({ cls: 'codex-entry-type-badge', text: t('World') });
                    }
                    if (item.type === 'location' && item.world) {
                        card.createSpan({ cls: 'codex-entry-card-meta', text: item.world });
                    }
                    card.addEventListener('click', () => {
                        this.selectedItem = item.filePath;
                        if (this.rootContainer) this.renderView(this.rootContainer);
                    });
                }
            } else {
                const cols = getLibraryTableColumns(this.plugin, 'locations') ?? ['type', 'world'];
                const propertyLabels = new Map<string, string>([
                    ['type', 'type'] as [string, string],
                    ['world', 'world'] as [string, string],
                    ...getLibraryFilePropertyOptions().map(property => [property.key, property.label] as [string, string]),
                ]);
                const formulas = getLibraryTableFormulas(this.plugin, 'locations');
                for (const formula of formulas) propertyLabels.set(`formula:${formula.id}`, formula.name);
                const resolveValue = (item: WorldOrLocation, key: string): unknown => {
                    if (key.startsWith('file.')) {
                        return getLibraryFilePropertyValue(this.plugin, item.filePath, key);
                    }
                    if (key === 'name') return item.name;
                    if (key === 'type') {
                        return item.type === 'world'
                            ? t('World')
                            : (item.locationType || t('Location'));
                    }
                    if (key === 'world') {
                        return item.type === 'location' ? (item.world || item.parent || '') : '';
                    }
                    const direct = (item as unknown as Record<string, unknown>)[key];
                    return direct !== undefined
                        ? direct
                        : getLibraryNotePropertyValue(this.plugin, item.filePath, key);
                };
                const valueForColumn = (item: WorldOrLocation, key: string): unknown => {
                    const formula = key.startsWith('formula:')
                        ? formulas.find(value => value.id === key.slice('formula:'.length))
                        : undefined;
                    return formula
                        ? evaluateLibraryTableFormula(formula.expression, property => resolveValue(item, property))
                        : resolveValue(item, key);
                };
                const tableSort = getLibraryTableSort(this.plugin, 'locations');
                const tableItems = [...items];
                if (tableSort) {
                    tableItems.sort((left, right) => {
                        const result = compareLibraryTableValues(
                            valueForColumn(left, tableSort.key),
                            valueForColumn(right, tableSort.key),
                        );
                        return tableSort.direction === 'asc' ? result : -result;
                    });
                }
                const tableVisible = pageSlice(tableItems, shown).visible;
                const wrap = host.createDiv('library-base-table-wrap');
                const table = wrap.createEl('table', { cls: 'library-base-table' });
                const hr = table.createEl('thead').createEl('tr');
                renderLibraryTableHeader(hr, 'name', 'name', tableSort, sort => {
                    void setLibraryTableSort(this.plugin, 'locations', sort).then(paint);
                });
                for (const key of cols) {
                    renderLibraryTableHeader(hr, propertyLabels.get(key) || key, key, tableSort, sort => {
                        void setLibraryTableSort(this.plugin, 'locations', sort).then(paint);
                    });
                }
                const tbody = table.createEl('tbody');
                for (const item of tableVisible) {
                    const tr = tbody.createEl('tr');
                    const nameTd = tr.createEl('td');
                    const btn = nameTd.createEl('button', {
                        cls: 'library-base-table-name-btn',
                        text: item.name,
                    });
                    btn.addEventListener('click', () => {
                        this.selectedItem = item.filePath;
                        if (this.rootContainer) this.renderView(this.rootContainer);
                    });
                    for (const key of cols) {
                        const value = valueForColumn(item, key);
                        tr.createEl('td', {
                            text: Array.isArray(value) ? value.join(', ') : String(value ?? ''),
                        });
                    }
                }
            }
            if (hasMore) {
                const more = host.createEl('button', {
                    cls: 'mod-cta library-browse-load-more',
                    text: t('Load more'),
                });
                more.addEventListener('click', () => {
                    shown += LIBRARY_BROWSE_PAGE_SIZE;
                    paint();
                });
            }
        };
        paint();
    }

    // ── Overview: tree hierarchy ───────────────────────

    private renderOverview(container: HTMLElement): void {
        container.empty();
        if (getLibraryContentMode(this.plugin) === 'browse') {
            void renderNativeLibraryBase(container, this.plugin, 'locations', this);
            return;
        }
        container.createEl('h3', { text: t('Worlds & Locations') });

        const locationPropertyFiles: WorldOrLocation[] = [
            ...this.locationManager.getAllWorlds(),
            ...this.locationManager.getAllLocations(),
        ];
        const locProps = [
            { key: 'type', label: 'type', type: 'note' as const },
            { key: 'world', label: 'world', type: 'note' as const },
            ...getLibraryNotePropertyOptions(
                this.plugin,
                locationPropertyFiles.map(item => item.filePath),
            ).filter(property => property.key !== 'type' && property.key !== 'world'),
            ...getLibraryFilePropertyOptions(),
        ];
        const savedLocCols = getLibraryTableColumns(this.plugin, 'locations');
        const selectedLocProps = savedLocCols !== undefined
            ? savedLocCols
            : ['type', 'world'];

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
            properties: locProps,
            selectedProperties: selectedLocProps,
            onPropertiesChange: async (keys) => {
                await setLibraryTableColumns(this.plugin, 'locations', keys);
                this.renderOverview(container);
            },
            onNew: (ev) => {
                const menu = new Menu();
                menu.addItem(item => item.setTitle(t('New World')).onClick(() => this.promptNewWorld()));
                menu.addItem(item => item.setTitle(t('New Location')).onClick(() => this.promptNewLocation()));
                menu.showAtMouseEvent(ev);
            },
            newLabel: t('New'),
            onLayoutChange: () => this.renderOverview(container),
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

        // Collect locationType + #hashtag labels for chip filter
        const allWorldsForTags = this.locationManager.getAllWorlds();
        const allOrphansForTags = this.locationManager.getOrphanLocations();
        const tagLabels = new Map<string, string>();
        const collectItemTags = (item: WorldOrLocation) => {
            if (item.type === 'location') collectDelimitedTags(tagLabels, item.locationType);
            const rec = item as unknown as Record<string, unknown>;
            for (const val of Object.values(rec)) {
                if (typeof val === 'string' && val.includes('#')) collectHashtagsFromText(tagLabels, val);
            }
        };
        for (const w of allWorldsForTags) {
            collectItemTags(w);
            for (const loc of this.locationManager.getLocationsForWorld(w.name)) collectItemTags(loc);
        }
        for (const loc of allOrphansForTags) collectItemTags(loc);
        renderLibraryFilterChips(chipHost, tagLabels, this.activeTagFilters, () => {
            if (this.activeTagFilters.size > 0) this.browseFilterOpen = true;
            this.renderOverview(container);
        });

        const q = this.searchText.toLowerCase();
        const currentBook = this.plugin.sceneManager.getCurrentBookTitle();

        const allWorlds = this.locationManager.getAllWorlds();
        const allOrphans = this.locationManager.getOrphanLocations();
        const scenes = this.sceneManager.getAllScenes().filter(scene => !scene.inactive);
        // One pass for scene counts — avoid O(locations × scenes) per tree node.
        this._locationSceneCounts = new Map<string, number>();
        for (const scene of scenes) {
            const loc = scene.location?.toLowerCase();
            if (!loc) continue;
            this._locationSceneCounts.set(loc, (this._locationSceneCounts.get(loc) ?? 0) + 1);
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

        if (worlds.length === 0 && orphanLocations.length === 0 && !q && this.activeTagFilters.size === 0) {
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

        if (worlds.length === 0 && orphanLocations.length === 0) {
            const empty = container.createDiv('location-empty-state');
            empty.createEl('h4', { text: t('No matching locations') });
            empty.createEl('p', { text: t('Try clearing search or tag filters.') });
            return;
        }

        const layout = getLibraryBrowseLayout(this.plugin, 'locations');
        if (layout === 'cards' || layout === 'table') {
            const flat: WorldOrLocation[] = [];
            for (const world of worlds) {
                flat.push(world);
                for (const loc of this.locationManager.getLocationsForWorld(world.name)) {
                    if (q && !loc.name.toLowerCase().includes(q) && !world.name.toLowerCase().includes(q)) continue;
                    if (this.activeTagFilters.size > 0 && !this.itemMatchesTagFilters(loc) && !this.itemMatchesTagFilters(world)) continue;
                    flat.push(loc);
                }
            }
            flat.push(...orphanLocations);
            this.renderLocationBrowseAlt(container, layout, flat);
            return;
        }

        const tree = container.createDiv('location-tree');

        // Render each world and its locations
        for (const world of worlds) {
            this.renderWorldNode(tree, world, scenes);
        }

        // Orphan locations (not linked to a world)
        if (orphanLocations.length > 0) {
            if (worlds.length > 0) {
                const divider = tree.createDiv('location-orphan-divider');
                divider.createEl('span', { text: t('Standalone Locations') });
            }
            for (const loc of orphanLocations) {
                this.renderLocationNode(tree, loc, scenes, 0);
            }
        }

        // Locations from scenes that don't have files yet
        if (this.activeTagFilters.size > 0) return;
        const allLocNames = [...this.locationManager.getAllLocations().map(l => l.name.toLowerCase()),
            ...allWorlds.map(w => w.name.toLowerCase())];
        const sceneLocations = this.sceneManager.queryService.getUniqueValues('location');
        let unlinked = sceneLocations.filter(n => !allLocNames.includes(n.toLowerCase()));
        if (q) {
            unlinked = unlinked.filter(n => n.toLowerCase().includes(q));
        }

        if (unlinked.length > 0) {
            const divider = tree.createDiv('location-orphan-divider');
            divider.createEl('span', { text: t('Locations from scenes (no profile yet)') });
            for (const name of unlinked) {
                this.renderUnlinkedLocation(tree, name, scenes);
            }
        }
    }

    private renderWorldNode(parent: HTMLElement, world: StoryWorld, scenes: Scene[]): void {
        const node = parent.createDiv('location-tree-node location-world-node');
        const isCollapsed = this.collapsedTreeNodes.has(world.filePath);

        const header = node.createDiv('location-tree-header');
        const chevron = header.createSpan('location-tree-chevron');

        const worldLocations = this.locationManager.getLocationsForWorld(world.name);
        if (worldLocations.length > 0) {
            obsidian.setIcon(chevron, isCollapsed ? 'chevron-right' : 'chevron-down');
            chevron.addEventListener('click', (e) => {
                e.stopPropagation();
                if (this.collapsedTreeNodes.has(world.filePath)) {
                    this.collapsedTreeNodes.delete(world.filePath);
                } else {
                    this.collapsedTreeNodes.add(world.filePath);
                }
                this.renderView(this.rootContainer!);
            });
        } else {
            chevron.setCssStyles({ width: '14px' }); // spacer
        }

        const icon = header.createSpan('location-tree-icon');
        if (world.image) {
            try {
                // Use the helper function to resolve the image path
                const imgSrc = resolveImagePath(this.app, world.image);
                
                const img = icon.createEl('img', { attr: { src: imgSrc, alt: world.name }, cls: 'location-tree-thumb' });
                
                // Add error handler to show placeholder if image fails to load
                img.onerror = () => {
                    img.remove();
                    obsidian.setIcon(icon, 'globe');
                    console.log('Failed to load world image:', world.image);
                };
            } catch (error) {
                console.error('Error loading world image:', error);
                obsidian.setIcon(icon, 'globe');
            }
        } else {
            obsidian.setIcon(icon, 'globe');
        }

        header.createSpan({ cls: 'location-tree-name', text: world.name });


        header.addEventListener('click', () => {
            this.selectedItem = world.filePath;
            this.renderView(this.rootContainer!);
        });

        header.addEventListener('contextmenu', (e) => {
            e.preventDefault();
            this.showItemContextMenu(world, e);
        });

        // Children
        if (!isCollapsed && worldLocations.length > 0) {
            const children = node.createDiv('location-tree-children');
            let topLevel = this.locationManager.getTopLevelLocations(world.name);
            if (this.activeTagFilters.size > 0) {
                // Keep locations that match, or whose descendants match
                topLevel = topLevel.filter(loc =>
                    this.itemMatchesTagFilters(loc)
                    || this.locationManager.getChildLocations(loc.name).some(c => this.itemMatchesTagFilters(c)));
            }
            for (const loc of topLevel) {
                this.renderLocationNode(children, loc, scenes, 1);
            }
        }
    }

    private renderLocationNode(parent: HTMLElement, loc: StoryLocation, scenes: Scene[], depth: number): void {
        const node = parent.createDiv('location-tree-node');
        const childLocations = this.locationManager.getChildLocations(loc.name);
        const isCollapsed = this.collapsedTreeNodes.has(loc.filePath);

        const header = node.createDiv('location-tree-header');
        header.setCssStyles({ paddingLeft: `${depth * 20}px` });

        const chevron = header.createSpan('location-tree-chevron');
        if (childLocations.length > 0) {
            obsidian.setIcon(chevron, isCollapsed ? 'chevron-right' : 'chevron-down');
            chevron.addEventListener('click', (e) => {
                e.stopPropagation();
                if (this.collapsedTreeNodes.has(loc.filePath)) {
                    this.collapsedTreeNodes.delete(loc.filePath);
                } else {
                    this.collapsedTreeNodes.add(loc.filePath);
                }
                this.renderView(this.rootContainer!);
            });
        } else {
            chevron.setCssStyles({ width: '14px' });
        }

        const icon = header.createSpan('location-tree-icon');
        if (loc.image) {
            try {
                // Use the helper function to resolve the image path
                const imgSrc = resolveImagePath(this.app, loc.image);
                
                const img = icon.createEl('img', { attr: { src: imgSrc, alt: loc.name }, cls: 'location-tree-thumb' });
                
                // Add error handler to show placeholder if image fails to load
                img.onerror = () => {
                    img.remove();
                    obsidian.setIcon(icon, 'map-pin');
                    console.log('Failed to load location image:', loc.image);
                };
            } catch (error) {
                console.error('Error loading location image:', error);
                obsidian.setIcon(icon, 'map-pin');
            }
        } else {
            obsidian.setIcon(icon, 'map-pin');
        }

        header.createSpan({ cls: 'location-tree-name', text: loc.name });

        // Scene count for this location (precomputed map when available)
        const locLower = loc.name.toLowerCase();
        const sceneCount = (this._locationSceneCounts?.get(locLower)
            ?? scenes.filter(s => s.location?.toLowerCase() === locLower).length);
        if (sceneCount > 0) {
            header.createSpan({ cls: 'location-tree-count', text: `${sceneCount} sc` });
        }

        if (loc.locationType) {
            header.createSpan({ cls: 'location-type-badge', text: loc.locationType });
        }

        header.addEventListener('click', () => {
            this.selectedItem = loc.filePath;
            this.renderView(this.rootContainer!);
        });

        header.addEventListener('contextmenu', (e) => {
            e.preventDefault();
            this.showItemContextMenu(loc, e);
        });

        // Child locations
        if (!isCollapsed && childLocations.length > 0) {
            const children = node.createDiv('location-tree-children');
            for (const child of childLocations) {
                this.renderLocationNode(children, child, scenes, depth + 1);
            }
        }
    }

    private renderUnlinkedLocation(parent: HTMLElement, name: string, scenes: Scene[]): void {
        const node = parent.createDiv('location-tree-node location-unlinked-node');
        const header = node.createDiv('location-tree-header');

        header.createSpan({ cls: 'location-tree-chevron' }).setCssStyles({ width: '14px' });
        const icon = header.createSpan('location-tree-icon');
        obsidian.setIcon(icon, 'map-pin');
        header.createSpan({ cls: 'location-tree-name', text: name });

        const locLower = name.toLowerCase();
        const sceneCount = this._locationSceneCounts?.get(locLower)
            ?? scenes.filter(s => s.location?.toLowerCase() === locLower).length;
        if (sceneCount > 0) {
            header.createSpan({ cls: 'location-tree-count', text: `${sceneCount} sc` });
        }

        const createBtn = header.createEl('button', { cls: 'location-create-profile-btn', text: t('Create') });
        createBtn.addEventListener('click', async (e) => {
            e.stopPropagation();
            await this.createLocationFromName(name);
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

        menu.showAtMouseEvent(e);
    }

    private async moveItemTo(item: WorldOrLocation, target: string, verb: 'promoted' | 'demoted'): Promise<void> {
        try {
            await this.locationManager.moveItem(item, target);
            new Notice(`"${item.name}" ${verb}`);
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
        const draft: WorldOrLocation = { ...item, custom: { ...(item.custom || {}) }, universalFields: { ...(item.universalFields || {}) } };
        // Snapshot for undo — taken once when the detail view opens
        this.undoSnapshot = { ...item, custom: { ...(item.custom || {}) } };
        // Track original name for cascade rename detection
        this.originalItemName = item.name;
        this.originalItemType = item.type;

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
        typeLabel.createSpan({ text: ` ${isWorld ? 'World' : 'Location'}` });

        // Portrait area (clickable to change)
        const portraitArea = container.createDiv('location-detail-portrait');
        const renderPortrait = () => {
            portraitArea.empty();
            if (draft.image) {
                try {
                    // Use the helper function to resolve the image path
                    const imgSrc = resolveImagePath(this.app, draft.image);
                    
                    const img = portraitArea.createEl('img', { attr: { src: imgSrc, alt: draft.name } });
                    img.classList.add('location-detail-portrait-img');
                    
                    // Add error handler to show placeholder if image fails to load
                    img.onerror = () => {
                        img.remove();
                        const ph = portraitArea.createDiv('location-detail-portrait-placeholder');
                        obsidian.setIcon(ph, 'image');
                        console.log('Failed to load location detail image:', draft.image);
                    };
                } catch (error) {
                    console.error('Error loading location detail image:', error);
                    const ph = portraitArea.createDiv('location-detail-portrait-placeholder');
                    obsidian.setIcon(ph, 'image');
                }
            } else {
                const ph = portraitArea.createDiv('location-detail-portrait-placeholder');
                obsidian.setIcon(ph, 'image');
                ph.createEl('span', { text: t('Click to add image') });
            }
            const changeLabel = portraitArea.createDiv('location-portrait-change-label');
            changeLabel.textContent = draft.image ? 'Change image' : '';
        };
        renderPortrait();
        portraitArea.addEventListener('click', () => {
            this.pickImage(draft.image).then(async (picked) => {
                if (picked !== undefined) {
                    draft.image = picked || undefined;
                    if (draft.type === 'world') {
                        await this.locationManager.saveWorld(draft as StoryWorld);
                    } else {
                        await this.locationManager.saveLocation(draft as StoryLocation);
                    }
                    renderPortrait();
                }
            });
        });

        // Layout: form + side panel
        const layout = container.createDiv('location-detail-layout');
        const formPanel = layout.createDiv('location-detail-form');
        const sidePanel = layout.createDiv('location-detail-side');

        // Categories interleaved with user-defined custom sections (#120)
        const categories = isWorld ? WORLD_CATEGORIES : LOCATION_CATEGORIES;
        const customHost = this.buildCustomSectionsHost(draft, categories.length);
        // Slot 0: any custom sections positioned above the first built-in.
        renderCustomSectionsAtSlot(formPanel, customHost, 0);
        for (let i = 0; i < categories.length; i++) {
            this.renderCategory(formPanel, categories[i], draft);
            // Slot i+1: any custom sections after the i-th built-in.
            renderCustomSectionsAtSlot(formPanel, customHost, i + 1);
        }

        // For locations: world & parent dropdowns
        if (!isWorld) {
            this.renderLocationHierarchy(formPanel, draft as StoryLocation);
        }

        // Custom fields
        this.renderCustomFields(formPanel, draft);

        // "+ Add custom section" button at the bottom
        renderAddCustomSectionButton(formPanel, customHost);

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
        draft: WorldOrLocation
    ): void {
        const section = parent.createDiv('location-section');
        const isCollapsed = this.collapsedSections.has(category.title);

        const sectionHeader = section.createDiv('location-section-header');
        const chevron = sectionHeader.createSpan('location-section-chevron');
        obsidian.setIcon(chevron, isCollapsed ? 'chevron-right' : 'chevron-down');
        const icon = sectionHeader.createSpan('location-section-icon');
        obsidian.setIcon(icon, category.icon);
        sectionHeader.createSpan({ text: category.title });

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
            const builtInKeysForAdd = category.fields
                .filter(f => !(this.plugin.settings.hiddenFields['location'] ?? []).includes(f.key))
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
            if ((e.target as HTMLElement).closest('.character-section-add-field-btn')) return;
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

        // Built-in fields (skip hidden ones)
        const hiddenKeys = this.plugin.settings.hiddenFields['location'] ?? [];
        const visibleFields = category.fields.filter(f => !hiddenKeys.includes(f.key));
        const hiddenFieldsInCat = category.fields.filter(f => hiddenKeys.includes(f.key));

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
                    ? `Hide ${hiddenFieldsInCat.length} hidden field${hiddenFieldsInCat.length > 1 ? 's' : ''}`
                    : `Show ${hiddenFieldsInCat.length} hidden field${hiddenFieldsInCat.length > 1 ? 's' : ''}`;
            });
        }
    }

    private renderField(parent: HTMLElement, field: LocationFieldDef, draft: WorldOrLocation, sectionTitle?: string, builtInKeys?: string[]): void {
        const row = parent.createDiv('location-field-row');
        const labelEl = row.createEl('label', { cls: 'location-field-label', text: field.label });

        // Up/down chevrons — reorder this built-in field within the section.
        if (sectionTitle && builtInKeys) {
            this.addBuiltInMoveChevrons(labelEl, sectionTitle, 'location', builtInKeys, field.key);
        }

        // Hide/unhide toggle (skip 'name')
        if (field.key !== 'name') {
            const hiddenKeys = this.plugin.settings.hiddenFields['location'] ?? [];
            const isHidden = hiddenKeys.includes(field.key);
            const hideBtn = labelEl.createEl('span', {
                cls: 'field-hide-btn',
                attr: { 'aria-label': isHidden ? t('Show this field') : t('Hide this field') },
            });
            obsidian.setIcon(hideBtn, isHidden ? 'eye' : 'eye-off');
            hideBtn.addEventListener('click', async (e) => {
                e.stopPropagation();
                const settings = this.plugin.settings;
                if (!settings.hiddenFields['location']) settings.hiddenFields['location'] = [];
                const list = settings.hiddenFields['location'];
                const idx = list.indexOf(field.key);
                if (idx >= 0) {
                    list.splice(idx, 1);
                } else {
                    list.push(field.key);
                }
                await this.plugin.saveSettings();
                if (this.rootContainer) this.renderDetail(this.rootContainer);
            });
        }

        const value = coerceString((draft as unknown as Record<string, unknown>)[field.key]);

        if (field.key === 'locationType') {
            const select = row.createEl('select', { cls: 'location-field-input dropdown' });
            select.createEl('option', { text: field.placeholder, value: '' });
            // Built-in types
            for (const t of LOCATION_TYPES) {
                const opt = select.createEl('option', { text: t, value: t.toLowerCase() });
                if (String(value).toLowerCase() === t.toLowerCase()) opt.selected = true;
            }
            // User-defined custom types
            const customTypes = this.plugin.settings.customLocationTypes ?? [];
            if (customTypes.length > 0) {
                const sep = select.createEl('option', { text: '──────────', value: '' });
                sep.disabled = true;
                for (const t of customTypes) {
                    const opt = select.createEl('option', { text: t, value: t.toLowerCase() });
                    if (String(value).toLowerCase() === t.toLowerCase()) opt.selected = true;
                }
            }
            // Pre-existing value not in either list (legacy)
            const knownLower = [
                ...LOCATION_TYPES.map(t => t.toLowerCase()),
                ...customTypes.map(t => t.toLowerCase()),
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
                attr: { placeholder: field.placeholder, rows: '3' },
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
                attr: { placeholder: field.placeholder },
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
                attr: { placeholder: tpl.placeholder || 'Type to add\u2026' },
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
            select.createEl('option', { text: tpl.placeholder || 'Select…', value: '' });

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
                cls: 'location-field-textarea',
                attr: { placeholder: tpl.placeholder, rows: '3' },
            });
            textarea.value = value;
            textarea.addEventListener('input', () => {
                draft.universalFields![tpl.id] = textarea.value;
                this.scheduleSave(draft);
            });
        } else if (tpl.type === 'checkbox') {
            const checked = value === true || value === 'true' || value === 'yes';
            const wrap = row.createDiv('location-field-checkbox-wrap');
            const cb = wrap.createEl('input', {
                cls: 'location-field-checkbox',
                type: 'checkbox',
            });
            cb.checked = !!checked;
            cb.addEventListener('change', () => {
                draft.universalFields![tpl.id] = cb.checked;
                this.scheduleSave(draft);
            });
        } else {
            const input = row.createEl('input', {
                cls: 'location-field-input',
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

    private renderLocationHierarchy(parent: HTMLElement, draft: StoryLocation): void {
        const section = parent.createDiv('location-section');
        const sectionHeader = section.createDiv('location-section-header');
        const chevron = sectionHeader.createSpan('location-section-chevron');
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

    private renderCustomFields(parent: HTMLElement, draft: WorldOrLocation): void {
        const section = parent.createDiv('location-section');
        const title = 'Custom Fields';
        const isCollapsed = this.collapsedSections.has(title);

        const sectionHeader = section.createDiv('location-section-header');
        const chevron = sectionHeader.createSpan('location-section-chevron');
        obsidian.setIcon(chevron, isCollapsed ? 'chevron-right' : 'chevron-down');
        const icon = sectionHeader.createSpan('location-section-icon');
        obsidian.setIcon(icon, 'plus-circle');
        sectionHeader.createSpan({ text: t(title) });

        const sectionBody = section.createDiv('location-section-body');
        if (isCollapsed) sectionBody.setCssStyles({ display: 'none' });

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
        section.createEl('h4', { text: t('Notes') });

        const textarea = section.createEl('textarea', {
            cls: 'codex-notes-textarea',
            attr: { placeholder: t('Free-form notes (markdown)…'), rows: '12' },
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
        const worldScenes = scenes.filter(s => s.location && locNames.has(s.location.toLowerCase()));
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
        const locScenes = scenes.filter(s => s.location?.toLowerCase() === locLower);

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
                // Record undo snapshot
                const undoMgr = this.plugin.sceneManager?.undoManager;
                if (undoMgr && this.undoSnapshot) {
                    undoMgr.recordUpdate(
                        draft.filePath,
                        this.undoSnapshot as unknown as unknown as Record<string, unknown>,
                        draft as unknown as unknown as Record<string, unknown>,
                        `Update ${draft.type} "${draft.name}"`,
                        'location'
                    );
                    this.undoSnapshot = { ...draft, custom: { ...(draft.custom || {}) } };
                }
                this._lastSaveTime = Date.now();
                if (draft.type === 'world') {
                    await this.locationManager.saveWorld(draft as StoryWorld);
                } else {
                    await this.locationManager.saveLocation(draft as StoryLocation);
                }
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
                if (undoMgr && this.undoSnapshot) {
                    undoMgr.recordUpdate(
                        draft.filePath,
                        this.undoSnapshot as unknown as unknown as Record<string, unknown>,
                        draft as unknown as unknown as Record<string, unknown>,
                        `Update ${draft.type} "${draft.name}"`,
                        'location'
                    );
                    this.undoSnapshot = { ...draft, custom: { ...(draft.custom || {}) } };
                }
                this._lastSaveTime = Date.now();
                if (draft.type === 'world') {
                    await this.locationManager.saveWorld(draft as StoryWorld);
                } else {
                    await this.locationManager.saveLocation(draft as StoryLocation);
                }
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
        if (this.rootContainer) {
            this.renderView(this.rootContainer);
        }
    }

    // ── Image gallery carousel ─────────────────────────

    private renderGallery(container: HTMLElement, draft: WorldOrLocation): void {
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
                attr: { title: t('Add image ({n}/{max})', { n: gallery.length, max: MAX_GALLERY }), 'aria-label': t('Add gallery image') }
            });
            obsidian.setIcon(addBtn, 'plus');
            addBtn.addEventListener('click', (e) => {
                e.stopPropagation();
                this.pickImage().then(async (picked) => {
                    if (picked && picked !== '') {
                        gallery.push({ path: picked, caption: '' });
                        draft.gallery = [...gallery];
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
                        attr: { src, alt: entry.caption || 'Gallery image' }
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
                const img = imgContainer.createEl('img', { attr: { src, alt: entry.caption || 'Gallery image' } });
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
        const attachmentSourcePath = this.sceneManager.getAttachmentSourcePath();
        return pickImageModal(this.app, attachmentSourcePath, currentImage);
    }
}
/* eslint-enable @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-argument, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-return, @typescript-eslint/no-floating-promises, @typescript-eslint/no-misused-promises, @typescript-eslint/no-unnecessary-type-assertion, @typescript-eslint/no-redundant-type-constituents, @typescript-eslint/no-unused-vars, no-unused-vars, no-useless-escape, no-control-regex, no-empty -- end of file-wide suppression block opened at line 1 */
