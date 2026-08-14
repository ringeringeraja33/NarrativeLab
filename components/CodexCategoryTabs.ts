/* eslint-disable @typescript-eslint/no-floating-promises, @typescript-eslint/no-misused-promises, @typescript-eslint/no-redundant-type-constituents -- Obsidian's API surface and several untyped third-party libraries force dynamic dispatch; floating promises are intentional in DOM/event handlers; matching enable at end of file */
/**
 * Shared Codex category tab bar — rendered in CodexView, CharacterView, and LocationView
 * so the user can switch between categories from any of those views.
 *
 * Tab labels prefer saved/custom display names (seeded from Obsidian language).
 * Right-click a tab to rename the folder + label together when the user chooses.
 */
import * as obsidian from 'obsidian';
import type SceneCardsPlugin from '../main';
import { CHARACTER_VIEW_TYPE, LOCATION_VIEW_TYPE, CODEX_VIEW_TYPE } from '../constants';
import {
    getLibraryContentMode,
    rememberLibraryCategory,
    setLibraryContentMode,
} from './LibraryModeBar';
import { preservedNarrativeLabLeafState } from '../utils/narrativeLabLeafState';
import {
    applyCategoryFolderLabels,
    deleteLibraryCategory,
    renameLibraryCategory,
    resolveLibraryCategoryLabel,
} from '../services/LibraryCategorySync';
import { t } from '../utils/i18n';
import {
    getBuiltinCodexCategory,
    makeCustomCodexCategory,
    makeProfileCodexCategory,
    UNCATEGORIZED_CATEGORY_ID,
} from '../models/Codex';
import { setLibraryCategoryProfileSetting } from '../utils/libraryCategoryTransactions';

const FIXED_PROFILE_CATEGORY_IDS = new Set(['characters', 'locations']);

export interface CodexTabsOptions {
    /** The view type that should be highlighted as active ('Characters' | 'Locations' | category id) */
    activeId: 'characters-pseudo' | 'locations-pseudo' | string;
    /** The WorkspaceLeaf to set view state on */
    leaf: obsidian.WorkspaceLeaf;
    /** Plugin instance */
    plugin: SceneCardsPlugin;
    /** Optional leading category-management controls. */
    renderBeforeModeActions?: (container: HTMLElement) => void;
    /** Optional trailing category-management controls. */
    renderAfterModeActions?: (container: HTMLElement) => void;
    /** Optional peer tabs rendered before every Library category. */
    renderLeadingTabs?: (container: HTMLElement) => void;
    /** Called immediately before a Library category is activated. */
    onCategoryActivate?: (categoryId: string) => void;
    /** Called after a successful tab/folder rename (views should re-render) */
    onCategoriesChanged?: () => void;
    /** Show the Custom Categories gear button (default true). */
    showManageCategories?: boolean;
}

/**
 * Render the Codex category tab bar into `parent`.
 * Includes Characters, Locations, and all user-defined codex categories.
 * Content-mode controls are rendered in the toolbar below this category row.
 */
