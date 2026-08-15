export type VaultPathKind = 'missing' | 'folder' | 'other';

export type LibraryBaseFilter = string
    | { and: LibraryBaseFilter[] }
    | { or: LibraryBaseFilter[] }
    | { not: LibraryBaseFilter[] };

/** Paths that differ only by letter case may be the same file on macOS/Windows. */
export function areCaseEquivalentVaultPaths(left: string, right: string): boolean {
    const normalize = (path: string) => path.replace(/\\/g, '/').replace(/^\/+|\/+$/g, '');
    const a = normalize(left);
    const b = normalize(right);
    return a.length > 0 && b.length > 0 && a.toLocaleLowerCase() === b.toLocaleLowerCase();
}

/** Exact folder scope for an Obsidian Base, including every requested root.
 * Prefer `file.inFolder` so Bases New can place notes in the category folder
 * (path.contains filters cannot be applied to a new note → toast + disappear).
 * Guard with if(file, …) so Bases does not toast
 * "Failed to evaluate a filter: Cannot read properties of null (reading 'path')"
 * when a row's file handle is briefly null (view close / vault race).
 */
export function buildLibraryPathScopeFilter(folderPaths: readonly string[]): LibraryBaseFilter {
    const unique = [...new Set(folderPaths.map(path => path.trim().replace(/\/+$/, '')).filter(Boolean))];
    const filters = unique.map(path => `if(file, file.inFolder(${JSON.stringify(path)}), false)`);
    if (filters.length === 0) return 'false';
    return filters.length === 1 ? filters[0] : { or: filters };
}

/** Null-safe Bases filter: skip rows whose file handle is missing mid-refresh. */
export function guardLibraryBaseFileFilter(expression: string): string {
    const trimmed = expression.trim();
    if (!trimmed || trimmed === 'false' || trimmed === 'true') return trimmed;
    if (trimmed.startsWith('if(file,')) return trimmed;
    return `if(file, ${trimmed}, false)`;
}

/** Allocate a stable category id without merging two distinct Library folders. */
export function allocateLibraryCategoryId(preferredId: string, usedIds: Iterable<string>): string {
    const base = preferredId.trim() || 'category';
    const used = new Set(usedIds);
    if (!used.has(base)) return base;
    let suffix = 2;
    while (used.has(`${base}-${suffix}`)) suffix += 1;
    return `${base}-${suffix}`;
}

function liveFolderNamesHave(liveFolders: Iterable<string>, name: string): boolean {
    return [...liveFolders].some(disk => libraryFolderNamesMatch(name, disk));
}

/**
 * When a Library folder is renamed on disk, the old mapping still points at
 * the previous basename. Allocate a `-2` clone only if *both* folders still
 * exist; otherwise retarget the original category.
 */
export function shouldAllocateNewCategoryForFolder(params: {
    mappedFolder: string;
    discoveredFolder: string;
    liveFolders: Iterable<string>;
}): boolean {
    const mapped = params.mappedFolder.trim();
    const discovered = params.discoveredFolder.trim();
    if (!mapped || libraryFolderNamesMatch(mapped, discovered)) return false;
    if (!liveFolderNamesHave(params.liveFolders, mapped)
        && liveFolderNamesHave(params.liveFolders, discovered)) {
        return false;
    }
    return true;
}

/** Location/Locations or Creature/Creatures — same seed folder, not a user rename. */
export function isSingularPluralFolderAlias(left: string, right: string): boolean {
    const a = left.trim().toLowerCase();
    const b = right.trim().toLowerCase();
    if (!a || !b || a === b) return false;
    return a + 's' === b || b + 's' === a;
}

/** Numbered clone (`creatures-2`) left behind after a builtin folder rename. */
export function findStaleNumberedCategoryClone(
    parentId: string,
    libraryFolders: Record<string, string>,
    liveFolders: Iterable<string>,
): { cloneId: string; liveFolder: string } | null {
    const repairs = collectStaleNumberedCategoryRepairs(libraryFolders, liveFolders);
    const hit = repairs.find((item): item is Extract<StaleNumberedCategoryRepair, { action: 'retarget' }> =>
        item.parentId === parentId && item.action === 'retarget');
    return hit ? { cloneId: hit.cloneId, liveFolder: hit.liveFolder } : null;
}

export type StaleNumberedCategoryRepair =
    | { action: 'retarget'; parentId: string; cloneId: string; liveFolder: string; abandonedFolder: string }
    | { action: 'drop-clone'; parentId: string; cloneId: string; abandonedFolder: string };

/**
 * Repair `-2` clones created when a category folder was renamed.
 * Occupied = folder currently holds Library notes. Empty leftovers do not count.
 *
 * - Parent empty, clone has notes → keep parent id, point it at the clone folder.
 * - Parent has notes, clone empty → delete the clone tab.
 * - Both have notes in different folders → leave them (two real categories).
 */
