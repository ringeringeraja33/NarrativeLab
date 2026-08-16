import { normalizePath } from 'obsidian';
import type SceneCardsPlugin from '../main';
import type { PlotlineDefinition } from '../models/Plotline';
import { normalizePlotlineDefinitions } from '../models/Plotline';
import type { Scene } from '../models/Scene';
import type { SceneManager } from './SceneManager';

/**
 * Per-project plotline registry: definitions + scenePaths ordering.
 * Scene.tags remain the membership source of truth for Board/Timeline.
 */
export class PlotlineManager {
    private seeded = false;

    constructor(
        private readonly plugin: SceneCardsPlugin,
        private readonly sceneManager: SceneManager,
    ) {}

    getPlotlineDefinitions(): PlotlineDefinition[] {
        return this.plugin.plotlineDefinitions.map(d => ({
            id: d.id,
            label: d.label,
            scenePaths: [...d.scenePaths],
        }));
    }

    /** Load definitions from parsed plotlines.json payload. */
    applyLoaded(raw: unknown, projectFile?: string): void {
        this.plugin.plotlineDefinitions = normalizePlotlineDefinitions(raw);
        this.seeded = this.plugin.plotlineDefinitions.length > 0;
        this.plugin.claimPlotlineRegistry(projectFile || this.sceneManager.activeProject?.filePath || '');
    }

    markLoaded(seeded: boolean): void {
        this.seeded = seeded;
    }

    /** Seed definitions from existing tags when plotlines.json has none yet. */
    async ensureSeeded(): Promise<void> {
        const activeFile = this.sceneManager.activeProject?.filePath
            ? normalizePath(this.sceneManager.activeProject.filePath)
            : '';
        const owner = this.plugin.plotlineRegistryOwner
            ? normalizePath(this.plugin.plotlineRegistryOwner)
            : '';
        if (owner && activeFile && owner !== activeFile) return;
        if (this.seeded || this.plugin.plotlineDefinitions.length > 0) {
            this.seeded = true;
            return;
        }
        if (!this.sceneManager.activeProject) return;

        const tagNames = this.collectTagNamesForSeed();
        const definitions: PlotlineDefinition[] = [];

        for (const id of tagNames) {
            const scenes = this.scenesForPlotlineSeed(id);
            definitions.push({
                id,
                label: id,
                scenePaths: scenes.map(s => s.filePath),
            });
        }

        if (definitions.length === 0) {
            this.seeded = true;
            return;
        }

        this.plugin.plotlineDefinitions = definitions;
        this.seeded = true;
        this.plugin.claimPlotlineRegistry(this.sceneManager.activeProject?.filePath || '');
        await this.plugin.saveProjectSystemData();
    }

    private collectTagNamesForSeed(): string[] {
        const names = new Set<string>();
        for (const name of this.sceneManager.activeProject?.plotlines ?? []) {
            const trimmed = String(name).trim();
            if (trimmed) names.add(trimmed);
        }
        for (const scene of this.sceneManager.getScenesForDraft()) {
            for (const tag of scene.tags ?? []) {
                const trimmed = String(tag).trim();
                if (trimmed) names.add(trimmed);
            }
        }
        return [...names].sort((a, b) => a.localeCompare(b, undefined, { sensitivity: 'base' }));
    }

    private scenesForPlotlineSeed(plotlineId: string): Scene[] {
        const candidates = this.sceneManager.getScenesForDraft()
            .filter(s => !s.corkboardNote && !s.inactive && (s.tags ?? []).includes(plotlineId));
        return this.sceneManager.sortScenesReadingOrder(candidates);
    }

    findDefinition(plotlineId: string): PlotlineDefinition | undefined {
        return this.plugin.plotlineDefinitions.find(d => d.id === plotlineId);
    }

    /** Create an empty plotline definition (no scenes required). */
    async createPlotline(name: string): Promise<boolean> {
        const normalized = name.trim();
        if (!normalized) return false;
        if (this.findDefinition(normalized)) return false;

        this.plugin.plotlineDefinitions.push({
            id: normalized,
            label: normalized,
            scenePaths: [],
        });
        this.plugin.claimPlotlineRegistry(this.sceneManager.activeProject?.filePath || '');

        const project = this.sceneManager.activeProject;
        if (project) {
            const list = new Set(project.plotlines ?? []);
            list.add(normalized);
            project.plotlines = [...list];
            await this.sceneManager.saveProjectFrontmatter(project);
        }

        await this.plugin.saveProjectSystemData();
        return true;
    }

    async renamePlotline(oldId: string, newId: string): Promise<number> {
        const trimmed = newId.trim();
        if (!trimmed || trimmed === oldId) return 0;
        if (this.findDefinition(trimmed)) return 0;

        const def = this.findDefinition(oldId);
        if (def) {
            def.id = trimmed;
            def.label = trimmed;
        }

        this.migrateTagColorKey(oldId, trimmed);

        const count = await this.sceneManager.renameTag(oldId, trimmed);
        await this.plugin.saveProjectSystemData();
        return count;
    }

    async deletePlotline(plotlineId: string): Promise<number> {
        this.plugin.plotlineDefinitions = this.plugin.plotlineDefinitions
            .filter(d => d.id !== plotlineId);

        const colors = this.plugin.settings.tagColors;
        if (colors?.[plotlineId]) {
            delete colors[plotlineId];
        }

        const count = await this.sceneManager.deleteTag(plotlineId);
        await this.plugin.saveProjectSystemData();
        return count;
    }

