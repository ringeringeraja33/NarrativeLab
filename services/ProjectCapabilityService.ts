import type { StoryLineProject } from '../models/StoryLineProject';
import {
    capabilitiesForPreset,
    moduleEnabled,
    normalizeProjectCapabilities,
    type ProjectCapabilities,
    type ProjectModuleId,
    type ProjectPresetId,
} from '../models/ProjectCapabilities';
import type { SceneManager } from './SceneManager';

export class ProjectCapabilityService {
    constructor(private sceneManager: SceneManager) {}

    get(project?: StoryLineProject | null): ProjectCapabilities {
        return normalizeProjectCapabilities(project?.capabilities);
    }

    isEnabled(module: ProjectModuleId, project?: StoryLineProject | null): boolean {
        return moduleEnabled(this.get(project ?? this.sceneManager.activeProject), module);
    }

    async apply(project: StoryLineProject, capabilities: ProjectCapabilities): Promise<void> {
        const previous = project.capabilities;
        const next = normalizeProjectCapabilities(capabilities);
        await this.sceneManager.ensureProjectModuleStorage(project, next);
        project.capabilities = next;
        try {
            await this.sceneManager.saveProjectFrontmatter(project);
        } catch (error) {
            project.capabilities = previous;
            throw error;
        }
    }

    async applyNavigation(
        project: StoryLineProject,
        navigation: NonNullable<ProjectCapabilities['navigation']>,
    ): Promise<void> {
        const previous = project.capabilities;
        const next = normalizeProjectCapabilities({ ...this.get(project), navigation });
        project.capabilities = next;
        try {
            await this.sceneManager.saveProjectFrontmatter(project);
        } catch (error) {
            project.capabilities = previous;
            throw error;
        }
    }

    async applyPreset(project: StoryLineProject, preset: ProjectPresetId): Promise<void> {
        await this.apply(project, capabilitiesForPreset(preset));
    }
}
