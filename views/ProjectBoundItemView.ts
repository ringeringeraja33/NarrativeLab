import { ItemView, normalizePath, type ViewStateResult, type WorkspaceLeaf } from 'obsidian';
import type { SceneManager } from '../services/SceneManager';
import {
    NARRATIVE_LAB_PROJECT_FILE_STATE_KEY,
    narrativeLabLeafState,
} from '../utils/narrativeLabLeafState';

/** Project-scoped view state shared by all main NarrativeLab surfaces. */
export abstract class ProjectBoundItemView extends ItemView {
    private boundProjectFile: string | null = null;

    constructor(leaf: WorkspaceLeaf) {
        super(leaf);
    }

    getBoundProjectFile(): string | null {
        return this.boundProjectFile;
    }

    getState(): Record<string, unknown> {
        return narrativeLabLeafState(this.boundProjectFile);
    }

    async setState(state: Record<string, unknown>, result: ViewStateResult): Promise<void> {
        await super.setState(state, result);
        const raw = state?.[NARRATIVE_LAB_PROJECT_FILE_STATE_KEY];
        this.boundProjectFile = typeof raw === 'string' && raw.trim()
            ? normalizePath(raw)
            : null;
    }

    /** Adopt the active project only for legacy leaves that have no saved binding. */
    protected captureProjectBinding(sceneManager: SceneManager): void {
        if (this.boundProjectFile) return;
        const active = sceneManager.activeProject?.filePath;
        if (active) this.boundProjectFile = normalizePath(active);
    }

    protected getBoundProjectTitle(sceneManager: SceneManager): string | null {
        if (!this.boundProjectFile) return sceneManager.activeProject?.title ?? null;
        const project = sceneManager.getProjects()
            .find(item => normalizePath(item.filePath) === this.boundProjectFile);
        if (project?.title) return project.title;
        return this.boundProjectFile.split('/').pop()?.replace(/\.md$/i, '') || null;
    }
}
