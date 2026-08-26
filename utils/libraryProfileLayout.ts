import * as obsidian from 'obsidian';
import type { App } from 'obsidian';
import type { SceneCardsSettings } from '../settings';
import { openConfirmModal } from '../components/ConfirmModal';
import { t } from './i18n';
import { normalizeCustomFieldInputHeight } from './customFieldInputHeight';

/** Per-project System/ filename for archive profile field layout. */
export const LIBRARY_PROFILE_LAYOUT_FILENAME = 'library-profile-layout.json';

/**
 * Built-in fields that cannot be deleted (basic identity / navigation).
 * They may still be hidden except `name`, which stays always visible in the UI.
 */
const CORE_UNDELETABLE = new Set(['name']);

export interface LibraryProfileLayoutSettings {
    hiddenFields: Record<string, string[]>;
    /** Built-in field keys removed from the form for this project + archive page. */
    removedBuiltinFields: Record<string, string[]>;
    /** Built-in section titles removed as whole columns for this project + archive page. */
    removedBuiltinSections: Record<string, string[]>;
    characterCustomSections: unknown[];
    locationCustomSections: unknown[];
    codexCategoryCustomSections: Record<string, unknown[]>;
    /** Default custom field names seeded onto new Codex entries (per category). */
    codexCategoryFieldTemplates: Record<string, string[]>;
    /** Detail page direction, keyed by character/location/world/Codex category. */
    profileOrientations: Record<string, LibraryProfileOrientation>;
    /** User-selected heights for all resizable profile text fields. */
    profileFieldInputHeights: Record<string, number>;
    /** Display overrides for built-in fields, keyed by category then field key. */
    profileFieldOverrides: Record<string, Record<string, ProfileFieldOverride>>;
    /** Section/column order shared by horizontal and vertical profile layouts. */
    profileSectionOrders: Record<string, string[]>;
}

export interface ProfileFieldOverride {
    label?: string;
    placeholder?: string;
}

/**
 * Horizontal = each section is a vertical column, columns arranged left-to-right.
 * Vertical = stacked accordion sections with the side rail still beside the form.
 */
export type LibraryProfileOrientation = 'horizontal' | 'vertical';

export function emptyLibraryProfileLayout(): LibraryProfileLayoutSettings {
    return {
        hiddenFields: {},
        removedBuiltinFields: {},
        removedBuiltinSections: {},
        characterCustomSections: [],
        locationCustomSections: [],
        codexCategoryCustomSections: {},
        codexCategoryFieldTemplates: {},
        profileOrientations: {},
        profileFieldInputHeights: {},
        profileFieldOverrides: {},
        profileSectionOrders: {},
    };
}

export function readLibraryProfileLayout(settings: SceneCardsSettings): LibraryProfileLayoutSettings {
    return {
        hiddenFields: { ...(settings.hiddenFields || {}) },
        removedBuiltinFields: { ...(settings.removedBuiltinFields || {}) },
        removedBuiltinSections: { ...(settings.removedBuiltinSections || {}) },
        characterCustomSections: Array.isArray(settings.characterCustomSections)
            ? JSON.parse(JSON.stringify(settings.characterCustomSections)) as unknown[]
            : [],
        locationCustomSections: Array.isArray(settings.locationCustomSections)
            ? JSON.parse(JSON.stringify(settings.locationCustomSections)) as unknown[]
            : [],
        codexCategoryCustomSections: JSON.parse(JSON.stringify(settings.codexCategoryCustomSections || {})) as Record<string, unknown[]>,
        codexCategoryFieldTemplates: { ...(settings.codexCategoryFieldTemplates || {}) },
        profileOrientations: { ...(settings.profileOrientations || {}) },
        profileFieldInputHeights: sanitizeCustomFieldInputHeightMap(settings.profileFieldInputHeights || {}),
        profileFieldOverrides: sanitizeProfileFieldOverrides(settings.profileFieldOverrides || {}),
        profileSectionOrders: sanitizeStringListMap(settings.profileSectionOrders || {}),
    };
}

