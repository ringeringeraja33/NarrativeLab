/* eslint-disable @typescript-eslint/no-floating-promises, @typescript-eslint/no-misused-promises, @typescript-eslint/no-unnecessary-type-assertion -- Obsidian's API surface and several untyped third-party libraries force dynamic dispatch; floating promises are intentional in DOM/event handlers; matching enable at end of file */
import { ButtonComponent, Menu, MenuItem, Modal, Notice, Setting, TFile, TextComponent, WorkspaceLeaf } from 'obsidian';
import * as obsidian from 'obsidian';
import { Scene } from '../models/Scene';
import { SceneManager } from '../services/SceneManager';
import { renderViewSwitcher } from '../components/ViewSwitcher';
import { renderStructureModeSwitcher, rememberStructureMode } from '../components/StructureModeSwitcher';
import type SceneCardsPlugin from '../main';

import { STORYLINE_VIEW_TYPE } from '../constants';
import { applyMobileClass } from '../components/MobileAdapter';
import { enableDragToPan } from '../components/DragToPan';
import { resolveTagColor, getPlotlineHSL, contrastTextColor } from '../settings';
import { attachTooltip } from '../components/Tooltip';
import { compareScenesByActChapter, getActDisplayLabel } from '../utils/actChapter';
import { t } from '../utils/i18n';
import { ProjectBoundItemView } from './ProjectBoundItemView';

type SortMode = 'alpha' | 'scenes-desc' | 'scenes-asc' | 'reading-order';
type PlotlineViewMode = 'list' | 'subway';

/**
 * Corkboard sticky notes are stored as Scene objects with `corkboardNote: true`.
 * They are layout/brainstorming aids, not story scenes, so the plotline view
 * excludes them from grouping and the "Unassigned" bucket.
 */

/**
 * Plotlines View — shows scenes grouped by plotline tags.
 * Each plotline can be renamed, deleted, and scenes can be
 * assigned or removed via click menus.
 */
export class StorylineView extends ProjectBoundItemView {
    private plugin: SceneCardsPlugin;
    private sceneManager: SceneManager;
    private rootContainer: HTMLElement | null = null;
    private _pendingRefresh: number | null = null;
    private sortMode: SortMode = 'reading-order';
    private plotlineViewMode: PlotlineViewMode = 'subway';
    /** Set of plotline tag names that are hidden in the subway view */
    private hiddenPlotlines: Set<string> = new Set();
    /** Whether subway scene nodes show plotline pills under the title. */
    private showSubwayTagPills = true;

    constructor(leaf: WorkspaceLeaf, plugin: SceneCardsPlugin, sceneManager: SceneManager) {
        super(leaf);
        this.plugin = plugin;
        this.sceneManager = sceneManager;
        this.ensureProjectBinding(sceneManager.activeProject?.filePath);
        // Restore last used Storyline view state
        const s = plugin.settings;
        this.plotlineViewMode = s.lastStorylineViewMode || 'subway';
        this.sortMode = s.lastStorylineSortMode || 'reading-order';
        this.showSubwayTagPills = s.lastStorylineShowTagPills !== false;
    }

    getViewType(): string {
        return STORYLINE_VIEW_TYPE;
    }

    getDisplayText(): string {
        const title = this.resolveProjectTitle(this.sceneManager.getProjects(), this.sceneManager.activeProject);
        return title || 'NarrativeLab';
    }

    getIcon(): string {
        return 'git-branch';
    }

    async onOpen(): Promise<void> {
        this.captureProjectBinding(this.sceneManager);
        this.plugin.storyLeaf = this.leaf;
        const container = this.containerEl.children[1] as HTMLElement;
        container.empty();
        container.addClass('story-line-storyline-container');
        applyMobileClass(container);
        this.rootContainer = container;

        await this.sceneManager.ensureInitialized();
        if (this.rootContainer !== container || !container.isConnected) return;
        this.renderView(container);
    }

    async onClose(): Promise<void> {
        if (this._pendingRefresh != null) {
            window.cancelAnimationFrame(this._pendingRefresh);
            this._pendingRefresh = null;
        }
        this.rootContainer = null;
    }

    /** Update sort mode, persist, and refresh. */
    private setSortMode(mode: SortMode): void {
        if (this.sortMode === mode) return;
        this.sortMode = mode;
        this.plugin.settings.lastStorylineSortMode = mode;
        this.plugin.saveSettings();
        this.refresh();
    }

    /** Update plotline view mode (list/subway), persist, and refresh. */
    private setViewMode(mode: PlotlineViewMode): void {
        if (this.plotlineViewMode === mode) return;
        this.plotlineViewMode = mode;
        rememberStructureMode(this.plugin, mode === 'list' ? 'plot-list' : 'subway');
        this.refresh();
    }

