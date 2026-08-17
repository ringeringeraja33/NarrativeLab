/* eslint-disable @typescript-eslint/no-floating-promises, @typescript-eslint/no-misused-promises, @typescript-eslint/no-unnecessary-type-assertion, @typescript-eslint/no-unused-vars -- Obsidian's API surface and several untyped third-party libraries force dynamic dispatch; floating promises are intentional in DOM/event handlers; matching enable at end of file */
import * as obsidian from 'obsidian';
import { SceneManager } from '../services/SceneManager';
import { CharacterManager } from '../services/CharacterManager';
import { renderViewSwitcher } from '../components/ViewSwitcher';
import { pickImage as pickImageModal, resolveImagePath } from '../components/ImagePicker';
import { isMobile, applyMobileClass } from '../components/MobileAdapter';
import {
    getLibraryContentMode,
    rememberLibraryCategory,
    renderLibraryStoryGraphAction,
    renderLibraryStoryGraph,
    setLibraryContentMode,
} from '../components/LibraryModeBar';
import type { StoryGraph } from '../components/StoryGraph';
import { RenameConfirmModal } from '../components/RenameConfirmModal';
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

import type SceneCardsPlugin from '../main';
import type { LibraryProfileEmbedOptions } from './CanvasLibraryProfileHost';

import { attachTooltip } from '../components/Tooltip';
import { mountLibraryEntityBoardAction } from '../components/LibraryEntityBoardAction';
import { renderLibraryProfileOrientationToggle } from '../components/LibraryProfileOrientationToggle';
import { renderCodexCategoryTabs } from '../components/CodexCategoryTabs';
import { renderLibraryArchiveFilterBar, collectEntityFilterKeys, collectArchiveFilterLabels, ARCHIVE_FILTER_HASHTAGS_KEY, buildArchiveFilterFieldOptions } from '../components/LibraryFilterChips';
import { disposeNativeLibraryBase, renderNativeLibraryBase } from '../components/NativeLibraryBase';
import {
    renderLibraryBrowseToolbar,
    renderLibraryModeToolbar,
} from '../components/LibraryBrowseLayout';
import { Modal, Notice, Setting, TFile, WorkspaceLeaf, normalizePath } from 'obsidian';
import { CHARACTER_CATEGORIES, CHARACTER_ROLES, CHARACTER_TAGLINE_FIELD_KEYS, Character, CharacterFieldDef, CharacterRelation, CharacterRelationCategory, RELATION_CATEGORIES, RELATION_TYPES_BY_CATEGORY, RoleEntry, TagType, computeReciprocalUpdates, extractAllCharacterTags, extractCharacterLocationTags, extractCharacterProps, getPrimaryRole, getRoleDisplay, getRoleList, normalizeCharacterRelations, resolveCharacterCardSnippet } from '../models/Character';
import { CHARACTER_VIEW_TYPE } from '../constants';
import { Scene, isWrittenLikeStatus, resolveStatusCfg } from '../models/Scene';
import { coerceString } from '../utils/narrow';
import { seedUiLanguage, t } from '../utils/i18n';
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
import {
    ensureSeededCharacterRelationTypes,
    listCustomCharacterRelationTypes,
    mergeCharacterRelationTypes,
    upsertCustomCharacterRelationType,
} from '../utils/storyGraphCharacterRelations';
type ScenePresenceStats = { pov: number; present: number };

/**
 * Character View - rich character cards with full profile editing.
 *
 * Overview mode: grid of compact character cards (name, role, scene count).
 * Detail mode: full character profile with collapsible sections and editable fields.
 */
export class CharacterView extends ProjectBoundItemView {
    private plugin: SceneCardsPlugin;
    private sceneManager: SceneManager;
    private characterManager: CharacterManager;
    private selectedCharacter: string | null = null;   // file path of selected character
    private rootContainer: HTMLElement | null = null;
    private collapsedSections: Set<string> = new Set();
    private autoSaveTimer: number | null = null;
    /** The draft waiting to be saved (if any) */
    private pendingSaveDraft: Character | null = null;
    /** Stable working copy reused across internal detail re-renders. */
    private editingDraft: Character | null = null;
    private pendingSaveRevision = 0;
    private saveQueue: Promise<void> = Promise.resolve();
    private saveInFlight = false;
    /** Snapshot of the character before any edits — used for undo recording */
    private undoSnapshot: Character | null = null;
    /** Timestamp of last self-initiated save; used to suppress external refresh that would steal focus */
    private _lastSaveTime = 0;
    private _libraryCategoriesEpoch = 0;
    private static readonly SAVE_REFRESH_GRACE_MS = 2000;
    /** Active StoryGraph instance (cleaned up on re-render) */
    private storyGraph: StoryGraph | null = null;
    /** Original name when the detail view was opened — used for cascade rename detection */
    private originalCharacterName: string | null = null;
    /** Last-saved relations snapshot — used to diff for reciprocal sync */
    private _lastSavedRelations: CharacterRelation[] = [];
    /** Flag to prevent reciprocal sync from re-triggering itself */
    private _skipReciprocalSync = false;
    /** Current search/filter text for overview grid */
    private searchText: string = '';
    /** Characters-specific top-level interface: card profiles, native browse, or graph. */
    private characterOverviewMode: 'editor' | 'base' | 'story-graph';
    private browseSearchOpen = false;
    private browseFilterOpen = false;
    private _searchTimer: number | null = null;
    /** Current sort mode for the overview grid */
    private sortBy: 'name' | 'modified' | 'created' | 'role' = 'name';
    /**
     * Active role/tag filters (lowercased). Characters must have at least
     * one matching role badge (OR). Empty = no tag filter.
     */
    private activeTagFilters: Set<string> = new Set();
    /**
     * When true and the active project belongs to a series, the overview
     * grid hides characters whose `books[]` field excludes the current
     * book (i.e. is non-empty and does not contain the current title).
     */
    private bookFilterActive: boolean = false;
    /** Focus the search field after the user opens it — not after every re-render. */
    private focusSearchOnNextOverview = false;

    /** Issue #102 — dropdowns portaled to <body> so position:fixed escapes
     *  ancestors with transform/contain. Cleaned up on each re-render. */
    private _portaledDropdowns: HTMLElement[] = [];
    private clearPortaledDropdowns(): void {
        for (const el of this._portaledDropdowns) { try { el.remove(); } catch { /* noop */ } }
        this._portaledDropdowns = [];
    }
    private embedOptions: LibraryProfileEmbedOptions | null = null;
    private embedHostEl: HTMLElement | null = null;

    /** Invalidate in-flight overview batch renders when the grid re-renders. */
    private _overviewGen = 0;
    private _overviewObserver: IntersectionObserver | null = null;
    private _overviewScrollHandler: (() => void) | null = null;
    /** Invalidate deferred detail side-panel / lazy column work when navigating away. */
    private _detailSideGen = 0;
    private _detailBodyObservers: IntersectionObserver[] = [];
    private static readonly OVERVIEW_BATCH = 36;
    private static readonly OVERVIEW_LITE_THRESHOLD = 36;

    constructor(leaf: WorkspaceLeaf, plugin: SceneCardsPlugin, sceneManager: SceneManager) {
        super(leaf);
        this.plugin = plugin;
        this.sceneManager = sceneManager;
        this.ensureProjectBinding(sceneManager.activeProject?.filePath);
        // Use the plugin's shared CharacterManager so entries scanned from
        // Additional Source Folders (which are added to the plugin-level
        // manager) are visible here too. Previously each view created its
        // own instance and re-loaded only from the project Characters
        // folder on every refresh, wiping out externally-scanned entries.
        this.characterManager = plugin.characterManager;
        this.characterOverviewMode = 'editor';
    }

    getViewType(): string {
        return CHARACTER_VIEW_TYPE;
    }

    getDisplayText(): string {
        const title = this.resolveProjectTitle(this.sceneManager.getProjects(), this.sceneManager.activeProject);
        return title || 'NarrativeLab';
    }

    getIcon(): string {
        return 'users';
    }

    /** Prefer live contentEl — avoids stale detached roots after leaf remounts. */
    private getViewRoot(): HTMLElement {
        if (this.embedHostEl) {
            this.rootContainer = this.embedHostEl;
            return this.embedHostEl;
        }
        const el = (this.contentEl ?? this.containerEl.children[1]) as HTMLElement;
        this.rootContainer = el;
        return el;
    }

    private syncOverviewModeFromLibraryUi(): void {
        const mode = getLibraryContentMode(this.plugin, this.getBoundProjectFile());
        this.characterOverviewMode = mode === 'story-graph'
            ? 'story-graph'
            : mode === 'browse'
                ? 'base'
                : 'editor';
    }

    async onOpen(): Promise<void> {
        this.captureProjectBinding(this.sceneManager);
        this.plugin.storyLeaf = this.leaf;
        this.syncOverviewModeFromLibraryUi();
        rememberLibraryCategory(this.plugin, 'characters', this.getBoundProjectFile());
        const container = this.getViewRoot();
        container.empty();
        container.addClass('story-line-character-container');
        applyMobileClass(container);

        await this.sceneManager.initialize();
        // Skip reload when refreshOpenViews (or another Library tab) just loaded.
        if (!this.plugin.entitiesFresh()) {
            await this.plugin.reloadEntities();
        }
        if (this.rootContainer !== container || !container.isConnected) return;
        this.renderView(container);
    }

    async onClose(): Promise<void> {
        this._overviewGen++;
        this._detailSideGen++;
        this._overviewObserver?.disconnect();
        this._overviewObserver = null;
        this.cancelDetailBodyObservers();
        if (this._overviewScrollHandler && this.rootContainer) {
            const content = this.rootContainer.querySelector('.story-line-character-content');
            if (content) content.removeEventListener('scroll', this._overviewScrollHandler);
            this._overviewScrollHandler = null;
        }
        if (this._searchTimer !== null) {
            window.clearTimeout(this._searchTimer);
            this._searchTimer = null;
        }
        // Flush any pending auto-save so edits are not lost
        await this.flushPendingSave();
        this.editingDraft = null;
        // Remove any floating lightbox windows from activeDocument.body
        activeDocument.querySelectorAll('.gallery-lightbox-window').forEach(el => el.remove());
        this.clearPortaledDropdowns(); // issue #102 — clean up portaled popups
    }

    // ── Main render ────────────────────────────────────

    /** Content pane under toolbar/tabs — prefer this for open/back navigation. */
    private getContentHost(): HTMLElement | null {
        if (this.embedHostEl) return this.embedHostEl;
        const root = this.getViewRoot();
        return root.querySelector('.story-line-character-content') as HTMLElement | null;
    }

    /** Stop in-flight overview batch painting (e.g. when opening a card). */
    private cancelOverviewWork(): void {
        this._overviewGen++;
        this._overviewObserver?.disconnect();
        this._overviewObserver = null;
        if (this._overviewScrollHandler) {
            const content = this.getContentHost();
            if (content) content.removeEventListener('scroll', this._overviewScrollHandler);
            this._overviewScrollHandler = null;
        }
    }

    /** Disconnect lazy board-column observers when leaving / re-rendering detail. */
    private cancelDetailBodyObservers(): void {
        for (const observer of this._detailBodyObservers) {
            try { observer.disconnect(); } catch { /* noop */ }
        }
        this._detailBodyObservers = [];
    }

    /**
     * Swap only the content pane (keep toolbar + category tabs).
     * Used for card open / back so large libraries don't rebuild chrome.
     */
    private renderContentOnly(): void {
        disposeNativeLibraryBase(this);
        this.clearPortaledDropdowns();
        this.cancelOverviewWork();
        this.cancelDetailBodyObservers();
        this._detailSideGen++;

        const root = this.getViewRoot();
        const content = this.getContentHost();
        if (!content) {
            this.renderView(root);
            return;
        }

        content.empty();
        if (this.storyGraph) {
            this.storyGraph.destroy();
            this.storyGraph = null;
        }

        if (this.selectedCharacter) {
            this.renderCharacterDetail(content);
        } else if (this.characterOverviewMode === 'story-graph' && !isMobile) {
            this.storyGraph = renderLibraryStoryGraph(content, this.plugin, () => {
                if (this.rootContainer) this.renderView(this.rootContainer);
            }, this.getBoundProjectFile());
        } else {
            this.renderCharacterOverview(content);
        }
    }

    private renderView(container: HTMLElement): void {
        disposeNativeLibraryBase(this);
        this.clearPortaledDropdowns(); // issue #102 — don't leak portaled popups across re-renders
        this.cancelOverviewWork();
        this.cancelDetailBodyObservers();
        this._detailSideGen++;
        container.empty();

        // Toolbar
        const toolbar = container.createDiv('story-line-toolbar');
        const titleRow = toolbar.createDiv('story-line-title-row');
        titleRow.createEl('h3', { cls: 'story-line-view-title', text: this.plugin.getProjectDisplayName(this.getBoundProjectFile()) });

        renderViewSwitcher(toolbar, CHARACTER_VIEW_TYPE, this.plugin, this.leaf);

        // ── Codex category tabs + Browse / Story Graph ──
        // New Character lives in the browse toolbar (inside this tab), not the project header.
        const storyGraphActive = !this.selectedCharacter
            && this.characterOverviewMode === 'story-graph'
            && !isMobile;
        renderCodexCategoryTabs(container, {
            activeId: storyGraphActive ? 'story-graph' : 'characters-pseudo',
            leaf: this.leaf,
            plugin: this.plugin,
            renderLeadingTabs: (tabs) => renderLibraryStoryGraphAction(
                tabs,
                storyGraphActive,
                () => {
                    this.selectedCharacter = null;
                    this.characterOverviewMode = 'story-graph';
                    setLibraryContentMode(this.plugin, 'story-graph', this.getBoundProjectFile());
                    if (this.rootContainer) this.renderView(this.rootContainer);
                },
            ),
            onCategoryActivate: (categoryId) => {
                if (categoryId !== 'characters') return;
                this.selectedCharacter = null;
                this.characterOverviewMode = getLibraryContentMode(this.plugin, this.getBoundProjectFile()) === 'browse'
                    ? 'base'
                    : 'editor';
                if (this.rootContainer) this.renderView(this.rootContainer);
            },
            onCategoriesChanged: () => {
                if (this.rootContainer) this.renderView(this.rootContainer);
            },
        });

        const content = container.createDiv('story-line-character-content');

        if (this.storyGraph) {
            this.storyGraph.destroy();
            this.storyGraph = null;
        }

        if (this.selectedCharacter) {
            this.renderCharacterDetail(content);
        } else if (this.characterOverviewMode === 'story-graph' && !isMobile) {
            this.storyGraph = renderLibraryStoryGraph(content, this.plugin, () => {
                if (this.rootContainer) this.renderView(this.rootContainer);
            }, this.getBoundProjectFile());
        } else {
            this.renderCharacterOverview(content);
        }
    }

    private renderCharacterOverviewModes(parent: HTMLElement): void {
        // Match the shared Library Browse / Story Graph underline tabs.
        const toggle = parent.createDiv('library-mode-toggle character-mode-toggle');
        const modes: Array<{
            id: 'editor' | 'base';
            label: string;
            icon: string;
        }> = [
            { id: 'editor', label: 'Character Profiles', icon: 'contact-round' },
            { id: 'base', label: 'Browse', icon: 'layout-grid' },
        ];
        for (const mode of modes) {
            const button = toggle.createEl('button', {
                cls: `character-mode-btn ${this.characterOverviewMode === mode.id ? 'active' : ''}`,
                attr: { type: 'button', 'aria-label': t(mode.label), 'data-mode': mode.id },
            });
            const icon = button.createSpan();
            obsidian.setIcon(icon, mode.icon);
            button.createSpan({ text: t(mode.label) });
            button.addEventListener('click', () => {
                if (this.characterOverviewMode === mode.id) return;
                this.characterOverviewMode = mode.id;
                setLibraryContentMode(
                    this.plugin,
                    mode.id === 'base' ? 'browse' : 'profile',
                    this.getBoundProjectFile(),
                );
                if (this.rootContainer) this.renderView(this.rootContainer);
            });
        }
    }

    // ── Overview Grid ──────────────────────────────────

