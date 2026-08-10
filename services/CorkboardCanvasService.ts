
import { App, TFile, normalizePath } from 'obsidian';
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

function isCanvasNode(value: unknown): value is CorkboardCanvasNode {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
    const node = value as Partial<CorkboardCanvasNode>;
    return typeof node.id === 'string'
        && typeof node.type === 'string'
        && typeof node.x === 'number'
        && typeof node.y === 'number'
        && typeof node.width === 'number'
        && typeof node.height === 'number';
}

function isCanvasEdge(value: unknown): value is CorkboardCanvasEdge {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
    const edge = value as Partial<CorkboardCanvasEdge>;
    return typeof edge.id === 'string'
        && typeof edge.fromNode === 'string'
        && typeof edge.toNode === 'string';
}

export type CorkboardPos = { x: number; y: number; z?: number; w?: number; h?: number };

const DEFAULT_W = 280;
const DEFAULT_H = 200;
/** Canonical tiled corkboard canvas filename for every project. */
export const CORKBOARD_CANVAS_NAME = 'corkboard.canvas';

/** `{project}/Canvas/corkboard.canvas` for a project manifest path. */
export function corkboardCanvasPathForProject(projectFilePath: string): string {
    const { canvasFolder } = deriveProjectFoldersFromFilePath(projectFilePath);
    return normalizePath(`${canvasFolder}/${CORKBOARD_CANVAS_NAME}`);
}

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
 * Obsidian `{project}/Canvas/corkboard.canvas` file (file nodes for NL items).
 */
export class CorkboardCanvasService {
    constructor(private app: App, private plugin: SceneCardsPlugin) {}

    /** Filename for the tiled corkboard canvas: always `corkboard.canvas`. */
    getCanvasFileName(_projectFilePath?: string, _title?: string): string {
        return CORKBOARD_CANVAS_NAME;
    }

    /** Canonical corkboard canvas: `{project}/Canvas/corkboard.canvas`. */
    getCanvasPath(): string | null {
        const project = this.plugin.sceneManager?.activeProject;
        if (!project?.filePath) return null;
        return corkboardCanvasPathForProject(project.filePath);
    }

    /**
     * Older locations still migrated into Canvas/corkboard.canvas:
     * System/corkboard.canvas and the short-lived `{project name}.canvas`.
     */
    getLegacyCanvasPaths(): string[] {
        const project = this.plugin.sceneManager?.activeProject;
        if (!project?.filePath) return [];
        const { canvasFolder } = deriveProjectFoldersFromFilePath(project.filePath);
        const paths: string[] = [];
        const sys = this.plugin.getProjectSystemFolder?.();
        if (sys) paths.push(normalizePath(`${sys}/${CORKBOARD_CANVAS_NAME}`));

        const leaf = project.filePath.split('/').pop()?.replace(/\.md$/i, '')?.trim() || '';
        const title = String(project.title ?? '').trim();
        for (const base of [leaf, title]) {
            if (!base) continue;
            const named = normalizePath(`${canvasFolder}/${sanitizeCanvasFileBase(base)}.canvas`);
            if (named.endsWith(`/${CORKBOARD_CANVAS_NAME}`)) continue;
            paths.push(named);
        }
        return paths;
    }

    /** Paths NL may sync onto the corkboard (Scenes / Notes / Research / …). */
    isNlManagedPath(path: string): boolean {
        const project = this.plugin.sceneManager?.activeProject;
        if (!project?.filePath) return false;
        const p = normalizePath(path);
        const derived = deriveProjectFoldersFromFilePath(project.filePath);
        const prefixes = [
            project.sceneFolder,
            project.notesFolder,
            project.researchFolder,
            project.archiveFolder,
            project.sceneNotesFolder,
            derived.sceneFolder,
            derived.notesFolder,
            derived.researchFolder,
            derived.archiveFolder,
            derived.sceneNotesFolder,
        ].filter((prefix): prefix is string => typeof prefix === 'string' && prefix.length > 0);
        return prefixes.some(prefix => {
            const root = normalizePath(prefix);
            return p === root || p.startsWith(`${root}/`);
        });
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
            const raw: unknown = JSON.parse(await this.app.vault.read(file));
            if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
                throw new Error('Canvas root must be a JSON object.');
            }
            const record = raw as Record<string, unknown>;
            if (!Array.isArray(record.nodes) || !Array.isArray(record.edges)) {
                throw new Error('Canvas must contain nodes and edges arrays.');
            }
            if (!record.nodes.every(isCanvasNode) || !record.edges.every(isCanvasEdge)) {
                throw new Error('Canvas contains malformed nodes or edges.');
            }
            const nodes = record.nodes;
            const edges = record.edges;
            return { nodes, edges };
        } catch (error) {
            const wrapped = new Error(`Could not read corkboard Canvas "${path}". The original file was not changed.`);
            (wrapped as Error & { cause?: unknown }).cause = error;
            throw wrapped;
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
            } catch (error) {
                const wrapped = new Error(`Could not verify corkboard Canvas "${path}". The original file was not changed.`);
                (wrapped as Error & { cause?: unknown }).cause = error;
                throw wrapped;
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
                : (Number.isFinite(pos?.x) ? Number(pos.x) : col * 320);
            const y = Number.isFinite(Number(prev?.y))
                ? Number(prev!.y)
                : (Number.isFinite(pos?.y) ? Number(pos.y) : row * 230);
            const w = Number.isFinite(Number(prev?.width)) && Number(prev!.width) > 0
                ? Number(prev!.width)
                : (Number.isFinite(pos?.w) && (pos.w as number) > 0 ? Number(pos.w) : DEFAULT_W);
            const h = Number.isFinite(Number(prev?.height)) && Number(prev!.height) > 0
                ? Number(prev!.height)
                : (Number.isFinite(pos?.h) && (pos.h as number) > 0 ? Number(pos.h) : DEFAULT_H);
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

    /** Ensure Canvas/corkboard.canvas exists; migrate renamed/legacy copies if needed. */
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
     * Rename/copy known legacy corkboard canvases onto Canvas/corkboard.canvas
     * when missing. Never adopt an arbitrary lone .canvas: it may be a narrative
     * projection or a user-authored Obsidian Canvas.
     */
    private async migrateLegacyCanvasIfNeeded(targetPath: string): Promise<void> {
        const existing = this.app.vault.getAbstractFileByPath(targetPath);
        if (existing instanceof TFile) return;

        const candidates: string[] = [...this.getLegacyCanvasPaths()];

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

    /**
     * After a project rename, fold any `{old/new name}.canvas` left in Canvas/
     * back into the fixed `corkboard.canvas` name.
     */
    async renameCanvasForProject(opts: {
        oldBaseFolder: string;
        newBaseFolder: string;
        oldLeaf: string;
        newLeaf: string;
    }): Promise<void> {
        const { canvasFolder: newCanvasFolder } = deriveProjectFoldersFromFilePath(
            normalizePath(`${opts.newBaseFolder}/${opts.newLeaf}.md`)
        );
        const target = normalizePath(`${newCanvasFolder}/${CORKBOARD_CANVAS_NAME}`);
        if (this.app.vault.getAbstractFileByPath(target) instanceof TFile) return;

        const candidates = [
            normalizePath(`${newCanvasFolder}/${sanitizeCanvasFileBase(opts.oldLeaf)}.canvas`),
            normalizePath(`${newCanvasFolder}/${sanitizeCanvasFileBase(opts.newLeaf)}.canvas`),
            normalizePath(`${opts.newBaseFolder}/System/${CORKBOARD_CANVAS_NAME}`),
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