    private renderView(container: HTMLElement): void {
        container.empty();

        // Toolbar
        const toolbar = container.createDiv('story-line-toolbar');
        const titleRow = toolbar.createDiv('story-line-title-row');
        titleRow.createEl('h3', { cls: 'story-line-view-title', text: this.plugin.getProjectDisplayName(this.getBoundProjectFile()) });
        // project name shown in top-center only; no inline project selector here

        // View switcher tabs
        renderViewSwitcher(toolbar, STORYLINE_VIEW_TYPE, this.plugin, this.leaf);

        // Controls row
        const controls = toolbar.createDiv('story-line-toolbar-controls');

        renderStructureModeSwitcher(
            controls,
            this.plotlineViewMode === 'list' ? 'plot-list' : 'subway',
            this.plugin,
            this.leaf,
            {
                onPlotList: () => this.setViewMode('list'),
                onSubway: () => this.setViewMode('subway'),
            },
        );

        // Sort button
        const sortBtn = controls.createEl('button', {
            cls: 'clickable-icon',
        });
        const sortIconSpan = sortBtn.createSpan();
        obsidian.setIcon(sortIconSpan, 'arrow-down-up');
        attachTooltip(sortBtn, t('Sort plotlines'));
        sortBtn.addEventListener('click', (e) => {
            const menu = new Menu();
            menu.addItem((item: MenuItem) => {
                item.setTitle(`${this.sortMode === 'alpha' ? '✓ ' : ''}${t('Alphabetical')}`)
                    .onClick(() => { this.setSortMode('alpha'); });
            });
            menu.addItem((item: MenuItem) => {
                item.setTitle(`${this.sortMode === 'scenes-desc' ? '✓ ' : ''}${t('Most scenes first')}`)
                    .onClick(() => { this.setSortMode('scenes-desc'); });
            });
            menu.addItem((item: MenuItem) => {
                item.setTitle(`${this.sortMode === 'scenes-asc' ? '✓ ' : ''}${t('Fewest scenes first')}`)
                    .onClick(() => { this.setSortMode('scenes-asc'); });
            });
            menu.addItem((item: MenuItem) => {
                item.setTitle(`${this.sortMode === 'reading-order' ? '✓ ' : ''}${t('Reading order (chapter #)')}`)
                    .onClick(() => { this.setSortMode('reading-order'); });
            });
            menu.showAtPosition({ x: e.clientX, y: e.clientY });
        });

        // New plotline button
        const addPlotlineBtn = controls.createEl('button', {
            cls: 'mod-cta story-line-add-btn',
            text: t('+ New Plotline')
        });
        addPlotlineBtn.addEventListener('click', () => this.openNewPlotlineModal());

        // Plotline filter button (show/hide individual plotlines)
        if (this.plotlineViewMode === 'subway') {
            const filterBtn = controls.createEl('button', {
                cls: `clickable-icon${this.hiddenPlotlines.size > 0 ? ' is-active' : ''}`,
            });
            const filterIcon = filterBtn.createSpan();
            obsidian.setIcon(filterIcon, 'filter');
            attachTooltip(filterBtn, this.hiddenPlotlines.size > 0
                ? t('Filtering: {n} hidden', { n: this.hiddenPlotlines.size })
                : t('Filter plotlines'));
            filterBtn.addEventListener('click', (e) => {
                const allTags = this.sceneManager.getPlotlines();
                const menu = new Menu();
                // Show All / Hide All
                menu.addItem((item: MenuItem) => {
                    item.setTitle(t('Show all'))
                        .setIcon('eye')
                        .onClick(() => {
                            this.hiddenPlotlines.clear();
                            this.refresh();
                        });
                });
                menu.addSeparator();
                for (const tag of allTags) {
                    const isHidden = this.hiddenPlotlines.has(tag);
                    menu.addItem((item: MenuItem) => {
                        item.setTitle(`${isHidden ? '   ' : '✓ '}${this.formatPlotlineName(tag)}`)
                            .onClick(() => {
                                if (isHidden) {
                                    this.hiddenPlotlines.delete(tag);
                                } else {
                                    this.hiddenPlotlines.add(tag);
                                }
                                this.refresh();
                            });
                    });
                }
                menu.showAtPosition({ x: e.clientX, y: e.clientY });
            });

            const tagToggle = controls.createEl('button', {
                cls: `clickable-icon${this.showSubwayTagPills ? ' is-active' : ''}`,
            });
            const tagIcon = tagToggle.createSpan();
            obsidian.setIcon(tagIcon, 'tags');
            attachTooltip(tagToggle, this.showSubwayTagPills ? t('Hide scene tags') : t('Show scene tags'));
            tagToggle.addEventListener('click', () => {
                this.showSubwayTagPills = !this.showSubwayTagPills;
                this.plugin.settings.lastStorylineShowTagPills = this.showSubwayTagPills;
                this.plugin.saveSettings();
                this.refresh();
            });
        }

        // Refresh button
        const refreshBtn = controls.createEl('button', {
            cls: 'clickable-icon',
        });
        const refreshIcon = refreshBtn.createSpan();
        obsidian.setIcon(refreshIcon, 'refresh-cw');
        attachTooltip(refreshBtn, t('Refresh plotlines'));
        refreshBtn.addEventListener('click', () => {
            this.refresh();
        });

        const content = container.createDiv('story-line-storyline-content');

        const allScenes = this.sceneManager.queryService.getFilteredScenes(
            {},
            { field: 'sequence', direction: 'asc' }
        );
        // Corkboard sticky notes are not story scenes — exclude them from
        // plotline grouping and the "Unassigned" bucket so they don't pollute
        // the plotline view or steal sequence slots in the display.
        const scenes = allScenes.filter(s => !this.isCorkboardNoteScene(s));

        // Group scenes by plotline tags
        const plotlines = this.groupByPlotline(scenes);

        if (plotlines.size === 0 && scenes.length === 0) {
            content.createDiv({
                cls: 'story-line-empty',
                text: t('No scenes found. Create scenes first, then create plotlines to organize them.')
            });
            return;
        }

        // Sort plotline keys
        let plotlineKeys = Array.from(plotlines.keys());
        if (this.sortMode === 'alpha') {
            plotlineKeys.sort();
        } else if (this.sortMode === 'scenes-desc') {
            plotlineKeys.sort((a, b) => (plotlines.get(b)?.length || 0) - (plotlines.get(a)?.length || 0));
        } else if (this.sortMode === 'scenes-asc') {
            plotlineKeys.sort((a, b) => (plotlines.get(a)?.length || 0) - (plotlines.get(b)?.length || 0));
        } else if (this.sortMode === 'reading-order') {
            plotlineKeys.sort((a, b) => {
                const aScenes = plotlines.get(a) || [];
                const bScenes = plotlines.get(b) || [];
                const aChap = aScenes.length > 0 ? Math.min(...aScenes.map(s => Number(s.chapter ?? s.sequence ?? Infinity))) : Infinity;
                const bChap = bScenes.length > 0 ? Math.min(...bScenes.map(s => Number(s.chapter ?? s.sequence ?? Infinity))) : Infinity;
                return aChap - bChap;
            });
        }

        if (this.plotlineViewMode === 'subway') {
            // Apply plotline visibility filter in subway mode
            const visibleKeys = plotlineKeys.filter(k => !this.hiddenPlotlines.has(k));
            this.renderSubwayMap(content, scenes, plotlines, visibleKeys);
        } else {
            this.renderListView(content, scenes, plotlines, plotlineKeys);
        }
    }

    // ═══════════════════════════════════════════════════════
    //  LIST VIEW (original)
    // ═══════════════════════════════════════════════════════

    private renderListView(
        content: HTMLElement,
        scenes: Scene[],
        plotlines: Map<string, Scene[]>,
        plotlineKeys: string[],
    ): void {
        // Help text
        if (plotlineKeys.length > 0) {
            const helpText = content.createDiv('storyline-help');
            const helpSpan = helpText.createSpan({ cls: 'storyline-help-text' });
            helpSpan.appendText('A plotline groups scenes that share a story thread — e.g. "main mystery" or "love story". Hover a plotline header for ');
            const penIcon = helpSpan.createSpan({ cls: 'storyline-help-icon' });
            obsidian.setIcon(penIcon, 'pencil');
            helpSpan.appendText(' rename, ');
            const plusIcon = helpSpan.createSpan({ cls: 'storyline-help-icon' });
            obsidian.setIcon(plusIcon, 'plus');
            helpSpan.appendText(' add scenes, or ');
            const trashIcon = helpSpan.createSpan({ cls: 'storyline-help-icon' });
            obsidian.setIcon(trashIcon, 'trash-2');
            helpSpan.appendText(' delete. Click any scene to assign/remove it from plotlines.');
        }

        // Render each plotline
        for (const plotline of plotlineKeys) {
            const plotScenes = plotlines.get(plotline) || [];
            this.renderPlotline(content, plotline, plotScenes, scenes);
        }

        // Unassigned scenes
        const unassigned = scenes.filter(s => !s.tags || s.tags.length === 0);
        if (unassigned.length > 0) {
            const unassignedSection = content.createDiv('storyline-orphaned');
            const header = unassignedSection.createDiv('storyline-header storyline-unassigned-header');
            header.createSpan({
                cls: 'storyline-unassigned-label',
                text: t('Unassigned ({n} scenes)', { n: unassigned.length })
            });
            header.createSpan({
                cls: 'storyline-unassigned-hint',
                text: t('— click a scene to assign it to a plotline')
            });

            const nodeRow = unassignedSection.createDiv('storyline-nodes');
            unassigned.forEach(scene => {
                this.renderSceneNode(nodeRow, scene, plotlineKeys);
            });
        }

        // If no plotlines exist but scenes do, show getting-started hint
        if (plotlineKeys.length === 0 && scenes.length > 0) {
            const hint = content.createDiv('storyline-getting-started');
            hint.createEl('h4', { text: t('What are plotlines?') });
            hint.createEl('p', {
                text: t('A plotline is a story thread that runs through your scenes. For example: "main mystery", "love story", "character arc — Flora".')
            });
            hint.createEl('h4', { text: t('How to get started') });
            const steps = hint.createEl('ol');
            steps.createEl('li', { text: t('Click "+ New Plotline" above') });
            steps.createEl('li', { text: t('Give it a name (e.g. "main mystery")') });
            steps.createEl('li', { text: t('Select which scenes belong to it') });
            hint.createEl('p', {
                cls: 'storyline-help-text',
                text: t('You can assign a scene to multiple plotlines. This helps you see how each thread weaves through your story.')
            });
        }
    }

