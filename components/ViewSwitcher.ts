/* eslint-disable @typescript-eslint/no-floating-promises, @typescript-eslint/no-misused-promises -- Obsidian's API surface and several untyped third-party libraries force dynamic dispatch; floating promises are intentional in DOM/event handlers; matching enable at end of file */
import { WorkspaceLeaf } from 'obsidian';
import * as obsidian from 'obsidian';
import type SceneCardsPlugin from '../main';
import { ConverterModal } from './ConverterModal';
import { isMobile, DESKTOP_ONLY_VIEWS } from './MobileAdapter';
import { attachTooltip } from './Tooltip';
import {
    BOARD_VIEW_TYPE,
    TIMELINE_VIEW_TYPE,
    STORYLINE_VIEW_TYPE,
    CHARACTER_VIEW_TYPE,
    STATS_VIEW_TYPE,
    PLOTGRID_VIEW_TYPE,
    LOCATION_VIEW_TYPE,
    CODEX_VIEW_TYPE,
    MANUSCRIPT_VIEW_TYPE,
    NARRATIVE_CANVAS_VIEW_TYPE,
    NCANVAS_LIBRARY_VIEW_TYPE,
} from '../constants';
import { getBuiltinCodexCategory, makeProfileCodexCategory } from '../models/Codex';
import { resolveLibraryCategoryLabel } from '../services/LibraryCategorySync';
import { t } from '../utils/i18n';
import {
    preservedNarrativeLabLeafState,
    getLeafNarrativeLabProjectFile,
} from '../utils/narrativeLabLeafState';
import { getRememberedLibraryCategory, resolveLibraryViewType } from './LibraryModeBar';
import { resolveStructureViewType } from './StructureModeSwitcher';

export interface ViewSwitcherEntry {
    type: string;
    label: string;
    icon: string;  // Lucide icon name
}

export const VIEW_ENTRIES: ViewSwitcherEntry[] = [
    { type: BOARD_VIEW_TYPE, label: 'Board', icon: 'layout-grid' },
    { type: PLOTGRID_VIEW_TYPE, label: 'Table', icon: 'table' },
    { type: TIMELINE_VIEW_TYPE, label: 'Structure', icon: 'git-branch' },
    { type: MANUSCRIPT_VIEW_TYPE, label: 'Manuscript', icon: 'book-open-text' },
    { type: CODEX_VIEW_TYPE, label: 'Library', icon: 'library-big' },
];

/** Stats sits with the other top-toolbar actions (not a primary planning tab). */
const STATS_ENTRY: ViewSwitcherEntry = {
    type: STATS_VIEW_TYPE,
    label: 'Stats',
    icon: 'bar-chart-2',
};

/** Opens the Narrative Canvas manager after Export in the top toolbar. */
const PLAYMODE_ENTRY: ViewSwitcherEntry = {
    type: NCANVAS_LIBRARY_VIEW_TYPE,
    label: 'Canvas',
    icon: 'monitor-play',
};

/** View types that are considered "inside" the Codex umbrella */
const CODEX_FAMILY = new Set([CODEX_VIEW_TYPE, CHARACTER_VIEW_TYPE, LOCATION_VIEW_TYPE]);
const STRUCTURE_FAMILY = new Set([STORYLINE_VIEW_TYPE, TIMELINE_VIEW_TYPE]);

/**
 * Renders view-switcher tabs into a toolbar container.
 * Uses the leaf reference directly from the owning view so
 * setViewState always targets the correct leaf.
 */
