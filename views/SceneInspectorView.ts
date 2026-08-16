/* eslint-disable @typescript-eslint/no-floating-promises, @typescript-eslint/no-misused-promises -- Obsidian's API surface and several untyped third-party libraries force dynamic dispatch; floating promises are intentional in DOM/event handlers; matching enable at end of file */
import { EventRef, ItemView, WorkspaceLeaf, TFile, MarkdownView } from 'obsidian';
import type SceneCardsPlugin from '../main';
import { SceneManager } from '../services/SceneManager';
import { InspectorComponent } from '../components/Inspector';
import { ManuscriptView } from './ManuscriptView';
import { t } from '../utils/i18n';
import {
    SCENE_INSPECTOR_VIEW_TYPE,
    MANUSCRIPT_VIEW_TYPE,
} from '../constants';

/**
 * Standalone Scene Inspector sidebar view — scene details only.
 * Synopsis / Notes / Research open as their own panes via commands.
 */
export class SceneInspectorView extends ItemView {
    private plugin: SceneCardsPlugin;
    private sceneManager: SceneManager;

    private inspectorComponent: InspectorComponent | null = null;
    private emptyEl: HTMLElement | null = null;

    /** Timestamp (ms) of last user-initiated edit inside the inspector. */
    private lastEditTime = 0;

    constructor(leaf: WorkspaceLeaf, plugin: SceneCardsPlugin, sceneManager: SceneManager) {
        super(leaf);
        this.plugin = plugin;
        this.sceneManager = sceneManager;
    }

    getViewType(): string {
        return SCENE_INSPECTOR_VIEW_TYPE;
    }

    getDisplayText(): string {
        return t('Scene Details');
    }

    getIcon(): string {
        return 'file-search';
    }

    async onOpen(): Promise<void> {
        const viewContent = this.containerEl.children[1] as HTMLElement;
        viewContent.empty();
        viewContent.addClass('sl-scene-inspector-host');
        this.containerEl.closest('.workspace-leaf')?.classList.add('sl-scene-inspector-leaf');

        // Use a wrapper inside .view-content so we don't fight Obsidian's
        // default flex layout on the leaf container.
        const container = viewContent.createDiv('sl-scene-inspector-sidebar');
        const panelsHost = container.createDiv('sl-inspector-panels');

        const detailsPanelEl = panelsHost.createDiv('sl-inspector-panel is-active');
        const inspectorHost = detailsPanelEl.createDiv('story-line-inspector-panel sl-sidebar-inspector');
        inspectorHost.setCssStyles({ display: 'none' });

        this.emptyEl = panelsHost.createDiv('sl-scene-inspector-empty');
        this.emptyEl.createEl('p', { text: t('Open a scene file to see its details here.') });

        this.inspectorComponent = new InspectorComponent(
            inspectorHost,
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
            }
        );

        // Listen for active file changes — only switch/hide when user
        // navigates to a real editor showing a different file.
        this.registerEvent(
            this.app.workspace.on('active-leaf-change', (leaf) => {
                if (!leaf) return;
                if (leaf === this.leaf) return;
                // Markdown editor — follow it
                if (leaf.view instanceof MarkdownView) {
                    this.updateForActiveFile();
                    return;
                }
                // Manuscript view — follow its currently-focused scene
                if (leaf.view instanceof ManuscriptView) {
                    this.updateForActiveFile();
                    return;
                }
            })
        );

        // Refresh scene data when files are modified.
        this.registerEvent(
            this.app.vault.on('modify', () => {
                if (!this.inspectorComponent?.getCurrentScene?.()) return;
                if (Date.now() - this.lastEditTime < 2000) return;
                window.setTimeout(() => this.refreshCurrentScene(), 600);
            })
        );

        // Listen for Manuscript focused-scene changes.
        this.registerEvent(
            (this.app.workspace as unknown as { on: (ev: string, cb: (filePath: string) => void) => EventRef }).on('storyline:manuscript-focus', (filePath: string) => {
                if (Date.now() - this.lastEditTime < 2000) return;
                this.showScene(filePath);
            })
        );

        // Listen for scene-focus from any NarrativeLab view.
        this.registerEvent(
            (this.app.workspace as unknown as { on: (ev: string, cb: (filePath: string) => void) => EventRef }).on('storyline:scene-focus', (filePath: string) => {
                if (Date.now() - this.lastEditTime < 2000) return;
                this.showScene(filePath);
            })
        );

        this.updateForActiveFile();
    }

    async onClose(): Promise<void> {
        this.containerEl.closest('.workspace-leaf')?.classList.remove('sl-scene-inspector-leaf');
        this.inspectorComponent = null;
    }

    // ── Scene wiring ──────────────────────────────────────────────

    refresh(): void {
        const current = this.inspectorComponent?.getCurrentScene?.() || null;
        if (!current || !this.sceneManager.getScene(current.filePath)) {
            this.inspectorComponent?.hide();
            this.refreshEmptyState();
            return;
        }
        this.refreshCurrentScene();
    }

    private showScene(filePath: string): void {
        const scene = this.sceneManager.getScene(filePath);
        if (!scene) return;
        this.inspectorComponent?.show(scene);
        this.refreshEmptyState();
    }

    private refreshEmptyState(): void {
        if (!this.emptyEl) return;
        const hasScene = !!this.inspectorComponent?.getCurrentScene?.();
        this.emptyEl.setCssStyles({ display: hasScene ? 'none' : 'block' });
    }

    private updateForActiveFile(): void {
        // 1. Prefer an active MarkdownView's file (the user's open scene).
        const activeFile = this.app.workspace.getActiveFile();
        if (activeFile && activeFile.extension === 'md') {
            const scene = this.sceneManager.getScene(activeFile.path);
            if (scene) {
                this.inspectorComponent?.show(scene);
                this.refreshEmptyState();
                return;
            }
        }

        // 2. Otherwise, if a Manuscript view is open, mirror its focused scene.
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

    private refreshCurrentScene(): void {
        const current = this.inspectorComponent?.getCurrentScene?.() || null;
        if (!current) return;
        const fresh = this.sceneManager.getScene(current.filePath);
        if (fresh) {
            this.inspectorComponent?.show(fresh);
        }
    }
}
/* eslint-enable @typescript-eslint/no-floating-promises, @typescript-eslint/no-misused-promises -- end of file-wide suppression block opened at line 1 */
