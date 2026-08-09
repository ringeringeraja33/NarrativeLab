
import type SceneCardsPlugin from '../main';
import { createEmptyConceptGridDocument, type ConceptGridDocument } from '../models/PlotGridData';
import { normalizePath, Notice, TFile } from 'obsidian';
import { t } from '../utils/i18n';

const VIEW_SNAPSHOT_VERSION = 2;

export interface ViewSnapshotMeta {
    id: number;
    name: string;
    created: string;
    modified?: string;
    description?: string;
}

export interface ViewSnapshot extends ViewSnapshotMeta {
    version?: number;
    board: Record<string, { x: number; y: number; z?: number }>;
    plotgrid: ConceptGridDocument | null;
    /** Scene file paths → sequence numbers (kanban order) — legacy */
    sequences?: Record<string, number>;
    /** Full scene layout state (act, chapter, status, pov, sequence) */
    sceneLayout?: Record<string, SceneLayoutState>;
}

/** Kanban-relevant properties captured per scene */
interface SceneLayoutState {
    sequence?: number | null;
    act?: number | string | null;
    chapter?: number | string | null;
    status?: string | null;
    pov?: string | null;
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
            const data: unknown = JSON.parse(await adapter.read(p));
            if (!data || typeof data !== 'object' || Array.isArray(data)) throw new Error(t('Invalid snapshot state.'));
            const activeId = (data as Partial<ActiveState>).activeSnapshotId;
            this._activeId = typeof activeId === 'number' ? activeId : null;
        } catch (error) {
            console.error('[NarrativeLab] Failed to read active snapshot state:', error);
            this._activeId = null;
        }
    }

    private async saveActiveState(): Promise<void> {
        await this.ensureFolder();
        await this.writeJsonSafely(this.activeStatePath(), { activeSnapshotId: this._activeId });
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
        existing.version = VIEW_SNAPSHOT_VERSION;
        existing.modified = new Date().toISOString();

        await this.writeJsonSafely(this.snapshotPath(this._activeId), existing);
    }

    private captureSceneLayout(): Record<string, SceneLayoutState> {
        const layout: Record<string, SceneLayoutState> = {};
        for (const scene of this.plugin.sceneManager.getAllScenes()) {
            layout[scene.filePath] = {
                sequence: scene.sequence ?? null,
                act: scene.act ?? null,
                chapter: scene.chapter ?? null,
                status: scene.status ?? null,
                pov: scene.pov ?? null,
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
            version: VIEW_SNAPSHOT_VERSION,
            id,
            name,
            created: new Date().toISOString(),
            description: description || undefined,
            board: board ?? {},
            plotgrid,
            sceneLayout: sequences,
        };

        await this.writeJsonSafely(this.snapshotPath(id), snapshot);

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
        snap.version = VIEW_SNAPSHOT_VERSION;
        snap.modified = new Date().toISOString();
        await this.writeJsonSafely(this.snapshotPath(id), snap);
    }

    /** Load a snapshot by ID. */
    async loadSnapshot(id: number): Promise<ViewSnapshot | null> {
        const adapter = this.plugin.app.vault.adapter;
        const path = this.snapshotPath(id);
        if (!await adapter.exists(path)) return null;
        try {
            const txt = await adapter.read(path);
            const data: unknown = JSON.parse(txt);
            if (!this.isViewSnapshot(data)) throw new Error(t('Invalid view snapshot.'));
            if (typeof data.version === 'number' && data.version > VIEW_SNAPSHOT_VERSION) {
                throw new Error(t('Unsupported view snapshot version: {version}', { version: data.version }));
            }
            return data;
        } catch (error) {
            console.error(`[NarrativeLab] Failed to load snapshot ${id}:`, error);
            new Notice(t('Could not load view snapshot {id}: {message}', {
                id,
                message: error instanceof Error ? error.message : String(error),
            }));
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
        const previousActiveId = this._activeId;
        const previousBoard = this.plugin.sceneManager.getCorkboardPositions() ?? {};
        const previousPlotgrid = await this.plugin.loadPlotGrid();
        const restoredFiles: Array<{ originalPath: string; currentPath: string; content: string }> = [];
        try {
            // Restore board positions
            await this.plugin.sceneManager.setCorkboardPositions(snapshot.board ?? {});

            // Restore plotgrid
            await this.plugin.savePlotGrid(
                snapshot.plotgrid ?? createEmptyConceptGridDocument(),
                { allowEmptyOverwrite: true },
            );

            // Restore scene layout (act, chapter, status, pov, sequence)
            const layout = snapshot.sceneLayout ?? this.migrateLegacySequences(snapshot.sequences);
            if (layout) {
                for (const [filePath, state] of Object.entries(layout)) {
                    const scene = this.plugin.sceneManager.getAllScenes().find(s => s.filePath === filePath);
                    if (!scene) continue;
                    const file = this.plugin.app.vault.getAbstractFileByPath(filePath);
                    if (!(file instanceof TFile)) continue;
                    const originalContent = await this.plugin.app.vault.read(file);
                    const updates: Record<string, unknown> = {};
                    if (state.sequence !== undefined && (scene.sequence ?? null) !== state.sequence) updates.sequence = state.sequence ?? undefined;
                    if (state.act !== undefined && (scene.act ?? null) !== state.act) updates.act = state.act ?? undefined;
                    if (state.chapter !== undefined && (scene.chapter ?? null) !== state.chapter) updates.chapter = state.chapter ?? undefined;
                    if (state.status !== undefined && (scene.status ?? null) !== state.status) updates.status = state.status ?? undefined;
                    if (state.pov !== undefined && (scene.pov ?? null) !== state.pov) updates.pov = state.pov ?? undefined;
                    if (Object.keys(updates).length > 0) {
                        const restoreState = {
                            originalPath: filePath,
                            currentPath: filePath,
                            content: originalContent,
                        };
                        restoredFiles.push(restoreState);
                        const result = await this.plugin.sceneManager.updateScene(filePath, updates, { recordUndo: false });
                        restoreState.currentPath = typeof result === 'string' ? result : filePath;
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
        } catch (error) {
            for (const state of [...restoredFiles].reverse()) {
                const current = this.plugin.app.vault.getAbstractFileByPath(state.currentPath);
                const original = this.plugin.app.vault.getAbstractFileByPath(state.originalPath);
                let file: TFile | null = current instanceof TFile
                    ? current
                    : original instanceof TFile ? original : null;
                if (!file) continue;
                if (file.path !== state.originalPath && !this.plugin.app.vault.getAbstractFileByPath(state.originalPath)) {
                    await this.plugin.app.fileManager.renameFile(file, state.originalPath).catch(() => undefined);
                    const renamed = this.plugin.app.vault.getAbstractFileByPath(state.originalPath);
                    file = renamed instanceof TFile ? renamed : null;
                }
                if (file) {
                    await this.plugin.app.vault.modify(file, state.content).catch(() => undefined);
                }
            }
            await this.plugin.sceneManager.setCorkboardPositions(previousBoard).catch(() => undefined);
            await this.plugin.savePlotGrid(
                previousPlotgrid ?? createEmptyConceptGridDocument(),
                { allowEmptyOverwrite: true },
            ).catch(() => undefined);
            this._activeId = previousActiveId;
            await this.saveActiveState().catch(() => undefined);
            await this.plugin.sceneManager.initialize().catch(() => undefined);
            this.plugin.invalidateCorkboardCache();
            await this.plugin.refreshOpenViews().catch(() => undefined);
            throw error;
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
            const file = this.plugin.app.vault.getAbstractFileByPath(path);
            if (!(file instanceof TFile)) {
                throw new Error(t('The snapshot file is not indexed by Obsidian. Reopen the vault and try again.'));
            }
            await this.plugin.app.fileManager.trashFile(file);
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

    private isViewSnapshot(value: unknown): value is ViewSnapshot {
        if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
        const snapshot = value as Partial<ViewSnapshot>;
        return typeof snapshot.id === 'number'
            && typeof snapshot.name === 'string'
            && typeof snapshot.created === 'string'
            && !!snapshot.board
            && typeof snapshot.board === 'object'
            && !Array.isArray(snapshot.board);
    }

    private async writeJsonSafely(path: string, value: unknown): Promise<void> {
        const adapter = this.plugin.app.vault.adapter;
        const payload = JSON.stringify(value, null, 2);
        const tempPath = `${path}.tmp`;
        if (await adapter.exists(path)) {
            await adapter.write(`${path}.bak`, await adapter.read(path));
        }
        await adapter.write(tempPath, payload);
        try {
            await adapter.write(path, payload);
            await adapter.remove(tempPath).catch(() => undefined);
        } catch (error) {
            throw new Error(t('Safe write failed for {name}: {message}', {
                name: path.split('/').pop() || path,
                message: error instanceof Error ? error.message : String(error),
            }));
        }
    }
}
