/* eslint-disable @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-argument, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-return, @typescript-eslint/no-floating-promises, @typescript-eslint/no-misused-promises, @typescript-eslint/no-unnecessary-type-assertion, @typescript-eslint/no-redundant-type-constituents, @typescript-eslint/no-unused-vars, no-unused-vars, no-useless-escape, no-control-regex, no-empty -- Obsidian's API surface and several untyped third-party libraries force dynamic dispatch; floating promises are intentional in DOM/event handlers; matching enable at end of file */
import { StoryLineProject, ProjectDraft, deriveProjectFolders, deriveProjectFoldersFromFilePath, DEFAULT_ATTACHMENT_FOLDER, DEFAULT_CANVAS_FOLDER } from '../models/StoryLineProject';
import { MetadataParser, setWordcountLocale, setSceneTitleToStemMap } from './MetadataParser';
import { normalizeStoryLineLocale, resolveLocale, DEFAULT_STORYLINE_LOCALE, AUTO_DETECT_LOCALE, type StoryLineLocale } from '../utils/locale';
import { UndoManager } from './UndoManager';
import { SceneQueryService, ISceneStore } from './SceneQueryService';
import { formatActChapterPrefix, sanitizeActChapterForPath, compareActChapter } from '../utils/actChapter';
import type SceneCardsPlugin from '../main';
import { App, Notice, TFile, TFolder, normalizePath, parseYaml, stringifyYaml } from 'obsidian';
import { BeatSheetTemplate, FilterPreset, Scene, SceneStatus, getStatusOrder } from '../models/Scene';

/**
 * Normalize a frontmatter `acts` / `chapters` value into a clean sorted
 * number array. Accepts arrays, single numbers, or comma-separated strings
 * (which can appear after a sync conflict mangles the YAML). Issue #176.
 */
function normalizeProjectDrafts(raw: unknown): ProjectDraft[] | undefined {
    if (!Array.isArray(raw) || raw.length === 0) return undefined;
    const drafts: ProjectDraft[] = [];
    for (const entry of raw) {
        if (!entry || typeof entry !== 'object') continue;
        const obj = entry as Record<string, unknown>;
        const id = typeof obj.id === 'string' && obj.id.trim() ? obj.id.trim() : `draft-${drafts.length + 1}`;
        const title = typeof obj.title === 'string' && obj.title.trim() ? obj.title.trim() : 'Draft';
        const folderRaw = obj.folder ?? obj.folderName;
        const folder = typeof folderRaw === 'string' && folderRaw.trim() ? folderRaw.trim() : undefined;
        const scenesRaw = obj.scenes ?? obj.scenePaths;
        let scenePaths: string[] | undefined;
        if (Array.isArray(scenesRaw)) {
            scenePaths = scenesRaw.map(s => String(s)).filter(Boolean);
            if (scenePaths.length === 0) scenePaths = undefined;
        }
        drafts.push({ id, title, folder, scenePaths });
    }
    return drafts.length > 0 ? drafts : undefined;
}

function normalizeActChapterList(raw: unknown): number[] {
    if (raw == null) return [];
    let arr: unknown[] = [];
    if (Array.isArray(raw)) {
        arr = raw;
    } else if (typeof raw === 'number' && Number.isFinite(raw)) {
        arr = [raw];
    } else if (typeof raw === 'string') {
        // Tolerate "1,2,3" or "1 - 5" style strings from corrupted frontmatter.
        const rangeMatch = raw.match(/^(\d+)\s*-\s*(\d+)$/);
        if (rangeMatch) {
            const lo = parseInt(rangeMatch[1], 10);
            const hi = parseInt(rangeMatch[2], 10);
            for (let i = Math.min(lo, hi); i <= Math.max(lo, hi); i++) arr.push(i);
        } else {
            arr = raw.split(',').map(s => s.trim());
        }
    } else {
        return [];
    }
    const nums = arr
        .map(v => Number(v))
        .filter(n => Number.isFinite(n))
        .map(n => Math.trunc(n));
    return Array.from(new Set(nums)).sort((a, b) => a - b);
}

