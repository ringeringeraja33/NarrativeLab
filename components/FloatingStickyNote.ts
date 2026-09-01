import {
    AbstractInputSuggest,
    App,
    Component,
    DropdownComponent,
    MarkdownRenderer,
    Modal,
    Notice,
    Platform,
    Setting,
    TFile,
    TFolder,
    TextComponent,
    normalizePath,
    setIcon,
} from 'obsidian';
import type SceneCardsPlugin from '../main';
import { deriveProjectFoldersFromFilePath } from '../models/StoryLineProject';
import { resolveStickyNoteColors, resolveStickyNoteFontColor } from '../settings';
import { t } from '../utils/i18n';
import {
    FLOATING_NOTE_CLASS,
    clampStickyNoteOpacity,
    clampStickyNoteZoom,
    hexToRgba,
    joinVaultMarkdownPath,
    nextStickyNoteColor,
    shouldPromptStickyNoteClose,
    staggerStickyNoteOrigin,
    type FloatingStickyNoteState,
} from '../utils/floatingStickyNote';

/**
 * Workspace-level floating sticky note.
 *
 * Mounts on the main workspace `body` (not inside a leaf), matching Web Novel
 * Assistant: drag the header, resize from the corner, Ctrl/Cmd+wheel to zoom,
 * pin to lock geometry, palette from corkboard colours, Markdown preview.
 */
export class FloatingStickyNote extends Component {
    app: App;
    plugin: SceneCardsPlugin;
    state: FloatingStickyNoteState;
    containerEl!: HTMLElement;
    contentContainer!: HTMLDivElement;
    textareaEl!: HTMLTextAreaElement;
    lastSavedContent = '';
    private resizeObserver: ResizeObserver | null = null;
    private resizeTimer: number | null = null;
    private inputTimer: number | null = null;
    private unloaded = false;
    private dragMove: ((e: MouseEvent) => void) | null = null;
    private dragUp: (() => void) | null = null;
    private static frontZ = 40;

    constructor(
        app: App,
        plugin: SceneCardsPlugin,
        options: { file?: TFile; content?: string; title?: string; state?: FloatingStickyNoteState },
    ) {
        super();
        this.app = app;
        this.plugin = plugin;

        if (options.state) {
            this.state = { ...options.state };
            this.state.zoomLevel = clampStickyNoteZoom(this.state.zoomLevel ?? 1);
            if (!this.state.textColor) this.state.textColor = '#111111';
        } else {
            const palette = resolveStickyNoteColors(this.plugin.settings);
            const picked = nextStickyNoteColor(palette, this.plugin.settings.nextFloatingStickyNoteColorIndex ?? 0);
            const origin = staggerStickyNoteOrigin(this.plugin.floatingStickyNotes.activeNotes.length);
            this.state = {
                id: crypto.randomUUID().slice(0, 8),
                projectFile: this.plugin.sceneManager.activeProject?.filePath
                    ? normalizePath(this.plugin.sceneManager.activeProject.filePath)
                    : undefined,
                filePath: options.file?.path,
                content: options.content || '',
                title: options.title || (options.file ? options.file.basename : t('Sticky note')),
                top: origin.top,
                left: origin.left,
                width: '320px',
                height: '420px',
                color: picked.color,
                textColor: resolveStickyNoteFontColor(this.plugin.settings, picked.color),
                isEditing: !options.file && !options.content,
                isPinned: false,
                zoomLevel: 1,
            };
            this.plugin.settings.nextFloatingStickyNoteColorIndex = picked.nextIndex;
            void this.plugin.saveSettings();
        }
        this.lastSavedContent = this.state.content || '';
    }

    destroy(): void {
        this.unload();
    }

    updateFromState(next: FloatingStickyNoteState): void {
        this.state = { ...this.state, ...next };
        this.lastSavedContent = this.state.content || '';
        if (this.textareaEl && activeDocument.activeElement !== this.textareaEl
            && this.textareaEl.value !== (this.state.content || '')) {
            this.textareaEl.value = this.state.content || '';
        }
        const titleEl = this.containerEl?.querySelector('.nl-floating-sticky-title');
        if (titleEl && titleEl.instanceOf(HTMLElement) && this.state.title) {
            titleEl.setText(this.state.title);
        }
        this.updateVisuals();
    }

