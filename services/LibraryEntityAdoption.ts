/* eslint-disable @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-argument, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-return, @typescript-eslint/no-floating-promises, @typescript-eslint/no-misused-promises, @typescript-eslint/no-unnecessary-type-assertion, @typescript-eslint/no-redundant-type-constituents, @typescript-eslint/no-unused-vars, no-unused-vars, no-useless-escape, no-control-regex, no-empty -- Obsidian's API surface and several untyped third-party libraries force dynamic dispatch; floating promises are intentional in DOM/event handlers; matching enable at end of file */
/**
 * Adopt plain markdown notes dropped into Library category folders:
 * recognise them as the folder's entity type and write minimal frontmatter
 * (`type`, `name`, dates) while preserving the existing body.
 *
 * Mirrors SceneManager.ensureNotesFileIndexed for Notes/, but covers
 * Characters / Locations / Codex category folders.
 */
import { App, TFile, normalizePath, parseYaml, stringifyYaml } from 'obsidian';
import { collectMarkdownFiles, invalidateAllEntityCaches, readVaultText } from './EntityFileCache';

export interface LibraryAdoptTarget {
    /** Vault-relative folder to scan recursively */
    folderPath: string;
    /** Frontmatter type to write when missing (e.g. 'character', 'items') */
    type: string;
    /** Types already valid in this folder — do not overwrite */
    allowedTypes?: string[];
}

function cleanContent(content: string): string {
    return content.replace(/[\u200B-\u200F\u2028-\u202F\uFEFF]/g, '');
}

function extractFrontmatter(content: string): Record<string, unknown> | null {
    const clean = cleanContent(content);
    const match = clean.match(/^---\r?\n([\s\S]*?)\r?\n---/);
    if (!match) return null;
    try {
        const parsed = parseYaml(match[1]);
        return parsed && typeof parsed === 'object' ? (parsed as Record<string, unknown>) : null;
    } catch {
        return null;
    }
}

/** Body after frontmatter; entire file when there is no FM block. */
function extractBody(content: string): string {
    const clean = cleanContent(content);
    const match = clean.match(/^---\r?\n[\s\S]*?\r?\n---\r?\n?([\s\S]*)$/);
    if (match) return match[1].replace(/^\r?\n/, '').replace(/\s+$/, '');
    return clean.replace(/\s+$/, '');
}

function todayIso(): string {
    return new Date().toISOString().split('T')[0];
}

/**
 * Patch one Library category folder. Returns how many files were modified.
 */
export async function adoptLibraryFolder(
    app: App,
    target: LibraryAdoptTarget,
): Promise<number> {
    const folder = normalizePath(target.folderPath);
    if (!folder) return 0;

    const adapter = app.vault.adapter;
    if (!await adapter.exists(folder)) return 0;

    const allowed = new Set<string>([target.type, ...(target.allowedTypes || [])]);
    const files = await collectMarkdownFiles(app, folder);
    let patched = 0;

    for (const file of files) {
        if (!(file instanceof TFile) || file.extension !== 'md') continue;
        try {
            const content = await readVaultText(app, file);
            const fm = extractFrontmatter(content);
            const currentType = fm?.type != null ? String(fm.type).trim() : '';

            // Another entity type living here — leave it alone.
            if (currentType && !allowed.has(currentType)) continue;

            const needsType = !currentType;
            const needsName = !String(fm?.name ?? '').trim();
            if (!needsType && !needsName) continue;

            const body = extractBody(content);
            const next: Record<string, unknown> = { ...(fm || {}) };
            if (needsType) next.type = target.type;
            if (needsName) next.name = file.basename;
            if (!next.created) next.created = todayIso();
            next.modified = todayIso();

            const newContent = `---\n${stringifyYaml(next)}---\n${body ? `\n${body}\n` : ''}`;
            if (newContent === content) continue;

            await app.vault.modify(file, newContent);
            invalidateAllEntityCaches(file.path);
            patched++;
        } catch {
            /* unreadable / locked — skip */
        }
    }

    return patched;
}

/**
 * Adopt every provided Library target folder. Dedupes identical folder paths.
 */
export async function adoptLibraryTargets(
    app: App,
    targets: LibraryAdoptTarget[],
): Promise<number> {
    const seen = new Set<string>();
    let total = 0;
    for (const target of targets) {
        const key = normalizePath(target.folderPath);
        if (!key || seen.has(key)) continue;
        seen.add(key);
        total += await adoptLibraryFolder(app, target);
    }
    return total;
}
/* eslint-enable @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-argument, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-return, @typescript-eslint/no-floating-promises, @typescript-eslint/no-misused-promises, @typescript-eslint/no-unnecessary-type-assertion, @typescript-eslint/no-redundant-type-constituents, @typescript-eslint/no-unused-vars, no-unused-vars, no-useless-escape, no-control-regex, no-empty -- end of file-wide suppression block opened at line 1 */
