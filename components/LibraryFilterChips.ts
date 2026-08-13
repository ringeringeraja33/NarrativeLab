
import { Menu } from 'obsidian';
import * as obsidian from 'obsidian';
import type SceneCardsPlugin from '../main';
import { attachTooltip } from './Tooltip';
import { t } from '../utils/i18n';

export interface LibraryFilterFieldOption {
    key: string;
    label: string;
}

/** Virtual filter field: scan all string properties for #hashtags. */
export const ARCHIVE_FILTER_HASHTAGS_KEY = '__hashtags__';

const ARCHIVE_FILTER_SKIP_KEYS = new Set([
    'name', 'image', 'gallery', 'relations', 'filePath', 'type', 'modified', 'created',
    'books', 'id', 'path',
]);

/** Build picker options from profile field categories (+ optional custom sections). */
export function buildArchiveFilterFieldOptions(
    categories: Array<{ fields: Array<{ key: string; label: string }> }>,
    customSections?: Array<{ fields?: Array<string | { name: string; label?: string }> }>,
): LibraryFilterFieldOption[] {
    const seen = new Set<string>();
    const out: LibraryFilterFieldOption[] = [
        { key: ARCHIVE_FILTER_HASHTAGS_KEY, label: 'Hashtags (#…)' },
    ];
    seen.add(ARCHIVE_FILTER_HASHTAGS_KEY);
    for (const cat of categories) {
        for (const field of cat.fields) {
            if (ARCHIVE_FILTER_SKIP_KEYS.has(field.key) || seen.has(field.key)) continue;
            seen.add(field.key);
            out.push({ key: field.key, label: field.label });
        }
    }
    for (const section of customSections || []) {
        for (const raw of section.fields || []) {
            const name = typeof raw === 'string' ? raw : raw.name;
            if (!name || ARCHIVE_FILTER_SKIP_KEYS.has(name) || seen.has(name)) continue;
            seen.add(name);
            const label = typeof raw === 'string' ? raw : (raw.label || raw.name);
            out.push({ key: name, label });
        }
    }
    return out;
}

/** Scan every string-ish value on an entity for #hashtags. */
export function collectHashtagsFromEntity(
    into: Map<string, string>,
    entity: Record<string, unknown>,
): void {
    const walk = (val: unknown): void => {
        if (typeof val === 'string') {
            if (val.includes('#')) collectHashtagsFromText(into, val);
            return;
        }
        if (Array.isArray(val)) {
            for (const item of val) walk(item);
            return;
        }
        if (val && typeof val === 'object') {
            for (const nested of Object.values(val as Record<string, unknown>)) walk(nested);
        }
    };
    walk(entity);
}

/**
 * Shared filter-chip bar for Library browse (Characters / Locations / Codex).
 * Selected keys are lowercased labels; OR semantics when filtering.
 */
export function renderLibraryFilterChips(
    host: HTMLElement,
    tagLabels: Map<string, string>,
    active: Set<string>,
    onChange: () => void,
    opts?: { emptyHint?: string },
): void {
    host.empty();
    host.addClass('story-line-filter-chips');
    host.addClass('character-tag-filter-chips');
    host.addClass('library-filter-chips');

    // Drop stale selections
    for (const key of [...active]) {
        if (!tagLabels.has(key)) active.delete(key);
    }

    if (tagLabels.size === 0) {
        if (opts?.emptyHint) {
            host.createSpan({ cls: 'library-filter-empty-hint', text: opts.emptyHint });
            host.show();
        } else {
            host.hide();
        }
        return;
    }

    host.show();
    const sorted = [...tagLabels.entries()].sort((a, b) =>
        a[1].localeCompare(b[1], undefined, { sensitivity: 'base' }));
    for (const [key, label] of sorted) {
        const chip = host.createEl('button', {
            cls: `story-line-chip${active.has(key) ? ' active' : ''}`,
            text: label,
            attr: { type: 'button' },
        });
        chip.addEventListener('click', (e) => {
            e.preventDefault();
            e.stopPropagation();
            if (active.has(key)) active.delete(key);
            else active.add(key);
            onChange();
        });
    }
    if (active.size > 0) {
        const clearBtn = host.createEl('button', {
            cls: 'story-line-chip story-line-chip-clear',
            text: t('Clear'),
            attr: { type: 'button' },
        });
        attachTooltip(clearBtn, t('Clear tag filters'));
        clearBtn.addEventListener('click', (e) => {
            e.preventDefault();
            e.stopPropagation();
            active.clear();
            onChange();
        });
    }
}

