
import { FilterPreset } from './Scene';

/**
 * Represents a NarrativeLab project manifest.
 *
 * A project may live anywhere in the vault. The manifest normally sits inside
 * its own project folder and owns a subfolder tree:
 *
 *   Writing/My Novel/Scenes/          (writer-facing)
 *   Writing/My Novel/Library/…        (writer-facing)
 *   Writing/My Novel/Notes/…          (writer-facing)
 *   Writing/My Novel/Canvas/          (authored .ncanvas boards)
 *   Writing/My Novel/Bases/           (Obsidian Base view files for Library)
 *   Writing/My Novel/System/          (plugin data: plotgrid, board.json, …)
 *
 * Legacy projects may have Characters/ and Locations/ at the project root;
 * the runtime detects this and uses the old paths transparently.
 */
/**
 * A manuscript draft within a project.
 *
 * Isolation is folder-based under `Scenes/`:
 * - Primary draft (no `folder`): scenes living in the Scenes root / Act folders
 *   that are NOT inside another draft’s subfolder.
 * - Other drafts: each owns `Scenes/<folder>/…` as an independent copy tree.
 *
 * `scenePaths` is an optional reading-order hint; membership is by folder.
 */
export interface ProjectDraft {
    id: string;
    title: string;
    /**
     * Subfolder name under the project Scenes/ folder (e.g. "草稿 2").
     * Omitted/empty = primary draft (Scenes root). Display name tracks this folder.
     */
    folder?: string;
    /** Optional ordered list of scene file paths (reading order within the draft) */
    scenePaths?: string[];
}

export interface StoryLineProject {
    /** Vault-relative path of the project .md file */
    filePath: string;
    /** Human-readable title (from frontmatter or filename) */
    title: string;
    /** ISO date string when the project was created */
    created: string;
    /** Description / notes (body of the .md file) */
    description: string;
    /**
     * Optional BCP-47 language tag for this project (`'en'`, `'sv'`, `'zh'`, `'ja'`, …).
     * Drives word counting, reading time, dialogue %, stop-word filtering, and PDF
     * line wrapping. `'auto'` enables script auto-detection from manuscript text.
     */
    locale?: string;
    /** Derived scene folder path */
    sceneFolder: string;
    /** Derived character folder path */
    characterFolder: string;
    /** Derived location folder path */
    locationFolder: string;
    /** Derived Library folder path (all narrative database entries live here) */
    codexFolder: string;
    /** Derived notes folder path (corkboard sticky notes live here) */
    notesFolder: string;
    /** Derived scene notes folder path (external per-scene notes files) */
    sceneNotesFolder: string;
    /** Derived archive folder path (archived / cut scenes) */
    archiveFolder: string;
    /** Derived research folder path (research posts) */
    researchFolder: string;

    // ── Project-specific structure ──────────────────────
    /** Defined act numbers (persisted in project frontmatter) */
    definedActs: number[];
    /** Defined chapter numbers (persisted in project frontmatter) */
    definedChapters: number[];
    /** Human-readable labels for acts / beats (act number → label, e.g. 1 → "Opening Image") */
    actLabels: Record<number, string>;
    /** Human-readable labels for chapters (chapter number → label, e.g. 1 → "Opening Image") */
    chapterLabels: Record<number, string>;
    /** Optional descriptions for acts (act number → description text) */
    actDescriptions: Record<number, string>;
    /** Optional descriptions for chapters (chapter number → description text) */
    chapterDescriptions: Record<number, string>;
    /** Saved filter presets (persisted in project frontmatter) */
    filterPresets: FilterPreset[];
    /** Explicit plotline names, including plotlines that do not have scenes yet */
    plotlines?: string[];
    /** Corkboard free-position layout (scene file path -> coordinates, layer order, and optional size) */
    corkboardPositions: Record<string, { x: number; y: number; z?: number; w?: number; h?: number }>;

    // ── Series ──────────────────────────────────────
    /** Optional series ID — links this project to a series (matches series.json name) */
    seriesId?: string;
    /** Vault-relative path to a cover image for the project */
    coverImage?: string;
    /** Name of the last applied beat sheet template */
    activeBeatSheet?: string;

    // ── Drafts (Longform-style alternate manuscripts) ──
    /** Named drafts for this project; always at least one primary draft at runtime */
    drafts?: ProjectDraft[];
    /** Id of the draft currently used for Navigator / Manuscript order */
    activeDraftId?: string;

    /**
     * Library tab id → folder basename under Library/ (and tab label).
     * Stable ids: characters, locations, items, creatures, custom-…;
     * renaming a tab only changes the value here + the folder on disk.
     */
    libraryFolders?: Record<string, string>;
}

// ── Series metadata ────────────────────────────────

/**
 * Represents a series — a group of book projects sharing a common codex.
 * Persisted as `series.json` in the series parent folder.
 */
export interface SeriesMetadata {
    /** Display name of the series */
    name: string;
    /** Ordered list of book folder names within the series folder */
    bookOrder: string[];
    /** ISO date string when the series was created */
    created: string;
}

/**
 * Subfolder inside each project that stores .ncanvas files.
 * Authored project content — lives at the project root (not under System/).
 */
