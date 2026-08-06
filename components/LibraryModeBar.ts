/* eslint-disable @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-argument, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-return, @typescript-eslint/no-floating-promises, @typescript-eslint/no-misused-promises, @typescript-eslint/no-unnecessary-type-assertion, @typescript-eslint/no-redundant-type-constituents, @typescript-eslint/no-unused-vars, no-unused-vars, no-useless-escape, no-control-regex, no-empty -- Obsidian's API surface and several untyped third-party libraries force dynamic dispatch; floating promises are intentional in DOM/event handlers; matching enable at end of file */
/**
 * Library content mode (Browse / Story Graph) — shared across Characters,
 * Locations, and Codex category pages.
 */
import * as obsidian from 'obsidian';
import { Menu, Notice } from 'obsidian';
import type SceneCardsPlugin from '../main';
import {
    type CharacterRelation,
    type CharacterRelationCategory,
    computeReciprocalUpdates,
    normalizeCharacterRelations,
} from '../models/Character';
import { StoryGraph, type StoryGraphFilterState } from './StoryGraph';
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

    const scenes = plugin.sceneManager.getAllScenes().filter(s => !s.inactive);
    const characters = plugin.characterManager.getAllCharacters();
    const scanner = plugin.linkScanner;
    scanner.rebuildLookups(plugin.settings.characterAliases);
    const scanResults = scanner.scanAll(scenes);

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