    // ═══════════════════════════════════════════════════════
    //  SUBWAY MAP VIEW
    // ═══════════════════════════════════════════════════════

    private renderSubwayMap(
        content: HTMLElement,
        scenes: Scene[],
        plotlines: Map<string, Scene[]>,
        plotlineKeys: string[],
    ): void {
        if (plotlineKeys.length === 0) {
            this.renderListView(content, scenes, plotlines, plotlineKeys);
            return;
        }

        const tagColors = this.plugin.settings.tagColors || {};
        const scheme = this.plugin.settings.colorScheme;

        // ── Layout constants ──
        const NODE_RADIUS = 10;
        const LINE_WIDTH = 8;
        const LABEL_LEFT = 14;
        const TRACK_LEFT = 160;
        const SCENE_SPACING = 220;
        const TOP_MARGIN = 55;

        // Each lane needs room for: the track line + scene label + tag pills below it
        const LANE_TRACK = 30;         // space for the line itself
        const LANE_INFO = this.showSubwayTagPills ? 65 : 36;          // space for scene title + optional tag pills below node
        const LANE_HEIGHT = LANE_TRACK + LANE_INFO;  // total per lane

        // ── Build ordered scene columns ──
        const allTaggedScenes = scenes.filter(s => s.tags && s.tags.length > 0);
        const orderedScenes: Scene[] = [];
        const seenPaths = new Set<string>();
        for (const s of allTaggedScenes) {
            if (!seenPaths.has(s.filePath)) {
                seenPaths.add(s.filePath);
                orderedScenes.push(s);
            }
        }
        // Sort by act → chapter → sequence so e.g. "01-01-02" comes before "01-02-01".
        // Sorting by sequence alone caused chapter nesting to be ignored (issue #96).
        orderedScenes.sort((a, b) => compareScenesByActChapter(a, b, (x, y) => (x.sequence ?? 0) - (y.sequence ?? 0)));

        if (orderedScenes.length === 0) {
            this.renderListView(content, scenes, plotlines, plotlineKeys);
            return;
        }

        const colOf = new Map<string, number>();
        orderedScenes.forEach((s, i) => colOf.set(s.filePath, i));

        const numCols = orderedScenes.length;
        const numLanes = plotlineKeys.length;

        const hslAdj = getPlotlineHSL(this.plugin.settings);
        const laneColor = (idx: number, plotline: string): string =>
            resolveTagColor(plotline, idx, scheme, tagColors, hslAdj);

        // ── SVG dimensions ──
        const svgWidth = TRACK_LEFT + numCols * SCENE_SPACING + 60;
        const trackBottom = TOP_MARGIN + numLanes * LANE_HEIGHT;
        const svgHeight = trackBottom + 30;

        const wrapper = content.createDiv('subway-map-wrapper');
        wrapper.setCssStyles({
            overflowX: 'auto',
            overflowY: 'auto',
            padding: '12px 0',
            position: 'relative',
        });

        // Enable drag-to-pan
        enableDragToPan(wrapper);

        // ── Sticky label column (stays visible when scrolling right) ──
        const labelCol = wrapper.createDiv('subway-label-col');
        labelCol.setCssStyles({
            position: 'sticky',
            left: '0',
            width: `${TRACK_LEFT}px`,
            height: `${svgHeight}px`,
            zIndex: '2',
            pointerEvents: 'none',
            background: 'var(--background-primary)',
            flexShrink: '0',
        });

        const svgNS = 'http://www.w3.org/2000/svg';
        const svg = activeDocument.createElementNS(svgNS, 'svg');
        svg.setAttribute('width', String(svgWidth));
        svg.setAttribute('height', String(svgHeight));
        svg.setAttribute('viewBox', `0 0 ${svgWidth} ${svgHeight}`);
        svg.setCssStyles({ minWidth: `${svgWidth}px` });
        // Pull SVG up so it overlaps the label column
        svg.setCssStyles({ marginTop: `-${svgHeight}px` });
        wrapper.appendChild(svg);

        const colX = (col: number) => TRACK_LEFT + col * SCENE_SPACING + SCENE_SPACING / 2;
        // Track Y sits in the upper portion of the lane
        const laneY = (lane: number) => TOP_MARGIN + lane * LANE_HEIGHT + LANE_TRACK / 2;

        // ── Build plotline → columns map ──
        const plotlineCols = new Map<string, number[]>();
        for (const pk of plotlineKeys) {
            const pScenes = plotlines.get(pk) || [];
            const cols = pScenes
                .map(s => colOf.get(s.filePath))
                .filter((c): c is number => c !== undefined)
                .sort((a, b) => a - b);
            plotlineCols.set(pk, cols);
        }

        // Which lanes are active at each column
        const sceneToLanes = new Map<number, number[]>();
        for (let li = 0; li < plotlineKeys.length; li++) {
            const plotlineKey = plotlineKeys[li];
            if (plotlineKey === undefined) continue;
            const cols = plotlineCols.get(plotlineKey) || [];
            for (const col of cols) {
                if (!sceneToLanes.has(col)) sceneToLanes.set(col, []);
                sceneToLanes.get(col)!.push(li);
            }
        }

        // ── Act dividers ──
        const acts = new Map<number, number[]>();
        orderedScenes.forEach((s, col) => {
            const act = Number(s.act) || 0;
            if (!acts.has(act)) acts.set(act, []);
            acts.get(act)!.push(col);
        });

        const actEntries = [...acts.entries()].sort((a, b) => a[0] - b[0]);
        for (let ai = 0; ai < actEntries.length; ai++) {
            const entry = actEntries[ai];
            if (!entry) continue;
            const [actNum, cols] = entry;
            const minCol = Math.min(...cols);
            const maxCol = Math.max(...cols);

            // Act label
            const centerX = (colX(minCol) + colX(maxCol)) / 2;
            const actLabel = activeDocument.createElementNS(svgNS, 'text');
            actLabel.setAttribute('x', String(centerX));
            actLabel.setAttribute('y', String(TOP_MARGIN - 20));
            actLabel.setAttribute('text-anchor', 'middle');
            actLabel.setAttribute('font-size', '16');
            actLabel.setAttribute('font-weight', '700');
            actLabel.setAttribute('fill', 'var(--text-muted)');
            actLabel.textContent = t(getActDisplayLabel(actNum)).toUpperCase();
            svg.appendChild(actLabel);

            // Vertical divider line before this act group (clear, visible)
            if (ai > 0) {
                const divX = colX(minCol) - SCENE_SPACING / 2;
                const line = activeDocument.createElementNS(svgNS, 'line');
                line.setAttribute('x1', String(divX));
                line.setAttribute('y1', String(TOP_MARGIN - 10));
                line.setAttribute('x2', String(divX));
                line.setAttribute('y2', String(trackBottom));
                line.setAttribute('stroke', 'var(--text-faint)');
                line.setAttribute('stroke-width', '2');
                line.setAttribute('stroke-dasharray', '8,6');
                svg.appendChild(line);
            }
        }

        // ── Draw track lines ──
        // Each plotline starts at its FIRST scene node and ends at its LAST scene node
        for (let li = 0; li < plotlineKeys.length; li++) {
            const pk = plotlineKeys[li];
            if (pk === undefined) continue;
            const color = laneColor(li, pk);
            const cols = plotlineCols.get(pk) || [];
            const y = laneY(li);

            // Plotline label in the sticky HTML column
            const lblDiv = labelCol.createDiv('subway-lane-label');
            lblDiv.setCssStyles({
                position: 'absolute',
                left: `${LABEL_LEFT}px`,
                top: `${y - 8}px`,
                fontSize: '15px',
                fontWeight: '700',
                color: color,
                whiteSpace: 'nowrap',
                fontFamily: 'var(--font-interface)',
                cursor: 'context-menu',
            });
            lblDiv.textContent = this.formatPlotlineName(pk);
            lblDiv.addEventListener('contextmenu', (e) => {
                this.showPlotlineContextMenu(e, pk, (plotlines.get(pk) || []).length, scenes);
            });

            if (cols.length === 0) continue;

            // Track runs from first node to last node (with short lead-in curve + trail)
            const firstCol = cols[0];
            const lastCol = cols.at(-1);
            if (firstCol === undefined || lastCol === undefined) continue;
            const firstX = colX(firstCol);
            const lastX = colX(lastCol);
            const leadIn = 30; // small rounded approach before first node
            const trailOut = 30; // small trail after last node

            const path = activeDocument.createElementNS(svgNS, 'path');
            path.setAttribute('d', `M ${firstX - leadIn} ${y} L ${lastX + trailOut} ${y}`);
            path.setAttribute('stroke', color);
            path.setAttribute('stroke-width', String(LINE_WIDTH));
            path.setAttribute('fill', 'none');
            path.setAttribute('stroke-linecap', 'round');
            path.setAttribute('opacity', '0.9');
            svg.appendChild(path);
        }

        // ── Shared-scene connectors ──
        for (const [col, lanes] of sceneToLanes) {
            if (lanes.length <= 1) continue;
            const x = colX(col);
            const sortedLanes = [...lanes].sort((a, b) => a - b);
            const firstLane = sortedLanes[0];
            const lastLane = sortedLanes.at(-1);
            if (firstLane === undefined || lastLane === undefined) continue;
            const topY = laneY(firstLane) - NODE_RADIUS;
            const botY = laneY(lastLane) + NODE_RADIUS;

            // Gradient connector
            const gradId = `conn-grad-${col}`;
            const defs = svg.querySelector('defs') || (() => {
                const d = activeDocument.createElementNS(svgNS, 'defs');
                svg.insertBefore(d, svg.firstChild);
                return d;
            })();
            const grad = activeDocument.createElementNS(svgNS, 'linearGradient');
            grad.setAttribute('id', gradId);
            grad.setAttribute('x1', '0'); grad.setAttribute('y1', '0');
            grad.setAttribute('x2', '0'); grad.setAttribute('y2', '1');
            // One gradient stop per lane, positioned proportionally to its Y
            // so middle lanes contribute their color instead of being skipped.
            const span = botY - topY || 1;
            for (const lane of sortedLanes) {
                const stop = activeDocument.createElementNS(svgNS, 'stop');
                const offset = (laneY(lane) - topY) / span;
                stop.setAttribute('offset', `${(offset * 100).toFixed(1)}%`);
                stop.setAttribute('stop-color', laneColor(lane, plotlineKeys[lane] ?? ''));
                grad.appendChild(stop);
            }
            defs.appendChild(grad);

            const connector = activeDocument.createElementNS(svgNS, 'rect');
            connector.setAttribute('x', String(x - 3));
            connector.setAttribute('y', String(topY));
            connector.setAttribute('width', '6');
            connector.setAttribute('height', String(botY - topY));
            connector.setAttribute('rx', '3');
            connector.setAttribute('fill', `url(#${gradId})`);
            connector.setAttribute('opacity', '0.55');
            svg.appendChild(connector);
        }

        // ── Draw nodes + inline scene labels + tag pills ──
        // For each node, render the circle, and BELOW it on the same lane,
        // show the scene title + tag pills (like the reference subway map)
        for (let li = 0; li < plotlineKeys.length; li++) {
            const pk = plotlineKeys[li];
            if (pk === undefined) continue;
            const color = laneColor(li, pk);
            const cols = plotlineCols.get(pk) || [];
            const y = laneY(li);

            for (const col of cols) {
                const x = colX(col);
                const scene = orderedScenes[col];
                if (!scene) continue;

                // Node shape: diamond for Arc Points, circle for regular scenes
                const isArcPoint = !!scene.arcAnchor;
                let nodeEl: SVGElement;
                if (isArcPoint) {
                    // Diamond shape for Arc Points
                    const d = NODE_RADIUS * 1.3; // slightly larger to match visual weight
                    const diamond = activeDocument.createElementNS(svgNS, 'polygon');
                    diamond.setAttribute('points', `${x},${y - d} ${x + d},${y} ${x},${y + d} ${x - d},${y}`);
                    diamond.setAttribute('fill', color);
                    diamond.setAttribute('stroke', color);
                    diamond.setAttribute('stroke-width', '2');
                    diamond.setAttribute('opacity', '0.9');
                    diamond.setCssStyles({ cursor: 'pointer' });
                    svg.appendChild(diamond);
                    nodeEl = diamond;
                } else {
                    // Circle node for regular scenes
                    const circle = activeDocument.createElementNS(svgNS, 'circle');
                    circle.setAttribute('cx', String(x));
                    circle.setAttribute('cy', String(y));
                    circle.setAttribute('r', String(NODE_RADIUS));
                    circle.setAttribute('fill', 'var(--background-primary)');
                    circle.setAttribute('stroke', color);
                    circle.setAttribute('stroke-width', '3.5');
                    circle.setCssStyles({ cursor: 'pointer' });
                    svg.appendChild(circle);
                    nodeEl = circle;
                }

                nodeEl.addEventListener('click', (e) => {
                    e.stopPropagation();
                    this.openScene(scene);
                });

                // Tooltip
                const titleEl = activeDocument.createElementNS(svgNS, 'title');
                const actStr = scene.act !== undefined ? String(scene.act).padStart(2, '0') : '??';
                const seqStr = scene.sequence !== undefined ? String(scene.sequence).padStart(2, '0') : '??';
                titleEl.textContent = this.buildSubwayTooltip(scene, isArcPoint, actStr, seqStr);
                nodeEl.appendChild(titleEl);

                // Story time above node (small)
                const timeStr = scene.storyTime || scene.storyDate || '';
                if (timeStr) {
                    const timeLabel = activeDocument.createElementNS(svgNS, 'text');
                    timeLabel.setAttribute('x', String(x));
                    timeLabel.setAttribute('y', String(y - NODE_RADIUS - 6));
                    timeLabel.setAttribute('text-anchor', 'middle');
                    timeLabel.setAttribute('font-size', '9');
                    timeLabel.setAttribute('fill', 'var(--text-faint)');
                    timeLabel.textContent = timeStr;
                    svg.appendChild(timeLabel);
                }

                // ── Scene title below node ──
                const labelY1 = y + NODE_RADIUS + 16;
                const labelText = `[${actStr}-${seqStr}] ${scene.title || t('Untitled')}`;

                const sceneLabel = activeDocument.createElementNS(svgNS, 'text');
                sceneLabel.setAttribute('x', String(x));
                sceneLabel.setAttribute('y', String(labelY1));
                sceneLabel.setAttribute('text-anchor', 'middle');
                sceneLabel.setAttribute('font-size', '11');
                sceneLabel.setAttribute('font-weight', '600');
                sceneLabel.setAttribute('fill', 'var(--text-normal)');
                sceneLabel.setCssStyles({ cursor: 'pointer' });
                sceneLabel.textContent = labelText;
                sceneLabel.addEventListener('click', () => this.openScene(scene));
                svg.appendChild(sceneLabel);

                // ── Tag pills below scene title ──
                if (this.showSubwayTagPills && scene.tags?.length) {
                    const pillY = labelY1 + 14;
                    const pillSpacing = 3;
                    const pillData = scene.tags.map(tag => ({
                        tag,
                        width: tag.length * 6 + 12,
                    }));
                    const totalWidth = pillData.reduce((s, p) => s + p.width + pillSpacing, -pillSpacing);
                    let px = x - totalWidth / 2;

                    for (const { tag, width } of pillData) {
                        const pillIdx = plotlineKeys.indexOf(tag);
                        const pillColor = resolveTagColor(tag, Math.max(0, pillIdx), scheme, tagColors, hslAdj);
                        const rect = activeDocument.createElementNS(svgNS, 'rect');
                        rect.setAttribute('x', String(px));
                        rect.setAttribute('y', String(pillY - 8));
                        rect.setAttribute('width', String(width));
                        rect.setAttribute('height', '15');
                        rect.setAttribute('rx', '7');
                        rect.setAttribute('fill', pillColor);
                        svg.appendChild(rect);

                        const text = activeDocument.createElementNS(svgNS, 'text');
                        text.setAttribute('x', String(px + width / 2));
                        text.setAttribute('y', String(pillY + 3));
                        text.setAttribute('text-anchor', 'middle');
                        text.setAttribute('font-size', '9');
                        text.setAttribute('fill', contrastTextColor(pillColor));
                        text.textContent = tag;
                        svg.appendChild(text);

                        px += width + pillSpacing;
                    }
                }
            }
        }
    }