export function renderViewSwitcher(
    container: HTMLElement,
    activeViewType: string,
    plugin: SceneCardsPlugin,
    leaf: WorkspaceLeaf
): HTMLElement {
    const switcher = container.createDiv('story-line-view-switcher');
    const projectFile = getLeafNarrativeLabProjectFile(leaf);

    // Filter out desktop-only views on mobile
    const platformEntries = isMobile
        ? VIEW_ENTRIES.filter(e => !DESKTOP_ONLY_VIEWS.has(e.type))
        : VIEW_ENTRIES;
    const entries = platformEntries.filter(entry => plugin.isViewEnabled(entry.type, projectFile));

    for (const entry of entries) {
        // The Library tab highlights for its Character and Location views too.
        const isCodexEntry = entry.type === CODEX_VIEW_TYPE;
        const isActive = isCodexEntry
            ? CODEX_FAMILY.has(activeViewType)
            : entry.type === TIMELINE_VIEW_TYPE
                ? STRUCTURE_FAMILY.has(activeViewType)
                : entry.type === activeViewType;

        const tab = switcher.createEl('button', {
            cls: `story-line-view-tab ${isActive ? 'active' : ''}`,
        });
        attachTooltip(tab, t(entry.label));
        const iconSpan = tab.createSpan({ cls: 'view-tab-icon' });
        obsidian.setIcon(iconSpan, entry.icon);
        tab.createSpan({ cls: 'view-tab-label', text: t(entry.label) });

        if (isCodexEntry) {
            const chevron = tab.createSpan({ cls: 'codex-dropdown-chevron' });
            obsidian.setIcon(chevron, 'chevron-down');

            tab.addEventListener('click', (e) => {
                e.preventDefault();
                e.stopPropagation();
                if ((e.target as HTMLElement).closest('.codex-dropdown-chevron')) {
                    showCodexDropdown(tab, plugin, leaf, activeViewType);
                    return;
                }
                const projectFile = getLeafNarrativeLabProjectFile(leaf);
                const targetType = resolveLibraryViewType(plugin, projectFile);
                void leaf.setViewState({
                    type: targetType,
                    active: true,
                    state: preservedNarrativeLabLeafState(leaf),
                }).then(() => {
                    plugin.app.workspace.revealLeaf(leaf);
                    if (targetType === CODEX_VIEW_TYPE) {
                        window.setTimeout(() => {
                            const remembered = getRememberedLibraryCategory(plugin, projectFile);
                            if (!remembered || remembered === 'characters' || remembered === 'locations') return;
                            const view = leaf.view as unknown as { setActiveCategory?: (id: string) => void };
                            view.setActiveCategory?.(remembered);
                        }, 50);
                    }
                }).catch(() => plugin.activateView(targetType));
            });
        } else if (entry.type === TIMELINE_VIEW_TYPE) {
            // Structure umbrella: restore the last sub-tab (timeline/tracks/plot-list/subway).
            tab.addEventListener('click', async (e) => {
                e.preventDefault();
                e.stopPropagation();
                const targetType = resolveStructureViewType(plugin);
                if (targetType === activeViewType) return;
                try {
                    await leaf.setViewState({
                        type: targetType,
                        active: true,
                        state: preservedNarrativeLabLeafState(leaf),
                    });
                    plugin.app.workspace.revealLeaf(leaf);
                } catch (err) {
                    console.error('NarrativeLab: structure view switch failed, falling back', err);
                    plugin.activateView(targetType);
                }
            });
        } else if (entry.type !== activeViewType) {
            tab.addEventListener('click', async (e) => {
                e.preventDefault();
                try {
                    await leaf.setViewState({
                        type: entry.type,
                        active: true,
                        state: preservedNarrativeLabLeafState(leaf),
                    });
                    plugin.app.workspace.revealLeaf(leaf);
                } catch (err) {
                    console.error('NarrativeLab: view switch failed, falling back', err);
                    plugin.activateView(entry.type);
                }
            });
        }
    }

    // Stats / Converter / Playmode — sibling of the tab strip (not nested),
    // so they never collide with primary tabs or the filter row below.
    container.querySelectorAll(':scope > .story-line-view-actions').forEach((el) => el.remove());
    const actions = container.createDiv('story-line-view-actions');

    const statsActive = activeViewType === STATS_VIEW_TYPE;
    const statsTab = actions.createEl('button', {
        cls: `story-line-view-tab story-line-view-tab-icon${statsActive ? ' active' : ''}`,
        attr: { type: 'button', 'aria-label': t(STATS_ENTRY.label) },
    });
    statsTab.toggle(plugin.isViewEnabled(STATS_VIEW_TYPE, projectFile));
    attachTooltip(statsTab, t(STATS_ENTRY.label));
    const statsIcon = statsTab.createSpan({ cls: 'view-tab-icon' });
    obsidian.setIcon(statsIcon, STATS_ENTRY.icon);
    if (!statsActive) {
        statsTab.addEventListener('click', async (e) => {
            e.preventDefault();
            try {
                await leaf.setViewState({
                    type: STATS_VIEW_TYPE,
                    active: true,
                    state: preservedNarrativeLabLeafState(leaf),
                });
                plugin.app.workspace.revealLeaf(leaf);
            } catch {
                plugin.activateView(STATS_VIEW_TYPE);
            }
        });
    }

    const exportTab = actions.createEl('button', {
        cls: 'story-line-view-tab story-line-view-tab-icon',
        attr: { type: 'button', 'aria-label': t('Converter') },
    });
    attachTooltip(exportTab, t('Converter'));
    const exportIcon = exportTab.createSpan({ cls: 'view-tab-icon' });
    obsidian.setIcon(exportIcon, 'arrow-left-right');
    exportTab.addEventListener('click', (e) => {
        e.preventDefault();
        new ConverterModal(plugin).open();
    });

    const playmodeActive = activeViewType === NARRATIVE_CANVAS_VIEW_TYPE
        || activeViewType === NCANVAS_LIBRARY_VIEW_TYPE;
    const playmodeTab = actions.createEl('button', {
        cls: `story-line-view-tab story-line-view-tab-playmode${playmodeActive ? ' active' : ''}`,
        attr: { type: 'button', 'aria-label': t(PLAYMODE_ENTRY.label) },
    });
    playmodeTab.toggle(plugin.isViewEnabled(NCANVAS_LIBRARY_VIEW_TYPE, projectFile));
    attachTooltip(playmodeTab, t('Choose, create, or open an ncanvas for this project'));
    const playIcon = playmodeTab.createSpan({ cls: 'view-tab-icon' });
    obsidian.setIcon(playIcon, PLAYMODE_ENTRY.icon);
    playmodeTab.createSpan({ cls: 'view-tab-label', text: t(PLAYMODE_ENTRY.label) });
    playmodeTab.addEventListener('click', (e) => {
        e.preventDefault();
        if (activeViewType === NCANVAS_LIBRARY_VIEW_TYPE) return;
        void plugin.openNCanvasLibrary(getLeafNarrativeLabProjectFile(leaf), leaf);
    });

    // Collapse primary-tab labels when the toolbar is too narrow.
    // Opt-out: `autoHideViewLabels = false`.
    if (plugin.settings.autoHideViewLabels !== false) {
        installAutoHideLabels(switcher);
    }

    return switcher;
}

