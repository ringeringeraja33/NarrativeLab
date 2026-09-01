/* eslint-disable @typescript-eslint/no-unsafe-member-access -- Obsidian frontmatter + cache */
import { App, TFile, normalizePath } from 'obsidian';
import type SceneCardsPlugin from '../main';
import {
    lookupStoryGraphFocusBundle,
    normalizeStoryGraphFocusBundle,
    storyGraphFocusKey,
    storyGraphPairKey,
    type StoryGraphFocusBundle,
} from './storyGraphStrands';

/**
 * Annotated Story Graph reference on a note's frontmatter.
 * Body [[wikilinks]] alone are the default link (默认引用).
 * A non-default category (e.g. 技能) is recorded here with direction
 * implied by which note owns the row (this note → target).
 */
export interface StoryGraphRef {
    /** Stable id for a profile-managed association mirrored onto both notes. */
    id?: string;
    target: string;
    targetPath?: string;
    /** Id from settings.storyGraphRelationCategories */
    category: string;
    /** Denormalized label for readability in YAML */
    label?: string;
    /** True when NarrativeLab owns this association rather than annotating a body wikilink. */
    managed?: boolean;
    /** Directed source of a managed association; identical on both mirrored rows. */
    sourcePath?: string;
}
const FM_KEY = 'storyRefs';
const managedRelationWriteChains = new Map<string, Promise<unknown>>();

function isTransientRelationWriteError(error: unknown): boolean {
    const message = error instanceof Error ? `${error.name} ${error.message}` : String(error);
    return /UNKNOWN|EBUSY|EPERM|EACCES|EAGAIN|locked|busy|access denied|sharing violation/i.test(message);
}

async function processManagedRelationFrontmatter(
    app: App,
    filePath: string,
    update: (frontmatter: Record<string, unknown>) => void,
): Promise<void> {
    const path = normalizePath(filePath);
    const previous = managedRelationWriteChains.get(path) || Promise.resolve();
    const run = previous.catch(() => undefined).then(async () => {
        let lastError: unknown;
        for (let attempt = 0; attempt < 4; attempt++) {
            try {
                const file = app.vault.getAbstractFileByPath(path);
                if (!(file instanceof TFile)) throw new Error(`Missing relation endpoint: ${path}`);
                await app.fileManager.processFrontMatter(file, update);
                return;
            } catch (error) {
                lastError = error;
                if (!isTransientRelationWriteError(error) || attempt === 3) break;
                await new Promise<void>(resolve => window.setTimeout(resolve, 60 * (attempt + 1) ** 2));
            }
        }
        throw lastError instanceof Error ? lastError : new Error(String(lastError));
    });
    managedRelationWriteChains.set(path, run.then(() => undefined, () => undefined));
    await run;
}

export function parseStoryRefs(raw: unknown): StoryGraphRef[] {
    if (!Array.isArray(raw)) return [];
    const out: StoryGraphRef[] = [];
    const seen = new Set<string>();
    for (const item of raw) {
        if (!item || typeof item !== 'object') continue;
        const rec = item as Record<string, unknown>;
        const target = typeof rec.target === 'string' ? rec.target.trim() : '';
        const category = typeof rec.category === 'string' ? rec.category.trim() : '';
        if (!target || !category) continue;
        const targetPath = typeof rec.targetPath === 'string'
            ? normalizePath(rec.targetPath.trim())
            : '';
        const label = typeof rec.label === 'string' ? rec.label.trim() : '';
        const id = typeof rec.id === 'string' ? rec.id.trim() : '';
        const managed = rec.managed === true;
        const sourcePath = typeof rec.sourcePath === 'string'
            ? normalizePath(rec.sourcePath.trim())
            : '';
        const key = id
            ? `id:${id.toLowerCase()}`
            : `${targetPath.toLowerCase()}|${target.toLowerCase()}|${category.toLowerCase()}|${managed ? 'managed' : 'link'}`;
        if (seen.has(key)) continue;
        seen.add(key);
        const row: StoryGraphRef = { target, category };
        if (id) row.id = id;
        if (targetPath) row.targetPath = targetPath;
        if (label) row.label = label;
        if (managed) row.managed = true;
        if (sourcePath) row.sourcePath = sourcePath;
        out.push(row);
    }
    return out;
}

