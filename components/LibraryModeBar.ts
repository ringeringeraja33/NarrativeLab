/* eslint-disable @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-argument, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-return, @typescript-eslint/no-floating-promises, @typescript-eslint/no-misused-promises, @typescript-eslint/no-unnecessary-type-assertion, @typescript-eslint/no-redundant-type-constituents, @typescript-eslint/no-unused-vars, no-unused-vars, no-useless-escape, no-control-regex, no-empty -- Obsidian's API surface and several untyped third-party libraries force dynamic dispatch; floating promises are intentional in DOM/event handlers; matching enable at end of file */
/**
 * Library content mode (Browse / Story Graph) — shared across Characters,
 * Locations, and Codex category pages.
 */
import * as obsidian from 'obsidian';
import { Menu, Modal, Notice, Setting, normalizePath } from 'obsidian';
import type SceneCardsPlugin from '../main';
import {
    RELATION_CATEGORIES,
    type CharacterRelation,
    type CharacterRelationCategory,
    computeReciprocalUpdates,
    normalizeCharacterRelations,
} from '../models/Character';
import {
    StoryGraph,
    normalizeStoryGraphRelationCategory,
    type StoryGraphConnectNode,
    type StoryGraphDocument,
    type StoryGraphFilterState,
    type StoryGraphLayoutState,
    type StoryGraphLinkEdgeInfo,
    type StoryGraphRelationArrow,
    type StoryGraphRelationCategory,
    type StoryGraphWikilink,
} from './StoryGraph';
import type { RelationshipEdgeInfo, RelationshipType } from './RelationshipMap';
import {
    openStoryGraphRelationFocus,
    type StoryGraphFocusEdge,
} from './StoryGraphFocusView';
import { isMobile } from './MobileAdapter';
import { pickImage, resolveImagePath } from './ImagePicker';
import { ensureWikilink } from '../utils/perceptions';
import {
    normalizeStoryGraphFocusBundle,
    type StoryGraphFocusBundle,
} from '../utils/storyGraphStrands';
import {
    DEFAULT_RELATION_TYPE_BY_CATEGORY,
    defaultCharacterRelationTypes,
    displayCharacterRelationLabel,
    makeCharacterRelationTypeId,
    mergeCharacterRelationTypes,
    normalizeCharacterRelationType,
    type StoryGraphCharacterRelationType,
} from '../utils/storyGraphCharacterRelations';
import { t } from '../utils/i18n';

export type LibraryContentMode = 'browse' | 'story-graph';

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
): HTMLElement | null {
    if (isMobile) return null;

    const mode = getLibraryContentMode(plugin);
    const toggle = parent.createDiv('library-mode-toggle character-mode-toggle');

    const browseBtn = toggle.createEl('button', {
        cls: `character-mode-btn ${mode === 'browse' ? 'active' : ''}`,
        attr: { 'data-mode': 'browse', 'aria-label': t('Browse') },
    });
    const browseIcon = browseBtn.createSpan();
    obsidian.setIcon(browseIcon, 'layout-grid');
    browseBtn.createSpan({ text: t(' Browse') });
    browseBtn.addEventListener('click', () => {
        if (getLibraryContentMode(plugin) === 'browse') return;
        setLibraryContentMode(plugin, 'browse');
        onChange();
    });

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
            label: character.name,
            entityType: 'character',
            image: character.image,
        });
    }
    for (const world of plugin.locationManager.getAllWorlds()) {
        add({
            filePath: world.filePath,
            label: world.name,
            entityType: 'location',
            image: world.image,
        });
    }
    for (const location of plugin.locationManager.getAllLocations()) {
        add({
            filePath: location.filePath,
            label: location.name,
            entityType: 'location',
            image: location.image,
        });
    }
    for (const entry of plugin.codexManager.getAllEntries()) {
        add({
            filePath: entry.filePath,
            label: entry.name,
            entityType: 'codex',
            image: entry.image,
        });
    }
    return Array.from(documents.values());
}

function collectStoryGraphWikilinks(
    plugin: SceneCardsPlugin,
    documents: StoryGraphDocument[],
): StoryGraphWikilink[] {
    const knownPaths = new Set(documents.map(document => normalizePath(document.filePath)));
    const links: StoryGraphWikilink[] = [];
    const seen = new Set<string>();
    const resolvedLinks = plugin.app.metadataCache.resolvedLinks;

    for (const document of documents) {
        const sourcePath = normalizePath(document.filePath);
        const targets = resolvedLinks[sourcePath] || {};
        for (const rawTargetPath of Object.keys(targets)) {
            const targetPath = normalizePath(rawTargetPath);
            if (!knownPaths.has(targetPath) || targetPath === sourcePath) continue;
            const key = `${sourcePath}=>${targetPath}`;
            if (seen.has(key)) continue;
            seen.add(key);
            links.push({ sourcePath, targetPath });
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
        text: t('Library wikilinks appear automatically. Connect via node menu (Connect to…) or mouse right-drag; double-click a relationship to focus; right-click an edge for type/category.'),
    });

    const scenes = plugin.sceneManager.getAllScenes().filter(s => !s.inactive);
    const characters = plugin.characterManager.getAllCharacters();
    const scanner = plugin.linkScanner;
    scanner.rebuildLookups(plugin.settings.characterAliases);
    const scanResults = scanner.scanAll(scenes);
    const documents = collectStoryGraphDocuments(plugin, scenes, characters);
    const wikilinks = collectStoryGraphWikilinks(plugin, documents);
    const relationCategories = plugin.settings.storyGraphRelationCategories || [];
    const relationAssignments = plugin.settings.storyGraphLinkRelationAssignments || {};

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

    const characterRelationTypes = mergeCharacterRelationTypes(
        plugin.settings.storyGraphCharacterRelationTypes,
        characters,
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
                const added = await ensureWikilink(plugin.app, from.filePath, to.label);
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
        },
    );
    graph.render();
    return graph;
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

