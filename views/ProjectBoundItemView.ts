import {
    ItemView,
    normalizePath,
    type ViewStateResult,
    type WorkspaceLeaf,
} from 'obsidian';
import {
    NARRATIVE_LAB_PROJECT_FILE_STATE_KEY,
    narrativeLabLeafState,
} from '../utils/narrativeLabLeafState';
import type { SceneManager } from '../services/SceneManager';

type ProjectIdentity = {
    filePath: string;
    title?: string;
};

/**
 * ItemView base that keeps a NarrativeLab tab bound to the project it opened.
 * Background tabs can then ignore refreshes for a different active project.
 */
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
        if (typeof raw === 'string' && raw.trim()) {
            this.boundProjectFile = normalizePath(raw);
        }
    }

    /** Bind legacy/unscoped leaves once, without overwriting restored state. */
    protected ensureProjectBinding(projectFile?: string | null): void {
        if (this.boundProjectFile || !projectFile?.trim()) return;
        this.boundProjectFile = normalizePath(projectFile);
    }

    /** Bind a leaf after project discovery when no project was available at construction time. */
    protected captureProjectBinding(sceneManager: SceneManager): void {
        this.ensureProjectBinding(sceneManager.activeProject?.filePath);
    }

    /** True when this tab should render from the live scene/entity indexes. */
    protected isBoundToActiveProject(sceneManager: SceneManager): boolean {
        const bound = this.getBoundProjectFile();
        const active = sceneManager.activeProject?.filePath;
        if (!bound || !active) return true;
        return normalizePath(bound) === normalizePath(active);
    }

    /** Resolve a stable title without reading another tab's active project. */
    protected resolveProjectTitle(
        projects: Iterable<ProjectIdentity>,
        activeProject?: ProjectIdentity | null,
    ): string | null {
        if (this.boundProjectFile) {
            const bound = normalizePath(this.boundProjectFile);
            for (const project of projects) {
                if (normalizePath(project.filePath) === bound) {
                    return project.title?.trim() || this.titleFromProjectFile(bound);
                }
            }
            return this.titleFromProjectFile(bound);
        }
        return activeProject?.title?.trim() || null;
    }

    private titleFromProjectFile(filePath: string): string {
        const name = normalizePath(filePath).split('/').pop() || filePath;
        return name.replace(/\.md$/i, '') || name;
    }
}
