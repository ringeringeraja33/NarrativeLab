/* eslint-disable @typescript-eslint/no-unnecessary-type-assertion -- Obsidian's API surface and several untyped third-party libraries force dynamic dispatch; floating promises are intentional in DOM/event handlers; matching enable at end of file */
/**
 * Library Browse layout mode (list / cards / table) — Bases-style toggle
 * shared by Characters, Locations, and Codex category overviews.
 */
import * as obsidian from 'obsidian';
import { Menu } from 'obsidian';
import type SceneCardsPlugin from '../main';
import { t } from '../utils/i18n';

export type LibraryBrowseLayout = 'list' | 'cards' | 'table';

/** First-paint window for cards/table (ncanvas-style). */
export const LIBRARY_BROWSE_PAGE_SIZE = 80;

const DEFAULT_LAYOUT: Record<string, LibraryBrowseLayout> = {
    characters: 'cards',
    locations: 'list',
};

export function getLibraryBrowseLayout(plugin: SceneCardsPlugin, categoryId: string): LibraryBrowseLayout {
    const map = plugin.settings.libraryBrowseLayout || {};
    const saved = map[categoryId];
    if (saved === 'list' || saved === 'cards' || saved === 'table') return saved;
    if (DEFAULT_LAYOUT[categoryId]) return DEFAULT_LAYOUT[categoryId];
    // Codex categories default to list
    return 'list';
}

export async function setLibraryBrowseLayout(
    plugin: SceneCardsPlugin,
    categoryId: string,
    layout: LibraryBrowseLayout,
): Promise<void> {
    if (!plugin.settings.libraryBrowseLayout) plugin.settings.libraryBrowseLayout = {};
    plugin.settings.libraryBrowseLayout[categoryId] = layout;
    await plugin.saveSettings();
}

export function getLibraryTableColumns(plugin: SceneCardsPlugin, categoryId: string): string[] | undefined {
    return plugin.settings.libraryTableColumns?.[categoryId];
}

export async function setLibraryTableColumns(
    plugin: SceneCardsPlugin,
    categoryId: string,
    columns: string[],
): Promise<void> {
    if (!plugin.settings.libraryTableColumns) plugin.settings.libraryTableColumns = {};
    plugin.settings.libraryTableColumns[categoryId] = columns;
    await plugin.saveSettings();
}

export interface LibraryTableSort {
    key: string;
    direction: 'asc' | 'desc';
}

export function getLibraryTableSort(
    plugin: SceneCardsPlugin,
    categoryId: string,
): LibraryTableSort | undefined {
    return plugin.settings.libraryTableSort?.[categoryId];
}

export async function setLibraryTableSort(
    plugin: SceneCardsPlugin,
    categoryId: string,
    sort: LibraryTableSort,
): Promise<void> {
    if (!plugin.settings.libraryTableSort) plugin.settings.libraryTableSort = {};
    plugin.settings.libraryTableSort[categoryId] = sort;
    await plugin.saveSettings();
}

export function compareLibraryTableValues(left: unknown, right: unknown): number {
    const normalize = (value: unknown): string | number => {
        if (value === undefined || value === null) return '';
        if (typeof value === 'number') return value;
        if (typeof value === 'string' || typeof value === 'boolean' || typeof value === 'bigint') return String(value);
        if (Array.isArray(value)) return value.map(item => safeDisplayValue(item)).join(', ');
        return safeDisplayValue(value);
    };
    const a = normalize(left);
    const b = normalize(right);
    if (typeof a === 'number' && typeof b === 'number') return a - b;
    return String(a).localeCompare(String(b), undefined, { numeric: true, sensitivity: 'base' });
}

