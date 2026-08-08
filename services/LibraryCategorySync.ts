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
import { localizeForLanguage, seedUiLanguage, t } from '../utils/i18n';
import { removeNativeLibraryBase, syncNativeLibraryBase } from '../components/NativeLibraryBase';

/** Default English folder basenames for built-in / special Library tabs. */
export const DEFAULT_LIBRARY_FOLDER_NAMES: Record<string, string> = {
    characters: 'Characters',
    locations: 'Locations',
    ...Object.fromEntries(BUILTIN_CODEX_CATEGORIES.map(c => [c.id, c.folder])),
};

const BUILTIN_LIBRARY_ICONS: Record<string, string> = {
    characters: 'users',
    locations: 'map-pin',
    ...Object.fromEntries(BUILTIN_CODEX_CATEGORIES.map(c => [c.id, c.icon])),
};

/** True when `label` is only a language seed of the English default (not a user rename). */
export function isSeedLibraryCategoryLabel(categoryId: string, label: string): boolean {
    const trimmed = label.trim();
    if (!trimmed) return false;
    const english = DEFAULT_LIBRARY_FOLDER_NAMES[categoryId];
    if (!english) return false;
    if (trimmed === english) return true;
    return trimmed === localizeForLanguage('zh', english)
        || trimmed === localizeForLanguage('en', english);
}

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

    const defaultName = DEFAULT_LIBRARY_FOLDER_NAMES[categoryId];
    const custom = plugin.settings.codexCustomCategories?.find(c => c.id === categoryId);
    const label = custom?.label?.trim();

    // Built-ins: keep English (or project-mapped) paths. Seeded zh/en display
    // labels must not redirect the vault folder.
    if (defaultName) {
        if (!label || isSeedLibraryCategoryLabel(categoryId, label)) return defaultName;
        return label; // legacy rename stored only on custom.label
    }

    if (label) return label;
    return categoryId;
}

/**
 * Player-visible Library tab / manager label.
 * Prefers saved custom label; otherwise seeds from Obsidian interface language.
 */
export function resolveLibraryCategoryLabel(
    plugin: SceneCardsPlugin,
    categoryId: string,
    fallback = '',
): string {
    if (categoryId === UNCATEGORIZED_CATEGORY_ID) {
        const custom = plugin.settings.codexCustomCategories?.find(c => c.id === categoryId);
        return custom?.label?.trim() || t('Uncategorized entries');
    }
    const custom = plugin.settings.codexCustomCategories?.find(c => c.id === categoryId);
    if (custom?.label?.trim()) return custom.label.trim();
    const english = DEFAULT_LIBRARY_FOLDER_NAMES[categoryId] || fallback;
    if (!english) return fallback || categoryId;
    return localizeForLanguage(seedUiLanguage(plugin.app), english);
}

/**
 * One-shot: persist display labels for built-in Library categories from Obsidian language.
 * Pins English folder mappings on the active project so labels can differ from paths.
 */
export async function ensureSeededLibraryCategoryLabels(plugin: SceneCardsPlugin): Promise<void> {
    const seedLang = seedUiLanguage(plugin.app);
    const deleted = new Set(plugin.settings.codexDeletedPresetCategories || []);
    if (!plugin.settings.codexCustomCategories) plugin.settings.codexCustomCategories = [];

    const ids = [
        'characters',
        'locations',
        ...BUILTIN_CODEX_CATEGORIES.map(c => c.id).filter(id => !deleted.has(id)),
    ];

    let settingsChanged = false;
    const project = plugin.sceneManager.activeProject;
    let projectChanged = false;
    if (project && !project.libraryFolders) {
        project.libraryFolders = {};
        projectChanged = true;
    }

    for (const id of ids) {
        const english = DEFAULT_LIBRARY_FOLDER_NAMES[id];
        if (!english) continue;
        const seedLabel = localizeForLanguage(seedLang, english);

        if (project?.libraryFolders && !project.libraryFolders[id]?.trim()) {
            project.libraryFolders[id] = english;
            projectChanged = true;
        }

        const entry = plugin.settings.codexCustomCategories.find(c => c.id === id);
        if (!entry) {
            plugin.settings.codexCustomCategories.push({
                id,
                label: seedLabel,
                icon: BUILTIN_LIBRARY_ICONS[id] || 'file-text',
                preset: id !== 'characters' && id !== 'locations'
                    ? true
                    : undefined,
            });
            settingsChanged = true;
        } else if (!entry.label?.trim() || entry.label.trim() === english) {
            // Still at English factory default → first-generation seed.
            if (entry.label?.trim() !== seedLabel) {
                entry.label = seedLabel;
                settingsChanged = true;
            }
            if (!entry.icon) {
                entry.icon = BUILTIN_LIBRARY_ICONS[id] || 'file-text';
                settingsChanged = true;
            }
        }
    }

    if (settingsChanged) await plugin.saveSettings();
    if (projectChanged && project) {
        await plugin.sceneManager.saveProjectFrontmatter(project);
    }
}