    onunload(): void {
        this.unloaded = true;
        this.cleanupDragging();
        if (this.resizeObserver) {
            this.resizeObserver.disconnect();
            this.resizeObserver = null;
        }
        if (this.resizeTimer !== null) {
            window.clearTimeout(this.resizeTimer);
            this.resizeTimer = null;
        }
        if (this.inputTimer !== null) {
            window.clearTimeout(this.inputTimer);
            this.inputTimer = null;
        }
        this.containerEl?.remove();
        this.plugin.floatingStickyNotes.forgetNote(this);
    }

    onload(): void {
        if (!Platform.isDesktop) return;
        this.plugin.floatingStickyNotes.rememberNote(this);

        const mainDoc = this.app.workspace.containerEl?.ownerDocument || activeDocument;
        const modalEl = mainDoc.body.querySelector('.modal-container, .modal.mod-settings');
        this.containerEl = mainDoc.body.createDiv({ cls: `${FLOATING_NOTE_CLASS} story-line-floating-sticky-note` });
        if (modalEl) mainDoc.body.insertBefore(this.containerEl, modalEl);
        else mainDoc.body.prepend(this.containerEl);

        // Apply the note palette and build its surface before any vault I/O can
        // yield. Otherwise the newly inserted element can briefly paint with
        // the host theme's default (white) form-field background.
        this.updateVisuals();
        const onWheel = (e: WheelEvent) => {
            if (!e.ctrlKey && !e.metaKey) return;
            e.preventDefault();
            e.stopPropagation();
            const delta = e.deltaY < 0 ? 0.1 : -0.1;
            this.state.zoomLevel = clampStickyNoteZoom((this.state.zoomLevel || 1) + delta);
            this.updateVisuals();
            this.persist();
        };
        this.containerEl.addEventListener('wheel', onWheel, { passive: false });
        this.register(() => this.containerEl.removeEventListener('wheel', onWheel));
        this.registerDomEvent(this.containerEl, 'mousedown', () => this.bringToFront());
        this.createChrome();

        void (async () => {
            if (this.state.filePath && !this.state.content) {
                const file = this.app.vault.getAbstractFileByPath(this.state.filePath);
                if (file instanceof TFile) {
                    this.state.content = await this.app.vault.read(file);
                }
            }
            if (this.unloaded) return;
            this.lastSavedContent = this.state.content || '';
            await this.renderContent();
            this.plugin.floatingStickyNotes.ensureStored(this.state);
        })();
    }

