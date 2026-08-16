/**
 * Pure helpers for workspace floating sticky notes.
 *
 * Layout and persistence follow the MIT-licensed Web Novel Assistant
 * (https://github.com/HatanoChihiro/obsidian-webnovel-assistant): notes live on
 * `document.body`, keep their own JSON file, and are not stored in data.json.
 */

export const FLOATING_NOTES_FILENAME = 'floating-notes.json';
export const FLOATING_NOTES_HIDDEN_CLASS = 'narrativelab-floating-notes-hidden';
export const FLOATING_NOTE_CLASS = 'nl-floating-sticky-note';

export interface FloatingStickyNoteState {
    id: string;
    /** Owning project `.md` path. Missing on legacy vault-wide notes. */
    projectFile?: string;
    filePath?: string;
    content?: string;
    title?: string;
    top: string;
    left: string;
    width: string;
    height: string;
    color: string;
    textColor?: string;
    isEditing: boolean;
    isPinned?: boolean;
    zoomLevel?: number;
}

export function isFloatingStickyNoteState(value: unknown): value is FloatingStickyNoteState {
    if (!value || typeof value !== 'object') return false;
    const note = value as Record<string, unknown>;
    return typeof note.id === 'string' && note.id.length > 0
        && typeof note.top === 'string'
        && typeof note.left === 'string'
        && typeof note.width === 'string'
        && typeof note.height === 'string'
        && typeof note.color === 'string';
}

export function parseFloatingStickyNotes(raw: unknown): FloatingStickyNoteState[] {
    if (!Array.isArray(raw)) return [];
    return raw.filter(isFloatingStickyNoteState).map(note => ({
        ...note,
        content: typeof note.content === 'string' ? note.content : '',
        title: typeof note.title === 'string' ? note.title : '',
        isEditing: note.isEditing === true,
        isPinned: note.isPinned === true,
        zoomLevel: clampStickyNoteZoom(typeof note.zoomLevel === 'number' ? note.zoomLevel : 1),
        textColor: typeof note.textColor === 'string' && note.textColor ? note.textColor : '#111111',
        projectFile: typeof note.projectFile === 'string' && note.projectFile.trim()
            ? note.projectFile
            : undefined,
    }));
}

/** Legacy notes without `projectFile` stay vault-wide. */
export function stickyNoteBelongsToProject(
    note: FloatingStickyNoteState,
    projectFile: string | null | undefined,
): boolean {
    if (!note.projectFile) return true;
    if (!projectFile) return true;
    return note.projectFile.replace(/\\/g, '/') === projectFile.replace(/\\/g, '/');
}

export function clampStickyNoteZoom(zoom: number): number {
    if (!Number.isFinite(zoom)) return 1;
    return Math.max(0.5, Math.min(4, zoom));
}

export function clampStickyNoteOpacity(opacity: number): number {
    if (!Number.isFinite(opacity)) return 0.92;
    return Math.max(0.4, Math.min(1, opacity));
}

export function hexToRgba(hex: string, alpha: number): string {
    if (!hex) return `rgba(255, 248, 204, ${alpha})`;
    let h = hex.replace('#', '').trim();
    if (h.length === 3) h = h.split('').map(ch => ch + ch).join('');
    if (h.length !== 6) return `rgba(255, 248, 204, ${alpha})`;
    const r = Number.parseInt(h.slice(0, 2), 16);
    const g = Number.parseInt(h.slice(2, 4), 16);
    const b = Number.parseInt(h.slice(4, 6), 16);
    if ([r, g, b].some(channel => Number.isNaN(channel))) {
        return `rgba(255, 248, 204, ${alpha})`;
    }
    return `rgba(${r}, ${g}, ${b}, ${alpha})`;
}

export function staggerStickyNoteOrigin(index: number): { top: string; left: string } {
    const offset = (Math.max(0, index) % 8) * 28;
    return { top: `${140 + offset}px`, left: `${140 + offset}px` };
}

export function nextStickyNoteColor(
    palette: Array<{ color: string }>,
    index: number,
): { color: string; nextIndex: number } {
    const colors = palette.length > 0 ? palette : [{ color: '#FFF8CC' }];
    const i = ((index % colors.length) + colors.length) % colors.length;
    return { color: colors[i].color, nextIndex: (i + 1) % colors.length };
}

export function joinVaultMarkdownPath(folder: string, fileName: string): string {
    const trimmedName = fileName.trim().replace(/\\/g, '/').split('/').pop() || fileName.trim();
    const withExt = trimmedName.toLowerCase().endsWith('.md') ? trimmedName : `${trimmedName}.md`;
    const dir = folder.replace(/\\/g, '/').replace(/^\/+|\/+$/g, '');
    return dir ? `${dir}/${withExt}` : withExt;
}

export function shouldPromptStickyNoteClose(opts: {
    filePath?: string;
    content: string;
    lastSavedContent: string;
}): boolean {
    const hasContent = opts.content.trim().length > 0;
    const dirty = opts.content !== opts.lastSavedContent;
    return (!opts.filePath && hasContent) || (!!opts.filePath && dirty);
}