export function applyLibraryProfileLayout(
    settings: SceneCardsSettings,
    layout: LibraryProfileLayoutSettings,
): void {
    settings.hiddenFields = { ...(layout.hiddenFields || {}) };
    settings.removedBuiltinFields = { ...(layout.removedBuiltinFields || {}) };
    settings.removedBuiltinSections = { ...(layout.removedBuiltinSections || {}) };
    settings.characterCustomSections = Array.isArray(layout.characterCustomSections)
        ? (layout.characterCustomSections as SceneCardsSettings['characterCustomSections'])
        : [];
    settings.locationCustomSections = Array.isArray(layout.locationCustomSections)
        ? (layout.locationCustomSections as SceneCardsSettings['locationCustomSections'])
        : [];
    settings.codexCategoryCustomSections = { ...(layout.codexCategoryCustomSections || {}) } as SceneCardsSettings['codexCategoryCustomSections'];
    settings.codexCategoryFieldTemplates = { ...(layout.codexCategoryFieldTemplates || {}) };
    settings.profileOrientations = { ...(layout.profileOrientations || {}) };
    settings.profileFieldInputHeights = { ...(layout.profileFieldInputHeights || {}) };
    settings.profileFieldOverrides = JSON.parse(JSON.stringify(layout.profileFieldOverrides || {})) as SceneCardsSettings['profileFieldOverrides'];
    settings.profileSectionOrders = sanitizeStringListMap(layout.profileSectionOrders || {});
}

export function libraryProfileLayoutFromUnknown(raw: unknown): LibraryProfileLayoutSettings | null {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
    const rec = raw as Record<string, unknown>;
    // Treat an empty/missing file as "not stored yet" only when nothing useful is present.
    const hasAny =
        isRecord(rec.hiddenFields)
        || isRecord(rec.removedBuiltinFields)
        || isRecord(rec.removedBuiltinSections)
        || Array.isArray(rec.characterCustomSections)
        || Array.isArray(rec.locationCustomSections)
        || isRecord(rec.codexCategoryCustomSections)
        || isRecord(rec.codexCategoryFieldTemplates)
        || isRecord(rec.profileOrientations)
        || isRecord(rec.profileFieldInputHeights)
        || isRecord(rec.profileFieldOverrides)
        || isRecord(rec.profileSectionOrders);
    if (!hasAny && !('version' in rec)) return null;

    return {
        hiddenFields: isRecord(rec.hiddenFields)
            ? sanitizeStringListMap(rec.hiddenFields)
            : {},
        removedBuiltinFields: isRecord(rec.removedBuiltinFields)
            ? sanitizeStringListMap(rec.removedBuiltinFields)
            : {},
        removedBuiltinSections: isRecord(rec.removedBuiltinSections)
            ? sanitizeStringListMap(rec.removedBuiltinSections)
            : {},
        characterCustomSections: Array.isArray(rec.characterCustomSections) ? rec.characterCustomSections : [],
        locationCustomSections: Array.isArray(rec.locationCustomSections) ? rec.locationCustomSections : [],
        codexCategoryCustomSections: isRecord(rec.codexCategoryCustomSections)
            ? Object.fromEntries(
                Object.entries(rec.codexCategoryCustomSections).map(([k, v]) => [
                    k,
                    Array.isArray(v) ? v : [],
                ]),
            )
            : {},
        codexCategoryFieldTemplates: isRecord(rec.codexCategoryFieldTemplates)
            ? sanitizeStringListMap(rec.codexCategoryFieldTemplates)
            : {},
        profileOrientations: isRecord(rec.profileOrientations)
            ? sanitizeOrientationMap(rec.profileOrientations)
            : {},
        profileFieldInputHeights: isRecord(rec.profileFieldInputHeights)
            ? sanitizeCustomFieldInputHeightMap(rec.profileFieldInputHeights)
            : {},
        profileFieldOverrides: isRecord(rec.profileFieldOverrides)
            ? sanitizeProfileFieldOverrides(rec.profileFieldOverrides)
            : {},
        profileSectionOrders: isRecord(rec.profileSectionOrders)
            ? sanitizeStringListMap(rec.profileSectionOrders)
            : {},
    };
}

function sanitizeProfileFieldOverrides(raw: Record<string, unknown>): Record<string, Record<string, ProfileFieldOverride>> {
    const out: Record<string, Record<string, ProfileFieldOverride>> = {};
    for (const [category, fields] of Object.entries(raw)) {
        if (!isRecord(fields)) continue;
        const cleanFields: Record<string, ProfileFieldOverride> = {};
        for (const [fieldKey, value] of Object.entries(fields)) {
            if (!fieldKey || !isRecord(value)) continue;
            const label = typeof value.label === 'string' ? value.label.trim() : '';
            const placeholder = typeof value.placeholder === 'string' ? value.placeholder.trim() : '';
            if (label || placeholder) cleanFields[fieldKey] = {
                ...(label ? { label } : {}),
                ...(placeholder ? { placeholder } : {}),
            };
        }
        if (Object.keys(cleanFields).length > 0) out[category] = cleanFields;
    }
    return out;
}

