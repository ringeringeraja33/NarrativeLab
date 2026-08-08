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
 * Force-directed spring layout for Library Story Graph.
 */

import * as obsidian from 'obsidian';
import { Menu, Notice, normalizePath } from 'obsidian';
import type { Scene } from '../models/Scene';
import type { Character } from '../models/Character';
import { RELATION_BASE_TYPE_BY_CATEGORY, extractCharacterProps, extractCharacterLocationTags } from '../models/Character';
import type { LinkScanResult } from '../services/LinkScanner';
import type { RelationshipEdgeInfo, RelationshipType } from './RelationshipMap';
import type { StoryGraphFocusEdge } from './StoryGraphFocusView';
import {
    lookupStoryGraphFocusBundle,
    storyGraphEdgeStrokeWidth,
    type StoryGraphFocusBundle,
} from '../utils/storyGraphStrands';
import {
    displayCharacterRelationLabel,
    mergeCharacterRelationTypes,
    resolveCharacterRelationStyle,
    type StoryGraphCharacterRelationType,
} from '../utils/storyGraphCharacterRelations';
import { t } from '../utils/i18n';

/** Node payload for connect / focus helpers outside the graph. */
export interface StoryGraphConnectNode {
    id: string;
    label: string;
    filePath: string;
    entityType: StoryGraphEntityType;
}

// ── Types ─────────────────────────────────────────────

export type StoryGraphEntityType = 'scene' | 'character' | 'location' | 'codex' | 'other' | 'prop';
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
    showCodex: boolean;
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
    /** Resolved portrait path (override or entity image). */
    image?: string;
    /** Skip force integration when restored/dragged from a saved layout. */
    pinned?: boolean;
}

/** Arrow style for a semantic category / character relation on the Story Graph. */
export type StoryGraphRelationArrow = 'single' | 'double';

interface StoryGraphEdge {
    source: string;   // node id
    target: string;   // node id
    kind: EdgeKind;   // drives colour & dash pattern
    /** Stable directed key for a real Obsidian wikilink edge. */
    linkKey?: string;
    sourcePath?: string;
    targetPath?: string;
    relationCategoryId?: string;
    /** Main edge label (character relation type / wikilink category). */
    edgeLabel?: string;
    edgeColor?: string;
    edgeArrow?: StoryGraphRelationArrow | 'none';
    /** Character-relation style id (for menus / sync). */
    edgeStyleId?: string;
    /** Number of internal focus strands under this parent edge (drives thickness). */
    strandCount?: number;
}

export interface StoryGraphDocument {
    filePath: string;
    label: string;
    entityType: StoryGraphEntityType;
    /** Optional portrait / cover image (vault-relative or URL). */
    image?: string;
}

/** Persisted layout for one project's Story Graph. */
export interface StoryGraphLayoutState {
    positions: Record<string, { x: number; y: number }>;
    nodeImages?: Record<string, string>;
    nodeScale?: number;
    panX?: number;
    panY?: number;
    zoom?: number;
}

/** Optional host wiring for layout save, images, and export helpers. */
export interface StoryGraphHostOptions {
    layout?: StoryGraphLayoutState;
    /** Entity image by vault path (characters / locations / codex / frontmatter). */
    imageByPath?: Record<string, string>;
    /** Turn a vault-relative image path into a resource URL for SVG `<image>`. */
    resolveImageUrl?: (imagePath: string) => string;
    onLayoutChange?: (layout: StoryGraphLayoutState) => void | Promise<void>;
    onPickNodeImage?: (
        node: StoryGraphConnectNode,
        currentImage?: string,
    ) => Promise<string | undefined>;
    /** Focus strand bundles keyed by undirected pair path. */
    focusBundles?: Record<string, StoryGraphFocusBundle>;
    /** Character relation styles (synced with character data). */
    characterRelationTypes?: StoryGraphCharacterRelationType[];
}

export interface StoryGraphWikilink {
    sourcePath: string;
    targetPath: string;
}

export interface StoryGraphRelationCategory {
    id: string;
    label: string;
    color: string;
    /** Default `single` (source → target). `double` draws ↔. */
    arrow?: StoryGraphRelationArrow;
}

export function normalizeStoryGraphRelationCategory(
    raw: Partial<StoryGraphRelationCategory> & { id?: string; label?: string; color?: string },
): StoryGraphRelationCategory | null {
    const id = typeof raw.id === 'string' ? raw.id.trim() : '';
    const label = typeof raw.label === 'string' ? raw.label.trim() : '';
    if (!id || !label) return null;
    const color = typeof raw.color === 'string' && raw.color.trim()
        ? raw.color.trim()
        : '#6C7AE0';
    return {
        id,
        label,
        color,
        arrow: raw.arrow === 'double' ? 'double' : 'single',
    };
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
        codex: resolveColor('--sl-sg-codex', '#0EA5E9'),
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
    line: SVGGeometryElement;
    hit?: SVGGeometryElement;
    label?: SVGTextElement;
    source: string;
    target: string;
    kind: EdgeKind;
    edge: StoryGraphEdge;
    /** When set, visible line endpoints are inset so arrowheads clear nodes. */
    arrow?: StoryGraphRelationArrow | 'none';
}

/** Inset a center-to-center segment so markers / strokes clear node shapes. */
function insetEdgePoints(
    x1: number,
    y1: number,
    x2: number,
    y2: number,
    padStart: number,
    padEnd: number,
): { x1: number; y1: number; x2: number; y2: number } {
    const dx = x2 - x1;
    const dy = y2 - y1;
    const len = Math.hypot(dx, dy) || 1;
    const maxPad = Math.max(0, (len - 4) / 2);
    const ps = Math.min(padStart, maxPad);
    const pe = Math.min(padEnd, maxPad);
    const ux = dx / len;
    const uy = dy / len;
    return {
        x1: x1 + ux * ps,
        y1: y1 + uy * ps,
        x2: x2 - ux * pe,
        y2: y2 - uy * pe,
    };
}

/** Quadratic path for the i-th parallel strand between two points. */
function parallelStrandPath(
    x1: number,
    y1: number,
    x2: number,
    y2: number,
    index: number,
    count: number,
    spacing = 10,
): { d: string; midX: number; midY: number } {
    const dx = x2 - x1;
    const dy = y2 - y1;
    const len = Math.hypot(dx, dy) || 1;
    const offset = (index - (count - 1) / 2) * spacing;
    const ox = (-dy / len) * offset;
    const oy = (dx / len) * offset;
    const mx = (x1 + x2) / 2 + ox;
    const my = (y1 + y2) / 2 + oy;
    return {
        d: `M ${x1} ${y1} Q ${mx} ${my} ${x2} ${y2}`,
        midX: mx,
        midY: my,
    };
}

function setEdgeGeometry(
    el: SVGGeometryElement,
    x1: number,
    y1: number,
    x2: number,
    y2: number,
    strandIndex?: number,
    strandCount?: number,
): { midX: number; midY: number } {
    const count = strandCount && strandCount > 1 ? strandCount : 1;
    const index = strandIndex ?? 0;
    if (count > 1 && el instanceof SVGPathElement) {
        const curve = parallelStrandPath(x1, y1, x2, y2, index, count);
        el.setAttribute('d', curve.d);
        return { midX: curve.midX, midY: curve.midY };
    }
    if (el instanceof SVGLineElement) {
        el.setAttribute('x1', String(x1));
        el.setAttribute('y1', String(y1));
        el.setAttribute('x2', String(x2));
        el.setAttribute('y2', String(y2));
    } else if (el instanceof SVGPathElement) {
        el.setAttribute('d', `M ${x1} ${y1} L ${x2} ${y2}`);
    }
    return { midX: (x1 + x2) / 2, midY: (y1 + y2) / 2 };
}

interface StoryNodeDom {
    shape: SVGElement;
    label: SVGTextElement;
    entityType: EntityType;
    radius: number;
    hasAvatar?: boolean;
    avatarCircle?: SVGCircleElement;
    avatarImage?: SVGImageElement;
    avatarRing?: SVGCircleElement;
    avatarClipCircle?: SVGCircleElement;
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
    private showCodex = true;
    private showOther = true;
    private showRelationships = true;
    private showProps = true;

    /** Optional callback when a graph document node is double-clicked. */
    private onSelectDocument?: (filePath: string) => void;

