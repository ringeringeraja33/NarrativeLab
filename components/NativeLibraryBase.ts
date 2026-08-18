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
    DEFAULT_BASES_FOLDER,
    LEGACY_SYSTEM_BASES_FOLDER,
    LEGACY_SYSTEM_LIBRARY_BASE,
    LIBRARY_BASE_PREFIX,
    LIBRARY_BASE_LEGACY_FILENAME,
    LIBRARY_BASE_FORMAT,
    deriveProjectFoldersFromFilePath,
} from '../models/StoryLineProject';
import type SceneCardsPlugin from '../main';
import { isExcalidrawFilePath } from '../services/EntityFileCache';
import {
    buildLibraryPathScopeFilter,
    collectReferencedLibraryCategoryIds,
    guardLibraryBaseFileFilter,
    type LibraryBaseFilter,
} from '../utils/libraryCategoryTransactions';

export const ALL_LIBRARY_CATEGORY_ID = '__all-library__';
const VIEW_CATEGORY_KEY = 'narrativeLabCategoryId';

interface NativeBaseEmbedState {
    child: MarkdownRenderChild | null;
    generation: number;
    plugin?: SceneCardsPlugin;
    categoryId?: string;
    basePath?: string;
    liveView?: BasesViewLike | null;
    unhook?: (() => void) | null;
    newNoteUnhook?: (() => void) | null;
    horizontalScrollUnhook?: (() => void) | null;
    persistTimer?: number | null;
    /** Last time this embed produced a layout snapshot (ms). Newer wins on merge. */
    lastLayoutAt?: number;
}

interface ViewLayoutSnapshot {
    order: string[];
    sort: Array<{ property: string; direction: 'ASC' | 'DESC' }>;
    columnSize: Record<string, number> | null;
    groupBy: unknown;
}

interface BasesViewLike {
    config: {
        getOrder?: () => unknown;
        getSort?: () => unknown;
        get?: (key: string) => unknown;
        set?: (key: string, value: unknown) => void;
    };
}

const activeEmbeds = new WeakMap<Component, NativeBaseEmbedState>();
/** Live embeds keyed by base path — used to flush layout before NarrativeLab rewrites YAML. */
const liveEmbedsByBase = new Map<string, Set<NativeBaseEmbedState>>();
const ensureLocks = new Map<string, Promise<{ basePath: string; folderPath: string } | null>>();
const persistLocks = new Map<string, Promise<void>>();
const migrationLocks = new Map<string, Promise<void>>();
/** Projects whose Library Base migration already completed this session. */
const migratedLibraryBasePaths = new Set<string>();
/** Projects whose Base filters were synced this session. */
const FILTER_STYLE_VERSION = 'single-library-base-v5-null-file-guard';
const syncedFilterStyleKeys = new Set<string>();

type BaseViewConfig = Record<string, unknown> & {
    type?: string;
    name?: string;
    filters?: unknown;
    order?: unknown;
    sort?: unknown;
    columnSize?: unknown;
    groupBy?: unknown;
    narrativeLabCategoryId?: string;
};