    private buildSubwayTooltip(scene: Scene, isArcPoint: boolean, actStr: string, seqStr: string): string {
        const lines: string[] = [`[${actStr}-${seqStr}] ${scene.title || t('Untitled')}`];
        if (scene.subtitle?.trim()) lines.push(scene.subtitle.trim());
        if (scene.synopsis?.trim()) lines.push(`Synopsis: ${this.compactTooltipText(scene.synopsis, 220)}`);
        if (isArcPoint) lines.push('Arc Point');
        lines.push(`Plotlines: ${(scene.tags && scene.tags.length > 0) ? scene.tags.join(', ') : 'none'}`);
        if (scene.storyDate) lines.push(`Date: ${scene.storyDate}`);
        if (scene.storyTime) lines.push(`Time: ${scene.storyTime}`);
        lines.push('Click to open');
        return lines.join('\n');
    }

    private compactTooltipText(text: string, maxLength: number): string {
        const singleLine = text.replace(/\s+/g, ' ').trim();
        if (singleLine.length <= maxLength) return singleLine;
        return singleLine.slice(0, Math.max(0, maxLength - 1)).trimEnd() + '…';
    }

    private renderPlotline(
        container: HTMLElement,
        plotline: string,
        scenes: Scene[],
        allScenes: Scene[]
    ): void {
        const section = container.createDiv('storyline-section');
        const tagColors = this.plugin.settings.tagColors || {};
        const scheme = this.plugin.settings.colorScheme;
        const plotlineIdx = this.sceneManager.getPlotlines().indexOf(plotline);
        const plotlineColor = resolveTagColor(plotline, Math.max(0, plotlineIdx), scheme, tagColors, getPlotlineHSL(this.plugin.settings));

        // Collapsible header
        const header = section.createDiv('storyline-header');
        if (plotlineColor) {
            header.setCssStyles({ borderLeftColor: plotlineColor });
        }
        const toggle = header.createSpan({ cls: 'storyline-toggle', text: '▼ ' });
        header.createSpan({
            cls: 'storyline-plotline-title',
            text: `${this.formatPlotlineName(plotline)} (${scenes.length})`
        });

        // Header action buttons (right side)
        const actions = header.createDiv('storyline-header-actions');

        // Color picker button
        const colorBtn = actions.createEl('button', {
            cls: 'clickable-icon storyline-action-btn',
            attr: { 'aria-label': t('Change plotline color'), title: t('Change color') }
        });
        const colorIcon = colorBtn.createSpan();
        obsidian.setIcon(colorIcon, 'palette');
        // Hidden native color input
        const colorInput = colorBtn.createEl('input', { type: 'color' }) as HTMLInputElement;
        colorInput.setCssStyles({
            position: 'absolute',
            width: '0',
            height: '0',
            opacity: '0',
            overflow: 'hidden',
        });
        colorInput.value = plotlineColor || '#888888';
        colorBtn.addEventListener('click', (e) => {
            e.stopPropagation();
            colorInput.click();
        });
        colorInput.addEventListener('input', async (e) => {
            const newColor = (e.target as HTMLInputElement).value;
            if (!this.plugin.settings.tagColors) this.plugin.settings.tagColors = {};
            this.plugin.settings.tagColors[plotline] = newColor;
            await this.plugin.saveSettings();
            this.plugin.refreshOpenViews();
        });

        // Rename button
        const renameBtn = actions.createEl('button', {
            cls: 'clickable-icon storyline-action-btn',
            attr: { 'aria-label': t('Rename plotline'), title: t('Rename') }
        });
        const renameIcon = renameBtn.createSpan();
        obsidian.setIcon(renameIcon, 'pencil');
        renameBtn.addEventListener('click', (e) => {
            e.stopPropagation();
            this.openRenamePlotlineModal(plotline);
        });

        // Add scenes button
        const addToPlotBtn = actions.createEl('button', {
            cls: 'clickable-icon storyline-action-btn',
            attr: { 'aria-label': t('Add scenes to this plotline'), title: t('Add scenes') }
        });
        const addIcon = addToPlotBtn.createSpan();
        obsidian.setIcon(addIcon, 'plus');
        addToPlotBtn.addEventListener('click', (e) => {
            e.stopPropagation();
            this.openAddSceneToPlotlineModal(plotline, scenes, allScenes);
        });

        // Delete button
        const deleteBtn = actions.createEl('button', {
            cls: 'clickable-icon storyline-action-btn storyline-delete-btn',
            attr: { 'aria-label': t('Delete plotline'), title: t('Delete') }
        });
        const deleteIcon = deleteBtn.createSpan();
        obsidian.setIcon(deleteIcon, 'trash-2');
        deleteBtn.addEventListener('click', (e) => {
            e.stopPropagation();
            this.confirmDeletePlotline(plotline, scenes.length);
        });

        // Right-click context menu
        header.addEventListener('contextmenu', (e) => {
            this.showPlotlineContextMenu(e, plotline, scenes.length, allScenes);
        });

        const body = section.createDiv('storyline-body');

        // Group scenes by act for visual flow
        const actGroups = new Map<string, Scene[]>();
        for (const scene of scenes) {
            const actKey = scene.act !== undefined ? getActDisplayLabel(scene.act) : 'No Act'; // key; display via t()
            if (!actGroups.has(actKey)) actGroups.set(actKey, []);
            actGroups.get(actKey)!.push(scene);
        }

        if (actGroups.size > 1 || (actGroups.size === 1 && !actGroups.has('No Act'))) {
            // Show scenes grouped by act with a visual flow
            for (const [actLabel, actScenes] of actGroups) {
                const actGroup = body.createDiv('plotline-act-group');
                actGroup.createSpan({ cls: 'plotline-act-label', text: actLabel });
                const flow = actGroup.createDiv('storyline-flow');
                actScenes.forEach((scene, idx) => {
                    this.renderSceneNode(flow, scene, [plotline]);
                    if (idx < actScenes.length - 1) {
                        flow.createSpan({ cls: 'storyline-arrow', text: '→' });
                    }
                });
            }
        } else {
            // Simple flow when no acts
            const flow = body.createDiv('storyline-flow');
            scenes.forEach((scene, idx) => {
                this.renderSceneNode(flow, scene, [plotline]);
                if (idx < scenes.length - 1) {
                    flow.createSpan({ cls: 'storyline-arrow', text: '→' });
                }
            });
        }

        // Coverage summary
        const totalScenes = allScenes.length;
        const pct = totalScenes > 0 ? Math.round((scenes.length / totalScenes) * 100) : 0;
        const summary = body.createDiv('plotline-summary');
        summary.createSpan({
            cls: 'plotline-summary-text',
            text: t('{n} of {total} scenes ({pct}%)', { n: scenes.length, total: totalScenes, pct })
        });
        // Mini progress bar
        const bar = summary.createDiv('plotline-progress-bar');
        const fill = bar.createDiv('plotline-progress-fill');
        fill.setCssStyles({ width: `${pct}%` });
        if (plotlineColor) {
            fill.setCssStyles({ backgroundColor: plotlineColor });
        }

        // Toggle collapse
        let collapsed = false;
        header.addEventListener('click', () => {
            collapsed = !collapsed;
            body.setCssStyles({ display: collapsed ? 'none' : 'block' });
            toggle.textContent = collapsed ? '▶ ' : '▼ ';
        });
    }