export function sanitizeCustomFieldInputHeightMap(raw: Record<string, unknown>): Record<string, number> {
    const out: Record<string, number> = {};
    for (const [key, value] of Object.entries(raw)) {
        const height = normalizeCustomFieldInputHeight(value);
        if (key && height !== undefined) out[key] = height;
    }
    return out;
}

function sanitizeOrientationMap(raw: Record<string, unknown>): Record<string, LibraryProfileOrientation> {
    const out: Record<string, LibraryProfileOrientation> = {};
    for (const [key, value] of Object.entries(raw)) {
        if (value === 'horizontal' || value === 'vertical') out[key] = value;
    }
    return out;
}

export function getLibraryProfileOrientation(
    settings: SceneCardsSettings,
    categoryKey: string,
): LibraryProfileOrientation {
    return settings.profileOrientations?.[categoryKey] === 'vertical'
        ? 'vertical'
        : 'horizontal';
}

export async function setLibraryProfileOrientation(
    settings: SceneCardsSettings,
    categoryKey: string,
    orientation: LibraryProfileOrientation,
    save: () => Promise<void>,
): Promise<void> {
    if (!settings.profileOrientations) settings.profileOrientations = {};
    const previous = settings.profileOrientations[categoryKey];
    settings.profileOrientations[categoryKey] = orientation;
    try {
        await save();
    } catch (error) {
        if (previous) settings.profileOrientations[categoryKey] = previous;
        else delete settings.profileOrientations[categoryKey];
        throw error;
    }
}

function isRecord(v: unknown): v is Record<string, unknown> {
    return !!v && typeof v === 'object' && !Array.isArray(v);
}

function sanitizeStringListMap(raw: Record<string, unknown>): Record<string, string[]> {
    const out: Record<string, string[]> = {};
    for (const [k, v] of Object.entries(raw)) {
        if (!Array.isArray(v)) continue;
        out[k] = v.map(x => String(x)).filter(Boolean);
    }
    return out;
}

export function isCoreProfileField(fieldKey: string): boolean {
    return CORE_UNDELETABLE.has(fieldKey);
}

export function getHiddenFieldKeys(settings: SceneCardsSettings, categoryKey: string): string[] {
    return settings.hiddenFields?.[categoryKey] ?? [];
}

/** Resolve a stored section order without losing sections introduced by an update. */
export function getOrderedProfileSectionIds(
    settings: SceneCardsSettings,
    categoryKey: string,
    defaultIds: string[],
): string[] {
    const allowed = new Set(defaultIds);
    const result: string[] = [];
    const seen = new Set<string>();
    for (const id of settings.profileSectionOrders?.[categoryKey] ?? []) {
        if (!allowed.has(id) || seen.has(id)) continue;
        result.push(id);
        seen.add(id);
    }
    for (const id of defaultIds) {
        if (seen.has(id)) continue;
        result.push(id);
        seen.add(id);
    }
    return result;
}

/** Return the one shared action group used by built-in and custom section headers. */
export function getProfileSectionActions(header: HTMLElement): HTMLElement {
    const existing = header.querySelector<HTMLElement>('.codex-section-actions');
    const actions = existing ?? header.createSpan({ cls: 'codex-section-actions' });
    actions.addClass('profile-section-actions');
    return actions;
}

/** Create one icon action with the shared section-header chrome. */
export function createProfileSectionAction(
    header: HTMLElement,
    opts: {
        icon: string;
        title: string;
        ariaLabel?: string;
        className?: string;
    },
): HTMLElement {
    const action = getProfileSectionActions(header).createSpan({
        cls: `codex-section-action-btn profile-section-action-btn${opts.className ? ` ${opts.className}` : ''}`,
        attr: {
            role: 'button',
            title: t(opts.title),
            'aria-label': t(opts.ariaLabel || opts.title),
        },
    });
    obsidian.setIcon(action, opts.icon);
    if (opts.className?.includes('profile-section-add-field-btn')) {
        const destructive = getProfileSectionActions(header).querySelector('.builtin-section-remove-btn');
        if (destructive) getProfileSectionActions(header).insertBefore(action, destructive);
    }
    return action;
}

