export interface LibraryProfilePropertyOrder {
    /** Top-level YAML keys in profile display order (system keys may be added by the writer). */
    orderedKeys: string[];
    /** Top-level note properties that should be visible in the matching Base view. */
    visibleKeys: string[];
    /** Order for values stored inside the `custom` mapping. */
    customKeys: string[];
    /** Order for template ids stored inside the `universalFields` mapping. */
    universalFieldIds: string[];
    /** Category-specific built-in / universal keys unavailable to custom mirrors. */
    reservedKeys?: string[];
    /** Top-level YAML key -> hiddenFields storage key for two-way Base visibility sync. */
    visibilityKeys?: Record<string, string>;
}

/** Storage separator used by fields that belong to user-created sections. */
export const CUSTOM_SECTION_KEY_SEP = ' :: ';

/** Core keys that a custom-field mirror must never overwrite. */
export const RESERVED_TOP_LEVEL_KEYS: ReadonlySet<string> = new Set([
    'type', 'name', 'title', 'created', 'modified',
    'act', 'chapter', 'sequence', 'chronologicalOrder', 'chronological_order',
    'pov', 'characters', 'location', 'tags', 'status',
    'storyDate', 'story_date', 'storyTime', 'story_time', 'timeline',
    'conflict', 'emotion', 'intensity', 'wordcount', 'target_wordcount',
    'setup_scenes', 'payoff_scenes', 'codexLinks', 'beatsheet',
    'corkboardNote', 'corkboardNoteColor', 'corkboardNoteImage',
    'corkboardNoteCaption', 'plotgridOrigin', 'subtitle', 'color',
    'timeline_mode', 'timeline_strand',
    'image', 'gallery', 'tagline', 'gender', 'role', 'occupation', 'residency',
    'family', 'earlylife', 'appearance', 'personality', 'goal', 'belief', 'misbelief',
    'fears', 'flaws', 'strengths', 'relations', 'books',
    'world', 'parent', 'description', 'geography', 'culture', 'politics',
    'magicTechnology', 'beliefs', 'economy', 'history', 'locationType',
    'atmosphere', 'significance', 'inhabitants', 'connectedLocations',
    'mapNotes',
    'custom', 'universalFields', 'note', 'notes',
]);

type LibraryProfilePropertyOrderProvider = (categoryKey: string) => LibraryProfilePropertyOrder | null;

let activeProvider: LibraryProfilePropertyOrderProvider | null = null;

export function setLibraryProfilePropertyOrderProvider(
    provider: LibraryProfilePropertyOrderProvider | null,
): void {
    activeProvider = provider;
}

export function getLibraryProfilePropertyOrder(categoryKey: string): LibraryProfilePropertyOrder | null {
    return activeProvider?.(categoryKey) ?? null;
}

function unique(values: Iterable<string>): string[] {
    const result: string[] = [];
    const seen = new Set<string>();
    for (const raw of values) {
        const value = String(raw || '').trim();
        if (!value || seen.has(value)) continue;
        seen.add(value);
        result.push(value);
    }
    return result;
}

function customFieldLabel(storageKey: string): string {
    const parts = storageKey.split(CUSTOM_SECTION_KEY_SEP);
    return (parts.length > 1 ? parts[parts.length - 1] : storageKey).trim();
}

function customFieldFallbackKey(storageKey: string): string {
    return storageKey.includes(CUSTOM_SECTION_KEY_SEP)
        ? storageKey
        : `Custom${CUSTOM_SECTION_KEY_SEP}${storageKey}`;
}

/**
 * Map internal custom-field storage keys to stable top-level YAML properties.
 * A unique, non-reserved field uses its display name. Duplicate labels and
 * core-key collisions keep a readable section-qualified fallback.
 */
export function buildCustomFieldTopLevelKeyMap(
    keys: Iterable<string>,
    additionalReserved: Iterable<string> = [],
): Map<string, string> {
    const ordered = unique(keys);
    const reserved = new Set([...RESERVED_TOP_LEVEL_KEYS, ...unique(additionalReserved)]);
    const labelCounts = new Map<string, number>();
    for (const key of ordered) {
        const label = customFieldLabel(key);
        if (label) labelCounts.set(label, (labelCounts.get(label) ?? 0) + 1);
    }

    const result = new Map<string, string>();
    const used = new Set<string>();
    for (const storageKey of ordered) {
        const label = customFieldLabel(storageKey) || storageKey;
        let target = labelCounts.get(label) === 1 && !reserved.has(label)
            ? label
            : customFieldFallbackKey(storageKey);
        if (reserved.has(target) || used.has(target)) {
            const base = customFieldFallbackKey(storageKey);
            target = base;
            let suffix = 2;
            while (reserved.has(target) || used.has(target)) {
                target = `${base} (${suffix++})`;
            }
        }
        used.add(target);
        result.set(storageKey, target);
    }
    return result;
}