export function renderCodexCategoryTabs(parent: HTMLElement, opts: CodexTabsOptions): HTMLElement {
    const {
        activeId,
        leaf,
        plugin,
        onCategoriesChanged,
        onCategoryActivate,
        renderBeforeModeActions,
        renderAfterModeActions,
        renderLeadingTabs,
        showManageCategories = true,
    } = opts;

    const tabs = parent.createDiv('codex-category-tabs');
    renderLeadingTabs?.(tabs);
    const renderedTabs: Array<{ id: string; el: HTMLButtonElement }> = [];
    const hiddenFixed = new Set(plugin.settings.libraryHiddenFixedCategories || []);
    const categoryOverrides = plugin.settings.codexCustomCategories || [];
    const overrideFor = (id: string) => categoryOverrides.find(category => category.id === id);
    const charName = resolveLibraryCategoryLabel(plugin, 'characters', 'Characters');
    const locName = resolveLibraryCategoryLabel(plugin, 'locations', 'Locations');
    const activateCategory = (categoryId: string): void => {
        rememberLibraryCategory(plugin, categoryId);
        if (getLibraryContentMode(plugin) === 'story-graph') {
            setLibraryContentMode(
                plugin,
                isLibraryCategoryProfilePageEnabled(plugin, categoryId) ? 'profile' : 'browse',
            );
        }
        onCategoryActivate?.(categoryId);
    };

    // ── Characters pseudo-tab ──
    if (!hiddenFixed.has('characters')) {
        const charTab = tabs.createEl('button', {
            cls: `codex-tab codex-pseudo-tab ${activeId === 'characters-pseudo' ? 'active' : ''}`,
            attr: { 'aria-label': charName, type: 'button', 'data-category-id': 'characters' },
        });
        const charIcon = charTab.createSpan({ cls: 'codex-tab-icon' });
        obsidian.setIcon(charIcon, overrideFor('characters')?.icon || 'users');
        charTab.createSpan({ cls: 'codex-tab-label', text: charName });
        if (activeId !== 'characters-pseudo') {
            charTab.addEventListener('click', () => {
                activateCategory('characters');
                switchTo(leaf, plugin, CHARACTER_VIEW_TYPE, 'characters');
            });
        }
        attachRenameMenu(charTab, plugin, 'characters', onCategoriesChanged);
        renderedTabs.push({ id: 'characters', el: charTab });
    }

    // ── Locations pseudo-tab ──
    if (!hiddenFixed.has('locations')) {
        const locTab = tabs.createEl('button', {
            cls: `codex-tab codex-pseudo-tab ${activeId === 'locations-pseudo' ? 'active' : ''}`,
            attr: { 'aria-label': locName, type: 'button', 'data-category-id': 'locations' },
        });
        const locIcon = locTab.createSpan({ cls: 'codex-tab-icon' });
        obsidian.setIcon(locIcon, overrideFor('locations')?.icon || 'map-pin');
        locTab.createSpan({ cls: 'codex-tab-label', text: locName });
        if (activeId !== 'locations-pseudo') {
            locTab.addEventListener('click', () => {
                activateCategory('locations');
                switchTo(leaf, plugin, LOCATION_VIEW_TYPE, 'locations');
            });
        }
        attachRenameMenu(locTab, plugin, 'locations', onCategoriesChanged);
        renderedTabs.push({ id: 'locations', el: locTab });
    }

    // ── Custom / built-in codex categories ──
    const cats = plugin.codexManager.getCategories()
        .filter(category => category.id !== UNCATEGORIZED_CATEGORY_ID);
    for (const cat of cats) {
        const isActive = activeId === cat.id;
        const tabLabel = resolveLibraryCategoryLabel(plugin, cat.id, cat.label);
        const tab = tabs.createEl('button', {
            cls: `codex-tab ${isActive ? 'active' : ''}`,
            attr: { 'aria-label': tabLabel, type: 'button', 'data-category-id': cat.id },
        });
        const icon = tab.createSpan({ cls: 'codex-tab-icon' });
        obsidian.setIcon(icon, cat.icon);
        tab.createSpan({ cls: 'codex-tab-label', text: tabLabel });
        attachRenameMenu(
            tab,
            plugin,
            cat.id,
            onCategoriesChanged,
            true,
            () => {
                if (isActive) {
                    const view = leaf.view as unknown as { setActiveCategory?: (id: string) => void };
                    view.setActiveCategory?.(UNCATEGORIZED_CATEGORY_ID);
                } else {
                    onCategoriesChanged?.();
                    plugin.refreshOpenViews();
                }
            },
        );

        if (!isActive) {
            tab.addEventListener('click', () => {
                activateCategory(cat.id);
                // Already on CodexView — switch category without remounting the leaf
                if (leaf.view?.getViewType?.() === CODEX_VIEW_TYPE) {
                    const view = leaf.view as unknown as { setActiveCategory?: (id: string) => void };
                    view.setActiveCategory?.(cat.id);
                    return;
                }
                // Navigate to CodexView with this category active
                try {
                    void leaf.setViewState({
                        type: CODEX_VIEW_TYPE,
                        active: true,
                        state: preservedNarrativeLabLeafState(leaf),
                    });
                    plugin.app.workspace.revealLeaf(leaf);
                    // After view is set, tell the CodexView which category to show
                    window.setTimeout(() => {
                        const view = leaf.view as unknown as { setActiveCategory?: (id: string) => void };
                        if (view && typeof view.setActiveCategory === 'function') {
                            view.setActiveCategory(cat.id);
                        }
                    }, 50);
                } catch {
                    plugin.activateView(CODEX_VIEW_TYPE);
                }
            });
        }
        renderedTabs.push({ id: cat.id, el: tab });
    }

    const storedOrder = plugin.settings.libraryCategoryOrder || [];
    const orderIndex = new Map(storedOrder.map((id, index) => [id, index]));
    renderedTabs.sort((a, b) => {
        const ai = orderIndex.get(a.id);
        const bi = orderIndex.get(b.id);
        if (ai === undefined && bi === undefined) return 0;
        if (ai === undefined) return 1;
        if (bi === undefined) return -1;
        return ai - bi;
    });
    for (const item of renderedTabs) tabs.appendChild(item.el);
    attachTabReordering(tabs, renderedTabs, plugin, onCategoriesChanged);

    // Category-management actions remain beside the category strip.
    let categoryActions: HTMLElement | null = null;
    if (
        renderBeforeModeActions
        || renderAfterModeActions
        || showManageCategories
    ) {
        const actions = tabs.createDiv('codex-category-actions');
        categoryActions = actions;
        renderBeforeModeActions?.(actions);
        renderAfterModeActions?.(actions);
        if (showManageCategories) {
            const manageCategoriesBtn = actions.createEl('button', {
                cls: 'character-mode-btn codex-manage-categories-tab',
                attr: { type: 'button', 'aria-label': t('Manage categories') },
            });
            const icon = manageCategoriesBtn.createSpan();
            obsidian.setIcon(icon, 'settings');
            manageCategoriesBtn.createSpan({ text: t('Custom Categories') });
            manageCategoriesBtn.addEventListener('click', () => {
                // Lazy import avoids CodexView ↔ CodexCategoryTabs circular init.
                void import('../views/CodexView').then(({ openManageLibraryCategoriesModal }) => {
                    openManageLibraryCategoriesModal(plugin, onCategoriesChanged);
                });
            });
        }
    }

    // Uncategorized follows the existing categories, before the divider/actions.
    if (!hiddenFixed.has(UNCATEGORIZED_CATEGORY_ID)) {
        const uncategorizedActive = activeId === UNCATEGORIZED_CATEGORY_ID;
        const uncategorizedOverride = overrideFor(UNCATEGORIZED_CATEGORY_ID);
        const uncategorizedLabel = uncategorizedOverride?.label || t('Uncategorized entries');
        const uncategorizedTab = tabs.createEl('button', {
            cls: `codex-tab codex-uncategorized-tab ${uncategorizedActive ? 'active' : ''}`,
            attr: {
                'aria-label': uncategorizedLabel,
                type: 'button',
                'data-category-id': UNCATEGORIZED_CATEGORY_ID,
            },
        });
        const uncategorizedIcon = uncategorizedTab.createSpan({ cls: 'codex-tab-icon' });
        obsidian.setIcon(uncategorizedIcon, uncategorizedOverride?.icon || 'file-question');
        uncategorizedTab.createSpan({
            cls: 'codex-tab-label',
            text: uncategorizedLabel,
        });
        if (!uncategorizedActive) {
            uncategorizedTab.addEventListener('click', () => {
                activateCategory(UNCATEGORIZED_CATEGORY_ID);
                if (leaf.view?.getViewType?.() === CODEX_VIEW_TYPE) {
                    const view = leaf.view as unknown as { setActiveCategory?: (id: string) => void };
                    view.setActiveCategory?.(UNCATEGORIZED_CATEGORY_ID);
                    return;
                }
                try {
                    void leaf.setViewState({
                        type: CODEX_VIEW_TYPE,
                        active: true,
                        state: preservedNarrativeLabLeafState(leaf),
                    });
                    plugin.app.workspace.revealLeaf(leaf);
                    window.setTimeout(() => {
                        const view = leaf.view as unknown as { setActiveCategory?: (id: string) => void };
                        view.setActiveCategory?.(UNCATEGORIZED_CATEGORY_ID);
                    }, 50);
                } catch {
                    plugin.activateView(CODEX_VIEW_TYPE);
                }
            });
        }
        if (categoryActions) tabs.insertBefore(uncategorizedTab, categoryActions);
    }

    return tabs;
}