/** Two compact controls shared by every built-in/custom-fields section header. */
export function attachProfileSectionOrderControls(
    header: HTMLElement,
    opts: {
        settings: SceneCardsSettings;
        categoryKey: string;
        sectionId: string;
        defaultIds: string[];
        save: () => Promise<void>;
        onChanged: () => void;
    },
): void {
    const order = getOrderedProfileSectionIds(opts.settings, opts.categoryKey, opts.defaultIds);
    const index = order.indexOf(opts.sectionId);
    const add = (direction: -1 | 1, icon: string, label: string, disabled: boolean): void => {
        const button = createProfileSectionAction(header, {
            icon,
            title: label,
            className: 'profile-section-order-btn',
        });
        if (disabled) {
            button.setAttr('data-disabled', 'true');
            button.setAttr('aria-disabled', 'true');
        }
        button.addEventListener('click', event => {
            event.preventDefault();
            event.stopPropagation();
            if (button.hasAttribute('data-disabled')) return;
            const current = getOrderedProfileSectionIds(opts.settings, opts.categoryKey, opts.defaultIds);
            const from = current.indexOf(opts.sectionId);
            const to = from + direction;
            if (from < 0 || to < 0 || to >= current.length) return;
            [current[from], current[to]] = [current[to], current[from]];
            const sectionOrders = opts.settings.profileSectionOrders ??= {};
            const previous = sectionOrders[opts.categoryKey];
            sectionOrders[opts.categoryKey] = current;
            void (async () => {
                try {
                    await opts.save();
                    opts.onChanged();
                } catch (error) {
                    if (previous) sectionOrders[opts.categoryKey] = previous;
                    else delete sectionOrders[opts.categoryKey];
                    console.error('[NarrativeLab] Failed to save profile section order:', error);
                }
            })();
        });
    };
    add(-1, 'chevron-up', 'Move section up', index <= 0);
    add(1, 'chevron-down', 'Move section down', index < 0 || index >= order.length - 1);
}

export function universalProfileFieldKey(templateId: string): string {
    return `universal:${templateId}`;
}

export function getBuiltinProfileFieldOverride(
    settings: SceneCardsSettings,
    categoryKey: string,
    fieldKey: string,
): ProfileFieldOverride | undefined {
    return settings.profileFieldOverrides?.[categoryKey]?.[fieldKey];
}

/** Pencil action shared by built-in fields so both field kinds expose the same toolbar. */
export function attachBuiltinFieldEditControl(
    labelEl: HTMLElement,
    opts: {
        app: App;
        settings: SceneCardsSettings;
        categoryKey: string;
        fieldKey: string;
        defaultLabel: string;
        defaultPlaceholder: string;
        save: () => Promise<void>;
        onChanged: () => void;
    },
): void {
    const editBtn = labelEl.createEl('span', {
        cls: 'profile-field-action-btn profile-field-edit-btn',
        attr: { 'aria-label': t('Edit field'), title: t('Edit field'), role: 'button' },
    });
    obsidian.setIcon(editBtn, 'pencil');
    editBtn.addEventListener('click', (event) => {
        event.preventDefault();
        event.stopPropagation();
        const existing = getBuiltinProfileFieldOverride(opts.settings, opts.categoryKey, opts.fieldKey);
        const translatedDefaultLabel = t(opts.defaultLabel);
        const translatedDefaultPlaceholder = t(opts.defaultPlaceholder);
        let label = existing?.label ?? translatedDefaultLabel;
        let placeholder = existing?.placeholder ?? translatedDefaultPlaceholder;
        const modal = new obsidian.Modal(opts.app);
        modal.titleEl.setText(t('Edit field'));
        new obsidian.Setting(modal.contentEl)
            .setName(t('Field label'))
            .addText(text => text.setValue(label).onChange(value => { label = value; }));
        new obsidian.Setting(modal.contentEl)
            .setName(t('Placeholder'))
            .addText(text => text.setValue(placeholder).onChange(value => { placeholder = value; }));
        new obsidian.Setting(modal.contentEl)
            .addButton(button => button.setButtonText(t('Reset')).onClick(async () => {
                const category = opts.settings.profileFieldOverrides?.[opts.categoryKey];
                if (category) {
                    delete category[opts.fieldKey];
                    if (Object.keys(category).length === 0) delete opts.settings.profileFieldOverrides![opts.categoryKey];
                }
                await opts.save();
                modal.close();
                opts.onChanged();
            }))
            .addButton(button => button.setButtonText(t('Cancel')).onClick(() => modal.close()))
            .addButton(button => button.setButtonText(t('Save')).setCta().onClick(async () => {
                if (!opts.settings.profileFieldOverrides) opts.settings.profileFieldOverrides = {};
                if (!opts.settings.profileFieldOverrides[opts.categoryKey]) {
                    opts.settings.profileFieldOverrides[opts.categoryKey] = {};
                }
                const cleanLabel = label.trim();
                const cleanPlaceholder = placeholder.trim();
                const next: ProfileFieldOverride = {
                    ...(cleanLabel && cleanLabel !== translatedDefaultLabel ? { label: cleanLabel } : {}),
                    ...(cleanPlaceholder && cleanPlaceholder !== translatedDefaultPlaceholder ? { placeholder: cleanPlaceholder } : {}),
                };
                if (Object.keys(next).length > 0) {
                    opts.settings.profileFieldOverrides[opts.categoryKey][opts.fieldKey] = next;
                } else {
                    delete opts.settings.profileFieldOverrides[opts.categoryKey][opts.fieldKey];
                }
                await opts.save();
                modal.close();
                opts.onChanged();
            }));
        modal.open();
    });
}