function customValueToString(value: unknown): string {
    if (value === undefined || value === null) return '';
    if (Array.isArray(value)) return value.map(item => customValueToString(item)).join(', ');
    if (typeof value === 'string') return value;
    if (typeof value === 'number' || typeof value === 'boolean' || typeof value === 'bigint') {
        return `${value}`;
    }
    if (typeof value === 'object') {
        try { return JSON.stringify(value); } catch { return ''; }
    }
    return '';
}

/**
 * Merge an editor snapshot with the last readable on-disk custom mapping.
 *
 * Autosave and project switches can briefly expose an empty/partial draft
 * while the Markdown file still contains valid fields. Missing keys are not
 * an instruction to erase data; explicit destructive operations must remove
 * the on-disk property themselves before the next ordinary save.
 */
export function mergeCustomFieldsForSafeSave(
    diskCustom: Record<string, string> | undefined,
    liveCustom: Record<string, string> | undefined,
): Record<string, string> | undefined {
    const diskEntries = Object.entries(diskCustom ?? {});
    const liveEntries = Object.entries(liveCustom ?? {});
    if (diskEntries.length === 0 && liveEntries.length === 0) return undefined;
    return Object.fromEntries([...diskEntries, ...liveEntries]);
}

/**
 * Apply one field from a possibly-partial editor snapshot.
 *
 * `undefined` means the caller did not load/provide the field and must not
 * erase a readable on-disk value. Explicit empty values remain a deliberate
 * clear operation.
 */
export function applyDefinedFrontmatterField(
    frontmatter: Record<string, unknown>,
    key: string,
    value: unknown,
): void {
    if (value === undefined) return;
    if (value === null || value === '' || (Array.isArray(value) && value.length === 0)) {
        delete frontmatter[key];
        return;
    }
    frontmatter[key] = value;
}

function sameYamlValue(left: unknown, right: unknown): boolean {
    if (left === right) return true;
    try { return JSON.stringify(left) === JSON.stringify(right); } catch { return false; }
}

function customFallbackTargets(frontmatter: Record<string, unknown>, storageKey: string): string[] {
    const base = customFieldFallbackKey(storageKey);
    const prefix = `${base} (`;
    return Object.keys(frontmatter)
        .filter(key => key === base || (key.startsWith(prefix) && /^\d+\)$/.test(key.slice(prefix.length))))
        .sort((left, right) => {
            if (left === base) return -1;
            if (right === base) return 1;
            return left.localeCompare(right, undefined, { numeric: true });
        });
}

function existingCustomMirrorTarget(
    frontmatter: Record<string, unknown>,
    storageKey: string,
    primaryTarget: string,
): string {
    if (primaryTarget === customFieldFallbackKey(storageKey)) return primaryTarget;
    return customFallbackTargets(frontmatter, storageKey)[0] ?? primaryTarget;
}

/** Read top-level mirrors back into the nested compatibility map. */
export function hydrateCustomFieldsFromTopLevel(
    frontmatter: Record<string, unknown>,
    custom: Record<string, string> | undefined,
    categoryKey: string,
): Record<string, string> | undefined {
    const layout = getLibraryProfilePropertyOrder(categoryKey);
    const layoutKeys = layout?.customKeys ?? [];
    const keys = unique([...layoutKeys, ...Object.keys(custom ?? {})]);
    if (keys.length === 0) return custom;
    const mapping = buildCustomFieldTopLevelKeyMap(keys, layout?.reservedKeys);
    const diskCustom = frontmatter.custom && typeof frontmatter.custom === 'object' && !Array.isArray(frontmatter.custom)
        ? frontmatter.custom as Record<string, unknown>
        : {};
    const result: Record<string, string> = {};
    for (const [key, value] of Object.entries(custom ?? {})) {
        result[key] = customValueToString(value);
    }
    for (const key of keys) {
        const primaryTarget = mapping.get(key);
        if (!primaryTarget) continue;
        const target = existingCustomMirrorTarget(frontmatter, key, primaryTarget);
        if (!target || !Object.prototype.hasOwnProperty.call(frontmatter, target)) continue;
        const topLevelValue = customValueToString(frontmatter[target]);
        const currentValue = result[key];
        const diskValue = customValueToString(diskCustom[key]);
        // Three-way merge: Base/top-level edits win when the nested value was
        // untouched; an active profile edit wins when the mirror still equals
        // the previous on-disk nested value. Concurrent edits prefer the live
        // profile draft so an in-progress form cannot be silently discarded.
        if (currentValue === undefined || sameYamlValue(currentValue, diskValue)) {
            result[key] = topLevelValue;
        } else if (sameYamlValue(topLevelValue, diskValue)) {
            result[key] = currentValue;
        }
    }
    return Object.keys(result).length > 0 ? result : undefined;
}

/**
 * Mirror every custom field to a top-level YAML property while preserving the
 * nested `custom` object for backward compatibility. Previous mirrors are
 * removed only when their value still matches the old nested source.
 */
