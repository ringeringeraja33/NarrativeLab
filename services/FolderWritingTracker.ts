import { FileView, MarkdownView, TFile, TFolder, normalizePath } from 'obsidian';
import type SceneCardsPlugin from '../main';
import { FolderWritingScope, type FolderScopeConfig } from './FolderWritingScope';
import { parseWritingTrackerFile } from '../utils/writingTrackerHeatmap';
import { WRITING_TRACKER_PANEL_TYPE, WRITING_TRACKER_VIEW_TYPE } from '../constants';
import { t } from '../utils/i18n';

/** Opt-in, vault-local folder scopes. Never creates anything in the source folder. */
export class FolderWritingTracker {
    current: FolderWritingScope | null = null;
    ready = false;
    busy = false;
    error = '';
    private entries: FolderScopeConfig[] = [];
    private loaded = false;
    private invalid = false;
    private recovered = false;
    private stopped = false;
    private loadTask: Promise<void> | null = null;
    private queue: Promise<unknown> = Promise.resolve();
    private writes: Promise<void> = Promise.resolve();
    private saveTimer: number | null = null;
    private refreshTimer: number | null = null;
    private revision = 0;
    constructor(private plugin: SceneCardsPlugin) {}
    get savedScopes(): readonly FolderScopeConfig[] { return this.entries; }
    private get path(): string {
        return normalizePath(`${this.plugin.manifest.dir || `${this.plugin.app.vault.configDir}/plugins/${this.plugin.manifest.id}`}/folder-writing-tracker.json`);
    }
    initialize(): void {
        const { workspace, vault } = this.plugin.app;
        // One event adapter; no folder scans until a scope has been configured.
        this.plugin.registerEvent(workspace.on('editor-change', (editor, info) => {
            const scope = this.current;
            const path = info.file?.path;
            if (!this.ready || !scope || !path || !scope.accepts(path)) return;
            const text = editor.getValue();
            scope.setText(path, text, true);
            this.scheduleSave(); this.notify();
        }));
        this.plugin.registerEvent(workspace.on('file-open', () => this.syncActivity()));
        this.plugin.registerEvent(workspace.on('layout-change', () => this.syncActivity()));
        this.plugin.registerEvent(vault.on('modify', file => {
            if (file instanceof TFile) void this.readInventory(file);
        }));
        this.plugin.registerEvent(vault.on('create', file => {
            if (file instanceof TFile) {
                if (file.stat?.size === 0) this.current?.setText(file.path, '', false);
                void this.readInventory(file);
            }
        }));
        this.plugin.registerEvent(vault.on('delete', file => {
            const scope = this.current;
            if (!scope) return;
            for (const path of [...scope.texts.keys()]) {
                if (path === file.path || path.startsWith(file.path + '/')) scope.remove(path);
            }
            if (scope.config.path === file.path || scope.config.path.startsWith(file.path + '/')) {
                this.ready = false; this.error = t('The tracked folder is unavailable. Its history was kept.');
            }
            this.syncActivity(); this.notify();
        }));
        this.plugin.registerEvent(vault.on('rename', (file, oldPath) => {
            const scope = this.current;
            for (const entry of this.entries) {
                if (entry.path === oldPath || entry.path.startsWith(oldPath + '/')) {
                    entry.path = file.path + entry.path.slice(oldPath.length);
                }
            }
            if (!scope) { this.scheduleSave(); return; }
            if (scope.config.path === oldPath || scope.config.path.startsWith(oldPath + '/')) {
                scope.config.path = file.path + scope.config.path.slice(oldPath.length);
            }
            for (const path of [...scope.texts.keys()]) {
                if (path !== oldPath && !path.startsWith(oldPath + '/')) continue;
                const text = scope.texts.get(path)!;
                scope.remove(path);
                scope.setText(file.path + path.slice(oldPath.length), text, false);
            }
            if (file instanceof TFile) void this.readInventory(file);
            else if (file instanceof TFolder) void this.reconcileInventory();
            this.syncActivity(); this.scheduleSave(); this.notify();
        }));
        workspace.onLayoutReady(() => {
            // Do not hold up workspace restoration for folder indexing.
            window.setTimeout(() => { if (!this.stopped) void this.load().catch(error => this.fail(error)); }, 0);
        });
        const checkpoint = window.setInterval(() => {
            if (this.current?.tracker.isSprintRunning()) this.scheduleSave();
        }, 30_000);
        this.plugin.register(() => {
            this.stopped = true; this.revision++;
            window.clearInterval(checkpoint);
            if (this.saveTimer !== null) window.clearTimeout(this.saveTimer);
            if (this.refreshTimer !== null) window.clearTimeout(this.refreshTimer);
            this.current?.tracker.setProjectFilesOpen(false);
            if (this.loaded && !this.invalid && this.current) void this.save().catch(error => console.error('[WritingLab] Folder stats save failed', error));
        });
    }
    private fail(error: unknown): void {
        this.error = String(error); this.busy = false; this.notify();
        console.error('[WritingLab] Folder statistics:', error);
    }
    private load(): Promise<void> {
        if (this.loadTask) return this.loadTask;
        return this.loadTask = this.loadNow();
    }
    private async loadNow(): Promise<void> {
        const adapter = this.plugin.app.vault.adapter;
        let found = false;
        let selected = '';
        for (const path of [this.path + '.tmp', this.path, this.path + '.bak']) {
            if (!await adapter.exists(path)) continue;
            found = true;
            try {
                const parsed: unknown = JSON.parse(await adapter.read(path));
                if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('Invalid folder statistics');
                const data = parsed as { version?: unknown; scopes?: unknown; selected?: unknown };
                if (data.version !== 1 || !Array.isArray(data.scopes)) throw new Error('Invalid folder statistics');
                const scopes: FolderScopeConfig[] = data.scopes.map((raw: unknown) => {
                    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('Invalid folder scope');
                    const entry = raw as Record<string, unknown>;
                    if (typeof entry.id !== 'string' || typeof entry.path !== 'string' || !entry.path
                        || entry.path.split('/').includes('..') || typeof entry.recursive !== 'boolean'
                        || !entry.tracker || typeof entry.tracker !== 'object' || Array.isArray(entry.tracker)) throw new Error('Invalid folder scope');
                    const tracker = entry.tracker as Record<string, unknown>;
                    if (!tracker.history || typeof tracker.history !== 'object'
                        || Array.isArray(tracker.history)
                        || Object.values(tracker.history).some(value => typeof value !== 'number' || !Number.isFinite(value))) throw new Error('Invalid folder scope');
                    return {
                        id: entry.id,
                        path: entry.path,
                        recursive: entry.recursive,
                        locale: typeof entry.locale === 'string' && entry.locale ? entry.locale : 'auto',
                        tracker: parseWritingTrackerFile(entry.tracker),
                        ...(typeof entry.totalWords === 'number' ? { totalWords: entry.totalWords } : {}),
                        ...(typeof entry.sprintInventoryTotal === 'number' ? { sprintInventoryTotal: entry.sprintInventoryTotal } : {}),
                    };
                });
                this.entries = scopes;
                selected = typeof data.selected === 'string' ? data.selected : '';
                this.loaded = true; this.recovered = path !== this.path; break;
            } catch (error) { console.warn('[WritingLab] Folder statistics recovery:', path, error); }
        }
        if (!this.loaded) {
            this.invalid = found; this.loaded = !found;
            if (found) throw new Error(t('Folder statistics could not be read. Existing records were kept.'));
        }
        const entry = this.entries.find(item => item.id === selected);
        if (entry && !this.stopped) await this.activate(entry);
    }
    async select(path: string, recursive = true): Promise<void> {
        await this.load();
        if (this.invalid) throw new Error(t('Folder statistics could not be read. Existing records were kept.'));
        const normalized = normalizePath(path);
        if (!(this.plugin.app.vault.getAbstractFileByPath(normalized) instanceof TFolder)) throw new Error(t('Choose an existing folder in this vault.'));
        // Serialize choices: a slow previous scan cannot overwrite a newer target.
        const task = this.queue.catch(() => undefined).then(async () => {
            if (this.current) {
                this.current.tracker.stopSprint(this.current.totalWords);
                this.current.tracker.setProjectFilesOpen(false);
                await this.save();
            }
            let entry = this.entries.find(item => item.path === normalized && item.recursive === recursive);
            if (!entry) {
                entry = { id: crypto.randomUUID(), path: normalized, recursive, locale: 'auto', tracker: { history: {} } };
                this.entries.push(entry);
            }
            await this.activate(entry);
            await this.save();
        });
        this.queue = task;
        return task;
    }
    async stop(): Promise<void> {
        await this.load();
        const task = this.queue.catch(() => undefined).then(async () => {
            if (this.current) {
                this.current.tracker.stopSprint(this.current.totalWords);
                this.current.tracker.setProjectFilesOpen(false);
                await this.save();
            }
            this.current = null; this.ready = false; this.revision++;
            await this.save(); this.notify();
        });
        this.queue = task; return task;
    }
    private async activate(entry: FolderScopeConfig): Promise<void> {
        this.revision++; this.ready = false; this.busy = true; this.error = '';
        this.current = new FolderWritingScope({ ...entry }, {
            excludeComments: this.plugin.settings.excludeCommentsFromWordcount !== false,
            excludeChecklists: this.plugin.settings.excludeChecklistFromWordcount === true,
        });
        this.current.tracker.setSprintDuration(Math.max(1, this.plugin.settings.sprintDurationMinutes || 25) * 60_000);
        this.notify();
        try {
            if (!(this.plugin.app.vault.getAbstractFileByPath(entry.path) instanceof TFolder)) throw new Error(t('The tracked folder is unavailable. Its history was kept.'));
            await this.reconcileInventory();
            if (this.stopped) return;
            this.current.tracker.startSession(this.current.totalWords, false);
            this.ready = true; this.syncActivity();
        } catch (error) { this.error = String(error); }
        finally { this.busy = false; this.notify(); }
    }
    private async reconcileInventory(): Promise<void> {
        const scope = this.current, revision = this.revision;
        if (!scope) return;
        const folder = this.plugin.app.vault.getAbstractFileByPath(scope.config.path);
        if (!(folder instanceof TFolder)) return;
        const folders = [folder]; let processed = 0;
        while (folders.length) {
            for (const child of folders.shift()!.children) {
                if (this.stopped || scope !== this.current || revision !== this.revision) return;
                if (child instanceof TFolder && scope.config.recursive && !child.name.startsWith('.')) folders.push(child);
                if (child instanceof TFile && scope.accepts(child.path)) await this.readInventory(child);
                if (++processed % 16 === 0) await new Promise(resolve => window.setTimeout(resolve, 0));
            }
        }
    }
    private editorText(path: string): string | undefined {
        let text: string | undefined;
        this.plugin.app.workspace.iterateAllLeaves(leaf => {
            if (leaf.view instanceof MarkdownView && leaf.view.file?.path === path) text = leaf.view.editor.getValue();
        });
        return text;
    }
    private async readInventory(file: TFile): Promise<void> {
        const scope = this.current, revision = this.revision, path = file.path;
        if (!scope?.accepts(path) || this.stopped) return;
        try {
            const raw = await this.plugin.app.vault.cachedRead(file);
            if (scope !== this.current || revision !== this.revision || file.path !== path
                || this.plugin.app.vault.getAbstractFileByPath(path) !== file) return;
            scope.setText(path, this.editorText(path) ?? raw, false);
            this.notify();
        } catch (error) {
            // A failed read must never turn an existing file's count into zero.
            if (this.busy) throw error;
            this.fail(error);
        }
    }
    syncActivity(): void {
        const scope = this.current;
        if (!scope) return;
        let open = false;
        if (this.ready) this.plugin.app.workspace.iterateAllLeaves(leaf => {
            if (leaf.view instanceof FileView && scope.accepts(leaf.view.file?.path || '')) open = true;
        });
        if (scope.tracker.setProjectFilesOpen(open)) { this.scheduleSave(); this.notify(); }
    }
    scheduleSave(): void {
        if (this.stopped || !this.loaded || this.invalid) return;
        if (this.saveTimer !== null) window.clearTimeout(this.saveTimer);
        this.saveTimer = window.setTimeout(() => {
            this.saveTimer = null;
            void this.save().catch(error => this.fail(error));
        }, 600);
    }
    async save(): Promise<void> {
        if (!this.loaded || this.invalid) return;
        if (this.current) this.entries = this.entries.map(entry => entry.id === this.current!.config.id ? this.current!.snapshot() : entry);
        const payload = JSON.stringify({ version: 1, selected: this.current?.config.id || '', scopes: this.entries }, null, 2);
        const task = this.writes.catch(() => undefined).then(async () => {
            const adapter = this.plugin.app.vault.adapter;
            await adapter.write(this.path + '.tmp', payload);
            if (!this.recovered && await adapter.exists(this.path)) await adapter.write(this.path + '.bak', await adapter.read(this.path));
            await adapter.write(this.path, payload);
            await adapter.remove(this.path + '.tmp');
            this.recovered = false;
        });
        this.writes = task; return task;
    }
    private notify(): void {
        if (this.stopped || this.refreshTimer !== null) return;
        this.refreshTimer = window.setTimeout(() => {
            this.refreshTimer = null;
            for (const type of [WRITING_TRACKER_PANEL_TYPE, WRITING_TRACKER_VIEW_TYPE]) {
                for (const leaf of this.plugin.app.workspace.getLeavesOfType(type)) (leaf.view as {refresh?: () => void}).refresh?.();
            }
        }, 250);
    }
}
