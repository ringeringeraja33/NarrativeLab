/* eslint-disable @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-argument, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-return, @typescript-eslint/no-floating-promises, @typescript-eslint/no-misused-promises, @typescript-eslint/no-unnecessary-type-assertion, @typescript-eslint/no-redundant-type-constituents, @typescript-eslint/no-unused-vars, no-unused-vars, no-useless-escape, no-control-regex, no-empty -- Obsidian's API surface and several untyped third-party libraries force dynamic dispatch; floating promises are intentional in DOM/event handlers; matching enable at end of file */
/**
 * RelationshipMap — interactive SVG graph of character relationships.
 *
 * Parses allies / enemies / family fields and renders
 * a force-directed-style graph using simple spring physics.
 *
 * Performance notes (large Libraries):
 * - Only characters with ≥1 relationship are shown by default
 * - Node count is capped
 * - Physics uses an index map; SVG is updated in place (no full rebuild each frame)
 */

import type { Character } from '../models/Character';
import { RELATION_BASE_TYPE_BY_CATEGORY, getRoleDisplay } from '../models/Character';
import { t } from '../utils/i18n';

export type RelationshipType = 'ally' | 'enemy' | 'romantic' | 'family' | 'mentor' | 'other';

export interface CharacterRelationship {
    from: string;
    to: string;
    type: RelationshipType;
    label?: string;
}

interface GraphNode {
    id: string;
    label: string;
    role?: string;
    x: number;
    y: number;
    vx: number;
    vy: number;
    /** Is this character matched to a full Character file? */
    hasProfile: boolean;
}

interface GraphEdge {
    source: string;
    target: string;
    /** Display names (preserve original casing for character lookup). */
    sourceLabel: string;
    targetLabel: string;
    type: RelationshipType;
    label?: string;
}

export interface RelationshipEdgeInfo {
    from: string;
    to: string;
    type: RelationshipType;
}

interface NodeDom {
    circle: SVGCircleElement;
    label: SVGTextElement;
    role?: SVGTextElement;
}

interface EdgeDom {
    type: RelationshipType;
    line: SVGLineElement;
    hit: SVGLineElement;
    edge: GraphEdge;
    label?: SVGTextElement;
}

/** Soft cap — beyond this the map becomes unusable in SVG + JS physics. */
const MAX_NODES = 80;
/** When node count exceeds this, hide per-node labels until zoomed in. */
const LABEL_HIDE_AT = 40;

/** Read a CSS custom property from the body, falling back to the provided default */
function resolveThemeColor(varName: string, fallback: string): string {
    const val = getComputedStyle(activeDocument.body).getPropertyValue(varName).trim();
    return val || fallback;
}

function getEdgeColors(): Record<RelationshipType, string> {
    return {
        ally: resolveThemeColor('--sl-rel-ally', '#4CAF50'),
        enemy: resolveThemeColor('--sl-rel-enemy', '#F44336'),
        romantic: resolveThemeColor('--sl-rel-romantic', '#E91E63'),
        family: resolveThemeColor('--sl-rel-family', '#FF9800'),
        mentor: resolveThemeColor('--sl-rel-mentor', '#9C27B0'),
        other: resolveThemeColor('--sl-rel-other', '#9E9E9E'),
    };
}

const EDGE_DASHES: Record<RelationshipType, string> = {
    ally: '',
    enemy: '6,3',
    romantic: '2,4',
    family: '',
    mentor: '8,3,2,3',
    other: '4,4',
};

const TYPE_LABELS: Record<RelationshipType, string> = {
    ally: 'Ally',
    enemy: 'Hostile',
    romantic: 'Romance',
    family: 'Family',
    mentor: 'Mentor',
    other: 'Other',
};

/**
 * Renders an interactive relationship map inside the given container.
 */
