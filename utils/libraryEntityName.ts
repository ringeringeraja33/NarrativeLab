import { coerceString } from './narrow';

/** Frontmatter placeholders that should yield to the note file title. */
const PLACEHOLDER_NAMES = new Set([
    'untitled',
    '未命名',
    'unnamed',
    'untitled note',
    '未命名笔记',
]);

/** File stem (Obsidian note title) from a vault path. */
export function fileTitleFromPath(filePath: string): string {
    return (filePath.split('/').pop() ?? filePath).replace(/\.md$/i, '').trim();
}

/**
 * Resolve a Library entity display name:
 * frontmatter `name` (or `title`) when present and meaningful, else the file title.
 */
export function resolveLibraryEntityName(
    rawName: unknown,
    filePath: string,
    rawTitle?: unknown,
): string {
    const fileTitle = fileTitleFromPath(filePath);
    for (const raw of [rawName, rawTitle]) {
        const cleaned = normalizeNameCandidate(raw);
        if (cleaned) return cleaned;
    }
    return fileTitle || 'Untitled';
}

function normalizeNameCandidate(raw: unknown): string {
    if (Array.isArray(raw)) {
        for (const item of raw) {
            const nested = normalizeNameCandidate(item);
            if (nested) return nested;
        }
        return '';
    }
    let s = coerceString(raw).trim();
    if (!s) return '';
    // Strip surrounding quotes that sometimes leak through YAML.
    if (
        (s.startsWith('"') && s.endsWith('"'))
        || (s.startsWith("'") && s.endsWith("'"))
    ) {
        s = s.slice(1, -1).trim();
    }
    const wiki = s.match(/^\[\[([^\]]+)\]\]$/);
    if (wiki) {
        let inner = wiki[1];
        const pipe = inner.indexOf('|');
        if (pipe >= 0) {
            inner = inner.slice(pipe + 1);
        } else {
            inner = inner.split('#')[0];
            const slash = inner.lastIndexOf('/');
            if (slash >= 0) inner = inner.slice(slash + 1);
        }
        s = inner.replace(/\.md$/i, '').trim();
    }
    if (!s) return '';
    if (PLACEHOLDER_NAMES.has(s.toLowerCase())) return '';
    return s;
}
