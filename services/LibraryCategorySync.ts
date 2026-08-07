/* eslint-disable @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-argument, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-return, @typescript-eslint/no-floating-promises, @typescript-eslint/no-misused-promises, @typescript-eslint/no-unnecessary-type-assertion, @typescript-eslint/no-redundant-type-constituents, @typescript-eslint/no-unused-vars, no-unused-vars, no-useless-escape, no-control-regex, no-empty -- Obsidian's API surface and several untyped third-party libraries force dynamic dispatch; floating promises are intentional in DOM/event handlers; matching enable at end of file */
/**
 * Keep Library tab labels parallel with Library/<folder> names.
 * Stable category ids (characters, locations, items, …) never change —
 * only the folder basename / tab label does.
 */
import { App, Notice, TFile, TFolder, normalizePath } from 'obsidian';
import { BUILTIN_CODEX_CATEGORIES, UNCATEGORIZED_CATEGORY_ID } from '../models/Codex';
import type { StoryLineProject } from '../models/StoryLineProject';
import type SceneCardsPlugin from '../main';
import { t } from '../utils/i18n';

/** Default English folder basenames for built-in / special Library tabs. */
export const DEFAULT_LIBRARY_FOLDER_NAMES: Record<string, string> = {
    characters: 'Characters',
    locations: 'Locations',
    ...Object.fromEntries(BUILTIN_CODEX_CATEGORIES.map(c => [c.id, c.folder])),
};

