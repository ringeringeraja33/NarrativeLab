/* eslint-disable @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-floating-promises, @typescript-eslint/no-unnecessary-type-assertion -- Obsidian's API surface and several untyped third-party libraries force dynamic dispatch; floating promises are intentional in DOM/event handlers; matching enable at end of file */
import { Notice, Menu, MenuItem } from 'obsidian';
import * as obsidian from 'obsidian';
import { SceneManager } from '../services/SceneManager';
import type SceneCardsPlugin from '../main';
import type { SceneFilter, SortConfig, SortField, FilterPreset } from '../models/Scene';
import { getStatusOrder } from '../models/Scene';
import { getActDisplayLabel } from '../utils/actChapter';
import { t } from '../utils/i18n';

export interface FiltersComponentOptions {
    /** Show sort controls in the overflow menu. Default true; Concept Grid passes false. */
    showSort?: boolean;
    /** Override search input placeholder (default: "Search scenes..."). */
    searchPlaceholder?: string;
    /** Override filter button label (default: "Filter scenes"). */
    filterLabel?: string;
    /** Override filter button tooltip (default: scene-oriented help text). */
    filterTooltip?: string;
    /** Initial host filter, used when a view rebuilds its toolbar. */
    initialFilter?: SceneFilter;
    /** Initial host sort, used when a view rebuilds its toolbar. */
    initialSort?: SortConfig;
}

/**
 * Filter controls component for scene views.
 *
 * Layout:
 *   [🔍 Search]  [Filter ▾ N]  [⋯]
 *   [active chips…]
 *   ┌ panel (visibility + chips + presets) ┐
 *
 * The top bar is built once and left intact so host views (Board group-by,
 * Manuscript focus/plain toggles) can inject controls without losing them
 * when filters change.
 */
export class FiltersComponent {
    private container: HTMLElement;
    private sceneManager: SceneManager;
    private plugin: SceneCardsPlugin | null;
    private currentFilter: SceneFilter = {};
    private currentSort: SortConfig = { field: 'sequence', direction: 'asc' };
    private onChange: (filter: SceneFilter, sort: SortConfig) => void;
    private visible = false;
    private showSort: boolean;
    private searchPlaceholder: string;
    private filterLabel: string;
    private filterTooltip: string;
    private outsideClickHandler: ((e: MouseEvent) => void) | null = null;

    private filterBtn: HTMLElement | null = null;
    private chipsRow: HTMLElement | null = null;
    private filterPanel: HTMLElement | null = null;

    constructor(
        container: HTMLElement,
        sceneManager: SceneManager,
        onChange: (filter: SceneFilter, sort: SortConfig) => void,
        plugin: SceneCardsPlugin,
        options?: FiltersComponentOptions,
    ) {
        this.container = container;
        this.sceneManager = sceneManager;
        this.onChange = onChange;
        this.plugin = plugin ?? null;
        this.showSort = options?.showSort !== false;
        this.searchPlaceholder = options?.searchPlaceholder ?? t('Search scenes...');
        this.filterLabel = options?.filterLabel ?? t('Filter scenes');
        this.filterTooltip = options?.filterTooltip ?? t('Filter scenes by act, chapter, status, and more');
        if (options?.initialFilter) {
            this.currentFilter = JSON.parse(JSON.stringify(options.initialFilter)) as SceneFilter;
        }
        if (options?.initialSort) {
            this.currentSort = { ...options.initialSort };
        }
    }