export class RelationshipMap {
    private container: HTMLElement;
    private characters: Character[];
    private nodes: GraphNode[] = [];
    private edges: GraphEdge[] = [];
    private nodeById = new Map<string, GraphNode>();
    private svg: SVGSVGElement | null = null;
    private layer: SVGGElement | null = null;
    private wrapper: HTMLElement | null = null;
    private width = 800;
    private height = 500;
    private animFrame = 0;
    private dragging: GraphNode | null = null;
    private panX = 0;
    private panY = 0;
    private isPanning = false;
    private panStart = { x: 0, y: 0 };
    private zoom = 1;
    private onSelectCharacter?: (name: string) => void;
    private onEdgeContextMenu?: (edge: RelationshipEdgeInfo, event: MouseEvent) => void;
    private resizeObserver: ResizeObserver | null = null;
    /** Issue #222 — relationship types currently hidden by the user. */
    private hiddenTypes: Set<RelationshipType> = new Set();
    private nodeDom = new Map<string, NodeDom>();
    private edgeDom: EdgeDom[] = [];
    private svgBuilt = false;
    private truncated = false;
    private totalRelated = 0;
    private onPanMove: ((e: MouseEvent) => void) | null = null;
    private onPanUp: (() => void) | null = null;
    private statusEl: HTMLElement | null = null;

    constructor(
        container: HTMLElement,
        characters: Character[],
        onSelectCharacter?: (name: string) => void,
        onEdgeContextMenu?: (edge: RelationshipEdgeInfo, event: MouseEvent) => void,
    ) {
        this.container = container;
        this.characters = characters;
        this.onSelectCharacter = onSelectCharacter;
        this.onEdgeContextMenu = onEdgeContextMenu;
    }

