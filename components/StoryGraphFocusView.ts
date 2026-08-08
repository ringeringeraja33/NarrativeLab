/* eslint-disable @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-argument, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-return, @typescript-eslint/no-floating-promises, @typescript-eslint/no-misused-promises -- Obsidian DOM + async save handlers */
import { Notice, TFile, normalizePath, setIcon } from 'obsidian';
import type SceneCardsPlugin from '../main';
import { resolveImagePath } from './ImagePicker';
import { openConfirmModal } from './ConfirmModal';
import {
    clampFocusNodePos,
    createFocusPort,
    createStoryGraphStrand,
    ensureFocusPorts,
    lookupStoryGraphFocusBundle,
    portsForFocusOrientation,
    strandDashArray,
    strandsForFocusOrientation,
    storyGraphFocusKey,
    storyGraphPairKey,
    type StoryGraphFocusBundle,
    type StoryGraphFocusNodePos,
    type StoryGraphFocusPort,
    type StoryGraphStrand,
    type StoryGraphStrandDirection,
    type StoryGraphStrandLineStyle,
} from '../utils/storyGraphStrands';
import { t } from '../utils/i18n';

export interface StoryGraphFocusEndpoint {
    name: string;
    filePath: string;
    image?: string;
}

export interface StoryGraphFocusEdge {
    left: StoryGraphFocusEndpoint;
    right: StoryGraphFocusEndpoint;
    /** Parent main-graph edge id, e.g. link:skill / char:mentor */
    parentId?: string;
    /** Parent label shown on the main graph (e.g. 技能). */
    parentLabel?: string;
    parentColor?: string;
}

const SVG_NS = 'http://www.w3.org/2000/svg';
const DEFAULT_LEFT: StoryGraphFocusNodePos = { x: 0.16, y: 0.5 };
const DEFAULT_RIGHT: StoryGraphFocusNodePos = { x: 0.84, y: 0.5 };
/** Avatar radius in focus canvas px — ports sit on this rim. */
const FOCUS_AVATAR_R = 48;
const FOCUS_ARROW_SIZE = 10;
/** Keep arrow tips short of the handle so they don't cover blue ports. */
const FOCUS_PORT_CLEARANCE = 12;

/**
 * Focus sub-canvas under one parent edge (e.g. 技能): edit internal
 * secondary strands. On the main graph the parent stays a single labeled
 * line that grows thicker with strand count.
 */
export class StoryGraphFocusView {
    private host: HTMLElement;
    private plugin: SceneCardsPlugin;
    private root: HTMLElement | null = null;
    private stage: HTMLElement | null = null;
    private svg: SVGSVGElement | null = null;
    private nodesLayer: HTMLElement | null = null;
    private dock: HTMLElement | null = null;
    private left: StoryGraphFocusEndpoint;
    private right: StoryGraphFocusEndpoint;
    private parentId: string;
    private parentLabel: string;
    private parentColor: string;
    private strands: StoryGraphStrand[] = [];
    private leftPorts: StoryGraphFocusPort[] = [createFocusPort()];
    private rightPorts: StoryGraphFocusPort[] = [createFocusPort()];
    private leftPos: StoryGraphFocusNodePos = { ...DEFAULT_LEFT };
    private rightPos: StoryGraphFocusNodePos = { ...DEFAULT_RIGHT };
    private selectedId: string | null = null;
    private dirty = false;
    private labelEditor: HTMLInputElement | null = null;
    /** Detect double-click across redraws that replace the hit path. */
    private lastEdgeClick: { id: string; t: number } | null = null;
    private onClose: () => void;
    private onSaved?: () => void;
    private nodeDrag: null | {
        side: 'left' | 'right';
        pointerId: number;
    } = null;
    private connectDrag: null | {
        fromSide: 'left' | 'right';
        fromPortId: string;
        pointerId: number;
        line: SVGLineElement;
    } = null;
    private boundPointerMove = (e: PointerEvent) => this.onPointerMove(e);
    private boundPointerUp = (e: PointerEvent) => this.onPointerUp(e);
    private boundResize = () => this.redrawCanvas();

    constructor(
        host: HTMLElement,
        plugin: SceneCardsPlugin,
        edge: StoryGraphFocusEdge,
        onClose: () => void,
        onSaved?: () => void,
    ) {
        this.host = host;
        this.plugin = plugin;
        this.onClose = onClose;
        this.onSaved = onSaved;
        this.left = edge.left;
        this.right = edge.right;
        this.parentId = edge.parentId || 'link:default';
        this.parentLabel = edge.parentLabel?.trim() || t('Default link');
        this.parentColor = edge.parentColor?.trim() || '#6C7AE0';
        if (!this.left.filePath || !this.right.filePath) {
            new Notice(t('Both endpoints need vault files to open focus view.'));
            queueMicrotask(() => onClose());
            return;
        }
        this.loadStrands();
        this.render();
        activeWindow.addEventListener('pointermove', this.boundPointerMove);
        activeWindow.addEventListener('pointerup', this.boundPointerUp);
        activeWindow.addEventListener('pointercancel', this.boundPointerUp);
        activeWindow.addEventListener('resize', this.boundResize);
    }

