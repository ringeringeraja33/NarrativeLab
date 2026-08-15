
/**
 * Shared mtime/size stamp cache for Library entity loaders (ncanvas-style).
 * Skip vault reads + YAML parse when the file stamp is unchanged.
 */
import { App, TFile, TFolder, normalizePath } from 'obsidian';

export interface StampCacheEntry<T> {
    stamp: string;
    entry: T;
}

/** path → stamp cache (shared across managers via typed wrappers) */
const caches = new Map<string, Map<string, StampCacheEntry<unknown>>>();

function getCache(ns: string): Map<string, StampCacheEntry<unknown>> {
    let c = caches.get(ns);
    if (!c) {
        c = new Map();
        caches.set(ns, c);
    }
    return c;
}

export function fileStamp(file: TFile): string {
    return `${Number(file.stat?.mtime || 0)}:${Number(file.stat?.size || 0)}`;
}

export function getCachedEntry<T>(ns: string, path: string, stamp: string): T | undefined {
    const hit = getCache(ns).get(normalizePath(path));
    if (hit && hit.stamp === stamp) return hit.entry as T;
    return undefined;
}

export function setCachedEntry<T>(ns: string, path: string, stamp: string, entry: T): void {
    getCache(ns).set(normalizePath(path), { stamp, entry });
}

export function invalidateCachedPath(ns: string, path: string): void {
    getCache(ns).delete(normalizePath(path));
}

/**
 * After a successful vault write, keep the stamp cache aligned with the
 * in-memory entity. Otherwise reloadEntities() can hit a pre-save stamp
 * and resurrect a stale parse (e.g. Character tagline / field edits look
 * like they “didn’t save”).
 */
export function rememberEntityAfterSave<T>(
    app: App,
    ns: string,
    path: string,
    entry: T,
): void {
    const normalized = normalizePath(path);
    const file = app.vault.getAbstractFileByPath(normalized);
    if (file instanceof TFile) {
        setCachedEntry(ns, normalized, fileStamp(file), entry);
    } else {
        invalidateCachedPath(ns, normalized);
    }
}

/** Invalidate a path across all entity namespaces (rename/delete). */
export function invalidateAllEntityCaches(path: string): void {
    const p = normalizePath(path);
    for (const c of caches.values()) c.delete(p);
}

/** Rename cache key across all namespaces. */
export function renameAllEntityCaches(oldPath: string, newPath: string): void {
    const from = normalizePath(oldPath);
    const to = normalizePath(newPath);
    for (const c of caches.values()) {
        const hit = c.get(from);
        if (hit) {
            c.delete(from);
            c.set(to, hit);
        }
    }
}

/** Rename every cached file below a moved folder across all namespaces. */
export function renameAllEntityCachePrefixes(oldFolder: string, newFolder: string): void {
    const from = normalizePath(oldFolder);
    const to = normalizePath(newFolder);
    if (!from || from === to) return;
    const fromPrefix = `${from}/`;
    for (const c of caches.values()) {
        for (const [path, hit] of [...c.entries()]) {
            if (!path.startsWith(fromPrefix)) continue;
            c.delete(path);
            c.set(normalizePath(`${to}/${path.slice(fromPrefix.length)}`), hit);
        }
    }
}

/** Excalidraw drawings may be stored as `.excalidraw` or `.excalidraw.md`. */
export function isExcalidrawFilePath(path: string): boolean {
    const name = normalizePath(path).split('/').pop()?.toLowerCase() || '';
    return name.endsWith('.excalidraw') || name.endsWith('.excalidraw.md');
}

/** Markdown files that NarrativeLab may treat as Library entities. */
export function isLibraryEntityMarkdownFile(file: TFile): boolean {
    return file.extension.toLowerCase() === 'md' && !isExcalidrawFilePath(file.path);
}

/** Collect markdown TFiles under a folder via vault tree (preferred) or adapter. */
export async function collectMarkdownFiles(app: App, folderPath: string): Promise<TFile[]> {
    const normalized = normalizePath(folderPath);
    const abstract = app.vault.getAbstractFileByPath(normalized);
    const out: TFile[] = [];
    if (abstract instanceof TFolder) {
        const walk = (folder: TFolder) => {
            for (const child of folder.children) {
                if (child instanceof TFolder) walk(child);
                else if (child instanceof TFile && isLibraryEntityMarkdownFile(child)) out.push(child);
            }
        };
        walk(abstract);
        return out;
    }

    // Fallback: adapter.list recursion
    const adapter = app.vault.adapter;
    const scan = async (folder: string): Promise<void> => {
        if (!await adapter.exists(folder)) return;
        const listing = await adapter.list(folder);
        for (const f of listing.files) {
            if (f.toLowerCase().endsWith('.md') && !isExcalidrawFilePath(f)) {
                const tf = app.vault.getAbstractFileByPath(normalizePath(f));
                if (tf instanceof TFile) out.push(tf);
            }
        }
        for (const sub of listing.folders) await scan(normalizePath(sub));
    };
    await scan(normalized);
    return out;
}

/** Read file text preferring vault.cachedRead. */
export async function readVaultText(app: App, file: TFile): Promise<string> {
    const vault = app.vault as App['vault'] & { cachedRead?: (f: TFile) => Promise<string> };
    if (typeof vault.cachedRead === 'function') return vault.cachedRead(file);
    return app.vault.read(file);
}

/**
 * Load/parse a markdown file with stamp cache.
 * `parse` returns null to skip (not cache a miss as empty unless desired).
 */
export async function loadWithStampCache<T>(
    app: App,
    ns: string,
    file: TFile,
    parse: (content: string, path: string) => T | null | undefined,
): Promise<T | null> {
    const path = normalizePath(file.path);
    const stamp = fileStamp(file);
    const cached = getCachedEntry<T>(ns, path, stamp);
    if (cached !== undefined) return cached;

    try {
        const content = await readVaultText(app, file);
        const entry = parse(content, path);
        if (entry == null) {
            invalidateCachedPath(ns, path);
            return null;
        }
        setCachedEntry(ns, path, stamp, entry);
        return entry;
    } catch {
        return null;
    }
}
