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
import { BUILTIN_CODEX_CATEGORIES } from '../models/Codex';
import { t } from '../utils/i18n';
import {
    LEGACY_SYSTEM_BASES_FOLDER,
    deriveProjectFoldersFromFilePath,
} from '../models/StoryLineProject';
import type SceneCardsPlugin from '../main';
import {
    buildLibraryPathScopeFilter,
    areCaseEquivalentVaultPaths,
    collectReferencedLibraryCategoryIds,
    type LibraryBaseFilter,
} from '../utils/libraryCategoryTransactions';

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
/** Projects whose Base filters were upgraded to path-contains-v3 this session. */
const FILTER_STYLE_VERSION = 'path-contains-v4-multi-root-boundary';
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

/** Keep the visible category name readable in the Bases sidebar. */
function sanitizeBaseDisplayKey(label: string): string {
    return label
        .trim()
        .replace(/[\\/:*?"<>|#[\]^]/g, '-')
        .replace(/\s+/g, ' ')
        .replace(/-+/g, '-')
        .replace(/^-+|-+$/g, '')
        || 'category';
}

/** Match the filename suffix to the current Library tab label. */
function getNativeBaseDisplayLabel(plugin: SceneCardsPlugin, categoryId: string): string {
    if (categoryId === ALL_LIBRARY_CATEGORY_ID) return t('All');
    const custom = plugin.settings.codexCustomCategories?.find(c => c.id === categoryId);
    if (categoryId === 'uncategorized') {
        return custom?.label?.trim() || t('Uncategorized entries');
    }

    const defaults: Record<string, string> = {
        characters: 'Characters',
        locations: 'Locations',
        ...Object.fromEntries(BUILTIN_CODEX_CATEGORIES.map(category => [category.id, category.folder])),
    };
    const mapped = plugin.sceneManager.activeProject?.libraryFolders?.[categoryId]?.trim();
    if (mapped && mapped !== defaults[categoryId]) return mapped;
    if (mapped) return mapped;
    if (custom?.label?.trim()) return custom.label.trim();

    const folder = getCategoryFolder(plugin, categoryId)?.split('/').pop()?.trim();
    return folder || defaults[categoryId] || categoryId;
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
    const key = sanitizeBaseDisplayKey(getNativeBaseDisplayLabel(plugin, categoryId));
    return normalizePath(`${basesFolder}/library-${key}.base`);
}

/**
 * Storage keys that may have been used for a category's Base file:
 * stable id, current folder label, custom/builtin labels, etc.
 * (Legacy Chinese folder names like 技能 created library-技能.base.)
 */
function collectAliasBaseKeys(plugin: SceneCardsPlugin, categoryId: string): string[] {
    const keys = new Set<string>();
    const add = (value: string): void => {
        keys.add(sanitizeBaseDisplayKey(value));
        keys.add(sanitizeBaseStorageKey(value));
    };
    add(categoryId);
    add(getNativeBaseDisplayLabel(plugin, categoryId));

    const project = plugin.sceneManager.activeProject;
    const mapped = project?.libraryFolders?.[categoryId]?.trim();
    if (mapped) add(mapped);

    const custom = plugin.settings.codexCustomCategories?.find(c => c.id === categoryId);
    if (custom?.label?.trim()) add(custom.label);

    const builtin = BUILTIN_CODEX_CATEGORIES.find(c => c.id === categoryId);
    if (builtin?.folder) add(builtin.folder);
    if (builtin?.label) add(builtin.label);

    if (categoryId === 'characters') add('Characters');
    if (categoryId === 'locations') add('Locations');
    if (categoryId === 'uncategorized') add('Uncategorized');
    if (categoryId === ALL_LIBRARY_CATEGORY_ID) keys.add('all');

    const folderPath = getCategoryFolder(plugin, categoryId);
    const folderBase = folderPath?.split('/').pop()?.trim();
    if (folderBase) add(folderBase);

    return [...keys];
}

/** Move id/legacy-labelled Base files onto the current visible category name. */
async function migrateAliasBaseToCurrentName(
    plugin: SceneCardsPlugin,
    categoryId: string,
): Promise<void> {
    const basesFolder = getProjectBasesFolder(plugin);
    const destination = getNativeBasePath(plugin, categoryId);
    if (!basesFolder || !destination) return;
    for (const key of collectAliasBaseKeys(plugin, categoryId)) {
        const source = normalizePath(`${basesFolder}/library-${key}.base`);
        if (source === destination || !(await pathExists(plugin, source))) continue;
        await moveOrReplaceBaseFile(plugin, source, destination);
    }
}

/** Preserve a category Base when its Library tab/folder is renamed. */
export async function renameNativeLibraryBase(
    plugin: SceneCardsPlugin,
    categoryId: string,
    oldLabel: string,
): Promise<void> {
    const basesFolder = getProjectBasesFolder(plugin);
    const destination = getNativeBasePath(plugin, categoryId);
    if (!basesFolder || !destination) return;
    const oldKeys = new Set([
        sanitizeBaseDisplayKey(oldLabel),
        sanitizeBaseStorageKey(oldLabel),
        sanitizeBaseStorageKey(categoryId),
    ]);
    for (const key of oldKeys) {
        const source = normalizePath(`${basesFolder}/library-${key}.base`);
        if (source === destination || !(await pathExists(plugin, source))) continue;
        await moveOrReplaceBaseFile(plugin, source, destination);
    }
}

function getLegacyNativeBasePaths(plugin: SceneCardsPlugin, categoryId: string): string[] {
    const folderPath = getCategoryFolder(plugin, categoryId);
    if (!folderPath) return [];
    const fileNames = categoryId === ALL_LIBRARY_CATEGORY_ID
        ? ['_NarrativeLab-All.base']
        : ['_NarrativeLab.base', '.narrative-lab.base'];
    return fileNames.map(fileName => normalizePath(`${folderPath}/${fileName}`));
}

async function trashBasePath(plugin: SceneCardsPlugin, path: string | null): Promise<void> {
    if (!path) return;
    const normalized = normalizePath(path);
    const file = plugin.app.vault.getAbstractFileByPath(normalized);
    if (file instanceof TFile) {
        await plugin.app.fileManager.trashFile(file);
        return;
    }
    if (await pathExists(plugin, normalized)) {
        throw new Error(t('The Base file exists but is not indexed by Obsidian. Reopen the vault and try again: {path}', {
            path: normalized,
        }));
    }
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
    return collectReferencedLibraryCategoryIds({
        alwaysCategoryIds: [ALL_LIBRARY_CATEGORY_ID, 'characters', 'locations'],
        optionalFixedCategoryIds: ['uncategorized'],
        hiddenFixedCategoryIds: plugin.settings.libraryHiddenFixedCategories || [],
        enabledCategoryIds: plugin.settings.codexEnabledCategories || [],
        mappedCategoryIds: Object.keys(plugin.sceneManager.activeProject?.libraryFolders || {}),
    });
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
    // On the default macOS/Windows filesystems, library-characters.base and
    // library-Characters.base resolve to the same file. Treating the first as
    // a disposable alias trashes the canonical Base itself.
    if (areCaseEquivalentVaultPaths(src, dest) && await pathExists(plugin, dest)) return;
    if (!(await pathExists(plugin, src))) return;

    await ensureVaultFolder(plugin, dest.split('/').slice(0, -1).join('/'));

    const srcFile = plugin.app.vault.getAbstractFileByPath(src);
    const destFile = plugin.app.vault.getAbstractFileByPath(dest);

    if (srcFile instanceof TFile && destFile instanceof TFile
        && areCaseEquivalentVaultPaths(srcFile.path, destFile.path)) return;

    if (destFile instanceof TFile || await pathExists(plugin, dest)) {
        // Destination already has the migrated file — drop the legacy copy
        if (srcFile instanceof TFile) {
            await plugin.app.fileManager.trashFile(srcFile);
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
                // Prefer a known category id so we don't create library-技能.base orphans
                const folderName = parent.split('/').pop() || 'category';
                const folderKey = sanitizeBaseStorageKey(folderName);
                let matchedId: string | null = null;
                for (const id of getKnownLibraryCategoryIds(plugin)) {
                    if (collectAliasBaseKeys(plugin, id).includes(folderKey)) {
                        matchedId = id;
                        break;
                    }
                }
                destPath = matchedId
                    ? getNativeBasePath(plugin, matchedId)
                    : normalizePath(`${destFolder}/library-${folderKey}.base`);
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
    // Drop Bases that no longer match a live Library category (e.g. library-技能.base)
    await pruneOrphanNativeLibraryBases(plugin);
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
    requiredFilters: LibraryBaseFilter[],
): boolean {
    const and = getFilterAndList(config);
    if (!and || and.length !== requiredFilters.length) return false;
    return requiredFilters.every((filter, index) =>
        JSON.stringify(and[index]) === JSON.stringify(filter));
}

/** True when Base filters drift from the Library-folder-derived required set. */
function shouldRewriteFilters(
    config: Record<string, unknown>,
    requiredFilters: LibraryBaseFilter[],
    _categoryId: string,
): boolean {
    return !filtersMatchRequired(config, requiredFilters);
}

function listLibrarySubfolderPaths(
    plugin: SceneCardsPlugin,
    libraryRoot: string,
): string[] {
    const root = plugin.app.vault.getAbstractFileByPath(normalizePath(libraryRoot));
    if (!(root instanceof TFolder)) return [];
    return root.children
        .filter((child): child is TFolder => child instanceof TFolder)
        .map(child => normalizePath(child.path));
}

function buildRequiredFilters(
    plugin: SceneCardsPlugin,
    categoryId: string,
    folderPaths: string[],
): LibraryBaseFilter[] {
    if (categoryId === 'uncategorized') {
        // Library-root notes only — include both shared and project-local roots,
        // then exclude every real category subfolder on disk.
        const filters: LibraryBaseFilter[] = [
            buildLibraryPathScopeFilter(folderPaths),
            'file.ext == "md"',
        ];
        const excluded = new Set<string>();
        for (const folderPath of folderPaths) {
            for (const sub of listLibrarySubfolderPaths(plugin, folderPath)) {
                excluded.add(sub);
            }
        }
        for (const id of getKnownLibraryCategoryIds(plugin)) {
            if (id === 'uncategorized' || id === ALL_LIBRARY_CATEGORY_ID) continue;
            const catFolder = getCategoryFolder(plugin, id);
            if (!catFolder || folderPaths.includes(normalizePath(catFolder))) continue;
            excluded.add(normalizePath(catFolder));
        }
        for (const sub of [...excluded].sort((a, b) => a.localeCompare(b))) {
            filters.push(`!file.path.contains(${JSON.stringify(`${sub}/`)})`);
        }
        return filters;
    }
    return [
        buildLibraryPathScopeFilter(folderPaths),
        'file.ext == "md"',
    ];
}

function libraryFilterSyncKey(plugin: SceneCardsPlugin, basesFolder: string): string {
    const roots = getCategoryFolders(plugin, ALL_LIBRARY_CATEGORY_ID);
    const subs = roots.flatMap(root => listLibrarySubfolderPaths(plugin, root))
        .sort()
        .join('|');
    const cats = getKnownLibraryCategoryIds(plugin).slice().sort();
    const baseNames = cats.map(id => getNativeBasePath(plugin, id) || id).join('|');
    return `${basesFolder}::${FILTER_STYLE_VERSION}::${cats.join(',')}::${baseNames}::${roots.join('|')}::${subs}`;
}

/** Ensure every known Library category Base uses path-contains filters (once/session). */
export async function syncAllNativeLibraryBases(
    plugin: SceneCardsPlugin,
): Promise<void> {
    if (!plugin.sceneManager.activeProject) return;
    const basesFolder = getProjectBasesFolder(plugin);
    if (!basesFolder) return;
    const styleKey = libraryFilterSyncKey(plugin, basesFolder);
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
    // Always prune — migrate itself is once-per-session, but categories can change.
    await pruneOrphanNativeLibraryBases(plugin);
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
            await pruneOrphanNativeLibraryBases(plugin);
            await syncAllNativeLibraryBases(plugin);
        });
    }
}

/**
 * Keep Bases/library-*.base aligned with current Library categories:
 * merge id/alias-named files into library-{current label}.base, trash orphans.
 */
export async function pruneOrphanNativeLibraryBases(
    plugin: SceneCardsPlugin,
): Promise<void> {
    const basesFolder = getProjectBasesFolder(plugin);
    if (!basesFolder || !(await pathExists(plugin, basesFolder))) return;

    const aliasToCanonicalId = new Map<string, string>();
    for (const id of getKnownLibraryCategoryIds(plugin)) {
        const canonicalKey = sanitizeBaseDisplayKey(getNativeBaseDisplayLabel(plugin, id));
        for (const alias of collectAliasBaseKeys(plugin, id)) {
            const existing = aliasToCanonicalId.get(alias);
            if (!existing || sanitizeBaseStorageKey(existing) !== alias) {
                // Prefer the category whose id key equals this alias
                if (!existing || alias === canonicalKey) {
                    aliasToCanonicalId.set(alias, id);
                }
            }
        }
    }

    const files = await listBaseFilesRecursive(plugin, basesFolder);
    for (const path of files) {
        const name = path.split('/').pop() || '';
        const match = /^library-(.+)\.base$/i.exec(name);
        if (!match) continue;
        const key = match[1];
        const canonicalId = aliasToCanonicalId.get(key)
            ?? aliasToCanonicalId.get(sanitizeBaseStorageKey(key));
        if (!canonicalId) {
            await trashBasePath(plugin, path);
            continue;
        }
        const canonicalPath = getNativeBasePath(plugin, canonicalId);
        if (canonicalPath && normalizePath(path) !== normalizePath(canonicalPath)) {
            await moveOrReplaceBaseFile(plugin, path, canonicalPath);
        }
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

/** Shared-series and project-local folders represented by one project Base. */
function getCategoryFolders(plugin: SceneCardsPlugin, categoryId: string): string[] {
    const primary = getCategoryFolder(plugin, categoryId);
    if (!primary) return [];
    const paths = new Set<string>([normalizePath(primary)]);
    const project = plugin.sceneManager.activeProject;
    const localRoot = project?.codexFolder ? normalizePath(project.codexFolder) : '';
    if (!localRoot) return [...paths];

    if (categoryId === ALL_LIBRARY_CATEGORY_ID || categoryId === 'uncategorized') {
        paths.add(localRoot);
    } else {
        const folderName = plugin.sceneManager.getLibraryFolderName(categoryId);
        paths.add(normalizePath(`${localRoot}/${folderName}`));
    }
    return [...paths];
}

function collectNoteProperties(plugin: SceneCardsPlugin, folderPaths: string[], recursive: boolean): string[] {
    const keys = new Set<string>();
    for (const file of plugin.app.vault.getMarkdownFiles()) {
        const parentPath = normalizePath(file.parent?.path || '');
        const inScope = folderPaths.some(folderPath => recursive
            ? parentPath === folderPath || parentPath.startsWith(`${folderPath}/`)
            : parentPath === folderPath);
        if (!inScope) continue;
        const frontmatter = plugin.app.metadataCache.getFileCache(file)?.frontmatter;
        if (!frontmatter) continue;
        for (const key of Object.keys(frontmatter)) {
            if (key !== 'position' && /^[\p{L}_][\p{L}\p{N}_-]*$/u.test(key)) keys.add(key);
        }
    }
    return Array.from(keys).sort((left, right) => left.localeCompare(right));
}

function collectConfiguredNoteProperties(config: Record<string, unknown>): string[] {
    const keys = new Set<string>();
    const addPropertyId = (value: unknown): void => {
        if (typeof value !== 'string' || !value.startsWith('note.')) return;
        const key = value.slice('note.'.length).trim();
        if (key) keys.add(key);
    };

    const properties = config.properties;
    if (properties && typeof properties === 'object' && !Array.isArray(properties)) {
        for (const propertyId of Object.keys(properties)) addPropertyId(propertyId);
    }
    if (Array.isArray(config.views)) {
        for (const view of config.views) {
            if (!view || typeof view !== 'object') continue;
            const order = (view as Record<string, unknown>).order;
            if (Array.isArray(order)) order.forEach(addPropertyId);
        }
    }
    return [...keys];
}

/**
 * Base field names are editable data identifiers, so keep them verbatim in
 * every interface language. Only surrounding Base controls are localized.
 */
function ensureRawNotePropertyDisplayNames(
    config: Record<string, unknown>,
    notePropertyKeys: Iterable<string>,
): boolean {
    const keys = [...new Set(notePropertyKeys)].filter(Boolean);
    if (keys.length === 0) return false;

    const existing = config.properties;
    const properties: Record<string, unknown> = existing && typeof existing === 'object' && !Array.isArray(existing)
        ? existing as Record<string, unknown>
        : {};
    let dirty = properties !== existing;

    for (const key of keys) {
        const propertyId = `note.${key}`;
        const current = properties[propertyId];
        const propertyConfig: Record<string, unknown> = current && typeof current === 'object' && !Array.isArray(current)
            ? current as Record<string, unknown>
            : {};
        const displayName = typeof propertyConfig.displayName === 'string'
            ? propertyConfig.displayName.trim()
            : '';
        const translatedKey = t(key);
        if (!displayName || (translatedKey !== key && displayName === translatedKey)) {
            propertyConfig.displayName = key;
            properties[propertyId] = propertyConfig;
            dirty = true;
        }
    }

    if (dirty) config.properties = properties;
    return dirty;
}

async function ensureNativeBaseUnlocked(
    plugin: SceneCardsPlugin,
    categoryId: string,
): Promise<{ basePath: string; folderPath: string } | null> {
    const folderPaths = getCategoryFolders(plugin, categoryId);
    const folderPath = folderPaths[0];
    if (!folderPath) return null;
    for (const path of folderPaths) {
        if (!plugin.app.vault.getAbstractFileByPath(path)) {
            await ensureVaultFolder(plugin, path);
        }
    }

    // Keep the filename aligned even when a category was renamed after the
    // one-time project migration already ran.
    await migrateAliasBaseToCurrentName(plugin, categoryId);
    const basePath = getNativeBasePath(plugin, categoryId);
    if (!basePath) return null;
    const recursive = categoryId !== 'uncategorized';
    const requiredFilters = buildRequiredFilters(plugin, categoryId, folderPaths);
    const discoveredProperties = collectNoteProperties(plugin, folderPaths, recursive);
    const existing = plugin.app.vault.getAbstractFileByPath(basePath);

    if (existing instanceof TFile) {
        const source = await plugin.app.vault.read(existing);
        let config: Record<string, unknown>;
        try {
            const parsed: unknown = parseYaml(source) as unknown;
            config = parsed && typeof parsed === 'object'
                ? parsed as Record<string, unknown>
                : {};
        } catch (error) {
            console.error('[NarrativeLab] Invalid Base YAML:', error);
            throw new Error(t('Cannot parse {path}; the file was left unchanged.', { path: basePath }));
        }

        // Only rewrite when filters are missing/legacy. Never clobber user edits
        // that already use path.contains (avoids Bases flash loops).
        let dirty = false;
        if (shouldRewriteFilters(config, requiredFilters, categoryId)) {
            config.filters = { and: requiredFilters };
            dirty = true;
        }
        dirty = ensureRawNotePropertyDisplayNames(config, [
            ...discoveredProperties,
            ...collectConfiguredNoteProperties(config),
        ]) || dirty;
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
                    ...discoveredProperties.map(key => `note.${key}`),
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
    const config: Record<string, unknown> = {
        filters: { and: requiredFilters },
        views: [{
            type: 'table',
            name: 'Table',
            order: [
                'file.name',
                ...discoveredProperties.map(key => `note.${key}`),
            ],
        }],
    };
    ensureRawNotePropertyDisplayNames(config, discoveredProperties);
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
    const basesFolder = getProjectBasesFolder(plugin);
    for (const key of collectAliasBaseKeys(plugin, categoryId)) {
        if (basesFolder) {
            await trashBasePath(plugin, normalizePath(`${basesFolder}/library-${key}.base`));
        }
    }
    for (const path of getLegacyNativeBasePaths(plugin, categoryId)) {
        await trashBasePath(plugin, path);
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
    const loading = host.createDiv({ cls: 'library-native-base-loading', text: t('Loading Base…') });
    let resolved: { basePath: string; folderPath: string } | null;
    try {
        resolved = await ensureNativeBase(plugin, categoryId);
    } catch (error) {
        console.error('[NarrativeLab] Failed to prepare native Library Base:', error);
        if (state.generation === generation && host.isConnected) {
            loading.setText(error instanceof Error ? error.message : t('Failed to load Base'));
        }
        return;
    }
    if (state.generation !== generation || !host.isConnected) return;
    if (!resolved) {
        loading.setText(t('No active project'));
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