/** Recompute project.characterFolder / locationFolder from libraryFolders. */
export function applyLibraryFolderPaths(project: StoryLineProject, plugin: SceneCardsPlugin): void {
    const lib = normalizePath(project.codexFolder);
    const charName = resolveLibraryFolderName(plugin, 'characters', project);
    const locName = resolveLibraryFolderName(plugin, 'locations', project);
    project.characterFolder = normalizePath(`${lib}/${charName}`);
    project.locationFolder = normalizePath(`${lib}/${locName}`);
}

/** Push resolved folder + display label onto CodexManager category defs. */
export function applyCategoryFolderLabels(plugin: SceneCardsPlugin): void {
    for (const cat of plugin.codexManager.getCategories()) {
        if (cat.id === UNCATEGORIZED_CATEGORY_ID) continue;
        const folder = resolveLibraryFolderName(plugin, cat.id);
        const label = resolveLibraryCategoryLabel(plugin, cat.id, cat.label || folder);
        plugin.codexManager.setCategoryFolder(cat.id, folder, label);
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
        const attachments = normalizePath(`${path}/Attachments`);
        if (!await adapter.exists(attachments)) {
            await plugin.app.vault.createFolder(attachments).catch(() => undefined);
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

        // Keep the active project's custom label in sync with the folder name.
        const custom = plugin.settings.codexCustomCategories?.find(c => c.id === categoryId);
        if (custom) {
            custom.label = newName;
            await plugin.saveSettings();
        }

        await plugin.sceneManager.saveProjectFrontmatter(project);
        applyCategoryFolderLabels(plugin);
        await syncNativeLibraryBase(plugin, categoryId);
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
    const libraryRoots = libraryRootsForProject(plugin, project);
    const pluginAny = plugin as SceneCardsPlugin & { _syncingLibraryFolders?: boolean };
    pluginAny._syncingLibraryFolders = true;

    try {
        for (const libraryRoot of libraryRoots) {
            const folderPath = normalizePath(`${libraryRoot}/${folderName}`);
            const folder = plugin.app.vault.getAbstractFileByPath(folderPath);
            if (!(folder instanceof TFolder)) continue;
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
                    if (file.name === '_NarrativeLab.base' || file.name === '.narrative-lab.base') continue;
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
                }
                const remainingFolder = plugin.app.vault.getAbstractFileByPath(folderPath);
                if (remainingFolder instanceof TFolder) {
                    await plugin.app.fileManager.trashFile(remainingFolder);
                }
            } else {
                await plugin.app.fileManager.trashFile(folder);
            }
        }
        await removeNativeLibraryBase(plugin, categoryId);

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
    await syncNativeLibraryBase(plugin, categoryId);
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

/** Per-project Library category config stored in System/library-categories.json. */
export const LIBRARY_CATEGORIES_FILENAME = 'library-categories.json';

export type LibraryCategorySettingsPayload = {
    enabledCategories: string[];
    customCategories: Array<{
        id: string;
        label: string;
        icon: string;
        showInSidebar?: boolean;
        preset?: boolean;
    }>;
    categoryOrder: string[];
    hiddenFixedCategories: string[];
    deletedPresetCategories: string[];
};

const FIXED_LIBRARY_FOLDER_IDS = new Set(['characters', 'locations']);

export function emptyLibraryCategorySettings(): LibraryCategorySettingsPayload {
    return {
        enabledCategories: [],
        customCategories: [],
        categoryOrder: [],
        hiddenFixedCategories: [],
        deletedPresetCategories: [],
    };
}

export function readLibraryCategorySettings(
    settings: SceneCardsPlugin['settings'],
): LibraryCategorySettingsPayload {
    return {
        enabledCategories: [...(settings.codexEnabledCategories || [])],
        customCategories: (settings.codexCustomCategories || []).map(category => ({ ...category })),
        categoryOrder: [...(settings.libraryCategoryOrder || [])],
        hiddenFixedCategories: [...(settings.libraryHiddenFixedCategories || [])],
        deletedPresetCategories: [...(settings.codexDeletedPresetCategories || [])],
    };
}

export function applyLibraryCategorySettings(
    plugin: SceneCardsPlugin,
    payload: LibraryCategorySettingsPayload,
): void {
    plugin.settings.codexEnabledCategories = [...(payload.enabledCategories || [])];
    plugin.settings.codexCustomCategories = (payload.customCategories || []).map(category => ({ ...category }));
    plugin.settings.libraryCategoryOrder = [...(payload.categoryOrder || [])];
    plugin.settings.libraryHiddenFixedCategories = [...(payload.hiddenFixedCategories || [])];
    plugin.settings.codexDeletedPresetCategories = [...(payload.deletedPresetCategories || [])];
}

function parseLibraryCategorySettings(raw: Record<string, unknown>): LibraryCategorySettingsPayload | null {
    if (!raw || typeof raw !== 'object') return null;
    const hasAny = 'enabledCategories' in raw
        || 'customCategories' in raw
        || 'categoryOrder' in raw
        || 'hiddenFixedCategories' in raw
        || 'deletedPresetCategories' in raw;
    if (!hasAny) return null;

    const customRaw = Array.isArray(raw.customCategories) ? raw.customCategories : [];
    const customCategories = customRaw
        .filter((item): item is Record<string, unknown> => !!item && typeof item === 'object')
        .map(item => ({
            id: String(item.id || '').trim(),
            label: String(item.label || '').trim(),
            icon: String(item.icon || 'file-text').trim() || 'file-text',
            ...(typeof item.showInSidebar === 'boolean' ? { showInSidebar: item.showInSidebar } : {}),
            ...(typeof item.preset === 'boolean' ? { preset: item.preset } : {}),
        }))
        .filter(item => item.id && item.label);

    const asStringArray = (value: unknown): string[] =>
        Array.isArray(value)
            ? value.map(entry => String(entry || '').trim()).filter(Boolean)
            : [];

    return {
        enabledCategories: asStringArray(raw.enabledCategories),
        customCategories,
        categoryOrder: asStringArray(raw.categoryOrder),
        hiddenFixedCategories: asStringArray(raw.hiddenFixedCategories),
        deletedPresetCategories: asStringArray(raw.deletedPresetCategories),
    };
}

export function libraryCategorySettingsFromUnknown(
    raw: Record<string, unknown>,
): LibraryCategorySettingsPayload | null {
    return parseLibraryCategorySettings(raw);
}

function slugLibraryCategoryId(name: string): string {
    const slug = name
        .trim()
        .toLowerCase()
        .replace(/\s+/g, '-')
        .replace(/[^\p{L}\p{N}_-]/gu, '')
        .replace(/-+/g, '-')
        .replace(/^-|-$/g, '');
    return slug || 'category';
}

function resolveCategoryIdForLibraryFolder(
    plugin: SceneCardsPlugin,
    project: StoryLineProject,
    folderName: string,
): { id: string; label: string; icon: string; builtin: boolean } | null {
    const normalized = folderName.trim();
    if (!normalized) return null;

    const byProject = Object.entries(project.libraryFolders || {})
        .find(([, name]) => name === normalized);
    if (byProject) {
        const id = byProject[0];
        if (FIXED_LIBRARY_FOLDER_IDS.has(id)) return null;
        const builtin = BUILTIN_CODEX_CATEGORIES.find(category => category.id === id);
        const custom = plugin.settings.codexCustomCategories?.find(category => category.id === id);
        return {
            id,
            label: custom?.label || builtin?.label || normalized,
            icon: custom?.icon || builtin?.icon || 'file-text',
            builtin: !!builtin,
        };
    }

    for (const builtin of BUILTIN_CODEX_CATEGORIES) {
        if (builtin.folder === normalized || builtin.id === normalized.toLowerCase()) {
            return {
                id: builtin.id,
                label: builtin.label,
                icon: builtin.icon,
                builtin: true,
            };
        }
    }

    const custom = plugin.settings.codexCustomCategories?.find(category =>
        category.label === normalized || category.id === normalized.toLowerCase());
    if (custom) {
        return {
            id: custom.id,
            label: custom.label,
            icon: custom.icon || 'file-text',
            builtin: false,
        };
    }

    const id = slugLibraryCategoryId(normalized);
    if (FIXED_LIBRARY_FOLDER_IDS.has(id) || id === UNCATEGORIZED_CATEGORY_ID) return null;
    return {
        id,
        label: normalized,
        icon: 'file-text',
        builtin: false,
    };
}

/**
 * Discover Library subfolders and register missing categories for the active project.
 * When `enableExisting` is true (first migration), restore/enable categories that
 * already have folders — e.g. revive Creatures after a shared global delete.
 */
export async function adoptLibraryCategoriesFromFolders(
    plugin: SceneCardsPlugin,
    options: { enableExisting?: boolean } = {},
): Promise<boolean> {
    const project = plugin.sceneManager.activeProject;
    if (!project) return false;

    const enableExisting = options.enableExisting === true;
    const libraryRoot = normalizePath(project.codexFolder);
    const rootAf = plugin.app.vault.getAbstractFileByPath(libraryRoot);
    if (!(rootAf instanceof TFolder)) return false;

    let changed = false;
    const enabled = new Set(plugin.settings.codexEnabledCategories || []);
    const order = [...(plugin.settings.libraryCategoryOrder || [])];
    const deleted = new Set(plugin.settings.codexDeletedPresetCategories || []);
    if (!plugin.settings.codexCustomCategories) plugin.settings.codexCustomCategories = [];
    if (!project.libraryFolders) project.libraryFolders = {};

    const ensureRegistered = (id: string, label: string, icon: string, builtin: boolean, folderName: string) => {
        if (deleted.has(id)) {
            deleted.delete(id);
            changed = true;
        }
        if (!enabled.has(id)) {
            enabled.add(id);
            changed = true;
        }
        if (!builtin && !plugin.settings.codexCustomCategories.some(category => category.id === id)) {
            plugin.settings.codexCustomCategories.push({ id, label, icon });
            changed = true;
        }
        if (!order.includes(id)) {
            order.push(id);
            changed = true;
        }
        if (project.libraryFolders![id] !== folderName) {
            project.libraryFolders![id] = folderName;
            changed = true;
        }
    };

    for (const child of rootAf.children) {
        if (!(child instanceof TFolder)) continue;
        const folderName = child.name;
        const resolved = resolveCategoryIdForLibraryFolder(plugin, project, folderName);
        if (!resolved) continue;

        const { id, label, icon, builtin } = resolved;
        const listed = enabled.has(id)
            || !!plugin.settings.codexCustomCategories.find(category => category.id === id)
            || !!project.libraryFolders[id];

        if (enableExisting) {
            ensureRegistered(id, label, icon, builtin, folderName);
            continue;
        }

        // Already-migrated project: keep user hide/delete choices, only adopt
        // brand-new folders that are not part of this project's category config.
        if (deleted.has(id) || listed || (builtin && !deleted.has(id) && enabled.has(id))) continue;
        if (builtin && !listed) continue;
        ensureRegistered(id, label, icon, builtin, folderName);
    }

    if (changed) {
        plugin.settings.codexEnabledCategories = Array.from(enabled);
        plugin.settings.libraryCategoryOrder = order;
        plugin.settings.codexDeletedPresetCategories = Array.from(deleted);
    }
    return changed;
}
/* eslint-enable @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-argument, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-return, @typescript-eslint/no-floating-promises, @typescript-eslint/no-misused-promises, @typescript-eslint/no-unnecessary-type-assertion, @typescript-eslint/no-redundant-type-constituents, @typescript-eslint/no-unused-vars, no-unused-vars, no-useless-escape, no-control-regex, no-empty -- end of file-wide suppression block opened at line 1 */