export interface ManagedStoryGraphRelation {
    id: string;
    sourcePath: string;
    sourceName: string;
    targetPath: string;
    targetName: string;
    category: string;
    label?: string;
}

function managedRefFor(
    relation: ManagedStoryGraphRelation,
    ownerPath: string,
): StoryGraphRef {
    const ownerIsSource = normalizePath(ownerPath) === normalizePath(relation.sourcePath);
    return {
        id: relation.id,
        managed: true,
        sourcePath: normalizePath(relation.sourcePath),
        target: ownerIsSource ? relation.targetName : relation.sourceName,
        targetPath: normalizePath(ownerIsSource ? relation.targetPath : relation.sourcePath),
        category: relation.category || 'default',
        label: relation.label,
    };
}

async function writeManagedRelationMirror(
    app: App,
    ownerPath: string,
    relation: ManagedStoryGraphRelation,
): Promise<void> {
    await processManagedRelationFrontmatter(app, ownerPath, (fm) => {
        const refs = parseStoryRefs(fm[FM_KEY]);
        const next = refs.filter(ref => !(ref.managed && ref.id === relation.id));
        next.push(managedRefFor(relation, ownerPath));
        fm[FM_KEY] = next;
    });
}

/**
 * Create or update one profile-managed relation on both endpoint notes.
 * One directed source is retained for graph arrows, while both profiles receive
 * the same stable id so either side can edit the complete relationship.
 */
export async function upsertManagedStoryGraphRelation(
    app: App,
    relation: ManagedStoryGraphRelation,
): Promise<void> {
    const normalized: ManagedStoryGraphRelation = {
        ...relation,
        id: relation.id.trim(),
        sourcePath: normalizePath(relation.sourcePath),
        sourceName: relation.sourceName.trim(),
        targetPath: normalizePath(relation.targetPath),
        targetName: relation.targetName.trim(),
        category: relation.category.trim() || 'default',
        label: relation.label?.trim() || undefined,
    };
    if (!normalized.id || !normalized.sourcePath || !normalized.targetPath) {
        throw new Error('Managed relation requires an id and two file paths');
    }
    if (normalized.sourcePath === normalized.targetPath) {
        throw new Error('A note cannot relate to itself');
    }
    await writeManagedRelationMirror(app, normalized.sourcePath, normalized);
    // If the second write fails, keep the first mirror as a recoverable source
    // of truth. The profile collector can still discover and repair it later.
    await writeManagedRelationMirror(app, normalized.targetPath, normalized);
}

/** Remove only NarrativeLab-managed rows; body text and ordinary wikilinks stay untouched. */
export async function removeManagedStoryGraphRelation(
    app: App,
    relationId: string,
    endpointPaths: string[],
): Promise<void> {
    const id = relationId.trim();
    if (!id) return;
    const errors: unknown[] = [];
    for (const rawPath of new Set(endpointPaths.map(path => normalizePath(path)))) {
        if (!(app.vault.getAbstractFileByPath(rawPath) instanceof TFile)) continue;
        try {
            await processManagedRelationFrontmatter(app, rawPath, (fm) => {
                const refs = parseStoryRefs(fm[FM_KEY]);
                const next = refs.filter(ref => !(ref.managed && ref.id === id));
                if (next.length) fm[FM_KEY] = next;
                else delete fm[FM_KEY];
            });
        } catch (error) {
            // Continue so a locked or missing endpoint never prevents cleanup
            // of the other side. The surviving mirror remains user-removable.
            errors.push(error);
        }
    }
    if (errors.length) {
        throw errors[0] instanceof Error ? errors[0] : new Error(String(errors[0]));
    }
}

function rebaseRelationPath(
    value: string,
    oldPath: string,
    newPath: string,
    folder: boolean,
): string {
    const path = normalizePath(value);
    if (path === oldPath) return newPath;
    if (folder && path.startsWith(`${oldPath}/`)) {
        return normalizePath(`${newPath}${path.slice(oldPath.length)}`);
    }
    return path;
}

/**
 * Keep frontmatter mirrors, graph categories, and focus notes attached when an
 * endpoint file or containing folder is renamed outside NarrativeLab.
 */
