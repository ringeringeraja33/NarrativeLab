/* eslint-disable @typescript-eslint/no-misused-promises -- DOM/event handlers and Obsidian dynamic API */
import type SceneCardsPlugin from '../main';
import { SceneManager } from '../services/SceneManager';
import { Scene } from '../models/Scene';
import { t } from '../utils/i18n';

/**
 * Scene synopsis side panel used by SynopsisView.
 */
export class InfoPanelComponent {
    private sceneManager: SceneManager;
    private container: HTMLElement;
    private currentScene: Scene | null = null;

    constructor(container: HTMLElement, _plugin: SceneCardsPlugin, sceneManager: SceneManager) {
        this.container = container;
        this.sceneManager = sceneManager;
    }

    show(scene: Scene): void {
        if (this.container.querySelector('input:focus, textarea:focus, select:focus, .cm-focused')) {
            this.currentScene = scene;
            return;
        }
        this.currentScene = scene;
        this.render();
    }

    hide(): void {
        this.currentScene = null;
        this.container.empty();
    }

    isVisible(): boolean {
        return this.currentScene !== null;
    }

    getCurrentScene(): Scene | null {
        return this.currentScene;
    }

    private render(): void {
        this.container.empty();
        const scene = this.currentScene;
        if (!scene) return;

        this.container.addClass('sl-info-panel');
        this.container.addClass('sl-info-panel-mode-synopsis');
        const titleEl = this.container.createDiv('sl-info-title');
        titleEl.setText(scene.title || t('Untitled'));

        const section = this.container.createDiv('sl-info-section');
        section.createDiv({ cls: 'sl-info-section-label', text: t('Synopsis') });
        const textarea = section.createEl('textarea', {
            cls: 'sl-info-synopsis-textarea',
            attr: { placeholder: t('Brief scene synopsis…') },
        });
        textarea.value = scene.synopsis || '';
        textarea.addEventListener('change', async () => {
            const val = textarea.value.trim();
            await this.sceneManager.updateScene(scene.filePath, { synopsis: val || undefined });
            scene.synopsis = val || undefined;
        });
    }
}
/* eslint-enable @typescript-eslint/no-misused-promises -- End Obsidian callback exception. */