/** Right-click a real Obsidian wikilink edge → assign a semantic category. */
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
    menu.addItem(item => {
        item.setTitle(t('Default link'));
        if (!current) item.setChecked(true);
        item.onClick(async () => {
            delete assignments[edge.key];
            plugin.settings.storyGraphLinkRelationAssignments = assignments;
            await plugin.saveSettings();
            onDone();
        });
    });
    for (const category of categories) {
        menu.addItem(item => {
            item.setTitle(category.label);
            if (current === category.id) item.setChecked(true);
            item.onClick(async () => {
                assignments[edge.key] = category.id;
                plugin.settings.storyGraphLinkRelationAssignments = assignments;
                await plugin.saveSettings();
                onDone();
            });
        });
    }
    menu.addSeparator();
    menu.addItem(item => {
        item.setTitle(t('New relation category…'));
        item.setIcon('plus');
        item.onClick(() => openNewStoryGraphRelationCategoryModal(plugin, async category => {
            const nextAssignments = plugin.settings.storyGraphLinkRelationAssignments || {};
            nextAssignments[edge.key] = category.id;
            plugin.settings.storyGraphLinkRelationAssignments = nextAssignments;
            await plugin.saveSettings();
            onDone();
        }));
    });
    menu.addItem(item => {
        item.setTitle(t('Manage relation categories'));
        item.setIcon('tags');
        item.onClick(() => openStoryGraphRelationCategoriesModal(plugin, onDone));
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
    modal.titleEl.setText(t('New relation category'));
    let label = '';
    let color = '#6C7AE0';
    let arrow: StoryGraphRelationArrow = 'single';

    new Setting(modal.contentEl)
        .setName(t('Name'))
        .addText(text => text.onChange(value => { label = value; }));
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
    let charDraft: StoryGraphCharacterRelationType[] = mergeCharacterRelationTypes(
        plugin.settings.storyGraphCharacterRelationTypes,
        plugin.characterManager.getAllCharacters(),
    );
    let linkDraft: StoryGraphRelationCategory[] = (plugin.settings.storyGraphRelationCategories || [])
        .map(category => normalizeStoryGraphRelationCategory(category))
        .filter((category): category is StoryGraphRelationCategory => !!category);

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
            const remove = row.createEl('button', { attr: { 'aria-label': t('Delete') } });
            obsidian.setIcon(remove, 'trash');
            remove.disabled = !!style.builtin;
            remove.addEventListener('click', () => {
                if (style.builtin) return;
                charDraft = charDraft.filter(item => item.id !== style.id);
                render();
            });
        }

        new Setting(content)
            .addButton(button => button
                .setButtonText(t('Add character relation'))
                .onClick(() => {
                    const label = t('New relation');
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
                        label: t('New relation'),
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
                            // Keep display edits: if user typed a translated label back, store canonical for builtins.
                            if (style.builtin) {
                                const cat = RELATION_CATEGORIES.find(c => c.value === style.id || c.value === style.category);
                                const typed = style.label.trim();
                                const translated = cat ? t(cat.label) : '';
                                if (cat && (typed === translated || typed === cat.label)) {
                                    style.label = cat.label;
                                }
                            } else if (style.label.trim()) {
                                // Stable id from final label when still a placeholder id.
                                const trimmed = style.label.trim();
                                if (style.id.startsWith('char-rel-') || style.id.startsWith('新关联')) {
                                    style.id = makeCharacterRelationTypeId(trimmed);
                                }
                            }
                            return normalizeCharacterRelationType(style);
                        })
                        .filter((style): style is StoryGraphCharacterRelationType => !!style);
                    // Ensure library category builtins remain
                    for (const d of defaultCharacterRelationTypes()) {
                        if (!cleanChars.some(c => c.id === d.id)) {
                            cleanChars.unshift({ ...d });
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
            }
        }

        new Notice(mapType ? t('Relationship updated') : t('Relationship removed'));
    } catch (e) {
        console.error('[NarrativeLab] updateCharacterRelation failed', e);
        new Notice(t('Failed to update relationship'));
    }
}
/* eslint-enable @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-argument, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-return, @typescript-eslint/no-floating-promises, @typescript-eslint/no-misused-promises, @typescript-eslint/no-unnecessary-type-assertion, @typescript-eslint/no-redundant-type-constituents, @typescript-eslint/no-unused-vars, no-unused-vars, no-useless-escape, no-control-regex, no-empty -- end of file-wide suppression block opened at line 1 */