export async function rebaseStoryGraphRelationPaths(
    plugin: SceneCardsPlugin,
    oldRawPath: string,
    newRawPath: string,
    folder = false,
): Promise<boolean> {
    const oldPath = normalizePath(oldRawPath);
    const newPath = normalizePath(newRawPath);
    if (!oldPath || !newPath || oldPath === newPath) return false;
    let changed = false;

    for (const file of plugin.app.vault.getMarkdownFiles()) {
        const frontmatter: Record<string, unknown> | undefined =
            plugin.app.metadataCache.getFileCache(file)?.frontmatter;
        const rawRefs: unknown = frontmatter?.[FM_KEY];
        if (!Array.isArray(rawRefs)) continue;
        const needsRewrite = rawRefs.some(item => {
            if (!item || typeof item !== 'object') return false;
            const rec = item as Record<string, unknown>;
            return (typeof rec.targetPath === 'string'
                    && rebaseRelationPath(rec.targetPath, oldPath, newPath, folder) !== normalizePath(rec.targetPath))
                || (typeof rec.sourcePath === 'string'
                    && rebaseRelationPath(rec.sourcePath, oldPath, newPath, folder) !== normalizePath(rec.sourcePath));
        });
        if (!needsRewrite) continue;
        await processManagedRelationFrontmatter(plugin.app, file.path, (fm) => {
            const rows = Array.isArray(fm[FM_KEY]) ? fm[FM_KEY] as unknown[] : [];
            fm[FM_KEY] = rows.map(item => {
                if (!item || typeof item !== 'object') return item;
                const row = { ...(item as Record<string, unknown>) };
                if (typeof row.targetPath === 'string') {
                    row.targetPath = rebaseRelationPath(row.targetPath, oldPath, newPath, folder);
                }
                if (typeof row.sourcePath === 'string') {
                    row.sourcePath = rebaseRelationPath(row.sourcePath, oldPath, newPath, folder);
                }
                return row;
            });
        });
        changed = true;
    }

    const assignments = plugin.settings.storyGraphLinkRelationAssignments || {};
    const nextAssignments: Record<string, string> = {};
    let assignmentsChanged = false;
    for (const [key, category] of Object.entries(assignments)) {
        const separator = key.indexOf('=>');
        if (separator < 0) {
            nextAssignments[key] = category;
            continue;
        }
        const source = rebaseRelationPath(key.slice(0, separator), oldPath, newPath, folder);
        const target = rebaseRelationPath(key.slice(separator + 2), oldPath, newPath, folder);
        const nextKey = linkAssignmentKey(source, target);
        nextAssignments[nextKey] = category;
        if (nextKey !== key) assignmentsChanged = true;
    }
    if (assignmentsChanged) {
        plugin.settings.storyGraphLinkRelationAssignments = nextAssignments;
        changed = true;
    }

    const rawBundles = plugin.settings.storyGraphFocusBundles || {};
    const nextBundles = { ...rawBundles };
    let bundlesChanged = false;
    for (const [key, raw] of Object.entries(rawBundles)) {
        const bundle = normalizeStoryGraphFocusBundle(raw);
        if (!bundle) continue;
        const leftPath = rebaseRelationPath(bundle.leftPath, oldPath, newPath, folder);
        const rightPath = rebaseRelationPath(bundle.rightPath, oldPath, newPath, folder);
        const nextBundle: StoryGraphFocusBundle = { ...bundle, leftPath, rightPath };
        const nextKey = bundle.parentId
            ? storyGraphFocusKey(leftPath, rightPath, bundle.parentId)
            : storyGraphPairKey(leftPath, rightPath);
        if (nextKey !== key || leftPath !== bundle.leftPath || rightPath !== bundle.rightPath) {
            delete nextBundles[key];
            nextBundles[nextKey] = nextBundle;
            bundlesChanged = true;
        }
    }
    if (bundlesChanged) {
        plugin.settings.storyGraphFocusBundles = nextBundles;
        changed = true;
    }
    if (changed) await plugin.saveSettings();
    return changed;
}