/** Keep the visible category name readable in the Bases view tabs. */
function sanitizeBaseDisplayKey(label: string): string {
    return label
        .trim()
        .replace(/[\\/:*?"<>|#[\]^]/g, '-')
        .replace(/\s+/g, ' ')
        .replace(/-+/g, '-')
        .replace(/^-+|-+$/g, '')
        || 'category';
}

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

/** Match the Base view tab label to the current Library tab label. */
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
    if (mapped) return mapped;
    if (custom?.label?.trim()) return custom.label.trim();

    const folder = getCategoryFolder(plugin, categoryId)?.split('/').pop()?.trim();
    return folder || defaults[categoryId] || categoryId;
}

function getProjectBaseFolder(plugin: SceneCardsPlugin): string | null {
    const project = plugin.sceneManager.activeProject;
    if (!project) return null;
    return normalizePath(deriveProjectFoldersFromFilePath(project.filePath).baseFolder);
}

function sanitizeProjectArtifactName(name: string): string {
    const cleaned = name
        .replace(/[\\/:*?"<>|]/g, '-')
        .replace(/\s+/g, ' ')
        .trim();
    return cleaned || 'project';
}

function projectLeafNameFromProjectFilePath(projectFilePath: string): string {
    return sanitizeProjectArtifactName(projectFilePath.split('/').pop()?.replace(/\.md$/i, '') ?? '');
}

/** Canonical single Library Base: `{Library}/library-<projectName>.base`. */
function getLibraryBasePath(plugin: SceneCardsPlugin): string | null {
    const libraryRoot = plugin.sceneManager.getCodexFolder?.()
        || (() => {
            const baseFolder = getProjectBaseFolder(plugin);
            return baseFolder ? `${baseFolder}/Library` : null;
        })();
    if (!libraryRoot) return null;
    const leaf = projectLeafNameFromProjectFilePath(plugin.sceneManager.activeProject?.filePath ?? '');
    return normalizePath(`${libraryRoot}/${LIBRARY_BASE_PREFIX}-${leaf}.base`);
}

/** Legacy pre-rename Library Base: `{libraryRoot}/library.base` (series or project-wide). */
function getLegacyLibraryBasePath(plugin: SceneCardsPlugin): string | null {
    const libraryRoot = plugin.sceneManager.getCodexFolder?.()
        || (() => {
            const baseFolder = getProjectBaseFolder(plugin);
            return baseFolder ? `${baseFolder}/Library` : null;
        })();
    if (!libraryRoot) return null;
    return normalizePath(`${libraryRoot}/${LIBRARY_BASE_LEGACY_FILENAME}`);
}

/** Former System/library.base path for the active project. */
function getLegacySystemLibraryBasePath(plugin: SceneCardsPlugin): string | null {
    const baseFolder = getProjectBaseFolder(plugin);
    if (!baseFolder) return null;
    return normalizePath(`${baseFolder}/${LEGACY_SYSTEM_LIBRARY_BASE}`);
}

/** Legacy multi-file Bases roots still scanned for migration. */
function getLegacyBasesScanFolders(plugin: SceneCardsPlugin): string[] {
    const baseFolder = getProjectBaseFolder(plugin);
    if (!baseFolder) return [];
    return [
        normalizePath(`${baseFolder}/${DEFAULT_BASES_FOLDER}`),
        normalizePath(`${baseFolder}/${LEGACY_SYSTEM_BASES_FOLDER}`),
    ];
}

/**
 * Storage keys that may have been used for a category's legacy Base file.
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

function getLegacyNativeBasePaths(plugin: SceneCardsPlugin, categoryId: string): string[] {
    const paths: string[] = [];
    for (const folder of getLegacyBasesScanFolders(plugin)) {
        for (const key of collectAliasBaseKeys(plugin, categoryId)) {
            paths.push(normalizePath(`${folder}/library-${key}.base`));
        }
    }
    const folderPath = getCategoryFolder(plugin, categoryId);
    if (folderPath) {
        const fileNames = categoryId === ALL_LIBRARY_CATEGORY_ID
            ? ['_NarrativeLab-All.base']
            : ['_NarrativeLab.base', '.narrative-lab.base'];
        for (const fileName of fileNames) {
            paths.push(normalizePath(`${folderPath}/${fileName}`));
        }
    }
    return paths;
}

async function trashBasePath(plugin: SceneCardsPlugin, path: string | null): Promise<void> {
    if (!path) return;
    const normalized = normalizePath(path);
    try {
        // OneDrive / race: vault index can still list a file after the disk path is gone.
        if (!(await pathExists(plugin, normalized))) return;
        const file = plugin.app.vault.getAbstractFileByPath(normalized);
        if (file instanceof TFile) {
            await plugin.app.fileManager.trashFile(file);
            return;
        }
        await plugin.app.vault.adapter.remove(normalized).catch(() => undefined);
    } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        if (/ENOENT|no such file|does not exist/i.test(message)) return;
        console.warn('[NarrativeLab] Could not trash Library Base file:', normalized, error);
    }
}

async function ensureVaultFolder(plugin: SceneCardsPlugin, folderPath: string): Promise<void> {
    if (plugin.sceneManager.isDeletedProjectPath(folderPath)) return;
    const parts = normalizePath(folderPath).split('/').filter(Boolean);
    let current = '';
    for (const part of parts) {
        current = current ? `${current}/${part}` : part;
        if (plugin.sceneManager.isDeletedProjectPath(current)) return;
        if (!plugin.app.vault.getAbstractFileByPath(current)) {
            await plugin.app.vault.createFolder(current);
        }
    }
}

function isNativeBasesNewButton(target: EventTarget | null): boolean {
    if (!(target instanceof HTMLElement)) return false;
    const control = target.closest<HTMLElement>('button, [role="button"]');
    if (!control || !control.closest('.bases-toolbar, .bases-toolbar-container')) return false;
    const labels = [
        control.textContent,
        control.getAttribute('aria-label'),
        control.getAttribute('title'),
    ];
    return labels.some(label => {
        const normalized = (label || '').replace(/^\s*\+\s*/, '').trim().toLocaleLowerCase();
        return normalized === 'new' || normalized === '新建' || normalized === t('New').trim().toLocaleLowerCase();
    });
}

async function availableNotePath(
    plugin: SceneCardsPlugin,
    targetFolder: string,
    file: TFile,
): Promise<string> {
    const extension = file.extension ? `.${file.extension}` : '';
    const stem = file.basename || t('Untitled');
    let suffix = 0;
    while (true) {
        const name = suffix === 0 ? `${stem}${extension}` : `${stem} ${suffix}${extension}`;
        const candidate = normalizePath(`${targetFolder}/${name}`);
        if (!(await pathExists(plugin, candidate))) return candidate;
        suffix += 1;
    }
}

/**
 * Keep the native Bases New control and editor, but route the note it creates
 * into the active Library category instead of Obsidian's global new-note path.
 */
function routeNativeBaseNewNotes(
    host: HTMLElement,
    plugin: SceneCardsPlugin,
    targetFolder: string,
): () => void {
    let armedCreateRef: ReturnType<typeof plugin.app.vault.on> | null = null;
    let disarmTimer: number | null = null;

    const disarm = () => {
        if (armedCreateRef) {
            plugin.app.vault.offref(armedCreateRef);
            armedCreateRef = null;
        }
        if (disarmTimer != null) {
            window.clearTimeout(disarmTimer);
            disarmTimer = null;
        }
    };

    const arm = () => {
        disarm();
        armedCreateRef = plugin.app.vault.on('create', file => {
            if (!(file instanceof TFile) || file.extension.toLocaleLowerCase() !== 'md') return;
            disarm();
            void (async () => {
                const destinationFolder = normalizePath(targetFolder);
                if (normalizePath(file.parent?.path || '') === destinationFolder) return;
                await ensureVaultFolder(plugin, destinationFolder);
                const destination = await availableNotePath(plugin, destinationFolder, file);
                await plugin.app.fileManager.renameFile(file, destination);
            })().catch(error => {
                console.error('[NarrativeLab] Failed to route new Library note:', error);
            });
        });
        disarmTimer = window.setTimeout(disarm, 5000);
    };

    const onTrigger = (event: MouseEvent | PointerEvent) => {
        if (isNativeBasesNewButton(event.target)) arm();
    };
    // Pointer-down covers Obsidian builds that create before the click event;
    // click also covers keyboard activation.
    host.addEventListener('pointerdown', onTrigger, true);
    host.addEventListener('click', onTrigger, true);
    return () => {
        host.removeEventListener('pointerdown', onTrigger, true);
        host.removeEventListener('click', onTrigger, true);
        disarm();
    };
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

/** Shared-series and project-local folders represented by one Library view. */
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
    if (categoryId === ALL_LIBRARY_CATEGORY_ID) {
        // All view uses global Library-root filters only.
        return [];
    }
    if (categoryId === 'uncategorized') {
        const filters: LibraryBaseFilter[] = [];
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
            filters.push(guardLibraryBaseFileFilter(`!file.inFolder(${JSON.stringify(sub)})`));
        }
        return filters;
    }
    return [
        buildLibraryPathScopeFilter(folderPaths),
    ];
}

