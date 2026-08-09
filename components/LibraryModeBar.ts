/* eslint-disable @typescript-eslint/no-unnecessary-type-assertion, @typescript-eslint/no-redundant-type-constituents -- Obsidian's dynamic API requires compatibility assertions; matching enable at end of file */
/**
 * Library content mode (Browse / Story Graph) — shared across Characters,
 * Locations, and Codex category pages.
 */
import * as obsidian from 'obsidian';
import { Menu, Modal, Notice, Setting, TFile, normalizePath } from 'obsidian';
import type SceneCardsPlugin from '../main';
import {
    RELATION_CATEGORIES,
    type CharacterRelation,
    type CharacterRelationCategory,
    computeReciprocalUpdates,
    normalizeCharacterRelations,
} from '../models/Character';
import {
    DEFAULT_STORY_GRAPH_ENTITY_FILLS,
    STORY_GRAPH_ENTITY_TYPES,
    StoryGraph,
    defaultLibraryCategoryFill,
    normalizeStoryGraphHexColor,
    normalizeStoryGraphRelationCategory,
    resolveLibraryCategoryNodeColors,
    resolveStoryGraphEntityColors,
    type StoryGraphConnectNode,
    type StoryGraphDocument,
    type StoryGraphEntityColorMap,
    type StoryGraphFilterState,
    type StoryGraphLayoutState,
    type StoryGraphLibraryCategoryColorMap,
    type StoryGraphLibraryCategoryLegend,
    type StoryGraphLinkEdgeInfo,
    type StoryGraphRelationArrow,
    type StoryGraphRelationCategory,
    type StoryGraphWikilink,
} from './StoryGraph';
import { resolveLibraryCategoryLabel } from '../services/LibraryCategorySync';
import {
    BUILTIN_CODEX_CATEGORIES,
    UNCATEGORIZED_CATEGORY_ID,
    getBuiltinCodexCategory,
} from '../models/Codex';
import type { RelationshipEdgeInfo, RelationshipType } from './RelationshipMap';
import {
    openStoryGraphRelationFocus,
    type StoryGraphFocusEdge,
} from './StoryGraphFocusView';
import { isMobile } from './MobileAdapter';
import { pickImage, resolveImagePath } from './ImagePicker';
import { ensureWikilink, waitForResolvedWikilink } from '../utils/perceptions';
import {
    assignStoryGraphLinkCategory,
    clearStoryRefsBetween,
    collectLinkRelationAssignments,
    migrateLinkAssignmentsToFrontmatter,
    pruneOrphanStoryRefs,
    removeStoryGraphLinkEdge,
    removeWikilinksBetween,
} from '../utils/storyGraphRefs';
import {
    normalizeStoryGraphFocusBundle,
    storyGraphPairKey,
    type StoryGraphFocusBundle,
} from '../utils/storyGraphStrands';
import { openConfirmModal } from './ConfirmModal';
import {
    DEFAULT_RELATION_TYPE_BY_CATEGORY,
    displayCharacterRelationLabel,
    ensureSeededCharacterRelationTypes,
    isCharacterRelationTypeInUse,
    makeCharacterRelationTypeId,
    mergeCharacterRelationTypes,
    normalizeCharacterRelationType,
    type StoryGraphCharacterRelationType,
} from '../utils/storyGraphCharacterRelations';
import { localizeForLanguage, seedUiLanguage, t } from '../utils/i18n';
import { resolveLibraryEntityName } from '../utils/libraryEntityName';

export type LibraryContentMode = 'browse' | 'story-graph';

export interface LibraryProfileModeAction {
    label: string;
    active: boolean;
    onClick: () => void;
}

const DEFAULT_FILTERS: StoryGraphFilterState = {
    showScenes: true,
    showCharacters: true,
    showLocations: true,
    showCodex: true,
    showRelationships: true,
    showProps: true,
    showOther: true,
};

/** Session state living on the plugin instance. */
export function getLibraryContentMode(plugin: SceneCardsPlugin): LibraryContentMode {
    const p = plugin as SceneCardsPlugin & { libraryContentMode?: LibraryContentMode };
    if (isMobile) return 'browse';
    return p.libraryContentMode === 'story-graph' ? 'story-graph' : 'browse';
}

export function setLibraryContentMode(plugin: SceneCardsPlugin, mode: LibraryContentMode): void {
    (plugin as SceneCardsPlugin & { libraryContentMode?: LibraryContentMode }).libraryContentMode = mode;
}

export function getStoryGraphFilters(plugin: SceneCardsPlugin): StoryGraphFilterState {
    const p = plugin as SceneCardsPlugin & { libraryStoryGraphFilters?: StoryGraphFilterState };
    return { ...DEFAULT_FILTERS, ...(p.libraryStoryGraphFilters || {}) };
}

export function setStoryGraphFilters(plugin: SceneCardsPlugin, filters: StoryGraphFilterState): void {
    (plugin as SceneCardsPlugin & { libraryStoryGraphFilters?: StoryGraphFilterState }).libraryStoryGraphFilters = { ...filters };
}

/**
 * Browse / Story Graph toggle — sits on the shared Library chrome bar.
 */
export function renderLibraryModeToggle(
    parent: HTMLElement,
    plugin: SceneCardsPlugin,
    onChange: () => void,
    profileMode?: LibraryProfileModeAction,
): HTMLElement | null {
    if (isMobile && !profileMode) return null;

    const mode = getLibraryContentMode(plugin);
    const toggle = parent.createDiv('library-mode-toggle character-mode-toggle');

    if (profileMode) {
        const profileBtn = toggle.createEl('button', {
            cls: `character-mode-btn ${profileMode.active ? 'active' : ''}`,
            attr: { 'data-mode': 'profile', 'aria-label': profileMode.label },
        });
        const profileIcon = profileBtn.createSpan();
        obsidian.setIcon(profileIcon, 'contact-round');
        profileBtn.createSpan({ text: profileMode.label });
        profileBtn.addEventListener('click', () => {
            if (profileMode.active) return;
            profileMode.onClick();
        });
    }

    const browseBtn = toggle.createEl('button', {
        cls: `character-mode-btn ${mode === 'browse' && !profileMode?.active ? 'active' : ''}`,
        attr: { 'data-mode': 'browse', 'aria-label': t('Browse') },
    });
    const browseIcon = browseBtn.createSpan();
    obsidian.setIcon(browseIcon, 'layout-grid');
    browseBtn.createSpan({ text: t(' Browse') });
    browseBtn.addEventListener('click', () => {
        if (getLibraryContentMode(plugin) === 'browse' && !profileMode?.active) return;
        setLibraryContentMode(plugin, 'browse');
        onChange();
    });

    if (!isMobile) {
        const graphBtn = toggle.createEl('button', {
            cls: `character-mode-btn ${mode === 'story-graph' ? 'active' : ''}`,
            attr: { 'data-mode': 'story-graph', 'aria-label': t('Story Graph') },
        });
        const graphIcon = graphBtn.createSpan();
        obsidian.setIcon(graphIcon, 'share-2');
        graphBtn.createSpan({ text: t(' Story Graph') });
        graphBtn.addEventListener('click', () => {
            if (getLibraryContentMode(plugin) === 'story-graph') return;
            setLibraryContentMode(plugin, 'story-graph');
            onChange();
        });
    }

    return toggle;
}

function storyGraphLayoutKey(plugin: SceneCardsPlugin): string {
    return plugin.sceneManager.activeProject?.filePath || '__global__';
}

