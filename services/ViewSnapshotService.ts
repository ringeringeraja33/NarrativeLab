/* eslint-disable @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-argument, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-return, @typescript-eslint/no-floating-promises, @typescript-eslint/no-misused-promises, @typescript-eslint/no-unnecessary-type-assertion, @typescript-eslint/no-redundant-type-constituents, @typescript-eslint/no-unused-vars, no-unused-vars, no-useless-escape, no-control-regex, no-empty -- Obsidian's API surface and several untyped third-party libraries force dynamic dispatch; floating promises are intentional in DOM/event handlers; matching enable at end of file */
import type SceneCardsPlugin from '../main';
import type { PlotGridData } from '../models/PlotGridData';
import { normalizePath } from 'obsidian';

export interface ViewSnapshotMeta {
    id: number;
    name: string;
    created: string;
    modified?: string;
    description?: string;
}

export interface ViewSnapshot extends ViewSnapshotMeta {
    board: Record<string, { x: number; y: number; z?: number }>;
    plotgrid: PlotGridData | null;
    /** Scene file paths → sequence numbers (kanban order) — legacy */
    sequences?: Record<string, number>;
    /** Full scene layout state (act, chapter, status, pov, sequence) */
    sceneLayout?: Record<string, SceneLayoutState>;
}

/** Kanban-relevant properties captured per scene */
interface SceneLayoutState {
    sequence?: number;
    act?: number | string;
    chapter?: number | string;
    status?: string;
    pov?: string;
}

/** Tracks which snapshot is currently active. Stored in System/Snapshots/active.json */
interface ActiveState {
    activeSnapshotId: number | null;
}

export class ViewSnapshotService {
    private _activeId: number | null = null;
    private _autoSaveTimer: number | null = null;
    /** Suppress auto-save while restoring a snapshot */
    private _restoring = false;

    constructor(private plugin: SceneCardsPlugin) {}

    get activeSnapshotId(): number | null { return this._activeId; }

    private getSnapshotsFolder(): string {
        return normalizePath(`${this.plugin.getProjectSystemFolder()}/Snapshots`);
    }

    private snapshotPath(id: number): string {
        const padded = String(id).padStart(3, '0');
        return normalizePath(`${this.getSnapshotsFolder()}/snapshot-${padded}.json`);
    }

    private activeStatePath(): string {
        return normalizePath(`${this.getSnapshotsFolder()}/active.json`);
    }

    private async ensureFolder(): Promise<void> {
        const folder = this.getSnapshotsFolder();
        const adapter = this.plugin.app.vault.adapter;
        if (!await adapter.exists(folder)) {
            await this.plugin.app.vault.createFolder(folder);
        }
    }

    /** Load the active-snapshot id from disk (call on project switch). */
    async loadActiveState(): Promise<void> {
        try {
            const adapter = this.plugin.app.vault.adapter;
            const p = this.activeStatePath();
            if (!await adapter.exists(p)) { this._activeId = null; return; }
            const data = JSON.parse(await adapter.read(p)) as ActiveState;
            this._activeId = data.activeSnapshotId ?? null;
        } catch { this._activeId = null; }
    }

    private async saveActiveState(): Promise<void> {
        await this.ensureFolder();
        const adapter = this.plugin.app.vault.adapter;
        await adapter.write(this.activeStatePath(), JSON.stringify({ activeSnapshotId: this._activeId }, null, 2));
    }

    // ── Auto-save ──────────────────────────────────────────

    /**
     * Schedule an auto-save of the active snapshot (debounced 2 s).
     * Call this whenever view state changes (corkboard move, plotgrid edit, kanban drag).
     * If no snapshot exists yet, one is auto-created on the first trigger.
     */
    scheduleAutoSave(): void {
        if (this._restoring) return;
        if (this._activeId == null) return;
        if (this._autoSaveTimer) window.clearTimeout(this._autoSaveTimer);
        this._autoSaveTimer = window.setTimeout(() => {
            this._autoSaveTimer = null;
            void this.autoSave();
        }, 2000);
    }

    private async autoSave(): Promise<void> {
        if (this._restoring || this._activeId == null) return;

        const existing = await this.loadSnapshot(this._activeId);
        if (!existing) return;

        existing.board = this.plugin.sceneManager.getCorkboardPositions() ?? {};
        existing.plotgrid = await this.plugin.loadPlotGrid();
        existing.sceneLayout = this.captureSceneLayout();
        existing.modified = new Date().toISOString();

        const adapter = this.plugin.app.vault.adapter;
        await adapter.write(this.snapshotPath(this._activeId), JSON.stringify(existing, null, 2));
    }

    private captureSceneLayout(): Record<string, SceneLayoutState> {
        const layout: Record<string, SceneLayoutState> = {};
        for (const scene of this.plugin.sceneManager.getAllScenes()) {
            layout[scene.filePath] = {
                sequence: scene.sequence,
                act: scene.act,
                chapter: scene.chapter,
                status: scene.status,
                pov: scene.pov,
            };
        }
        return layout;
    }

    // ── CRUD ───────────────────────────────────────────────

    /** List all snapshots (newest first). */
    async listSnapshots(): Promise<ViewSnapshotMeta[]> {
        const folder = this.getSnapshotsFolder();
        const adapter = this.plugin.app.vault.adapter;
        if (!await adapter.exists(folder)) return [];

        const listing = await adapter.list(folder);
        const metas: ViewSnapshotMeta[] = [];

        for (const filePath of listing.files) {
            if (!filePath.endsWith('.json') || filePath.endsWith('active.json')) continue;
            try {
                const txt = await adapter.read(filePath);
                const data = JSON.parse(txt) as ViewSnapshot;
                metas.push({
                    id: data.id,
                    name: data.name,
                    created: data.created,
                    modified: data.modified,
                    description: data.description,
                });
            } catch { /* skip unreadable files */ }
        }

        metas.sort((a, b) => b.id - a.id);
        return metas;
    }