/**
 * Toggle `sl-collapsed` on the tab strip when primary labels would overflow
 * the free space between the title and the trailing action cluster.
 */
function installAutoHideLabels(switcher: HTMLElement): void {
    const parent = switcher.parentElement;
    if (!parent) return;

    const measure = () => {
        switcher.classList.remove('sl-collapsed');
        parent.classList.remove('sl-toolbar-compact');

        let reserved = 0;
        let sameRowSiblings = 0;
        for (const child of Array.from(parent.children)) {
            const el = child as HTMLElement;
            // Full-width control rows sit on their own line — ignore for width budget.
            if (el.classList.contains('story-line-toolbar-controls')) continue;
            if (child === switcher) continue;
            reserved += el.offsetWidth;
            sameRowSiblings += 1;
        }
        const styles = window.getComputedStyle(parent);
        const gap = parseFloat(styles.columnGap || styles.gap || '0') || 0;
        // title + actions (+ gaps) leave this much room for primary tabs
        const available = parent.clientWidth - reserved - gap * sameRowSiblings - 8;
        if (switcher.scrollWidth > Math.max(0, available)) {
            switcher.classList.add('sl-collapsed');
        }
        // If icon-only tabs + Playmode label still overflow, compact Playmode too.
        if (switcher.scrollWidth > Math.max(0, available)) {
            parent.classList.add('sl-toolbar-compact');
        }
    };

    window.requestAnimationFrame(measure);

    const ro = new ResizeObserver(() => measure());
    ro.observe(parent);

    const cleanup = () => ro.disconnect();
    const mo = new MutationObserver(() => {
        if (!switcher.isConnected) {
            cleanup();
            mo.disconnect();
        }
    });
    if (switcher.parentNode) {
        mo.observe(switcher.parentNode, { childList: true });
    }
}

// ── Library dropdown ───────────────────────────────────