function getStoryGraphLayout(plugin: SceneCardsPlugin): StoryGraphLayoutState | undefined {
    const layouts = plugin.settings.storyGraphLayouts || {};
    return layouts[storyGraphLayoutKey(plugin)];
}

async function saveStoryGraphLayout(
    plugin: SceneCardsPlugin,
    layout: StoryGraphLayoutState,
): Promise<void> {
    const key = storyGraphLayoutKey(plugin);
    plugin.settings.storyGraphLayouts = {
        ...(plugin.settings.storyGraphLayouts || {}),
        [key]: layout,
    };
    await plugin.saveSettings();
}

function collectStoryGraphImageMap(plugin: SceneCardsPlugin): Record<string, string> {
    const map: Record<string, string> = {};
    const put = (filePath: string | undefined, image: string | undefined) => {
        if (!filePath || !image?.trim()) return;
        map[normalizePath(filePath)] = image.trim();
    };
    for (const character of plugin.characterManager.getAllCharacters()) {
        put(character.filePath, character.image);
    }
    for (const world of plugin.locationManager.getAllWorlds()) {
        put(world.filePath, world.image);
    }
    for (const location of plugin.locationManager.getAllLocations()) {
        put(location.filePath, location.image);
    }
    for (const entry of plugin.codexManager.getAllEntries()) {
        put(entry.filePath, entry.image);
    }
    return map;
}

function collectStoryGraphDocuments(
    plugin: SceneCardsPlugin,
    scenes: ReturnType<SceneCardsPlugin['sceneManager']['getAllScenes']>,
    characters: ReturnType<SceneCardsPlugin['characterManager']['getAllCharacters']>,
): StoryGraphDocument[] {
    const documents = new Map<string, StoryGraphDocument>();
    const add = (document: StoryGraphDocument) => {
        if (!document.filePath) return;
        const filePath = normalizePath(document.filePath);
        documents.set(filePath, { ...document, filePath });
    };

    for (const scene of scenes) {
        add({
            filePath: scene.filePath,
            label: scene.title || t('Untitled'),
            entityType: 'scene',
        });
    }
    for (const character of characters) {
        add({
            filePath: character.filePath,
            label: resolveLibraryEntityName(character.name, character.filePath),
            entityType: 'character',
            image: character.image,
        });
    }
    for (const world of plugin.locationManager.getAllWorlds()) {
        add({
            filePath: world.filePath,
            label: resolveLibraryEntityName(world.name, world.filePath),
            entityType: 'location',
            image: world.image,
        });
    }
    for (const location of plugin.locationManager.getAllLocations()) {
        add({
            filePath: location.filePath,
            label: resolveLibraryEntityName(location.name, location.filePath),
            entityType: 'location',
            image: location.image,
        });
    }
    for (const entry of plugin.codexManager.getAllEntries()) {
        add({
            filePath: entry.filePath,
            label: resolveLibraryEntityName(entry.name, entry.filePath),
            entityType: 'codex',
            libraryCategoryId: entry.type,
            image: entry.image,
        });
    }
    return Array.from(documents.values());
}

/**
 * Legend chips that mirror Library category manager / tabs
 * (Skills, Characters, Locations, Uncategorized, …) in saved order.
 * Source of truth = enabled Library categories (+ Characters / Locations),
 * not a separate Story Graph type list.
 */
export function collectStoryGraphLegendLibraryCategories(
    plugin: SceneCardsPlugin,
): StoryGraphLibraryCategoryLegend[] {
    const hidden = new Set(plugin.settings.libraryHiddenFixedCategories || []);
    const order = plugin.settings.libraryCategoryOrder || [];
    const enabled = new Set(plugin.settings.codexEnabledCategories || []);
    const items: StoryGraphLibraryCategoryLegend[] = [];
    const seen = new Set<string>();

    const push = (item: StoryGraphLibraryCategoryLegend) => {
        if (seen.has(item.id) || hidden.has(item.id)) return;
        seen.add(item.id);
        items.push(item);
    };

    push({
        id: 'characters',
        label: resolveLibraryCategoryLabel(plugin, 'characters', 'Characters'),
        focus: 'character',
    });
    push({
        id: 'locations',
        label: resolveLibraryCategoryLabel(plugin, 'locations', 'Locations'),
        focus: 'location',
    });

    const pushLibraryCategory = (id: string, fallbackLabel: string) => {
        if (
            id === UNCATEGORIZED_CATEGORY_ID
            || id === 'characters'
            || id === 'locations'
        ) return;
        if (!enabled.has(id) && !plugin.codexManager.getCategoryDef(id)) return;
        push({
            id,
            label: resolveLibraryCategoryLabel(plugin, id, fallbackLabel),
            focus: 'library',
        });
    };

    // Live Codex manager first (folder labels applied).
    for (const category of plugin.codexManager.getCategories()) {
        pushLibraryCategory(category.id, category.label);
    }

    // Settings-backed customs / builtins (covers brand-new categories before reload).
    for (const custom of plugin.settings.codexCustomCategories || []) {
        if (!enabled.has(custom.id)) continue;
        pushLibraryCategory(custom.id, custom.label || custom.id);
    }
    for (const id of enabled) {
        const builtin = getBuiltinCodexCategory(id)
            || BUILTIN_CODEX_CATEGORIES.find(c => c.id === id);
        if (!builtin) continue;
        pushLibraryCategory(id, builtin.label);
    }

    // Project Library folder map — keep node types aligned with vault subfolders.
    const folders = plugin.sceneManager.activeProject?.libraryFolders || {};
    for (const [id, folderName] of Object.entries(folders)) {
        if (!folderName?.trim()) continue;
        if (!enabled.has(id) && id !== 'characters' && id !== 'locations') continue;
        pushLibraryCategory(id, folderName.trim());
    }

    push({
        id: UNCATEGORIZED_CATEGORY_ID,
        label: resolveLibraryCategoryLabel(
            plugin,
            UNCATEGORIZED_CATEGORY_ID,
            t('Uncategorized entries'),
        ),
        focus: 'library',
    });

    const orderIndex = new Map(order.map((id, index) => [id, index]));
    items.sort((a, b) => {
        const ai = orderIndex.get(a.id);
        const bi = orderIndex.get(b.id);
        if (ai === undefined && bi === undefined) return 0;
        if (ai === undefined) return 1;
        if (bi === undefined) return -1;
        return ai - bi;
    });
    return items;
}

/**
 * Seed default node colors for current Library categories and drop orphans.
 * Keeps Story Graph 「节点颜色」 in lockstep with Library tabs / subfolders.
 */
export function syncStoryGraphLibraryNodeTypes(plugin: SceneCardsPlugin): boolean {
    const libraryCats = collectStoryGraphLegendLibraryCategories(plugin)
        .filter(category => category.focus === 'library');
    const keep = new Set(libraryCats.map(category => category.id));
    const prev = plugin.settings.storyGraphLibraryCategoryColors || {};
    const next: StoryGraphLibraryCategoryColorMap = {};
    const defaultBorder = resolveStoryGraphEntityColors(
        plugin.settings.storyGraphEntityColors,
    ).codex.border;
    let dirty = false;

    libraryCats.forEach((category, index) => {
        const existing = prev[category.id];
        if (existing?.fill) {
            next[category.id] = {
                fill: existing.fill,
                border: existing.border || defaultBorder,
            };
            if (!existing.border) dirty = true;
        } else {
            next[category.id] = {
                fill: defaultLibraryCategoryFill(category.id, index),
                border: defaultBorder,
            };
            dirty = true;
        }
    });
    for (const id of Object.keys(prev)) {
        if (!keep.has(id)) dirty = true;
    }
    if (!dirty && Object.keys(prev).length === Object.keys(next).length) {
        return false;
    }
    plugin.settings.storyGraphLibraryCategoryColors = next;
    return true;
}