    private renderCharacterOverview(container: HTMLElement): void {
        const searchWasFocused = activeDocument.activeElement instanceof HTMLInputElement
            && activeDocument.activeElement.classList.contains('library-browse-search-input')
            && container.contains(activeDocument.activeElement);
        const shouldFocusSearch = searchWasFocused || this.focusSearchOnNextOverview;
        this.focusSearchOnNextOverview = false;
        container.empty();
        if (this.characterOverviewMode === 'base') {
            renderLibraryModeToolbar(container, actions => this.renderCharacterOverviewModes(actions));
            void renderNativeLibraryBase(container, this.plugin, 'characters', this);
            return;
        }
        // Tab already says “角色” — skip a redundant page title to free vertical space.

        const { searchInput, chipHost } = renderLibraryBrowseToolbar(container, {
            plugin: this.plugin,
            categoryId: 'characters',
            sortOptions: [
                { value: 'name', label: t('Name') },
                { value: 'modified', label: t('Last edited') },
                { value: 'created', label: t('Date created') },
                { value: 'role', label: t('Role') },
            ],
            sortBy: this.sortBy,
            onSortChange: (value) => {
                this.sortBy = value as 'name' | 'role' | 'created' | 'modified';
                this.renderCharacterOverview(container);
            },
            searchText: this.searchText,
            searchPlaceholder: t('Search characters…'),
            searchOpen: this.browseSearchOpen,
            onSearchOpenChange: (open) => {
                this.browseSearchOpen = open;
                this.focusSearchOnNextOverview = open;
                this.renderCharacterOverview(container);
            },
            onSearchChange: (value) => {
                this.searchText = value;
                this.renderCharacterOverview(container);
            },
            filterOpen: this.browseFilterOpen,
            filterCount: this.activeTagFilters.size,
            onFilterOpenChange: (open) => {
                this.browseFilterOpen = open;
                this.renderCharacterOverview(container);
            },
            onNew: () => this.promptNewCharacter(),
            newLabel: t('New'),
            // Character Profiles is card-only; Browse (native Base) owns table/list.
            showLayoutToggle: false,
            onLayoutChange: () => this.renderCharacterOverview(container),
            renderLeadingActions: (actionsEl) => this.renderCharacterOverviewModes(actionsEl),
            appendExtra: (actionsEl) => {
                const currentBook = this.plugin.sceneManager.getCurrentBookTitle();
                const inSeries = !!this.plugin.sceneManager.getSeriesFolder();
                if (!inSeries || !currentBook) return;
                const filterToggle = actionsEl.createEl('button', {
                    cls: `codex-book-filter${this.bookFilterActive ? ' active' : ''}`,
                    text: this.bookFilterActive ? t('Showing: {book}', { book: currentBook }) : t('All projects'),
                });
                attachTooltip(filterToggle, this.bookFilterActive
                    ? t('Click to show all series characters')
                    : t('Click to hide characters not in “{book}”', { book: currentBook }));
                filterToggle.addEventListener('click', () => {
                    this.bookFilterActive = !this.bookFilterActive;
                    this.renderCharacterOverview(container);
                });
            },
        });

        if (searchInput && shouldFocusSearch) {
            window.setTimeout(() => {
                searchInput.focus();
                searchInput.selectionStart = searchInput.selectionEnd = searchInput.value.length;
            }, 0);
        }

        const q = this.searchText.toLowerCase();

        let fileCharacters = this.characterManager.getAllCharacters();
        const sceneCharNames = this.sceneManager.queryService.getAllCharacters();
        const scenes = this.sceneManager.getAllScenes().filter(scene => !scene.inactive);

        // Build alias map: lowered alias → canonical name
        const aliasMap = this.characterManager.buildAliasMap(this.plugin.settings.characterAliases);

        // Kick off async plotgrid scan in the background — will augment cards
        // once resolved. We render the grid immediately and patch in plotgrid
        // data after.
        let plotgridCharacters: Map<string, Set<string>> | null = null;
        if (typeof this.plugin.scanPlotGridCells === 'function') {
            this.plugin.scanPlotGridCells().then(result => {
                plotgridCharacters = result.characters;
                // Re-render plotgrid badges into already-rendered cards
                this.patchPlotGridBadges(container, plotgridCharacters, aliasMap);
            }).catch(() => { /* non-fatal */ });
        }

        // Collect filter chips from user-selected profile fields (default: Role + #hashtags).
        const overrides = this.plugin.settings.tagTypeOverrides;
        const availableFilterFields = buildArchiveFilterFieldOptions(
            CHARACTER_CATEGORIES,
            this.plugin.settings.characterCustomSections as Array<{ fields?: Array<string | { name: string; label?: string }> }> | undefined,
        );
        const tagsByPath = new Map<string, { props: string[]; locations: string[] }>();
        for (const c of fileCharacters) {
            const allTags = extractAllCharacterTags(c, overrides);
            const props: string[] = [];
            const locations: string[] = [];
            for (const tag of allTags) {
                if (tag.type === 'location') locations.push(tag.name);
                else props.push(tag.name);
            }
            tagsByPath.set(c.filePath, { props, locations });
        }

        const selectedFilterFields = renderLibraryArchiveFilterBar(chipHost, {
            plugin: this.plugin,
            categoryId: 'characters',
            availableFields: availableFilterFields,
            defaultFields: ['role', ARCHIVE_FILTER_HASHTAGS_KEY],
            collectLabels: (fields) => collectArchiveFilterLabels(
                fileCharacters as unknown as Record<string, unknown>[],
                fields,
                (entity) => getRoleList(entity as unknown as Character),
            ),
            active: this.activeTagFilters,
            onChange: () => {
                if (this.activeTagFilters.size > 0) this.browseFilterOpen = true;
                this.renderCharacterOverview(container);
            },
        });

        const charFilterKeys = new Map<string, string[]>();
        const tagLabels = collectArchiveFilterLabels(
            fileCharacters as unknown as Record<string, unknown>[],
            selectedFilterFields,
            (entity) => getRoleList(entity as unknown as Character),
        );
        for (const c of fileCharacters) {
            charFilterKeys.set(
                c.filePath,
                collectEntityFilterKeys(
                    c as unknown as Record<string, unknown>,
                    selectedFilterFields,
                    getRoleList(c),
                ),
            );
        }

        // Apply search filter to file-backed characters (name + tags)
        if (q) {
            fileCharacters = fileCharacters.filter(c => {
                if (c.name.toLowerCase().includes(q)) return true;
                const keys = charFilterKeys.get(c.filePath) ?? [];
                return keys.some(k => k.includes(q) || (tagLabels.get(k) ?? '').toLowerCase().includes(q));
            });
        }

        // Apply book-membership filter (series mode only).
        // A character is shown when its `books` field is missing/empty
        // (“appears in every book”) or contains the current book title.
        const currentBook = this.plugin.sceneManager.getCurrentBookTitle();
        if (this.bookFilterActive && currentBook) {
            const lower = currentBook.toLowerCase();
            fileCharacters = fileCharacters.filter(c => {
                if (!c.books || c.books.length === 0) return true;
                return c.books.some(b => b.toLowerCase() === lower);
            });
        }

        // Apply role/prop/location tag filter (OR).
        if (this.activeTagFilters.size > 0) {
            fileCharacters = fileCharacters.filter(c => {
                const keys = charFilterKeys.get(c.filePath) ?? [];
                return keys.some(k => this.activeTagFilters.has(k));
            });
        }

        // Apply sort
        if (this.sortBy === 'role') {
            const roleOrder: Record<string, number> = { protagonist: 0, antagonist: 1, supporting: 2, minor: 3 };
            fileCharacters.sort((a, b) => {
                const ra = roleOrder[getPrimaryRole(a.role).toLowerCase()] ?? 99;
                const rb = roleOrder[getPrimaryRole(b.role).toLowerCase()] ?? 99;
                return ra !== rb ? ra - rb : a.name.localeCompare(b.name);
            });
        } else if (this.sortBy === 'modified') {
            fileCharacters.sort((a, b) => (b.modified ?? '').localeCompare(a.modified ?? ''));
        } else if (this.sortBy === 'created') {
            fileCharacters.sort((a, b) => (b.created ?? '').localeCompare(a.created ?? ''));
        } else {
            fileCharacters.sort((a, b) => a.name.toLowerCase().localeCompare(b.name.toLowerCase()));
        }

        // Characters with files
        const showUnlinkedCandidates = this.activeTagFilters.size === 0 && sceneCharNames.length > 0;
        // Find characters from scenes that don't have files yet
        // Skip when a role/tag filter is active — unlinked cards have no roles.
        const allFileNames = new Set(
            this.characterManager.getAllCharacters().map(c => c.name.toLowerCase()),
        );
        const ignoredSet = new Set(this.plugin.settings.ignoredCharacters.map((n: string) => n.toLowerCase()));
        const manualAliases = this.plugin.settings.characterAliases;
        const unlinked = !showUnlinkedCandidates ? [] : sceneCharNames.filter(n => {
            const lower = n.toLowerCase();
            if (ignoredSet.has(lower)) return false;
            if (manualAliases[lower]) return false;
            if (allFileNames.has(lower)) return false;
            const canonical = aliasMap.get(lower);
            if (canonical && allFileNames.has(canonical.toLowerCase())) return false;
            return true;
        });

        // Deduplicate unlinked names: if "Micke" and "Micke Barr" both
        // appear, merge the short (first-name-only) form into the longer
        // full name so only "Micke Barr" is shown.
        let deduped = this.deduplicateUnlinked(unlinked);
        if (q) {
            deduped = deduped.filter(n => n.toLowerCase().includes(q));
        }

        if (fileCharacters.length === 0 && deduped.length === 0) {
            const empty = container.createDiv('character-empty-state');
            if (q || this.activeTagFilters.size > 0 || this.bookFilterActive) {
                empty.createEl('h4', { text: t('No matching characters') });
                empty.createEl('p', { text: t('Try clearing search or tag filters.') });
            } else {
                const emptyIcon = empty.createDiv('character-empty-icon');
                obsidian.setIcon(emptyIcon, 'user-plus');
                empty.createEl('h4', { text: t('No characters yet') });
                empty.createEl('p', { text: t('Click "+ New Character" to create your first character profile, or add characters to your scene frontmatter.') });
            }
            return;
        }

        // One O(scenes) pass — never O(characters × scenes) per card.
        // Frontmatter / POV only — body link-scan is too expensive for large projects.
        const sceneStats = this.precomputeScenePresenceStats(scenes, aliasMap);

        const gen = ++this._overviewGen;
        this._overviewObserver?.disconnect();
        this._overviewObserver = null;
        if (this._overviewScrollHandler) {
            container.removeEventListener('scroll', this._overviewScrollHandler);
            this._overviewScrollHandler = null;
        }

        const totalCards = fileCharacters.length + deduped.length;
        const lite = totalCards >= CharacterView.OVERVIEW_LITE_THRESHOLD;
        const progressRow = container.createDiv('character-overview-progress-row');
        const hint = progressRow.createDiv('character-overview-progress');
        const loadMoreBtn = progressRow.createEl('button', {
            cls: 'character-overview-load-more',
            text: t('Load more'),
            attr: { type: 'button' },
        });
        loadMoreBtn.hide();
        if (totalCards > CharacterView.OVERVIEW_BATCH) {
            hint.setText(t('Showing {shown} of {total}…', {
                shown: Math.min(CharacterView.OVERVIEW_BATCH, totalCards),
                total: totalCards,
            }));
        } else {
            progressRow.hide();
        }

        type OverviewItem =
            | { kind: 'file'; char: Character }
            | { kind: 'unlinked'; name: string };

        const items: OverviewItem[] = [
            ...fileCharacters.map((char): OverviewItem => ({ kind: 'file', char })),
            ...deduped.map((name): OverviewItem => ({ kind: 'unlinked', name })),
        ];

        // Keep grids + sentinel in a dedicated host so load-more never inserts
        // new sections after the sentinel (which broke IntersectionObserver).
        const listHost = container.createDiv('character-overview-list');
        let grid = listHost.createDiv('character-overview-grid');
        const sentinel = listHost.createDiv('character-overview-sentinel');
        let unlinkedStarted = false;
        let index = 0;
        let painting = false;

        const finishLoading = () => {
            this._overviewObserver?.disconnect();
            this._overviewObserver = null;
            if (this._overviewScrollHandler) {
                container.removeEventListener('scroll', this._overviewScrollHandler);
                this._overviewScrollHandler = null;
            }
            sentinel.remove();
            loadMoreBtn.hide();
            progressRow.hide();
        };

        const updateProgress = () => {
            if (index >= items.length) {
                finishLoading();
                return;
            }
            progressRow.show();
            hint.setText(t('Showing {shown} of {total}…', { shown: index, total: items.length }));
            loadMoreBtn.show();
        };

        const appendItem = (item: OverviewItem) => {
            if (item.kind === 'unlinked' && !unlinkedStarted) {
                unlinkedStarted = true;
                if (fileCharacters.length > 0) {
                    const divider = listHost.createDiv('character-unlinked-divider');
                    divider.createEl('span', { text: t('Characters from scenes (no profile yet)') });
                    listHost.insertBefore(divider, sentinel);
                }
                grid = listHost.createDiv('character-overview-grid');
                listHost.insertBefore(grid, sentinel);
            }
            if (item.kind === 'file') {
                this.renderOverviewCard(grid, item.char, sceneStats, aliasMap, {
                    lite,
                    tagCache: tagsByPath.get(item.char.filePath),
                });
            } else {
                this.renderUnlinkedCard(grid, item.name, sceneStats, aliasMap);
            }
        };

        const paintBatch = (): boolean => {
            if (gen !== this._overviewGen || painting) return index < items.length;
            painting = true;
            try {
                const end = Math.min(index + CharacterView.OVERVIEW_BATCH, items.length);
                for (; index < end; index++) appendItem(items[index]);
                updateProgress();
                return index < items.length;
            } finally {
                painting = false;
            }
        };

        // First paint immediately (keeps UI responsive).
        const hasMore = paintBatch();
        if (!hasMore) return;

        const tryLoadMore = () => {
            if (gen !== this._overviewGen) return;
            if (!sentinel.isConnected) return;
            const rootRect = container.getBoundingClientRect();
            const sentRect = sentinel.getBoundingClientRect();
            const nearBottom =
                container.scrollTop + container.clientHeight >= container.scrollHeight - 420
                || sentRect.top <= rootRect.bottom + 420;
            if (!nearBottom) return;
            if (paintBatch()) {
                // Keep filling while the sentinel stays in range (short viewports).
                window.requestAnimationFrame(tryLoadMore);
            }
        };

        loadMoreBtn.addEventListener('click', (e) => {
            e.preventDefault();
            paintBatch();
            window.requestAnimationFrame(tryLoadMore);
        });

        this._overviewScrollHandler = () => tryLoadMore();
        container.addEventListener('scroll', this._overviewScrollHandler, { passive: true });

        this._overviewObserver = new IntersectionObserver(
            (entries) => {
                if (gen !== this._overviewGen) {
                    this._overviewObserver?.disconnect();
                    return;
                }
                if (!entries.some((e) => e.isIntersecting)) return;
                tryLoadMore();
            },
            // Prefer viewport root — nested flex scroll roots are unreliable in Obsidian panes.
            { root: null, rootMargin: '400px 0px' },
        );
        this._overviewObserver.observe(sentinel);
        window.requestAnimationFrame(tryLoadMore);
    }

    /**
     * Build POV/presence counts keyed by canonical character name (lowercase).
     * Single pass over scenes instead of scanning every scene per card.
     */
    private precomputeScenePresenceStats(
        scenes: Scene[],
        aliasMap: Map<string, string>,
    ): Map<string, ScenePresenceStats> {
        const stats = new Map<string, ScenePresenceStats>();
        const bump = (rawName: string, asPov: boolean) => {
            if (!rawName) return;
            const lower = rawName.toLowerCase();
            const canonical = (aliasMap.get(lower) ?? lower).toLowerCase();
            let entry = stats.get(canonical);
            if (!entry) {
                entry = { pov: 0, present: 0 };
                stats.set(canonical, entry);
            }
            if (asPov) entry.pov++;
            else entry.present++;
        };

        for (const scene of scenes) {
            const povLower = scene.pov?.toLowerCase() ?? '';
            if (povLower) bump(povLower, true);

            // Overview counts use frontmatter only. Scanning every scene body via
            // linkScanner here froze large projects on open.
            for (const c of scene.characters ?? []) {
                if (!c) continue;
                const lower = c.toLowerCase();
                if (lower === povLower) continue;
                bump(lower, false);
            }
        }
        return stats;
    }

    private lookupSceneStats(
        name: string,
        sceneStats: Map<string, ScenePresenceStats>,
        aliasMap?: Map<string, string>,
    ): ScenePresenceStats {
        const lower = name.toLowerCase();
        const canonical = (aliasMap?.get(lower) ?? lower).toLowerCase();
        return sceneStats.get(canonical) ?? { pov: 0, present: 0 };
    }

    /**
     * After plotgrid scan resolves, patch "Plotgrid" badges into already-rendered cards.
     */
    private patchPlotGridBadges(
        container: HTMLElement,
        pgChars: Map<string, Set<string>>,
        aliasMap: Map<string, string>,
    ): void {
        const cards = container.querySelectorAll('.character-overview-card');
        cards.forEach(cardEl => {
            const nameEl = cardEl.querySelector('h4');
            if (!nameEl) return;
            const charName = nameEl.textContent || '';

            // Gather all alias keys for this character
            const keys = new Set<string>();
            keys.add(charName.toLowerCase());
            for (const [alias, canonical] of aliasMap) {
                if (canonical.toLowerCase() === charName.toLowerCase()) keys.add(alias);
            }

            // Sum plotgrid rows mentioning this character
            let pgRows = new Set<string>();
            for (const key of keys) {
                const rows = pgChars.get(key);
                if (rows) rows.forEach(r => pgRows.add(r));
            }

            if (pgRows.size > 0) {
                // Find the stats div and append plotgrid stat
                const statsDiv = cardEl.querySelector('.character-card-stats');
                if (statsDiv && !statsDiv.querySelector('.character-plotgrid-badge')) {
                    statsDiv.createSpan({ cls: 'character-stat-sep', text: '\u00b7' });
                    const badge = statsDiv.createSpan({ cls: 'character-plotgrid-badge' });
                    badge.textContent = t('{count} plotgrid', { count: pgRows.size });
                    badge.title = t('Mentioned in plotgrid rows: {rows}', { rows: [...pgRows].join(', ') });
                    badge.setCssStyles({ color: 'var(--text-accent)' });
                }
            }
        });
    }

