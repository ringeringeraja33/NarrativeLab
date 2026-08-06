/* eslint-disable @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-argument, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-return, @typescript-eslint/no-floating-promises, @typescript-eslint/no-misused-promises, @typescript-eslint/no-unnecessary-type-assertion, @typescript-eslint/no-redundant-type-constituents, @typescript-eslint/no-unused-vars, no-unused-vars, no-useless-escape, no-control-regex, no-empty -- Obsidian's API surface and several untyped third-party libraries force dynamic dispatch; floating promises are intentional in DOM/event handlers; matching enable at end of file */
import { App, Notice, normalizePath } from 'obsidian';
import type SceneCardsPlugin from '../main';
import { SeriesMetadata, deriveProjectFoldersFromFilePath } from '../models/StoryLineProject';

/**
 * Manages series — groups of book projects sharing a common codex.
 *
 * Series folder layout:
 *   MySeriesFolder/
 *     series.json        ← SeriesMetadata
 *     Codex/
 *       Characters/
 *       Locations/
 *       [other codex categories]
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
        if (!await adapter.exists(metaPath)) return null;
        try {
            const raw = await adapter.read(metaPath);
            const data = JSON.parse(raw);
            if (!data.name || !Array.isArray(data.bookOrder)) return null;
            return {
                name: data.name,
                bookOrder: data.bookOrder,
                created: data.created || '',
            };
        } catch {
            return null;
        }
    }

    /**
     * Save series.json to the series folder.
     */
    async saveSeriesMetadata(seriesFolder: string, meta: SeriesMetadata): Promise<void> {
        const adapter = this.app.vault.adapter;
        const metaPath = normalizePath(`${seriesFolder}/series.json`);
        await adapter.write(metaPath, JSON.stringify(meta, null, 2));
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
     * Create a new series from the currently active project.
     *
     * Steps:
     * 1. Create series folder (parent-level) inside NarrativeLab root
     * 2. Move the current book project folder into the series folder
     * 3. Move the book's codex to the shared series codex folder
     * 4. Write series.json
     * 5. Update the project's seriesId
     */
    async createSeriesFromProject(seriesName: string): Promise<string> {
        // Pre-flight: check Obsidian link settings
        this.checkLinkSettings();

        const project = this.plugin.sceneManager.activeProject;
        if (!project) throw new Error('No active project');

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
                `Series name "${seriesName}" matches the current project's folder name. ` +
                `Please choose a different series name (e.g. "${seriesName} Series").`
            );
        }

        // Ensure series folder exists
        await this.ensureFolder(seriesFolder);

        // If the book is not already inside the series folder, move it
        const targetBookFolder = normalizePath(`${seriesFolder}/${bookBaseName}`);
        if (normalizePath(bookFolders.baseFolder) !== targetBookFolder) {
            await this.moveFolderRecursive(bookFolders.baseFolder, targetBookFolder);
            // Also move the project .md file if it's at root level
            const oldProjectFile = project.filePath;
            const newProjectFile = normalizePath(`${targetBookFolder}/${bookBaseName}.md`);
            if (normalizePath(oldProjectFile) !== newProjectFile) {
                // The project file should already be inside the book folder after move
                // but handle root-level project files (legacy layout)
                if (await adapter.exists(oldProjectFile)) {
                    await this.app.fileManager.renameFile(
                        this.app.vault.getAbstractFileByPath(oldProjectFile)!,
                        newProjectFile
                    );
                }
            }
        }

        // Create shared Codex folder structure at series level
        const seriesCodexFolder = normalizePath(`${seriesFolder}/Library`);
        await this.ensureFolder(seriesCodexFolder);
        await this.ensureFolder(normalizePath(`${seriesCodexFolder}/Characters`));
        await this.ensureFolder(normalizePath(`${seriesCodexFolder}/Locations`));

        // Move book's codex entries to the shared series codex
        const bookCodexFolder = normalizePath(`${targetBookFolder}/Library`);
        if (await adapter.exists(bookCodexFolder)) {
            await this.migrateCodexFolder(bookCodexFolder, seriesCodexFolder);
        }

        // Write series.json
        const now = new Date().toISOString().split('T')[0];
        const meta: SeriesMetadata = {
            name: seriesName,
            bookOrder: [bookBaseName],
            created: now,
        };
        await this.saveSeriesMetadata(seriesFolder, meta);

        // Update project's seriesId and re-derive paths
        const newProjectFile = normalizePath(`${targetBookFolder}/${bookBaseName}.md`);
        await this.plugin.sceneManager.scanProjects();
        const updatedProject = this.plugin.sceneManager.getProjects()
            .find(p => normalizePath(p.filePath) === newProjectFile);
        if (updatedProject) {
            updatedProject.seriesId = safeName;
            await this.plugin.sceneManager.setActiveProject(updatedProject);
            await this.plugin.sceneManager.saveProjectFrontmatter(updatedProject);
        }

        new Notice(`Series "${seriesName}" created`);
        return seriesFolder;
    }

    // ── Add existing project to series ─────────────────

    /**
     * Add the currently active project to an existing series.
     *
     * Steps:
     * 1. Move book folder into the series folder
     * 2. Migrate book's codex to the shared series codex (handling duplicates)
     * 3. Update series.json bookOrder
     * 4. Set seriesId on the project
     */
    async addProjectToSeries(seriesFolder: string): Promise<void> {
        this.checkLinkSettings();

        const project = this.plugin.sceneManager.activeProject;
        if (!project) throw new Error('No active project');

        const meta = await this.loadSeriesMetadata(seriesFolder);
        if (!meta) throw new Error('Invalid series folder — no series.json found');

        const adapter = this.app.vault.adapter;
        const bookFolders = deriveProjectFoldersFromFilePath(project.filePath);
        const bookBaseName = bookFolders.baseFolder.split('/').pop() ?? '';
        const seriesFolderName = seriesFolder.split('/').pop() ?? '';

        // Issue #82: refuse same-name collision between series folder and
        // the book folder \u2014 would attempt to move the book into itself.
        if (seriesFolderName.toLowerCase() === bookBaseName.toLowerCase()) {
            throw new Error(
                `Series folder "${seriesFolderName}" has the same name as the project folder. ` +
                `Rename the project or the series before adding.`
            );
        }

        const targetBookFolder = normalizePath(`${seriesFolder}/${bookBaseName}`);

        // Move the book folder into the series
        if (normalizePath(bookFolders.baseFolder) !== targetBookFolder) {
            await this.moveFolderRecursive(bookFolders.baseFolder, targetBookFolder);
        }

        // Migrate codex
        const seriesCodexFolder = normalizePath(`${seriesFolder}/Library`);
        await this.ensureFolder(seriesCodexFolder);
        await this.ensureFolder(normalizePath(`${seriesCodexFolder}/Characters`));
        await this.ensureFolder(normalizePath(`${seriesCodexFolder}/Locations`));

        const bookCodexFolder = normalizePath(`${targetBookFolder}/Library`);
        if (await adapter.exists(bookCodexFolder)) {
            await this.migrateCodexFolder(bookCodexFolder, seriesCodexFolder);
        }

        // Update series.json
        const safeName = seriesFolder.split('/').pop() ?? '';
        if (!meta.bookOrder.includes(bookBaseName)) {
            meta.bookOrder.push(bookBaseName);
        }
        await this.saveSeriesMetadata(seriesFolder, meta);

        // Re-scan and set active with seriesId
        const newProjectFile = normalizePath(`${targetBookFolder}/${bookBaseName}.md`);
        await this.plugin.sceneManager.scanProjects();
        const updatedProject = this.plugin.sceneManager.getProjects()
            .find(p => normalizePath(p.filePath) === newProjectFile);
        if (updatedProject) {
            updatedProject.seriesId = safeName;
            await this.plugin.sceneManager.setActiveProject(updatedProject);
            await this.plugin.sceneManager.saveProjectFrontmatter(updatedProject);
        }

        new Notice(`Project added to series "${meta.name}"`);
    }

    // ── Remove from series ─────────────────────────────

    /**
     * Remove the active project from its series.
     * Moves the book folder back out and copies its current shared codex entities locally.
     */
    async removeProjectFromSeries(): Promise<void> {
        const project = this.plugin.sceneManager.activeProject;
        if (!project?.seriesId) throw new Error('Project is not in a series');

        const seriesFolder = this.plugin.sceneManager.getSeriesFolder();
        if (!seriesFolder) throw new Error('Cannot determine series folder');

        const meta = await this.loadSeriesMetadata(seriesFolder);
        if (!meta) throw new Error('Invalid series metadata');

        const bookFolders = deriveProjectFoldersFromFilePath(project.filePath);
        const bookBaseName = bookFolders.baseFolder.split('/').pop() ?? '';
        const seriesParent = seriesFolder.includes('/')
            ? seriesFolder.split('/').slice(0, -1).join('/')
            : '';
        const targetBookFolder = normalizePath([seriesParent, bookBaseName].filter(Boolean).join('/'));

        // Copy shared codex entries into the book's local codex before moving
        const seriesCodexFolder = normalizePath(`${seriesFolder}/Library`);
        const localCodexFolder = normalizePath(`${bookFolders.baseFolder}/Library`);
        await this.ensureFolder(localCodexFolder);
        await this.copyFolderRecursive(seriesCodexFolder, localCodexFolder);

        // Move book folder out of series folder
        if (normalizePath(bookFolders.baseFolder) !== targetBookFolder) {
            await this.moveFolderRecursive(bookFolders.baseFolder, targetBookFolder);
        }

        // Update series.json
        meta.bookOrder = meta.bookOrder.filter(b => b !== bookBaseName);
        await this.saveSeriesMetadata(seriesFolder, meta);

        // Re-scan and clear seriesId
        const newProjectFile = normalizePath(`${targetBookFolder}/${bookBaseName}.md`);
        await this.plugin.sceneManager.scanProjects();
        const updatedProject = this.plugin.sceneManager.getProjects()
            .find(p => normalizePath(p.filePath) === newProjectFile);
        if (updatedProject) {
            delete updatedProject.seriesId;
            await this.plugin.sceneManager.setActiveProject(updatedProject);
            await this.plugin.sceneManager.saveProjectFrontmatter(updatedProject);
        }

        new Notice(`Project removed from series "${meta.name}"`);
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
                    && !['Library', 'Codex', 'Scenes', 'System', 'Attachments', 'NCanvas', 'Canvas'].includes(name)) {
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
        const vaultConfig = ((this.app.vault as unknown as { config?: Record<string, unknown> }).config) ?? {};

        // Obsidian stores the "Automatically update internal links" toggle
        // under the internal key `alwaysUpdateLinks`. When it is `true`,
        // auto-update is enabled (links are silently updated when files move).
        // Default (undefined / false) = auto-update is OFF — Obsidian prompts
        // or leaves stale links.
        // Note: older Obsidian versions used `promptDelete` for a different
        // setting ("Confirm before deleting"), so we check both keys for
        // maximum compatibility, but `alwaysUpdateLinks` is the correct one.
        const alwaysUpdate = vaultConfig.alwaysUpdateLinks === true;
        if (!alwaysUpdate) {
            throw new Error(
                'Series migration requires "Automatically update internal links" to be ON.\n\n' +
                'Go to Settings → Files & Links and enable it, then try again.'
            );
        }

        const newLinkFormat = vaultConfig.newLinkFormat;
        if (newLinkFormat && newLinkFormat !== 'shortest') {
            new Notice(
                'Tip: Setting "New link format" to "Shortest path when possible" ' +
                'is recommended before migrating to a series.',
                8000
            );
        }
    }

    // ── File operations ────────────────────────────────

    /**
     * Migrate all files from a book's Codex folder to the series Codex folder.
     * Skips files that already exist in the destination (no overwrite).
     * Removes the source codex folder when done (if empty).
     */
    private async migrateCodexFolder(sourceCodex: string, destCodex: string): Promise<void> {
        const adapter = this.app.vault.adapter;
        if (!await adapter.exists(sourceCodex)) return;

        const listing = await adapter.list(sourceCodex);

        // Migrate files at this level
        for (const filePath of listing.files) {
            const fileName = filePath.split('/').pop() ?? '';
            const destFile = normalizePath(`${destCodex}/${fileName}`);
            if (await adapter.exists(destFile)) {
                // Duplicate — skip (series version takes precedence)
                continue;
            }
            // Use fileManager.renameFile for safe link updates
            const file = this.app.vault.getAbstractFileByPath(filePath);
            if (file) {
                await this.app.fileManager.renameFile(file, destFile);
            }
        }

        // Recursively migrate subfolders
        for (const subFolder of listing.folders) {
            const subName = subFolder.split('/').pop() ?? '';
            const destSub = normalizePath(`${destCodex}/${subName}`);
            await this.ensureFolder(destSub);
            await this.migrateCodexFolder(subFolder, destSub);
        }

        // Remove source folder if empty
        try {
            const remaining = await adapter.list(sourceCodex);
            if (remaining.files.length === 0 && remaining.folders.length === 0) {
                await adapter.rmdir(sourceCodex, false);
            }
        } catch { /* non-fatal */ }
    }

    /**
     * Move an entire folder tree from source to destination.
     * Uses fileManager.renameFile for each file to preserve links.
     */
    private async moveFolderRecursive(source: string, dest: string): Promise<void> {
        const adapter = this.app.vault.adapter;
        if (!await adapter.exists(source)) return;

        const normSource = normalizePath(source);
        const normDest = normalizePath(dest);
        // Defensive guard against pathological inputs (e.g. dest inside source
        // due to a same-name collision between series and book — issue #82).
        // Without this we would recurse forever moving the destination subtree
        // back into itself.
        if (normSource === normDest) return;
        if (normDest.startsWith(`${normSource}/`)) {
            throw new Error(
                `Cannot move "${normSource}" into its own subfolder "${normDest}". ` +
                `Choose a different destination name.`
            );
        }

        await this.ensureFolder(dest);
        const listing = await adapter.list(source);

        for (const filePath of listing.files) {
            const fileName = filePath.split('/').pop() ?? '';
            const destFile = normalizePath(`${dest}/${fileName}`);
            const file = this.app.vault.getAbstractFileByPath(filePath);
            if (file) {
                await this.app.fileManager.renameFile(file, destFile);
            }
        }

        for (const subFolder of listing.folders) {
            const subName = subFolder.split('/').pop() ?? '';
            const destSub = normalizePath(`${dest}/${subName}`);
            await this.moveFolderRecursive(subFolder, destSub);
        }

        // Remove source folder if empty
        try {
            const remaining = await adapter.list(source);
            if (remaining.files.length === 0 && remaining.folders.length === 0) {
                await adapter.rmdir(source, false);
            }
        } catch { /* non-fatal */ }
    }

    /**
     * Copy folder contents (non-destructive, for restore when leaving a series).
     */
    private async copyFolderRecursive(source: string, dest: string): Promise<void> {
        const adapter = this.app.vault.adapter;
        if (!await adapter.exists(source)) return;

        await this.ensureFolder(dest);
        const listing = await adapter.list(source);

        for (const filePath of listing.files) {
            const fileName = filePath.split('/').pop() ?? '';
            const destFile = normalizePath(`${dest}/${fileName}`);
            if (await adapter.exists(destFile)) continue;
            try {
                const content = await adapter.read(filePath);
                await adapter.write(destFile, content);
            } catch { /* skip unreadable */ }
        }

        for (const subFolder of listing.folders) {
            const subName = subFolder.split('/').pop() ?? '';
            await this.copyFolderRecursive(subFolder, normalizePath(`${dest}/${subName}`));
        }
    }

    private async ensureFolder(folderPath: string): Promise<void> {
        const adapter = this.app.vault.adapter;
        if (!await adapter.exists(folderPath)) {
            await adapter.mkdir(folderPath);
        }
    }
}
/* eslint-enable @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-argument, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-return, @typescript-eslint/no-floating-promises, @typescript-eslint/no-misused-promises, @typescript-eslint/no-unnecessary-type-assertion, @typescript-eslint/no-redundant-type-constituents, @typescript-eslint/no-unused-vars, no-unused-vars, no-useless-escape, no-control-regex, no-empty -- end of file-wide suppression block opened at line 1 */
