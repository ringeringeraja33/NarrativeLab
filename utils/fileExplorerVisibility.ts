/**
 * Extensions Obsidian can normally open without another plugin. The runtime
 * view registry remains authoritative; this list is only used when that
 * private registry is unavailable on a particular Obsidian build.
 */
export const OBSIDIAN_OPENABLE_EXTENSION_FALLBACK = new Set([
    'md',
    'canvas',
    'base',
    'pdf',
    'png',
    'jpg',
    'jpeg',
    'gif',
    'bmp',
    'svg',
    'webp',
    'avif',
    'mp3',
    'wav',
    'm4a',
    'ogg',
    'flac',
    'aac',
    'mp4',
    'webm',
    'mov',
    'mkv',
    'avi',
    'ncanvas',
    'narrativecanvas',
]);

export interface FileExplorerVisibilityRules {
    systemFolder: boolean;
    libraryFolder: boolean;
    canvasFolder: boolean;
    seriesMetadata: boolean;
    unsupportedFiles: boolean;
}

export const DEFAULT_FILE_EXPLORER_VISIBILITY_RULES: FileExplorerVisibilityRules = {
    systemFolder: true,
    libraryFolder: true,
    canvasFolder: true,
    seriesMetadata: true,
    unsupportedFiles: true,
};

function pathBasename(path: string): string {
    const normalized = path.replace(/\\/g, '/').replace(/\/+$/, '');
    return normalized.slice(normalized.lastIndexOf('/') + 1).toLowerCase();
}

export function fileExtension(path: string): string {
    const basename = pathBasename(path);
    const dot = basename.lastIndexOf('.');
    return dot > 0 && dot < basename.length - 1 ? basename.slice(dot + 1) : '';
}

export function shouldHideFileExplorerFolder(
    path: string,
    rules: FileExplorerVisibilityRules = DEFAULT_FILE_EXPLORER_VISIBILITY_RULES,
): boolean {
    const basename = pathBasename(path);
    return (basename === 'system' && rules.systemFolder)
        || (basename === 'library' && rules.libraryFolder)
        || (basename === 'canvas' && rules.canvasFolder);
}

export function shouldHideFileExplorerFile(
    path: string,
    canOpenExtension: (extension: string) => boolean = extension =>
        OBSIDIAN_OPENABLE_EXTENSION_FALLBACK.has(extension),
    rules: FileExplorerVisibilityRules = DEFAULT_FILE_EXPLORER_VISIBILITY_RULES,
): boolean {
    if (pathBasename(path) === 'series.json') return rules.seriesMetadata;
    const extension = fileExtension(path);
    return rules.unsupportedFiles && (!extension || !canOpenExtension(extension));
}