/** Keep denormalized YAML labels and focus-card styling aligned with category edits. */
export async function syncStoryGraphRelationCategoryMetadata(
    plugin: SceneCardsPlugin,
    categories: Array<{ id: string; label: string; color?: string }>,
): Promise<boolean> {
    const categoryById = new Map(categories.map(category => [category.id, category]));
    let changed = false;
    for (const file of plugin.app.vault.getMarkdownFiles()) {
        const frontmatter: Record<string, unknown> | undefined =
            plugin.app.metadataCache.getFileCache(file)?.frontmatter;
        const rawRefs: unknown = frontmatter?.[FM_KEY];
        if (!Array.isArray(rawRefs)) continue;
        const needsRewrite = rawRefs.some(item => {
            if (!item || typeof item !== 'object') return false;
            const row = item as Record<string, unknown>;
            const category = typeof row.category === 'string'
                ? categoryById.get(row.category)
                : undefined;
            return !!category && row.label !== category.label;
        });
        if (!needsRewrite) continue;
        await processManagedRelationFrontmatter(plugin.app, file.path, (fm) => {
            const rows = Array.isArray(fm[FM_KEY]) ? fm[FM_KEY] as unknown[] : [];
            fm[FM_KEY] = rows.map(item => {
                if (!item || typeof item !== 'object') return item;
                const row = { ...(item as Record<string, unknown>) };
                const category = typeof row.category === 'string'
                    ? categoryById.get(row.category)
                    : undefined;
                if (category) row.label = category.label;
                return row;
            });
        });
        changed = true;
    }

    const bundles = { ...(plugin.settings.storyGraphFocusBundles || {}) };
    let bundlesChanged = false;
    for (const [key, raw] of Object.entries(bundles)) {
        const bundle = normalizeStoryGraphFocusBundle(raw);
        if (!bundle?.parentId?.startsWith('link:')) continue;
        const category = categoryById.get(bundle.parentId.slice('link:'.length));
        if (!category) continue;
        if (bundle.parentLabel === category.label && bundle.parentColor === category.color) continue;
        bundles[key] = {
            ...bundle,
            parentLabel: category.label,
            parentColor: category.color,
        };
        bundlesChanged = true;
    }
    if (bundlesChanged) {
        plugin.settings.storyGraphFocusBundles = bundles;
        changed = true;
    }
    return changed;
}

export function readStoryRefsFromCache(app: App, filePath: string): StoryGraphRef[] {
    const file = app.vault.getAbstractFileByPath(normalizePath(filePath));
    if (!(file instanceof TFile)) return [];
    const cache = app.metadataCache.getFileCache(file);
    return parseStoryRefs(cache?.frontmatter?.[FM_KEY]);
}

function refMatches(
    ref: StoryGraphRef,
    towardName: string,
    towardPath?: string,
): boolean {
    const pathKey = towardPath ? normalizePath(towardPath).toLowerCase() : '';
    const nameKey = towardName.trim().toLowerCase();
    if (pathKey && (ref.targetPath || '').toLowerCase() === pathKey) return true;
    return ref.target.toLowerCase() === nameKey;
}

/** Upsert or clear a categorized ref on one note toward another. */
export async function writeStoryRefToward(
    app: App,
    filePath: string,
    toward: { name: string; path?: string },
    category: { id: string; label?: string } | null,
): Promise<void> {
    const file = app.vault.getAbstractFileByPath(normalizePath(filePath));
    if (!(file instanceof TFile)) return;
    const towardPath = toward.path ? normalizePath(toward.path) : '';
    const towardName = toward.name.trim();
    if (!towardName) return;

    await app.fileManager.processFrontMatter(file, (fm) => {
        const list = parseStoryRefs(fm[FM_KEY]);
        // Managed profile associations share storyRefs storage but are owned by
        // their stable id; ordinary wikilink annotation must never erase them.
        const others = list.filter(r => r.managed || !refMatches(r, towardName, towardPath));
        if (!category?.id) {
            if (others.length) fm[FM_KEY] = others;
            else delete fm[FM_KEY];
            return;
        }
        const row: StoryGraphRef = {
            target: towardName,
            category: category.id,
        };
        if (towardPath) row.targetPath = towardPath;
        if (category.label?.trim()) row.label = category.label.trim();
        others.push(row);
        fm[FM_KEY] = others;
    });
}

/** Clear categorized refs between two notes (both directions). */
export async function clearStoryRefsBetween(
    app: App,
    pathA: string,
    nameA: string,
    pathB: string,
    nameB: string,
): Promise<void> {
    await writeStoryRefToward(app, pathA, { name: nameB, path: pathB }, null);
    await writeStoryRefToward(app, pathB, { name: nameA, path: pathA }, null);
}

