import {
    Component,
    MarkdownRenderChild,
    MarkdownRenderer,
    TFile,
    TFolder,
    normalizePath,
    parseYaml,
    stringifyYaml,
} from 'obsidian';
import {
    LEGACY_SYSTEM_BASES_FOLDER,
    deriveProjectFoldersFromFilePath,
} from '../models/StoryLineProject';
import type SceneCardsPlugin from '../main';

export const ALL_LIBRARY_CATEGORY_ID = '__all-library__';

interface NativeBaseEmbedState {
    child: MarkdownRenderChild | null;
    generation: number;
}

const activeEmbeds = new WeakMap<Component, NativeBaseEmbedState>();
const ensureLocks = new Map<string, Promise<{ basePath: string; folderPath: string } | null>>();
const migrationLocks = new Map<string, Promise<void>>();
/** Projects whose Bases/ migration already completed this session. */
const migratedBasesFolders = new Set<string>();
/** Projects whose Base filters were upgraded to path-contains-v2 this session. */
const FILTER_STYLE_VERSION = 'path-contains-v2';
const syncedFilterStyleKeys = new Set<string>();

function sanitizeBaseStorageKey(categoryId: string): string {
    const raw = categoryId === ALL_LIBRARY_CATEGORY_ID ? 'all' : categoryId;
    return raw
        .trim()
        .replace(/[\\/:*?"<>|#[\]^]/g, '-')
        .replace(/\s+/g, '-')
        .replace(/-+/g, '-')
        .replace(/^-+|-+$/g, '')
        || 'category';
}

/** Project-root Bases/ folder (never under System/). */
function getProjectBasesFolder(plugin: SceneCardsPlugin): string | null {
    const project = plugin.sceneManager.activeProject;
    if (!project) return null;
    return normalizePath(deriveProjectFoldersFromFilePath(project.filePath).basesFolder);
}

function getNativeBasePath(plugin: SceneCardsPlugin, categoryId: string): string | null {
    const basesFolder = getProjectBasesFolder(plugin);
    if (!basesFolder) return null;
    const key = sanitizeBaseStorageKey(categoryId);
    return normalizePath(`${basesFolder}/library-${key}.base`);
}

function getLegacyNativeBasePaths(plugin: SceneCardsPlugin, categoryId: string): string[] {
    const folderPath = getCategoryFolder(plugin, categoryId);
    if (!folderPath) return [];
    const fileNames = categoryId === ALL_LIBRARY_CATEGORY_ID
        ? ['_NarrativeLab-All.base']
        : ['_NarrativeLab.base', '.narrative-lab.base'];
    return fileNames.map(fileName => normalizePath(`${folderPath}/${fileName}`));
}

async function ensureVaultFolder(plugin: SceneCardsPlugin, folderPath: string): Promise<void> {
    const parts = normalizePath(folderPath).split('/').filter(Boolean);
    let current = '';
    for (const part of parts) {
        current = current ? `${current}/${part}` : part;
        if (!plugin.app.vault.getAbstractFileByPath(current)) {
            await plugin.app.vault.createFolder(current);
        }
    }
}

function getKnownLibraryCategoryIds(plugin: SceneCardsPlugin): string[] {
    const ids = new Set<string>([
        ALL_LIBRARY_CATEGORY_ID,
        'uncategorized',
        'characters',
        'locations',
        ...(plugin.settings.codexEnabledCategories || []),
        ...(plugin.settings.codexCustomCategories || []).map(category => category.id),
        ...plugin.codexManager.getCategories().map(category => category.id),
    ]);
    return [...ids];
}

async function pathExists(plugin: SceneCardsPlugin, path: string): Promise<boolean> {
    const normalized = normalizePath(path);
    if (plugin.app.vault.getAbstractFileByPath(normalized)) return true;
    try {
        return await plugin.app.vault.adapter.exists(normalized);
    } catch {
        return false;
    }
}

async function moveOrReplaceBaseFile(
    plugin: SceneCardsPlugin,
    sourcePath: string,
    destPath: string,
): Promise<void> {
    const src = normalizePath(sourcePath);
    const dest = normalizePath(destPath);
    if (src === dest) return;
    if (!(await pathExists(plugin, src))) return;

    await ensureVaultFolder(plugin, dest.split('/').slice(0, -1).join('/'));

    const srcFile = plugin.app.vault.getAbstractFileByPath(src);
    const destFile = plugin.app.vault.getAbstractFileByPath(dest);

    if (destFile instanceof TFile || await pathExists(plugin, dest)) {
        // Destination already has the migrated file — drop the legacy copy
        if (srcFile instanceof TFile) {
            await plugin.app.fileManager.trashFile(srcFile).catch(async () => {
                await plugin.app.vault.adapter.remove(src).catch(() => undefined);
            });
        } else {
            await plugin.app.vault.adapter.remove(src).catch(() => undefined);
        }
        return;
    }

    if (srcFile instanceof TFile) {
        await plugin.app.fileManager.renameFile(srcFile, dest);
        return;
    }

    // Dotfiles / adapter-only paths may not appear in the vault index
    await plugin.app.vault.adapter.rename(src, dest).catch(async () => {
        try {
            const data = await plugin.app.vault.adapter.read(src);
            await plugin.app.vault.adapter.write(dest, data);
            await plugin.app.vault.adapter.remove(src);
        } catch {
            /* non-fatal */
        }
    });
}

async function listBaseFilesRecursive(
    plugin: SceneCardsPlugin,
    folderPath: string,
): Promise<string[]> {
    const root = normalizePath(folderPath);
    const found: string[] = [];
    const walk = async (dir: string) => {
        let listing: { files: string[]; folders: string[] };
        try {
            listing = await plugin.app.vault.adapter.list(dir);
        } catch {
            return;
        }
        for (const file of listing.files) {
            if (file.toLowerCase().endsWith('.base')) found.push(normalizePath(file));
        }
        for (const sub of listing.folders) {
            await walk(normalizePath(sub));
        }
    };
    if (await pathExists(plugin, root)) await walk(root);
    return found;
}

async function removeFolderIfEmpty(plugin: SceneCardsPlugin, folderPath: string): Promise<void> {
    const path = normalizePath(folderPath);
    const af = plugin.app.vault.getAbstractFileByPath(path);
    if (af instanceof TFolder) {
        // Prefer adapter listing so dotfiles count
        try {
            const listing = await plugin.app.vault.adapter.list(path);
            if (listing.files.length === 0 && listing.folders.length === 0) {
                await plugin.app.fileManager.trashFile(af).catch(async () => {
                    await plugin.app.vault.adapter.rmdir(path, false).catch(() => undefined);
                });
            }
        } catch {
            if (af.children.length === 0) {
                await plugin.app.fileManager.trashFile(af).catch(() => undefined);
            }
        }
        return;
    }
    if (await pathExists(plugin, path)) {
        try {
            const listing = await plugin.app.vault.adapter.list(path);
            if (listing.files.length === 0 && listing.folders.length === 0) {
                await plugin.app.vault.adapter.rmdir(path, false).catch(() => undefined);
            }
        } catch { /* ignore */ }
    }
}

async function migrateSystemBasesFolder(plugin: SceneCardsPlugin): Promise<void> {
    const project = plugin.sceneManager.activeProject;
    if (!project) return;
    const folders = deriveProjectFoldersFromFilePath(project.filePath);
    const destFolder = normalizePath(folders.basesFolder);
    const legacyFolder = normalizePath(`${folders.baseFolder}/${LEGACY_SYSTEM_BASES_FOLDER}`);
    if (legacyFolder === destFolder) return;
    if (!(await pathExists(plugin, legacyFolder))) return;

    await ensureVaultFolder(plugin, destFolder);

    const legacyBases = await listBaseFilesRecursive(plugin, legacyFolder);
    for (const srcPath of legacyBases) {
        const name = srcPath.split('/').pop() || 'library.base';
        await moveOrReplaceBaseFile(plugin, srcPath, `${destFolder}/${name}`);
    }

    // Remove empty nested folders then System/Bases itself
    await removeFolderIfEmpty(plugin, legacyFolder);
}

/**
 * Move any stray `.base` files still living under Library/ (or elsewhere in the
 * project) into project-root Bases/, using library-{category}.base names when known.
 */
async function migrateStrayProjectBaseFiles(plugin: SceneCardsPlugin): Promise<void> {
    const project = plugin.sceneManager.activeProject;
    if (!project) return;
    const folders = deriveProjectFoldersFromFilePath(project.filePath);
    const baseFolder = normalizePath(folders.baseFolder);
    const destFolder = normalizePath(folders.basesFolder);
    await ensureVaultFolder(plugin, destFolder);

    // Map known category folders → destination library-*.base paths
    const folderToDest = new Map<string, string>();
    for (const categoryId of getKnownLibraryCategoryIds(plugin)) {
        const categoryFolder = getCategoryFolder(plugin, categoryId);
        const dest = getNativeBasePath(plugin, categoryId);
        if (categoryFolder && dest) folderToDest.set(normalizePath(categoryFolder), dest);
    }

    const candidates = await listBaseFilesRecursive(plugin, baseFolder);
    for (const srcPath of candidates) {
        // Already in the canonical Bases/ folder
        if (srcPath === destFolder || srcPath.startsWith(`${destFolder}/`)) continue;
        // Never touch trash / archive copies
        if (srcPath.includes('/.trash/') || srcPath.includes('/Archived/')) continue;

        const parent = normalizePath(srcPath.split('/').slice(0, -1).join('/'));
        const name = (srcPath.split('/').pop() || '').toLowerCase();
        let destPath: string | null = folderToDest.get(parent) ?? null;

        if (!destPath) {
            if (name === '_narrativelab-all.base' || name === 'library-all.base') {
                destPath = getNativeBasePath(plugin, ALL_LIBRARY_CATEGORY_ID);
            } else if (name.startsWith('library-') && name.endsWith('.base')) {
                destPath = normalizePath(`${destFolder}/${srcPath.split('/').pop()}`);
            } else if (name === '.narrative-lab.base' || name === '_narrativelab.base') {
                // Unknown category folder — keep a stable name from the folder
                const folderKey = sanitizeBaseStorageKey(parent.split('/').pop() || 'category');
                destPath = normalizePath(`${destFolder}/library-${folderKey}.base`);
            } else {
                destPath = normalizePath(`${destFolder}/${srcPath.split('/').pop()}`);
            }
        }
        if (!destPath) continue;
        await moveOrReplaceBaseFile(plugin, srcPath, destPath);
    }
}

async function migrateLegacyNativeBasesUnlocked(plugin: SceneCardsPlugin): Promise<void> {
    const basesFolder = getProjectBasesFolder(plugin);
    if (!basesFolder) return;
    await ensureVaultFolder(plugin, basesFolder);
    await migrateSystemBasesFolder(plugin);

    for (const categoryId of getKnownLibraryCategoryIds(plugin)) {
        const legacyPaths = getLegacyNativeBasePaths(plugin, categoryId);
        const destinationPath = getNativeBasePath(plugin, categoryId);
        if (!destinationPath) continue;

        for (const legacyPath of legacyPaths) {
            if (legacyPath === destinationPath) continue;
            if (!(await pathExists(plugin, legacyPath))) continue;
            await moveOrReplaceBaseFile(plugin, legacyPath, destinationPath);
            // Prefer the first legacy file that existed; continue to delete the rest
        }
    }

    // Final sweep: any remaining .base under the project (incl. dotfiles)
    await migrateStrayProjectBaseFiles(plugin);
    // System/Bases may now be empty after the sweep
    const project = plugin.sceneManager.activeProject;
    if (project) {
        const legacyFolder = normalizePath(
            `${deriveProjectFoldersFromFilePath(project.filePath).baseFolder}/${LEGACY_SYSTEM_BASES_FOLDER}`,
        );
        await removeFolderIfEmpty(plugin, legacyFolder);
    }
}

async function migrateLegacyNativeBases(plugin: SceneCardsPlugin): Promise<void> {
    if (!plugin.sceneManager.activeProject) return;
    const basesFolder = getProjectBasesFolder(plugin);
    if (!basesFolder) return;
    // Once per project per session — re-running on every Base mount caused
    // vault churn and made the Library table flash continuously.
    if (migratedBasesFolders.has(basesFolder)) return;
    const lockKey = basesFolder;
    const existing = migrationLocks.get(lockKey);
    if (existing) return existing;
    const pending = migrateLegacyNativeBasesUnlocked(plugin)
        .then(() => {
            migratedBasesFolders.add(basesFolder);
        })
        .catch(error => {
            console.error('[NarrativeLab] Failed to migrate Library Base files:', error);
        })
        .finally(() => migrationLocks.delete(lockKey));
    migrationLocks.set(lockKey, pending);
    return pending;
}

function getFilterAndList(config: Record<string, unknown>): unknown[] | null {
    const filters = config.filters;
    if (!filters || typeof filters !== 'object') return null;
    const and = (filters as { and?: unknown }).and;
    return Array.isArray(and) ? and : null;
}

function filtersMatchRequired(
    config: Record<string, unknown>,
    requiredFilters: string[],
): boolean {
    const and = getFilterAndList(config);
    if (!and || and.length !== requiredFilters.length) return false;
    return requiredFilters.every((filter, index) => and[index] === filter);
}

/** True when filters still use legacy folder is / inFolder, or need uncategorized exclusions. */
function shouldRewriteFilters(
    config: Record<string, unknown>,
    requiredFilters: string[],
    categoryId: string,
): boolean {
    if (filtersMatchRequired(config, requiredFilters)) return false;
    const and = getFilterAndList(config);
    if (!and || and.length === 0) return true;
    const lines = and.filter((item): item is string => typeof item === 'string');
    const joined = lines.join('\n');
    if (joined.includes('file.inFolder(') || /file\.folder\s*==/.test(joined)) return true;
    if (!joined.includes('file.path.contains(')) return true;
    // Uncategorized must exclude category subfolders; upgrade once if missing.
    if (categoryId === 'uncategorized' && !joined.includes('!file.path.contains(')) return true;
    // Already path-contains style — keep user-edited filters
    return false;
}

function buildRequiredFilters(
    plugin: SceneCardsPlugin,
    categoryId: string,
    folderPath: string,
): string[] {
    if (categoryId === 'uncategorized') {
        // path contains Library/, minus every known category subfolder
        const filters = [
            `file.path.contains(${JSON.stringify(`${folderPath}/`)})`,
            'file.ext == "md"',
        ];
        for (const id of getKnownLibraryCategoryIds(plugin)) {
            if (id === 'uncategorized' || id === ALL_LIBRARY_CATEGORY_ID) continue;
            const catFolder = getCategoryFolder(plugin, id);
            if (!catFolder || catFolder === folderPath) continue;
            filters.push(`!file.path.contains(${JSON.stringify(`${catFolder}/`)})`);
        }
        return filters;
    }
    return [
        `file.path.contains(${JSON.stringify(folderPath)})`,
        'file.ext == "md"',
    ];
}

/** Ensure every known Library category Base uses path-contains filters (once/session). */
export async function syncAllNativeLibraryBases(
    plugin: SceneCardsPlugin,
): Promise<void> {
    if (!plugin.sceneManager.activeProject) return;
    const basesFolder = getProjectBasesFolder(plugin);
    if (!basesFolder) return;
    const styleKey = `${basesFolder}::${FILTER_STYLE_VERSION}`;
    if (syncedFilterStyleKeys.has(styleKey)) return;
    for (const categoryId of getKnownLibraryCategoryIds(plugin)) {
        try {
            await ensureNativeBase(plugin, categoryId);
        } catch (error) {
            console.error('[NarrativeLab] Failed to sync Library Base:', categoryId, error);
        }
    }
    syncedFilterStyleKeys.add(styleKey);
}

export async function migrateNativeLibraryBasesForActiveProject(
    plugin: SceneCardsPlugin,
): Promise<void> {
    await migrateLegacyNativeBases(plugin);
    await syncAllNativeLibraryBases(plugin);
}

/** Migrate Bases/ out of System/ (and Library/) for every known project. */
export async function migrateNativeLibraryBasesForAllProjects(
    plugin: SceneCardsPlugin,
): Promise<void> {
    const projects = plugin.sceneManager.getProjects();
    for (const project of projects) {
        await plugin.sceneManager.withActiveProject(project, async () => {
            await migrateLegacyNativeBases(plugin);
            await syncAllNativeLibraryBases(plugin);
        });
    }
}

function getCategoryFolder(plugin: SceneCardsPlugin, categoryId: string): string | null {
    if (!plugin.sceneManager.activeProject) return null;
    if (categoryId === ALL_LIBRARY_CATEGORY_ID) {
        return normalizePath(plugin.sceneManager.getCodexFolder());
    }
    if (categoryId === 'uncategorized') {
        return normalizePath(plugin.sceneManager.getCodexFolder());
    }
    if (categoryId === 'characters') {
        return normalizePath(plugin.sceneManager.getCharacterFolder());
    }
    if (categoryId === 'locations') {
        return normalizePath(plugin.sceneManager.getLocationFolder());
    }
    const folderName = plugin.sceneManager.getLibraryFolderName(categoryId);
    return normalizePath(`${plugin.sceneManager.getCodexFolder()}/${folderName}`);
}

function collectNoteProperties(plugin: SceneCardsPlugin, folderPath: string, recursive: boolean): string[] {
    const keys = new Set<string>();
    for (const file of plugin.app.vault.getMarkdownFiles()) {
        const parentPath = normalizePath(file.parent?.path || '');
        const inScope = recursive
            ? parentPath === folderPath || parentPath.startsWith(`${folderPath}/`)
            : parentPath === folderPath;
        if (!inScope) continue;
        const frontmatter = plugin.app.metadataCache.getFileCache(file)?.frontmatter;
        if (!frontmatter) continue;
        for (const key of Object.keys(frontmatter)) {
            if (key !== 'position' && /^[\p{L}_][\p{L}\p{N}_-]*$/u.test(key)) keys.add(key);
        }
    }
    return Array.from(keys).sort((left, right) => left.localeCompare(right));
}

async function ensureNativeBaseUnlocked(
    plugin: SceneCardsPlugin,
    categoryId: string,
): Promise<{ basePath: string; folderPath: string } | null> {
    const folderPath = getCategoryFolder(plugin, categoryId);
    if (!folderPath) return null;
    if (!plugin.app.vault.getAbstractFileByPath(folderPath)) {
        await plugin.app.vault.createFolder(folderPath);
    }

    // Migration runs on plugin load / project switch — not on every Base mount.
    const basePath = getNativeBasePath(plugin, categoryId);
    if (!basePath) return null;
    const recursive = categoryId !== 'uncategorized';
    const requiredFilters = buildRequiredFilters(plugin, categoryId, folderPath);
    const existing = plugin.app.vault.getAbstractFileByPath(basePath);

    if (existing instanceof TFile) {
        const source = await plugin.app.vault.read(existing);
        let config: Record<string, unknown>;
        try {
            const parsed = parseYaml(source);
            config = parsed && typeof parsed === 'object'
                ? parsed as Record<string, unknown>
                : {};
        } catch (error) {
            console.error('[NarrativeLab] Invalid Base YAML:', error);
            throw new Error(`Cannot parse ${basePath}; the file was left unchanged.`);
        }

        // Only rewrite when filters are missing/legacy. Never clobber user edits
        // that already use path.contains (avoids Bases flash loops).
        let dirty = false;
        if (shouldRewriteFilters(config, requiredFilters, categoryId)) {
            config.filters = { and: requiredFilters };
            dirty = true;
        }
        if (Array.isArray(config.views)) {
            for (const view of config.views) {
                if (!view || typeof view !== 'object') continue;
                const viewConfig = view as Record<string, unknown>;
                if (viewConfig.type === 'narrative-lab-cards') {
                    viewConfig.type = 'table';
                    if (viewConfig.name === 'NarrativeLab Cards') viewConfig.name = 'Table';
                    dirty = true;
                }
            }
        }
        if (!Array.isArray(config.views) || config.views.length === 0) {
            config.views = [{
                type: 'table',
                name: 'Table',
                order: [
                    'file.name',
                    ...collectNoteProperties(plugin, folderPath, recursive).map(key => `note.${key}`),
                ],
            }];
            dirty = true;
        }
        if (dirty) {
            await plugin.app.vault.modify(existing, stringifyYaml(config));
        }
        return { basePath, folderPath };
    }

    await ensureVaultFolder(plugin, basePath.split('/').slice(0, -1).join('/'));
    const config = {
        filters: { and: requiredFilters },
        views: [{
            type: 'table',
            name: 'Table',
            order: [
                'file.name',
                ...collectNoteProperties(plugin, folderPath, recursive).map(key => `note.${key}`),
            ],
        }],
    };
    await plugin.app.vault.create(basePath, stringifyYaml(config));
    return { basePath, folderPath };
}

async function ensureNativeBase(
    plugin: SceneCardsPlugin,
    categoryId: string,
): Promise<{ basePath: string; folderPath: string } | null> {
    const folderPath = getCategoryFolder(plugin, categoryId);
    if (!folderPath) return null;
    const basePath = getNativeBasePath(plugin, categoryId);
    if (!basePath) return null;
    const existing = ensureLocks.get(basePath);
    if (existing) return existing;
    const pending = ensureNativeBaseUnlocked(plugin, categoryId)
        .finally(() => ensureLocks.delete(basePath));
    ensureLocks.set(basePath, pending);
    return pending;
}

export async function syncNativeLibraryBase(
    plugin: SceneCardsPlugin,
    categoryId: string,
): Promise<void> {
    await ensureNativeBase(plugin, categoryId);
}

export async function removeNativeLibraryBase(
    plugin: SceneCardsPlugin,
    categoryId: string,
): Promise<void> {
    for (const path of [
        getNativeBasePath(plugin, categoryId),
        ...getLegacyNativeBasePaths(plugin, categoryId),
    ]) {
        if (!path) continue;
        const file = plugin.app.vault.getAbstractFileByPath(path);
        if (file instanceof TFile) {
            await plugin.app.fileManager.trashFile(file);
        }
    }
}

export function disposeNativeLibraryBase(owner: Component): void {
    const state = activeEmbeds.get(owner);
    if (!state) {
        activeEmbeds.set(owner, { child: null, generation: 1 });
        return;
    }
    state.generation += 1;
    if (state.child) {
        owner.removeChild(state.child);
        state.child = null;
    }
}

/**
 * Render an actual Obsidian Bases embed. Column drag/drop, property controls,
 * formulas, filters, grouping, summaries, and editing are provided by core.
 */
export async function renderNativeLibraryBase(
    container: HTMLElement,
    plugin: SceneCardsPlugin,
    categoryId: string,
    owner: Component,
): Promise<void> {
    disposeNativeLibraryBase(owner);
    const state = activeEmbeds.get(owner)!;
    const generation = state.generation;

    container.empty();
    const host = container.createDiv('library-native-base-embed markdown-rendered');
    const loading = host.createDiv({ cls: 'library-native-base-loading', text: 'Loading Base…' });
    let resolved: { basePath: string; folderPath: string } | null;
    try {
        resolved = await ensureNativeBase(plugin, categoryId);
    } catch (error) {
        console.error('[NarrativeLab] Failed to prepare native Library Base:', error);
        if (state.generation === generation && host.isConnected) {
            loading.setText(error instanceof Error ? error.message : 'Failed to load Base');
        }
        return;
    }
    if (state.generation !== generation || !host.isConnected) return;
    if (!resolved) {
        loading.setText('No active project');
        return;
    }

    loading.remove();
    const child = owner.addChild(new MarkdownRenderChild(host));
    state.child = child;
    const linkPath = resolved.basePath.replace(/\]/g, '\\]');
    await MarkdownRenderer.render(
        plugin.app,
        `![[${linkPath}]]`,
        host,
        resolved.basePath,
        child,
    );
    if (state.generation !== generation || !host.isConnected) {
        if (state.child === child) state.child = null;
        owner.removeChild(child);
    }
}
