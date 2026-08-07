import {
    Component,
    MarkdownRenderChild,
    MarkdownRenderer,
    TFile,
    normalizePath,
    parseYaml,
    stringifyYaml,
} from 'obsidian';
import type SceneCardsPlugin from '../main';

export const ALL_LIBRARY_CATEGORY_ID = '__all-library__';

interface NativeBaseEmbedState {
    child: MarkdownRenderChild | null;
    generation: number;
}

const activeEmbeds = new WeakMap<Component, NativeBaseEmbedState>();
const ensureLocks = new Map<string, Promise<{ basePath: string; folderPath: string } | null>>();
const migrationLocks = new Map<string, Promise<void>>();

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

function getNativeBasePath(plugin: SceneCardsPlugin, categoryId: string): string | null {
    if (!plugin.sceneManager.activeProject) return null;
    const key = sanitizeBaseStorageKey(categoryId);
    return normalizePath(`${plugin.getProjectSystemFolder()}/Bases/library-${key}.base`);
}

function getLegacyNativeBasePaths(plugin: SceneCardsPlugin, categoryId: string): string[] {
    const folderPath = getCategoryFolder(plugin, categoryId);
    if (!folderPath) return [];
    const fileNames = categoryId === ALL_LIBRARY_CATEGORY_ID
        ? ['_NarrativeLab-All.base']
        : ['_NarrativeLab.base', '.narrative-lab.base'];
    return fileNames.map(fileName => normalizePath(`${folderPath}/${fileName}`));
}

function getLegacyNativeBasePath(plugin: SceneCardsPlugin, categoryId: string): string | null {
    const paths = getLegacyNativeBasePaths(plugin, categoryId);
    return paths[0] ?? null;
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

async function migrateLegacyNativeBasesUnlocked(plugin: SceneCardsPlugin): Promise<void> {
    await ensureVaultFolder(plugin, normalizePath(`${plugin.getProjectSystemFolder()}/Bases`));

    for (const categoryId of getKnownLibraryCategoryIds(plugin)) {
        const legacyPaths = getLegacyNativeBasePaths(plugin, categoryId);
        const destinationPath = getNativeBasePath(plugin, categoryId);
        if (!destinationPath) continue;

        for (const legacyPath of legacyPaths) {
            if (legacyPath === destinationPath) continue;
            const legacyFile = plugin.app.vault.getAbstractFileByPath(legacyPath);
            if (!(legacyFile instanceof TFile)) continue;

            const destination = plugin.app.vault.getAbstractFileByPath(destinationPath);
            if (destination instanceof TFile) {
                await plugin.app.fileManager.trashFile(legacyFile);
            } else {
                await plugin.app.fileManager.renameFile(legacyFile, destinationPath);
                break;
            }
        }
    }
}

async function migrateLegacyNativeBases(plugin: SceneCardsPlugin): Promise<void> {
    if (!plugin.sceneManager.activeProject) return;
    const lockKey = normalizePath(plugin.getProjectSystemFolder());
    const existing = migrationLocks.get(lockKey);
    if (existing) return existing;
    const pending = migrateLegacyNativeBasesUnlocked(plugin)
        .catch(error => {
            console.error('[NarrativeLab] Failed to migrate Library Base files:', error);
        })
        .finally(() => migrationLocks.delete(lockKey));
    migrationLocks.set(lockKey, pending);
    return pending;
}

export async function migrateNativeLibraryBasesForActiveProject(
    plugin: SceneCardsPlugin,
): Promise<void> {
    await migrateLegacyNativeBases(plugin);
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

    await migrateLegacyNativeBases(plugin);
    const basePath = getNativeBasePath(plugin, categoryId);
    if (!basePath) return null;
    const recursive = categoryId !== 'uncategorized';
    const scopeFilter = recursive
        ? `file.inFolder(${JSON.stringify(folderPath)})`
        : `file.folder == ${JSON.stringify(folderPath)}`;
    const requiredFilters = [scopeFilter, 'file.ext == "md"'];
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
        config.filters = { and: requiredFilters };
        if (Array.isArray(config.views)) {
            for (const view of config.views) {
                if (!view || typeof view !== 'object') continue;
                const viewConfig = view as Record<string, unknown>;
                if (viewConfig.type === 'narrative-lab-cards') {
                    viewConfig.type = 'table';
                    if (viewConfig.name === 'NarrativeLab Cards') viewConfig.name = 'Table';
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
        }
        const next = stringifyYaml(config);
        if (next.trim() !== source.trim()) {
            await plugin.app.vault.modify(existing, next);
        }
        return { basePath, folderPath };
    }

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