/**
 * Remove body (and embed) wikilinks in `sourcePath` that resolve to `targetPath`.
 * Returns how many link tokens were removed.
 */
export async function removeWikilinksToTarget(
    app: App,
    sourcePath: string,
    targetPath: string,
): Promise<number> {
    const src = normalizePath(sourcePath);
    const tgt = normalizePath(targetPath);
    const file = app.vault.getAbstractFileByPath(src);
    if (!(file instanceof TFile)) return 0;

    const content = await app.vault.read(file);
    const cache = app.metadataCache.getFileCache(file);
    const ranges: Array<{ from: number; to: number }> = [];

    const consider = (linkpath: string, position?: { start: { offset: number }; end: { offset: number } }) => {
        if (!position) return;
        const dest = app.metadataCache.getFirstLinkpathDest(linkpath, src);
        if (!dest || normalizePath(dest.path) !== tgt) return;
        ranges.push({ from: position.start.offset, to: position.end.offset });
    };

    for (const link of cache?.links || []) {
        consider(link.link, link.position);
    }
    for (const embed of cache?.embeds || []) {
        consider(embed.link, embed.position);
    }

    if (ranges.length === 0) {
        // Fallback: strip common literal forms if cache lags.
        const targetFile = app.vault.getAbstractFileByPath(tgt);
        const basenames = new Set<string>();
        if (targetFile instanceof TFile) {
            basenames.add(targetFile.basename);
            basenames.add(targetFile.path.replace(/\.md$/i, ''));
            basenames.add(targetFile.path);
        }
        let next = content;
        let removed = 0;
        for (const name of basenames) {
            const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
            const re = new RegExp(`!?\\[\\[${escaped}(?:\\|[^\\]]*)?\\]\\]`, 'g');
            const before = next;
            next = next.replace(re, '');
            if (next !== before) removed += 1;
        }
        if (removed === 0) return 0;
        next = next.replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n');
        if (next !== content) await app.vault.modify(file, next);
        return removed;
    }

    ranges.sort((a, b) => b.from - a.from);
    let next = content;
    for (const r of ranges) {
        let from = r.from;
        let to = r.to;
        // Swallow a single trailing newline so blank lines don't stack.
        if (next[to] === '\n') to += 1;
        else if (from > 0 && next[from - 1] === '\n' && (to >= next.length || next[to] === '\n')) {
            from -= 1;
        }
        next = next.slice(0, from) + next.slice(to);
    }
    next = next.replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n');
    if (next !== content) await app.vault.modify(file, next);
    return ranges.length;
}

/** Strip body wikilinks both ways between two notes. */
export async function removeWikilinksBetween(
    app: App,
    pathA: string,
    pathB: string,
): Promise<number> {
    const a = await removeWikilinksToTarget(app, pathA, pathB);
    const b = await removeWikilinksToTarget(app, pathB, pathA);
    return a + b;
}

export function linkAssignmentKey(sourcePath: string, targetPath: string): string {
    return `${normalizePath(sourcePath)}=>${normalizePath(targetPath)}`;
}

/**
 * Merge settings assignments with frontmatter `storyRefs` (FM wins).
 * Optionally prune keys that no longer have a body wikilink.
 */
export function collectLinkRelationAssignments(
    plugin: SceneCardsPlugin,
    documentPaths: string[],
    wikilinkKeys: Set<string>,
): { assignments: Record<string, string>; settingsDirty: boolean } {
    const assignments: Record<string, string> = {
        ...(plugin.settings.storyGraphLinkRelationAssignments || {}),
    };
    let settingsDirty = false;

    for (const path of documentPaths) {
        const refs = readStoryRefsFromCache(plugin.app, path);
        for (const ref of refs) {
            if (!ref.targetPath || !ref.category) continue;
            if (ref.managed && ref.sourcePath && normalizePath(ref.sourcePath) !== normalizePath(path)) {
                // The target-side mirror is for profile editing only. The source
                // mirror owns the directed graph edge and category assignment.
                continue;
            }
            if (ref.category === 'default') continue;
            const key = linkAssignmentKey(ref.managed && ref.sourcePath ? ref.sourcePath : path, ref.targetPath);
            if (assignments[key] !== ref.category) {
                assignments[key] = ref.category;
                settingsDirty = true;
            }
        }
    }

    for (const key of Object.keys(assignments)) {
        if (!wikilinkKeys.has(key)) {
            delete assignments[key];
            settingsDirty = true;
        }
    }

    return { assignments, settingsDirty };
}