function collectStoryGraphWikilinks(
    plugin: SceneCardsPlugin,
    documents: StoryGraphDocument[],
): StoryGraphWikilink[] {
    const knownPaths = new Set(documents.map(document => normalizePath(document.filePath)));
    const links: StoryGraphWikilink[] = [];
    const seen = new Set<string>();
    const add = (sourcePath: string, targetPath: string) => {
        const src = normalizePath(sourcePath);
        const tgt = normalizePath(targetPath);
        if (!knownPaths.has(tgt) || tgt === src) return;
        const key = `${src}=>${tgt}`;
        if (seen.has(key)) return;
        seen.add(key);
        links.push({ sourcePath: src, targetPath: tgt });
    };

    const resolvedLinks = plugin.app.metadataCache.resolvedLinks;
    for (const document of documents) {
        const sourcePath = normalizePath(document.filePath);
        const targets = resolvedLinks[sourcePath] || {};
        for (const rawTargetPath of Object.keys(targets)) {
            add(sourcePath, rawTargetPath);
        }

        // Also walk the file cache — freshly written [[links]] often appear here
        // before resolvedLinks is fully rebuilt.
        const file = plugin.app.vault.getAbstractFileByPath(sourcePath);
        if (!(file instanceof TFile)) continue;
        const cache = plugin.app.metadataCache.getFileCache(file);
        for (const link of cache?.links || []) {
            const dest = plugin.app.metadataCache.getFirstLinkpathDest(link.link, sourcePath);
            if (dest) add(sourcePath, dest.path);
        }
    }
    return links;
}

/**
 * Mount the Story Graph into a Library content pane.
 * Returns the graph instance (caller should destroy on re-render).
 */
export function renderLibraryStoryGraph(
    container: HTMLElement,
    plugin: SceneCardsPlugin,
    onRefresh: () => void,
): StoryGraph {
    container.empty();
    container.addClass('story-graph-page');
    container.createEl('h3', { cls: 'story-graph-title', text: t('Story Graph') });
    container.createEl('p', {
        cls: 'setting-item-description story-graph-description',
        text: t('Body wikilinks are default references. Right-click an edge to set a category (written to frontmatter), focus strands, or delete the link entirely (clears body + frontmatter on both notes).'),
    });

    const scenes = plugin.sceneManager.getAllScenes().filter(s => !s.inactive);
    const characters = plugin.characterManager.getAllCharacters();
    const scanner = plugin.linkScanner;
    scanner.rebuildLookups(plugin.settings.characterAliases);
    const scanResults = scanner.scanAll(scenes);
    const documents = collectStoryGraphDocuments(plugin, scenes, characters);
    const wikilinks = collectStoryGraphWikilinks(plugin, documents);
    const relationCategories = plugin.settings.storyGraphRelationCategories || [];
    const wikilinkKeys = new Set(wikilinks.map(l => `${l.sourcePath}=>${l.targetPath}`));
    const docPaths = documents.map(d => d.filePath);
    const { assignments: relationAssignments, settingsDirty: assignmentsDirty } =
        collectLinkRelationAssignments(plugin, docPaths, wikilinkKeys);
    if (assignmentsDirty) {
        plugin.settings.storyGraphLinkRelationAssignments = relationAssignments;
        void plugin.saveSettings();
    }
    const pathToLabel = new Map(documents.map(d => [normalizePath(d.filePath), d.label]));
    // Keep notes ↔ graph in sync: migrate legacy settings-only categories into
    // frontmatter, and drop storyRefs whose body wikilinks were removed.
    void (async () => {
        await migrateLinkAssignmentsToFrontmatter(plugin, pathToLabel, wikilinkKeys);
        await pruneOrphanStoryRefs(plugin, docPaths, wikilinkKeys);
    })();

    const graphContainer = container.createDiv('story-graph-container');
    let focusHost: HTMLElement | null = null;
    const openFocus = (edge: StoryGraphFocusEdge) => {
        if (focusHost) {
            focusHost.remove();
            focusHost = null;
        }
        focusHost = container.createDiv('story-graph-focus-host');
        openStoryGraphRelationFocus(
            focusHost,
            plugin,
            edge,
            () => {
                focusHost?.remove();
                focusHost = null;
                graphContainer.removeClass('is-focus-hidden');
                onRefresh();
            },
            () => {
                // Keep focus open; host refresh happens on close.
            },
        );
        graphContainer.addClass('is-focus-hidden');
    };

    const focusBundles: Record<string, StoryGraphFocusBundle> = {};
    for (const [key, raw] of Object.entries(plugin.settings.storyGraphFocusBundles || {})) {
        const bundle = normalizeStoryGraphFocusBundle(raw);
        if (bundle) focusBundles[key] = bundle;
    }

    const seedLang = seedUiLanguage(plugin.app);
    // Fire-and-forget persist on first empty install; merge uses Obsidian seed lang.
    void ensureSeededCharacterRelationTypes(plugin, characters);
    const characterRelationTypes = mergeCharacterRelationTypes(
        plugin.settings.storyGraphCharacterRelationTypes,
        characters,
        seedLang,
    );

    const openFocusFromRelation = (edge: RelationshipEdgeInfo) => {
        const from = characters.find(c => c.name === edge.from)
            || plugin.characterManager.findByName(edge.from);
        const to = characters.find(c => c.name === edge.to)
            || plugin.characterManager.findByName(edge.to);
        if (!from?.filePath || !to?.filePath) {
            new Notice(t('Both endpoints need vault files to open focus view.'));
            return;
        }
        const style = characterRelationTypes.find(
            s => s.id === edge.styleId || s.category === edge.styleId || s.baseType === edge.type,
        );
        openFocus({
            left: { name: from.name, filePath: from.filePath, image: from.image },
            right: { name: to.name, filePath: to.filePath, image: to.image },
            parentId: `char:${style?.id || edge.styleId || edge.type}`,
            parentLabel: style ? displayCharacterRelationLabel(style) : edge.type,
            parentColor: style?.color,
        });
    };

    const openFocusFromLink = (edge: StoryGraphLinkEdgeInfo) => {
        const cat = edge.relationCategoryId
            ? relationCategories.find(c => c.id === edge.relationCategoryId)
            : undefined;
        openFocus({
            left: { name: edge.from, filePath: edge.sourcePath },
            right: { name: edge.to, filePath: edge.targetPath },
            parentId: cat ? `link:${cat.id}` : 'link:default',
            parentLabel: cat?.label || t('Default link'),
            parentColor: cat?.color,
        });
    };

    const connectNodes = async (
        from: StoryGraphConnectNode,
        to: StoryGraphConnectNode,
        mode: 'wikilink' | RelationshipType | string,
    ) => {
        if (mode === 'wikilink') {
            try {
                const added = await ensureWikilink(
                    plugin.app,
                    from.filePath,
                    to.label,
                    to.filePath,
                );
                // Wait for Obsidian to resolve the link so the next graph rebuild
                // can draw the edge as「默认引用」instead of looking unchanged.
                if (to.filePath) {
                    await waitForResolvedWikilink(plugin.app, from.filePath, to.filePath);
                } else {
                    await new Promise<void>(r => window.setTimeout(r, 120));
                }
                new Notice(added ? t('Wikilink added') : t('Wikilink already present'));
                onRefresh();
            } catch (e) {
                console.error('[NarrativeLab] ensureWikilink failed', e);
                new Notice(t('Failed to add wikilink'));
            }
            return;
        }
        const style = characterRelationTypes.find(s => s.id === mode || s.baseType === mode);
        await updateCharacterRelation(
            plugin,
            from.label,
            to.label,
            style?.baseType || (mode as RelationshipType),
            style ? { id: style.id, category: style.category } : undefined,
        ).then(onRefresh);
    };

    const attachmentFolder = plugin.sceneManager.activeProject?.filePath
        || plugin.sceneManager.getSceneFolder()
        || '';

    const graph = new StoryGraph(
        graphContainer,
        scenes,
        characters,
        scanResults,
        (filePath: string) => {
            const file = plugin.app.vault.getAbstractFileByPath(filePath);
            if (file) void plugin.app.workspace.openLinkText(filePath, '', true);
        },
        plugin.settings.tagTypeOverrides,
        (edge, evt) => showRelationEdgeMenu(plugin, edge, evt, onRefresh, openFocusFromRelation),
        getStoryGraphFilters(plugin),
        (filters) => setStoryGraphFilters(plugin, filters),
        documents,
        wikilinks,
        relationCategories,
        relationAssignments,
        (edge, evt) => showStoryGraphLinkEdgeMenu(plugin, edge, evt, onRefresh, openFocusFromLink),
        () => openStoryGraphRelationCategoriesModal(plugin, onRefresh),
        (edge) => openFocus(edge),
        connectNodes,
        {
            layout: getStoryGraphLayout(plugin),
            imageByPath: collectStoryGraphImageMap(plugin),
            resolveImageUrl: (imagePath) => resolveImagePath(plugin.app, imagePath),
            onLayoutChange: (layout) => saveStoryGraphLayout(plugin, layout),
            onPickNodeImage: async (_node, current) => pickImage(plugin.app, attachmentFolder, current),
            focusBundles,
            characterRelationTypes,
            entityColors: plugin.settings.storyGraphEntityColors || {},
            libraryCategoryColors: plugin.settings.storyGraphLibraryCategoryColors || {},
            libraryCategories: collectStoryGraphLegendLibraryCategories(plugin),
            // Legend right-click always opens the full Relation categories modal
            // (node colors + character relations + wikilink categories) — no per-type popup.
            onLegendEditEntity: () => openStoryGraphRelationCategoriesModal(plugin, onRefresh),
            onLegendEditCharRelation: () => openStoryGraphRelationCategoriesModal(plugin, onRefresh),
            onLegendEditLinkCategory: () => openStoryGraphRelationCategoriesModal(plugin, onRefresh),
            // Left-click + → add a general graph relation; right-click → full add menu.
            onLegendAdd: () => openNewStoryGraphRelationCategoryModal(plugin, async () => onRefresh()),
            onLegendAddMenu: (evt) => showStoryGraphLegendAddMenu(plugin, onRefresh, evt),
        },
    );
    graph.render();
    return graph;
}

