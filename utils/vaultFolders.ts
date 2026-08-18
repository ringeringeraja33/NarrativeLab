import { App, normalizePath } from 'obsidian';

type PathGuard = (path: string) => boolean;

let deletedProjectPathGuard: PathGuard = () => false;

/** SceneManager registers this so every folder-create path sees vacated roots. */
export function registerDeletedProjectPathGuard(guard: PathGuard): void {
    deletedProjectPathGuard = guard;
}

export function isTombstonedProjectPath(path: string): boolean {
    const normalized = normalizePath(path);
    return !!normalized && deletedProjectPathGuard(normalized);
}

/** Finder / Explorer leftovers that exist on disk but never enter Obsidian's vault index. */
export function isUntrackedLibraryNoise(name: string): boolean {
    const n = name.toLowerCase();
    return n === '.ds_store' || n === 'thumbs.db' || n === 'desktop.ini'
        || n.startsWith('._') || n === 'icon\r';
}

/**
 * Per-project files that live under Library/ but are not shared series
 * material. datasheet.xlsx is that book's plot grid; library.base is the
 * Base view for that Library root. Merging them into another Library is
 * not a real content conflict.
 */
/** Vault-relative parent for a new project. `/` and blanks are the vault root. */
export function vaultRelativeFolderPath(path: string | null | undefined): string {
    return String(path ?? '').replace(/\\/g, '/').replace(/^\/+|\/+$/g, '').trim();
}

export function isProjectScopedLibraryArtifact(name: string): boolean {
    const n = name.toLowerCase();
    return (
        n === 'datasheet.xlsx'
        || (n.startsWith('datasheet-') && n.endsWith('.xlsx'))
        || n === 'datasheet.nlmeta.json'
        || n.endsWith('.nlmeta.json')
        || n === 'library.base'
        || (n.startsWith('library-') && n.endsWith('.base'))
        || n === '_narrativelab.base'
        || n === '.narrative-lab.base'
        || n === 'corkboard.canvas'
        || (n.startsWith('corkboard-') && n.endsWith('.canvas'))
    );
}

/**
 * Create nested vault folders, but never under a deleted or just-moved project root.
 * Call this instead of `vault.createFolder` for any project-tree path.
 */
export async function ensureVaultFolder(app: App, folderPath: string): Promise<void> {
    const normalized = normalizePath(folderPath);
    if (!normalized || isTombstonedProjectPath(normalized)) return;
    const parts = normalized.split('/').filter(Boolean);
    let current = '';
    for (const part of parts) {
        current = current ? `${current}/${part}` : part;
        if (isTombstonedProjectPath(current)) return;
        if (app.vault.getAbstractFileByPath(current)) continue;
        try {
            await app.vault.createFolder(current);
        } catch {
            if (!app.vault.getAbstractFileByPath(current)) {
                throw new Error(`Could not create folder: ${current}`);
            }
        }
    }
}