function buildGlobalLibraryFilters(plugin: SceneCardsPlugin): LibraryBaseFilter[] {
    const roots = getCategoryFolders(plugin, ALL_LIBRARY_CATEGORY_ID);
    return [
        buildLibraryPathScopeFilter(roots),
        guardLibraryBaseFileFilter('file.ext == "md"'),
        guardLibraryBaseFileFilter('file.basename.lower().endsWith(".excalidraw") == false'),
    ];
}

function filtersEqual(a: unknown, b: unknown): boolean {
    return JSON.stringify(a) === JSON.stringify(b);
}

function getViews(config: Record<string, unknown>): BaseViewConfig[] {
    if (!Array.isArray(config.views)) return [];
    return config.views.filter((view): view is BaseViewConfig => !!view && typeof view === 'object');
}

function findViewForCategory(views: BaseViewConfig[], categoryId: string): BaseViewConfig | undefined {
    return views.find(view => String(view[VIEW_CATEGORY_KEY] || '') === categoryId);
}

function viewFiltersMatch(view: BaseViewConfig, required: LibraryBaseFilter[]): boolean {
    if (required.length === 0) {
        return view.filters == null
            || (typeof view.filters === 'object'
                && view.filters !== null
                && Array.isArray((view.filters as { and?: unknown }).and)
                && (view.filters as { and: unknown[] }).and.length === 0);
    }
    const filters = view.filters;
    if (!filters || typeof filters !== 'object') return false;
    const and = (filters as { and?: unknown }).and;
    if (!Array.isArray(and) || and.length !== required.length) return false;
    return required.every((filter, index) => filtersEqual(and[index], filter));
}

function collectNoteProperties(plugin: SceneCardsPlugin, folderPaths: string[], recursive: boolean): string[] {
    const keys = new Set<string>();
    for (const file of plugin.app.vault.getMarkdownFiles()) {
        if (isExcalidrawFilePath(file.path)) continue;
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
    for (const view of getViews(config)) {
        if (Array.isArray(view.order)) view.order.forEach(addPropertyId);
    }
    return [...keys];
}

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

async function readBaseConfig(
    plugin: SceneCardsPlugin,
    basePath: string,
): Promise<Record<string, unknown> | null> {
    const existing = plugin.app.vault.getAbstractFileByPath(basePath);
    if (!(existing instanceof TFile)) {
        if (!(await pathExists(plugin, basePath))) return null;
        try {
            const source = await plugin.app.vault.adapter.read(basePath);
            const parsed: unknown = parseYaml(source) as unknown;
            return parsed && typeof parsed === 'object' ? parsed as Record<string, unknown> : {};
        } catch {
            return null;
        }
    }
    const source = await plugin.app.vault.read(existing);
    try {
        const parsed: unknown = parseYaml(source) as unknown;
        return parsed && typeof parsed === 'object' ? parsed as Record<string, unknown> : {};
    } catch (error) {
        console.error('[NarrativeLab] Invalid Base YAML:', error);
        throw new Error(t('Cannot parse {path}; the file was left unchanged.', { path: basePath }));
    }
}

async function writeBaseConfig(
    plugin: SceneCardsPlugin,
    basePath: string,
    config: Record<string, unknown>,
): Promise<void> {
    // Prefer any live embed layout over a stale in-memory config so ensure*
    // rewrites cannot clobber Properties/Sort changes the user just made.
    applyLiveLayoutsToConfig(basePath, config);
    await ensureVaultFolder(plugin, basePath.split('/').slice(0, -1).join('/'));
    const yaml = stringifyYaml(config);
    const existing = plugin.app.vault.getAbstractFileByPath(basePath);
    if (existing instanceof TFile) {
        await plugin.app.vault.modify(existing, yaml);
        return;
    }
    if (await pathExists(plugin, basePath)) {
        await plugin.app.vault.adapter.write(basePath, yaml);
        return;
    }
    await plugin.app.vault.create(basePath, yaml);
}

function stringArrayEqual(left: unknown, right: string[]): boolean {
    if (!Array.isArray(left) || left.length !== right.length) return false;
    return left.every((item, index) => String(item) === right[index]);
}

function primitiveText(value: unknown): string {
    return typeof value === 'string'
        ? value
        : (typeof value === 'number' || typeof value === 'boolean' ? String(value) : '');
}

function sortConfigsEqual(left: unknown, right: ViewLayoutSnapshot['sort']): boolean {
    if (!Array.isArray(left)) return right.length === 0;
    if (left.length !== right.length) return false;
    return left.every((item, index) => {
        if (!item || typeof item !== 'object') return false;
        const row = item as { property?: unknown; direction?: unknown };
        const expected = right[index];
        return String(row.property) === expected.property
            && (primitiveText(row.direction) || 'ASC').toUpperCase() === expected.direction;
    });
}

function columnSizeEqual(left: unknown, right: Record<string, number> | null): boolean {
    if (!right) return left == null;
    if (!left || typeof left !== 'object' || Array.isArray(left)) return false;
    const leftRecord = left as Record<string, unknown>;
    const leftKeys = Object.keys(leftRecord);
    const rightKeys = Object.keys(right);
    if (leftKeys.length !== rightKeys.length) return false;
    return rightKeys.every(key => Number(leftRecord[key]) === right[key]);
}

function cloneColumnSize(value: unknown): Record<string, number> | null {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
    const out: Record<string, number> = {};
    for (const [key, raw] of Object.entries(value as Record<string, unknown>)) {
        const num = Number(raw);
        if (Number.isFinite(num) && num > 0) out[key] = num;
    }
    return Object.keys(out).length > 0 ? out : null;
}

function cloneGroupBy(value: unknown): unknown {
    if (value == null) return null;
    if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
        return value;
    }
    try {
        return JSON.parse(JSON.stringify(value));
    } catch {
        return null;
    }
}

