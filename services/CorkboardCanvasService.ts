/* eslint-disable @typescript-eslint/no-explicit-any -- Obsidian Canvas JSON is loosely typed */
import { App, TFile, TFolder, normalizePath } from 'obsidian';
import {
    deriveProjectFoldersFromFilePath,
} from '../models/StoryLineProject';
import type SceneCardsPlugin from '../main';

/** Obsidian .canvas node (subset we read/write). */
export interface CorkboardCanvasNode {
    id: string;
    type: string;
    x: number;
    y: number;
    width: number;
    height: number;
    file?: string;
    text?: string;
    color?: string;
    [key: string]: unknown;
}

export interface CorkboardCanvasEdge {
    id: string;
    fromNode: string;
    fromSide?: string;
    toNode: string;
    toSide?: string;
    [key: string]: unknown;
}

export interface CorkboardCanvasData {
    nodes: CorkboardCanvasNode[];
    edges: CorkboardCanvasEdge[];
}

export type CorkboardPos = { x: number; y: number; z?: number; w?: number; h?: number };

const DEFAULT_W = 280;
const DEFAULT_H = 200;
/** Legacy fixed name — migrated to `{project name}.canvas`. */
const LEGACY_CORKBOARD_CANVAS_NAME = 'corkboard.canvas';