    private renderOverviewCard(
        grid: HTMLElement,
        char: Character,
        sceneStats: Map<string, ScenePresenceStats>,
        aliasMap?: Map<string, string>,
        opts?: { lite?: boolean; tagCache?: { props: string[]; locations: string[] } },
    ): HTMLElement {
        const lite = !!opts?.lite;
        const card = grid.createDiv('character-overview-card');
        if (lite) card.addClass('is-lite');

        // Role badges — supports string / string[] / roles[] (issue #72)
        const roleList = getRoleList(char);
        if (roleList.length) {
            const wrap = card.createDiv('character-role-badges');
            for (const r of roleList) {
                const badge = wrap.createDiv('character-role-badge');
                badge.textContent = r;
                badge.addClass(this.roleClass(r));
            }
        }

        // Portrait / placeholder
        const portrait = card.createDiv('character-card-portrait');
        if (char.image) {
            const imgSrc = resolveImagePath(this.app, char.image);
            if (imgSrc) {
                const img = portrait.createEl('img', {
                    cls: 'character-portrait-img',
                    attr: { src: imgSrc, alt: char.name, loading: 'lazy', decoding: 'async' },
                });
                img.onerror = () => {
                    img.remove();
                    const ph = portrait.createDiv('character-portrait-placeholder');
                    obsidian.setIcon(ph, 'circle-user-round');
                };
            } else {
                const ph = portrait.createDiv('character-portrait-placeholder');
                obsidian.setIcon(ph, 'circle-user-round');
            }
        } else {
            const placeholder = portrait.createDiv('character-portrait-placeholder');
            obsidian.setIcon(placeholder, 'circle-user-round');
        }

        // Name
        card.createEl('h4', { text: char.name });

        // Short description snippet — per-character tagline field selector, with auto fallback
        const snippet = resolveCharacterCardSnippet(char);
        if (snippet) {
            card.createEl('p', { cls: 'character-card-snippet', text: snippet });
        }

        const { pov: povCount, present: presentCount } = this.lookupSceneStats(char.name, sceneStats, aliasMap);
        const total = povCount + presentCount;

        const stats = card.createDiv('character-card-stats');
        if (total > 0) {
            stats.createSpan({ text: `${povCount} ${t('POV')}` });
            stats.createSpan({ cls: 'character-stat-sep', text: '\u00b7' });
            stats.createSpan({ text: t('{count} scenes', { count: total }) });
        } else {
            stats.createSpan({ cls: 'character-stat-none', text: t('No scenes yet') });
        }

        // Completeness + tag chips are expensive at scale — skip in lite mode
        // (detail view still shows them).
        if (!lite) {
            const filled = CHARACTER_CATEGORIES.reduce((acc, cat) =>
                acc + cat.fields.filter(f => {
                    const val = char[f.key];
                    return val !== undefined && val !== null && val !== '';
                }).length, 0);
            const totalFields = CHARACTER_CATEGORIES.reduce((acc, cat) => acc + cat.fields.length, 0);
            const pct = Math.round((filled / totalFields) * 100);
            const completeness = card.createDiv('character-card-completeness');
            const bar = completeness.createDiv('character-completeness-bar');
            const fill = bar.createDiv('character-completeness-fill');
            fill.setCssStyles({ width: `${pct}%` });
            completeness.createSpan({ cls: 'character-completeness-label', text: t('{pct}% complete', { pct }) });

            const overrides = this.plugin.settings.tagTypeOverrides;
            const cached = opts?.tagCache;
            const charProps = cached?.props ?? extractCharacterProps(char, overrides);
            const charLocTags = cached?.locations ?? extractCharacterLocationTags(char, overrides);
            if (charLocTags.length > 0 || charProps.length > 0) {
                const propsRow = card.createDiv('character-card-props');
                charLocTags.forEach(p => {
                    const span = propsRow.createSpan({ cls: 'character-prop-tag character-loc-tag', text: `#${p}` });
                    if (overrides[p.toLowerCase()]) span.addClass('tag-overridden');
                    this.addTagContextMenu(span, p);
                });
                charProps.slice(0, 5).forEach(p => {
                    const span = propsRow.createSpan({ cls: 'character-prop-tag', text: `#${p}` });
                    if (overrides[p.toLowerCase()]) span.addClass('tag-overridden');
                    this.addTagContextMenu(span, p);
                });
                const totalTags = charLocTags.length + charProps.length;
                if (totalTags > 5 + charLocTags.length) {
                    propsRow.createSpan({ cls: 'character-prop-more', text: `+${charProps.length - 5}` });
                }
            }
        }

        card.addEventListener('click', () => {
            void this.openCharacterDetail(char.filePath);
        });

        // Right-click context menu — promote / demote between project and
        // series, and toggle book membership (series mode only).
        card.addEventListener('contextmenu', (e) => {
            e.preventDefault();
            this.showCharacterContextMenu(char, e);
        });

        return card;
    }

    /**
     * Open a character detail pane by file path (or basename fallback).
     * Reloads entities once if the in-memory map missed a just-created file.
     */
    private async openCharacterDetail(filePath: string): Promise<void> {
        const path = normalizePath(filePath || '');
        if (!path) return;
        if (this.selectedCharacter && normalizePath(this.selectedCharacter) !== path) {
            await this.flushPendingSave();
            this.editingDraft = null;
        }

        const basename = path.split('/').pop()?.replace(/\.md$/i, '') ?? '';
        let char =
            this.characterManager.getCharacter(path)
            || (basename ? this.characterManager.findByName(basename) : undefined);

        // Paint immediately when the card already has a manager entry (common path).
        // Only fall back to a full reload when the character is missing.
        if (char) {
            this.selectedCharacter = char.filePath;
            this.renderContentOnly();
            return;
        }

        this.selectedCharacter = path;
        this.renderContentOnly();
        try {
            await this.plugin.reloadEntities();
        } catch { /* project may not be ready */ }
        char =
            this.characterManager.getCharacter(path)
            || (basename ? this.characterManager.findByName(basename) : undefined);
        if (!char) {
            this.selectedCharacter = null;
            new Notice(t('Character not found in the active project.'));
            if (this.embedOptions) {
                this.embedOptions.onBack();
                return;
            }
            this.renderContentOnly();
            return;
        }
        this.selectedCharacter = char.filePath;
        this.renderContentOnly();
    }

    private renderUnlinkedCard(
        grid: HTMLElement,
        name: string,
        sceneStats: Map<string, ScenePresenceStats>,
        aliasMap?: Map<string, string>,
    ): HTMLElement {
        const card = grid.createDiv('character-overview-card character-unlinked');

        card.createEl('h4', { text: name });

        const { pov: povCount, present: presentCount } = this.lookupSceneStats(name, sceneStats, aliasMap);

        const stats = card.createDiv('character-card-stats');
        stats.createSpan({ text: `${povCount} ${t('POV')} \u00b7 ${t('{count} scenes', { count: povCount + presentCount })}` });

        const btnRow = card.createDiv('character-unlinked-actions');

        const createBtn = btnRow.createEl('button', { cls: 'character-create-profile-btn', text: t('Create Profile') });
        createBtn.addEventListener('click', async (e) => {
            e.stopPropagation();
            await this.createCharacterFromName(name);
        });

        const linkBtn = btnRow.createEl('button', { cls: 'character-link-btn', text: t('Link to\u2026') });
        linkBtn.addEventListener('click', (e) => {
            e.stopPropagation();
            this.promptLinkCharacter(name);
        });

        const ignoreBtn = btnRow.createEl('button', { cls: 'character-ignore-btn', text: t('Ignore') });
        ignoreBtn.addEventListener('click', async (e) => {
            e.stopPropagation();
            await this.ignoreCharacter(name);
        });

        return card;
    }

    /**
     * Prompt user to pick which existing character to link an alias to.
     */
    private promptLinkCharacter(aliasName: string): void {
        const characters = this.characterManager.getAllCharacters();
        if (characters.length === 0) {
            new Notice(t('No character profiles to link to. Create a profile first.'));
            return;
        }

        const modal = new LinkCharacterModal(this.app, aliasName, characters, async (canonical) => {
            this.plugin.settings.characterAliases[aliasName.toLowerCase()] = canonical;
            await this.plugin.saveSettings();
            // Rebuild lookups so the alias is immediately recognised
            this.plugin.linkScanner.invalidateAll();
            this.plugin.linkScanner.rebuildLookups(this.plugin.settings.characterAliases);
            new Notice(t('"{alias}" linked to {canonical}', { alias: aliasName, canonical }));
            if (this.rootContainer) this.renderView(this.rootContainer);
        });
        modal.open();
    }

    /**
     * Add a character name to the ignored list.
     */
    private async ignoreCharacter(name: string): Promise<void> {
        const lower = name.toLowerCase();
        if (!this.plugin.settings.ignoredCharacters.includes(lower)) {
            this.plugin.settings.ignoredCharacters.push(lower);
            await this.plugin.saveSettings();
        }
        new Notice(t('"{name}" ignored', { name }));
        if (this.rootContainer) this.renderView(this.rootContainer);
    }

    /**
     * Deduplicate unlinked names: when a first-name-only entry (e.g. "Micke")
     * and a full-name entry (e.g. "Micke Barr") both appear, keep only the
     * full name. The alias map is updated so "micke" → "Micke Barr", which
     * lets the scene-count logic aggregate both.
     */
    private deduplicateUnlinked(names: string[]): string[] {
        // Build a map: first-word (lowered) → list of full names that start with that word
        const byFirst = new Map<string, string[]>();
        for (const n of names) {
            const first = n.split(/\s+/)[0]?.toLowerCase();
            if (first) {
                if (!byFirst.has(first)) byFirst.set(first, []);
                byFirst.get(first)!.push(n);
            }
        }

        const toRemove = new Set<string>(); // lowered names to drop

        for (const [_firstLower, group] of byFirst) {
            if (group.length < 2) continue;
            // Separate single-word names from multi-word names
            const singles = group.filter(n => !n.includes(' '));
            const fulls = group.filter(n => n.includes(' '));
            if (singles.length > 0 && fulls.length === 1) {
                // Exactly one full name — merge all singles into it
                const canonical = fulls[0];
                for (const s of singles) {
                    toRemove.add(s.toLowerCase());
                    // Also register in the plugin settings alias map so
                    // LinkScanner and future renders benefit
                    this.plugin.settings.characterAliases[s.toLowerCase()] = canonical;
                }
                // Persist (fire-and-forget; next reload will have it)
                this.plugin.saveSettings();
            }
            // If there are multiple full names (rare), leave them alone —
            // the user can manually link/ignore.
        }

        return names.filter(n => !toRemove.has(n.toLowerCase()));
    }

    // ── Scene presence helper (frontmatter + LinkScanner) ──

    /**
     * Check if a character (identified by a set of lowercased aliases) is
     * present in a scene — frontmatter characters/pov by default.
     * Optional bodyScan consults LinkScanner (expensive on large libraries).
     */
    private isCharInScene(
        scene: Scene,
        charAliases: Set<string>,
        opts?: { bodyScan?: boolean },
    ): { isPov: boolean; isPresent: boolean } {
        const isPov = !!(scene.pov && charAliases.has(scene.pov.toLowerCase()));
        const fmPresent = scene.characters?.some(c => charAliases.has(c.toLowerCase())) ?? false;

        let scanPresent = false;
        if (opts?.bodyScan) {
            try {
                const scanResult = this.plugin.linkScanner?.getResult(scene.filePath);
                if (scanResult?.characters) {
                    scanPresent = scanResult.characters.some(c => charAliases.has(c.toLowerCase()));
                }
            } catch { /* scanner not ready */ }
        }

        return { isPov, isPresent: isPov || fmPresent || scanPresent };
    }

    // ── Character Detail ───────────────────────────────

    /** Re-render detail into the content pane (never wipe toolbar/tabs). */
    private rerenderCharacterDetail(): void {
        if (!this.selectedCharacter) return;
        const host = this.getContentHost() || this.rootContainer;
        if (host) this.renderCharacterDetail(host);
    }