function attachTabReordering(
    tabs: HTMLElement,
    renderedTabs: Array<{ id: string; el: HTMLButtonElement }>,
    plugin: SceneCardsPlugin,
    onCategoriesChanged?: () => void,
): void {
    let dragged: HTMLButtonElement | null = null;
    let suppressClickUntil = 0;

    const clearIndicators = () => {
        for (const item of renderedTabs) {
            item.el.removeClass('is-drag-over-before', 'is-drag-over-after');
        }
    };

    for (const item of renderedTabs) {
        const tab = item.el;
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
            event.dataTransfer?.setData('text/plain', item.id);
            if (event.dataTransfer) event.dataTransfer.effectAllowed = 'move';
        });
        tab.addEventListener('dragover', event => {
            if (!dragged || dragged === tab) return;
            event.preventDefault();
            if (event.dataTransfer) event.dataTransfer.dropEffect = 'move';
            clearIndicators();
            const rect = tab.getBoundingClientRect();
            tab.addClass(
                event.clientX < rect.left + rect.width / 2
                    ? 'is-drag-over-before'
                    : 'is-drag-over-after',
            );
        });
        tab.addEventListener('drop', async event => {
            if (!dragged || dragged === tab) return;
            event.preventDefault();
            const rect = tab.getBoundingClientRect();
            const insertAfter = event.clientX >= rect.left + rect.width / 2;
            tabs.insertBefore(dragged, insertAfter ? tab.nextSibling : tab);
            suppressClickUntil = Date.now() + 250;
            clearIndicators();

            const order = Array.from(tabs.querySelectorAll<HTMLButtonElement>('.codex-tab[data-category-id]'))
                .map(element => element.dataset.categoryId)
                .filter((id): id is string => !!id);
            plugin.settings.libraryCategoryOrder = order;

            // Keep generic category consumers (such as the view switcher) in the same order.
            const enabled = new Set(plugin.settings.codexEnabledCategories || []);
            const orderedCodex = order.filter(id =>
                id !== 'characters' && id !== 'locations' && enabled.has(id));
            for (const id of plugin.settings.codexEnabledCategories || []) {
                if (!orderedCodex.includes(id)) orderedCodex.push(id);
            }
            plugin.settings.codexEnabledCategories = orderedCodex;
            await plugin.saveSettings();
            onCategoriesChanged?.();
        });
        tab.addEventListener('dragend', () => {
            tab.removeClass('is-dragging');
            clearIndicators();
            dragged = null;
        });
    }
}

