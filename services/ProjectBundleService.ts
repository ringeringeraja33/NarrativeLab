import { App, TFile, TFolder, normalizePath } from 'obsidian';
import type SceneCardsPlugin from '../main';
import { deriveProjectFoldersFromFilePath } from '../models/StoryLineProject';
import { t } from '../utils/i18n';
import { isRootProjectManifest, normalizeProjectBundleRelativePath } from '../utils/projectBundleValidation';
import { coerceString } from '../utils/narrow';

export const PROJECT_BUNDLE_KIND = 'narrative-lab-project-bundle';
export const PROJECT_BUNDLE_VERSION = 1;

const TEXT_EXTENSIONS = new Set(['md', 'json', 'ncanvas', 'narrativecanvas', 'base', 'csv', 'html', 'txt']);

export interface ProjectBundleFile {
    relativePath: string;
    content: string;
}

export interface ProjectBundle {
    version: number;
    kind: string;
    exportedAt: string;
    project: {
        title: string;
        sourcePath: string;
        baseFolder: string;
    };
    files: ProjectBundleFile[];
}

/**
 * Full-project text asset pack (scenes, library, notes, research, System JSON, ncanvas).
 * Binary attachments are skipped; only path-bearing text files are included.
 */
export class ProjectBundleService {
    constructor(
        private app: App,
        private plugin: SceneCardsPlugin,
    ) {}