/**
 * Render chips + a “Filter by field” picker for archive profile overviews.
 * Chips are built only from the selected field keys' distinct values.
 */
export function renderLibraryArchiveFilterBar(
    host: HTMLElement,
    opts: {
        plugin: SceneCardsPlugin;
        categoryId: string;
        availableFields: LibraryFilterFieldOption[];
        defaultFields: string[];
        /** Collect lowercase→display labels for the currently selected fields. */
        collectLabels: (selectedFields: string[]) => Map<string, string>;
        active: Set<string>;
        onChange: () => void;
        emptyHint?: string;
    },
): string[] {
    const selected = getLibraryArchiveFilterFields(
        opts.plugin,
        opts.categoryId,
        opts.defaultFields,
        opts.availableFields.map(f => f.key),
    );

    host.empty();
    host.addClass('story-line-filter-chips');
    host.addClass('character-tag-filter-chips');
    host.addClass('library-filter-chips');
    host.addClass('library-archive-filter-bar');
    host.show();

    const toolbar = host.createDiv('library-archive-filter-toolbar');
    const fieldBtn = toolbar.createEl('button', {
        cls: 'library-browse-action library-archive-filter-field-btn',
        attr: {
            type: 'button',
            'aria-label': t('Filter by field'),
            title: t('Choose which profile fields feed the filter chips'),
        },
    });
    const fieldIcon = fieldBtn.createSpan({ cls: 'library-browse-action-icon' });
    obsidian.setIcon(fieldIcon, 'list-filter');
    const selectedLabels = opts.availableFields
        .filter(f => selected.includes(f.key))
        .map(f => t(f.label));
    fieldBtn.createSpan({
        cls: 'library-browse-action-label',
        text: selectedLabels.length
            ? t('Filter by: {fields}', { fields: selectedLabels.join(', ') })
            : t('Filter by field'),
    });
    fieldBtn.addEventListener('click', (e) => {
        e.preventDefault();
        e.stopPropagation();
        const menu = new Menu();
        for (const field of opts.availableFields) {
            const on = selected.includes(field.key);
            menu.addItem(item => {
                item.setTitle(t(field.label));
                item.setChecked(on);
                item.onClick(() => {
                    const next = on
                        ? selected.filter(k => k !== field.key)
                        : [...selected, field.key];
                    // Keep at least one field so chips don't vanish unexpectedly.
                    const safe = next.length > 0 ? next : [field.key];
                    void setLibraryArchiveFilterFields(opts.plugin, opts.categoryId, safe)
                        .then(() => {
                            opts.active.clear();
                            opts.onChange();
                        });
                });
            });
        }
        menu.showAtMouseEvent(e);
    });

    const chipHost = host.createDiv('library-archive-filter-chips');
    const labels = opts.collectLabels(selected);
    if (labels.size === 0) {
        chipHost.createSpan({
            cls: 'library-filter-empty-hint',
            text: opts.emptyHint || t('No values found for the selected filter fields.'),
        });
    } else {
        renderLibraryFilterChips(chipHost, labels, opts.active, opts.onChange);
        // renderLibraryFilterChips clears/reclasses the host — restore nest class.
        chipHost.addClass('library-archive-filter-chips');
    }

    return selected;
}

/** Split comma-separated type/tag strings into lowercase→display map entries. */
export function collectDelimitedTags(
    into: Map<string, string>,
    raw: string | undefined | null,
): void {
    if (!raw) return;
    for (const part of String(raw).split(',').map(s => s.trim()).filter(Boolean)) {
        const key = part.toLowerCase();
        if (!into.has(key)) into.set(key, part);
    }
}

/** Pull #hashtags from free-text fields (same spirit as character props). */
export function collectHashtagsFromText(
    into: Map<string, string>,
    text: string | undefined | null,
): void {
    if (!text) return;
    const re = /#([A-Za-z\u00C0-\u024F\u0400-\u04FF\u4E00-\u9FFF][\w\u00C0-\u024F\u0400-\u04FF\u4E00-\u9FFF-]*)/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(String(text))) !== null) {
        const label = m[1];
        const key = label.toLowerCase();
        if (!into.has(key)) into.set(key, label);
    }
}

/**
 * Collect filterable values from a field on an entity.
 * - arrays / comma lists → each part becomes a chip
 * - free text also contributes #hashtags
 */