    /**
     * Render the filter bar (full build — call once after mount).
     */
    render(): void {
        this.detachOutsideClick();
        this.container.empty();
        this.container.addClass('story-line-filters-container');
        this.filterBtn = null;
        this.chipsRow = null;
        this.filterPanel = null;

        const topBar = this.container.createDiv('story-line-filter-bar');

        // Search
        const searchWrapper = topBar.createDiv('story-line-search-wrapper');
        const searchIcon = searchWrapper.createSpan();
        obsidian.setIcon(searchIcon, 'search');
        const searchInput = searchWrapper.createEl('input', {
            cls: 'story-line-search',
            attr: {
                type: 'text',
                placeholder: this.searchPlaceholder,
            }
        });
        if (this.currentFilter.searchText) {
            searchInput.value = this.currentFilter.searchText;
        }
        searchInput.addEventListener('input', () => {
            this.currentFilter.searchText = searchInput.value || undefined;
            this.emitChange();
        });

        topBar.createDiv('story-line-filter-spacer');

        this.filterBtn = topBar.createEl('button', {
            cls: 'story-line-filter-toggle clickable-icon',
            attr: { title: this.filterTooltip, 'aria-expanded': 'false' },
        });
        const filterIcon = this.filterBtn.createSpan();
        obsidian.setIcon(filterIcon, 'list-filter');
        this.filterBtn.createSpan({ cls: 'story-line-filter-toggle-label', text: this.filterLabel });
        this.filterBtn.addEventListener('click', (e) => {
            e.stopPropagation();
            this.togglePanel();
        });

        if (this.showSort) {
            const sortBtn = topBar.createEl('button', {
                cls: 'story-line-filter-toggle clickable-icon story-line-sort',
                attr: { title: t('Change scene sort order') },
            });
            const sortIcon = sortBtn.createSpan();
            obsidian.setIcon(sortIcon, 'arrow-up-down');
            sortBtn.createSpan({ cls: 'story-line-filter-toggle-label', text: t('Sort scenes') });
            sortBtn.addEventListener('click', (e) => {
                e.stopPropagation();
                this.openSortMenu(sortBtn);
            });
        }

        this.chipsRow = this.container.createDiv('story-line-active-chips');
        this.filterPanel = this.container.createDiv('story-line-filter-panel');
        this.filterPanel.setCssStyles({ display: 'none' });

        this.refreshChrome();
        if (this.visible) {
            this.openPanel();
        }
    }

    /** Toggle the filter panel without rebuilding the top bar. */
    private togglePanel(): void {
        if (this.visible) this.closePanel();
        else this.openPanel();
    }

    private openPanel(): void {
        if (!this.filterPanel || !this.filterBtn) return;
        this.visible = true;
        this.filterPanel.empty();
        this.renderFilterPanel(this.filterPanel);
        this.filterPanel.setCssStyles({ display: 'block' });
        this.filterBtn.addClass('is-open');
        this.filterBtn.setAttr('aria-expanded', 'true');
        this.attachOutsideClick();
    }

    private closePanel(): void {
        if (!this.filterPanel || !this.filterBtn) return;
        this.visible = false;
        this.detachOutsideClick();
        this.filterPanel.setCssStyles({ display: 'none' });
        this.filterPanel.empty();
        this.filterBtn.removeClass('is-open');
        this.filterBtn.setAttr('aria-expanded', 'false');
    }

    /** Update badge + active chips; rebuild panel contents if open. */
    private afterFilterChange(): void {
        this.refreshChrome();
        if (this.visible && this.filterPanel) {
            this.filterPanel.empty();
            this.renderFilterPanel(this.filterPanel);
        }
        this.emitChange();
    }

    private refreshChrome(): void {
        this.updateFilterBadge();
        this.renderActiveChips();
    }

    private updateFilterBadge(): void {
        if (!this.filterBtn) return;
        const count = this.countActiveFilters();
        this.filterBtn.toggleClass('has-filters', count > 0);
        let badge = this.filterBtn.querySelector('.story-line-filter-badge') as HTMLElement | null;
        if (count > 0) {
            if (!badge) {
                badge = this.filterBtn.createSpan({ cls: 'story-line-filter-badge' });
            }
            badge.setText(String(count));
        } else if (badge) {
            badge.remove();
        }
    }

    private attachOutsideClick(): void {
        this.detachOutsideClick();
        this.outsideClickHandler = (e: MouseEvent) => {
            const target = e.target as Node | null;
            if (!target) return;
            if (this.filterPanel?.contains(target) || this.filterBtn?.contains(target)) return;
            this.closePanel();
        };
        window.setTimeout(() => {
            if (this.outsideClickHandler) {
                activeDocument.addEventListener('mousedown', this.outsideClickHandler);
            }
        }, 0);
    }

    private detachOutsideClick(): void {
        if (this.outsideClickHandler) {
            activeDocument.removeEventListener('mousedown', this.outsideClickHandler);
            this.outsideClickHandler = null;
        }
    }