export function collectStaleNumberedCategoryRepairs(
    libraryFolders: Record<string, string>,
    occupiedFolders: Iterable<string>,
): StaleNumberedCategoryRepair[] {
    const repairs: StaleNumberedCategoryRepair[] = [];
    const parentIds = Object.keys(libraryFolders).filter(id => !/-\d+$/.test(id));
    for (const parentId of parentIds) {
        const parentFolder = libraryFolders[parentId]?.trim() || '';
        const parentOccupied = !!parentFolder && liveFolderNamesHave(occupiedFolders, parentFolder);
        const prefix = `${parentId}-`;
        const clones = Object.keys(libraryFolders)
            .filter(id => id.startsWith(prefix) && /^\d+$/.test(id.slice(prefix.length)))
            .sort((a, b) => Number(a.slice(prefix.length)) - Number(b.slice(prefix.length)));
        for (const cloneId of clones) {
            const cloneFolder = libraryFolders[cloneId]?.trim() || '';
            const cloneOccupied = !!cloneFolder && liveFolderNamesHave(occupiedFolders, cloneFolder);
            if (!parentOccupied && cloneOccupied) {
                repairs.push({
                    action: 'retarget',
                    parentId,
                    cloneId,
                    liveFolder: cloneFolder,
                    abandonedFolder: parentFolder,
                });
                continue;
            }
            if (cloneOccupied && parentOccupied && libraryFolderNamesMatch(parentFolder, cloneFolder)) {
                repairs.push({
                    action: 'drop-clone',
                    parentId,
                    cloneId,
                    abandonedFolder: '',
                });
                continue;
            }
            if (!cloneOccupied) {
                repairs.push({
                    action: 'drop-clone',
                    parentId,
                    cloneId,
                    abandonedFolder: cloneFolder,
                });
            }
        }
    }
    return repairs;
}

export interface LibraryFolderRenameState {
    root: string;
    oldPath: string;
    newPath: string;
    rootKind: VaultPathKind;
    oldKind: VaultPathKind;
    newKind: VaultPathKind;
}

export type LibraryFolderRenameDecision =
    | { ok: true; operations: Array<{ oldPath: string; newPath: string; action: 'rename' | 'create' }> }
    | { ok: false; reason: 'missing-root' | 'source-not-folder' | 'target-conflict'; path: string };

/** Validate every Library root before the first folder is changed. */
export function planLibraryFolderRename(states: LibraryFolderRenameState[]): LibraryFolderRenameDecision {
    const operations: Array<{ oldPath: string; newPath: string; action: 'rename' | 'create' }> = [];
    for (const state of states) {
        if (state.rootKind !== 'folder') return { ok: false, reason: 'missing-root', path: state.root };
        if (state.oldKind === 'other') return { ok: false, reason: 'source-not-folder', path: state.oldPath };
        if (state.oldKind === 'folder') {
            if (state.newKind !== 'missing') return { ok: false, reason: 'target-conflict', path: state.newPath };
            operations.push({ oldPath: state.oldPath, newPath: state.newPath, action: 'rename' });
            continue;
        }
        // Target folder with no source is a completed half of an earlier rename.
        if (state.newKind === 'folder') continue;
        if (state.newKind === 'other') return { ok: false, reason: 'target-conflict', path: state.newPath };
        operations.push({ oldPath: state.oldPath, newPath: state.newPath, action: 'create' });
    }
    return { ok: true, operations };
}

/** Folder basename match that tolerates case-only differences (macOS/Windows). */
export function libraryFolderNamesMatch(left: string, right: string): boolean {
    const a = left.trim();
    const b = right.trim();
    return a.length > 0 && b.length > 0 && a.toLocaleLowerCase() === b.toLocaleLowerCase();
}

/** Categories whose known folder aliases are all absent from the Library snapshot. */
export function findLibraryCategoriesMissingFolders(
    aliasesByCategory: Readonly<Record<string, readonly string[]>>,
    existingFolderNames: Iterable<string>,
    protectedCategoryIds: Iterable<string> = [],
): string[] {
    const existing = [...existingFolderNames].map(name => name.trim()).filter(Boolean);
    const protectedIds = new Set(protectedCategoryIds);
    const missing: string[] = [];
    for (const [categoryId, aliases] of Object.entries(aliasesByCategory)) {
        if (protectedIds.has(categoryId)) continue;
        const names = aliases.map(name => name.trim()).filter(Boolean);
        if (names.length === 0 || names.some(name => existing.some(disk => libraryFolderNamesMatch(name, disk)))) {
            continue;
        }
        missing.push(categoryId);
    }
    return missing;
}

export interface LibraryBaseReferenceState {
    alwaysCategoryIds: readonly string[];
    enabledCategoryIds: readonly string[];
    mappedCategoryIds: readonly string[];
    optionalFixedCategoryIds?: readonly string[];
    hiddenFixedCategoryIds?: readonly string[];
}

export interface AdoptedLibraryCategoryVisibility {
    /** Already in the user's enabled tab list. */
    alreadyEnabled: boolean;
    /** Already known to this project (customCategories or libraryFolders). */
    alreadyRegistered: boolean;
    /** User deleted this preset; do not resurrect it from a leftover folder. */
    deleted: boolean;
}

/**
 * Disk folders can discover brand-new categories, but they must not undo hide.
 * Hidden categories stay registered so their Library folders are kept and are
 * not treated as new tabs.
 */
export function shouldEnableAdoptedLibraryCategory(
    state: AdoptedLibraryCategoryVisibility,
): boolean {
    if (state.deleted) return false;
    if (state.alreadyEnabled) return true;
    if (state.alreadyRegistered) return false;
    return true;
}

/** Resolve category ids that still have a live Library/UI reference. */
export function collectReferencedLibraryCategoryIds(state: LibraryBaseReferenceState): string[] {
    const ids = new Set<string>(state.alwaysCategoryIds.filter(Boolean));
    const hidden = new Set(state.hiddenFixedCategoryIds || []);
    for (const id of state.optionalFixedCategoryIds || []) {
        if (id && !hidden.has(id)) ids.add(id);
    }
    for (const id of state.enabledCategoryIds) {
        if (id) ids.add(id);
    }
    for (const id of state.mappedCategoryIds) {
        if (id) ids.add(id);
    }
    return [...ids];
}