    /** Get the next available snapshot ID. */
    async getNextId(): Promise<number> {
        const metas = await this.listSnapshots();
        if (metas.length === 0) return 1;
        return Math.max(...metas.map(m => m.id)) + 1;
    }

    /** Create a brand-new snapshot from current state (frozen point-in-time copy). */
    async createSnapshot(name: string, description?: string): Promise<ViewSnapshot> {
        await this.ensureFolder();

        // Flush pending corkboard writes so we capture the latest positions.
        await this.plugin.flushCorkboardPositions();

        const id = await this.getNextId();
        const board = this.plugin.sceneManager.getCorkboardPositions();
        const plotgrid = await this.plugin.loadPlotGrid();
        const sequences = this.captureSceneLayout();

        const snapshot: ViewSnapshot = {
            id,
            name,
            created: new Date().toISOString(),
            description: description || undefined,
            board: board ?? {},
            plotgrid,
            sceneLayout: sequences,
        };

        const adapter = this.plugin.app.vault.adapter;
        await adapter.write(this.snapshotPath(id), JSON.stringify(snapshot, null, 2));

        // New snapshot becomes active; the previously active one is now frozen.
        this._activeId = id;
        await this.saveActiveState();
        return snapshot;
    }

    /** Update metadata (name/description) of an existing snapshot. */
    async updateMeta(id: number, name: string, description?: string): Promise<void> {
        const snap = await this.loadSnapshot(id);
        if (!snap) return;
        snap.name = name;
        snap.description = description || undefined;
        snap.modified = new Date().toISOString();
        const adapter = this.plugin.app.vault.adapter;
        await adapter.write(this.snapshotPath(id), JSON.stringify(snap, null, 2));
    }

    /** Load a snapshot by ID. */
    async loadSnapshot(id: number): Promise<ViewSnapshot | null> {
        const adapter = this.plugin.app.vault.adapter;
        const path = this.snapshotPath(id);
        if (!await adapter.exists(path)) return null;
        try {
            const txt = await adapter.read(path);
            return JSON.parse(txt) as ViewSnapshot;
        } catch {
            return null;
        }
    }

    /** Restore a snapshot — apply its state to board + plotgrid + scene sequences. */
    async restoreSnapshot(id: number): Promise<boolean> {
        const snapshot = await this.loadSnapshot(id);
        if (!snapshot) return false;

        // Flush any pending changes to the currently active snapshot before switching
        if (this._autoSaveTimer) {
            window.clearTimeout(this._autoSaveTimer);
            this._autoSaveTimer = null;
        }
        if (this._activeId != null && this._activeId !== id) {
            await this.autoSave();
        }

        this._restoring = true;
        try {
            // Restore board positions
            await this.plugin.sceneManager.setCorkboardPositions(snapshot.board ?? {});

            // Restore plotgrid
            if (snapshot.plotgrid) {
                await this.plugin.savePlotGrid(snapshot.plotgrid);
            }

            // Restore scene layout (act, chapter, status, pov, sequence)
            const layout = snapshot.sceneLayout ?? this.migrateLegacySequences(snapshot.sequences);
            if (layout) {
                for (const [filePath, state] of Object.entries(layout)) {
                    const scene = this.plugin.sceneManager.getAllScenes().find(s => s.filePath === filePath);
                    if (!scene) continue;
                    const updates: Record<string, unknown> = {};
                    if (state.sequence !== undefined && scene.sequence !== state.sequence) updates.sequence = state.sequence;
                    if (state.act !== undefined && scene.act !== state.act) updates.act = state.act;
                    if (state.chapter !== undefined && scene.chapter !== state.chapter) updates.chapter = state.chapter;
                    if (state.status !== undefined && scene.status !== state.status) updates.status = state.status;
                    if (state.pov !== undefined && scene.pov !== state.pov) updates.pov = state.pov;
                    if (Object.keys(updates).length > 0) {
                        await this.plugin.sceneManager.updateScene(filePath, updates);
                    }
                }
            }

            // Mark as active
            this._activeId = id;
            await this.saveActiveState();

            // Invalidate BoardView's local corkboard cache so it re-reads
            // the restored positions from SceneManager on next refresh.
            this.plugin.invalidateCorkboardCache();

            // Refresh all open views so they pick up the new state
            await this.plugin.refreshOpenViews();
        } finally {
            this._restoring = false;
        }
        return true;
    }

    /** Delete a snapshot by ID. */
    async deleteSnapshot(id: number): Promise<void> {
        const adapter = this.plugin.app.vault.adapter;
        const path = this.snapshotPath(id);
        if (await adapter.exists(path)) {
            await adapter.remove(path);
        }
        if (this._activeId === id) {
            this._activeId = null;
            await this.saveActiveState();
        }
    }

    /** Convert old `sequences` field to the new `sceneLayout` format. */
    private migrateLegacySequences(sequences?: Record<string, number>): Record<string, SceneLayoutState> | null {
        if (!sequences) return null;
        const layout: Record<string, SceneLayoutState> = {};
        for (const [filePath, seq] of Object.entries(sequences)) {
            layout[filePath] = { sequence: seq };
        }
        return layout;
    }
}
/* eslint-enable @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-argument, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-return, @typescript-eslint/no-floating-promises, @typescript-eslint/no-misused-promises, @typescript-eslint/no-unnecessary-type-assertion, @typescript-eslint/no-redundant-type-constituents, @typescript-eslint/no-unused-vars, no-unused-vars, no-useless-escape, no-control-regex, no-empty -- end of file-wide suppression block opened at line 1 */