/** Legend “+” — add a general relation, a character-only relation, or open the manager. */
function showStoryGraphLegendAddMenu(
    plugin: SceneCardsPlugin,
    onDone: () => void,
    evt?: MouseEvent,
): void {
    const menu = new Menu();
    menu.addItem(item => {
        item.setTitle(t('Add relation'));
        item.setIcon('link');
        item.onClick(() => openNewStoryGraphRelationCategoryModal(plugin, async () => {
            onDone();
        }));
    });
    menu.addItem(item => {
        item.setTitle(t('Add character relation'));
        item.setIcon('heart-handshake');
        item.onClick(() => openQuickAddCharacterRelationModal(plugin, onDone));
    });
    menu.addSeparator();
    menu.addItem(item => {
        item.setTitle(t('Manage all…'));
        item.setIcon('tags');
        item.onClick(() => openStoryGraphRelationCategoriesModal(plugin, onDone));
    });
    // Anchor to the + button (more reliable than showAtMouseEvent inside leaf views).
    const anchor = evt?.currentTarget instanceof HTMLElement
        ? evt.currentTarget
        : evt?.target instanceof HTMLElement
            ? evt.target.closest('button')
            : null;
    if (anchor) {
        const rect = anchor.getBoundingClientRect();
        menu.showAtPosition({ x: Math.round(rect.left), y: Math.round(rect.bottom + 4) });
        return;
    }
    if (evt) {
        menu.showAtMouseEvent(evt);
        return;
    }
    menu.showAtPosition({ x: Math.round(window.innerWidth / 2 - 80), y: 120 });
}

function openQuickAddCharacterRelationModal(
    plugin: SceneCardsPlugin,
    onDone: () => void,
    applyTo?: { from: string; to: string },
): void {
    const modal = new Modal(plugin.app);
    modal.titleEl.setText(t('Add character relation'));
    const seedLang = seedUiLanguage(plugin.app);
    let label = localizeForLanguage(seedLang, 'New relation');
    let color = '#6C7AE0';
    let arrow: 'single' | 'double' = 'double';

    new Setting(modal.contentEl)
        .setName(t('Name'))
        .addText(text => {
            text.setValue(label);
            text.onChange(v => { label = v; });
            window.setTimeout(() => {
                text.inputEl.focus();
                text.inputEl.select();
            }, 40);
        });
    new Setting(modal.contentEl)
        .setName(t('Color'))
        .addColorPicker(picker => picker.setValue(color).onChange(v => { color = v; }));
    new Setting(modal.contentEl)
        .setName(t('Arrow style'))
        .addDropdown(drop => drop
            .addOption('single', t('Single arrow'))
            .addOption('double', t('Double arrow'))
            .setValue(arrow)
            .onChange(v => { arrow = v === 'double' ? 'double' : 'single'; }));
    new Setting(modal.contentEl)
        .addButton(btn => btn
            .setButtonText(t('Add'))
            .setCta()
            .onClick(async () => {
                const name = label.trim();
                if (!name) {
                    new Notice(t('Please enter a name'));
                    return;
                }
                const id = makeCharacterRelationTypeId(name);
                const next = normalizeCharacterRelationType({
                    id,
                    label: name,
                    color,
                    arrow,
                    baseType: 'other',
                    category: 'custom',
                    builtin: false,
                });
                if (!next) return;
                const merged = mergeCharacterRelationTypes(
                    plugin.settings.storyGraphCharacterRelationTypes,
                    plugin.characterManager.getAllCharacters(),
                    seedLang,
                );
                plugin.settings.storyGraphCharacterRelationTypes = [
                    ...merged.filter(s => s.id !== next.id),
                    next,
                ];
                await plugin.saveSettings();
                if (applyTo) {
                    await updateCharacterRelation(
                        plugin,
                        applyTo.from,
                        applyTo.to,
                        next.baseType,
                        { id: next.id, category: next.category },
                    );
                }
                modal.close();
                onDone();
            }));
    modal.open();
}

