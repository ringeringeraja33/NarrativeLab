/** Quote a path or filename for Obsidian graph / search syntax. */
export function quoteGraphSearchTerm(value: string): string {
    const trimmed = value.replace(/\\/g, '/').trim();
    if (!trimmed) return '""';
    return `"${trimmed.replace(/"/g, '\\"')}"`;
}

function uniqueFolders(folders: string[]): string[] {
    const seen = new Set<string>();
    const out: string[] = [];
    for (const raw of folders) {
        const folder = raw.replace(/\\/g, '/').replace(/^\/+|\/+$/g, '').trim();
        if (!folder || seen.has(folder)) continue;
        seen.add(folder);
        out.push(folder);
    }
    return out;
}

/** `path:"Library" OR path:"Scenes"` — scopes native Graph to project folders. */
export function buildProjectGraphQuery(folders: string[]): string {
    const parts = uniqueFolders(folders).map(folder => `path:${quoteGraphSearchTerm(folder)}`);
    if (parts.length === 0) return '';
    if (parts.length === 1) return parts[0]!;
    return parts.join(' OR ');
}

/**
 * Same project `path:` scope, plus `file:` so native Graph isolates that note.
 * Basename without `.md` matches Obsidian's `file:` operator.
 */
export function buildProjectFileGraphQuery(folders: string[], filePath: string): string {
    const scope = buildProjectGraphQuery(folders);
    const basename = filePath.replace(/\\/g, '/').split('/').pop() || filePath;
    const name = basename.replace(/\.md$/i, '');
    const fileClause = `file:${quoteGraphSearchTerm(name)}`;
    if (!scope) return fileClause;
    return `(${scope}) ${fileClause}`;
}