export function renderLibraryTableHeader(
    row: HTMLTableRowElement,
    label: string,
    key: string,
    currentSort: LibraryTableSort | undefined,
    onSort: (sort: LibraryTableSort) => void,
): HTMLTableCellElement {
    const active = currentSort?.key === key;
    const th = row.createEl('th');
    th.createSpan({ cls: 'library-base-table-header-label', text: label });
    const button = th.createEl('button', {
        cls: `library-base-table-sort${active ? ' is-active' : ''}`,
        attr: {
            type: 'button',
            title: t('Sort by {property}', { property: label }),
            'aria-label': t('Sort by {property}', { property: label }),
        },
    });
    obsidian.setIcon(button, active
        ? (currentSort?.direction === 'asc' ? 'arrow-up' : 'arrow-down')
        : 'arrow-up-down');
    button.addEventListener('click', event => {
        event.stopPropagation();
        onSort({
            key,
            direction: active && currentSort?.direction === 'asc' ? 'desc' : 'asc',
        });
    });
    return th;
}

export interface LibraryTableFormula {
    id: string;
    name: string;
    expression: string;
}

export function getLibraryTableFormulas(
    plugin: SceneCardsPlugin,
    categoryId: string,
): LibraryTableFormula[] {
    return (plugin.settings.libraryTableFormulas?.[categoryId] || []).map(formula => ({ ...formula }));
}

export async function setLibraryTableFormulas(
    plugin: SceneCardsPlugin,
    categoryId: string,
    formulas: LibraryTableFormula[],
): Promise<void> {
    if (!plugin.settings.libraryTableFormulas) plugin.settings.libraryTableFormulas = {};
    plugin.settings.libraryTableFormulas[categoryId] = formulas.map(formula => ({ ...formula }));
    await plugin.saveSettings();
}

export function getLibraryFilePropertyOptions(): LibraryBrowsePropertyOption[] {
    return [
        'file.name',
        'file.tags',
        'file.mtime',
        'file.ctime',
        'file.backlinks',
        'file.basename',
        'file.embeds',
        'file.extension',
        'file.folder',
        'file.fullname',
        'file.links',
        'file.path',
        'file.size',
    ].map(key => ({ key, label: key, type: 'file' as const }));
}

export function getLibraryNotePropertyOptions(
    plugin: SceneCardsPlugin,
    filePaths: string[],
): LibraryBrowsePropertyOption[] {
    const keys = new Set<string>();
    for (const filePath of filePaths) {
        const file = plugin.app.vault.getAbstractFileByPath(filePath);
        if (!(file instanceof obsidian.TFile)) continue;
        const frontmatter = plugin.app.metadataCache.getFileCache(file)?.frontmatter;
        if (!frontmatter) continue;
        for (const key of Object.keys(frontmatter)) {
            if (key !== 'position') keys.add(key);
        }
    }
    return Array.from(keys)
        .sort((a, b) => a.localeCompare(b))
        .map(key => ({ key, label: key, type: 'note' as const }));
}

export function getLibraryNotePropertyValue(
    plugin: SceneCardsPlugin,
    filePath: string,
    key: string,
): unknown {
    const file = plugin.app.vault.getAbstractFileByPath(filePath);
    if (!(file instanceof obsidian.TFile)) return undefined;
    return plugin.app.metadataCache.getFileCache(file)?.frontmatter?.[key];
}

export function getLibraryFilePropertyValue(
    plugin: SceneCardsPlugin,
    filePath: string,
    key: string,
): string {
    const file = plugin.app.vault.getAbstractFileByPath(filePath);
    if (!(file instanceof obsidian.TFile)) return '';
    const cache = plugin.app.metadataCache.getFileCache(file);
    switch (key) {
        case 'file.name': return file.basename;
        case 'file.tags':
            return cache ? (obsidian.getAllTags(cache) || []).join(', ') : '';
        case 'file.mtime':
            return new Date(file.stat.mtime).toLocaleString();
        case 'file.ctime':
            return new Date(file.stat.ctime).toLocaleString();
        case 'file.backlinks': {
            let count = 0;
            for (const targets of Object.values(plugin.app.metadataCache.resolvedLinks)) {
                if (targets[file.path]) count += targets[file.path];
            }
            return String(count);
        }
        case 'file.basename': return file.basename;
        case 'file.embeds':
            return (cache?.embeds || []).map(embed => embed.link).join(', ');
        case 'file.extension': return file.extension;
        case 'file.folder': return file.parent?.path || '';
        case 'file.fullname': return file.name;
        case 'file.links':
            return Object.keys(plugin.app.metadataCache.resolvedLinks[file.path] || {}).join(', ');
        case 'file.path': return file.path;
        case 'file.size': return String(file.stat.size);
        default: return '';
    }
}

