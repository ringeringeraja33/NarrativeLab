/* eslint-disable @typescript-eslint/no-floating-promises, @typescript-eslint/no-misused-promises -- Obsidian's API surface and several untyped third-party libraries force dynamic dispatch; floating promises are intentional in DOM/event handlers; matching enable at end of file */
import { WorkspaceLeaf } from 'obsidian';
import * as obsidian from 'obsidian';
import type SceneCardsPlugin from '../main';
import { ConverterModal } from './ConverterModal';
import { isMobile, DESKTOP_ONLY_VIEWS } from './MobileAdapter';
import { attachTooltip } from './Tooltip';
import {
    CHARACTER_VIEW_TYPE,
    STATS_VIEW_TYPE,
    LOCATION_VIEW_TYPE,
    CODEX_VIEW_TYPE,
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
import {
    PROJECT_PAGES,
    PROJECT_TAB_GROUPS,
    flattenTabGroupOrder,
    sortByProjectPageOrder,
    sortTabGroups,
} from '../models/ProjectPages';
import { ProjectModulesModal } from './ProjectModulesModal';
import { showMenuSafely } from '../utils/obsidianMenu';

export interface ViewSwitcherEntry {
    type: string;
    label: string;
    icon: string;  // Lucide icon name
    module?: import('../models/ProjectCapabilities').ProjectModuleId;
}

export const VIEW_ENTRIES: readonly ViewSwitcherEntry[] = PROJECT_PAGES;

/** Stats sits with the other top-toolbar actions (not a primary planning tab). */
const STATS_ENTRY: ViewSwitcherEntry = {
    type: STATS_VIEW_TYPE,
    label: 'Stats',
    icon: 'bar-chart-2',
};

/** View types that are considered "inside" the Codex umbrella */
const CODEX_FAMILY = new Set([CODEX_VIEW_TYPE, CHARACTER_VIEW_TYPE, LOCATION_VIEW_TYPE]);

const lastPageByGroup = new Map<string, string>();

function groupMemoryKey(projectFile: string | null | undefined, groupId: string): string {
    return `${projectFile || ''}::${groupId}`;
}

function rememberGroupPage(projectFile: string | null | undefined, groupId: string, type: string): void {
    lastPageByGroup.set(groupMemoryKey(projectFile, groupId), type);
}

function preferredGroupPage(
    projectFile: string | null | undefined,
    groupId: string,
    pages: readonly ViewSwitcherEntry[],
    activeViewType: string,
): ViewSwitcherEntry {
    const current = pages.find(page => page.type === activeViewType);
    if (current) return current;
    const remembered = lastPageByGroup.get(groupMemoryKey(projectFile, groupId));
    return pages.find(page => page.type === remembered) ?? pages[0];
}

function groupIsActive(groupId: string, pages: readonly ViewSwitcherEntry[], activeViewType: string): boolean {
    if (groupId === 'library') return CODEX_FAMILY.has(activeViewType);
    if (groupId === 'presentation') {
        return activeViewType === NARRATIVE_CANVAS_VIEW_TYPE || activeViewType === NCANVAS_LIBRARY_VIEW_TYPE;
    }
    return pages.some(page => page.type === activeViewType);
}

async function switchLeafView(leaf: WorkspaceLeaf, plugin: SceneCardsPlugin, type: string): Promise<void> {
    try {
        await leaf.setViewState({
            type,
            active: true,
            state: preservedNarrativeLabLeafState(leaf),
        });
        plugin.app.workspace.revealLeaf(leaf);
    } catch (err) {
        console.error('NarrativeLab: view switch failed, falling back', err);
        plugin.activateView(type);
    }
}

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
    container.querySelectorAll(':scope > .story-line-view-switcher, :scope > .story-line-view-actions').forEach(el => el.remove());
    const switcher = container.createDiv('story-line-view-switcher');
    const projectFile = getLeafNarrativeLabProjectFile(leaf);
    const project = plugin.sceneManager.getProjects().find(project => project.filePath === projectFile);
    const navigation = plugin.capabilityService.get(project).navigation;

    const hiddenTypes = new Set(PROJECT_PAGES.filter(page => navigation?.hidden.includes(page.module)).map(page => page.type));
    const groups = sortTabGroups([...PROJECT_TAB_GROUPS], navigation?.order);
    const strip: { group: (typeof PROJECT_TAB_GROUPS)[number]; pages: ViewSwitcherEntry[]; userHidden: boolean }[] = [];
    for (const group of groups) {
        const pages = sortByProjectPageOrder(
            PROJECT_PAGES.filter(entry =>
                group.modules.includes(entry.module)
                && plugin.isViewEnabled(entry.type, projectFile)
                && (!isMobile || !DESKTOP_ONLY_VIEWS.has(entry.type))),
            navigation?.order,
        );
        if (!pages.length) continue;
        strip.push({ group, pages, userHidden: pages.every(page => hiddenTypes.has(page.type)) });
    }

    for (const item of strip) {
        const { group, pages } = item;
        const isActive = groupIsActive(group.id, pages, activeViewType);
        if (isActive && pages.some(page => page.type === activeViewType)) {
            rememberGroupPage(projectFile, group.id, activeViewType);
        }
        const hasMenu = group.id !== 'manuscript';
        const tab = switcher.createEl('button', {
            cls: `story-line-view-tab ${isActive ? 'active' : ''}`,
            attr: {
                type: 'button',
                'aria-current': isActive ? 'page' : 'false',
                'data-group': group.id,
                ...(hasMenu ? { 'aria-haspopup': 'menu' } : {}),
            },
        });
        attachTooltip(tab, t(group.label));
        const iconSpan = tab.createSpan({ cls: 'view-tab-icon' });
        obsidian.setIcon(iconSpan, group.icon);
        tab.createSpan({ cls: 'view-tab-label', text: t(group.label) });

        if (group.id === 'presentation') {
            const chevron = tab.createSpan({ cls: 'codex-dropdown-chevron' });
            obsidian.setIcon(chevron, 'chevron-down');
            tab.addEventListener('click', event => {
                event.preventDefault();
                event.stopPropagation();
                if ((event.target as HTMLElement).closest('.codex-dropdown-chevron')) {
                    const project = plugin.sceneManager.getProjects().find(p => p.filePath === projectFile);
                    if (!project) return;
                    const menu = new obsidian.Menu();
                    for (const path of plugin.getNcanvasPathsForProject(project).candidates) {
                        menu.addItem(item => item.setTitle(path.split('/').pop()!.replace(/\.n(?:arrative)?canvas$/i, ''))
                            .setIcon('monitor-play').onClick(() => plugin.openProjectCanvasTab(project.filePath, leaf, path)));
                    }
                    menu.addSeparator();
                    menu.addItem(item => item.setTitle(t('New canvas')).setIcon('plus').onClick(async () => {
                        const { openNewProjectCanvasModal } = await import('../views/NCanvasLibraryView');
                        openNewProjectCanvasModal(plugin, project.filePath, leaf);
                    }));
                    menu.addItem(item => item.setTitle(t('Manage canvases')).setIcon('settings')
                        .onClick(() => plugin.openNCanvasLibrary(project.filePath, leaf)));
                    const rect = tab.getBoundingClientRect();
                    showMenuSafely(menu, { x: rect.left, y: rect.bottom + 4 });
                    return;
                }
                if (activeViewType !== NARRATIVE_CANVAS_VIEW_TYPE) void plugin.openProjectCanvasTab(projectFile, leaf);
            });
        } else if (group.id === 'library') {
            const chevron = tab.createSpan({ cls: 'codex-dropdown-chevron' });
            obsidian.setIcon(chevron, 'chevron-down');
            tab.addEventListener('click', (e) => {
                e.preventDefault();
                e.stopPropagation();
                if ((e.target as HTMLElement).closest('.codex-dropdown-chevron')) {
                    showCodexDropdown(tab, plugin, leaf, activeViewType);
                    return;
                }
                const boundProject = getLeafNarrativeLabProjectFile(leaf);
                const targetType = resolveLibraryViewType(plugin, boundProject);
                void leaf.setViewState({
                    type: targetType,
                    active: true,
                    state: preservedNarrativeLabLeafState(leaf),
                }).then(() => {
                    plugin.app.workspace.revealLeaf(leaf);
                    if (targetType === CODEX_VIEW_TYPE) {
                        window.setTimeout(() => {
                            const remembered = getRememberedLibraryCategory(plugin, boundProject);
                            if (!remembered || remembered === 'characters' || remembered === 'locations') return;
                            const view = leaf.view as unknown as { setActiveCategory?: (id: string) => void };
                            view.setActiveCategory?.(remembered);
                        }, 50);
                    }
                }).catch(() => plugin.activateView(targetType));
            });
        } else if (hasMenu) {
            const chevron = tab.createSpan({ cls: 'codex-dropdown-chevron' });
            obsidian.setIcon(chevron, 'chevron-down');
            const menuPages = pages.filter(page => !hiddenTypes.has(page.type) || page.type === activeViewType);
            const openable = menuPages.length ? menuPages : pages;
            tab.addEventListener('click', event => {
                event.preventDefault();
                event.stopPropagation();
                if ((event.target as HTMLElement).closest('.codex-dropdown-chevron')) {
                    const menu = new obsidian.Menu();
                    for (const page of openable) {
                        menu.addItem(item => item.setTitle(t(page.label)).setIcon(page.icon).onClick(() => {
                            rememberGroupPage(projectFile, group.id, page.type);
                            void switchLeafView(leaf, plugin, page.type);
                        }));
                    }
                    const rect = tab.getBoundingClientRect();
                    showMenuSafely(menu, { x: rect.left, y: rect.bottom + 4 });
                    return;
                }
                if (isActive) return;
                const target = preferredGroupPage(projectFile, group.id, openable, activeViewType);
                rememberGroupPage(projectFile, group.id, target.type);
                void switchLeafView(leaf, plugin, target.type);
            });
        } else if (!isActive) {
            tab.addEventListener('click', event => {
                event.preventDefault();
                void switchLeafView(leaf, plugin, pages[0].type);
            });
        }
    }

    if (project) attachProjectTabReordering(switcher, plugin, project);

    // Stats / Converter / Playmode — sibling of the tab strip (not nested),
    // so they never collide with primary tabs or the filter row below.
    container.querySelectorAll(':scope > .story-line-view-actions').forEach((el) => el.remove());
    const actions = container.createDiv('story-line-view-actions');
    const settings = actions.createEl('button', {
        cls: 'story-line-view-tab nl-project-settings-button',
        text: t('Project settings'),
        attr: { type: 'button' },
    });
    settings.addEventListener('click', () => {
        const project = plugin.sceneManager.getProjects().find(p => p.filePath === projectFile);
        if (project) new ProjectModulesModal(plugin.app, plugin, project).open();
    });

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

    placeSwitcher(container, switcher, actions);
    installTabOverflow(
        switcher,
        strip.map(item => ({ label: item.group.label, icon: item.group.icon })),
        leaf,
        strip.map(item => item.userHidden),
    );

    return switcher;
}