    private loadStrands(): void {
        const found = lookupStoryGraphFocusBundle(
            this.plugin.settings.storyGraphFocusBundles as Record<string, unknown>,
            this.left.filePath,
            this.right.filePath,
            this.parentId,
        );
        const bundle = found?.bundle;
        const ports = portsForFocusOrientation(bundle, this.left.filePath, this.right.filePath);
        this.leftPorts = ports.leftPorts;
        this.rightPorts = ports.rightPorts;
        this.strands = strandsForFocusOrientation(bundle, this.left.filePath, this.right.filePath);
        // Seed one blank secondary strand when opening a parent with no children yet.
        if (this.strands.length === 0) {
            this.strands = [createStoryGraphStrand({
                direction: 'ltr',
                label: '',
                color: this.parentColor,
                leftPortId: this.leftPorts[0].id,
                rightPortId: this.rightPorts[0].id,
            })];
        }
        const ensured = ensureFocusPorts(this.leftPorts, this.rightPorts, this.strands);
        this.leftPorts = ensured.leftPorts;
        this.rightPorts = ensured.rightPorts;
        this.strands = ensured.strands;
        this.leftPos = clampFocusNodePos(bundle?.leftPos, DEFAULT_LEFT);
        this.rightPos = clampFocusNodePos(bundle?.rightPos, DEFAULT_RIGHT);
        if (bundle && normalizePath(bundle.leftPath) !== normalizePath(this.left.filePath)) {
            const tmp = this.leftPos;
            this.leftPos = this.rightPos;
            this.rightPos = tmp;
        }
        if (bundle?.parentLabel) this.parentLabel = bundle.parentLabel;
        if (bundle?.parentColor) this.parentColor = bundle.parentColor;
        this.selectedId = this.strands[0]?.id || null;
    }

    private render(): void {
        this.root?.remove();
        const root = this.host.createDiv({ cls: 'story-graph-focus' });
        this.root = root;

        const toolbar = root.createDiv({ cls: 'story-graph-focus-toolbar' });
        const back = toolbar.createEl('button', {
            cls: 'story-graph-focus-back',
            attr: { type: 'button' },
        });
        setIcon(back.createSpan(), 'arrow-left');
        back.createSpan({ text: t('Back to Story Graph') });
        back.addEventListener('click', () => { void this.close(true); });

        const title = toolbar.createDiv({ cls: 'story-graph-focus-title' });
        const swatch = title.createSpan({ cls: 'story-graph-focus-parent-swatch' });
        swatch.setCssStyles({ backgroundColor: this.parentColor });
        title.createSpan({
            text: t('Secondary strands under "{parent}"', { parent: this.parentLabel }),
        });

        const saveBtn = toolbar.createEl('button', {
            cls: 'mod-cta',
            text: t('Save strands'),
            attr: { type: 'button' },
        });
        saveBtn.addEventListener('click', () => { void this.save(); });

        const stage = root.createDiv({ cls: 'story-graph-focus-stage is-canvas' });
        this.stage = stage;
        stage.createDiv({
            cls: 'story-graph-focus-hint-bar',
            text: t('Drag handles to connect · same handle can host many lines · drop asks about a new handle'),
        });

        const svg = activeDocument.createElementNS(SVG_NS, 'svg');
        svg.classList.add('story-graph-focus-svg');
        stage.appendChild(svg);
        this.svg = svg;

        this.nodesLayer = stage.createDiv({ cls: 'story-graph-focus-nodes' });
        this.mountNode('left');
        this.mountNode('right');

        this.dock = stage.createDiv({ cls: 'story-graph-focus-dock' });
        this.renderDock();

        requestAnimationFrame(() => this.redrawCanvas());
    }

    private mountNode(side: 'left' | 'right'): void {
        if (!this.nodesLayer) return;
        const endpoint = side === 'left' ? this.left : this.right;
        const el = this.nodesLayer.createDiv({
            cls: `story-graph-focus-node is-${side}`,
            attr: { 'data-side': side },
        });

        const avatar = el.createDiv({ cls: 'story-graph-focus-avatar' });
        const src = this.resolveImage(endpoint);
        if (src) {
            avatar.createEl('img', { attr: { src, alt: endpoint.name } });
        } else {
            const fallback = avatar.createDiv({ cls: 'story-graph-focus-avatar-fallback' });
            fallback.setText((endpoint.name || '?').slice(0, 1));
        }
        el.createDiv({ cls: 'story-graph-focus-name', text: endpoint.name });
        el.createDiv({ cls: 'story-graph-focus-ports' });

        const addPort = el.createEl('button', {
            cls: 'story-graph-focus-add-port',
            attr: {
                type: 'button',
                title: t('Add handle'),
                'aria-label': t('Add handle'),
            },
        });
        setIcon(addPort, 'plus');
        addPort.addEventListener('pointerdown', (e) => e.stopPropagation());
        addPort.addEventListener('click', (e) => {
            e.preventDefault();
            e.stopPropagation();
            const port = createFocusPort();
            if (side === 'left') this.leftPorts.push(port);
            else this.rightPorts.push(port);
            this.dirty = true;
            this.redrawCanvas();
        });

        el.addEventListener('pointerdown', (e: PointerEvent) => {
            if ((e.target as HTMLElement).closest('.story-graph-focus-port, .story-graph-focus-add-port')) return;
            if (e.button !== 0) return;
            e.preventDefault();
            e.stopPropagation();
            this.nodeDrag = { side, pointerId: e.pointerId };
            el.classList.add('is-dragging');
            try { el.setPointerCapture(e.pointerId); } catch { /* ignore */ }
        });

        el.addEventListener('dblclick', () => {
            if (endpoint.filePath) {
                void this.plugin.app.workspace.openLinkText(endpoint.filePath, '', false);
            }
        });
    }

    private portsFor(side: 'left' | 'right'): StoryGraphFocusPort[] {
        return side === 'left' ? this.leftPorts : this.rightPorts;
    }

    private portIndex(side: 'left' | 'right', portId: string): number {
        const idx = this.portsFor(side).findIndex(p => p.id === portId);
        return idx >= 0 ? idx : 0;
    }