/** Drop frontmatter storyRefs that no longer have a matching body wikilink. */
export async function pruneOrphanStoryRefs(
    plugin: SceneCardsPlugin,
    documentPaths: string[],
    wikilinkKeys: Set<string>,
): Promise<void> {
    for (const path of documentPaths) {
        const refs = readStoryRefsFromCache(plugin.app, path);
        if (refs.length === 0) continue;
        const kept: StoryGraphRef[] = [];
        let changed = false;
        for (const ref of refs) {
            if (ref.managed) {
                kept.push(ref);
                continue;
            }
            if (!ref.targetPath) {
                kept.push(ref);
                continue;
            }
            const key = linkAssignmentKey(path, ref.targetPath);
            if (wikilinkKeys.has(key)) kept.push(ref);
            else changed = true;
        }
        if (!changed) continue;
        const file = plugin.app.vault.getAbstractFileByPath(normalizePath(path));
        if (!(file instanceof TFile)) continue;
        await plugin.app.fileManager.processFrontMatter(file, (fm) => {
            if (kept.length) fm[FM_KEY] = kept;
            else delete fm[FM_KEY];
        });
    }
}

/**
 * One-way migrate: settings-only category assignments → note frontmatter `storyRefs`
 * so specially annotated links are visible on the documents.
 */
export async function migrateLinkAssignmentsToFrontmatter(
    plugin: SceneCardsPlugin,
    pathToLabel: Map<string, string>,
    wikilinkKeys: Set<string>,
): Promise<void> {
    const assignments = plugin.settings.storyGraphLinkRelationAssignments || {};
    const categories = plugin.settings.storyGraphRelationCategories || [];
    const labelById = new Map(categories.map(c => [c.id, c.label]));

    for (const [key, categoryId] of Object.entries(assignments)) {
        if (!categoryId || !wikilinkKeys.has(key)) continue;
        const sep = key.indexOf('=>');
        if (sep < 0) continue;
        const sourcePath = normalizePath(key.slice(0, sep));
        const targetPath = normalizePath(key.slice(sep + 2));
        const existing = readStoryRefsFromCache(plugin.app, sourcePath);
        if (existing.some(r => (r.targetPath || '') === targetPath && r.category === categoryId)) {
            continue;
        }
        const targetName = pathToLabel.get(targetPath)
            || targetPath.split('/').pop()?.replace(/\.md$/i, '')
            || targetPath;
        await writeStoryRefToward(
            plugin.app,
            sourcePath,
            { name: targetName, path: targetPath },
            { id: categoryId, label: labelById.get(categoryId) || categoryId },
        );
    }
}

/** Clear focus bundles for a path pair (all parent edge scopes). */
export function clearFocusBundlesForPair(
    plugin: SceneCardsPlugin,
    pathA: string,
    pathB: string,
): boolean {
    const pair = storyGraphPairKey(pathA, pathB);
    const all = { ...(plugin.settings.storyGraphFocusBundles || {}) };
    let dirty = false;
    for (const key of Object.keys(all)) {
        if (key === pair || key.startsWith(`${pair}@@`)) {
            delete all[key];
            dirty = true;
        }
    }
    if (dirty) plugin.settings.storyGraphFocusBundles = all;
    return dirty;
}

/** Clear one parent-scoped focus bundle without disturbing other edges on the same pair. */
export function clearFocusBundleForParent(
    plugin: SceneCardsPlugin,
    pathA: string,
    pathB: string,
    parentId: string,
): boolean {
    const found = lookupStoryGraphFocusBundle(
        plugin.settings.storyGraphFocusBundles,
        pathA,
        pathB,
        parentId,
    );
    if (!found) return false;
    const all = { ...(plugin.settings.storyGraphFocusBundles || {}) };
    delete all[found.key];
    plugin.settings.storyGraphFocusBundles = all;
    return true;
}

/**
 * Fully remove a Story Graph wikilink edge: body links both ways,
 * frontmatter storyRefs, settings assignment, and focus bundles.
 */
