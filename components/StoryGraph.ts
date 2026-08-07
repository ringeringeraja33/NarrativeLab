/* eslint-disable @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-argument, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-return, @typescript-eslint/no-floating-promises, @typescript-eslint/no-misused-promises, @typescript-eslint/no-unnecessary-type-assertion, @typescript-eslint/no-redundant-type-constituents, @typescript-eslint/no-unused-vars, no-unused-vars, no-useless-escape, no-control-regex, no-empty -- Obsidian's API surface and several untyped third-party libraries force dynamic dispatch; floating promises are intentional in DOM/event handlers; matching enable at end of file */
/**
 * StoryGraph — interactive SVG graph showing how scenes connect to
 * characters, locations, and other entities via wikilinks detected in
 * the scene body text.  Also overlays character-to-character relationships
 * (allies / enemies / family) and #prop tags extracted from character fields.
 *
 * - Scene nodes: rectangles (purple)
 * - Character nodes: circles (blue)
 * - Location nodes: diamonds (green)
 * - Other/unknown nodes: small circles (orange)
 * - Prop nodes: hexagons (pink)
 * - Edges: scene → entity, character ↔ character relationships, character → prop
 *
 * Uses the same spring-physics layout pattern as RelationshipMap.
 */

import * as obsidian from 'obsidian';
import type { Scene } from '../models/Scene';
import type { Character } from '../models/Character';
import { RELATION_BASE_TYPE_BY_CATEGORY, extractCharacterProps, extractCharacterLocationTags } from '../models/Character';
import type { LinkScanResult } from '../services/LinkScanner';
import type { RelationshipEdgeInfo, RelationshipType } from './RelationshipMap';
import { t } from '../utils/i18n';

// ── Types ─────────────────────────────────────────────

export type StoryGraphEntityType = 'scene' | 'character' | 'location' | 'other' | 'prop';
type EntityType = StoryGraphEntityType;

/** Edge subtypes — character-to-character relationships */
type RelEdgeKind = 'ally' | 'enemy' | 'family' | 'romantic' | 'mentor' | 'other-rel';
type EdgeKind = EntityType | RelEdgeKind | 'wikilink';

const REL_EDGE_KINDS = new Set<string>(['ally', 'enemy', 'family', 'romantic', 'mentor', 'other-rel']);

function isRelEdgeKind(kind: EdgeKind): kind is RelEdgeKind {
    return REL_EDGE_KINDS.has(kind);
}

function relKindToRelationshipType(kind: RelEdgeKind): RelationshipType {
    return kind === 'other-rel' ? 'other' : kind;
}

/** Visibility toggles for the Story Graph filter bar. */
export interface StoryGraphFilterState {
    showScenes: boolean;
    showCharacters: boolean;
    showLocations: boolean;
    showRelationships: boolean;
    showProps: boolean;
    showOther: boolean;
}

interface StoryGraphNode {
    id: string;
    label: string;
    entityType: EntityType;
    /** Number of connections (used for sizing) */
    weight: number;
    x: number;
    y: number;
    vx: number;
    vy: number;
    /** Vault-relative path for opening Library entity nodes. */
    filePath?: string;
}

interface StoryGraphEdge {
    source: string;   // node id
    target: string;   // node id
    kind: EdgeKind;   // drives colour & dash pattern
    /** Stable directed key for a real Obsidian wikilink edge. */
    linkKey?: string;
    sourcePath?: string;
    targetPath?: string;
    relationCategoryId?: string;
}

export interface StoryGraphDocument {
    filePath: string;
    label: string;
    entityType: StoryGraphEntityType;
}

export interface StoryGraphWikilink {
    sourcePath: string;
    targetPath: string;
}

export interface StoryGraphRelationCategory {
    id: string;
    label: string;
    color: string;
}

export interface StoryGraphLinkEdgeInfo {
    key: string;
    sourcePath: string;
    targetPath: string;
    from: string;
    to: string;
    relationCategoryId?: string;
}

// ── Colours ───────────────────────────────────────────

function resolveColor(varName: string, fallback: string): string {
    const val = getComputedStyle(activeDocument.body).getPropertyValue(varName).trim();
    return val || fallback;
}

function getEntityColors(): Record<EntityType, string> {
    return {
        scene: resolveColor('--sl-sg-scene', '#7C3AED'),
        character: resolveColor('--sl-sg-character', '#2196F3'),
        location: resolveColor('--sl-sg-location', '#4CAF50'),
        other: resolveColor('--sl-sg-other', '#FF9800'),
        prop: resolveColor('--sl-sg-prop', '#E91E63'),
    };
}

function getEdgeColor(
    kind: EdgeKind,
    relationCategoryId?: string,
    relationCategories: StoryGraphRelationCategory[] = [],
): string {
    if (kind === 'wikilink' && relationCategoryId) {
        return relationCategories.find(category => category.id === relationCategoryId)?.color
            || resolveColor('--text-muted', '#6B7280');
    }
    switch (kind) {
        case 'ally': return resolveColor('--sl-rel-ally', '#4CAF50');
        case 'enemy': return resolveColor('--sl-rel-enemy', '#F44336');
        case 'family': return resolveColor('--sl-rel-family', '#FF9800');
        case 'romantic': return resolveColor('--sl-rel-romantic', '#E91E63');
        case 'mentor': return resolveColor('--sl-rel-mentor', '#9C27B0');
        case 'other-rel': return resolveColor('--sl-rel-other', '#9E9E9E');
        case 'wikilink': return resolveColor('--text-muted', '#6B7280');
        default: return getEntityColors()[kind] || '#999';
    }
}

