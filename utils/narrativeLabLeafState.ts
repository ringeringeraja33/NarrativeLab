import { normalizePath, type WorkspaceLeaf } from 'obsidian';

/** Persisted on NarrativeLab leaf view state so multiple projects can stay open. */
export const NARRATIVE_LAB_PROJECT_FILE_STATE_KEY = 'narrativeLabProjectFile';

export function getLeafNarrativeLabProjectFile(leaf: WorkspaceLeaf): string | null {
    const state = leaf.getViewState()?.state as Record<string, unknown> | undefined;
    const raw = state?.[NARRATIVE_LAB_PROJECT_FILE_STATE_KEY];
    return typeof raw === 'string' && raw.trim() ? normalizePath(raw) : null;
}

/** Build a leaf state object that keeps the bound project (and optional extras). */
export function narrativeLabLeafState(
    projectFile?: string | null,
    extra: Record<string, unknown> = {},
): Record<string, unknown> {
    const state: Record<string, unknown> = { ...extra };
    if (projectFile && projectFile.trim()) {
        state[NARRATIVE_LAB_PROJECT_FILE_STATE_KEY] = normalizePath(projectFile);
    }
    return state;
}

/** Preserve only the project binding when switching NarrativeLab view types in-place. */
export function preservedNarrativeLabLeafState(leaf: WorkspaceLeaf): Record<string, unknown> {
    return narrativeLabLeafState(getLeafNarrativeLabProjectFile(leaf));
}