    private portWorldPos(side: 'left' | 'right', portId: string): { x: number; y: number } {
        const center = this.pixelPos(side);
        const other = this.pixelPos(side === 'left' ? 'right' : 'left');
        const ports = this.portsFor(side);
        const count = Math.max(1, ports.length);
        const index = this.portIndex(side, portId);
        const base = Math.atan2(other.y - center.y, other.x - center.x);
        const step = count <= 1 ? 0 : Math.min(0.55, 1.05 / count);
        const slot = index - (count - 1) / 2;
        const angle = base + slot * step;
        return {
            x: center.x + Math.cos(angle) * FOCUS_AVATAR_R,
            y: center.y + Math.sin(angle) * FOCUS_AVATAR_R,
        };
    }

    private syncPortsDom(): void {
        if (!this.nodesLayer) return;
        for (const side of ['left', 'right'] as const) {
            const node = this.nodesLayer.querySelector(`[data-side="${side}"]`) as HTMLElement | null;
            if (!node) continue;
            const host = node.querySelector('.story-graph-focus-ports') as HTMLElement | null;
            if (!host) continue;
            const ports = this.portsFor(side);
            host.empty();
            const center = this.pixelPos(side);
            ports.forEach((port) => {
                const el = host.createDiv({
                    cls: 'story-graph-focus-port',
                    attr: {
                        'data-port-id': port.id,
                        'data-side': side,
                        title: t('Drag to connect'),
                        'aria-label': t('Drag to connect'),
                    },
                });
                const world = this.portWorldPos(side, port.id);
                el.style.left = `${world.x - center.x + FOCUS_AVATAR_R}px`;
                el.style.top = `${world.y - center.y + FOCUS_AVATAR_R}px`;
                el.addEventListener('pointerdown', (e: PointerEvent) => {
                    if (e.button !== 0 || !this.svg || !this.stage) return;
                    e.preventDefault();
                    e.stopPropagation();
                    const origin = this.portWorldPos(side, port.id);
                    const line = activeDocument.createElementNS(SVG_NS, 'line');
                    line.classList.add('story-graph-focus-rubber');
                    line.setAttribute('x1', String(origin.x));
                    line.setAttribute('y1', String(origin.y));
                    line.setAttribute('x2', String(origin.x));
                    line.setAttribute('y2', String(origin.y));
                    this.svg.appendChild(line);
                    this.connectDrag = {
                        fromSide: side,
                        fromPortId: port.id,
                        pointerId: e.pointerId,
                        line,
                    };
                    try { el.setPointerCapture(e.pointerId); } catch { /* ignore */ }
                });
            });

            // Place "+" just outside the outermost port fan.
            const addBtn = node.querySelector('.story-graph-focus-add-port') as HTMLElement | null;
            if (addBtn) {
                const other = this.pixelPos(side === 'left' ? 'right' : 'left');
                const base = Math.atan2(other.y - center.y, other.x - center.x);
                const count = Math.max(1, ports.length);
                const step = count <= 1 ? 0 : Math.min(0.55, 1.05 / count);
                const outer = ((count - 1) / 2) * step + (count > 0 ? 0.35 : 0);
                const angle = base + outer;
                const r = FOCUS_AVATAR_R + 16;
                addBtn.style.left = `${Math.cos(angle) * r + FOCUS_AVATAR_R}px`;
                addBtn.style.top = `${Math.sin(angle) * r + FOCUS_AVATAR_R}px`;
            }
        }
    }

    private renderDock(): void {
        if (!this.dock) return;
        this.dock.empty();

        const list = this.dock.createDiv({ cls: 'story-graph-focus-strand-list' });
        this.strands.forEach((strand, index) => {
            list.appendChild(this.makeStrandCard(strand, index));
        });

        const addBtn = this.dock.createEl('button', {
            cls: 'story-graph-focus-add-strand',
            attr: { type: 'button' },
        });
        setIcon(addBtn.createSpan(), 'plus');
        addBtn.createSpan({ text: ` ${t('Add strand')}` });
        addBtn.addEventListener('click', () => {
            const strand = createStoryGraphStrand({
                direction: 'ltr',
                label: t('New strand'),
                leftPortId: this.leftPorts[0]?.id,
                rightPortId: this.rightPorts[0]?.id,
            });
            this.strands.push(strand);
            this.selectedId = strand.id;
            this.dirty = true;
            this.renderDock();
            this.redrawCanvas();
        });
    }