const EDGE_DASH: Record<string, string> = {
    ally: '',
    enemy: '6,3',
    family: '3,3',
    romantic: '2,4',
    mentor: '8,3,2,3',
    'other-rel': '4,4',
};

// ── Component ─────────────────────────────────────────

const MAX_STORY_NODES = 120;

interface StoryEdgeDom {
    line: SVGLineElement;
    hit?: SVGLineElement;
    label?: SVGTextElement;
    source: string;
    target: string;
    kind: EdgeKind;
    edge: StoryGraphEdge;
}

interface StoryNodeDom {
    shape: SVGElement;
    label: SVGTextElement;
    entityType: EntityType;
    radius: number;
}

export class StoryGraph {
    private container: HTMLElement;
    private scenes: Scene[];
    private characters: Character[];
    private scanResults: Map<string, LinkScanResult>;
    private documents: StoryGraphDocument[];
    private wikilinks: StoryGraphWikilink[];
    private relationCategories: StoryGraphRelationCategory[];
    private relationAssignments: Record<string, string>;
    private nodes: StoryGraphNode[] = [];
    private edges: StoryGraphEdge[] = [];
    private nodeById = new Map<string, StoryGraphNode>();
    private svg: SVGSVGElement | null = null;
    private layer: SVGGElement | null = null;
    private wrapper: HTMLElement | null = null;
    private width = 900;
    private height = 600;
    private animFrame = 0;
    private dragging: StoryGraphNode | null = null;
    private panX = 0;
    private panY = 0;
    private isPanning = false;
    private panStart = { x: 0, y: 0 };
    private zoom = 1;
    private resizeObserver: ResizeObserver | null = null;
    private edgeDom: StoryEdgeDom[] = [];
    private nodeDom = new Map<string, StoryNodeDom>();
    private svgBuilt = false;
    private onPanMove: ((e: MouseEvent) => void) | null = null;
    private onPanUp: (() => void) | null = null;

    /** Visibility filters — toggled by the toolbar */
    private showScenes = true;
    private showCharacters = true;
    private showLocations = true;
    private showOther = true;
    private showRelationships = true;
    private showProps = true;

    /** Optional callback when a graph document node is double-clicked. */
    private onSelectDocument?: (filePath: string) => void;

    /** Right-click a character↔character relationship edge */
    private onRelationEdgeContextMenu?: (edge: RelationshipEdgeInfo, event: MouseEvent) => void;
    /** Right-click an actual Obsidian wikilink edge to set its semantic category. */
    private onLinkEdgeContextMenu?: (edge: StoryGraphLinkEdgeInfo, event: MouseEvent) => void;
    /** Open the relation-category manager from the graph toolbar. */
    private onManageRelationCategories?: () => void;

    /** Persist filter changes (e.g. onto the plugin session state) */
    private onFiltersChange?: (filters: StoryGraphFilterState) => void;

    /** Manual tag-type overrides from plugin settings */
    private tagTypeOverrides: Record<string, string>;

    constructor(
        container: HTMLElement,
        scenes: Scene[],
        characters: Character[],
        scanResults: Map<string, LinkScanResult>,
        onSelectScene?: (filePath: string) => void,
        tagTypeOverrides?: Record<string, string>,
        onRelationEdgeContextMenu?: (edge: RelationshipEdgeInfo, event: MouseEvent) => void,
        filters?: Partial<StoryGraphFilterState>,
        onFiltersChange?: (filters: StoryGraphFilterState) => void,
        documents: StoryGraphDocument[] = [],
        wikilinks: StoryGraphWikilink[] = [],
        relationCategories: StoryGraphRelationCategory[] = [],
        relationAssignments: Record<string, string> = {},
        onLinkEdgeContextMenu?: (edge: StoryGraphLinkEdgeInfo, event: MouseEvent) => void,
        onManageRelationCategories?: () => void,
    ) {
        this.container = container;
        this.scenes = scenes;
        this.characters = characters;
        this.scanResults = scanResults;
        this.onSelectDocument = onSelectScene;
        this.tagTypeOverrides = tagTypeOverrides || {};
        this.onRelationEdgeContextMenu = onRelationEdgeContextMenu;
        this.onFiltersChange = onFiltersChange;
        this.documents = documents;
        this.wikilinks = wikilinks;
        this.relationCategories = relationCategories;
        this.relationAssignments = relationAssignments;
        this.onLinkEdgeContextMenu = onLinkEdgeContextMenu;
        this.onManageRelationCategories = onManageRelationCategories;
        if (filters) {
            if (filters.showScenes !== undefined) this.showScenes = filters.showScenes;
            if (filters.showCharacters !== undefined) this.showCharacters = filters.showCharacters;
            if (filters.showLocations !== undefined) this.showLocations = filters.showLocations;
            if (filters.showRelationships !== undefined) this.showRelationships = filters.showRelationships;
            if (filters.showProps !== undefined) this.showProps = filters.showProps;
            if (filters.showOther !== undefined) this.showOther = filters.showOther;
        }
    }

    private emitFilters(): void {
        this.onFiltersChange?.({
            showScenes: this.showScenes,
            showCharacters: this.showCharacters,
            showLocations: this.showLocations,
            showRelationships: this.showRelationships,
            showProps: this.showProps,
            showOther: this.showOther,
        });
    }

    // ── Public API ─────────────────────────────────────