function groupByEqual(left: unknown, right: unknown): boolean {
    if (left == null && right == null) return true;
    try {
        return JSON.stringify(left ?? null) === JSON.stringify(right ?? null);
    } catch {
        return left === right;
    }
}

function snapshotBasesViewLayout(view: BasesViewLike): ViewLayoutSnapshot {
    const orderRaw = view.config.getOrder?.();
    const sortRaw = view.config.getSort?.();
    const order = Array.isArray(orderRaw)
        ? orderRaw.map(item => String(item)).filter(Boolean)
        : [];
    const sort: ViewLayoutSnapshot['sort'] = [];
    if (Array.isArray(sortRaw)) {
        for (const item of sortRaw) {
            if (!item || typeof item !== 'object') continue;
            const row = item as { property?: unknown; direction?: unknown };
            const property = primitiveText(row.property).trim();
            if (!property) continue;
            const direction = (primitiveText(row.direction) || 'ASC').toUpperCase() === 'DESC' ? 'DESC' : 'ASC';
            sort.push({ property, direction });
        }
    }
    return {
        order,
        sort,
        columnSize: cloneColumnSize(view.config.get?.('columnSize')),
        groupBy: cloneGroupBy(view.config.get?.('groupBy')),
    };
}

function applyLayoutSnapshotToView(view: BaseViewConfig, snapshot: ViewLayoutSnapshot): boolean {
    let dirty = false;
    if (snapshot.order.length > 0 && !stringArrayEqual(view.order, snapshot.order)) {
        view.order = snapshot.order.slice();
        dirty = true;
    }
    if (!sortConfigsEqual(view.sort, snapshot.sort)) {
        if (snapshot.sort.length === 0) {
            if (view.sort !== undefined) {
                delete view.sort;
                dirty = true;
            }
        } else {
            view.sort = snapshot.sort.map(entry => ({
                property: entry.property,
                direction: entry.direction,
            }));
            dirty = true;
        }
    }
    if (!columnSizeEqual(view.columnSize, snapshot.columnSize)) {
        if (!snapshot.columnSize) {
            if (view.columnSize !== undefined) {
                delete view.columnSize;
                dirty = true;
            }
        } else {
            view.columnSize = { ...snapshot.columnSize };
            dirty = true;
        }
    }
    if (!groupByEqual(view.groupBy, snapshot.groupBy)) {
        if (snapshot.groupBy == null) {
            if (view.groupBy !== undefined) {
                delete view.groupBy;
                dirty = true;
            }
        } else {
            view.groupBy = cloneGroupBy(snapshot.groupBy);
            dirty = true;
        }
    }
    return dirty;
}

function applyLiveLayoutsToConfig(basePath: string, config: Record<string, unknown>): boolean {
    const hooks = liveEmbedsByBase.get(basePath);
    if (!hooks || hooks.size === 0) return false;
    const views = getViews(config);
    let dirty = false;
    // Prefer the newest dirty embed per category so a stale second leaf cannot
    // overwrite a layout the user just changed.
    const newestByCategory = new Map<string, { state: NativeBaseEmbedState; at: number }>();
    for (const state of hooks) {
        if (!state.categoryId || !state.liveView) continue;
        const at = state.lastLayoutAt ?? 0;
        const prev = newestByCategory.get(state.categoryId);
        if (!prev || at >= prev.at) {
            newestByCategory.set(state.categoryId, { state, at });
        }
    }
    for (const { state } of newestByCategory.values()) {
        if (!state.categoryId || !state.liveView) continue;
        const view = findViewForCategory(views, state.categoryId);
        if (!view) continue;
        if (applyLayoutSnapshotToView(view, snapshotBasesViewLayout(state.liveView))) {
            dirty = true;
        }
    }
    if (dirty) config.views = views;
    return dirty;
}

function trackLiveEmbed(state: NativeBaseEmbedState): void {
    if (!state.basePath) return;
    let set = liveEmbedsByBase.get(state.basePath);
    if (!set) {
        set = new Set();
        liveEmbedsByBase.set(state.basePath, set);
    }
    set.add(state);
}

function untrackLiveEmbed(state: NativeBaseEmbedState): void {
    if (!state.basePath) return;
    const set = liveEmbedsByBase.get(state.basePath);
    if (!set) return;
    set.delete(state);
    if (set.size === 0) liveEmbedsByBase.delete(state.basePath);
}

function findBasesViewInComponent(component: Component, depth = 0): BasesViewLike | null {
    if (depth > 14) return null;
    const anyComp = component as unknown as {
        config?: BasesViewLike['config'];
        _children?: Component[];
        children?: Component[];
    };
    if (
        anyComp.config
        && typeof anyComp.config.getOrder === 'function'
        && typeof anyComp.config.getSort === 'function'
    ) {
        return anyComp as unknown as BasesViewLike;
    }
    const kids = anyComp._children ?? anyComp.children;
    if (!Array.isArray(kids)) return null;
    for (const kid of kids) {
        const found = findBasesViewInComponent(kid, depth + 1);
        if (found) return found;
    }
    return null;
}

async function waitForBasesView(
    child: Component,
    generation: number,
    getGeneration: () => number,
): Promise<BasesViewLike | null> {
    for (let attempt = 0; attempt < 24; attempt++) {
        if (getGeneration() !== generation) return null;
        const found = findBasesViewInComponent(child);
        if (found) return found;
        await new Promise<void>(resolve => window.setTimeout(resolve, 50));
    }
    return findBasesViewInComponent(child);
}

async function withPersistLock(basePath: string, fn: () => Promise<void>): Promise<void> {
    while (persistLocks.has(basePath)) {
        try { await persistLocks.get(basePath); } catch { /* continue */ }
    }
    while (ensureLocks.has(basePath)) {
        try { await ensureLocks.get(basePath); } catch { /* continue */ }
    }
    const pending = fn().finally(() => {
        if (persistLocks.get(basePath) === pending) persistLocks.delete(basePath);
    });
    persistLocks.set(basePath, pending);
    await pending;
}