export function collectValuesFromField(
    into: Map<string, string>,
    value: unknown,
    opts?: { hashtags?: boolean },
): void {
    if (value == null) return;
    if (Array.isArray(value)) {
        for (const item of value) {
            if (typeof item === 'string') {
                collectDelimitedTags(into, item);
                if (opts?.hashtags !== false) collectHashtagsFromText(into, item);
            } else if (item && typeof item === 'object' && 'name' in item && typeof (item as { name?: unknown }).name === 'string') {
                collectDelimitedTags(into, (item as { name: string }).name);
            } else if (item != null && (typeof item === 'string' || typeof item === 'number' || typeof item === 'boolean')) {
                collectDelimitedTags(into, String(item));
            }
        }
        return;
    }
    if (typeof value === 'string') {
        collectDelimitedTags(into, value);
        if (opts?.hashtags !== false) collectHashtagsFromText(into, value);
        return;
    }
    if (typeof value === 'number' || typeof value === 'boolean') {
        collectDelimitedTags(into, String(value));
    }
}

/** Read a nested/custom field: bare key, universalFields[id], or custom["Section :: name"]. */
export function readEntityFilterValue(
    entity: Record<string, unknown>,
    fieldKey: string,
): unknown {
    if (fieldKey === 'role' || fieldKey in entity) {
        return entity[fieldKey];
    }
    const universal = entity.universalFields;
    if (universal && typeof universal === 'object' && !Array.isArray(universal)) {
        const rec = universal as Record<string, unknown>;
        if (fieldKey in rec) return rec[fieldKey];
    }
    const custom = entity.custom;
    if (custom && typeof custom === 'object' && !Array.isArray(custom)) {
        const rec = custom as Record<string, unknown>;
        if (fieldKey in rec) return rec[fieldKey];
        // Composite custom keys: "Section :: Field"
        for (const [k, v] of Object.entries(rec)) {
            if (k === fieldKey || k.endsWith(` :: ${fieldKey}`) || k.endsWith(`:: ${fieldKey}`)) {
                return v;
            }
        }
    }
    return undefined;
}

export function collectEntityFilterKeys(
    entity: Record<string, unknown>,
    fieldKeys: string[],
    roleList?: string[],
): string[] {
    const into = new Map<string, string>();
    for (const key of fieldKeys) {
        if (key === ARCHIVE_FILTER_HASHTAGS_KEY) {
            collectHashtagsFromEntity(into, entity);
            continue;
        }
        if (key === 'role' && roleList) {
            for (const role of roleList) collectDelimitedTags(into, role);
            continue;
        }
        collectValuesFromField(into, readEntityFilterValue(entity, key), { hashtags: false });
    }
    return [...into.keys()];
}

/** Collect chip labels from entities for the selected filter fields. */
export function collectArchiveFilterLabels(
    entities: Record<string, unknown>[],
    fieldKeys: string[],
    getRoleList?: (entity: Record<string, unknown>) => string[],
): Map<string, string> {
    const into = new Map<string, string>();
    for (const entity of entities) {
        for (const key of fieldKeys) {
            if (key === ARCHIVE_FILTER_HASHTAGS_KEY) {
                collectHashtagsFromEntity(into, entity);
                continue;
            }
            if (key === 'role' && getRoleList) {
                for (const role of getRoleList(entity)) collectDelimitedTags(into, role);
                continue;
            }
            collectValuesFromField(into, readEntityFilterValue(entity, key), { hashtags: false });
        }
    }
    return into;
}

export function getLibraryArchiveFilterFields(
    plugin: SceneCardsPlugin,
    categoryId: string,
    defaults: string[],
    allowedKeys?: string[],
): string[] {
    const saved = plugin.settings.libraryArchiveFilterFields?.[categoryId];
    const allowed = allowedKeys ? new Set(allowedKeys) : null;
    const pick = (keys: string[]) => {
        const cleaned = keys
            .map(k => k.trim())
            .filter(Boolean)
            .filter(k => !allowed || allowed.has(k));
        return cleaned.length > 0 ? cleaned : defaults.filter(k => !allowed || allowed.has(k));
    };
    if (Array.isArray(saved) && saved.length > 0) return pick(saved);
    return pick(defaults);
}

export async function setLibraryArchiveFilterFields(
    plugin: SceneCardsPlugin,
    categoryId: string,
    fields: string[],
): Promise<void> {
    if (!plugin.settings.libraryArchiveFilterFields) {
        plugin.settings.libraryArchiveFilterFields = {};
    }
    plugin.settings.libraryArchiveFilterFields[categoryId] = [...fields];
    await plugin.saveSettings();
}
