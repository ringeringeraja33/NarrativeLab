/* eslint-disable @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-argument, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-return, @typescript-eslint/no-floating-promises, @typescript-eslint/no-misused-promises, @typescript-eslint/no-unnecessary-type-assertion, @typescript-eslint/no-redundant-type-constituents, @typescript-eslint/no-unused-vars, no-unused-vars, no-useless-escape, no-control-regex, no-empty -- Obsidian's API surface and several untyped third-party libraries force dynamic dispatch; floating promises are intentional in DOM/event handlers; matching enable at end of file */
/**
 * Shared Codex category tab bar — rendered in CodexView, CharacterView, and LocationView
 * so the user can switch between categories from any of those views.
 */
import * as obsidian from 'obsidian';
import type SceneCardsPlugin from '../main';
import { CHARACTER_VIEW_TYPE, LOCATION_VIEW_TYPE, CODEX_VIEW_TYPE } from '../constants';
import { t } from '../utils/i18n';

export interface CodexTabsOptions {
    /** The view type that should be highlighted as active ('Characters' | 'Locations' | category id) */
    activeId: 'characters-pseudo' | 'locations-pseudo' | string;
    /** The WorkspaceLeaf to set view state on */
    leaf: obsidian.WorkspaceLeaf;
    /** Plugin instance */
    plugin: SceneCardsPlugin;
}

/**
 * Render the Codex category tab bar into `parent`.
 * Includes Characters, Locations, and all user-defined codex categories.
 */
export function renderCodexCategoryTabs(parent: HTMLElement, opts: CodexTabsOptions): HTMLElement {
    const { activeId, leaf, plugin } = opts;

    const tabs = parent.createDiv('codex-category-tabs');

    // ── Characters pseudo-tab ──
    const charTab = tabs.createEl('button', {
        cls: `codex-tab codex-pseudo-tab ${activeId === 'characters-pseudo' ? 'active' : ''}`,
        attr: { 'aria-label': t('Characters') },
    });
    const charIcon = charTab.createSpan({ cls: 'codex-tab-icon' });
    obsidian.setIcon(charIcon, 'users');
    charTab.createSpan({ cls: 'codex-tab-label', text: t('Characters') });
    if (activeId !== 'characters-pseudo') {
        charTab.addEventListener('click', () => switchTo(leaf, plugin, CHARACTER_VIEW_TYPE));
    }

    // ── Locations pseudo-tab ──
    const locTab = tabs.createEl('button', {
        cls: `codex-tab codex-pseudo-tab ${activeId === 'locations-pseudo' ? 'active' : ''}`,
        attr: { 'aria-label': t('Locations') },
    });
    const locIcon = locTab.createSpan({ cls: 'codex-tab-icon' });
    obsidian.setIcon(locIcon, 'map-pin');
    locTab.createSpan({ cls: 'codex-tab-label', text: t('Locations') });
    if (activeId !== 'locations-pseudo') {
        locTab.addEventListener('click', () => switchTo(leaf, plugin, LOCATION_VIEW_TYPE));
    }

    // ── Custom codex categories ──
    const cats = plugin.codexManager.getCategories();
    for (const cat of cats) {
        const isActive = activeId === cat.id;
        const tab = tabs.createEl('button', {
            cls: `codex-tab ${isActive ? 'active' : ''}`,
            attr: { 'aria-label': cat.label },
        });
        const icon = tab.createSpan({ cls: 'codex-tab-icon' });
        obsidian.setIcon(icon, cat.icon);
        tab.createSpan({ cls: 'codex-tab-label', text: cat.label });

        if (!isActive) {
            tab.addEventListener('click', () => {
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
    }

    return tabs;
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