    render(): void {
        this.destroy();
        this.container.empty();
        this.svgBuilt = false;
        this.edgeDom = [];
        this.nodeDom.clear();
        this.panX = 0;
        this.panY = 0;
        this.zoom = 1;
        this.buildGraph();

        if (this.nodes.length === 0) {
            const empty = this.container.createDiv('story-graph-empty');
            empty.createEl('p', { text: t('No links detected in Library files or scene text. Add an Obsidian wikilink such as [[Character]] to see it here.') });
            return;
        }

        // Filter toolbar
        this.renderFilterBar();

        // Legend
        this.renderLegend();

        // SVG wrapper
        const wrapper = this.container.createDiv('story-graph-wrapper');
        this.wrapper = wrapper;
        const rect = wrapper.getBoundingClientRect();
        this.width = Math.max(700, rect.width || 900);
        this.height = Math.max(450, rect.height || 600);

        const svgNS = 'http://www.w3.org/2000/svg';
        this.svg = activeDocument.createElementNS(svgNS, 'svg');
        this.svg.setAttribute('width', '100%');
        this.svg.setAttribute('height', '100%');
        this.svg.setAttribute('viewBox', `0 0 ${this.width} ${this.height}`);
        this.svg.classList.add('story-graph-svg');
        wrapper.appendChild(this.svg);

        // Resize observer — update dimensions when container changes
        let resizeTimer = 0;
        this.resizeObserver = new ResizeObserver((entries) => {
            for (const entry of entries) {
                const cr = entry.contentRect;
                if (cr.width > 0 && cr.height > 0) {
                    this.width = Math.max(700, cr.width);
                    this.height = Math.max(450, cr.height);
                    if (this.svg) {
                        this.svg.setAttribute('viewBox', `0 0 ${this.width} ${this.height}`);
                    }
                    if (resizeTimer) window.clearTimeout(resizeTimer);
                    resizeTimer = window.setTimeout(() => this.updatePositions(), 80);
                }
            }
        });
        this.resizeObserver.observe(wrapper);

        // Pan support — transform only
        this.svg.addEventListener('mousedown', (e) => {
            if (e.target === this.svg || e.target === this.layer) {
                this.isPanning = true;
                this.panStart = { x: e.clientX - this.panX, y: e.clientY - this.panY };
            }
        });
        this.onPanMove = (e: MouseEvent) => {
            if (!this.isPanning) return;
            this.panX = e.clientX - this.panStart.x;
            this.panY = e.clientY - this.panStart.y;
            this.updateTransform();
        };
        this.onPanUp = () => { this.isPanning = false; };
        window.addEventListener('mousemove', this.onPanMove);
        window.addEventListener('mouseup', this.onPanUp);

        // Zoom support (mouse wheel)
        this.svg.addEventListener('wheel', (e) => {
            e.preventDefault();
            const factor = e.deltaY < 0 ? 1.1 : 0.9;
            const newZoom = Math.min(5, Math.max(0.2, this.zoom * factor));
            const svgRect = this.svg!.getBoundingClientRect();
            const mx = e.clientX - svgRect.left;
            const my = e.clientY - svgRect.top;
            this.panX = mx - (mx - this.panX) * (newZoom / this.zoom);
            this.panY = my - (my - this.panY) * (newZoom / this.zoom);
            this.zoom = newZoom;
            this.updateTransform();
        }, { passive: false });

        this.buildSVG();
        this.runSimulation();
    }

    destroy(): void {
        if (this.animFrame) cancelAnimationFrame(this.animFrame);
        this.animFrame = 0;
        if (this.resizeObserver) {
            this.resizeObserver.disconnect();
            this.resizeObserver = null;
        }
        if (this.onPanMove) {
            window.removeEventListener('mousemove', this.onPanMove);
            this.onPanMove = null;
        }
        if (this.onPanUp) {
            window.removeEventListener('mouseup', this.onPanUp);
            this.onPanUp = null;
        }
    }

    // ── Filter toolbar ─────────────────────────────────

    private renderFilterBar(): void {
        const bar = this.container.createDiv('story-graph-filters');

        const makeToggle = (label: string, icon: string, active: boolean, onToggle: (v: boolean) => void) => {
            const btn = bar.createEl('button', {
                cls: `story-graph-filter-btn ${active ? 'active' : ''}`,
                attr: { 'aria-label': label },
            });
            const ic = btn.createSpan();
            obsidian.setIcon(ic, icon);
            btn.createSpan({ text: ` ${label}` });
            btn.addEventListener('click', () => {
                const next = !btn.hasClass('active');
                btn.toggleClass('active', next);
                onToggle(next);
                this.emitFilters();
                // Full remount with new filters
                this.render();
            });
        };

        makeToggle(t('Scenes'), 'clapperboard', this.showScenes, v => { this.showScenes = v; });
        makeToggle(t('Characters'), 'user', this.showCharacters, v => { this.showCharacters = v; });
        makeToggle(t('Locations'), 'map-pin', this.showLocations, v => { this.showLocations = v; });
        makeToggle(t('Relationships'), 'heart-handshake', this.showRelationships, v => { this.showRelationships = v; });
        makeToggle(t('Props'), 'tag', this.showProps, v => { this.showProps = v; });
        makeToggle(t('Other'), 'file-text', this.showOther, v => { this.showOther = v; });
        if (this.onManageRelationCategories) {
            const manageBtn = bar.createEl('button', {
                cls: 'story-graph-filter-btn story-graph-manage-relations',
                attr: { 'aria-label': t('Relation categories') },
            });
            const icon = manageBtn.createSpan();
            obsidian.setIcon(icon, 'tags');
            manageBtn.createSpan({ text: ` ${t('Relation categories')}` });
            manageBtn.addEventListener('click', () => this.onManageRelationCategories?.());
        }
    }

    // ── Legend ──────────────────────────────────────────

