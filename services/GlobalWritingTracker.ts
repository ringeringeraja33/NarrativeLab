import { normalizePath } from 'obsidian';
import type SceneCardsPlugin from '../main';
import { WritingTracker, type WritingTrackerData } from './WritingTracker';
import {
    parseWritingTrackerFile,
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
            }
        } catch (error) {
            console.error('[NarrativeLab] Failed to load writing tracker:', error);
        }
        this.loaded = true;
    }

    /** First run: copy the active project's history so the heatmap is not blank. */
    seedFromProjectIfEmpty(data: WritingTrackerData | undefined): void {
        if (!this.loaded) return;
        const existing = this.tracker.getFullHistory();
        if (Object.keys(existing).length > 0) return;
        if (!data?.history || Object.keys(data.history).length === 0) return;
        this.tracker.importData(data);
        void this.save();
    }

    recordFlush(delta: { words: number; revisions: number }): void {
        if (delta.words > 0) this.tracker.addTodayWords(delta.words);
        if (delta.revisions > 0) this.tracker.addTodayRevisions(delta.revisions);
        if (delta.words > 0 || delta.revisions > 0) this.scheduleSave();
    }

    private scheduleSave(): void {
        if (this.saveTimer !== null) window.clearTimeout(this.saveTimer);
        this.saveTimer = window.setTimeout(() => {
            this.saveTimer = null;
            void this.save();
        }, 800);
    }

    async save(): Promise<void> {
        const payload = JSON.stringify(this.tracker.exportData(), null, 2);
        const path = this.getFilePath();
        this.writeQueue = this.writeQueue
            .catch(() => undefined)
            .then(async () => {
                await this.plugin.app.vault.adapter.write(path, payload);
            });
        try {
            await this.writeQueue;
        } catch (error) {
            console.error('[NarrativeLab] Failed to save writing tracker:', error);
        }
    }
}