export function mirrorCustomFieldsToTopLevel(
    frontmatter: Record<string, unknown>,
    custom: Record<string, string> | undefined,
    categoryKey: string,
    previousCustom?: Record<string, string>,
): void {
    const layout = getLibraryProfilePropertyOrder(categoryKey);
    const layoutKeys = layout?.customKeys ?? [];
    const previous = previousCustom ?? (
        frontmatter.custom && typeof frontmatter.custom === 'object' && !Array.isArray(frontmatter.custom)
            ? frontmatter.custom as Record<string, string>
            : undefined
    );
    const previousKeys = unique([...layoutKeys, ...Object.keys(previous ?? {})]);
    const previousMapping = buildCustomFieldTopLevelKeyMap(previousKeys, layout?.reservedKeys);
    for (const [storageKey, oldValue] of Object.entries(previous ?? {})) {
        const targets = new Set([
            previousMapping.get(storageKey),
            ...customFallbackTargets(frontmatter, storageKey),
        ]);
        for (const target of targets) {
            if (target && sameYamlValue(frontmatter[target], oldValue)) delete frontmatter[target];
        }
    }

    const keys = unique([...layoutKeys, ...Object.keys(custom ?? {})]);
    const mapping = buildCustomFieldTopLevelKeyMap(keys, layout?.reservedKeys);
    const occupied = new Set(Object.keys(frontmatter));
    for (const storageKey of keys) {
        let target = mapping.get(storageKey);
        if (!target) continue;
        const value = custom?.[storageKey] ?? '';
        if (occupied.has(target)) {
            // A top-level-only edit may have just been hydrated into `custom`.
            // Reuse that same property instead of creating a duplicate fallback.
            if (sameYamlValue(frontmatter[target], value)) {
                frontmatter[target] = value;
                continue;
            }
            const existingFallback = customFallbackTargets(frontmatter, storageKey)
                .find(candidate => !RESERVED_TOP_LEVEL_KEYS.has(candidate));
            if (existingFallback) {
                target = existingFallback;
            } else {
                const base = customFieldFallbackKey(storageKey);
                target = base;
                let suffix = 2;
                while (occupied.has(target) || RESERVED_TOP_LEVEL_KEYS.has(target)) {
                    target = `${base} (${suffix++})`;
                }
            }
        }
        frontmatter[target] = value;
        occupied.add(target);
    }
}

export function reorderMapping(
    source: Record<string, unknown>,
    preferredKeys: Iterable<string>,
): Record<string, unknown> {
    const result: Record<string, unknown> = {};
    const consumed = new Set<string>();
    for (const key of unique(preferredKeys)) {
        if (!Object.prototype.hasOwnProperty.call(source, key)) continue;
        result[key] = source[key];
        consumed.add(key);
    }
    for (const [key, value] of Object.entries(source)) {
        if (!consumed.has(key)) result[key] = value;
    }
    return result;
}

/** Move one mapping entry among matching siblings while preserving all non-matching slots. */
export function moveMappingEntry(
    source: Record<string, string>,
    key: string,
    direction: -1 | 1,
    include: (candidate: string) => boolean = () => true,
): Record<string, string> {
    const allKeys = Object.keys(source);
    const movable = allKeys.filter(include);
    const from = movable.indexOf(key);
    const to = from + direction;
    if (from < 0 || to < 0 || to >= movable.length) return source;
    [movable[from], movable[to]] = [movable[to], movable[from]];
    let movableIndex = 0;
    const result: Record<string, string> = {};
    for (const originalKey of allKeys) {
        if (!include(originalKey)) {
            result[originalKey] = source[originalKey];
            continue;
        }
        const nextKey = movable[movableIndex++];
        result[nextKey] = source[nextKey];
    }
    return result;
}

/** Rebuild insertion order only; values and unknown properties are preserved verbatim. */
export function orderLibraryEntityFrontmatter(
    frontmatter: Record<string, unknown>,
    categoryKey: string,
): Record<string, unknown> {
    const layout = getLibraryProfilePropertyOrder(categoryKey);
    if (!layout) return frontmatter;

    const copy: Record<string, unknown> = { ...frontmatter };
    if (copy.custom && typeof copy.custom === 'object' && !Array.isArray(copy.custom)) {
        copy.custom = reorderMapping(copy.custom as Record<string, unknown>, layout.customKeys);
    }
    if (copy.universalFields && typeof copy.universalFields === 'object' && !Array.isArray(copy.universalFields)) {
        copy.universalFields = reorderMapping(
            copy.universalFields as Record<string, unknown>,
            layout.universalFieldIds,
        );
    }

    const systemFirst = ['type'];
    const systemLast = ['custom', 'universalFields', 'books', 'modified', 'created'];
    const preferred = unique([
        ...systemFirst,
        ...layout.orderedKeys,
        ...systemLast,
    ]);
    return reorderMapping(copy, preferred);
}