/** Normalize project frontmatter `libraryFolders` map (id → folder basename). */
function normalizeLibraryFoldersMap(raw: unknown): Record<string, string> {
    if (!raw || typeof raw !== 'object') return {};
    const out: Record<string, string> = {};
    for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
        const id = String(k || '').trim();
        const name = String(v ?? '').trim().replace(/[\\/:*?"<>|]/g, '-');
        if (id && name) out[id] = name;
    }
    return out;
}

/**
 * Manages CRUD operations, indexing, and project management for scenes.
 *
 * Query/filter/sort/statistics logic is delegated to SceneQueryService.
 * SceneManager implements ISceneStore to provide read-only scene access.
 */
export class SceneManager implements ISceneStore {
    private app: App;
    private plugin: SceneCardsPlugin;
    private scenes: Map<string, Scene> = new Map();
    private projects: Map<string, StoryLineProject> = new Map();
    private initialized = false;
    private initializePromise: Promise<void> | null = null;
    private _activeProject: StoryLineProject | null = null;
    /** Serialize project.md writes — concurrent vault.modify races cause Windows UNKNOWN open errors. */
    private _projectFrontmatterWrite: Promise<void> = Promise.resolve();
    /** Paths currently being adopted as Notes/ corkboard files (re-entrancy guard). */
    private adoptingNotes = new Set<string>();
    public undoManager: UndoManager;
    /** Read-only query service for filtering, sorting, aggregation */
    public readonly queryService: SceneQueryService;
    /** Monotonically increasing version — bumped on every scene mutation */
    private _cacheVersion = 0;
    get cacheVersion(): number { return this._cacheVersion; }
    /** Secondary index: tag → set of filePaths */
    private _tagIndex: Map<string, Set<string>> = new Map();
    /** Secondary index: plotline/tag list for fast reverse lookup */
    getScenesByTag(tag: string): Scene[] {
        const paths = this._tagIndex.get(tag);
        if (!paths) return [];
        const result: Scene[] = [];
        for (const p of paths) {
            const s = this.scenes.get(p);
            if (s) result.push(s);
        }
        return result;
    }
    /** Bump version and rebuild tag index for a single scene */
    private bumpVersion(filePath?: string): void {
        this._cacheVersion++;
        if (filePath) {
            // Remove old tag entries for this path
            for (const [, paths] of this._tagIndex) paths.delete(filePath);
            // Re-add from current scene
            const scene = this.scenes.get(filePath);
            if (scene?.tags) {
                for (const t of scene.tags) {
                    let set = this._tagIndex.get(t);
                    if (!set) { set = new Set(); this._tagIndex.set(t, set); }
                    set.add(filePath);
                }
            }
        } else {
            // Full rebuild (used after initialize/clear)
            this._tagIndex.clear();
            for (const [fp, scene] of this.scenes) {
                if (scene.tags) {
                    for (const t of scene.tags) {
                        let set = this._tagIndex.get(t);
                        if (!set) { set = new Set(); this._tagIndex.set(t, set); }
                        set.add(fp);
                    }
                }
            }
        }
    }

    constructor(app: App, plugin: SceneCardsPlugin) {
        this.app = app;
        this.plugin = plugin;
        this.undoManager = new UndoManager(app);
        this.queryService = new SceneQueryService(this);
    }

    // ── ISceneStore implementation ─────────────────────────

    /** Raw iterator over all scenes (for ISceneStore) */
    sceneValues(): Iterable<Scene> {
        return this.scenes.values();
    }

    // ────────────────────────────────────
    //  Project management
    // ────────────────────────────────────

    /** Get all discovered projects */
    getProjects(): StoryLineProject[] {
        return Array.from(this.projects.values());
    }

    /** Get the currently active project (may be null) */
    get activeProject(): StoryLineProject | null {
        return this._activeProject;
    }

    /**
     * Temporarily point `activeProject` at another project without a full
     * switch (no save/reload). Used by one-shot migrations that resolve paths
     * via the active project helpers.
     */
    async withActiveProject<T>(
        project: StoryLineProject | null,
        fn: () => Promise<T>,
    ): Promise<T> {
        const previous = this._activeProject;
        this._activeProject = project;
        try {
            return await fn();
        } finally {
            this._activeProject = previous;
        }
    }

    /** Computed scene folder for the active project (falls back to derived default) */
    getSceneFolder(): string {
        if (this._activeProject) return this._activeProject.sceneFolder;
        const root = this.plugin.settings.storyLineRoot;
        return root ? `${root}/Scenes` : 'Scenes';
    }

    /**
     * Vault-relative project root folder for the active project.
     */
    getProjectBaseFolder(): string {
        if (this._activeProject) {
            return deriveProjectFoldersFromFilePath(this._activeProject.filePath).baseFolder;
        }
        return this.plugin.settings.storyLineRoot || '';
    }

    /** Computed Canvas/ (.ncanvas) folder at the active project root. */
    getCanvasFolder(): string {
        const base = this.getProjectBaseFolder();
        return base ? `${base}/${DEFAULT_CANVAS_FOLDER}` : DEFAULT_CANVAS_FOLDER;
    }

    /**
     * Computed attachment folder for the active project.
     * Uses the plugin setting `projectAttachmentFolder` (default Attachments).
     */
    getAttachmentFolder(): string {
        const base = this.getProjectBaseFolder();
        const folderName = (this.plugin.settings.projectAttachmentFolder || DEFAULT_ATTACHMENT_FOLDER)
            .trim()
            .replace(/^\/+|\/+$/g, '') || DEFAULT_ATTACHMENT_FOLDER;
        return base ? normalizePath(`${base}/${folderName}`) : folderName;
    }

    /**
     * Path passed to Obsidian when resolving attachment imports for the active project.
     * Points at the configured project attachment folder, not the scene subfolder.
     */
    getAttachmentSourcePath(): string {
        const attachmentFolder = this.getAttachmentFolder();
        if (attachmentFolder) return attachmentFolder;
        return this._activeProject?.filePath || this.getSceneFolder();
    }

    /**
     * Per-category Library attachment folder: Library/<Category>/Attachments.
     * Used for character/location/codex portraits; scene attachments stay at project root.
     */
    getLibraryAttachmentFolder(categoryId: string): string {
        const folderName = this.getLibraryFolderName(categoryId);
        const libraryRoot = this.getCodexFolder();
        return normalizePath(`${libraryRoot}/${folderName}/${DEFAULT_ATTACHMENT_FOLDER}`);
    }

    /**
     * Library tab id → folder basename (=== tab label).
     * Falls back to project.libraryFolders, then custom label, then defaults.
     */
    getLibraryFolderName(categoryId: string): string {
        const fromProject = this._activeProject?.libraryFolders?.[categoryId]?.trim();
        if (fromProject) return fromProject;
        const custom = this.plugin.settings.codexCustomCategories?.find(c => c.id === categoryId);
        if (custom?.label?.trim()) return custom.label.trim();
        const defaults: Record<string, string> = {
            characters: 'Characters',
            locations: 'Locations',
            items: 'Items',
            creatures: 'Creatures',
            lore: 'Lore',
            organizations: 'Organizations',
            culture: 'Culture',
            systems: 'Systems',
        };
        return defaults[categoryId] || categoryId;
    }

    /** Computed character folder for the active project (series-aware) */
    getCharacterFolder(): string {
        const name = this.getLibraryFolderName('characters');
        if (this.getSeriesFolder()) {
            return normalizePath(`${this.getSeriesCodexFolder()}/${name}`);
        }
        if (this._activeProject) {
            return normalizePath(`${this._activeProject.codexFolder}/${name}`);
        }
        const root = this.plugin.settings.storyLineRoot;
        return normalizePath(root ? `${root}/Library/${name}` : `Library/${name}`);
    }

    /** Computed location folder for the active project (series-aware) */
    getLocationFolder(): string {
        const name = this.getLibraryFolderName('locations');
        if (this.getSeriesFolder()) {
            return normalizePath(`${this.getSeriesCodexFolder()}/${name}`);
        }
        if (this._activeProject) {
            return normalizePath(`${this._activeProject.codexFolder}/${name}`);
        }
        const root = this.plugin.settings.storyLineRoot;
        return normalizePath(root ? `${root}/Library/${name}` : `Library/${name}`);
    }

    /** Computed Library folder for the active project (series-aware) */
    getCodexFolder(): string {
        if (this.getSeriesFolder()) {
            return this.getSeriesCodexFolder();
        }
        if (this._activeProject) return this._activeProject.codexFolder;
        const root = this.plugin.settings.storyLineRoot;
        return root ? `${root}/Library` : 'Library';
    }

    /** Computed notes folder for the active project (corkboard sticky notes) */
    getNotesFolder(): string {
        if (this._activeProject) return this._activeProject.notesFolder;
        const root = this.plugin.settings.storyLineRoot;
        return root ? `${root}/Notes` : 'Notes';
    }

    /** Computed scene notes folder for the active project (external per-scene notes files) */
    getSceneNotesFolder(): string {
        if (this._activeProject) return this._activeProject.sceneNotesFolder;
        const root = this.plugin.settings.storyLineRoot;
        return root ? `${root}/SceneNotes` : 'SceneNotes';
    }

    /** Computed archive folder for the active project (cut / archived scenes) */
    getArchiveFolder(): string {
        if (this._activeProject) return this._activeProject.archiveFolder;
        const root = this.plugin.settings.storyLineRoot;
        return root ? `${root}/Archive` : 'Archive';
    }

    /**
     * Return the series-level Library folder (parent of book folder + `/Library`).
     * Only meaningful when the active project has a seriesId.
     */
    getSeriesCodexFolder(): string {
        if (this._activeProject) {
            const base = deriveProjectFoldersFromFilePath(this._activeProject.filePath).baseFolder;
            const parentDir = base.substring(0, base.lastIndexOf('/'));
            return normalizePath(`${parentDir}/Library`);
        }
        const root = this.plugin.settings.storyLineRoot;
        return root ? `${root}/Library` : 'Library';
    }

    /** Return a valid series folder for a project, ignoring orphaned frontmatter seriesId values. */
    getSeriesFolderForProject(project: StoryLineProject | null | undefined): string | null {
        if (!project?.seriesId) return null;
        const base = deriveProjectFoldersFromFilePath(project.filePath).baseFolder;
        const parent = base.substring(0, base.lastIndexOf('/'));
        if (!parent) return null;
        const metadataFile = this.app.vault.getAbstractFileByPath(normalizePath(`${parent}/series.json`));
        return metadataFile instanceof TFile ? parent : null;
    }

    /** Whether a project has both seriesId and a real parent series.json. */
    isProjectInValidSeries(project: StoryLineProject | null | undefined): boolean {
        return this.getSeriesFolderForProject(project) !== null;
    }

    /**
     * Return the validated series folder (parent of the active book folder).
     * A stale seriesId without series.json falls back to project-local folders.
     */
    getSeriesFolder(): string | null {
        return this.getSeriesFolderForProject(this._activeProject);
    }

    /**
     * Return the per-project Characters folder, regardless of series
     * redirection. Used by the Promote / Demote actions and by the
     * series-aware multi-folder scan so book-only characters can live
     * alongside series-shared ones.
     */
    getProjectLocalCharacterFolder(): string | null {
        if (!this._activeProject) return null;
        const name = this._activeProject.libraryFolders?.characters || 'Characters';
        return normalizePath(`${this._activeProject.codexFolder}/${name}`);
    }

    /**
     * Return the per-project Locations folder, regardless of series
     * redirection. See {@link getProjectLocalCharacterFolder}.
     */
    getProjectLocalLocationFolder(): string | null {
        if (!this._activeProject) return null;
        const name = this._activeProject.libraryFolders?.locations || 'Locations';
        return normalizePath(`${this._activeProject.codexFolder}/${name}`);
    }

    /**
     * Title of the active project — used as the "book name" for the
     * `books?: string[]` membership field on series-shared characters
     * and locations. Returns null when no project is active.
     */
    getCurrentBookTitle(): string | null {
        return this._activeProject?.title ?? null;
    }

    /**
     * Discover project manifests anywhere in the vault.
     * Both `type: narrative-lab` and legacy `type: storyline` are accepted.
     *
     * Uses the vault adapter (filesystem) API so that externally-created
     * files (e.g. sample projects, Dropbox-synced files) are discovered
     * even before Obsidian's vault index has caught up.
     */
    async scanProjects(): Promise<StoryLineProject[]> {
        this.projects.clear();
        const rootPath = this.plugin.settings.storyLineRoot;
        const adapter = this.app.vault.adapter;
        const isDiscardedPath = (path: string): boolean =>
            normalizePath(path).split('/').some(segment =>
                segment === '.trash' || segment === '.obsidian'
            );

        // Helper: try to parse a .md file at the given path as a project
        const tryParse = async (filePath: string) => {
            if (!filePath.endsWith('.md') || isDiscardedPath(filePath)) return;
            try {
                const content = await adapter.read(filePath);
                const project = this.parseProjectContent(content, filePath);
                if (project) {
                    await this.detectLegacyFolders(project);
                    this.projects.set(filePath, project);
                }
            } catch { /* file unreadable — skip */ }
        };

        // Recursively scan subfolders for project .md files
        // Supports: NarrativeLab/Project/Project.md AND NarrativeLab/Series/Book/Book.md
        const scanFolder = async (folderPath: string) => {
            try {
                const listing = await adapter.list(folderPath);
                for (const f of listing.files) {
                    await tryParse(f);
                }
                for (const sub of listing.folders) {
                    // Skip internal folders that never contain project files
                    const folderName = sub.split('/').pop() ?? '';
                    if (folderName.startsWith('.')
                        || ['System', 'Scenes', 'Characters', 'Locations', 'Library', 'Codex', 'Notes', 'Archive', 'Research', 'NCanvas', 'Canvas', 'Bases', 'Attachments', 'SceneNotes'].includes(folderName)) continue;
                    await scanFolder(sub);
                }
            } catch { /* folder unreadable — skip */ }
        };

        // The configured folder is only a creation default. Scan it directly
        // when present so freshly synced files are found before metadata indexing.
        if (rootPath && await adapter.exists(rootPath)) {
            const rootListing = await adapter.list(rootPath);
            for (const f of rootListing.files) await tryParse(f);
            for (const folder of rootListing.folders) {
                const folderName = folder.split('/').pop() ?? '';
                if (!folderName.startsWith('.') && folderName !== 'System') await scanFolder(folder);
            }
        }

        // ── Vault-wide discovery ──────────────────────────────────
        // Scan the entire vault index. Project location is deliberately
        // unrestricted; the manifest itself defines the project root.
        try {
            const allFiles = this.app.vault.getMarkdownFiles();
            for (const file of allFiles) {
                if (this.projects.has(file.path)) continue; // already found in root scan
                const cache = this.app.metadataCache.getFileCache(file);
                const type = cache?.frontmatter?.type;
                if (type === 'narrative-lab' || type === 'storyline') {
                    await tryParse(file.path);
                }
            }
        } catch { /* vault-wide scan is best-effort */ }

        // ── Saved-active-project fallback ──────────────────────────
        // Issue #207 — projects created in a custom vault folder (outside
        // storyLineRoot) can be missed by both the root scan and the
        // vault-wide metadataCache scan when the cache hasn't indexed the
        // newly-created file yet (common on mobile, with synced folders,
        // or immediately after creation). When a saved activeProjectFile
        // path exists on disk but wasn't picked up, read it directly and
        // parse it from its file contents — bypassing the metadata cache
        // entirely — so the project is never orphaned on reload.
        const savedPath = this.plugin.settings.activeProjectFile;
        if (savedPath && !isDiscardedPath(savedPath) && !this.projects.has(savedPath)) {
            try {
                if (await this.app.vault.adapter.exists(savedPath)) {
                    const content = await this.app.vault.adapter.read(savedPath);
                    const project = this.parseProjectContent(content, savedPath);
                    if (project) {
                        await this.detectLegacyFolders(project);
                        this.projects.set(savedPath, project);
                    }
                }
            } catch { /* file unreadable or missing — skip */ }
        }

        // Restore active project from settings
        if (savedPath && this.projects.has(savedPath)) {
            this._activeProject = this.projects.get(savedPath)!;
        } else if (this.projects.size > 0) {
            // Default to first project found
            this._activeProject = this.projects.values().next().value ?? null;
            if (this._activeProject) {
                this.plugin.settings.activeProjectFile = this._activeProject.filePath;
                // Persist only the activeProjectFile — avoid a full saveSettings()
                // here because it strips per-project keys from data.json before
                // the migration code has had a chance to move them to System/ files.
                await this.plugin.saveData(this.plugin.settings);
            }
        }

        // Propagate the active project's language to wordcount tokenisation.
        this.applyActiveProjectLocale();

        return this.getProjects();
    }

    /**
     * Push the active project's `locale` to module-level word-count state so
     * `MetadataParser.countWords` tokenises with the right script profile.
     * Falls back to the global default-language setting, then English.
     */
    public getEffectiveLocale(sampleText = ''): StoryLineLocale {
        const projectLocale = this._activeProject?.locale;
        const settingsDefault = (this.plugin.settings as { defaultProjectLanguage?: string }).defaultProjectLanguage;
        const stored = projectLocale ?? settingsDefault ?? DEFAULT_STORYLINE_LOCALE;
        if (stored === AUTO_DETECT_LOCALE) {
            const sample = sampleText || this._activeProject?.description || '';
            return sample ? resolveLocale(stored, sample, DEFAULT_STORYLINE_LOCALE) : AUTO_DETECT_LOCALE;
        }
        return normalizeStoryLineLocale(stored);
    }

    private applyActiveProjectLocale(): void {
        const projectLocale = this._activeProject?.locale;
        const settingsDefault = (this.plugin.settings as { defaultProjectLanguage?: string }).defaultProjectLanguage;
        const stored = projectLocale ?? settingsDefault ?? DEFAULT_STORYLINE_LOCALE;
        setWordcountLocale(normalizeStoryLineLocale(stored));
    }

    /**
     * Create a new NarrativeLab project
     */
    async createProject(title: string, description = '', customBasePath?: string): Promise<StoryLineProject> {
        const rootPath = normalizePath(customBasePath ?? this.plugin.settings.storyLineRoot ?? '');
        if (rootPath) await this.ensureFolder(rootPath);

        const safeName = title.replace(/[\\/:*?"<>|]/g, '-');
        const baseFolder = normalizePath([rootPath, safeName].filter(Boolean).join('/'));
        const filePath = normalizePath(`${baseFolder}/${safeName}.md`);

        const folders = deriveProjectFolders(rootPath, safeName);
        const now = new Date().toISOString().split('T')[0];

        const defaultLang = (this.plugin.settings as { defaultProjectLanguage?: string }).defaultProjectLanguage ?? DEFAULT_STORYLINE_LOCALE;
        const projectLocale = normalizeStoryLineLocale(defaultLang);

        const libraryFolders: Record<string, string> = {
            characters: 'Characters',
            locations: 'Locations',
        };
        for (const id of this.plugin.settings.codexEnabledCategories || []) {
            const custom = this.plugin.settings.codexCustomCategories?.find(c => c.id === id);
            if (custom?.label) libraryFolders[id] = custom.label;
            else if (id === 'items') libraryFolders[id] = 'Items';
            else if (id === 'creatures') libraryFolders[id] = 'Creatures';
            else if (id === 'lore') libraryFolders[id] = 'Lore';
            else if (id === 'organizations') libraryFolders[id] = 'Organizations';
            else if (id === 'culture') libraryFolders[id] = 'Culture';
            else if (id === 'systems') libraryFolders[id] = 'Systems';
            else libraryFolders[id] = id;
        }

        const frontmatter: Record<string, unknown> = {
            type: 'narrative-lab',
            title,
            created: now,
            language: projectLocale,
            drafts: [{ id: 'main', title: 'Primary draft' }],
            activeDraft: 'main',
            libraryFolders,
        };
        const content = `---\n${stringifyYaml(frontmatter)}---\n${description}\n`;

        try {
            // Create base project folder first
            await this.ensureFolder(baseFolder);

            // Create project file inside the folder
            await this.app.vault.create(filePath, content);

            // Default Library tabs (special + enabled categories) — folders
            // match tab labels and can be renamed later.
            const libraryFolder = normalizePath(folders.codexFolder);
            await this.ensureFolder(libraryFolder);
            for (const folderName of Object.values(libraryFolders)) {
                const categoryFolder = normalizePath(`${libraryFolder}/${folderName}`);
                await this.ensureFolder(categoryFolder);
                await this.ensureFolder(normalizePath(`${categoryFolder}/${DEFAULT_ATTACHMENT_FOLDER}`));
            }

            // Create System folder for project data files
            const systemFolder = normalizePath(`${baseFolder}/System`);
            await this.ensureFolder(systemFolder);

            // Authored content folders at project root (not under System/)
            await this.ensureFolder(normalizePath(folders.basesFolder));
            await this.ensureFolder(normalizePath(folders.canvasFolder));

            // Create default data files inside System/
            const viewFiles = ['plotgrid.json', 'timeline.json', 'board.json', 'plotlines.json', 'stats.json', 'characters.json'];
            const createdFiles: string[] = [];
            const updatedFiles: string[] = [];
            for (const vf of viewFiles) {
                const vfPath = normalizePath(`${systemFolder}/${vf}`);
                const contents = JSON.stringify({}, null, 2);
                const existing = this.app.vault.getAbstractFileByPath(vfPath) as TFile | null;
                if (!existing) {
                    await this.app.vault.create(vfPath, contents);
                    createdFiles.push(vfPath);
                } else {
                    try {
                        await this.app.vault.modify(existing, contents);
                        updatedFiles.push(vfPath);
                    } catch {
                        // If modify fails (rare), ignore and continue
                    }
                }
            }

            const project: StoryLineProject = {
                filePath,
                title,
                created: now,
                description,
                locale: projectLocale,
                ...folders,
                characterFolder: normalizePath(`${folders.codexFolder}/${libraryFolders.characters}`),
                locationFolder: normalizePath(`${folders.codexFolder}/${libraryFolders.locations}`),
                libraryFolders,
                definedActs: [],
                definedChapters: [],
                actLabels: {},
                chapterLabels: {},
                actDescriptions: {},
                chapterDescriptions: {},
                filterPresets: [],
                plotlines: [],
                corkboardPositions: {},
                drafts: [{ id: 'main', title: 'Primary draft' }],
                activeDraftId: 'main',
            };

            this.projects.set(filePath, project);
            new Notice(`Project "${title}" created`);
            return project;
        } catch (err) {
            new Notice('Failed to create project file or folders: ' + String(err));
            throw err;
        }
    }

    /**
     * Switch to a different active project and re-index scenes.
     */
    async setActiveProject(project: StoryLineProject): Promise<void> {
        // Save per-project data for the previous project before switching
        await this.plugin.saveProjectSystemData();

        this._activeProject = project;
        this.plugin.settings.activeProjectFile = project.filePath;
        this.applyActiveProjectLocale();

        // Load per-project data from the new project's System/ folder BEFORE
        // saveSettings (which also calls saveProjectSystemData — with the new
        // project's data already loaded this is a harmless round-trip).
        await this.plugin.loadProjectSystemData();
        // Reload universal field templates for the new project
        await this.plugin.fieldTemplates.load();
        await this.loadCorkboardPositions();
        await this.plugin.saveSettings();
        await this.initialize();
        await this.migrateDraftFoldersIfNeeded();
        await this.reconcileDraftFolders();
        // Ensure Bases/ sits at project root (not System/ or Library/)
        try {
            const { migrateNativeLibraryBasesForActiveProject } = await import('../components/NativeLibraryBase');
            await migrateNativeLibraryBasesForActiveProject(this.plugin);
        } catch { /* non-fatal */ }
        await this.plugin.plotlineManager.ensureSeeded();
        await this.plugin.syncNarrativeCanvasToActiveProject();
        // Ask the plugin to refresh any open NarrativeLab views so the UI updates
        try {
            if (this.plugin && typeof this.plugin.refreshOpenViews === 'function') {
                this.plugin.refreshOpenViews();
            }
        } catch (e) {
            // non-fatal; UI may refresh on next file event
        }
    }

    /**
     * Rename a project: renames the .md file, the project folder, updates
     * frontmatter title, and series.json bookOrder if applicable.
     * Uses fileManager.renameFile() so all vault links stay valid.
     */
    async renameProject(project: StoryLineProject, newTitle: string): Promise<StoryLineProject> {
        const safeName = newTitle.replace(/[\\/:*?"<>|]/g, '-');
        const folders = deriveProjectFoldersFromFilePath(project.filePath);
        const oldBaseFolder = folders.baseFolder;
        const parentDir = oldBaseFolder.substring(0, oldBaseFolder.lastIndexOf('/'));
        const newBaseFolder = normalizePath(`${parentDir}/${safeName}`);
        const newFilePath = normalizePath(`${newBaseFolder}/${safeName}.md`);

        // Rename the project folder first (moves everything inside it)
        if (normalizePath(oldBaseFolder) !== newBaseFolder) {
            const folderFile = this.app.vault.getAbstractFileByPath(oldBaseFolder);
            if (folderFile) {
                await this.app.fileManager.renameFile(folderFile, newBaseFolder);
            }
        }

        // Rename the project .md file inside the folder
        const oldFileInNewFolder = normalizePath(`${newBaseFolder}/${oldBaseFolder.split('/').pop()}.md`);
        if (normalizePath(oldFileInNewFolder) !== newFilePath) {
            const mdFile = this.app.vault.getAbstractFileByPath(oldFileInNewFolder);
            if (mdFile) {
                await this.app.fileManager.renameFile(mdFile, newFilePath);
            }
        }

        // Remove old project entry and add new one
        this.projects.delete(project.filePath);
        project.filePath = newFilePath;
        project.title = newTitle;
        // Re-derive folder paths
        const newFolders = deriveProjectFoldersFromFilePath(newFilePath);
        project.sceneFolder = newFolders.sceneFolder;
        project.characterFolder = newFolders.characterFolder;
        project.locationFolder = newFolders.locationFolder;
        project.codexFolder = newFolders.codexFolder;
        project.notesFolder = newFolders.notesFolder;
        project.archiveFolder = newFolders.archiveFolder;
        this.projects.set(newFilePath, project);

        // Update frontmatter
        await this.saveProjectFrontmatter(project);

        // If this was the active project, update settings
        if (this._activeProject?.filePath === newFilePath || this.plugin.settings.activeProjectFile === project.filePath) {
            this._activeProject = project;
            this.plugin.settings.activeProjectFile = newFilePath;
            await this.plugin.saveSettings();
        }

        // If in a series, update bookOrder in series.json
        if (project.seriesId) {
            const seriesFolder = this.getSeriesFolder();
            if (seriesFolder) {
                const meta = await this.plugin.seriesManager.loadSeriesMetadata(seriesFolder);
                if (meta) {
                    const oldName = oldBaseFolder.split('/').pop() ?? '';
                    const idx = meta.bookOrder.indexOf(oldName);
                    if (idx !== -1) {
                        meta.bookOrder[idx] = safeName;
                        await this.plugin.seriesManager.saveSeriesMetadata(seriesFolder, meta);
                    }
                }
            }
        }

        return project;
    }

    /**
     * Delete a project and its entire folder from the vault.
     *
     * - Trashes the project's base folder via Obsidian's `fileManager.trashFile()`
     *   so the user's "Deleted files" setting is respected (system trash vs. `.trash`).
     * - Removes the project from any series it belongs to (updates `series.json`).
     * - Clears `activeProjectFile` if the deleted project was active and switches
     *   to another project when one is available.
     * - Re-scans so the in-memory project map stays in sync.
     *
     * Returns `true` if the project was deleted, `false` if it could not be found.
     */
    async deleteProject(project: StoryLineProject): Promise<boolean> {
        const filePath = normalizePath(project.filePath);
        if (!this.projects.has(filePath)) {
            new Notice(`Project "${project.title}" was not found. It may have already been deleted.`);
            return false;
        }

        const folders = deriveProjectFoldersFromFilePath(filePath);
        const baseFolder = normalizePath(folders.baseFolder);

        // ── Remove from series metadata (if applicable) ──────────────
        if (project.seriesId) {
            // Series folder is the parent of the book's base folder.
            const seriesFolder = baseFolder.substring(0, baseFolder.lastIndexOf('/'));
            const meta = await this.plugin.seriesManager.loadSeriesMetadata(seriesFolder);
            if (meta) {
                const bookBaseName = baseFolder.split('/').pop() ?? '';
                meta.bookOrder = meta.bookOrder.filter(b => b !== bookBaseName);
                await this.plugin.seriesManager.saveSeriesMetadata(seriesFolder, meta);
            }
        }

        // ── Trash the project folder (and everything inside) ─────────
        // `fileManager.trashFile()` accepts a TFile or TFolder and recursively
        // trashes all children. It respects the user's "Deleted files" setting
        // (Settings → Files & Links → Deleted files).
        const folderEntry = this.app.vault.getAbstractFileByPath(baseFolder);
        if (folderEntry) {
            await this.app.fileManager.trashFile(folderEntry);
        } else {
            // Folder entry not found — try to trash the .md file directly
            // so the project stops being discovered by the vault-wide scan.
            const mdEntry = this.app.vault.getAbstractFileByPath(filePath);
            if (mdEntry) {
                await this.app.fileManager.trashFile(mdEntry);
            }
        }

        // ── Update in-memory state ───────────────────────────────────
        this.projects.delete(filePath);

        // If the deleted project was active, pick a replacement
        const wasActive = this._activeProject?.filePath === filePath;
        if (wasActive) {
            const remaining = this.getProjects();
            if (remaining.length > 0) {
                await this.setActiveProject(remaining[0]);
            } else {
                this._activeProject = null;
                this.plugin.settings.activeProjectFile = '';
                await this.plugin.saveSettings();
            }
        }

        // Re-scan to make sure the project map is fully in sync (handles
        // any stray files that may have been left behind).
        await this.scanProjects();

        new Notice(`Project "${project.title}" deleted.`);
        return true;
    }

    /**
     * Duplicate an existing project (fork a variant).
     */
    async forkProject(source: StoryLineProject, newTitle: string): Promise<StoryLineProject> {
        const newProject = await this.createProject(newTitle, source.description);

        // Copy all scene files from source to new project
        const sourceFolder = this.app.vault.getAbstractFileByPath(source.sceneFolder);
        if (sourceFolder && sourceFolder instanceof TFolder) {
            for (const child of sourceFolder.children) {
                if (child instanceof TFile && child.extension === 'md') {
                    const content = await this.app.vault.read(child);
                    const newPath = normalizePath(`${newProject.sceneFolder}/${child.name}`);
                    await this.app.vault.create(newPath, content);
                }
            }
        }

        // Copy all note files from source to new project
        const sourceNotesFolder = this.app.vault.getAbstractFileByPath(source.notesFolder);
        if (sourceNotesFolder && sourceNotesFolder instanceof TFolder) {
            for (const child of sourceNotesFolder.children) {
                if (child instanceof TFile && child.extension === 'md') {
                    const content = await this.app.vault.read(child);
                    const newPath = normalizePath(`${newProject.notesFolder}/${child.name}`);
                    await this.app.vault.create(newPath, content);
                }
            }
        }

        // Copy archived scenes from source to new project
        const sourceArchiveFolder = this.app.vault.getAbstractFileByPath(source.archiveFolder);
        if (sourceArchiveFolder && sourceArchiveFolder instanceof TFolder) {
            for (const child of sourceArchiveFolder.children) {
                if (child instanceof TFile && child.extension === 'md') {
                    const content = await this.app.vault.read(child);
                    const newPath = normalizePath(`${newProject.archiveFolder}/${child.name}`);
                    await this.app.vault.create(newPath, content);
                }
            }
        }

        const sceneCount = sourceFolder instanceof TFolder ? sourceFolder.children.filter(c => c instanceof TFile).length : 0;
        new Notice(`Forked "${source.title}" → "${newTitle}" (${sceneCount} scenes copied)`);
        return newProject;
    }
    /**
     * Parse raw markdown/YAML content as a NarrativeLab project.
     * Used by both TFile-based and adapter-based scanning.
     * Handles both LF and CRLF line endings.
     */
    private parseProjectContent(content: string, filePath: string): StoryLineProject | null {
        const fmMatch = content.match(/^---\r?\n([\s\S]*?)\r?\n---/);
        if (!fmMatch) return null;

        try {
            const fm = parseYaml(fmMatch[1]);
            if (fm?.type !== 'narrative-lab' && fm?.type !== 'storyline') return null;

            // Derive basename from file path (strip directory + extension)
            const basename = filePath.split('/').pop()?.replace(/\.md$/i, '') ?? filePath;
            const title = fm.title || basename;

            // Derive folders from the file's actual location (works for any vault path)
            const folders = deriveProjectFoldersFromFilePath(filePath);
            const libraryFolders = normalizeLibraryFoldersMap(fm.libraryFolders);
            const charSeg = libraryFolders.characters || 'Characters';
            const locSeg = libraryFolders.locations || 'Locations';

            return {
                filePath,
                title,
                created: fm.created || '',
                description: content.slice(fmMatch[0].length).trim(),
                // Issue: multi-language support — accept both `language:` (preferred)
                // and `storyline-locale:` (community PR #90 spelling) for forward/back compat.
                locale: (fm.language || fm['storyline-locale'])
                    ? normalizeStoryLineLocale(fm.language ?? fm['storyline-locale'])
                    : undefined,
                ...folders,
                characterFolder: normalizePath(`${folders.codexFolder}/${charSeg}`),
                locationFolder: normalizePath(`${folders.codexFolder}/${locSeg}`),
                libraryFolders: Object.keys(libraryFolders).length > 0 ? libraryFolders : undefined,
                definedActs: normalizeActChapterList(fm.acts),
                definedChapters: normalizeActChapterList(fm.chapters),
                actLabels: (fm.actLabels && typeof fm.actLabels === 'object') ? Object.fromEntries(Object.entries(fm.actLabels).map(([k, v]) => [Number(k), String(v)])) : {},
                chapterLabels: (fm.chapterLabels && typeof fm.chapterLabels === 'object') ? Object.fromEntries(Object.entries(fm.chapterLabels).map(([k, v]) => [Number(k), String(v)])) : {},
                actDescriptions: (fm.actDescriptions && typeof fm.actDescriptions === 'object') ? Object.fromEntries(Object.entries(fm.actDescriptions).map(([k, v]) => [Number(k), String(v)])) : {},
                chapterDescriptions: (fm.chapterDescriptions && typeof fm.chapterDescriptions === 'object') ? Object.fromEntries(Object.entries(fm.chapterDescriptions).map(([k, v]) => [Number(k), String(v)])) : {},
                filterPresets: Array.isArray(fm.filterPresets) ? fm.filterPresets : [],
                plotlines: Array.isArray(fm.plotlines)
                    ? [...new Set((fm.plotlines as unknown[])
                        .map((value: unknown) => String(value).trim())
                        .filter(Boolean))]
                    : [],
                corkboardPositions: {},
                seriesId: fm.seriesId || undefined,
                coverImage: fm.coverImage || undefined,
                activeBeatSheet: fm.activeBeatSheet || undefined,
                drafts: normalizeProjectDrafts(fm.drafts),
                activeDraftId: typeof fm.activeDraft === 'string' ? fm.activeDraft
                    : (typeof fm.activeDraftId === 'string' ? fm.activeDraftId : undefined),
            };
        } catch {
            return null;
        }
    }

    /**
     * Legacy detection for pre-NarrativeLab projects. Prefer Library, then
     * fall back to Codex, then to root-level Characters/Locations folders.
     */
    private async detectLegacyFolders(project: StoryLineProject): Promise<void> {
        const adapter = this.app.vault.adapter;
        const folders = deriveProjectFoldersFromFilePath(project.filePath);
        const legacyCodexFolder = normalizePath(`${folders.baseFolder}/Codex`);
        const legacyCharFolder = normalizePath(`${folders.baseFolder}/Characters`);
        const legacyLocFolder = normalizePath(`${folders.baseFolder}/Locations`);

        if (!await adapter.exists(project.codexFolder) && await adapter.exists(legacyCodexFolder)) {
            project.codexFolder = legacyCodexFolder;
            project.characterFolder = normalizePath(`${legacyCodexFolder}/Characters`);
            project.locationFolder = normalizePath(`${legacyCodexFolder}/Locations`);
        }
        if (!await adapter.exists(project.characterFolder) && await adapter.exists(legacyCharFolder)) {
            project.characterFolder = legacyCharFolder;
        }
        if (!await adapter.exists(project.locationFolder) && await adapter.exists(legacyLocFolder)) {
            project.locationFolder = legacyLocFolder;
        }
    }

    // ────────────────────────────────────
    //  Scene management
    // ────────────────────────────────────

    /**
     * Initialize: scan configured folders and build scene index.
     * Uses the vault adapter (filesystem) for reliable discovery of
     * externally-created or synced files.
     */
    async initialize(): Promise<void> {
        if (this.initializePromise) return this.initializePromise;
        this.initializePromise = (async () => {
            this.scenes.clear();
            const sceneFolder = this.getSceneFolder();
            await this.scanFolderAdapter(sceneFolder);
            const notesFolder = this.getNotesFolder();
            await this.scanFolderAdapter(notesFolder);
            this.initialized = true;
            this.bumpVersion();
        })().finally(() => {
            this.initializePromise = null;
        });
        return this.initializePromise;
    }

    /** Reuse the current scene index when it has already been initialized. */
    async ensureInitialized(): Promise<void> {
        if (this.initialized) return;
        await this.initialize();
    }

    /**
     * Add a single file from an external folder scan.
     * Returns true if the file was recognised as a scene.
     */
    addFile(content: string, filePath: string): boolean {
        if (this.scenes.has(filePath)) return false;
        if (filePath.includes('/_snapshots/')) return false; // issue #100 — snapshots aren't scenes
        const scene = MetadataParser.parseContent(content, filePath);
        if (scene) {
            this.scenes.set(filePath, scene);
            this.bumpVersion(filePath);
            return true;
        }
        return false;
    }

    /** True when `filePath` is inside `folder` (normalized prefix match). */
    private isPathUnderFolder(filePath: string, folder: string): boolean {
        const root = normalizePath(folder);
        const path = normalizePath(filePath);
        return path === root || path.startsWith(`${root}/`);
    }

    /**
     * Obsidian-native notes created under Notes/ have no `type: scene` frontmatter,
     * so the board ignores them. Adopt those files as corkboard notes (write the
     * required YAML once) so the Notes toggle can show them.
     */
    async ensureNotesFileIndexed(file: TFile): Promise<Scene | null> {
        if (file.extension !== 'md') return null;
        if (!this.isPathUnderFolder(file.path, this.getNotesFolder())) return null;
        if (file.path.includes('/_snapshots/')) return null;

        const path = normalizePath(file.path);
        if (this.adoptingNotes.has(path)) {
            return this.scenes.get(path) ?? null;
        }

        const content = await this.app.vault.read(file);
        const fm = MetadataParser.extractFrontmatter(content);
        // Don't hijack other entity types that happen to live under Notes/
        if (fm?.type && fm.type !== 'scene') return null;

        let scene = MetadataParser.parseContent(content, file.path);
        if (scene?.corkboardNote) {
            this.scenes.set(path, scene);
            this.bumpVersion(path);
            return scene;
        }

        this.adoptingNotes.add(path);
        try {
            const today = new Date().toISOString().split('T')[0];
            if (scene) {
                await MetadataParser.updateFrontmatter(this.app, file, { corkboardNote: true });
            } else {
                await MetadataParser.updateFrontmatter(this.app, file, {
                    type: 'scene',
                    title: String(fm?.title || file.basename),
                    status: ((fm?.status as Scene['status']) || 'idea'),
                    created: String(fm?.created || today),
                    corkboardNote: true,
                });
            }
            scene = await MetadataParser.parseFile(this.app, file);
            if (scene) {
                this.scenes.set(path, scene);
                this.bumpVersion(path);
            }
            return scene;
        } finally {
            this.adoptingNotes.delete(path);
        }
    }

    /**
     * Recursively scan a folder for scene files using the adapter API.
     *
     * Issue #100 — Files under any `_snapshots/` folder are version history
     * artifacts of scenes (see SnapshotManager); they must not be counted as
     * scenes themselves. Skip both the snapshot files directly and any
     * recursion into a `_snapshots` subfolder.
     */
    private async scanFolderAdapter(folderPath: string): Promise<void> {
        const adapter = this.app.vault.adapter;
        if (!await adapter.exists(folderPath)) return;

        const listing = await adapter.list(folderPath);
        const scanningNotes = this.isPathUnderFolder(folderPath, this.getNotesFolder());
        for (const f of listing.files) {
            if (!f.endsWith('.md')) continue;
            if (f.includes('/_snapshots/')) continue; // issue #100 — skip snapshot files
            try {
                const content = await adapter.read(f);
                const scene = MetadataParser.parseContent(content, f);
                if (scene) {
                    this.scenes.set(f, scene);
                    if (scanningNotes && !scene.corkboardNote) {
                        const af = this.app.vault.getAbstractFileByPath(f);
                        if (af instanceof TFile) await this.ensureNotesFileIndexed(af);
                    }
                } else if (scanningNotes) {
                    const af = this.app.vault.getAbstractFileByPath(f);
                    if (af instanceof TFile) await this.ensureNotesFileIndexed(af);
                }
            } catch { /* file unreadable — skip */ }
        }
        for (const sub of listing.folders) {
            const segment = sub.split('/').pop() ?? '';
            if (segment === '_snapshots') continue; // issue #100 — don't recurse into snapshots
            await this.scanFolderAdapter(sub);
        }
    }

    /**
     * Get all scenes
     */
    getAllScenes(): Scene[] {
        return Array.from(this.scenes.values());
    }

    /**
     * Scenes for board/manuscript/timeline: active draft only (+ corkboard notes).
     * Draft subfolders are isolated so copies in other drafts never appear here.
     */
    getWorkbenchScenes(): Scene[] {
        const project = this._activeProject;
        if (!project) return this.getAllScenes();
        this.ensureProjectDrafts(project);
        const draft = this.getActiveDraft();
        if (!draft) return this.getAllScenes();
        return this.getAllScenes().filter(s => {
            if (s.corkboardNote) return true;
            return this.sceneBelongsToDraft(s.filePath, draft, project);
        });
    }

    /**
     * Get a scene by file path
     */
    getScene(filePath: string): Scene | undefined {
        return this.scenes.get(filePath);
    }

    /**
     * Create a new scene
     */
    async createScene(sceneData: Partial<Scene>, afterScene?: Scene): Promise<TFile> {
        // Route corkboard notes to the Notes/ folder
        const isNote = sceneData.corkboardNote === true;
        // Scenes for a named draft go under Scenes/<draft folder>/
        let baseFolder = isNote ? this.getNotesFolder() : this.getSceneFolder();
        if (!isNote) {
            const draft = this.getActiveDraft();
            if (draft?.folder) {
                baseFolder = normalizePath(`${baseFolder}/${draft.folder}`);
            }
        }

        // Ensure folder exists
        await this.ensureFolder(baseFolder);

        // Determine subfolder based on act (only for scenes, not notes).
        // Sanitize the act value so non-numeric acts like "1.1" or "Prologue"
        // produce a valid Windows/macOS folder name (illegal characters are
        // replaced with "-" by sanitizeActChapterForPath).
        let targetFolder = baseFolder;
        if (!isNote && sceneData.act !== undefined) {
            const actFolderSegment = sanitizeActChapterForPath(String(sceneData.act));
            if (actFolderSegment) {
                targetFolder = normalizePath(`${baseFolder}/Act ${actFolderSegment}`);
                await this.ensureFolder(targetFolder);
            }
        }

        // Auto-generate sequence if enabled (skip when caller already set one).
        // Corkboard notes are layout/brainstorming aids, not story scenes, so
        // they must NOT consume a sequence number — otherwise they create gaps
        // in the scene numbering and pollute globalResequence / Timeline order.
        if (!isNote && this.plugin.settings.autoGenerateSequence && sceneData.sequence === undefined) {
            sceneData.sequence = this.getNextSequence(afterScene);
        }

        // Generate filename. formatActChapterPrefix zero-pads pure-numeric
        // acts ("1" → "01") and emits string acts verbatim with illegal
        // characters replaced ("1.1" → "1.1", "Prologue" → "Prologue").
        const seqStr = sceneData.sequence !== undefined
            ? String(sceneData.sequence).padStart(2, '0')
            : '00';
        const actStr = formatActChapterPrefix(sceneData.act, '00');
        const safeTitle = (sceneData.title || 'Untitled')
            .replace(/[\\/:*?"<>|]/g, '-')
            .substring(0, 60);
        const baseName = `${actStr}-${seqStr} ${safeTitle}`;
        // Issue #81: when auto-generate sequence is off (or the caller didn't
        // provide one), multiple new notes/scenes can collide on the same
        // "00-00 Untitled.md" filename. Append a numeric suffix to ensure
        // uniqueness so vault.create() doesn't fail with "File already exists".
        let fileName = `${baseName}.md`;
        let filePath = normalizePath(`${targetFolder}/${fileName}`);
        let dedupe = 1;
        while (this.app.vault.getAbstractFileByPath(filePath)) {
            fileName = `${baseName} (${dedupe}).md`;
            filePath = normalizePath(`${targetFolder}/${fileName}`);
            dedupe++;
        }

        // Auto-populate beatsheet from project's active beat sheet template
        if (!isNote && !sceneData.beatsheet && this._activeProject?.activeBeatSheet) {
            sceneData.beatsheet = this._activeProject.activeBeatSheet;
        }

        // Issue #77 \u2014 seed universalFields with template defaults for any
        // scene-category fields that have a defaultValue and aren't already set.
        if (!isNote) {
            sceneData.universalFields = this.seedSceneUniversalDefaults(sceneData.universalFields) as Record<string, string | string[]> | undefined;
        }

        // Issue #77 \u2014 parse the user's "Default scene frontmatter" YAML
        // snippet into extra keys to merge. NarrativeLab keys win on conflict.
        const extraFm = isNote ? undefined : this.parseDefaultSceneFrontmatter();

        // Generate content
        const content = MetadataParser.generateSceneContent(sceneData, undefined, extraFm);

        // Create file
        const file = await this.app.vault.create(filePath, content);

        // Record undo snapshot for create
        this.undoManager.recordCreate(file.path, content, `Create "${sceneData.title || 'scene'}"`);

        // Add to index
        const scene = await MetadataParser.parseFile(this.app, file);
        if (scene) {
            this.scenes.set(file.path, scene);
            this.bumpVersion(file.path);
        }

        // Keep draft reading-order list in sync when the active draft uses one
        if (!isNote) {
            const draft = this.getActiveDraft();
            const project = this._activeProject;
            if (project && draft?.scenePaths && !draft.scenePaths.includes(file.path)) {
                draft.scenePaths = [...draft.scenePaths, file.path];
                await this.saveProjectFrontmatter(project);
            }
        }

        return file;
    }

    /**
     * Update an existing scene's metadata
     */
    async updateScene(filePath: string, updates: Partial<Scene>): Promise<string | void> {
        const file = this.app.vault.getAbstractFileByPath(filePath);
        if (!file || !(file instanceof TFile)) {
            new Notice('Scene file not found');
            return;
        }

        // Record undo snapshot before applying changes
        const oldSnap = this.scenes.get(filePath);
        if (oldSnap) {
            const label = `Update "${oldSnap.title}"`;
            this.undoManager.recordUpdate(filePath, oldSnap as unknown as Record<string, unknown>, updates, label);
        }

        // Issue #212 — populate the title→fileStem map so setup/payoff wikilinks
        // are written as `[[stem|title]]`, letting Obsidian’s graph resolve the
        // link to the real file while NarrativeLab still matches by title.
        if (updates.setup_scenes !== undefined || updates.payoff_scenes !== undefined) {
            const stemMap = new Map<string, string>();
            for (const [p, s] of this.scenes) {
                if (s.title) {
                    const stem = p.split('/').pop()?.replace(/\.md$/, '') ?? s.title;
                    stemMap.set(s.title, stem);
                }
            }
            setSceneTitleToStemMap(stemMap);
        }

        await MetadataParser.updateFrontmatter(this.app, file, updates);

        // Refresh index
        const scene = await MetadataParser.parseFile(this.app, file);
        if (scene) {
            this.scenes.set(filePath, scene);
            this.bumpVersion(filePath);
        }

        let currentPath = filePath;

        // If the act changed, relocate the file to the correct Act folder and
        // update the act prefix in the filename.
        if (updates.act !== undefined && oldSnap && updates.act !== oldSnap.act) {
            currentPath = await this.relocateSceneForAct(filePath, updates.act);
        }

        if (
            updates.title !== undefined ||
            updates.sequence !== undefined ||
            (updates.act !== undefined && oldSnap && updates.act !== oldSnap.act)
        ) {
            currentPath = await this.syncSceneFileName(currentPath);
        }

        return currentPath;
    }

    /**
     * Move a scene file to the correct Act subfolder and update the act/sequence
     * prefix in the filename (e.g. `01-05 Title.md` → `02-03 Title.md`).
     * Returns the new file path, or the original path if no move was needed.
     */
    private async relocateSceneForAct(filePath: string, newAct: number | string | undefined): Promise<string> {
        const file = this.app.vault.getAbstractFileByPath(filePath);
        if (!file || !(file instanceof TFile)) return filePath;

        // Keep the scene inside its owning draft (named draft folder), not the
        // project-wide Scenes root — otherwise Navigator hides it while that draft is active.
        const draftRoot = this.getDraftSceneRoot(this.getDraftOwningScenePath(filePath));

        // Determine target folder. Same sanitization as createScene so a
        // string act like "1.1" or "Prologue" produces a valid folder name.
        let targetFolder = draftRoot;
        if (newAct !== undefined) {
            const actFolderSegment = sanitizeActChapterForPath(String(newAct));
            if (actFolderSegment) {
                targetFolder = normalizePath(`${draftRoot}/Act ${actFolderSegment}`);
            }
        }
        await this.ensureFolder(targetFolder);

        // Update act (and optionally sequence) prefix in filename.
        // The prefix may be either two digits ("01-05") for numeric acts or
        // a freeform string ("1.1-05", "Prologue-05") for string acts —
        // recognise both shapes so we can rewrite them in place.
        let newName = file.name;
        const actStr = formatActChapterPrefix(newAct, '00');
        // Match either NN-NN<space>... (legacy numeric) or <anything>-NN<space>...
        // where the act portion may contain dots or letters but no whitespace
        // and no second dash before the sequence.
        const prefixMatch = file.name.match(/^([^\s/-]+)-(\d+(?:\.\d+)?)\s/);
        if (prefixMatch) {
            // Read the updated sequence from the freshly-written YAML
            const updatedScene = this.scenes.get(filePath);
            const seqStr = updatedScene?.sequence !== undefined
                ? String(updatedScene.sequence).padStart(2, '0')
                : prefixMatch[2];  // keep existing if unknown
            newName = file.name.replace(/^[^\s/-]+-\d+(?:\.\d+)?(\s)/, `${actStr}-${seqStr}$1`);
        }

        const newPath = normalizePath(`${targetFolder}/${newName}`);
        if (normalizePath(filePath) === newPath) return filePath;

        // Remove old index
        this.scenes.delete(filePath);

        // Rename/move via fileManager so vault links update
        await this.app.fileManager.renameFile(file, newPath);

        // Re-index at new path
        const movedFile = this.app.vault.getAbstractFileByPath(newPath);
        if (movedFile && movedFile instanceof TFile) {
            const updated = await MetadataParser.parseFile(this.app, movedFile);
            if (updated) this.scenes.set(newPath, updated);
        }
        this.bumpVersion(newPath);

        return newPath;
    }

    private getSceneSafeTitle(title: string | undefined): string {
        return (title || 'Untitled')
            .replace(/[\\/:*?"<>|]/g, '-')
            .substring(0, 60)
            .trim() || 'Untitled';
    }

    private getSceneFileNameForMetadata(scene: Scene, currentFile: TFile): string {
        const safeTitle = this.getSceneSafeTitle(scene.title);
        const hasPrefix = /^([^\s/-]+)-(\d+(?:\.\d+)?)\s/.test(currentFile.name);
        if (hasPrefix || scene.sequence !== undefined || scene.act !== undefined) {
            const actStr = formatActChapterPrefix(scene.act, '00');
            const seqStr = scene.sequence !== undefined
                ? String(scene.sequence).padStart(2, '0')
                : '00';
            return `${actStr}-${seqStr} ${safeTitle}.md`;
        }
        return `${safeTitle}.md`;
    }

    private getUniquePathInFolder(folder: string, fileName: string, currentPath: string): string {
        const dot = fileName.lastIndexOf('.');
        const base = dot >= 0 ? fileName.slice(0, dot) : fileName;
        const ext = dot >= 0 ? fileName.slice(dot) : '';
        const current = normalizePath(currentPath);
        let candidate = normalizePath(`${folder}/${fileName}`);
        let dedupe = 1;
        while (this.app.vault.getAbstractFileByPath(candidate) && normalizePath(candidate) !== current) {
            candidate = normalizePath(`${folder}/${base} (${dedupe})${ext}`);
            dedupe++;
        }
        return candidate;
    }

    private async syncSceneFileName(filePath: string): Promise<string> {
        const file = this.app.vault.getAbstractFileByPath(filePath);
        if (!file || !(file instanceof TFile)) return filePath;
        const scene = this.scenes.get(filePath) ?? await MetadataParser.parseFile(this.app, file);
        if (!scene || scene.corkboardNote) return filePath;
        const sceneFolder = normalizePath(this.getSceneFolder());
        if (!normalizePath(file.path).startsWith(`${sceneFolder}/`)) return filePath;

        const folder = file.parent?.path ? normalizePath(file.parent.path) : sceneFolder;
        const newName = this.getSceneFileNameForMetadata(scene, file);
        const newPath = this.getUniquePathInFolder(folder, newName, file.path);
        if (normalizePath(file.path) === normalizePath(newPath)) return file.path;

        this.scenes.delete(file.path);
        await this.app.fileManager.renameFile(file, newPath);
        const movedFile = this.app.vault.getAbstractFileByPath(newPath);
        if (movedFile instanceof TFile) {
            const updated = await MetadataParser.parseFile(this.app, movedFile);
            if (updated) this.scenes.set(newPath, updated);
        }
        this.bumpVersion(newPath);

        // Issue #175 — keep the linked scene notes file name in sync with the
        // scene title so renaming a scene also renames its "Title - Notes.md".
        await this.renameSceneNotesFile(newPath);

        return newPath;
    }

    /**
     * Rename a scene's external notes file to match the scene's current title.
     * No-op when there is no notes file, the notes file lives outside the
     * project's notes folder, or the name already matches. Issue #175.
     */
    private async renameSceneNotesFile(scenePath: string): Promise<void> {
        const scene = this.scenes.get(scenePath);
        if (!scene || !scene.notesFile) return;
        const notesFile = this.app.vault.getAbstractFileByPath(scene.notesFile);
        if (!(notesFile instanceof TFile)) return;

        const notesFolder = normalizePath(this.getSceneNotesFolder());
        if (!normalizePath(notesFile.path).startsWith(`${notesFolder}/`)) return;

        const targetPath = this.getUniqueSceneNotesPath(scene, notesFile.path);
        if (normalizePath(targetPath) === normalizePath(notesFile.path)) return;

        await this.app.fileManager.renameFile(notesFile, targetPath);
        await this.updateScene(scenePath, { notesFile: targetPath });
        scene.notesFile = targetPath;
    }

    /**
     * Move a corkboard note from the Notes/ folder to the Scenes/ folder,
     * flipping corkboardNote to false.  Returns the new file path.
     */
    async moveNoteToSceneFolder(filePath: string): Promise<string> {
        const file = this.app.vault.getAbstractFileByPath(filePath);
        if (!file || !(file instanceof TFile)) {
            new Notice('Note file not found');
            return filePath;
        }

        const scene = this.scenes.get(filePath);

        // Update frontmatter first (still at old path)
        await this.updateScene(filePath, {
            corkboardNote: false,
            plotgridOrigin: undefined,
        });

        // Target the active draft's Scenes root (not always project-wide Scenes/)
        const draftRoot = this.getDraftSceneRoot(this.getActiveDraft());
        await this.ensureFolder(draftRoot);

        let targetFolder = draftRoot;
        if (scene?.act !== undefined) {
            const actSeg = sanitizeActChapterForPath(String(scene.act));
            if (actSeg) {
                targetFolder = normalizePath(`${draftRoot}/Act ${actSeg}`);
                await this.ensureFolder(targetFolder);
            }
        }

        const newPath = normalizePath(`${targetFolder}/${file.name}`);

        // Only move if the file is actually in a different folder
        if (normalizePath(filePath) !== newPath) {
            // Remove old index entry
            this.scenes.delete(filePath);
            // Use fileManager.renameFile so vault links update
            await this.app.fileManager.renameFile(file, newPath);
            // Re-index at the new path
            const movedFile = this.app.vault.getAbstractFileByPath(newPath);
            if (movedFile && movedFile instanceof TFile) {
                const updated = await MetadataParser.parseFile(this.app, movedFile);
                if (updated) this.scenes.set(newPath, updated);
            }
            this.bumpVersion(newPath);
            return newPath;
        }

        return filePath;
    }

    /**
     * Issue #83 \u2014 Convert an arbitrary markdown file (an orphan note created
     * by typing a `[[wikilink]]` to a non-existent file, for example) into a
     * proper NarrativeLab scene. Adds the required scene frontmatter, assigns the
     * next sequence number, and moves the file into the active project's
     * Scenes/ folder so it appears in every view.
     *
     * Returns the new file path (which may equal `filePath` if no move was
     * needed) or `null` on failure.
     */
    async convertFileToScene(filePath: string): Promise<string | null> {
        if (!this._activeProject) {
            new Notice('No active NarrativeLab project. Open one first.');
            return null;
        }
        const file = this.app.vault.getAbstractFileByPath(filePath);
        if (!file || !(file instanceof TFile) || file.extension !== 'md') {
            new Notice('Selected file is not a markdown note.');
            return null;
        }

        // Refuse if it's already indexed as a real (non-corkboard) scene.
        const existing = this.scenes.get(filePath);
        if (existing && existing.type === 'scene' && !existing.corkboardNote) {
            new Notice('This file is already a scene.');
            return filePath;
        }

        const today = new Date().toISOString().split('T')[0];
        const content = await this.app.vault.read(file);
        const fm = (MetadataParser.extractFrontmatter(content) || {}) as Partial<Scene> & Record<string, unknown>;

        const updates: Partial<Scene> = {
            type: 'scene',
            title: String(fm.title || file.basename),
            status: (fm.status || 'idea') as Scene['status'],
            created: String(fm.created || today),
            corkboardNote: false,
            plotgridOrigin: undefined,
        };
        if (fm.sequence === undefined) {
            updates.sequence = this.getNextSequence();
        }

        // Write frontmatter (also recomputes wordcount + modified date)
        await MetadataParser.updateFrontmatter(this.app, file, updates);

        // Index the file so moveNoteToSceneFolder can reference it
        const parsed = await MetadataParser.parseFile(this.app, file);
        if (parsed) {
            this.scenes.set(filePath, parsed);
            this.bumpVersion(filePath);
        }

        // Now move it into Scenes/<Act N> if needed (reuses existing logic).
        const newPath = await this.moveNoteToSceneFolder(filePath);
        new Notice(`Converted "${file.basename}" to a scene.`);
        return newPath;
    }

    async archiveScene(filePath: string): Promise<string> {
        const file = this.app.vault.getAbstractFileByPath(filePath);
        if (!file || !(file instanceof TFile)) {
            new Notice('Scene file not found');
            return filePath;
        }

        const scene = this.scenes.get(filePath);
        const archiveFolder = this.getArchiveFolder();
        await this.ensureFolder(archiveFolder);

        const newPath = normalizePath(`${archiveFolder}/${file.name}`);

        // Remove from active index
        this.scenes.delete(filePath);
        this.bumpVersion(filePath);

        // Move the file
        await this.app.fileManager.renameFile(file, newPath);

        new Notice(`"${scene?.title || file.basename}" archived`);
        return newPath;
    }

    /**
     * Restore a scene from the Archive/ folder back to Scenes/.
     * Handles filename collisions and assigns a new sequence number
     * to avoid clashing with existing scenes.
     */
    async restoreScene(filePath: string): Promise<string> {
        const file = this.app.vault.getAbstractFileByPath(filePath);
        if (!file || !(file instanceof TFile)) {
            new Notice('Archived file not found');
            return filePath;
        }

        const draftRoot = this.getDraftSceneRoot(this.getActiveDraft());
        await this.ensureFolder(draftRoot);
        let newPath = normalizePath(`${draftRoot}/${file.name}`);

        // Handle filename collision — append " (restored)" if needed
        if (this.app.vault.getAbstractFileByPath(newPath)) {
            const baseName = file.basename;
            newPath = normalizePath(`${draftRoot}/${baseName} (restored).md`);
            // If even that exists, add a number
            let counter = 2;
            while (this.app.vault.getAbstractFileByPath(newPath)) {
                newPath = normalizePath(`${draftRoot}/${baseName} (restored ${counter}).md`);
                counter++;
            }
        }

        await this.app.fileManager.renameFile(file, newPath);

        // Re-index at new path
        const movedFile = this.app.vault.getAbstractFileByPath(newPath);
        if (movedFile && movedFile instanceof TFile) {
            const scene = await MetadataParser.parseFile(this.app, movedFile);
            if (scene) {
                // Assign a new sequence number at the end to avoid clashes
                const newSeq = this.getNextSequence();
                await MetadataParser.updateFrontmatter(this.app, movedFile, { sequence: newSeq });
                scene.sequence = newSeq;
                this.scenes.set(newPath, scene);
                this.bumpVersion(newPath);
            }
        }

        new Notice(`"${file.basename}" restored from archive (sequence renumbered)`);
        return newPath;
    }

    /**
     * List all archived scene files.
     */
    async getArchivedScenes(): Promise<{ filePath: string; title: string }[]> {
        const archiveFolder = this.getArchiveFolder();
        const adapter = this.app.vault.adapter;
        if (!await adapter.exists(archiveFolder)) return [];

        const results: { filePath: string; title: string }[] = [];
        try {
            const listing = await adapter.list(archiveFolder);
            for (const f of listing.files) {
                if (!f.endsWith('.md')) continue;
                try {
                    const content = await adapter.read(f);
                    const scene = MetadataParser.parseContent(content, f);
                    results.push({ filePath: f, title: scene?.title || f.split('/').pop()?.replace(/\.md$/, '') || f });
                } catch { /* skip unreadable files */ }
            }
        } catch { /* folder unreadable */ }
        return results;
    }

    /**
     * Delete a scene
     */
    async deleteScene(filePath: string): Promise<void> {
        const file = this.app.vault.getAbstractFileByPath(filePath);
        if (!file || !(file instanceof TFile)) return;

        // Record undo snapshot before deleting
        const fileContent = await this.app.vault.read(file);
        const scene = this.scenes.get(filePath);
        const label = scene ? `Delete "${scene.title}"` : 'Delete scene';
        this.undoManager.recordDelete(filePath, fileContent, label);

        await this.app.fileManager.trashFile(file);
        this.scenes.delete(filePath);
        await this.syncDraftScenePaths(filePath, null);
        await this.plugin.plotlineManager?.syncScenePath(filePath, null);
        this.bumpVersion(filePath);

    }

    /**
     * Duplicate a scene
     */
    async duplicateScene(filePath: string): Promise<TFile | null> {
        const scene = this.scenes.get(filePath);
        if (!scene) return null;

        // eslint-disable-next-line @typescript-eslint/no-unused-vars -- destructure to omit filePath/body from the duplicated scene metadata
        const { filePath: _fp, body: _body, ...rest } = scene;
        const newScene: Partial<Scene> = {
            ...rest,
            title: `${scene.title} (copy)`,
            sequence: this.getNextSequence(scene),
        };

        return this.createScene(newScene);
    }

    /**
     * Move a scene to a different act/position (for drag-and-drop)
     */
    async moveScene(
        filePath: string,
        targetAct?: number | string,
        newSequence?: number
    ): Promise<void> {
        const updates: Partial<Scene> = {};
        if (targetAct !== undefined) updates.act = targetAct;
        if (newSequence !== undefined) updates.sequence = newSequence;

        await this.updateScene(filePath, updates);
    }

    /**
     * Resequence scenes after drag-and-drop.
     *
     * Writes a flat, globally unique `sequence` value 1..N in the supplied
     * order. Does NOT touch `chapter` (that destroys user-meaningful chapter
     * assignments). For #118: `sequence` is the single global authoritative
     * counter; `act` / `chapter` are independent organizational fields.
     */
    async resequenceScenes(orderedPaths: string[]): Promise<void> {
        for (let i = 0; i < orderedPaths.length; i++) {
            await this.updateScene(orderedPaths[i], { sequence: i + 1 });
        }
    }

    /**
     * Renumber every scene in the project with a flat, globally unique
     * `sequence` 1..N. Ordering is act → chapter → current `sequence`, so
     * a scene's relative position is preserved while the counter becomes
     * unique across the whole project. Does NOT modify `act` / `chapter`.
     *
     * Spec for #118: there is exactly ONE authoritative scene order —
     * the global `sequence` value. Per-chapter "sequence within chapter"
     * is a display concern only.
     *
     * @param ordered Optional explicit ordering; otherwise computed from
     * the current act/chapter/sequence of all scenes.
     */
    async globalResequence(ordered?: Scene[]): Promise<void> {
        // Corkboard notes are excluded from the global sequence space so they
        // don't create gaps in scene numbering or steal slots from real scenes.
        const list = (ordered ?? [...this.getAllScenes()])
            .filter(s => !s.corkboardNote)
            .sort((a, b) => {
                const ac = compareActChapter(a.act, b.act);
                if (ac !== 0) return ac;
                const cc = compareActChapter(a.chapter, b.chapter);
                if (cc !== 0) return cc;
                return (a.sequence ?? 0) - (b.sequence ?? 0);
            });
        for (let i = 0; i < list.length; i++) {
            const want = i + 1;
            if (list[i].sequence !== want) {
                await this.updateScene(list[i].filePath, { sequence: want });
            }
        }
    }

    /**
     * Handle file changes (for watching file modifications)
     */
    async handleFileChange(file: TFile): Promise<void> {
        if (file.extension !== 'md') return;

        const inScenes = this.isPathUnderFolder(file.path, this.getSceneFolder());
        const inNotes = this.isPathUnderFolder(file.path, this.getNotesFolder());
        if (!inScenes && !inNotes) return;

        // Native Obsidian notes under Notes/ need corkboard frontmatter before
        // the board/corkboard can show them (even with the Notes toggle on).
        if (inNotes) {
            await this.ensureNotesFileIndexed(file);
            return;
        }

        const scene = await MetadataParser.parseFile(this.app, file);
        if (scene) {
            this.scenes.set(file.path, scene);
        } else {
            this.scenes.delete(file.path);
        }
        this.bumpVersion(file.path);
    }

    /**
     * Handle newly created files (Obsidian "New note" fires create, not always modify).
     */
    async handleFileCreate(file: TFile): Promise<void> {
        await this.handleFileChange(file);
    }

    /**
     * Handle file deletion
     */
    handleFileDelete(filePath: string): void {
        this.scenes.delete(filePath);
        void this.syncDraftScenePaths(filePath, null);
        void this.plugin.plotlineManager?.syncScenePath(filePath, null);
        this.bumpVersion(filePath);
    }

    /**
     * Handle file rename
     */
    async handleFileRename(file: TFile, oldPath: string): Promise<void> {
        this.scenes.delete(oldPath);
        const inScenes = this.isPathUnderFolder(file.path, this.getSceneFolder());
        const inNotes = this.isPathUnderFolder(file.path, this.getNotesFolder());
        if (file.extension === 'md' && (inScenes || inNotes)) {
            if (inNotes) {
                await this.ensureNotesFileIndexed(file);
            } else {
                const scene = await MetadataParser.parseFile(this.app, file);
                if (scene) {
                    this.scenes.set(file.path, scene);
                    if (!scene.corkboardNote) {
                        const titleFromFile = this.getTitleFromSceneFileName(file);
                        if (titleFromFile && titleFromFile !== scene.title) {
                            const oldTitle = scene.title;
                            await this.updateScene(file.path, { title: titleFromFile });
                            if (oldTitle) await this.updateSceneTitleReferences(oldTitle, titleFromFile);
                        }
                    }
                }
            }
        }
        await this.syncDraftScenePaths(oldPath, file.path);
        await this.plugin.plotlineManager?.syncScenePath(oldPath, file.path);
        this.bumpVersion(file.path);
    }

    /** Keep draft reading-order lists in sync when a scene path changes or is removed. */
    private async syncDraftScenePaths(oldPath: string, newPath: string | null): Promise<void> {
        const project = this._activeProject;
        if (!project?.drafts) return;
        const oldN = normalizePath(oldPath);
        let dirty = false;
        for (const draft of project.drafts) {
            if (!draft.scenePaths?.length) continue;
            if (newPath === null) {
                const next = draft.scenePaths.filter(p => normalizePath(p) !== oldN);
                if (next.length !== draft.scenePaths.length) {
                    draft.scenePaths = next.length > 0 ? next : undefined;
                    dirty = true;
                }
            } else {
                let changed = false;
                draft.scenePaths = draft.scenePaths.map(p => {
                    if (normalizePath(p) !== oldN) return p;
                    changed = true;
                    return newPath;
                });
                if (changed) dirty = true;
            }
        }
        if (dirty) await this.saveProjectFrontmatter(project);
    }

    private getTitleFromSceneFileName(file: TFile): string | undefined {
        let title = file.basename.trim();
        title = title.replace(/^[^\s/-]+-\d+(?:\.\d+)?\s+/, '').trim();
        return title || undefined;
    }

    private async updateSceneTitleReferences(oldTitle: string, newTitle: string): Promise<void> {
        if (!oldTitle || oldTitle === newTitle) return;
        const scenes = Array.from(this.scenes.values());
        for (const scene of scenes) {
            const updates: Partial<Scene> = {};
            if (scene.setup_scenes?.includes(oldTitle)) {
                updates.setup_scenes = scene.setup_scenes.map(title => title === oldTitle ? newTitle : title);
            }
            if (scene.payoff_scenes?.includes(oldTitle)) {
                updates.payoff_scenes = scene.payoff_scenes.map(title => title === oldTitle ? newTitle : title);
            }
            if (Object.keys(updates).length > 0) {
                await this.updateScene(scene.filePath, updates);
            }
        }
    }

    /** Plotlines defined for the project, including currently empty plotlines. */
    getPlotlines(): string[] {
        const mgr = this.plugin.plotlineManager;
        const ids = new Set<string>();
        const ordered: string[] = [];

        if (mgr) {
            for (const def of mgr.getPlotlineDefinitions()) {
                if (!ids.has(def.id)) {
                    ids.add(def.id);
                    ordered.push(def.id);
                }
            }
        }

        for (const name of this._activeProject?.plotlines ?? []) {
            const trimmed = String(name).trim();
            if (trimmed && !ids.has(trimmed)) {
                ids.add(trimmed);
                ordered.push(trimmed);
            }
        }

        for (const scene of this.scenes.values()) {
            if (scene.corkboardNote) continue;
            for (const tag of scene.tags ?? []) {
                const name = String(tag).trim();
                if (name && !ids.has(name)) {
                    ids.add(name);
                    ordered.push(name);
                }
            }
        }

        if (ordered.length > 0) return ordered;
        return [...ids].sort((a, b) => a.localeCompare(b, undefined, { sensitivity: 'base' }));
    }

    /** Create an empty plotline that can receive scenes later. */
    async addPlotline(name: string): Promise<boolean> {
        const normalized = name.trim();
        if (!normalized) return false;
        if (this.plugin.plotlineManager) {
            return this.plugin.plotlineManager.createPlotline(normalized);
        }
        const project = this._activeProject;
        if (!project) return false;
        const existing = this.getPlotlines();
        if (existing.some(value => value.toLowerCase() === normalized.toLowerCase())) return false;
        project.plotlines = [...(project.plotlines ?? []), normalized];
        await this.saveProjectFrontmatter(project);
        return true;
    }

    getPlotlineDefinitions() {
        return this.plugin.plotlineManager?.getPlotlineDefinitions() ?? [];
    }

    assignSceneToPlotline(scenePath: string, plotlineId: string): Promise<void> {
        return this.plugin.plotlineManager?.assignSceneToPlotline(scenePath, plotlineId) ?? Promise.resolve();
    }

    unassignSceneFromPlotline(scenePath: string, plotlineId: string): Promise<void> {
        return this.plugin.plotlineManager?.unassignSceneFromPlotline(scenePath, plotlineId) ?? Promise.resolve();
    }

    reorderSceneInPlotline(plotlineId: string, scenePath: string, targetIndex: number): Promise<void> {
        return this.plugin.plotlineManager?.reorderSceneInPlotline(plotlineId, scenePath, targetIndex)
            ?? Promise.resolve();
    }

    setPlotlineSceneOrder(plotlineId: string, orderedPaths: string[]): Promise<void> {
        return this.plugin.plotlineManager?.setPlotlineSceneOrder(plotlineId, orderedPaths)
            ?? Promise.resolve();
    }

    getScenesOrderedForPlotline(plotlineId: string) {
        return this.plugin.plotlineManager?.getScenesOrderedForPlotline(plotlineId) ?? [];
    }

    orderScenesForPlotline(plotlineId: string, scenes: Scene[]) {
        return this.plugin.plotlineManager?.orderScenesForPlotline(plotlineId, scenes) ?? scenes;
    }

    renamePlotline(oldId: string, newId: string): Promise<number> {
        return this.plugin.plotlineManager?.renamePlotline(oldId, newId) ?? this.renameTag(oldId, newId);
    }

    deletePlotline(plotlineId: string): Promise<number> {
        return this.plugin.plotlineManager?.deletePlotline(plotlineId) ?? this.deleteTag(plotlineId);
    }

    /**
     * Update only the tags field via Obsidian's processFrontMatter.
     * Prefer this over updateScene for tag/plotline edits — full-file
     * read/modify can hang indefinitely on cloud-synced vaults (OneDrive).
     */
    async updateSceneTags(filePath: string, tags: string[]): Promise<void> {
        const file = this.app.vault.getAbstractFileByPath(filePath);
        if (!file || !(file instanceof TFile)) {
            new Notice('Scene file not found');
            return;
        }

        const oldSnap = this.scenes.get(filePath);
        const oldTags = oldSnap?.tags ?? [];
        const uniqueTags = [...new Set(tags.map(t => String(t)).filter(Boolean))];

        if (oldSnap) {
            this.undoManager.recordUpdate(
                filePath,
                oldSnap as unknown as Record<string, unknown>,
                { tags: uniqueTags },
                `Update tags of "${oldSnap.title}"`,
            );
        }

        await this.app.fileManager.processFrontMatter(file, (fm) => {
            if (uniqueTags.length > 0) fm.tags = uniqueTags;
            else delete fm.tags;
        });

        const cached = this.scenes.get(filePath);
        if (cached) {
            cached.tags = uniqueTags;
            this.bumpVersion(filePath);
        }

        const project = this._activeProject;
        if (project && uniqueTags.length > 0) {
            const defined = new Set(project.plotlines ?? []);
            const before = defined.size;
            uniqueTags.forEach(tag => defined.add(tag));
            if (defined.size !== before) {
                project.plotlines = [...defined];
                await this.saveProjectFrontmatter(project);
            }
        }

        await this.plugin.plotlineManager?.syncSceneTags(filePath, oldTags, uniqueTags);
    }

    /**
     * Rename a plotline tag across all scenes that use it.
     */
    async renameTag(oldTag: string, newTag: string): Promise<number> {
        let count = 0;
        for (const scene of this.scenes.values()) {
            if (scene.tags && scene.tags.includes(oldTag)) {
                const newTags = scene.tags.map(t => t === oldTag ? newTag : t);
                await this.updateSceneTags(scene.filePath, newTags);
                count++;
            }
        }
        if (this._activeProject?.plotlines?.includes(oldTag)) {
            this._activeProject.plotlines = [...new Set(
                this._activeProject.plotlines.map(tag => tag === oldTag ? newTag : tag),
            )];
            await this.saveProjectFrontmatter(this._activeProject);
        }
        return count;
    }

    /**
     * Delete a plotline tag from all scenes that use it.
     */
    async deleteTag(tag: string): Promise<number> {
        let count = 0;
        for (const scene of this.scenes.values()) {
            if (scene.tags && scene.tags.includes(tag)) {
                const newTags = scene.tags.filter(t => t !== tag);
                await this.updateSceneTags(scene.filePath, newTags);
                count++;
            }
        }
        if (this._activeProject?.plotlines?.includes(tag)) {
            this._activeProject.plotlines = this._activeProject.plotlines.filter(value => value !== tag);
            await this.saveProjectFrontmatter(this._activeProject);
        }
        return count;
    }

    // ────────────────────────────────────
    //  Story structure (empty acts/chapters)
    // ────────────────────────────────────

    /** Get all defined act numbers (including those with scenes) */
    getDefinedActs(): number[] {
        const fromProject = this._activeProject?.definedActs ?? [];
        const fromScenes = new Set<number>();
        for (const scene of this.scenes.values()) {
            if (scene.act !== undefined && typeof scene.act === 'number') {
                fromScenes.add(scene.act);
            } else if (scene.act !== undefined) {
                const n = Number(scene.act);
                if (!isNaN(n)) fromScenes.add(n);
            }
        }
        const merged = new Set([...fromProject, ...fromScenes]);
        return Array.from(merged).sort((a, b) => a - b);
    }

    /** Get all defined chapter numbers (including those with scenes) */
    getDefinedChapters(): number[] {
        const fromProject = this._activeProject?.definedChapters ?? [];
        const fromScenes = new Set<number>();
        for (const scene of this.scenes.values()) {
            if (scene.chapter !== undefined && typeof scene.chapter === 'number') {
                fromScenes.add(scene.chapter);
            } else if (scene.chapter !== undefined) {
                const n = Number(scene.chapter);
                if (!isNaN(n)) fromScenes.add(n);
            }
        }
        const merged = new Set([...fromProject, ...fromScenes]);
        return Array.from(merged).sort((a, b) => a - b);
    }

    /** Add empty acts (they persist even without scenes) */
    async addActs(actNumbers: number[]): Promise<void> {
        if (!this._activeProject) return;
        // Issue #176 — sanitize input: drop NaN/non-finite values and dedupe
        // so repeated calls (e.g. on mobile where the dialog gave no feedback)
        // don't stack redundant frontmatter writes that can race with sync.
        const clean = actNumbers
            .map(Number)
            .filter(n => Number.isFinite(n))
            .map(n => Math.trunc(n));
        if (clean.length === 0) return;

        const existing = this._activeProject.definedActs;
        const merged = new Set([...existing, ...clean]);
        const next = Array.from(merged).sort((a, b) => a - b);
        // Skip the write entirely if nothing actually changed — prevents the
        // "nothing happened, so I tapped it again" loop that corrupted projects.
        if (next.length === existing.length && next.every((v, i) => v === existing[i])) return;
        this._activeProject.definedActs = next;
        await this.saveProjectFrontmatter(this._activeProject);
    }

    /** Remove an act definition (scenes in it are NOT deleted) */
    async removeAct(actNumber: number): Promise<void> {
        if (!this._activeProject) return;
        this._activeProject.definedActs = this._activeProject.definedActs.filter(a => a !== actNumber);
        await this.saveProjectFrontmatter(this._activeProject);
    }

    /** Add empty chapters */
    async addChapters(chapterNumbers: number[]): Promise<void> {
        if (!this._activeProject) return;
        // Issue #176 — sanitize + skip no-op writes (see addActs).
        const clean = chapterNumbers
            .map(Number)
            .filter(n => Number.isFinite(n))
            .map(n => Math.trunc(n));
        if (clean.length === 0) return;
        const existing = this._activeProject.definedChapters;
        const merged = new Set([...existing, ...clean]);
        const next = Array.from(merged).sort((a, b) => a - b);
        if (next.length === existing.length && next.every((v, i) => v === existing[i])) return;
        this._activeProject.definedChapters = next;
        await this.saveProjectFrontmatter(this._activeProject);
    }

    /** Remove a chapter definition */
    async removeChapter(chapterNumber: number): Promise<void> {
        if (!this._activeProject) return;
        this._activeProject.definedChapters = this._activeProject.definedChapters.filter(c => c !== chapterNumber);
        await this.saveProjectFrontmatter(this._activeProject);
    }

    /**
     * Issue #220 — Insert a new chapter at a specific position, renumbering
     * existing chapters (and their scenes) to make room.
     *
     * @param beforeChapter  The chapter number the new one should appear
     *                       *before*. Chapters >= this value are shifted up
     *                       by 1. Use `undefined` (or a number larger than
     *                       any existing chapter) to append at the end.
     * @returns The chapter number that was assigned to the new chapter.
     */
    async insertChapter(beforeChapter?: number): Promise<number> {
        if (!this._activeProject) throw new Error('No active project');

        const existing = this.getDefinedChapters();
        if (existing.length === 0 || beforeChapter === undefined ||
            beforeChapter > Math.max(...existing)) {
            // Append at the end
            const nextNum = existing.length > 0 ? Math.max(...existing) + 1 : 1;
            await this.addChapters([nextNum]);
            return nextNum;
        }

        // Shift every chapter >= beforeChapter up by one: both the defined
        // list, the labels, the descriptions, and every scene's `chapter`
        // field. Process in descending order so we never overwrite a value
        // we still need to read.
        const sorted = [...existing].sort((a, b) => b - a);
        for (const ch of sorted) {
            if (ch < beforeChapter) break;
            const newCh = ch + 1;

            // Move label
            const label = this._activeProject.chapterLabels?.[ch];
            if (label) {
                this._activeProject.chapterLabels[newCh] = label;
                delete this._activeProject.chapterLabels[ch];
            }

            // Move description
            const desc = this._activeProject.chapterDescriptions?.[ch];
            if (desc) {
                this._activeProject.chapterDescriptions[newCh] = desc;
                delete this._activeProject.chapterDescriptions[ch];
            }

            // Move scenes
            for (const scene of this.scenes.values()) {
                if (Number(scene.chapter) === ch) {
                    await this.updateScene(scene.filePath, { chapter: newCh });
                }
            }
        }

        // Register the new (now-free) chapter number and persist
        this._activeProject.definedChapters =
            [...this._activeProject.definedChapters, beforeChapter].sort((a, b) => a - b);
        await this.saveProjectFrontmatter(this._activeProject);
        return beforeChapter;
    }

    // ────────────────────────────────────
    //  Act labels (beat names)
    // ────────────────────────────────────

    /** Get the label for a specific act, or undefined */
    getActLabel(actNumber: number): string | undefined {
        return this._activeProject?.actLabels?.[actNumber];
    }

    /** Get all act labels */
    getActLabels(): Record<number, string> {
        return this._activeProject?.actLabels ?? {};
    }

    /** Set / update the label for a given act */
    async setActLabel(actNumber: number, label: string): Promise<void> {
        if (!this._activeProject) return;
        if (label.trim()) {
            this._activeProject.actLabels[actNumber] = label.trim();
        } else {
            delete this._activeProject.actLabels[actNumber];
        }
        await this.saveProjectFrontmatter(this._activeProject);
    }

    /** Get the label for a specific chapter, or undefined */
    getChapterLabel(chapterNumber: number): string | undefined {
        return this._activeProject?.chapterLabels?.[chapterNumber];
    }

    /** Get all chapter labels */
    getChapterLabels(): Record<number, string> {
        return this._activeProject?.chapterLabels ?? {};
    }

    /** Set / update the label for a given chapter */
    async setChapterLabel(chapterNumber: number, label: string): Promise<void> {
        if (!this._activeProject) return;
        if (label.trim()) {
            this._activeProject.chapterLabels[chapterNumber] = label.trim();
        } else {
            delete this._activeProject.chapterLabels[chapterNumber];
        }
        await this.saveProjectFrontmatter(this._activeProject);
    }

    // ────────────────────────────────────
    //  Act / chapter descriptions
    // ────────────────────────────────────

    /** Get the description for a specific act */
    getActDescription(actNumber: number): string | undefined {
        return this._activeProject?.actDescriptions?.[actNumber];
    }

    /** Get all act descriptions */
    getActDescriptions(): Record<number, string> {
        return this._activeProject?.actDescriptions ?? {};
    }

    /** Set / update the description for a given act */
    async setActDescription(actNumber: number, description: string): Promise<void> {
        if (!this._activeProject) return;
        if (description.trim()) {
            this._activeProject.actDescriptions[actNumber] = description.trim();
        } else {
            delete this._activeProject.actDescriptions[actNumber];
        }
        await this.saveProjectFrontmatter(this._activeProject);
    }

    /** Get the description for a specific chapter */
    getChapterDescription(chapterNumber: number): string | undefined {
        return this._activeProject?.chapterDescriptions?.[chapterNumber];
    }

    /** Get all chapter descriptions */
    getChapterDescriptions(): Record<number, string> {
        return this._activeProject?.chapterDescriptions ?? {};
    }

    /** Set / update the description for a given chapter */
    async setChapterDescription(chapterNumber: number, description: string): Promise<void> {
        if (!this._activeProject) return;
        if (description.trim()) {
            this._activeProject.chapterDescriptions[chapterNumber] = description.trim();
        } else {
            delete this._activeProject.chapterDescriptions[chapterNumber];
        }
        await this.saveProjectFrontmatter(this._activeProject);
    }

    /** Apply a beat sheet template — sets acts, chapters, and act labels */
    async applyBeatSheet(template: BeatSheetTemplate): Promise<void> {
        if (!this._activeProject) return;
        // Merge acts
        const mergedActs = new Set([...this._activeProject.definedActs, ...template.acts]);
        this._activeProject.definedActs = Array.from(mergedActs).sort((a, b) => a - b);
        // Merge chapters
        if (template.chapters.length > 0) {
            const mergedChapters = new Set([...this._activeProject.definedChapters, ...template.chapters]);
            this._activeProject.definedChapters = Array.from(mergedChapters).sort((a, b) => a - b);
        }
        // Apply act labels (overwrite existing for matching acts)
        for (const [act, label] of Object.entries(template.actLabels)) {
            this._activeProject.actLabels[Number(act)] = label;
        }
        // Apply chapter labels (overwrite existing for matching chapters)
        if (template.chapterLabels) {
            for (const [ch, label] of Object.entries(template.chapterLabels)) {
                this._activeProject.chapterLabels[Number(ch)] = label;
            }
        }
        this._activeProject.activeBeatSheet = template.name;
        await this.saveProjectFrontmatter(this._activeProject);
    }

    /**
     * Create placeholder scenes from a beat sheet template's beat definitions.
     * Each beat becomes a scene with act, chapter, title, synopsis, and status='idea'.
     *
     * Chapter assignment logic:
     *  - If the beat has an explicit `chapter` field, use it.
     *  - If the template has a `chapters` array, derive chapter from beat index
     *    (beat index → template.chapters[index]).
     *  - Otherwise, derive chapter from beat order within each act
     *    (1st beat in act 1 → chapter 1, 2nd → chapter 2, etc.).
     */
    async createScenesFromBeats(template: BeatSheetTemplate): Promise<number> {
        if (!this._activeProject) return 0;
        let created = 0;

        // Global chapter counter for templates without a chapters array.
        // Each beat gets the next chapter number globally so chapters are
        // unique across all acts (beat 1 in act 1 → ch 1, beat 1 in act 2 → ch 4, etc.).
        let globalChapter = 0;

        // Global sequence counter — always assign sequential sequence numbers
        // so placeholder scenes sort correctly regardless of autoGenerateSequence.
        const allSequences = this.getAllScenes()
            .map(s => s.sequence ?? 0)
            .sort((a, b) => a - b);
        let nextSeq = allSequences.length > 0 ? allSequences[allSequences.length - 1] + 1 : 1;

        for (let i = 0; i < template.beats.length; i++) {
            const beat = template.beats[i];

            // Determine chapter
            let chapter: number | undefined;
            if (beat.chapter !== undefined) {
                // Explicit chapter on beat definition
                chapter = beat.chapter;
            } else if (template.chapters.length > 0 && i < template.chapters.length) {
                // Template has chapters array — map beat index to chapter
                chapter = template.chapters[i];
            } else {
                // No chapters array — assign globally incrementing chapter numbers
                globalChapter++;
                chapter = globalChapter;
            }

            // Fill missing chapter labels from beat labels for act-only templates
            if (chapter !== undefined && !this._activeProject.chapterLabels[chapter]) {
                this._activeProject.chapterLabels[chapter] = beat.label;
            }

            await this.createScene({
                title: beat.label,
                act: beat.act,
                chapter,
                sequence: nextSeq++,
                beatsheet: template.name,
                synopsis: beat.description,
                status: 'idea' as SceneStatus,
            });
            created++;
        }

        // Save any chapter labels we filled in
        if (created > 0) {
            await this.saveProjectFrontmatter(this._activeProject);
        }

        return created;
    }

    /**
     * Apply a custom story structure with the given number of acts,
     * chapters per act, and optionally create placeholder scenes.
     */
    async applyCustomStructure(
        numActs: number,
        chaptersPerAct: number,
        scenesPerChapter: number,
        createScenes: boolean,
    ): Promise<{ acts: number; chapters: number; scenes: number }> {
        if (!this._activeProject) return { acts: 0, chapters: 0, scenes: 0 };

        const acts: number[] = [];
        const chapters: number[] = [];
        let scenesCreated = 0;

        // Global sequence counter for placeholder scenes
        const allSequences = this.getAllScenes()
            .map(s => s.sequence ?? 0)
            .sort((a, b) => a - b);
        let nextSeq = allSequences.length > 0 ? allSequences[allSequences.length - 1] + 1 : 1;

        for (let a = 1; a <= numActs; a++) {
            acts.push(a);
            for (let c = 1; c <= chaptersPerAct; c++) {
                const chapterNum = (a - 1) * chaptersPerAct + c;
                chapters.push(chapterNum);

                if (createScenes) {
                    for (let s = 1; s <= scenesPerChapter; s++) {
                        const chLabel = this._activeProject.chapterLabels[chapterNum];
                        const title = chLabel
                            ? `Chapter ${chapterNum} — ${chLabel}`
                            : `Chapter ${chapterNum}`;
                        await this.createScene({
                            title,
                            act: a,
                            chapter: chapterNum,
                            sequence: nextSeq++,
                            status: 'idea' as SceneStatus,
                        });
                        scenesCreated++;
                    }
                }
            }
        }

        // Merge into project
        const mergedActs = new Set([...this._activeProject.definedActs, ...acts]);
        this._activeProject.definedActs = Array.from(mergedActs).sort((a, b) => a - b);
        const mergedChapters = new Set([...this._activeProject.definedChapters, ...chapters]);
        this._activeProject.definedChapters = Array.from(mergedChapters).sort((a, b) => a - b);

        await this.saveProjectFrontmatter(this._activeProject);

        return { acts: acts.length, chapters: chapters.length, scenes: scenesCreated };
    }

    // ────────────────────────────────────
    //  Scene Notes (external files)
    // ────────────────────────────────────

    /**
     * Get or create the external notes file path for a scene.
     * Returns the vault-relative path to the notes .md file.
     * If the scene doesn't have a notesFile yet, one is created.
     */
    async getOrCreateSceneNotesFile(scene: Scene): Promise<string> {
        if (scene.notesFile) {
            // Verify the file still exists
            const existing = this.app.vault.getAbstractFileByPath(scene.notesFile);
            if (existing && existing instanceof TFile) {
                return this.migrateLegacySceneNotesName(scene, existing);
            }
        }

        // Create a new notes file
        const notesFolder = this.getSceneNotesFolder();
        await this.ensureFolder(notesFolder);

        const filePath = this.getUniqueSceneNotesPath(scene);

        // Migrate existing inline notes to the file. Do not add a title
        // heading here; the Scene Detail sidebar already shows the scene title.
        const initialContent = scene.notes ? `${scene.notes}\n` : '';

        await this.app.vault.create(filePath, initialContent);

        // Update scene frontmatter with the notesFile path
        await this.updateScene(scene.filePath, { notesFile: filePath });
        scene.notesFile = filePath;

        return filePath;
    }

    /**
     * Read-only lookup of a scene's external notes file path.
     *
     * Returns the vault-relative path if the scene has a `notesFile` *and* the
     * file still exists on disk; otherwise `undefined`. Crucially this does
     * **not** create a file — render paths (Inspector / InfoPanel / NotesView)
     * use it so that merely opening a scene doesn't sprout an empty
     * `Title - Notes.md`. Creation is deferred to `writeSceneNotes()` /
     * `getOrCreateSceneNotesFile()`, which are only called when the user
     * actually types something or explicitly opens the notes file.
     *
     * Issue #200.
     */
    getSceneNotesFile(scene: Scene): string | undefined {
        if (!scene.notesFile) return undefined;
        const existing = this.app.vault.getAbstractFileByPath(scene.notesFile);
        return existing instanceof TFile ? scene.notesFile : undefined;
    }

    private getSceneNotesBaseName(scene: Scene): string {
        const safeTitle = (scene.title || 'Untitled')
            .replace(/[\\/:*?"<>|]/g, '-')
            .substring(0, 52)
            .trim() || 'Untitled';
        return `${safeTitle} - Notes`;
    }

    private getLegacySceneNotesBaseName(scene: Scene): string {
        return (scene.title || 'Untitled')
            .replace(/[\\/:*?"<>|]/g, '-')
            .substring(0, 60)
            .trim() || 'Untitled';
    }

    private getUniqueSceneNotesPath(scene: Scene, currentPath?: string): string {
        const notesFolder = this.getSceneNotesFolder();
        const baseName = this.getSceneNotesBaseName(scene);
        const current = currentPath ? normalizePath(currentPath) : '';
        let filePath = normalizePath(`${notesFolder}/${baseName}.md`);
        let dedupe = 1;
        while (this.app.vault.getAbstractFileByPath(filePath) && normalizePath(filePath) !== current) {
            filePath = normalizePath(`${notesFolder}/${baseName} (${dedupe}).md`);
            dedupe++;
        }
        return filePath;
    }

    private isLegacySceneNotesName(scene: Scene, file: TFile): boolean {
        const notesFolder = normalizePath(this.getSceneNotesFolder());
        if (!normalizePath(file.path).startsWith(`${notesFolder}/`)) return false;
        const legacyBase = this.getLegacySceneNotesBaseName(scene);
        if (file.basename === legacyBase) return true;
        const escaped = legacyBase.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        return new RegExp(`^${escaped} \\(\\d+\\)$`).test(file.basename);
    }

    private async migrateLegacySceneNotesName(scene: Scene, file: TFile): Promise<string> {
        if (!this.isLegacySceneNotesName(scene, file)) return file.path;
        const targetPath = this.getUniqueSceneNotesPath(scene, file.path);
        if (normalizePath(targetPath) === normalizePath(file.path)) return file.path;
        await this.app.fileManager.renameFile(file, targetPath);
        await this.updateScene(scene.filePath, { notesFile: targetPath });
        scene.notesFile = targetPath;
        return targetPath;
    }

    /**
     * Read the content of a scene's external notes file.
     * Returns the raw markdown content, or undefined if no notes file exists.
     */
    async readSceneNotes(scene: Scene): Promise<string | undefined> {
        if (!scene.notesFile) return scene.notes || undefined;
        const file = this.app.vault.getAbstractFileByPath(scene.notesFile);
        if (!file || !(file instanceof TFile)) return scene.notes || undefined;
        return this.app.vault.read(file);
    }

    /**
     * Write content to a scene's external notes file.
     * Creates the file if it doesn't exist yet.
     */
    async writeSceneNotes(scene: Scene, content: string): Promise<void> {
        const notesPath = await this.getOrCreateSceneNotesFile(scene);
        const file = this.app.vault.getAbstractFileByPath(notesPath);
        if (file && file instanceof TFile) {
            await this.app.vault.modify(file, content);
        }
    }

    /**
     * Open a scene's external notes file in an Obsidian editor tab.
     * Creates the file if it doesn't exist yet.
     */
    async openSceneNotes(scene: Scene): Promise<void> {
        const notesPath = await this.getOrCreateSceneNotesFile(scene);
        const file = this.app.vault.getAbstractFileByPath(notesPath);
        if (file && file instanceof TFile) {
            await this.app.workspace.getLeaf(false).openFile(file);
        }
    }

    /**
     * Delete a scene's external notes file and clear the notesFile reference.
     */
    async deleteSceneNotes(scene: Scene): Promise<void> {
        if (!scene.notesFile) return;
        const file = this.app.vault.getAbstractFileByPath(scene.notesFile);
        if (file && file instanceof TFile) {
            await this.app.fileManager.trashFile(file);
        }
        await this.updateScene(scene.filePath, { notesFile: undefined });
        scene.notesFile = undefined;
    }

    // ────────────────────────────────────
    //  Filter presets (per-project)
    // ────────────────────────────────────

    /** Get filter presets for the active project */
    getFilterPresets(): FilterPreset[] {
        return this._activeProject?.filterPresets ?? [];
    }

    /** Add a filter preset to the active project */
    async addFilterPreset(preset: FilterPreset): Promise<void> {
        if (!this._activeProject) return;
        this._activeProject.filterPresets.push(preset);
        await this.saveProjectFrontmatter(this._activeProject);
    }

    /** Remove a filter preset by index */
    async removeFilterPreset(index: number): Promise<void> {
        if (!this._activeProject) return;
        this._activeProject.filterPresets.splice(index, 1);
        await this.saveProjectFrontmatter(this._activeProject);
    }

    /** Get persisted corkboard positions from System/board.json */
    getCorkboardPositions(): Record<string, { x: number; y: number; z?: number; w?: number; h?: number }> {
        // Return the in-memory cache (populated by loadCorkboardPositions)
        return this._activeProject?.corkboardPositions ?? {};
    }

    /** Load corkboard positions from System/board.json into the active project */
    async loadCorkboardPositions(): Promise<void> {
        if (!this._activeProject) return;
        try {
            const adapter = this.plugin.app.vault.adapter;
            const sysFolder = this.plugin.getProjectSystemFolder();
            const path = `${sysFolder}/board.json`;
            if (!await adapter.exists(path)) {
                this._activeProject.corkboardPositions = {};
                return;
            }
            const raw = JSON.parse(await adapter.read(path));
            const positions: Record<string, { x: number; y: number; z?: number; w?: number; h?: number }> = {};
            if (raw.corkboardPositions && typeof raw.corkboardPositions === 'object') {
                for (const [key, value] of Object.entries(raw.corkboardPositions)) {
                    const v = value as { x?: unknown; y?: unknown; z?: unknown; w?: unknown; h?: unknown };
                    const x = Number(v?.x);
                    const y = Number(v?.y);
                    const z = Number(v?.z);
                    if (!Number.isFinite(x) || !Number.isFinite(y)) continue;
                    const entry: { x: number; y: number; z?: number; w?: number; h?: number } = Number.isFinite(z) ? { x, y, z } : { x, y };
                    const w = Number(v?.w);
                    if (Number.isFinite(w) && w > 0) entry.w = w;
                    const h = Number(v?.h);
                    if (Number.isFinite(h) && h > 0) entry.h = h;
                    positions[key] = entry;
                }
            }
            this._activeProject.corkboardPositions = positions;
        } catch {
            if (this._activeProject) this._activeProject.corkboardPositions = {};
        }
    }

    /** Persist corkboard positions to System/board.json */
    async setCorkboardPositions(positions: Record<string, { x: number; y: number; z?: number; w?: number; h?: number }>): Promise<void> {
        if (!this._activeProject) return;

        const cleaned: Record<string, { x: number; y: number; z?: number; w?: number; h?: number }> = {};
        for (const [path, pos] of Object.entries(positions)) {
            const x = Number(pos?.x);
            const y = Number(pos?.y);
            if (!Number.isFinite(x) || !Number.isFinite(y)) continue;
            const z = Number(pos?.z);
            const entry: { x: number; y: number; z?: number; w?: number; h?: number } = Number.isFinite(z) ? { x, y, z } : { x, y };
            const w = Number((pos as unknown as Record<string, unknown>)?.w);
            if (Number.isFinite(w) && w > 0) entry.w = w;
            const h = Number((pos as unknown as Record<string, unknown>)?.h);
            if (Number.isFinite(h) && h > 0) entry.h = h;
            cleaned[path] = entry;
        }

        const prev = this._activeProject.corkboardPositions || {};
        const unchanged = JSON.stringify(prev) === JSON.stringify(cleaned);
        this._activeProject.corkboardPositions = cleaned;
        if (unchanged) return;

        // Write to System/board.json
        try {
            const adapter = this.plugin.app.vault.adapter;
            const sysFolder = this.plugin.getProjectSystemFolder();
            if (!await adapter.exists(sysFolder)) {
                await this.plugin.app.vault.createFolder(sysFolder);
            }
            await adapter.write(`${sysFolder}/board.json`, JSON.stringify({ corkboardPositions: cleaned }));
        } catch (e) {
            console.error('[NarrativeLab] Failed to save corkboard positions:', e);
        }
    }

    // ────────────────────────────────────
    //  Project frontmatter persistence
    // ────────────────────────────────────

    /**
     * Save project-specific data back to the project .md frontmatter.
     * Preserves the body content below the frontmatter.
     * Writes are serialized + retried — concurrent modify on Windows often
     * surfaces as Obsidian "UNKNOWN: unknown error, open" notice spam.
     */
    async saveProjectFrontmatter(project: StoryLineProject): Promise<void> {
        const run = this._projectFrontmatterWrite.then(
            () => this.saveProjectFrontmatterUnqueued(project),
            () => this.saveProjectFrontmatterUnqueued(project),
        );
        this._projectFrontmatterWrite = run.then(() => undefined, () => undefined);
        return run;
    }

    private async saveProjectFrontmatterUnqueued(project: StoryLineProject): Promise<void> {
        const file = this.app.vault.getAbstractFileByPath(project.filePath);
        if (!file || !(file instanceof TFile)) return;

        // If we're rewriting the *active* project's frontmatter, also bring the
        // module-level word-count tokeniser in sync immediately.
        if (this._activeProject?.filePath === project.filePath) {
            this.applyActiveProjectLocale();
        }

        const buildContent = async (): Promise<string | null> => {
            const content = await this.app.vault.read(file);
            const fmMatch = content.match(/^---\r?\n([\s\S]*?)\r?\n---/);
            let existingFm: Record<string, unknown> = {};
            let body = content;

            if (fmMatch) {
                try {
                    existingFm = parseYaml(fmMatch[1]) || {};
                } catch {
                    existingFm = {};
                }
                body = content.slice(fmMatch[0].length);
            }

            // Update project-specific fields
            existingFm.type = 'storyline';
            existingFm.title = project.title;
            existingFm.created = project.created;

            // Multi-language support — persist BCP-47 locale.
            if (project.locale) {
                existingFm.language = normalizeStoryLineLocale(project.locale);
                // Drop the legacy/community-PR key if both were present.
                if ('storyline-locale' in existingFm) delete existingFm['storyline-locale'];
            }

            // Acts & chapters — only write if non-empty, remove if empty
            if (project.definedActs.length > 0) {
                existingFm.acts = project.definedActs;
            } else {
                delete existingFm.acts;
            }
            if (project.definedChapters.length > 0) {
                existingFm.chapters = project.definedChapters;
            } else {
                delete existingFm.chapters;
            }

            // Act labels (beat names)
            if (Object.keys(project.actLabels).length > 0) {
                existingFm.actLabels = project.actLabels;
            } else {
                delete existingFm.actLabels;
            }

            // Chapter labels
            if (Object.keys(project.chapterLabels).length > 0) {
                existingFm.chapterLabels = project.chapterLabels;
            } else {
                delete existingFm.chapterLabels;
            }

            // Act descriptions
            if (Object.keys(project.actDescriptions).length > 0) {
                existingFm.actDescriptions = project.actDescriptions;
            } else {
                delete existingFm.actDescriptions;
            }

            // Chapter descriptions
            if (Object.keys(project.chapterDescriptions).length > 0) {
                existingFm.chapterDescriptions = project.chapterDescriptions;
            } else {
                delete existingFm.chapterDescriptions;
            }

            // Filter presets
            if (project.filterPresets.length > 0) {
                existingFm.filterPresets = project.filterPresets;
            } else {
                delete existingFm.filterPresets;
            }

            // Explicit plotlines preserve empty story threads before scenes are assigned.
            if (project.plotlines && project.plotlines.length > 0) {
                existingFm.plotlines = [...new Set(project.plotlines.map(name => name.trim()).filter(Boolean))];
            } else {
                delete existingFm.plotlines;
            }

            // corkboardPositions no longer stored in frontmatter — lives in System/board.json
            delete existingFm.corkboardPositions;

            // Series ID
            if (project.seriesId) {
                existingFm.seriesId = project.seriesId;
            } else {
                delete existingFm.seriesId;
            }

            // Cover image
            if (project.coverImage) {
                existingFm.coverImage = project.coverImage;
            } else {
                delete existingFm.coverImage;
            }

            // Active beat sheet template
            if (project.activeBeatSheet) {
                existingFm.activeBeatSheet = project.activeBeatSheet;
            } else {
                delete existingFm.activeBeatSheet;
            }

            // Drafts — folder-isolated under Scenes/<folder>/
            this.ensureProjectDrafts(project);
            if (project.drafts && project.drafts.length > 0) {
                existingFm.drafts = project.drafts.map(d => {
                    const entry: Record<string, unknown> = { id: d.id, title: d.title };
                    if (d.folder) entry.folder = d.folder;
                    if (d.scenePaths && d.scenePaths.length > 0) entry.scenes = d.scenePaths;
                    return entry;
                });
            } else {
                delete existingFm.drafts;
            }
            if (project.activeDraftId) {
                existingFm.activeDraft = project.activeDraftId;
            } else {
                delete existingFm.activeDraft;
            }
            delete existingFm.activeDraftId;

            // Library tab id → folder basename (parallel with tab labels)
            if (project.libraryFolders && Object.keys(project.libraryFolders).length > 0) {
                existingFm.libraryFolders = { ...project.libraryFolders };
            } else {
                delete existingFm.libraryFolders;
            }

            const newContent = `---\n${stringifyYaml(existingFm)}---${body}`;
            // Skip no-op writes — they still contend with the open editor on Windows.
            if (newContent === content) return null;
            return newContent;
        };

        return this.plugin.withSuppressedVaultEcho(file.path, async () => {
            let lastError: unknown;
            for (let attempt = 0; attempt < 4; attempt++) {
                try {
                    const newContent = await buildContent();
                    if (newContent == null) return;
                    await this.app.vault.modify(file, newContent);
                    return;
                } catch (err) {
                    lastError = err;
                    // Brief backoff for sharing violations / OneDrive / editor autosave races.
                    await new Promise(resolve => window.setTimeout(resolve, 80 * (attempt + 1)));
                }
            }
            console.error('[NarrativeLab] saveProjectFrontmatter failed after retries', project.filePath, lastError);
            throw lastError instanceof Error ? lastError : new Error(String(lastError));
        });
    }

    // ────────────────────────────────────
    //  Drafts (folder-isolated under Scenes/)
    // ────────────────────────────────────

    /** Ensure the project has at least one draft and a valid activeDraftId. */
    ensureProjectDrafts(project: StoryLineProject): void {
        if (!project.drafts || project.drafts.length === 0) {
            project.drafts = [{ id: 'main', title: 'Primary draft' }];
        }
        if (!project.activeDraftId || !project.drafts.some(d => d.id === project.activeDraftId)) {
            project.activeDraftId = project.drafts[0].id;
        }
    }

    /**
     * Display label for a draft. Named drafts use their Scenes/ subfolder name;
     * the primary draft keeps the localized "Primary draft" title.
     */
    draftDisplayTitle(draft: ProjectDraft): string {
        if (draft.folder) return draft.folder;
        if (draft.title === 'Main' || draft.title === 'Primary draft' || draft.id === 'main') {
            return 'Primary draft';
        }
        return draft.title || 'Primary draft';
    }

    getDrafts(): ProjectDraft[] {
        const project = this._activeProject;
        if (!project) return [];
        this.ensureProjectDrafts(project);
        return project.drafts ?? [];
    }

    getActiveDraft(): ProjectDraft | null {
        const project = this._activeProject;
        if (!project) return null;
        this.ensureProjectDrafts(project);
        return project.drafts?.find(d => d.id === project.activeDraftId) ?? project.drafts?.[0] ?? null;
    }

    /** Absolute vault path of a draft's Scenes subfolder, or Scenes root for primary. */
    getDraftSceneRoot(draft?: ProjectDraft | null): string {
        const sceneFolder = normalizePath(this.getSceneFolder());
        if (draft?.folder) return normalizePath(`${sceneFolder}/${draft.folder}`);
        return sceneFolder;
    }

    /** Draft that currently owns a scene path, or the primary/active draft as fallback. */
    getDraftOwningScenePath(scenePath: string): ProjectDraft | null {
        const project = this._activeProject;
        if (!project) return null;
        this.ensureProjectDrafts(project);
        const drafts = project.drafts ?? [];
        for (const draft of drafts) {
            if (draft.folder && this.sceneBelongsToDraft(scenePath, draft, project)) return draft;
        }
        const primary = drafts.find(d => !d.folder) ?? drafts[0] ?? null;
        if (primary && this.sceneBelongsToDraft(scenePath, primary, project)) return primary;
        return this.getActiveDraft();
    }

    private sanitizeDraftFolderName(name: string): string {
        const cleaned = name.trim().replace(/[\\/:*?"<>|]/g, '-').replace(/\s+/g, ' ').trim();
        return cleaned || 'Draft';
    }

    private uniqueDraftFolderName(desired: string): string {
        const sceneFolder = normalizePath(this.getSceneFolder());
        let base = this.sanitizeDraftFolderName(desired);
        let candidate = base;
        let n = 2;
        while (this.app.vault.getAbstractFileByPath(normalizePath(`${sceneFolder}/${candidate}`))) {
            candidate = `${base} ${n}`;
            n++;
        }
        return candidate;
    }

    private draftFolderPrefixes(project: StoryLineProject): string[] {
        const sceneFolder = normalizePath(this.getSceneFolder());
        return (project.drafts ?? [])
            .map(d => d.folder)
            .filter((f): f is string => !!f)
            .map(f => normalizePath(`${sceneFolder}/${f}/`));
    }

    private sceneBelongsToDraft(scenePath: string, draft: ProjectDraft, project: StoryLineProject): boolean {
        const path = normalizePath(scenePath);
        const sceneFolder = normalizePath(this.getSceneFolder());
        if (!this.isPathUnderFolder(path, sceneFolder)) return false;
        const prefixes = this.draftFolderPrefixes(project);
        if (draft.folder) {
            const mine = normalizePath(`${sceneFolder}/${draft.folder}/`);
            return path.startsWith(mine);
        }
        // Primary: in Scenes/ but not inside any other draft folder
        return !prefixes.some(p => path.startsWith(p));
    }

    compareScenesReadingOrder(a: Scene, b: Scene): number {
        const actCmp = compareActChapter(a.act, b.act);
        if (actCmp !== 0) return actCmp;
        const chCmp = compareActChapter(a.chapter, b.chapter);
        if (chCmp !== 0) return chCmp;
        return (a.sequence ?? 9999) - (b.sequence ?? 9999);
    }

    sortScenesReadingOrder(scenes: Scene[]): Scene[] {
        return scenes.slice().sort((a, b) => this.compareScenesReadingOrder(a, b));
    }

    /**
     * Migrate legacy drafts that only had shared scenePaths (no folder) into
     * independent Scenes/<name>/ copies so deletes no longer affect other drafts.
     */
    async migrateDraftFoldersIfNeeded(): Promise<void> {
        const project = this._activeProject;
        if (!project) return;
        this.ensureProjectDrafts(project);
        let dirty = false;
        const sceneFolder = normalizePath(this.getSceneFolder());

        for (const draft of project.drafts ?? []) {
            if (draft.id === 'main' || draft.folder) continue;

            const folderName = this.uniqueDraftFolderName(draft.title || 'Draft');
            const draftRoot = normalizePath(`${sceneFolder}/${folderName}`);
            await this.ensureFolder(draftRoot);

            const sourcePaths = draft.scenePaths?.length
                ? draft.scenePaths
                : this.getAllScenes()
                    .filter(s => !s.corkboardNote && !s.inactive && this.sceneBelongsToDraft(s.filePath, { id: 'main', title: 'Primary draft' }, project))
                    .map(s => s.filePath);

            const newPaths: string[] = [];
            for (const srcPath of sourcePaths) {
                const srcFile = this.app.vault.getAbstractFileByPath(srcPath);
                if (!(srcFile instanceof TFile)) continue;
                let rel = normalizePath(srcPath);
                if (rel.startsWith(sceneFolder + '/')) rel = rel.slice(sceneFolder.length + 1);
                else rel = srcFile.name;
                // Don't nest another draft folder inside this one
                for (const other of project.drafts ?? []) {
                    if (other.folder && (rel === other.folder || rel.startsWith(other.folder + '/'))) {
                        rel = srcFile.name;
                        break;
                    }
                }
                let dest = normalizePath(`${draftRoot}/${rel}`);
                const destDir = dest.includes('/') ? dest.slice(0, dest.lastIndexOf('/')) : draftRoot;
                await this.ensureFolder(destDir);
                let dedupe = 1;
                while (this.app.vault.getAbstractFileByPath(dest)) {
                    const stem = rel.replace(/\.md$/i, '');
                    dest = normalizePath(`${draftRoot}/${stem} (${dedupe}).md`);
                    dedupe++;
                }
                await this.app.vault.copy(srcFile, dest);
                const copied = await MetadataParser.parseFile(this.app, this.app.vault.getAbstractFileByPath(dest) as TFile);
                if (copied) {
                    this.scenes.set(dest, copied);
                    this.bumpVersion(dest);
                }
                newPaths.push(dest);
            }

            draft.folder = folderName;
            draft.title = folderName;
            draft.scenePaths = newPaths.length > 0 ? newPaths : undefined;
            dirty = true;
        }

        if (dirty) {
            await this.saveProjectFrontmatter(project);
            new Notice('Drafts migrated to Scenes/ subfolders');
        }
    }

    async setActiveDraft(draftId: string): Promise<void> {
        if (!this._activeProject) return;
        await this.migrateDraftFoldersIfNeeded();
        await this.reconcileDraftFolders();
        this.ensureProjectDrafts(this._activeProject);
        if (!this._activeProject.drafts?.some(d => d.id === draftId)) return;
        this._activeProject.activeDraftId = draftId;
        await this.saveProjectFrontmatter(this._activeProject);
        this.bumpVersion(); // invalidate query cache so board/manuscript re-scope
    }

    /**
     * Create a new draft as Scenes/<name>/, copying the active draft's scenes
     * into that folder so edits/deletes stay isolated.
     */
    async createDraft(title: string, snapshotScenes = true): Promise<ProjectDraft | null> {
        if (!this._activeProject) return null;
        await this.migrateDraftFoldersIfNeeded();
        this.ensureProjectDrafts(this._activeProject);

        const folderName = this.uniqueDraftFolderName(title.trim() || 'Draft');
        const sceneFolder = normalizePath(this.getSceneFolder());
        const draftRoot = normalizePath(`${sceneFolder}/${folderName}`);
        await this.ensureFolder(draftRoot);

        const sourceDraft = this.getActiveDraft();
        const sourceRoot = this.getDraftSceneRoot(sourceDraft);
        const sourceScenes = snapshotScenes
            ? this.sortScenesReadingOrder(this.getScenesForDraft(sourceDraft?.id))
            : [];

        const newPaths: string[] = [];
        for (const scene of sourceScenes) {
            const srcFile = this.app.vault.getAbstractFileByPath(scene.filePath);
            if (!(srcFile instanceof TFile)) continue;
            let rel = normalizePath(scene.filePath);
            if (rel.startsWith(sourceRoot + '/')) rel = rel.slice(sourceRoot.length + 1);
            else rel = srcFile.name;
            let dest = normalizePath(`${draftRoot}/${rel}`);
            const destDir = dest.includes('/') ? dest.slice(0, dest.lastIndexOf('/')) : draftRoot;
            await this.ensureFolder(destDir);
            let dedupe = 1;
            while (this.app.vault.getAbstractFileByPath(dest)) {
                const stem = rel.replace(/\.md$/i, '');
                dest = normalizePath(`${draftRoot}/${stem} (${dedupe}).md`);
                dedupe++;
            }
            await this.app.vault.copy(srcFile, dest);
            const copied = await MetadataParser.parseFile(this.app, this.app.vault.getAbstractFileByPath(dest) as TFile);
            if (copied) {
                this.scenes.set(dest, copied);
                this.bumpVersion(dest);
            }
            newPaths.push(dest);
        }

        const id = `draft-${Date.now().toString(36)}`;
        const draft: ProjectDraft = {
            id,
            title: folderName,
            folder: folderName,
            scenePaths: newPaths.length > 0 ? newPaths : undefined,
        };
        this._activeProject.drafts = [...(this._activeProject.drafts ?? []), draft];
        this._activeProject.activeDraftId = draft.id;
        await this.saveProjectFrontmatter(this._activeProject);
        new Notice(`Draft folder created: Scenes/${folderName}`);
        return draft;
    }

    /** Rename a draft and its Scenes/<folder> (keeps sidebar label in sync). */
    async renameDraft(draftId: string, title: string): Promise<void> {
        if (!this._activeProject?.drafts) return;
        const draft = this._activeProject.drafts.find(d => d.id === draftId);
        if (!draft) return;

        const newName = this.sanitizeDraftFolderName(title);
        if (!newName) return;

        if (draft.folder && draft.folder !== newName) {
            const sceneFolder = normalizePath(this.getSceneFolder());
            const oldPath = normalizePath(`${sceneFolder}/${draft.folder}`);
            let finalName = newName;
            let destPath = normalizePath(`${sceneFolder}/${finalName}`);
            let n = 2;
            while (
                destPath !== oldPath
                && this.app.vault.getAbstractFileByPath(destPath)
            ) {
                finalName = `${newName} ${n}`;
                destPath = normalizePath(`${sceneFolder}/${finalName}`);
                n++;
            }
            const folder = this.app.vault.getAbstractFileByPath(oldPath);
            if (folder instanceof TFolder) {
                await this.app.fileManager.renameFile(folder, destPath);
                const oldPrefix = oldPath + '/';
                const newPrefix = destPath + '/';
                if (draft.scenePaths) {
                    draft.scenePaths = draft.scenePaths.map(p => {
                        const np = normalizePath(p);
                        return np.startsWith(oldPrefix) ? newPrefix + np.slice(oldPrefix.length) : p;
                    });
                }
                // Re-key in-memory scene index for moved files
                for (const [path, scene] of [...this.scenes.entries()]) {
                    const np = normalizePath(path);
                    if (np.startsWith(oldPrefix)) {
                        const next = newPrefix + np.slice(oldPrefix.length);
                        this.scenes.delete(path);
                        scene.filePath = next;
                        this.scenes.set(next, scene);
                    }
                }
            }
            draft.folder = finalName;
            draft.title = finalName;
        } else if (!draft.folder) {
            // Primary draft — title only
            draft.title = newName === 'Primary draft' || newName === '正文' ? 'Primary draft' : newName;
        } else {
            draft.title = draft.folder;
        }
        await this.saveProjectFrontmatter(this._activeProject);
    }

    /**
     * When the user renames a draft folder in the file explorer, keep the
     * draft registry / sidebar label matched to the new folder name.
     */
    async handleDraftFolderRename(oldPath: string, newPath: string): Promise<boolean> {
        const project = this._activeProject;
        if (!project?.drafts) return false;
        const sceneFolder = normalizePath(this.getSceneFolder());
        const oldNorm = normalizePath(oldPath);
        const newNorm = normalizePath(newPath);
        // Only direct children of Scenes/ are draft roots
        const oldParent = oldNorm.includes('/') ? oldNorm.slice(0, oldNorm.lastIndexOf('/')) : '';
        if (oldParent !== sceneFolder) return false;

        const oldName = oldNorm.slice(sceneFolder.length + 1);
        const newName = newNorm.slice(sceneFolder.length + 1);
        if (!oldName || !newName || newName.includes('/')) return false;

        const draft = project.drafts.find(d => d.folder === oldName);
        if (!draft) return false;

        draft.folder = newName;
        draft.title = newName;
        const oldPrefix = oldNorm + '/';
        const newPrefix = newNorm + '/';
        if (draft.scenePaths) {
            draft.scenePaths = draft.scenePaths.map(p => {
                const np = normalizePath(p);
                return np.startsWith(oldPrefix) ? newPrefix + np.slice(oldPrefix.length) : p;
            });
        }
        await this.saveProjectFrontmatter(project);
        return true;
    }

    /**
     * When a Scenes/<draft>/ folder is deleted in the file explorer, drop that
     * draft from the project registry so the layers menu stays in sync.
     * Also called opportunistically to prune any already-missing draft folders.
     */
    async reconcileDraftFolders(): Promise<boolean> {
        const project = this._activeProject;
        if (!project) return false;
        this.ensureProjectDrafts(project);
        if (!project.drafts || project.drafts.length === 0) return false;

        const sceneFolder = normalizePath(this.getSceneFolder());
        const kept: ProjectDraft[] = [];
        const removedTitles: string[] = [];

        for (const draft of project.drafts) {
            if (!draft.folder) {
                kept.push(draft);
                continue;
            }
            const draftRoot = normalizePath(`${sceneFolder}/${draft.folder}`);
            const folder = this.app.vault.getAbstractFileByPath(draftRoot);
            if (folder instanceof TFolder) {
                kept.push(draft);
            } else {
                removedTitles.push(draft.folder || draft.title || draft.id);
            }
        }

        if (kept.length === 0) {
            kept.push({ id: 'main', title: 'Primary draft' });
        }

        const activeMissing = !kept.some(d => d.id === project.activeDraftId);
        const listChanged = kept.length !== project.drafts.length
            || kept.some((d, i) => d.id !== project.drafts![i]?.id);

        if (!listChanged && !activeMissing) return false;

        project.drafts = kept;
        if (activeMissing || !project.activeDraftId) {
            project.activeDraftId = kept[0].id;
        }
        await this.saveProjectFrontmatter(project);
        this.bumpVersion();
        if (removedTitles.length > 0) {
            new Notice(
                removedTitles.length === 1
                    ? `Draft folder removed: ${removedTitles[0]}`
                    : `Removed ${removedTitles.length} missing draft folders`
            );
        }
        return true;
    }

    /** Handle vault delete of a draft root folder under Scenes/. */
    async handleDraftFolderDelete(path: string): Promise<boolean> {
        const project = this._activeProject;
        if (!project?.drafts) return false;
        const sceneFolder = normalizePath(this.getSceneFolder());
        const norm = normalizePath(path);
        const parent = norm.includes('/') ? norm.slice(0, norm.lastIndexOf('/')) : '';
        // Direct draft root, or reconcile whenever anything under Scenes/ vanishes
        if (parent === sceneFolder || norm === sceneFolder || norm.startsWith(sceneFolder + '/')) {
            return this.reconcileDraftFolders();
        }
        return false;
    }

    async deleteDraft(draftId: string): Promise<boolean> {
        if (!this._activeProject?.drafts) return false;
        this.ensureProjectDrafts(this._activeProject);
        if ((this._activeProject.drafts?.length ?? 0) <= 1) return false;
        const draft = this._activeProject.drafts.find(d => d.id === draftId);
        this._activeProject.drafts = this._activeProject.drafts.filter(d => d.id !== draftId);
        if (this._activeProject.activeDraftId === draftId) {
            this._activeProject.activeDraftId = this._activeProject.drafts[0]?.id;
        }
        // Leave the Scenes/<folder> on disk — user can delete manually.
        // Drop in-memory index entries for that folder so binder won't list them
        // while another draft is active (they're still filtered by folder).
        void draft;
        await this.saveProjectFrontmatter(this._activeProject);
        return true;
    }

    /** Scenes belonging to a draft (or the active draft when omitted). */
    getScenesForDraft(draftId?: string): Scene[] {
        const project = this._activeProject;
        if (!project) return [];
        this.ensureProjectDrafts(project);
        const draft = draftId
            ? project.drafts?.find(d => d.id === draftId)
            : this.getActiveDraft();
        if (!draft) return [];

        const all = this.getAllScenes().filter(s => !s.corkboardNote && !s.inactive);
        const candidates = all.filter(s => this.sceneBelongsToDraft(s.filePath, draft, project));

        if (draft.scenePaths && draft.scenePaths.length > 0) {
            const byPath = new Map(candidates.map(s => [s.filePath, s]));
            const ordered: Scene[] = [];
            for (const path of draft.scenePaths) {
                const scene = byPath.get(path);
                if (scene) {
                    ordered.push(scene);
                    byPath.delete(path);
                }
            }
            // New files in the draft folder not yet in the order list
            for (const scene of this.sortScenesReadingOrder([...byPath.values()])) {
                ordered.push(scene);
            }
            return ordered;
        }
        return this.sortScenesReadingOrder(candidates);
    }

    // --- Private helpers ---

    private getNextSequence(afterScene?: Scene): number {
        // Only real scenes participate in the sequence space; corkboard notes
        // are excluded so they don't inflate the next sequence number.
        const allSequences = this.getAllScenes()
            .filter(s => !s.corkboardNote)
            .map(s => s.sequence ?? 0)
            .sort((a, b) => a - b);

        if (afterScene?.sequence !== undefined) {
            return afterScene.sequence + 1;
        }

        return allSequences.length > 0 ? allSequences[allSequences.length - 1] + 1 : 1;
    }

    private async ensureFolder(folderPath: string): Promise<void> {
        const normalized = normalizePath(folderPath);
        const adapter = this.app.vault.adapter;
        if (await adapter.exists(normalized)) return;
        const parts = normalized.split('/').filter(Boolean);
        let cur = '';
        for (const part of parts) {
            cur = cur ? `${cur}/${part}` : part;
            if (!await adapter.exists(cur)) {
                await this.app.vault.createFolder(cur);
            }
        }
    }

    /**
     * Issue #77 \u2014 parse the user's `defaultSceneFrontmatter` setting (raw
     * YAML) into a plain object suitable for merging into a new scene's
     * frontmatter. Returns `undefined` when the setting is empty or invalid
     * so the caller can skip the merge cleanly.
     */
    private parseDefaultSceneFrontmatter(): Record<string, unknown> | undefined {
        const raw = this.plugin.settings.defaultSceneFrontmatter;
        if (!raw || !raw.trim()) return undefined;
        try {
            const parsed = parseYaml(raw);
            if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
                return parsed as unknown as Record<string, unknown>;
            }
        } catch (err) {
            console.warn('NarrativeLab: invalid YAML in defaultSceneFrontmatter setting', err);
        }
        return undefined;
    }

    /**
     * Issue #77 \u2014 seed `universalFields` with `defaultValue` from every
     * scene-category template that defines one, without overwriting any
     * value the caller already supplied.
     */
    private seedSceneUniversalDefaults(existing: Record<string, unknown> | undefined): Record<string, unknown> | undefined {
        const templates = this.plugin?.fieldTemplates?.getAll?.() ?? [];
        const sceneTemplates = templates.filter(t => (t.category || 'character') === 'scene' && t.defaultValue);
        if (sceneTemplates.length === 0) return existing;
        const out: Record<string, unknown> = { ...(existing || {}) };
        for (const t of sceneTemplates) {
            if (out[t.id] !== undefined && out[t.id] !== '' && !(Array.isArray(out[t.id]) && (out[t.id] as unknown[]).length === 0)) continue;
            const dv = t.defaultValue!;
            if (t.type === 'multi-select') {
                out[t.id] = dv.split(',').map(s => s.trim()).filter(Boolean);
            } else {
                out[t.id] = dv;
            }
        }
        return Object.keys(out).length > 0 ? out : undefined;
    }

    // ────────────────────────────────────
    //  Split & Merge
    // ────────────────────────────────────

    /**
     * Split a scene into two at a given character offset in the body text.
     * Scene A keeps the original's metadata. Scene B inherits all metadata
     * (including status) but gets a new sequence number.
     *
     * Returns [sceneA file, sceneB file].
     */
    async splitScene(
        filePath: string,
        splitOffset: number,
        titleA?: string,
        titleB?: string,
    ): Promise<[TFile, TFile]> {
        const scene = this.scenes.get(filePath);
        if (!scene) throw new Error('Scene not found');

        const body = scene.body || '';
        const bodyA = body.substring(0, splitOffset).trim();
        const bodyB = body.substring(splitOffset).trim();

        // Scene A: update existing file with first half
        const file = this.app.vault.getAbstractFileByPath(filePath);
        if (!file || !(file instanceof TFile)) throw new Error('Scene file not found');

        const updatesA: Partial<Scene> = { body: bodyA };
        if (titleA) updatesA.title = titleA;
        await MetadataParser.updateFrontmatter(this.app, file, updatesA);
        const parsedA = await MetadataParser.parseFile(this.app, file);
        if (parsedA) this.scenes.set(file.path, parsedA);
        this.bumpVersion(file.path);

        // Shift sequence numbers for all scenes after the original
        const origSeq = scene.sequence ?? 0;
        const allScenes = this.getAllScenes()
            .filter(s => (s.sequence ?? 0) > origSeq)
            .sort((a, b) => (b.sequence ?? 0) - (a.sequence ?? 0)); // descending to avoid collisions
        for (const s of allScenes) {
            await this.updateScene(s.filePath, { sequence: (s.sequence ?? 0) + 1 });
        }

        // Scene B: create new file inheriting metadata
        // eslint-disable-next-line @typescript-eslint/no-unused-vars -- destructure to strip per-file fields before cloning
        const { filePath: _fp, body: _body, wordcount: _wc, created: _cr, modified: _mod, ...inherited } = scene;
        const sceneB: Partial<Scene> = {
            ...inherited,
            title: titleB || `${scene.title} (part 2)`,
            sequence: origSeq + 1,
            body: bodyB,
        };

        const fileB = await this.createScene(sceneB);
        new Notice(`Split "${scene.title}" into two scenes`);
        return [file, fileB];
    }

    /**
     * Merge two or more adjacent scenes into one.
     * The first scene's file is kept; subsequent scenes are deleted.
     * Metadata is combined: characters unioned, lower status kept, etc.
     *
     * @param filePaths  Ordered list of scene file paths to merge
     * @param mergedTitle  Optional title for the merged scene
     * @returns The merged scene's TFile
     */
    async mergeScenes(filePaths: string[], mergedTitle?: string): Promise<TFile> {
        if (filePaths.length < 2) throw new Error('Need at least 2 scenes to merge');

        const scenes = filePaths.map(fp => this.scenes.get(fp)).filter(Boolean) as Scene[];
        if (scenes.length < 2) throw new Error('Could not find all scenes');

        const primary = scenes[0];
        const rest = scenes.slice(1);

        // Combine body text with separators
        const combinedBody = scenes
            .map(s => (s.body || '').trim())
            .filter(b => b.length > 0)
            .join('\n\n---\n\n');

        // Union characters (deduplicated)
        const charSet = new Set<string>();
        for (const s of scenes) {
            if (s.pov) charSet.add(s.pov);
            if (s.characters) s.characters.forEach(c => charSet.add(c));
        }

        // Union tags (deduplicated)
        const tagSet = new Set<string>();
        for (const s of scenes) {
            if (s.tags) (s.tags as string[]).forEach((t: string) => tagSet.add(t));
        }

        // Keep lower (earlier) status
        const lowestStatus = scenes.reduce((lowest, s) => {
            const statusOrder = getStatusOrder();
            const idxCurrent = statusOrder.indexOf(s.status as SceneStatus);
            const idxLowest = statusOrder.indexOf(lowest as SceneStatus);
            // -1 means not found; treat as highest so it doesn't win
            const safeCurrent = idxCurrent >= 0 ? idxCurrent : statusOrder.length;
            const safeLowest = idxLowest >= 0 ? idxLowest : statusOrder.length;
            return safeCurrent < safeLowest ? s.status : lowest;
        }, primary.status || 'idea');

        // Combine locations if different
        const locations = [...new Set(scenes.map(s => s.location).filter(Boolean))];
        const mergedLocation = locations.length === 1 ? locations[0] : locations.join(', ');

        // Union setup/payoff links
        const setupSet = new Set<string>();
        const payoffSet = new Set<string>();
        for (const s of scenes) {
            if (s.setup_scenes) s.setup_scenes.forEach(x => setupSet.add(x));
            if (s.payoff_scenes) s.payoff_scenes.forEach(x => payoffSet.add(x));
        }

        // Build merged updates for primary scene
        const updates: Partial<Scene> = {
            body: combinedBody,
            title: mergedTitle || primary.title,
            characters: [...charSet],
            tags: [...tagSet],
            status: lowestStatus,
            location: mergedLocation,
            setup_scenes: setupSet.size > 0 ? [...setupSet] : undefined,
            payoff_scenes: payoffSet.size > 0 ? [...payoffSet] : undefined,
        };

        // Update the primary scene
        const primaryFile = this.app.vault.getAbstractFileByPath(primary.filePath);
        if (!primaryFile || !(primaryFile instanceof TFile)) throw new Error('Primary scene file not found');
        await MetadataParser.updateFrontmatter(this.app, primaryFile, updates);
        const parsed = await MetadataParser.parseFile(this.app, primaryFile);
        if (parsed) this.scenes.set(primaryFile.path, parsed);
        this.bumpVersion(primaryFile.path);

        // Delete the other scenes
        for (const s of rest) {
            await this.deleteScene(s.filePath);
        }

        // Resequence remaining scenes to close gaps
        const ordered = this.getAllScenes()
            .sort((a, b) => (a.sequence ?? 0) - (b.sequence ?? 0))
            .map(s => s.filePath);
        await this.resequenceScenes(ordered);

        new Notice(`Merged ${scenes.length} scenes into "${updates.title}"`);
        return primaryFile;
    }
}
/* eslint-enable @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-argument, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-return, @typescript-eslint/no-floating-promises, @typescript-eslint/no-misused-promises, @typescript-eslint/no-unnecessary-type-assertion, @typescript-eslint/no-redundant-type-constituents, @typescript-eslint/no-unused-vars, no-unused-vars, no-useless-escape, no-control-regex, no-empty -- end of file-wide suppression block opened at line 1 */