    private makeStrandCard(strand: StoryGraphStrand, index: number): HTMLElement {
        const row = activeDocument.createElement('div');
        row.className = `story-graph-focus-strand-card${this.selectedId === strand.id ? ' is-selected' : ''}`;
        row.addEventListener('click', (e) => {
            if ((e.target as HTMLElement).closest('button, input, select')) return;
            this.selectedId = strand.id;
            this.dock?.querySelectorAll('.story-graph-focus-strand-card').forEach(el => {
                el.classList.toggle('is-selected', el === row);
            });
            this.redrawCanvas();
        });

        const preview = row.createDiv({ cls: 'story-graph-focus-strand-preview' });
        this.paintStrandPreview(preview, strand);

        const dirs = row.createDiv({ cls: 'story-graph-focus-strand-dirs' });
        for (const opt of [
            { value: 'rtl' as const, glyph: '←' },
            { value: 'ltr' as const, glyph: '→' },
            { value: 'both' as const, glyph: '↔' },
        ]) {
            const btn = dirs.createEl('button', {
                cls: `story-graph-focus-dir-btn${strand.direction === opt.value ? ' is-active' : ''}`,
                text: opt.glyph,
                attr: {
                    type: 'button',
                    title: opt.value === 'ltr'
                        ? `${this.left.name} → ${this.right.name}`
                        : opt.value === 'rtl'
                            ? `${this.right.name} → ${this.left.name}`
                            : `${this.left.name} ↔ ${this.right.name}`,
                },
            });
            btn.addEventListener('click', (e) => {
                e.stopPropagation();
                strand.direction = opt.value;
                this.dirty = true;
                this.selectedId = strand.id;
                dirs.querySelectorAll('.story-graph-focus-dir-btn').forEach(el => {
                    el.classList.toggle('is-active', el === btn);
                });
                this.paintStrandPreview(preview, strand);
                this.redrawCanvas();
            });
        }

        const labelInput = row.createEl('input', {
            cls: 'story-graph-focus-strand-label',
            attr: {
                type: 'text',
                value: strand.label,
                placeholder: t('Short label'),
                'aria-label': t('Strand label'),
            },
        }) as HTMLInputElement;
        labelInput.addEventListener('input', () => {
            strand.label = labelInput.value;
            this.dirty = true;
            this.paintStrandPreview(preview, strand);
            this.redrawCanvas();
        });

        const styleSelect = row.createEl('select', {
            cls: 'story-graph-focus-strand-style',
            attr: { 'aria-label': t('Line style') },
        }) as HTMLSelectElement;
        for (const opt of [
            { value: 'solid', label: t('Solid') },
            { value: 'dashed', label: t('Dashed') },
            { value: 'dotted', label: t('Dotted') },
        ]) {
            styleSelect.createEl('option', { text: opt.label, attr: { value: opt.value } });
        }
        styleSelect.value = strand.lineStyle;
        styleSelect.addEventListener('change', () => {
            strand.lineStyle = styleSelect.value as StoryGraphStrandLineStyle;
            this.dirty = true;
            this.paintStrandPreview(preview, strand);
            this.redrawCanvas();
        });

        const colorWrap = row.createDiv({ cls: 'story-graph-focus-color-wrap' });
        colorWrap.style.backgroundColor = strand.color || '#6C7AE0';
        const color = colorWrap.createEl('input', {
            cls: 'story-graph-focus-color',
            attr: {
                type: 'color',
                value: strand.color,
                'aria-label': t('Color'),
            },
        }) as HTMLInputElement;
        color.addEventListener('input', () => {
            strand.color = color.value;
            colorWrap.style.backgroundColor = color.value;
            this.dirty = true;
            this.paintStrandPreview(preview, strand);
            this.redrawCanvas();
        });

        const remove = row.createEl('button', {
            cls: 'story-graph-focus-strand-remove',
            attr: {
                type: 'button',
                'aria-label': t('Remove strand'),
            },
        });
        setIcon(remove, 'trash-2');
        remove.addEventListener('click', (e) => {
            e.stopPropagation();
            this.strands.splice(index, 1);
            if (this.selectedId === strand.id) {
                this.selectedId = this.strands[0]?.id || null;
            }
            this.dirty = true;
            this.renderDock();
            this.redrawCanvas();
        });

        return row;
    }

    private paintStrandPreview(el: HTMLElement, strand: StoryGraphStrand): void {
        el.empty();
        const svg = activeDocument.createElementNS(SVG_NS, 'svg');
        svg.setAttribute('viewBox', '0 0 140 36');
        svg.setAttribute('width', '140');
        svg.setAttribute('height', '36');
        const color = strand.color || '#5B7CFF';

        const pathD = 'M 18 22 C 48 10, 92 10, 122 22';
        const path = activeDocument.createElementNS(SVG_NS, 'path');
        path.setAttribute('d', pathD);
        path.setAttribute('fill', 'none');
        path.setAttribute('stroke', color);
        path.setAttribute('stroke-width', '2.25');
        path.setAttribute('stroke-linecap', 'round');
        const dash = strandDashArray(strand.lineStyle);
        if (dash) path.setAttribute('stroke-dasharray', dash);
        svg.appendChild(path);

        // Preview arrows as polygons (markers are unreliable in nested/tiny SVGs).
        if (strand.direction === 'ltr' || strand.direction === 'both') {
            this.appendArrowHead(svg, 122, 22, 0.95, 0.3, color, 8);
        }
        if (strand.direction === 'rtl' || strand.direction === 'both') {
            this.appendArrowHead(svg, 18, 22, -0.95, 0.3, color, 8);
        }

        const previewLabel = strand.label.trim();
        if (previewLabel) {
            this.appendPathLabel(svg, pathD, `pv-label-${strand.id}`, previewLabel, color, {
                fontSize: 11,
                dy: -8,
                pathLength: 110,
                maxLines: 2,
            });
        }
        el.appendChild(svg);
    }

    /** Cubic path M x1 y1 C c1x c1y, c2x c2y, x2 y2 → reversed. */
    private reverseCubicPathD(
        x1: number, y1: number,
        c1x: number, c1y: number,
        c2x: number, c2y: number,
        x2: number, y2: number,
    ): string {
        return `M ${x2} ${y2} C ${c2x} ${c2y}, ${c1x} ${c1y}, ${x1} ${y1}`;
    }

    /** Split long labels so they don't crowd a single path line. */
    private wrapPathLabel(
        label: string,
        maxCharsPerLine: number,
        maxLines: number,
    ): string[] {
        const text = label.trim().replace(/\s+/g, ' ');
        if (!text) return [];
        const limit = Math.max(4, maxCharsPerLine);
        const lines: string[] = [];
        // Prefer explicit newlines from the user.
        const paragraphs = text.split(/\n+/);
        for (const paragraph of paragraphs) {
            if (!paragraph) continue;
            if (/[\u4e00-\u9fff]/.test(paragraph)) {
                // CJK: wrap by character count (no spaces to break on).
                for (let i = 0; i < paragraph.length; i += limit) {
                    lines.push(paragraph.slice(i, i + limit));
                    if (lines.length >= maxLines) break;
                }
            } else {
                const words = paragraph.split(' ');
                let current = '';
                for (const word of words) {
                    const next = current ? `${current} ${word}` : word;
                    if (next.length <= limit) {
                        current = next;
                    } else {
                        if (current) lines.push(current);
                        if (lines.length >= maxLines) break;
                        // Hard-split overlong tokens.
                        if (word.length > limit) {
                            for (let i = 0; i < word.length && lines.length < maxLines; i += limit) {
                                const chunk = word.slice(i, i + limit);
                                if (i + limit < word.length && lines.length === maxLines - 1) {
                                    lines.push(`${chunk.slice(0, Math.max(1, limit - 1))}…`);
                                } else {
                                    lines.push(chunk);
                                }
                            }
                            current = '';
                        } else {
                            current = word;
                        }
                    }
                    if (lines.length >= maxLines) break;
                }
                if (current && lines.length < maxLines) lines.push(current);
            }
            if (lines.length >= maxLines) break;
        }
        if (lines.length >= maxLines) {
            const leftover = text.length > lines.join('').length;
            if (leftover) {
                const last = lines[lines.length - 1];
                lines[lines.length - 1] = last.length > 1
                    ? `${last.slice(0, Math.max(1, last.length - 1))}…`
                    : '…';
            }
        }
        return lines.slice(0, maxLines);
    }