function placeSwitcher(container: HTMLElement, switcher: HTMLElement, actions: HTMLElement): void {
    const titleRow = container.querySelector(':scope > .story-line-title-row');
    const title = container.querySelector(':scope > .story-line-view-title');
    const controls = container.querySelector(':scope > .story-line-toolbar-controls');
    const anchor = titleRow?.nextSibling ?? title?.nextSibling ?? controls;
    if (anchor && anchor !== switcher) container.insertBefore(switcher, anchor);
    if (switcher.nextSibling !== actions) container.insertBefore(actions, switcher.nextSibling);
}

function attachProjectTabReordering(
    switcher: HTMLElement,
    plugin: SceneCardsPlugin,
    project: import('../models/StoryLineProject').StoryLineProject,
): void {
    const tabs = Array.from(switcher.querySelectorAll<HTMLButtonElement>(':scope > button[data-group]'));
    if (tabs.length < 2) return;
    let dragged: HTMLButtonElement | null = null;
    let suppressClickUntil = 0;
    const clearIndicators = () => {
        for (const tab of tabs) tab.removeClass('is-drag-over-before', 'is-drag-over-after');
    };
    const groupIds = () => Array.from(switcher.querySelectorAll<HTMLButtonElement>(':scope > button[data-group]'))
        .map(item => item.dataset.group)
        .filter((id): id is string => Boolean(id));

    for (const tab of tabs) {
        tab.draggable = true;
        tab.addClass('is-reorderable');
        tab.addEventListener('click', event => {
            if (Date.now() >= suppressClickUntil) return;
            event.preventDefault();
            event.stopImmediatePropagation();
        }, true);
        tab.addEventListener('dragstart', event => {
            dragged = tab;
            tab.addClass('is-dragging');
            event.dataTransfer?.setData('text/plain', tab.dataset.group || '');
            if (event.dataTransfer) event.dataTransfer.effectAllowed = 'move';
            event.stopPropagation();
        });
        tab.addEventListener('dragover', event => {
            if (!dragged || dragged === tab) return;
            event.preventDefault();
            event.stopPropagation();
            if (event.dataTransfer) event.dataTransfer.dropEffect = 'move';
            clearIndicators();
            const rect = tab.getBoundingClientRect();
            tab.addClass(event.clientX < rect.left + rect.width / 2 ? 'is-drag-over-before' : 'is-drag-over-after');
        });
        tab.addEventListener('drop', event => {
            if (!dragged || dragged === tab) return;
            event.preventDefault();
            event.stopPropagation();
            const before = groupIds();
            const rect = tab.getBoundingClientRect();
            const insertAfter = event.clientX >= rect.left + rect.width / 2;
            switcher.insertBefore(dragged, insertAfter ? tab.nextSibling : tab);
            const ordered = groupIds();
            suppressClickUntil = Date.now() + 250;
            clearIndicators();
            if (ordered.join('\0') === before.join('\0')) return;
            const previous = plugin.capabilityService.get(project).navigation?.order;
            void plugin.updateProjectTabOrder(project, flattenTabGroupOrder(ordered, previous))
                .catch(error => new obsidian.Notice(String(error)));
        });
        tab.addEventListener('dragend', () => {
            tab.removeClass('is-dragging');
            clearIndicators();
            dragged = null;
        });
    }
}

