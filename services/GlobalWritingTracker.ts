import { normalizePath } from 'obsidian';
import type SceneCardsPlugin from '../main';
import { WritingTracker } from './WritingTracker';
import { deriveProjectFoldersFromFilePath } from '../models/StoryLineProject';
import {
    parseWritingTrackerFile,
    parseWritingTrackerDate,
    reconcileDerivedTrackerHistory,
    WRITING_TRACKER_FILENAME,
} from '../utils/writingTrackerHeatmap';
import type { WritingTrackerData } from './WritingTracker';
import { t } from '../utils/i18n';

export interface WritingHistoryAssignmentResult {
    dates: number;
    words: number;
    revisions: number;
    projectTitle: string;
}

export interface WritingWordCorrectionResult {
    date: string;
    words: number;
    projectTitle: string;
}

/**
 * Vault-wide net-word ledger, stored beside the plugin (not in a project
 * System/ folder) so switching books cannot wipe or mix the heatmap.
 */
export class GlobalWritingTracker {
    readonly tracker = new WritingTracker();
    private writeQueue: Promise<void> = Promise.resolve();
    private saveTimer: number | null = null;
    private loaded = false;
    private invalidFile = false;
    private loadedFromBackup = false;
    private unattributedHistory: Record<string, number> = {};
    private unattributedRevisionHistory: Record<string, number> = {};
    private mutatingLedger = false;

    constructor(private plugin: SceneCardsPlugin) {}

    getFilePath(): string {
        const dir = this.plugin.manifest.dir
            || `${this.plugin.app.vault.configDir}/plugins/${this.plugin.manifest.id}`;
        return normalizePath(`${dir}/${WRITING_TRACKER_FILENAME}`);
    }