/** Lightweight computed column: replaces {{propertyKey}} tokens with row values. */
export function evaluateLibraryTableFormula(
    expression: string,
    resolveValue: (key: string) => unknown,
): string {
    return expression.replace(/\{\{\s*([^}]+?)\s*\}\}/g, (_match, key: string) => {
        const value = resolveValue(key.trim());
        if (value === undefined || value === null) return '';
        return Array.isArray(value)
            ? value.map(item => safeDisplayValue(item)).join(', ')
            : safeDisplayValue(value);
    });
}

function safeDisplayValue(value: unknown): string {
    if (typeof value === 'string') return value;
    if (typeof value === 'number' || typeof value === 'boolean' || typeof value === 'bigint') return String(value);
    try {
        const serialized = JSON.stringify(value);
        return typeof serialized === 'string' ? serialized : '';
    } catch {
        return '';
    }
}

const LAYOUT_OPTS: Array<{ id: LibraryBrowseLayout; icon: string; label: string }> = [
    { id: 'list', icon: 'list', label: 'List' },
    { id: 'cards', icon: 'layout-grid', label: 'Cards' },
    { id: 'table', icon: 'table', label: 'Table view' },
];

/**
 * Render list / cards / table toggle into a search row (or any parent).
 */
export function renderLibraryLayoutToggle(
    parent: HTMLElement,
    plugin: SceneCardsPlugin,
    categoryId: string,
    onChange: () => void,
): HTMLElement {
    const current = getLibraryBrowseLayout(plugin, categoryId);
    const bar = parent.createDiv('library-layout-toggle');

    for (const opt of LAYOUT_OPTS) {
        const btn = bar.createEl('button', {
            cls: `library-layout-btn ${current === opt.id ? 'is-active' : ''}`,
            attr: {
                type: 'button',
                'aria-label': t(opt.label),
                title: t(opt.label),
            },
        });
        const icon = btn.createSpan({ cls: 'library-layout-btn-icon' });
        obsidian.setIcon(icon, opt.icon);
        btn.addEventListener('click', () => {
            if (getLibraryBrowseLayout(plugin, categoryId) === opt.id) return;
            void setLibraryBrowseLayout(plugin, categoryId, opt.id).then(onChange);
        });
    }

    return bar;
}

/** Slice items for first paint; returns { visible, hasMore }. */
export function pageSlice<T>(items: T[], shown: number): { visible: T[]; hasMore: boolean } {
    const n = Math.max(0, shown);
    return {
        visible: items.slice(0, n),
        hasMore: items.length > n,
    };
}

export interface LibraryBrowseSortOption {
    value: string;
    label: string;
}

export interface LibraryBrowsePropertyOption {
    key: string;
    label: string;
    type?: 'note' | 'file' | 'formula';
}

export interface LibraryBrowseToolbarOpts {
    plugin: SceneCardsPlugin;
    categoryId: string;
    sortOptions: LibraryBrowseSortOption[];
    sortBy: string;
    onSortChange: (value: string) => void;
    searchText: string;
    searchPlaceholder: string;
    searchOpen: boolean;
    onSearchOpenChange: (open: boolean) => void;
    onSearchChange: (value: string) => void;
    /** Debounce ms for search input (default 180). */
    searchDebounceMs?: number;
    filterOpen: boolean;
    filterCount: number;
    onFilterOpenChange: (open: boolean) => void;
    properties?: LibraryBrowsePropertyOption[];
    selectedProperties?: string[];
    onPropertiesChange?: (keys: string[]) => void | Promise<void>;
    onNew?: (ev: MouseEvent) => void;
    newLabel?: string;
    onLayoutChange: () => void;
    /** When false, hide list/cards/table switcher (e.g. Character Profiles). */
    showLayoutToggle?: boolean;
    /** Optional controls after New (e.g. series book filter). */
    appendExtra?: (actionsEl: HTMLElement) => void;
    /** Content-mode controls aligned to the far right of the toolbar. */
    renderTrailingActions?: (actionsEl: HTMLElement) => void;
}