    /**
     * Draw label along a path so text stays parallel to the strand.
     * Long labels wrap onto stacked path-aligned lines.
     */
    private appendPathLabel(
        parent: SVGElement,
        pathD: string,
        pathId: string,
        label: string,
        color: string,
        opts?: {
            fontSize?: number;
            dy?: number;
            /** Mid-tangent x; negative → reverse path so text isn't upside-down. */
            tangentX?: number;
            reverseD?: string;
            /** Approximate path length in px — drives wrap width. */
            pathLength?: number;
            maxLines?: number;
        },
    ): void {
        const fontSize = opts?.fontSize ?? 12;
        const baseDy = opts?.dy ?? -10;
        const maxLines = opts?.maxLines ?? 3;
        const pathLength = Math.max(80, opts?.pathLength ?? 220);
        // ~0.9em per CJK glyph; leave margins so text doesn't reach arrowheads.
        const maxChars = Math.max(4, Math.floor((pathLength * 0.5) / (fontSize * 0.92)));
        const lines = this.wrapPathLabel(label, maxChars, maxLines);
        if (lines.length === 0) return;

        const useReverse = (opts?.tangentX ?? 1) < 0 && !!opts?.reverseD;
        const d = useReverse ? opts!.reverseD! : pathD;
        const id = `${pathId}${useReverse ? '-r' : ''}`;

        const guide = activeDocument.createElementNS(SVG_NS, 'path');
        guide.setAttribute('id', id);
        guide.setAttribute('d', d);
        guide.setAttribute('fill', 'none');
        guide.setAttribute('stroke', 'none');
        guide.classList.add('story-graph-focus-label-guide');
        parent.appendChild(guide);

        const lineGap = fontSize + 2;
        // Center the wrapped block around the base dy offset.
        const blockStart = baseDy - ((lines.length - 1) * lineGap) / 2;

        lines.forEach((line, index) => {
            const text = activeDocument.createElementNS(SVG_NS, 'text');
            text.setAttribute('fill', color);
            text.setAttribute('font-size', String(fontSize));
            text.setAttribute('font-weight', '600');
            text.setAttribute('dy', String(blockStart + index * lineGap));
            text.classList.add('story-graph-focus-edge-label');

            const textPath = activeDocument.createElementNS(SVG_NS, 'textPath');
            textPath.setAttribute('href', `#${id}`);
            textPath.setAttributeNS('http://www.w3.org/1999/xlink', 'xlink:href', `#${id}`);
            textPath.setAttribute('startOffset', '50%');
            textPath.setAttribute('text-anchor', 'middle');
            textPath.textContent = line;
            text.appendChild(textPath);
            parent.appendChild(text);
        });
    }

    /** Unit direction (dx,dy) points toward the arrow tip. */
    private appendArrowHead(
        parent: SVGElement,
        tipX: number,
        tipY: number,
        dx: number,
        dy: number,
        color: string,
        size = FOCUS_ARROW_SIZE,
    ): void {
        const len = Math.hypot(dx, dy) || 1;
        const ux = dx / len;
        const uy = dy / len;
        const px = -uy;
        const py = ux;
        const baseX = tipX - ux * size;
        const baseY = tipY - uy * size;
        const poly = activeDocument.createElementNS(SVG_NS, 'polygon');
        poly.setAttribute('points', [
            `${tipX},${tipY}`,
            `${baseX + px * size * 0.55},${baseY + py * size * 0.55}`,
            `${baseX - px * size * 0.55},${baseY - py * size * 0.55}`,
        ].join(' '));
        poly.setAttribute('fill', color);
        poly.classList.add('story-graph-focus-arrow');
        parent.appendChild(poly);
    }

    /** Point on circle around `from` facing `to`. */
    private rimPoint(
        from: { x: number; y: number },
        to: { x: number; y: number },
        radius: number,
    ): { x: number; y: number; ux: number; uy: number } {
        const dx = to.x - from.x;
        const dy = to.y - from.y;
        const len = Math.hypot(dx, dy) || 1;
        const ux = dx / len;
        const uy = dy / len;
        return {
            x: from.x + ux * radius,
            y: from.y + uy * radius,
            ux,
            uy,
        };
    }

    private stageSize(): { w: number; h: number } {
        const rect = this.stage?.getBoundingClientRect();
        return {
            w: Math.max(320, rect?.width || 640),
            h: Math.max(360, rect?.height || 480),
        };
    }

    private pixelPos(side: 'left' | 'right'): { x: number; y: number } {
        const { w, h } = this.stageSize();
        const pos = side === 'left' ? this.leftPos : this.rightPos;
        return { x: pos.x * w, y: pos.y * h };
    }