/** Right-click a relationship edge → change type or delete. */
export function showRelationEdgeMenu(
    plugin: SceneCardsPlugin,
    edge: RelationshipEdgeInfo,
    evt: MouseEvent,
    onDone: () => void,
    onFocus?: (edge: RelationshipEdgeInfo) => void,
): void {
    const menu = new Menu();
    const styles = mergeCharacterRelationTypes(
        plugin.settings.storyGraphCharacterRelationTypes,
        plugin.characterManager.getAllCharacters(),
        seedUiLanguage(plugin.app),
    );

    menu.addItem(item => {
        item.setTitle(`${edge.from} ↔ ${edge.to}`);
        item.setDisabled(true);
    });
    menu.addSeparator();
    if (onFocus) {
        menu.addItem(item => {
            item.setTitle(t('Focus relationship'));
            item.setIcon('scan-eye');
            item.onClick(() => onFocus(edge));
        });
        menu.addSeparator();
    }

    for (const style of styles) {
        menu.addItem(item => {
            item.setTitle(displayCharacterRelationLabel(style));
            if (edge.styleId
                ? style.id === edge.styleId
                : (style.baseType === edge.type || style.id === edge.type)) {
                item.setChecked(true);
            }
            item.onClick(() => {
                void updateCharacterRelation(
                    plugin,
                    edge.from,
                    edge.to,
                    style.baseType,
                    { id: style.id, category: style.category },
                ).then(onDone);
            });
        });
    }

    menu.addSeparator();
    menu.addItem(item => {
        item.setTitle(t('Remove relationship'));
        item.setIcon('trash');
        item.onClick(() => {
            void updateCharacterRelation(plugin, edge.from, edge.to, null).then(onDone);
        });
    });

    menu.showAtMouseEvent(evt);
}

/** Right-click a real Obsidian wikilink edge → category / focus / full delete. */
export function showStoryGraphLinkEdgeMenu(
    plugin: SceneCardsPlugin,
    edge: StoryGraphLinkEdgeInfo,
    evt: MouseEvent,
    onDone: () => void,
    onFocus?: (edge: StoryGraphLinkEdgeInfo) => void,
): void {
    const menu = new Menu();
    const categories = plugin.settings.storyGraphRelationCategories || [];
    const assignments = plugin.settings.storyGraphLinkRelationAssignments || {};
    const current = assignments[edge.key];
    const fromChar = plugin.characterManager.findByName(edge.from);
    const toChar = plugin.characterManager.findByName(edge.to);
    const bothCharacters = !!(fromChar && toChar);
    const charStyles = bothCharacters
        ? mergeCharacterRelationTypes(
            plugin.settings.storyGraphCharacterRelationTypes,
            plugin.characterManager.getAllCharacters(),
            seedUiLanguage(plugin.app),
        )
        : [];
    const currentCharRel = bothCharacters && fromChar
        ? normalizeCharacterRelations(fromChar.relations).find(
            r => r.target.toLowerCase() === edge.to.toLowerCase(),
        )
        : undefined;

    menu.addItem(item => {
        item.setTitle(`${edge.from} → ${edge.to}`);
        item.setDisabled(true);
    });
    menu.addSeparator();
    if (onFocus) {
        menu.addItem(item => {
            item.setTitle(t('Focus relationship'));
            item.setIcon('scan-eye');
            item.onClick(() => onFocus(edge));
        });
        menu.addSeparator();
    }
    if (bothCharacters) {
        menu.addItem(item => {
            item.setTitle(t('Character relations'));
            item.setDisabled(true);
        });
        for (const style of charStyles) {
            menu.addItem(item => {
                item.setTitle(displayCharacterRelationLabel(style));
                if (currentCharRel && (
                    style.id === currentCharRel.type
                    || style.baseType === currentCharRel.type
                )) {
                    item.setChecked(true);
                }
                item.onClick(() => {
                    void updateCharacterRelation(
                        plugin,
                        edge.from,
                        edge.to,
                        style.baseType,
                        { id: style.id, category: style.category },
                    ).then(onDone);
                });
            });
        }
        menu.addItem(item => {
            item.setTitle(t('Add character relation'));
            item.setIcon('heart-handshake');
            item.onClick(() => openQuickAddCharacterRelationModal(
                plugin,
                onDone,
                { from: edge.from, to: edge.to },
            ));
        });
        if (currentCharRel) {
            menu.addItem(item => {
                item.setTitle(t('Remove relationship'));
                item.setIcon('unlink');
                item.onClick(() => {
                    void updateCharacterRelation(plugin, edge.from, edge.to, null).then(onDone);
                });
            });
        }
        menu.addSeparator();
    }
    menu.addItem(item => {
        item.setTitle(t('Default link'));
        if (!current) item.setChecked(true);
        item.onClick(async () => {
            // Default = body wikilink only; clear special frontmatter annotation.
            await assignStoryGraphLinkCategory(plugin, edge, null);
            onDone();
        });
    });
    for (const category of categories) {
        menu.addItem(item => {
            item.setTitle(category.label);
            if (current === category.id) item.setChecked(true);
            item.onClick(async () => {
                await assignStoryGraphLinkCategory(plugin, edge, {
                    id: category.id,
                    label: category.label,
                });
                onDone();
            });
        });
    }
    menu.addSeparator();
    menu.addItem(item => {
        item.setTitle(t('New relation category…'));
        item.setIcon('plus');
        item.onClick(() => openNewStoryGraphRelationCategoryModal(plugin, async category => {
            await assignStoryGraphLinkCategory(plugin, edge, {
                id: category.id,
                label: category.label,
            });
            onDone();
        }));
    });
    menu.addItem(item => {
        item.setTitle(t('Manage relation categories'));
        item.setIcon('tags');
        item.onClick(() => openStoryGraphRelationCategoriesModal(plugin, onDone));
    });
    menu.addSeparator();
    menu.addItem(item => {
        item.setTitle(t('Remove link'));
        item.setIcon('trash');
        item.onClick(() => {
            openConfirmModal(plugin.app, {
                title: t('Remove link'),
                message: t(
                    'Remove all body wikilinks and annotated references between "{from}" and "{to}"?',
                    { from: edge.from, to: edge.to },
                ),
                confirmLabel: t('Remove link'),
                confirmClass: 'mod-warning',
                onConfirm: async () => {
                    try {
                        await removeStoryGraphLinkEdge(plugin, edge);
                        new Notice(t('Link removed'));
                        onDone();
                    } catch (e) {
                        console.error('[NarrativeLab] removeStoryGraphLinkEdge failed', e);
                        new Notice(t('Failed to remove link'));
                    }
                },
            });
        });
    });
    menu.showAtMouseEvent(evt);
}

function makeRelationCategoryId(label: string): string {
    const slug = label.trim().toLowerCase()
        .replace(/\s+/g, '-')
        .replace(/[^a-z0-9\u4e00-\u9fff-]/g, '');
    return slug || `relation-${Date.now().toString(36)}`;
}

function openNewStoryGraphRelationCategoryModal(
    plugin: SceneCardsPlugin,
    onCreated: (category: StoryGraphRelationCategory) => void | Promise<void>,
): void {
    const modal = new Modal(plugin.app);
    modal.titleEl.setText(t('Add relation'));
    const seedLang = seedUiLanguage(plugin.app);
    let label = localizeForLanguage(seedLang, 'New relation');
    let color = '#6C7AE0';
    let arrow: StoryGraphRelationArrow = 'single';

    new Setting(modal.contentEl)
        .setName(t('Name'))
        .addText(text => {
            text.setValue(label);
            text.onChange(value => { label = value; });
            window.setTimeout(() => {
                text.inputEl.focus();
                text.inputEl.select();
            }, 40);
        });
    new Setting(modal.contentEl)
        .setName(t('Color'))
        .addColorPicker(picker => picker
            .setValue(color)
            .onChange(value => { color = value; }));
    new Setting(modal.contentEl)
        .setName(t('Arrow style'))
        .setDesc(t('Single arrow follows the wikilink direction; double arrow is mutual.'))
        .addDropdown(drop => drop
            .addOption('single', t('Single arrow'))
            .addOption('double', t('Double arrow'))
            .setValue(arrow)
            .onChange(value => {
                arrow = value === 'double' ? 'double' : 'single';
            }));
    new Setting(modal.contentEl)
        .addButton(button => button
            .setButtonText(t('Create'))
            .setCta()
            .onClick(async () => {
                const name = label.trim();
                if (!name) {
                    new Notice(t('Please enter a name'));
                    return;
                }
                const categories = plugin.settings.storyGraphRelationCategories || [];
                let id = makeRelationCategoryId(name);
                if (categories.some(category => category.id === id)) {
                    id = `${id}-${Date.now().toString(36)}`;
                }
                const category = normalizeStoryGraphRelationCategory({ id, label: name, color, arrow });
                if (!category) return;
                plugin.settings.storyGraphRelationCategories = [...categories, category];
                await plugin.saveSettings();
                modal.close();
                await onCreated(category);
            }));
    modal.open();
}

