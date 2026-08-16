/* eslint-disable @typescript-eslint/no-floating-promises, @typescript-eslint/no-misused-promises -- Obsidian's API surface forces dynamic dispatch; floating promises are intentional in DOM/event handlers */
import { EventRef, ItemView, MarkdownView, TFile, WorkspaceLeaf } from 'obsidian';
import type SceneCardsPlugin from '../main';
import { SceneManager } from '../services/SceneManager';
import { InspectorComponent } from '../components/Inspector';
import { ManuscriptView } from './ManuscriptView';
import { MANUSCRIPT_VIEW_TYPE, DETAILS_VIEW_TYPE } from '../constants';
import { t } from '../utils/i18n';

/**
 * Standalone Scene Details view — hosts the full InspectorComponent
 * in its own dockable leaf so it can be placed beside / above /
 * below the Synopsis or Notes panes. Uses Obsidian's native tab
 * drag for layout (drop on a pane edge to split, drop on a tab
 * strip to dock).
 */
export class DetailsView extends ItemView {
    private plugin: SceneCardsPlugin;
    private sceneManager: SceneManager;
    private inspectorComponent: InspectorComponent | null = null;
    private inspectorHost: HTMLElement | null = null;
    private emptyEl: HTMLElement | null = null;
    private lastEditTime = 0;

    constructor(leaf: WorkspaceLeaf, plugin: SceneCardsPlugin, sceneManager: SceneManager) {
        super(leaf);
        this.plugin = plugin;
        this.sceneManager = sceneManager;
    }

    getViewType(): string {
        return DETAILS_VIEW_TYPE;
    }

    getDisplayText(): string {
        return t('Scene Details');
    }

    getIcon(): string {
        return 'list';
    }

    async onOpen(): Promise<void> {
        const viewContent = this.containerEl.children[1] as HTMLElement;
        viewContent.empty();
        viewContent.addClass('sl-scene-inspector-host');
        this.containerEl.closest('.workspace-leaf')?.classList.add('sl-scene-inspector-leaf');

        const container = viewContent.createDiv('sl-scene-inspector-sidebar');
        const panelsHost = container.createDiv('sl-inspector-panels');

        const detailsPanelEl = panelsHost.createDiv('sl-inspector-panel is-active');
        this.inspectorHost = detailsPanelEl.createDiv('story-line-inspector-panel sl-sidebar-inspector');
        this.inspectorHost.setCssStyles({ display: 'none' });

        this.emptyEl = panelsHost.createDiv('sl-scene-inspector-empty');
        this.emptyEl.createEl('p', { text: t('Open a scene file to see its details here.') });

        this.inspectorComponent = new InspectorComponent(
            this.inspectorHost,
            this.plugin,
            this.sceneManager,
            {
                onEdit: (scene) => {
                    const file = this.app.vault.getAbstractFileByPath(scene.filePath);
                    if (file instanceof TFile) {
                        this.app.workspace.getLeaf('tab').openFile(file);
                    }
                },
                onDelete: async (scene) => {
                    await this.sceneManager.deleteScene(scene.filePath);
                    this.inspectorComponent?.hide();
                    this.refreshEmptyState();
                },
                onRefresh: () => {
                    this.lastEditTime = Date.now();
                    this.refreshCurrentScene();
                },
                onStatusChange: async (scene, status) => {
                    this.lastEditTime = Date.now();
                    await this.sceneManager.updateScene(scene.filePath, { status });
                    this.refreshCurrentScene();
                },
            },
        );

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
                if (!this.inspectorComponent?.getCurrentScene?.()) return;
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
        this.containerEl.closest('.workspace-leaf')?.classList.remove('sl-scene-inspector-leaf');
        this.inspectorComponent = null;
    }

    private showScene(filePath: string): void {
        const scene = this.sceneManager.getScene(filePath);
        if (!scene) return;
        this.inspectorComponent?.show(scene);
        this.refreshEmptyState();
    }

    private updateForActiveFile(): void {
        const activeFile = this.app.workspace.getActiveFile();
        if (activeFile && activeFile.extension === 'md') {
            const scene = this.sceneManager.getScene(activeFile.path);
            if (scene) {
                this.inspectorComponent?.show(scene);
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
                    this.inspectorComponent?.show(scene);
                    this.refreshEmptyState();
                    return;
                }
            }
        }

        this.inspectorComponent?.hide();
        this.refreshEmptyState();
    }

    refresh(): void {
        const current = this.inspectorComponent?.getCurrentScene?.();
        if (!current || !this.sceneManager.getScene(current.filePath)) {
            this.inspectorComponent?.hide();
            this.refreshEmptyState();
            return;
        }
        this.refreshCurrentScene();
    }

    private refreshCurrentScene(): void {
        const current = this.inspectorComponent?.getCurrentScene?.();
        if (!current) return;
        const fresh = this.sceneManager.getScene(current.filePath);
        if (fresh) this.inspectorComponent?.show(fresh);
    }

    private refreshEmptyState(): void {
        if (!this.emptyEl) return;
        const hasScene = !!this.inspectorComponent?.getCurrentScene?.();
        this.emptyEl.setCssStyles({ display: hasScene ? 'none' : 'block' });
    }
}
/* eslint-enable @typescript-eslint/no-floating-promises, @typescript-eslint/no-misused-promises -- end of file-wide suppression block opened at line 1 */