async function persistLayoutSnapshot(
    plugin: SceneCardsPlugin,
    basePath: string,
    categoryId: string,
    snapshot: ViewLayoutSnapshot,
): Promise<void> {
    if (
        snapshot.order.length === 0
        && snapshot.sort.length === 0
        && !snapshot.columnSize
        && snapshot.groupBy == null
    ) {
        return;
    }
    await withPersistLock(basePath, async () => {
        const config = await readBaseConfig(plugin, basePath);
        if (!config) return;
        const views = getViews(config);
        const view = findViewForCategory(views, categoryId);
        if (!view) return;
        if (!applyLayoutSnapshotToView(view, snapshot)) return;
        config.views = views;
        // Bypass writeBaseConfig's live merge — this snapshot is already authoritative.
        await ensureVaultFolder(plugin, basePath.split('/').slice(0, -1).join('/'));
        const yaml = stringifyYaml(config);
        const existing = plugin.app.vault.getAbstractFileByPath(basePath);
        if (existing instanceof TFile) {
            await plugin.app.vault.modify(existing, yaml);
            return;
        }
        if (await pathExists(plugin, basePath)) {
            await plugin.app.vault.adapter.write(basePath, yaml);
            return;
        }
        await plugin.app.vault.create(basePath, yaml);
    });
}

function schedulePersistLiveLayout(state: NativeBaseEmbedState): void {
    if (!state.plugin || !state.basePath || !state.categoryId || !state.liveView) return;
    state.lastLayoutAt = Date.now();
    if (state.persistTimer != null) window.clearTimeout(state.persistTimer);
    state.persistTimer = window.setTimeout(() => {
        state.persistTimer = null;
        if (!state.plugin || !state.basePath || !state.categoryId || !state.liveView) return;
        const snapshot = snapshotBasesViewLayout(state.liveView);
        void persistLayoutSnapshot(state.plugin, state.basePath, state.categoryId, snapshot)
            .catch(error => console.warn('[NarrativeLab] Failed to persist live Base layout:', error));
    }, 250);
}

function hookLiveBasesView(state: NativeBaseEmbedState, view: BasesViewLike): void {
    state.liveView = view;
    trackLiveEmbed(state);
    const config = view.config;
    const originalSet = config.set;
    if (originalSet) {
        config.set = (key: string, value: unknown) => {
            originalSet.call(config, key, value);
            if (key === 'order' || key === 'sort' || key === 'columnSize' || key === 'groupBy') {
                schedulePersistLiveLayout(state);
            }
        };
    }

    // Toolbar menus may update config without going through a patched set in
    // some Obsidian builds — also snapshot after Properties/Sort interactions.
    const host = state.child?.containerEl;
    const onPointerUp = (event: Event) => {
        const target = event.target as HTMLElement | null;
        if (!target?.closest?.('.bases-toolbar, .menu, .suggestion-container, .bases-view')) return;
        schedulePersistLiveLayout(state);
    };
    host?.addEventListener('pointerup', onPointerUp, true);
    host?.addEventListener('change', onPointerUp, true);

    state.unhook = () => {
        config.set = originalSet;
        host?.removeEventListener('pointerup', onPointerUp, true);
        host?.removeEventListener('change', onPointerUp, true);
        if (state.persistTimer != null) {
            window.clearTimeout(state.persistTimer);
            state.persistTimer = null;
        }
        untrackLiveEmbed(state);
        state.liveView = null;
        state.unhook = null;
    };
}

async function flushEmbedLayout(state: NativeBaseEmbedState): Promise<void> {
    if (!state.plugin || !state.basePath || !state.categoryId || !state.liveView) return;
    if (state.persistTimer != null) {
        window.clearTimeout(state.persistTimer);
        state.persistTimer = null;
    }
    const snapshot = snapshotBasesViewLayout(state.liveView);
    await persistLayoutSnapshot(state.plugin, state.basePath, state.categoryId, snapshot);
}

async function readLegacyCategoryConfig(
    plugin: SceneCardsPlugin,
    categoryId: string,
): Promise<Record<string, unknown> | null> {
    // Prefer a matching view from the previous System/library.base when present.
    const legacySystem = getLegacySystemLibraryBasePath(plugin);
    if (legacySystem && await pathExists(plugin, legacySystem)) {
        try {
            const config = await readBaseConfig(plugin, legacySystem);
            const view = config ? findViewForCategory(getViews(config), categoryId) : null;
            if (view) return { views: [view], properties: config?.properties };
        } catch { /* try per-category files */ }
    }
    for (const path of getLegacyNativeBasePaths(plugin, categoryId)) {
        if (!(await pathExists(plugin, path))) continue;
        try {
            return await readBaseConfig(plugin, path);
        } catch {
            /* try next alias */
        }
    }
    return null;
}

function extractTableOrder(config: Record<string, unknown> | null, discovered: string[]): string[] {
    if (config && Array.isArray(config.views)) {
        for (const view of config.views) {
            if (!view || typeof view !== 'object') continue;
            const viewConfig = view as BaseViewConfig;
            if (Array.isArray(viewConfig.order) && viewConfig.order.length > 0) {
                return viewConfig.order.filter((item): item is string => typeof item === 'string');
            }
        }
    }
    return [
        'file.name',
        ...discovered.map(key => `note.${key}`),
    ];
}