export interface LibraryBrowseToolbarResult {
    root: HTMLElement;
    searchInput: HTMLInputElement | null;
    chipHost: HTMLElement;
}

function makeBrowseActionBtn(
    parent: HTMLElement,
    opts: { icon: string; label: string; cls?: string; title?: string },
): HTMLButtonElement {
    const btn = parent.createEl('button', {
        cls: `library-browse-action ${opts.cls || ''}`,
        attr: {
            type: 'button',
            title: opts.title || opts.label,
            'aria-label': opts.label,
        },
    });
    const icon = btn.createSpan({ cls: 'library-browse-action-icon' });
    obsidian.setIcon(icon, opts.icon);
    btn.createSpan({ cls: 'library-browse-action-label', text: opts.label });
    return btn;
}

function openLibraryFormulaModal(
    opts: LibraryBrowseToolbarOpts,
    existing?: LibraryTableFormula,
): void {
    const modal = new obsidian.Modal(opts.plugin.app);
    modal.titleEl.setText(existing ? t('Edit formula') : t('Add formula'));
    let name = existing?.name || '';
    let expression = existing?.expression || '';

    new obsidian.Setting(modal.contentEl)
        .setName(t('Formula name'))
        .addText(text => text
            .setValue(name)
            .onChange(value => { name = value; }));
    new obsidian.Setting(modal.contentEl)
        .setName(t('Formula'))
        .setDesc(t('Use {{property}} placeholders, for example {{name}} · {{entryType}}.'))
        .addTextArea(textarea => textarea
            .setValue(expression)
            .onChange(value => { expression = value; }));
    const actions = new obsidian.Setting(modal.contentEl);
    if (existing) {
        actions.addButton(button => button
            .setButtonText(t('Delete'))
            .setWarning()
            .onClick(async () => {
                const formulas = getLibraryTableFormulas(opts.plugin, opts.categoryId)
                    .filter(formula => formula.id !== existing.id);
                await setLibraryTableFormulas(opts.plugin, opts.categoryId, formulas);
                await opts.onPropertiesChange?.(
                    (opts.selectedProperties || []).filter(key => key !== `formula:${existing.id}`),
                );
                modal.close();
                opts.onLayoutChange();
            }));
    }
    actions.addButton(button => button
        .setButtonText(t('Save'))
        .setCta()
        .onClick(async () => {
            const cleanName = name.trim();
            if (!cleanName || !expression.trim()) return;
            const formulas = getLibraryTableFormulas(opts.plugin, opts.categoryId);
            const formula: LibraryTableFormula = {
                id: existing?.id || `formula-${Date.now().toString(36)}`,
                name: cleanName,
                expression: expression.trim(),
            };
            const index = formulas.findIndex(item => item.id === formula.id);
            if (index >= 0) formulas[index] = formula;
            else formulas.push(formula);
            await setLibraryTableFormulas(opts.plugin, opts.categoryId, formulas);
            if (!existing) {
                await opts.onPropertiesChange?.([
                    ...(opts.selectedProperties || []),
                    `formula:${formula.id}`,
                ]);
            }
            modal.close();
            opts.onLayoutChange();
        }));
    modal.open();
}

