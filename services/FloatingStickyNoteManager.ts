import { Notice, normalizePath, Platform, TFile } from 'obsidian';
import type SceneCardsPlugin from '../main';
import { FloatingStickyNote } from '../components/FloatingStickyNote';
import { t } from '../utils/i18n';
import {
    FLOATING_NOTE_CLASS,
    FLOATING_NOTES_FILENAME,
    FLOATING_NOTES_HIDDEN_CLASS,
    isFloatingStickyNoteState,
    parseFloatingStickyNotes,
    stickyNoteBelongsToProject,
    type FloatingStickyNoteState,
} from '../utils/floatingStickyNote';

/**
 * Persists floating sticky notes beside the plugin (not in data.json) and
 * keeps desktop windows in sync — same split as Web Novel Assistant.
 */
export class FloatingStickyNoteManager {
    activeNotes: FloatingStickyNote[] = [];
    private notes: FloatingStickyNoteState[] = [];
    private writeQueue: Promise<void> = Promise.resolve();
    private saveTimer: number | null = null;
    private unloading = false;
    private invalidFile = false;
    private loadedFromBackup = false;

    constructor(private plugin: SceneCardsPlugin) {}

    getNotesFilePath(): string {
        const dir = this.plugin.manifest.dir
            || `${this.plugin.app.vault.configDir}/plugins/${this.plugin.manifest.id}`;
        return normalizePath(`${dir}/${FLOATING_NOTES_FILENAME}`);
    }

    async load(): Promise<FloatingStickyNoteState[]> {
        const adapter = this.plugin.app.vault.adapter;
        const path = this.getNotesFilePath();
        let foundCandidate = false;
        for (const candidate of [`${path}.tmp`, path, `${path}.bak`]) {
            try {
                if (!await adapter.exists(candidate)) continue;
                foundCandidate = true;
                const raw = JSON.parse(await adapter.read(candidate)) as unknown;
                if (!Array.isArray(raw) || !raw.every(isFloatingStickyNoteState)) {
                    throw new Error('invalid floating sticky-note data');
                }
                this.notes = parseFloatingStickyNotes(raw);
                this.invalidFile = false;
                // Any fallback source means the canonical file was not the
                // trusted source; do not copy it over the recovery backup.
                this.loadedFromBackup = candidate !== path;
                this.applyHiddenClass();
                return this.notes;
            } catch (error) {
                console.error(`[NarrativeLab] Failed to load floating sticky notes from ${candidate}:`, error);
            }
        }
        this.notes = [];
        this.invalidFile = foundCandidate;
        this.loadedFromBackup = false;
        this.applyHiddenClass();
        return this.notes;
    }

    getNotes(): FloatingStickyNoteState[] {
        return this.notes;
    }

    rememberNote(note: FloatingStickyNote): void {
        if (!this.activeNotes.includes(note)) this.activeNotes.push(note);
    }

    forgetNote(note: FloatingStickyNote): void {
        this.activeNotes = this.activeNotes.filter(item => item !== note);
    }

    ensureStored(state: FloatingStickyNoteState): void {
        if (this.notes.some(note => note.id === state.id)) return;
        this.notes.push({ ...state });
        void this.saveNotes(this.notes);
    }

    updateNote(state: FloatingStickyNoteState, debounceSave = false): void {
        const index = this.notes.findIndex(note => note.id === state.id);
        if (index >= 0) this.notes[index] = { ...state };
        else this.notes.push({ ...state });
        if (debounceSave) {
            if (this.saveTimer !== null) window.clearTimeout(this.saveTimer);
            this.saveTimer = window.setTimeout(() => {
                this.saveTimer = null;
                void this.saveNotes(this.notes);
            }, 500);
            return;
        }
        void this.saveNotes(this.notes);
    }

    removeNote(id: string): void {
        this.notes = this.notes.filter(note => note.id !== id);
        void this.saveNotes(this.notes);
    }

    async saveNotes(notes: FloatingStickyNoteState[]): Promise<void> {
        if (this.invalidFile) {
            console.error('[NarrativeLab] Refusing to overwrite unreadable floating sticky-note data.');
            return;
        }
        const snapshot = notes.map(note => ({ ...note }));
        this.notes = snapshot;
        const content = JSON.stringify(snapshot, null, 2);
        this.writeQueue = this.writeQueue.then(async () => {
            if (this.unloading) return;
            try {
                const adapter = this.plugin.app.vault.adapter;
                const path = this.getNotesFilePath();
                const tempPath = `${path}.tmp`;
                const backupPath = `${path}.bak`;
                await adapter.write(tempPath, content);
                if (!this.loadedFromBackup && await adapter.exists(path)) {
                    await adapter.write(backupPath, await adapter.read(path));
                }
                await adapter.write(path, content);
                await adapter.remove(tempPath).catch(() => undefined);
                this.loadedFromBackup = false;
            } catch (error) {
                console.error('[NarrativeLab] Failed to save floating sticky notes:', error);
            }
        }, () => undefined);
        return this.writeQueue;
    }

