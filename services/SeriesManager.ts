import { App, Notice, TFile, TFolder, normalizePath } from 'obsidian';
import type SceneCardsPlugin from '../main';
import { SeriesMetadata, StoryLineProject, deriveProjectFoldersFromFilePath } from '../models/StoryLineProject';
import { t } from '../utils/i18n';
import { isProjectScopedLibraryArtifact, isUntrackedLibraryNoise, vaultRelativeFolderPath } from '../utils/vaultFolders';
import type { ProjectCapabilities } from '../models/ProjectCapabilities';

interface LibraryTransferJournal {
    movedFiles: Array<{ from: string; to: string }>;
    copiedFiles: string[];
    duplicateFiles: string[];
}

function createLibraryTransferJournal(): LibraryTransferJournal {
    return { movedFiles: [], copiedFiles: [], duplicateFiles: [] };
}

function parseSeriesMetadata(raw: unknown): SeriesMetadata | null {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
    const data = raw as Record<string, unknown>;
    if (typeof data.name !== 'string' || !data.name.trim()
        || !Array.isArray(data.bookOrder) || !data.bookOrder.every(path => typeof path === 'string')) return null;
    return {
        name: data.name,
        bookOrder: data.bookOrder,
        created: typeof data.created === 'string' ? data.created : '',
    };
}

/**
 * Manages series — groups of book projects sharing a common Library.
 *
 * Series folder layout:
 *   MySeriesFolder/
 *     series.json        ← SeriesMetadata
 *     Library/
 *       Characters/
 *       Locations/
 *       [other Library categories]
 *     Book1/             ← NarrativeLab project (scenes, .storyline)
 *     Book2/
 */
export class SeriesManager {
    private app: App;
    private plugin: SceneCardsPlugin;

    constructor(app: App, plugin: SceneCardsPlugin) {
        this.app = app;
        this.plugin = plugin;
    }

    // ── Read ───────────────────────────────────────────

    /**
     * Load series.json from a series folder.
     * Returns null if the file doesn't exist or is invalid.
     */
    async loadSeriesMetadata(seriesFolder: string): Promise<SeriesMetadata | null> {
        const adapter = this.app.vault.adapter;
        const metaPath = normalizePath(`${seriesFolder}/series.json`);
        for (const candidate of [`${metaPath}.tmp`, metaPath, `${metaPath}.bak`]) {
            try {
                if (!await adapter.exists(candidate)) continue;
                const parsed = parseSeriesMetadata(JSON.parse(await adapter.read(candidate)) as unknown);
                if (!parsed) throw new Error('invalid series metadata');
                return parsed;
            } catch (error) {
                console.error(`[NarrativeLab] Could not load series metadata from ${candidate}:`, error);
            }
        }
        return null;
    }

    /**
     * Save series.json to the series folder.
     */
    async saveSeriesMetadata(seriesFolder: string, meta: SeriesMetadata): Promise<void> {
        const adapter = this.app.vault.adapter;
        const metaPath = normalizePath(`${seriesFolder}/series.json`);
        const backupPath = `${metaPath}.bak`;
        const tempPath = `${metaPath}.tmp`;
        let readableMain: string | null = null;
        if (await adapter.exists(metaPath)) {
            const current = await adapter.read(metaPath);
            const currentParsed = (() => {
                try { return parseSeriesMetadata(JSON.parse(current) as unknown); } catch { return null; }
            })();
            if (!currentParsed) {
                let backupReadable = false;
                if (await adapter.exists(backupPath)) {
                    try {
                        backupReadable = !!parseSeriesMetadata(JSON.parse(await adapter.read(backupPath)) as unknown);
                    } catch { /* unreadable backup */ }
                }
                if (!backupReadable) {
                    throw new Error('Cannot save series metadata because the existing file and backup are unreadable.');
                }
            } else {
                readableMain = current;
            }
        }
        const content = JSON.stringify(meta, null, 2);
        await adapter.write(tempPath, content);
        if (readableMain !== null) await adapter.write(backupPath, readableMain);
        await adapter.write(metaPath, content);
        await adapter.remove(tempPath).catch(() => undefined);
    }

    /**
     * Get the series folder for the active project (if it belongs to a series).
     */
    getActiveSeriesFolder(): string | null {
        return this.plugin.sceneManager.getSeriesFolder();
    }

    /**
     * Get the series metadata for the active project.
     */
    async getActiveSeriesMetadata(): Promise<SeriesMetadata | null> {
        const folder = this.getActiveSeriesFolder();
        if (!folder) return null;
        return this.loadSeriesMetadata(folder);
    }

    // ── Create ─────────────────────────────────────────