function openLibraryPropertiesPopover(
    button: HTMLButtonElement,
    opts: LibraryBrowseToolbarOpts,
): void {
    activeDocument.querySelectorAll('.library-properties-popover').forEach(element => element.remove());

    const formulas = getLibraryTableFormulas(opts.plugin, opts.categoryId);
    const formulaOptions: LibraryBrowsePropertyOption[] = formulas.map(formula => ({
        key: `formula:${formula.id}`,
        label: formula.name,
        type: 'formula',
    }));
    const options = [...(opts.properties || []), ...formulaOptions];
    const optionByKey = new Map(options.map(option => [option.key, option]));
    let selectedOrder = (opts.selectedProperties || []).filter(key => optionByKey.has(key));
    let query = '';
    let draggedKey: string | null = null;

    const popover = activeDocument.body.createDiv('library-properties-popover');
    const rect = button.getBoundingClientRect();
    popover.setCssStyles({
        position: 'fixed',
        left: `${Math.min(rect.left, window.innerWidth - 320)}px`,
        top: `${Math.min(rect.bottom + 4, window.innerHeight - 500)}px`,
    });
    popover.createDiv({ cls: 'library-properties-title', text: t('Properties') });
    const search = popover.createEl('input', {
        cls: 'library-properties-search',
        attr: { type: 'search', placeholder: t('Find or create…') },
    });
    const list = popover.createDiv('library-properties-list');
    const footer = popover.createDiv('library-properties-footer');

    const close = () => {
        popover.remove();
        activeDocument.removeEventListener('pointerdown', onOutside, true);
        activeDocument.removeEventListener('keydown', onKeyDown, true);
    };
    const commit = async (next: string[]) => {
        selectedOrder = next;
        close();
        await opts.onPropertiesChange?.(next);
    };
    const onOutside = (event: Event) => {
        if (!popover.contains(event.target as Node) && event.target !== button) close();
    };
    const onKeyDown = (event: KeyboardEvent) => {
        if (event.key === 'Escape') close();
    };

    const renderList = () => {
        list.empty();
        const selected = new Set(selectedOrder);
        const ordered = [
            ...selectedOrder.map(key => optionByKey.get(key)).filter((option): option is LibraryBrowsePropertyOption => !!option),
            ...options.filter(option => !selected.has(option.key)),
        ].filter(option => !query || option.label.toLowerCase().includes(query)
            || option.key.toLowerCase().includes(query));

        for (const option of ordered) {
            const row = list.createDiv(`library-properties-row${selected.has(option.key) ? ' is-selected' : ''}`);
            row.dataset.propertyKey = option.key;
            row.draggable = selected.has(option.key);
            const checkbox = row.createEl('input', {
                cls: 'library-properties-check',
                attr: { type: 'checkbox' },
            }) as HTMLInputElement;
            checkbox.checked = selected.has(option.key);
            const icon = row.createSpan('library-properties-type-icon');
            obsidian.setIcon(icon, option.type === 'formula' ? 'sigma' : option.type === 'file' ? 'file' : 'text');
            row.createSpan({ cls: 'library-properties-label', text: option.label });

            const edit = row.createEl('button', {
                cls: 'library-properties-edit',
                attr: { type: 'button', 'aria-label': t('Property options') },
            });
            obsidian.setIcon(edit, 'chevron-right');
            edit.addEventListener('click', event => {
                event.stopPropagation();
                if (option.type === 'formula') {
                    close();
                    const id = option.key.slice('formula:'.length);
                    const formula = formulas.find(item => item.id === id);
                    if (formula) openLibraryFormulaModal(opts, formula);
                    return;
                }
                const menu = new Menu();
                menu.addItem(item => item
                    .setTitle(selected.has(option.key) ? t('Hide property') : t('Show property'))
                    .setIcon(selected.has(option.key) ? 'eye-off' : 'eye')
                    .onClick(() => {
                        const next = selected.has(option.key)
                            ? selectedOrder.filter(key => key !== option.key)
                            : [...selectedOrder, option.key];
                        void commit(next);
                    }));
                const index = selectedOrder.indexOf(option.key);
                if (index > 0) {
                    menu.addItem(item => item
                        .setTitle(t('Move up'))
                        .setIcon('arrow-up')
                        .onClick(() => {
                            const next = [...selectedOrder];
                            [next[index - 1], next[index]] = [next[index], next[index - 1]];
                            void commit(next);
                        }));
                }
                if (index >= 0 && index < selectedOrder.length - 1) {
                    menu.addItem(item => item
                        .setTitle(t('Move down'))
                        .setIcon('arrow-down')
                        .onClick(() => {
                            const next = [...selectedOrder];
                            [next[index], next[index + 1]] = [next[index + 1], next[index]];
                            void commit(next);
                        }));
                }
                menu.showAtMouseEvent(event);
            });
            const toggle = () => {
                const next = selected.has(option.key)
                    ? selectedOrder.filter(key => key !== option.key)
                    : [...selectedOrder, option.key];
                void commit(next);
            };
            checkbox.addEventListener('change', toggle);
            row.addEventListener('click', event => {
                if (event.target === checkbox || (event.target as HTMLElement).closest('button')) return;
                toggle();
            });
            row.addEventListener('dragstart', event => {
                draggedKey = option.key;
                event.dataTransfer?.setData('text/plain', option.key);
                if (event.dataTransfer) event.dataTransfer.effectAllowed = 'move';
            });
            row.addEventListener('dragover', event => {
                if (!draggedKey || !selected.has(option.key) || draggedKey === option.key) return;
                event.preventDefault();
                row.addClass('is-drag-over');
            });
            row.addEventListener('dragleave', () => row.removeClass('is-drag-over'));
            row.addEventListener('drop', event => {
                event.preventDefault();
                row.removeClass('is-drag-over');
                if (!draggedKey || draggedKey === option.key) return;
                const next = selectedOrder.filter(key => key !== draggedKey);
                const targetIndex = next.indexOf(option.key);
                next.splice(Math.max(0, targetIndex), 0, draggedKey);
                void commit(next);
            });
        }
    };

    const addFormula = footer.createEl('button', { cls: 'library-properties-footer-btn' });
    obsidian.setIcon(addFormula.createSpan(), 'sigma');
    addFormula.createSpan({ text: t('Add formula') });
    addFormula.addEventListener('click', () => {
        close();
        openLibraryFormulaModal(opts);
    });
    const hideAll = footer.createEl('button', { cls: 'library-properties-footer-btn' });
    obsidian.setIcon(hideAll.createSpan(), 'eye-off');
    hideAll.createSpan({ text: t('Hide all') });
    hideAll.addEventListener('click', () => void commit([]));

    search.addEventListener('input', () => {
        query = search.value.trim().toLowerCase();
        renderList();
    });
    renderList();
    window.setTimeout(() => {
        activeDocument.addEventListener('pointerdown', onOutside, true);
        activeDocument.addEventListener('keydown', onKeyDown, true);
        search.focus();
    }, 0);
}