    /** Right-click a character↔character relationship edge */
    private onRelationEdgeContextMenu?: (edge: RelationshipEdgeInfo, event: MouseEvent) => void;
    /** Double-click any focusable edge → focus view */
    private onEdgeFocus?: (edge: StoryGraphFocusEdge, event: MouseEvent) => void;
    /** Right-click an actual Obsidian wikilink edge to set its semantic category. */
    private onLinkEdgeContextMenu?: (edge: StoryGraphLinkEdgeInfo, event: MouseEvent) => void;
    /** Open the relation-category manager from the graph toolbar. */
    private onManageRelationCategories?: () => void;
    /** Finish a user-drawn connection (wikilink and/or character relation). */
    private onConnectNodes?: (
        from: StoryGraphConnectNode,
        to: StoryGraphConnectNode,
        mode: 'wikilink' | RelationshipType | string,
    ) => void | Promise<void>;

    /** Right-drag rubber-band connection from a node. */
    private connectDrag: null | {
        fromNode: StoryGraphNode;
        from: StoryGraphConnectNode;
        line: SVGLineElement;
        startClientX: number;
        startClientY: number;
        moved: boolean;
        hoverId: string | null;
    } = null;
    private suppressNodeContextMenu = false;
    /** Touch / menu-driven: pick source, then tap a target node. */
    private connectPick: null | { from: StoryGraphConnectNode; fromNodeId: string } = null;
    private connectBanner: HTMLElement | null = null;
    private onConnectKeyDown: ((e: KeyboardEvent) => void) | null = null;
    private onConnectDragMove: ((e: MouseEvent) => void) | null = null;
    private onConnectDragUp: ((e: MouseEvent) => void) | null = null;

    /** Persist filter changes (e.g. onto the plugin session state) */
    private onFiltersChange?: (filters: StoryGraphFilterState) => void;

    /** Manual tag-type overrides from plugin settings */
    private tagTypeOverrides: Record<string, string>;