    /**
     * Create a series and its first project directly in the final nested
     * location. This avoids creating a temporary standalone project and then
     * moving/copying it into the series.
     */
    async createSeriesWithNewProject(
        seriesName: string,
        projectTitle: string,
        description = '',
        customParentPath?: string,
        capabilities?: ProjectCapabilities,
    ): Promise<StoryLineProject> {
        const safeSeriesName = seriesName.replace(/[\\/:*?"<>|]/g, '-');
        const parentPath = vaultRelativeFolderPath(
            customParentPath ?? this.plugin.settings.storyLineRoot,
        );
        const seriesFolder = normalizePath(
            [parentPath, safeSeriesName].filter(Boolean).join('/'),
        );
        const adapter = this.app.vault.adapter;
        if (await adapter.exists(seriesFolder)) {
            throw new Error(t('A folder named "{name}" already exists at the selected location.', {
                name: safeSeriesName,
            }));
        }

        await this.ensureFolder(seriesFolder);
        let project: StoryLineProject | null = null;
        try {
            const seriesLibrary = normalizePath(`${seriesFolder}/Library`);
            await this.ensureFolder(seriesLibrary);
            await this.ensureFolder(normalizePath(`${seriesLibrary}/Characters`));
            await this.ensureFolder(normalizePath(`${seriesLibrary}/Locations`));

            project = await this.plugin.sceneManager.createProject(
                projectTitle,
                description,
                seriesFolder,
                capabilities ? { capabilities } : { preset: 'full-narrative' },
            );

            const meta: SeriesMetadata = {
                name: seriesName,
                bookOrder: [projectTitle.replace(/[\\/:*?"<>|]/g, '-')],
                created: new Date().toISOString().split('T')[0],
            };
            await this.saveSeriesMetadata(seriesFolder, meta);

            project.seriesId = safeSeriesName;
            await this.plugin.sceneManager.saveProjectFrontmatter(project);
            await this.plugin.sceneManager.setActiveProject(project);

            // A newly-created project only contains empty seed Library folders;
            // merge them into the shared Library and remove the empty local copy.
            const projectFolders = deriveProjectFoldersFromFilePath(project.filePath);
            const localLibrary = this.resolveExistingLibraryFolder(projectFolders.baseFolder);
            if (await adapter.exists(localLibrary)) {
                await this.migrateCodexFolder(localLibrary, seriesLibrary);
            }

            new Notice(t('Series "{name}" created', { name: seriesName }));
            return project;
        } catch (error) {
            // The series folder did not exist before this operation, so removing
            // it is a safe rollback of files created by this failed attempt.
            const createdFolder = this.app.vault.getAbstractFileByPath(seriesFolder);
            if (createdFolder instanceof TFolder) {
                await this.app.fileManager.trashFile(createdFolder).catch(() => undefined);
            }
            if (project) await this.plugin.sceneManager.scanProjects().catch(() => undefined);
            throw error;
        }
    }

    /**
     * Create a new series from the currently active project.
     *
     * Steps:
     * 1. Create series folder (parent-level) inside NarrativeLab root
     * 2. Move the current book project folder into the series folder
     * 3. Move the book's Library to the shared series Library folder
     * 4. Write series.json
     * 5. Update the project's seriesId
     */
    async createSeriesFromProject(seriesName: string, sourceProject?: StoryLineProject): Promise<string> {
        // Pre-flight: check Obsidian link settings
        this.checkLinkSettings();

        const project = sourceProject ?? this.plugin.sceneManager.activeProject;
        if (!project) throw new Error(t('No active project'));

        // Determine current book base folder
        const bookFolders = deriveProjectFoldersFromFilePath(project.filePath);
        const bookBaseName = bookFolders.baseFolder.split('/').pop() ?? '';
        const safeName = seriesName.replace(/[\\/:*?"<>|]/g, '-');
        const bookParent = bookFolders.baseFolder.includes('/')
            ? bookFolders.baseFolder.split('/').slice(0, -1).join('/')
            : '';
        const seriesFolder = normalizePath([bookParent, safeName].filter(Boolean).join('/'));
        const adapter = this.app.vault.adapter;

        // Issue #82: Refuse to create a series whose folder name collides
        // with the active book's folder name. Otherwise the book's base
        // folder == the series folder, and moving it into a same-named
        // subfolder triggers an infinite recursive move.
        if (safeName.toLowerCase() === bookBaseName.toLowerCase()) {
            throw new Error(
                t('Series name "{name}" matches the current project folder. Choose a different name, such as "{name} Series".', { name: seriesName })
            );
        }

        if (await adapter.exists(seriesFolder)) {
            throw new Error(t('A folder named "{name}" already exists at the selected location.', {
                name: safeName,
            }));
        }

        const originalBookFolder = normalizePath(bookFolders.baseFolder);
        const originalProjectFile = normalizePath(project.filePath);
        const targetBookFolder = normalizePath(`${seriesFolder}/${bookBaseName}`);
        const libraryJournal = createLibraryTransferJournal();
        const resumeProjectLeaves = originalBookFolder !== targetBookFolder
            ? await this.plugin.quiesceProjectLeavesForFolderMove(originalBookFolder, targetBookFolder)
            : async () => undefined;
        let movedProject = false;
        try {
            await this.ensureFolder(seriesFolder);

            if (originalBookFolder !== targetBookFolder) {
                await this.moveProjectFolder(originalBookFolder, targetBookFolder);
                movedProject = true;
                // Handle legacy manifests that were not nested under the project folder.
                const newProjectFile = normalizePath(`${targetBookFolder}/${bookBaseName}.md`);
                if (originalProjectFile !== newProjectFile && await adapter.exists(originalProjectFile)) {
                    const oldManifest = this.app.vault.getAbstractFileByPath(originalProjectFile);
                    if (oldManifest) await this.app.fileManager.renameFile(oldManifest, newProjectFile);
                }
            }

            const seriesCodexFolder = normalizePath(`${seriesFolder}/Library`);
            await this.ensureFolder(seriesCodexFolder);
            await this.ensureFolder(normalizePath(`${seriesCodexFolder}/Characters`));
            await this.ensureFolder(normalizePath(`${seriesCodexFolder}/Locations`));

            const bookCodexFolder = this.resolveExistingLibraryFolder(targetBookFolder);
            if (await adapter.exists(bookCodexFolder)) {
                await this.migrateCodexFolder(bookCodexFolder, seriesCodexFolder, libraryJournal);
            }

            const meta: SeriesMetadata = {
                name: seriesName,
                bookOrder: [bookBaseName],
                created: new Date().toISOString().split('T')[0],
            };
            await this.saveSeriesMetadata(seriesFolder, meta);

            const newProjectFile = this.manifestPathInFolder(targetBookFolder, originalProjectFile);
            const updatedProject = await this.resolveMovedProject(
                newProjectFile,
                t('Could not find the moved project after creating the series.'),
            );
            updatedProject.seriesId = safeName;
            await this.plugin.sceneManager.setActiveProject(updatedProject);
            await this.plugin.sceneManager.saveProjectFrontmatter(updatedProject);
            await this.trashDuplicateLibraryFiles(libraryJournal);

            new Notice(t('Series "{name}" created', { name: seriesName }));
            return seriesFolder;
        } catch (error) {
            let rollbackIncomplete = false;
            await this.rollbackMovedLibraryFiles(libraryJournal).catch(rollbackError => {
                rollbackIncomplete = true;
                console.error('[NarrativeLab] Failed to roll back series Library migration:', rollbackError);
            });
            if (movedProject && await adapter.exists(targetBookFolder) && !await adapter.exists(originalBookFolder)) {
                await this.moveProjectFolder(targetBookFolder, originalBookFolder).catch(rollbackError => {
                    rollbackIncomplete = true;
                    console.error('[NarrativeLab] Failed to restore project folder after series creation:', rollbackError);
                });
            }
            const createdSeries = this.app.vault.getAbstractFileByPath(seriesFolder);
            if (createdSeries instanceof TFolder && !rollbackIncomplete) {
                await this.app.fileManager.trashFile(createdSeries).catch(() => undefined);
            }
            this.plugin.settings.activeProjectFile = originalProjectFile;
            await this.plugin.sceneManager.scanProjects().catch(() => undefined);
            const restored = this.plugin.sceneManager.getProjects()
                .find(candidate => normalizePath(candidate.filePath) === originalProjectFile);
            if (restored) {
                delete restored.seriesId;
                await this.plugin.sceneManager.saveProjectFrontmatter(restored).catch(() => undefined);
                await this.plugin.sceneManager.setActiveProject(restored).catch(() => undefined);
            }
            throw error;
        } finally {
            const moveStuck = await adapter.exists(targetBookFolder)
                && !await adapter.exists(originalBookFolder);
            await resumeProjectLeaves(moveStuck);
        }
    }

    /**
     * Create a blank project directly inside an existing series folder.
     * The new book uses the shared series Library.
     */
    async createProjectInSeries(seriesFolder: string, projectTitle: string, description = ''): Promise<StoryLineProject> {
        this.checkLinkSettings();

        const meta = await this.loadSeriesMetadata(seriesFolder);
        if (!meta) throw new Error(t('Invalid series folder: series.json was not found.'));

        const safeTitle = projectTitle.replace(/[\\/:*?"<>|]/g, '-');
        const seriesFolderName = seriesFolder.split('/').pop() ?? '';
        if (seriesFolderName.toLowerCase() === safeTitle.toLowerCase()) {
            throw new Error(
                t('Series folder "{name}" has the same name as the project folder. Rename the project or series before adding it.', { name: seriesFolderName }),
            );
        }

        const adapter = this.app.vault.adapter;
        const targetBookFolder = normalizePath(`${seriesFolder}/${safeTitle}`);
        if (await adapter.exists(targetBookFolder)) {
            throw new Error(t('A folder named "{name}" already exists at the selected location.', {
                name: safeTitle,
            }));
        }

        const metadataSnapshot: SeriesMetadata = { ...meta, bookOrder: [...meta.bookOrder] };
        let project: StoryLineProject | null = null;
        try {
            project = await this.plugin.sceneManager.createProject(projectTitle, description, seriesFolder);

            const seriesCodexFolder = this.resolveExistingLibraryFolder(seriesFolder);
            await this.ensureFolder(seriesCodexFolder);
            await this.ensureFolder(normalizePath(`${seriesCodexFolder}/Characters`));
            await this.ensureFolder(normalizePath(`${seriesCodexFolder}/Locations`));

            if (!meta.bookOrder.includes(safeTitle)) meta.bookOrder.push(safeTitle);
            await this.saveSeriesMetadata(seriesFolder, meta);

            project.seriesId = seriesFolderName;
            await this.plugin.sceneManager.saveProjectFrontmatter(project);
            await this.plugin.sceneManager.setActiveProject(project);

            const projectFolders = deriveProjectFoldersFromFilePath(project.filePath);
            const localLibrary = this.resolveExistingLibraryFolder(projectFolders.baseFolder);
            if (await adapter.exists(localLibrary)) {
                await this.migrateCodexFolder(localLibrary, seriesCodexFolder);
            }

            new Notice(t('Project added to series "{name}"', { name: meta.name }));
            return project;
        } catch (error) {
            await this.saveSeriesMetadata(seriesFolder, metadataSnapshot).catch(rollbackError => {
                console.error('[NarrativeLab] Failed to restore series metadata after new project failed:', rollbackError);
            });
            if (project) {
                await this.plugin.sceneManager.deleteProject(project).catch(rollbackError => {
                    console.error('[NarrativeLab] Failed to remove the unfinished series project:', rollbackError);
                });
            }
            throw error;
        }
    }

    // ── Add existing project to series ─────────────────

    /**
     * Add the currently active project to an existing series.
     *
     * Steps:
     * 1. Move book folder into the series folder
     * 2. Migrate the book Library to the shared series Library (handling duplicates)
     * 3. Update series.json bookOrder
     * 4. Set seriesId on the project
     */
    async addProjectToSeries(seriesFolder: string): Promise<void> {
        this.checkLinkSettings();

        const project = this.plugin.sceneManager.activeProject;
        if (!project) throw new Error(t('No active project'));

        const meta = await this.loadSeriesMetadata(seriesFolder);
        if (!meta) throw new Error(t('Invalid series folder: series.json was not found.'));

        const adapter = this.app.vault.adapter;
        const bookFolders = deriveProjectFoldersFromFilePath(project.filePath);
        const bookBaseName = bookFolders.baseFolder.split('/').pop() ?? '';
        const seriesFolderName = seriesFolder.split('/').pop() ?? '';

        // Issue #82: refuse same-name collision between series folder and
        // the book folder \u2014 would attempt to move the book into itself.
        if (seriesFolderName.toLowerCase() === bookBaseName.toLowerCase()) {
            throw new Error(
                t('Series folder "{name}" has the same name as the project folder. Rename the project or series before adding it.', { name: seriesFolderName })
            );
        }

        const targetBookFolder = normalizePath(`${seriesFolder}/${bookBaseName}`);
        const originalBookFolder = normalizePath(bookFolders.baseFolder);
        const originalProjectFile = normalizePath(project.filePath);
        const metadataSnapshot: SeriesMetadata = { ...meta, bookOrder: [...meta.bookOrder] };
        const libraryJournal = createLibraryTransferJournal();
        const resumeProjectLeaves = originalBookFolder !== targetBookFolder
            ? await this.plugin.quiesceProjectLeavesForFolderMove(originalBookFolder, targetBookFolder)
            : async () => undefined;
        let movedProject = false;
        try {
            if (originalBookFolder !== targetBookFolder) {
                await this.moveProjectFolder(originalBookFolder, targetBookFolder);
                movedProject = true;
            }

            const seriesCodexFolder = this.resolveExistingLibraryFolder(seriesFolder);
            await this.ensureFolder(seriesCodexFolder);
            await this.ensureFolder(normalizePath(`${seriesCodexFolder}/Characters`));
            await this.ensureFolder(normalizePath(`${seriesCodexFolder}/Locations`));

            const bookCodexFolder = this.resolveExistingLibraryFolder(targetBookFolder);
            if (await adapter.exists(bookCodexFolder)) {
                await this.migrateCodexFolder(bookCodexFolder, seriesCodexFolder, libraryJournal);
            }

            const safeName = seriesFolder.split('/').pop() ?? '';
            if (!meta.bookOrder.includes(bookBaseName)) meta.bookOrder.push(bookBaseName);
            await this.saveSeriesMetadata(seriesFolder, meta);

            const newProjectFile = this.manifestPathInFolder(targetBookFolder, originalProjectFile);
            const updatedProject = await this.resolveMovedProject(
                newProjectFile,
                t('Could not find the moved project after adding it to the series.'),
            );
            updatedProject.seriesId = safeName;
            await this.plugin.sceneManager.setActiveProject(updatedProject);
            await this.plugin.sceneManager.saveProjectFrontmatter(updatedProject);
            await this.trashDuplicateLibraryFiles(libraryJournal);

            new Notice(t('Project added to series "{name}"', { name: meta.name }));
        } catch (error) {
            await this.saveSeriesMetadata(seriesFolder, metadataSnapshot).catch(rollbackError => {
                console.error('[NarrativeLab] Failed to restore series metadata:', rollbackError);
            });
            await this.rollbackMovedLibraryFiles(libraryJournal).catch(rollbackError => {
                console.error('[NarrativeLab] Failed to restore project Library:', rollbackError);
            });
            if (movedProject && await adapter.exists(targetBookFolder) && !await adapter.exists(originalBookFolder)) {
                await this.moveProjectFolder(targetBookFolder, originalBookFolder).catch(rollbackError => {
                    console.error('[NarrativeLab] Failed to restore project folder:', rollbackError);
                });
            }
            this.plugin.settings.activeProjectFile = originalProjectFile;
            await this.plugin.sceneManager.scanProjects().catch(() => undefined);
            const restored = this.plugin.sceneManager.getProjects()
                .find(candidate => normalizePath(candidate.filePath) === originalProjectFile);
            if (restored) {
                delete restored.seriesId;
                await this.plugin.sceneManager.saveProjectFrontmatter(restored).catch(() => undefined);
                await this.plugin.sceneManager.setActiveProject(restored).catch(() => undefined);
            }
            throw error;
        } finally {
            const moveStuck = await adapter.exists(targetBookFolder)
                && !await adapter.exists(originalBookFolder);
            await resumeProjectLeaves(moveStuck);
        }
    }

    // ── Remove from series ─────────────────────────────

    /**
     * Remove the active project from its series.
     * Moves the book folder back out and copies its current shared Library entities locally.
     */
    async removeProjectFromSeries(): Promise<void> {
        const project = this.plugin.sceneManager.activeProject;
        if (!project?.seriesId) throw new Error(t('Project is not in a series.'));

        const seriesFolder = this.plugin.sceneManager.getSeriesFolder();
        if (!seriesFolder) throw new Error(t('Cannot determine the series folder.'));

        const meta = await this.loadSeriesMetadata(seriesFolder);
        if (!meta) throw new Error(t('Invalid series metadata.'));

        const bookFolders = deriveProjectFoldersFromFilePath(project.filePath);
        const bookBaseName = bookFolders.baseFolder.split('/').pop() ?? '';
        const seriesParent = seriesFolder.includes('/')
            ? seriesFolder.split('/').slice(0, -1).join('/')
            : '';
        const targetBookFolder = normalizePath([seriesParent, bookBaseName].filter(Boolean).join('/'));

        const sourceBookFolder = normalizePath(bookFolders.baseFolder);
        const originalProjectFile = normalizePath(project.filePath);
        const metadataSnapshot: SeriesMetadata = { ...meta, bookOrder: [...meta.bookOrder] };
        const copyJournal = createLibraryTransferJournal();
        const seriesCodexFolder = this.resolveExistingLibraryFolder(seriesFolder);
        const localCodexFolder = normalizePath(`${bookFolders.baseFolder}/Library`);
        const resumeProjectLeaves = sourceBookFolder !== targetBookFolder
            ? await this.plugin.quiesceProjectLeavesForFolderMove(sourceBookFolder, targetBookFolder)
            : async () => undefined;
        let movedProject = false;
        try {
            await this.ensureFolder(localCodexFolder);
            await this.copyFolderRecursive(seriesCodexFolder, localCodexFolder, copyJournal);

            if (sourceBookFolder !== targetBookFolder) {
                await this.moveProjectFolder(sourceBookFolder, targetBookFolder);
                movedProject = true;
            }

            meta.bookOrder = meta.bookOrder.filter(b => b !== bookBaseName);
            await this.saveSeriesMetadata(seriesFolder, meta);

            const newProjectFile = this.manifestPathInFolder(targetBookFolder, originalProjectFile);
            const updatedProject = await this.resolveMovedProject(
                newProjectFile,
                t('Could not find the moved project after removing it from the series.'),
            );
            delete updatedProject.seriesId;
            await this.plugin.sceneManager.setActiveProject(updatedProject);
            await this.plugin.sceneManager.saveProjectFrontmatter(updatedProject);

            new Notice(t('Project removed from series "{name}"', { name: meta.name }));
        } catch (error) {
            await this.saveSeriesMetadata(seriesFolder, metadataSnapshot).catch(rollbackError => {
                console.error('[NarrativeLab] Failed to restore series metadata:', rollbackError);
            });
            if (movedProject && await this.app.vault.adapter.exists(targetBookFolder)
                && !await this.app.vault.adapter.exists(sourceBookFolder)) {
                await this.moveProjectFolder(targetBookFolder, sourceBookFolder).catch(rollbackError => {
                    console.error('[NarrativeLab] Failed to move project back into series:', rollbackError);
                });
            }
            await this.rollbackCopiedLibraryFiles(copyJournal).catch(rollbackError => {
                console.error('[NarrativeLab] Failed to remove copied Library files:', rollbackError);
            });
            this.plugin.settings.activeProjectFile = originalProjectFile;
            await this.plugin.sceneManager.scanProjects().catch(() => undefined);
            const restored = this.plugin.sceneManager.getProjects()
                .find(candidate => normalizePath(candidate.filePath) === originalProjectFile);
            if (restored) {
                restored.seriesId = seriesFolder.split('/').pop() ?? restored.seriesId;
                await this.plugin.sceneManager.saveProjectFrontmatter(restored).catch(() => undefined);
                await this.plugin.sceneManager.setActiveProject(restored).catch(() => undefined);
            }
            throw error;
        } finally {
            const moveStuck = await this.app.vault.adapter.exists(targetBookFolder)
                && !await this.app.vault.adapter.exists(sourceBookFolder);
            await resumeProjectLeaves(moveStuck);
        }
    }

    /**
     * Remove an orphaned book name from series.json without touching the vault.
     *
     * This is intentionally separate from removeProjectFromSeries(): when the
     * project can no longer be resolved there is no folder that can safely be
     * moved and no Library data that can safely be copied. Reloading the file
     * before editing also prevents an old management modal from overwriting
     * newer series changes.
     */
    async removeMissingProjectReference(seriesFolder: string, bookName: string): Promise<boolean> {
        const meta = await this.loadSeriesMetadata(seriesFolder);
        if (!meta) throw new Error(t('Invalid series metadata.'));

        const nextBookOrder = meta.bookOrder.filter(name => name !== bookName);
        if (nextBookOrder.length === meta.bookOrder.length) return false;

        meta.bookOrder = nextBookOrder;
        await this.saveSeriesMetadata(seriesFolder, meta);
        return true;
    }

    /**
     * Dissolve a series into standalone projects.
     *
     * Every direct child project receives a copy of the shared Library before
     * it is moved beside the series folder. The remaining series container is
     * moved to trash only after collision and unmanaged-content preflights pass.
     */
    async dissolveSeries(seriesFolder: string): Promise<StoryLineProject[]> {
        this.checkLinkSettings();

        const folder = normalizePath(seriesFolder);
        const meta = await this.loadSeriesMetadata(folder);
        if (!meta) throw new Error(t('Invalid series metadata.'));

        await this.plugin.sceneManager.scanProjects();
        const projects = this.plugin.sceneManager.getProjects();
        const directProjects = projects.filter(project => {
            const base = normalizePath(deriveProjectFoldersFromFilePath(project.filePath).baseFolder);
            const parent = base.includes('/') ? base.slice(0, base.lastIndexOf('/')) : '';
            return parent === folder;
        });
        if (directProjects.length === 0) {
            throw new Error(t('This series does not contain any NarrativeLab projects.'));
        }

        const order = new Map(meta.bookOrder.map((name, index) => [name, index]));
        directProjects.sort((a, b) => {
            const aName = deriveProjectFoldersFromFilePath(a.filePath).baseFolder.split('/').pop() ?? '';
            const bName = deriveProjectFoldersFromFilePath(b.filePath).baseFolder.split('/').pop() ?? '';
            return (order.get(aName) ?? Number.MAX_SAFE_INTEGER)
                - (order.get(bName) ?? Number.MAX_SAFE_INTEGER);
        });

        const parent = folder.includes('/') ? folder.slice(0, folder.lastIndexOf('/')) : '';
        const moves = directProjects.map(project => {
            const source = normalizePath(deriveProjectFoldersFromFilePath(project.filePath).baseFolder);
            const name = source.split('/').pop() ?? project.title;
            const target = normalizePath([parent, name].filter(Boolean).join('/'));
            const sourcePrefix = `${source}/`;
            const filePath = normalizePath(project.filePath);
            const nextFilePath = filePath.startsWith(sourcePrefix)
                ? normalizePath(`${target}/${filePath.slice(sourcePrefix.length)}`)
                : normalizePath(`${target}/${name}.md`);
            return { project, source, target, nextFilePath };
        });

        const adapter = this.app.vault.adapter;
        for (const move of moves) {
            if (move.source === move.target || await adapter.exists(move.target)) {
                throw new Error(t('Cannot dissolve this series because "{path}" already exists.', {
                    path: move.target,
                }));
            }
        }

        // Refuse to trash anything the series manager does not own.
        const listing = await adapter.list(folder);
        const managedFolders = new Set<string>([
            ...moves.map(move => move.source),
            normalizePath(`${folder}/Library`),
            normalizePath(`${folder}/Codex`),
        ]);
        const unexpected = [
            ...listing.files.filter(path => {
                const name = path.split('/').pop() ?? '';
                if (isUntrackedLibraryNoise(name)) return false;
                return normalizePath(path) !== normalizePath(`${folder}/series.json`);
            }),
            ...listing.folders.filter(path => {
                const name = path.split('/').pop() ?? '';
                if (isUntrackedLibraryNoise(name) || name.startsWith('.')) return false;
                return !managedFolders.has(normalizePath(path));
            }),
        ];
        if (unexpected.length > 0) {
            throw new Error(t('The series folder contains unmanaged files or folders: {items}. Move them elsewhere before dissolving the series.', {
                items: unexpected.map(path => path.split('/').pop() ?? path).join(', '),
            }));
        }

        let seriesEntry = this.app.vault.getAbstractFileByPath(folder);
        if (!(seriesEntry instanceof TFolder)) {
            if (!await adapter.exists(folder)) {
                throw new Error(t('Could not find the indexed series folder. Wait for Obsidian to finish indexing and try again.'));
            }
            seriesEntry = null;
        }

        const previousActivePath = normalizePath(this.plugin.sceneManager.activeProject?.filePath ?? '');
        const activeMove = moves.find(move => normalizePath(move.project.filePath) === previousActivePath);
        const sharedLibrary = this.resolveExistingLibraryFolder(folder);
        const copyJournals = new Map<string, LibraryTransferJournal>();
        const movedProjects: typeof moves = [];
        try {
            for (const move of moves) {
                const localLibrary = normalizePath(`${move.source}/Library`);
                const journal = createLibraryTransferJournal();
                copyJournals.set(move.source, journal);
                await this.ensureFolder(localLibrary);
                await this.copyFolderRecursive(sharedLibrary, localLibrary, journal);
            }
            for (const move of moves) {
                await this.moveProjectFolder(move.source, move.target);
                movedProjects.push(move);
            }

            // Trash is the commit point. Before this succeeds every move and
            // every copied Library file can still be reversed in place.
            const indexed = seriesEntry ?? this.app.vault.getAbstractFileByPath(folder);
            if (indexed instanceof TFolder) {
                await this.app.fileManager.trashFile(indexed);
            } else {
                const leftover = await adapter.list(folder).catch(() => ({ files: [] as string[], folders: [] as string[] }));
                for (const file of leftover.files) {
                    const name = file.split('/').pop() ?? '';
                    if (isUntrackedLibraryNoise(name) || name === 'series.json') {
                        await adapter.remove(file).catch(() => undefined);
                    }
                }
                await adapter.rmdir(folder, false);
            }
        } catch (error) {
            for (const move of [...movedProjects].reverse()) {
                if (await adapter.exists(move.target) && !await adapter.exists(move.source)) {
                    await this.moveProjectFolder(move.target, move.source).catch(rollbackError => {
                        console.error('[NarrativeLab] Failed to restore project while rolling back series dissolve:', rollbackError);
                    });
                }
            }
            for (const move of [...moves].reverse()) {
                const journal = copyJournals.get(move.source);
                if (!journal) continue;
                await this.rollbackCopiedLibraryFiles(journal).catch(rollbackError => {
                    console.error('[NarrativeLab] Failed to remove copied Library files:', rollbackError);
                });
            }
            await this.plugin.sceneManager.scanProjects().catch(() => undefined);
            throw error;
        }

        if (activeMove) {
            this.plugin.settings.activeProjectFile = activeMove.nextFilePath;
        }
        await this.plugin.sceneManager.scanProjects();

        const standalone: StoryLineProject[] = [];
        for (const move of moves) {
            const updated = this.plugin.sceneManager.getProjects()
                .find(project => normalizePath(project.filePath) === move.nextFilePath);
            if (!updated) continue;
            delete updated.seriesId;
            await this.plugin.sceneManager.saveProjectFrontmatter(updated).catch(error => {
                console.error('[NarrativeLab] Failed to clear series metadata after dissolve:', error);
            });
            standalone.push(updated);
        }

        const nextActive = activeMove
            ? standalone.find(project => normalizePath(project.filePath) === activeMove.nextFilePath)
            : this.plugin.sceneManager.activeProject;
        if (nextActive) await this.plugin.sceneManager.setActiveProject(nextActive);
        return standalone;
    }

    // ── Scan for series folders ────────────────────────

    /**
     * Discover series folders anywhere in the vault.
     */
    async discoverSeries(): Promise<Array<{ folder: string; meta: SeriesMetadata }>> {
        const adapter = this.app.vault.adapter;
        const results: Array<{ folder: string; meta: SeriesMetadata }> = [];

        const scan = async (folder: string): Promise<void> => {
            const listing = await adapter.list(folder);
            if (listing.files.some(path => path.endsWith('/series.json') || path === 'series.json')) {
                const meta = await this.loadSeriesMetadata(folder);
                if (meta) results.push({ folder, meta });
            }
            for (const subfolder of listing.folders) {
                const name = subfolder.split('/').pop() ?? '';
                // Hidden/system folders (especially Obsidian's `.trash`) are
                // not live series sources and may contain deleted series.json files.
                if (!name.startsWith('.')
                    && !['Library', 'Codex', 'Scenes', 'System', 'Attachments', 'NCanvas', 'Canvas', 'Bases', 'Notes', 'Research', 'Archived', 'Archive'].includes(name)) {
                    await scan(normalizePath(subfolder));
                }
            }
        };
        try { await scan(''); } catch { /* vault may still be indexing */ }

        return results;
    }

    // ── Pre-flight ─────────────────────────────────────

    /**
     * Verify that Obsidian's link settings are safe for migration.
     * Throws if "Automatically update internal links" is OFF.
     * Shows a notice if link format is not "shortest path".
     */
    checkLinkSettings(): void {
        const alwaysUpdate = this.readAlwaysUpdateLinks();
        // Missing config is not "off" — vault.config is often empty even when
        // Settings → Files & Links has the toggle enabled. Only abort when
        // Obsidian explicitly reports false.
        if (alwaysUpdate === false) {
            throw new Error(
                t('Series migration requires “Automatically update internal links”. Enable it under Settings → Files & Links, then try again.')
            );
        }
        if (alwaysUpdate === null) {
            new Notice(t('Before moving a project into a series, enable “Automatically update internal links” under Settings → Files & Links.'), 8000);
        }

        const vault = this.app.vault as unknown as {
            config?: Record<string, unknown>;
            getConfig?: (key: string) => unknown;
        };
        const newLinkFormat = vault.getConfig?.('newLinkFormat') ?? vault.config?.newLinkFormat;
        if (newLinkFormat && newLinkFormat !== 'shortest') {
            new Notice(t('Before moving a project into a series, set "New link format" to "Shortest path when possible".'), 8000);
        }
    }

    /** true / false when Obsidian reports the setting; null if unknown. */
    private readAlwaysUpdateLinks(): boolean | null {
        const vault = this.app.vault as unknown as {
            config?: Record<string, unknown>;
            getConfig?: (key: string) => unknown;
        };
        const fromGetConfig = vault.getConfig?.('alwaysUpdateLinks');
        if (fromGetConfig === true || fromGetConfig === false) return fromGetConfig;
        if (vault.config && Object.prototype.hasOwnProperty.call(vault.config, 'alwaysUpdateLinks')) {
            return vault.config.alwaysUpdateLinks === true;
        }
        return null;
    }

    private manifestPathInFolder(bookFolder: string, originalProjectFile: string): string {
        const name = originalProjectFile.split('/').pop()
            || `${bookFolder.split('/').pop() ?? 'project'}.md`;
        return normalizePath(`${bookFolder}/${name}`);
    }

    private async resolveMovedProject(expectedPath: string, missingMessage: string): Promise<StoryLineProject> {
        for (let attempt = 0; attempt < 8; attempt++) {
            const found = await this.plugin.sceneManager.loadProjectFromPath(expectedPath);
            if (found) return found;
            await new Promise<void>(resolve => window.setTimeout(resolve, 80 * (attempt + 1)));
        }
        throw new Error(missingMessage);
    }

    // ── File operations ────────────────────────────────

    private isTransientFilesystemError(error: unknown): boolean {
        const message = error instanceof Error
            ? `${error.name} ${error.message}`
            : String(error);
        return /UNKNOWN|EBUSY|EPERM|EACCES|EAGAIN|resource busy|locked|busy|access denied|sharing violation/i.test(message);
    }

    private async moveProjectFileWithRetry(source: string, destination: string): Promise<void> {
        const src = normalizePath(source);
        const dest = normalizePath(destination);
        const adapter = this.app.vault.adapter;
        let lastError: unknown;
        for (let attempt = 0; attempt < 8; attempt++) {
            const [sourceExists, destinationExists] = await Promise.all([
                adapter.exists(src),
                adapter.exists(dest),
            ]);
            if (!sourceExists && destinationExists) return;
            if (destinationExists) throw new Error(`Destination already exists: ${dest}`);
            if (!sourceExists) throw new Error(`Source file disappeared during project move: ${src}`);
            try {
                const file = this.app.vault.getAbstractFileByPath(src);
                if (file instanceof TFile) await this.app.fileManager.renameFile(file, dest);
                else await adapter.rename(src, dest);
                return;
            } catch (error) {
                lastError = error;
                if (!this.isTransientFilesystemError(error) || attempt === 7) break;
                await new Promise<void>(resolve => window.setTimeout(
                    resolve,
                    Math.min(1200, 50 * (attempt + 1) * (attempt + 1)),
                ));
            }
        }
        throw lastError instanceof Error ? lastError : new Error(String(lastError));
    }

    /**
     * Windows may lock the directory handle itself even after every child file
     * is closed. Fall back to moving the contents through Obsidian one file at
     * a time, keeping link updates and rolling every completed file back if a
     * genuinely locked child still cannot move. The project manifest moves last
     * so a half-finished destination is never discovered as another project.
     */
    private async moveProjectFolderByEntries(source: string, destination: string): Promise<void> {
        const src = normalizePath(source);
        const dest = normalizePath(destination);
        const adapter = this.app.vault.adapter;
        const folders = [src];
        const files: string[] = [];
        for (let index = 0; index < folders.length; index++) {
            const listing = await adapter.list(folders[index]);
            files.push(...listing.files.map(path => normalizePath(path)));
            folders.push(...listing.folders.map(path => normalizePath(path)));
        }

        const likelyManifest = normalizePath(`${src}/${src.split('/').pop() || ''}.md`);
        files.sort((a, b) => {
            if (a === likelyManifest) return 1;
            if (b === likelyManifest) return -1;
            return a.localeCompare(b);
        });

        const destinationFor = (path: string): string => normalizePath(
            path === src ? dest : `${dest}/${path.slice(src.length + 1)}`,
        );
        const destinationFolders = folders
            .map(destinationFor)
            .sort((a, b) => a.length - b.length);
        const movedFiles: Array<{ from: string; to: string }> = [];

        try {
            for (const folder of destinationFolders) await this.ensureFolder(folder);
            for (const file of files) {
                const target = destinationFor(file);
                await this.moveProjectFileWithRetry(file, target);
                movedFiles.push({ from: file, to: target });
            }
        } catch (error) {
            for (const moved of [...movedFiles].reverse()) {
                await this.moveProjectFileWithRetry(moved.to, moved.from).catch(rollbackError => {
                    console.error('[NarrativeLab] Failed to roll back a file from a staged project move:', rollbackError);
                });
            }
            for (const folder of [...destinationFolders].reverse()) {
                await adapter.rmdir(folder, false).catch(() => undefined);
            }
            throw error;
        }

        // A content-wise move has no folder rename event, so rebase project and
        // scene paths explicitly before the old empty directory is removed.
        await this.plugin.sceneManager.handleProjectTreeFolderRename(src, dest).catch(error => {
            console.warn('[NarrativeLab] Could not eagerly rebase the staged project move:', error);
        });
        for (const folder of [...folders].sort((a, b) => b.length - a.length)) {
            await adapter.rmdir(folder, false).catch(() => undefined);
        }
    }

    /**
     * Move one project folder as a single vault operation.
     *
     * Windows can briefly reject a directory rename while Canvas autosave,
     * Univer persistence, OneDrive, antivirus, or an external editor still has
     * a child file open. File writes already tolerate those sharing violations;
     * project moves need the same treatment. Each retry re-reads both paths so
     * a rename that completed on disk before its caller threw is not repeated.
     */
    private async moveProjectFolder(source: string, destination: string): Promise<void> {
        const src = normalizePath(source);
        const dest = normalizePath(destination);
        if (src === dest) return;
        if (dest.startsWith(`${src}/`)) {
            throw new Error(t('Cannot move "{source}" into its own subfolder "{destination}". Choose a different destination name.', {
                source: src,
                destination: dest,
            }));
        }
        const adapter = this.app.vault.adapter;
        const sleep = (ms: number) => new Promise<void>(resolve => window.setTimeout(resolve, ms));
        let lastError: unknown;

        for (let attempt = 0; attempt < 8; attempt++) {
            const [sourceExists, destinationExists] = await Promise.all([
                adapter.exists(src),
                adapter.exists(dest),
            ]);

            // A provider can finish the physical rename and then report a
            // sharing/index error. Treat the actual on-disk state as truth.
            if (!sourceExists && destinationExists) return;
            if (destinationExists) {
                throw new Error(t('A project folder named "{name}" already exists in this series.', {
                    name: dest.split('/').pop() || dest,
                }));
            }
            if (!sourceExists) {
                throw new Error(t('Could not find the indexed project folder: {path}. Wait for Obsidian to finish indexing and try again.', {
                    path: src,
                }));
            }

            try {
                // Re-resolve on every attempt: Obsidian may refresh its folder
                // object while a sync provider releases the underlying handle.
                const sourceFolder = this.app.vault.getAbstractFileByPath(src);
                if (sourceFolder instanceof TFolder) {
                    await this.app.fileManager.renameFile(sourceFolder, dest);
                } else {
                    // Folder is on disk but not in the vault index yet
                    // (OneDrive / cold start).
                    const parent = dest.includes('/') ? dest.slice(0, dest.lastIndexOf('/')) : '';
                    if (parent) await this.ensureFolder(parent);
                    await adapter.rename(src, dest);
                }
                return;
            } catch (error) {
                lastError = error;
                if (!this.isTransientFilesystemError(error) || attempt === 7) break;
                if (attempt === 0) {
                    new Notice(t('Project files are temporarily busy. Retrying the move…'), 5000);
                }
                await sleep(Math.min(1200, 60 * (attempt + 1) * (attempt + 1)));
            }
        }

        if (lastError && this.isTransientFilesystemError(lastError)) {
            try {
                await this.moveProjectFolderByEntries(src, dest);
                return;
            } catch (fallbackError) {
                lastError = fallbackError;
            }
        }

        const message = lastError instanceof Error ? lastError.message : String(lastError);
        throw new Error(t(
            'Could not move the project because Windows is still using one of its files. Wait for autosave to finish, then close Excel or another external editor if the problem continues. Original error: {message}',
            { message },
        ));
    }

    /** Prefer the current Library name while continuing to open legacy Codex folders. */
    private resolveExistingLibraryFolder(ownerFolder: string): string {
        const library = normalizePath(`${ownerFolder}/Library`);
        const legacyCodex = normalizePath(`${ownerFolder}/Codex`);
        if (this.app.vault.getAbstractFileByPath(library)) return library;
        if (this.app.vault.getAbstractFileByPath(legacyCodex)) return legacyCodex;
        return library;
    }

    /**
     * Migrate shared Library material from a book's Library into the series Library.
     * Per-project artifacts (datasheet.xlsx, library.base) stay with the book.
     * Identical duplicates are recorded for post-commit cleanup. A same-name
     * entity file with different bytes aborts before either version can be lost.
     * Removes the source Library folder when done (if empty).
     */
    private async migrateCodexFolder(
        sourceCodex: string,
        destCodex: string,
        journal: LibraryTransferJournal = createLibraryTransferJournal(),
    ): Promise<LibraryTransferJournal> {
        const adapter = this.app.vault.adapter;
        if (!await adapter.exists(sourceCodex)) return journal;

        const listing = await adapter.list(sourceCodex);

        // Migrate files at this level
        for (const filePath of listing.files) {
            const fileName = filePath.split('/').pop() ?? '';
            if (isUntrackedLibraryNoise(fileName)) {
                await adapter.remove(filePath).catch(() => undefined);
                continue;
            }
            if (isProjectScopedLibraryArtifact(fileName)) continue;
            const destFile = normalizePath(`${destCodex}/${fileName}`);
            if (await adapter.exists(destFile)) {
                if (!await this.filesHaveSameBytes(filePath, destFile)) {
                    throw new Error(t('Cannot merge Library file because a different file already exists at {path}.', {
                        path: destFile,
                    }));
                }
                journal.duplicateFiles.push(normalizePath(filePath));
                continue;
            }
            // Use fileManager.renameFile for safe link updates
            const file = this.app.vault.getAbstractFileByPath(filePath);
            if (file instanceof TFile) {
                await this.app.fileManager.renameFile(file, destFile);
                journal.movedFiles.push({ from: normalizePath(filePath), to: destFile });
                continue;
            }
            // On disk but not yet in the vault index (Finder junk already skipped; sync lag / binaries)
            if (await adapter.exists(filePath)) {
                const destParent = destFile.includes('/') ? destFile.slice(0, destFile.lastIndexOf('/')) : destFile;
                await this.ensureFolder(destParent);
                await adapter.rename(filePath, destFile);
                journal.movedFiles.push({ from: normalizePath(filePath), to: destFile });
            }
        }

        // Recursively migrate subfolders
        for (const subFolder of listing.folders) {
            const subName = subFolder.split('/').pop() ?? '';
            if (isUntrackedLibraryNoise(subName) || subName.startsWith('.')) continue;
            const destSub = normalizePath(`${destCodex}/${subName}`);
            await this.ensureFolder(destSub);
            await this.migrateCodexFolder(subFolder, destSub, journal);
        }

        // Remove source folder if empty
        try {
            const remaining = await adapter.list(sourceCodex);
            if (remaining.files.length === 0 && remaining.folders.length === 0) {
                await adapter.rmdir(sourceCodex, false);
            }
        } catch { /* non-fatal */ }
        return journal;
    }

    /**
     * Copy folder contents (non-destructive, for restore when leaving a series).
     */
    private async copyFolderRecursive(
        source: string,
        dest: string,
        journal: LibraryTransferJournal = createLibraryTransferJournal(),
    ): Promise<LibraryTransferJournal> {
        const adapter = this.app.vault.adapter;
        if (!await adapter.exists(source)) return journal;

        await this.ensureFolder(dest);
        const listing = await adapter.list(source);

        for (const filePath of listing.files) {
            const fileName = filePath.split('/').pop() ?? '';
            if (isUntrackedLibraryNoise(fileName) || isProjectScopedLibraryArtifact(fileName)) continue;
            const destFile = normalizePath(`${dest}/${fileName}`);
            if (await adapter.exists(destFile)) {
                if (await this.filesHaveSameBytes(filePath, destFile)) continue;
                throw new Error(t('Cannot copy shared Library file because a different file already exists at {path}.', {
                    path: destFile,
                }));
            }
            // Library folders may contain images, PDFs, or other binary assets.
            // Binary I/O preserves both text and non-text files byte-for-byte.
            const content = await adapter.readBinary(filePath);
            await adapter.writeBinary(destFile, content);
            journal.copiedFiles.push(destFile);
        }

        for (const subFolder of listing.folders) {
            const subName = subFolder.split('/').pop() ?? '';
            if (isUntrackedLibraryNoise(subName) || subName.startsWith('.')) continue;
            await this.copyFolderRecursive(subFolder, normalizePath(`${dest}/${subName}`), journal);
        }
        return journal;
    }

    private async filesHaveSameBytes(leftPath: string, rightPath: string): Promise<boolean> {
        const adapter = this.app.vault.adapter;
        const [left, right] = await Promise.all([
            adapter.readBinary(leftPath),
            adapter.readBinary(rightPath),
        ]);
        if (left.byteLength !== right.byteLength) return false;
        const leftBytes = new Uint8Array(left);
        const rightBytes = new Uint8Array(right);
        for (let index = 0; index < leftBytes.length; index += 1) {
            if (leftBytes[index] !== rightBytes[index]) return false;
        }
        return true;
    }

    private async trashDuplicateLibraryFiles(journal: LibraryTransferJournal): Promise<void> {
        for (const path of journal.duplicateFiles) {
            const file = this.app.vault.getAbstractFileByPath(path);
            if (!(file instanceof TFile)) continue;
            await this.app.fileManager.trashFile(file).catch(error => {
                console.warn('[NarrativeLab] Could not remove identical Library duplicate:', path, error);
            });
        }
    }

    private async rollbackMovedLibraryFiles(journal: LibraryTransferJournal): Promise<void> {
        for (const move of [...journal.movedFiles].reverse()) {
            const destination = this.app.vault.getAbstractFileByPath(move.to);
            if (!(destination instanceof TFile)) continue;
            if (await this.app.vault.adapter.exists(move.from)) continue;
            await this.ensureFolder(move.from.slice(0, move.from.lastIndexOf('/')));
            await this.app.fileManager.renameFile(destination, move.from);
        }
    }

    private async rollbackCopiedLibraryFiles(journal: LibraryTransferJournal): Promise<void> {
        for (const path of [...journal.copiedFiles].reverse()) {
            const file = this.app.vault.getAbstractFileByPath(path);
            if (file instanceof TFile) {
                await this.app.fileManager.trashFile(file);
                continue;
            }
            if (await this.app.vault.adapter.exists(path)) {
                await this.app.vault.adapter.remove(path);
            }
        }
    }

    private async ensureFolder(folderPath: string): Promise<void> {
        const adapter = this.app.vault.adapter;
        const folder = normalizePath(folderPath);
        if (!folder || this.plugin.sceneManager.isDeletedProjectPath(folder)) return;
        if (await adapter.exists(folder)) return;
        const slash = folder.lastIndexOf('/');
        if (slash > 0) await this.ensureFolder(folder.slice(0, slash));
        if (!await adapter.exists(folder)) await adapter.mkdir(folder);
    }
}