/**
 * Bases-style browse chrome: Sort · Filter · Properties · Search · New + layout toggle.
 * Returns chipHost for tag filters; search field expands when Search is active.
 */
export function renderLibraryBrowseToolbar(
    parent: HTMLElement,
    opts: LibraryBrowseToolbarOpts,
): LibraryBrowseToolbarResult {
    const root = parent.createDiv('library-browse-chrome');
    const toolbar = root.createDiv('codex-search-row library-browse-toolbar');
    const actions = toolbar.createDiv('library-browse-actions');

    const currentSortLabel =
        opts.sortOptions.find(o => o.value === opts.sortBy)?.label || t('Sort');
    const sortBtn = makeBrowseActionBtn(actions, {
        icon: 'arrow-up-down',
        label: t('Sort'),
        title: `${t('Sort')}: ${currentSortLabel}`,
        cls: 'library-browse-sort',
    });
    sortBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        const menu = new Menu();
        for (const opt of opts.sortOptions) {
            menu.addItem(item => item
                .setTitle(opt.label)
                .setChecked(opt.value === opts.sortBy)
                .onClick(() => opts.onSortChange(opt.value)));
        }
        menu.showAtMouseEvent(e);
    });

    const filterActive = opts.filterCount > 0;
    const filterBtn = makeBrowseActionBtn(actions, {
        icon: 'list-filter',
        label: t('Filter'),
        cls: `library-browse-filter${opts.filterOpen ? ' is-open' : ''}${filterActive ? ' has-filters' : ''}`,
    });
    if (filterActive) {
        filterBtn.createSpan({
            cls: 'library-browse-action-badge',
            text: String(opts.filterCount),
        });
    }
    filterBtn.addEventListener('click', () => {
        opts.onFilterOpenChange(!opts.filterOpen);
    });

    // Property selection controls table columns; showing it in cards/list
    // suggested those layouts would change even though they do not.
    if (
        getLibraryBrowseLayout(opts.plugin, opts.categoryId) === 'table'
        && opts.properties
        && opts.properties.length > 0
        && opts.onPropertiesChange
    ) {
        const propBtn = makeBrowseActionBtn(actions, {
            icon: 'list',
            label: t('Properties'),
            cls: 'library-browse-properties',
        });
        propBtn.addEventListener('click', (e) => {
            e.stopPropagation();
            openLibraryPropertiesPopover(propBtn, opts);
        });
    }

    const searchShowing = opts.searchOpen || !!opts.searchText.trim();
    const searchBtn = makeBrowseActionBtn(actions, {
        icon: 'search',
        label: t('Search'),
        cls: `library-browse-search-btn${searchShowing ? ' is-open' : ''}`,
    });
    searchBtn.addEventListener('click', () => {
        opts.onSearchOpenChange(!searchShowing);
    });

    if (opts.onNew) {
        const newBtn = makeBrowseActionBtn(actions, {
            icon: 'plus',
            label: opts.newLabel || t('New'),
            cls: 'library-browse-new',
        });
        newBtn.addEventListener('click', (ev) => opts.onNew!(ev));
    }

    opts.appendExtra?.(actions);

    if (opts.showLayoutToggle !== false) {
        renderLibraryLayoutToggle(toolbar, opts.plugin, opts.categoryId, opts.onLayoutChange);
    }

    if (opts.renderTrailingActions) {
        const trailing = toolbar.createDiv('library-browse-mode-actions');
        opts.renderTrailingActions(trailing);
    }

    let searchInput: HTMLInputElement | null = null;
    if (searchShowing) {
        const searchSlot = root.createDiv('library-browse-search-slot');
        searchInput = searchSlot.createEl('input', {
            cls: 'codex-search-input library-browse-search-input',
            attr: { type: 'text', placeholder: opts.searchPlaceholder },
        });
        searchInput.value = opts.searchText;
        let timer: number | null = null;
        const debounce = opts.searchDebounceMs ?? 180;
        searchInput.addEventListener('input', () => {
            const value = searchInput!.value;
            if (timer !== null) window.clearTimeout(timer);
            timer = window.setTimeout(() => {
                timer = null;
                opts.onSearchChange(value);
            }, debounce);
        });
    }

    const chipsVisible = opts.filterOpen || filterActive;
    const chipHost = root.createDiv(
        'story-line-filter-chips character-tag-filter-chips library-filter-chips library-browse-chip-host',
    );
    if (!chipsVisible) {
        chipHost.addClass('is-collapsed');
    }

    return { root, searchInput, chipHost };
}

/** Keep content-mode controls in the same left-aligned toolbar position. */
export function renderLibraryModeToolbar(
    parent: HTMLElement,
    renderActions: (actionsEl: HTMLElement) => void,
): HTMLElement {
    const root = parent.createDiv('library-browse-chrome library-mode-only-chrome');
    const toolbar = root.createDiv('codex-search-row library-browse-toolbar');
    const trailing = toolbar.createDiv('library-browse-mode-actions');
    renderActions(trailing);
    return root;
}
/* eslint-enable @typescript-eslint/no-unnecessary-type-assertion -- end of file-wide suppression block opened at line 1 */
