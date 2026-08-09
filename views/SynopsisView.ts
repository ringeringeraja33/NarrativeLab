
import { EventRef, ItemView, MarkdownView, WorkspaceLeaf } from 'obsidian';
import type SceneCardsPlugin from '../main';
import { SceneManager } from '../services/SceneManager';
import { InfoPanelComponent } from '../components/InfoPanel';
import { ManuscriptView } from './ManuscriptView';
import { MANUSCRIPT_VIEW_TYPE, SYNOPSIS_VIEW_TYPE } from '../constants';
import { t } from '../utils/i18n';

/**
 * Standalone Synopsis view — mirrors the focused scene's `synopsis`
 * field in its own dockable leaf. Drag the tab anywhere in the
 * Obsidian workspace to position it (left/right of another pane,
 * stacked above/below, or in its own window).
 */
export class SynopsisView extends ItemView {
    private plugin: SceneCardsPlugin;
    private sceneManager: SceneManager;
    private synopsisPanel: InfoPanelComponent | null = null;
    private emptyEl: HTMLElement | null = null;
    private lastEditTime = 0;

    constructor(leaf: WorkspaceLeaf, plugin: SceneCardsPlugin, sceneManager: SceneManager) {
        super(leaf);
        this.plugin = plugin;
        this.sceneManager = sceneManager;
    }

    getViewType(): string {
        return SYNOPSIS_VIEW_TYPE;
    }

    getDisplayText(): string {
        return t('Scene Synopsis');
    }

    getIcon(): string {
        return 'scroll-text';
    }

    async onOpen(): Promise<void> {
        const viewContent = this.containerEl.children[1] as HTMLElement;
        viewContent.empty();
        viewContent.addClass('sl-notes-view-host');

        const container = viewContent.createDiv('sl-notes-view');

        const panelEl = container.createDiv('sl-inspector-panel is-active sl-inspector-panel-synopsis sl-info-panel-host');
        this.synopsisPanel = new InfoPanelComponent(panelEl, this.plugin, this.sceneManager, 'synopsis');

        this.emptyEl = container.createDiv('sl-scene-inspector-empty');
        this.emptyEl.createEl('p', { text: t('Open a scene file to edit its synopsis here.') });

        this.registerEvent(
            this.app.workspace.on('active-leaf-change', (leaf) => {
                if (!leaf || leaf === this.leaf) return;
                if (leaf.view instanceof MarkdownView || leaf.view instanceof ManuscriptView) {
                    this.updateForActiveFile();
                }
            })
        );

        this.registerEvent(
            this.app.vault.on('modify', () => {
                if (!this.synopsisPanel?.getCurrentScene()) return;
                if (Date.now() - this.lastEditTime < 2000) return;
                window.setTimeout(() => this.refreshCurrentScene(), 600);
            })
        );

        this.registerEvent(
            (this.app.workspace as unknown as { on: (ev: string, cb: (filePath: string) => void) => EventRef }).on(
                'storyline:scene-focus',
                (filePath: string) => {
                    if (Date.now() - this.lastEditTime < 2000) return;
                    this.showScene(filePath);
                },
            ),
        );
        this.registerEvent(
            (this.app.workspace as unknown as { on: (ev: string, cb: (filePath: string) => void) => EventRef }).on(
                'storyline:manuscript-focus',
                (filePath: string) => {
                    if (Date.now() - this.lastEditTime < 2000) return;
                    this.showScene(filePath);
                },
            ),
        );

        this.updateForActiveFile();
    }

    async onClose(): Promise<void> {
        this.synopsisPanel = null;
    }

    private showScene(filePath: string): void {
        const scene = this.sceneManager.getScene(filePath);
        if (!scene) return;
        this.synopsisPanel?.show(scene);
        this.refreshEmptyState();
    }

    private updateForActiveFile(): void {
        const activeFile = this.app.workspace.getActiveFile();
        if (activeFile && activeFile.extension === 'md') {
            const scene = this.sceneManager.getScene(activeFile.path);
            if (scene) {
                this.synopsisPanel?.show(scene);
                this.refreshEmptyState();
                return;
            }
        }

        const manuscriptLeaves = this.app.workspace.getLeavesOfType(MANUSCRIPT_VIEW_TYPE);
        for (const leaf of manuscriptLeaves) {
            const view = leaf.view;
            if (view instanceof ManuscriptView && view.focusedScenePath) {
                const scene = this.sceneManager.getScene(view.focusedScenePath);
                if (scene) {
                    this.synopsisPanel?.show(scene);
                    this.refreshEmptyState();
                    return;
                }
            }
        }

        this.synopsisPanel?.hide();
        this.refreshEmptyState();
    }

    private refreshCurrentScene(): void {
        const current = this.synopsisPanel?.getCurrentScene();
        if (!current) return;
        const fresh = this.sceneManager.getScene(current.filePath);
        if (fresh) this.synopsisPanel?.show(fresh);
    }

    private refreshEmptyState(): void {
        if (!this.emptyEl) return;
        const hasScene = !!this.synopsisPanel?.getCurrentScene();
        this.emptyEl.setCssStyles({ display: hasScene ? 'none' : 'block' });
    }
}
