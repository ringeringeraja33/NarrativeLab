/* eslint-disable @typescript-eslint/no-unsafe-assignment -- Obsidian DOM + async save handlers */
import { Menu, Notice, TFile, normalizePath, setIcon } from 'obsidian';
import type SceneCardsPlugin from '../main';
import { pickImage, resolveImagePath } from './ImagePicker';
import { openConfirmModal } from './ConfirmModal';
import type { StoryGraphLayoutState } from './StoryGraph';
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
    type StoryGraphStrandMid,
} from '../utils/storyGraphStrands';
import { t } from '../utils/i18n';
import { showMenuSafely } from '../utils/obsidianMenu';

interface FocusUndoSnapshot {
    strands: StoryGraphStrand[];
    leftPorts: StoryGraphFocusPort[];
    rightPorts: StoryGraphFocusPort[];
    leftPos: StoryGraphFocusNodePos;
    rightPos: StoryGraphFocusNodePos;
    selectedId: string | null;
}
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
    private canvasToolbar: HTMLElement | null = null;
    private hintBar: HTMLElement | null = null;
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
    /** Excalidraw-style canvas tool. */
    private tool: 'select' | 'arrow' = 'select';
    private strandsMenuOpen = false;
    private strandSearchQuery = '';
    private undoStack: FocusUndoSnapshot[] = [];
    private redoStack: FocusUndoSnapshot[] = [];
    private static readonly MAX_UNDO = 40;
    private undoBtn: HTMLButtonElement | null = null;
    private redoBtn: HTMLButtonElement | null = null;
    private onClose: () => void;
    private onSaved?: () => void;
    private nodeDrag: null | {
        side: 'left' | 'right';
        pointerId: number;
        pushedUndo: boolean;
    } = null;
    private connectDrag: null | {
        fromSide: 'left' | 'right';
        fromPortId: string;
        pointerId: number;
        line: SVGLineElement;
    } = null;
    private bendDrag: null | {
        strandId: string;
        pointerId: number;
        pushedUndo: boolean;
        x1: number;
        y1: number;
        x2: number;
        y2: number;
    } = null;
    private boundPointerMove = (e: PointerEvent) => this.onPointerMove(e);
    private boundPointerUp = (e: PointerEvent) => this.onPointerUp(e);
    private boundResize = () => this.redrawCanvas();
    private boundKeyDown = (e: KeyboardEvent) => this.onKeyDown(e);

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
        activeWindow.addEventListener('keydown', this.boundKeyDown, true);
    }

    private cloneStrand(s: StoryGraphStrand): StoryGraphStrand {
        return {
            ...s,
            mid: s.mid ? { ...s.mid } : undefined,
        };
    }

    private cloneSnapshot(): FocusUndoSnapshot {
        return {
            strands: this.strands.map(s => this.cloneStrand(s)),
            leftPorts: this.leftPorts.map(p => ({ ...p })),
            rightPorts: this.rightPorts.map(p => ({ ...p })),
            leftPos: { ...this.leftPos },
            rightPos: { ...this.rightPos },
            selectedId: this.selectedId,
        };
    }

    private pushUndo(): void {
        this.undoStack.push(this.cloneSnapshot());
        if (this.undoStack.length > StoryGraphFocusView.MAX_UNDO) {
            this.undoStack.shift();
        }
        this.redoStack = [];
        this.syncUndoRedoButtons();
    }

    private applyFocusSnapshot(snap: FocusUndoSnapshot): void {
        this.endEditStrandLabel(false);
        this.strands = snap.strands.map(s => this.cloneStrand(s));
        this.leftPorts = snap.leftPorts.map(p => ({ ...p }));
        this.rightPorts = snap.rightPorts.map(p => ({ ...p }));
        this.leftPos = { ...snap.leftPos };
        this.rightPos = { ...snap.rightPos };
        this.selectedId = snap.selectedId;
        this.dirty = true;
        this.syncUndoRedoButtons();
        this.renderCanvasToolbar();
        this.redrawCanvas();
    }

    private undo(): void {
        const snap = this.undoStack.pop();
        if (!snap) {
            new Notice(t('Nothing to undo'));
            return;
        }
        this.redoStack.push(this.cloneSnapshot());
        if (this.redoStack.length > StoryGraphFocusView.MAX_UNDO) {
            this.redoStack.shift();
        }
        this.applyFocusSnapshot(snap);
    }

    private redo(): void {
        const snap = this.redoStack.pop();
        if (!snap) {
            new Notice(t('Nothing to redo'));
            return;
        }
        this.undoStack.push(this.cloneSnapshot());
        if (this.undoStack.length > StoryGraphFocusView.MAX_UNDO) {
            this.undoStack.shift();
        }
        this.applyFocusSnapshot(snap);
    }

    private syncUndoRedoButtons(): void {
        if (this.undoBtn) this.undoBtn.disabled = this.undoStack.length === 0;
        if (this.redoBtn) this.redoBtn.disabled = this.redoStack.length === 0;
    }

    private onKeyDown(e: KeyboardEvent): void {
        if (!this.root) return;
        const target = e.target as HTMLElement | null;
        const inField = !!target?.closest('input, textarea, select, [contenteditable="true"]');
        if (!inField && (e.key === '1' || e.key === 'v' || e.key === 'V')) {
            e.preventDefault();
            this.setTool('select');
            return;
        }
        if (!inField && (e.key === '5' || e.key === 'a' || e.key === 'A')) {
            e.preventDefault();
            this.setTool('arrow');
            return;
        }
        if (!inField && e.key === 'Escape') {
            if (this.strandsMenuOpen) {
                e.preventDefault();
                this.strandsMenuOpen = false;
                this.renderCanvasToolbar();
                return;
            }
            if (this.tool !== 'select') {
                e.preventDefault();
                this.setTool('select');
                return;
            }
        }
        const mod = e.ctrlKey || e.metaKey;
        const isUndo = mod && !e.shiftKey && (e.key === 'z' || e.key === 'Z');
        const isRedo = mod && (
            (e.shiftKey && (e.key === 'z' || e.key === 'Z'))
            || e.key === 'y'
            || e.key === 'Y'
        );
        if (!isUndo && !isRedo) return;
        if (inField) return;
        if (!this.root.contains(target) && !this.root.contains(activeDocument.activeElement)) return;
        if (isUndo && this.undoStack.length === 0) return;
        if (isRedo && this.redoStack.length === 0) return;
        e.preventDefault();
        e.stopPropagation();
        if (isUndo) this.undo();
        else this.redo();
    }

    private setTool(tool: 'select' | 'arrow'): void {
        if (this.tool === tool) return;
        this.tool = tool;
        this.stage?.classList.toggle('is-arrow-tool', tool === 'arrow');
        this.syncHintBar();
        this.renderCanvasToolbar();
    }

    private syncHintBar(): void {
        if (!this.hintBar) return;
        this.hintBar.style.display = this.strandsMenuOpen ? 'none' : '';
        this.hintBar.setText(
            this.tool === 'arrow'
                ? t('Arrow tool: drag a handle to the other side to add a strand')
                : t('Drag mid-point to bend · double-click line to edit label · right-click a strand to remove it · open Strands to manage'),
        );
    }

    private portHasStrands(side: 'left' | 'right', portId: string): boolean {
        return this.strands.some(s =>
            (side === 'left' ? s.leftPortId : s.rightPortId) === portId,
        );
    }

    private deletePort(side: 'left' | 'right', portId: string): void {
        const ports = this.portsFor(side);
        if (ports.length <= 1) return;
        if (this.portHasStrands(side, portId)) return;
        this.pushUndo();
        if (side === 'left') {
            this.leftPorts = this.leftPorts.filter(p => p.id !== portId);
        } else {
            this.rightPorts = this.rightPorts.filter(p => p.id !== portId);
        }
        this.dirty = true;
        this.redrawCanvas();
    }

    private loadStrands(): void {
        const found = lookupStoryGraphFocusBundle(
            this.plugin.settings.storyGraphFocusBundles,
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

        const actions = toolbar.createDiv({ cls: 'story-graph-focus-toolbar-actions' });
        const undoBtn = actions.createEl('button', {
            cls: 'story-graph-focus-undo',
            attr: {
                type: 'button',
                title: t('Undo (Ctrl+Z)'),
                'aria-label': t('Undo (Ctrl+Z)'),
            },
        });
        setIcon(undoBtn.createSpan(), 'undo-2');
        undoBtn.createSpan({ text: ` ${t('Undo')}` });
        undoBtn.addEventListener('click', () => this.undo());
        this.undoBtn = undoBtn;

        const redoBtn = actions.createEl('button', {
            cls: 'story-graph-focus-redo',
            attr: {
                type: 'button',
                title: t('Redo (Ctrl+Shift+Z)'),
                'aria-label': t('Redo (Ctrl+Shift+Z)'),
            },
        });
        setIcon(redoBtn.createSpan(), 'redo-2');
        redoBtn.createSpan({ text: ` ${t('Redo')}` });
        redoBtn.addEventListener('click', () => this.redo());
        this.redoBtn = redoBtn;
        this.syncUndoRedoButtons();

        const saveBtn = actions.createEl('button', {
            cls: 'mod-cta',
            text: t('Save strands'),
            attr: { type: 'button' },
        });
        saveBtn.addEventListener('click', () => { void this.save(); });

        const stage = root.createDiv({ cls: 'story-graph-focus-stage is-canvas' });
        this.stage = stage;
        this.hintBar = stage.createDiv({ cls: 'story-graph-focus-hint-bar' });
        this.syncHintBar();

        this.canvasToolbar = stage.createDiv({ cls: 'story-graph-focus-canvas-tools' });
        this.renderCanvasToolbar();

        const svg = activeDocument.createElementNS(SVG_NS, 'svg');
        svg.classList.add('story-graph-focus-svg');
        stage.appendChild(svg);
        this.svg = svg;

        this.nodesLayer = stage.createDiv({ cls: 'story-graph-focus-nodes' });
        this.mountNode('left');
        this.mountNode('right');

        stage.addEventListener('pointerdown', (e) => {
            if (!this.strandsMenuOpen) return;
            const target = e.target as HTMLElement;
            if (target.closest('.story-graph-focus-canvas-tools')) return;
            this.strandsMenuOpen = false;
            this.renderCanvasToolbar();
        });

        window.requestAnimationFrame(() => this.redrawCanvas());
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
            this.pushUndo();
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
            this.nodeDrag = { side, pointerId: e.pointerId, pushedUndo: false };
            el.classList.add('is-dragging');
            try { el.setPointerCapture(e.pointerId); } catch { /* ignore */ }
        });

        el.addEventListener('contextmenu', (e) => {
            if ((e.target as HTMLElement).closest('.story-graph-focus-port, .story-graph-focus-add-port')) return;
            e.preventDefault();
            e.stopPropagation();
            this.showNodeImageMenu(e, side);
        });

        el.addEventListener('dblclick', () => {
            if (endpoint.filePath) {
                void this.plugin.app.workspace.openLinkText(endpoint.filePath, '', false);
            }
        });
    }

    private storyGraphLayoutProjectKey(): string {
        return this.plugin.sceneManager.activeProject?.filePath || '__global__';
    }

    private getStoryGraphLayout(): StoryGraphLayoutState {
        const layouts = this.plugin.settings.storyGraphLayouts || {};
        const prev = layouts[this.storyGraphLayoutProjectKey()];
        return {
            positions: { ...(prev?.positions || {}) },
            nodeImages: { ...(prev?.nodeImages || {}) },
            nodeScale: prev?.nodeScale,
            panX: prev?.panX,
            panY: prev?.panY,
            zoom: prev?.zoom,
        };
    }

    private layoutImageKey(endpoint: StoryGraphFocusEndpoint): string {
        return normalizePath(endpoint.filePath || '');
    }

    /** Vault-relative path: layout override → endpoint → note/character. */
    private resolveStoredImagePath(endpoint: StoryGraphFocusEndpoint): string {
        const key = this.layoutImageKey(endpoint);
        if (key) {
            const images = this.getStoryGraphLayout().nodeImages || {};
            const override = images[key] || images[endpoint.filePath];
            if (typeof override === 'string' && override.trim()) return override.trim();
        }
        if (endpoint.image?.trim()) return endpoint.image.trim();
        const file = this.plugin.app.vault.getAbstractFileByPath(endpoint.filePath);
        if (file instanceof TFile) {
            const img = this.plugin.app.metadataCache.getFileCache(file)?.frontmatter?.image;
            if (typeof img === 'string' && img.trim()) return img.trim();
        }
        const character = this.plugin.characterManager.getAllCharacters()
            .find(c => c.filePath === endpoint.filePath);
        if (character?.image?.trim()) return character.image.trim();
        return '';
    }

    private hasLayoutImageOverride(endpoint: StoryGraphFocusEndpoint): boolean {
        const key = this.layoutImageKey(endpoint);
        if (!key) return false;
        const images = this.getStoryGraphLayout().nodeImages || {};
        const override = images[key] || images[endpoint.filePath];
        return typeof override === 'string' && !!override.trim();
    }

    private showNodeImageMenu(e: MouseEvent, side: 'left' | 'right'): void {
        const endpoint = side === 'left' ? this.left : this.right;
        const menu = new Menu();
        menu.addItem(item => {
            item.setTitle(endpoint.name || '?');
            item.setDisabled(true);
        });
        menu.addSeparator();
        const current = this.resolveStoredImagePath(endpoint);
        menu.addItem(item => {
            item.setTitle(current ? t('Change node image') : t('Set node image'));
            item.setIcon('image');
            item.onClick(() => { void this.pickImageForEndpoint(side); });
        });
        if (this.hasLayoutImageOverride(endpoint)) {
            menu.addItem(item => {
                item.setTitle(t('Clear node image'));
                item.setIcon('image-off');
                item.onClick(() => { void this.setEndpointLayoutImage(side, ''); });
            });
        }
        showMenuSafely(menu, e);
    }

    private async pickImageForEndpoint(side: 'left' | 'right'): Promise<void> {
        const endpoint = side === 'left' ? this.left : this.right;
        const attachmentFolder = this.plugin.sceneManager.activeProject?.filePath
            || this.plugin.sceneManager.getSceneFolder()
            || '';
        const current = this.resolveStoredImagePath(endpoint);
        const next = await pickImage(this.plugin.app, attachmentFolder, current || undefined);
        if (next === undefined) return;
        await this.setEndpointLayoutImage(side, next);
    }

    private async setEndpointLayoutImage(side: 'left' | 'right', image: string): Promise<void> {
        const endpoint = side === 'left' ? this.left : this.right;
        const key = this.layoutImageKey(endpoint);
        if (!key) {
            new Notice(t('Both endpoints need vault files to open focus view.'));
            return;
        }
        const projectKey = this.storyGraphLayoutProjectKey();
        const layout = this.getStoryGraphLayout();
        const nodeImages = { ...(layout.nodeImages || {}) };
        if (!image.trim()) {
            delete nodeImages[key];
            delete nodeImages[endpoint.filePath];
            endpoint.image = undefined;
        } else {
            nodeImages[key] = image.trim();
            endpoint.image = image.trim();
        }
        this.plugin.settings.storyGraphLayouts = {
            ...(this.plugin.settings.storyGraphLayouts || {}),
            [projectKey]: { ...layout, nodeImages },
        };
        await this.plugin.saveSettings();
        this.refreshNodeAvatar(side);
        this.onSaved?.();
    }

    private refreshNodeAvatar(side: 'left' | 'right'): void {
        const endpoint = side === 'left' ? this.left : this.right;
        const node = this.nodesLayer?.querySelector(`[data-side="${side}"]`) as HTMLElement | null;
        const avatar = node?.querySelector('.story-graph-focus-avatar') as HTMLElement | null;
        if (!avatar) return;
        avatar.empty();
        const src = this.resolveImage(endpoint);
        if (src) {
            avatar.createEl('img', { attr: { src, alt: endpoint.name } });
        } else {
            const fallback = avatar.createDiv({ cls: 'story-graph-focus-avatar-fallback' });
            fallback.setText((endpoint.name || '?').slice(0, 1));
        }
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
            const node = this.nodesLayer.querySelector(`[data-side="${side}"]`);
            if (!node) continue;
            const host = node.querySelector('.story-graph-focus-ports');
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
                    // Connect from handles in arrow tool (Excalidraw-style), or always when menu wants quick add.
                    if (this.tool !== 'arrow') {
                        this.setTool('arrow');
                    }
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
                el.addEventListener('contextmenu', (e) => {
                    e.preventDefault();
                    e.stopPropagation();
                    // Only offer delete when this handle has no strands and isn't the last one.
                    if (this.portHasStrands(side, port.id)) return;
                    if (this.portsFor(side).length <= 1) return;
                    const menu = new Menu();
                    menu.addItem(item => {
                        item.setTitle(t('Delete handle'))
                            .setIcon('trash-2')
                            .onClick(() => this.deletePort(side, port.id));
                    });
                    showMenuSafely(menu, e);
                });
            });

            // Place "+" just outside the outermost port fan.
            const addBtn = node.querySelector<HTMLElement>('.story-graph-focus-add-port');
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

    private renderCanvasToolbar(): void {
        if (!this.canvasToolbar) return;
        const focusSearch = !!this.canvasToolbar.querySelector('.story-graph-focus-strand-search:focus');
        this.canvasToolbar.empty();
        this.stage?.classList.toggle('is-arrow-tool', this.tool === 'arrow');
        this.syncHintBar();

        const bar = this.canvasToolbar.createDiv({ cls: 'story-graph-focus-tool-bar' });

        const selectBtn = bar.createEl('button', {
            cls: `story-graph-focus-tool-btn${this.tool === 'select' ? ' is-active' : ''}`,
            attr: {
                type: 'button',
                title: `${t('Select')} — 1`,
                'aria-label': t('Select'),
                'aria-pressed': this.tool === 'select' ? 'true' : 'false',
            },
        });
        setIcon(selectBtn, 'mouse-pointer-2');
        selectBtn.createSpan({ cls: 'story-graph-focus-tool-key', text: '1' });
        selectBtn.addEventListener('click', (e) => {
            e.stopPropagation();
            this.setTool('select');
        });

        const arrowBtn = bar.createEl('button', {
            cls: `story-graph-focus-tool-btn${this.tool === 'arrow' ? ' is-active' : ''}`,
            attr: {
                type: 'button',
                title: `${t('Arrow / connect')} — 5`,
                'aria-label': t('Arrow / connect'),
                'aria-pressed': this.tool === 'arrow' ? 'true' : 'false',
            },
        });
        setIcon(arrowBtn, 'move-up-right');
        arrowBtn.createSpan({ cls: 'story-graph-focus-tool-key', text: '5' });
        arrowBtn.addEventListener('click', (e) => {
            e.stopPropagation();
            this.setTool('arrow');
        });

        bar.createDiv({ cls: 'story-graph-focus-tool-divider' });

        const strandsWrap = bar.createDiv({ cls: 'story-graph-focus-strands-menu' });
        const strandsBtn = strandsWrap.createEl('button', {
            cls: `story-graph-focus-tool-btn story-graph-focus-strands-trigger${this.strandsMenuOpen ? ' is-open' : ''}`,
            attr: {
                type: 'button',
                title: t('Strands'),
                'aria-label': t('Strands'),
                'aria-expanded': this.strandsMenuOpen ? 'true' : 'false',
            },
        });
        setIcon(strandsBtn, 'list');
        strandsBtn.createSpan({
            cls: 'story-graph-focus-strands-trigger-label',
            text: `${t('Strands')} · ${this.strands.length}`,
        });
        setIcon(strandsBtn.createSpan({ cls: 'story-graph-focus-strands-chevron' }), 'chevron-down');
        strandsBtn.addEventListener('click', (e) => {
            e.stopPropagation();
            this.strandsMenuOpen = !this.strandsMenuOpen;
            this.renderCanvasToolbar();
        });

        if (this.strandsMenuOpen) {
            // Panel hangs under the whole tool bar (not just the trigger).
            const panel = this.canvasToolbar.createDiv({ cls: 'story-graph-focus-strands-panel' });
            panel.addEventListener('pointerdown', (e) => e.stopPropagation());

            const search = panel.createEl('input', {
                cls: 'story-graph-focus-strand-search',
                attr: {
                    type: 'search',
                    placeholder: t('Search strands'),
                    value: this.strandSearchQuery,
                    'aria-label': t('Search strands'),
                },
            });
            search.value = this.strandSearchQuery;

            const list = panel.createDiv({ cls: 'story-graph-focus-strand-list' });
            this.renderStrandList(list);

            search.addEventListener('input', () => {
                this.strandSearchQuery = search.value;
                this.renderStrandList(list);
            });

            const addBtn = panel.createEl('button', {
                cls: 'story-graph-focus-add-strand',
                attr: { type: 'button' },
            });
            setIcon(addBtn.createSpan(), 'plus');
            addBtn.createSpan({ text: ` ${t('Add strand')}` });
            addBtn.addEventListener('click', () => {
                this.addStrandQuick();
            });

            if (focusSearch) {
                window.requestAnimationFrame(() => {
                    search.focus();
                    const len = search.value.length;
                    search.setSelectionRange(len, len);
                });
            }
        }
    }

    private syncStrandCardSelection(): void {
        if (!this.canvasToolbar || !this.strandsMenuOpen) return;
        this.canvasToolbar.querySelectorAll('.story-graph-focus-strand-card').forEach((el) => {
            const id = el.getAttribute('data-strand-id');
            el.classList.toggle('is-selected', id === this.selectedId);
            if (id === this.selectedId) {
                (el as HTMLElement).scrollIntoView({ block: 'nearest' });
            }
        });
    }

    private renderStrandList(list: HTMLElement): void {
        list.empty();
        const q = this.strandSearchQuery.trim().toLowerCase();
        const entries = this.strands
            .filter((strand) => !q || strand.label.toLowerCase().includes(q));
        if (entries.length === 0) {
            list.createDiv({
                cls: 'story-graph-focus-strand-empty',
                text: this.strands.length === 0
                    ? t('No strands yet — use the arrow tool or add one below')
                    : t('No matching strands'),
            });
            return;
        }
        for (const strand of entries) {
            list.appendChild(this.makeStrandCard(strand));
        }
        window.requestAnimationFrame(() => {
            const selected = list.querySelector('.story-graph-focus-strand-card.is-selected');
            selected?.scrollIntoView({ block: 'nearest' });
        });
    }

    private addStrandQuick(): void {
        this.pushUndo();
        const strand = createStoryGraphStrand({
            direction: 'ltr',
            label: t('New strand'),
            leftPortId: this.leftPorts[0]?.id,
            rightPortId: this.rightPorts[0]?.id,
        });
        this.strands.push(strand);
        this.selectedId = strand.id;
        this.dirty = true;
        this.strandsMenuOpen = true;
        this.tool = 'select';
        this.stage?.classList.toggle('is-arrow-tool', false);
        this.syncHintBar();
        this.renderCanvasToolbar();
        this.redrawCanvas();
    }

    private makeStrandCard(strand: StoryGraphStrand): HTMLElement {
        const row = activeDocument.createElement('div');
        row.className = `story-graph-focus-strand-card${this.selectedId === strand.id ? ' is-selected' : ''}`;
        row.setAttribute('data-strand-id', strand.id);
        row.addEventListener('click', (e) => {
            if ((e.target as HTMLElement).closest('button, input, select')) return;
            this.selectedId = strand.id;
            this.syncStrandCardSelection();
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
                if (strand.direction === opt.value) return;
                this.pushUndo();
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
        });
        let labelUndoPushed = false;
        labelInput.addEventListener('focus', () => { labelUndoPushed = false; });
        labelInput.addEventListener('input', () => {
            if (!labelUndoPushed) {
                this.pushUndo();
                labelUndoPushed = true;
            }
            strand.label = labelInput.value;
            this.dirty = true;
            this.paintStrandPreview(preview, strand);
            this.redrawCanvas();
        });

        const styleSelect = row.createEl('select', {
            cls: 'story-graph-focus-strand-style',
            attr: { 'aria-label': t('Line style') },
        });
        for (const opt of [
            { value: 'solid', label: t('Solid') },
            { value: 'dashed', label: t('Dashed') },
            { value: 'dotted', label: t('Dotted') },
        ]) {
            styleSelect.createEl('option', { text: opt.label, attr: { value: opt.value } });
        }
        styleSelect.value = strand.lineStyle;
        styleSelect.addEventListener('change', () => {
            this.pushUndo();
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
        });
        let colorUndoPushed = false;
        color.addEventListener('pointerdown', () => { colorUndoPushed = false; });
        color.addEventListener('input', () => {
            if (!colorUndoPushed) {
                this.pushUndo();
                colorUndoPushed = true;
            }
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
        remove.disabled = this.strands.length <= 1;
        if (this.strands.length <= 1) {
            remove.setAttribute(
                'title',
                t('Keep at least one strand. To remove the link entirely, delete it on the Story Graph.'),
            );
        }
        remove.addEventListener('click', (e) => {
            e.stopPropagation();
            this.removeStrandById(strand.id);
        });

        return row;
    }

    /** Child strands only — the parent edge is removed from the main Story Graph. */
    private removeStrandById(strandId: string): void {
        if (this.strands.length <= 1) {
            new Notice(t('Keep at least one strand. To remove the link entirely, delete it on the Story Graph.'));
            return;
        }
        const index = this.strands.findIndex(s => s.id === strandId);
        if (index < 0) return;
        this.pushUndo();
        this.strands.splice(index, 1);
        if (this.selectedId === strandId) {
            this.selectedId = this.strands[0]?.id || null;
        }
        this.dirty = true;
        this.renderCanvasToolbar();
        this.redrawCanvas();
    }

    private showStrandContextMenu(e: MouseEvent, strand: StoryGraphStrand): void {
        const menu = new Menu();
        const title = strand.label.trim() || t('New strand');
        menu.addItem(item => {
            item.setTitle(title);
            item.setDisabled(true);
        });
        menu.addSeparator();
        menu.addItem(item => {
            item.setTitle(t('Remove strand'));
            item.setIcon('trash-2');
            if (this.strands.length <= 1) item.setDisabled(true);
            item.onClick(() => this.removeStrandById(strand.id));
        });
        showMenuSafely(menu, e);
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

    /**
     * Quadratic bend through a mid handle on the curve (Excalidraw-like),
     * expressed as an equivalent cubic for SVG path + textPath.
     */
    private strandCubicThroughMid(
        x1: number,
        y1: number,
        x2: number,
        y2: number,
        sux: number,
        suy: number,
        snx: number,
        sny: number,
        mid: StoryGraphStrandMid,
    ): {
        c1x: number;
        c1y: number;
        c2x: number;
        c2y: number;
        handleX: number;
        handleY: number;
    } {
        const chordMidX = (x1 + x2) / 2;
        const chordMidY = (y1 + y2) / 2;
        const handleX = chordMidX + sux * mid.along + snx * mid.perp;
        const handleY = chordMidY + suy * mid.along + sny * mid.perp;
        // Control point so the quadratic passes through the handle at t=0.5.
        const ctrlX = 2 * handleX - chordMidX;
        const ctrlY = 2 * handleY - chordMidY;
        return {
            c1x: x1 + (2 / 3) * (ctrlX - x1),
            c1y: y1 + (2 / 3) * (ctrlY - y1),
            c2x: x2 + (2 / 3) * (ctrlX - x2),
            c2y: y2 + (2 / 3) * (ctrlY - y2),
            handleX,
            handleY,
        };
    }

    private midFromPointer(
        clientX: number,
        clientY: number,
        x1: number,
        y1: number,
        x2: number,
        y2: number,
    ): StoryGraphStrandMid {
        if (!this.stage) return { along: 0, perp: 0 };
        const rect = this.stage.getBoundingClientRect();
        const px = clientX - rect.left;
        const py = clientY - rect.top;
        const cdx = x2 - x1;
        const cdy = y2 - y1;
        const spanLen = Math.hypot(cdx, cdy) || 1;
        const sux = cdx / spanLen;
        const suy = cdy / spanLen;
        const snx = -suy;
        const sny = sux;
        const chordMidX = (x1 + x2) / 2;
        const chordMidY = (y1 + y2) / 2;
        const ox = px - chordMidX;
        const oy = py - chordMidY;
        const along = Math.max(-800, Math.min(800, ox * sux + oy * suy));
        const perp = Math.max(-800, Math.min(800, ox * snx + oy * sny));
        return { along, perp };
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

    /** Wrap metrics for a strand label — drives both drawing and anti-overlap packing. */
    private strandLabelMetrics(
        label: string,
        pathLength: number,
        fontSize = 12,
        maxLines = 3,
    ): { lines: string[]; lineGap: number; height: number; band: number } {
        const pathLen = Math.max(80, pathLength);
        // ~0.9em per CJK glyph; leave margins so text doesn't reach arrowheads.
        const maxChars = Math.max(4, Math.floor((pathLen * 0.5) / (fontSize * 0.92)));
        const lines = this.wrapPathLabel(label, maxChars, maxLines);
        const lineGap = fontSize + 2;
        const height = lines.length === 0 ? 0 : lines.length * lineGap;
        // Perpendicular band reserved for this strand so tall blocks don't stack.
        const band = Math.max(22, height + (lines.length > 1 ? 18 : 12));
        return { lines, lineGap, height, band };
    }

    /**
     * Pack strand bows so label blocks (especially multi-line) leave each other room.
     * Returns bow offset along the left→right normal, centered on 0.
     */
    private packStrandBows(
        strands: StoryGraphStrand[],
        pathLength: number,
        fontSize = 12,
        maxLines = 3,
    ): Map<string, { bow: number; metrics: ReturnType<StoryGraphFocusView['strandLabelMetrics']> }> {
        const gap = 10;
        const items = strands.map((strand) => ({
            strand,
            metrics: this.strandLabelMetrics(strand.label, pathLength, fontSize, maxLines),
        }));
        const centers: number[] = [];
        for (let i = 0; i < items.length; i++) {
            const half = items[i].metrics.band / 2;
            if (i === 0) {
                centers.push(0);
            } else {
                const prevHalf = items[i - 1].metrics.band / 2;
                centers.push(centers[i - 1] + prevHalf + gap + half);
            }
        }
        if (centers.length > 0) {
            const mid = (centers[0] + centers[centers.length - 1]) / 2;
            for (let i = 0; i < centers.length; i++) centers[i] -= mid;
        }
        const out = new Map<string, { bow: number; metrics: ReturnType<StoryGraphFocusView['strandLabelMetrics']> }>();
        items.forEach((item, i) => {
            out.set(item.strand.id, { bow: centers[i] || 0, metrics: item.metrics });
        });
        return out;
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
            /** Precomputed wrap lines (avoids double-wrapping). */
            lines?: string[];
        },
    ): void {
        const fontSize = opts?.fontSize ?? 12;
        const baseDy = opts?.dy ?? -10;
        const maxLines = opts?.maxLines ?? 3;
        const pathLength = Math.max(80, opts?.pathLength ?? 220);
        const metrics = opts?.lines
            ? {
                lines: opts.lines,
                lineGap: fontSize + 2,
            }
            : this.strandLabelMetrics(label, pathLength, fontSize, maxLines);
        const lines = metrics.lines;
        if (lines.length === 0) return;

        const useReverse = (opts?.tangentX ?? 1) < 0 && !!opts?.reverseD;
        const d = useReverse ? opts.reverseD! : pathD;
        const id = `${pathId}${useReverse ? '-r' : ''}`;

        const guide = activeDocument.createElementNS(SVG_NS, 'path');
        guide.setAttribute('id', id);
        guide.setAttribute('d', d);
        guide.setAttribute('fill', 'none');
        guide.setAttribute('stroke', 'none');
        guide.classList.add('story-graph-focus-label-guide');
        parent.appendChild(guide);

        const lineGap = metrics.lineGap;
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
            const node = this.nodesLayer.querySelector<HTMLElement>(`[data-side="${side}"]`);
            if (!node) continue;
            const center = side === 'left' ? left : right;
            node.style.left = `${center.x}px`;
            node.style.top = `${center.y}px`;
        }
        this.syncPortsDom();

        // Always geometry left→right; arrows convey direction.
        const dx = right.x - left.x;
        const dy = right.y - left.y;
        const len = Math.hypot(dx, dy) || 1;
        const ux = dx / len;
        const uy = dy / len;
        const baseSpan = Math.hypot(dx, dy) || 220;

        // Stable order: port fan (top→bottom) then dock order, then pack bows by label height.
        const packOrder = [...this.strands].sort((a, b) => {
            const aL = this.portIndex('left', a.leftPortId || this.leftPorts[0]?.id || '');
            const bL = this.portIndex('left', b.leftPortId || this.leftPorts[0]?.id || '');
            if (aL !== bL) return aL - bL;
            const aR = this.portIndex('right', a.rightPortId || this.rightPorts[0]?.id || '');
            const bR = this.portIndex('right', b.rightPortId || this.rightPorts[0]?.id || '');
            if (aR !== bR) return aR - bR;
            return this.strands.indexOf(a) - this.strands.indexOf(b);
        });
        const packed = this.packStrandBows(packOrder, baseSpan, 12, 3);

        this.strands.forEach((strand, index) => {
            const color = strand.color || '#5B7CFF';
            const selected = strand.id === this.selectedId;
            const leftPortId = strand.leftPortId || this.leftPorts[0]?.id;
            const rightPortId = strand.rightPortId || this.rightPorts[0]?.id;
            const pack = packed.get(strand.id);
            const autoBow = pack?.bow || 0;
            const labelMetrics = pack?.metrics;

            const leftAttach = this.portWorldPos('left', leftPortId || this.leftPorts[0].id);
            const rightAttach = this.portWorldPos('right', rightPortId || this.rightPorts[0].id);
            // Port centers stay on the rim; stroke/arrows stop short so they don't cover handles.
            const spanDx = rightAttach.x - leftAttach.x;
            const spanDy = rightAttach.y - leftAttach.y;
            const spanLen = Math.hypot(spanDx, spanDy) || 1;
            const sux = spanDx / spanLen;
            const suy = spanDy / spanLen;
            const snx = -suy;
            const sny = sux;
            const clearance = Math.min(FOCUS_PORT_CLEARANCE, spanLen * 0.2);
            const x1 = leftAttach.x + sux * clearance;
            const y1 = leftAttach.y + suy * clearance;
            const x2 = rightAttach.x - sux * clearance;
            const y2 = rightAttach.y - suy * clearance;

            // Mid bend: manual mid overrides auto label-pack bow (Excalidraw-style).
            const mid: StoryGraphStrandMid = strand.mid
                ? { along: strand.mid.along, perp: strand.mid.perp }
                : { along: 0, perp: autoBow };
            const geom = this.strandCubicThroughMid(x1, y1, x2, y2, sux, suy, snx, sny, mid);
            const { c1x, c1y, c2x, c2y, handleX: midX, handleY: midY } = geom;
            const cdx = x2 - x1;
            const cdy = y2 - y1;

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

            hit.addEventListener('pointerdown', (e) => {
                if (e.button !== 0) return;
                e.stopPropagation();
                const now = Date.now();
                const isDouble =
                    !!this.lastEdgeClick &&
                    this.lastEdgeClick.id === strand.id &&
                    now - this.lastEdgeClick.t < 400;
                this.lastEdgeClick = { id: strand.id, t: now };
                if (isDouble) {
                    e.preventDefault();
                    this.selectedId = strand.id;
                    this.beginEditStrandLabel(strand, midX, midY);
                    return;
                }
                const alreadySelected = this.selectedId === strand.id;
                this.selectedId = strand.id;
                this.syncStrandCardSelection();
                // Avoid rebuilding SVG on a re-click so the 2nd half of a
                // double-click can still land on this hit path / fire dblclick.
                if (!alreadySelected) this.redrawCanvas();
            });
            hit.addEventListener('dblclick', (e) => {
                e.preventDefault();
                e.stopPropagation();
                this.selectedId = strand.id;
                this.beginEditStrandLabel(strand, midX, midY);
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
            if (labelText && labelMetrics && labelMetrics.lines.length > 0) {
                // Mid-tangent of cubic at t≈0.5 (keep glyphs upright when flipped).
                const midTx = 0.75 * (c2x - c1x) + 0.375 * ((c1x - x1) + (x2 - c2x));
                const labelDy = -8;
                const safeId = `sgf-lbl-${strand.id.replace(/[^a-zA-Z0-9_-]/g, '')}-${index}`;
                const approxLen = Math.hypot(cdx, cdy) + Math.hypot(mid.along, mid.perp) * 0.6;
                this.appendPathLabel(g, d, safeId, labelText, color, {
                    fontSize: 12,
                    dy: labelDy,
                    tangentX: midTx || cdx,
                    reverseD: this.reverseCubicPathD(x1, y1, c1x, c1y, c2x, c2y, x2, y2),
                    pathLength: approxLen,
                    maxLines: 3,
                    lines: labelMetrics.lines,
                });
            }

            // Mid bend handle (selected strand) — visible only while the edge is hovered.
            if (selected) {
                const midHandle = activeDocument.createElementNS(SVG_NS, 'circle');
                midHandle.setAttribute('cx', String(midX));
                midHandle.setAttribute('cy', String(midY));
                midHandle.setAttribute('r', '6');
                midHandle.classList.add('story-graph-focus-mid-handle');
                if (this.bendDrag?.strandId === strand.id) {
                    midHandle.classList.add('is-dragging');
                }
                midHandle.setAttribute('aria-label', t('Drag to bend'));
                midHandle.addEventListener('pointerdown', (e) => {
                    if (e.button !== 0) return;
                    e.preventDefault();
                    e.stopPropagation();
                    const now = Date.now();
                    const isDouble =
                        !!this.lastEdgeClick &&
                        this.lastEdgeClick.id === strand.id &&
                        now - this.lastEdgeClick.t < 400;
                    this.lastEdgeClick = { id: strand.id, t: now };
                    this.selectedId = strand.id;
                    // Mid sits on the label; treat double-press as label edit.
                    if (isDouble) {
                        this.beginEditStrandLabel(strand, midX, midY);
                        return;
                    }
                    midHandle.classList.add('is-dragging');
                    this.bendDrag = {
                        strandId: strand.id,
                        pointerId: e.pointerId,
                        pushedUndo: false,
                        x1,
                        y1,
                        x2,
                        y2,
                    };
                    try {
                        (e.target as Element).setPointerCapture?.(e.pointerId);
                    } catch { /* ignore */ }
                });
                midHandle.addEventListener('dblclick', (e) => {
                    e.preventDefault();
                    e.stopPropagation();
                    // Prefer label edit when the mid handle receives the dblclick.
                    this.beginEditStrandLabel(strand, midX, midY);
                });
                g.appendChild(midHandle);
            }

            g.addEventListener('contextmenu', (e) => {
                e.preventDefault();
                e.stopPropagation();
                this.selectedId = strand.id;
                this.showStrandContextMenu(e, strand);
            });

            this.svg!.appendChild(g);
        });

        if (rubber && rubber.parentNode !== this.svg) {
            this.svg.appendChild(rubber);
        }
    }

    private onPointerMove(e: PointerEvent): void {
        if (this.bendDrag && this.bendDrag.pointerId === e.pointerId) {
            const strand = this.strands.find(s => s.id === this.bendDrag!.strandId);
            if (!strand) return;
            if (!this.bendDrag.pushedUndo) {
                this.pushUndo();
                this.bendDrag.pushedUndo = true;
            }
            strand.mid = this.midFromPointer(
                e.clientX,
                e.clientY,
                this.bendDrag.x1,
                this.bendDrag.y1,
                this.bendDrag.x2,
                this.bendDrag.y2,
            );
            this.dirty = true;
            this.redrawCanvas();
            return;
        }
        if (this.nodeDrag && this.nodeDrag.pointerId === e.pointerId && this.stage) {
            if (!this.nodeDrag.pushedUndo) {
                this.pushUndo();
                this.nodeDrag.pushedUndo = true;
            }
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
        if (this.bendDrag && this.bendDrag.pointerId === e.pointerId) {
            this.bendDrag = null;
            this.syncStrandCardSelection();
            this.redrawCanvas();
            return;
        }
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
                    this.pushUndo();
                    const port = createFocusPort();
                    if (targetSide === 'left') this.leftPorts.push(port);
                    else this.rightPorts.push(port);
                    this.addStrandBetweenPorts(fromSide, fromPortId, targetSide, port.id, false);
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
        });
        input.value = strand.label;
        input.style.left = `${midX}px`;
        input.style.top = `${midY}px`;
        this.labelEditor = input;

        const commit = () => {
            if (this.labelEditor !== input) return;
            const next = input.value.trim();
            if (next !== strand.label) {
                this.pushUndo();
                strand.label = next;
                this.dirty = true;
            }
            this.endEditStrandLabel(false);
            if (this.strandsMenuOpen) this.renderCanvasToolbar();
            else this.syncStrandCardSelection();
            this.redrawCanvas();
        };
        const cancel = () => {
            if (this.labelEditor !== input) return;
            this.endEditStrandLabel(false);
            this.syncStrandCardSelection();
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
        window.requestAnimationFrame(() => {
            input.focus();
            input.select();
        });
        this.syncStrandCardSelection();
    }

    private endEditStrandLabel(_commit: boolean): void {
        this.labelEditor?.remove();
        this.labelEditor = null;
    }

    private addStrandBetweenPorts(
        fromSide: 'left' | 'right',
        fromPortId: string,
        _toSide: 'left' | 'right',
        toPortId: string,
        recordUndo = true,
    ): void {
        if (recordUndo) this.pushUndo();
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
        this.strandsMenuOpen = true;
        this.renderCanvasToolbar();
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
            const node = this.nodesLayer.querySelector(`[data-side="${side}"]`);
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
        const path = this.resolveStoredImagePath(endpoint);
        return path ? resolveImagePath(this.plugin.app, path) : '';
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
        activeWindow.removeEventListener('keydown', this.boundKeyDown, true);
        this.endEditStrandLabel(false);
        this.root?.remove();
        this.root = null;
        this.stage = null;
        this.svg = null;
        this.nodesLayer = null;
        this.canvasToolbar = null;
        this.hintBar = null;
        this.undoBtn = null;
        this.redoBtn = null;
        this.undoStack = [];
        this.redoStack = [];
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
/* eslint-enable @typescript-eslint/no-unsafe-assignment -- End Obsidian DOM exception. */