function attachRenameMenu(
    tab: HTMLElement,
    plugin: SceneCardsPlugin,
    categoryId: string,
    onCategoriesChanged?: () => void,
    allowDelete: boolean = false,
    onDeleted?: () => void,
): void {
    tab.addEventListener('contextmenu', (e) => {
        e.preventDefault();
        e.stopPropagation();
        const menu = new obsidian.Menu();
        menu.addItem(item => item
            .setTitle(t('Rename…'))
            .setIcon('pencil')
            .onClick(() => {
                promptRenameCategory(plugin, categoryId, onCategoriesChanged);
            }));
        if (!FIXED_PROFILE_CATEGORY_IDS.has(categoryId) && categoryId !== UNCATEGORIZED_CATEGORY_ID) {
            const profileEnabled = isLibraryCategoryProfilePageEnabled(plugin, categoryId);
            menu.addItem(item => item
                .setTitle(t(profileEnabled ? 'Disable profile page' : 'Enable profile page'))
                .setIcon('contact')
                .setChecked(profileEnabled)
                .onClick(() => {
                    void setLibraryCategoryProfilePage(
                        plugin,
                        categoryId,
                        !profileEnabled,
                        onCategoriesChanged,
                    );
                }));
        }
        if (allowDelete) {
            menu.addItem(item => item
                .setTitle(t('Delete'))
                .setIcon('trash')
                .onClick(() => {
                    promptDeleteCategory(plugin, categoryId, onDeleted);
                }));
        }
        menu.showAtMouseEvent(e);
    });
}

