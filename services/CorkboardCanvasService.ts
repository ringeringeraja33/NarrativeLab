/* eslint-disable @typescript-eslint/no-explicit-any -- Obsidian Canvas JSON is loosely typed */
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

export type CorkboardPos = { x: number; y: number; z?: number; w?: number; h?: number };

const DEFAULT_W = 280;
const DEFAULT_H = 200;
const CORKBOARD_CANVAS_NAME = 'corkboard.canvas';

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

/**
 * Bidirectional bridge between NarrativeLab board.json positions and a native
 * Obsidian `Canvas/corkboard.canvas` file (file nodes for NL items).
 */
export class CorkboardCanvasService {
    constructor(private app: App, private plugin: SceneCardsPlugin) {}

    /** Canonical corkboard canvas: `{project}/Canvas/corkboard.canvas`. */
    getCanvasPath(): string | null {
        const project = this.plugin.sceneManager?.activeProject;
        if (!project?.filePath) return null;
        const { canvasFolder } = deriveProjectFoldersFromFilePath(project.filePath);
        return normalizePath(`${canvasFolder}/${CORKBOARD_CANVAS_NAME}`);
    }

    /** Older location before Canvas/ move. */
    getLegacySystemCanvasPath(): string | null {
        const sys = this.plugin.getProjectSystemFolder?.();
        if (!sys) return null;
        return normalizePath(`${sys}/${CORKBOARD_CANVAS_NAME}`);
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
        const payload = JSON.stringify(
            {
                nodes: data.nodes ?? [],
                edges: data.edges ?? [],
            },
            null,
            2
        );
        const existing = this.app.vault.getAbstractFileByPath(path);
        if (existing instanceof TFile) {
            await this.app.vault.modify(existing, payload);
            return existing;
        }
        return await this.app.vault.create(path, payload);
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

    /** Ensure corkboard.canvas exists; migrate from System/ on first run. */
    async ensureCanvasFile(
        visiblePaths: string[],
        positions: Record<string, CorkboardPos>
    ): Promise<TFile | null> {
        const path = this.getCanvasPath();
        if (!path) return null;

        const existing = this.app.vault.getAbstractFileByPath(path);
        if (!(existing instanceof TFile)) {
            const legacy = this.getLegacySystemCanvasPath();
            if (legacy && legacy !== path) {
                const legacyFile = this.app.vault.getAbstractFileByPath(legacy);
                if (legacyFile instanceof TFile) {
                    try {
                        await this.ensureFolderFor(path);
                        await this.app.vault.rename(legacyFile, path);
                    } catch {
                        // If rename fails (dest exists / sync), copy contents instead.
                        const data = await this.readCanvas(legacy);
                        await this.writeCanvas(path, data);
                    }
                }
            }
        }

        return await this.syncVisibleFiles(path, visiblePaths, positions);
    }
}
