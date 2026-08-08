import { App, TFile, normalizePath } from 'obsidian';

/** Asymmetric perception of another entity — stored on THIS note's frontmatter. */
export interface EntityPerception {
    /** Display name / wikilink text of the other endpoint. */
    target: string;
    /** Optional vault path for disambiguation. */
    targetPath?: string;
    surface?: string;
    deep?: string;
}

export function parsePerceptions(raw: unknown): EntityPerception[] {
    if (!Array.isArray(raw)) return [];
    const out: EntityPerception[] = [];
    const seen = new Set<string>();
    for (const item of raw) {
        if (!item || typeof item !== 'object') continue;
        const rec = item as Record<string, unknown>;
        const target = typeof rec.target === 'string' ? rec.target.trim() : '';
        if (!target) continue;
        const targetPath = typeof rec.targetPath === 'string'
            ? normalizePath(rec.targetPath.trim())
            : '';
        const surface = typeof rec.surface === 'string' ? rec.surface.trim() : '';
        const deep = typeof rec.deep === 'string' ? rec.deep.trim() : '';
        const key = `${targetPath.toLowerCase()}|${target.toLowerCase()}`;
        if (seen.has(key)) continue;
        seen.add(key);
        const row: EntityPerception = { target };
        if (targetPath) row.targetPath = targetPath;
        if (surface) row.surface = surface;
        if (deep) row.deep = deep;
        out.push(row);
    }
    return out;
}

export function findPerception(
    list: EntityPerception[],
    towardName: string,
    towardPath?: string,
): EntityPerception | undefined {
    const pathKey = towardPath ? normalizePath(towardPath).toLowerCase() : '';
    const nameKey = towardName.trim().toLowerCase();
    if (pathKey) {
        const byPath = list.find(p => (p.targetPath || '').toLowerCase() === pathKey);
        if (byPath) return byPath;
    }
    return list.find(p => p.target.toLowerCase() === nameKey);
}

/** Read perceptions from a vault note's frontmatter. */
export async function readPerceptions(app: App, filePath: string): Promise<EntityPerception[]> {
    const file = app.vault.getAbstractFileByPath(normalizePath(filePath));
    if (!(file instanceof TFile)) return [];
    const cache = app.metadataCache.getFileCache(file);
    return parsePerceptions(cache?.frontmatter?.perceptions);
}

/**
 * Upsert this note's perception toward another entity.
 * Empty surface+deep removes the row.
 */
export async function writePerceptionToward(
    app: App,
    filePath: string,
    toward: { name: string; path?: string },
    surface: string,
    deep: string,
): Promise<void> {
    const file = app.vault.getAbstractFileByPath(normalizePath(filePath));
    if (!(file instanceof TFile)) {
        throw new Error(`File not found: ${filePath}`);
    }
    const s = surface.trim();
    const d = deep.trim();
    const towardPath = toward.path ? normalizePath(toward.path) : '';
    const towardName = toward.name.trim();

    await app.fileManager.processFrontMatter(file, (fm) => {
        const list = parsePerceptions(fm.perceptions);
        const existing = findPerception(list, towardName, towardPath);
        const others = list.filter(p => p !== existing);
        if (!s && !d) {
            if (others.length) fm.perceptions = others;
            else delete fm.perceptions;
            return;
        }
        const row: EntityPerception = { target: towardName };
        if (towardPath) row.targetPath = towardPath;
        if (s) row.surface = s;
        if (d) row.deep = d;
        others.push(row);
        fm.perceptions = others;
    });
}

/** Append a wikilink to the end of a note body if missing. */
export async function ensureWikilink(
    app: App,
    sourcePath: string,
    targetLabel: string,
    targetPath?: string,
): Promise<boolean> {
    const file = app.vault.getAbstractFileByPath(normalizePath(sourcePath));
    if (!(file instanceof TFile)) return false;
    const label = targetLabel.trim();
    if (!label) return false;

    const targetFile = targetPath
        ? app.vault.getAbstractFileByPath(normalizePath(targetPath))
        : null;
    // Prefer Obsidian's resolved link form so metadataCache picks it up reliably.
    const link = targetFile instanceof TFile
        ? app.fileManager.generateMarkdownLink(targetFile, file.path)
        : `[[${label}]]`;

    const content = await app.vault.read(file);
    // Already linked? Check common forms (display name, path, generated link).
    const alreadyLinked = content.includes(link)
        || content.includes(`[[${label}]]`)
        || (targetFile instanceof TFile && (
            content.includes(`[[${targetFile.basename}]]`)
            || content.includes(`[[${targetFile.path}]]`)
            || content.includes(`[[${targetFile.path.replace(/\.md$/i, '')}]]`)
        ));
    if (alreadyLinked) return false;

    const next = content.trimEnd() + (content.trimEnd() ? '\n\n' : '') + link + '\n';
    await app.vault.modify(file, next);
    return true;
}

/**
 * Wait until metadataCache resolves a directed wikilink (or timeout).
 * Needed because vault.modify → resolvedLinks is asynchronous.
 */
export async function waitForResolvedWikilink(
    app: App,
    sourcePath: string,
    targetPath: string,
    timeoutMs = 2000,
): Promise<boolean> {
    const src = normalizePath(sourcePath);
    const tgt = normalizePath(targetPath);
    const hasLink = (): boolean => {
        const fromResolved = app.metadataCache.resolvedLinks[src] || {};
        if (Object.keys(fromResolved).some(p => normalizePath(p) === tgt)) return true;
        const file = app.vault.getAbstractFileByPath(src);
        if (!(file instanceof TFile)) return false;
        const cache = app.metadataCache.getFileCache(file);
        for (const link of cache?.links || []) {
            const dest = app.metadataCache.getFirstLinkpathDest(link.link, src);
            if (dest && normalizePath(dest.path) === tgt) return true;
        }
        return false;
    };
    if (hasLink()) return true;

    return await new Promise<boolean>((resolve) => {
        const timer = window.setTimeout(() => {
            cleanup();
            resolve(hasLink());
        }, timeoutMs);
        const onChange = (file: TFile) => {
            if (normalizePath(file.path) !== src) return;
            if (hasLink()) {
                cleanup();
                resolve(true);
            }
        };
        const onResolved = () => {
            if (hasLink()) {
                cleanup();
                resolve(true);
            }
        };
        const refChange = app.metadataCache.on('changed', onChange);
        const refResolved = app.metadataCache.on('resolved', onResolved);
        const cleanup = () => {
            window.clearTimeout(timer);
            app.metadataCache.offref(refChange);
            app.metadataCache.offref(refResolved);
        };
        // One more tick in case modify already flushed before we subscribed.
        window.setTimeout(() => {
            if (hasLink()) {
                cleanup();
                resolve(true);
            }
        }, 30);
    });
}