export async function removeStoryGraphLinkEdge(
    plugin: SceneCardsPlugin,
    edge: {
        sourcePath: string;
        targetPath: string;
        from: string;
        to: string;
        key: string;
        managedRelationId?: string;
        relationCategoryId?: string;
    },
): Promise<void> {
    if (edge.managedRelationId) {
        await removeManagedStoryGraphRelation(
            plugin.app,
            edge.managedRelationId,
            [edge.sourcePath, edge.targetPath],
        );
    } else {
        await removeWikilinksBetween(plugin.app, edge.sourcePath, edge.targetPath);
        await clearStoryRefsBetween(
            plugin.app,
            edge.sourcePath,
            edge.from,
            edge.targetPath,
            edge.to,
        );
    }

    const assignments = { ...(plugin.settings.storyGraphLinkRelationAssignments || {}) };
    delete assignments[edge.key];
    delete assignments[linkAssignmentKey(edge.targetPath, edge.sourcePath)];
    plugin.settings.storyGraphLinkRelationAssignments = assignments;
    if (edge.managedRelationId) {
        clearFocusBundleForParent(
            plugin,
            edge.sourcePath,
            edge.targetPath,
            edge.relationCategoryId ? `link:${edge.relationCategoryId}` : 'link:default',
        );
    } else {
        clearFocusBundlesForPair(plugin, edge.sourcePath, edge.targetPath);
    }
    await plugin.saveSettings();
}

/** Persist a non-default category onto the source note + settings. */
export async function assignStoryGraphLinkCategory(
    plugin: SceneCardsPlugin,
    edge: {
        sourcePath: string;
        targetPath: string;
        from: string;
        to: string;
        key: string;
        managedRelationId?: string;
        relationCategoryId?: string;
    },
    category: { id: string; label: string } | null,
): Promise<void> {
    const assignments = { ...(plugin.settings.storyGraphLinkRelationAssignments || {}) };
    if (edge.managedRelationId) {
        const nextCategory = category?.id || 'default';
        const oldRef = readStoryRefsFromCache(plugin.app, edge.sourcePath)
            .find(ref => ref.managed && ref.id === edge.managedRelationId);
        const oldCategory = oldRef?.category || edge.relationCategoryId || 'default';
        await upsertManagedStoryGraphRelation(plugin.app, {
            id: edge.managedRelationId,
            sourcePath: edge.sourcePath,
            sourceName: edge.from,
            targetPath: edge.targetPath,
            targetName: edge.to,
            category: nextCategory,
            label: category?.label || 'Default link',
        });
        const oldParent = oldCategory === 'default' ? 'link:default' : `link:${oldCategory}`;
        const nextParent = nextCategory === 'default' ? 'link:default' : `link:${nextCategory}`;
        if (oldParent !== nextParent) {
            const found = lookupStoryGraphFocusBundle(
                plugin.settings.storyGraphFocusBundles,
                edge.sourcePath,
                edge.targetPath,
                oldParent,
            );
            if (found) {
                const all = { ...(plugin.settings.storyGraphFocusBundles || {}) };
                delete all[found.key];
                const migrated: StoryGraphFocusBundle = {
                    ...found.bundle,
                    parentId: nextParent,
                    parentLabel: category?.label || 'Default link',
                    parentColor: category
                        ? plugin.settings.storyGraphRelationCategories
                            ?.find(item => item.id === category.id)?.color
                        : undefined,
                };
                all[storyGraphFocusKey(edge.sourcePath, edge.targetPath, nextParent)] = migrated;
                plugin.settings.storyGraphFocusBundles = all;
            }
        }
        if (category) assignments[edge.key] = category.id;
        else delete assignments[edge.key];
        plugin.settings.storyGraphLinkRelationAssignments = assignments;
        await plugin.saveSettings();
        return;
    }
    if (!category) {
        delete assignments[edge.key];
        await writeStoryRefToward(
            plugin.app,
            edge.sourcePath,
            { name: edge.to, path: edge.targetPath },
            null,
        );
    } else {
        assignments[edge.key] = category.id;
        await writeStoryRefToward(
            plugin.app,
            edge.sourcePath,
            { name: edge.to, path: edge.targetPath },
            { id: category.id, label: category.label },
        );
    }
    plugin.settings.storyGraphLinkRelationAssignments = assignments;
    await plugin.saveSettings();
}
/* eslint-enable @typescript-eslint/no-unsafe-member-access -- End Obsidian frontmatter exception. */