function isLibraryCategoryProfilePageEnabled(
    plugin: SceneCardsPlugin,
    categoryId: string,
): boolean {
    if (FIXED_PROFILE_CATEGORY_IDS.has(categoryId)) return true;
    return plugin.settings.codexCustomCategories
        ?.find(category => category.id === categoryId)
        ?.hasProfilePage === true;
}

async function setLibraryCategoryProfilePage(
    plugin: SceneCardsPlugin,
    categoryId: string,
    enabled: boolean,
    onCategoriesChanged?: () => void,
): Promise<void> {
    const previousCategories = (plugin.settings.codexCustomCategories || []).map(category => ({ ...category }));
    const previousLayout = { ...(plugin.settings.libraryBrowseLayout || {}) };
    const previousSidebar = [...(plugin.settings.codexSidebarCategories || [])];
    const resolved = plugin.codexManager.getCategoryDef(categoryId);
    const builtin = getBuiltinCodexCategory(categoryId);
    const fallback = {
        id: categoryId,
        label: resolveLibraryCategoryLabel(
            plugin,
            categoryId,
            resolved?.label || builtin?.label || plugin.sceneManager.getLibraryFolderName(categoryId),
        ),
        icon: resolved?.icon || builtin?.icon || 'file-text',
        preset: Boolean(builtin),
    };
    plugin.settings.codexCustomCategories = setLibraryCategoryProfileSetting(
        plugin.settings.codexCustomCategories || [],
        fallback,
        enabled,
    );

    if (!plugin.settings.libraryBrowseLayout) plugin.settings.libraryBrowseLayout = {};
    if (enabled && !plugin.settings.libraryBrowseLayout[categoryId]) {
        plugin.settings.libraryBrowseLayout[categoryId] = 'cards';
    }
    const sidebar = new Set(plugin.settings.codexSidebarCategories || []);
    if (enabled) sidebar.add(categoryId);
    else sidebar.delete(categoryId);
    plugin.settings.codexSidebarCategories = Array.from(sidebar);

    try {
        await plugin.saveSettings();
    } catch (error) {
        plugin.settings.codexCustomCategories = previousCategories;
        plugin.settings.libraryBrowseLayout = previousLayout;
        plugin.settings.codexSidebarCategories = previousSidebar;
        console.error('[NarrativeLab] Failed to update Library category profile page:', error);
        new obsidian.Notice(t('Failed to update profile page'));
        return;
    }
    try {
        const customDefs = (plugin.settings.codexCustomCategories || []).map(category =>
            category.hasProfilePage
                ? makeProfileCodexCategory(category.id, category.label, category.icon)
                : makeCustomCodexCategory(category.id, category.label, category.icon));
        plugin.codexManager.initCategories(plugin.settings.codexEnabledCategories || [], customDefs);
        applyCategoryFolderLabels(plugin);
        plugin.libraryCategoriesStructureEpoch += 1;
        await plugin.reloadEntities();
        onCategoriesChanged?.();
        void plugin.refreshOpenViews();
        new obsidian.Notice(t(enabled ? 'Profile page enabled' : 'Profile page disabled'));
    } catch (error) {
        console.error('[NarrativeLab] Library category profile page saved but refresh failed:', error);
        new obsidian.Notice(t('Profile page setting saved; refresh the view to apply it.'));
    }
}

