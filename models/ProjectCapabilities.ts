export const PROJECT_CAPABILITIES_VERSION = 1;

export const PROJECT_MODULE_IDS = [
    'manuscript', 'notes', 'outline', 'writingTracker', 'writingStats',
    'research', 'library', 'table', 'canvas', 'citations', 'scenes',
    'board', 'structure', 'plotlines', 'timeline', 'characters',
    'locations', 'sceneDetails', 'sceneNotes', 'synopsis', 'series',
] as const;

export type ProjectModuleId = typeof PROJECT_MODULE_IDS[number];
export type ProjectPresetId = 'plain-writing' | 'essay' | 'research-paper'
    | 'literature-review' | 'novel' | 'full-narrative' | 'custom' | 'legacy-full';
export type WordCountProfileId = 'general' | 'academic' | 'narrative' | 'custom';

export interface ProjectCapabilities {
    version: number;
    preset: ProjectPresetId;
    modules: ProjectModuleId[];
    wordCountProfile: WordCountProfileId;
}

export const PROJECT_MODULE_DEPENDENCIES: Readonly<Partial<Record<ProjectModuleId, readonly ProjectModuleId[]>>> = {
    writingTracker: [], writingStats: [], research: ['notes'], board: ['scenes'],
    structure: ['scenes'], plotlines: ['scenes'], timeline: ['scenes'],
    characters: ['library'], locations: ['library'], sceneDetails: ['scenes'],
    sceneNotes: ['scenes'], synopsis: ['scenes'], series: ['library'],
};

const WRITING = ['manuscript', 'writingTracker', 'writingStats'] as const;
const RESEARCH = ['manuscript', 'notes', 'outline', 'writingTracker', 'writingStats',
    'research', 'library', 'table', 'canvas', 'citations'] as const;
const NARRATIVE = ['manuscript', 'notes', 'outline', 'writingTracker', 'writingStats',
    'research', 'library', 'table', 'canvas', 'scenes', 'board', 'structure',
    'plotlines', 'timeline', 'characters', 'locations', 'sceneDetails',
    'sceneNotes', 'synopsis'] as const;

export const PROJECT_PRESETS: Readonly<Record<ProjectPresetId, readonly ProjectModuleId[]>> = {
    'plain-writing': WRITING,
    essay: ['manuscript', 'notes', 'writingTracker', 'writingStats'],
    'research-paper': RESEARCH,
    'literature-review': ['manuscript', 'notes', 'outline', 'writingTracker',
        'writingStats', 'research', 'library', 'table', 'canvas', 'citations'],
    novel: NARRATIVE,
    'full-narrative': [...NARRATIVE, 'series'],
    custom: WRITING,
    'legacy-full': PROJECT_MODULE_IDS,
};

export function isProjectModuleId(value: unknown): value is ProjectModuleId {
    return typeof value === 'string' && (PROJECT_MODULE_IDS as readonly string[]).includes(value);
}

export function normalizeProjectCapabilities(value: unknown): ProjectCapabilities {
    if (!value || typeof value !== 'object') {
        return capabilitiesForPreset('legacy-full');
    }
    const raw = value as Record<string, unknown>;
    const preset = typeof raw.preset === 'string' && raw.preset in PROJECT_PRESETS
        ? raw.preset as ProjectPresetId : 'custom';
    const modules = Array.isArray(raw.modules)
        ? raw.modules.filter(isProjectModuleId) : [...PROJECT_PRESETS[preset]];
    const profile = raw.wordCountProfile;
    const wordCountProfile: WordCountProfileId = profile === 'academic'
        || profile === 'narrative' || profile === 'custom' ? profile : 'general';
    return {
        version: PROJECT_CAPABILITIES_VERSION,
        preset,
        modules: resolveModuleDependencies(modules),
        wordCountProfile,
    };
}

export function capabilitiesForPreset(preset: ProjectPresetId): ProjectCapabilities {
    return {
        version: PROJECT_CAPABILITIES_VERSION,
        preset,
        modules: [...PROJECT_PRESETS[preset]],
        wordCountProfile: preset === 'research-paper' || preset === 'literature-review'
            ? 'academic' : preset === 'novel' || preset === 'full-narrative' || preset === 'legacy-full'
                ? 'narrative' : 'general',
    };
}

export function resolveModuleDependencies(modules: Iterable<ProjectModuleId>): ProjectModuleId[] {
    const enabled = new Set(modules);
    let changed = true;
    while (changed) {
        changed = false;
        for (const module of [...enabled]) {
            for (const dependency of PROJECT_MODULE_DEPENDENCIES[module] ?? []) {
                if (!enabled.has(dependency)) { enabled.add(dependency); changed = true; }
            }
        }
    }
    return PROJECT_MODULE_IDS.filter(module => enabled.has(module));
}

export function moduleEnabled(capabilities: ProjectCapabilities | undefined, module: ProjectModuleId): boolean {
    return normalizeProjectCapabilities(capabilities).modules.includes(module);
}