    async assignSceneToPlotline(scenePath: string, plotlineId: string): Promise<void> {
        const scene = this.sceneManager.getScene(scenePath);
        if (!scene) return;

        if (!this.findDefinition(plotlineId)) {
            await this.createPlotline(plotlineId);
        }

        const tags = new Set(scene.tags ?? []);
        tags.add(plotlineId);
        await this.sceneManager.updateSceneTags(scenePath, [...tags]);
    }

    async unassignSceneFromPlotline(scenePath: string, plotlineId: string): Promise<void> {
        const scene = this.sceneManager.getScene(scenePath);
        if (!scene) return;

        const tags = (scene.tags ?? []).filter(t => t !== plotlineId);
        await this.sceneManager.updateSceneTags(scenePath, tags);
    }

    async reorderSceneInPlotline(
        plotlineId: string,
        scenePath: string,
        targetIndex: number,
    ): Promise<void> {
        const def = this.findDefinition(plotlineId);
        if (!def) return;

        const norm = normalizePath(scenePath);
        let paths = def.scenePaths.filter(p => normalizePath(p) !== norm);
        const clamped = Math.max(0, Math.min(targetIndex, paths.length));
        paths.splice(clamped, 0, scenePath);
        def.scenePaths = paths;
        await this.plugin.saveProjectSystemData();
    }

    async setPlotlineSceneOrder(plotlineId: string, orderedPaths: string[]): Promise<void> {
        const def = this.findDefinition(plotlineId);
        if (!def) return;
        def.scenePaths = [...orderedPaths];
        await this.plugin.saveProjectSystemData();
    }

    /** Keep scenePaths in sync when scene tags change outside assign/unassign. */
    syncSceneTags(scenePath: string, oldTags: string[], newTags: string[]): Promise<void> {
        const activeFile = this.sceneManager.activeProject?.filePath
            ? normalizePath(this.sceneManager.activeProject.filePath)
            : '';
        const owner = this.plugin.plotlineRegistryOwner
            ? normalizePath(this.plugin.plotlineRegistryOwner)
            : '';
        if (owner && activeFile && owner !== activeFile) return Promise.resolve();

        const oldSet = new Set(oldTags);
        const newSet = new Set(newTags);
        let dirty = false;

        for (const tag of newSet) {
            if (!oldSet.has(tag)) {
                this.ensureDefinition(tag);
                this.appendScenePath(tag, scenePath);
                dirty = true;
            }
        }
        for (const tag of oldSet) {
            if (!newSet.has(tag)) {
                if (this.removeScenePath(tag, scenePath)) dirty = true;
            }
        }

        if (dirty) return this.plugin.saveProjectSystemData();
        return Promise.resolve();
    }

    /** Update scenePaths when a scene file is renamed or deleted. */
    async syncScenePath(oldPath: string, newPath: string | null): Promise<void> {
        const oldN = normalizePath(oldPath);
        let dirty = false;

        for (const def of this.plugin.plotlineDefinitions) {
            if (newPath === null) {
                const next = def.scenePaths.filter(p => normalizePath(p) !== oldN);
                if (next.length !== def.scenePaths.length) {
                    def.scenePaths = next;
                    dirty = true;
                }
            } else {
                let changed = false;
                def.scenePaths = def.scenePaths.map(p => {
                    if (normalizePath(p) !== oldN) return p;
                    changed = true;
                    return newPath;
                });
                if (changed) dirty = true;
            }
        }

        if (dirty) await this.plugin.saveProjectSystemData();
    }

    /** Order scenes by registry scenePaths; append tagged scenes missing from the list. */
    orderScenesForPlotline(plotlineId: string, scenes: Scene[]): Scene[] {
        const def = this.findDefinition(plotlineId);
        if (!def || def.scenePaths.length === 0) {
            return this.sceneManager.sortScenesReadingOrder(scenes);
        }

        const byPath = new Map(scenes.map(s => [normalizePath(s.filePath), s]));
        const ordered: Scene[] = [];
        const used = new Set<string>();

        for (const path of def.scenePaths) {
            const key = normalizePath(path);
            const scene = byPath.get(key);
            if (scene) {
                ordered.push(scene);
                used.add(key);
            }
        }

        const remaining = scenes.filter(s => !used.has(normalizePath(s.filePath)));
        remaining.sort((a, b) => this.sceneManager.compareScenesReadingOrder(a, b));
        return [...ordered, ...remaining];
    }

    getScenesOrderedForPlotline(plotlineId: string): Scene[] {
        const scenes = this.sceneManager.getScenesForDraft()
            .filter(s => (s.tags ?? []).includes(plotlineId));
        return this.orderScenesForPlotline(plotlineId, scenes);
    }

    private ensureDefinition(plotlineId: string): void {
        if (this.findDefinition(plotlineId)) return;
        this.plugin.plotlineDefinitions.push({
            id: plotlineId,
            label: plotlineId,
            scenePaths: [],
        });
    }

    private appendScenePath(plotlineId: string, scenePath: string): void {
        const def = this.findDefinition(plotlineId);
        if (!def) return;
        const norm = normalizePath(scenePath);
        if (def.scenePaths.some(p => normalizePath(p) === norm)) return;
        def.scenePaths.push(scenePath);
    }

    private removeScenePath(plotlineId: string, scenePath: string): boolean {
        const def = this.findDefinition(plotlineId);
        if (!def) return false;
        const norm = normalizePath(scenePath);
        const next = def.scenePaths.filter(p => normalizePath(p) !== norm);
        if (next.length === def.scenePaths.length) return false;
        def.scenePaths = next;
        return true;
    }

    private migrateTagColorKey(oldTag: string, newTag: string): void {
        const colors = this.plugin.settings.tagColors;
        if (!colors?.[oldTag]) return;
        colors[newTag] = colors[oldTag];
        delete colors[oldTag];
    }
}