    private renderSceneNode(
        container: HTMLElement,
        scene: Scene,
        _availablePlotlines: string[]
    ): void {
        const node = container.createDiv('storyline-node');
        const act = scene.act !== undefined ? String(scene.act).padStart(2, '0') : '??';
        const seq = scene.sequence !== undefined ? String(scene.sequence).padStart(2, '0') : '??';

        node.createSpan({
            cls: 'storyline-node-id',
            text: `[${act}-${seq}]`
        });
        node.createSpan({
            cls: 'storyline-node-title',
            text: ` ${scene.title || t('Untitled')}`
        });

        // Show existing tags as small badges
        if (scene.tags?.length) {
            const tagsEl = node.createDiv('storyline-node-tags');
            const tagColors = this.plugin.settings.tagColors || {};
            const scheme = this.plugin.settings.colorScheme;
            const allTagsSorted = this.sceneManager.getPlotlines();
            scene.tags.forEach(tag => {
                const badge = tagsEl.createSpan({ cls: 'storyline-tag-badge', text: tag });
                const badgeColor = resolveTagColor(tag, Math.max(0, allTagsSorted.indexOf(tag)), scheme, tagColors, getPlotlineHSL(this.plugin.settings));
                badge.setCssStyles({
                    backgroundColor: badgeColor,
                    color: contrastTextColor(badgeColor),
                });
            });
        }

        // Status indicator
        node.setAttribute('data-status', scene.status || 'idea');

        // Click to open tag assignment menu
        node.addEventListener('click', (e) => {
            e.stopPropagation();
            this.showTagAssignMenu(scene, node);
        });

        node.setAttribute('title', t('{title}\nTags: {tags}\nClick to assign/remove plotline', {
            title: scene.title || t('Untitled'),
            tags: scene.tags?.join(', ') || t('None'),
        }));
    }