    private renderLegend(): void {
        const legend = this.container.createDiv('story-graph-legend');
        const colors = getEntityColors();
        const items: [string, string, EntityType][] = [
            ['Scene', 'book-open', 'scene'],
            ['Character', 'user', 'character'],
            ['Location', 'map-pin', 'location'],
            ['Prop', 'tag', 'prop'],
            ['Other', 'file-text', 'other'],
        ];
        for (const [label, _icon, type] of items) {
            const item = legend.createDiv('story-graph-legend-item');
            const swatch = item.createSpan({ cls: 'story-graph-legend-swatch' });
            swatch.setCssStyles({ backgroundColor: colors[type] });
            item.createSpan({ text: label });
        }
        // Relationship edge legend
        const relItems: [string, string][] = [
            ['Ally', resolveColor('--sl-rel-ally', '#4CAF50')],
            ['Enemy', resolveColor('--sl-rel-enemy', '#F44336')],
            ['Family', resolveColor('--sl-rel-family', '#FF9800')],
            ['Romantic', resolveColor('--sl-rel-romantic', '#E91E63')],
            ['Mentor', resolveColor('--sl-rel-mentor', '#9C27B0')],
            ['Other', resolveColor('--sl-rel-other', '#9E9E9E')],
        ];
        for (const [label, color] of relItems) {
            const item = legend.createDiv('story-graph-legend-item');
            const swatch = item.createSpan({ cls: 'story-graph-legend-swatch story-graph-legend-line' });
            swatch.setCssStyles({ borderBottomColor: color });
            item.createSpan({ text: label });
        }
        const defaultLink = legend.createDiv('story-graph-legend-item');
        const defaultLinkSwatch = defaultLink.createSpan({
            cls: 'story-graph-legend-swatch story-graph-legend-line',
        });
        defaultLinkSwatch.setCssStyles({
            borderBottomColor: resolveColor('--text-muted', '#6B7280'),
        });
        defaultLink.createSpan({ text: t('Default link') });
        for (const category of this.relationCategories) {
            const item = legend.createDiv('story-graph-legend-item');
            const swatch = item.createSpan({ cls: 'story-graph-legend-swatch story-graph-legend-line' });
            swatch.setCssStyles({ borderBottomColor: category.color });
            item.createSpan({ text: category.label });
        }
    }

    // ── Graph building ─────────────────────────────────