    async flush(): Promise<void> {
        if (this.saveTimer !== null) {
            window.clearTimeout(this.saveTimer);
            this.saveTimer = null;
            await this.saveNotes(this.notes);
        }
        await this.writeQueue;
    }

    applyHiddenClass(): void {
        const hidden = this.plugin.settings.showFloatingStickyNotes === false;
        activeDocument.body.toggleClass(FLOATING_NOTES_HIDDEN_CLASS, hidden);
    }

    async toggleVisibility(): Promise<void> {
        this.plugin.settings.showFloatingStickyNotes = this.plugin.settings.showFloatingStickyNotes === false;
        this.applyHiddenClass();
        await this.plugin.saveSettings();
        if (this.plugin.settings.showFloatingStickyNotes !== false && this.activeNotes.length === 0) {
            this.restoreFloatingNotes();
        }
        new Notice(this.plugin.settings.showFloatingStickyNotes === false
            ? t('Sticky notes hidden')
            : t('Sticky notes shown'));
    }

    restoreFloatingNotes(): void {
        this.syncVisibleNotesForProject(this.plugin.sceneManager.activeProject?.filePath ?? null);
    }

    /** Show only this book's notes; legacy notes without `projectFile` stay visible. */
    syncVisibleNotesForProject(projectFile: string | null): void {
        if (!Platform.isDesktop || this.unloading) return;
        this.applyHiddenClass();
        const visible = this.notes.filter(note => stickyNoteBelongsToProject(note, projectFile));
        const ids = new Set(visible.map(note => note.id));
        for (const note of [...this.activeNotes]) {
            if (!ids.has(note.state.id)) note.destroy();
        }
        const activeIds = new Set(this.activeNotes.map(note => note.state.id));
        for (const state of visible) {
            if (activeIds.has(state.id)) {
                this.activeNotes.find(note => note.state.id === state.id)?.updateFromState(state);
                continue;
            }
            const note = new FloatingStickyNote(this.plugin.app, this.plugin, { state });
            note.load();
        }
    }

    applyVisuals(): void {
        for (const note of this.activeNotes) note.updateVisuals();
    }

    createStickyNote(options: { file?: TFile; content?: string; title?: string } = {}): void {
        if (!Platform.isDesktop) {
            new Notice(t('Floating sticky notes are available on desktop.'));
            return;
        }
        if (this.plugin.settings.showFloatingStickyNotes === false) {
            this.plugin.settings.showFloatingStickyNotes = true;
            this.applyHiddenClass();
            void this.plugin.saveSettings();
        }
        const note = new FloatingStickyNote(this.plugin.app, this.plugin, options);
        note.load();
    }

    async createNoteFile(fullPath: string, content: string): Promise<TFile> {
        const normalized = normalizePath(fullPath);
        const slash = normalized.lastIndexOf('/');
        if (slash > 0) await this.ensureFolder(normalized.slice(0, slash));
        return this.plugin.app.vault.create(normalized, content);
    }

    async unloadAll(): Promise<void> {
        for (const note of this.activeNotes) {
            if (note.state.isEditing && note.textareaEl) {
                note.state.content = note.textareaEl.value;
            }
            this.updateNote(note.state);
        }
        await this.flush();
        this.unloading = true;
        for (const note of [...this.activeNotes]) note.destroy();
        activeDocument.querySelectorAll(`.${FLOATING_NOTE_CLASS}`).forEach(el => el.remove());
        activeDocument.body.removeClass(FLOATING_NOTES_HIDDEN_CLASS);
    }

    private async ensureFolder(folderPath: string): Promise<void> {
        const parts = normalizePath(folderPath).split('/').filter(Boolean);
        let current = '';
        for (const part of parts) {
            current = current ? `${current}/${part}` : part;
            if (this.plugin.app.vault.getAbstractFileByPath(current)) continue;
            try {
                await this.plugin.app.vault.createFolder(current);
            } catch {
                /* created concurrently */
            }
        }
    }
}