    private createChrome(): void {
        const headerEl = this.containerEl.createDiv({ cls: 'nl-floating-sticky-header' });
        const titleWrapper = headerEl.createDiv({ cls: 'nl-floating-sticky-title-wrapper' });
        const titleIcon = titleWrapper.createSpan({ cls: 'nl-floating-sticky-title-icon' });
        setIcon(titleIcon, 'sticky-note');
        titleWrapper.createSpan({ text: this.state.title || '', cls: 'nl-floating-sticky-title' });

        const controlsEl = headerEl.createDiv({ cls: 'nl-floating-sticky-controls' });
        const pinBtn = this.iconButton(controlsEl, 'pin', this.state.isPinned === true, t('Pin sticky note'));
        const saveBtn = this.iconButton(controlsEl, 'save', false, t('Save to note'));
        const syncBtn = this.state.filePath
            ? this.iconButton(controlsEl, 'refresh-cw', false, t('Sync from file'))
            : null;
        const toggleEditBtn = this.iconButton(
            controlsEl,
            this.state.isEditing ? 'eye' : 'pencil',
            false,
            this.state.isEditing ? t('Preview') : t('Edit'),
        );
        const paletteBtn = this.iconButton(controlsEl, 'palette', false, t('Color'));
        paletteBtn.addClass('nl-floating-sticky-palette-target');
        const closeBtn = controlsEl.createEl('button', {
            cls: 'nl-floating-sticky-close',
            attr: { type: 'button', 'aria-label': t('Close') },
        });
        setIcon(closeBtn, 'x');

        this.contentContainer = this.containerEl.createDiv({ cls: 'nl-floating-sticky-content markdown-rendered' });
        this.contentContainer.tabIndex = -1;
        this.textareaEl = this.containerEl.createEl('textarea', {
            cls: 'nl-floating-sticky-textarea',
            attr: { spellcheck: 'false' },
        });

        const stopBubble = (e: Event) => e.stopPropagation();
        this.textareaEl.addEventListener('keydown', stopBubble);
        this.textareaEl.addEventListener('keyup', stopBubble);
        this.textareaEl.addEventListener('mousedown', stopBubble);
        this.textareaEl.addEventListener('input', () => {
            this.state.content = this.textareaEl.value;
            this.plugin.floatingStickyNotes.updateNote(this.state, true);
            const dirty = this.textareaEl.value !== this.lastSavedContent;
            saveBtn.toggleClass('is-active', dirty && !this.plugin.settings.floatingStickyNoteAutoSave);
            if (!this.plugin.settings.floatingStickyNoteAutoSave) return;
            if (this.inputTimer !== null) window.clearTimeout(this.inputTimer);
            this.inputTimer = window.setTimeout(() => {
                this.inputTimer = null;
                this.state.content = this.textareaEl.value;
                this.persist();
                if (this.state.filePath) {
                    const file = this.app.vault.getAbstractFileByPath(this.state.filePath);
                    if (file instanceof TFile) {
                        void this.app.vault.process(file, () => this.state.content || '');
                        this.lastSavedContent = this.state.content || '';
                    }
                }
                saveBtn.removeClass('is-active');
            }, 500);
        });

        const popupEl = this.createPalette(controlsEl);
        this.bindControls(pinBtn, saveBtn, syncBtn, toggleEditBtn, paletteBtn, closeBtn, popupEl, titleWrapper);
        this.setupDragging(headerEl);
        this.setupResizing();
    }

    private iconButton(parent: HTMLElement, icon: string, active: boolean, label: string): HTMLButtonElement {
        const btn = parent.createEl('button', {
            cls: 'nl-floating-sticky-btn',
            attr: { type: 'button', 'aria-label': label, title: label },
        });
        setIcon(btn, icon);
        if (active) btn.addClass('is-active');
        return btn;
    }

    private createPalette(parent: HTMLElement): HTMLElement {
        const popupEl = parent.createDiv({ cls: 'nl-floating-sticky-palette' });
        for (const swatchColor of resolveStickyNoteColors(this.plugin.settings)) {
            const swatch = popupEl.createDiv({ cls: 'nl-floating-sticky-swatch' });
            const text = resolveStickyNoteFontColor(this.plugin.settings, swatchColor.color);
            swatch.setCssStyles({ backgroundColor: swatchColor.color, color: text });
            swatch.setText('Aa');
            swatch.onclick = (e) => {
                e.stopPropagation();
                this.state.color = swatchColor.color;
                this.state.textColor = text;
                this.updateVisuals();
                this.persist();
                popupEl.removeClass('is-active');
            };
        }
        this.containerEl.addEventListener('click', (e) => {
            const target = e.target;
            if (!target || !(target as Node).instanceOf(HTMLElement)) return;
            const el = target as HTMLElement;
            if (!el.closest('.nl-floating-sticky-palette') && !el.closest('.nl-floating-sticky-palette-target')) {
                popupEl.removeClass('is-active');
            }
        });
        return popupEl;
    }