    private redrawCanvas(): void {
        if (!this.stage || !this.svg || !this.nodesLayer) return;
        const { w, h } = this.stageSize();
        this.svg.setAttribute('viewBox', `0 0 ${w} ${h}`);
        this.svg.setAttribute('width', String(w));
        this.svg.setAttribute('height', String(h));

        // Keep rubber-band if present
        const rubber = this.connectDrag?.line || null;
        this.svg.querySelectorAll(':scope > *:not(.story-graph-focus-rubber)').forEach(n => n.remove());

        const left = this.pixelPos('left');
        const right = this.pixelPos('right');

        for (const side of ['left', 'right'] as const) {
            const node = this.nodesLayer.querySelector(`[data-side="${side}"]`) as HTMLElement | null;
            if (!node) continue;
            const center = side === 'left' ? left : right;
            node.style.left = `${center.x}px`;
            node.style.top = `${center.y}px`;
        }
        this.syncPortsDom();

        // Group strands that share the same port pair so multi-lines on one handle bow apart.
        const pairGroups = new Map<string, StoryGraphStrand[]>();
        for (const strand of this.strands) {
            const key = `${strand.leftPortId || ''}|${strand.rightPortId || ''}`;
            const list = pairGroups.get(key) || [];
            list.push(strand);
            pairGroups.set(key, list);
        }

        this.strands.forEach((strand, index) => {
            const color = strand.color || '#5B7CFF';
            const selected = strand.id === this.selectedId;
            const leftPortId = strand.leftPortId || this.leftPorts[0]?.id;
            const rightPortId = strand.rightPortId || this.rightPorts[0]?.id;
            const group = pairGroups.get(`${leftPortId || ''}|${rightPortId || ''}`) || [strand];
            const groupIndex = group.findIndex(s => s.id === strand.id);
            const groupCount = group.length;
            const slot = groupIndex - (groupCount - 1) / 2;
            const spacing = groupCount <= 1 ? 0 : Math.max(28, Math.min(48, Math.round(160 / groupCount)));
            const offset = slot * spacing;

            // Always geometry left→right; arrows convey direction.
            const dx = right.x - left.x;
            const dy = right.y - left.y;
            const len = Math.hypot(dx, dy) || 1;
            const ux = dx / len;
            const uy = dy / len;
            const nx = -uy;
            const ny = ux;

            const leftAttach = this.portWorldPos('left', leftPortId || this.leftPorts[0].id);
            const rightAttach = this.portWorldPos('right', rightPortId || this.rightPorts[0].id);
            // Port centers stay on the rim; stroke/arrows stop short so they don't cover handles.
            const spanDx = rightAttach.x - leftAttach.x;
            const spanDy = rightAttach.y - leftAttach.y;
            const spanLen = Math.hypot(spanDx, spanDy) || 1;
            const sux = spanDx / spanLen;
            const suy = spanDy / spanLen;
            const clearance = Math.min(FOCUS_PORT_CLEARANCE, spanLen * 0.2);
            const x1 = leftAttach.x + sux * clearance;
            const y1 = leftAttach.y + suy * clearance;
            const x2 = rightAttach.x - sux * clearance;
            const y2 = rightAttach.y - suy * clearance;

            // Extra bow so multi-lines on the same handle stay readable.
            const bow = offset;
            const cdx = x2 - x1;
            const cdy = y2 - y1;
            const c1x = x1 + cdx * 0.33 + nx * bow;
            const c1y = y1 + cdy * 0.33 + ny * bow;
            const c2x = x1 + cdx * 0.67 + nx * bow;
            const c2y = y1 + cdy * 0.67 + ny * bow;

            const g = activeDocument.createElementNS(SVG_NS, 'g');
            g.classList.add('story-graph-focus-edge');
            if (selected) g.classList.add('is-selected');

            const d = `M ${x1} ${y1} C ${c1x} ${c1y}, ${c2x} ${c2y}, ${x2} ${y2}`;
            const hit = activeDocument.createElementNS(SVG_NS, 'path');
            hit.setAttribute('d', d);
            hit.setAttribute('fill', 'none');
            hit.setAttribute('stroke', 'transparent');
            hit.setAttribute('stroke-width', '20');
            hit.classList.add('story-graph-focus-edge-hit');
            const midX = (x1 + x2) / 2 + nx * bow;
            const midY = (y1 + y2) / 2 + ny * bow;

            hit.addEventListener('pointerdown', (e) => {
                e.stopPropagation();
                const now = Date.now();
                const isDouble =
                    !!this.lastEdgeClick &&
                    this.lastEdgeClick.id === strand.id &&
                    now - this.lastEdgeClick.t < 400;
                this.lastEdgeClick = { id: strand.id, t: now };
                this.selectedId = strand.id;
                if (isDouble) {
                    e.preventDefault();
                    this.beginEditStrandLabel(strand, midX, midY);
                    return;
                }
                this.renderDock();
                this.redrawCanvas();
            });

            const path = activeDocument.createElementNS(SVG_NS, 'path');
            path.setAttribute('d', d);
            path.setAttribute('fill', 'none');
            path.setAttribute('stroke', color);
            path.setAttribute('stroke-width', selected ? '3' : '2.25');
            path.setAttribute('stroke-linecap', 'butt');
            path.setAttribute('opacity', selected ? '1' : '0.92');
            const dash = strandDashArray(strand.lineStyle);
            if (dash) path.setAttribute('stroke-dasharray', dash);

            g.appendChild(hit);
            g.appendChild(path);

            // Tangents at ends of the cubic (approx control→endpoint).
            const endDx = x2 - c2x;
            const endDy = y2 - c2y;
            const startDx = c1x - x1;
            const startDy = c1y - y1;
            if (strand.direction === 'ltr' || strand.direction === 'both') {
                this.appendArrowHead(g, x2, y2, endDx || ux, endDy || uy, color);
            }
            if (strand.direction === 'rtl' || strand.direction === 'both') {
                this.appendArrowHead(g, x1, y1, -(startDx || ux), -(startDy || uy), color);
            }

            const labelText = strand.label.trim();
            if (labelText) {
                // Mid-tangent of cubic at t≈0.5 (keep glyphs upright when flipped).
                const midTx = 0.75 * (c2x - c1x) + 0.375 * ((c1x - x1) + (x2 - c2x));
                const labelDy = slot >= 0 ? -11 : 13;
                const safeId = `sgf-lbl-${strand.id.replace(/[^a-zA-Z0-9_-]/g, '')}-${index}`;
                const approxLen = Math.hypot(cdx, cdy) + Math.abs(bow) * 0.6;
                this.appendPathLabel(g, d, safeId, labelText, color, {
                    fontSize: 12,
                    dy: labelDy,
                    tangentX: midTx || cdx,
                    reverseD: this.reverseCubicPathD(x1, y1, c1x, c1y, c2x, c2y, x2, y2),
                    pathLength: approxLen,
                    maxLines: 3,
                });
            }

            this.svg!.appendChild(g);
        });

        if (rubber && rubber.parentNode !== this.svg) {
            this.svg.appendChild(rubber);
        }
    }