    private renderCharacterDetail(container: HTMLElement): void {
        container.empty();
        container.removeClass('character-detail--board', 'character-detail--vertical');
        const profileOrientation = getLibraryProfileOrientation(this.plugin.settings, 'character');
        const horizontalProfile = profileOrientation === 'horizontal';
        container.addClass(horizontalProfile ? 'character-detail--board' : 'character-detail--vertical');
        const selectedPath = this.selectedCharacter ? normalizePath(this.selectedCharacter) : '';
        const basename = selectedPath.split('/').pop()?.replace(/\.md$/i, '') ?? '';
        let character =
            (selectedPath ? this.characterManager.getCharacter(selectedPath) : undefined)
            || (basename ? this.characterManager.findByName(basename) : undefined);
        if (!character) {
            this.selectedCharacter = null;
            if (this.embedOptions) {
                this.embedOptions.onBack();
                return;
            }
            this.renderCharacterOverview(container);
            return;
        }
        // Keep selection keyed to the canonical path from the manager.
        // Narrow to a const so click handlers don't re-widen to Character | undefined.
        const selected = character;
        this.selectedCharacter = selected.filePath;

        const reuseDraft = this.editingDraft
            && normalizePath(this.editingDraft.filePath) === normalizePath(selected.filePath);
        const draft: Character = reuseDraft
            ? this.editingDraft!
            : { ...selected, custom: { ...(selected.custom || {}) }, universalFields: { ...(selected.universalFields || {}) } };
        this.editingDraft = draft;
        if (!reuseDraft) {
            // Snapshot once per detail editing session, not on every internal re-render.
            this.undoSnapshot = { ...selected, custom: { ...(selected.custom || {}) }, universalFields: { ...(selected.universalFields || {}) } };
            this.originalCharacterName = selected.name;
            this._lastSavedRelations = normalizeCharacterRelations(selected.relations).map(r => ({ ...r }));
        }

        // Horizontal mode shows every section as a column — expand built-ins / custom.
        if (horizontalProfile) {
            for (const cat of CHARACTER_CATEGORIES) this.collapsedSections.delete(cat.title);
            this.collapsedSections.delete('Custom Fields');
            for (const key of [...this.collapsedSections]) {
                if (key.startsWith('custom-section::character::')) this.collapsedSections.delete(key);
            }
        }

        // Back + actions
        const header = container.createDiv('character-detail-header');
        const backBtn = header.createEl('span', { cls: 'codex-nav-back-link' });
        const backIcon = backBtn.createSpan();
        obsidian.setIcon(backIcon, 'circle-arrow-left');
        backBtn.createSpan({ text: this.embedOptions ? t('Back to library') : t(' All Characters') });
        backBtn.addEventListener('click', async () => {
            await this.flushPendingSave();
            this.editingDraft = null;
            this.selectedCharacter = null;
            if (this.embedOptions) {
                this.embedOptions.onBack();
                return;
            }
            this.renderContentOnly();
        });

        const headerRight = header.createDiv('character-detail-header-right');

        renderLibraryProfileOrientationToggle(headerRight, {
            settings: this.plugin.settings,
            categoryKey: 'character',
            save: () => this.plugin.saveSettings(),
            beforeChange: () => this.flushPendingSave(),
            onChanged: () => this.rerenderCharacterDetail(),
        });

        mountLibraryEntityBoardAction(headerRight, {
            plugin: this.plugin,
            notePath: selected.filePath,
            name: draft.name || selected.name,
            image: draft.image,
            onCreated: () => this.rerenderCharacterDetail(),
        });

        const openBtn = headerRight.createEl('button', {
            cls: 'codex-detail-action-btn',
            attr: { 'aria-label': t('Open character file') },
        });
        const openIcon = openBtn.createSpan();
        obsidian.setIcon(openIcon, 'file');
        attachTooltip(openBtn, t('Open character file'));
        openBtn.addEventListener('click', () => this.openCharacterFile(selected));

        const deleteBtn = headerRight.createEl('button', {
            cls: 'codex-detail-action-btn codex-detail-delete-btn',
            attr: { 'aria-label': t('Delete character') },
        });
        const deleteIcon = deleteBtn.createSpan();
        obsidian.setIcon(deleteIcon, 'trash');
        attachTooltip(deleteBtn, t('Delete character'));
        deleteBtn.addEventListener('click', () => this.confirmDeleteCharacter(selected));

        // Compact identity strip (portrait lives here; gallery keeps full images)
        const hero = container.createDiv('character-detail-hero');
        const portraitArea = hero.createDiv('character-detail-hero-portrait');
        const renderPortrait = () => {
            portraitArea.empty();
            if (draft.image) {
                const imgSrc = resolveImagePath(this.app, draft.image);
                if (imgSrc) {
                    const img = portraitArea.createEl('img', {
                        cls: 'character-detail-hero-portrait-img',
                        attr: { src: imgSrc, alt: draft.name },
                    });
                    img.onerror = () => {
                        img.remove();
                        const ph = portraitArea.createDiv('character-detail-hero-portrait-placeholder');
                        obsidian.setIcon(ph, 'circle-user-round');
                    };
                } else {
                    const ph = portraitArea.createDiv('character-detail-hero-portrait-placeholder');
                    obsidian.setIcon(ph, 'circle-user-round');
                }
            } else {
                const ph = portraitArea.createDiv('character-detail-hero-portrait-placeholder');
                obsidian.setIcon(ph, 'circle-user-round');
            }
            const changeLabel = portraitArea.createDiv('character-portrait-change-label');
            changeLabel.textContent = draft.image ? t('Change image') : t('Add image');
        };
        renderPortrait();
        portraitArea.addEventListener('click', () => {
            this.pickImage(draft.image).then(async (picked) => {
                if (picked !== undefined) {
                    draft.image = picked || undefined;
                    await this.characterManager.saveCharacter(draft);
                    renderPortrait();
                }
            });
        });

        const heroMeta = hero.createDiv('character-detail-hero-meta');
        heroMeta.createEl('h2', { cls: 'character-detail-hero-name', text: draft.name });
        const heroSub = heroMeta.createDiv('character-detail-hero-sub');
        const roleText = getRoleDisplay(draft.role);
        if (roleText) heroSub.createSpan({ cls: 'character-detail-hero-chip', text: roleText });
        const cardSnippet = resolveCharacterCardSnippet(draft);
        if (cardSnippet && cardSnippet !== roleText) {
            const snippetText = cardSnippet.replace(/\s+/g, ' ').trim();
            if (snippetText) {
                heroSub.createSpan({
                    cls: 'character-detail-hero-chip is-muted character-detail-hero-tagline',
                    text: snippetText.length > 64 ? `${snippetText.slice(0, 64)}…` : snippetText,
                });
            }
        } else {
            if (draft.occupation) {
                heroSub.createSpan({ cls: 'character-detail-hero-chip is-muted', text: draft.occupation });
            }
            if (draft.residency) {
                const residencySnippet = coerceString(draft.residency).replace(/\s+/g, ' ').trim();
                if (residencySnippet) {
                    heroSub.createSpan({
                        cls: 'character-detail-hero-chip is-muted',
                        text: residencySnippet.length > 48 ? `${residencySnippet.slice(0, 48)}…` : residencySnippet,
                    });
                }
            }
        }

        // Layout: horizontal board columns, or stacked sections with side rail.
        const layout = container.createDiv(
            `character-detail-layout ${horizontalProfile ? 'character-detail-layout--board' : 'character-detail-layout--vertical'}`,
        );
        const formPanel = layout.createDiv(
            `character-detail-form${horizontalProfile ? ' character-detail-board-track' : ' character-detail-vertical-track'}`,
        );
        const sidePanel = layout.createDiv('character-detail-side');
        const commitFocusedField = (event: Event) => {
            const tagName = (event.target as { tagName?: string } | null)?.tagName?.toLowerCase();
            if (tagName !== 'input' && tagName !== 'textarea' && tagName !== 'select') return;
            window.setTimeout(() => { void this.flushPendingSave(); }, 0);
        };
        layout.addEventListener('change', commitFocusedField);
        layout.addEventListener('focusout', commitFocusedField);

        // Wheel on the board gutter / headers pans columns; column bodies keep vertical scroll.
        // Shift+wheel always pans horizontally.
        if (horizontalProfile) {
            formPanel.addEventListener('wheel', (e) => {
                if (e.deltaY === 0) return;
                if (formPanel.scrollWidth <= formPanel.clientWidth + 1) return;
                const inColumnBody = !!(e.target as HTMLElement | null)?.closest?.('.character-section-body');
                if (inColumnBody && !e.shiftKey) return;
                e.preventDefault();
                formPanel.scrollLeft += e.deltaY + e.deltaX;
            }, { passive: false });
        }

        // ── Form sections as board columns (+ interleaved custom sections) ──
        // Eagerly fill only the first columns; remaining column fields load when
        // scrolled into view so open-detail stays responsive.
        const customHost = this.buildCustomSectionsHost(draft);
        renderCustomSectionsAtSlot(formPanel, customHost, 0);
        for (let i = 0; i < CHARACTER_CATEGORIES.length; i++) {
            const category = CHARACTER_CATEGORIES[i];
            if (isBuiltinSectionRemoved(this.plugin.settings, 'character', category.title)) {
                renderCustomSectionsAtSlot(formPanel, customHost, i + 1);
                continue;
            }
            this.renderCategory(formPanel, category, draft, {
                board: horizontalProfile,
                eager: horizontalProfile ? i < 2 : true,
            });
            renderCustomSectionsAtSlot(formPanel, customHost, i + 1);
        }

        this.renderCustomFields(formPanel, draft, { board: horizontalProfile });
        renderAddCustomSectionButton(formPanel, customHost);
        renderRemovedBuiltinSectionsToggle(formPanel, {
            settings: this.plugin.settings,
            categoryKey: 'character',
            sections: CHARACTER_CATEGORIES.map(c => ({ title: c.title, fields: c.fields })),
            save: () => this.plugin.saveSettings(),
            onChanged: () => {
                if (this.selectedCharacter && this.rootContainer) this.rerenderCharacterDetail();
            },
        });

        // ── Side panel: gallery first; defer scene/refs until after first paint ──
        this.renderGallery(sidePanel, draft);
        const deferredHost = sidePanel.createDiv('character-detail-side-deferred');
        const sideGen = this._detailSideGen;
        const selectedPathForSide = selected.filePath;
        const characterName = selected.name;
        // setTimeout (not rAF): let the browser paint header + first columns first.
        window.setTimeout(() => {
            if (sideGen !== this._detailSideGen) return;
            if (this.selectedCharacter !== selectedPathForSide) return;
            deferredHost.empty();
            this.renderScenePanel(deferredHost, characterName);
            window.setTimeout(() => {
                if (sideGen !== this._detailSideGen) return;
                if (this.selectedCharacter !== selectedPathForSide) return;
                this.renderLinkedAliasesPanel(deferredHost, characterName);
                if (!this.embedOptions?.hideVaultReferences) {
                    this.renderReferencesPanel(deferredHost, characterName);
                }
                this.renderNotesSection(deferredHost, draft);
            }, 0);
        }, 0);
    }

    private renderCategory(
        parent: HTMLElement,
        category: { title: string; icon: string; fields: CharacterFieldDef[] },
        draft: Character,
        opts?: { board?: boolean; eager?: boolean },
    ): void {
        const board = !!opts?.board;
        const eager = !!opts?.eager;
        const section = parent.createDiv('character-section');
        if (board) section.addClass('character-board-column');
        const isCollapsed = board ? false : this.collapsedSections.has(category.title);

        // Section header (collapsible in stacked mode; sticky title in board mode)
        const sectionHeader = section.createDiv('character-section-header');
        const chevron = sectionHeader.createSpan('character-section-chevron');
        if (board) chevron.addClass('is-hidden');
        obsidian.setIcon(chevron, isCollapsed ? 'chevron-right' : 'chevron-down');
        const icon = sectionHeader.createSpan('character-section-icon');
        obsidian.setIcon(icon, category.icon);
        sectionHeader.createSpan({ text: t(category.title) });

        attachBuiltinSectionRemoveControl(sectionHeader, {
            app: this.app,
            settings: this.plugin.settings,
            categoryKey: 'character',
            sectionTitle: category.title,
            sectionFields: category.fields,
            save: () => this.plugin.saveSettings(),
            onChanged: () => {
                if (this.selectedCharacter && this.rootContainer) this.rerenderCharacterDetail();
            },
        });

        // ── '+' button to add a universal field to this section ──
        const addFieldBtn = sectionHeader.createEl('button', {
            cls: 'character-section-add-field-btn',
            attr: { title: t('Add universal field to this section'), 'aria-label': t('Add universal field') },
        });
        obsidian.setIcon(addFieldBtn, 'plus');
        addFieldBtn.addEventListener('click', (e) => {
            e.stopPropagation(); // Don't toggle collapse
            const existingSiblings = this.plugin.fieldTemplates
                .getBySection(category.title, 'character')
                .map(t => ({ id: t.id, label: t.label }));
            // Snapshot the current built-in keys so moveAfter can resolve the
            // merged order even before the new field is rendered (issue #197).
            const builtInKeysForAdd = filterRemovedBuiltinFields(
                category.fields,
                this.plugin.settings,
                'character',
            )
                .filter(f => !getHiddenFieldKeys(this.plugin.settings, 'character').includes(f.key))
                .map(f => f.key);
            const modal = new AddFieldModal(
                this.app,
                category.title,
                null,
                async (template, positionAfterId) => {
                    template.category = 'character';
                    await this.plugin.fieldTemplates.add(template);
                    if (positionAfterId !== undefined) {
                        await this.plugin.fieldTemplates.moveAfter(
                            category.title, 'character', builtInKeysForAdd,
                            template.id, positionAfterId,
                        );
                    }
                    // Re-render the detail view to show the new field
                    this.rerenderCharacterDetail();
                },
                undefined,
                undefined,
                existingSiblings,
            );
            modal.open();
        });

        const sectionBody = section.createDiv('character-section-body');
        if (isCollapsed) sectionBody.setCssStyles({ display: 'none' });

        // Lazy-build field DOM only when the section is (or becomes) expanded.
        let bodyBuilt = false;
        const ensureBody = () => {
            if (bodyBuilt) return;
            bodyBuilt = true;

            // Built-in fields (skip removed + hidden ones)
            const sectionFields = filterRemovedBuiltinFields(category.fields, this.plugin.settings, 'character');
            const hiddenKeys = getHiddenFieldKeys(this.plugin.settings, 'character');
            const visibleFields = sectionFields.filter(f => !hiddenKeys.includes(f.key));
            const hiddenFieldsInCat = sectionFields.filter(f => hiddenKeys.includes(f.key));

            // Render fields in user-defined merged order (built-in + universal).
            const universalFields = this.plugin.fieldTemplates.getBySection(category.title, 'character');
            const fieldMap = new Map<string, CharacterFieldDef>(visibleFields.map(f => [String(f.key), f]));
            const tplMap = new Map(universalFields.map(tpl => [tpl.id, tpl]));
            const builtInKeys = visibleFields.map(f => String(f.key));
            const merged = this.plugin.fieldTemplates.getMergedOrder(category.title, 'character', builtInKeys);
            for (const entry of merged) {
                if (entry.kind === 'builtin') {
                    const f = fieldMap.get(entry.key);
                    if (f) this.renderField(sectionBody, f, draft, category.title, builtInKeys);
                } else {
                    const tplEntry = tplMap.get(entry.key);
                    if (tplEntry) this.renderUniversalField(sectionBody, tplEntry, draft, builtInKeys);
                }
            }

            // Show toggle for hidden fields
            if (hiddenFieldsInCat.length > 0) {
                const toggleEl = sectionBody.createDiv('hidden-fields-toggle');
                toggleEl.createEl('a', {
                    text: hiddenFieldsInCat.length > 1
                        ? t('Show {count} hidden fields', { count: hiddenFieldsInCat.length })
                        : t('Show {count} hidden field', { count: hiddenFieldsInCat.length }),
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
                        ? (hiddenFieldsInCat.length > 1
                            ? t('Hide {count} hidden fields', { count: hiddenFieldsInCat.length })
                            : t('Hide {count} hidden field', { count: hiddenFieldsInCat.length }))
                        : (hiddenFieldsInCat.length > 1
                            ? t('Show {count} hidden fields', { count: hiddenFieldsInCat.length })
                            : t('Show {count} hidden field', { count: hiddenFieldsInCat.length }));
                });
            }

            renderRemovedBuiltinFieldsToggle(sectionBody, {
                settings: this.plugin.settings,
                categoryKey: 'character',
                sectionFields: category.fields,
                save: () => this.plugin.saveSettings(),
                onChanged: () => {
                    if (this.selectedCharacter && this.rootContainer) this.rerenderCharacterDetail();
                },
            });
        };

        if (!board) {
            if (!isCollapsed) ensureBody();
            sectionHeader.addEventListener('click', (e) => {
                // Ignore clicks on the add-field button
                if ((e.target as HTMLElement).closest('.character-section-add-field-btn')) return;
                if ((e.target as HTMLElement).closest('.codex-section-actions, .builtin-section-remove-btn')) return;
                if (this.collapsedSections.has(category.title)) {
                    this.collapsedSections.delete(category.title);
                    ensureBody();
                    sectionBody.setCssStyles({ display: '' });
                    obsidian.setIcon(chevron, 'chevron-down');
                } else {
                    this.collapsedSections.add(category.title);
                    sectionBody.setCssStyles({ display: 'none' });
                    obsidian.setIcon(chevron, 'chevron-right');
                }
            });
            return;
        }

        // Board mode: build field DOM only for eager (visible) columns, or when
        // the user scrolls a column near the viewport.
        if (eager) {
            ensureBody();
            return;
        }

        const track = parent.closest('.character-detail-board-track') as HTMLElement | null;
        if (typeof IntersectionObserver === 'undefined' || !track) {
            ensureBody();
            return;
        }

        const observer = new IntersectionObserver(
            (entries) => {
                for (const entry of entries) {
                    if (!entry.isIntersecting) continue;
                    ensureBody();
                    observer.disconnect();
                    const idx = this._detailBodyObservers.indexOf(observer);
                    if (idx >= 0) this._detailBodyObservers.splice(idx, 1);
                    break;
                }
            },
            { root: track, rootMargin: '120px', threshold: 0.01 },
        );
        this._detailBodyObservers.push(observer);
        observer.observe(section);
        // If already in view (e.g. wide screens), build on the next frame.
        window.requestAnimationFrame(() => {
            if (bodyBuilt) return;
            const tr = track.getBoundingClientRect();
            const sr = section.getBoundingClientRect();
            if (sr.left < tr.right + 120 && sr.right > tr.left - 120) {
                ensureBody();
                observer.disconnect();
                const idx = this._detailBodyObservers.indexOf(observer);
                if (idx >= 0) this._detailBodyObservers.splice(idx, 1);
            }
        });
    }