export function getRemovedBuiltinFieldKeys(settings: SceneCardsSettings, categoryKey: string): string[] {
    return settings.removedBuiltinFields?.[categoryKey] ?? [];
}

export function getRemovedBuiltinSectionTitles(settings: SceneCardsSettings, categoryKey: string): string[] {
    return settings.removedBuiltinSections?.[categoryKey] ?? [];
}

export function isBuiltinSectionRemoved(
    settings: SceneCardsSettings,
    categoryKey: string,
    sectionTitle: string,
): boolean {
    return getRemovedBuiltinSectionTitles(settings, categoryKey).includes(sectionTitle);
}

/** Sections that still contain undeletable core fields (e.g. name) cannot be removed whole. */
export function canRemoveBuiltinSection(fields: Array<{ key: string }>): boolean {
    return fields.length > 0 && !fields.some(f => isCoreProfileField(f.key));
}

export async function removeBuiltinProfileSection(
    settings: SceneCardsSettings,
    categoryKey: string,
    sectionTitle: string,
    fieldKeys: string[],
    save: () => Promise<void>,
): Promise<void> {
    if (!settings.removedBuiltinSections) settings.removedBuiltinSections = {};
    if (!settings.removedBuiltinSections[categoryKey]) settings.removedBuiltinSections[categoryKey] = [];
    const sections = settings.removedBuiltinSections[categoryKey];
    if (!sections.includes(sectionTitle)) sections.push(sectionTitle);

    if (!settings.removedBuiltinFields) settings.removedBuiltinFields = {};
    if (!settings.removedBuiltinFields[categoryKey]) settings.removedBuiltinFields[categoryKey] = [];
    const fields = settings.removedBuiltinFields[categoryKey];
    for (const key of fieldKeys) {
        if (isCoreProfileField(key)) continue;
        if (!fields.includes(key)) fields.push(key);
    }
    const hidden = settings.hiddenFields?.[categoryKey];
    if (hidden) {
        for (const key of fieldKeys) {
            const i = hidden.indexOf(key);
            if (i >= 0) hidden.splice(i, 1);
        }
    }
    await save();
}

export async function restoreBuiltinProfileSection(
    settings: SceneCardsSettings,
    categoryKey: string,
    sectionTitle: string,
    fieldKeys: string[],
    save: () => Promise<void>,
): Promise<void> {
    const sections = settings.removedBuiltinSections?.[categoryKey];
    if (sections) {
        const i = sections.indexOf(sectionTitle);
        if (i >= 0) sections.splice(i, 1);
    }
    const fields = settings.removedBuiltinFields?.[categoryKey];
    if (fields) {
        for (const key of fieldKeys) {
            const i = fields.indexOf(key);
            if (i >= 0) fields.splice(i, 1);
        }
    }
    await save();
}

