import {
    Component,
    MarkdownRenderChild,
    MarkdownRenderer,
    TFile,
    TFolder,
    Notice,
    normalizePath,
    parseYaml,
    setIcon,
    stringifyYaml,
} from 'obsidian';
import { PRESET_CODEX_CATEGORIES } from '../models/Codex';
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
import { getLibraryProfilePropertyOrder } from '../utils/libraryProfilePropertyOrder';
import { attachTooltip } from './Tooltip';
import {
    buildLibraryPathScopeFilter,
    collectReferencedLibraryCategoryIds,
    guardLibraryBaseFileFilter,
    type LibraryBaseFilter,
} from '../utils/libraryCategoryTransactions';

export const ALL_LIBRARY_CATEGORY_ID = '__all-library__';
const VIEW_CATEGORY_KEY = 'narrativeLabCategoryId';
const VIEW_HIDDEN_CUSTOM_PROPERTIES_KEY = 'narrativeLabHiddenCustomProperties';

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
    /** Monotonic user-layout revision. Older async writes are discarded. */
    layoutRevision?: number;
    /** Values passed to config.set are authoritative while get* may still be stale. */
    pendingLayout?: Partial<ViewLayoutSnapshot>;
    /** Associates Obsidian's body-level Properties menu with this embed. */
    lastInteractionAt?: number;
    /** Layout before opening a body-level toolbar menu. */
    interactionSnapshot?: ViewLayoutSnapshot;
    /** Identifies one click inside the body-level Properties menu. */
    menuOrderToken?: number;
    /** Visible columns immediately before that menu click. */
    menuOrderBaseline?: string[];
    /** First real order delta produced by that click; stale reversions lose. */
    menuOrderAccepted?: string[];
    /** Token whose accepted order has already been queued for persistence. */
    menuOrderScheduledToken?: number;
    /** Short post-click probes used to catch a transient rendered order. */
    menuOrderCaptureTimers?: number[];
}

interface ViewLayoutSnapshot {
    order: string[];
    sort: Array<{ property: string; direction: 'ASC' | 'DESC' }>;
    columnSize: Record<string, number> | null;
    groupBy: unknown;
}

interface BasesViewLike {
    allProperties?: unknown;
    data?: {
        properties?: unknown;
    };
    config: {
        getOrder?: () => unknown;
        getSort?: () => unknown;
        getDisplayName?: (propertyId: string) => string;
        get?: (key: string) => unknown;
        set?: (key: string, value: unknown) => void;
    };
}

const activeEmbeds = new WeakMap<Component, NativeBaseEmbedState>();
/** Live embeds keyed by base path — used to flush layout before NarrativeLab rewrites YAML. */
const liveEmbedsByBase = new Map<string, Set<NativeBaseEmbedState>>();
const ensureLocks = new Map<string, Promise<{ basePath: string; folderPath: string } | null>>();
const persistLocks = new Map<string, Promise<void>>();
let layoutRevisionCounter = 0;
const latestLayoutRevisionByView = new Map<string, number>();
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
    narrativeLabHiddenCustomProperties?: unknown;
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
        ...Object.fromEntries(PRESET_CODEX_CATEGORIES.map(category => [category.id, category.folder])),
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

    const builtin = PRESET_CODEX_CATEGORIES.find(c => c.id === categoryId);
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

function isNativeBasesNewButton(event: Event): boolean {
    const controls = new Set<Element>();
    for (const candidate of event.composedPath()) {
        if (!(candidate instanceof Element)) continue;
        const control = candidate.closest(
            'button, [role="button"], a, .clickable-icon, [class*="bases-toolbar"]',
        );
        if (control) controls.add(control);
    }

    // Clicking Lucide's SVG/path makes event.target an SVGElement, not an
    // HTMLElement. Walk the composed path and identify the enclosing control
    // by accessible text so Obsidian DOM/class changes do not break creation.
    const accepted = new Set([
        'new',
        'new note',
        'new file',
        'create note',
        'create file',
        '新建',
        '新建笔记',
        '新建文件',
        '创建笔记',
        '创建文件',
        t('New').trim().toLocaleLowerCase(),
    ]);
    for (const control of controls) {
        const labels = [
            control.textContent,
            control.getAttribute('aria-label'),
            control.getAttribute('title'),
            control.getAttribute('data-tooltip-position') ? control.getAttribute('data-tooltip-content') : null,
        ];
        if (labels.some(label => {
            const normalized = (label || '')
                .replace(/^\s*[+＋]\s*/, '')
                .replace(/\s+/g, ' ')
                .trim()
                .toLocaleLowerCase();
            return accepted.has(normalized);
        })) return true;
    }
    return false;
}

