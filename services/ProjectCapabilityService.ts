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
        project.capabilities = normalizeProjectCapabilities(capabilities);
        await this.sceneManager.ensureProjectModuleStorage(project, project.capabilities);
        await this.sceneManager.saveProjectFrontmatter(project);
    }

    async applyPreset(project: StoryLineProject, preset: ProjectPresetId): Promise<void> {
        await this.apply(project, capabilitiesForPreset(preset));
    }
}
