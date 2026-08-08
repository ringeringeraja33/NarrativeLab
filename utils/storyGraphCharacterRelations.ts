import type {
    Character,
    CharacterRelation,
    CharacterRelationCategory,
} from '../models/Character';
import {
    RELATION_BASE_TYPE_BY_CATEGORY,
    RELATION_CATEGORIES,
    inferCategoryForType,
    normalizeCharacterRelations,
} from '../models/Character';
import type { RelationshipType } from '../components/RelationshipMap';
import { localizeForLanguage, seedUiLanguage, type UiLanguage } from './i18n';
import type { App } from 'obsidian';

/** Editable character-relation style shown on the Story Graph + legend. */
export interface StoryGraphCharacterRelationType {
    id: string;
    label: string;
    color: string;
    arrow: 'single' | 'double';
    /** Maps to Story Graph edge kind / reciprocal writer. */
    baseType: RelationshipType;
    /** Library relation category this style belongs to. */
    category: CharacterRelationCategory;
    /** Built-in category rows (family/social/…). */
    builtin?: boolean;
}

const CATEGORY_COLORS: Record<CharacterRelationCategory, string> = {
    family: '#FF9800',
    romantic: '#E91E63',
    social: '#4CAF50',
    conflict: '#F44336',
    guidance: '#9C27B0',
    professional: '#3F51B5',
    story: '#009688',
    custom: '#9E9E9E',
};

/** Default CharacterRelation.type when assigning a category-level style from the graph. */
export const DEFAULT_RELATION_TYPE_BY_CATEGORY: Record<CharacterRelationCategory, string> = {
    family: 'sibling',
    romantic: 'partner',
    social: 'ally',
    conflict: 'enemy',
    guidance: 'mentor',
    professional: 'colleague',
    story: 'protector',
    custom: 'other',
};

/** Old Story Graph style ids → library relation categories. */
const LEGACY_STYLE_TO_CATEGORY: Record<string, CharacterRelationCategory> = {
    ally: 'social',
    enemy: 'conflict',
    hostile: 'conflict',
    family: 'family',
    romantic: 'romantic',
    romance: 'romantic',
    mentor: 'guidance',
    other: 'custom',
};

const CATEGORY_IDS = new Set<string>(RELATION_CATEGORIES.map(c => c.value));

/**
 * Built-in legend styles. `seedLang` picks the one-shot display labels
 * (Obsidian zh/en); stored labels are not retranslated later.
 */
export function defaultCharacterRelationTypes(
    seedLang: UiLanguage = 'en',
): StoryGraphCharacterRelationType[] {
    return RELATION_CATEGORIES.map(cat => ({
        id: cat.value,
        label: localizeForLanguage(seedLang, cat.label),
        color: CATEGORY_COLORS[cat.value],
        arrow: 'double' as const,
        baseType: RELATION_BASE_TYPE_BY_CATEGORY[cat.value],
        category: cat.value,
        builtin: true,
    }));
}

function isRelationCategory(value: string): value is CharacterRelationCategory {
    return CATEGORY_IDS.has(value);
}

export function normalizeCharacterRelationType(
    raw: Partial<StoryGraphCharacterRelationType> & { id?: string; label?: string },
): StoryGraphCharacterRelationType | null {
    let id = typeof raw.id === 'string' ? raw.id.trim().toLowerCase().replace(/\s+/g, '-') : '';
    const label = typeof raw.label === 'string' ? raw.label.trim() : '';
    if (!id || !label) return null;

    // Migrate legacy ally/enemy/… ids onto library categories.
    const legacyCat = LEGACY_STYLE_TO_CATEGORY[id];
    if (legacyCat) id = legacyCat;

    let category: CharacterRelationCategory = isRelationCategory(String(raw.category))
        ? raw.category as CharacterRelationCategory
        : (isRelationCategory(id) ? id : 'custom');

    if (legacyCat) category = legacyCat;

    const baseType: RelationshipType = (
        raw.baseType === 'ally'
        || raw.baseType === 'enemy'
        || raw.baseType === 'family'
        || raw.baseType === 'romantic'
        || raw.baseType === 'mentor'
        || raw.baseType === 'other'
    ) ? raw.baseType : RELATION_BASE_TYPE_BY_CATEGORY[category];

    const builtin = CATEGORY_IDS.has(id) || !!raw.builtin;

    const defaultLabel = RELATION_CATEGORIES.find(c => c.value === id)?.label;
    // Keep user label; only fall back to canonical category label when migrating legacy ids.
    const wasLegacy = !!LEGACY_STYLE_TO_CATEGORY[String(raw.id || '').trim().toLowerCase()];
    const resolvedLabel = wasLegacy && defaultLabel && (label === 'Ally' || label === 'Hostile' || label === 'Romance' || label === 'Mentor' || label === 'Other' || label === 'Family')
        ? defaultLabel
        : label;

    return {
        id,
        label: resolvedLabel,
        color: typeof raw.color === 'string' && raw.color.trim()
            ? raw.color.trim()
            : CATEGORY_COLORS[category],
        arrow: raw.arrow === 'single' ? 'single' : 'double',
        baseType,
        category,
        builtin,
    };
}

