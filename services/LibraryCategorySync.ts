/* eslint-disable @typescript-eslint/no-unsafe-assignment -- Obsidian's API surface and several untyped third-party libraries force dynamic dispatch; floating promises are intentional in DOM/event handlers; matching enable at end of file */
/**
 * Library categories ↔ vault folders.
 *
 * Strict rules (every project):
 * 1. Source of truth for folders = direct subfolders of Library/ (plus fixed
 *    Characters / Locations / Uncategorized). Tab visibility is the user's
 *    enabled/hidden list — hiding a category keeps its folder. Automatic
 *    reconcile must adopt unknown folders, never trash ones that still have notes.
 * 2. Uncategorized = notes at Library root only — never notes inside a
 *    category subfolder (Creatures, Skills, …).
 * 3. Deleting a category removes its Library folder(s) and Library Base view,
 *    plus settings; leftover rename aliases (e.g. library-技能.base) are pruned.
 * 4. Library/library.base views must match live categories; orphans are removed.
 * 5. Stable category ids (characters, locations, items, …) never change —
 *    only the folder basename / tab label does.
 */
import { Notice, TFile, TFolder, normalizePath } from 'obsidian';
import { BUILTIN_CODEX_CATEGORIES, UNCATEGORIZED_CATEGORY_ID } from '../models/Codex';
import type { StoryLineProject } from '../models/StoryLineProject';
import type SceneCardsPlugin from '../main';
import { localizeForLanguage, t } from '../utils/i18n';
import {
    allocateLibraryCategoryId,
    collectStaleNumberedCategoryRepairs,
    findLibraryCategoriesMissingFolders,
    libraryFolderNamesMatch,
    planLibraryFolderRename,
    isSingularPluralFolderAlias,
    shouldAllocateNewCategoryForFolder,
    shouldEnableAdoptedLibraryCategory,
    type VaultPathKind,
} from '../utils/libraryCategoryTransactions';
import { coerceString } from '../utils/narrow';
import { ensureVaultFolder, isUntrackedLibraryNoise } from '../utils/vaultFolders';
import { collectMarkdownFiles, isLibraryEntityMarkdownFile } from './EntityFileCache';
import {
    migrateNativeLibraryBasesForActiveProject,
    pruneOrphanNativeLibraryBases,
    renameNativeLibraryBase,
    removeNativeLibraryBase,
    syncNativeLibraryBase,
} from '../components/NativeLibraryBase';

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

/** Version 1 restores Storyline's six original Codex presets to each project once. */
export const STORYLINE_PRESET_SEED_VERSION = 1;

/**
 * Restore the original Storyline preset categories for projects created before
 * they became opt-in. Explicitly deleted presets keep their tombstones and are
 * never recreated. The version marker means later user hide/show choices stick.
 */
export function seedStorylinePresetCategories(plugin: SceneCardsPlugin): boolean {
    if ((plugin.settings.codexPresetSeedVersion || 0) >= STORYLINE_PRESET_SEED_VERSION) {
        return false;
    }

    const deleted = new Set(plugin.settings.codexDeletedPresetCategories || []);
    const enabled = new Set(plugin.settings.codexEnabledCategories || []);
    const order = [...(plugin.settings.libraryCategoryOrder || [])];
    const categories = plugin.settings.codexCustomCategories || [];

    for (const fixedId of ['characters', 'locations']) {
        if (!order.includes(fixedId)) order.push(fixedId);
    }
    for (const preset of BUILTIN_CODEX_CATEGORIES) {
        if (deleted.has(preset.id)) continue;
        enabled.add(preset.id);
        if (!order.includes(preset.id)) order.push(preset.id);
        const existing = categories.find(category => category.id === preset.id);
        if (existing) {
            existing.preset = true;
            existing.hasProfilePage = true;
            existing.showInSidebar = true;
            if (!existing.label?.trim()) existing.label = preset.label;
            if (!existing.icon) existing.icon = preset.icon;
        } else {
            categories.push({
                id: preset.id,
                label: preset.label,
                icon: preset.icon,
                preset: true,
                hasProfilePage: true,
                showInSidebar: true,
            });
        }
    }

    plugin.settings.codexEnabledCategories = Array.from(enabled);
    plugin.settings.codexCustomCategories = categories;
    plugin.settings.libraryCategoryOrder = order;
    plugin.settings.codexPresetSeedVersion = STORYLINE_PRESET_SEED_VERSION;
    return true;
}

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

/** Player-visible Library tab / manager label. Editable names stay verbatim. */
export function resolveLibraryCategoryLabel(
    plugin: SceneCardsPlugin,
    categoryId: string,
    fallback = '',
): string {
    if (categoryId === UNCATEGORIZED_CATEGORY_ID) {
        const custom = plugin.settings.codexCustomCategories?.find(c => c.id === categoryId);
        return custom?.label?.trim() || t('Uncategorized entries');
    }
    const projectFolder = plugin.sceneManager.activeProject?.libraryFolders?.[categoryId]?.trim();
    const defaultFolder = DEFAULT_LIBRARY_FOLDER_NAMES[categoryId];
    // A non-default project mapping is an explicit folder rename and should be
    // visible immediately, including for fixed Characters / Locations tabs.
    if (projectFolder && projectFolder !== defaultFolder) return projectFolder;
    const custom = plugin.settings.codexCustomCategories?.find(c => c.id === categoryId);
    const customLabel = custom?.label?.trim();
    if (customLabel && (!defaultFolder || !isSeedLibraryCategoryLabel(categoryId, customLabel))) {
        return customLabel;
    }
    const english = DEFAULT_LIBRARY_FOLDER_NAMES[categoryId] || fallback;
    if (!english) return fallback || categoryId;
    return t(english);
}

