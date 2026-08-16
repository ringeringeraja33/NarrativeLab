/* eslint-disable @typescript-eslint/no-floating-promises, @typescript-eslint/no-misused-promises -- Obsidian's API surface forces dynamic dispatch; floating promises are intentional in DOM/event handlers */
import { EventRef, ItemView, MarkdownView, TFile, WorkspaceLeaf, WorkspaceSplit, setIcon } from 'obsidian';
import type SceneCardsPlugin from '../main';
import { SceneManager } from '../services/SceneManager';
import type { Scene } from '../models/Scene';
import { ManuscriptView } from './ManuscriptView';
import { MANUSCRIPT_VIEW_TYPE, NOTES_VIEW_TYPE } from '../constants';
import { t } from '../utils/i18n';

/**
 * Standalone Notes sidebar view (#116).
 *
 * Mirrors the focused scene's `notes` field in a dedicated sidebar leaf,
 * so writers can keep notes visible alongside the manuscript without
 * having the full Inspector open. Uses a native embedded MarkdownView
 * so notes editing matches Obsidian Live Preview.
 */
export class NotesView extends ItemView {
    private sceneManager: SceneManager;
    private editorHost: HTMLElement | null = null;
    private editorLeaf: WorkspaceLeaf | null = null;
    private currentScenePath: string | null = null;
    private currentNotesPath: string | null = null;
    private saveTimer: number | null = null;
    private emptyEl: HTMLElement | null = null;
    /** Invalidates an embedded editor that finishes opening after a scene switch. */
    private editorMountGeneration = 0;

    constructor(leaf: WorkspaceLeaf, _plugin: SceneCardsPlugin, sceneManager: SceneManager) {
        super(leaf);
        this.sceneManager = sceneManager;
    }

    getViewType(): string {
        return NOTES_VIEW_TYPE;
    }

    getDisplayText(): string {
        return t('Scene Notes');
    }

    getIcon(): string {
        return 'sticky-note';
    }

    async onOpen(): Promise<void> {
        const viewContent = this.containerEl.children[1] as HTMLElement;
        viewContent.empty();
        viewContent.addClass('sl-notes-view-host');

        const container = viewContent.createDiv('sl-notes-view');

        const header = container.createDiv('sl-notes-editor-header');
        header.createDiv({ cls: 'sl-notes-editor-title', text: t('Scene Notes') });
        const openBtn = header.createEl('button', {
            cls: 'clickable-icon sl-notes-open-btn',
            attr: { title: t('Open notes file in separate tab'), 'aria-label': t('Open notes file') },
        });
        setIcon(openBtn, 'file-text');
        openBtn.addEventListener('click', async () => {
            if (!this.currentNotesPath) return;
            const file = this.app.vault.getAbstractFileByPath(this.currentNotesPath);
            if (file instanceof TFile) {
                await this.app.workspace.getLeaf('tab').openFile(file, { state: { mode: 'source', source: false } });
            }
        });

        // Real embedded Obsidian MarkdownView. This is intentionally not the
        // custom InfoPanel notes renderer: it gives native Live Preview editing.
        this.editorHost = container.createDiv('sl-notes-editor-host');

        // Empty state
        this.emptyEl = container.createDiv('sl-scene-inspector-empty');
        this.emptyEl.createEl('p', { text: t('Open a scene file to edit its notes here.') });

        // Follow active markdown / manuscript leaves.
        this.registerEvent(
            this.app.workspace.on('active-leaf-change', (leaf) => {
                if (!leaf || leaf === this.leaf || leaf === this.editorLeaf) return;
                if (leaf.view instanceof MarkdownView || leaf.view instanceof ManuscriptView) {
                    this.updateForActiveFile();
                }
            })
        );

        // Refresh when the focused scene file changes externally.
        this.registerEvent(
            this.app.vault.on('modify', (file) => {
                if (!this.currentScenePath) return;
                if (file.path === this.currentNotesPath) return;
                window.setTimeout(() => this.refreshCurrentScene(), 600);
            })
        );

        // Listen for scene-focus events from other NarrativeLab views.
        this.registerEvent(
            (this.app.workspace as unknown as { on: (ev: string, cb: (filePath: string) => void) => EventRef }).on(
                'storyline:scene-focus',
                (filePath: string) => {
                    this.showScene(filePath);
                },
            ),
        );
        this.registerEvent(
            (this.app.workspace as unknown as { on: (ev: string, cb: (filePath: string) => void) => EventRef }).on(
                'storyline:manuscript-focus',
                (filePath: string) => {
                    this.showScene(filePath);
                },
            ),
        );

        this.updateForActiveFile();
    }

    async onClose(): Promise<void> {
        this.detachEditor();
        this.editorHost = null;
        this.currentScenePath = null;
        this.currentNotesPath = null;
    }

    refresh(): void {
        if (this.currentScenePath && !this.sceneManager.getScene(this.currentScenePath)) {
            this.currentScenePath = null;
            this.currentNotesPath = null;
            this.detachEditor();
            this.refreshEmptyState();
            return;
        }
        this.updateForActiveFile();
    }

    private async showScene(filePath: string): Promise<void> {
        const scene = this.sceneManager.getScene(filePath);
        if (!scene) return;
        this.currentScenePath = scene.filePath;
        // Issue #200 — read-only lookup so opening a scene in the Notes view
        // doesn't create an empty notes file. The file is created lazily when
        // the user actually types something (see attachAutosave / openBtn).
        const notesPath = this.sceneManager.getSceneNotesFile(scene);
        if (notesPath) {
            await this.mountNotesEditor(notesPath);
        } else {
            // No notes file yet — show a clickable placeholder that creates
            // the file on first input instead of eagerly on render.
            this.detachEditor();
            this.currentNotesPath = null;
            this.showNotesPlaceholder(scene);
        }
        this.refreshEmptyState();
    }