/**
 * True when this legend style is applied on at least one character relation.
 * Builtin category rows count as used when any relation sits in that category.
 */
export function isCharacterRelationTypeInUse(
    style: StoryGraphCharacterRelationType,
    characters: Character[],
): boolean {
    const id = style.id.trim().toLowerCase();
    const label = style.label.trim().toLowerCase();
    for (const character of characters) {
        for (const rel of normalizeCharacterRelations(character.relations)) {
            const typeKey = rel.type.trim().toLowerCase();
            if (typeKey && (typeKey === id || typeKey === label)) return true;
            if (
                style.builtin
                && (rel.category === style.category || rel.category === style.id)
            ) {
                return true;
            }
        }
    }
    return false;
}

/** Merge saved styles with library categories + types discovered on character notes. */
export function mergeCharacterRelationTypes(
    saved: Array<Partial<StoryGraphCharacterRelationType> & { id?: string; label?: string }> | undefined,
    characters: Character[],
    seedLang: UiLanguage = 'en',
): StoryGraphCharacterRelationType[] {
    const defaults = defaultCharacterRelationTypes(seedLang);
    const byId = new Map<string, StoryGraphCharacterRelationType>();
    const savedList = saved || [];

    // Fresh install / empty settings → show full library category set (seed language).
    // Once the user has saved a list, respect deletions of unused builtins.
    if (savedList.length === 0) {
        for (const d of defaults) byId.set(d.id, { ...d });
    }

    for (const raw of savedList) {
        const n = normalizeCharacterRelationType(raw);
        if (!n) continue;
        const prev = byId.get(n.id);
        byId.set(n.id, {
            ...n,
            builtin: prev?.builtin || n.builtin || CATEGORY_IDS.has(n.id),
            // Prefer user-saved label for builtins when they customized it
            label: (prev?.builtin || CATEGORY_IDS.has(n.id))
                ? (n.label && n.label !== prev?.label ? n.label : (prev?.label || n.label))
                : (n.label || prev?.label || n.id),
            color: n.color || prev?.color || CATEGORY_COLORS[n.category],
            arrow: n.arrow || prev?.arrow || 'double',
        });
    }

    // Rehydrate builtins that are still applied on character notes.
    for (const d of defaults) {
        if (byId.has(d.id)) continue;
        if (isCharacterRelationTypeInUse(d, characters)) {
            byId.set(d.id, { ...d });
        }
    }

    // Import custom types found on character notes (not covered by category builtins).
    for (const character of characters) {
        for (const rel of normalizeCharacterRelations(character.relations)) {
            const typeKey = rel.type.trim().toLowerCase();
            if (!typeKey || byId.has(typeKey) || CATEGORY_IDS.has(typeKey)) continue;
            // Skip built-in DETAILED types — they map to category legend entries.
            if (inferCategoryForType(rel.type) !== 'custom' && rel.category !== 'custom') continue;
            const category: CharacterRelationCategory = rel.category === 'custom'
                ? 'custom'
                : (isRelationCategory(rel.category) ? rel.category : 'custom');
            byId.set(typeKey, {
                id: typeKey,
                label: rel.type.trim(),
                color: CATEGORY_COLORS[category],
                arrow: 'double',
                baseType: RELATION_BASE_TYPE_BY_CATEGORY[category],
                category,
                builtin: false,
            });
        }
    }

    const builtinIds = new Set(defaults.map(d => d.id));
    const builtins = defaults.map(d => byId.get(d.id)!).filter(Boolean);
    const customs = [...byId.values()]
        .filter(s => !builtinIds.has(s.id))
        .sort((a, b) => a.label.localeCompare(b.label));
    return [...builtins, ...customs];
}