    async exportActiveProject(): Promise<string> {
        const project = this.plugin.sceneManager.activeProject;
        if (!project) throw new Error(t('No active project. Open a project first.'));

        const folders = deriveProjectFoldersFromFilePath(project.filePath);
        const base = normalizePath(folders.baseFolder);
        const files: ProjectBundleFile[] = [];

        for (const file of this.app.vault.getFiles()) {
            const path = normalizePath(file.path);
            if (path !== base && !path.startsWith(`${base}/`)) continue;
            if (path.startsWith(`${base}/Exports/`)) continue;
            if (path.startsWith(`${base}/Attachments/`)) continue;
            const ext = file.extension.toLowerCase();
            if (!TEXT_EXTENSIONS.has(ext)) continue;
            try {
                const content = await this.app.vault.read(file);
                const relativePath = path === base
                    ? file.name
                    : path.slice(base.length + 1);
                files.push({ relativePath, content });
            } catch (err) {
                console.warn('[NarrativeLab] Bundle skip file', path, err);
            }
        }

        files.sort((a, b) => a.relativePath.localeCompare(b.relativePath));

        const bundle: ProjectBundle = {
            version: PROJECT_BUNDLE_VERSION,
            kind: PROJECT_BUNDLE_KIND,
            exportedAt: new Date().toISOString(),
            project: {
                title: project.title,
                sourcePath: project.filePath,
                baseFolder: base,
            },
            files,
        };

        const exportFolder = normalizePath(`${base}/Exports`);
        if (!(await this.app.vault.adapter.exists(exportFolder))) {
            await this.app.vault.createFolder(exportFolder);
        }
        const safeTitle = project.title.replace(/[\\/:*?"<>|]/g, '-') || 'project';
        const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
        const outPath = normalizePath(`${exportFolder}/${safeTitle}-bundle-${stamp}.json`);
        const payload = JSON.stringify(bundle, null, 2);
        const existing = this.app.vault.getAbstractFileByPath(outPath);
        if (existing instanceof TFile) {
            await this.app.vault.modify(existing, payload);
        } else {
            await this.app.vault.create(outPath, payload);
        }
        return outPath;
    }

    parseBundle(raw: string): ProjectBundle {
        const data: unknown = JSON.parse(raw);
        if (!this.isRecord(data) || data.kind !== PROJECT_BUNDLE_KIND) {
            throw new Error(t('Not a NarrativeLab project bundle.'));
        }
        if (data.version !== PROJECT_BUNDLE_VERSION) {
            throw new Error(t('Unsupported project bundle version: {version}', {
                version: coerceString(data.version, t('unknown')),
            }));
        }
        if (!this.isRecord(data.project) || typeof data.project.title !== 'string') {
            throw new Error(t('Bundle is missing project metadata.'));
        }
        if (!Array.isArray(data.files)) {
            throw new Error(t('Bundle is missing file entries.'));
        }
        const seen = new Set<string>();
        const files = data.files.map((entry, index) => {
            if (!this.isRecord(entry) || typeof entry.relativePath !== 'string' || typeof entry.content !== 'string') {
                throw new Error(t('Bundle file entry {index} is invalid.', { index: index + 1 }));
            }
            let relativePath: string;
            try {
                relativePath = normalizeProjectBundleRelativePath(entry.relativePath);
            } catch {
                throw new Error(t('Bundle contains an unsafe path: {path}', { path: entry.relativePath }));
            }
            if (seen.has(relativePath)) {
                throw new Error(t('Bundle contains the same path more than once: {path}', { path: relativePath }));
            }
            seen.add(relativePath);
            return { relativePath, content: entry.content };
        });
        return {
            version: PROJECT_BUNDLE_VERSION,
            kind: PROJECT_BUNDLE_KIND,
            exportedAt: typeof data.exportedAt === 'string' ? data.exportedAt : '',
            project: {
                title: data.project.title,
                sourcePath: typeof data.project.sourcePath === 'string' ? data.project.sourcePath : '',
                baseFolder: typeof data.project.baseFolder === 'string' ? data.project.baseFolder : '',
            },
            files,
        };
    }

    /**
     * Import bundle files into the active project's base folder (overwrite by relative path).
     */
    async importIntoActiveProject(bundle: ProjectBundle): Promise<{ written: number }> {
        bundle = this.parseBundle(JSON.stringify(bundle));
        const project = this.plugin.sceneManager.activeProject;
        if (!project) throw new Error(t('No active project. Open a project first.'));

        const folders = deriveProjectFoldersFromFilePath(project.filePath);
        const base = normalizePath(folders.baseFolder);
        const entries = bundle.files.filter(entry => !isRootProjectManifest(entry.relativePath, entry.content));
        const changes: Array<{ target: string; content: string; previousContent: string | null }> = [];
        let written = 0;

        // Read every destination before writing anything. Adapter-only files
        // are rejected because modifying them through Vault would be unsafe.
        for (const entry of entries) {
            const target = normalizePath(`${base}/${entry.relativePath}`);
            const abstract = this.app.vault.getAbstractFileByPath(target);
            if (abstract && !(abstract instanceof TFile)) {
                throw new Error(t('A folder blocks the import path: {path}', { path: target }));
            }
            if (!abstract && await this.app.vault.adapter.exists(target)) {
                throw new Error(t('The import target is not indexed by Obsidian. Reopen the vault and try again: {path}', { path: target }));
            }
            changes.push({
                target,
                content: entry.content,
                previousContent: abstract instanceof TFile ? await this.app.vault.read(abstract) : null,
            });
        }

        const backupFolder = normalizePath(`${this.plugin.getProjectSystemFolder()}/Import Backups`);
        await this.ensureVaultFolder(backupFolder);
        const stamp = new Date().toISOString().replace(/[:.]/g, '-');
        const backupPath = normalizePath(`${backupFolder}/bundle-import-${stamp}.json`);
        await this.app.vault.create(backupPath, JSON.stringify({
            version: 1,
            created: new Date().toISOString(),
            bundleExportedAt: bundle.exportedAt,
            files: changes.map(change => ({
                relativePath: change.target.slice(base.length + 1),
                previousContent: change.previousContent,
            })),
        }, null, 2));

        try {
            for (const change of changes) {
                await this.ensureParentFolder(change.target);
                const existing = this.app.vault.getAbstractFileByPath(change.target);
                if (existing instanceof TFile) await this.app.vault.modify(existing, change.content);
                else await this.app.vault.create(change.target, change.content);
                written += 1;
            }

            await this.plugin.loadProjectSystemData();
            await this.plugin.sceneManager.initialize();
            await this.plugin.refreshOpenViews();
            return { written };
        } catch (error) {
            const rollbackErrors: string[] = [];
            for (const change of [...changes.slice(0, written)].reverse()) {
                try {
                    const file = this.app.vault.getAbstractFileByPath(change.target);
                    if (!(file instanceof TFile)) continue;
                    const current = await this.app.vault.read(file);
                    if (current !== change.content) {
                        rollbackErrors.push(t('Skipped rollback because the file changed: {path}', { path: change.target }));
                        continue;
                    }
                    if (change.previousContent === null) await this.app.fileManager.trashFile(file);
                    else await this.app.vault.modify(file, change.previousContent);
                } catch (rollbackError) {
                    rollbackErrors.push(`${change.target}: ${rollbackError instanceof Error ? rollbackError.message : String(rollbackError)}`);
                }
            }
            await this.plugin.loadProjectSystemData().catch(() => undefined);
            await this.plugin.sceneManager.initialize().catch(() => undefined);
            await this.plugin.refreshOpenViews().catch(() => undefined);
            if (rollbackErrors.length > 0) {
                throw new Error(t('Import failed. Some files could not be rolled back: {details}', {
                    details: rollbackErrors.join('; '),
                }));
            }
            throw error;
        }
    }

    /**
     * Create a new project folder beside the active project's parent (or under story root)
     * and import the bundle into it, then switch to that project.
     */
    async importAsNewProject(bundle: ProjectBundle): Promise<{ written: number; projectPath: string }> {
        bundle = this.parseBundle(JSON.stringify(bundle));
        const title = String(bundle.project?.title || 'Imported Project').trim() || 'Imported Project';
        const safeTitle = title.replace(/[\\/:*?"<>|]/g, '-');
        const active = this.plugin.sceneManager.activeProject;
        let parentRoot = '';
        if (active?.filePath) {
            const folders = deriveProjectFoldersFromFilePath(active.filePath);
            const slash = folders.baseFolder.lastIndexOf('/');
            parentRoot = slash >= 0 ? folders.baseFolder.slice(0, slash) : '';
        }
        if (!parentRoot) {
            parentRoot = (this.plugin.settings.storyLineRoot || 'NarrativeLab').replace(/\/+$/, '');
        }

        let base = normalizePath(`${parentRoot}/${safeTitle}`);
        if (await this.app.vault.adapter.exists(base)) {
            let i = 2;
            while (await this.app.vault.adapter.exists(normalizePath(`${parentRoot}/${safeTitle}-${i}`))) i += 1;
            base = normalizePath(`${parentRoot}/${safeTitle}-${i}`);
        }

        const projectMd = normalizePath(`${base}/${base.split('/').pop()}.md`);
        let written = 0;
        try {
            await this.ensureVaultFolder(base);
            await this.app.vault.create(projectMd, `---\ntype: narrative-lab\ntitle: ${JSON.stringify(title)}\n---\n\n# ${title}\n`);

            for (const entry of bundle.files) {
                // Always replace the source root manifest with the clean target
                // manifest above. This prevents stale seriesId and duplicate projects.
                if (isRootProjectManifest(entry.relativePath, entry.content)) continue;
                const target = normalizePath(`${base}/${entry.relativePath}`);
                await this.ensureParentFolder(target);
                const existing = this.app.vault.getAbstractFileByPath(target);
                if (existing && !(existing instanceof TFile)) {
                    throw new Error(t('A folder blocks the import path: {path}', { path: target }));
                }
                if (existing instanceof TFile) await this.app.vault.modify(existing, entry.content);
                else await this.app.vault.create(target, entry.content);
                written += 1;
            }

            await this.plugin.sceneManager.initialize();
            const projects = this.plugin.sceneManager.getProjects();
            const created = projects.find(p => normalizePath(p.filePath) === projectMd)
                || projects.find(p => deriveProjectFoldersFromFilePath(p.filePath).baseFolder === base);
            if (!created) throw new Error(t('Imported project could not be registered.'));
            await this.plugin.sceneManager.setActiveProject(created);
            await this.plugin.loadProjectSystemData();
            await this.plugin.refreshOpenViews();

            return { written, projectPath: projectMd };
        } catch (error) {
            if (active) {
                await this.plugin.sceneManager.setActiveProject(active).catch(() => undefined);
                await this.plugin.loadProjectSystemData().catch(() => undefined);
            }
            const createdFolder = this.app.vault.getAbstractFileByPath(base);
            if (createdFolder instanceof TFolder) {
                await this.app.fileManager.trashFile(createdFolder).catch(cleanupError => {
                    console.error('[NarrativeLab] Failed to move incomplete imported project to trash:', cleanupError);
                });
            }
            await this.plugin.sceneManager.initialize().catch(() => undefined);
            await this.plugin.refreshOpenViews().catch(() => undefined);
            throw error;
        }
    }

    private async ensureParentFolder(filePath: string): Promise<void> {
        const slash = filePath.lastIndexOf('/');
        if (slash <= 0) return;
        await this.ensureVaultFolder(filePath.slice(0, slash));
    }

    private async ensureVaultFolder(folder: string): Promise<void> {
        const parts = normalizePath(folder).split('/').filter(Boolean);
        let cur = '';
        for (const part of parts) {
            cur = cur ? `${cur}/${part}` : part;
            if (!(await this.app.vault.adapter.exists(cur))) {
                await this.app.vault.createFolder(cur);
            }
        }
    }

    private isRecord(value: unknown): value is Record<string, unknown> {
        return value !== null && typeof value === 'object' && !Array.isArray(value);
    }

}

/** Pick a vault .json file via fuzzy suggest. */
export async function pickBundleJsonFile(app: App): Promise<TFile | null> {
    const { FuzzySuggestModal } = await import('obsidian');
    return new Promise((resolve) => {
        let settled = false;
        const finish = (file: TFile | null) => {
            if (settled) return;
            settled = true;
            resolve(file);
        };
        const files = app.vault.getFiles().filter(f => f.extension.toLowerCase() === 'json');
        const modal = new (class extends FuzzySuggestModal<TFile> {
            getItems(): TFile[] { return files; }
            getItemText(item: TFile): string { return item.path; }
            onChooseItem(item: TFile): void { finish(item); }
            onClose(): void {
                window.setTimeout(() => finish(null), 0);
            }
        })(app);
        modal.setPlaceholder(t('Search for a project bundle JSON…'));
        modal.open();
    });
}