    private openSortMenu(anchor: HTMLElement): void {
        const menu = new Menu();
        const sortOptions: { value: SortField; label: string }[] = [
            { value: 'sequence', label: t('Sort by reading order') },
            { value: 'title', label: t('Sort by title') },
            { value: 'status', label: t('Sort by status') },
            { value: 'act', label: t('Sort by act') },
            { value: 'chapter', label: t('Sort by chapter') },
            { value: 'wordcount', label: t('Sort by word count') },
            { value: 'modified', label: t('Sort by modified time') },
        ];
        for (const opt of sortOptions) {
            menu.addItem((item: MenuItem) => {
                item.setTitle(opt.label)
                    .setChecked(this.currentSort.field === opt.value)
                    .onClick(() => {
                        this.currentSort.field = opt.value;
                        this.emitChange();
                    });
            });
        }
        menu.addSeparator();
        menu.addItem((item: MenuItem) => {
            item.setTitle(t('Ascending'))
                .setChecked(this.currentSort.direction === 'asc')
                .onClick(() => {
                    this.currentSort.direction = 'asc';
                    this.emitChange();
                });
        });
        menu.addItem((item: MenuItem) => {
            item.setTitle(t('Descending'))
                .setChecked(this.currentSort.direction === 'desc')
                .onClick(() => {
                    this.currentSort.direction = 'desc';
                    this.emitChange();
                });
        });
        const rect = anchor.getBoundingClientRect();
        menu.showAtPosition({ x: rect.left, y: rect.bottom + 4 });
    }

    /** Removable chips summarizing non-default filters */
    private renderActiveChips(): void {
        if (!this.chipsRow) return;
        this.chipsRow.empty();

        const chips: { label: string; clear: () => void }[] = [];
        const f = this.currentFilter;

        if (f.activeState === 'all' || f.activeState === 'inactive') {
            chips.push({
                label: t('Including inactive'),
                clear: () => { this.currentFilter.activeState = 'active'; },
            });
        }

        for (const status of f.status ?? []) {
            const s = status;
            chips.push({
                label: s.charAt(0).toUpperCase() + s.slice(1),
                clear: () => {
                    this.currentFilter.status = (this.currentFilter.status ?? []).filter(x => x !== s);
                    if (!this.currentFilter.status?.length) delete this.currentFilter.status;
                },
            });
        }

        for (const act of f.act ?? []) {
            const a = act;
            chips.push({
                label: `${t('Act')}: ${t(getActDisplayLabel(a))}`,
                clear: () => {
                    this.currentFilter.act = (this.currentFilter.act ?? []).filter(x => String(x) !== String(a));
                    if (!this.currentFilter.act?.length) delete this.currentFilter.act;
                },
            });
        }

        for (const chapter of f.chapter ?? []) {
            const ch = chapter;
            chips.push({
                label: `${t('Chapter')}: ${ch}`,
                clear: () => {
                    this.currentFilter.chapter = (this.currentFilter.chapter ?? []).filter(x => String(x) !== String(ch));
                    if (!this.currentFilter.chapter?.length) delete this.currentFilter.chapter;
                },
            });
        }

        for (const tag of f.tags ?? []) {
            const tg = tag;
            chips.push({
                label: `#${tg}`,
                clear: () => {
                    this.currentFilter.tags = (this.currentFilter.tags ?? []).filter(x => x !== tg);
                    if (!this.currentFilter.tags?.length) delete this.currentFilter.tags;
                },
            });
        }

        for (const pov of f.pov ?? []) {
            const p = pov;
            chips.push({
                label: `${t('POV')}: ${p}`,
                clear: () => {
                    this.currentFilter.pov = (this.currentFilter.pov ?? []).filter(x => x !== p);
                    if (!this.currentFilter.pov?.length) delete this.currentFilter.pov;
                },
            });
        }

        for (const char of f.characters ?? []) {
            const c = char;
            chips.push({
                label: c.replace(/\[\[|\]\]/g, ''),
                clear: () => {
                    this.currentFilter.characters = (this.currentFilter.characters ?? []).filter(x => x !== c);
                    if (!this.currentFilter.characters?.length) delete this.currentFilter.characters;
                },
            });
        }

        for (const loc of f.locations ?? []) {
            const l = loc;
            chips.push({
                label: l.replace(/\[\[|\]\]/g, ''),
                clear: () => {
                    this.currentFilter.locations = (this.currentFilter.locations ?? []).filter(x => x !== l);
                    if (!this.currentFilter.locations?.length) delete this.currentFilter.locations;
                },
            });
        }

        if (f.customFields) {
            for (const [tplId, vals] of Object.entries(f.customFields)) {
                const tplLabel = this.plugin?.fieldTemplates?.getAll().find(x => x.id === tplId)?.label ?? tplId;
                for (const val of vals) {
                    const v = val;
                    chips.push({
                        label: `${tplLabel}: ${v}`,
                        clear: () => {
                            if (!this.currentFilter.customFields) return;
                            const arr = (this.currentFilter.customFields[tplId] ?? []).filter(x => x !== v);
                            if (arr.length === 0) delete this.currentFilter.customFields[tplId];
                            else this.currentFilter.customFields[tplId] = arr;
                            if (Object.keys(this.currentFilter.customFields).length === 0) {
                                delete this.currentFilter.customFields;
                            }
                        },
                    });
                }
            }
        }

        this.chipsRow.toggleClass('is-empty', chips.length === 0);
        if (chips.length === 0) return;

        for (const chip of chips) {
            const el = this.chipsRow.createEl('button', {
                cls: 'story-line-active-chip',
                text: chip.label,
                attr: { title: t('Click to remove') },
            });
            const x = el.createSpan({ cls: 'story-line-active-chip-x', text: '×' });
            x.setAttr('aria-hidden', 'true');
            el.addEventListener('click', () => {
                chip.clear();
                this.afterFilterChange();
            });
        }

        const clearAll = this.chipsRow.createEl('button', {
            cls: 'story-line-active-chip story-line-active-chip-clear',
            text: t('Clear'),
        });
        clearAll.addEventListener('click', () => {
            this.clearFiltersKeepSearch();
            this.afterFilterChange();
        });
    }