export function promptDeleteCategory(
    plugin: SceneCardsPlugin,
    categoryId: string,
    onDeleted?: () => void,
): void {
    const name = resolveLibraryCategoryLabel(
        plugin,
        categoryId,
        plugin.sceneManager.getLibraryFolderName(categoryId),
    );
    const modal = new obsidian.Modal(plugin.app);
    modal.titleEl.setText(t('Delete Library category'));
    modal.contentEl.createEl('p', {
        text: t('What should happen to the entries in “{name}”?', { name }),
    });
    modal.contentEl.createEl('p', {
        cls: 'setting-item-description',
        text: t('Move keeps every file by placing it directly in the Library root (Uncategorized entries). Delete moves the entire category folder to the trash.'),
    });
    modal.contentEl.createEl('p', {
        cls: 'setting-item-description mod-warning',
        text: t('Both options remove this category from the project and delete its linked Base, field templates, table layout, sorting, formulas, and Story Graph color settings.'),
    });
    if (plugin.sceneManager.activeProject?.seriesId) {
        modal.contentEl.createEl('p', {
            cls: 'setting-item-description mod-warning',
            text: t('This category is stored in the shared series Library. Deleting it affects every project in the series.'),
        });
    }
    new obsidian.Setting(modal.contentEl)
        .addButton(button => button
            .setButtonText(t('Cancel'))
            .onClick(() => modal.close()))
        .addButton(button => button
            .setButtonText(t('Move to Uncategorized'))
            .setCta()
            .onClick(async () => {
                modal.close();
                const deleted = await deleteLibraryCategory(plugin, categoryId, 'move-to-root');
                if (deleted) onDeleted?.();
            }))
        .addButton(button => button
            .setButtonText(t('Delete entries and folder'))
            .setClass('mod-warning')
            .onClick(async () => {
                modal.close();
                const deleted = await deleteLibraryCategory(plugin, categoryId, 'trash');
                if (deleted) onDeleted?.();
            }));
    modal.open();
}

function promptRenameCategory(
    plugin: SceneCardsPlugin,
    categoryId: string,
    onCategoriesChanged?: () => void,
): void {
    const current = resolveLibraryCategoryLabel(
        plugin,
        categoryId,
        plugin.sceneManager.getLibraryFolderName(categoryId),
    );
    const modal = new obsidian.Modal(plugin.app);
    modal.titleEl.setText(t('Rename Library tab'));
    modal.contentEl.createEl('p', {
        cls: 'setting-item-description',
        text: t('Tab name matches the Library folder name.'),
    });

    let value = current;
    new obsidian.Setting(modal.contentEl)
        .setName(t('Name'))
        .addText(text => {
            text.setValue(current);
            text.onChange(v => { value = v; });
            window.setTimeout(() => {
                text.inputEl.focus();
                text.inputEl.select();
            }, 20);
            text.inputEl.addEventListener('keydown', (ev) => {
                if (ev.key === 'Enter') {
                    ev.preventDefault();
                    void commit();
                }
            });
        });

    const commit = async () => {
        modal.close();
        const ok = await renameLibraryCategory(plugin, categoryId, value);
        if (!ok) return;
        await plugin.reloadEntities();
        onCategoriesChanged?.();
        plugin.refreshOpenViews();
    };

    new obsidian.Setting(modal.contentEl)
        .addButton(btn => btn.setButtonText(t('Cancel')).onClick(() => modal.close()))
        .addButton(btn => btn.setButtonText(t('Rename')).setCta().onClick(() => void commit()));

    modal.open();
}

function switchTo(
    leaf: obsidian.WorkspaceLeaf,
    plugin: SceneCardsPlugin,
    viewType: string,
    categoryId?: string,
): void {
    if (categoryId) rememberLibraryCategory(plugin, categoryId);
    try {
        leaf.setViewState({
            type: viewType,
            active: true,
            state: preservedNarrativeLabLeafState(leaf),
        });
        plugin.app.workspace.revealLeaf(leaf);
    } catch {
        plugin.activateView(viewType);
    }
}
/* eslint-enable @typescript-eslint/no-floating-promises, @typescript-eslint/no-misused-promises, @typescript-eslint/no-redundant-type-constituents -- end of file-wide suppression block opened at line 1 */
