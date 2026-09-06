import { FuzzySuggestModal, Notice, TFolder, type App } from 'obsidian';
import type SceneCardsPlugin from '../main';
import type { FolderScopeConfig } from '../services/FolderWritingScope';
import { t } from '../utils/i18n';

export class FolderTrackerPicker extends FuzzySuggestModal<TFolder> {
    constructor(app: App, private select: (folder: TFolder) => void) {
        super(app); this.setPlaceholder(t('Choose an existing folder in this vault.'));
    }
    getItems(): TFolder[] { return this.app.vault.getAllLoadedFiles().filter((file): file is TFolder => file instanceof TFolder && !file.path.split('/').some(part => part.startsWith('.'))); }
    getItemText(folder: TFolder): string { return folder.path; }
    onChooseItem(folder: TFolder): void { this.select(folder); }
}

function folderLeafName(path: string): string {
    return path.replace(/\/+$/, '').split('/').pop() || path;
}

function scopeLabel(entry: FolderScopeConfig): string {
    return entry.path + (entry.recursive ? ` · ${t('Include subfolders')}` : '');
}

export function renderFolderTrackerControls(parent: HTMLElement, plugin: SceneCardsPlugin): void {
    const service = plugin.folderWritingTracker;
    const card = parent.createDiv('nl-folder-tracker');
    const choose = (path: string, recursive = true) => {
        void service.select(path, recursive).catch(error => new Notice(String(error)));
    };
    const pickFolder = () => new FolderTrackerPicker(plugin.app, folder => choose(folder.path)).open();
    const current = service.current;

    if (current) {
        const recording = service.ready && current.tracker.isProjectFilesOpen();
        const head = card.createDiv('nl-folder-tracker-head');
        const identity = head.createDiv('nl-folder-tracker-identity');
        identity.createDiv({ cls: 'nl-folder-tracker-name', text: folderLeafName(current.config.path) });
        if (folderLeafName(current.config.path) !== current.config.path) {
            identity.createDiv({ cls: 'nl-folder-tracker-path', text: current.config.path });
        }
        const status = head.createDiv({
            cls: 'nl-folder-tracker-status' + (service.busy ? '' : recording ? ' is-recording' : ' is-paused'),
            text: service.busy ? t('Indexing folder...') : recording ? t('Recording this folder') : t('Paused'),
        });
        status.setAttr('title', recording
            ? t('Only this folder records new writing. Other saved folders keep history but are not counting.')
            : t('Open a note in this folder to record. Other saved folders are not counting.'));

        const meta = card.createDiv('nl-folder-tracker-meta');
        meta.createSpan({
            text: service.ready
                ? t('{n} documents · {words} words', { n: current.texts.size, words: current.totalWords.toLocaleString() })
                : t('Indexing folder...'),
        });
        const row = meta.createEl('label', {
            cls: 'nl-folder-tracker-recursive',
            attr: { title: t('Subfolder and single-folder scopes keep separate histories.') },
        });
        const checkbox = row.createEl('input', { type: 'checkbox' });
        checkbox.checked = current.config.recursive;
        checkbox.disabled = service.busy;
        row.createSpan({ text: t('Include subfolders') });
        checkbox.addEventListener('change', () => choose(current.config.path, checkbox.checked));

        card.createEl('p', {
            cls: 'nl-folder-tracker-hint',
            text: recording
                ? t('Only this folder records new writing. Other saved folders keep history but are not counting.')
                : t('Open a note in this folder to record. Other saved folders are not counting.'),
        });

        const actions = card.createDiv('nl-folder-tracker-actions');
        if (service.savedScopes.length > 1) {
            const select = actions.createEl('select', { attr: { 'aria-label': t('Tracked folder') } });
            for (const entry of service.savedScopes) {
                select.createEl('option', { text: scopeLabel(entry), attr: { value: entry.id } });
            }
            select.value = current.config.id;
            select.disabled = service.busy;
            select.addEventListener('change', () => {
                const entry = service.savedScopes.find(item => item.id === select.value);
                if (entry) choose(entry.path, entry.recursive);
            });
        }
        const add = actions.createEl('button', { text: t('Track another folder'), attr: { type: 'button' } });
        add.disabled = service.busy;
        add.addEventListener('click', pickFolder);
        const stop = actions.createEl('button', { text: t('Stop folder tracking'), attr: { type: 'button' } });
        stop.disabled = service.busy;
        stop.addEventListener('click', () => { void service.stop().catch(error => new Notice(String(error))); });
    } else {
        const head = card.createDiv('nl-folder-tracker-head');
        head.createDiv({ cls: 'nl-folder-tracker-name', text: t('No folder selected') });
        head.createDiv({ cls: 'nl-folder-tracker-status is-idle', text: t('Not tracking') });
        card.createEl('p', {
            cls: 'nl-folder-tracker-hint',
            text: t('No folder is recording new writing. Saved folders keep their history; select one to continue counting.'),
        });
        if (service.savedScopes.length) {
            const list = card.createDiv('nl-folder-tracker-saved');
            list.createSpan({ cls: 'nl-folder-tracker-saved-label', text: t('Resume tracking') });
            for (const entry of service.savedScopes) {
                const resume = list.createEl('button', { text: scopeLabel(entry), attr: { type: 'button' } });
                resume.disabled = service.busy;
                resume.addEventListener('click', () => choose(entry.path, entry.recursive));
            }
        }
        const start = card.createEl('button', { text: t('Track a folder'), cls: 'mod-cta', attr: { type: 'button' } });
        start.disabled = service.busy;
        start.addEventListener('click', pickFolder);
    }

    card.createEl('p', {
        cls: 'nl-folder-tracker-footnote',
        text: t('Existing text is not counted as new writing. Each folder scope keeps its own history.'),
    });
    if (service.error) card.createEl('p', { cls: 'nl-tracker-empty', text: service.error });
}