    async load(): Promise<void> {
        const adapter = this.plugin.app.vault.adapter;
        const path = this.getFilePath();
        this.loaded = false;
        this.invalidFile = false;
        this.loadedFromBackup = false;
        // A leftover temp file is the fully staged payload from an interrupted
        // safe write, so prefer it over the older canonical ledger.
        let foundCandidate = false;
        for (const candidate of [`${path}.tmp`, path, `${path}.bak`]) {
            try {
                if (!await adapter.exists(candidate)) continue;
                foundCandidate = true;
                const raw = JSON.parse(await adapter.read(candidate)) as unknown;
                if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
                    throw new Error('invalid writing tracker object');
                }
                const parsed = parseWritingTrackerFile(raw);
                this.tracker.importData(parsed);
                this.unattributedHistory = parsed.unattributedHistory;
                this.unattributedRevisionHistory = parsed.unattributedRevisionHistory;
                this.invalidFile = false;
                this.loadedFromBackup = candidate !== path;
                this.loaded = true;
                break;
            } catch (error) {
                console.error(`[NarrativeLab] Failed to load writing tracker from ${candidate}:`, error);
            }
        }
        if (!this.loaded) {
            this.invalidFile = foundCandidate;
            this.loadedFromBackup = false;
            this.loaded = !foundCandidate;
            if (!foundCandidate) {
                this.tracker.importData({ history: {} });
                this.unattributedHistory = {};
                this.unattributedRevisionHistory = {};
            }
        }
    }

    /** Rebuild vault totals from project ledgers and quarantine legacy-only dates. */
    async reconcileProjectLedgers(): Promise<boolean> {
        if (!this.loaded) return false;
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
                const rawValue = JSON.parse(await adapter.read(path)) as unknown;
                if (!rawValue || typeof rawValue !== 'object' || Array.isArray(rawValue)) {
                    throw new Error('invalid stats object');
                }
                const raw = rawValue as Record<string, unknown>;
                if (raw.writingTrackerData !== undefined
                    && (!raw.writingTrackerData
                        || typeof raw.writingTrackerData !== 'object'
                        || Array.isArray(raw.writingTrackerData))) {
                    throw new Error('invalid writing tracker data');
                }
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
        if (!complete) return false;
        if (!found) return true;
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
        return this.save();
    }

    getUnattributedWordTotal(): number {
        return Object.values(this.unattributedHistory).reduce((sum, words) => sum + words, 0);
    }

    getUnattributedEntryCount(): number {
        return new Set([
            ...Object.keys(this.unattributedHistory),
            ...Object.keys(this.unattributedRevisionHistory),
        ]).size;
    }

    getUnattributedRevisionTotal(): number {
        return Object.values(this.unattributedRevisionHistory).reduce((sum, words) => sum + words, 0);
    }

    async assignUnattributedToProject(projectFilePath: string): Promise<WritingHistoryAssignmentResult> {
        return this.runLedgerMutation(async () => {
            if (!await this.reconcileProjectLedgers()) {
                throw new Error(t('One or more project stats files could not be read. Assignment was cancelled.'));
            }
            const history = { ...this.unattributedHistory };
            const revisionHistory = { ...this.unattributedRevisionHistory };
            const dates = new Set([...Object.keys(history), ...Object.keys(revisionHistory)]).size;
            if (dates === 0) throw new Error(t('There are no unattributed statistics to assign.'));
            const { target, project, statsPayload, storedTracker } = await this.loadProjectTracker(projectFilePath);
            storedTracker.mergePersistedHistory(history, revisionHistory);

            await this.plugin.applyWritingTrackerHistoryDelta(
                target,
                history,
                revisionHistory,
                statsPayload,
                storedTracker.exportData(),
            );

            // The project write completed. Update the live vault ledger and remove
            // the recovery copies; a later project reconciliation remains idempotent.
            this.tracker.mergePersistedHistory(history, revisionHistory);
            for (const date of Object.keys(history)) delete this.unattributedHistory[date];
            for (const date of Object.keys(revisionHistory)) delete this.unattributedRevisionHistory[date];
            if (!await this.save()) {
                throw new Error(t('Statistics were assigned to the project, but the vault ledger update failed. Reload NarrativeLab before trying again.'));
            }

            return {
                dates,
                words: Object.values(history).reduce((sum, words) => sum + words, 0),
                revisions: Object.values(revisionHistory).reduce((sum, words) => sum + words, 0),
                projectTitle: project.title,
            };
        });
    }

    async applyProjectWordCorrection(
        projectFilePath: string,
        date: string,
        words: number,
    ): Promise<WritingWordCorrectionResult> {
        return this.runLedgerMutation(async () => {
            if (!parseWritingTrackerDate(date)) throw new Error(t('Choose a valid correction date.'));
            const amount = Math.round(words);
            if (!Number.isFinite(amount) || amount === 0) {
                throw new Error(t('Enter a non-zero whole-word correction.'));
            }
            if (!await this.reconcileProjectLedgers()) {
                throw new Error(t('One or more project stats files could not be read. Correction was cancelled.'));
            }
            const { target, project, statsPayload, storedTracker } = await this.loadProjectTracker(projectFilePath);
            const history = { [date]: amount };
            storedTracker.mergePersistedHistory(history);
            await this.plugin.applyWritingTrackerHistoryDelta(
                target,
                history,
                {},
                statsPayload,
                storedTracker.exportData(),
            );
            this.tracker.mergePersistedHistory(history);
            if (!await this.save()) {
                throw new Error(t('The project correction was written, but the vault ledger update failed. Reload NarrativeLab before trying again.'));
            }
            return { date, words: amount, projectTitle: project.title };
        });
    }

    async deleteUnattributedHistory(): Promise<{ dates: number; words: number; revisions: number }> {
        return this.runLedgerMutation(async () => {
            const dates = this.getUnattributedEntryCount();
            if (dates === 0) throw new Error(t('There is no excluded writing history to delete.'));
            const words = this.getUnattributedWordTotal();
            const revisions = this.getUnattributedRevisionTotal();
            const previousHistory = this.unattributedHistory;
            const previousRevisions = this.unattributedRevisionHistory;
            this.unattributedHistory = {};
            this.unattributedRevisionHistory = {};
            if (!await this.save()) {
                this.unattributedHistory = previousHistory;
                this.unattributedRevisionHistory = previousRevisions;
                throw new Error(t('The unattributed statistics could not be saved as deleted. Nothing was changed.'));
            }
            return { dates, words, revisions };
        });
    }

    private async runLedgerMutation<T>(operation: () => Promise<T>): Promise<T> {
        if (this.mutatingLedger) throw new Error(t('A word count correction is already running.'));
        this.mutatingLedger = true;
        try {
            return await operation();
        } finally {
            this.mutatingLedger = false;
        }
    }

    private async loadProjectTracker(projectFilePath: string): Promise<{
        target: string;
        project: ReturnType<SceneCardsPlugin['sceneManager']['getProjects']>[number];
        statsPayload: Record<string, unknown>;
        storedTracker: WritingTracker;
    }> {
        const target = normalizePath(projectFilePath);
        const project = this.plugin.sceneManager.getProjects()
            .find(candidate => normalizePath(candidate.filePath) === target);
        if (!project) throw new Error(t('The selected project is no longer available.'));
        const adapter = this.plugin.app.vault.adapter;
        if (!await adapter.exists(target)) throw new Error(t('The selected project is no longer available.'));

        const base = deriveProjectFoldersFromFilePath(target).baseFolder;
        const statsPath = normalizePath(`${base}/System/stats.json`);
        let statsPayload: Record<string, unknown> = {};
        if (await adapter.exists(statsPath)) {
            try {
                const parsed = JSON.parse(await adapter.read(statsPath)) as unknown;
                if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('invalid object');
                statsPayload = parsed as Record<string, unknown>;
                if (statsPayload.writingTrackerData !== undefined
                    && (!statsPayload.writingTrackerData
                        || typeof statsPayload.writingTrackerData !== 'object'
                        || Array.isArray(statsPayload.writingTrackerData))) {
                    throw new Error('invalid writing tracker data');
                }
            } catch {
                throw new Error(t('The project stats file could not be read. Nothing was changed.'));
            }
        }

        const storedTracker = new WritingTracker();
        const rawTracker = statsPayload.writingTrackerData;
        storedTracker.importData(
            rawTracker && typeof rawTracker === 'object' && !Array.isArray(rawTracker)
                ? rawTracker as WritingTrackerData
                : { history: {} },
        );
        return { target, project, statsPayload, storedTracker };
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

    async save(): Promise<boolean> {
        if (this.invalidFile) {
            console.error('[NarrativeLab] Refusing to overwrite an unreadable writing tracker ledger.');
            return false;
        }
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
                if (!this.loadedFromBackup && await adapter.exists(path)) {
                    try { await adapter.write(backupPath, await adapter.read(path)); } catch { /* best effort */ }
                }
                await adapter.write(path, payload);
                await adapter.remove(tempPath).catch(() => undefined);
                this.loadedFromBackup = false;
            });
        try {
            await this.writeQueue;
            return true;
        } catch (error) {
            console.error('[NarrativeLab] Failed to save writing tracker:', error);
            return false;
        }
    }
}