    /**
     * Show a "Click to add notes…" placeholder when no notes file exists yet.
     * Clicking it creates the file (lazy creation, issue #200) and remounts
     * the embedded editor.
     */
    private showNotesPlaceholder(scene: Scene): void {
        if (!this.editorHost) return;
        this.editorHost.empty();
        const placeholder = this.editorHost.createDiv('sl-notes-placeholder');
        placeholder.createEl('p', { text: t('No notes file yet.') });
        const addBtn = placeholder.createEl('button', {
            cls: 'sl-notes-create-btn',
            text: t('Click to add notes…'),
        });
        addBtn.addEventListener('click', async () => {
            const path = await this.sceneManager.getOrCreateSceneNotesFile(scene);
            if (this.currentScenePath !== scene.filePath || !placeholder.isConnected) return;
            await this.mountNotesEditor(path);
            this.refreshEmptyState();
        });
    }

    private updateForActiveFile(): void {
        const activeFile = this.app.workspace.getActiveFile();
        if (activeFile && activeFile.extension === 'md') {
            const scene = this.sceneManager.getScene(activeFile.path);
            if (scene) {
                this.showScene(scene.filePath);
                return;
            }
        }

        const manuscriptLeaves = this.app.workspace.getLeavesOfType(MANUSCRIPT_VIEW_TYPE);
        for (const leaf of manuscriptLeaves) {
            const view = leaf.view;
            if (view instanceof ManuscriptView && view.focusedScenePath) {
                const scene = this.sceneManager.getScene(view.focusedScenePath);
                if (scene) {
                    this.showScene(scene.filePath);
                    return;
                }
            }
        }

        this.currentScenePath = null;
        this.currentNotesPath = null;
        this.detachEditor();
        this.refreshEmptyState();
    }

    private refreshCurrentScene(): void {
        if (!this.currentScenePath) return;
        const activeMarkdownView = this.app.workspace.getActiveViewOfType(MarkdownView);
        if (activeMarkdownView && activeMarkdownView === this.editorLeaf?.view) return;
        const fresh = this.sceneManager.getScene(this.currentScenePath);
        if (fresh) this.showScene(fresh.filePath);
    }

    private async mountNotesEditor(notesPath: string): Promise<void> {
        if (!this.editorHost) return;
        if (this.currentNotesPath === notesPath && this.editorLeaf) return;

        this.detachEditor();
        const mountGeneration = this.editorMountGeneration;
        this.currentNotesPath = notesPath;

        const file = this.app.vault.getAbstractFileByPath(notesPath);
        if (!(file instanceof TFile)) return;

        this.editorHost.empty();

        const host = this.editorHost;
        const split = new (WorkspaceSplit as unknown as new (workspace: unknown, dir: string) => WorkspaceSplit)(this.app.workspace, 'vertical');
        const splitEl: HTMLElement = (split as unknown as { containerEl: HTMLElement }).containerEl;
        splitEl.addClass('sl-notes-embedded-split');
        host.appendChild(splitEl);

        const leaf = this.app.workspace.createLeafInParent(split, 0);
        try {
            await leaf.openFile(file, { state: { mode: 'source', source: false } });
        } catch (error) {
            leaf.detach();
            if (mountGeneration === this.editorMountGeneration) {
                console.error('[NarrativeLab] Failed to open Notes editor:', error);
            }
            return;
        }
        if (
            mountGeneration !== this.editorMountGeneration
            || this.currentNotesPath !== notesPath
            || this.editorHost !== host
            || !host.isConnected
        ) {
            leaf.detach();
            return;
        }
        this.editorLeaf = leaf;
        this.attachAutosave(splitEl, leaf, file);
    }

    private attachAutosave(splitEl: HTMLElement, leaf: WorkspaceLeaf, file: TFile): void {
        const saveNow = (): void => {
            const editor = (leaf.view as unknown as { editor?: { getValue: () => string } })?.editor;
            if (!editor) return;
            const value = editor.getValue();
            void this.app.vault.read(file).then(async (diskValue) => {
                if (diskValue !== value) {
                    await this.app.vault.modify(file, value);
                }
            }).catch(error => {
                console.error('[NarrativeLab] Failed to autosave Notes view:', error);
            });
        };

        const scheduleSave = (): void => {
            if (this.saveTimer !== null) window.clearTimeout(this.saveTimer);
            this.saveTimer = window.setTimeout(() => {
                this.saveTimer = null;
                saveNow();
            }, 250);
        };

        const flushSave = (): void => {
            if (this.saveTimer !== null) {
                window.clearTimeout(this.saveTimer);
                this.saveTimer = null;
            }
            saveNow();
        };

        splitEl.addEventListener('input', scheduleSave, true);
        splitEl.addEventListener('keyup', scheduleSave, true);
        splitEl.addEventListener('focusout', flushSave, true);
    }

    private detachEditor(): void {
        this.editorMountGeneration++;
        if (this.saveTimer !== null) {
            window.clearTimeout(this.saveTimer);
            this.saveTimer = null;
        }
        this.editorLeaf?.detach();
        this.editorLeaf = null;
        this.editorHost?.empty();
    }

    private refreshEmptyState(): void {
        if (!this.emptyEl) return;
        const hasScene = !!this.currentScenePath;
        this.emptyEl.setCssStyles({ display: hasScene ? 'none' : 'block' });
        this.editorHost?.setCssStyles({ display: hasScene ? 'flex' : 'none' });
    }
}
/* eslint-enable @typescript-eslint/no-floating-promises, @typescript-eslint/no-misused-promises -- end of file-wide suppression block opened at line 1 */