    /**
     * Show a menu to assign/remove plotline tags from a scene
     */
    private showTagAssignMenu(scene: Scene, anchorEl: HTMLElement): void {
        const menu = new Menu();
        const allTags = this.sceneManager.getPlotlines();
        const sceneTags = new Set(scene.tags || []);

        if (allTags.length > 0) {
            for (const tag of allTags) {
                const hasTag = sceneTags.has(tag);
                menu.addItem((item: MenuItem) => {
                    item.setTitle(`${hasTag ? '✓ ' : '   '}${this.formatPlotlineName(tag)}`)
                        .onClick(async () => {
                            const newTags = hasTag
                                ? (scene.tags || []).filter((t: string) => t !== tag)
                                : [...(scene.tags || []), tag];
                            await this.sceneManager.updateScene(scene.filePath, { tags: newTags });
                            this.refresh();
                        });
                });
            }
            menu.addSeparator();
        }

        menu.addItem((item: MenuItem) => {
            item.setTitle(t('+ Create new plotline…'))
                .setIcon('plus')
                .onClick(() => this.openNewPlotlineForScene(scene));
        });

        const rect = anchorEl.getBoundingClientRect();
        menu.showAtPosition({ x: rect.left, y: rect.bottom });
    }

    // ── Rename ─────────────────────────────────────────────

    private openRenamePlotlineModal(plotline: string): void {
        const modal = new Modal(this.app);
        modal.titleEl.setText(t('Rename Plotline'));
        let newName = plotline;

        new Setting(modal.contentEl)
            .setName(t('Plotline name'))
            .setDesc(t('Current tag: "{tag}". The tag will be updated in all scenes that use it.', { tag: plotline }))
            .addText((text: TextComponent) => {
                text.setValue(plotline);
                text.onChange((v: string) => (newName = v));
            });

        new Setting(modal.contentEl)
            .addButton((btn: ButtonComponent) => {
                btn.setButtonText(t('Rename')).setCta().onClick(async () => {
                    const slug = newName.trim().toLowerCase().replace(/\s+/g, '-');
                    if (!slug || slug === plotline) {
                        modal.close();
                        return;
                    }
                    const count = await this.sceneManager.renamePlotline(plotline, slug);
                    new Notice(t('Renamed plotline in {count} scene(s)', { count }));
                    this.plugin.refreshOpenViews();
                    modal.close();
                });
            });
        modal.open();
    }

    // ── Delete ─────────────────────────────────────────────