    /** Layout persistence + node portraits */
    private layoutPositions = new Map<string, { x: number; y: number }>();
    private layoutImages = new Map<string, string>();
    private imageByPath: Record<string, string> = {};
    private resolveImageUrl?: (imagePath: string) => string;
    private nodeScale = 1;
    private onLayoutChange?: (layout: StoryGraphLayoutState) => void | Promise<void>;
    private onPickNodeImage?: (
        node: StoryGraphConnectNode,
        currentImage?: string,
    ) => Promise<string | undefined>;
    private layoutSaveTimer = 0;
    private hasHydratedViewport = false;
    private focusBundles: Record<string, StoryGraphFocusBundle> = {};
    private characterRelationTypes: StoryGraphCharacterRelationType[] = [];
    private isFullscreen = false;
    private fullscreenBtn: HTMLElement | null = null;
    private onFullscreenKeyDown: ((e: KeyboardEvent) => void) | null = null;
    private onNativeFullscreenChange: (() => void) | null = null;
    /** Viewport before entering fullscreen — restored on exit. */
    private preFullscreenView: { panX: number; panY: number; zoom: number } | null = null;

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
        onEdgeFocus?: (edge: StoryGraphFocusEdge, event: MouseEvent) => void,
        onConnectNodes?: (
            from: StoryGraphConnectNode,
            to: StoryGraphConnectNode,
            mode: 'wikilink' | RelationshipType | string,
        ) => void | Promise<void>,
        host?: StoryGraphHostOptions,
    ) {
        this.container = container;
        this.scenes = scenes;
        this.characters = characters;
        this.scanResults = scanResults;
        this.onSelectDocument = onSelectScene;
        this.tagTypeOverrides = tagTypeOverrides || {};
        this.onRelationEdgeContextMenu = onRelationEdgeContextMenu;
        this.onEdgeFocus = onEdgeFocus;
        this.onConnectNodes = onConnectNodes;
        this.onFiltersChange = onFiltersChange;
        this.documents = documents;
        this.wikilinks = wikilinks;
        this.relationCategories = relationCategories;
        this.relationAssignments = relationAssignments;
        this.onLinkEdgeContextMenu = onLinkEdgeContextMenu;
        this.onManageRelationCategories = onManageRelationCategories;
        this.imageByPath = host?.imageByPath || {};
        this.resolveImageUrl = host?.resolveImageUrl;
        this.onLayoutChange = host?.onLayoutChange;
        this.onPickNodeImage = host?.onPickNodeImage;
        this.focusBundles = host?.focusBundles || {};
        this.characterRelationTypes = host?.characterRelationTypes?.length
            ? host.characterRelationTypes
            : mergeCharacterRelationTypes(undefined, characters);
        this.hydrateLayout(host?.layout);
        if (filters) {
            if (filters.showScenes !== undefined) this.showScenes = filters.showScenes;
            if (filters.showCharacters !== undefined) this.showCharacters = filters.showCharacters;
            if (filters.showLocations !== undefined) this.showLocations = filters.showLocations;
            if (filters.showCodex !== undefined) this.showCodex = filters.showCodex;
            if (filters.showRelationships !== undefined) this.showRelationships = filters.showRelationships;
            if (filters.showProps !== undefined) this.showProps = filters.showProps;
            if (filters.showOther !== undefined) this.showOther = filters.showOther;
        }
    }

    private hydrateLayout(layout?: StoryGraphLayoutState): void {
        if (!layout) return;
        for (const [key, pos] of Object.entries(layout.positions || {})) {
            if (typeof pos?.x === 'number' && typeof pos?.y === 'number') {
                this.layoutPositions.set(key, { x: pos.x, y: pos.y });
            }
        }
        for (const [key, image] of Object.entries(layout.nodeImages || {})) {
            if (typeof image === 'string' && image.trim()) {
                this.layoutImages.set(key, image.trim());
            }
        }
        if (typeof layout.nodeScale === 'number' && layout.nodeScale > 0) {
            this.nodeScale = Math.min(2, Math.max(0.5, layout.nodeScale));
        }
        if (!this.hasHydratedViewport) {
            if (typeof layout.panX === 'number') this.panX = layout.panX;
            if (typeof layout.panY === 'number') this.panY = layout.panY;
            if (typeof layout.zoom === 'number' && layout.zoom > 0) {
                this.zoom = Math.min(5, Math.max(0.2, layout.zoom));
            }
            this.hasHydratedViewport = true;
        }
    }

    private layoutKey(node: { id: string; filePath?: string }): string {
        return node.filePath || node.id;
    }

    private captureLivePositions(): void {
        for (const node of this.nodes) {
            this.layoutPositions.set(this.layoutKey(node), { x: node.x, y: node.y });
        }
    }

    private buildLayoutState(): StoryGraphLayoutState {
        const positions: Record<string, { x: number; y: number }> = {};
        for (const node of this.nodes) {
            positions[this.layoutKey(node)] = { x: node.x, y: node.y };
        }
        // Keep orphaned saved keys for nodes currently filtered out.
        for (const [key, pos] of this.layoutPositions) {
            if (!positions[key]) positions[key] = pos;
        }
        const nodeImages: Record<string, string> = {};
        for (const [key, image] of this.layoutImages) {
            nodeImages[key] = image;
        }
        return {
            positions,
            nodeImages,
            nodeScale: this.nodeScale,
            panX: this.panX,
            panY: this.panY,
            zoom: this.zoom,
        };
    }

    private scheduleLayoutSave(immediate = false): void {
        if (!this.onLayoutChange) return;
        if (this.layoutSaveTimer) window.clearTimeout(this.layoutSaveTimer);
        const flush = () => {
            this.layoutSaveTimer = 0;
            this.captureLivePositions();
            void this.onLayoutChange?.(this.buildLayoutState());
        };
        if (immediate) {
            flush();
            return;
        }
        this.layoutSaveTimer = window.setTimeout(flush, 450);
    }

    async saveLayoutNow(): Promise<void> {
        this.scheduleLayoutSave(true);
        new Notice(t('Story Graph layout saved'));
    }

    private resolveNodeImagePath(node: StoryGraphNode): string {
        const key = this.layoutKey(node);
        const override = this.layoutImages.get(key);
        if (override) return override;
        if (node.image) return node.image;
        if (node.filePath && this.imageByPath[node.filePath]) {
            return this.imageByPath[node.filePath];
        }
        return '';
    }

    private emitFilters(): void {
        this.onFiltersChange?.({
            showScenes: this.showScenes,
            showCharacters: this.showCharacters,
            showLocations: this.showLocations,
            showCodex: this.showCodex,
            showRelationships: this.showRelationships,
            showProps: this.showProps,
            showOther: this.showOther,
        });
    }

    // ── Public API ─────────────────────────────────────

    render(): void {
        this.captureLivePositions();
        const keepPanX = this.panX;
        const keepPanY = this.panY;
        const keepZoom = this.zoom;
        this.destroy();
        this.container.empty();
        this.svgBuilt = false;
        this.edgeDom = [];
        this.nodeDom.clear();
        this.panX = keepPanX;
        this.panY = keepPanY;
        this.zoom = keepZoom;
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
        this.onPanUp = () => {
            if (this.isPanning) this.scheduleLayoutSave();
            this.isPanning = false;
        };
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
            this.scheduleLayoutSave();
        }, { passive: false });

        this.svg.addEventListener('contextmenu', (e) => {
            const target = e.target as Element | null;
            if (target === this.svg || target === this.layer) {
                e.preventDefault();
                this.showCanvasConnectMenu(e);
            }
        });

        this.buildSVG();
        this.runSimulation();
        // Preserve immersive mode across filter remounts.
        if (this.isFullscreen) {
            this.applyFullscreenClass();
            this.bindFullscreenKeys();
        }
    }

    destroy(): void {
        this.clearConnectDrag(false);
        this.clearConnectPick(false);
        // Keep CSS fullscreen across filter re-renders; only tear down listeners here.
        this.unbindFullscreenKeys();
        if (this.layoutSaveTimer) {
            window.clearTimeout(this.layoutSaveTimer);
            this.layoutSaveTimer = 0;
        }
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

    private fullscreenHost(): HTMLElement {
        return (this.container.closest('.story-graph-page') as HTMLElement | null) || this.container;
    }

    private unbindFullscreenKeys(): void {
        if (this.onFullscreenKeyDown) {
            window.removeEventListener('keydown', this.onFullscreenKeyDown);
            this.onFullscreenKeyDown = null;
        }
        if (this.onNativeFullscreenChange) {
            activeDocument.removeEventListener('fullscreenchange', this.onNativeFullscreenChange);
            this.onNativeFullscreenChange = null;
        }
    }

    private applyFullscreenClass(): void {
        const host = this.fullscreenHost();
        host.toggleClass('is-story-graph-fullscreen', this.isFullscreen);
        this.container.toggleClass('is-fullscreen', this.isFullscreen);
    }

    private bindFullscreenKeys(): void {
        this.unbindFullscreenKeys();
        if (!this.isFullscreen) return;
        this.onFullscreenKeyDown = (e: KeyboardEvent) => {
            if (e.key !== 'Escape') return;
            if (this.connectDrag || this.connectPick) return; // connect owns Escape
            e.preventDefault();
            void this.setFullscreen(false);
        };
        window.addEventListener('keydown', this.onFullscreenKeyDown);
        this.onNativeFullscreenChange = () => {
            const nativeOn = !!activeDocument.fullscreenElement;
            if (!nativeOn && this.isFullscreen) {
                // User exited via browser/OS chrome — sync CSS mode off.
                void this.setFullscreen(false, false);
            }
        };
        activeDocument.addEventListener('fullscreenchange', this.onNativeFullscreenChange);
    }

    private async setFullscreen(on: boolean, useNative = true): Promise<void> {
        if (on && !this.isFullscreen) {
            this.preFullscreenView = {
                panX: this.panX,
                panY: this.panY,
                zoom: this.zoom,
            };
        }

        this.isFullscreen = on;
        this.applyFullscreenClass();
        this.bindFullscreenKeys();

        const host = this.fullscreenHost();
        try {
            if (on && useNative && host.requestFullscreen && !activeDocument.fullscreenElement) {
                await host.requestFullscreen();
            } else if (!on && activeDocument.fullscreenElement) {
                await activeDocument.exitFullscreen();
            }
        } catch {
            // CSS overlay still works if native fullscreen is blocked.
        }

        this.syncFullscreenButton();

        // Wait for layout/fullscreen chrome, then resize + center content.
        const settle = () => {
            if (!this.wrapper) return;
            const rect = this.wrapper.getBoundingClientRect();
            if (rect.width > 0 && rect.height > 0) {
                this.width = Math.max(320, rect.width);
                this.height = Math.max(240, rect.height);
                this.svg?.setAttribute('viewBox', `0 0 ${this.width} ${this.height}`);
            }
            if (on) {
                this.fitContentInView();
            } else if (this.preFullscreenView) {
                this.panX = this.preFullscreenView.panX;
                this.panY = this.preFullscreenView.panY;
                this.zoom = this.preFullscreenView.zoom;
                this.preFullscreenView = null;
                this.updateTransform();
            }
            this.updatePositions();
        };
        window.requestAnimationFrame(() => {
            window.requestAnimationFrame(settle);
        });
    }

    /** Pan/zoom so the current node cluster sits centered in the SVG viewport. */
    private fitContentInView(padding = 56): void {
        if (this.nodes.length === 0 || !this.svg) return;

        let minX = Infinity;
        let minY = Infinity;
        let maxX = -Infinity;
        let maxY = -Infinity;
        for (const node of this.nodes) {
            const r = this.nodeRadius(node) + 18;
            minX = Math.min(minX, node.x - r);
            minY = Math.min(minY, node.y - r);
            maxX = Math.max(maxX, node.x + r);
            maxY = Math.max(maxY, node.y + r + 16);
        }
        if (!Number.isFinite(minX) || !Number.isFinite(maxX)) return;

        const contentW = Math.max(40, maxX - minX);
        const contentH = Math.max(40, maxY - minY);
        const availW = Math.max(120, this.width - padding * 2);
        const availH = Math.max(120, this.height - padding * 2);
        const zoom = Math.min(5, Math.max(0.25, Math.min(availW / contentW, availH / contentH)));
        const cx = (minX + maxX) / 2;
        const cy = (minY + maxY) / 2;
        this.zoom = zoom;
        this.panX = this.width / 2 - cx * zoom;
        this.panY = this.height / 2 - cy * zoom;
        this.updateTransform();
    }

    private syncFullscreenButton(): void {
        if (!this.fullscreenBtn) return;
        this.fullscreenBtn.toggleClass('active', this.isFullscreen);
        this.fullscreenBtn.setAttribute(
            'aria-label',
            this.isFullscreen ? t('Exit fullscreen') : t('Fullscreen'),
        );
        this.fullscreenBtn.empty();
        const icon = this.fullscreenBtn.createSpan();
        obsidian.setIcon(icon, this.isFullscreen ? 'minimize-2' : 'maximize-2');
        this.fullscreenBtn.createSpan({
            text: ` ${this.isFullscreen ? t('Exit fullscreen') : t('Fullscreen')}`,
        });
    }

    private toggleFullscreen(): void {
        void this.setFullscreen(!this.isFullscreen);
    }

    // ── Connect by right-drag (rubber-band) ────────────

    private toConnectNode(node: StoryGraphNode): StoryGraphConnectNode | null {
        if (!node.filePath) return null;
        return {
            id: node.id,
            label: node.label,
            filePath: node.filePath,
            entityType: node.entityType,
        };
    }

    private parentIdForEdge(edge: StoryGraphEdge): string {
        if (edge.relationCategoryId) return `link:${edge.relationCategoryId}`;
        if (edge.kind === 'wikilink') return 'link:default';
        if (edge.edgeStyleId) return `char:${edge.edgeStyleId}`;
        if (isRelEdgeKind(edge.kind)) {
            return `char:${relKindToRelationshipType(edge.kind as RelEdgeKind)}`;
        }
        return `edge:${edge.kind}`;
    }

    private parentLabelForEdge(edge: StoryGraphEdge): string {
        if (edge.edgeLabel) return edge.edgeLabel;
        if (edge.relationCategoryId) {
            const cat = this.relationCategories.find(c => c.id === edge.relationCategoryId);
            if (cat?.label) return cat.label;
        }
        if (edge.kind === 'wikilink') return t('Default link');
        if (edge.edgeStyleId) {
            const style = this.characterRelationTypes.find(s => s.id === edge.edgeStyleId);
            if (style) return displayCharacterRelationLabel(style);
        }
        return '';
    }

    private toFocusEdge(
        a: StoryGraphNode,
        b: StoryGraphNode,
        edge?: StoryGraphEdge,
    ): StoryGraphFocusEdge | null {
        if (!a.filePath || !b.filePath) return null;
        const parentId = edge ? this.parentIdForEdge(edge) : 'link:default';
        const parentLabel = edge ? this.parentLabelForEdge(edge) : '';
        const parentColor = edge?.edgeColor
            || (edge?.relationCategoryId
                ? this.relationCategories.find(c => c.id === edge.relationCategoryId)?.color
                : undefined);
        return {
            left: { name: a.label, filePath: a.filePath },
            right: { name: b.label, filePath: b.filePath },
            parentId,
            parentLabel,
            parentColor,
        };
    }

    private clearConnectDrag(showNotice = false): void {
        const wasActive = !!this.connectDrag;
        if (this.connectDrag?.hoverId) {
            this.setNodeConnectHover(this.connectDrag.hoverId, false);
        }
        this.connectDrag?.line.remove();
        this.connectDrag = null;
        if (!this.connectPick) {
            this.wrapper?.removeClass('is-connecting');
            if (this.onConnectKeyDown) {
                window.removeEventListener('keydown', this.onConnectKeyDown);
                this.onConnectKeyDown = null;
            }
        }
        if (this.onConnectDragMove) {
            window.removeEventListener('mousemove', this.onConnectDragMove);
            this.onConnectDragMove = null;
        }
        if (this.onConnectDragUp) {
            window.removeEventListener('mouseup', this.onConnectDragUp);
            this.onConnectDragUp = null;
        }
        if (wasActive && showNotice) {
            new Notice(t('Connect cancelled'));
        }
    }

    private clearConnectPick(showNotice = false): void {
        const wasActive = !!this.connectPick;
        if (this.connectPick) {
            this.setNodeConnectHover(this.connectPick.fromNodeId, false);
        }
        this.connectPick = null;
        this.connectBanner?.remove();
        this.connectBanner = null;
        if (!this.connectDrag) {
            this.wrapper?.removeClass('is-connecting');
            if (this.onConnectKeyDown) {
                window.removeEventListener('keydown', this.onConnectKeyDown);
                this.onConnectKeyDown = null;
            }
        }
        if (wasActive && showNotice) {
            new Notice(t('Connect cancelled'));
        }
    }

    /** Touch-friendly / menu: arm source, then tap another node. */
    private beginConnectPick(node: StoryGraphNode): void {
        if (!this.onConnectNodes) return;
        const from = this.toConnectNode(node);
        if (!from) {
            new Notice(t('This node has no vault file'));
            return;
        }
        this.clearConnectDrag(false);
        this.clearConnectPick(false);
        this.connectPick = { from, fromNodeId: node.id };
        this.wrapper?.addClass('is-connecting');
        this.setNodeConnectHover(node.id, true);
        this.onConnectKeyDown = (ke: KeyboardEvent) => {
            if (ke.key === 'Escape') {
                ke.preventDefault();
                this.clearConnectPick(true);
            }
        };
        window.addEventListener('keydown', this.onConnectKeyDown);
        this.renderConnectPickBanner();
        new Notice(t('Tap another node to connect'));
    }

    private renderConnectPickBanner(): void {
        this.connectBanner?.remove();
        this.connectBanner = null;
        if (!this.connectPick) return;
        const banner = this.container.createDiv('story-graph-connect-banner');
        banner.createSpan({
            text: t('From {name} — tap a target node (Esc to cancel)', {
                name: this.connectPick.from.label,
            }),
        });
        const cancel = banner.createEl('button', {
            cls: 'story-graph-connect-cancel',
            text: t('Cancel'),
            attr: { type: 'button' },
        });
        cancel.addEventListener('click', () => this.clearConnectPick(true));
        this.connectBanner = banner;
    }

    private completeConnectPick(target: StoryGraphNode, clientX: number, clientY: number): void {
        if (!this.connectPick) return;
        const from = this.connectPick.from;
        if (target.id === this.connectPick.fromNodeId) {
            new Notice(t('Pick a different node'));
            return;
        }
        const to = this.toConnectNode(target);
        if (!to) {
            new Notice(t('This node has no vault file'));
            return;
        }
        this.clearConnectPick(false);
        this.showConnectDropMenuAt(clientX, clientY, from, to);
    }

    private clientToGraph(clientX: number, clientY: number): { x: number; y: number } | null {
        if (!this.svg) return null;
        const svgRect = this.svg.getBoundingClientRect();
        return {
            x: (clientX - svgRect.left - this.panX) / this.zoom,
            y: (clientY - svgRect.top - this.panY) / this.zoom,
        };
    }

    private hitTestNode(clientX: number, clientY: number, exceptId?: string): StoryGraphNode | null {
        const pt = this.clientToGraph(clientX, clientY);
        if (!pt) return null;
        let best: StoryGraphNode | null = null;
        let bestDist = Infinity;
        for (const node of this.nodes) {
            if (exceptId && node.id === exceptId) continue;
            const r = this.nodeRadius(node) + 10;
            const d = Math.hypot(node.x - pt.x, node.y - pt.y);
            if (d <= r && d < bestDist) {
                best = node;
                bestDist = d;
            }
        }
        return best;
    }

    private setNodeConnectHover(nodeId: string, on: boolean): void {
        const dom = this.nodeDom.get(nodeId);
        if (!dom) return;
        dom.shape.classList.toggle('is-connect-target', on);
    }

    private startConnectDrag(node: StoryGraphNode, e: MouseEvent): void {
        if (!this.onConnectNodes || !this.layer) return;
        const from = this.toConnectNode(node);
        if (!from) {
            new Notice(t('This node has no vault file'));
            return;
        }
        this.clearConnectDrag(false);
        const svgNS = 'http://www.w3.org/2000/svg';
        const line = activeDocument.createElementNS(svgNS, 'line');
        line.setAttribute('x1', String(node.x));
        line.setAttribute('y1', String(node.y));
        line.setAttribute('x2', String(node.x));
        line.setAttribute('y2', String(node.y));
        line.setAttribute('stroke', 'var(--interactive-accent)');
        line.setAttribute('stroke-width', '2');
        line.setAttribute('stroke-dasharray', '5,4');
        line.setAttribute('stroke-opacity', '0.95');
        line.setAttribute('marker-end', 'url(#sg-arrow-end)');
        line.classList.add('story-graph-connect-drag-line');
        line.style.pointerEvents = 'none';
        this.layer.appendChild(line);

        this.connectDrag = {
            fromNode: node,
            from,
            line,
            startClientX: e.clientX,
            startClientY: e.clientY,
            moved: false,
            hoverId: null,
        };
        this.wrapper?.addClass('is-connecting');

        this.onConnectKeyDown = (ke: KeyboardEvent) => {
            if (ke.key === 'Escape') {
                ke.preventDefault();
                this.clearConnectDrag(true);
            }
        };
        window.addEventListener('keydown', this.onConnectKeyDown);

        this.onConnectDragMove = (me: MouseEvent) => {
            const drag = this.connectDrag;
            if (!drag) return;
            const dist = Math.hypot(me.clientX - drag.startClientX, me.clientY - drag.startClientY);
            if (dist > 6) drag.moved = true;
            const pt = this.clientToGraph(me.clientX, me.clientY);
            if (pt) {
                drag.line.setAttribute('x2', String(pt.x));
                drag.line.setAttribute('y2', String(pt.y));
            }
            const hover = this.hitTestNode(me.clientX, me.clientY, drag.fromNode.id);
            const nextId = hover?.id || null;
            if (drag.hoverId && drag.hoverId !== nextId) {
                this.setNodeConnectHover(drag.hoverId, false);
            }
            if (nextId && nextId !== drag.hoverId) {
                this.setNodeConnectHover(nextId, true);
            }
            drag.hoverId = nextId;
        };
        this.onConnectDragUp = (ue: MouseEvent) => {
            const drag = this.connectDrag;
            if (!drag) return;
            const moved = drag.moved;
            const from = drag.from;
            const hover = this.hitTestNode(ue.clientX, ue.clientY, drag.fromNode.id);
            this.clearConnectDrag(false);
            // Suppress the trailing contextmenu event after right mouseup.
            this.suppressNodeContextMenu = true;
            window.setTimeout(() => { this.suppressNodeContextMenu = false; }, 0);
            if (!moved) {
                // Treat as a plain right-click → node menu (image etc.)
                this.showNodeContextMenu(ue, node);
                return;
            }
            if (!hover) {
                new Notice(t('Drop on a target node to connect'));
                return;
            }
            const to = this.toConnectNode(hover);
            if (!to) {
                new Notice(t('This node has no vault file'));
                return;
            }
            this.showConnectDropMenu(ue, from, to);
        };
        window.addEventListener('mousemove', this.onConnectDragMove);
        window.addEventListener('mouseup', this.onConnectDragUp);
    }

    private showConnectDropMenu(
        e: MouseEvent,
        from: StoryGraphConnectNode,
        to: StoryGraphConnectNode,
    ): void {
        this.showConnectDropMenuAt(e.clientX, e.clientY, from, to);
    }

    private showConnectDropMenuAt(
        x: number,
        y: number,
        from: StoryGraphConnectNode,
        to: StoryGraphConnectNode,
    ): void {
        if (!this.onConnectNodes) return;
        const menu = new Menu();
        menu.addItem(item => {
            item.setTitle(`${from.label} → ${to.label}`);
            item.setDisabled(true);
        });
        menu.addSeparator();
        menu.addItem(item => {
            item.setTitle(t('Connect with wikilink'));
            item.setIcon('link');
            item.onClick(() => {
                void this.onConnectNodes?.(from, to, 'wikilink');
            });
        });
        if (from.entityType === 'character' && to.entityType === 'character') {
            menu.addSeparator();
            menu.addItem(item => {
                item.setTitle(t('Connect character relation'));
                item.setIcon('heart-handshake');
                item.setDisabled(true);
            });
            for (const style of this.characterRelationTypes) {
                menu.addItem(item => {
                    item.setTitle(`  ${displayCharacterRelationLabel(style)}`);
                    item.onClick(() => {
                        void this.onConnectNodes?.(from, to, style.id);
                    });
                });
            }
        }
        menu.showAtPosition({ x, y });
    }

    private showCanvasConnectMenu(e: MouseEvent): void {
        const menu = new Menu();
        menu.addItem(item => {
            item.setTitle(t('Right-drag from a node to connect'));
            item.setDisabled(true);
        });
        menu.addItem(item => {
            item.setTitle(t('Or open a node menu and choose Connect to…'));
            item.setDisabled(true);
        });
        if (this.connectPick) {
            menu.addSeparator();
            menu.addItem(item => {
                item.setTitle(t('Cancel connect'));
                item.setIcon('x');
                item.onClick(() => this.clearConnectPick(true));
            });
        }
        menu.showAtMouseEvent(e);
    }

    private showNodeContextMenu(e: MouseEvent, node: StoryGraphNode): void {
        const menu = new Menu();
        menu.addItem(item => {
            item.setTitle(node.label);
            item.setDisabled(true);
        });
        menu.addSeparator();

        if (this.onConnectNodes && this.toConnectNode(node)) {
            menu.addItem(item => {
                item.setTitle(t('Connect to…'));
                item.setIcon('spline');
                item.onClick(() => this.beginConnectPick(node));
            });
            menu.addItem(item => {
                item.setTitle(t('Tip: on mouse, right-drag to connect'));
                item.setDisabled(true);
            });
            menu.addSeparator();
        } else if (this.onConnectNodes) {
            menu.addItem(item => {
                item.setTitle(t('This node has no vault file'));
                item.setDisabled(true);
            });
            menu.addSeparator();
        }

        if (this.connectPick) {
            menu.addItem(item => {
                item.setTitle(t('Cancel connect'));
                item.setIcon('x');
                item.onClick(() => this.clearConnectPick(true));
            });
            menu.addSeparator();
        }

        if (this.onPickNodeImage) {
            const current = this.resolveNodeImagePath(node);
            menu.addItem(item => {
                item.setTitle(current ? t('Change node image') : t('Set node image'));
                item.setIcon('image');
                item.onClick(() => { void this.pickImageForNode(node); });
            });
            if (this.layoutImages.has(this.layoutKey(node))) {
                menu.addItem(item => {
                    item.setTitle(t('Clear node image'));
                    item.setIcon('image-off');
                    item.onClick(() => {
                        this.layoutImages.delete(this.layoutKey(node));
                        this.scheduleLayoutSave(true);
                        this.render();
                    });
                });
            }
        }
        menu.showAtMouseEvent(e);
    }

    private async pickImageForNode(node: StoryGraphNode): Promise<void> {
        if (!this.onPickNodeImage) return;
        const connect = this.toConnectNode(node) || {
            id: node.id,
            label: node.label,
            filePath: node.filePath || '',
            entityType: node.entityType,
        };
        const current = this.resolveNodeImagePath(node);
        const next = await this.onPickNodeImage(connect, current || undefined);
        if (next === undefined) return;
        const key = this.layoutKey(node);
        if (!next) {
            this.layoutImages.delete(key);
        } else {
            this.layoutImages.set(key, next);
        }
        this.scheduleLayoutSave(true);
        this.render();
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
        makeToggle(t('Codex'), 'book-open', this.showCodex, v => { this.showCodex = v; });
        makeToggle(t('Relationships'), 'heart-handshake', this.showRelationships, v => { this.showRelationships = v; });
        makeToggle(t('Props'), 'tag', this.showProps, v => { this.showProps = v; });
        makeToggle(t('Other'), 'file-text', this.showOther, v => { this.showOther = v; });

        const tools = bar.createDiv('story-graph-filter-tools');

        const sizeWrap = tools.createDiv('story-graph-size-control');
        sizeWrap.createSpan({ text: t('Node size') });
        const sizeInput = sizeWrap.createEl('input', {
            attr: {
                type: 'range',
                min: '0.6',
                max: '1.8',
                step: '0.1',
                value: String(this.nodeScale),
                'aria-label': t('Node size'),
            },
        }) as HTMLInputElement;
        sizeInput.addEventListener('input', () => {
            this.nodeScale = Number(sizeInput.value) || 1;
            if (this.svg) {
                this.buildSVG();
                this.updatePositions();
            }
            this.scheduleLayoutSave();
        });

        const saveBtn = tools.createEl('button', {
            cls: 'story-graph-filter-btn',
            attr: { 'aria-label': t('Save layout'), type: 'button' },
        });
        const saveIcon = saveBtn.createSpan();
        obsidian.setIcon(saveIcon, 'save');
        saveBtn.createSpan({ text: ` ${t('Save layout')}` });
        saveBtn.addEventListener('click', () => { void this.saveLayoutNow(); });

        const resetBtn = tools.createEl('button', {
            cls: 'story-graph-filter-btn',
            attr: { 'aria-label': t('Reset layout'), type: 'button' },
        });
        const resetIcon = resetBtn.createSpan();
        obsidian.setIcon(resetIcon, 'refresh-cw');
        resetBtn.createSpan({ text: ` ${t('Reset layout')}` });
        resetBtn.addEventListener('click', () => {
            this.layoutPositions.clear();
            for (const node of this.nodes) node.pinned = false;
            this.panX = 0;
            this.panY = 0;
            this.zoom = 1;
            this.hasHydratedViewport = true;
            this.render();
            this.scheduleLayoutSave(true);
            new Notice(t('Story Graph layout reset'));
        });

        const exportBtn = tools.createEl('button', {
            cls: 'story-graph-filter-btn',
            attr: { 'aria-label': t('Export image'), type: 'button' },
        });
        const exportIcon = exportBtn.createSpan();
        obsidian.setIcon(exportIcon, 'image-down');
        exportBtn.createSpan({ text: ` ${t('Export image')}` });
        exportBtn.addEventListener('click', () => { void this.exportAsPng(); });

        this.fullscreenBtn = tools.createEl('button', {
            cls: `story-graph-filter-btn ${this.isFullscreen ? 'active' : ''}`,
            attr: {
                'aria-label': this.isFullscreen ? t('Exit fullscreen') : t('Fullscreen'),
                type: 'button',
            },
        });
        this.syncFullscreenButton();
        this.fullscreenBtn.addEventListener('click', () => this.toggleFullscreen());

        if (this.onManageRelationCategories) {
            const manageBtn = tools.createEl('button', {
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

        // Row 1: node / entity types (color swatches)
        const nodeRow = legend.createDiv('story-graph-legend-row is-nodes');
        const items: [string, string, EntityType][] = [
            ['Scene', 'book-open', 'scene'],
            ['Character', 'user', 'character'],
            ['Location', 'map-pin', 'location'],
            ['Codex', 'book-open', 'codex'],
            ['Prop', 'tag', 'prop'],
            ['Other', 'file-text', 'other'],
        ];
        for (const [label, _icon, type] of items) {
            const item = nodeRow.createDiv('story-graph-legend-item');
            const swatch = item.createSpan({ cls: 'story-graph-legend-swatch' });
            swatch.setCssStyles({ backgroundColor: colors[type] });
            item.createSpan({ text: label });
        }

        // Row 2: relationship / edge types (color lines)
        const edgeRow = legend.createDiv('story-graph-legend-row is-edges');
        for (const style of this.characterRelationTypes) {
            const item = edgeRow.createDiv('story-graph-legend-item');
            const swatch = item.createSpan({ cls: 'story-graph-legend-swatch story-graph-legend-line' });
            swatch.setCssStyles({ borderBottomColor: style.color });
            item.createSpan({ text: displayCharacterRelationLabel(style) });
        }
        const defaultLink = edgeRow.createDiv('story-graph-legend-item');
        const defaultLinkSwatch = defaultLink.createSpan({
            cls: 'story-graph-legend-swatch story-graph-legend-line',
        });
        defaultLinkSwatch.setCssStyles({
            borderBottomColor: resolveColor('--text-muted', '#6B7280'),
        });
        defaultLink.createSpan({ text: t('Default link') });
        for (const category of this.relationCategories) {
            const item = edgeRow.createDiv('story-graph-legend-item');
            const swatch = item.createSpan({ cls: 'story-graph-legend-swatch story-graph-legend-line' });
            swatch.setCssStyles({ borderBottomColor: category.color });
            item.createSpan({ text: category.label });
        }
    }

    // ── Graph building ─────────────────────────────────

    private buildGraph(): void {
        const nodeMap = new Map<string, StoryGraphNode>();
        let edgeList: StoryGraphEdge[] = [];

        const ensureNode = (
            id: string,
            label: string,
            entityType: EntityType,
            filePath?: string,
            image?: string,
        ): StoryGraphNode => {
            if (!nodeMap.has(id)) {
                const key = filePath || id;
                const saved = this.layoutPositions.get(key) || this.layoutPositions.get(id);
                const docImage = filePath
                    ? (this.documents.find(d => d.filePath === filePath)?.image || image)
                    : image;
                nodeMap.set(id, {
                    id, label, entityType, weight: 0,
                    x: saved
                        ? saved.x
                        : this.width / 2 + (Math.random() - 0.5) * this.width * 0.6,
                    y: saved
                        ? saved.y
                        : this.height / 2 + (Math.random() - 0.5) * this.height * 0.6,
                    vx: 0, vy: 0, filePath,
                    image: docImage,
                    pinned: !!saved,
                });
            } else {
                const existing = nodeMap.get(id)!;
                if (filePath && !existing.filePath) existing.filePath = filePath;
                if (image && !existing.image) existing.image = image;
            }
            return nodeMap.get(id)!;
        };

        const isVisible = (entityType: EntityType): boolean => {
            if (entityType === 'scene') return this.showScenes;
            if (entityType === 'character') return this.showCharacters;
            if (entityType === 'location') return this.showLocations;
            if (entityType === 'codex') return this.showCodex;
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
                    const resolvedType = (configuredType === 'codex' ? 'codex' : configuredType) as EntityType;
                    if (resolvedType === 'character' && !this.showCharacters) continue;
                    if (resolvedType === 'location' && !this.showLocations) continue;
                    if (resolvedType === 'codex' && !this.showCodex) continue;
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
                const addRelEdges = (
                    names: string[] | string | undefined,
                    kind: EdgeKind,
                    meta?: {
                        label?: string;
                        color?: string;
                        arrow?: 'single' | 'double';
                        styleId?: string;
                    },
                ) => {
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
                        // Deduplicate bidirectional (same kind + label)
                        const labelKey = meta?.label || '';
                        const fwd = `${fromId}|${toId}|${kind}|${labelKey}`;
                        const rev = `${toId}|${fromId}|${kind}|${labelKey}`;
                        if (!edgeList.some(e => {
                            const k = `${e.source}|${e.target}|${e.kind}|${e.edgeLabel || ''}`;
                            return k === fwd || k === rev;
                        })) {
                            nodeMap.get(fromId)!.weight++;
                            nodeMap.get(toId)!.weight++;
                            const style = this.characterRelationTypes.find(
                                s => s.builtin && (s.baseType === kind || (kind === 'other-rel' && s.baseType === 'other')),
                            );
                            edgeList.push({
                                source: fromId,
                                target: toId,
                                kind,
                                edgeLabel: meta?.label || (style ? displayCharacterRelationLabel(style) : undefined),
                                edgeColor: meta?.color || style?.color,
                                edgeArrow: meta?.arrow || style?.arrow || 'double',
                                edgeStyleId: meta?.styleId || style?.id,
                            });
                        }
                    }
                };

                if (Array.isArray(char.relations)) {
                    for (const relation of char.relations) {
                        const style = resolveCharacterRelationStyle(relation, this.characterRelationTypes);
                        const baseType = style.baseType;
                        const kind: EdgeKind = baseType === 'other' ? 'other-rel' : baseType;
                        addRelEdges([relation.target], kind, {
                            label: displayCharacterRelationLabel(style),
                            color: style.color,
                            arrow: style.arrow,
                            styleId: style.id,
                        });
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
            edgeList = edgeList.filter(e => keep.has(e.source) && keep.has(e.target));
        }
        this.edges = this.applyFocusStrandThickness(edgeList, nodeMap);
        this.nodes = nodes;
        this.nodeById = new Map(nodes.map(n => [n.id, n]));
    }

    /**
     * Attach focus strand counts to parent edges. Main graph keeps a single
     * labeled line; thickness grows with the number of internal strands.
     */
    private applyFocusStrandThickness(
        edgeList: StoryGraphEdge[],
        nodeMap: Map<string, StoryGraphNode>,
    ): StoryGraphEdge[] {
        if (!this.focusBundles || Object.keys(this.focusBundles).length === 0) {
            return edgeList;
        }

        return edgeList.map(edge => {
            const a = nodeMap.get(edge.source);
            const b = nodeMap.get(edge.target);
            const aPath = edge.sourcePath || a?.filePath;
            const bPath = edge.targetPath || b?.filePath;
            if (!aPath || !bPath) return edge;
            const parentId = this.parentIdForEdge(edge);
            const found = lookupStoryGraphFocusBundle(
                this.focusBundles as Record<string, unknown>,
                aPath,
                bPath,
                parentId,
            );
            if (!found) return edge;
            const count = found.bundle.strands.length;
            if (count <= 0) return { ...edge, strandCount: 0 };
            return { ...edge, strandCount: count };
        });
    }

    // ── Simulation ─────────────────────────────────────

    private runSimulation(): void {
        const pinnedCount = this.nodes.filter(n => n.pinned).length;
        // Fully restored layouts: paint once, no force settle.
        if (pinnedCount > 0 && pinnedCount >= this.nodes.length) {
            this.updatePositions();
            return;
        }

        let iterations = 0;
        const maxIterations = pinnedCount > 0
            ? 80
            : (this.nodes.length > 60 ? 180 : 280);
        // Throttle SVG attribute writes on large graphs.
        const paintEvery = this.nodes.length > 80 ? 2 : 1;

        const tick = () => {
            if (!this.svg) return;
            iterations++;

            this.applyForces();

            for (const node of this.nodes) {
                if (node === this.dragging || node.pinned) continue;
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
            } else {
                // Persist auto-layout for unpinned nodes after settle.
                this.scheduleLayoutSave();
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

    private ensureArrowMarkers(svgNS: string): void {
        if (!this.svg) return;
        const defs = activeDocument.createElementNS(svgNS, 'defs');
        const makeMarker = (id: string, orient: string) => {
            const marker = activeDocument.createElementNS(svgNS, 'marker');
            marker.setAttribute('id', id);
            marker.setAttribute('viewBox', '0 0 10 10');
            marker.setAttribute('refX', '9');
            marker.setAttribute('refY', '5');
            marker.setAttribute('markerWidth', '6');
            marker.setAttribute('markerHeight', '6');
            marker.setAttribute('orient', orient);
            marker.setAttribute('markerUnits', 'strokeWidth');
            const path = activeDocument.createElementNS(svgNS, 'path');
            path.setAttribute('d', 'M 0 1 L 9 5 L 0 9 z');
            path.setAttribute('fill', 'context-stroke');
            marker.appendChild(path);
            defs.appendChild(marker);
        };
        makeMarker('sg-arrow-end', 'auto');
        makeMarker('sg-arrow-start', 'auto-start-reverse');
        this.svg.appendChild(defs);
    }

    private buildSVG(): void {
        if (!this.svg) return;
        const svgNS = 'http://www.w3.org/2000/svg';
        while (this.svg.firstChild) this.svg.removeChild(this.svg.firstChild);
        this.edgeDom = [];
        this.nodeDom.clear();

        this.ensureArrowMarkers(svgNS);

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
            const focusEdge = this.toFocusEdge(a, b, edge);
            const canFocus = !!focusEdge && !!this.onEdgeFocus;
            const canRelMenu = isRelEdge && !!this.onRelationEdgeContextMenu;
            const canLinkMenu = isWikilinkEdge && !!this.onLinkEdgeContextMenu;
            let hit: SVGGeometryElement | undefined;
            const strandCount = edge.strandCount || 0;
            const strokeWidth = storyGraphEdgeStrokeWidth(
                strandCount,
                isRelEdge || isWikilinkEdge ? 2 : 1.5,
            );

            // Wide invisible hit: double-click opens focus for this parent edge's sub-strands.
            if (canFocus || canRelMenu || canLinkMenu) {
                hit = activeDocument.createElementNS(svgNS, 'line');
                setEdgeGeometry(hit, a.x, a.y, b.x, b.y);
                hit.setAttribute('fill', 'none');
                hit.setAttribute('stroke', 'transparent');
                hit.setAttribute('stroke-width', String(Math.max(14, strokeWidth + 10)));
                hit.style.cursor = 'pointer';
                hit.classList.add('story-graph-edge-hit');
                g.appendChild(hit);

                const relationEdgeInfo: RelationshipEdgeInfo = {
                    from: a.label,
                    to: b.label,
                    type: isRelEdge
                        ? relKindToRelationshipType(edge.kind as RelEdgeKind)
                        : 'other',
                    styleId: edge.edgeStyleId,
                };

                const openMenu = (e: MouseEvent) => {
                    e.preventDefault();
                    e.stopPropagation();
                    if (isRelEdge) {
                        this.onRelationEdgeContextMenu?.(relationEdgeInfo, e);
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
                    } else if (focusEdge && this.onEdgeFocus) {
                        const menu = new Menu();
                        menu.addItem(item => {
                            item.setTitle(focusEdge.parentLabel || `${a.label} ↔ ${b.label}`);
                            item.setDisabled(true);
                        });
                        menu.addSeparator();
                        menu.addItem(item => {
                            item.setTitle(t('Focus relationship'));
                            item.setIcon('scan-eye');
                            item.onClick(() => this.onEdgeFocus?.(focusEdge, e));
                        });
                        menu.showAtMouseEvent(e);
                    }
                };
                hit.addEventListener('contextmenu', openMenu);
                hit.addEventListener('dblclick', (e) => {
                    if (!focusEdge || !this.onEdgeFocus) return;
                    e.preventDefault();
                    e.stopPropagation();
                    this.onEdgeFocus(focusEdge, e);
                });
            }

            const category = edge.relationCategoryId
                ? this.relationCategories.find(item => item.id === edge.relationCategoryId)
                : undefined;
            let arrow: StoryGraphRelationArrow | 'none' = 'none';
            if (edge.edgeArrow === 'single' || edge.edgeArrow === 'double') {
                arrow = edge.edgeArrow;
            } else if (isWikilinkEdge) {
                arrow = category?.arrow === 'double' ? 'double' : 'single';
            } else if (isRelEdge) {
                arrow = 'double';
            }

            const padA = this.nodeRadius(a) + (arrow !== 'none' ? 2 : 0);
            const padB = this.nodeRadius(b) + (arrow !== 'none' ? 2 : 0);
            const inset = arrow === 'none'
                ? { x1: a.x, y1: a.y, x2: b.x, y2: b.y }
                : insetEdgePoints(a.x, a.y, b.x, b.y, padA, padB);

            const line = activeDocument.createElementNS(svgNS, 'line');
            const mid = setEdgeGeometry(
                line,
                inset.x1,
                inset.y1,
                inset.x2,
                inset.y2,
            );
            line.setAttribute('fill', 'none');
            const stroke = edge.edgeColor
                || getEdgeColor(edge.kind, edge.relationCategoryId, this.relationCategories);
            line.setAttribute('stroke', stroke);
            line.setAttribute('stroke-width', String(strokeWidth));
            line.setAttribute('stroke-opacity', isRelEdge || isWikilinkEdge ? '0.9' : '0.45');
            line.setAttribute('stroke-linecap', 'round');
            line.style.pointerEvents = hit ? 'none' : '';
            const dash = EDGE_DASH[edge.kind];
            if (dash) line.setAttribute('stroke-dasharray', dash);
            if (arrow === 'single' || arrow === 'double') {
                line.setAttribute('marker-end', 'url(#sg-arrow-end)');
            }
            if (arrow === 'double') {
                line.setAttribute('marker-start', 'url(#sg-arrow-start)');
            }
            const title = activeDocument.createElementNS(svgNS, 'title');
            const arrowGlyph = arrow === 'double' ? '↔' : '→';
            // Main graph shows only the parent label (e.g. 技能), never child strand names.
            const labelText = edge.edgeLabel || category?.label;
            const depthHint = strandCount > 0
                ? ` · ${strandCount} ${t('internal strands')}`
                : '';
            title.textContent = labelText
                ? `${a.label} ${arrowGlyph} ${b.label}: ${labelText}${depthHint}`
                : `${a.label} ${arrowGlyph} ${b.label}${depthHint}`;
            line.appendChild(title);
            g.appendChild(line);

            let label: SVGTextElement | undefined;
            if (labelText) {
                label = activeDocument.createElementNS(svgNS, 'text');
                label.setAttribute('x', String(mid.midX));
                label.setAttribute('y', String(mid.midY - 4));
                label.setAttribute('text-anchor', 'middle');
                label.setAttribute('fill', edge.edgeColor || category?.color || stroke);
                label.setAttribute('font-size', strandCount > 2 ? '11' : '10');
                label.setAttribute('font-weight', strandCount > 0 ? '600' : '500');
                label.setAttribute('class', 'story-graph-edge-label');
                label.textContent = labelText;
                g.appendChild(label);
            }
            this.edgeDom.push({
                line,
                hit,
                label,
                source: edge.source,
                target: edge.target,
                kind: edge.kind,
                edge,
                arrow,
            });
        }

        for (const node of this.nodes) {
            const color = colors[node.entityType];
            const radius = this.nodeRadius(node);
            const imagePath = this.resolveNodeImagePath(node);
            const imageUrl = imagePath && this.resolveImageUrl
                ? this.resolveImageUrl(imagePath)
                : '';
            let shape: SVGElement;
            let hasAvatar = false;
            let avatarCircle: SVGCircleElement | undefined;
            let avatarImage: SVGImageElement | undefined;
            let avatarRing: SVGCircleElement | undefined;
            let avatarClipCircle: SVGCircleElement | undefined;

            if (imageUrl) {
                hasAvatar = true;
                const group = activeDocument.createElementNS(svgNS, 'g');
                group.classList.add('story-graph-node', 'story-graph-node-avatar', `story-graph-node-${node.entityType}`);

                const clipId = `sg-clip-${node.id.replace(/[^a-zA-Z0-9_-]/g, '_')}`;
                const clip = activeDocument.createElementNS(svgNS, 'clipPath');
                clip.setAttribute('id', clipId);
                avatarClipCircle = activeDocument.createElementNS(svgNS, 'circle');
                avatarClipCircle.setAttribute('cx', String(node.x));
                avatarClipCircle.setAttribute('cy', String(node.y));
                avatarClipCircle.setAttribute('r', String(radius));
                clip.appendChild(avatarClipCircle);
                // Attach clip to the root defs created by ensureArrowMarkers
                const defs = this.svg?.querySelector('defs');
                defs?.appendChild(clip);

                avatarCircle = activeDocument.createElementNS(svgNS, 'circle');
                avatarCircle.setAttribute('cx', String(node.x));
                avatarCircle.setAttribute('cy', String(node.y));
                avatarCircle.setAttribute('r', String(radius));
                avatarCircle.setAttribute('fill', color);
                avatarCircle.setAttribute('fill-opacity', '0.35');
                group.appendChild(avatarCircle);

                avatarImage = activeDocument.createElementNS(svgNS, 'image');
                avatarImage.setAttribute('href', imageUrl);
                avatarImage.setAttribute('x', String(node.x - radius));
                avatarImage.setAttribute('y', String(node.y - radius));
                avatarImage.setAttribute('width', String(radius * 2));
                avatarImage.setAttribute('height', String(radius * 2));
                avatarImage.setAttribute('preserveAspectRatio', 'xMidYMid slice');
                avatarImage.setAttribute('clip-path', `url(#${clipId})`);
                group.appendChild(avatarImage);

                avatarRing = activeDocument.createElementNS(svgNS, 'circle');
                avatarRing.setAttribute('cx', String(node.x));
                avatarRing.setAttribute('cy', String(node.y));
                avatarRing.setAttribute('r', String(radius));
                avatarRing.setAttribute('fill', 'none');
                avatarRing.setAttribute('stroke', color);
                avatarRing.setAttribute('stroke-width', '2.5');
                avatarRing.classList.add('story-graph-node-avatar-ring');
                group.appendChild(avatarRing);

                shape = group;
            } else if (node.entityType === 'scene') {
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
            // Avatars: label sits outside the ring below the portrait.
            const labelY = hasAvatar
                ? node.y + radius + 14
                : (node.entityType === 'scene'
                    ? node.y + radius * 1.6 / 2 + 14
                    : node.y + radius + 14);
            text.setAttribute('x', String(node.x));
            text.setAttribute('y', String(labelY));
            text.setAttribute('text-anchor', 'middle');
            text.setAttribute('fill', 'var(--text-normal)');
            text.setAttribute('font-size', hasAvatar || node.entityType !== 'scene' ? '11' : '10');
            text.setAttribute('font-weight', hasAvatar || node.entityType !== 'scene' ? '600' : '400');
            if (hasAvatar) text.classList.add('story-graph-node-label-outer');
            const maxLen = node.entityType === 'scene' ? 18 : 16;
            text.textContent = node.label.length > maxLen
                ? node.label.substring(0, maxLen - 1) + '…'
                : node.label;
            // Hide labels when very dense — keep avatar labels visible (user intent).
            if (!hasAvatar && this.nodes.length > 70) text.setAttribute('display', 'none');
            g.appendChild(text);

            this.nodeDom.set(node.id, {
                shape,
                label: text,
                entityType: node.entityType,
                radius,
                hasAvatar,
                avatarCircle,
                avatarImage,
                avatarRing,
                avatarClipCircle,
            });
        }

        this.svgBuilt = true;
    }

    private updatePositions(): void {
        if (!this.svgBuilt) return;

        for (const ed of this.edgeDom) {
            const a = this.nodeById.get(ed.source);
            const b = this.nodeById.get(ed.target);
            if (!a || !b) continue;
            const arrow = ed.arrow || 'none';
            const padA = this.nodeRadius(a) + (arrow !== 'none' ? 2 : 0);
            const padB = this.nodeRadius(b) + (arrow !== 'none' ? 2 : 0);
            const inset = arrow === 'none'
                ? { x1: a.x, y1: a.y, x2: b.x, y2: b.y }
                : insetEdgePoints(a.x, a.y, b.x, b.y, padA, padB);
            const mid = setEdgeGeometry(
                ed.line,
                inset.x1,
                inset.y1,
                inset.x2,
                inset.y2,
            );
            if (ed.hit) {
                setEdgeGeometry(ed.hit, a.x, a.y, b.x, b.y);
            }
            if (ed.label) {
                ed.label.setAttribute('x', String(mid.midX));
                ed.label.setAttribute('y', String(mid.midY - 4));
            }
        }

        for (const node of this.nodes) {
            const dom = this.nodeDom.get(node.id);
            if (!dom) continue;
            const r = this.nodeRadius(node);
            dom.radius = r;
            const shape = dom.shape;

            if (dom.hasAvatar) {
                for (const circle of [dom.avatarCircle, dom.avatarRing, dom.avatarClipCircle]) {
                    circle?.setAttribute('cx', String(node.x));
                    circle?.setAttribute('cy', String(node.y));
                    circle?.setAttribute('r', String(r));
                }
                if (dom.avatarImage) {
                    dom.avatarImage.setAttribute('x', String(node.x - r));
                    dom.avatarImage.setAttribute('y', String(node.y - r));
                    dom.avatarImage.setAttribute('width', String(r * 2));
                    dom.avatarImage.setAttribute('height', String(r * 2));
                }
                dom.label.setAttribute('x', String(node.x));
                dom.label.setAttribute('y', String(node.y + r + 14));
                continue;
            }

            if (dom.entityType === 'scene') {
                const rw = r * 2.4;
                const rh = r * 1.6;
                shape.setAttribute('x', String(node.x - rw / 2));
                shape.setAttribute('y', String(node.y - rh / 2));
                shape.setAttribute('width', String(rw));
                shape.setAttribute('height', String(rh));
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
                shape.setAttribute('r', String(r));
                dom.label.setAttribute('x', String(node.x));
                dom.label.setAttribute('y', String(node.y + r + 14));
            }
        }
    }

    private nodeRadius(node: StoryGraphNode): number {
        const base = node.entityType === 'scene' ? 10 : 14;
        const raw = base + Math.min(node.weight * 1.5, 12);
        return Math.max(8, raw * this.nodeScale);
    }

    private async exportAsPng(): Promise<void> {
        if (!this.svg || this.nodes.length === 0) {
            new Notice(t('Nothing to export'));
            return;
        }
        try {
            let minX = Infinity;
            let minY = Infinity;
            let maxX = -Infinity;
            let maxY = -Infinity;
            for (const node of this.nodes) {
                const r = this.nodeRadius(node) + 28;
                minX = Math.min(minX, node.x - r);
                minY = Math.min(minY, node.y - r);
                maxX = Math.max(maxX, node.x + r);
                maxY = Math.max(maxY, node.y + r + 16);
            }
            const pad = 28;
            minX -= pad;
            minY -= pad;
            maxX += pad;
            maxY += pad;
            const w = Math.max(200, Math.ceil(maxX - minX));
            const h = Math.max(200, Math.ceil(maxY - minY));

            const clone = this.svg.cloneNode(true) as SVGSVGElement;
            clone.querySelectorAll('.story-graph-edge-hit').forEach(el => el.remove());
            const layer = clone.querySelector('g');
            layer?.setAttribute('transform', '');
            clone.setAttribute('xmlns', 'http://www.w3.org/2000/svg');
            clone.setAttribute('viewBox', `${minX} ${minY} ${w} ${h}`);
            clone.setAttribute('width', String(w));
            clone.setAttribute('height', String(h));

            // Inline image hrefs as data URLs when possible for canvas safety.
            const images = Array.from(clone.querySelectorAll('image'));
            await Promise.all(images.map(async (img) => {
                const href = img.getAttribute('href') || img.getAttribute('xlink:href') || '';
                if (!href || href.startsWith('data:')) return;
                try {
                    const res = await fetch(href);
                    const blob = await res.blob();
                    const dataUrl = await new Promise<string>((resolve, reject) => {
                        const reader = new FileReader();
                        reader.onload = () => resolve(String(reader.result || ''));
                        reader.onerror = () => reject(reader.error);
                        reader.readAsDataURL(blob);
                    });
                    if (dataUrl) {
                        img.setAttribute('href', dataUrl);
                        img.removeAttribute('xlink:href');
                    }
                } catch {
                    /* keep original href */
                }
            }));

            const serializer = new XMLSerializer();
            const svgText = serializer.serializeToString(clone);
            const svgBlob = new Blob([svgText], { type: 'image/svg+xml;charset=utf-8' });
            const svgUrl = URL.createObjectURL(svgBlob);
            const bitmap = await new Promise<HTMLImageElement>((resolve, reject) => {
                const image = new Image();
                image.onload = () => resolve(image);
                image.onerror = () => reject(new Error('svg decode failed'));
                image.src = svgUrl;
            });

            const scale = 2;
            const canvas = activeDocument.createElement('canvas');
            canvas.width = w * scale;
            canvas.height = h * scale;
            const ctx = canvas.getContext('2d');
            if (!ctx) throw new Error('canvas unavailable');
            ctx.fillStyle = getComputedStyle(activeDocument.body)
                .getPropertyValue('--background-primary').trim() || '#ffffff';
            ctx.fillRect(0, 0, canvas.width, canvas.height);
            ctx.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
            URL.revokeObjectURL(svgUrl);

            const pngUrl = canvas.toDataURL('image/png');
            const anchor = activeDocument.createElement('a');
            const stamp = new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-');
            anchor.href = pngUrl;
            anchor.download = `story-graph-${stamp}.png`;
            activeDocument.body.appendChild(anchor);
            anchor.click();
            anchor.remove();
            new Notice(t('Story Graph image exported'));
        } catch (e) {
            console.error('[NarrativeLab] Story Graph export failed', e);
            new Notice(t('Failed to export Story Graph image'));
        }
    }

    private wireNodeEvents(el: SVGElement, node: StoryGraphNode): void {
        el.addEventListener('mousedown', (e) => {
            e.stopPropagation();

            // Right-drag: pull out a connection line to another node (mouse).
            if (e.button === 2) {
                e.preventDefault();
                this.startConnectDrag(node, e);
                return;
            }
            if (e.button !== 0) return;
            if (this.connectDrag) return;

            // Tap-to-connect (touch / menu-armed): next tap picks the target.
            if (this.connectPick) {
                e.preventDefault();
                this.completeConnectPick(node, e.clientX, e.clientY);
                return;
            }

            this.dragging = node;
            node.pinned = true;
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
                this.layoutPositions.set(this.layoutKey(node), { x: node.x, y: node.y });
                this.scheduleLayoutSave();
            };
            window.addEventListener('mousemove', onMove);
            window.addEventListener('mouseup', onUp);
        });

        // Touch: long-press often opens contextmenu; also allow direct tap when armed.
        el.addEventListener('touchend', (e) => {
            if (!this.connectPick || e.changedTouches.length === 0) return;
            e.preventDefault();
            e.stopPropagation();
            const touch = e.changedTouches[0];
            this.completeConnectPick(node, touch.clientX, touch.clientY);
        }, { passive: false });

        el.addEventListener('contextmenu', (e) => {
            e.preventDefault();
            e.stopPropagation();
            if (this.suppressNodeContextMenu || this.connectDrag?.moved) {
                this.suppressNodeContextMenu = false;
                return;
            }
            // If a drag just finished without move, startConnectDrag already opens the menu.
            if (this.connectDrag) return;
            this.showNodeContextMenu(e, node);
        });

        if (node.filePath && this.onSelectDocument) {
            el.addEventListener('dblclick', () => {
                if (this.connectDrag || this.connectPick) return;
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
