export interface LibraryProfilePropertyOrder {
    /** Top-level YAML keys in profile display order (system keys may be added by the writer). */
    orderedKeys: string[];
    /** Top-level note properties that should be visible in the matching Base view. */
    visibleKeys: string[];
    /** Order for values stored inside the `custom` mapping. */
    customKeys: string[];
    /** Order for template ids stored inside the `universalFields` mapping. */
    universalFieldIds: string[];
}

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