    private showPlotlineContextMenu(
        e: MouseEvent,
        plotline: string,
        sceneCount: number,
        allScenes?: Scene[],
    ): void {
        e.preventDefault();
        e.stopPropagation();
        const menu = new Menu();
        const currentColor = this.plugin.settings.tagColors?.[plotline]
            || resolveTagColor(
                plotline,
                Math.max(0, this.sceneManager.getPlotlines().indexOf(plotline)),
                this.plugin.settings.colorScheme,
                this.plugin.settings.tagColors || {},
                getPlotlineHSL(this.plugin.settings),
            );

        const colorInput = activeDocument.body.createEl('input', { type: 'color' }) as HTMLInputElement;
        colorInput.value = currentColor || '#888888';
        colorInput.setCssStyles({
            position: 'fixed',
            left: '-9999px',
            width: '0',
            height: '0',
            opacity: '0',
            pointerEvents: 'none',
        });
        colorInput.addEventListener('input', async (ev) => {
            const newColor = (ev.target as HTMLInputElement).value;
            if (!this.plugin.settings.tagColors) this.plugin.settings.tagColors = {};
            this.plugin.settings.tagColors[plotline] = newColor;
            await this.plugin.saveSettings();
            this.plugin.refreshOpenViews();
            colorInput.remove();
        });
        colorInput.addEventListener('change', () => {
            window.setTimeout(() => colorInput.remove(), 0);
        });

        menu.addItem((item: MenuItem) => {
            item.setTitle(t('Change color'))
                .setIcon('palette')
                .onClick(() => colorInput.click());
        });
        if (this.plugin.settings.tagColors?.[plotline]) {
            menu.addItem((item: MenuItem) => {
                item.setTitle(t('Reset color'))
                    .setIcon('rotate-ccw')
                    .onClick(async () => {
                        delete this.plugin.settings.tagColors[plotline];
                        await this.plugin.saveSettings();
                        this.plugin.refreshOpenViews();
                    });
            });
        }
        menu.addItem((item: MenuItem) => {
            item.setTitle(t('Rename plotline'))
                .setIcon('pencil')
                .onClick(() => this.openRenamePlotlineModal(plotline));
        });
        if (allScenes) {
            const plotScenes = allScenes.filter(s => s.tags?.includes(plotline));
            menu.addItem((item: MenuItem) => {
                item.setTitle(t('Add scenes'))
                    .setIcon('plus')
                    .onClick(() => this.openAddSceneToPlotlineModal(plotline, plotScenes, allScenes));
            });
        }
        menu.addSeparator();
        menu.addItem((item: MenuItem) => {
            item.setTitle(t('Delete plotline'))
                .setIcon('trash-2')
                .onClick(() => this.confirmDeletePlotline(plotline, sceneCount));
        });
        menu.showAtMouseEvent(e);
    }

    private confirmDeletePlotline(plotline: string, sceneCount: number): void {
        const affected = Math.max(sceneCount, this.sceneManager.countScenesWithPlotline(plotline));
        const modal = new Modal(this.app);
        modal.titleEl.setText(t('Delete Plotline'));
        modal.contentEl.createEl('p', {
            text: t('Remove the tag "{tag}" from {count} scene(s)? The scenes themselves will not be deleted.', { tag: plotline, count: affected })
        });

        new Setting(modal.contentEl)
            .addButton((btn: ButtonComponent) => {
                btn.setButtonText(t('Cancel')).onClick(() => modal.close());
            })
            .addButton((btn: ButtonComponent) => {
                btn.setButtonText(t('Delete')).setClass('mod-warning').onClick(async () => {
                    const count = await this.sceneManager.deletePlotline(plotline);
                    this.hiddenPlotlines.delete(plotline);
                    new Notice(t('Removed plotline from {count} scene(s)', { count }));
                    this.plugin.refreshOpenViews();
                    modal.close();
                });
            });
        modal.open();
    }

    // ── Create new plotline for a scene ────────────────────

