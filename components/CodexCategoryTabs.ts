/* eslint-disable @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-argument, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-return, @typescript-eslint/no-floating-promises, @typescript-eslint/no-misused-promises, @typescript-eslint/no-unnecessary-type-assertion, @typescript-eslint/no-redundant-type-constituents, @typescript-eslint/no-unused-vars, no-unused-vars, no-useless-escape, no-control-regex, no-empty -- Obsidian's API surface and several untyped third-party libraries force dynamic dispatch; floating promises are intentional in DOM/event handlers; matching enable at end of file */
/**
 * Shared Codex category tab bar — rendered in CodexView, CharacterView, and LocationView
 * so the user can switch between categories from any of those views.
 *
 * Tab labels always equal the Library/<folder> basename (not i18n).
 * Right-click a tab to rename the folder + label together.
 */
import * as obsidian from 'obsidian';
import type SceneCardsPlugin from '../main';
import { CHARACTER_VIEW_TYPE, LOCATION_VIEW_TYPE, CODEX_VIEW_TYPE } from '../constants';
import { renderLibraryModeToggle } from './LibraryModeBar';
import { deleteLibraryCategory, renameLibraryCategory } from '../services/LibraryCategorySync';
import { t } from '../utils/i18n';
import { UNCATEGORIZED_CATEGORY_ID } from '../models/Codex';

export interface CodexTabsOptions {
    /** The view type that should be highlighted as active ('Characters' | 'Locations' | category id) */
    activeId: 'characters-pseudo' | 'locations-pseudo' | string;
    /** The WorkspaceLeaf to set view state on */
    leaf: obsidian.WorkspaceLeaf;
    /** Plugin instance */
    plugin: SceneCardsPlugin;
    /** Show Browse / Story Graph toggle on the right of the tab bar */
    showModeToggle?: boolean;
    /** Called when Browse / Story Graph mode changes */
    onModeChange?: () => void;
    /** Optional controls rendered immediately before Browse / Story Graph. */
    renderBeforeModeActions?: (container: HTMLElement) => void;
    /** Optional controls rendered immediately after Browse / Story Graph. */
    renderAfterModeActions?: (container: HTMLElement) => void;
    /** Called after a successful tab/folder rename (views should re-render) */
    onCategoriesChanged?: () => void;
}

/**
 * Render the Codex category tab bar into `parent`.
 * Includes Characters, Locations, and all user-defined codex categories.
 * Optionally appends the Library Browse / Story Graph mode toggle.
 */
export function renderCodexCategoryTabs(parent: HTMLElement, opts: CodexTabsOptions): HTMLElement {
    const {
        activeId,
        leaf,
        plugin,
        showModeToggle,
        onModeChange,
        onCategoriesChanged,
        renderBeforeModeActions,
        renderAfterModeActions,
    } = opts;

    const tabs = parent.createDiv('codex-category-tabs');
    const renderedTabs: Array<{ id: string; el: HTMLButtonElement }> = [];
    const hiddenFixed = new Set(plugin.settings.libraryHiddenFixedCategories || []);
    const categoryOverrides = plugin.settings.codexCustomCategories || [];
    const overrideFor = (id: string) => categoryOverrides.find(category => category.id === id);
    const charName = plugin.sceneManager.getLibraryFolderName('characters');
    const locName = plugin.sceneManager.getLibraryFolderName('locations');

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
            charTab.addEventListener('click', () => switchTo(leaf, plugin, CHARACTER_VIEW_TYPE));
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
            locTab.addEventListener('click', () => switchTo(leaf, plugin, LOCATION_VIEW_TYPE));
        }
        attachRenameMenu(locTab, plugin, 'locations', onCategoriesChanged);
        renderedTabs.push({ id: 'locations', el: locTab });
    }

    // ── Custom / built-in codex categories ──
    const cats = plugin.codexManager.getCategories()
        .filter(category => category.id !== UNCATEGORIZED_CATEGORY_ID);
    for (const cat of cats) {
        const isActive = activeId === cat.id;
        const tab = tabs.createEl('button', {
            cls: `codex-tab ${isActive ? 'active' : ''}`,
            attr: { 'aria-label': cat.label, type: 'button', 'data-category-id': cat.id },
        });
        const icon = tab.createSpan({ cls: 'codex-tab-icon' });
        obsidian.setIcon(icon, cat.icon);
        tab.createSpan({ cls: 'codex-tab-label', text: cat.label });
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
                // Already on CodexView — switch category without remounting the leaf
                if (leaf.view?.getViewType?.() === CODEX_VIEW_TYPE) {
                    const view = leaf.view as unknown as { setActiveCategory?: (id: string) => void };
                    view.setActiveCategory?.(cat.id);
                    return;
                }
                // Navigate to CodexView with this category active
                try {
                    void leaf.setViewState({ type: CODEX_VIEW_TYPE, active: true, state: {} });
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

    // Uncategorized remains a fixed definition and, when shown, is always last.
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
                if (leaf.view?.getViewType?.() === CODEX_VIEW_TYPE) {
                    const view = leaf.view as unknown as { setActiveCategory?: (id: string) => void };
                    view.setActiveCategory?.(UNCATEGORIZED_CATEGORY_ID);
                    return;
                }
                try {
                    void leaf.setViewState({ type: CODEX_VIEW_TYPE, active: true, state: {} });
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
    }

    // Keep the complete right-side action cluster together so no controls
    // overflow past the edge when category labels consume more room.
    if (
        (showModeToggle !== false && onModeChange)
        || renderBeforeModeActions
        || renderAfterModeActions
    ) {
        const actions = tabs.createDiv('codex-category-actions');
        renderBeforeModeActions?.(actions);
        if (showModeToggle !== false && onModeChange) {
            renderLibraryModeToggle(actions, plugin, onModeChange);
        }
        renderAfterModeActions?.(actions);
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

export function promptDeleteCategory(
    plugin: SceneCardsPlugin,
    categoryId: string,
    onDeleted?: () => void,
): void {
    const name = plugin.sceneManager.getLibraryFolderName(categoryId);
    const modal = new obsidian.Modal(plugin.app);
    modal.titleEl.setText(t('Delete Library category'));
    modal.contentEl.createEl('p', {
        text: t('What should happen to the entries in “{name}”?', { name }),
    });
    modal.contentEl.createEl('p', {
        cls: 'setting-item-description',
        text: t('Move keeps every file by placing it directly in the Library root (Uncategorized entries). Delete moves the entire category folder to the trash.'),
    });
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
    const current = plugin.sceneManager.getLibraryFolderName(categoryId);
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

function switchTo(leaf: obsidian.WorkspaceLeaf, plugin: SceneCardsPlugin, viewType: string): void {
    try {
        leaf.setViewState({ type: viewType, active: true, state: {} });
        plugin.app.workspace.revealLeaf(leaf);
    } catch {
        plugin.activateView(viewType);
    }
}
/* eslint-enable @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-argument, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-return, @typescript-eslint/no-floating-promises, @typescript-eslint/no-misused-promises, @typescript-eslint/no-unnecessary-type-assertion, @typescript-eslint/no-redundant-type-constituents, @typescript-eslint/no-unused-vars, no-unused-vars, no-useless-escape, no-control-regex, no-empty -- end of file-wide suppression block opened at line 1 */