    private bindControls(
        pinBtn: HTMLButtonElement,
        saveBtn: HTMLButtonElement,
        syncBtn: HTMLButtonElement | null,
        toggleEditBtn: HTMLButtonElement,
        paletteBtn: HTMLButtonElement,
        closeBtn: HTMLButtonElement,
        popupEl: HTMLElement,
        titleWrapper: HTMLElement,
    ): void {
        paletteBtn.onclick = (e) => {
            e.stopPropagation();
            popupEl.toggleClass('is-active', !popupEl.hasClass('is-active'));
        };

        pinBtn.onclick = () => {
            this.state.isPinned = !this.state.isPinned;
            pinBtn.toggleClass('is-active', this.state.isPinned === true);
            this.updateVisuals();
            this.persist();
        };

        if (syncBtn) {
            syncBtn.onclick = () => {
                void (async () => {
                    if (!this.state.filePath) return;
                    const file = this.app.vault.getAbstractFileByPath(this.state.filePath);
                    if (!(file instanceof TFile)) return;
                    this.state.content = await this.app.vault.read(file);
                    if (this.unloaded) return;
                    this.lastSavedContent = this.state.content;
                    if (this.state.isEditing) this.textareaEl.value = this.state.content || '';
                    await this.renderContent();
                    this.persist();
                    new Notice(t('Sticky note synced from file'));
                })();
            };
        }

        toggleEditBtn.onclick = () => {
            void (async () => {
                if (this.state.isEditing) {
                    this.state.content = this.textareaEl.value;
                    if (this.state.filePath) {
                        const file = this.app.vault.getAbstractFileByPath(this.state.filePath);
                        if (file instanceof TFile) {
                            await this.app.vault.process(file, () => this.state.content || '');
                            this.lastSavedContent = this.state.content || '';
                        }
                    }
                    this.state.isEditing = false;
                    setIcon(toggleEditBtn, 'pencil');
                    toggleEditBtn.setAttr('aria-label', t('Edit'));
                    toggleEditBtn.setAttr('title', t('Edit'));
                } else {
                    if (this.state.filePath) {
                        const file = this.app.vault.getAbstractFileByPath(this.state.filePath);
                        if (file instanceof TFile) {
                            this.state.content = await this.app.vault.read(file);
                            if (this.unloaded) return;
                        }
                    }
                    this.state.isEditing = true;
                    setIcon(toggleEditBtn, 'eye');
                    toggleEditBtn.setAttr('aria-label', t('Preview'));
                    toggleEditBtn.setAttr('title', t('Preview'));
                }
                await this.renderContent();
                this.persist();
                if (this.state.isEditing) {
                    window.requestAnimationFrame(() => this.textareaEl.focus());
                }
            })();
        };

        saveBtn.onclick = () => {
            void (async () => {
                if (this.state.isEditing) this.state.content = this.textareaEl.value;
                if (this.state.filePath) {
                    const file = this.app.vault.getAbstractFileByPath(this.state.filePath);
                    if (file instanceof TFile) {
                        await this.app.vault.process(file, () => this.state.content || '');
                        this.lastSavedContent = this.state.content || '';
                        new Notice(t('Sticky note saved to file'));
                    }
                    return;
                }
                new SaveFloatingStickyNoteModal(this.app, this.plugin, async (fileName, folderPath) => {
                    await this.saveAsVaultFile(fileName, folderPath, titleWrapper);
                }).open();
            })();
        };

        closeBtn.onclick = () => this.requestClose();
    }

    private async saveAsVaultFile(fileName: string, folderPath: string, titleWrapper: HTMLElement): Promise<void> {
        const fullPath = joinVaultMarkdownPath(folderPath, fileName);
        if (this.app.vault.getAbstractFileByPath(fullPath)) {
            new Notice(t('File already exists: {path}', { path: fullPath }));
            return;
        }
        await this.plugin.floatingStickyNotes.createNoteFile(fullPath, this.state.content || '');
        const file = this.app.vault.getAbstractFileByPath(fullPath);
        if (!(file instanceof TFile)) {
            throw new Error(fullPath);
        }
        this.state.filePath = file.path;
        this.state.title = file.basename;
        this.lastSavedContent = this.state.content || '';
        const titleEl = titleWrapper?.querySelector('.nl-floating-sticky-title');
        if (titleEl && titleEl.instanceOf(HTMLElement)) titleEl.setText(this.state.title);
        this.persist();
        new Notice(t('Saved as {path}', { path: fullPath }));
    }