function upsertCategoryView(
    plugin: SceneCardsPlugin,
    config: Record<string, unknown>,
    categoryId: string,
    options?: { seedFromLegacy?: Record<string, unknown> | null },
): boolean {
    const folderPaths = getCategoryFolders(plugin, categoryId);
    if (folderPaths.length === 0) return false;
    const recursive = categoryId !== 'uncategorized';
    const requiredFilters = buildRequiredFilters(plugin, categoryId, folderPaths);
    const discovered = collectNoteProperties(plugin, folderPaths, recursive);
    const label = getNativeBaseDisplayLabel(plugin, categoryId);
    const views = getViews(config);
    let view = findViewForCategory(views, categoryId);
    let dirty = false;

    if (!view) {
        view = {
            type: 'table',
            name: label,
            [VIEW_CATEGORY_KEY]: categoryId,
            order: extractTableOrder(options?.seedFromLegacy ?? null, discovered),
        };
        if (requiredFilters.length > 0) {
            view.filters = { and: requiredFilters };
        }
        views.push(view);
        dirty = true;
    } else {
        if (view.type === 'narrative-lab-cards') {
            view.type = 'table';
            dirty = true;
        }
        if (view.name !== label) {
            view.name = label;
            dirty = true;
        }
        if (String(view[VIEW_CATEGORY_KEY] || '') !== categoryId) {
            view[VIEW_CATEGORY_KEY] = categoryId;
            dirty = true;
        }
        if (!viewFiltersMatch(view, requiredFilters)) {
            if (requiredFilters.length === 0) {
                delete view.filters;
            } else {
                view.filters = { and: requiredFilters };
            }
            dirty = true;
        }
        if (!Array.isArray(view.order) || view.order.length === 0) {
            view.order = extractTableOrder(null, discovered);
            dirty = true;
        }
    }

    config.views = views;
    dirty = ensureRawNotePropertyDisplayNames(config, [
        ...discovered,
        ...collectConfiguredNoteProperties(config),
    ]) || dirty;
    return dirty;
}

async function ensureConsolidatedLibraryBase(
    plugin: SceneCardsPlugin,
): Promise<{ basePath: string; config: Record<string, unknown>; dirty: boolean } | null> {
    const basePath = getLibraryBasePath(plugin);
    if (!basePath) return null;

    let config = await readBaseConfig(plugin, basePath);
    let dirty = false;
    if (!config) {
        // Lift the whole previous System/library.base into Library/ when present.
        const legacySystem = getLegacySystemLibraryBasePath(plugin);
        if (legacySystem && await pathExists(plugin, legacySystem)) {
            try {
                config = await readBaseConfig(plugin, legacySystem);
            } catch { /* fall through to empty shell */ }
        }
        // Copy the previous shared Library/library.base into the new per-project file.
        if (!config) {
            const legacyLibrary = getLegacyLibraryBasePath(plugin);
            if (legacyLibrary && await pathExists(plugin, legacyLibrary)) {
                try {
                    config = await readBaseConfig(plugin, legacyLibrary);
                } catch { /* fall through to empty shell */ }
            }
        }
        if (config) {
            dirty = true;
        } else {
            config = {
                narrativeLabLibraryBase: LIBRARY_BASE_FORMAT,
                filters: { and: buildGlobalLibraryFilters(plugin) },
                views: [],
            };
            dirty = true;
        }
    }

    if (config.narrativeLabLibraryBase !== LIBRARY_BASE_FORMAT) {
        config.narrativeLabLibraryBase = LIBRARY_BASE_FORMAT;
        dirty = true;
    }

    const globalFilters = { and: buildGlobalLibraryFilters(plugin) };
    if (!filtersEqual(config.filters, globalFilters)) {
        config.filters = globalFilters;
        dirty = true;
    }

    for (const categoryId of getKnownLibraryCategoryIds(plugin)) {
        const folderPaths = getCategoryFolders(plugin, categoryId);
        for (const path of folderPaths) {
            if (!plugin.app.vault.getAbstractFileByPath(path)) {
                await ensureVaultFolder(plugin, path);
            }
        }
        const seed = findViewForCategory(getViews(config), categoryId)
            ? null
            : await readLegacyCategoryConfig(plugin, categoryId);
        if (upsertCategoryView(plugin, config, categoryId, { seedFromLegacy: seed })) {
            dirty = true;
        }
    }

    return { basePath, config, dirty };
}

async function trashLegacyLibraryBaseFiles(plugin: SceneCardsPlugin): Promise<void> {
    const canonical = getLibraryBasePath(plugin);
    const seen = new Set<string>();
    await trashBasePath(plugin, getLegacySystemLibraryBasePath(plugin));
    // If the legacy shared Library/library.base belongs to a single project
    // (no series codex), we can safely remove it after per-project migration.
    // For series codex, keep it so other open projects can still copy from it.
    if (!plugin.sceneManager.activeProject?.seriesId) {
        await trashBasePath(plugin, getLegacyLibraryBasePath(plugin));
    }
    for (const categoryId of getKnownLibraryCategoryIds(plugin)) {
        for (const path of getLegacyNativeBasePaths(plugin, categoryId)) {
            const normalized = normalizePath(path);
            if (canonical && normalized === canonical) continue;
            if (seen.has(normalized)) continue;
            seen.add(normalized);
            await trashBasePath(plugin, normalized);
        }
    }
    for (const folder of getLegacyBasesScanFolders(plugin)) {
        const files = await listBaseFilesRecursive(plugin, folder);
        for (const path of files) {
            if (canonical && normalizePath(path) === canonical) continue;
            const name = (path.split('/').pop() || '').toLowerCase();
            if (name.startsWith('library-') && name.endsWith('.base')) {
                await trashBasePath(plugin, path);
            }
        }
        await removeFolderIfEmpty(plugin, folder);
    }
}

async function migrateLegacyNativeBasesUnlocked(plugin: SceneCardsPlugin): Promise<void> {
    const ensured = await ensureConsolidatedLibraryBase(plugin);
    if (!ensured) return;
    const liveDirty = applyLiveLayoutsToConfig(ensured.basePath, ensured.config);
    if (ensured.dirty || liveDirty) {
        await writeBaseConfig(plugin, ensured.basePath, ensured.config);
    }
    await trashLegacyLibraryBaseFiles(plugin);
}

async function migrateLegacyNativeBases(plugin: SceneCardsPlugin): Promise<void> {
    if (!plugin.sceneManager.activeProject) return;
    const basePath = getLibraryBasePath(plugin);
    if (!basePath) return;
    if (migratedLibraryBasePaths.has(basePath)) return;
    const existing = migrationLocks.get(basePath);
    if (existing) return existing;
    const pending = migrateLegacyNativeBasesUnlocked(plugin)
        .then(() => {
            migratedLibraryBasePaths.add(basePath);
        })
        .catch(error => {
            console.error('[NarrativeLab] Failed to migrate Library Base files:', error);
        })
        .finally(() => migrationLocks.delete(basePath));
    migrationLocks.set(basePath, pending);
    return pending;
}