    render(): void {
        this.destroy();
        this.container.empty();
        this.svgBuilt = false;
        this.nodeDom.clear();
        this.edgeDom = [];

        // Build graph data
        this.buildGraph();

        if (this.nodes.length === 0) {
            const empty = this.container.createDiv('relationship-map-empty');
            empty.createEl('p', {
                text: t('No relationships to display.'),
            });
            return;
        }

        this.statusEl = this.container.createDiv('relationship-map-status');
        this.updateStatusText();

        // Legend — Issue #222: each item is a toggle that shows/hides that
        // relationship type. Clicking re-renders the SVG immediately.
        const legend = this.container.createDiv('relationship-map-legend');
        const edgeColors = getEdgeColors();
        for (const [type, color] of Object.entries(edgeColors) as Array<[RelationshipType, string]>) {
            const item = legend.createDiv('relationship-map-legend-item');
            item.classList.add('relationship-map-legend-toggle');
            const isHidden = this.hiddenTypes.has(type);
            if (isHidden) item.classList.add('is-off');
            const swatch = item.createEl('span', { cls: 'relationship-map-legend-swatch' });
            swatch.setCssStyles({ backgroundColor: color });
            if (type === 'enemy') swatch.setCssStyles({ borderStyle: 'dashed' });
            if (type === 'romantic') swatch.setCssStyles({ borderRadius: '50%' });
            item.createEl('span', { text: t(TYPE_LABELS[type]) });
            item.addEventListener('click', () => {
                if (this.hiddenTypes.has(type)) {
                    this.hiddenTypes.delete(type);
                } else {
                    this.hiddenTypes.add(type);
                }
                // Only rebuild visibility — avoid tearing down physics mid-run
                this.applyVisibility();
                item.classList.toggle('is-off', this.hiddenTypes.has(type));
            });
        }

        // SVG container
        const wrapper = this.container.createDiv('relationship-map-wrapper');
        this.wrapper = wrapper;
        const rect = wrapper.getBoundingClientRect();
        this.width = Math.max(600, rect.width || 800);
        this.height = Math.max(400, rect.height || 500);

        const svgNS = 'http://www.w3.org/2000/svg';
        this.svg = activeDocument.createElementNS(svgNS, 'svg');
        this.svg.setAttribute('width', '100%');
        this.svg.setAttribute('height', '100%');
        this.svg.setAttribute('viewBox', `0 0 ${this.width} ${this.height}`);
        this.svg.classList.add('relationship-map-svg');
        wrapper.appendChild(this.svg);

        // Resize observer — update dimensions when container changes
        let resizeTimer = 0;
        this.resizeObserver = new ResizeObserver((entries) => {
            for (const entry of entries) {
                const cr = entry.contentRect;
                if (cr.width > 0 && cr.height > 0) {
                    this.width = Math.max(600, cr.width);
                    this.height = Math.max(400, cr.height);
                    if (this.svg) {
                        this.svg.setAttribute('viewBox', `0 0 ${this.width} ${this.height}`);
                    }
                    if (resizeTimer) window.clearTimeout(resizeTimer);
                    resizeTimer = window.setTimeout(() => this.updatePositions(), 80);
                }
            }
        });
        this.resizeObserver.observe(wrapper);

        // Pan support — only update transform, never rebuild SVG
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
            this.applyLabelVisibility();
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

    // ── Graph building ─────────────────────────────────

    private buildGraph(): void {
        const nodeMap = new Map<string, GraphNode>();
        const edgeList: GraphEdge[] = [];
        const profileKeys = new Set(this.characters.map(c => c.name.toLowerCase()));

        // Parse relationships first — only create nodes that participate in an edge.
        for (const char of this.characters) {
            const fromKey = char.name.toLowerCase();
            if (Array.isArray(char.relations)) {
                for (const relation of char.relations) {
                    const baseType = RELATION_BASE_TYPE_BY_CATEGORY[relation.category] || 'other';
                    const name = relation.target?.trim();
                    if (!name) continue;
                    this.ensureNode(nodeMap, char.name, true, getRoleDisplay(char.role) || undefined);
                    this.ensureNode(nodeMap, name, profileKeys.has(name.toLowerCase()));
                    edgeList.push({
                        source: fromKey,
                        target: name.toLowerCase(),
                        sourceLabel: char.name,
                        targetLabel: name,
                        type: baseType,
                    });
                }
            }

            // Legacy free-text family/background field may contain relatives by name.
            if (char.family) {
                for (const name of this.parseNames(char.family)) {
                    this.ensureNode(nodeMap, char.name, true, getRoleDisplay(char.role) || undefined);
                    this.ensureNode(nodeMap, name, profileKeys.has(name.toLowerCase()));
                    edgeList.push({
                        source: fromKey,
                        target: name.toLowerCase(),
                        sourceLabel: char.name,
                        targetLabel: name,
                        type: 'family',
                    });
                }
            }
        }

        // Deduplicate edges (if A→B and B→A exist, keep one)
        const edgeSet = new Set<string>();
        const deduped: GraphEdge[] = [];
        for (const e of edgeList) {
            const fwd = `${e.source}|${e.target}|${e.type}`;
            const rev = `${e.target}|${e.source}|${e.type}`;
            if (!edgeSet.has(fwd) && !edgeSet.has(rev)) {
                edgeSet.add(fwd);
                deduped.push(e);
            }
        }

        // Prefer connected profile characters; drop orphans (no edges).
        const connected = new Set<string>();
        for (const e of deduped) {
            connected.add(e.source);
            connected.add(e.target);
        }
        let nodes = Array.from(nodeMap.values()).filter(n => connected.has(n.id));
        this.totalRelated = nodes.length;
        this.truncated = false;

        if (nodes.length > MAX_NODES) {
            // Keep highest-degree nodes so the map stays readable.
            const degree = new Map<string, number>();
            for (const e of deduped) {
                degree.set(e.source, (degree.get(e.source) ?? 0) + 1);
                degree.set(e.target, (degree.get(e.target) ?? 0) + 1);
            }
            nodes.sort((a, b) => (degree.get(b.id) ?? 0) - (degree.get(a.id) ?? 0));
            nodes = nodes.slice(0, MAX_NODES);
            const keep = new Set(nodes.map(n => n.id));
            this.edges = deduped.filter(e => keep.has(e.source) && keep.has(e.target));
            this.truncated = true;
        } else {
            this.edges = deduped.filter(e => connected.has(e.source) && connected.has(e.target));
        }

        // Seed positions once we know canvas size (updated again in buildSVG if needed)
        for (const node of nodes) {
            node.x = this.width / 2 + (Math.random() - 0.5) * this.width * 0.6;
            node.y = this.height / 2 + (Math.random() - 0.5) * this.height * 0.6;
            node.vx = 0;
            node.vy = 0;
        }

        this.nodes = nodes;
        this.nodeById = new Map(nodes.map(n => [n.id, n]));
    }

    private ensureNode(
        map: Map<string, GraphNode>,
        name: string,
        hasProfile: boolean,
        role?: string,
    ): void {
        const key = name.toLowerCase();
        const existing = map.get(key);
        if (existing) {
            if (hasProfile) existing.hasProfile = true;
            if (role) existing.role = role;
            return;
        }
        map.set(key, {
            id: key,
            label: name,
            role,
            x: 0,
            y: 0,
            vx: 0,
            vy: 0,
            hasProfile,
        });
    }

    /**
     * Parse a free-text field into individual names.
     * Handles comma-separated, [[wikilinks]], and lines.
     */
    private parseNames(text: string): string[] {
        // Strip wikilinks
        const cleaned = text.replace(/\[\[([^\]]+)\]\]/g, '$1');
        // Split on commas, semicolons, newlines, "and"
        const parts = cleaned.split(/[,;\n]|\band\b/i);
        return parts
            .map(p => p.trim())
            .filter(p => p.length > 0 && p.length < 60);
    }