    requestClose(): void {
        const currentContent = this.state.isEditing ? this.textareaEl.value : (this.state.content || '');
        if (shouldPromptStickyNoteClose({
            filePath: this.state.filePath,
            content: currentContent,
            lastSavedContent: this.lastSavedContent,
        })) {
            new ConfirmCloseFloatingStickyNoteModal(this.app, async (shouldSave) => {
                if (!shouldSave) {
                    this.close();
                    return;
                }
                if (this.state.isEditing) this.state.content = this.textareaEl.value;
                if (this.state.filePath) {
                    const file = this.app.vault.getAbstractFileByPath(this.state.filePath);
                    if (file instanceof TFile) {
                        await this.app.vault.process(file, () => this.state.content || '');
                        new Notice(t('Sticky note saved'));
                    }
                    this.close();
                    return;
                }
                new SaveFloatingStickyNoteModal(this.app, this.plugin, async (fileName, folderPath) => {
                    const titleWrapper = this.containerEl.querySelector('.nl-floating-sticky-title-wrapper');
                    await this.saveAsVaultFile(
                        fileName,
                        folderPath,
                        titleWrapper && titleWrapper.instanceOf(HTMLElement) ? titleWrapper : this.containerEl,
                    );
                    this.close();
                }).open();
            }).open();
            return;
        }
        this.close();
    }

    updateVisuals(): void {
        if (!this.containerEl) return;
        const opacity = clampStickyNoteOpacity(this.plugin.settings.floatingStickyNoteOpacity);
        this.containerEl.setCssProps({
            top: this.state.top,
            left: this.state.left,
            width: this.state.width,
            height: this.state.height,
            '--sticky-zoom': String(this.state.zoomLevel || 1),
            '--note-bg-color': this.state.color,
            '--note-bg-color-alpha': hexToRgba(this.state.color, opacity),
            '--note-text-color': this.state.textColor || '#111111',
            '--nl-floating-sticky-z': String(FloatingStickyNote.frontZ),
        });
        this.containerEl.toggleClass('is-pinned', this.state.isPinned === true);
    }

    async renderContent(): Promise<void> {
        if (this.state.isEditing) {
            this.contentContainer.addClass('is-hidden');
            this.textareaEl.addClass('is-visible');
            if (activeDocument.activeElement !== this.textareaEl) {
                const next = this.state.content || '';
                if (this.textareaEl.value !== next) this.textareaEl.value = next;
            }
            return;
        }
        this.textareaEl.removeClass('is-visible');
        this.contentContainer.removeClass('is-hidden');
        this.contentContainer.empty();
        let text = this.state.content || '';
        if (this.state.filePath) {
            const file = this.app.vault.getAbstractFileByPath(this.state.filePath);
            if (file instanceof TFile) text = await this.app.vault.read(file);
        }
        await MarkdownRenderer.render(this.app, text, this.contentContainer, this.state.filePath || '', this);
    }

    persist(): void {
        this.plugin.floatingStickyNotes.updateNote(this.state);
    }

    close(): void {
        this.plugin.floatingStickyNotes.removeNote(this.state.id);
        this.unload();
    }

    private bringToFront(): void {
        FloatingStickyNote.frontZ += 1;
        this.containerEl.setCssProps({ '--nl-floating-sticky-z': String(FloatingStickyNote.frontZ) });
    }

    private cleanupDragging(): void {
        if (this.dragMove) {
            activeDocument.removeEventListener('mousemove', this.dragMove);
            this.dragMove = null;
        }
        if (this.dragUp) {
            activeDocument.removeEventListener('mouseup', this.dragUp);
            this.dragUp = null;
        }
    }

    private setupDragging(handle: HTMLElement): void {
        let lastX = 0;
        let lastY = 0;
        const onMove = (e: MouseEvent) => {
            const dx = e.clientX - lastX;
            const dy = e.clientY - lastY;
            lastX = e.clientX;
            lastY = e.clientY;
            this.state.top = `${this.containerEl.offsetTop + dy}px`;
            this.state.left = `${this.containerEl.offsetLeft + dx}px`;
            this.containerEl.setCssProps({ top: this.state.top, left: this.state.left });
        };
        const onUp = () => {
            this.cleanupDragging();
            this.persist();
        };
        this.registerDomEvent(handle, 'mousedown', (e: MouseEvent) => {
            if (this.state.isPinned) return;
            const target = e.target;
            if (!target || !(target as Node).instanceOf(HTMLElement)) return;
            const el = target as HTMLElement;
            if (el.tagName === 'BUTTON' || el.closest('.nl-floating-sticky-btn') || el.closest('.nl-floating-sticky-close')) {
                return;
            }
            lastX = e.clientX;
            lastY = e.clientY;
            this.cleanupDragging();
            this.dragMove = onMove;
            this.dragUp = onUp;
            activeDocument.addEventListener('mousemove', onMove);
            activeDocument.addEventListener('mouseup', onUp);
        });
    }