function libraryFilterSyncKey(plugin: SceneCardsPlugin, basePath: string): string {
    const roots = getCategoryFolders(plugin, ALL_LIBRARY_CATEGORY_ID);
    const subs = roots.flatMap(root => listLibrarySubfolderPaths(plugin, root))
        .sort()
        .join('|');
    const cats = getKnownLibraryCategoryIds(plugin).slice().sort();
    const labels = cats.map(id => getNativeBaseDisplayLabel(plugin, id)).join('|');
    return `${basePath}::${FILTER_STYLE_VERSION}::${cats.join(',')}::${labels}::${roots.join('|')}::${subs}`;
}

async function ensureNativeBaseUnlocked(
    plugin: SceneCardsPlugin,
    categoryId: string,
): Promise<{ basePath: string; folderPath: string } | null> {
    const folderPaths = getCategoryFolders(plugin, categoryId);
    const folderPath = folderPaths[0];
    if (!folderPath) return null;
    const ensured = await ensureConsolidatedLibraryBase(plugin);
    if (!ensured) return null;
    if (persistLocks.has(ensured.basePath)) {
        try { await persistLocks.get(ensured.basePath); } catch { /* ignore */ }
    }
    const liveDirty = applyLiveLayoutsToConfig(ensured.basePath, ensured.config);
    if (ensured.dirty || liveDirty) {
        await writeBaseConfig(plugin, ensured.basePath, ensured.config);
    }
    return { basePath: ensured.basePath, folderPath };
}

async function ensureNativeBase(
    plugin: SceneCardsPlugin,
    categoryId: string,
): Promise<{ basePath: string; folderPath: string } | null> {
    const folderPath = getCategoryFolder(plugin, categoryId);
    if (!folderPath) return null;
    const basePath = getLibraryBasePath(plugin);
    if (!basePath) return null;
    while (ensureLocks.has(basePath)) {
        await ensureLocks.get(basePath);
    }
    const pending = ensureNativeBaseUnlocked(plugin, categoryId)
        .finally(() => ensureLocks.delete(basePath));
    ensureLocks.set(basePath, pending);
    return pending;
}

/** Rename a category view when its Library tab/folder label changes. */
export async function renameNativeLibraryBase(
    plugin: SceneCardsPlugin,
    categoryId: string,
    _oldLabel: string,
): Promise<void> {
    await ensureNativeBase(plugin, categoryId);
}

/** Ensure every known Library category has a view with correct filters (once/session). */
export async function syncAllNativeLibraryBases(
    plugin: SceneCardsPlugin,
): Promise<void> {
    if (!plugin.sceneManager.activeProject) return;
    const basePath = getLibraryBasePath(plugin);
    if (!basePath) return;
    const styleKey = libraryFilterSyncKey(plugin, basePath);
    if (syncedFilterStyleKeys.has(styleKey)) return;
    try {
        const ensured = await ensureConsolidatedLibraryBase(plugin);
        if (ensured) {
            const liveDirty = applyLiveLayoutsToConfig(ensured.basePath, ensured.config);
            if (ensured.dirty || liveDirty) {
                await writeBaseConfig(plugin, ensured.basePath, ensured.config);
            }
        }
    } catch (error) {
        console.error('[NarrativeLab] Failed to sync Library Base:', error);
    }
    syncedFilterStyleKeys.add(styleKey);
}

export async function migrateNativeLibraryBasesForActiveProject(
    plugin: SceneCardsPlugin,
): Promise<void> {
    try {
        await migrateLegacyNativeBases(plugin);
        await pruneOrphanNativeLibraryBases(plugin);
        await syncAllNativeLibraryBases(plugin);
    } catch (error) {
        // Never block project open on Base migration / OneDrive rename races.
        console.warn('[NarrativeLab] Library Base migration skipped:', error);
    }
}

/**
 * Drop views for deleted categories and trash leftover multi-file Bases.
 */