/** Drop permanently removed built-ins from a category field list. */
export function filterRemovedBuiltinFields<T extends { key: string }>(
    fields: T[],
    settings: SceneCardsSettings,
    categoryKey: string,
): T[] {
    const removed = new Set(getRemovedBuiltinFieldKeys(settings, categoryKey));
    if (removed.size === 0) return fields;
    return fields.filter(f => !removed.has(f.key));
}

export async function toggleHiddenProfileField(
    settings: SceneCardsSettings,
    categoryKey: string,
    fieldKey: string,
    save: () => Promise<void>,
): Promise<void> {
    if (!settings.hiddenFields) settings.hiddenFields = {};
    if (!settings.hiddenFields[categoryKey]) settings.hiddenFields[categoryKey] = [];
    const list = settings.hiddenFields[categoryKey];
    const idx = list.indexOf(fieldKey);
    if (idx >= 0) list.splice(idx, 1);
    else list.push(fieldKey);
    await save();
}

export async function removeBuiltinProfileField(
    settings: SceneCardsSettings,
    categoryKey: string,
    fieldKey: string,
    save: () => Promise<void>,
): Promise<void> {
    if (isCoreProfileField(fieldKey)) return;
    if (!settings.removedBuiltinFields) settings.removedBuiltinFields = {};
    if (!settings.removedBuiltinFields[categoryKey]) settings.removedBuiltinFields[categoryKey] = [];
    const list = settings.removedBuiltinFields[categoryKey];
    if (!list.includes(fieldKey)) list.push(fieldKey);
    // Also drop from hidden list if present.
    const hidden = settings.hiddenFields?.[categoryKey];
    if (hidden) {
        const i = hidden.indexOf(fieldKey);
        if (i >= 0) hidden.splice(i, 1);
    }
    await save();
}

export async function restoreBuiltinProfileField(
    settings: SceneCardsSettings,
    categoryKey: string,
    fieldKey: string,
    save: () => Promise<void>,
): Promise<void> {
    const list = settings.removedBuiltinFields?.[categoryKey];
    if (!list) return;
    const i = list.indexOf(fieldKey);
    if (i >= 0) list.splice(i, 1);
    await save();
}

/**
 * Hide + delete controls for built-in archive fields.
 * Core fields (`name`) cannot be deleted; `name` also cannot be hidden.
 */
export function attachBuiltinFieldVisibilityControls(
    labelEl: HTMLElement,
    opts: {
        app: App;
        settings: SceneCardsSettings;
        categoryKey: string;
        fieldKey: string;
        fieldLabel: string;
        save: () => Promise<void>;
        onChanged: () => void;
    },
): void {
    const { settings, categoryKey, fieldKey } = opts;
    const canHide = fieldKey !== 'name';
    const canDelete = !isCoreProfileField(fieldKey);

    const hiddenKeys = getHiddenFieldKeys(settings, categoryKey);
    const isHidden = hiddenKeys.includes(fieldKey);
    const hideBtn = labelEl.createEl('span', {
        cls: 'profile-field-action-btn field-hide-btn',
        attr: {
            'aria-label': isHidden ? t('Show this field') : t('Hide this field'),
            title: isHidden ? t('Show this field') : t('Hide this field'),
            role: 'button',
            ...(canHide ? {} : { 'aria-disabled': 'true' }),
        },
    });
    obsidian.setIcon(hideBtn, isHidden ? 'eye' : 'eye-off');
    if (canHide) {
        hideBtn.addEventListener('click', (e) => {
            e.stopPropagation();
            void toggleHiddenProfileField(settings, categoryKey, fieldKey, opts.save)
                .then(() => opts.onChanged());
        });
    }

    const removeBtn = labelEl.createEl('span', {
        cls: 'profile-field-action-btn field-remove-btn',
        attr: {
            'aria-label': t('Remove field'),
            title: t('Remove this default field from this archive page'),
            role: 'button',
            ...(canDelete ? {} : { 'aria-disabled': 'true' }),
        },
    });
    obsidian.setIcon(removeBtn, 'x');
    if (canDelete) {
        removeBtn.addEventListener('click', (e) => {
            e.stopPropagation();
            openConfirmModal(opts.app, {
                title: t('Remove Field'),
                message: t(
                    'Remove “{field}” from this archive page in the current project? Existing note data is kept; you can restore the field later.',
                    { field: t(opts.fieldLabel) },
                ),
                confirmLabel: t('Remove field'),
                confirmClass: 'mod-warning',
                onConfirm: async () => {
                    await removeBuiltinProfileField(settings, categoryKey, fieldKey, opts.save);
                    opts.onChanged();
                },
            });
        });
    }
}