    private setupResizing(): void {
        this.resizeObserver = new ResizeObserver(() => {
            if (this.state.isPinned) return;
            if (this.resizeTimer !== null) window.clearTimeout(this.resizeTimer);
            this.resizeTimer = window.setTimeout(() => {
                this.resizeTimer = null;
                if (this.containerEl.offsetWidth > 0 && this.containerEl.offsetHeight > 0) {
                    this.state.width = `${this.containerEl.offsetWidth}px`;
                    this.state.height = `${this.containerEl.offsetHeight}px`;
                    this.persist();
                }
            }, 300);
        });
        this.resizeObserver.observe(this.containerEl);
    }
}

const STICKY_NOTE_CUSTOM_FOLDER = '__nl_custom__';

function normalizeStickyFolderPath(path: string): string {
    const trimmed = path.trim().replace(/\\/g, '/');
    if (!trimmed || trimmed === '/') return '';
    return normalizePath(trimmed).replace(/^\/+|\/+$/g, '');
}

function stickyNoteSaveFolderChoices(plugin: SceneCardsPlugin): Array<{ path: string; label: string }> {
    const seen = new Set<string>();
    const out: Array<{ path: string; label: string }> = [];
    const add = (rawPath: string, label: string) => {
        const key = normalizeStickyFolderPath(rawPath);
        if (seen.has(key)) return;
        seen.add(key);
        out.push({ path: key, label });
    };
    add('', t('Vault root (/)'));
    const notes = plugin.sceneManager?.getNotesFolder?.() || '';
    if (notes) add(notes, t('Default location ({path})', { path: notes }));
    const projectFile = plugin.sceneManager?.activeProject?.filePath;
    if (projectFile) {
        const base = deriveProjectFoldersFromFilePath(projectFile).baseFolder;
        if (base) add(base, t('Project folder ({path})', { path: base }));
    }
    const root = plugin.app.vault.getRoot();
    for (const child of root.children) {
        if (child instanceof TFolder) add(child.path, child.path);
    }
    return out;
}

class StickyNoteFolderSuggest extends AbstractInputSuggest<TFolder> {
    constructor(
        app: App,
        inputEl: HTMLInputElement,
        private onPick: (path: string) => void,
    ) {
        super(app, inputEl);
    }

    getSuggestions(query: string): TFolder[] {
        const lower = query.toLowerCase();
        const folders: TFolder[] = [];
        const walk = (folder: TFolder) => {
            if (folder.path && folder.path !== '/') {
                if (folder.path.toLowerCase().includes(lower)) folders.push(folder);
            }
            for (const child of folder.children) {
                if (child instanceof TFolder) walk(child);
            }
        };
        walk(this.app.vault.getRoot());
        return folders.sort((a, b) => a.path.localeCompare(b.path));
    }

    renderSuggestion(folder: TFolder, el: HTMLElement): void {
        el.setText(folder.path);
    }

    selectSuggestion(folder: TFolder): void {
        this.setValue(folder.path);
        this.onPick(folder.path);
        this.close();
    }
}

class SaveFloatingStickyNoteModal extends Modal {
    constructor(
        app: App,
        private plugin: SceneCardsPlugin,
        private onSubmit: (fileName: string, folderPath: string) => void | Promise<void>,
    ) {
        super(app);
    }

