/* eslint-disable @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-argument, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-return, @typescript-eslint/no-floating-promises, @typescript-eslint/no-misused-promises, @typescript-eslint/no-unnecessary-type-assertion, @typescript-eslint/no-redundant-type-constituents, @typescript-eslint/no-unused-vars, no-unused-vars, no-useless-escape, no-control-regex, no-empty -- Obsidian's API surface and several untyped third-party libraries force dynamic dispatch; floating promises are intentional in DOM/event handlers; matching enable at end of file */
/**
 * Library content mode (Browse / Story Graph) — shared across Characters,
 * Locations, and Codex category pages.
 */
import * as obsidian from 'obsidian';
import { Menu, Modal, Notice, Setting, normalizePath } from 'obsidian';
import type SceneCardsPlugin from '../main';
import {
    type CharacterRelation,
    type CharacterRelationCategory,
    computeReciprocalUpdates,
    normalizeCharacterRelations,
} from '../models/Character';
import {
    StoryGraph,
    type StoryGraphDocument,
    type StoryGraphFilterState,
    type StoryGraphLinkEdgeInfo,
    type StoryGraphRelationCategory,
    type StoryGraphWikilink,
} from './StoryGraph';
import type { RelationshipEdgeInfo, RelationshipType } from './RelationshipMap';
import { isMobile } from './MobileAdapter';
import { t } from '../utils/i18n';

export type LibraryContentMode = 'browse' | 'story-graph';

