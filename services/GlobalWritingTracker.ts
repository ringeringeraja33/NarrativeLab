import { normalizePath } from 'obsidian';
import type SceneCardsPlugin from '../main';
import { WritingTracker } from './WritingTracker';
import { deriveProjectFoldersFromFilePath } from '../models/StoryLineProject';
import {
    parseWritingTrackerFile,
    reconcileDerivedTrackerHistory,
    WRITING_TRACKER_FILENAME,
} from '../utils/writingTrackerHeatmap';

/**
 * Vault-wide net-word ledger, stored beside the plugin (not in a project
 * System/ folder) so switching books cannot wipe or mix the heatmap.
 */
export class GlobalWritingTracker {
    readonly tracker = new WritingTracker();
    private writeQueue: Promise<void> = Promise.resolve();
    private saveTimer: number | null = null;
    private loaded = false;
    private unattributedHistory: Record<string, number> = {};
    private unattributedRevisionHistory: Record<string, number> = {};

    constructor(private plugin: SceneCardsPlugin) {}

    getFilePath(): string {
        const dir = this.plugin.manifest.dir
            || `${this.plugin.app.vault.configDir}/plugins/${this.plugin.manifest.id}`;
        return normalizePath(`${dir}/${WRITING_TRACKER_FILENAME}`);
    }

    async load(): Promise<void> {
        try {
            const adapter = this.plugin.app.vault.adapter;
            const path = this.getFilePath();
            if (await adapter.exists(path)) {
                const parsed = parseWritingTrackerFile(JSON.parse(await adapter.read(path)) as unknown);
                this.tracker.importData(parsed);
                this.unattributedHistory = parsed.unattributedHistory;
                this.unattributedRevisionHistory = parsed.unattributedRevisionHistory;
            }
        } catch (error) {
            console.error('[NarrativeLab] Failed to load writing tracker:', error);
        }
        this.loaded = true;
    }

    /** Rebuild vault totals from project ledgers and quarantine legacy-only dates. */
    async reconcileProjectLedgers(): Promise<void> {
        if (!this.loaded) return;
        const history: Record<string, number> = {};
        const revisionHistory: Record<string, number> = {};
        let found = false;
        let complete = true;
        for (const project of this.plugin.sceneManager.getProjects()) {
            try {
                const base = deriveProjectFoldersFromFilePath(project.filePath).baseFolder;
                const path = normalizePath(`${base}/System/stats.json`);
                const adapter = this.plugin.app.vault.adapter;
                if (!await adapter.exists(path)) continue;
                const raw = JSON.parse(await adapter.read(path)) as Record<string, unknown>;
                const parsed = parseWritingTrackerFile(
                    raw?.writingTrackerData && typeof raw.writingTrackerData === 'object'
                        ? raw.writingTrackerData
                        : {},
                );
                found = true;
                for (const [date, words] of Object.entries(parsed.history)) {
                    history[date] = (history[date] || 0) + words;
                }
                for (const [date, words] of Object.entries(parsed.revisionHistory)) {
                    revisionHistory[date] = (revisionHistory[date] || 0) + words;
                }
            } catch (error) {
                complete = false;
                console.warn('[NarrativeLab] Could not merge project writing tracker:', project.filePath, error);
            }
        }
        // Never replace the current ledger with a partial project scan.
        if (!found || !complete) return;
        const existingHistory = this.tracker.getFullHistory();
        const existingRevisions = this.tracker.getFullRevisionHistory();
        const words = reconcileDerivedTrackerHistory(history, existingHistory, this.unattributedHistory);
        const revisions = reconcileDerivedTrackerHistory(
            revisionHistory,
            existingRevisions,
            this.unattributedRevisionHistory,
        );
        this.unattributedHistory = words.unattributedHistory;
        this.unattributedRevisionHistory = revisions.unattributedHistory;
        this.tracker.importData({ history: words.history, revisionHistory: revisions.history });
        await this.save();
    }

    getUnattributedWordTotal(): number {
        return Object.values(this.unattributedHistory).reduce((sum, words) => sum + words, 0);
    }

    getUnattributedEntryCount(): number {
        return Object.keys(this.unattributedHistory).length;
    }

    recordFlush(delta: { words: number; revisions: number }, now = Date.now()): void {
        if (delta.words !== 0) this.tracker.addTodayWords(delta.words, now);
        if (delta.revisions > 0) this.tracker.addTodayRevisions(delta.revisions, now);
        if (delta.words !== 0 || delta.revisions > 0) this.scheduleSave();
    }

    private scheduleSave(): void {
        if (this.saveTimer !== null) window.clearTimeout(this.saveTimer);
        this.saveTimer = window.setTimeout(() => {
            this.saveTimer = null;
            void this.save();
        }, 800);
    }

    async save(): Promise<void> {
        const payload = JSON.stringify({
            ...this.tracker.exportData(),
            unattributedHistory: this.unattributedHistory,
            unattributedRevisionHistory: this.unattributedRevisionHistory,
        }, null, 2);
        const path = this.getFilePath();
        this.writeQueue = this.writeQueue
            .catch(() => undefined)
            .then(async () => {
                const adapter = this.plugin.app.vault.adapter;
                const tempPath = `${path}.tmp`;
                const backupPath = `${path}.bak`;
                await adapter.write(tempPath, payload);
                if (await adapter.exists(path)) {
                    try { await adapter.write(backupPath, await adapter.read(path)); } catch { /* best effort */ }
                }
                await adapter.write(path, payload);
                await adapter.remove(tempPath).catch(() => undefined);
            });
        try {
            await this.writeQueue;
        } catch (error) {
            console.error('[NarrativeLab] Failed to save writing tracker:', error);
        }
    }
}
