/* eslint-disable @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-argument, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-return, @typescript-eslint/no-floating-promises, @typescript-eslint/no-misused-promises, @typescript-eslint/no-unnecessary-type-assertion, @typescript-eslint/no-redundant-type-constituents, @typescript-eslint/no-unused-vars, no-unused-vars, no-useless-escape, no-control-regex, no-empty -- Obsidian's API surface and several untyped third-party libraries force dynamic dispatch; floating promises are intentional in DOM/event handlers; matching enable at end of file */
import { FilterPreset } from './Scene';

/**
 * Represents a NarrativeLab project manifest.
 *
 * A project may live anywhere in the vault. The manifest normally sits inside
 * its own project folder and owns a subfolder tree:
 *
 *   Writing/My Novel/Scenes/
 *   Writing/My Novel/Library/
 *   Writing/My Novel/Library/Characters/
 *   Writing/My Novel/Library/Locations/
 *
 * Legacy projects may have Characters/ and Locations/ at the project root;
 * the runtime detects this and uses the old paths transparently.
 */
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
    /** Corkboard free-position layout (scene file path -> coordinates + layer order + optional height) */
    corkboardPositions: Record<string, { x: number; y: number; z?: number; h?: number }>;

    // ── Series ──────────────────────────────────────
    /** Optional series ID — links this project to a series (matches series.json name) */
    seriesId?: string;
    /** Vault-relative path to a cover image for the project */
    coverImage?: string;
    /** Name of the last applied beat sheet template */
    activeBeatSheet?: string;
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
 * Build derived folder paths from a root folder and project title.
 */
export function deriveProjectFolders(
    rootFolder: string,
    title: string
): { sceneFolder: string; characterFolder: string; locationFolder: string; codexFolder: string; notesFolder: string; sceneNotesFolder: string; archiveFolder: string; researchFolder: string } {
    const base = [rootFolder.replace(/\\/g, '/').replace(/^\/+|\/+$/g, ''), title]
        .filter(Boolean)
        .join('/');
    return {
        sceneFolder: `${base}/Scenes`,
        characterFolder: `${base}/Library/Characters`,
        locationFolder: `${base}/Library/Locations`,
        codexFolder: `${base}/Library`,
        notesFolder: `${base}/Notes`,
        sceneNotesFolder: `${base}/SceneNotes`,
        archiveFolder: `${base}/Archive`,
        researchFolder: `${base}/Research`,
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
/** Subfolder inside each project that stores .ncanvas files */
export const DEFAULT_CANVAS_FOLDER = 'Canvas';
/** Default attachment folder name inside each project root */
export const DEFAULT_ATTACHMENT_FOLDER = 'Attachments';

export function deriveProjectFoldersFromFilePath(
    filePath: string
): { baseFolder: string; sceneFolder: string; characterFolder: string; locationFolder: string; codexFolder: string; notesFolder: string; sceneNotesFolder: string; archiveFolder: string; researchFolder: string; canvasFolder: string; attachmentFolder: string } {
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
        attachmentFolder: `${baseFolder}/${DEFAULT_ATTACHMENT_FOLDER}`,
    };
}
/* eslint-enable @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-argument, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-return, @typescript-eslint/no-floating-promises, @typescript-eslint/no-misused-promises, @typescript-eslint/no-unnecessary-type-assertion, @typescript-eslint/no-redundant-type-constituents, @typescript-eslint/no-unused-vars, no-unused-vars, no-useless-escape, no-control-regex, no-empty -- end of file-wide suppression block opened at line 1 */