/** Hide + delete actions for a universal field, matching built-in field chrome. */
export function attachUniversalProfileFieldControls(
    labelEl: HTMLElement,
    opts: {
        app: App;
        settings: SceneCardsSettings;
        categoryKey: string;
        templateId: string;
        fieldLabel: string;
        save: () => Promise<void>;
        remove: () => Promise<void>;
        onChanged: () => void;
    },
): void {
    const layoutKey = universalProfileFieldKey(opts.templateId);
    const isHidden = getHiddenFieldKeys(opts.settings, opts.categoryKey).includes(layoutKey);
    const hideBtn = labelEl.createEl('span', {
        cls: 'profile-field-action-btn field-hide-btn',
        attr: {
            'aria-label': isHidden ? t('Show this field') : t('Hide this field'),
            title: isHidden ? t('Show this field') : t('Hide this field'),
            role: 'button',
        },
    });
    obsidian.setIcon(hideBtn, isHidden ? 'eye' : 'eye-off');
    hideBtn.addEventListener('click', (event) => {
        event.preventDefault();
        event.stopPropagation();
        void toggleHiddenProfileField(opts.settings, opts.categoryKey, layoutKey, opts.save)
            .then(() => opts.onChanged());
    });

    const removeBtn = labelEl.createEl('span', {
        cls: 'profile-field-action-btn field-remove-btn',
        attr: { 'aria-label': t('Remove field'), title: t('Remove field'), role: 'button' },
    });
    obsidian.setIcon(removeBtn, 'x');
    removeBtn.addEventListener('click', (event) => {
        event.preventDefault();
        event.stopPropagation();
        openConfirmModal(opts.app, {
            title: t('Remove Field'),
            message: t(
                'Remove “{field}” from this archive page in the current project? Existing note data is kept; you can restore the field later.',
                { field: opts.fieldLabel },
            ),
            confirmLabel: t('Remove field'),
            confirmClass: 'mod-warning',
            onConfirm: async () => {
                await opts.remove();
                const hidden = opts.settings.hiddenFields?.[opts.categoryKey];
                if (hidden) {
                    const index = hidden.indexOf(layoutKey);
                    if (index >= 0) hidden.splice(index, 1);
                    await opts.save();
                }
                opts.onChanged();
            },
        });
    });
}

/** Collapsible list of removed default fields with Restore actions. */
export function renderRemovedBuiltinFieldsToggle(
    parent: HTMLElement,
    opts: {
        settings: SceneCardsSettings;
        categoryKey: string;
        /** All built-in fields that belong to this section (before removal filter). */
        sectionFields: Array<{ key: string; label: string }>;
        save: () => Promise<void>;
        onChanged: () => void;
    },
): void {
    const removedKeys = new Set(getRemovedBuiltinFieldKeys(opts.settings, opts.categoryKey));
    const removedInSection = opts.sectionFields.filter(f => removedKeys.has(f.key));
    if (removedInSection.length === 0) return;

    const toggleEl = parent.createDiv('removed-fields-toggle');
    toggleEl.createEl('a', {
        text: removedInSection.length > 1
            ? t('Show {count} removed fields', { count: removedInSection.length })
            : t('Show {count} removed field', { count: removedInSection.length }),
        cls: 'removed-fields-toggle-link',
    });
    const listEl = parent.createDiv('removed-fields-container');
    listEl.setCssStyles({ display: 'none' });
    for (const field of removedInSection) {
        const row = listEl.createDiv('removed-field-row');
        row.createSpan({ text: t(field.label), cls: 'removed-field-label' });
        const restoreBtn = row.createEl('button', {
            cls: 'removed-field-restore-btn',
            text: t('Restore'),
            attr: { type: 'button' },
        });
        restoreBtn.addEventListener('click', (e) => {
            e.preventDefault();
            e.stopPropagation();
            void restoreBuiltinProfileField(opts.settings, opts.categoryKey, field.key, opts.save)
                .then(() => opts.onChanged());
        });
    }
    let showing = false;
    toggleEl.addEventListener('click', () => {
        showing = !showing;
        listEl.setCssStyles({ display: showing ? '' : 'none' });
        const a = toggleEl.querySelector('a');
        if (!a) return;
        a.textContent = showing
            ? (removedInSection.length > 1
                ? t('Hide {count} removed fields', { count: removedInSection.length })
                : t('Hide {count} removed field', { count: removedInSection.length }))
            : (removedInSection.length > 1
                ? t('Show {count} removed fields', { count: removedInSection.length })
                : t('Show {count} removed field', { count: removedInSection.length }));
    });
}

