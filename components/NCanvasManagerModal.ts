import { App, Modal, Notice, Setting, normalizePath, setIcon } from 'obsidian';
import type SceneCardsPlugin from '../main';
import { t } from '../utils/i18n';

export const SAMPLE_NCANVAS_FILENAMES = {
    en: 'Narrative Canvas Guide Sample.ncanvas',
    zh: '叙事画布功能指南示例.ncanvas',
} as const;

export type SampleNcanvasLanguage = keyof typeof SAMPLE_NCANVAS_FILENAMES;

/**
 * Per-project NCanvas manager: list/switch .ncanvas files, create blank,
 * and generate Chinese / English guide samples into the project's NCanvas folder.
 */
export class NCanvasManagerModal extends Modal {
    private plugin: SceneCardsPlugin;
    private listEl: HTMLElement | null = null;
    private nameInput = '';

    constructor(app: App, plugin: SceneCardsPlugin) {
        super(app);
        this.plugin = plugin;
        this.titleEl.setText(t('NCanvas files'));
    }

    onOpen(): void {
        const { contentEl } = this;
        contentEl.empty();
        contentEl.addClass('narrative-lab-ncanvas-modal');

        const project = this.plugin.sceneManager.activeProject;
        if (!project) {
            contentEl.createEl('p', { text: t('No active project. Open a project first.') });
            return;
        }

        const folders = this.plugin.getNcanvasPathsForProject(project);
        contentEl.createEl('p', {
            cls: 'ncanvas-modal-hint',
            text: t('Manage .ncanvas files for this project. Stored in {folder}.', {
                folder: folders.canvasFolder,
            }),
        });

        this.listEl = contentEl.createDiv({ cls: 'ncanvas-file-list' });
        this.renderList();

        const createSection = contentEl.createDiv({ cls: 'ncanvas-create-section' });
        createSection.createEl('h3', { text: t('New ncanvas') });

        new Setting(createSection)
            .setName(t('File name'))
            .setDesc(t('Creates a blank canvas in this project’s NCanvas folder.'))
            .addText((text) => {
                text.setPlaceholder(t('Untitled Canvas'));
                text.onChange((value) => {
                    this.nameInput = value;
                });
            })
            .addButton((btn) => {
                btn.setButtonText(t('Create'))
                    .setCta()
                    .onClick(() => {
                        void this.createBlank();
                    });
            });

        const sampleSection = contentEl.createDiv({ cls: 'ncanvas-sample-section' });
        sampleSection.createEl('h3', { text: t('Guide samples') });
        sampleSection.createEl('p', {
            cls: 'ncanvas-modal-hint',
            text: t('Generate the built-in Narrative Canvas walkthrough into this project.'),
        });

        const sampleActions = sampleSection.createDiv({ cls: 'ncanvas-sample-actions' });
        const zhBtn = sampleActions.createEl('button', {
            text: t('Sample (Chinese)'),
            cls: 'mod-cta',
            attr: { type: 'button' },
        });
        zhBtn.addEventListener('click', () => {
            void this.createSample('zh');
        });
        const enBtn = sampleActions.createEl('button', {
            text: t('Sample (English)'),
            cls: 'mod-cta',
            attr: { type: 'button' },
        });
        enBtn.addEventListener('click', () => {
            void this.createSample('en');
        });

        const footer = contentEl.createDiv({ cls: 'ncanvas-modal-footer' });
        const closeBtn = footer.createEl('button', { text: t('Cancel'), cls: 'mod-quiet', attr: { type: 'button' } });
        closeBtn.addEventListener('click', () => this.close());
    }

    private renderList(): void {
        if (!this.listEl) return;
        this.listEl.empty();

        const project = this.plugin.sceneManager.activeProject;
        if (!project) return;

        const { candidates } = this.plugin.getNcanvasPathsForProject(project);
        const remembered = normalizePath(String(
            this.plugin.settings.narrativeCanvasPathByProject?.[project.filePath] || '',
        ));

        if (candidates.length === 0) {
            this.listEl.createDiv({
                cls: 'ncanvas-empty',
                text: t('No .ncanvas files yet. Create one or generate a sample below.'),
            });
            return;
        }

        for (const path of candidates) {
            const row = this.listEl.createDiv({ cls: 'ncanvas-file-row' });
            if (path === remembered) row.addClass('is-current');

            const info = row.createDiv({ cls: 'ncanvas-file-info' });
            const name = path.split('/').pop() || path;
            info.createDiv({ cls: 'ncanvas-file-name', text: name });
            info.createDiv({ cls: 'ncanvas-file-path', text: path });
            if (path === remembered) {
                info.createSpan({ cls: 'ncanvas-file-badge', text: t('Current') });
            }

            const openBtn = row.createEl('button', {
                cls: 'mod-cta',
                attr: { type: 'button', 'aria-label': t('Open') },
            });
            setIcon(openBtn, 'folder-open');
            openBtn.createSpan({ text: t('Open') });
            openBtn.addEventListener('click', () => {
                void this.openPath(path);
            });

            row.addEventListener('dblclick', () => {
                void this.openPath(path);
            });
        }
    }

    private async openPath(path: string): Promise<void> {
        try {
            await this.plugin.openNarrativeCanvas(path);
            this.close();
        } catch (err) {
            console.error(err);
            new Notice(t('Failed to open Narrative Canvas: {err}', { err: String(err) }));
        }
    }

    private async createBlank(): Promise<void> {
        try {
            const path = await this.plugin.createBlankNcanvasInActiveProject(this.nameInput);
            if (!path) return;
            this.close();
        } catch (err) {
            console.error(err);
            new Notice(t('Failed to create ncanvas: {err}', { err: String(err) }));
        }
    }

    private async createSample(language: SampleNcanvasLanguage): Promise<void> {
        try {
            const path = await this.plugin.createSampleNcanvasInActiveProject(language);
            if (!path) return;
            this.close();
        } catch (err) {
            console.error(err);
            new Notice(t('Failed to create sample ncanvas: {err}', { err: String(err) }));
        }
    }
}