export async function pruneOrphanNativeLibraryBases(
    plugin: SceneCardsPlugin,
): Promise<void> {
    const basePath = getLibraryBasePath(plugin);
    if (!basePath) return;

    if (await pathExists(plugin, basePath)) {
        const config = await readBaseConfig(plugin, basePath);
        if (config) {
            const known = new Set(getKnownLibraryCategoryIds(plugin));
            const views = getViews(config);
            const next = views.filter(view => {
                const id = String(view[VIEW_CATEGORY_KEY] || '');
                return !id || known.has(id);
            });
            if (next.length !== views.length) {
                config.views = next;
                await writeBaseConfig(plugin, basePath, config);
            }
        }
    }

    await trashLegacyLibraryBaseFiles(plugin);
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
    const basePath = getLibraryBasePath(plugin);
    if (basePath && await pathExists(plugin, basePath)) {
        const config = await readBaseConfig(plugin, basePath);
        if (config) {
            const views = getViews(config);
            const next = views.filter(view => String(view[VIEW_CATEGORY_KEY] || '') !== categoryId);
            if (next.length !== views.length) {
                config.views = next;
                await writeBaseConfig(plugin, basePath, config);
            }
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
    // Snapshot+write layout while the Bases view is still alive, then detach.
    const flush = flushEmbedLayout(state);
    state.unhook?.();
    state.newNoteUnhook?.();
    state.horizontalScrollUnhook?.();
    state.unhook = null;
    state.newNoteUnhook = null;
    state.horizontalScrollUnhook = null;
    state.generation += 1;
    if (state.child) {
        owner.removeChild(state.child);
        state.child = null;
    }
    state.plugin = undefined;
    state.categoryId = undefined;
    state.basePath = undefined;
    void flush.catch(error => {
        console.warn('[NarrativeLab] Failed to persist Library Base layout:', error);
    });
}

function escapeWikilinkPath(path: string): string {
    return path.replace(/\]/g, '\\]');
}

/** Mirror the native Bases table's horizontal position at the Library pane bottom. */
function mountBottomHorizontalScrollbar(host: HTMLElement): () => void {
    const rail = host.createDiv('library-native-base-bottom-scroll');
    const spacer = rail.createDiv('library-native-base-bottom-scroll-spacer');
    const pane = host.closest<HTMLElement>(
        '.story-line-codex-content, .story-line-character-content, .story-line-location-content',
    );
    let source: HTMLElement | null = null;
    let syncing = false;
    let updateFrame = 0;
    let resizeObserver: ResizeObserver | null = null;

    const findSource = (): HTMLElement | null => {
        const preferred = Array.from(host.querySelectorAll<HTMLElement>(
            '.bases-table-container, .bases-view [class*="table"], .bases-view',
        ));
        const fallback = Array.from(host.querySelectorAll<HTMLElement>('.bases-view *'));
        const candidates = Array.from(new Set([...preferred, ...fallback]))
            .filter(element => (
                element !== rail
                && element.clientWidth > 0
                && element.scrollWidth > element.clientWidth + 1
                && ['auto', 'scroll'].includes(getComputedStyle(element).overflowX)
            ));
        candidates.sort((left, right) => {
            const preferredDelta = Number(right.matches('.bases-table-container'))
                - Number(left.matches('.bases-table-container'));
            if (preferredDelta) return preferredDelta;
            return right.clientWidth * right.clientHeight - left.clientWidth * left.clientHeight;
        });
        return candidates[0] || null;
    };

    const syncFromSource = () => {
        if (!source || syncing) return;
        syncing = true;
        rail.scrollLeft = source.scrollLeft;
        syncing = false;
    };
    const syncFromRail = () => {
        if (!source || syncing) return;
        syncing = true;
        source.scrollLeft = rail.scrollLeft;
        syncing = false;
    };
    const updateNow = () => {
        updateFrame = 0;
        const next = findSource();
        if (next !== source) {
            source?.removeEventListener('scroll', syncFromSource);
            if (source) resizeObserver?.unobserve(source);
            source = next;
            source?.addEventListener('scroll', syncFromSource, { passive: true });
            if (source) resizeObserver?.observe(source);
        }
        const rect = pane?.getBoundingClientRect();
        if (!source || !rect || rect.width <= 0 || rect.height <= 0) {
            rail.hide();
            return;
        }
        spacer.style.width = `${source.scrollWidth}px`;
        rail.style.left = `${Math.max(0, rect.left)}px`;
        rail.style.width = `${Math.max(0, rect.width)}px`;
        rail.style.bottom = `${Math.max(0, window.innerHeight - rect.bottom)}px`;
        rail.show();
        syncFromSource();
    };
    const scheduleUpdate = () => {
        if (updateFrame) return;
        updateFrame = window.requestAnimationFrame(updateNow);
    };

    rail.addEventListener('scroll', syncFromRail, { passive: true });
    const mutationObserver = new MutationObserver(records => {
        if (records.every(record => rail.contains(record.target))) return;
        scheduleUpdate();
    });
    mutationObserver.observe(host, {
        childList: true,
        subtree: true,
        attributes: true,
        attributeFilter: ['class', 'style'],
    });
    resizeObserver = new ResizeObserver(scheduleUpdate);
    resizeObserver.observe(host);
    if (pane) resizeObserver.observe(pane);
    window.addEventListener('resize', scheduleUpdate, { passive: true });
    scheduleUpdate();

    return () => {
        if (updateFrame) window.cancelAnimationFrame(updateFrame);
        source?.removeEventListener('scroll', syncFromSource);
        rail.removeEventListener('scroll', syncFromRail);
        mutationObserver.disconnect();
        resizeObserver?.disconnect();
        resizeObserver = null;
        window.removeEventListener('resize', scheduleUpdate);
        rail.remove();
    };
}

/**
 * Render an Obsidian Bases embed for one Library category view inside
 * Library/library.base.
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

    // The caller may place the Profiles / Base mode switch beside this embed.
    // Replace only an earlier Base host; clearing the whole content pane here
    // removes that sibling control and strands the user on the Base page.
    container.querySelectorAll(':scope > .library-native-base-embed')
        .forEach(element => element.remove());
    const host = container.createDiv('library-native-base-embed markdown-rendered');
    const loading = host.createDiv({ cls: 'library-native-base-loading', text: t('Loading Base…') });
    let resolved: { basePath: string; folderPath: string } | null;
    try {
        await migrateLegacyNativeBases(plugin);
        // Wait for any in-flight layout flush from the previous embed.
        const basePath = getLibraryBasePath(plugin);
        if (basePath && persistLocks.has(basePath)) {
            try { await persistLocks.get(basePath); } catch { /* ignore */ }
        }
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

    const viewName = getNativeBaseDisplayLabel(plugin, categoryId);
    loading.remove();
    const child = owner.addChild(new MarkdownRenderChild(host));
    state.child = child;
    state.plugin = plugin;
    state.categoryId = categoryId;
    state.basePath = resolved.basePath;
    state.newNoteUnhook = routeNativeBaseNewNotes(host, plugin, resolved.folderPath);
    const linkPath = escapeWikilinkPath(resolved.basePath);
    const linkView = escapeWikilinkPath(viewName);
    await MarkdownRenderer.render(
        plugin.app,
        `![[${linkPath}#${linkView}]]`,
        host,
        resolved.basePath,
        child,
    );
    if (state.generation !== generation || !host.isConnected) {
        if (state.child === child) state.child = null;
        owner.removeChild(child);
        return;
    }
    state.horizontalScrollUnhook = mountBottomHorizontalScrollbar(host);

    // Hook the live Bases view so Properties / Sort toolbar changes are written
    // back into Library/library.base (embedded Bases often keep these in memory).
    void waitForBasesView(child, generation, () => state.generation).then(view => {
        if (!view || state.generation !== generation || !host.isConnected) return;
        hookLiveBasesView(state, view);
    });
}