/**
 * X control on a built-in section header — removes the whole column from this
 * archive page (fields stay on disk and can be restored).
 */
export function attachBuiltinSectionRemoveControl(
    headerEl: HTMLElement,
    opts: {
        app: App;
        settings: SceneCardsSettings;
        categoryKey: string;
        sectionTitle: string;
        sectionFields: Array<{ key: string }>;
        save: () => Promise<void>;
        onChanged: () => void;
    },
): void {
    if (!canRemoveBuiltinSection(opts.sectionFields)) return;

    const actions = getProfileSectionActions(headerEl);
    actions.addClass('builtin-section-actions');
    const removeBtn = createProfileSectionAction(headerEl, {
        icon: 'trash',
        title: 'Remove this section from this archive page',
        ariaLabel: 'Remove section',
        className: 'builtin-section-remove-btn',
    });
    removeBtn.addEventListener('click', (e) => {
        e.preventDefault();
        e.stopPropagation();
        openConfirmModal(opts.app, {
            title: t('Remove Section'),
            message: t(
                'Remove “{section}” from this archive page in the current project? Existing note data is kept; you can restore the section later.',
                { section: t(opts.sectionTitle) },
            ),
            confirmLabel: t('Remove section'),
            confirmClass: 'mod-warning',
            onConfirm: async () => {
                await removeBuiltinProfileSection(
                    opts.settings,
                    opts.categoryKey,
                    opts.sectionTitle,
                    opts.sectionFields.map(f => f.key),
                    opts.save,
                );
                opts.onChanged();
            },
        });
    });
}

/** Collapsible list of removed built-in sections with Restore actions. */
export function renderRemovedBuiltinSectionsToggle(
    parent: HTMLElement,
    opts: {
        settings: SceneCardsSettings;
        categoryKey: string;
        /** All built-in sections for this archive page. */
        sections: Array<{ title: string; fields: Array<{ key: string }> }>;
        save: () => Promise<void>;
        onChanged: () => void;
    },
): void {
    const removedTitles = new Set(getRemovedBuiltinSectionTitles(opts.settings, opts.categoryKey));
    const removedSections = opts.sections.filter(s => removedTitles.has(s.title));
    if (removedSections.length === 0) return;

    const toggleEl = parent.createDiv('removed-fields-toggle removed-sections-toggle');
    toggleEl.createEl('a', {
        text: removedSections.length > 1
            ? t('Show {count} removed sections', { count: removedSections.length })
            : t('Show {count} removed section', { count: removedSections.length }),
        cls: 'removed-fields-toggle-link',
    });
    const listEl = parent.createDiv('removed-fields-container');
    listEl.setCssStyles({ display: 'none' });
    for (const section of removedSections) {
        const row = listEl.createDiv('removed-field-row');
        row.createSpan({ text: t(section.title), cls: 'removed-field-label' });
        const restoreBtn = row.createEl('button', {
            cls: 'removed-field-restore-btn',
            text: t('Restore'),
            attr: { type: 'button' },
        });
        restoreBtn.addEventListener('click', (e) => {
            e.preventDefault();
            e.stopPropagation();
            void restoreBuiltinProfileSection(
                opts.settings,
                opts.categoryKey,
                section.title,
                section.fields.map(f => f.key),
                opts.save,
            ).then(() => opts.onChanged());
        });
    }
    let showing = false;
    toggleEl.addEventListener('click', () => {
        showing = !showing;
        listEl.setCssStyles({ display: showing ? '' : 'none' });
        const a = toggleEl.querySelector('a');
        if (!a) return;
        a.textContent = showing
            ? (removedSections.length > 1
                ? t('Hide {count} removed sections', { count: removedSections.length })
                : t('Hide {count} removed section', { count: removedSections.length }))
            : (removedSections.length > 1
                ? t('Show {count} removed sections', { count: removedSections.length })
                : t('Show {count} removed section', { count: removedSections.length }));
    });
}