    private renderField(parent: HTMLElement, field: CharacterFieldDef, draft: Character, sectionTitle?: string, builtInKeys?: string[]): void {
        const row = parent.createDiv('character-field-row');
        const labelEl = row.createEl('label', { cls: 'character-field-label', text: t(field.label) });

        // Up/down chevrons — reorder this built-in field within the section.
        if (sectionTitle && builtInKeys) {
            this.addBuiltInMoveChevrons(labelEl, sectionTitle, 'character', builtInKeys, field.key);
        }

        // Hide / remove controls for built-in fields (name is always visible + undeletable)
        attachBuiltinFieldVisibilityControls(labelEl, {
            app: this.app,
            settings: this.plugin.settings,
            categoryKey: 'character',
            fieldKey: field.key,
            fieldLabel: field.label,
            save: () => this.plugin.saveSettings(),
            onChanged: () => {
                if (this.selectedCharacter && this.rootContainer) this.rerenderCharacterDetail();
            },
        });

        // Coerce array shapes (e.g. role: string[]) to a comma-separated string
        // for input rendering. Issue #72 Tier 1.
        const rawValue: unknown = (draft as unknown as Record<string, unknown>)[field.key];
        let value: string = coerceString(rawValue);
        if (Array.isArray(rawValue)) value = rawValue.map(v => coerceString(v).trim()).filter(Boolean).join(', ');

        if (field.key === 'relations') {
            this.renderRelationsField(row, draft);
            return;
        }

        if (field.key === 'tagline') {
            // Tagline is a dropdown that picks which other field to show on the card
            const select = row.createEl('select', { cls: 'character-field-input dropdown' });
            select.createEl('option', {
                text: t('Auto (personality → occupation → role)'),
                attr: { value: '' },
            });
            const taglineOptions: { key: string; label: string }[] = [];
            for (const cat of CHARACTER_CATEGORIES) {
                for (const f of cat.fields) {
                    if (!CHARACTER_TAGLINE_FIELD_KEYS.has(String(f.key))) continue;
                    taglineOptions.push({ key: String(f.key), label: f.label });
                }
            }
            for (const opt of taglineOptions) {
                select.createEl('option', { text: t(opt.label), attr: { value: opt.key } });
            }
            // Preserve legacy free-text taglines (Scrivener synopsis) so they stay selectable.
            if (value && !CHARACTER_TAGLINE_FIELD_KEYS.has(value)) {
                select.createEl('option', {
                    text: t('Custom: {text}', { text: value.length > 40 ? `${value.slice(0, 40)}…` : value }),
                    attr: { value },
                });
            }
            select.value = value;
            select.addEventListener('change', () => {
                const next = select.value;
                draft.tagline = next || undefined;
                this.scheduleSave(draft);
            });
            return;
        }

        if (field.key === 'role') {
            // Role accepts a single value or a comma-separated list of values
            // (issue #72 Tier 1). Rendered as a text input with a datalist of
            // suggestions so the user can pick or type freely (e.g.
            // "Mentor, Love Interest, Antagonist").
            const listId = `character-role-list-${Date.now()}-${Math.random().toString(36).slice(2)}`;
            const input = row.createEl('input', {
                cls: 'character-field-input',
                type: 'text',
                attr: { placeholder: field.placeholder ? t(field.placeholder) : '', list: listId },
            });
            input.value = value;
            const datalist = row.createEl('datalist', { attr: { id: listId } });
            for (const r of CHARACTER_ROLES) {
                datalist.createEl('option', { attr: { value: r } });
            }
            input.addEventListener('input', () => {
                const raw = input.value;
                // Persist as array when comma-separated, else single string
                if (raw.includes(',')) {
                    (draft as unknown as Record<string, unknown>)[field.key] = raw
                        .split(',')
                        .map(s => s.trim())
                        .filter(Boolean);
                } else {
                    (draft as unknown as Record<string, unknown>)[field.key] = raw;
                }
                this.scheduleSave(draft);
            });

            // Issue #72 Tier 2 — role history editor (repeating rows).
            // Renders below the simple role input; only rows the user has
            // explicitly added are persisted to the `roles:` YAML array.
            this.renderRoleHistoryEditor(row, draft);
        } else if (field.multiline) {
            const textarea = row.createEl('textarea', {
                cls: 'character-field-textarea',
                attr: { placeholder: field.placeholder ? t(field.placeholder) : '', rows: '2' },
            });
            textarea.value = value;
            // Auto-grow: fit content, shrink back when empty
            const autoGrow = () => {
                textarea.setCssStyles({ height: 'auto' });
                const scrollH = textarea.scrollHeight;
                const minH = 48; // ~2 rows
                textarea.setCssStyles({ height: Math.max(scrollH, minH) + 'px' });
            };
            // Initial sizing after paint
            window.setTimeout(autoGrow, 0);
            textarea.addEventListener('input', () => {
                (draft as unknown as Record<string, unknown>)[field.key] = textarea.value;
                this.scheduleSave(draft);
                autoGrow();
            });
        } else {
            const input = row.createEl('input', {
                cls: 'character-field-input',
                type: 'text',
                attr: { placeholder: field.placeholder ? t(field.placeholder) : '' },
            });
            input.value = value;
            input.addEventListener('input', () => {
                (draft as unknown as Record<string, unknown>)[field.key] = input.value;
                this.scheduleSave(draft);
            });

            // ── Cascade rename: check when leaving the Name field ──
            if (field.key === 'name') {
                input.addEventListener('blur', () => {
                    this.checkCharacterRename(draft, input);
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
            if (this.selectedCharacter && this.rootContainer) this.rerenderCharacterDetail();
        });

        const downBtn = labelEl.createEl('span', {
            cls: 'field-move-btn',
            attr: { title: t('Move field down'), 'aria-label': t('Move field down') },
        });
        obsidian.setIcon(downBtn, 'chevron-down');
        downBtn.addEventListener('click', async (e) => {
            e.stopPropagation();
            await this.plugin.fieldTemplates.moveEntryDown(section, category, builtInKeys, 'builtin', fieldKey);
            if (this.selectedCharacter && this.rootContainer) this.rerenderCharacterDetail();
        });
    }

    /**
     * Render a single universal (template-defined) field inside a section.
     * Values are stored in `draft.universalFields[template.id]`.
     */
    private renderUniversalField(
        parent: HTMLElement,
        tpl: UniversalFieldTemplate,
        draft: Character,
        builtInKeys?: string[],
    ): void {
        if (!draft.universalFields) draft.universalFields = {};
        const value = (draft.universalFields[tpl.id] ?? '') as string;

        const row = parent.createDiv('character-field-row character-universal-field-row');

        // Label with an edit icon
        const labelWrap = row.createDiv('character-universal-label-wrap');
        labelWrap.createEl('label', { cls: 'character-field-label', text: tpl.label });

        const editBtn = labelWrap.createEl('span', {
            cls: 'character-universal-edit-btn',
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
                    if (this.selectedCharacter && this.rootContainer) {
                        this.rerenderCharacterDetail();
                    }
                },
                async () => {
                    await this.plugin.fieldTemplates.remove(tpl.id);
                    // Optionally clean up universalFields[tpl.id] from all characters
                    if (this.selectedCharacter && this.rootContainer) {
                        this.rerenderCharacterDetail();
                    }
                },
                undefined,
                siblings,
            );
            modal.open();
        });

        // Issue #92 — up/down move buttons (revealed on hover)
        const moveUpBtn = labelWrap.createEl('span', {
            cls: 'character-universal-move-btn',
            attr: { title: t('Move field up'), 'aria-label': t('Move field up') },
        });
        obsidian.setIcon(moveUpBtn, 'chevron-up');
        moveUpBtn.addEventListener('click', async (e) => {
            e.stopPropagation();
            await this.plugin.fieldTemplates.moveEntryUp(
                tpl.section, tpl.category, builtInKeys ?? [], 'universal', tpl.id,
            );
            if (this.selectedCharacter && this.rootContainer) this.rerenderCharacterDetail();
        });

        const moveDownBtn = labelWrap.createEl('span', {
            cls: 'character-universal-move-btn',
            attr: { title: t('Move field down'), 'aria-label': t('Move field down') },
        });
        obsidian.setIcon(moveDownBtn, 'chevron-down');
        moveDownBtn.addEventListener('click', async (e) => {
            e.stopPropagation();
            await this.plugin.fieldTemplates.moveEntryDown(
                tpl.section, tpl.category, builtInKeys ?? [], 'universal', tpl.id,
            );
            if (this.selectedCharacter && this.rootContainer) this.rerenderCharacterDetail();
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
            const select = row.createEl('select', { cls: 'character-field-input dropdown' });
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
            // If current value isn't in the list, add it
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
                cls: 'character-field-textarea',
                attr: { placeholder: tpl.placeholder || '', rows: '2' },
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
            const wrap = row.createDiv('character-field-checkbox-wrap');
            const cb = wrap.createEl('input', {
                cls: 'character-field-checkbox',
                type: 'checkbox',
            });
            cb.checked = !!checked;
            cb.addEventListener('change', () => {
                draft.universalFields![tpl.id] = cb.checked ? 'true' : 'false';
                this.scheduleSave(draft);
            });
        } else {
            // Default: single-line text
            const input = row.createEl('input', {
                cls: 'character-field-input',
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

    /**
     * Issue #72 Tier 2 — repeating-row editor for the structured role
     * history. Each row binds to one entry in `draft.roles`. Rows can be
     * added or removed; empty rows are stripped on save.
     */
    private renderRoleHistoryEditor(row: HTMLElement, draft: Character): void {
        const container = row.createDiv('character-role-history');

        const header = container.createDiv('character-role-history-header');
        header.createSpan({ cls: 'character-role-history-title', text: t('Role history (optional)') });
        header.createSpan({
            cls: 'character-role-history-hint',
            text: t('Track role changes across scenes, plotlines and projects.'),
        });

        const list = container.createDiv('character-role-history-list');

        const persist = () => {
            const cleaned: RoleEntry[] = [];
            for (const e of (draft.roles || [])) {
                const role = String(e.role || '').trim();
                if (!role) continue;
                const out: RoleEntry = { role };
                if (e.from && e.from.trim()) out.from = e.from.trim();
                if (e.plotline && e.plotline.trim()) out.plotline = e.plotline.trim();
                if (e.book && e.book.trim()) out.book = e.book.trim();
                cleaned.push(out);
            }
            draft.roles = cleaned;
            this.scheduleSave(draft);
        };

        const renderRows = () => {
            list.empty();
            const entries = draft.roles || [];
            entries.forEach((entry, idx) => {
                const r = list.createDiv('character-role-history-row');

                const roleListId = `character-role-history-list-${Date.now()}-${idx}-${Math.random().toString(36).slice(2)}`;

                const roleInput = r.createEl('input', {
                    cls: 'character-role-history-input character-role-history-role',
                    type: 'text',
                    attr: { placeholder: t('role'), list: roleListId },
                });
                roleInput.value = entry.role || '';
                const dl = r.createEl('datalist', { attr: { id: roleListId } });
                for (const opt of CHARACTER_ROLES) dl.createEl('option', { attr: { value: opt } });
                roleInput.addEventListener('input', () => {
                    entry.role = roleInput.value;
                    persist();
                });

                const fromInput = r.createEl('input', {
                    cls: 'character-role-history-input character-role-history-from',
                    type: 'text',
                    attr: { placeholder: t('from (scene or [[wikilink]])') },
                });
                fromInput.value = entry.from || '';
                fromInput.addEventListener('input', () => {
                    entry.from = fromInput.value;
                    persist();
                });

                const plotInput = r.createEl('input', {
                    cls: 'character-role-history-input character-role-history-plotline',
                    type: 'text',
                    attr: { placeholder: t('plotline') },
                });
                plotInput.value = entry.plotline || '';
                plotInput.addEventListener('input', () => {
                    entry.plotline = plotInput.value;
                    persist();
                });

                const bookInput = r.createEl('input', {
                    cls: 'character-role-history-input character-role-history-book',
                    type: 'text',
                    attr: { placeholder: t('project label') },
                });
                bookInput.value = entry.book || '';
                bookInput.addEventListener('input', () => {
                    entry.book = bookInput.value;
                    persist();
                });

                const removeBtn = r.createEl('button', {
                    cls: 'character-role-history-remove',
                    text: '×',
                    attr: { title: t('Remove this entry'), type: 'button' },
                });
                removeBtn.addEventListener('click', () => {
                    (draft.roles || []).splice(idx, 1);
                    persist();
                    renderRows();
                });
            });

            if (!entries.length) {
                list.createDiv({
                    cls: 'character-role-history-empty',
                    text: t('No role history entries yet.'),
                });
            }
        };

        const addBtn = container.createEl('button', {
            cls: 'character-role-history-add',
            text: t('+ Add role entry'),
            attr: { type: 'button' },
        });
        addBtn.addEventListener('click', () => {
            if (!draft.roles) draft.roles = [];
            draft.roles.push({ role: '' });
            renderRows();
            // Focus the role input on the new last row
            const inputs = list.querySelectorAll('.character-role-history-role');
            const last = inputs[inputs.length - 1] as HTMLInputElement | undefined;
            last?.focus();
        });

        renderRows();
    }

    private renderRelationsField(row: HTMLElement, draft: Character): void {
        const container = row.createDiv('character-tag-field relation-builder-field');
        const list = container.createDiv('character-tag-list relation-builder-list');
        const addRow = container.createDiv('character-tag-add-row relation-builder-add-row');

        const aliasMap = this.characterManager.buildAliasMap(this.plugin.settings.characterAliases);
        const resolveAlias = (n: string): string => aliasMap.get(n.toLowerCase()) || n;

        const fileCharacters = this.characterManager.getAllCharacters().map(c => c.name);
        const sceneCharacters = this.sceneManager.queryService.getAllCharacters();
        const mergedNames = Array.from(new Set([...fileCharacters, ...sceneCharacters].map(resolveAlias)))
            .filter(n => n !== draft.name)
            .sort((a, b) => a.toLowerCase().localeCompare(b.toLowerCase()));

        const relations: CharacterRelation[] = normalizeCharacterRelations(draft.relations);
        const NEW_CUSTOM_TYPE_VALUE = '__custom_new__';
        const relationSeedLang = seedUiLanguage(this.plugin.app);
        void ensureSeededCharacterRelationTypes(this.plugin, this.characterManager.getAllCharacters());
        const sharedStyles = mergeCharacterRelationTypes(
            this.plugin.settings.storyGraphCharacterRelationTypes,
            this.characterManager.getAllCharacters(),
            relationSeedLang,
        );
        const sharedCustoms = listCustomCharacterRelationTypes(sharedStyles);
        const sharedCustomIds = new Set(sharedCustoms.map(s => s.id));

        const inferCategoryFromType = (type: string): CharacterRelationCategory => {
            for (const category of RELATION_CATEGORIES) {
                const options = RELATION_TYPES_BY_CATEGORY[category.value];
                if (options.includes(type)) return category.value;
            }
            const shared = sharedCustoms.find(s => s.id === type || s.id === type.toLowerCase());
            if (shared) return shared.category || 'custom';
            return 'custom';
        };

        const persistSharedCustomType = async (typeId: string, label: string, category: CharacterRelationCategory) => {
            const next = upsertCustomCharacterRelationType(
                this.plugin.settings.storyGraphCharacterRelationTypes,
                { id: typeId, label, category },
                relationSeedLang,
            );
            this.plugin.settings.storyGraphCharacterRelationTypes = next;
            await this.plugin.saveSettings();
        };

        const buildTypeOptions = (select: HTMLSelectElement, currentType?: string) => {
            select.empty();
            for (const category of RELATION_CATEGORIES) {
                const types = RELATION_TYPES_BY_CATEGORY[category.value];
                if (types.length === 0) continue;
                const group = activeDocument.createElement('optgroup');
                group.label = t(category.label);
                for (const type of types) {
                    const opt = activeDocument.createElement('option');
                    opt.value = type;
                    opt.text = t(type);
                    if (currentType === type) opt.selected = true;
                    group.appendChild(opt);
                }
                select.appendChild(group);
            }

            const customGroup = activeDocument.createElement('optgroup');
            customGroup.label = t('Custom');
            for (const custom of sharedCustoms) {
                const opt = activeDocument.createElement('option');
                opt.value = custom.id;
                opt.text = custom.label;
                if (currentType === custom.id || currentType === custom.label) opt.selected = true;
                customGroup.appendChild(opt);
            }
            const createOpt = activeDocument.createElement('option');
            createOpt.value = NEW_CUSTOM_TYPE_VALUE;
            createOpt.text = t('New');
            customGroup.appendChild(createOpt);
            select.appendChild(customGroup);

            if (currentType && !select.value) {
                // Unknown custom still in use on this note — keep it selectable.
                const orphan = activeDocument.createElement('option');
                orphan.value = currentType;
                orphan.text = currentType;
                orphan.selected = true;
                customGroup.appendChild(orphan);
            }

            if (!select.value) {
                const fallback = RELATION_TYPES_BY_CATEGORY.family[0] || 'sibling';
                select.value = fallback;
            }
        };

        let dragIndex: number | null = null;

        const renderRows = () => {
            list.empty();

            for (let index = 0; index < relations.length; index++) {
                const relation = relations[index];
                const relRow = list.createDiv('character-field-row relation-builder-item');
                relRow.draggable = false;
                const inlineRow = relRow.createDiv('relation-builder-inline-row');
                const typeSelect = inlineRow.createEl('select', { cls: 'character-field-input dropdown relation-builder-type' });
                buildTypeOptions(typeSelect, relation.type);
                const customTypeInput = inlineRow.createEl('input', {
                    cls: 'character-field-input relation-builder-type relation-builder-custom-input',
                    type: 'text',
                    attr: { placeholder: t('Custom relation type (e.g. bodyguard)') },
                });
                customTypeInput.setCssStyles({ display: 'none' });
                const dragHandle = inlineRow.createDiv('relation-builder-drag-handle');
                dragHandle.draggable = true;
                dragHandle.ariaLabel = t('Drag to reorder relation');
                dragHandle.title = t('Drag to reorder');
                obsidian.setIcon(dragHandle, 'ellipsis-vertical');

                const targetSelect = inlineRow.createEl('select', { cls: 'character-field-input dropdown relation-builder-target' });
                targetSelect.createEl('option', { value: '', text: t('Select character') });
                for (const name of mergedNames) {
                    const opt = targetSelect.createEl('option', { value: name, text: name });
                    if (name === relation.target) opt.selected = true;
                }
                if (relation.target && !mergedNames.includes(relation.target)) {
                    const opt = targetSelect.createEl('option', { value: relation.target, text: relation.target });
                    opt.selected = true;
                }

                const removeBtn = inlineRow.createEl('button', { cls: 'character-custom-remove relation-builder-remove', text: '×', attr: { title: t('Remove relation') } });

                const setCustomMode = (enabled: boolean, focus = false) => {
                    typeSelect.setCssStyles({ display: enabled ? 'none' : '' });
                    customTypeInput.setCssStyles({ display: enabled ? '' : 'none' });
                    if (enabled) {
                        customTypeInput.value = relation.type && relation.type !== NEW_CUSTOM_TYPE_VALUE ? relation.type : '';
                        if (focus) customTypeInput.focus();
                    }
                };

                const shouldStartCustomMode = relation.type === NEW_CUSTOM_TYPE_VALUE
                    || ((relation.category === 'custom' || !!relation.type)
                        && !sharedCustomIds.has(relation.type)
                        && !Object.values(RELATION_TYPES_BY_CATEGORY).some(list => list.includes(relation.type)));
                setCustomMode(shouldStartCustomMode);

                typeSelect.addEventListener('change', () => {
                    let selected = typeSelect.value;
                    if (selected === NEW_CUSTOM_TYPE_VALUE) {
                        relation.category = 'custom';
                        relation.type = NEW_CUSTOM_TYPE_VALUE;
                        setCustomMode(true, true);
                        draft.relations = normalizeCharacterRelations(relations);
                        this.scheduleSave(draft);
                        return;
                    }
                    relation.type = selected;
                    relation.category = inferCategoryFromType(relation.type);
                    draft.relations = normalizeCharacterRelations(relations);
                    this.scheduleSave(draft);
                    setCustomMode(false);
                });

                customTypeInput.addEventListener('change', () => {
                    const rawLabel = customTypeInput.value.trim();
                    const cleaned = rawLabel.toLowerCase().replace(/\s+/g, '-');
                    if (!cleaned) {
                        relation.type = NEW_CUSTOM_TYPE_VALUE;
                        relation.category = 'custom';
                        draft.relations = normalizeCharacterRelations(relations);
                        this.scheduleSave(draft);
                        return;
                    }
                    relation.type = cleaned;
                    relation.category = 'custom';
                    draft.relations = normalizeCharacterRelations(relations);
                    this.scheduleSave(draft);
                    void persistSharedCustomType(cleaned, rawLabel || cleaned, 'custom');
                });

                customTypeInput.addEventListener('input', () => {
                    const cleaned = customTypeInput.value.trim().toLowerCase().replace(/\s+/g, '-');
                    if (!cleaned) {
                        relation.type = NEW_CUSTOM_TYPE_VALUE;
                        relation.category = 'custom';
                        draft.relations = normalizeCharacterRelations(relations);
                        this.scheduleSave(draft);
                        return;
                    }
                    relation.type = cleaned;
                    relation.category = 'custom';
                    draft.relations = normalizeCharacterRelations(relations);
                    this.scheduleSave(draft);
                });

                targetSelect.addEventListener('change', () => {
                    relation.target = resolveAlias(targetSelect.value);
                    draft.relations = normalizeCharacterRelations(relations);
                    this.scheduleSave(draft);
                });

                removeBtn.addEventListener('click', () => {
                    relations.splice(index, 1);
                    draft.relations = normalizeCharacterRelations(relations);
                    this.scheduleSave(draft);
                    renderRows();
                });

                dragHandle.addEventListener('dragstart', (event) => {
                    dragIndex = index;
                    relRow.addClass('relation-builder-dragging');
                    event.dataTransfer?.setData('text/plain', String(index));
                    if (event.dataTransfer) event.dataTransfer.effectAllowed = 'move';
                });

                relRow.addEventListener('dragover', (event) => {
                    event.preventDefault();
                    if (dragIndex === null || dragIndex === index) return;
                    relRow.addClass('relation-builder-drag-over');
                    if (event.dataTransfer) event.dataTransfer.dropEffect = 'move';
                });

                relRow.addEventListener('dragleave', () => {
                    relRow.removeClass('relation-builder-drag-over');
                });

                relRow.addEventListener('drop', (event) => {
                    event.preventDefault();
                    relRow.removeClass('relation-builder-drag-over');
                    if (dragIndex === null || dragIndex === index) return;

                    const [moved] = relations.splice(dragIndex, 1);
                    const insertIndex = dragIndex < index ? index - 1 : index;
                    relations.splice(insertIndex, 0, moved);
                    draft.relations = normalizeCharacterRelations(relations);
                    this.scheduleSave(draft);
                    renderRows();
                });

                relRow.addEventListener('dragend', () => {
                    dragIndex = null;
                    list.querySelectorAll('.relation-builder-drag-over').forEach(el => el.removeClass('relation-builder-drag-over'));
                    list.querySelectorAll('.relation-builder-dragging').forEach(el => el.removeClass('relation-builder-dragging'));
                });
            }
        };

        const addBtn = addRow.createEl('button', { cls: 'character-custom-add-btn', text: t('+ Add relation') });
        addBtn.addEventListener('click', () => {
            const existing = addRow.querySelector('.relation-builder-add-picker') as HTMLSelectElement | null;
            if (existing) {
                const existingPicker = existing as HTMLSelectElement & { showPicker?: () => void };
                if (typeof existingPicker.showPicker === 'function') {
                    existingPicker.showPicker();
                } else {
                    existing.focus();
                    existing.click();
                }
                return;
            }

            addBtn.setCssStyles({ display: 'none' });
            const tempSelect = addRow.createEl('select', { cls: 'character-field-input dropdown relation-builder-add-type relation-builder-add-picker' });
            tempSelect.createEl('option', { value: '', text: t('Choose relation type…') });
            buildTypeOptions(tempSelect);
            tempSelect.value = '';

            const cleanup = () => {
                if (tempSelect.parentElement) tempSelect.remove();
                addBtn.setCssStyles({ display: '' });
            };

            tempSelect.addEventListener('change', () => {
                const selectedType = tempSelect.value;
                if (!selectedType) {
                    cleanup();
                    return;
                }
                relations.push({ category: inferCategoryFromType(selectedType), type: selectedType, target: '' });
                draft.relations = normalizeCharacterRelations(relations);
                this.scheduleSave(draft);
                cleanup();
                renderRows();
            });

            tempSelect.addEventListener('blur', () => {
                // Delay to allow change to fire first when selecting an option
                window.setTimeout(() => cleanup(), 50);
            });

            const picker = tempSelect as HTMLSelectElement & { showPicker?: () => void };
            if (typeof picker.showPicker === 'function') {
                picker.showPicker();
            } else {
                tempSelect.focus();
                tempSelect.click();
            }
        });

        renderRows();
    }

    private renderCustomFields(parent: HTMLElement, draft: Character, opts?: { board?: boolean }): void {
        const board = !!opts?.board;
        const section = parent.createDiv('character-section');
        if (board) section.addClass('character-board-column');
        const title = 'Custom Fields';
        const isCollapsed = board ? false : this.collapsedSections.has(title);

        const sectionHeader = section.createDiv('character-section-header');
        const chevron = sectionHeader.createSpan('character-section-chevron');
        if (board) chevron.addClass('is-hidden');
        obsidian.setIcon(chevron, isCollapsed ? 'chevron-right' : 'chevron-down');
        const icon = sectionHeader.createSpan('character-section-icon');
        obsidian.setIcon(icon, 'plus-circle');
        sectionHeader.createSpan({ text: t(title) });

        const sectionBody = section.createDiv('character-section-body');
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

        const renderAllCustomFields = () => {
            sectionBody.empty();
            const custom = draft.custom || {};

            for (const [key, val] of Object.entries(custom)) {
                // Skip composite keys belonging to user-defined custom sections (#120)
                if (isCustomSectionKey(key)) continue;
                const row = sectionBody.createDiv('character-field-row character-custom-row');
                const keyInput = row.createEl('input', {
                    cls: 'character-field-input character-custom-key',
                    type: 'text',
                    attr: { placeholder: t('Field name') },
                });
                keyInput.value = key;

                const valInput = row.createEl('input', {
                    cls: 'character-field-input character-custom-value',
                    type: 'text',
                    attr: { placeholder: t('Value') },
                });
                valInput.value = val;

                const removeBtn = row.createEl('button', { cls: 'character-custom-remove', attr: { title: t('Remove field') } });
                obsidian.setIcon(removeBtn, 'x');

                keyInput.addEventListener('change', () => {
                    delete draft.custom![key];
                    const newKey = keyInput.value.trim();
                    if (newKey) {
                        draft.custom![newKey] = valInput.value;
                    }
                    this.scheduleSave(draft);
                });

                valInput.addEventListener('input', () => {
                    const k = keyInput.value.trim();
                    if (k) {
                        draft.custom![k] = valInput.value;
                        this.scheduleSave(draft);
                    }
                });

                removeBtn.addEventListener('click', () => {
                    delete draft.custom![key];
                    row.remove();
                    this.scheduleSave(draft);
                });
            }

            // Add button
            const addRow = sectionBody.createDiv('character-custom-add-row');
            const addBtn = addRow.createEl('button', { cls: 'character-custom-add-btn', text: t('+ Add Field') });
            addBtn.addEventListener('click', () => {
                if (!draft.custom) draft.custom = {};
                const n = Object.keys(draft.custom).length + 1;
                let newKey = `field_${n}`;
                while (draft.custom[newKey]) newKey = `field_${n}_${Date.now()}`;
                draft.custom[newKey] = '';
                renderAllCustomFields();
            });
        };

        renderAllCustomFields();
    }

    // ── User-defined custom sections (#120) ────────────

    /**
     * Build the {@link CustomSectionsHost} used to interleave user-defined
     * custom sections with the built-in `CHARACTER_CATEGORIES` in the detail
     * form. The host is rebuilt per-render so it always reflects the latest
     * settings array reference.
     */
    private buildCustomSectionsHost(draft: Character): CustomSectionsHost<Character> {
        if (!this.plugin.settings.characterCustomSections) {
            this.plugin.settings.characterCustomSections = [];
        }
        const sections = this.plugin.settings.characterCustomSections as import('../components/CustomSectionsRenderer').CustomSection[];
        return {
            app: this.app,
            draft,
            sections,
            builtinSectionCount: CHARACTER_CATEGORIES.length,
            collapsedSections: this.collapsedSections,
            collapseKeyPrefix: 'character',
            cssPrefix: 'character',
            scheduleSave: (d) => this.scheduleSave(d),
            persistSections: () => { void this.plugin.saveSettings(); },
            requestRerender: () => {
                this.rerenderCharacterDetail();
            },
        };
    }

    // ── Image gallery carousel ─────────────────────────

    private renderGallery(container: HTMLElement, draft: Character): void {
        const MAX_GALLERY = 10;
        const SECTION_KEY = '__Gallery';

        const wrapper = container.createDiv('character-gallery');

        const gallery = draft.gallery ?? [];

        // Collapsible header with add button
        const isCollapsed = this.collapsedSections.has(SECTION_KEY);
        const header = wrapper.createDiv('character-gallery-header');
        const chevron = header.createSpan('character-section-chevron');
        obsidian.setIcon(chevron, isCollapsed ? 'chevron-right' : 'chevron-down');
        header.createEl('h4', { text: t('Gallery') });

        // Add button in header (like section add-field buttons)
        if (gallery.length < MAX_GALLERY) {
            const addBtn = header.createEl('button', {
                cls: 'character-section-add-field-btn',
                attr: { title: t('Add image ({current}/{max})', { current: gallery.length, max: MAX_GALLERY }), 'aria-label': t('Add gallery image') }
            });
            obsidian.setIcon(addBtn, 'plus');
            addBtn.addEventListener('click', (e) => {
                e.stopPropagation();
                this.pickImage().then(async (picked) => {
                    if (picked && picked !== '') {
                        gallery.push({ path: picked, caption: '' });
                        draft.gallery = [...gallery];
                        await this.characterManager.saveCharacter(draft);
                        // Re-render entire gallery section
                        wrapper.empty();
                        container.removeChild(wrapper);
                        this.renderGallery(container, draft);
                        // Move gallery before scene panel
                        const scenePanel = container.querySelector('.character-side-stats');
                        if (scenePanel) {
                            const galleryEl = container.querySelector('.character-gallery');
                            if (galleryEl) container.insertBefore(galleryEl, scenePanel);
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

    private renderNotesSection(container: HTMLElement, draft: Character): void {
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

    // ── Scene side panel ───────────────────────────────

    private renderScenePanel(container: HTMLElement, characterName: string): void {
        const scenes = this.sceneManager.queryService.getFilteredScenes(
            undefined,
            { field: 'sequence', direction: 'asc' }
        );

        // Build alias set for this character (full name + all aliases)
        const aliasMap = this.characterManager.buildAliasMap(this.plugin.settings.characterAliases);
        const charAliases = new Set<string>();
        charAliases.add(characterName.toLowerCase());
        for (const [alias, canonical] of aliasMap) {
            if (canonical.toLowerCase() === characterName.toLowerCase()) {
                charAliases.add(alias);
            }
        }

        // Single pass + frontmatter-only (body scan is too slow on large libraries).
        const povScenes: Scene[] = [];
        const presentScenes: Scene[] = [];
        for (const s of scenes) {
            const { isPov, isPresent } = this.isCharInScene(s, charAliases);
            if (isPov) povScenes.push(s);
            else if (isPresent) presentScenes.push(s);
        }
        const allCharScenes = [...povScenes, ...presentScenes];

        // Stats summary
        const statsBox = container.createDiv('character-side-stats');
        statsBox.createEl('h4', { text: t('Scene Presence') });

        const statGrid = statsBox.createDiv('character-stat-grid');
        this.renderStat(statGrid, String(povScenes.length), 'POV');
        this.renderStat(statGrid, String(presentScenes.length), 'Supporting');
        this.renderStat(statGrid, String(allCharScenes.length), 'Total');

        // Plotgrid stat (patched async)
        const pgStatEl = statGrid.createDiv('character-stat-item');
        pgStatEl.setCssStyles({ display: 'none' });
        const pgValEl = pgStatEl.createDiv({ cls: 'character-stat-value', text: '0' });
        pgStatEl.createDiv({ cls: 'character-stat-label', text: t('Plotgrid') });

        // Writing progress
        const totalScenes = allCharScenes.length;
        const completedScenes = allCharScenes
            .filter(s => isWrittenLikeStatus(s.status))
            .length;

        if (totalScenes > 0) {
            const progressSection = container.createDiv('character-progress');
            progressSection.createEl('h4', { text: t('Writing Progress') });
            const progressBar = progressSection.createDiv('character-progress-bar');
            const filled = progressBar.createDiv('character-progress-filled');
            const percent = Math.round((completedScenes / totalScenes) * 100);
            filled.setCssStyles({ width: `${percent}%` });
            progressSection.createSpan({
                cls: 'character-progress-label',
                text: t('{completed} of {total} scenes written ({percent}%)', {
                    completed: completedScenes,
                    total: totalScenes,
                    percent,
                })
            });
        }

        // POV distribution
        if (scenes.length > 0) {
            const totalPovScenes = scenes.filter(s => s.pov).length;
            const charPovPercent = totalPovScenes > 0
                ? Math.round((povScenes.length / totalPovScenes) * 100)
                : 0;
            if (totalPovScenes > 0) {
                const distBox = container.createDiv('character-side-pov-dist');
                distBox.createEl('p', {
                    text: t('{percent}% of all POV scenes', { percent: charPovPercent })
                });
            }
        }

        // Scene list
        if (allCharScenes.length > 0) {
            const listSection = container.createDiv('character-side-scenes');
            listSection.createEl('h4', { text: t('Scenes') });
            for (const scene of allCharScenes) {
                const item = listSection.createDiv('character-side-scene-item');
                const isPov = scene.pov && charAliases.has(scene.pov.toLowerCase());

                // Use shared formatter so string acts (e.g. "1.1", "Prologue")
                // are shown verbatim and pure-numeric acts are zero-padded.
                const act = formatActChapterPrefix(scene.act, '??');
                const seq = scene.sequence !== undefined ? String(scene.sequence).padStart(2, '0') : '??';

                item.createSpan({ cls: 'scene-id', text: `[${act}-${seq}]` });
                item.createSpan({ cls: 'scene-title', text: ` ${scene.title}` });

                if (isPov) {
                    item.createSpan({ cls: 'character-pov-badge', text: t('POV') });
                }

                const statusCfg = resolveStatusCfg(scene.status || 'idea');
                const statusBadge = item.createSpan({
                    cls: 'scene-status-badge',
                    attr: { title: t(statusCfg.label) }
                });
                obsidian.setIcon(statusBadge, statusCfg.icon);

                item.addEventListener('click', () => this.openScene(scene));
            }
        }

        // Plotgrid cell appearances (async)
        const pgSection = container.createDiv('character-side-scenes character-side-plotgrid');
        pgSection.setCssStyles({ display: 'none' });

        if (typeof this.plugin.scanPlotGridCells === 'function') {
            this.plugin.scanPlotGridCells().then(result => {
                const hitsByKey = result.characterHits || new Map();
                const hitMap = new Map<string, import('../models/PlotGridData').PlotGridAppearanceHit>();
                for (const key of charAliases) {
                    const hits = hitsByKey.get(key);
                    if (!hits) continue;
                    for (const hit of hits) {
                        hitMap.set(`${hit.pageId}::${hit.rowId}`, hit);
                    }
                }
                // Fallback for older scan payloads that only return row-label sets.
                if (hitMap.size === 0) {
                    const pgChars = result.characters;
                    const pgRows = new Set<string>();
                    for (const key of charAliases) {
                        const rows = pgChars.get(key);
                        if (rows) rows.forEach(r => pgRows.add(r));
                    }
                    if (pgRows.size === 0) return;
                    pgStatEl.setCssStyles({ display: '' });
                    pgValEl.textContent = String(pgRows.size);
                    pgSection.setCssStyles({ display: '' });
                    pgSection.createEl('h4', { text: t('Plotgrid Appearances') });
                    for (const rowLabel of [...pgRows].sort()) {
                        const item = pgSection.createDiv('character-side-scene-item');
                        const icon = item.createSpan({ cls: 'scene-id' });
                        obsidian.setIcon(icon, 'grid-3x3');
                        item.createSpan({ cls: 'scene-title', text: ` ${rowLabel}` });
                    }
                    return;
                }

                const hits = [...hitMap.values()].sort((a, b) => {
                    const pageCmp = a.pageTitle.localeCompare(b.pageTitle, undefined, { sensitivity: 'base' });
                    if (pageCmp !== 0) return pageCmp;
                    return a.rowLabel.localeCompare(b.rowLabel, undefined, { sensitivity: 'base' });
                });

                pgStatEl.setCssStyles({ display: '' });
                pgValEl.textContent = String(hits.length);

                pgSection.setCssStyles({ display: '' });
                pgSection.createEl('h4', { text: t('Plotgrid Appearances') });
                pgSection.createEl('p', {
                    cls: 'setting-item-description character-side-plotgrid-hint',
                    text: t('Click a row to open Concept Grid. Scene-linked rows also show their source file.'),
                });

                for (const hit of hits) {
                    const item = pgSection.createDiv('character-side-scene-item character-side-plotgrid-item');
                    const main = item.createDiv('character-side-plotgrid-main');
                    const icon = main.createSpan({ cls: 'scene-id' });
                    obsidian.setIcon(icon, 'grid-3x3');
                    main.createSpan({ cls: 'scene-title', text: hit.rowLabel || t('Untitled row') });

                    const meta = item.createDiv('character-side-plotgrid-meta');
                    const sheetBits = [hit.pageTitle, hit.filePath.split('/').pop() || hit.filePath]
                        .filter(Boolean);
                    meta.createSpan({
                        cls: 'character-side-plotgrid-sheet',
                        text: sheetBits.join(' · '),
                        attr: { title: hit.filePath },
                    });
                    if (hit.columnLabel) {
                        meta.createSpan({
                            cls: 'character-side-plotgrid-col',
                            text: t('Column: {label}', { label: hit.columnLabel }),
                        });
                    }
                    if (hit.scenePath) {
                        const sceneName = hit.scenePath.split('/').pop()?.replace(/\.md$/i, '')
                            || hit.scenePath;
                        const sceneLink = meta.createEl('button', {
                            cls: 'character-side-plotgrid-scene',
                            text: sceneName,
                            attr: {
                                type: 'button',
                                title: hit.scenePath,
                            },
                        });
                        sceneLink.addEventListener('click', (e) => {
                            e.preventDefault();
                            e.stopPropagation();
                            const file = this.app.vault.getAbstractFileByPath(hit.scenePath!);
                            if (file instanceof obsidian.TFile) {
                                void this.app.workspace.getLeaf('tab').openFile(file, {
                                    state: { mode: 'source', source: false },
                                });
                            } else {
                                new obsidian.Notice(t('Could not find scene file.'));
                            }
                        });
                    }

                    item.setAttr('title', t('Open in Concept Grid — {page} / {row}', {
                        page: hit.pageTitle,
                        row: hit.rowLabel,
                    }));
                    item.addEventListener('click', () => {
                        void this.plugin.openPlotGridAppearance(hit);
                    });
                }
            }).catch(() => { /* non-fatal */ });
        }

        // Character arc intensity curve
        const scenesWithIntensity = allCharScenes
            .sort((a, b) => (a.sequence ?? 0) - (b.sequence ?? 0))
            .filter(s => s.intensity !== undefined && s.intensity !== null);

        if (scenesWithIntensity.length >= 2) {
            this.renderIntensityCurve(container, characterName, scenesWithIntensity);
        }

        // Gap detection
        this.renderGapDetection(container, characterName, scenes, allCharScenes);
    }

    /**
     * Render the "Linked Aliases" panel — shows every alias name that has
     * been linked to this character via the "Link to…" action (stored in
     * `settings.characterAliases` as alias → canonical). Each alias has an
     * "Unlink" button that removes the mapping.
     *
     * This addresses issue #213: previously, linking an alias to a character
     * made the alias disappear as a separate entry, but there was no way to
     * see which aliases pointed at a given character, nor to unlink one.
     */
    private renderLinkedAliasesPanel(container: HTMLElement, characterName: string): void {
        const aliases = this.plugin.settings.characterAliases || {};
        const linked = Object.entries(aliases).filter(
            ([, canonical]) => canonical.toLowerCase() === characterName.toLowerCase()
        );

        if (linked.length === 0) return;

        const section = container.createDiv('character-linked-aliases-panel');
        section.createEl('h3', { text: t('Linked Aliases') });

        section.createEl('p', {
            cls: 'setting-item-description',
            text: t('These names are linked to this character. They appear in scenes as this character and no longer show up as separate entries.'),
        });

        const list = section.createEl('ul', { cls: 'linked-aliases-list' });
        for (const [aliasLower, canonical] of linked) {
            const li = list.createEl('li', { cls: 'linked-alias-row' });
            // Recover original casing from the alias key (stored lowercased).
            // Fall back to the lowercased key if no better source is available.
            li.createSpan({ text: aliasLower, cls: 'linked-alias-name' });
            li.createSpan({ text: ` → ${canonical}`, cls: 'linked-alias-target' });

            const unlinkBtn = li.createEl('button', {
                cls: 'linked-alias-unlink-btn',
                text: t('Unlink'),
                attr: { 'aria-label': t('Unlink "{alias}" from {canonical}', { alias: aliasLower, canonical }) },
            });
            unlinkBtn.addEventListener('click', async (e) => {
                e.stopPropagation();
                delete this.plugin.settings.characterAliases[aliasLower];
                await this.plugin.saveSettings();
                // Rebuild lookups so the alias is treated as standalone again
                this.plugin.linkScanner.invalidateAll();
                this.plugin.linkScanner.rebuildLookups(this.plugin.settings.characterAliases);
                new Notice(t('Unlinked "{alias}"', { alias: aliasLower }));
                if (this.rootContainer) this.renderView(this.rootContainer);
            });
        }
    }

    private renderReferencesPanel(container: HTMLElement, entityName: string): void {
        const index = this.plugin.linkScanner.buildEntityIndex();
        const refs = index.get(entityName.toLowerCase());
        if (!refs || refs.length === 0) return;

        const section = container.createDiv('character-references-panel');
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
            groupEl.createEl('h4', { text: t(groupLabel.charAt(0).toUpperCase() + groupLabel.slice(1)) });
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
        const stat = parent.createDiv('character-stat-item');
        stat.createDiv({ cls: 'character-stat-value', text: value });
        stat.createDiv({ cls: 'character-stat-label', text: t(label) });
    }

    // ── Auto-save ──────────────────────────────────────

    private scheduleSave(draft: Character): void {
        if (this.autoSaveTimer) window.clearTimeout(this.autoSaveTimer);
        this.pendingSaveDraft = draft;
        const revision = ++this.pendingSaveRevision;
        this.autoSaveTimer = window.setTimeout(() => {
            this.autoSaveTimer = null;
            void this.persistCharacterDraft(draft, revision);
        }, 600);
    }

    private async persistCharacterDraft(draft: Character, revision: number): Promise<void> {
        const operation = this.saveQueue
            .catch(() => undefined)
            .then(async () => {
                this.saveInFlight = true;
                const undoMgr = this.plugin.sceneManager?.undoManager;
                let undoToken: Awaited<ReturnType<typeof undoMgr.beginUpdate>> | null = null;
                if (undoMgr && this.undoSnapshot) {
                    try {
                        undoToken = await undoMgr.beginUpdate(
                            draft.filePath,
                            t('Update "{name}"', { name: draft.name }),
                            'character',
                        );
                    } catch (error) {
                        // Undo history is optional; it must never block the actual save.
                        console.warn('NarrativeLab: could not create character undo snapshot', error);
                    }
                }
                this._lastSaveTime = Date.now();
                try {
                    await this.characterManager.saveCharacter(draft);
                    if (undoToken && undoMgr) {
                        try {
                            await undoMgr.commitUpdate(undoToken);
                        } catch (error) {
                            console.warn('NarrativeLab: character saved, but undo history could not be committed', error);
                        }
                    }
                    this.undoSnapshot = {
                        ...draft,
                        custom: { ...(draft.custom || {}) },
                        universalFields: { ...(draft.universalFields || {}) },
                    };
                    if (this.pendingSaveDraft === draft && this.pendingSaveRevision === revision) {
                        this.pendingSaveDraft = null;
                    }
                    if (!this._skipReciprocalSync) {
                        try {
                            await this.syncReciprocalRelations(draft);
                        } catch (error) {
                            console.warn('NarrativeLab: character saved, but reciprocal relations could not be synchronized', error);
                        }
                    }
                } catch (error) {
                    console.error('NarrativeLab: failed to save character', error);
                    new Notice(t('Failed to save character: {message}', {
                        message: error instanceof Error ? error.message : String(error),
                    }));
                    throw error;
                } finally {
                    this.saveInFlight = false;
                }
            });
        this.saveQueue = operation;
        await operation;
    }

    /**
     * Compute relation diffs and apply reciprocal updates to target characters.
     */
    private async syncReciprocalRelations(draft: Character): Promise<void> {
        const currentRelations = normalizeCharacterRelations(draft.relations);
        const updates = computeReciprocalUpdates(
            draft.name,
            this._lastSavedRelations,
            currentRelations,
        );

        // Update snapshot for next diff
        this._lastSavedRelations = currentRelations.map(r => ({ ...r }));

        if (updates.length === 0) return;

        // Group updates by target
        const byTarget = new Map<string, typeof updates>();
        for (const u of updates) {
            const key = u.targetName.toLowerCase();
            if (!byTarget.has(key)) byTarget.set(key, []);
            byTarget.get(key)!.push(u);
        }

        for (const [, targetUpdates] of byTarget) {
            const targetName = targetUpdates[0].targetName;
            const targetChar = this.characterManager.findByName(targetName);
            if (!targetChar) continue;

            let relations = normalizeCharacterRelations(targetChar.relations);
            let changed = false;

            for (const u of targetUpdates) {
                const matchKey = `${u.relation.type}|${u.relation.target.toLowerCase()}`;
                const existingIdx = relations.findIndex(
                    r => `${r.type}|${r.target.toLowerCase()}` === matchKey
                );

                if (u.action === 'add' && existingIdx === -1) {
                    relations.push(u.relation);
                    changed = true;
                } else if (u.action === 'remove' && existingIdx !== -1) {
                    relations.splice(existingIdx, 1);
                    changed = true;
                }
            }

            if (changed) {
                targetChar.relations = normalizeCharacterRelations(relations);
                try {
                    this._skipReciprocalSync = true;
                    await this.characterManager.saveCharacter(targetChar);
                } catch (e) {
                    console.error(`NarrativeLab: failed to sync reciprocal relations to "${targetName}"`, e);
                } finally {
                    this._skipReciprocalSync = false;
                }
            }
        }
    }

    /**
     * Check if the character name changed and offer to cascade-update all references.
     * Called on blur of the Name input field.
     */
    private checkCharacterRename(draft: Character, inputEl: HTMLInputElement): void {
        const oldName = this.originalCharacterName;
        const newName = draft.name?.trim();
        if (!oldName || !newName || oldName === newName) return;

        const service = this.plugin.cascadeRename;
        const preview = service.previewCharacterRename(oldName, newName);
        const total = preview.sceneCount + preview.relationCount;
        if (total === 0) {
            // No references to update — just silently update the tracked name
            this.originalCharacterName = newName;
            return;
        }

        const summary = service.buildSummary(preview);
        const modal = new RenameConfirmModal(
            this.app,
            'character',
            oldName,
            newName,
            preview,
            summary,
            async () => {
                await service.cascadeCharacterRename(oldName, newName);
                this.originalCharacterName = newName;
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
            const draft = this.pendingSaveDraft;
            const revision = this.pendingSaveRevision;
            try {
                await this.persistCharacterDraft(draft, revision);
            } catch { /* persistCharacterDraft already reports the error */ }
        } else {
            await this.saveQueue.catch(() => undefined);
        }
    }

    // ── Actions ────────────────────────────────────────

    private promptNewCharacter(): void {
        const modal = new Modal(this.app);
        modal.titleEl.setText(t('New Character'));

        let name = '';
        new Setting(modal.contentEl)
            .setName(t('Character name'))
            .addText(text => {
                text.setPlaceholder(t('Enter character name\u2026'))
                    .onChange(v => (name = v));
                window.setTimeout(() => text.inputEl.focus(), 50);
            });

        new Setting(modal.contentEl)
            .addButton(btn => {
                btn.setButtonText(t('Create'))
                    .setCta()
                    .onClick(async () => {
                        if (!name.trim()) {
                            new Notice(t('Please enter a name.'));
                            return;
                        }
                        try {
                            const char = await this.characterManager.createCharacter(
                                this.sceneManager.getCharacterFolder(),
                                name.trim()
                            );
                            // Suppress the vault-create → refreshOpenViews bounce that
                            // can clear selection before the new file is re-indexed.
                            this._lastSaveTime = Date.now();
                            modal.close();
                            await this.openCharacterDetail(char.filePath);
                            new Notice(t('Character "{name}" created', { name: name.trim() }));
                        } catch (e) {
                            new Notice(String(e));
                        }
                    });
            });

        modal.open();
    }

    private async createCharacterFromName(name: string): Promise<void> {
        try {
            const char = await this.characterManager.createCharacter(
                this.sceneManager.getCharacterFolder(),
                name
            );
            this._lastSaveTime = Date.now();
            await this.openCharacterDetail(char.filePath);
            new Notice(t('Character profile created for "{name}"', { name }));
        } catch (e) {
            new Notice(String(e));
        }
    }

    private confirmDeleteCharacter(character: Character): void {
        const modal = new Modal(this.app);
        modal.titleEl.setText(t('Delete Character'));
        modal.contentEl.createEl('p', {
            text: t('Are you sure you want to delete "{name}"? The file will be moved to trash.', { name: character.name })
        });

        new Setting(modal.contentEl)
            .addButton(btn => {
                btn.setButtonText(t('Delete'))
                    .setClass('mod-warning')
                    .onClick(async () => {
                        // Record undo before deleting
                        const undoMgr = this.plugin.sceneManager?.undoManager;
                        if (undoMgr) {
                            const file = this.app.vault.getAbstractFileByPath(character.filePath);
                            if (file instanceof TFile) {
                                const content = await this.app.vault.read(file);
                                undoMgr.recordDelete(character.filePath, content, `Delete character "${character.name}"`, 'character');
                            }
                        }
                        await this.characterManager.deleteCharacter(character.filePath);
                        this.selectedCharacter = null;
                        modal.close();
                        if (this.embedOptions) {
                            (this.embedOptions.onDeleted || this.embedOptions.onBack)();
                        } else {
                            this.renderContentOnly();
                        }
                        new Notice(t('"{name}" deleted', { name: character.name }));
                    });
            })
            .addButton(btn => {
                btn.setButtonText(t('Cancel'))
                    .onClick(() => modal.close());
            });

        modal.open();
    }

    private async openCharacterFile(character: Character): Promise<void> {
        const file = this.app.vault.getAbstractFileByPath(character.filePath);
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

    // ── Reused visualisations ──────────────────────────

    private renderGapDetection(
        container: HTMLElement,
        character: string,
        allScenes: Scene[],
        charScenes: Scene[]
    ): void {
        if (charScenes.length < 2 || allScenes.length < 3) return;

        const sortedAll = [...allScenes].sort((a, b) => (a.sequence ?? 0) - (b.sequence ?? 0));
        const sortedChar = [...charScenes].sort((a, b) => (a.sequence ?? 0) - (b.sequence ?? 0));

        const GAP_THRESHOLD = 3;
        const gaps: { from: Scene; to: Scene; missedCount: number }[] = [];

        for (let i = 0; i < sortedChar.length - 1; i++) {
            const currentSeq = sortedChar[i].sequence ?? 0;
            const nextSeq = sortedChar[i + 1].sequence ?? 0;
            const missedScenes = sortedAll.filter(s =>
                (s.sequence ?? 0) > currentSeq && (s.sequence ?? 0) < nextSeq
            );
            if (missedScenes.length >= GAP_THRESHOLD) {
                gaps.push({ from: sortedChar[i], to: sortedChar[i + 1], missedCount: missedScenes.length });
            }
        }

        const firstCharSeq = sortedChar[0].sequence ?? 0;
        const lastCharSeq = sortedChar[sortedChar.length - 1].sequence ?? 0;
        const scenesBefore = sortedAll.filter(s => (s.sequence ?? 0) < firstCharSeq).length;
        const scenesAfter = sortedAll.filter(s => (s.sequence ?? 0) > lastCharSeq).length;

        const section = container.createDiv('character-gaps-section');
        section.createEl('h4', { text: t('Presence Gaps') });

        if (gaps.length === 0 && scenesBefore < GAP_THRESHOLD && scenesAfter < GAP_THRESHOLD) {
            const okDiv = section.createDiv('character-gap-ok');
            const okIcon = okDiv.createSpan();
            obsidian.setIcon(okIcon, 'check-circle');
            okDiv.createSpan({ text: t(' {character} appears regularly throughout the story', { character }) });
            return;
        }

        // Presence bar
        const heatmap = section.createDiv('character-presence-bar');
        const charLower = character.toLowerCase();
        sortedAll.forEach(scene => {
            const cell = heatmap.createDiv('character-presence-cell');
            const isPresent = scene.pov?.toLowerCase() === charLower ||
                scene.characters?.some(c => c.toLowerCase() === charLower);
            cell.addClass(isPresent ? 'presence-active' : 'presence-absent');
            cell.setAttribute('title', t('{title} (seq {seq}) — {status}', {
                title: scene.title,
                seq: scene.sequence ?? '?',
                status: isPresent ? t('Present') : t('Absent'),
            }));
        });
        section.createDiv({ cls: 'character-presence-legend', text: t('Each cell = one scene. Colored = present, dim = absent.') });

        if (scenesBefore >= GAP_THRESHOLD) {
            const gapDiv = section.createDiv('character-gap-item');
            const gapIcon = gapDiv.createSpan();
            obsidian.setIcon(gapIcon, 'alert-triangle');
            gapDiv.createSpan({ text: t(' Absent for first {count} scenes (appears first in scene {seq})', { count: scenesBefore, seq: firstCharSeq }) });
        }

        gaps.forEach(gap => {
            const gapDiv = section.createDiv('character-gap-item');
            const gapIcon = gapDiv.createSpan();
            obsidian.setIcon(gapIcon, 'alert-triangle');
            gapDiv.createSpan({ text: t(' Gone for {count} scenes between "{from}" and "{to}"', { count: gap.missedCount, from: gap.from.title, to: gap.to.title }) });
        });

        if (scenesAfter >= GAP_THRESHOLD) {
            const gapDiv = section.createDiv('character-gap-item');
            const gapIcon = gapDiv.createSpan();
            obsidian.setIcon(gapIcon, 'alert-triangle');
            gapDiv.createSpan({ text: t(' Absent for last {count} scenes (last appears at scene {seq})', { count: scenesAfter, seq: lastCharSeq }) });
        }
    }

    private renderIntensityCurve(container: HTMLElement, _character: string, scenes: Scene[]): void {
        const section = container.createDiv('character-arc-section');
        section.createEl('h4', { text: t('Character Arc (Intensity)') });

        const width = 400;
        const height = 120;
        const padX = 36;
        const padY = 16;
        const plotW = width - padX * 2;
        const plotH = height - padY * 2;
        const minIntensity = -10;
        const maxIntensity = 10;
        const intensityRange = maxIntensity - minIntensity;

        const svg = activeDocument.createElementNS('http://www.w3.org/2000/svg', 'svg');
        svg.setAttribute('viewBox', `0 0 ${width} ${height}`);
        svg.setAttribute('width', '100%');
        svg.setAttribute('height', String(height));
        svg.classList.add('character-arc-svg');

        for (let v = minIntensity; v <= maxIntensity; v += 5) {
            const y = padY + plotH - ((v - minIntensity) / intensityRange) * plotH;
            const line = activeDocument.createElementNS('http://www.w3.org/2000/svg', 'line');
            line.setAttribute('x1', String(padX));
            line.setAttribute('x2', String(padX + plotW));
            line.setAttribute('y1', String(y));
            line.setAttribute('y2', String(y));
            line.setAttribute('class', 'arc-grid-line');
            svg.appendChild(line);
        }

        const yLabelLow = activeDocument.createElementNS('http://www.w3.org/2000/svg', 'text');
        yLabelLow.setAttribute('x', String(padX - 6));
        yLabelLow.setAttribute('y', String(padY + plotH));
        yLabelLow.setAttribute('text-anchor', 'end');
        yLabelLow.setAttribute('class', 'arc-axis-label');
        yLabelLow.textContent = String(minIntensity);
        svg.appendChild(yLabelLow);

        const yLabelHigh = activeDocument.createElementNS('http://www.w3.org/2000/svg', 'text');
        yLabelHigh.setAttribute('x', String(padX - 6));
        yLabelHigh.setAttribute('y', String(padY + 4));
        yLabelHigh.setAttribute('text-anchor', 'end');
        yLabelHigh.setAttribute('class', 'arc-axis-label');
        yLabelHigh.textContent = String(maxIntensity);
        svg.appendChild(yLabelHigh);

        const points: { x: number; y: number; scene: Scene }[] = [];
        scenes.forEach((scene, idx) => {
            const x = padX + (idx / (scenes.length - 1)) * plotW;
            const intensity = typeof scene.intensity === 'number' ? Math.max(minIntensity, Math.min(maxIntensity, scene.intensity)) : 0;
            const y = padY + plotH - ((intensity - minIntensity) / intensityRange) * plotH;
            points.push({ x, y, scene });
        });

        if (points.length >= 2) {
            const pathD = points.map((p, i) => `${i === 0 ? 'M' : 'L'} ${p.x} ${p.y}`).join(' ');
            const path = activeDocument.createElementNS('http://www.w3.org/2000/svg', 'path');
            path.setAttribute('d', pathD);
            path.setAttribute('class', 'arc-line');
            svg.appendChild(path);

            const areaD = pathD + ` L ${points[points.length - 1].x} ${padY + plotH} L ${points[0].x} ${padY + plotH} Z`;
            const area = activeDocument.createElementNS('http://www.w3.org/2000/svg', 'path');
            area.setAttribute('d', areaD);
            area.setAttribute('class', 'arc-area');
            svg.appendChild(area);
        }

        points.forEach(p => {
            const circle = activeDocument.createElementNS('http://www.w3.org/2000/svg', 'circle');
            circle.setAttribute('cx', String(p.x));
            circle.setAttribute('cy', String(p.y));
            circle.setAttribute('r', '4');
            circle.setAttribute('class', 'arc-dot');

            const title = activeDocument.createElementNS('http://www.w3.org/2000/svg', 'title');
            title.textContent = t('{title} — intensity: {intensity}', { title: p.scene.title, intensity: p.scene.intensity ?? '' });
            circle.appendChild(title);
            svg.appendChild(circle);

            const label = activeDocument.createElementNS('http://www.w3.org/2000/svg', 'text');
            label.setAttribute('x', String(p.x));
            label.setAttribute('y', String(padY + plotH + 14));
            label.setAttribute('text-anchor', 'middle');
            label.setAttribute('class', 'arc-scene-label');
            label.textContent = String(p.scene.sequence ?? '?');
            svg.appendChild(label);
        });

        section.appendChild(svg);
    }

    // ── Utility ────────────────────────────────────────

    private roleClass(role: string): string {
        const r = role.toLowerCase().replace(/\s+/g, '-');
        return `role-${r}`;
    }

    /**
     * Navigate directly to a character's detail view by file path.
     * Called from the command palette / file-menu when the user wants to
     * jump from the character's freeform note back to the details panel.
     */
    async navigateToCharacter(filePath: string): Promise<void> {
        await this.openCharacterDetail(filePath);
    }

    async mountEmbeddedDetail(
        container: HTMLElement,
        filePath: string,
        options: LibraryProfileEmbedOptions,
    ): Promise<boolean> {
        this.embedOptions = options;
        this.embedHostEl = container;
        this.rootContainer = container;
        this.ensureProjectBinding(this.sceneManager.activeProject?.filePath);
        await this.openCharacterDetail(filePath);
        return Boolean(this.selectedCharacter);
    }

    async unmountEmbeddedDetail(): Promise<void> {
        await this.flushPendingSave();
        this.editingDraft = null;
        this.selectedCharacter = null;
        this.clearPortaledDropdowns();
        this.embedOptions = null;
        this.embedHostEl = null;
    }

    /**
     * Public refresh called by the plugin on file changes.
     * If we are in detail-editing mode and the refresh was triggered by our own
     * save (within the grace window), skip the re-render to avoid stealing focus.
     */
    async refresh(): Promise<void> {
        if (!this.isBoundToActiveProject(this.sceneManager)) return;
        // refreshOpenViews already reloaded entities — only re-render here.
        if (
            this.selectedCharacter &&
            (
                this.pendingSaveDraft !== null
                || this.saveInFlight
                || Date.now() - this._lastSaveTime < CharacterView.SAVE_REFRESH_GRACE_MS
                || !!this.getViewRoot().querySelector('input:focus, textarea:focus, select:focus')
            )
        ) {
            return;
        }
        this.editingDraft = null;
        const categoriesEpoch = this.plugin.libraryCategoriesStructureEpoch;
        const categoriesChanged = categoriesEpoch !== this._libraryCategoriesEpoch;
        this._libraryCategoriesEpoch = categoriesEpoch;
        // Keep the native Bases embed mounted — remounting flashes the table.
        // Still remount when Library folders are newly adopted into tabs.
        if (
            !categoriesChanged
            && !this.selectedCharacter
            && this.characterOverviewMode === 'base'
            && this.containerEl.querySelector('.library-native-base-embed')
        ) {
            const title = this.plugin.getProjectDisplayName(this.getBoundProjectFile());
            this.containerEl.querySelectorAll('.story-line-view-title')
                .forEach(el => { el.textContent = title; });
            return;
        }
        // Keep Story Graph mounted — remounting resets pan/zoom mid-gesture
        // ("画面跳回") whenever vault refresh fires during wheel zoom.
        if (
            !categoriesChanged
            && !this.selectedCharacter
            && this.characterOverviewMode === 'story-graph'
            && this.storyGraph
            && this.containerEl.querySelector('.story-graph-page')
        ) {
            const title = this.plugin.getProjectDisplayName(this.getBoundProjectFile());
            this.containerEl.querySelectorAll('.story-line-view-title')
                .forEach(el => { el.textContent = title; });
            return;
        }
        const scroller = this.getViewRoot().querySelector('.story-line-character-content') as HTMLElement | null;
        const scrollTop = !this.selectedCharacter ? (scroller?.scrollTop ?? 0) : 0;
        this.renderView(this.getViewRoot());
        if (scrollTop > 0) {
            const next = this.getViewRoot().querySelector('.story-line-character-content') as HTMLElement | null;
            if (next) {
                next.scrollTop = scrollTop;
                window.requestAnimationFrame(() => {
                    if (next.isConnected) next.scrollTop = scrollTop;
                });
            }
        }
    }

    /* ───── Character card context menu (promote/demote, book membership) ───── */

    private showCharacterContextMenu(char: Character, e: MouseEvent): void {
        const menu = new obsidian.Menu();
        const sm = this.plugin.sceneManager;
        const seriesFolder = sm.getSeriesFolder();
        const seriesCharFolder = seriesFolder
            ? `${seriesFolder}/Library/Characters`
            : null;
        const projectCharFolder = sm.getProjectLocalCharacterFolder();
        const currentBook = sm.getCurrentBookTitle();

        menu.addItem(item =>
            item.setTitle(char.name).setDisabled(true));
        menu.addSeparator();

        // Promote / Demote between project and series folder
        if (seriesFolder && seriesCharFolder && projectCharFolder) {
            const inSeries = char.filePath.startsWith(seriesCharFolder + '/');
            if (inSeries) {
                menu.addItem(item =>
                    item.setTitle(t('Keep in current project only'))
                        .setIcon('arrow-down-from-line')
                        .onClick(() => this.demoteCharacterToProject(char, projectCharFolder)));
            } else {
                menu.addItem(item =>
                    item.setTitle(t('Promote to series (shared)'))
                        .setIcon('arrow-up-from-line')
                        .onClick(() => this.promoteCharacterToSeries(char, seriesCharFolder)));
            }
            menu.addSeparator();
        }

        // Toggle current-book membership (only meaningful in series mode)
        if (seriesFolder && currentBook) {
            const lower = currentBook.toLowerCase();
            const inBook = !char.books || char.books.length === 0
                || char.books.some(b => b.toLowerCase() === lower);
            const allBooks = !char.books || char.books.length === 0;

            if (allBooks) {
                menu.addItem(item =>
                    item.setTitle(t('Restrict to "{book}" only', { book: currentBook }))
                        .setIcon('book-marked')
                        .onClick(() => this.setCharacterBooks(char, [currentBook])));
            } else if (inBook) {
                menu.addItem(item =>
                    item.setTitle(t('Remove from "{book}"', { book: currentBook }))
                        .setIcon('book-x')
                        .onClick(() => this.setCharacterBooks(char,
                            (char.books || []).filter(b => b.toLowerCase() !== lower))));
            } else {
                menu.addItem(item =>
                    item.setTitle(t('Add to "{book}"', { book: currentBook }))
                        .setIcon('book-plus')
                        .onClick(() => this.setCharacterBooks(char,
                            [...(char.books || []), currentBook])));
            }
            menu.addItem(item =>
                item.setTitle(t('Share across all projects'))
                    .setIcon('books')
                    .setDisabled(allBooks)
                    .onClick(() => this.setCharacterBooks(char, [])));
        }

        showMenuSafely(menu, e);
    }

    private async promoteCharacterToSeries(char: Character, seriesCharFolder: string): Promise<void> {
        try {
            await this.characterManager.moveCharacter(char, seriesCharFolder);
            new Notice(t('"{name}" promoted to series', { name: char.name }));
            await this.plugin.refreshOpenViews();
        } catch (err) {
            new Notice(t('Could not promote: {err}', { err: (err as Error).message }));
        }
    }

    private async demoteCharacterToProject(char: Character, projectCharFolder: string): Promise<void> {
        try {
            await this.characterManager.moveCharacter(char, projectCharFolder);
            new Notice(t('"{name}" demoted to project', { name: char.name }));
            await this.plugin.refreshOpenViews();
        } catch (err) {
            new Notice(t('Could not demote: {err}', { err: (err as Error).message }));
        }
    }

    private async setCharacterBooks(char: Character, books: string[]): Promise<void> {
        try {
            const updated: Character = { ...char, books: books.length ? books : undefined };
            await this.characterManager.saveCharacter(updated);
            await this.plugin.refreshOpenViews();
        } catch (err) {
            new Notice(t('Could not update project membership: {err}', { err: (err as Error).message }));
        }
    }

    /* ───── Tag type override context menu ───── */

    private addTagContextMenu(el: HTMLElement, tagName: string): void {
        el.addEventListener('contextmenu', (e) => {
            e.preventDefault();
            e.stopPropagation();

            const low = tagName.toLowerCase();
            const current = this.plugin.settings.tagTypeOverrides[low];

            const types: { label: string; value: TagType | null; icon: string }[] = [
                { label: 'Prop', value: 'prop', icon: 'gem' },
                { label: 'Location', value: 'location', icon: 'map-pin' },
                { label: 'Character', value: 'character', icon: 'user' },
                { label: 'Other', value: 'other', icon: 'file-text' },
                { label: 'Reset to Auto', value: null, icon: 'rotate-ccw' },
            ];

            const menu = new obsidian.Menu();
            menu.addItem(item => item.setTitle(`#${tagName}`).setDisabled(true));
            menu.addSeparator();
            for (const t of types) {
                menu.addItem(item => {
                    item.setTitle(t.label)
                        .setIcon(t.icon)
                        .setChecked(t.value !== null && current === t.value)
                        .onClick(async () => {
                            if (t.value === null) {
                                delete this.plugin.settings.tagTypeOverrides[low];
                            } else {
                                this.plugin.settings.tagTypeOverrides[low] = t.value;
                            }
                            await this.plugin.saveSettings();
                            if (this.rootContainer) this.renderView(this.rootContainer);
                        });
                });
            }
            showMenuSafely(menu, e);
        });
    }

    /**
     * Open a modal to pick/import an image file.
     * Returns the vault-relative path of the chosen file, empty string to clear, or undefined if cancelled.
     */
    private pickImage(currentImage?: string): Promise<string | undefined> {
        const attachmentSourcePath = this.sceneManager.getLibraryAttachmentFolder('characters');
        return pickImageModal(this.app, attachmentSourcePath, currentImage);
    }

    /**
     * Open a non-modal, draggable/resizable floating window showing a gallery image.
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
            titleText.textContent = entry.caption || t('Image {index} of {total}', { index: currentIndex + 1, total: gallery.length });
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
            // Use getBoundingClientRect to get the actual visual position
            // (handles transform: translate(-50%, -50%) correctly)
            const rect = win.getBoundingClientRect();
            dragOffsetX = e.clientX - rect.left;
            dragOffsetY = e.clientY - rect.top;
            // Resolve transform to explicit left/top on first drag
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
}
/**
 * Modal that lets the user pick an existing character profile to link an alias to.
 */
class LinkCharacterModal extends Modal {
    private aliasName: string;
    private characters: Character[];
    private onSelect: (canonicalName: string) => void;

    constructor(app: import('obsidian').App, aliasName: string, characters: Character[], onSelect: (canonicalName: string) => void) {
        super(app);
        this.aliasName = aliasName;
        this.characters = characters;
        this.onSelect = onSelect;
    }

    onOpen(): void {
        const { contentEl } = this;
        contentEl.empty();
        contentEl.createEl('h3', { text: t('Link "{alias}" to\u2026', { alias: this.aliasName }) });
        contentEl.createEl('p', {
            cls: 'setting-item-description',
            text: t('Choose which character "{alias}" refers to. This alias will be remembered and the name will no longer appear as a separate character.', { alias: this.aliasName }),
        });

        const list = contentEl.createDiv('link-character-list');

        for (const char of this.characters) {
            const row = list.createDiv('link-character-row');
            row.createSpan({ text: char.name, cls: 'link-character-name' });
            if (char.nickname) {
                row.createSpan({ text: ` (${char.nickname})`, cls: 'link-character-nickname' });
            }
            row.addEventListener('click', () => {
                this.onSelect(char.name);
                this.close();
            });
        }
    }

    onClose(): void {
        this.contentEl.empty();
    }
}
/* eslint-enable @typescript-eslint/no-floating-promises, @typescript-eslint/no-misused-promises, @typescript-eslint/no-unnecessary-type-assertion, @typescript-eslint/no-unused-vars -- end of file-wide suppression block opened at line 1 */
