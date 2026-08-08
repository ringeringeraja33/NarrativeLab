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
import { t } from './i18n';

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

export function defaultCharacterRelationTypes(): StoryGraphCharacterRelationType[] {
    return RELATION_CATEGORIES.map(cat => ({
        id: cat.value,
        label: cat.label,
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

/** Merge saved styles with library categories + types discovered on character notes. */
export function mergeCharacterRelationTypes(
    saved: Array<Partial<StoryGraphCharacterRelationType> & { id?: string; label?: string }> | undefined,
    characters: Character[],
): StoryGraphCharacterRelationType[] {
    const defaults = defaultCharacterRelationTypes();
    const byId = new Map<string, StoryGraphCharacterRelationType>();
    for (const d of defaults) byId.set(d.id, { ...d });

    for (const raw of saved || []) {
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

export function displayCharacterRelationLabel(style: StoryGraphCharacterRelationType): string {
    return t(style.label);
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
): StoryGraphCharacterRelationType[] {
    const label = input.label.trim();
    const merged = mergeCharacterRelationTypes(saved, []);
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