    onOpen(): void {
        const { contentEl } = this;
        contentEl.empty();
        new Setting(contentEl).setName(t('Save sticky note')).setHeading();

        let fileName = `${t('Sticky note')} ${window.moment().format('YYYYMMDD_HHmmss')}`;
        let folderPath = normalizeStickyFolderPath(this.plugin.sceneManager?.getNotesFolder?.() || '');
        const choices = stickyNoteSaveFolderChoices(this.plugin);
        if (folderPath && !choices.some(choice => choice.path === folderPath)) {
            choices.push({ path: folderPath, label: folderPath });
        }

        let folderText: TextComponent | null = null;
        let folderDropdown: DropdownComponent | null = null;

        const syncDropdown = (path: string) => {
            const normalized = normalizeStickyFolderPath(path);
            const matched = choices.some(choice => choice.path === normalized);
            folderDropdown?.setValue(matched ? normalized : STICKY_NOTE_CUSTOM_FOLDER);
        };

        new Setting(contentEl)
            .setName(t('File name'))
            .setDesc(t('Name of the Markdown file, without .md.'))
            .addText(text => {
                text.setValue(fileName).onChange(value => { fileName = value; });
                text.inputEl.addClass('nl-settings-input-full');
                window.setTimeout(() => text.inputEl.select(), 50);
            });

        new Setting(contentEl)
            .setName(t('Save location'))
            .setDesc(t('Vault folder for the file. Leave empty for the vault root.'))
            .setClass('nl-floating-sticky-save-location')
            .addDropdown(dropdown => {
                folderDropdown = dropdown;
                for (const choice of choices) {
                    dropdown.addOption(choice.path, choice.label);
                }
                dropdown.addOption(STICKY_NOTE_CUSTOM_FOLDER, t('Custom path'));
                dropdown.setValue(
                    choices.some(choice => choice.path === folderPath) ? folderPath : STICKY_NOTE_CUSTOM_FOLDER,
                );
                dropdown.onChange(value => {
                    if (value === STICKY_NOTE_CUSTOM_FOLDER) {
                        folderText?.inputEl.focus();
                        return;
                    }
                    folderPath = value;
                    folderText?.setValue(value);
                });
            })
            .addText(text => {
                folderText = text;
                text.setValue(folderPath)
                    .setPlaceholder(t('Notes'))
                    .onChange(value => {
                        folderPath = value;
                        syncDropdown(value);
                    });
                text.inputEl.addClass('nl-settings-input-full');
                new StickyNoteFolderSuggest(this.app, text.inputEl, path => {
                    folderPath = path;
                    text.setValue(path);
                    syncDropdown(path);
                });
            });

        contentEl.createEl('p', {
            text: t('The floating note stays on screen. Save writes a Markdown file you can open later.'),
            cls: 'setting-item-description',
        });

        new Setting(contentEl)
            .addButton(btn => btn.setButtonText(t('Cancel')).onClick(() => this.close()))
            .addButton(btn => btn.setButtonText(t('Save')).setCta().onClick(async () => {
                const name = fileName.trim();
                if (!name) {
                    new Notice(t('Please enter a file name.'));
                    return;
                }
                btn.setDisabled(true);
                try {
                    await this.onSubmit(name, normalizeStickyFolderPath(folderPath));
                    this.close();
                } catch (error) {
                    new Notice(t('Could not save sticky note: {error}', { error: error instanceof Error ? error.message : 'unknown' }));
                    btn.setDisabled(false);
                }
            }));
    }

    onClose(): void {
        this.contentEl.empty();
    }
}

class ConfirmCloseFloatingStickyNoteModal extends Modal {
    constructor(
        app: App,
        private onSubmit: (shouldSave: boolean) => void | Promise<void>,
    ) {
        super(app);
    }

    onOpen(): void {
        const { contentEl } = this;
        contentEl.empty();
        new Setting(contentEl).setName(t('Unsaved sticky note')).setHeading();
        contentEl.createEl('p', {
            text: t('This note is not saved as a vault file, or the linked file has unsaved edits.'),
        });
        new Setting(contentEl)
            .addButton(btn => btn.setButtonText(t("Don't save")).onClick(async () => {
                await this.onSubmit(false);
                this.close();
            }))
            .addButton(btn => btn.setButtonText(t('Cancel')).onClick(() => this.close()))
            .addButton(btn => btn.setButtonText(t('Save')).setCta().onClick(async () => {
                btn.setDisabled(true);
                try {
                    await this.onSubmit(true);
                    this.close();
                } catch (error) {
                    new Notice(t('Could not save sticky note: {error}', { error: error instanceof Error ? error.message : 'unknown' }));
                    btn.setDisabled(false);
                }
            }));
    }

    onClose(): void {
        this.contentEl.empty();
    }
}
