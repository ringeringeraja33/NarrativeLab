/**
 * Shared “entity board” helper: Library note ↔ Project/Canvas/<Name>.canvas
 * Used by CharacterView and Narrative Canvas (createCodexCanvas host override).
 */
import { App, TFile, normalizePath } from 'obsidian';
import {
    DEFAULT_CANVAS_FOLDER,
    LEGACY_NCANVAS_FOLDER,
} from '../models/StoryLineProject';

export type LibraryEntityBoardImage =
    | string
    | { path?: string; w?: number; x?: number; y?: number };

export type LibraryEntityBoardFile = string | { path?: string };

export interface CreateLibraryEntityBoardEntry {
    name?: string;
    /** Markdown note path (Narrative Canvas calls this codexFile). */
    notePath?: string;
    codexFile?: string;
    images?: LibraryEntityBoardImage[];
    files?: LibraryEntityBoardFile[];
}

function normalizeVaultPath(value: unknown): string {
    const normalized = String(value || '')
        .trim()
        .replace(/\\/g, '/')
        .replace(/^\/+/, '')
        .replace(/\/{2,}/g, '/')
        .split('/')
        .filter((part) => part && part !== '.' && part !== '..')
        .join('/');
    return normalized ? normalizePath(normalized) : '';
}

function sanitizeFileName(value: string): string {
    return String(value || '')
        .replace(/[\\/\n\r\t:*?"<>|]/g, '-')
        .replace(/\s+/g, ' ')
        .trim()
        .slice(0, 180);
}

function parentPath(path: string): string {
    const normalized = normalizeVaultPath(path);
    const slash = normalized.lastIndexOf('/');
    return slash >= 0 ? normalized.slice(0, slash) : '';
}

function joinVaultPath(folder: string, fileName: string): string {
    const base = normalizeVaultPath(folder);
    return base ? normalizePath(`${base}/${fileName}`) : normalizePath(fileName);
}

/** Walk up from a Library/... note to the project root. */
export function getProjectRootFromLibraryNote(notePath: string): string {
    let current = parentPath(notePath);
    while (current) {
        const leaf = current.split('/').pop() || '';
        if (leaf === 'Library' || leaf === 'Codex') {
            return parentPath(current);
        }
        current = parentPath(current);
    }
    return '';
}

async function ensureVaultFolder(app: App, folder: string): Promise<void> {
    const normalized = normalizeVaultPath(folder);
    if (!normalized) return;
    const parts = normalized.split('/').filter(Boolean);
    let cursor = '';
    for (const part of parts) {
        cursor = cursor ? `${cursor}/${part}` : part;
        if (!app.vault.getAbstractFileByPath(cursor)) {
            await app.vault.createFolder(cursor);
        }
    }
}

async function uniquePath(app: App, path: string): Promise<string> {
    const desired = normalizeVaultPath(path);
    if (!app.vault.getAbstractFileByPath(desired)) return desired;
    const extMatch = desired.match(/(\.[^./]+)$/);
    const suffix = extMatch ? extMatch[1] : '';
    const base = suffix ? desired.slice(0, -suffix.length) : desired;
    let index = 2;
    let candidate = `${base}-${index}${suffix}`;
    while (app.vault.getAbstractFileByPath(candidate)) {
        index += 1;
        candidate = `${base}-${index}${suffix}`;
    }
    return candidate;
}

function readCanvasFrontmatter(app: App, notePath: string): string {
    const file = app.vault.getAbstractFileByPath(normalizeVaultPath(notePath));
    if (!(file instanceof TFile)) return '';
    const cache = app.metadataCache.getFileCache(file);
    const raw = cache?.frontmatter?.canvas;
    if (typeof raw === 'string' && raw.trim()) return normalizeVaultPath(raw);
    return '';
}

export class LibraryEntityBoardService {
    constructor(private readonly app: App) {}

    /** Always Project/Canvas/ for new boards (never legacy NCanvas/). */
    resolveProjectCanvasFolder(notePath: string, fallbackProjectRoot = ''): string {
        const root = getProjectRootFromLibraryNote(notePath) || normalizeVaultPath(fallbackProjectRoot);
        if (!root) return '';
        return joinVaultPath(root, DEFAULT_CANVAS_FOLDER);
    }

    /**
     * Resolve an already-linked board: frontmatter → Canvas/Name.canvas → NCanvas/Name.canvas.
     */
    findLinkedBoard(notePath: string, displayName?: string): string | null {
        const note = normalizeVaultPath(notePath);
        if (!note) return null;

        const fromFm = readCanvasFrontmatter(this.app, note);
        if (fromFm && this.app.vault.getAbstractFileByPath(fromFm) instanceof TFile) {
            return fromFm;
        }

        const root = getProjectRootFromLibraryNote(note);
        if (!root) return fromFm || null;

        const basename = (displayName && displayName.trim())
            || (note.split('/').pop() || '').replace(/\.md$/i, '')
            || 'Board';
        const fileName = `${sanitizeFileName(basename) || 'Board'}.canvas`;
        const primary = joinVaultPath(joinVaultPath(root, DEFAULT_CANVAS_FOLDER), fileName);
        if (this.app.vault.getAbstractFileByPath(primary) instanceof TFile) return primary;
        const legacy = joinVaultPath(joinVaultPath(root, LEGACY_NCANVAS_FOLDER), fileName);
        if (this.app.vault.getAbstractFileByPath(legacy) instanceof TFile) return legacy;

        // Frontmatter may point at a missing file — still return it so callers can show/open errors.
        return fromFm || null;
    }

    async createBoard(
        entry: CreateLibraryEntityBoardEntry,
        options: { fallbackProjectRoot?: string } = {},
    ): Promise<string> {
        const name = String(entry?.name || 'Board').trim() || 'Board';
        const notePath = normalizeVaultPath(entry.notePath || entry.codexFile);
        const folder = this.resolveProjectCanvasFolder(notePath, options.fallbackProjectRoot || '');
        if (!folder) {
            throw new Error('Could not resolve the project Canvas folder for this entry.');
        }
        await ensureVaultFolder(this.app, folder);
        const canvasPath = await uniquePath(
            this.app,
            joinVaultPath(folder, `${sanitizeFileName(name) || 'Board'}.canvas`),
        );

        const nodes: Array<Record<string, unknown>> = [];
        let nodeId = 0;
        const scale = 14;
        for (const image of Array.isArray(entry.images) ? entry.images : []) {
            const path = normalizeVaultPath(typeof image === 'string' ? image : image?.path);
            if (!path) continue;
            const width = Math.round((Number(typeof image === 'object' ? image?.w : 0) || 28) * scale);
            nodes.push({
                id: `n${nodeId += 1}`,
                type: 'file',
                file: path,
                x: Math.round((Number(typeof image === 'object' ? image?.x : 0) || 4) * scale),
                y: Math.round((Number(typeof image === 'object' ? image?.y : 0) || 5) * scale),
                width,
                height: Math.round(width * 0.75),
            });
        }
        (Array.isArray(entry.files) ? entry.files : []).forEach((file, index) => {
            const path = normalizeVaultPath(typeof file === 'string' ? file : file?.path);
            if (!path) return;
            nodes.push({
                id: `n${nodeId += 1}`,
                type: 'file',
                file: path,
                x: 60 + (index % 2) * 460,
                y: 1240 + Math.floor(index / 2) * 420,
                width: 420,
                height: 380,
            });
        });

        await this.app.vault.create(canvasPath, JSON.stringify({ nodes, edges: [] }, null, '\t'));

        if (notePath) {
            const mdFile = this.app.vault.getAbstractFileByPath(notePath);
            if (mdFile instanceof TFile) {
                await this.app.fileManager.processFrontMatter(mdFile, (fm) => {
                    fm.canvas = canvasPath;
                });
                const embed = (text: string) => (
                    text.includes(`![[${canvasPath}]]`)
                        ? text
                        : `${text.trimEnd()}\n\n![[${canvasPath}]]\n`
                );
                if (typeof this.app.vault.process === 'function') {
                    await this.app.vault.process(mdFile, embed);
                } else {
                    await this.app.vault.modify(mdFile, embed(await this.app.vault.read(mdFile)));
                }
            }
        }

        return canvasPath;
    }

    async openBoard(canvasPath: string): Promise<void> {
        const path = normalizeVaultPath(canvasPath);
        const file = this.app.vault.getAbstractFileByPath(path);
        if (!(file instanceof TFile)) {
            throw new Error(`Board file not found: ${path}`);
        }
        await this.app.workspace.getLeaf('tab').openFile(file);
    }
}