export const DEFAULT_CANVAS_FOLDER = 'Canvas';
/** Former root folder name — migrated into Canvas/. */
export const LEGACY_NCANVAS_FOLDER = 'NCanvas';
/** Former internal location — migrated to the project-root Canvas/ folder. */
export const LEGACY_SYSTEM_NCANVAS_FOLDER = 'System/NCanvas';
/**
 * @deprecated Alias of {@link LEGACY_NCANVAS_FOLDER}. Older code used
 * `LEGACY_CANVAS_FOLDER = 'Canvas'` when the canonical folder was `NCanvas`.
 */
export const LEGACY_CANVAS_FOLDER = LEGACY_NCANVAS_FOLDER;
/**
 * Legacy multi-file Library Bases folder (`Bases/library-*.base`).
 * Live Library Base is a single file: `Library/library.base`.
 */
export const DEFAULT_BASES_FOLDER = 'Bases';
/** Former nested Bases location — still scanned during migration. */
export const LEGACY_SYSTEM_BASES_FOLDER = 'System/Bases';
/** Former single-file location under System/ — migrated to Library/library.base. */
export const LEGACY_SYSTEM_LIBRARY_BASE = `System/library.base`;
/** Canonical single Library Base filename under Library/. */
export const LIBRARY_BASE_FILENAME = 'library.base';
/** Format marker written into Library/library.base. */
export const LIBRARY_BASE_FORMAT = 3;
/** Default attachment folder name inside each project root */
export const DEFAULT_ATTACHMENT_FOLDER = 'Attachments';

/** Only these Library categories are created for a brand-new project. */
export const DEFAULT_PROJECT_LIBRARY_FOLDERS: Readonly<Record<'characters' | 'locations', string>> = Object.freeze({
    characters: 'Characters',
    locations: 'Locations',
});
/** Internal catch-all stays available but is hidden in a new project's tab bar. */
export const DEFAULT_PROJECT_LIBRARY_HIDDEN_CATEGORIES: readonly string[] = Object.freeze(['uncategorized']);

/**
 * Build derived folder paths from a root folder and project title.
 */
export function deriveProjectFolders(
    rootFolder: string,
    title: string
): {
    baseFolder: string;
    sceneFolder: string;
    characterFolder: string;
    locationFolder: string;
    codexFolder: string;
    notesFolder: string;
    sceneNotesFolder: string;
    archiveFolder: string;
    researchFolder: string;
    canvasFolder: string;
    basesFolder: string;
    attachmentFolder: string;
} {
    const base = [rootFolder.replace(/\\/g, '/').replace(/^\/+|\/+$/g, ''), title]
        .filter(Boolean)
        .join('/');
    return {
        baseFolder: base,
        sceneFolder: `${base}/Scenes`,
        characterFolder: `${base}/Library/Characters`,
        locationFolder: `${base}/Library/Locations`,
        codexFolder: `${base}/Library`,
        notesFolder: `${base}/Notes`,
        sceneNotesFolder: `${base}/SceneNotes`,
        archiveFolder: `${base}/Archive`,
        researchFolder: `${base}/Research`,
        canvasFolder: `${base}/${DEFAULT_CANVAS_FOLDER}`,
        basesFolder: `${base}/${DEFAULT_BASES_FOLDER}`,
        attachmentFolder: `${base}/${DEFAULT_ATTACHMENT_FOLDER}`,
    };
}

/**
 * Derive project folder paths from the project .md file's actual location.
 * Works for projects anywhere in the vault — not tied to storyLineRoot.
 *
 * Layout detection:
 *  - New layout:  `Any/Path/MyNovel/MyNovel.md`  → base = `Any/Path/MyNovel`
 *  - Legacy:      `Any/Path/MyNovel.md`           → base = `Any/Path/MyNovel`
 */
export function deriveProjectFoldersFromFilePath(
    filePath: string
): {
    baseFolder: string;
    sceneFolder: string;
    characterFolder: string;
    locationFolder: string;
    codexFolder: string;
    notesFolder: string;
    sceneNotesFolder: string;
    archiveFolder: string;
    researchFolder: string;
    canvasFolder: string;
    basesFolder: string;
    attachmentFolder: string;
} {
    const lastSlash = filePath.lastIndexOf('/');
    const parentDir = lastSlash >= 0 ? filePath.substring(0, lastSlash) : '';
    const basename = (filePath.split('/').pop() ?? '').replace(/\.md$/i, '');
    const parentName = parentDir.split('/').pop() ?? '';

    // If the file sits inside a folder with the same name → new layout
    const baseFolder = (parentName === basename)
        ? parentDir
        : [parentDir, basename].filter(Boolean).join('/');
    return {
        baseFolder,
        sceneFolder: `${baseFolder}/Scenes`,
        characterFolder: `${baseFolder}/Library/Characters`,
        locationFolder: `${baseFolder}/Library/Locations`,
        codexFolder: `${baseFolder}/Library`,
        notesFolder: `${baseFolder}/Notes`,
        sceneNotesFolder: `${baseFolder}/SceneNotes`,
        archiveFolder: `${baseFolder}/Archive`,
        researchFolder: `${baseFolder}/Research`,
        canvasFolder: `${baseFolder}/${DEFAULT_CANVAS_FOLDER}`,
        basesFolder: `${baseFolder}/${DEFAULT_BASES_FOLDER}`,
        attachmentFolder: `${baseFolder}/${DEFAULT_ATTACHMENT_FOLDER}`,
    };
}