export function sanitizeLibraryFolderName(raw: string): string {
    return raw.trim().replace(/[\\/:*?"<>|]/g, '-').replace(/\s+/g, ' ').trim();
}

export function basenameOfPath(path: string): string {
    const n = normalizePath(path);
    const i = n.lastIndexOf('/');
    return i >= 0 ? n.slice(i + 1) : n;
}

export function parentOfPath(path: string): string {
    const n = normalizePath(path);
    const i = n.lastIndexOf('/');
    return i >= 0 ? n.slice(0, i) : '';
}

/** Resolve the Library folder basename for a stable category id. */
export function resolveLibraryFolderName(
    plugin: SceneCardsPlugin,
    categoryId: string,
    project: StoryLineProject | null = plugin.sceneManager.activeProject,
): string {
    const fromProject = project?.libraryFolders?.[categoryId]?.trim();
    if (fromProject) return fromProject;

    const custom = plugin.settings.codexCustomCategories?.find(c => c.id === categoryId);
    if (custom?.label?.trim()) return custom.label.trim();

    return DEFAULT_LIBRARY_FOLDER_NAMES[categoryId] || categoryId;
}

/** Recompute project.characterFolder / locationFolder from libraryFolders. */
export function applyLibraryFolderPaths(project: StoryLineProject, plugin: SceneCardsPlugin): void {
    const lib = normalizePath(project.codexFolder);
    const charName = resolveLibraryFolderName(plugin, 'characters', project);
    const locName = resolveLibraryFolderName(plugin, 'locations', project);
    project.characterFolder = normalizePath(`${lib}/${charName}`);
    project.locationFolder = normalizePath(`${lib}/${locName}`);
}

/** Push resolved folder/label onto CodexManager category defs (label === folder). */
export function applyCategoryFolderLabels(plugin: SceneCardsPlugin): void {
    for (const cat of plugin.codexManager.getCategories()) {
        if (cat.id === UNCATEGORIZED_CATEGORY_ID) continue;
        const name = resolveLibraryFolderName(plugin, cat.id);
        plugin.codexManager.setCategoryFolder(cat.id, name);
    }
}

/** Ensure Library + known category folders exist for the active project. */
export async function ensureLibraryCategoryFolders(plugin: SceneCardsPlugin): Promise<void> {
    const project = plugin.sceneManager.activeProject;
    if (!project) return;
    const adapter = plugin.app.vault.adapter;
    const lib = normalizePath(project.codexFolder);
    if (!await adapter.exists(lib)) {
        await plugin.app.vault.createFolder(lib).catch(() => undefined);
    }

    const ids = new Set<string>([
        'characters',
        'locations',
        ...(plugin.settings.codexEnabledCategories || []),
    ]);
    for (const id of ids) {
        const name = resolveLibraryFolderName(plugin, id, project);
        const path = normalizePath(`${lib}/${name}`);
        if (!await adapter.exists(path)) {
            await plugin.app.vault.createFolder(path).catch(() => undefined);
        }
    }
}

/**
 * Rename a Library category tab (= rename its folder + persist mapping).
 */
export async function renameLibraryCategory(
    plugin: SceneCardsPlugin,
    categoryId: string,
    rawNewName: string,
): Promise<boolean> {
    if (categoryId === UNCATEGORIZED_CATEGORY_ID) return false;
    const project = plugin.sceneManager.activeProject;
    if (!project) {
        new Notice(t('No active project'));
        return false;
    }

    const newName = sanitizeLibraryFolderName(rawNewName);
    if (!newName) {
        new Notice(t('Invalid folder name'));
        return false;
    }

    const oldName = resolveLibraryFolderName(plugin, categoryId, project);
    if (oldName === newName) return false;

    const pluginAny = plugin as SceneCardsPlugin & { _syncingLibraryFolders?: boolean };
    pluginAny._syncingLibraryFolders = true;
    try {
        const libraryRoots = libraryRootsForProject(plugin, project);
        for (const lib of libraryRoots) {
            const oldPath = normalizePath(`${lib}/${oldName}`);
            const newPath = normalizePath(`${lib}/${newName}`);
            const existing = plugin.app.vault.getAbstractFileByPath(newPath);
            if (existing) {
                new Notice(t('A folder with this name already exists'));
                return false;
            }
            const folder = plugin.app.vault.getAbstractFileByPath(oldPath);
            if (folder instanceof TFolder) {
                await plugin.app.fileManager.renameFile(folder, newPath);
            } else {
                // Folder missing — still update mapping; create empty target.
                await plugin.app.vault.createFolder(newPath).catch(() => undefined);
            }
        }

        if (!project.libraryFolders) project.libraryFolders = {};
        project.libraryFolders[categoryId] = newName;
        applyLibraryFolderPaths(project, plugin);

        // Keep global custom label in sync so new projects inherit the name.
        const custom = plugin.settings.codexCustomCategories?.find(c => c.id === categoryId);
        if (custom) {
            custom.label = newName;
            await plugin.saveSettings();
        }

        await plugin.sceneManager.saveProjectFrontmatter(project);
        applyCategoryFolderLabels(plugin);
        return true;
    } finally {
        pluginAny._syncingLibraryFolders = false;
    }
}

/** Remove a non-core Library tab and trash its folder in the active project. */
export async function deleteLibraryCategory(
    plugin: SceneCardsPlugin,
    categoryId: string,
    mode: 'trash' | 'move-to-root' = 'trash',
): Promise<boolean> {
    if (
        categoryId === 'characters'
        || categoryId === 'locations'
        || categoryId === UNCATEGORIZED_CATEGORY_ID
    ) return false;

    const project = plugin.sceneManager.activeProject;
    if (!project) {
        new Notice(t('No active project'));
        return false;
    }

    const folderName = resolveLibraryFolderName(plugin, categoryId, project);
    const libraryRoot = normalizePath(plugin.sceneManager.getCodexFolder());
    const folderPath = normalizePath(`${libraryRoot}/${folderName}`);
    const pluginAny = plugin as SceneCardsPlugin & { _syncingLibraryFolders?: boolean };
    pluginAny._syncingLibraryFolders = true;

    try {
        const folder = plugin.app.vault.getAbstractFileByPath(folderPath);
        if (folder instanceof TFolder) {
            if (mode === 'move-to-root') {
                const files: TFile[] = [];
                const collectFiles = (current: TFolder) => {
                    for (const child of current.children) {
                        if (child instanceof TFile) files.push(child);
                        else if (child instanceof TFolder) collectFiles(child);
                    }
                };
                collectFiles(folder);
                for (const file of files) {
                    const dot = file.name.lastIndexOf('.');
                    const stem = dot > 0 ? file.name.slice(0, dot) : file.name;
                    const extension = dot > 0 ? file.name.slice(dot) : '';
                    let targetPath = normalizePath(`${libraryRoot}/${file.name}`);
                    let suffix = 2;
                    while (plugin.app.vault.getAbstractFileByPath(targetPath)) {
                        targetPath = normalizePath(`${libraryRoot}/${stem} ${suffix}${extension}`);
                        suffix += 1;
                    }
                    await plugin.app.fileManager.renameFile(file, targetPath);
                    if (file.extension.toLowerCase() === 'md') {
                        await plugin.app.fileManager.processFrontMatter(file, frontmatter => {
                            frontmatter.type = UNCATEGORIZED_CATEGORY_ID;
                        });
                    }
                }
                const remainingFolder = plugin.app.vault.getAbstractFileByPath(folderPath);
                if (remainingFolder instanceof TFolder) {
                    await plugin.app.fileManager.trashFile(remainingFolder);
                }
            } else {
                await plugin.app.fileManager.trashFile(folder);
            }
        }

        plugin.settings.codexEnabledCategories =
            (plugin.settings.codexEnabledCategories || []).filter(id => id !== categoryId);
        plugin.settings.codexSidebarCategories =
            (plugin.settings.codexSidebarCategories || []).filter(id => id !== categoryId);
        plugin.settings.libraryCategoryOrder =
            (plugin.settings.libraryCategoryOrder || []).filter(id => id !== categoryId);
        const customIndex = (plugin.settings.codexCustomCategories || [])
            .findIndex(category => category.id === categoryId);
        if (customIndex >= 0) {
            plugin.settings.codexCustomCategories.splice(customIndex, 1);
        }
        if (BUILTIN_CODEX_CATEGORIES.some(category => category.id === categoryId)) {
            const deleted = new Set(plugin.settings.codexDeletedPresetCategories || []);
            deleted.add(categoryId);
            plugin.settings.codexDeletedPresetCategories = Array.from(deleted);
        }
        delete plugin.settings.codexCategoryFieldTemplates?.[categoryId];
        delete plugin.settings.codexCategoryCustomSections?.[categoryId];
        delete plugin.settings.libraryBrowseLayout?.[categoryId];
        delete plugin.settings.libraryTableColumns?.[categoryId];
        delete plugin.settings.libraryTableSort?.[categoryId];
        delete plugin.settings.libraryTableFormulas?.[categoryId];
        delete plugin.settings.hiddenFields?.[categoryId];

        if (project.libraryFolders) {
            delete project.libraryFolders[categoryId];
        }

        await plugin.saveSettings();
        await plugin.sceneManager.saveProjectFrontmatter(project);
        await plugin.reloadEntities();
        new Notice(t('Library category deleted'));
        return true;
    } catch (error) {
        console.error('[NarrativeLab] Failed to delete Library category:', error);
        new Notice(t('Failed to delete Library category'));
        return false;
    } finally {
        pluginAny._syncingLibraryFolders = false;
    }
}

/** Direct children of project (and series) Library folders. */
function libraryRootsForProject(plugin: SceneCardsPlugin, project: StoryLineProject): string[] {
    const roots = new Set<string>();
    roots.add(normalizePath(project.codexFolder));
    const seriesLib = plugin.sceneManager.getSeriesFolder()
        ? normalizePath(plugin.sceneManager.getSeriesCodexFolder())
        : null;
    if (seriesLib) roots.add(seriesLib);
    return [...roots];
}

/**
 * Vault renamed a folder — if it is a Library category folder, update mapping.
 */
export async function handleLibraryFolderVaultRename(
    plugin: SceneCardsPlugin,
    oldPath: string,
    newPath: string,
): Promise<boolean> {
    const project = plugin.sceneManager.activeProject;
    if (!project) return false;

    const oldParent = parentOfPath(oldPath);
    const newParent = parentOfPath(newPath);
    const roots = libraryRootsForProject(plugin, project);
    if (!roots.includes(normalizePath(oldParent))) return false;
    // Must stay under the same Library root (not moved elsewhere).
    if (normalizePath(oldParent) !== normalizePath(newParent)) return false;

    const oldName = basenameOfPath(oldPath);
    const newName = basenameOfPath(newPath);
    if (!oldName || !newName || oldName === newName) return false;

    const categoryId = findCategoryIdForFolderName(plugin, project, oldName);
    if (!categoryId) return false;

    if (!project.libraryFolders) project.libraryFolders = {};
    project.libraryFolders[categoryId] = newName;
    applyLibraryFolderPaths(project, plugin);

    const custom = plugin.settings.codexCustomCategories?.find(c => c.id === categoryId);
    if (custom) {
        custom.label = newName;
        await plugin.saveSettings();
    }

    await plugin.sceneManager.saveProjectFrontmatter(project);
    applyCategoryFolderLabels(plugin);
    return true;
}

function findCategoryIdForFolderName(
    plugin: SceneCardsPlugin,
    project: StoryLineProject,
    folderName: string,
): string | null {
    const candidates = new Set<string>([
        'characters',
        'locations',
        ...(plugin.settings.codexEnabledCategories || []),
        ...(plugin.settings.codexCustomCategories || []).map(c => c.id),
    ]);
    for (const id of candidates) {
        if (resolveLibraryFolderName(plugin, id, project) === folderName) return id;
    }
    // Also match defaults / builtin folder even if not currently enabled
    for (const [id, defName] of Object.entries(DEFAULT_LIBRARY_FOLDER_NAMES)) {
        if (defName === folderName) return id;
    }
    for (const cc of plugin.settings.codexCustomCategories || []) {
        if (cc.label === folderName) return cc.id;
    }
    return null;
}

/** Seed libraryFolders for a new project from defaults + enabled categories. */
export function defaultLibraryFoldersForNewProject(
    plugin: SceneCardsPlugin,
): Record<string, string> {
    const map: Record<string, string> = {
        characters: DEFAULT_LIBRARY_FOLDER_NAMES.characters,
        locations: DEFAULT_LIBRARY_FOLDER_NAMES.locations,
    };
    for (const id of plugin.settings.codexEnabledCategories || []) {
        map[id] = resolveLibraryFolderName(plugin, id, null);
    }
    return map;
}

export async function ensureFoldersExist(app: App, paths: string[]): Promise<void> {
    for (const p of paths) {
        const path = normalizePath(p);
        if (!path) continue;
        if (await app.vault.adapter.exists(path)) continue;
        await app.vault.createFolder(path).catch(() => undefined);
    }
}
/* eslint-enable @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-argument, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-return, @typescript-eslint/no-floating-promises, @typescript-eslint/no-misused-promises, @typescript-eslint/no-unnecessary-type-assertion, @typescript-eslint/no-redundant-type-constituents, @typescript-eslint/no-unused-vars, no-unused-vars, no-useless-escape, no-control-regex, no-empty -- end of file-wide suppression block opened at line 1 */