/** Configure character relation styles + wikilink categories for the Story Graph. */
export function openStoryGraphRelationCategoriesModal(
    plugin: SceneCardsPlugin,
    onDone: () => void,
): void {
    const modal = new Modal(plugin.app);
    modal.titleEl.setText(t('Relation categories'));
    const seedLang = seedUiLanguage(plugin.app);
    void ensureSeededCharacterRelationTypes(plugin, plugin.characterManager.getAllCharacters());
    let charDraft: StoryGraphCharacterRelationType[] = mergeCharacterRelationTypes(
        plugin.settings.storyGraphCharacterRelationTypes,
        plugin.characterManager.getAllCharacters(),
        seedLang,
    );
    let linkDraft: StoryGraphRelationCategory[] = (plugin.settings.storyGraphRelationCategories || [])
        .map(category => normalizeStoryGraphRelationCategory(category))
        .filter((category): category is StoryGraphRelationCategory => !!category);
    const entityDraft: StoryGraphEntityColorMap = {};
    {
        const resolved = resolveStoryGraphEntityColors(plugin.settings.storyGraphEntityColors);
        for (const type of STORY_GRAPH_ENTITY_TYPES) {
            entityDraft[type] = {
                fill: resolved[type].fill,
                border: resolved[type].border,
            };
        }
    }
    // Align node-type rows with current Library categories / folders first.
    if (syncStoryGraphLibraryNodeTypes(plugin)) {
        void plugin.saveSettings();
    }
    const legendLibraryCats = collectStoryGraphLegendLibraryCategories(plugin);
    const libraryCats = legendLibraryCats.filter(category => category.focus === 'library');
    const libraryDraft: StoryGraphLibraryCategoryColorMap = {};
    {
        const saved = plugin.settings.storyGraphLibraryCategoryColors || {};
        libraryCats.forEach((category, index) => {
            const resolved = resolveLibraryCategoryNodeColors(
                category.id,
                index,
                saved,
                plugin.settings.storyGraphEntityColors,
            );
            libraryDraft[category.id] = {
                fill: resolved.fill,
                border: resolved.border,
            };
        });
    }
    const renderArrowSelect = (
        parent: HTMLElement,
        value: 'single' | 'double',
        onChange: (v: 'single' | 'double') => void,
    ) => {
        const arrowSelect = parent.createEl('select', {
            cls: 'dropdown story-graph-relation-arrow-select',
            attr: { 'aria-label': t('Arrow style') },
        }) as HTMLSelectElement;
        arrowSelect.createEl('option', { text: t('Single arrow'), attr: { value: 'single' } });
        arrowSelect.createEl('option', { text: t('Double arrow'), attr: { value: 'double' } });
        arrowSelect.value = value;
        arrowSelect.addEventListener('change', () => {
            onChange(arrowSelect.value === 'double' ? 'double' : 'single');
        });
        return arrowSelect;
    };

    const render = () => {
        const content = modal.contentEl;
        content.empty();
        content.addClass('story-graph-relation-manager');
        content.createEl('p', {
            cls: 'setting-item-description',
            text: t('Edit character relation styles (synced with character notes) and wikilink categories. Internal multi-strands are set in focus view.'),
        });

        content.createEl('h4', { text: t('Node colors') });
        content.createEl('p', {
            cls: 'setting-item-description',
            text: t('Scenes plus Library categories (same as tabs / Library subfolders). New Library categories appear here automatically.'),
        });
        const nodeColorList = content.createDiv('story-graph-entity-color-list');
        const nodeHeader = nodeColorList.createDiv(
            'story-graph-entity-color-row story-graph-entity-color-header',
        );
        nodeHeader.createSpan();
        nodeHeader.createSpan({ text: t('Type') });
        nodeHeader.createSpan({ text: t('Fill') });
        nodeHeader.createSpan({ text: t('Border') });
        const addColorRow = (
            label: string,
            style: { fill?: string; border?: string },
            fallbackFill: string,
            onChange: (next: { fill?: string; border?: string }) => void,
        ) => {
            const row = nodeColorList.createDiv('story-graph-entity-color-row');
            const swatch = row.createSpan({ cls: 'story-graph-entity-color-swatch' });
            const syncSwatch = () => {
                swatch.setCssStyles({
                    backgroundColor: style.fill || fallbackFill,
                    boxShadow: `inset 0 0 0 2px ${style.border || '#FFFFFF'}`,
                });
            };
            syncSwatch();
            row.createSpan({
                cls: 'story-graph-entity-color-label',
                text: label,
            });
            const fillInput = row.createEl('input', {
                attr: {
                    type: 'color',
                    value: style.fill || fallbackFill,
                    'aria-label': `${label} — ${t('Fill')}`,
                    title: t('Fill'),
                },
            }) as HTMLInputElement;
            fillInput.addEventListener('input', () => {
                style.fill = fillInput.value;
                onChange(style);
                syncSwatch();
            });
            const borderInput = row.createEl('input', {
                attr: {
                    type: 'color',
                    value: style.border || '#FFFFFF',
                    'aria-label': `${label} — ${t('Border')}`,
                    title: t('Border'),
                },
            }) as HTMLInputElement;
            borderInput.addEventListener('input', () => {
                style.border = borderInput.value;
                onChange(style);
                syncSwatch();
            });
        };

        // Same order as the graph legend: Scenes → Library categories (manager order)
        addColorRow(
            t('Scenes'),
            entityDraft.scene || {
                fill: DEFAULT_STORY_GRAPH_ENTITY_FILLS.scene,
                border: '#FFFFFF',
            },
            DEFAULT_STORY_GRAPH_ENTITY_FILLS.scene,
            (style) => { entityDraft.scene = style; },
        );
        legendLibraryCats.forEach((category, index) => {
            if (category.focus === 'character') {
                addColorRow(
                    category.label,
                    entityDraft.character || {
                        fill: DEFAULT_STORY_GRAPH_ENTITY_FILLS.character,
                        border: '#FFFFFF',
                    },
                    DEFAULT_STORY_GRAPH_ENTITY_FILLS.character,
                    (style) => { entityDraft.character = style; },
                );
                return;
            }
            if (category.focus === 'location') {
                addColorRow(
                    category.label,
                    entityDraft.location || {
                        fill: DEFAULT_STORY_GRAPH_ENTITY_FILLS.location,
                        border: '#FFFFFF',
                    },
                    DEFAULT_STORY_GRAPH_ENTITY_FILLS.location,
                    (style) => { entityDraft.location = style; },
                );
                return;
            }
            const style = libraryDraft[category.id] || {
                fill: defaultLibraryCategoryFill(category.id, index),
                border: '#FFFFFF',
            };
            libraryDraft[category.id] = style;
            addColorRow(
                category.label,
                style,
                defaultLibraryCategoryFill(category.id, index),
                (next) => { libraryDraft[category.id] = next; },
            );
        });
        new Setting(content)
            .addButton(button => button
                .setButtonText(t('Reset node colors'))
                .onClick(() => {
                    for (const type of STORY_GRAPH_ENTITY_TYPES) {
                        entityDraft[type] = {
                            fill: DEFAULT_STORY_GRAPH_ENTITY_FILLS[type],
                            border: resolveStoryGraphEntityColors({})[type].border,
                        };
                    }
                    const codexBorder = resolveStoryGraphEntityColors({}).codex.border;
                    libraryCats.forEach((category, index) => {
                        libraryDraft[category.id] = {
                            fill: defaultLibraryCategoryFill(category.id, index),
                            border: codexBorder,
                        };
                    });
                    render();
                }));

        content.createEl('h4', { text: t('Character relations') });
        content.createEl('p', {
            cls: 'setting-item-description',
            text: t('Legend matches library relation categories. Custom types sync with character profile relation entries.'),
        });
        const charList = content.createDiv('story-graph-relation-category-list');
        for (const style of charDraft) {
            const row = charList.createDiv('story-graph-relation-category-row is-character');
            const color = row.createEl('input', {
                attr: { type: 'color', value: style.color, 'aria-label': t('Color') },
            }) as HTMLInputElement;
            const name = row.createEl('input', {
                attr: {
                    type: 'text',
                    value: displayCharacterRelationLabel(style),
                    'aria-label': t('Name'),
                },
            }) as HTMLInputElement;
            if (!style.builtin) {
                const catSelect = row.createEl('select', {
                    cls: 'dropdown story-graph-relation-category-select',
                    attr: { 'aria-label': t('Relation category') },
                }) as HTMLSelectElement;
                for (const cat of RELATION_CATEGORIES) {
                    catSelect.createEl('option', {
                        text: t(cat.label),
                        attr: { value: cat.value },
                    });
                }
                catSelect.value = style.category || 'custom';
                catSelect.addEventListener('change', () => {
                    style.category = catSelect.value as CharacterRelationCategory;
                    style.baseType = (
                        style.category === 'social' ? 'ally'
                        : style.category === 'conflict' ? 'enemy'
                        : style.category === 'romantic' ? 'romantic'
                        : style.category === 'family' ? 'family'
                        : style.category === 'guidance' ? 'mentor'
                        : 'other'
                    );
                });
            } else {
                // Spacer keeps columns aligned with custom rows (category select).
                row.createSpan({ cls: 'story-graph-relation-category-spacer' });
            }
            renderArrowSelect(row, style.arrow, v => { style.arrow = v; });
            color.addEventListener('input', () => { style.color = color.value; });
            name.addEventListener('input', () => { style.label = name.value; });
            const characters = plugin.characterManager.getAllCharacters();
            const inUse = isCharacterRelationTypeInUse(style, characters);
            const remove = row.createEl('button', {
                attr: {
                    'aria-label': inUse
                        ? t('Cannot delete: used by character relations')
                        : t('Delete'),
                    title: inUse
                        ? t('Cannot delete: used by character relations')
                        : t('Delete'),
                },
            });
            obsidian.setIcon(remove, 'trash');
            remove.disabled = inUse;
            remove.addEventListener('click', () => {
                if (isCharacterRelationTypeInUse(style, plugin.characterManager.getAllCharacters())) {
                    new Notice(t('Cannot delete: used by character relations'));
                    return;
                }
                charDraft = charDraft.filter(item => item.id !== style.id);
                render();
            });
        }

        new Setting(content)
            .addButton(button => button
                .setButtonText(t('Add character relation'))
                .onClick(() => {
                    // Editable seed: Obsidian interface language at creation time.
                    const label = localizeForLanguage(seedLang, 'New relation');
                    const id = makeCharacterRelationTypeId(`${label}-${Date.now().toString(36)}`);
                    charDraft.push({
                        id,
                        label,
                        color: '#6C7AE0',
                        arrow: 'double',
                        baseType: 'other',
                        category: 'custom',
                        builtin: false,
                    });
                    render();
                    const inputs = modal.contentEl.querySelectorAll(
                        '.story-graph-relation-category-row.is-character input[type="text"]',
                    );
                    const last = inputs[inputs.length - 1] as HTMLInputElement | undefined;
                    last?.focus();
                    last?.select();
                }));

        content.createEl('h4', { text: t('Wikilink categories') });
        content.createEl('p', {
            cls: 'setting-item-description',
            text: t('Assign these to Obsidian wikilink edges via right-click on the graph.'),
        });
        const linkList = content.createDiv('story-graph-relation-category-list');
        const defaultRow = linkList.createDiv({
            cls: 'story-graph-relation-category-row is-default',
        });
        defaultRow.createSpan({ text: t('Default link') });
        defaultRow.createSpan({
            cls: 'story-graph-relation-arrow-hint',
            text: t('Single arrow'),
        });
        for (const category of linkDraft) {
            if (!category.arrow) category.arrow = 'single';
            const row = linkList.createDiv('story-graph-relation-category-row');
            const color = row.createEl('input', {
                attr: { type: 'color', value: category.color, 'aria-label': t('Color') },
            }) as HTMLInputElement;
            const name = row.createEl('input', {
                attr: { type: 'text', value: category.label, 'aria-label': t('Name') },
            }) as HTMLInputElement;
            renderArrowSelect(row, category.arrow === 'double' ? 'double' : 'single', v => {
                category.arrow = v;
            });
            color.addEventListener('input', () => { category.color = color.value; });
            name.addEventListener('input', () => { category.label = name.value; });
            const remove = row.createEl('button', { attr: { 'aria-label': t('Delete') } });
            obsidian.setIcon(remove, 'trash');
            remove.addEventListener('click', () => {
                linkDraft = linkDraft.filter(item => item.id !== category.id);
                render();
            });
        }

        new Setting(content)
            .addButton(button => button
                .setButtonText(t('Add wikilink category'))
                .onClick(() => {
                    linkDraft.push({
                        id: `relation-${Date.now().toString(36)}`,
                        label: localizeForLanguage(seedLang, 'New relation'),
                        color: '#6C7AE0',
                        arrow: 'single',
                    });
                    render();
                }));
        new Setting(content)
            .addButton(button => button
                .setButtonText(t('Save'))
                .setCta()
                .onClick(async () => {
                    const cleanLinks = linkDraft
                        .map(category => normalizeStoryGraphRelationCategory(category))
                        .filter((category): category is StoryGraphRelationCategory => !!category);
                    const cleanChars = charDraft
                        .map(style => {
                            // Player-editable labels stay as typed (including seeded zh/en).
                            if (!style.builtin && style.label.trim()) {
                                const trimmed = style.label.trim();
                                if (style.id.startsWith('char-rel-') || style.id.startsWith('新关联')) {
                                    style.id = makeCharacterRelationTypeId(trimmed);
                                }
                            }
                            return normalizeCharacterRelationType(style);
                        })
                        .filter((style): style is StoryGraphCharacterRelationType => !!style);
                    // Keep any still-applied styles (e.g. deleted from draft but used on notes).
                    const chars = plugin.characterManager.getAllCharacters();
                    for (const kept of mergeCharacterRelationTypes(cleanChars, chars, seedLang)) {
                        if (!cleanChars.some(c => c.id === kept.id) && isCharacterRelationTypeInUse(kept, chars)) {
                            cleanChars.push(kept);
                        }
                    }
                    const validIds = new Set(cleanLinks.map(category => category.id));
                    const assignments = plugin.settings.storyGraphLinkRelationAssignments || {};
                    for (const [key, categoryId] of Object.entries(assignments)) {
                        if (!validIds.has(categoryId)) delete assignments[key];
                    }
                    plugin.settings.storyGraphRelationCategories = cleanLinks;
                    plugin.settings.storyGraphLinkRelationAssignments = assignments;
                    plugin.settings.storyGraphCharacterRelationTypes = cleanChars;
                    const cleanEntity: StoryGraphEntityColorMap = {};
                    for (const type of STORY_GRAPH_ENTITY_TYPES) {
                        const style = entityDraft[type];
                        if (!style) continue;
                        cleanEntity[type] = {
                            fill: normalizeStoryGraphHexColor(
                                style.fill,
                                DEFAULT_STORY_GRAPH_ENTITY_FILLS[type],
                            ),
                            border: normalizeStoryGraphHexColor(
                                style.border,
                                resolveStoryGraphEntityColors({})[type].border,
                            ),
                        };
                    }
                    plugin.settings.storyGraphEntityColors = cleanEntity;
                    const cleanLibrary: StoryGraphLibraryCategoryColorMap = {};
                    const defaultBorder = resolveStoryGraphEntityColors({}).codex.border;
                    libraryCats.forEach((category, index) => {
                        const style = libraryDraft[category.id];
                        if (!style) return;
                        cleanLibrary[category.id] = {
                            fill: normalizeStoryGraphHexColor(
                                style.fill,
                                defaultLibraryCategoryFill(category.id, index),
                            ),
                            border: normalizeStoryGraphHexColor(style.border, defaultBorder),
                        };
                    });
                    plugin.settings.storyGraphLibraryCategoryColors = cleanLibrary;
                    await plugin.saveSettings();
                    modal.close();
                    onDone();
                }));
    };
    render();
    modal.open();
}