/**
 * Toggle `sl-collapsed` on the tab strip when primary labels would overflow
 * the free space between the title and the trailing action cluster.
 */
function installTabOverflow(
    switcher: HTMLElement,
    entries: readonly { label: string; icon: string }[],
    leaf: WorkspaceLeaf,
    initiallyHidden: readonly boolean[],
): void {
    const parent = switcher.parentElement;
    if (!parent) return;
    const tabs = Array.from(switcher.querySelectorAll<HTMLButtonElement>(':scope > button'));
    const more = switcher.createEl('button', { cls: 'story-line-view-tab nl-tab-more', text: t('More views') + ' ▾', attr: { type: 'button' } });
    more.addEventListener('click', event => {
        event.stopPropagation();
        const menu = new obsidian.Menu();
        tabs.forEach((tab, index) => {
            if (!tab.hidden) return;
            const entry = entries[index];
            if (!entry) return;
            menu.addItem(item => item.setTitle(t(entry.label)).setIcon(entry.icon).onClick(() => tab.click()));
        });
        const rect = more.getBoundingClientRect();
        showMenuSafely(menu, { x: rect.left, y: rect.bottom + 4 });
    });

    const measure = () => {
        switcher.classList.remove('sl-collapsed');
        parent.classList.remove('sl-toolbar-compact');
        tabs.forEach((tab, index) => { tab.hidden = Boolean(initiallyHidden[index]) && !tab.classList.contains('active'); });
        more.hidden = !tabs.some(tab => tab.hidden);

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
        const width = () => tabs.reduce((total, tab) => total + (tab.hidden ? 0 : tab.offsetWidth + 4), more.hidden ? 0 : more.offsetWidth + 4);
        if (width() > Math.max(100, available)) {
            more.hidden = false;
            for (const tab of [...tabs].reverse()) {
                if (width() <= Math.max(100, available)) break;
                if (!tab.classList.contains('active')) tab.hidden = true;
            }
        }
    };

    window.requestAnimationFrame(measure);

    const ro = new ResizeObserver(() => measure());
    ro.observe(parent);

    // Toolbar refresh replaces the entire subtree. Observe the stable view root
    // and also register unload cleanup, so detached toolbars cannot leak observers.
    const cleanup = () => { ro.disconnect(); mo.disconnect(); };
    const mo = new MutationObserver(() => { if (!switcher.isConnected) cleanup(); });
    mo.observe(leaf.view.containerEl, { childList: true, subtree: true });
    leaf.view.register(cleanup);
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