    private updateStatusText(): void {
        if (!this.statusEl) return;
        const parts = [
            t('{n} characters with relationships', { n: this.totalRelated }),
        ];
        if (this.truncated) {
            parts.push(t('Showing top {n} by connections', { n: this.nodes.length }));
        }
        this.statusEl.setText(parts.join(' · '));
    }

    // ── Simulation & rendering ─────────────────────────

    private runSimulation(): void {
        let iterations = 0;
        const n = this.nodes.length;
        // Large graphs: fewer ticks; small graphs keep smoother settle.
        const maxIterations = n > 50 ? 90 : n > 25 ? 160 : 240;
        let frame = 0;

        const tick = () => {
            if (!this.svg) return;
            iterations++;
            this.applyForces();

            for (const node of this.nodes) {
                if (node === this.dragging) continue;
                node.x += node.vx;
                node.y += node.vy;
                node.vx *= 0.85;
                node.vy *= 0.85;
                node.x = Math.max(40, Math.min(this.width - 40, node.x));
                node.y = Math.max(40, Math.min(this.height - 40, node.y));
            }

            // Throttle DOM writes — every other frame is enough visually.
            frame++;
            if (frame % 2 === 0 || iterations >= maxIterations) {
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
        const repulsion = n > 50 ? 1800 : 3000;
        const springLength = n > 50 ? 90 : 120;
        const springK = 0.02;
        const centerGravity = 0.001;

        // Repulsion — full O(n²) only for modest graphs; sample for larger ones.
        if (n <= 60) {
            for (let i = 0; i < n; i++) {
                for (let j = i + 1; j < n; j++) {
                    this.repulsePair(this.nodes[i], this.nodes[j], repulsion);
                }
            }
        } else {
            // Approximate: each node only repels a random subset + nearby index neighbors.
            const samples = 12;
            for (let i = 0; i < n; i++) {
                const a = this.nodes[i];
                for (let s = 0; s < samples; s++) {
                    const j = (i + 1 + ((s * 37 + iterationsSalt(i, s)) % (n - 1))) % n;
                    if (j === i) continue;
                    this.repulsePair(a, this.nodes[j], repulsion);
                }
            }
        }

        // Spring forces along edges
        for (const edge of this.edges) {
            if (this.hiddenTypes.has(edge.type)) continue;
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

        // Center gravity
        for (const node of this.nodes) {
            node.vx += (this.width / 2 - node.x) * centerGravity;
            node.vy += (this.height / 2 - node.y) * centerGravity;
        }
    }

    private repulsePair(a: GraphNode, b: GraphNode, repulsion: number): void {
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

    private buildSVG(): void {
        if (!this.svg) return;
        const svgNS = 'http://www.w3.org/2000/svg';
        while (this.svg.firstChild) this.svg.removeChild(this.svg.firstChild);

        const edgeColors = getEdgeColors();
        const g = activeDocument.createElementNS(svgNS, 'g');
        this.layer = g;
        this.svg.appendChild(g);
        this.updateTransform();

        this.edgeDom = [];
        for (const edge of this.edges) {
            const a = this.nodeById.get(edge.source);
            const b = this.nodeById.get(edge.target);
            if (!a || !b) continue;

            // Invisible wide stroke for easier right-click / hover targeting
            const hit = activeDocument.createElementNS(svgNS, 'line');
            hit.setAttribute('stroke', 'transparent');
            hit.setAttribute('stroke-width', '14');
            hit.style.cursor = 'pointer';
            hit.classList.add('relationship-map-edge-hit');
            g.appendChild(hit);

            const line = activeDocument.createElementNS(svgNS, 'line');
            line.setAttribute('stroke', edgeColors[edge.type]);
            line.setAttribute('stroke-width', '2');
            line.style.pointerEvents = 'none';
            if (EDGE_DASHES[edge.type]) {
                line.setAttribute('stroke-dasharray', EDGE_DASHES[edge.type]);
            }
            g.appendChild(line);

            const openEdgeMenu = (e: MouseEvent) => {
                e.preventDefault();
                e.stopPropagation();
                this.onEdgeContextMenu?.(
                    { from: edge.sourceLabel, to: edge.targetLabel, type: edge.type },
                    e,
                );
            };
            hit.addEventListener('contextmenu', openEdgeMenu);
            hit.addEventListener('click', (e) => {
                // Secondary-click equivalents on some trackpads fire click + button===2
                if (e.button === 2) openEdgeMenu(e);
            });

            let labelEl: SVGTextElement | undefined;
            if (edge.label) {
                labelEl = activeDocument.createElementNS(svgNS, 'text');
                labelEl.setAttribute('text-anchor', 'middle');
                labelEl.setAttribute('fill', edgeColors[edge.type]);
                labelEl.setAttribute('font-size', '10');
                labelEl.textContent = edge.label;
                labelEl.style.cursor = 'pointer';
                labelEl.addEventListener('contextmenu', openEdgeMenu);
                g.appendChild(labelEl);
            }
            this.edgeDom.push({ type: edge.type, line, hit, edge, label: labelEl });
        }

        this.nodeDom.clear();
        for (const node of this.nodes) {
            const circle = activeDocument.createElementNS(svgNS, 'circle');
            circle.setAttribute('r', node.hasProfile ? '18' : '12');
            circle.setAttribute('fill', node.hasProfile
                ? 'var(--interactive-accent)'
                : 'var(--background-modifier-border)');
            circle.setAttribute('stroke', 'var(--background-primary)');
            circle.setAttribute('stroke-width', '2');
            circle.classList.add('relationship-map-node');
            circle.style.cursor = 'pointer';

            circle.addEventListener('mousedown', (e) => {
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

            circle.addEventListener('dblclick', () => {
                if (this.onSelectCharacter && node.hasProfile) {
                    this.onSelectCharacter(node.label);
                }
            });

            g.appendChild(circle);

            const label = activeDocument.createElementNS(svgNS, 'text');
            label.setAttribute('text-anchor', 'middle');
            label.setAttribute('fill', 'var(--text-normal)');
            label.setAttribute('font-size', node.hasProfile ? '12' : '10');
            label.setAttribute('font-weight', node.hasProfile ? '600' : '400');
            label.textContent = node.label;
            g.appendChild(label);

            let roleEl: SVGTextElement | undefined;
            if (node.role && node.hasProfile) {
                roleEl = activeDocument.createElementNS(svgNS, 'text');
                roleEl.setAttribute('text-anchor', 'middle');
                roleEl.setAttribute('fill', 'var(--text-muted)');
                roleEl.setAttribute('font-size', '9');
                roleEl.textContent = node.role;
                g.appendChild(roleEl);
            }

            this.nodeDom.set(node.id, { circle, label, role: roleEl });
        }

        this.svgBuilt = true;
        this.applyVisibility();
        this.updatePositions();
        this.applyLabelVisibility();
    }

    private updateTransform(): void {
        if (!this.layer) return;
        this.layer.setAttribute('transform', `translate(${this.panX},${this.panY}) scale(${this.zoom})`);
    }

    private updatePositions(): void {
        if (!this.svgBuilt) return;
        // edgeDom is built in the same order as drawable edges (both endpoints present).
        let di = 0;
        for (const edge of this.edges) {
            const a = this.nodeById.get(edge.source);
            const b = this.nodeById.get(edge.target);
            if (!a || !b) continue;
            const dom = this.edgeDom[di++];
            if (!dom) continue;
            dom.line.setAttribute('x1', String(a.x));
            dom.line.setAttribute('y1', String(a.y));
            dom.line.setAttribute('x2', String(b.x));
            dom.line.setAttribute('y2', String(b.y));
            dom.hit.setAttribute('x1', String(a.x));
            dom.hit.setAttribute('y1', String(a.y));
            dom.hit.setAttribute('x2', String(b.x));
            dom.hit.setAttribute('y2', String(b.y));
            if (dom.label) {
                dom.label.setAttribute('x', String((a.x + b.x) / 2));
                dom.label.setAttribute('y', String((a.y + b.y) / 2 - 6));
            }
        }

        for (const node of this.nodes) {
            const dom = this.nodeDom.get(node.id);
            if (!dom) continue;
            dom.circle.setAttribute('cx', String(node.x));
            dom.circle.setAttribute('cy', String(node.y));
            dom.label.setAttribute('x', String(node.x));
            dom.label.setAttribute('y', String(node.y + (node.hasProfile ? 30 : 24)));
            if (dom.role) {
                dom.role.setAttribute('x', String(node.x));
                dom.role.setAttribute('y', String(node.y - 24));
            }
        }
    }

    private applyVisibility(): void {
        for (const dom of this.edgeDom) {
            const hide = this.hiddenTypes.has(dom.type);
            dom.line.style.display = hide ? 'none' : '';
            dom.hit.style.display = hide ? 'none' : '';
            if (dom.label) dom.label.style.display = hide ? 'none' : '';
        }
    }

    private applyLabelVisibility(): void {
        const showLabels = this.nodes.length < LABEL_HIDE_AT || this.zoom >= 1.15;
        for (const node of this.nodes) {
            const dom = this.nodeDom.get(node.id);
            if (!dom) continue;
            dom.label.style.display = showLabels ? '' : 'none';
            if (dom.role) dom.role.style.display = showLabels ? '' : 'none';
        }
    }
}

/** Deterministic-ish salt for sampled repulsion without Math.random each frame. */
function iterationsSalt(i: number, s: number): number {
    return ((i + 1) * (s + 3) * 2654435761) >>> 0;
}
/* eslint-enable @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-argument, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-return, @typescript-eslint/no-floating-promises, @typescript-eslint/no-misused-promises, @typescript-eslint/no-unnecessary-type-assertion, @typescript-eslint/no-redundant-type-constituents, @typescript-eslint/no-unused-vars, no-unused-vars, no-useless-escape, no-control-regex, no-empty -- end of file-wide suppression block opened at line 1 */