/** Visible Library tabs for canvas / other hosts — same set as CodexCategoryTabs. */
export function listVisibleLibraryCategories(plugin: SceneCardsPlugin): Array<{
    id: string;
    label: string;
    folder: string;
}> {
    const hiddenFixed = new Set(plugin.settings.libraryHiddenFixedCategories || []);
    const enabled = new Set(plugin.settings.codexEnabledCategories || []);

    const items: Array<{ id: string; label: string; folder: string }> = [];
    if (!hiddenFixed.has('characters')) {
        items.push({
            id: 'characters',
            label: resolveLibraryCategoryLabel(plugin, 'characters', 'Characters'),
            folder: resolveLibraryFolderName(plugin, 'characters'),
        });
    }
    if (!hiddenFixed.has('locations')) {
        items.push({
            id: 'locations',
            label: resolveLibraryCategoryLabel(plugin, 'locations', 'Locations'),
            folder: resolveLibraryFolderName(plugin, 'locations'),
        });
    }
    for (const category of plugin.codexManager.getCategories()) {
        if (category.id === UNCATEGORIZED_CATEGORY_ID) continue;
        if (!enabled.has(category.id)) continue;
        items.push({
            id: category.id,
            label: resolveLibraryCategoryLabel(plugin, category.id, category.label),
            folder: resolveLibraryFolderName(plugin, category.id),
        });
    }

    const seen = new Set(items.map(item => item.id));
    for (const custom of plugin.settings.codexCustomCategories || []) {
        if (!custom?.id || seen.has(custom.id)) continue;
        if (custom.id === UNCATEGORIZED_CATEGORY_ID) continue;
        if (!enabled.has(custom.id)) continue;
        seen.add(custom.id);
        items.push({
            id: custom.id,
            label: resolveLibraryCategoryLabel(plugin, custom.id, custom.label),
            folder: resolveLibraryFolderName(plugin, custom.id),
        });
    }

    const order = plugin.settings.libraryCategoryOrder || [];
    const orderIndex = new Map(order.map((id, index) => [id, index]));
    items.sort((left, right) => {
        const leftIndex = orderIndex.get(left.id);
        const rightIndex = orderIndex.get(right.id);
        if (leftIndex === undefined && rightIndex === undefined) return 0;
        if (leftIndex === undefined) return 1;
        if (rightIndex === undefined) return -1;
        return leftIndex - rightIndex;
    });
    return items;
}

/** Display name for a canvas kind / NL category id, including custom-* orphans. */
export function resolveLibraryCategoryLabelForKind(plugin: SceneCardsPlugin, kind: string): string {
    const raw = String(kind || '').trim();
    if (!raw) return '';
    const categories = listVisibleLibraryCategories(plugin);
    const match = categories.find(category => {
        const id = String(category.id || '').toLowerCase();
        const label = String(category.label || '').toLowerCase();
        const folder = String(category.folder || '').toLowerCase();
        const key = raw.toLowerCase();
        return id === key || label === key || folder === key
            || (id === 'characters' && (key === 'character' || key === 'characters'))
            || (id === 'locations' && (key === 'location' || key === 'locations'))
            || (id === 'items' && (key === 'item' || key === 'items'));
    });
    if (match?.label) return match.label;
    const custom = (plugin.settings.codexCustomCategories || []).find(category => (
        category.id === raw || category.id.toLowerCase() === raw.toLowerCase()
    ));
    if (custom?.label?.trim()) return custom.label.trim();
    const mapped = raw.toLowerCase() === 'character' ? 'characters'
        : raw.toLowerCase() === 'location' ? 'locations'
        : raw.toLowerCase() === 'item' ? 'items'
        : raw;
    const resolved = resolveLibraryCategoryLabel(plugin, mapped, custom?.label || '');
    if (resolved && resolved !== mapped && resolved !== raw) return resolved;
    const folder = plugin.sceneManager.activeProject?.libraryFolders?.[mapped]
        || plugin.sceneManager.activeProject?.libraryFolders?.[raw];
    if (folder?.trim()) return folder.trim();
    return resolved || raw;
}

function setLibraryCategoryDisplayMetadata(
    plugin: SceneCardsPlugin,
    categoryId: string,
    label: string,
): void {
    if (!plugin.settings.codexCustomCategories) plugin.settings.codexCustomCategories = [];
    const existing = plugin.settings.codexCustomCategories.find(category => category.id === categoryId);
    if (existing) {
        existing.label = label;
        if (!existing.icon) existing.icon = BUILTIN_LIBRARY_ICONS[categoryId] || 'file-text';
        return;
    }
    plugin.settings.codexCustomCategories.push({
        id: categoryId,
        label,
        icon: BUILTIN_LIBRARY_ICONS[categoryId] || 'file-text',
        preset: BUILTIN_CODEX_CATEGORIES.some(category => category.id === categoryId) || undefined,
    });
}