function showCodexDropdown(
    anchor: HTMLElement,
    plugin: SceneCardsPlugin,
    leaf: WorkspaceLeaf,
    activeViewType: string,
): void {
    // Close any existing dropdown
    activeDocument.querySelectorAll('.codex-dropdown-menu').forEach(el => el.remove());

    const menu = activeDocument.createElement('div');
    menu.classList.add('codex-dropdown-menu');

    // Position below the anchor tab
    const rect = anchor.getBoundingClientRect();
    menu.setCssStyles({
        top: `${rect.bottom + 2}px`,
        left: `${rect.left}px`,
    });

    const switchTo = async (viewType: string) => {
        menu.remove();
        removeClickOutside();
        try {
            await leaf.setViewState({
                type: viewType,
                active: true,
                state: preservedNarrativeLabLeafState(leaf),
            });
            plugin.app.workspace.revealLeaf(leaf);
        } catch { plugin.activateView(viewType); }
    };

    const charactersLabel = resolveLibraryCategoryLabel(plugin, 'characters', 'Characters');
    const locationsLabel = resolveLibraryCategoryLabel(plugin, 'locations', 'Locations');

    // Characters — NarrativeLab dedicated view
    addDropdownItem(menu, 'users', charactersLabel, activeViewType === CHARACTER_VIEW_TYPE, () => switchTo(CHARACTER_VIEW_TYPE));

    // Locations
    addDropdownItem(menu, 'map-pin', locationsLabel, activeViewType === LOCATION_VIEW_TYPE, () => switchTo(LOCATION_VIEW_TYPE));

    // Enabled codex categories
    const enabledIds = plugin.settings.codexEnabledCategories || [];
    const customDefs = (plugin.settings.codexCustomCategories || []).map(
        (c: { id: string; label: string; icon: string }) =>
            makeProfileCodexCategory(c.id, c.label, c.icon),
    );
    for (const id of enabledIds) {
        const builtin = getBuiltinCodexCategory(id);
        const custom = customDefs.find((c: { id: string }) => c.id === id);
        const def = builtin && custom
            ? { ...builtin, label: custom.label, folder: custom.folder, icon: custom.icon }
            : builtin || custom;
        if (def) {
            // Codex category — navigate to CodexView with this category active
            addDropdownItem(menu, def.icon, t(def.label), false, async () => {
                menu.remove();
                removeClickOutside();
                // Switch to CodexView, then set active category via the view instance
                try {
                    await leaf.setViewState({
                        type: CODEX_VIEW_TYPE,
                        active: true,
                        state: preservedNarrativeLabLeafState(leaf),
                    });
                    plugin.app.workspace.revealLeaf(leaf);
                    // Find the CodexView instance and set its category
                    const view = leaf.view as unknown as { setActiveCategory?: (id: string) => void };
                    if (view && typeof view.setActiveCategory === 'function') {
                        view.setActiveCategory(id);
                    }
                } catch { plugin.activateView(CODEX_VIEW_TYPE); }
            });
        }
    }

    activeDocument.body.appendChild(menu);

    // Close on click outside
    const onClickOutside = (ev: MouseEvent) => {
        if (!menu.contains(ev.target as Node) && !anchor.contains(ev.target as Node)) {
            menu.remove();
            removeClickOutside();
        }
    };
    const removeClickOutside = () => activeDocument.removeEventListener('click', onClickOutside, true);
    // Delay attaching so the current click doesn't immediately close it
    window.setTimeout(() => activeDocument.addEventListener('click', onClickOutside, true), 0);
}

function addDropdownItem(
    menu: HTMLElement,
    icon: string,
    label: string,
    isActive: boolean,
    onClick: () => void,
): void {
    const item = menu.createDiv(`codex-dropdown-item ${isActive ? 'active' : ''}`);
    const iconEl = item.createSpan({ cls: 'codex-dropdown-item-icon' });
    obsidian.setIcon(iconEl, icon);
    item.createSpan({ cls: 'codex-dropdown-item-label', text: label });
    item.addEventListener('click', (e) => {
        e.preventDefault();
        e.stopPropagation();
        onClick();
    });
}
/* eslint-enable @typescript-eslint/no-floating-promises, @typescript-eslint/no-misused-promises -- end of file-wide suppression block opened at line 1 */