function sanitizeCanvasFileBase(name: string): string {
    const cleaned = name
        .replace(/[\\/:*?"<>|]/g, '-')
        .replace(/\.canvas$/i, '')
        .replace(/\s+/g, ' ')
        .trim();
    return cleaned || 'corkboard';
}

/** Stable node id from vault path so remounts don't reshuffle edges. */
export function corkboardNodeIdForPath(path: string): string {
    const p = normalizePath(path);
    let h = 2166136261;
    for (let i = 0; i < p.length; i++) {
        h ^= p.charCodeAt(i);
        h = Math.imul(h, 16777619);
    }
    return `nl-${(h >>> 0).toString(36)}`;
}

function canonicalizeCanvasPayload(data: CorkboardCanvasData): string {
    return JSON.stringify({
        nodes: data.nodes ?? [],
        edges: data.edges ?? [],
    });
}

/**
 * Bidirectional bridge between NarrativeLab board.json positions and a native
 * Obsidian `{project}/Canvas/{project name}.canvas` file (file nodes for NL items).
 */
export class CorkboardCanvasService {
    constructor(private app: App, private plugin: SceneCardsPlugin) {}

    /** Filename for the tiled corkboard canvas: `{project name}.canvas`. */
    getCanvasFileName(projectFilePath?: string, title?: string): string | null {
        const project = this.plugin.sceneManager?.activeProject;
        const filePath = projectFilePath || project?.filePath;
        if (!filePath) return null;
        const fromManifest = filePath.split('/').pop()?.replace(/\.md$/i, '')?.trim() || '';
        const fromTitle = String(title ?? project?.title ?? '').trim();
        // Prefer manifest/folder name so renames stay aligned with the project folder.
        return `${sanitizeCanvasFileBase(fromManifest || fromTitle)}.canvas`;
    }

    /** Canonical corkboard canvas: `{project}/Canvas/{project name}.canvas`. */
    getCanvasPath(): string | null {
        const project = this.plugin.sceneManager?.activeProject;
        if (!project?.filePath) return null;
        const fileName = this.getCanvasFileName();
        if (!fileName) return null;
        const { canvasFolder } = deriveProjectFoldersFromFilePath(project.filePath);
        return normalizePath(`${canvasFolder}/${fileName}`);
    }

    /** Older locations: Canvas/corkboard.canvas and System/corkboard.canvas. */
    getLegacyCanvasPaths(): string[] {
        const project = this.plugin.sceneManager?.activeProject;
        if (!project?.filePath) return [];
        const { canvasFolder } = deriveProjectFoldersFromFilePath(project.filePath);
        const paths = [normalizePath(`${canvasFolder}/${LEGACY_CORKBOARD_CANVAS_NAME}`)];
        const sys = this.plugin.getProjectSystemFolder?.();
        if (sys) paths.push(normalizePath(`${sys}/${LEGACY_CORKBOARD_CANVAS_NAME}`));
        return paths;
    }

    /** Paths NL may sync onto the corkboard (Scenes / Notes / Research / …). */
    isNlManagedPath(path: string): boolean {
        const project = this.plugin.sceneManager?.activeProject;
        if (!project?.filePath) return false;
        const folders = deriveProjectFoldersFromFilePath(project.filePath);
        const p = normalizePath(path);
        const prefixes = [
            folders.sceneFolder,
            folders.notesFolder,
            folders.researchFolder,
            folders.archiveFolder,
            folders.sceneNotesFolder,
        ];
        return prefixes.some(prefix => p === prefix || p.startsWith(prefix + '/'));
    }

    async ensureFolderFor(path: string): Promise<void> {
        const dir = path.includes('/') ? path.slice(0, path.lastIndexOf('/')) : '';
        if (!dir) return;
        const adapter = this.app.vault.adapter;
        if (!(await adapter.exists(dir))) {
            await this.app.vault.createFolder(dir).catch(() => undefined);
        }
    }

    async readCanvas(path: string): Promise<CorkboardCanvasData> {
        const file = this.app.vault.getAbstractFileByPath(path);
        if (!(file instanceof TFile)) {
            return { nodes: [], edges: [] };
        }
        try {
            const raw = JSON.parse(await this.app.vault.read(file));
            const nodes = Array.isArray(raw?.nodes) ? raw.nodes : [];
            const edges = Array.isArray(raw?.edges) ? raw.edges : [];
            return { nodes, edges };
        } catch {
            return { nodes: [], edges: [] };
        }
    }

    async writeCanvas(path: string, data: CorkboardCanvasData): Promise<TFile> {
        await this.ensureFolderFor(path);
        const payload = canonicalizeCanvasPayload(data);
        const existing = this.app.vault.getAbstractFileByPath(path);
        if (existing instanceof TFile) {
            try {
                const current = await this.app.vault.read(existing);
                if (current === payload) return existing;
                const parsed = JSON.parse(current) as CorkboardCanvasData;
                if (canonicalizeCanvasPayload({
                    nodes: Array.isArray(parsed?.nodes) ? parsed.nodes : [],
                    edges: Array.isArray(parsed?.edges) ? parsed.edges : [],
                }) === payload) {
                    return existing;
                }
            } catch {
                // Fall through and rewrite if current content is unreadable.
            }
            const suppress = this.plugin.beginSuppressVaultRefresh?.(path);
            try {
                await this.app.vault.modify(existing, payload);
            } finally {
                suppress?.();
            }
            return existing;
        }
        const suppress = this.plugin.beginSuppressVaultRefresh?.(path);
        try {
            return await this.app.vault.create(path, payload);
        } finally {
            suppress?.();
        }
    }

    /** Pull geometry from .canvas file nodes into a board.json-compatible map. */
    positionsFromCanvas(data: CorkboardCanvasData): Record<string, CorkboardPos> {
        const out: Record<string, CorkboardPos> = {};
        let z = 1;
        for (const node of data.nodes || []) {
            if (node?.type !== 'file' || !node.file) continue;
            const path = normalizePath(String(node.file));
            const x = Number(node.x);
            const y = Number(node.y);
            if (!Number.isFinite(x) || !Number.isFinite(y)) continue;
            const w = Number(node.width);
            const h = Number(node.height);
            out[path] = {
                x,
                y,
                z: z++,
                ...(Number.isFinite(w) && w > 0 ? { w } : {}),
                ...(Number.isFinite(h) && h > 0 ? { h } : {}),
            };
        }
        return out;
    }

    /**
     * Rebuild NL-managed file nodes for `visiblePaths` while preserving
     * user-added cards/groups/media and edges between surviving ids.
     */
    async syncVisibleFiles(
        canvasPath: string,
        visiblePaths: string[],
        positions: Record<string, CorkboardPos>
    ): Promise<TFile> {
        const existing = await this.readCanvas(canvasPath);
        const visibleSet = new Set(visiblePaths.map(p => normalizePath(p)));

        // Prefer live Canvas geometry so remounts don't snap nodes back.
        const existingFileNodes = new Map<string, CorkboardCanvasNode>();
        for (const n of existing.nodes || []) {
            if (n?.type === 'file' && n.file) {
                existingFileNodes.set(normalizePath(String(n.file)), n);
            }
        }

        // Keep groups/text/media + user file cards that NL does not manage.
        // NL-managed file nodes are rebuilt from the current draft/filter set.
        const kept = (existing.nodes || []).filter(n => {
            if (!n) return false;
            if (n.type !== 'file') return true;
            if (!n.file) return false;
            return !this.isNlManagedPath(normalizePath(String(n.file)));
        });

        const fileNodes: CorkboardCanvasNode[] = [];
        visiblePaths.forEach((rawPath, index) => {
            const path = normalizePath(rawPath);
            if (!visibleSet.has(path)) return;
            const prev = existingFileNodes.get(path);
            const pos = positions[path];
            const col = index % 4;
            const row = Math.floor(index / 4);
            const x = Number.isFinite(Number(prev?.x))
                ? Number(prev!.x)
                : (Number.isFinite(pos?.x) ? Number(pos!.x) : col * 320);
            const y = Number.isFinite(Number(prev?.y))
                ? Number(prev!.y)
                : (Number.isFinite(pos?.y) ? Number(pos!.y) : row * 230);
            const w = Number.isFinite(Number(prev?.width)) && Number(prev!.width) > 0
                ? Number(prev!.width)
                : (Number.isFinite(pos?.w) && (pos!.w as number) > 0 ? Number(pos!.w) : DEFAULT_W);
            const h = Number.isFinite(Number(prev?.height)) && Number(prev!.height) > 0
                ? Number(prev!.height)
                : (Number.isFinite(pos?.h) && (pos!.h as number) > 0 ? Number(pos!.h) : DEFAULT_H);
            fileNodes.push({
                id: prev?.id?.startsWith?.('nl-') ? prev.id : corkboardNodeIdForPath(path),
                type: 'file',
                file: path,
                x,
                y,
                width: w,
                height: h,
                ...(prev?.color ? { color: prev.color } : {}),
            });
        });

        const nodes = [...kept, ...fileNodes];
        const idSet = new Set(nodes.map(n => n.id));
        const edges = (existing.edges || []).filter(
            e => e && idSet.has(String(e.fromNode)) && idSet.has(String(e.toNode))
        );

        return await this.writeCanvas(canvasPath, { nodes, edges });
    }

    /** Ensure project-named .canvas exists; migrate legacy corkboard.canvas if needed. */
    async ensureCanvasFile(
        visiblePaths: string[],
        positions: Record<string, CorkboardPos>
    ): Promise<TFile | null> {
        const path = this.getCanvasPath();
        if (!path) return null;

        await this.migrateLegacyCanvasIfNeeded(path);

        return await this.syncVisibleFiles(path, visiblePaths, positions);
    }

    /**
     * Rename/copy legacy corkboard canvases onto the project-named path when missing:
     * corkboard.canvas, System/corkboard.canvas, or a single leftover .canvas in Canvas/.
     */
    private async migrateLegacyCanvasIfNeeded(targetPath: string): Promise<void> {
        const existing = this.app.vault.getAbstractFileByPath(targetPath);
        if (existing instanceof TFile) return;

        const candidates: string[] = [...this.getLegacyCanvasPaths()];
        const project = this.plugin.sceneManager?.activeProject;
        if (project?.filePath) {
            const { canvasFolder } = deriveProjectFoldersFromFilePath(project.filePath);
            const folder = this.app.vault.getAbstractFileByPath(canvasFolder);
            if (folder instanceof TFolder) {
                const canvases = folder.children
                    .filter((c): c is TFile => c instanceof TFile && c.extension.toLowerCase() === 'canvas')
                    .map(c => c.path);
                // If exactly one .canvas remains under Canvas/, treat it as the corkboard.
                if (canvases.length === 1 && canvases[0] !== targetPath) {
                    candidates.push(canvases[0]);
                }
            }
        }

        for (const legacy of candidates) {
            if (!legacy || legacy === targetPath) continue;
            const legacyFile = this.app.vault.getAbstractFileByPath(legacy);
            if (!(legacyFile instanceof TFile)) continue;
            if (await this.tryMigrateCanvasFile(legacyFile, targetPath)) return;
        }
    }

    private async tryMigrateCanvasFile(legacyFile: TFile, targetPath: string): Promise<boolean> {
        try {
            await this.ensureFolderFor(targetPath);
            const suppress = this.plugin.beginSuppressVaultRefresh?.(targetPath);
            try {
                await this.app.vault.rename(legacyFile, targetPath);
            } finally {
                suppress?.();
            }
            return true;
        } catch {
            try {
                const data = await this.readCanvas(legacyFile.path);
                await this.writeCanvas(targetPath, data);
                return true;
            } catch (err) {
                console.warn('[NarrativeLab] corkboard canvas migrate failed:', legacyFile.path, err);
                return false;
            }
        }
    }

    /** After a project rename, move `{oldName}.canvas` / corkboard.canvas → `{newName}.canvas`. */
    async renameCanvasForProject(opts: {
        oldBaseFolder: string;
        newBaseFolder: string;
        oldLeaf: string;
        newLeaf: string;
    }): Promise<void> {
        const { canvasFolder: newCanvasFolder } = deriveProjectFoldersFromFilePath(
            normalizePath(`${opts.newBaseFolder}/${opts.newLeaf}.md`)
        );
        const target = normalizePath(`${newCanvasFolder}/${sanitizeCanvasFileBase(opts.newLeaf)}.canvas`);
        if (this.app.vault.getAbstractFileByPath(target) instanceof TFile) return;

        const candidates = [
            normalizePath(`${newCanvasFolder}/${sanitizeCanvasFileBase(opts.oldLeaf)}.canvas`),
            normalizePath(`${newCanvasFolder}/${LEGACY_CORKBOARD_CANVAS_NAME}`),
            normalizePath(`${opts.newBaseFolder}/System/${LEGACY_CORKBOARD_CANVAS_NAME}`),
        ];
        for (const legacy of candidates) {
            if (legacy === target) continue;
            const file = this.app.vault.getAbstractFileByPath(legacy);
            if (file instanceof TFile) {
                await this.tryMigrateCanvasFile(file, target);
                return;
            }
        }
    }
}