    private clearFiltersKeepSearch(): void {
        const search = this.currentFilter.searchText;
        this.currentFilter = search
            ? { searchText: search, activeState: 'active' }
            : { activeState: 'active' };
    }

    private countActiveFilters(): number {
        const f = this.currentFilter;
        let n = 0;
        if (f.activeState === 'all' || f.activeState === 'inactive') n++;
        if (f.status?.length) n += f.status.length;
        if (f.act?.length) n += f.act.length;
        if (f.chapter?.length) n += f.chapter.length;
        if (f.pov?.length) n += f.pov.length;
        if (f.characters?.length) n += f.characters.length;
        if (f.locations?.length) n += f.locations.length;
        if (f.tags?.length) n += f.tags.length;
        if (f.customFields) {
            for (const vals of Object.values(f.customFields)) n += vals.length;
        }
        return n;
    }

    private renderChipSection(
        panel: HTMLElement,
        title: string,
        values: string[],
        isActive: (value: string) => boolean,
        onToggle: (value: string) => void,
        labelFor?: (value: string) => string,
    ): void {
        if (values.length === 0) return;
        const section = panel.createDiv('story-line-filter-section');
        section.createDiv({ cls: 'story-line-filter-section-title', text: title });
        const container = section.createDiv('story-line-filter-chips');
        for (const value of values) {
            const chip = container.createEl('button', {
                cls: `story-line-chip${isActive(value) ? ' active' : ''}`,
                text: labelFor ? labelFor(value) : value,
            });
            chip.addEventListener('click', () => onToggle(value));
        }
    }

    private toggleListFilter<K extends 'status' | 'act' | 'chapter' | 'pov' | 'characters' | 'locations' | 'tags'>(
        key: K,
        value: NonNullable<SceneFilter[K]>[number],
    ): void {
        const current = (this.currentFilter[key] ?? []) as Array<typeof value>;
        const idx = current.map(String).indexOf(String(value));
        if (idx >= 0) current.splice(idx, 1);
        else current.push(value);
        if (current.length === 0) delete this.currentFilter[key];
        else (this.currentFilter as Record<string, unknown>)[key] = current;
        this.afterFilterChange();
    }

