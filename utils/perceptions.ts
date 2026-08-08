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
): Promise<boolean> {
    const file = app.vault.getAbstractFileByPath(normalizePath(sourcePath));
    if (!(file instanceof TFile)) return false;
    const label = targetLabel.trim();
    if (!label) return false;
    const content = await app.vault.read(file);
    const link = `[[${label}]]`;
    if (content.includes(link)) return false;
    const next = content.trimEnd() + (content.trimEnd() ? '\n\n' : '') + link + '\n';
    await app.vault.modify(file, next);
    return true;
}