const DEFAULT_FILTERS: StoryGraphFilterState = {
    showScenes: true,
    showCharacters: true,
    showLocations: true,
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
        });
    }
    for (const world of plugin.locationManager.getAllWorlds()) {
        add({ filePath: world.filePath, label: world.name, entityType: 'location' });
    }
    for (const location of plugin.locationManager.getAllLocations()) {
        add({ filePath: location.filePath, label: location.name, entityType: 'location' });
    }
    for (const entry of plugin.codexManager.getAllEntries()) {
        add({ filePath: entry.filePath, label: entry.name, entityType: 'other' });
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
    container.createEl('h3', { text: t('Story Graph') });
    container.createEl('p', {
        cls: 'setting-item-description story-graph-description',
        text: t('Library wikilinks appear automatically. Double-click a node to open it; right-click a link to set its relation category.'),
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
        (edge, evt) => showRelationEdgeMenu(plugin, edge, evt, onRefresh),
        getStoryGraphFilters(plugin),
        (filters) => setStoryGraphFilters(plugin, filters),
        documents,
        wikilinks,
        relationCategories,
        relationAssignments,
        (edge, evt) => showStoryGraphLinkEdgeMenu(plugin, edge, evt, onRefresh),
        () => openStoryGraphRelationCategoriesModal(plugin, onRefresh),
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
): void {
    const menu = new Menu();
    const types: { type: RelationshipType; label: string }[] = [
        { type: 'ally', label: t('Ally') },
        { type: 'enemy', label: t('Hostile') },
        { type: 'romantic', label: t('Romance') },
        { type: 'family', label: t('Family') },
        { type: 'mentor', label: t('Mentor') },
        { type: 'other', label: t('Other') },
    ];

    menu.addItem(item => {
        item.setTitle(`${edge.from} ↔ ${edge.to}`);
        item.setDisabled(true);
    });
    menu.addSeparator();

    for (const opt of types) {
        menu.addItem(item => {
            item.setTitle(opt.label);
            if (opt.type === edge.type) item.setChecked(true);
            item.onClick(() => {
                void updateCharacterRelation(plugin, edge.from, edge.to, opt.type).then(onDone);
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

    new Setting(modal.contentEl)
        .setName(t('Name'))
        .addText(text => text.onChange(value => { label = value; }));
    new Setting(modal.contentEl)
        .setName(t('Color'))
        .addColorPicker(picker => picker
            .setValue(color)
            .onChange(value => { color = value; }));
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
                const category = { id, label: name, color };
                plugin.settings.storyGraphRelationCategories = [...categories, category];
                await plugin.saveSettings();
                modal.close();
                await onCreated(category);
            }));
    modal.open();
}

/** Configure names and colours used to classify wikilink edges. */
export function openStoryGraphRelationCategoriesModal(
    plugin: SceneCardsPlugin,
    onDone: () => void,
): void {
    const modal = new Modal(plugin.app);
    modal.titleEl.setText(t('Relation categories'));
    let draft = (plugin.settings.storyGraphRelationCategories || [])
        .map(category => ({ ...category }));

    const render = () => {
        const content = modal.contentEl;
        content.empty();
        content.addClass('story-graph-relation-manager');
        content.createEl('p', {
            cls: 'setting-item-description',
            text: t('Create semantic categories for Obsidian wikilinks. Right-click a graph edge to assign one.'),
        });
        const list = content.createDiv('story-graph-relation-category-list');
        list.createDiv({
            cls: 'story-graph-relation-category-row is-default',
            text: t('Default link'),
        });
        for (const category of draft) {
            const row = list.createDiv('story-graph-relation-category-row');
            const color = row.createEl('input', {
                attr: { type: 'color', value: category.color, 'aria-label': t('Color') },
            }) as HTMLInputElement;
            const name = row.createEl('input', {
                attr: { type: 'text', value: category.label, 'aria-label': t('Name') },
            }) as HTMLInputElement;
            color.addEventListener('input', () => { category.color = color.value; });
            name.addEventListener('input', () => { category.label = name.value; });
            const remove = row.createEl('button', { attr: { 'aria-label': t('Delete') } });
            obsidian.setIcon(remove, 'trash');
            remove.addEventListener('click', () => {
                draft = draft.filter(item => item.id !== category.id);
                render();
            });
        }

        new Setting(content)
            .addButton(button => button
                .setButtonText(t('Add relation category'))
                .onClick(() => {
                    draft.push({
                        id: `relation-${Date.now().toString(36)}`,
                        label: t('New relation'),
                        color: '#6C7AE0',
                    });
                    render();
                }));
        new Setting(content)
            .addButton(button => button
                .setButtonText(t('Save'))
                .setCta()
                .onClick(async () => {
                    const clean = draft
                        .map(category => ({ ...category, label: category.label.trim() }))
                        .filter(category => category.label);
                    const validIds = new Set(clean.map(category => category.id));
                    const assignments = plugin.settings.storyGraphLinkRelationAssignments || {};
                    for (const [key, categoryId] of Object.entries(assignments)) {
                        if (!validIds.has(categoryId)) delete assignments[key];
                    }
                    plugin.settings.storyGraphRelationCategories = clean;
                    plugin.settings.storyGraphLinkRelationAssignments = assignments;
                    await plugin.saveSettings();
                    modal.close();
                    onDone();
                }));
    };
    render();
    modal.open();
}

function relationFromMapType(mapType: RelationshipType, targetName: string): CharacterRelation {
    const defaults: Record<RelationshipType, { category: CharacterRelationCategory; type: string }> = {
        ally: { category: 'social', type: 'ally' },
        enemy: { category: 'conflict', type: 'enemy' },
        romantic: { category: 'romantic', type: 'partner' },
        family: { category: 'family', type: 'sibling' },
        mentor: { category: 'guidance', type: 'mentor' },
        other: { category: 'custom', type: 'other' },
    };
    const d = defaults[mapType];
    return { category: d.category, type: d.type, target: targetName };
}

/** Write a character↔character relation to both profile pages. */
export async function updateCharacterRelation(
    plugin: SceneCardsPlugin,
    fromName: string,
    toName: string,
    mapType: RelationshipType | null,
): Promise<void> {
    const fromChar = plugin.characterManager.findByName(fromName);
    if (!fromChar) {
        new Notice(t('Character "{name}" not found', { name: fromName }));
        return;
    }

    const oldRelations = normalizeCharacterRelations(fromChar.relations);
    const toKey = toName.toLowerCase();
    let next = oldRelations.filter(r => r.target.toLowerCase() !== toKey);
    if (mapType) next.push(relationFromMapType(mapType, toName));
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