    /**
     * Normalize a plotline name into a tag slug.
     * Keeps CJK / letters / numbers / `_` / `-` / `/`; strips YAML/tag-breaking
     * chars like `?` `#` `[` which otherwise make Obsidian frontmatter throw
     * (e.g. typing "哦?" used to fail create with no useful explanation).
     */
    private toPlotlineSlug(raw: string): string {
        return raw
            .trim()
            .toLowerCase()
            .replace(/\s+/g, '-')
            .replace(/[#[\]|\\^?!,;:<>{}'"*`~@&%]+/g, '')
            .replace(/-+/g, '-')
            .replace(/^-|-$/g, '');
    }

    /** Read the plotline name from the modal input (avoids IME/onChange races). */
    private readPlotlineNameInput(modal: Modal, fallback: string): string {
        const input = modal.contentEl.querySelector(
            '.setting-item input[type="text"]',
        ) as HTMLInputElement | null;
        return (input?.value ?? fallback).trim();
    }

    private openNewPlotlineForScene(scene: Scene): void {
        const modal = new Modal(this.app);
        modal.titleEl.setText(t('New Plotline'));
        let tagName = '';

        new Setting(modal.contentEl)
            .setName(t('Plotline name'))
            .setDesc(t('Will be added to "{title}"', { title: scene.title || t('Untitled') }))
            .addText((text: TextComponent) => {
                text.setPlaceholder(t('e.g. main-mystery'));
                text.onChange((v: string) => (tagName = v));
            });

        new Setting(modal.contentEl)
            .addButton((btn: ButtonComponent) => {
                btn.setButtonText(t('Create & Assign')).setCta().onClick(async () => {
                    const raw = this.readPlotlineNameInput(modal, tagName);
                    const slug = this.toPlotlineSlug(raw);
                    if (!raw) {
                        new Notice(t('Please enter a plotline name.'));
                        return;
                    }
                    if (!slug) {
                        new Notice(t('Plotline name has no valid characters. Avoid ? # [ ] and similar symbols.'));
                        return;
                    }
                    const newTags = [...new Set([...(scene.tags || []), slug])];
                    btn.setDisabled(true);
                    try {
                        await this.sceneManager.updateSceneTags(scene.filePath, newTags);
                        modal.close();
                        this.refresh();
                        new Notice(t('Plotline created'));
                    } catch (err) {
                        console.error('[NarrativeLab] create plotline failed', err);
                        btn.setDisabled(false);
                        new Notice(t('Failed to create plotline: {err}', {
                            err: err instanceof Error ? err.message : String(err),
                        }));
                    }
                });
            });
        modal.open();
    }

    // ── Create new plotline (toolbar button) ───────────────

    private openNewPlotlineModal(): void {
        const modal = new Modal(this.app);
        modal.titleEl.setText(t('New Plotline'));
        let tagName = '';

        new Setting(modal.contentEl)
            .setName(t('Plotline name'))
            .setDesc(t('Enter a name for the plotline. It will be stored as a tag on each assigned scene.'))
            .addText((text: TextComponent) => {
                text.setPlaceholder(t('e.g. love-triangle'));
                text.onChange((v: string) => (tagName = v));
            });

        const scenePicker = modal.contentEl.createDiv('storyline-scene-picker');
        scenePicker.createEl('p', {
            cls: 'setting-item-description',
            text: t('Select scenes to include (optional):')
        });

        const scenes = this.sceneManager.queryService.getFilteredScenes(undefined, { field: 'sequence', direction: 'asc' })
            .filter(s => !this.isCorkboardNoteScene(s));
        const selectedPaths = new Set<string>();

        const sceneList = scenePicker.createDiv('storyline-scene-picker-list');
        scenes.forEach(scene => {
            const row = sceneList.createDiv('storyline-scene-picker-row');
            const cb = row.createEl('input', { type: 'checkbox' });
            const act = scene.act !== undefined && scene.act !== null && scene.act !== ''
                ? String(scene.act).padStart(2, '0')
                : '--';
            const seq = scene.sequence !== undefined
                ? String(scene.sequence).padStart(2, '0')
                : '--';
            row.createSpan({ text: `[${act}-${seq}] ${scene.title || t('Untitled')}` });
            cb.addEventListener('change', () => {
                if (cb.checked) selectedPaths.add(scene.filePath);
                else selectedPaths.delete(scene.filePath);
            });
        });

        new Setting(modal.contentEl)
            .addButton((btn: ButtonComponent) => {
                btn.setButtonText(t('Create Plotline')).setCta().onClick(async () => {
                    const raw = this.readPlotlineNameInput(modal, tagName);
                    const slug = this.toPlotlineSlug(raw);
                    if (!raw) {
                        new Notice(t('Please enter a plotline name.'));
                        return;
                    }
                    if (!slug) {
                        new Notice(t('Plotline name has no valid characters. Avoid ? # [ ] and similar symbols.'));
                        return;
                    }
                    const paths = [...selectedPaths];
                    btn.setDisabled(true);
                    try {
                        // Persist the plotline on the project even when no scenes
                        // are selected yet (same contract as Navigator creation).
                        const registered = await this.sceneManager.addPlotline(slug);
                        if (!registered && paths.length === 0) {
                            btn.setDisabled(false);
                            new Notice(t('A plotline with this name already exists.'));
                            return;
                        }

                        let assigned = 0;
                        const errors: string[] = [];
                        for (const path of paths) {
                            const scene = this.sceneManager.getScene(path);
                            if (!scene) continue;
                            const newTags = [...new Set([...(scene.tags || []), slug])];
                            try {
                                await this.sceneManager.updateSceneTags(path, newTags);
                                assigned++;
                            } catch (e) {
                                errors.push(path.split('/').pop() || path);
                                console.error('[NarrativeLab] updateSceneTags failed', path, e);
                            }
                        }
                        if (paths.length > 0 && assigned === 0) {
                            btn.setDisabled(false);
                            new Notice(t('Failed to create plotline: {err}', {
                                err: errors.join(', ') || t('Unknown error'),
                            }));
                            return;
                        }
                        modal.close();
                        this.refresh();
                        if (assigned > 0) {
                            new Notice(t('Plotline created on {count} scene(s)', { count: assigned }));
                        } else {
                            new Notice(t('Plotline name saved — assign scenes from the plotline menu.'));
                        }
                        if (errors.length > 0) {
                            new Notice(t('Some scenes failed: {list}', { list: errors.join(', ') }));
                        }
                    } catch (err) {
                        console.error('[NarrativeLab] create plotline failed', err);
                        btn.setDisabled(false);
                        new Notice(t('Failed to create plotline: {err}', {
                            err: err instanceof Error ? err.message : String(err),
                        }));
                    }
                });
            });
        modal.open();
    }

    // ── Add scenes to existing plotline ────────────────────

    private openAddSceneToPlotlineModal(
        plotline: string,
        currentScenes: Scene[],
        allScenes: Scene[]
    ): void {
        const modal = new Modal(this.app);
        modal.titleEl.setText(t('Add scenes to "{name}"', { name: this.formatPlotlineName(plotline) }));

        const currentPaths = new Set(currentScenes.map(s => s.filePath));
        const available = allScenes.filter(s => !currentPaths.has(s.filePath));
        const selectedPaths = new Set<string>();

        if (available.length === 0) {
            modal.contentEl.createEl('p', { text: t('All scenes are already in this plotline.') });
        } else {
            const sceneList = modal.contentEl.createDiv('storyline-scene-picker-list');
            available.forEach(scene => {
                const row = sceneList.createDiv('storyline-scene-picker-row');
                const cb = row.createEl('input', { type: 'checkbox' });
                row.createSpan({ text: `[${String(scene.act ?? '?').toString().padStart(2, '0')}-${String(scene.sequence ?? '?').toString().padStart(2, '0')}] ${scene.title || t('Untitled')}` });
                cb.addEventListener('change', () => {
                    if (cb.checked) selectedPaths.add(scene.filePath);
                    else selectedPaths.delete(scene.filePath);
                });
            });
        }

        new Setting(modal.contentEl)
            .addButton((btn: ButtonComponent) => {
                btn.setButtonText(t('Add to Plotline')).setCta().onClick(async () => {
                    const paths = [...selectedPaths];
                    modal.close();
                    try {
                        for (const path of paths) {
                            const scene = this.sceneManager.getScene(path);
                            if (!scene) continue;
                            const newTags = [...new Set([...(scene.tags || []), plotline])];
                            await this.sceneManager.updateSceneTags(path, newTags);
                        }
                        this.refresh();
                        new Notice(t('Added {count} scene(s) to plotline', { count: paths.length }));
                    } catch (err) {
                        console.error('[NarrativeLab] add to plotline failed', err);
                        new Notice(t('Failed to create plotline'));
                    }
                });
            });
        modal.open();
    }

    // ── Helpers ────────────────────────────────────────────

    /**
     * Returns true for corkboard sticky notes (Scene objects with
     * `corkboardNote: true`). These are brainstorming/layout aids, not story
     * scenes, and are excluded from plotline grouping.
     */
    private isCorkboardNoteScene(scene: Scene): boolean {
        const value: unknown = (scene as Scene & { corkboardNote?: unknown }).corkboardNote;
        if (value === true) return true;
        if (value === false || value === undefined || value === null) return false;
        if (typeof value === 'string') return value.trim().toLowerCase() === 'true';
        if (typeof value === 'number') return value === 1;
        return false;
    }

    private groupByPlotline(scenes: Scene[]): Map<string, Scene[]> {
        const groups = new Map<string, Scene[]>();

        // Keep empty plotlines created in the Navigator / project frontmatter.
        for (const name of this.sceneManager.getPlotlines()) {
            if (!groups.has(name)) groups.set(name, []);
        }

        for (const scene of scenes) {
            if (!scene.tags || scene.tags.length === 0) continue;

            for (const tag of scene.tags) {
                if (!groups.has(tag)) {
                    groups.set(tag, []);
                }
                groups.get(tag)!.push(scene);
            }
        }

        // Ensure each plotline's scenes are ordered by act → chapter → sequence
        // so the list view doesn't show scenes in arbitrary input order (issue #96).
        for (const list of groups.values()) {
            list.sort((a, b) => compareScenesByActChapter(a, b, (x, y) => (x.sequence ?? 0) - (y.sequence ?? 0)));
        }

        return groups;
    }

    private formatPlotlineName(tag: string): string {
        // Convert "main-mystery" → "Main Mystery"
        // Use split instead of \b\w regex to avoid issues with
        // non-ASCII characters like å, ä, ö being treated as word boundaries.
        const name = tag.split('/').pop() || tag;
        return name
            .replace(/[-_]/g, ' ')
            .split(' ')
            .map(w => w.length > 0 ? w.charAt(0).toUpperCase() + w.slice(1) : '')
            .join(' ');
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

    /**
     * Public refresh called by the plugin on file changes
     */
    refresh(): void {
        if (!this.rootContainer) return;
        // Coalesce rapid calls into a single rAF, but do NOT skip if
        // a render is already queued — the data may have changed again.
        if (this._pendingRefresh) {
            cancelAnimationFrame(this._pendingRefresh);
        }
        this._pendingRefresh = window.requestAnimationFrame(() => {
            this._pendingRefresh = null;
            if (!this.rootContainer) return;
            const previous = this.rootContainer.querySelector<HTMLElement>('.story-line-storyline-content');
            const scroll = previous ? { top: previous.scrollTop, left: previous.scrollLeft } : null;
            this.renderView(this.rootContainer);
            if (!scroll) return;
            const current = this.rootContainer.querySelector<HTMLElement>('.story-line-storyline-content');
            if (current) {
                current.scrollTop = scroll.top;
                current.scrollLeft = scroll.left;
            }
        });
    }
}
/* eslint-enable @typescript-eslint/no-floating-promises, @typescript-eslint/no-misused-promises, @typescript-eslint/no-unnecessary-type-assertion -- end of file-wide suppression block opened at line 1 */