/**
 * Make the native Base New control use the same category-aware creation flow
 * as the Profiles page. Creating directly in the destination is safer than
 * watching Obsidian create a note elsewhere and moving it afterward.
 */
function wireNativeBaseNewAction(
    host: HTMLElement,
    onNew: (event: MouseEvent | PointerEvent) => void,
): () => void {
    let lastActionAt = 0;
    const onTrigger = (event: MouseEvent | PointerEvent) => {
        if (!isNativeBasesNewButton(event)) return;
        event.preventDefault();
        event.stopPropagation();
        event.stopImmediatePropagation();
        // One pointer activation produces pointerdown, mousedown, pointerup,
        // mouseup and click. Block every phase but launch our flow only once.
        if (Date.now() - lastActionAt > 500) {
            lastActionAt = Date.now();
            onNew(event);
        }
    };
    const eventTypes = ['pointerdown', 'mousedown', 'pointerup', 'mouseup', 'click'] as const;
    for (const eventType of eventTypes) host.addEventListener(eventType, onTrigger, true);
    return () => {
        for (const eventType of eventTypes) host.removeEventListener(eventType, onTrigger, true);
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

function getBaseHiddenCustomProperties(view: BaseViewConfig): Set<string> {
    const raw = view[VIEW_HIDDEN_CUSTOM_PROPERTIES_KEY];
    if (!Array.isArray(raw)) return new Set();
    return new Set(raw.filter((value): value is string => typeof value === 'string' && value.length > 0));
}

function effectiveProfileOrder(view: BaseViewConfig, profileOrder: string[]): string[] {
    const hidden = getBaseHiddenCustomProperties(view);
    return hidden.size === 0 ? profileOrder : profileOrder.filter(propertyId => !hidden.has(propertyId));
}

function applyProfileOrdersToConfig(config: Record<string, unknown>): boolean {
    let dirty = false;
    for (const view of getViews(config)) {
        const categoryId = String(view[VIEW_CATEGORY_KEY] || '');
        if (!categoryId) continue;
        const profileOrder = getProfileTableOrder(categoryId);
        if (!profileOrder) continue;
        const order = effectiveProfileOrder(view, profileOrder);
        if (stringArrayEqual(view.order, order)) continue;
        view.order = order;
        dirty = true;
    }
    return dirty;
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
    // Widths and sorts may come from the live view, but profile layout owns
    // field visibility/order and must win over a stale Base snapshot.
    applyProfileOrdersToConfig(config);
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
    // BasesQueryResult.properties is the list that actually rendered. On
    // Obsidian 1.13 the toolbar can update it before config.getOrder(), so the
    // latter alone can report the pre-click column list and undo the action.
    const renderedOrder = view.data?.properties;
    const configOrder = view.config.getOrder?.();
    const orderRaw = Array.isArray(renderedOrder) ? renderedOrder : configOrder;
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

/** Obsidian may expose the same note property as `foo` and `note.foo`. */
function comparableBasePropertyId(value: unknown): string {
    const propertyId = primitiveText(value);
    return propertyId.startsWith('note.') ? propertyId.slice('note.'.length) : propertyId;
}

function baseOrdersEquivalent(left: readonly string[], right: readonly string[]): boolean {
    return left.length === right.length
        && left.every((propertyId, index) => (
            comparableBasePropertyId(propertyId) === comparableBasePropertyId(right[index])
        ));
}

function cloneSnapshot(snapshot: ViewLayoutSnapshot): ViewLayoutSnapshot {
    return {
        order: snapshot.order.slice(),
        sort: snapshot.sort.map(item => ({ ...item })),
        columnSize: snapshot.columnSize ? { ...snapshot.columnSize } : null,
        groupBy: cloneGroupBy(snapshot.groupBy),
    };
}

function overlayPendingLayout(
    snapshot: ViewLayoutSnapshot,
    pending: Partial<ViewLayoutSnapshot> | undefined,
): ViewLayoutSnapshot {
    if (!pending) return snapshot;
    return {
        order: pending.order?.slice() ?? snapshot.order,
        sort: pending.sort?.map(item => ({ ...item })) ?? snapshot.sort,
        columnSize: pending.columnSize !== undefined
            ? (pending.columnSize ? { ...pending.columnSize } : null)
            : snapshot.columnSize,
        groupBy: pending.groupBy !== undefined ? cloneGroupBy(pending.groupBy) : snapshot.groupBy,
    };
}

function layoutSnapshotsEqual(left: ViewLayoutSnapshot, right: ViewLayoutSnapshot): boolean {
    return stringArrayEqual(left.order, right.order)
        && sortConfigsEqual(left.sort, right.sort)
        && columnSizeEqual(left.columnSize, right.columnSize)
        && groupByEqual(left.groupBy, right.groupBy);
}

function layoutRevisionKey(basePath: string, categoryId: string): string {
    return `${basePath}::${categoryId}`;
}

function isLatestLayoutRevision(basePath: string, categoryId: string, revision: number): boolean {
    return latestLayoutRevisionByView.get(layoutRevisionKey(basePath, categoryId)) === revision;
}

function markLayoutRevision(state: NativeBaseEmbedState): number | null {
    if (!state.basePath || !state.categoryId) return null;
    const revision = ++layoutRevisionCounter;
    state.layoutRevision = revision;
    latestLayoutRevisionByView.set(layoutRevisionKey(state.basePath, state.categoryId), revision);
    return revision;
}

function snapshotPatchForConfigSet(
    key: string,
    value: unknown,
): Partial<ViewLayoutSnapshot> | null {
    if (key === 'order') {
        return { order: Array.isArray(value) ? value.map(item => String(item)).filter(Boolean) : [] };
    }
    if (key === 'sort') {
        const sort: ViewLayoutSnapshot['sort'] = [];
        if (Array.isArray(value)) {
            for (const item of value) {
                if (!item || typeof item !== 'object') continue;
                const row = item as { property?: unknown; direction?: unknown };
                const property = primitiveText(row.property).trim();
                if (!property) continue;
                sort.push({
                    property,
                    direction: (primitiveText(row.direction) || 'ASC').toUpperCase() === 'DESC'
                        ? 'DESC'
                        : 'ASC',
                });
            }
        }
        return { sort };
    }
    if (key === 'columnSize') return { columnSize: cloneColumnSize(value) };
    if (key === 'groupBy') return { groupBy: cloneGroupBy(value) };
    return null;
}

function normalizeSnapshotPropertyIds(
    snapshot: ViewLayoutSnapshot,
    config: Record<string, unknown>,
): ViewLayoutSnapshot {
    const known = new Set<string>();
    const properties = config.properties;
    if (properties && typeof properties === 'object' && !Array.isArray(properties)) {
        Object.keys(properties).forEach(key => known.add(key));
    }
    const normalize = (raw: string): string => {
        if (!raw || raw.includes('.')) return raw;
        const noteId = `note.${raw}`;
        return known.has(noteId) ? noteId : raw;
    };
    return {
        order: snapshot.order.map(normalize),
        sort: snapshot.sort.map(item => ({ ...item, property: normalize(item.property) })),
        columnSize: snapshot.columnSize
            ? Object.fromEntries(Object.entries(snapshot.columnSize).map(([key, value]) => [normalize(key), value]))
            : null,
        groupBy: snapshot.groupBy,
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
        if (at <= 0) continue;
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

/** Write one settled layout without merging a stale live snapshot back into it. */
async function writeAuthoritativeBaseConfig(
    plugin: SceneCardsPlugin,
    basePath: string,
    config: Record<string, unknown>,
): Promise<void> {
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

async function persistLayoutSnapshot(
    plugin: SceneCardsPlugin,
    basePath: string,
    categoryId: string,
    snapshot: ViewLayoutSnapshot,
    revision: number,
): Promise<void> {
    if (
        snapshot.order.length === 0
        && snapshot.sort.length === 0
        && !snapshot.columnSize
        && snapshot.groupBy == null
    ) {
        return;
    }
    if (!isLatestLayoutRevision(basePath, categoryId, revision)) return;
    let persistedSnapshot: ViewLayoutSnapshot | null = null;
    let persistedOrderChanged = false;
    await withPersistLock(basePath, async () => {
        if (!isLatestLayoutRevision(basePath, categoryId, revision)) return;
        const config = await readBaseConfig(plugin, basePath);
        if (!config) return;
        const views = getViews(config);
        const view = findViewForCategory(views, categoryId);
        if (!view) return;
        const normalized = normalizeSnapshotPropertyIds(snapshot, config);
        persistedSnapshot = cloneSnapshot(normalized);
        persistedOrderChanged = !stringArrayEqual(view.order, normalized.order);
        // A Properties action also changes the shared profile visibility.
        // Delay its Base write until that setting is updated so the native
        // embed sees one final file change instead of old → transient → final.
        if (persistedOrderChanged) return;
        const dirty = applyLayoutSnapshotToView(view, normalized);
        if (!dirty) return;
        config.views = views;
        await writeAuthoritativeBaseConfig(plugin, basePath, config);
    });
    const authoritativeSnapshot = persistedSnapshot as ViewLayoutSnapshot | null;
    if (!authoritativeSnapshot || !isLatestLayoutRevision(basePath, categoryId, revision)) return;
    // Sort/width/group changes must not be interpreted as a Properties action.
    // In particular, a stale getOrder() equal to disk is not evidence that all
    // omitted custom fields were deliberately hidden.
    if (!persistedOrderChanged) return;

    // Saving project profile settings writes only project System data; it does
    // not remount the native Base. Update it first so the provider can produce
    // the final canonical visible order for our single Base write below.
    await plugin.syncLibraryProfileVisibilityFromBase(categoryId, authoritativeSnapshot.order);
    if (!isLatestLayoutRevision(basePath, categoryId, revision)) return;

    // Commit sort/width/group, Base-only custom visibility, and canonical
    // column order together. One durable Base modification means one native
    // repaint, eliminating the visible appear/disappear/appear cycle.
    await withPersistLock(basePath, async () => {
        if (!isLatestLayoutRevision(basePath, categoryId, revision)) return;
        const config = await readBaseConfig(plugin, basePath);
        if (!config) return;
        const views = getViews(config);
        const view = findViewForCategory(views, categoryId);
        const profileOrder = getProfileTableOrder(categoryId);
        if (!view || !profileOrder) return;
        const normalized = normalizeSnapshotPropertyIds(authoritativeSnapshot, config);
        const hiddenDirty = updateBaseHiddenCustomProperties(
            view,
            normalized.order,
            profileOrder,
            getProfileManagedPropertyIds(categoryId),
        );
        const order = effectiveProfileOrder(view, profileOrder);
        const layoutDirty = applyLayoutSnapshotToView(view, {
            ...normalized,
            order,
        });
        if (!hiddenDirty && !layoutDirty) return;
        config.views = views;
        await writeAuthoritativeBaseConfig(plugin, basePath, config);
    });
}

function schedulePersistLiveLayout(
    state: NativeBaseEmbedState,
    patch?: Partial<ViewLayoutSnapshot> | null,
): void {
    if (!state.plugin || !state.basePath || !state.categoryId || !state.liveView) return;
    state.lastLayoutAt = Date.now();
    const revision = markLayoutRevision(state);
    if (revision == null) return;
    if (patch) state.pendingLayout = { ...(state.pendingLayout ?? {}), ...patch };
    const baseline = patch ? undefined : state.interactionSnapshot;
    if (state.persistTimer != null) window.clearTimeout(state.persistTimer);
    state.persistTimer = window.setTimeout(() => {
        void (async () => {
            state.persistTimer = null;
            if (!state.plugin || !state.basePath || !state.categoryId || !state.liveView) return;
            const pending = state.pendingLayout;
            state.pendingLayout = undefined;
            let snapshot = overlayPendingLayout(snapshotBasesViewLayout(state.liveView), pending);
            // Body-level Properties/Sort menus can repaint before their query data
            // settles. Wait briefly for a real layout delta; if none appears, this
            // was only a menu navigation click and must not write anything.
            if (!patch && baseline) {
                for (let attempt = 0; attempt < 12 && layoutSnapshotsEqual(snapshot, baseline); attempt++) {
                    await new Promise<void>(resolve => window.setTimeout(resolve, 100));
                    if (!state.liveView || !isLatestLayoutRevision(state.basePath, state.categoryId, revision)) return;
                    snapshot = snapshotBasesViewLayout(state.liveView);
                }
                if (layoutSnapshotsEqual(snapshot, baseline)) return;
            }
            await persistLayoutSnapshot(state.plugin, state.basePath, state.categoryId, snapshot, revision);
        })().catch(error => console.warn('[NarrativeLab] Failed to persist live Base layout:', error));
    }, 250);
}

function hookLiveBasesView(state: NativeBaseEmbedState, view: BasesViewLike): void {
    state.liveView = view;
    trackLiveEmbed(state);
    const config = view.config;
    const originalSet = config.set;
    if (originalSet) {
        config.set = (key: string, value: unknown) => {
            const patch = snapshotPatchForConfigSet(key, value);
            if (patch?.order) {
                const baseline = state.menuOrderBaseline;
                const accepted = state.menuOrderAccepted;
                // Obsidian 1.13 can emit the pre-click order after already
                // emitting and rendering the user's new Properties choice.
                // Do not let that late echo visually undo the same menu click.
                if (
                    baseline
                    && accepted
                    && !baseOrdersEquivalent(accepted, baseline)
                    && baseOrdersEquivalent(patch.order, baseline)
                ) {
                    return;
                }
                if (baseline && !accepted && !baseOrdersEquivalent(patch.order, baseline)) {
                    state.menuOrderAccepted = patch.order.slice();
                }
            }
            originalSet.call(config, key, value);
            if (patch) schedulePersistLiveLayout(state, patch);
        };
    }

    // Toolbar menus may update config without going through a patched set in
    // some Obsidian builds — also snapshot after Properties/Sort interactions.
    const host = state.child?.containerEl;
    const clearMenuOrderCaptures = () => {
        for (const timer of state.menuOrderCaptureTimers ?? []) window.clearTimeout(timer);
        state.menuOrderCaptureTimers = [];
    };
    const onHostPointerDown = () => {
        clearMenuOrderCaptures();
        state.menuOrderToken = (state.menuOrderToken ?? 0) + 1;
        state.menuOrderBaseline = undefined;
        state.menuOrderAccepted = undefined;
        state.menuOrderScheduledToken = undefined;
        state.lastInteractionAt = Date.now();
        if (state.liveView) state.interactionSnapshot = snapshotBasesViewLayout(state.liveView);
    };
    const isRecentBaseMenuEvent = (event: Event): boolean => {
        if (Date.now() - (state.lastInteractionAt ?? 0) > 60_000) return false;
        const target = event.target as HTMLElement | null;
        return !!target?.closest?.('.menu, .suggestion-container');
    };
    const onDocumentPointerDown = (event: Event) => {
        if (!isRecentBaseMenuEvent(event) || !state.liveView) return;
        clearMenuOrderCaptures();
        state.menuOrderToken = (state.menuOrderToken ?? 0) + 1;
        state.interactionSnapshot = snapshotBasesViewLayout(state.liveView);
        state.menuOrderBaseline = state.interactionSnapshot.order.slice();
        state.menuOrderAccepted = undefined;
        state.menuOrderScheduledToken = undefined;
    };
    const onDocumentPointerUp = (event: Event) => {
        if (!isRecentBaseMenuEvent(event) || !state.liveView) return;
        const token = state.menuOrderToken ?? 0;
        const baseline = state.menuOrderBaseline?.slice()
            ?? state.interactionSnapshot?.order.slice()
            ?? snapshotBasesViewLayout(state.liveView).order;
        const capture = () => {
            if (!state.liveView || state.menuOrderToken !== token) return;
            const order = snapshotBasesViewLayout(state.liveView).order;
            const accepted = state.menuOrderAccepted;
            if (accepted) {
                // Some Obsidian builds repaint query data without calling the
                // patched config.set(). Keep the first genuine user delta
                // pinned until the menu transaction and delayed echoes settle.
                if (!baseOrdersEquivalent(order, accepted)) {
                    originalSet?.call(config, 'order', accepted.slice());
                }
                if (state.menuOrderScheduledToken !== token) {
                    state.menuOrderScheduledToken = token;
                    schedulePersistLiveLayout(state, { order: accepted.slice() });
                }
                return;
            }
            if (baseOrdersEquivalent(order, baseline)) return;
            state.menuOrderAccepted = order.slice();
            state.menuOrderScheduledToken = token;
            schedulePersistLiveLayout(state, { order: order.slice() });
        };

        // Probe through the delayed Base echo window. Once a genuine delta is
        // captured, later probes actively restore it if query data regresses.
        clearMenuOrderCaptures();
        state.menuOrderCaptureTimers = [0, 16, 50, 120, 250, 450, 800].map(delay => (
            window.setTimeout(capture, delay)
        ));
        schedulePersistLiveLayout(state);
    };
    host?.addEventListener('pointerdown', onHostPointerDown, true);
    activeDocument.addEventListener('pointerdown', onDocumentPointerDown, true);
    activeDocument.addEventListener('pointerup', onDocumentPointerUp, true);

    state.unhook = () => {
        config.set = originalSet;
        host?.removeEventListener('pointerdown', onHostPointerDown, true);
        activeDocument.removeEventListener('pointerdown', onDocumentPointerDown, true);
        activeDocument.removeEventListener('pointerup', onDocumentPointerUp, true);
        clearMenuOrderCaptures();
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
    const revision = state.layoutRevision;
    if (revision == null || !isLatestLayoutRevision(state.basePath, state.categoryId, revision)) return;
    if (state.persistTimer != null) {
        window.clearTimeout(state.persistTimer);
        state.persistTimer = null;
    }
    const pending = state.pendingLayout;
    state.pendingLayout = undefined;
    const snapshot = overlayPendingLayout(snapshotBasesViewLayout(state.liveView), pending);
    await persistLayoutSnapshot(state.plugin, state.basePath, state.categoryId, snapshot, revision);
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

function getProfileTableOrder(categoryId: string): string[] | null {
    const layouts = categoryId === 'characters'
        ? [getLibraryProfilePropertyOrder('character')]
        : categoryId === 'locations'
            ? [getLibraryProfilePropertyOrder('world'), getLibraryProfilePropertyOrder('location')]
            : [getLibraryProfilePropertyOrder(categoryId)];
    if (layouts.every(layout => !layout)) return null;
    const result = ['file.name'];
    const seen = new Set(result);
    for (const layout of layouts) {
        for (const key of layout?.visibleKeys ?? []) {
            const propertyId = key === 'name' ? 'file.name' : `note.${key}`;
            if (seen.has(propertyId)) continue;
            seen.add(propertyId);
            result.push(propertyId);
        }
    }
    return result;
}

function getProfileManagedPropertyIds(categoryId: string): Set<string> {
    const layouts = categoryId === 'characters'
        ? [getLibraryProfilePropertyOrder('character')]
        : categoryId === 'locations'
            ? [getLibraryProfilePropertyOrder('world'), getLibraryProfilePropertyOrder('location')]
            : [getLibraryProfilePropertyOrder(categoryId)];
    // `file.name` is mandatory in the profile editor but remains optional as
    // a Base column, so it deliberately uses the Base-only hidden list below.
    const result = new Set<string>();
    for (const layout of layouts) {
        for (const propertyKey of Object.keys(layout?.visibilityKeys ?? {})) {
            if (propertyKey !== 'name') result.add(`note.${propertyKey}`);
        }
    }
    return result;
}

/**
 * Track Base-only visibility for custom/top-level properties that have no
 * hiddenFields key. Built-in and universal fields are handled by the shared
 * profile layout; custom fields remain recoverable from Base Properties.
 */
function updateBaseHiddenCustomProperties(
    view: BaseViewConfig,
    snapshotOrder: readonly string[],
    profileOrder: readonly string[],
    managedPropertyIds: ReadonlySet<string>,
): boolean {
    const visible = new Set(snapshotOrder);
    const hidden = getBaseHiddenCustomProperties(view);
    const profileProperties = new Set(profileOrder);
    let dirty = false;
    for (const propertyId of profileOrder) {
        if (managedPropertyIds.has(propertyId)) continue;
        if (visible.has(propertyId)) {
            if (hidden.delete(propertyId)) dirty = true;
        } else if (!hidden.has(propertyId)) {
            hidden.add(propertyId);
            dirty = true;
        }
    }
    for (const propertyId of [...hidden]) {
        if (!profileProperties.has(propertyId)) {
            hidden.delete(propertyId);
            dirty = true;
        }
    }
    const next = [...hidden];
    if (next.length === 0) {
        if (view[VIEW_HIDDEN_CUSTOM_PROPERTIES_KEY] !== undefined) {
            delete view[VIEW_HIDDEN_CUSTOM_PROPERTIES_KEY];
            dirty = true;
        }
    } else if (!stringArrayEqual(view[VIEW_HIDDEN_CUSTOM_PROPERTIES_KEY], next)) {
        view[VIEW_HIDDEN_CUSTOM_PROPERTIES_KEY] = next;
        dirty = true;
    }
    return dirty;
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
    const profileOrder = getProfileTableOrder(categoryId);
    const label = getNativeBaseDisplayLabel(plugin, categoryId);
    const views = getViews(config);
    let view = findViewForCategory(views, categoryId);
    let dirty = false;

    if (!view) {
        view = {
            type: 'table',
            name: label,
            [VIEW_CATEGORY_KEY]: categoryId,
            order: profileOrder ?? extractTableOrder(options?.seedFromLegacy ?? null, discovered),
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
            view.order = profileOrder ?? extractTableOrder(null, discovered);
            dirty = true;
        } else if (profileOrder) {
            const order = effectiveProfileOrder(view, profileOrder);
            if (!stringArrayEqual(view.order, order)) {
                view.order = order;
                dirty = true;
            }
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

/** Open the canonical Base file at the requested category's native view. */
export async function openNativeLibraryBase(
    plugin: SceneCardsPlugin,
    categoryId: string,
): Promise<boolean> {
    try {
        const resolved = await ensureNativeBase(plugin, categoryId);
        if (!resolved) {
            new Notice(t('No active project'));
            return false;
        }
        const viewName = getNativeBaseDisplayLabel(plugin, categoryId);
        // Obsidian's documented Base deep-link form is File.base#View.
        await plugin.app.workspace.openLinkText(
            `${resolved.basePath}#${viewName}`,
            '',
            true,
        );
        return true;
    } catch (error) {
        console.error('[NarrativeLab] Failed to open native Library Base:', error);
        new Notice(t('Failed to open Base'));
        return false;
    }
}

/** Compact far-right action shared by every Library profile/browse row. */
export function renderOpenNativeLibraryBaseAction(
    parent: HTMLElement,
    plugin: SceneCardsPlugin,
    categoryId: string,
): HTMLButtonElement {
    const label = t('Open in Obsidian Base');
    const button = parent.createEl('button', {
        cls: 'clickable-icon library-open-native-base',
        attr: { type: 'button', 'aria-label': label },
    });
    setIcon(button, 'database');
    attachTooltip(button, label);
    button.addEventListener('click', () => {
        void openNativeLibraryBase(plugin, categoryId);
    });
    return button;
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
    const project = plugin.sceneManager.activeProject;
    if (!project || !plugin.capabilityService.isEnabled('library', project)) return;
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
    const project = plugin.sceneManager.activeProject;
    if (!project || !plugin.capabilityService.isEnabled('library', project)) return;
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
    onNew: (event: MouseEvent | PointerEvent) => void,
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
    state.newNoteUnhook = wireNativeBaseNewAction(host, onNew);
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