/** Custom (non-category) types shared with Character profile relation pickers. */
export function listCustomCharacterRelationTypes(
    styles: StoryGraphCharacterRelationType[],
): StoryGraphCharacterRelationType[] {
    return styles.filter(s => !s.builtin && !CATEGORY_IDS.has(s.id));
}

export function resolveCharacterRelationStyle(
    relation: CharacterRelation,
    styles: StoryGraphCharacterRelationType[],
): StoryGraphCharacterRelationType {
    const typeKey = relation.type.trim().toLowerCase();
    const byType = styles.find(s => s.id === typeKey || s.id === relation.type);
    if (byType) return byType;

    const category = isRelationCategory(relation.category)
        ? relation.category
        : inferCategoryForType(relation.type);
    const byCat = styles.find(s => s.builtin && s.category === category)
        || styles.find(s => s.id === category);
    if (byCat) return byCat;

    return styles.find(s => s.builtin && s.category === 'custom')
        || defaultCharacterRelationTypes().find(s => s.category === 'custom')!;
}

/**
 * Player-editable legend label — show as stored.
 * Do not run through `t()`: language switches must not overwrite customizations.
 * Built-in type pickers in CharacterView still use `t()` on stable English ids.
 */
export function displayCharacterRelationLabel(style: StoryGraphCharacterRelationType): string {
    return style.label?.trim() || style.id;
}

/**
 * Persist built-in relation legend labels once, using Obsidian's interface language.
 * Empty settings → seed zh/en defaults and save. Existing lists are left untouched
 * so NarrativeLab language switches do not rewrite player-editable labels.
 */
export async function ensureSeededCharacterRelationTypes(
    plugin: {
        app: App;
        settings: {
            storyGraphCharacterRelationTypes?: Array<Partial<StoryGraphCharacterRelationType> & { id?: string; label?: string }>;
        };
        saveSettings: () => Promise<void>;
    },
    characters: Character[] = [],
): Promise<StoryGraphCharacterRelationType[]> {
    const seedLang = seedUiLanguage(plugin.app);
    const saved = plugin.settings.storyGraphCharacterRelationTypes;
    if (Array.isArray(saved) && saved.length > 0) {
        return mergeCharacterRelationTypes(saved, characters, seedLang);
    }
    const seeded = defaultCharacterRelationTypes(seedLang);
    plugin.settings.storyGraphCharacterRelationTypes = seeded;
    await plugin.saveSettings();
    return mergeCharacterRelationTypes(seeded, characters, seedLang);
}

export function makeCharacterRelationTypeId(label: string): string {
    const slug = label.trim().toLowerCase()
        .replace(/\s+/g, '-')
        .replace(/[^a-z0-9\u4e00-\u9fff-]/g, '');
    if (slug && !CATEGORY_IDS.has(slug)) return slug;
    return `char-rel-${Date.now().toString(36)}`;
}

/** Upsert a custom type into settings (graph legend ↔ character profile sync). */
export function upsertCustomCharacterRelationType(
    saved: Array<Partial<StoryGraphCharacterRelationType>> | undefined,
    input: { id?: string; label: string; color?: string; arrow?: 'single' | 'double'; category?: CharacterRelationCategory },
    seedLang: UiLanguage = 'en',
): StoryGraphCharacterRelationType[] {
    const label = input.label.trim();
    const merged = mergeCharacterRelationTypes(saved, [], seedLang);
    if (!label) return merged;
    const id = (input.id || makeCharacterRelationTypeId(label)).trim().toLowerCase();
    if (CATEGORY_IDS.has(id)) return merged;
    const next = normalizeCharacterRelationType({
        id,
        label,
        color: input.color,
        arrow: input.arrow ?? 'double',
        baseType: RELATION_BASE_TYPE_BY_CATEGORY[input.category || 'custom'],
        category: input.category || 'custom',
        builtin: false,
    });
    if (!next) return merged;
    const others = merged.filter(s => s.id !== next.id);
    return [...others, next];
}