/** Persist raw English defaults while preserving explicit folder/category renames. */
export async function ensureSeededLibraryCategoryLabels(plugin: SceneCardsPlugin): Promise<void> {
    const deleted = new Set(plugin.settings.codexDeletedPresetCategories || []);
    if (!plugin.settings.codexCustomCategories) plugin.settings.codexCustomCategories = [];

    const project = plugin.sceneManager.activeProject;
    const enabled = new Set(plugin.settings.codexEnabledCategories || []);
    const registered = new Set(plugin.settings.codexCustomCategories.map(category => category.id));

    const ids = [
        'characters',
        'locations',
        ...BUILTIN_CODEX_CATEGORIES.map(c => c.id).filter(id =>
            !deleted.has(id)
            && (enabled.has(id) || registered.has(id) || !!project?.libraryFolders?.[id])),
    ];

    let settingsChanged = false;
    let projectChanged = false;
    if (project && !project.libraryFolders) {
        project.libraryFolders = {};
        projectChanged = true;
    }

    for (const id of ids) {
        const english = DEFAULT_LIBRARY_FOLDER_NAMES[id];
        if (!english) continue;
        const projectFolder = project?.libraryFolders?.[id]?.trim();
        const seedLabel = projectFolder && projectFolder !== english ? projectFolder : english;

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
        } else if (!entry.label?.trim() || isSeedLibraryCategoryLabel(id, entry.label)) {
            // Migrate old UI-language seeds; explicit folder renames remain intact.
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

/**
 * Category ids that still own a Library folder: fixed hubs plus categories
 * already registered by this project. Merely existing as a built-in template
 * does not create a folder.
 */
export function getManagedLibraryCategoryIds(plugin: SceneCardsPlugin): string[] {
    const ids = new Set<string>(['characters', 'locations']);
    for (const custom of plugin.settings.codexCustomCategories || []) {
        if (!custom.id || custom.id === UNCATEGORIZED_CATEGORY_ID) continue;
        ids.add(custom.id);
    }
    for (const id of plugin.settings.codexEnabledCategories || []) {
        if (!id || id === UNCATEGORIZED_CATEGORY_ID) continue;
        ids.add(id);
    }
    return [...ids];
}

function removeLibraryCategoryState(
    plugin: SceneCardsPlugin,
    project: StoryLineProject,
    categoryId: string,
): void {
    plugin.settings.codexEnabledCategories =
        (plugin.settings.codexEnabledCategories || []).filter(id => id !== categoryId);
    plugin.settings.libraryCategoryOrder =
        (plugin.settings.libraryCategoryOrder || []).filter(id => id !== categoryId);
    if (plugin.settings.storyGraphLibraryCategoryColors?.[categoryId]) {
        delete plugin.settings.storyGraphLibraryCategoryColors[categoryId];
    }
    plugin.settings.codexCustomCategories =
        (plugin.settings.codexCustomCategories || []).filter(category => category.id !== categoryId);
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
    delete plugin.settings.libraryArchiveFilterFields?.[categoryId];
    delete plugin.settings.hiddenFields?.[categoryId];
    delete plugin.settings.removedBuiltinFields?.[categoryId];
    delete plugin.settings.removedBuiltinSections?.[categoryId];
    if (project.libraryFolders) delete project.libraryFolders[categoryId];
}

/** Read direct Library children from disk so Finder/Explorer changes do not wait for Obsidian's index. */
async function readLibraryFolderNames(
    plugin: SceneCardsPlugin,
    project: StoryLineProject,
): Promise<{ names: Set<string>; occupied: Set<string>; scannedRoots: number }> {
    const names = new Set<string>();
    const occupied = new Set<string>();
    let scannedRoots = 0;
    for (const root of libraryRootsForProject(plugin, project)) {
        try {
            if (!await plugin.app.vault.adapter.exists(root)) continue;
            const listing = await plugin.app.vault.adapter.list(root);
            scannedRoots += 1;
            for (const folderPath of listing.folders) {
                const name = basenameOfPath(folderPath);
                if (!name) continue;
                names.add(name);
                try {
                    const notes = await collectMarkdownFiles(plugin.app, folderPath);
                    if (notes.some(file => isLibraryEntityMarkdownFile(file))) occupied.add(name);
                } catch {
                    // After a Finder move the folder can exist on disk before
                    // Obsidian indexes its notes. Treat as occupied so we do
                    // not trash a live category.
                    occupied.add(name);
                }
            }
        } catch (error) {
            console.warn('[NarrativeLab] Failed to scan Library folders:', root, error);
        }
    }
    return { names, occupied, scannedRoots };
}

function isLibraryCategoryFolderEmpty(folder: TFolder): boolean {
    for (const child of folder.children) {
        if (child instanceof TFolder) {
            if (!isLibraryCategoryFolderEmpty(child)) return false;
            continue;
        }
        if (!(child instanceof TFile)) continue;
        if (child.name.toLowerCase().endsWith('.base')) continue;
        if (isUntrackedLibraryNoise(child.name) || child.name.startsWith('.')) continue;
        return false;
    }
    return true;
}

/** Empty English seed left behind after the category folder was renamed. */
function isLeftoverSeedLibraryFolder(
    plugin: SceneCardsPlugin,
    project: StoryLineProject,
    folderName: string,
): boolean {
    for (const [id, english] of Object.entries(DEFAULT_LIBRARY_FOLDER_NAMES)) {
        if (!libraryFolderNamesMatch(english, folderName) && !isSingularPluralFolderAlias(folderName, english)) {
            continue;
        }
        const current = resolveLibraryFolderName(plugin, id, project);
        if (current && !libraryFolderNamesMatch(current, folderName)) return true;
    }
    return false;
}

async function trashEmptyLibraryFolder(
    plugin: SceneCardsPlugin,
    project: StoryLineProject,
    folderName: string,
): Promise<void> {
    const name = folderName.trim();
    if (!name) return;
    for (const root of libraryRootsForProject(plugin, project)) {
        const folder = plugin.app.vault.getAbstractFileByPath(normalizePath(`${root}/${name}`));
        if (!(folder instanceof TFolder) || !isLibraryCategoryFolderEmpty(folder)) continue;
        await disposeLibrarySubfolder(plugin, root, name, 'trash');
    }
}

async function mergeFolderInto(
    plugin: SceneCardsPlugin,
    from: TFolder,
    to: TFolder,
): Promise<void> {
    for (const child of [...from.children]) {
        const destPath = normalizePath(`${to.path}/${child.name}`);
        const existing = plugin.app.vault.getAbstractFileByPath(destPath);
        if (child instanceof TFolder && existing instanceof TFolder) {
            await mergeFolderInto(plugin, child, existing);
            const leftover = plugin.app.vault.getAbstractFileByPath(child.path);
            if (leftover instanceof TFolder && leftover.children.length === 0) {
                await plugin.app.fileManager.trashFile(leftover);
            }
            continue;
        }
        let target = destPath;
        if (existing) {
            const dot = child.name.lastIndexOf('.');
            const stem = dot > 0 ? child.name.slice(0, dot) : child.name;
            const extension = dot > 0 ? child.name.slice(dot) : '';
            let suffix = 2;
            while (plugin.app.vault.getAbstractFileByPath(target)) {
                target = normalizePath(`${to.path}/${stem} ${suffix}${extension}`);
                suffix += 1;
            }
        }
        await plugin.app.fileManager.renameFile(child, target);
    }
}

/** Location → Locations: restore the seed folder instead of creating locations-2. */
async function restoreCanonicalSeedFolders(
    plugin: SceneCardsPlugin,
    project: StoryLineProject,
): Promise<boolean> {
    let changed = false;
    if (!project.libraryFolders) project.libraryFolders = {};
    for (const root of libraryRootsForProject(plugin, project)) {
        if (!await plugin.app.vault.adapter.exists(root)) continue;
        for (const [id, canonical] of Object.entries(DEFAULT_LIBRARY_FOLDER_NAMES)) {
            const listing = await plugin.app.vault.adapter.list(root);
            const alias = listing.folders
                .map(path => basenameOfPath(path))
                .find(name => isSingularPluralFolderAlias(name, canonical));
            if (!alias) continue;
            const fromPath = normalizePath(`${root}/${alias}`);
            const toPath = normalizePath(`${root}/${canonical}`);
            const from = plugin.app.vault.getAbstractFileByPath(fromPath);
            if (!(from instanceof TFolder)) continue;
            const to = plugin.app.vault.getAbstractFileByPath(toPath);
            if (!to) {
                await plugin.app.fileManager.renameFile(from, toPath);
            } else if (to instanceof TFolder) {
                await mergeFolderInto(plugin, from, to);
                const leftover = plugin.app.vault.getAbstractFileByPath(fromPath);
                if (leftover instanceof TFolder) {
                    await plugin.app.fileManager.trashFile(leftover);
                }
            } else {
                continue;
            }
            if (project.libraryFolders[id] !== canonical) {
                project.libraryFolders[id] = canonical;
                changed = true;
            }
            const custom = plugin.settings.codexCustomCategories?.find(category => category.id === id);
            if (custom?.label && (
                isSingularPluralFolderAlias(custom.label, canonical)
                || libraryFolderNamesMatch(custom.label, alias)
            )) {
                custom.label = canonical;
                changed = true;
            }
            changed = true;
        }
    }
    return changed;
}

/** Remove category settings and Base assets when its local folder was removed. */
async function pruneLibraryCategoriesMissingFolders(plugin: SceneCardsPlugin): Promise<boolean> {
    const pluginAny = plugin as SceneCardsPlugin & { _syncingLibraryFolders?: boolean };
    // Never prune mid-rename/create — vault events can fire before mapping updates.
    if (pluginAny._syncingLibraryFolders) return false;

    const project = plugin.sceneManager.activeProject;
    if (!project) return false;
    const snapshot = await readLibraryFolderNames(plugin, project);
    if (snapshot.scannedRoots === 0 || snapshot.names.size === 0) return false;

    const candidateIds = new Set<string>([
        ...(plugin.settings.codexEnabledCategories || []),
        ...(plugin.settings.codexCustomCategories || []).map(category => category.id),
        ...Object.keys(project.libraryFolders || {}),
    ]);
    candidateIds.delete('characters');
    candidateIds.delete('locations');
    candidateIds.delete(UNCATEGORIZED_CATEGORY_ID);

    const aliasesByCategory: Record<string, string[]> = {};
    for (const categoryId of candidateIds) {
        const aliases = new Set<string>();
        aliases.add(resolveLibraryFolderName(plugin, categoryId, project));
        const mapped = project.libraryFolders?.[categoryId]?.trim();
        if (mapped) aliases.add(mapped);
        const custom = plugin.settings.codexCustomCategories?.find(category => category.id === categoryId);
        const customLabel = sanitizeLibraryFolderName(custom?.label || '');
        if (customLabel) aliases.add(customLabel);
        const english = DEFAULT_LIBRARY_FOLDER_NAMES[categoryId];
        if (english) aliases.add(english);
        aliasesByCategory[categoryId] = [...aliases];
    }

    const missing = findLibraryCategoriesMissingFolders(aliasesByCategory, snapshot.names);
    if (missing.length === 0) return false;
    for (const categoryId of missing) {
        // Resolve aliases before removing their metadata.
        await removeNativeLibraryBase(plugin, categoryId);
        removeLibraryCategoryState(plugin, project, categoryId);
    }
    return true;
}

function expectedLibraryFolderNames(
    plugin: SceneCardsPlugin,
    project: StoryLineProject,
): Set<string> {
    const names = new Set<string>();
    for (const id of getManagedLibraryCategoryIds(plugin)) {
        const resolved = resolveLibraryFolderName(plugin, id, project);
        if (resolved) names.add(resolved);
        const mapped = project.libraryFolders?.[id]?.trim();
        if (mapped) names.add(mapped);
        const custom = plugin.settings.codexCustomCategories?.find(c => c.id === id);
        const label = sanitizeLibraryFolderName(custom?.label || '');
        if (label) names.add(label);
        const english = DEFAULT_LIBRARY_FOLDER_NAMES[id];
        // After Creatures → Evomon, do not keep the old English folder as "expected"
        // or ensureLibraryCategoryFolders will recreate an empty duplicate.
        const current = mapped || resolved;
        if (english && (!current || libraryFolderNamesMatch(current, english))) {
            names.add(english);
        }
    }
    return names;
}

/** Move notes out of a category folder into Library root, then trash the folder. */
async function disposeLibrarySubfolder(
    plugin: SceneCardsPlugin,
    libraryRoot: string,
    folderName: string,
    mode: 'trash' | 'move-to-root',
): Promise<void> {
    const folderPath = normalizePath(`${libraryRoot}/${folderName}`);
    const folder = plugin.app.vault.getAbstractFileByPath(folderPath);
    if (!(folder instanceof TFolder)) return;

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
            if (file.name.toLowerCase().endsWith('.base')) continue;
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
        const remaining = plugin.app.vault.getAbstractFileByPath(folderPath);
        if (remaining instanceof TFolder) {
            await plugin.app.fileManager.trashFile(remaining);
        }
        return;
    }

    await plugin.app.fileManager.trashFile(folder);
}

/** Ensure Library + known category folders exist for the active project. */
export async function ensureLibraryCategoryFolders(plugin: SceneCardsPlugin): Promise<void> {
    const project = plugin.sceneManager.activeProject;
    if (!project) return;
    const adapter = plugin.app.vault.adapter;
    const roots = libraryRootsForProject(plugin, project);
    for (const lib of roots) {
        if (plugin.sceneManager.isDeletedProjectPath(lib)) continue;
        if (!await adapter.exists(lib)) {
            await ensureVaultFolder(plugin.app, lib);
        }
    }

    const ids = new Set<string>([
        'characters',
        'locations',
        ...(plugin.settings.codexEnabledCategories || []),
    ]);
    // Prefer the series Library when present — that's where shared categories live.
    const primaryLib = normalizePath(plugin.sceneManager.getCodexFolder() || project.codexFolder);
    for (const id of ids) {
        const name = resolveLibraryFolderName(plugin, id, project);
        const path = normalizePath(`${primaryLib}/${name}`);
        if (plugin.sceneManager.isDeletedProjectPath(path)) continue;
        if (!await adapter.exists(path)) {
            await ensureVaultFolder(plugin.app, path);
        }
    }
}

/**
 * After folders→categories adopt: ensure enabled folders exist, drop stale
 * libraryFolders keys, prune unmanaged orphan folders, prune orphan Bases.
 */
export async function syncLibraryFoldersWithCategories(
    plugin: SceneCardsPlugin,
): Promise<boolean> {
    const project = plugin.sceneManager.activeProject;
    if (!project) return false;

    const pluginAny = plugin as SceneCardsPlugin & { _syncingLibraryFolders?: boolean };
    const wasSyncing = !!pluginAny._syncingLibraryFolders;
    pluginAny._syncingLibraryFolders = true;
    let changed = false;
    try {
        await ensureLibraryCategoryFolders(plugin);

        const managed = new Set(getManagedLibraryCategoryIds(plugin));
        if (project.libraryFolders) {
            for (const id of Object.keys(project.libraryFolders)) {
                if (managed.has(id)) continue;
                delete project.libraryFolders[id];
                changed = true;
            }
        }

        const expected = expectedLibraryFolderNames(plugin, project);
        const expectedList = [...expected];
        for (const libraryRoot of libraryRootsForProject(plugin, project)) {
            const rootAf = plugin.app.vault.getAbstractFileByPath(libraryRoot);
            if (!(rootAf instanceof TFolder)) continue;
            for (const child of [...rootAf.children]) {
                if (!(child instanceof TFolder)) continue;
                if (expected.has(child.name)) continue;
                // Case-only mismatch (Skills vs skills) — keep folder, align mapping.
                const caseMatch = expectedList.find(name => libraryFolderNamesMatch(name, child.name));
                if (caseMatch) {
                    for (const id of getManagedLibraryCategoryIds(plugin)) {
                        const mapped = project.libraryFolders?.[id]?.trim();
                        const resolved = resolveLibraryFolderName(plugin, id, project);
                        if (
                            (mapped && libraryFolderNamesMatch(mapped, child.name))
                            || libraryFolderNamesMatch(resolved, child.name)
                        ) {
                            if (!project.libraryFolders) project.libraryFolders = {};
                            if (project.libraryFolders[id] !== child.name) {
                                project.libraryFolders[id] = child.name;
                                changed = true;
                            }
                        }
                    }
                    continue;
                }
                // Folders are the source of truth. After a local move the
                // in-memory category list can briefly fall back to defaults;
                // never dump a live custom folder into Uncategorized.
                if (isLeftoverSeedLibraryFolder(plugin, project, child.name)
                    && isLibraryCategoryFolderEmpty(child)) {
                    await disposeLibrarySubfolder(plugin, libraryRoot, child.name, 'trash');
                    changed = true;
                }
            }
        }

        if (changed) {
            await plugin.sceneManager.saveProjectFrontmatter(project).catch(() => undefined);
        }
        await pruneOrphanNativeLibraryBases(plugin);
        return changed;
    } finally {
        if (!wasSyncing) pluginAny._syncingLibraryFolders = false;
    }
}

/**
 * Full reconcile for the active project: folders → categories → folders/Bases.
 * Call on project open, after category manager save, and from the all-projects pass.
 */
export async function reconcileLibraryCategoriesForActiveProject(
    plugin: SceneCardsPlugin,
    options: { createMissingRegistered?: boolean } = {},
): Promise<boolean> {
    if (!plugin.sceneManager.activeProject) return false;
    const adopted = await adoptLibraryCategoriesFromFolders(plugin);
    const removed = options.createMissingRegistered
        ? false
        : await pruneLibraryCategoriesMissingFolders(plugin);
    const foldersChanged = await syncLibraryFoldersWithCategories(plugin);
    try {
        await migrateNativeLibraryBasesForActiveProject(plugin);
    } catch (error) {
        console.warn('[NarrativeLab] Library Base reconcile migration skipped:', error);
    }
    return adopted || removed || foldersChanged;
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

    // Localized built-in labels are display aliases, not an instruction to
    // rename stable English vault folders. A user-edited non-seed name still
    // performs the normal folder rename.
    const seededFolder = DEFAULT_LIBRARY_FOLDER_NAMES[categoryId];
    const newName = seededFolder && isSeedLibraryCategoryLabel(categoryId, rawNewName)
        ? seededFolder
        : sanitizeLibraryFolderName(rawNewName);
    if (!newName) {
        new Notice(t('Invalid folder name'));
        return false;
    }

    const oldName = resolveLibraryFolderName(plugin, categoryId, project);
    if (oldName === newName) return false;

    const pluginAny = plugin as SceneCardsPlugin & { _syncingLibraryFolders?: boolean };
    const settingsSnapshot = JSON.stringify(plugin.settings);
    const projectFoldersSnapshot = project.libraryFolders ? { ...project.libraryFolders } : undefined;
    const renamedFolders: Array<{ from: string; to: string }> = [];
    const createdFolders: string[] = [];
    pluginAny._syncingLibraryFolders = true;
    try {
        const libraryRoots = libraryRootsForProject(plugin, project);
        const states = libraryRoots.map(lib => {
            const oldPath = normalizePath(`${lib}/${oldName}`);
            const newPath = normalizePath(`${lib}/${newName}`);
            const kindOf = (path: string): VaultPathKind => {
                const value = plugin.app.vault.getAbstractFileByPath(path);
                if (!value) return 'missing';
                return value instanceof TFolder ? 'folder' : 'other';
            };
            return {
                root: lib,
                oldPath,
                newPath,
                rootKind: kindOf(lib),
                oldKind: kindOf(oldPath),
                newKind: kindOf(newPath),
            };
        });
        const plan = planLibraryFolderRename(states);
        if (!plan.ok) {
            if (plan.reason === 'missing-root') throw new Error(t('Library folder not found: {path}', { path: plan.path }));
            if (plan.reason === 'source-not-folder') throw new Error(t('Library folder not found: {path}', { path: plan.path }));
            throw new Error(t('A folder with this name already exists'));
        }
        for (const operation of plan.operations) {
            if (operation.action === 'create') {
                await ensureVaultFolder(plugin.app, operation.newPath);
                createdFolders.push(operation.newPath);
                continue;
            }
            const folder = plugin.app.vault.getAbstractFileByPath(operation.oldPath);
            if (!(folder instanceof TFolder)) throw new Error(t('Library folder not found: {path}', { path: operation.oldPath }));
            await plugin.app.fileManager.renameFile(folder, operation.newPath);
            renamedFolders.push({ from: operation.oldPath, to: operation.newPath });
        }

        if (!project.libraryFolders) project.libraryFolders = {};
        project.libraryFolders[categoryId] = newName;
        applyLibraryFolderPaths(project, plugin);

        // Keep the active project's custom label in sync with the folder name.
        setLibraryCategoryDisplayMetadata(plugin, categoryId, newName);
        await plugin.saveSettings();

        await plugin.sceneManager.saveProjectFrontmatter(project);
        applyCategoryFolderLabels(plugin);
        await renameNativeLibraryBase(plugin, categoryId, oldName);
        await syncNativeLibraryBase(plugin, categoryId);
        // Drop alias Bases named after the old folder label (e.g. library-技能.base)
        await pruneOrphanNativeLibraryBases(plugin);
        return true;
    } catch (error) {
        for (const move of [...renamedFolders].reverse()) {
            const folder = plugin.app.vault.getAbstractFileByPath(move.to);
            if (folder instanceof TFolder && !plugin.app.vault.getAbstractFileByPath(move.from)) {
                await plugin.app.fileManager.renameFile(folder, move.from).catch(rollbackError => {
                    console.error('[NarrativeLab] Failed to roll back Library folder rename:', rollbackError);
                });
            }
        }
        for (const path of [...createdFolders].reverse()) {
            const folder = plugin.app.vault.getAbstractFileByPath(path);
            if (folder instanceof TFolder && folder.children.length === 0) {
                await plugin.app.fileManager.trashFile(folder).catch(() => undefined);
            }
        }
        plugin.settings = JSON.parse(settingsSnapshot);
        project.libraryFolders = projectFoldersSnapshot ? { ...projectFoldersSnapshot } : undefined;
        applyLibraryFolderPaths(project, plugin);
        await plugin.saveSettings().catch(() => undefined);
        await plugin.sceneManager.saveProjectFrontmatter(project).catch(() => undefined);
        await syncNativeLibraryBase(plugin, categoryId).catch(() => undefined);
        console.error('[NarrativeLab] Failed to rename Library category:', error);
        new Notice(t('Failed to rename Library category: {message}', {
            message: error instanceof Error ? error.message : String(error),
        }));
        return false;
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

    const folderNames = new Set<string>();
    const primaryName = resolveLibraryFolderName(plugin, categoryId, project);
    if (primaryName) folderNames.add(primaryName);
    const mapped = project.libraryFolders?.[categoryId]?.trim();
    if (mapped) folderNames.add(mapped);
    const custom = plugin.settings.codexCustomCategories?.find(c => c.id === categoryId);
    const customLabel = sanitizeLibraryFolderName(custom?.label || '');
    if (customLabel) folderNames.add(customLabel);
    const english = DEFAULT_LIBRARY_FOLDER_NAMES[categoryId];
    if (english) folderNames.add(english);

    const libraryRoots = libraryRootsForProject(plugin, project);
    const pluginAny = plugin as SceneCardsPlugin & { _syncingLibraryFolders?: boolean };
    const settingsSnapshot = JSON.stringify(plugin.settings);
    const projectFoldersSnapshot = project.libraryFolders ? { ...project.libraryFolders } : undefined;
    const stagedFolders: Array<{ originalPath: string; stagedPath: string }> = [];
    let stagingRoot: string | null = null;
    let stagingFolder: TFolder | null = null;
    pluginAny._syncingLibraryFolders = true;

    try {
        // Also catch leftover rename aliases (e.g. 技能 after label became Skills).
        for (const libraryRoot of libraryRoots) {
            const rootAf = plugin.app.vault.getAbstractFileByPath(libraryRoot);
            if (!(rootAf instanceof TFolder)) continue;
            for (const child of rootAf.children) {
                if (!(child instanceof TFolder)) continue;
                if (slugLibraryCategoryId(child.name) === categoryId) {
                    folderNames.add(child.name);
                }
            }
        }

        if (mode === 'trash') {
            const targets = new Map<string, TFolder>();
            for (const libraryRoot of libraryRoots) {
                for (const folderName of folderNames) {
                    const path = normalizePath(`${libraryRoot}/${folderName}`);
                    const folder = plugin.app.vault.getAbstractFileByPath(path);
                    if (folder instanceof TFolder) targets.set(path, folder);
                }
            }
            if (targets.size > 0) {
                const systemFolder = normalizePath(plugin.getProjectSystemFolder());
                if (!plugin.app.vault.getAbstractFileByPath(systemFolder)) {
                    await ensureVaultFolder(plugin.app, systemFolder);
                }
                const stamp = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
                // Dot-prefixed folders are deliberately omitted from Obsidian's
                // Vault index. Keep this temporary folder indexed so trash and
                // rollback can use FileManager instead of unsafe adapter removal.
                stagingRoot = normalizePath(`${systemFolder}/_NarrativeLab-delete-${stamp}`);
                if (plugin.sceneManager.isDeletedProjectPath(stagingRoot)) {
                    throw new Error(t('Library folder not found: {path}', { path: systemFolder }));
                }
                stagingFolder = await plugin.app.vault.createFolder(stagingRoot);
                let index = 0;
                for (const [originalPath, folder] of targets) {
                    const stagedPath = normalizePath(`${stagingRoot}/${index}-${folder.name}`);
                    await plugin.app.fileManager.renameFile(folder, stagedPath);
                    stagedFolders.push({ originalPath, stagedPath });
                    index += 1;
                }
            }
        }

        // Remove the generated/linked Base first. If that fails, leave the
        // category folder and its entries untouched; the Base is recoverable
        // from trash and can also be regenerated from the category mapping.
        await removeNativeLibraryBase(plugin, categoryId);

        if (mode === 'move-to-root') {
            for (const libraryRoot of libraryRoots) {
                for (const folderName of folderNames) {
                    await disposeLibrarySubfolder(plugin, libraryRoot, folderName, mode);
                }
            }
        }

        removeLibraryCategoryState(plugin, project, categoryId);

        await plugin.saveSettings();
        await plugin.sceneManager.saveProjectFrontmatter(project);
        await syncLibraryFoldersWithCategories(plugin);
        await plugin.reloadEntities();
        if (stagingRoot) {
            const staged = plugin.app.vault.getAbstractFileByPath(stagingRoot) ?? stagingFolder;
            if (!(staged instanceof TFolder)) throw new Error(t('Staged Library assets could not be found.'));
            await plugin.app.fileManager.trashFile(staged);
            stagingRoot = null;
            stagingFolder = null;
            stagedFolders.length = 0;
        }
        new Notice(t('Library category deleted'));
        return true;
    } catch (error) {
        for (const move of [...stagedFolders].reverse()) {
            const folder = plugin.app.vault.getAbstractFileByPath(move.stagedPath);
            if (folder instanceof TFolder && !plugin.app.vault.getAbstractFileByPath(move.originalPath)) {
                await plugin.app.fileManager.renameFile(folder, move.originalPath).catch(rollbackError => {
                    console.error('[NarrativeLab] Failed to restore staged Library assets:', rollbackError);
                });
            }
        }
        if (stagingRoot) {
            const folder = plugin.app.vault.getAbstractFileByPath(stagingRoot) ?? stagingFolder;
            if (folder instanceof TFolder && folder.children.length === 0) {
                await plugin.app.fileManager.trashFile(folder).catch(() => undefined);
            }
        }
        plugin.settings = JSON.parse(settingsSnapshot);
        project.libraryFolders = projectFoldersSnapshot ? { ...projectFoldersSnapshot } : undefined;
        applyLibraryFolderPaths(project, plugin);
        await plugin.saveSettings().catch(() => undefined);
        await plugin.sceneManager.saveProjectFrontmatter(project).catch(() => undefined);
        await syncNativeLibraryBase(plugin, categoryId).catch(() => undefined);
        console.error('[NarrativeLab] Failed to delete Library category:', error);
        new Notice(t('Failed to delete Library category: {message}', {
            message: error instanceof Error ? error.message : String(error),
        }));
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

    setLibraryCategoryDisplayMetadata(plugin, categoryId, newName);
    await plugin.saveSettings();

    await plugin.sceneManager.saveProjectFrontmatter(project);
    applyCategoryFolderLabels(plugin);
    await syncNativeLibraryBase(plugin, categoryId);
    return true;
}

export function findCategoryIdForFolderName(
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
        if (libraryFolderNamesMatch(resolveLibraryFolderName(plugin, id, project), folderName)) return id;
    }
    // Also match defaults / builtin folder even if not currently enabled
    for (const [id, defName] of Object.entries(DEFAULT_LIBRARY_FOLDER_NAMES)) {
        if (libraryFolderNamesMatch(defName, folderName)) return id;
    }
    for (const cc of plugin.settings.codexCustomCategories || []) {
        if (libraryFolderNamesMatch(cc.label, folderName)) return cc.id;
    }
    return null;
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
        hasProfilePage?: boolean;
        preset?: boolean;
    }>;
    categoryOrder: string[];
    hiddenFixedCategories: string[];
    deletedPresetCategories: string[];
    presetSeedVersion?: number;
};

const FIXED_LIBRARY_FOLDER_IDS = new Set(['characters', 'locations']);

export function emptyLibraryCategorySettings(): LibraryCategorySettingsPayload {
    return {
        enabledCategories: [],
        customCategories: [],
        categoryOrder: [],
        hiddenFixedCategories: [],
        deletedPresetCategories: [],
        presetSeedVersion: 0,
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
        presetSeedVersion: settings.codexPresetSeedVersion || 0,
    };
}

export function applyLibraryCategorySettings(
    plugin: SceneCardsPlugin,
    payload: LibraryCategorySettingsPayload,
): void {
    plugin.settings.codexEnabledCategories = [...(payload.enabledCategories || [])];
    plugin.settings.codexCustomCategories = (payload.customCategories || []).map(category => ({
        ...category,
        hasProfilePage: true,
        showInSidebar: true,
    }));
    plugin.settings.libraryCategoryOrder = [...(payload.categoryOrder || [])];
    plugin.settings.libraryHiddenFixedCategories = [...(payload.hiddenFixedCategories || [])];
    plugin.settings.codexDeletedPresetCategories = [...(payload.deletedPresetCategories || [])];
    plugin.settings.codexPresetSeedVersion = payload.presetSeedVersion || 0;
}

function parseLibraryCategorySettings(raw: Record<string, unknown>): LibraryCategorySettingsPayload | null {
    if (!raw || typeof raw !== 'object') return null;
    const hasAny = 'enabledCategories' in raw
        || 'customCategories' in raw
        || 'categoryOrder' in raw
        || 'hiddenFixedCategories' in raw
        || 'deletedPresetCategories' in raw
        || 'presetSeedVersion' in raw;
    if (!hasAny) return null;

    const customRaw = Array.isArray(raw.customCategories) ? raw.customCategories : [];
    const customCategories = customRaw
        .filter((item): item is Record<string, unknown> => !!item && typeof item === 'object')
        .map(item => ({
            id: coerceString(item.id).trim(),
            label: coerceString(item.label).trim(),
            icon: coerceString(item.icon, 'file-text').trim() || 'file-text',
            showInSidebar: true,
            hasProfilePage: true,
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
        presetSeedVersion: Number.isFinite(Number(raw.presetSeedVersion))
            ? Math.max(0, Math.floor(Number(raw.presetSeedVersion)))
            : 0,
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
        if (
            builtin.folder === normalized
            || builtin.id === normalized.toLowerCase()
            || builtin.label === normalized
        ) {
            return {
                id: builtin.id,
                label: builtin.label,
                icon: builtin.icon,
                builtin: true,
            };
        }
    }

    // Localized seed labels (e.g. 生物 → creatures) still map to builtins.
    for (const builtin of BUILTIN_CODEX_CATEGORIES) {
        if (
            isSeedLibraryCategoryLabel(builtin.id, normalized)
            || localizeForLanguage('zh', builtin.folder) === normalized
            || localizeForLanguage('en', builtin.folder) === normalized
        ) {
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
 * Library subfolders discover which categories exist. Brand-new folders become
 * enabled tabs; already-registered categories keep the user's hide/show choice.
 * Fixed Characters/Locations are skipped here.
 */
export async function adoptLibraryCategoriesFromFolders(
    plugin: SceneCardsPlugin,
    _options: { enableExisting?: boolean } = {},
): Promise<boolean> {
    const project = plugin.sceneManager.activeProject;
    if (!project) return false;

    let changed = false;
    const enabled = new Set(plugin.settings.codexEnabledCategories || []);
    const order = [...(plugin.settings.libraryCategoryOrder || [])];
    const deleted = new Set(plugin.settings.codexDeletedPresetCategories || []);
    if (!plugin.settings.codexCustomCategories) plugin.settings.codexCustomCategories = [];
    if (!project.libraryFolders) project.libraryFolders = {};

    // Recover fixed-folder renames that happened while Obsidian was closed.
    // Localized seed names are unambiguous; arbitrary unknown folders remain
    // custom categories because their intended fixed-category target is unknowable.
    let diskSnapshot = await readLibraryFolderNames(plugin, project);
    if (diskSnapshot.scannedRoots > 0) {
        for (const id of FIXED_LIBRARY_FOLDER_IDS) {
            const current = resolveLibraryFolderName(plugin, id, project);
            if (diskSnapshot.names.has(current)) continue;
            const defaultName = DEFAULT_LIBRARY_FOLDER_NAMES[id];
            const localizedCandidates = new Set([
                localizeForLanguage('zh', defaultName),
                localizeForLanguage('en', defaultName),
            ]);
            const replacement = [...localizedCandidates].find(name =>
                name !== current && diskSnapshot.names.has(name));
            if (!replacement) continue;
            project.libraryFolders[id] = replacement;
            setLibraryCategoryDisplayMetadata(plugin, id, replacement);
            changed = true;
        }
    }

    if (await restoreCanonicalSeedFolders(plugin, project)) {
        changed = true;
        diskSnapshot = await readLibraryFolderNames(plugin, project);
    }

    if (project.libraryFolders) {
        const repairs = collectStaleNumberedCategoryRepairs(
            project.libraryFolders,
            diskSnapshot.occupied,
        );
        for (const repair of repairs) {
            if (repair.action === 'retarget') {
                const canonical = DEFAULT_LIBRARY_FOLDER_NAMES[repair.parentId];
                project.libraryFolders[repair.parentId] =
                    canonical && isSingularPluralFolderAlias(repair.liveFolder, canonical)
                        ? canonical
                        : repair.liveFolder;
            }
            removeLibraryCategoryState(plugin, project, repair.cloneId);
            enabled.delete(repair.cloneId);
            const orderIndex = order.indexOf(repair.cloneId);
            if (orderIndex >= 0) order.splice(orderIndex, 1);
            if (repair.abandonedFolder && !diskSnapshot.occupied.has(repair.abandonedFolder)) {
                await trashEmptyLibraryFolder(plugin, project, repair.abandonedFolder);
            }
            changed = true;
        }
    }

    const ensureRegistered = (id: string, label: string, icon: string, builtin: boolean, folderName: string) => {
        // Deleted presets stay deleted even if their Library folder is still on disk.
        if (deleted.has(id)) return;

        const alreadyRegistered = plugin.settings.codexCustomCategories.some(category => category.id === id)
            || !!project.libraryFolders?.[id];
        const enableTab = shouldEnableAdoptedLibraryCategory({
            alreadyEnabled: enabled.has(id),
            alreadyRegistered,
            deleted: false,
        });

        if (enableTab && !enabled.has(id)) {
            enabled.add(id);
            changed = true;
        }
        if (!builtin && !plugin.settings.codexCustomCategories.some(category => category.id === id)) {
            plugin.settings.codexCustomCategories.push({
                id,
                label,
                icon,
                hasProfilePage: true,
                showInSidebar: true,
            });
            changed = true;
        }
        // Keep builtin display metadata in customCategories for renames/icons.
        if (builtin && !plugin.settings.codexCustomCategories.some(category => category.id === id)) {
            plugin.settings.codexCustomCategories.push({
                id,
                label,
                icon,
                preset: true,
                hasProfilePage: true,
                showInSidebar: true,
            });
            changed = true;
        }
        if (enableTab && !order.includes(id)) {
            order.push(id);
            changed = true;
        }
        if (project.libraryFolders![id] !== folderName) {
            project.libraryFolders![id] = folderName;
            changed = true;
        }
    };

    // A series project reads from the shared series Library while retaining a
    // project-local Library for book-only assets. Scan both so a folder created
    // in Finder/Explorer is adopted regardless of which Library owns it.
    for (const libraryRoot of libraryRootsForProject(plugin, project)) {
        let folderPaths: string[] = [];
        try {
            if (!await plugin.app.vault.adapter.exists(libraryRoot)) continue;
            folderPaths = (await plugin.app.vault.adapter.list(libraryRoot)).folders;
        } catch (error) {
            console.warn('[NarrativeLab] Failed to scan Library categories:', libraryRoot, error);
            continue;
        }
        for (const folderPath of folderPaths) {
            let folderName = basenameOfPath(folderPath);
            let resolved = resolveCategoryIdForLibraryFolder(plugin, project, folderName);
            if (!resolved) continue;
            const canonical = DEFAULT_LIBRARY_FOLDER_NAMES[resolved.id];
            if (canonical && isSingularPluralFolderAlias(folderName, canonical)) {
                folderName = canonical;
            }
            const mappedFolder = project.libraryFolders?.[resolved.id]?.trim();
            if (mappedFolder && mappedFolder !== folderName
                && shouldAllocateNewCategoryForFolder({
                    mappedFolder,
                    discoveredFolder: folderName,
                    liveFolders: diskSnapshot.occupied,
                })) {
                const usedIds = new Set<string>([
                    ...Object.keys(project.libraryFolders || {}),
                    ...(plugin.settings.codexEnabledCategories || []),
                    ...(plugin.settings.codexCustomCategories || []).map(category => category.id),
                ]);
                resolved = {
                    id: allocateLibraryCategoryId(resolved.id, usedIds),
                    label: folderName,
                    icon: 'file-text',
                    builtin: false,
                };
            }
            ensureRegistered(
                resolved.id,
                resolved.label,
                resolved.icon,
                resolved.builtin,
                folderName,
            );
        }
    }

    if (changed) {
        plugin.settings.codexEnabledCategories = Array.from(enabled);
        plugin.settings.libraryCategoryOrder = order;
        plugin.settings.codexDeletedPresetCategories = Array.from(deleted);
    }
    return changed;
}
/* eslint-enable @typescript-eslint/no-unsafe-assignment -- end of file-wide suppression block opened at line 1 */
