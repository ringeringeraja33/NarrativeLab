import { App, Notice, TFile, normalizePath } from 'obsidian';
import type SceneCardsPlugin from '../main';
import { deriveProjectFoldersFromFilePath } from '../models/StoryLineProject';
import { t } from '../utils/i18n';

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
        const data = JSON.parse(raw) as ProjectBundle;
        if (!data || data.kind !== PROJECT_BUNDLE_KIND) {
            throw new Error(t('Not a NarrativeLab project bundle.'));
        }
        if (!Array.isArray(data.files)) {
            throw new Error(t('Bundle is missing file entries.'));
        }
        return data;
    }

    /**
     * Import bundle files into the active project's base folder (overwrite by relative path).
     */
    async importIntoActiveProject(bundle: ProjectBundle): Promise<{ written: number }> {
        const project = this.plugin.sceneManager.activeProject;
        if (!project) throw new Error(t('No active project. Open a project first.'));

        const folders = deriveProjectFoldersFromFilePath(project.filePath);
        const base = normalizePath(folders.baseFolder);
        let written = 0;

        for (const entry of bundle.files) {
            const rel = normalizePath(String(entry.relativePath || '')).replace(/^\/+/, '');
            if (!rel || rel.includes('..')) continue;
            const target = normalizePath(`${base}/${rel}`);
            await this.ensureParentFolder(target);
            const existing = this.app.vault.getAbstractFileByPath(target);
            const content = String(entry.content ?? '');
            if (existing instanceof TFile) {
                await this.app.vault.modify(existing, content);
            } else {
                await this.app.vault.create(target, content);
            }
            written += 1;
        }

        await this.plugin.loadProjectSystemData();
        await this.plugin.sceneManager.initialize();
        await this.plugin.refreshOpenViews();
        return { written };
    }

    /**
     * Create a new project folder beside the active project's parent (or under story root)
     * and import the bundle into it, then switch to that project.
     */
    async importAsNewProject(bundle: ProjectBundle): Promise<{ written: number; projectPath: string }> {
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

        await this.ensureVaultFolder(base);
        const projectMd = normalizePath(`${base}/${base.split('/').pop()}.md`);
        if (!(await this.app.vault.adapter.exists(projectMd))) {
            await this.app.vault.create(projectMd, `---\ntype: storyline\ntitle: ${JSON.stringify(title)}\n---\n\n# ${title}\n`);
        }

        let written = 0;
        for (const entry of bundle.files) {
            const rel = normalizePath(String(entry.relativePath || '')).replace(/^\/+/, '');
            if (!rel || rel.includes('..')) continue;
            // Skip source project markdown at root if names differ — still write content under new base
            const target = normalizePath(`${base}/${rel}`);
            await this.ensureParentFolder(target);
            const existing = this.app.vault.getAbstractFileByPath(target);
            const content = String(entry.content ?? '');
            if (existing instanceof TFile) {
                await this.app.vault.modify(existing, content);
            } else {
                await this.app.vault.create(target, content);
            }
            written += 1;
        }

        // Ensure project manifest exists after import
        if (!(this.app.vault.getAbstractFileByPath(projectMd) instanceof TFile)) {
            await this.app.vault.create(projectMd, `---\ntype: storyline\ntitle: ${JSON.stringify(title)}\n---\n\n# ${title}\n`);
        }

        await this.plugin.sceneManager.initialize();
        const projects = this.plugin.sceneManager.getProjects();
        const created = projects.find(p => normalizePath(p.filePath) === projectMd)
            || projects.find(p => deriveProjectFoldersFromFilePath(p.filePath).baseFolder === base);
        if (created) {
            await this.plugin.sceneManager.setActiveProject(created);
            await this.plugin.loadProjectSystemData();
            await this.plugin.refreshOpenViews();
        }

        return { written, projectPath: projectMd };
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

export function notifyBundleResult(path: string, count: number): void {
    new Notice(t('Project bundle written: {path} ({n} files)', { path, n: count }));
}