    private renderFilterPanel(panel: HTMLElement): void {
        // ── Visibility ──
        const visSection = panel.createDiv('story-line-filter-section');
        visSection.createDiv({ cls: 'story-line-filter-section-title', text: t('Visibility') });

        const inactiveRow = visSection.createDiv('story-line-filter-row');
        const inactiveLabel = inactiveRow.createEl('label', { cls: 'sl-toggle-wrap story-line-inactive-toggle' });
        inactiveLabel.createSpan({ cls: 'sl-toggle-label', text: t('Include inactive content') });
        const inactiveCb = inactiveLabel.createEl('input', { type: 'checkbox' });
        inactiveCb.checked = this.currentFilter.activeState === 'all' || this.currentFilter.activeState === 'inactive';
        inactiveLabel.createSpan({ cls: 'sl-toggle-track' });
        inactiveCb.addEventListener('change', () => {
            this.currentFilter.activeState = inactiveCb.checked ? 'all' : 'active';
            this.afterFilterChange();
        });

        // High-frequency dimensions first (status / tags / structure)
        this.renderChipSection(
            panel,
            t('Status'),
            getStatusOrder().map(String),
            (status) => !!this.currentFilter.status?.includes(status as never),
            (status) => this.toggleListFilter('status', status as never),
            (status) => status.charAt(0).toUpperCase() + status.slice(1),
        );

        const tagValues = this.sceneManager.queryService.getAllTags();
        this.renderChipSection(
            panel,
            t('Tags'),
            tagValues,
            (tag) => !!this.currentFilter.tags?.includes(tag),
            (tag) => this.toggleListFilter('tags', tag),
            (tag) => `#${tag}`,
        );

        const actValues = this.sceneManager.queryService.getUniqueValues('act');
        this.renderChipSection(
            panel,
            t('Act'),
            actValues,
            (act) => !!this.currentFilter.act?.map(String).includes(act),
            (act) => this.toggleListFilter('act', act),
            (act) => t(getActDisplayLabel(act)),
        );

        const chapterValues = this.sceneManager.queryService.getUniqueValues('chapter');
        this.renderChipSection(
            panel,
            t('Chapter'),
            chapterValues,
            (ch) => !!this.currentFilter.chapter?.map(String).includes(ch),
            (ch) => this.toggleListFilter('chapter', ch),
        );

        const povValues = this.sceneManager.queryService.getUniqueValues('pov');
        this.renderChipSection(
            panel,
            t('POV'),
            povValues,
            (pov) => !!this.currentFilter.pov?.includes(pov),
            (pov) => this.toggleListFilter('pov', pov),
        );

        const charValues = this.sceneManager.queryService.getAllCharacters();
        this.renderChipSection(
            panel,
            t('Characters'),
            charValues,
            (char) => !!this.currentFilter.characters?.includes(char),
            (char) => this.toggleListFilter('characters', char),
            (char) => char.replace(/\[\[|\]\]/g, ''),
        );

        const locValues = this.sceneManager.queryService.getUniqueValues('location');
        this.renderChipSection(
            panel,
            t('Location'),
            locValues,
            (loc) => !!this.currentFilter.locations?.includes(loc),
            (loc) => this.toggleListFilter('locations', loc),
            (loc) => loc.replace(/\[\[|\]\]/g, ''),
        );

        // Custom scene fields
        if (this.plugin?.fieldTemplates) {
            const sceneTpls = this.plugin.fieldTemplates.getAll()
                .filter(tpl => (tpl.category || 'character') === 'scene')
                .filter(tpl => tpl.type === 'dropdown' || tpl.type === 'multi-select');

            for (const tpl of sceneTpls) {
                const used = new Set<string>();
                for (const scene of this.sceneManager.getAllScenes()) {
                    const raw = scene.universalFields?.[tpl.id];
                    if (Array.isArray(raw)) raw.forEach(v => v && used.add(String(v)));
                    else if (typeof raw === 'string' && raw.trim()) used.add(raw);
                }
                for (const opt of tpl.options) used.add(opt);
                if (used.size === 0) continue;

                const cfSection = panel.createDiv('story-line-filter-section');
                cfSection.createDiv({ cls: 'story-line-filter-section-title', text: tpl.label });
                const cfContainer = cfSection.createDiv('story-line-filter-chips');
                Array.from(used).sort((a, b) => a.localeCompare(b)).forEach(val => {
                    const chip = cfContainer.createEl('button', {
                        cls: `story-line-chip${this.currentFilter.customFields?.[tpl.id]?.includes(val) ? ' active' : ''}`,
                        text: val,
                    });
                    chip.addEventListener('click', () => {
                        if (!this.currentFilter.customFields) this.currentFilter.customFields = {};
                        const arr = this.currentFilter.customFields[tpl.id] ?? [];
                        const idx = arr.indexOf(val);
                        if (idx >= 0) arr.splice(idx, 1);
                        else arr.push(val);
                        if (arr.length === 0) delete this.currentFilter.customFields[tpl.id];
                        else this.currentFilter.customFields[tpl.id] = arr;
                        if (Object.keys(this.currentFilter.customFields).length === 0) {
                            delete this.currentFilter.customFields;
                        }
                        this.afterFilterChange();
                    });
                });
            }
        }

        // Presets
        if (this.plugin) {
            const presetSection = panel.createDiv('story-line-preset-section story-line-filter-section');
            const presetHeader = presetSection.createDiv('story-line-preset-header');
            presetHeader.createEl('span', { text: t('Saved Presets'), cls: 'story-line-filter-section-title' });

            const saveBtn = presetHeader.createEl('button', {
                cls: 'story-line-chip story-line-preset-save',
                text: t('+ Save current'),
            });
            saveBtn.addEventListener('click', () => {
                if (this.countActiveFilters() === 0) {
                    new Notice(t('No active filters to save'));
                    return;
                }
                const nameInput = activeDocument.createElement('input');
                nameInput.type = 'text';
                nameInput.placeholder = t('Preset name…');
                nameInput.className = 'story-line-preset-name-input';
                presetHeader.appendChild(nameInput);
                nameInput.focus();
                const doSave = () => {
                    const name = nameInput.value.trim();
                    if (!name) { nameInput.remove(); return; }
                    const preset: FilterPreset = { name, filter: JSON.parse(JSON.stringify(this.currentFilter)) };
                    this.sceneManager.addFilterPreset(preset);
                    nameInput.remove();
                    this.afterFilterChange();
                    new Notice(t('Filter preset "{name}" saved', { name }));
                };
                nameInput.addEventListener('keydown', (e) => {
                    if (e.key === 'Enter') doSave();
                    if (e.key === 'Escape') nameInput.remove();
                });
                nameInput.addEventListener('blur', doSave);
            });

            const presetChips = presetSection.createDiv('story-line-filter-chips');
            this.sceneManager.getFilterPresets().forEach((preset, idx) => {
                const chip = presetChips.createEl('button', {
                    cls: 'story-line-chip story-line-preset-chip',
                    text: preset.name,
                    attr: { title: t('Click to apply, right‑click to delete') },
                });
                chip.addEventListener('click', () => {
                    this.currentFilter = JSON.parse(JSON.stringify(preset.filter));
                    this.afterFilterChange();
                    new Notice(t('Applied preset "{name}"', { name: preset.name }));
                });
                chip.addEventListener('contextmenu', (e) => {
                    e.preventDefault();
                    this.sceneManager.removeFilterPreset(idx);
                    this.afterFilterChange();
                    new Notice(t('Deleted preset "{name}"', { name: preset.name }));
                });
            });
        }

        const clearBtn = panel.createEl('button', {
            cls: 'story-line-clear-filters',
            text: t('Clear All Filters'),
        });
        clearBtn.addEventListener('click', () => {
            this.clearFiltersKeepSearch();
            this.afterFilterChange();
        });
    }

    private emitChange(): void {
        // Scene vs Arc Point is not a useful filter surface — drop any leftover value
        // from old presets so it never silently narrows results.
        delete this.currentFilter.arcAnchorFilter;
        this.onChange(this.currentFilter, this.currentSort);
    }

    getFilter(): SceneFilter {
        return this.currentFilter;
    }

    getSort(): SortConfig {
        return this.currentSort;
    }
}
/* eslint-enable @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-floating-promises, @typescript-eslint/no-unnecessary-type-assertion -- end of file-wide suppression block opened at line 1 */