function relationFromMapType(
    mapType: RelationshipType,
    targetName: string,
    typeOverride?: { id: string; category?: CharacterRelationCategory },
): CharacterRelation {
    const defaults: Record<RelationshipType, { category: CharacterRelationCategory; type: string }> = {
        ally: { category: 'social', type: 'ally' },
        enemy: { category: 'conflict', type: 'enemy' },
        romantic: { category: 'romantic', type: 'partner' },
        family: { category: 'family', type: 'sibling' },
        mentor: { category: 'guidance', type: 'mentor' },
        other: { category: 'custom', type: 'other' },
    };
    const d = defaults[mapType];
    const typeId = typeOverride?.id?.trim();
    const categoryOverride = typeOverride?.category;

    // Category-level library style (family/social/…) → default type in that category.
    if (typeId && RELATION_CATEGORIES.some(c => c.value === typeId)) {
        const category = typeId as CharacterRelationCategory;
        return {
            category,
            type: DEFAULT_RELATION_TYPE_BY_CATEGORY[category],
            target: targetName,
        };
    }

    if (typeId && typeId !== d.type) {
        return {
            category: categoryOverride || 'custom',
            type: typeId,
            target: targetName,
        };
    }
    return { category: d.category, type: d.type, target: targetName };
}

/** Write a character↔character relation to both profile pages. */
export async function updateCharacterRelation(
    plugin: SceneCardsPlugin,
    fromName: string,
    toName: string,
    mapType: RelationshipType | null,
    typeOverride?: { id: string; category?: CharacterRelationCategory },
): Promise<void> {
    const fromChar = plugin.characterManager.findByName(fromName);
    if (!fromChar) {
        new Notice(t('Character "{name}" not found', { name: fromName }));
        return;
    }

    const oldRelations = normalizeCharacterRelations(fromChar.relations);
    const toKey = toName.toLowerCase();
    const previous = oldRelations.find(r => r.target.toLowerCase() === toKey);
    let next = oldRelations.filter(r => r.target.toLowerCase() !== toKey);
    if (mapType) {
        const row = relationFromMapType(mapType, toName, typeOverride);
        if (previous?.surface) row.surface = previous.surface;
        if (previous?.deep) row.deep = previous.deep;
        next.push(row);
    }
    next = normalizeCharacterRelations(next);
    fromChar.relations = next;

    try {
        await plugin.characterManager.saveCharacter(fromChar);

        const updates = computeReciprocalUpdates(fromChar.name, oldRelations, next);
        const byTarget = new Map<string, typeof updates>();
        for (const u of updates) {
            const key = u.targetName.toLowerCase();
            if (!byTarget.has(key)) byTarget.set(key, []);
            byTarget.get(key)!.push(u);
        }

        for (const [, targetUpdates] of byTarget) {
            const targetChar = plugin.characterManager.findByName(targetUpdates[0].targetName);
            if (!targetChar) continue;
            let relations = normalizeCharacterRelations(targetChar.relations);
            let changed = false;

            for (const u of targetUpdates) {
                const matchKey = `${u.relation.type}|${u.relation.target.toLowerCase()}`;
                const existingIdx = relations.findIndex(
                    r => `${r.type}|${r.target.toLowerCase()}` === matchKey
                );
                if (u.action === 'remove' && existingIdx !== -1) {
                    relations.splice(existingIdx, 1);
                    changed = true;
                } else if (u.action === 'add' && existingIdx !== -1) {
                    /* already present */
                } else if (u.action === 'add' && existingIdx === -1) {
                    const before = relations.length;
                    relations = relations.filter(
                        r => r.target.toLowerCase() !== fromChar.name.toLowerCase()
                    );
                    if (relations.length !== before) changed = true;
                    relations.push(u.relation);
                    changed = true;
                }
            }

            if (changed) {
                targetChar.relations = normalizeCharacterRelations(relations);
                await plugin.characterManager.saveCharacter(targetChar);
            }
        }

        if (!mapType) {
            const toChar = plugin.characterManager.findByName(toName);
            if (toChar) {
                const before = normalizeCharacterRelations(toChar.relations);
                const cleaned = before.filter(
                    r => r.target.toLowerCase() !== fromChar.name.toLowerCase()
                );
                if (cleaned.length !== before.length) {
                    toChar.relations = cleaned;
                    await plugin.characterManager.saveCharacter(toChar);
                }
                // Full teardown: body wikilinks + annotated storyRefs + focus bundles.
                if (fromChar.filePath && toChar.filePath) {
                    await removeWikilinksBetween(plugin.app, fromChar.filePath, toChar.filePath);
                    await clearStoryRefsBetween(
                        plugin.app,
                        fromChar.filePath,
                        fromChar.name,
                        toChar.filePath,
                        toChar.name,
                    );
                    const pair = storyGraphPairKey(fromChar.filePath, toChar.filePath);
                    const bundles = { ...(plugin.settings.storyGraphFocusBundles || {}) };
                    let bundleDirty = false;
                    for (const key of Object.keys(bundles)) {
                        if (key === pair || key.startsWith(`${pair}@@`)) {
                            delete bundles[key];
                            bundleDirty = true;
                        }
                    }
                    if (bundleDirty) {
                        plugin.settings.storyGraphFocusBundles = bundles;
                        await plugin.saveSettings();
                    }
                }
            }
        }

        new Notice(mapType ? t('Relationship updated') : t('Relationship removed'));
    } catch (e) {
        console.error('[NarrativeLab] updateCharacterRelation failed', e);
        new Notice(t('Failed to update relationship'));
    }
}
/* eslint-enable @typescript-eslint/no-unnecessary-type-assertion, @typescript-eslint/no-redundant-type-constituents -- end of file-wide suppression block opened at line 1 */