    private onPointerMove(e: PointerEvent): void {
        if (this.nodeDrag && this.nodeDrag.pointerId === e.pointerId && this.stage) {
            const rect = this.stage.getBoundingClientRect();
            const x = (e.clientX - rect.left) / Math.max(1, rect.width);
            const y = (e.clientY - rect.top) / Math.max(1, rect.height);
            const next = clampFocusNodePos({ x, y }, this.nodeDrag.side === 'left' ? DEFAULT_LEFT : DEFAULT_RIGHT);
            if (this.nodeDrag.side === 'left') this.leftPos = next;
            else this.rightPos = next;
            this.dirty = true;
            this.redrawCanvas();
            return;
        }
        if (this.connectDrag && this.connectDrag.pointerId === e.pointerId && this.stage) {
            const rect = this.stage.getBoundingClientRect();
            const x = e.clientX - rect.left;
            const y = e.clientY - rect.top;
            this.connectDrag.line.setAttribute('x2', String(x));
            this.connectDrag.line.setAttribute('y2', String(y));
        }
    }

    private onPointerUp(e: PointerEvent): void {
        if (this.nodeDrag && this.nodeDrag.pointerId === e.pointerId) {
            this.nodesLayer?.querySelectorAll('.story-graph-focus-node').forEach(n => n.classList.remove('is-dragging'));
            this.nodeDrag = null;
            return;
        }
        if (this.connectDrag && this.connectDrag.pointerId === e.pointerId) {
            const { fromSide, fromPortId } = this.connectDrag;
            this.connectDrag.line.remove();
            this.connectDrag = null;

            const hitPort = this.hitTestPort(e.clientX, e.clientY);
            const targetSide = hitPort?.side || this.hitTestNode(e.clientX, e.clientY);
            if (!targetSide || targetSide === fromSide) return;

            // Dropped on a specific handle → reuse it (same handle may host many lines).
            if (hitPort && hitPort.side === targetSide) {
                this.addStrandBetweenPorts(fromSide, fromPortId, targetSide, hitPort.portId);
                return;
            }

            // Dropped on the node → ask whether to create a new handle on the target.
            const existingTargetPort = this.portsFor(targetSide)[0]?.id;
            openConfirmModal(this.plugin.app, {
                title: t('Create new handle?'),
                message: t('Create a new handle for this strand, or attach it to an existing handle?'),
                confirmLabel: t('New handle'),
                confirmClass: 'mod-cta',
                cancelLabel: t('Use existing handle'),
                onConfirm: () => {
                    const port = createFocusPort();
                    if (targetSide === 'left') this.leftPorts.push(port);
                    else this.rightPorts.push(port);
                    this.addStrandBetweenPorts(fromSide, fromPortId, targetSide, port.id);
                },
                onCancel: () => {
                    if (!existingTargetPort) return;
                    this.addStrandBetweenPorts(fromSide, fromPortId, targetSide, existingTargetPort);
                },
            });
        }
    }

    /** Inline label editor at the strand midpoint (double-click edge). */
    private beginEditStrandLabel(strand: StoryGraphStrand, midX: number, midY: number): void {
        if (!this.stage) return;
        this.endEditStrandLabel(false);
        this.selectedId = strand.id;

        const input = this.stage.createEl('input', {
            cls: 'story-graph-focus-inline-label',
            attr: {
                type: 'text',
                value: strand.label,
                placeholder: t('Short label'),
                'aria-label': t('Strand label'),
            },
        }) as HTMLInputElement;
        input.value = strand.label;
        input.style.left = `${midX}px`;
        input.style.top = `${midY}px`;
        this.labelEditor = input;

        const commit = () => {
            if (this.labelEditor !== input) return;
            strand.label = input.value.trim();
            this.dirty = true;
            this.endEditStrandLabel(false);
            this.renderDock();
            this.redrawCanvas();
        };
        const cancel = () => {
            if (this.labelEditor !== input) return;
            this.endEditStrandLabel(false);
            this.renderDock();
            this.redrawCanvas();
        };

        input.addEventListener('keydown', (e) => {
            if (e.key === 'Enter') {
                e.preventDefault();
                commit();
            } else if (e.key === 'Escape') {
                e.preventDefault();
                cancel();
            }
            e.stopPropagation();
        });
        input.addEventListener('blur', () => commit());
        input.addEventListener('pointerdown', (e) => e.stopPropagation());

        // Focus after layout so the caret is visible.
        requestAnimationFrame(() => {
            input.focus();
            input.select();
        });
        this.renderDock();
    }

