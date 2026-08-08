/* eslint-disable @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-argument -- Obsidian frontmatter + cache */
import { App, TFile, normalizePath } from 'obsidian';
import type SceneCardsPlugin from '../main';
import { storyGraphPairKey } from './storyGraphStrands';

/**
 * Annotated Story Graph reference on a note's frontmatter.
 * Body [[wikilinks]] alone are the default link (默认引用).
 * A non-default category (e.g. 技能) is recorded here with direction
 * implied by which note owns the row (this note → target).
 */
export interface StoryGraphRef {
    target: string;
    targetPath?: string;
    /** Id from settings.storyGraphRelationCategories */
    category: string;
    /** Denormalized label for readability in YAML */
    label?: string;
}

const FM_KEY = 'storyRefs';

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
        const key = `${targetPath.toLowerCase()}|${target.toLowerCase()}|${category.toLowerCase()}`;
        if (seen.has(key)) continue;
        seen.add(key);
        const row: StoryGraphRef = { target, category };
        if (targetPath) row.targetPath = targetPath;
        if (label) row.label = label;
        out.push(row);
    }
    return out;
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
        const others = list.filter(r => !refMatches(r, towardName, towardPath));
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
            const key = linkAssignmentKey(path, ref.targetPath);
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
    },
): Promise<void> {
    await removeWikilinksBetween(plugin.app, edge.sourcePath, edge.targetPath);
    await clearStoryRefsBetween(
        plugin.app,
        edge.sourcePath,
        edge.from,
        edge.targetPath,
        edge.to,
    );

    const assignments = { ...(plugin.settings.storyGraphLinkRelationAssignments || {}) };
    delete assignments[edge.key];
    delete assignments[linkAssignmentKey(edge.targetPath, edge.sourcePath)];
    plugin.settings.storyGraphLinkRelationAssignments = assignments;
    clearFocusBundlesForPair(plugin, edge.sourcePath, edge.targetPath);
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
    },
    category: { id: string; label: string } | null,
): Promise<void> {
    const assignments = { ...(plugin.settings.storyGraphLinkRelationAssignments || {}) };
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