    private buildGraph(): void {
        const nodeMap = new Map<string, StoryGraphNode>();
        const edgeList: StoryGraphEdge[] = [];

        const ensureNode = (
            id: string,
            label: string,
            entityType: EntityType,
            filePath?: string,
        ): StoryGraphNode => {
            if (!nodeMap.has(id)) {
                nodeMap.set(id, {
                    id, label, entityType, weight: 0,
                    x: this.width / 2 + (Math.random() - 0.5) * this.width * 0.6,
                    y: this.height / 2 + (Math.random() - 0.5) * this.height * 0.6,
                    vx: 0, vy: 0, filePath,
                });
            } else if (filePath && !nodeMap.get(id)?.filePath) {
                nodeMap.get(id)!.filePath = filePath;
            }
            return nodeMap.get(id)!;
        };

        const isVisible = (entityType: EntityType): boolean => {
            if (entityType === 'scene') return this.showScenes;
            if (entityType === 'character') return this.showCharacters;
            if (entityType === 'location') return this.showLocations;
            if (entityType === 'prop') return this.showProps;
            return this.showOther;
        };
        const documentNodeId = (document: StoryGraphDocument): string =>
            document.entityType === 'scene'
                ? `scene::${document.filePath}`
                : `${document.entityType}::${document.label.toLowerCase()}`;
        const documentByPath = new Map(this.documents.map(document => [document.filePath, document]));
        const documentByName = new Map(
            this.documents.map(document => [document.label.toLowerCase(), document]),
        );
        const ensureNamedNode = (label: string, fallbackType: EntityType): StoryGraphNode => {
            const document = documentByName.get(label.toLowerCase());
            return document
                ? ensureNode(documentNodeId(document), document.label, document.entityType, document.filePath)
                : ensureNode(`${fallbackType}::${label.toLowerCase()}`, label, fallbackType);
        };
        const hasEdge = (source: string, target: string): boolean =>
            edgeList.some(edge => edge.source === source && edge.target === target);

        // ── 1. Real Obsidian wikilinks between Library / scene files ──
        for (const link of this.wikilinks) {
            const sourceDocument = documentByPath.get(link.sourcePath);
            const targetDocument = documentByPath.get(link.targetPath);
            if (!sourceDocument || !targetDocument) continue;
            if (!isVisible(sourceDocument.entityType) || !isVisible(targetDocument.entityType)) continue;

            const sourceId = documentNodeId(sourceDocument);
            const targetId = documentNodeId(targetDocument);
            if (sourceId === targetId || hasEdge(sourceId, targetId)) continue;

            const sourceNode = ensureNode(
                sourceId,
                sourceDocument.label,
                sourceDocument.entityType,
                sourceDocument.filePath,
            );
            const targetNode = ensureNode(
                targetId,
                targetDocument.label,
                targetDocument.entityType,
                targetDocument.filePath,
            );
            sourceNode.weight++;
            targetNode.weight++;
            const linkKey = `${link.sourcePath}=>${link.targetPath}`;
            edgeList.push({
                source: sourceId,
                target: targetId,
                kind: 'wikilink',
                linkKey,
                sourcePath: link.sourcePath,
                targetPath: link.targetPath,
                relationCategoryId: this.relationAssignments[linkKey],
            });
        }

        // ── 2. Scene → entity edges (plain mentions from LinkScanner) ──

        if (this.showScenes) {
            for (const scene of this.scenes) {
                const result = this.scanResults.get(scene.filePath);
                if (!result || result.links.length === 0) continue;

                const sceneId = `scene::${scene.filePath}`;
                ensureNode(sceneId, scene.title || 'Untitled', 'scene', scene.filePath);

                for (const link of result.links) {
                    const configuredType = this.tagTypeOverrides[link.name.toLowerCase()] || link.type;
                    const resolvedType = (configuredType === 'codex' ? 'other' : configuredType) as EntityType;
                    if (resolvedType === 'character' && !this.showCharacters) continue;
                    if (resolvedType === 'location' && !this.showLocations) continue;
                    if (resolvedType === 'other' && !this.showOther) continue;
                    if (resolvedType === 'prop' && !this.showProps) continue;

                    const knownDocument = documentByName.get(link.name.toLowerCase());
                    const entityId = knownDocument
                        ? documentNodeId(knownDocument)
                        : `${resolvedType}::${link.name.toLowerCase()}`;
                    if (hasEdge(sceneId, entityId)) continue;
                    const node = ensureNode(
                        entityId,
                        knownDocument?.label || link.name,
                        knownDocument?.entityType || resolvedType,
                        knownDocument?.filePath,
                    );
                    nodeMap.get(sceneId)!.weight++;
                    node.weight++;

                    edgeList.push({ source: sceneId, target: entityId, kind: resolvedType });
                }
            }
        }

        // ── 2. Character ↔ Character relationship edges ────────

        if (this.showRelationships && this.showCharacters) {
            for (const char of this.characters) {
                const fromId = `character::${char.name.toLowerCase()}`;
                // Only add relationship edges for characters that are already in the graph
                // OR create their nodes so the relationship network is visible
                const addRelEdges = (names: string[] | string | undefined, kind: EdgeKind) => {
                    if (!names) return;
                    const arr = Array.isArray(names) ? names
                        : typeof names === 'string' ? names.split(/[,;]/).map(s => s.replace(/\[\[|\]\]/g, '').trim()).filter(Boolean)
                        : [];
                    for (const name of arr) {
                        if (!name) continue;
                        const toId = `character::${name.toLowerCase()}`;
                        // Ensure both nodes exist
                        ensureNamedNode(char.name, 'character');
                        ensureNamedNode(name, 'character');
                        // Deduplicate bidirectional
                        const fwd = `${fromId}|${toId}|${kind}`;
                        const rev = `${toId}|${fromId}|${kind}`;
                        if (!edgeList.some(e => {
                            const k = `${e.source}|${e.target}|${e.kind}`;
                            return k === fwd || k === rev;
                        })) {
                            nodeMap.get(fromId)!.weight++;
                            nodeMap.get(toId)!.weight++;
                            edgeList.push({ source: fromId, target: toId, kind });
                        }
                    }
                };

                if (Array.isArray(char.relations)) {
                    for (const relation of char.relations) {
                        const baseType = RELATION_BASE_TYPE_BY_CATEGORY[relation.category] || 'other';
                        const kind: EdgeKind = baseType === 'other' ? 'other-rel' : baseType;
                        addRelEdges([relation.target], kind);
                    }
                }

                // Legacy free-text family/background field may contain relatives by name.
                addRelEdges(char.family, 'family');
            }
        }

        // ── 3. Character → Prop edges (from #hashtags) ─────────

        if (this.showProps) {
            for (const char of this.characters) {
                const props = extractCharacterProps(char, this.tagTypeOverrides);
                if (props.length === 0) continue;
                const charId = `character::${char.name.toLowerCase()}`;
                ensureNamedNode(char.name, 'character');

                for (const prop of props) {
                    const propId = `prop::${prop.toLowerCase()}`;
                    const propNode = ensureNode(propId, `#${prop}`, 'prop');
                    nodeMap.get(charId)!.weight++;
                    propNode.weight++;
                    edgeList.push({ source: charId, target: propId, kind: 'prop' });
                }
            }
        }

        // ── 3b. Character → Location tags (from #tags in residency etc.) ─

        if (this.showLocations) {
            for (const char of this.characters) {
                const locTags = extractCharacterLocationTags(char, this.tagTypeOverrides);
                if (locTags.length === 0) continue;
                const charId = `character::${char.name.toLowerCase()}`;
                ensureNamedNode(char.name, 'character');

                for (const tag of locTags) {
                    const locId = `location::${tag.toLowerCase()}`;
                    const locNode = ensureNode(locId, `#${tag}`, 'location');
                    nodeMap.get(charId)!.weight++;
                    locNode.weight++;
                    edgeList.push({ source: charId, target: locId, kind: 'location' });
                }
            }
        }

        // ── 3c. Character → Location edges (from locations field) ──

        if (this.showLocations) {
            for (const char of this.characters) {
                const locs = char.locations;
                if (!locs || locs.length === 0) continue;
                const charId = `character::${char.name.toLowerCase()}`;
                ensureNamedNode(char.name, 'character');

                for (const loc of locs) {
                    if (!loc) continue;
                    // Strip leading # so "#Place" and "Place" resolve to the same node
                    const cleanLoc = loc.replace(/^#/, '');
                    if (!cleanLoc) continue;
                    const locId = `location::${cleanLoc.toLowerCase()}`;
                    // Avoid duplicate edges if a #tag already created this link
                    const fwd = `${charId}|${locId}|location`;
                    if (edgeList.some(e => `${e.source}|${e.target}|${e.kind}` === fwd)) continue;
                    const locNode = ensureNamedNode(cleanLoc, 'location');
                    nodeMap.get(charId)!.weight++;
                    locNode.weight++;
                    edgeList.push({ source: charId, target: locId, kind: 'location' });
                }
            }
        }

        // ── 4. Clean up orphan scene nodes ─────────────────────

        const connectedScenes = new Set(edgeList.map(e => e.source));
        for (const [id, node] of nodeMap) {
            if (node.entityType === 'scene' && !connectedScenes.has(id)) {
                nodeMap.delete(id);
            }
        }

        // Cap node count for SVG + JS physics (keep highest-weight nodes).
        let nodes = Array.from(nodeMap.values());
        if (nodes.length > MAX_STORY_NODES) {
            nodes.sort((a, b) => b.weight - a.weight);
            nodes = nodes.slice(0, MAX_STORY_NODES);
            const keep = new Set(nodes.map(n => n.id));
            this.edges = edgeList.filter(e => keep.has(e.source) && keep.has(e.target));
        } else {
            this.edges = edgeList;
        }
        this.nodes = nodes;
        this.nodeById = new Map(nodes.map(n => [n.id, n]));
    }

    // ── Simulation ─────────────────────────────────────

    private runSimulation(): void {
        let iterations = 0;
        const maxIterations = this.nodes.length > 60 ? 180 : 280;
        // Throttle SVG attribute writes on large graphs.
        const paintEvery = this.nodes.length > 80 ? 2 : 1;

        const tick = () => {
            if (!this.svg) return;
            iterations++;

            this.applyForces();

            for (const node of this.nodes) {
                if (node === this.dragging) continue;
                node.x += node.vx;
                node.y += node.vy;
                node.vx *= 0.82;
                node.vy *= 0.82;
                node.x = Math.max(50, Math.min(this.width - 50, node.x));
                node.y = Math.max(50, Math.min(this.height - 50, node.y));
            }

            if (iterations % paintEvery === 0 || iterations >= maxIterations) {
                this.updatePositions();
            }

            if (iterations < maxIterations) {
                this.animFrame = window.requestAnimationFrame(tick);
            }
        };

        this.animFrame = window.requestAnimationFrame(tick);
    }

    private applyForces(): void {
        const n = this.nodes.length;
        const repulsion = 4000;
        const springLength = 100;
        const springK = 0.025;
        const centerGravity = 0.0012;

        // Full O(n²) only for small graphs; sample neighbors otherwise.
        if (n <= 50) {
            for (let i = 0; i < n; i++) {
                for (let j = i + 1; j < n; j++) {
                    this.repulsePair(this.nodes[i], this.nodes[j], repulsion);
                }
            }
        } else {
            const samples = Math.min(18, n - 1);
            for (let i = 0; i < n; i++) {
                const a = this.nodes[i];
                for (let s = 0; s < samples; s++) {
                    const j = (i + 1 + ((s * 37 + iterationsSalt(i)) % (n - 1))) % n;
                    if (j === i) continue;
                    this.repulsePair(a, this.nodes[j], repulsion);
                }
            }
        }

        for (const edge of this.edges) {
            const a = this.nodeById.get(edge.source);
            const b = this.nodeById.get(edge.target);
            if (!a || !b) continue;
            const dx = b.x - a.x;
            const dy = b.y - a.y;
            const dist = Math.max(1, Math.sqrt(dx * dx + dy * dy));
            const displacement = dist - springLength;
            const force = springK * displacement;
            const fx = (dx / dist) * force;
            const fy = (dy / dist) * force;
            a.vx += fx;
            a.vy += fy;
            b.vx -= fx;
            b.vy -= fy;
        }

        for (const node of this.nodes) {
            node.vx += (this.width / 2 - node.x) * centerGravity;
            node.vy += (this.height / 2 - node.y) * centerGravity;
        }
    }

    private repulsePair(a: StoryGraphNode, b: StoryGraphNode, repulsion: number): void {
        const dx = b.x - a.x;
        const dy = b.y - a.y;
        const dist = Math.max(1, Math.sqrt(dx * dx + dy * dy));
        const force = repulsion / (dist * dist);
        const fx = (dx / dist) * force;
        const fy = (dy / dist) * force;
        a.vx -= fx;
        a.vy -= fy;
        b.vx += fx;
        b.vy += fy;
    }

    // ── SVG rendering ──────────────────────────────────

    private updateTransform(): void {
        if (!this.layer) return;
        this.layer.setAttribute('transform', `translate(${this.panX},${this.panY}) scale(${this.zoom})`);
    }

    private buildSVG(): void {
        if (!this.svg) return;
        const svgNS = 'http://www.w3.org/2000/svg';
        while (this.svg.firstChild) this.svg.removeChild(this.svg.firstChild);
        this.edgeDom = [];
        this.nodeDom.clear();

        const colors = getEntityColors();
        const g = activeDocument.createElementNS(svgNS, 'g');
        this.layer = g;
        this.svg.appendChild(g);
        this.updateTransform();

        for (const edge of this.edges) {
            const a = this.nodeById.get(edge.source);
            const b = this.nodeById.get(edge.target);
            if (!a || !b) continue;

            const isRelEdge = isRelEdgeKind(edge.kind);
            const isWikilinkEdge = edge.kind === 'wikilink' && !!edge.linkKey;
            let hit: SVGLineElement | undefined;

            // Wide invisible hit target so semantic edges are easy to right-click.
            if ((isRelEdge && this.onRelationEdgeContextMenu)
                || (isWikilinkEdge && this.onLinkEdgeContextMenu)) {
                hit = activeDocument.createElementNS(svgNS, 'line');
                hit.setAttribute('x1', String(a.x));
                hit.setAttribute('y1', String(a.y));
                hit.setAttribute('x2', String(b.x));
                hit.setAttribute('y2', String(b.y));
                hit.setAttribute('stroke', 'transparent');
                hit.setAttribute('stroke-width', '14');
                hit.style.cursor = 'pointer';
                hit.classList.add('story-graph-edge-hit');
                g.appendChild(hit);

                const openMenu = (e: MouseEvent) => {
                    e.preventDefault();
                    e.stopPropagation();
                    if (isRelEdge) {
                        this.onRelationEdgeContextMenu?.(
                            {
                                from: a.label,
                                to: b.label,
                                type: relKindToRelationshipType(edge.kind as RelEdgeKind),
                            },
                            e,
                        );
                    } else if (
                        edge.linkKey
                        && edge.sourcePath
                        && edge.targetPath
                    ) {
                        this.onLinkEdgeContextMenu?.({
                            key: edge.linkKey,
                            sourcePath: edge.sourcePath,
                            targetPath: edge.targetPath,
                            from: a.label,
                            to: b.label,
                            relationCategoryId: edge.relationCategoryId,
                        }, e);
                    }
                };
                hit.addEventListener('contextmenu', openMenu);
                hit.addEventListener('click', (e) => {
                    if (e.button === 2) openMenu(e);
                });
            }

            const line = activeDocument.createElementNS(svgNS, 'line');
            line.setAttribute('x1', String(a.x));
            line.setAttribute('y1', String(a.y));
            line.setAttribute('x2', String(b.x));
            line.setAttribute('y2', String(b.y));
            line.setAttribute('stroke', getEdgeColor(
                edge.kind,
                edge.relationCategoryId,
                this.relationCategories,
            ));
            line.setAttribute('stroke-width', isRelEdge || isWikilinkEdge ? '2' : '1.5');
            line.setAttribute('stroke-opacity', isRelEdge || isWikilinkEdge ? '0.7' : '0.45');
            line.style.pointerEvents = hit ? 'none' : '';
            if (EDGE_DASH[edge.kind]) {
                line.setAttribute('stroke-dasharray', EDGE_DASH[edge.kind]);
            }
            const category = edge.relationCategoryId
                ? this.relationCategories.find(item => item.id === edge.relationCategoryId)
                : undefined;
            const title = activeDocument.createElementNS(svgNS, 'title');
            title.textContent = category
                ? `${a.label} → ${b.label}: ${category.label}`
                : `${a.label} → ${b.label}`;
            line.appendChild(title);
            g.appendChild(line);

            let label: SVGTextElement | undefined;
            if (isWikilinkEdge && category) {
                label = activeDocument.createElementNS(svgNS, 'text');
                label.setAttribute('x', String((a.x + b.x) / 2));
                label.setAttribute('y', String((a.y + b.y) / 2 - 4));
                label.setAttribute('text-anchor', 'middle');
                label.setAttribute('fill', category.color);
                label.setAttribute('font-size', '10');
                label.setAttribute('class', 'story-graph-edge-label');
                label.textContent = category.label;
                g.appendChild(label);
            }
            this.edgeDom.push({ line, hit, label, source: edge.source, target: edge.target, kind: edge.kind, edge });
        }

        for (const node of this.nodes) {
            const color = colors[node.entityType];
            const radius = this.nodeRadius(node);
            let shape: SVGElement;

            if (node.entityType === 'scene') {
                const rect = activeDocument.createElementNS(svgNS, 'rect');
                const rw = radius * 2.4;
                const rh = radius * 1.6;
                rect.setAttribute('x', String(node.x - rw / 2));
                rect.setAttribute('y', String(node.y - rh / 2));
                rect.setAttribute('width', String(rw));
                rect.setAttribute('height', String(rh));
                rect.setAttribute('rx', '4');
                rect.setAttribute('fill', color);
                rect.setAttribute('fill-opacity', '0.85');
                rect.setAttribute('stroke', 'var(--background-primary)');
                rect.setAttribute('stroke-width', '2');
                rect.classList.add('story-graph-node', 'story-graph-node-scene');
                shape = rect;
            } else if (node.entityType === 'location') {
                const r = radius;
                const diamond = activeDocument.createElementNS(svgNS, 'polygon');
                diamond.setAttribute('points', [
                    `${node.x},${node.y - r}`,
                    `${node.x + r},${node.y}`,
                    `${node.x},${node.y + r}`,
                    `${node.x - r},${node.y}`,
                ].join(' '));
                diamond.setAttribute('fill', color);
                diamond.setAttribute('fill-opacity', '0.85');
                diamond.setAttribute('stroke', 'var(--background-primary)');
                diamond.setAttribute('stroke-width', '2');
                diamond.classList.add('story-graph-node', 'story-graph-node-location');
                shape = diamond;
            } else if (node.entityType === 'prop') {
                const r = radius * 0.9;
                const hex = activeDocument.createElementNS(svgNS, 'polygon');
                const pts: string[] = [];
                for (let i = 0; i < 6; i++) {
                    const angle = (Math.PI / 3) * i - Math.PI / 6;
                    pts.push(`${node.x + r * Math.cos(angle)},${node.y + r * Math.sin(angle)}`);
                }
                hex.setAttribute('points', pts.join(' '));
                hex.setAttribute('fill', color);
                hex.setAttribute('fill-opacity', '0.85');
                hex.setAttribute('stroke', 'var(--background-primary)');
                hex.setAttribute('stroke-width', '2');
                hex.classList.add('story-graph-node', 'story-graph-node-prop');
                shape = hex;
            } else {
                const circle = activeDocument.createElementNS(svgNS, 'circle');
                circle.setAttribute('cx', String(node.x));
                circle.setAttribute('cy', String(node.y));
                circle.setAttribute('r', String(radius));
                circle.setAttribute('fill', color);
                circle.setAttribute('fill-opacity', '0.85');
                circle.setAttribute('stroke', 'var(--background-primary)');
                circle.setAttribute('stroke-width', '2');
                circle.classList.add('story-graph-node', `story-graph-node-${node.entityType}`);
                shape = circle;
            }

            this.wireNodeEvents(shape, node);
            g.appendChild(shape);

            const text = activeDocument.createElementNS(svgNS, 'text');
            const labelY = node.entityType === 'scene'
                ? node.y + radius * 1.6 / 2 + 14
                : node.y + radius + 14;
            text.setAttribute('x', String(node.x));
            text.setAttribute('y', String(labelY));
            text.setAttribute('text-anchor', 'middle');
            text.setAttribute('fill', 'var(--text-normal)');
            text.setAttribute('font-size', node.entityType === 'scene' ? '10' : '11');
            text.setAttribute('font-weight', node.entityType === 'scene' ? '400' : '600');
            const maxLen = node.entityType === 'scene' ? 18 : 16;
            text.textContent = node.label.length > maxLen
                ? node.label.substring(0, maxLen - 1) + '…'
                : node.label;
            // Hide labels when very dense — reduces paint cost
            if (this.nodes.length > 70) text.setAttribute('display', 'none');
            g.appendChild(text);

            this.nodeDom.set(node.id, { shape, label: text, entityType: node.entityType, radius });
        }

        this.svgBuilt = true;
    }

    private updatePositions(): void {
        if (!this.svgBuilt) return;

        for (const ed of this.edgeDom) {
            const a = this.nodeById.get(ed.source);
            const b = this.nodeById.get(ed.target);
            if (!a || !b) continue;
            ed.line.setAttribute('x1', String(a.x));
            ed.line.setAttribute('y1', String(a.y));
            ed.line.setAttribute('x2', String(b.x));
            ed.line.setAttribute('y2', String(b.y));
            if (ed.hit) {
                ed.hit.setAttribute('x1', String(a.x));
                ed.hit.setAttribute('y1', String(a.y));
                ed.hit.setAttribute('x2', String(b.x));
                ed.hit.setAttribute('y2', String(b.y));
            }
            if (ed.label) {
                ed.label.setAttribute('x', String((a.x + b.x) / 2));
                ed.label.setAttribute('y', String((a.y + b.y) / 2 - 4));
            }
        }

        for (const node of this.nodes) {
            const dom = this.nodeDom.get(node.id);
            if (!dom) continue;
            const r = dom.radius;
            const shape = dom.shape;

            if (dom.entityType === 'scene') {
                const rw = r * 2.4;
                const rh = r * 1.6;
                shape.setAttribute('x', String(node.x - rw / 2));
                shape.setAttribute('y', String(node.y - rh / 2));
                dom.label.setAttribute('x', String(node.x));
                dom.label.setAttribute('y', String(node.y + rh / 2 + 14));
            } else if (dom.entityType === 'location') {
                shape.setAttribute('points', [
                    `${node.x},${node.y - r}`,
                    `${node.x + r},${node.y}`,
                    `${node.x},${node.y + r}`,
                    `${node.x - r},${node.y}`,
                ].join(' '));
                dom.label.setAttribute('x', String(node.x));
                dom.label.setAttribute('y', String(node.y + r + 14));
            } else if (dom.entityType === 'prop') {
                const hr = r * 0.9;
                const pts: string[] = [];
                for (let i = 0; i < 6; i++) {
                    const angle = (Math.PI / 3) * i - Math.PI / 6;
                    pts.push(`${node.x + hr * Math.cos(angle)},${node.y + hr * Math.sin(angle)}`);
                }
                shape.setAttribute('points', pts.join(' '));
                dom.label.setAttribute('x', String(node.x));
                dom.label.setAttribute('y', String(node.y + r + 14));
            } else {
                shape.setAttribute('cx', String(node.x));
                shape.setAttribute('cy', String(node.y));
                dom.label.setAttribute('x', String(node.x));
                dom.label.setAttribute('y', String(node.y + r + 14));
            }
        }
    }

    private nodeRadius(node: StoryGraphNode): number {
        const base = node.entityType === 'scene' ? 10 : 14;
        return base + Math.min(node.weight * 1.5, 12);
    }

    private wireNodeEvents(el: SVGElement, node: StoryGraphNode): void {
        el.addEventListener('mousedown', (e) => {
            e.stopPropagation();
            this.dragging = node;
            const onMove = (me: MouseEvent) => {
                if (!this.svg) return;
                const svgRect = this.svg.getBoundingClientRect();
                node.x = (me.clientX - svgRect.left - this.panX) / this.zoom;
                node.y = (me.clientY - svgRect.top - this.panY) / this.zoom;
                this.updatePositions();
            };
            const onUp = () => {
                this.dragging = null;
                window.removeEventListener('mousemove', onMove);
                window.removeEventListener('mouseup', onUp);
            };
            window.addEventListener('mousemove', onMove);
            window.addEventListener('mouseup', onUp);
        });

        if (node.filePath && this.onSelectDocument) {
            el.addEventListener('dblclick', () => {
                this.onSelectDocument!(node.filePath!);
            });
        }

        el.setCssStyles({ cursor: 'grab' });
    }
}

/** Deterministic-ish salt so sampled repulsion isn't always the same neighbors. */
function iterationsSalt(i: number): number {
    return (i * 2654435761) >>> 0;
}
/* eslint-enable @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-argument, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-return, @typescript-eslint/no-floating-promises, @typescript-eslint/no-misused-promises, @typescript-eslint/no-unnecessary-type-assertion, @typescript-eslint/no-redundant-type-constituents, @typescript-eslint/no-unused-vars, no-unused-vars, no-useless-escape, no-control-regex, no-empty -- end of file-wide suppression block opened at line 1 */
