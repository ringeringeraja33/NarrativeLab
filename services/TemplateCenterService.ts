import { App, normalizePath } from 'obsidian';
import type SceneCardsPlugin from '../main';
import type { BeatSheetTemplate, ProjectPresetTemplate, SceneTemplate, TemplateScope } from '../models/Scene';
import { t } from '../utils/i18n';

export const PROJECT_TEMPLATES_FOLDER = 'Templates';
export const PROJECT_TEMPLATES_FILE = 'templates.json';

interface ProjectTemplateFile {
    version: 1;
    sceneTemplates: SceneTemplate[];
    structureTemplates: BeatSheetTemplate[];
    projectPresets: ProjectPresetTemplate[];
}

export interface TemplateExportBundle extends ProjectTemplateFile {
    kind: 'narrative-lab-template-bundle';
    exportedAt: string;
}

function makeId(prefix: string): string {
    return `${prefix}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

function normalizeSceneTemplate(template: SceneTemplate, scope: TemplateScope): SceneTemplate {
    return {
        ...template,
        id: template.id || makeId('scene'),
        scope,
        name: String(template.name || '').trim() || 'Untitled Template',
        description: typeof template.description === 'string' ? template.description : undefined,
        defaultFields: { ...(template.defaultFields || {}) },
        bodyTemplate: typeof template.bodyTemplate === 'string' ? template.bodyTemplate : '',
    };
}

function normalizeStructureTemplate(template: BeatSheetTemplate, scope: TemplateScope): BeatSheetTemplate {
    const positiveNumbers = (value: unknown): number[] => Array.isArray(value)
        ? [...new Set(value.map(Number).filter(n => Number.isInteger(n) && n >= 0))].sort((a, b) => a - b)
        : [];
    const labels = (value: unknown): Record<number, string> => {
        const out: Record<number, string> = {};
        if (!value || typeof value !== 'object') return out;
        for (const [key, label] of Object.entries(value as Record<string, unknown>)) {
            const n = Number(key);
            if (Number.isInteger(n) && typeof label === 'string' && label.trim()) out[n] = label.trim();
        }
        return out;
    };
    return {
        ...template,
        id: template.id || makeId('structure'),
        scope,
        name: String(template.name || '').trim() || 'Untitled Structure',
        summary: typeof template.summary === 'string' ? template.summary : '',
        acts: positiveNumbers(template.acts),
        chapters: positiveNumbers(template.chapters),
        actLabels: labels(template.actLabels),
        chapterLabels: labels(template.chapterLabels),
        beats: Array.isArray(template.beats)
            ? template.beats
                .filter(beat => beat && typeof beat === 'object')
                .map(beat => ({
                    act: Number(beat.act) || 1,
                    ...(beat.chapter === undefined ? {} : { chapter: Number(beat.chapter) || 1 }),
                    label: String(beat.label || '').trim() || 'Beat',
                    description: String(beat.description || ''),
                }))
            : [],
    };
}

function normalizePreset(template: ProjectPresetTemplate, scope: TemplateScope): ProjectPresetTemplate {
    return {
        ...template,
        id: template.id || makeId('preset'),
        scope,
        name: String(template.name || '').trim() || 'Untitled Preset',
    };
}

function isProjectTemplateFile(value: unknown): value is ProjectTemplateFile {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
    const file = value as Partial<ProjectTemplateFile>;
    return file.version === 1
        && Array.isArray(file.sceneTemplates)
        && Array.isArray(file.structureTemplates)
        && Array.isArray(file.projectPresets);
}

/** Owns global and per-project template persistence. Project data never enters Library/. */
export class TemplateCenterService {
    private projectSceneTemplates: SceneTemplate[] = [];
    private projectStructureTemplates: BeatSheetTemplate[] = [];
    private projectPresets: ProjectPresetTemplate[] = [];
    private projectFileInvalid = false;
    private projectLoadedFromBackup = false;

    constructor(private app: App, private plugin: SceneCardsPlugin) {}

    private get folderPath(): string {
        return normalizePath(`${this.plugin.getProjectSystemFolder()}/${PROJECT_TEMPLATES_FOLDER}`);
    }

    private get filePath(): string {
        return normalizePath(`${this.folderPath}/${PROJECT_TEMPLATES_FILE}`);
    }

    async load(): Promise<void> {
        this.projectSceneTemplates = [];
        this.projectStructureTemplates = [];
        this.projectPresets = [];
        this.projectFileInvalid = false;
        this.projectLoadedFromBackup = false;
        if (!this.plugin.sceneManager?.activeProject) return;
        const adapter = this.app.vault.adapter;
        let foundCandidate = false;
        for (const candidate of [`${this.filePath}.tmp`, this.filePath, `${this.filePath}.bak`]) {
            try {
                if (!await adapter.exists(candidate)) continue;
                foundCandidate = true;
                const raw = JSON.parse(await adapter.read(candidate)) as unknown;
                if (!isProjectTemplateFile(raw)) throw new Error('invalid project template file');
                this.projectSceneTemplates = raw.sceneTemplates.map(template => normalizeSceneTemplate(template, 'project'));
                this.projectStructureTemplates = raw.structureTemplates.map(template => normalizeStructureTemplate(template, 'project'));
                this.projectPresets = raw.projectPresets.map(template => normalizePreset(template, 'project'));
                this.projectLoadedFromBackup = candidate !== this.filePath;
                return;
            } catch (error) {
                console.error(`[NarrativeLab] Could not load project templates from ${candidate}:`, error);
            }
        }
        this.projectFileInvalid = foundCandidate;
    }

    private async saveProject(): Promise<void> {
        if (!this.plugin.sceneManager?.activeProject) throw new Error(t('Open a project before saving project templates.'));
        if (this.projectFileInvalid) {
            throw new Error(t('Project templates cannot be saved because the existing file is unreadable.'));
        }
        if (!await this.app.vault.adapter.exists(this.folderPath)) {
            await this.app.vault.createFolder(this.folderPath);
        }
        const payload: ProjectTemplateFile = {
            version: 1,
            sceneTemplates: this.projectSceneTemplates,
            structureTemplates: this.projectStructureTemplates,
            projectPresets: this.projectPresets,
        };
        const content = JSON.stringify(payload, null, 2);
        const tempPath = `${this.filePath}.tmp`;
        const backupPath = `${this.filePath}.bak`;
        await this.app.vault.adapter.write(tempPath, content);
        if (!this.projectLoadedFromBackup && await this.app.vault.adapter.exists(this.filePath)) {
            await this.app.vault.adapter.write(backupPath, await this.app.vault.adapter.read(this.filePath));
        }
        await this.app.vault.adapter.write(this.filePath, content);
        await this.app.vault.adapter.remove(tempPath).catch(() => undefined);
        this.projectLoadedFromBackup = false;
    }

    getSceneTemplates(): SceneTemplate[] {
        return [
            ...(this.plugin.settings.sceneTemplates || []).map(template => normalizeSceneTemplate(template, 'global')),
            ...this.projectSceneTemplates.map(template => ({ ...template, defaultFields: { ...template.defaultFields } })),
        ];
    }

    getStructureTemplates(): BeatSheetTemplate[] {
        return [
            ...(this.plugin.settings.structureTemplates || []).map(template => normalizeStructureTemplate(template, 'global')),
            ...this.projectStructureTemplates.map(template => ({ ...template })),
        ];
    }

    getProjectPresets(): ProjectPresetTemplate[] {
        return [
            ...(this.plugin.settings.projectPresets || []).map(template => normalizePreset(template, 'global')),
            ...this.projectPresets.map(template => ({ ...template })),
        ];
    }

    findSceneTemplate(id?: string): SceneTemplate | undefined {
        return id ? this.getSceneTemplates().find(template => template.id === id) : undefined;
    }

    findStructureTemplate(id?: string): BeatSheetTemplate | undefined {
        return id ? this.getStructureTemplates().find(template => template.id === id) : undefined;
    }

    async saveSceneTemplate(template: SceneTemplate): Promise<SceneTemplate> {
        const scope = template.scope === 'project' ? 'project' : 'global';
        const normalized = normalizeSceneTemplate(template, scope);
        if (scope === 'project') {
            this.projectSceneTemplates = this.upsert(this.projectSceneTemplates, normalized);
            await this.saveProject();
            this.plugin.settings.sceneTemplates = (this.plugin.settings.sceneTemplates || []).filter(item => item.id !== normalized.id);
            await this.plugin.saveSettings();
        } else {
            this.plugin.settings.sceneTemplates = this.upsert(this.plugin.settings.sceneTemplates || [], normalized);
            await this.plugin.saveSettings();
            const projectLength = this.projectSceneTemplates.length;
            this.projectSceneTemplates = this.projectSceneTemplates.filter(item => item.id !== normalized.id);
            if (this.projectSceneTemplates.length !== projectLength) await this.saveProject();
        }
        return normalized;
    }

    async saveStructureTemplate(template: BeatSheetTemplate): Promise<BeatSheetTemplate> {
        const scope = template.scope === 'project' ? 'project' : 'global';
        const normalized = normalizeStructureTemplate(template, scope);
        if (scope === 'project') {
            this.projectStructureTemplates = this.upsert(this.projectStructureTemplates, normalized);
            await this.saveProject();
            this.plugin.settings.structureTemplates = (this.plugin.settings.structureTemplates || []).filter(item => item.id !== normalized.id);
            await this.plugin.saveSettings();
        } else {
            this.plugin.settings.structureTemplates = this.upsert(this.plugin.settings.structureTemplates || [], normalized);
            await this.plugin.saveSettings();
            const projectLength = this.projectStructureTemplates.length;
            this.projectStructureTemplates = this.projectStructureTemplates.filter(item => item.id !== normalized.id);
            if (this.projectStructureTemplates.length !== projectLength) await this.saveProject();
        }
        return normalized;
    }

    async saveProjectPreset(template: ProjectPresetTemplate): Promise<ProjectPresetTemplate> {
        const scope = template.scope === 'project' ? 'project' : 'global';
        const normalized = normalizePreset(template, scope);
        if (scope === 'project') {
            this.projectPresets = this.upsert(this.projectPresets, normalized);
            await this.saveProject();
            this.plugin.settings.projectPresets = (this.plugin.settings.projectPresets || []).filter(item => item.id !== normalized.id);
            await this.plugin.saveSettings();
        } else {
            this.plugin.settings.projectPresets = this.upsert(this.plugin.settings.projectPresets || [], normalized);
            await this.plugin.saveSettings();
            const projectLength = this.projectPresets.length;
            this.projectPresets = this.projectPresets.filter(item => item.id !== normalized.id);
            if (this.projectPresets.length !== projectLength) await this.saveProject();
        }
        return normalized;
    }

    async deleteTemplate(kind: 'scene' | 'structure' | 'preset', id: string): Promise<void> {
        const globalKey = kind === 'scene' ? 'sceneTemplates' : kind === 'structure' ? 'structureTemplates' : 'projectPresets';
        const globalItems = this.plugin.settings[globalKey] as Array<{ id?: string }>;
        const globalNext = globalItems.filter(item => item.id !== id);
        if (globalNext.length !== globalItems.length) {
            (this.plugin.settings[globalKey] as Array<{ id?: string }>) = globalNext;
            await this.plugin.saveSettings();
            return;
        }
        if (kind === 'scene') this.projectSceneTemplates = this.projectSceneTemplates.filter(item => item.id !== id);
        if (kind === 'structure') this.projectStructureTemplates = this.projectStructureTemplates.filter(item => item.id !== id);
        if (kind === 'preset') this.projectPresets = this.projectPresets.filter(item => item.id !== id);
        await this.saveProject();
    }

    async moveSceneTemplate(id: string, direction: -1 | 1): Promise<void> {
        const globalIndex = (this.plugin.settings.sceneTemplates || []).findIndex(item => item.id === id);
        if (globalIndex >= 0) {
            this.move(this.plugin.settings.sceneTemplates, globalIndex, direction);
            await this.plugin.saveSettings();
            return;
        }
        const projectIndex = this.projectSceneTemplates.findIndex(item => item.id === id);
        if (projectIndex >= 0) {
            this.move(this.projectSceneTemplates, projectIndex, direction);
            await this.saveProject();
        }
    }

    async exportBundle(): Promise<string> {
        if (!this.plugin.sceneManager?.activeProject) throw new Error(t('Open a project before exporting templates.'));
        if (!await this.app.vault.adapter.exists(this.folderPath)) await this.app.vault.createFolder(this.folderPath);
        const stamp = new Date().toISOString().replace(/[:.]/g, '-');
        const path = normalizePath(`${this.folderPath}/template-export-${stamp}.json`);
        const bundle: TemplateExportBundle = {
            kind: 'narrative-lab-template-bundle',
            version: 1,
            exportedAt: new Date().toISOString(),
            sceneTemplates: this.getSceneTemplates(),
            structureTemplates: this.getStructureTemplates(),
            projectPresets: this.getProjectPresets(),
        };
        await this.app.vault.adapter.write(path, JSON.stringify(bundle, null, 2));
        return path;
    }

    async importBundle(path: string, scope: TemplateScope): Promise<{ scenes: number; structures: number; presets: number }> {
        const raw = JSON.parse(await this.app.vault.adapter.read(normalizePath(path))) as Partial<TemplateExportBundle>;
        if (raw.kind !== 'narrative-lab-template-bundle') throw new Error(t('This is not a NarrativeLab template bundle.'));
        const scenes = Array.isArray(raw.sceneTemplates) ? raw.sceneTemplates : [];
        const structures = Array.isArray(raw.structureTemplates) ? raw.structureTemplates : [];
        const presets = Array.isArray(raw.projectPresets) ? raw.projectPresets : [];
        for (const template of scenes) await this.saveSceneTemplate({ ...template, id: makeId('scene'), scope });
        for (const template of structures) await this.saveStructureTemplate({ ...template, id: makeId('structure'), scope });
        for (const template of presets) await this.saveProjectPreset({ ...template, id: makeId('preset'), scope });
        return { scenes: scenes.length, structures: structures.length, presets: presets.length };
    }

    private upsert<T extends { id?: string }>(items: T[], item: T): T[] {
        const index = items.findIndex(existing => existing.id === item.id);
        if (index < 0) return [...items, item];
        return items.map((existing, itemIndex) => itemIndex === index ? item : existing);
    }

    private move<T>(items: T[], index: number, direction: -1 | 1): void {
        const target = index + direction;
        if (target < 0 || target >= items.length) return;
        [items[index], items[target]] = [items[target], items[index]];
    }
}