    private endEditStrandLabel(_commit: boolean): void {
        this.labelEditor?.remove();
        this.labelEditor = null;
    }

    private addStrandBetweenPorts(
        fromSide: 'left' | 'right',
        fromPortId: string,
        toSide: 'left' | 'right',
        toPortId: string,
    ): void {
        const direction: StoryGraphStrandDirection = fromSide === 'left' ? 'ltr' : 'rtl';
        const leftPortId = fromSide === 'left' ? fromPortId : toPortId;
        const rightPortId = fromSide === 'right' ? fromPortId : toPortId;
        const strand = createStoryGraphStrand({
            direction,
            label: t('New strand'),
            leftPortId,
            rightPortId,
        });
        this.strands.push(strand);
        this.selectedId = strand.id;
        this.dirty = true;
        this.renderDock();
        this.redrawCanvas();
    }

    private hitTestPort(clientX: number, clientY: number): { side: 'left' | 'right'; portId: string } | null {
        if (!this.nodesLayer) return null;
        const ports = this.nodesLayer.querySelectorAll('.story-graph-focus-port');
        for (const el of Array.from(ports)) {
            const r = el.getBoundingClientRect();
            const pad = 10;
            if (
                clientX >= r.left - pad
                && clientX <= r.right + pad
                && clientY >= r.top - pad
                && clientY <= r.bottom + pad
            ) {
                const side = el.getAttribute('data-side') as 'left' | 'right' | null;
                const portId = el.getAttribute('data-port-id');
                if ((side === 'left' || side === 'right') && portId) {
                    return { side, portId };
                }
            }
        }
        return null;
    }

    private hitTestNode(clientX: number, clientY: number): 'left' | 'right' | null {
        if (!this.nodesLayer) return null;
        for (const side of ['left', 'right'] as const) {
            const node = this.nodesLayer.querySelector(`[data-side="${side}"]`) as HTMLElement | null;
            if (!node) continue;
            const r = node.getBoundingClientRect();
            const pad = 12;
            if (
                clientX >= r.left - pad
                && clientX <= r.right + pad
                && clientY >= r.top - pad
                && clientY <= r.bottom + pad
            ) {
                return side;
            }
        }
        return null;
    }

    private resolveImage(endpoint: StoryGraphFocusEndpoint): string {
        if (endpoint.image) return resolveImagePath(this.plugin.app, endpoint.image);
        const file = this.plugin.app.vault.getAbstractFileByPath(endpoint.filePath);
        if (file instanceof TFile) {
            const img = this.plugin.app.metadataCache.getFileCache(file)?.frontmatter?.image;
            if (typeof img === 'string' && img.trim()) {
                return resolveImagePath(this.plugin.app, img);
            }
        }
        const character = this.plugin.characterManager.getAllCharacters()
            .find(c => c.filePath === endpoint.filePath);
        if (character?.image) return resolveImagePath(this.plugin.app, character.image);
        return '';
    }

    private async save(): Promise<void> {
        try {
            // Keep blank-labeled strands — they still count toward main-edge thickness.
            const strands = this.strands
                .map(s => createStoryGraphStrand({
                    ...s,
                    label: s.label.trim(),
                    color: s.color || this.parentColor,
                }))
                .filter(s => !!s.id);

            const ensured = ensureFocusPorts(this.leftPorts, this.rightPorts, strands);
            this.leftPorts = ensured.leftPorts;
            this.rightPorts = ensured.rightPorts;
            const bundle: StoryGraphFocusBundle = {
                leftPath: this.left.filePath,
                rightPath: this.right.filePath,
                leftName: this.left.name,
                rightName: this.right.name,
                parentId: this.parentId,
                parentLabel: this.parentLabel,
                parentColor: this.parentColor,
                strands: ensured.strands,
                leftPorts: ensured.leftPorts,
                rightPorts: ensured.rightPorts,
                leftPos: { ...this.leftPos },
                rightPos: { ...this.rightPos },
            };
            const key = storyGraphFocusKey(this.left.filePath, this.right.filePath, this.parentId);
            const all = { ...(this.plugin.settings.storyGraphFocusBundles || {}) };
            all[key] = bundle;
            // Drop legacy pair-only key once parent-scoped data exists.
            const legacyKey = storyGraphPairKey(this.left.filePath, this.right.filePath);
            if (legacyKey !== key) delete all[legacyKey];
            this.plugin.settings.storyGraphFocusBundles = all;
            await this.plugin.saveSettings();
            this.strands = strands;
            this.dirty = false;
            new Notice(t('Strands saved'));
            this.onSaved?.();
        } catch (err) {
            console.error('[NarrativeLab] Story Graph focus save failed', err);
            new Notice(t('Failed to save strands'));
        }
    }

    private async close(promptIfDirty: boolean): Promise<void> {
        if (promptIfDirty && this.dirty) {
            await this.save();
        }
        this.destroy();
        this.onClose();
    }

    destroy(): void {
        activeWindow.removeEventListener('pointermove', this.boundPointerMove);
        activeWindow.removeEventListener('pointerup', this.boundPointerUp);
        activeWindow.removeEventListener('pointercancel', this.boundPointerUp);
        activeWindow.removeEventListener('resize', this.boundResize);
        this.root?.remove();
        this.root = null;
        this.stage = null;
        this.svg = null;
        this.nodesLayer = null;
        this.dock = null;
    }
}

export function openStoryGraphRelationFocus(
    host: HTMLElement,
    plugin: SceneCardsPlugin,
    edge: StoryGraphFocusEdge,
    onClosed: () => void,
    onSaved?: () => void,
): StoryGraphFocusView {
    host.querySelectorAll('.story-graph-focus').forEach(el => el.remove());
    return new StoryGraphFocusView(host, plugin, edge, onClosed, onSaved);
}
