import {
    Modal,
    Notice,
    Setting,
    TFile,
    WorkspaceLeaf,
    normalizePath,
    setIcon,
} from 'obsidian';
import type SceneCardsPlugin from '../main';
import { NCANVAS_LIBRARY_VIEW_TYPE } from '../constants';
import { renderViewSwitcher } from '../components/ViewSwitcher';
import { applyMobileClass } from '../components/MobileAdapter';
import { attachTooltip } from '../components/Tooltip';
import { t } from '../utils/i18n';
import { ProjectBoundItemView } from './ProjectBoundItemView';

type NameAction = 'create' | 'rename';

class CanvasNameModal extends Modal {
    private value: string;

    constructor(
        private plugin: SceneCardsPlugin,
        private action: NameAction,
        initialValue: string,
        private canvasPath: string | null,
        private onDone: () => void,
    ) {
        super(plugin.app);
        this.value = initialValue;
        this.titleEl.setText(t(action === 'create' ? 'New canvas' : 'Rename canvas'));
    }

    onOpen(): void {
        this.contentEl.empty();
        const setting = new Setting(this.contentEl)
            .setName(t('Canvas name'))
            .setDesc(t('The canvas is stored as a project-local .ncanvas file.'));
        setting.addText(text => {
            text.setPlaceholder(t('Untitled Canvas'));
            text.setValue(this.value);
            text.onChange(value => { this.value = value; });
            window.setTimeout(() => {
                text.inputEl.focus();
                text.inputEl.select();
            }, 0);
            text.inputEl.addEventListener('keydown', event => {
                if (event.key !== 'Enter') return;
                event.preventDefault();
                void this.submit();
            });
        });
        setting.addButton(button => button
            .setButtonText(t(this.action === 'create' ? 'Create and open' : 'Rename'))
            .setCta()
            .onClick(() => { void this.submit(); }));
    }

    private async submit(): Promise<void> {
        const name = this.value.trim();
        if (!name) {
            new Notice(t('Enter a canvas name.'));
            return;
        }
        try {
            if (this.action === 'create') {
                await this.plugin.createBlankNcanvasInActiveProject(name);
            } else if (this.canvasPath) {
                await this.plugin.renameNcanvasInActiveProject(this.canvasPath, name);
                this.onDone();
            }
            this.close();
        } catch (error) {
            console.error('NarrativeLab: canvas name action failed', error);
            new Notice(t('Canvas operation failed: {error}', { error: String(error) }));
        }
    }
}

class DeleteCanvasModal extends Modal {
    constructor(
        private plugin: SceneCardsPlugin,
        private path: string,
        private onDone: () => void,
    ) {
        super(plugin.app);
        this.titleEl.setText(t('Delete canvas?'));
    }

    onOpen(): void {
        this.contentEl.empty();
        this.contentEl.createEl('p', {
            text: t('“{name}” will be moved to the Obsidian trash. Other canvases are not affected.', {
                name: this.path.split('/').pop()?.replace(/\.n(?:arrative)?canvas$/i, '') || this.path,
            }),
        });
        const actions = this.contentEl.createDiv('modal-button-container');
        const cancel = actions.createEl('button', { text: t('Cancel'), attr: { type: 'button' } });
        cancel.addEventListener('click', () => this.close());
        const remove = actions.createEl('button', {
            text: t('Move to trash'),
            cls: 'mod-warning',
            attr: { type: 'button' },
        });
        remove.addEventListener('click', () => {
            void this.plugin.deleteNcanvasInActiveProject(this.path).then(() => {
                this.close();
                this.onDone();
            }).catch(error => {
                console.error('NarrativeLab: canvas delete failed', error);
                new Notice(t('Canvas operation failed: {error}', { error: String(error) }));
            });
        });
    }
}

export class NCanvasLibraryView extends ProjectBoundItemView {
    private renderEpoch = 0;

    constructor(
        leaf: WorkspaceLeaf,
        private plugin: SceneCardsPlugin,
    ) {
        super(leaf);
        this.ensureProjectBinding(plugin.sceneManager.activeProject?.filePath);
    }

    getViewType(): string {
        return NCANVAS_LIBRARY_VIEW_TYPE;
    }

    getDisplayText(): string {
        const project = this.resolveProject();
        return project ? `${project.title} · ${t('Canvas')}` : t('Canvas');
    }

    getIcon(): string {
        return 'panels-top-left';
    }

    async onOpen(): Promise<void> {
        this.captureProjectBinding(this.plugin.sceneManager);
        await this.render();
    }

    /** Re-read vault files when returning from a canvas created in another tab. */
    async refresh(): Promise<void> {
        await this.render();
    }

    private resolveProject() {
        const bound = normalizePath(this.getBoundProjectFile() || '');
        if (bound) {
            return this.plugin.sceneManager.getProjects()
                .find(project => normalizePath(project.filePath) === bound) || null;
        }
        return this.plugin.sceneManager.activeProject;
    }

    private async render(): Promise<void> {
        const epoch = ++this.renderEpoch;
        const container = this.containerEl.children[1] as HTMLElement;
        container.empty();
        container.addClass('narrative-lab-ncanvas-library-view');
        applyMobileClass(container);

        const toolbar = container.createDiv('story-line-toolbar');
        const titleRow = toolbar.createDiv('story-line-title-row');
        titleRow.createEl('h3', {
            cls: 'story-line-view-title',
            text: this.plugin.getProjectDisplayName(this.getBoundProjectFile()),
        });
        renderViewSwitcher(toolbar, NCANVAS_LIBRARY_VIEW_TYPE, this.plugin, this.leaf);

        const project = this.resolveProject();
        const content = container.createDiv('nl-ncanvas-library-content');
        if (!project) {
            content.createDiv({ cls: 'nl-ncanvas-empty', text: t('No active project. Open a project first.') });
            return;
        }

        const { canvasFolder, candidates } = this.plugin.getNcanvasPathsForProject(project);
        const heading = content.createDiv('nl-ncanvas-library-heading');
        const headingCopy = heading.createDiv('nl-ncanvas-library-heading-copy');
        headingCopy.createEl('h2', { text: t('Canvas box') });
        headingCopy.createEl('p', {
            text: t('{count} canvases · stored in {folder}', {
                count: candidates.length,
                folder: canvasFolder,
            }),
        });
        const actions = heading.createDiv('nl-ncanvas-library-actions');
        const sample = actions.createEl('button', { attr: { type: 'button' } });
        setIcon(sample, 'book-open');
        sample.createSpan({ text: t('Guide sample') });
        sample.addEventListener('click', () => {
            void this.plugin.createSampleNcanvasInActiveProject(
                this.plugin.getEffectiveInterfaceLanguage() === 'zh' ? 'zh' : 'en',
            );
        });
        const create = actions.createEl('button', { cls: 'mod-cta', attr: { type: 'button' } });
        setIcon(create, 'plus');
        create.createSpan({ text: t('New canvas') });
        create.addEventListener('click', () => this.openNameModal('create'));

        if (!candidates.length) {
            const empty = content.createDiv('nl-ncanvas-empty');
            const icon = empty.createDiv('nl-ncanvas-empty-icon');
            setIcon(icon, 'panels-top-left');
            empty.createEl('h3', { text: t('No canvases yet') });
            empty.createEl('p', { text: t('Create separate canvases for different story lines, systems, or visual plans.') });
            const emptyCreate = empty.createEl('button', {
                text: t('Create first canvas'),
                cls: 'mod-cta',
                attr: { type: 'button' },
            });
            emptyCreate.addEventListener('click', () => this.openNameModal('create'));
            return;
        }

        const remembered = normalizePath(String(
            this.plugin.settings.narrativeCanvasPathByProject?.[project.filePath] || '',
        ));
        const grid = content.createDiv('nl-ncanvas-card-grid');
        for (const path of candidates) {
            if (epoch !== this.renderEpoch) return;
            this.renderCard(grid, path, path === remembered);
        }
    }

    private renderCard(grid: HTMLElement, path: string, current: boolean): void {
        const file = this.plugin.app.vault.getAbstractFileByPath(path);
        if (!(file instanceof TFile)) return;
        const displayName = file.basename;
        const card = grid.createDiv(`nl-ncanvas-card${current ? ' is-current' : ''}`);
        card.tabIndex = 0;
        card.setAttr('role', 'button');
        card.setAttr('aria-label', t('Open canvas: {name}', { name: displayName }));

        const preview = card.createDiv('nl-ncanvas-card-preview');
        const previewIcon = preview.createDiv('nl-ncanvas-card-preview-icon');
        setIcon(previewIcon, 'workflow');
        if (current) preview.createSpan({ cls: 'nl-ncanvas-current-badge', text: t('Current') });

        const body = card.createDiv('nl-ncanvas-card-body');
        const copy = body.createDiv('nl-ncanvas-card-copy');
        copy.createEl('h3', { text: displayName });
        copy.createEl('p', {
            text: t('Modified {date} · {size}', {
                date: new Date(file.stat.mtime).toLocaleString(),
                size: this.formatFileSize(file.stat.size),
            }),
        });
        const cardActions = body.createDiv('nl-ncanvas-card-actions');
        const rename = cardActions.createEl('button', { attr: { type: 'button', 'aria-label': t('Rename canvas') } });
        setIcon(rename, 'pencil');
        attachTooltip(rename, t('Rename canvas'));
        rename.addEventListener('click', event => {
            event.stopPropagation();
            this.openNameModal('rename', path, displayName);
        });
        const remove = cardActions.createEl('button', { attr: { type: 'button', 'aria-label': t('Delete canvas') } });
        setIcon(remove, 'trash-2');
        attachTooltip(remove, t('Delete canvas'));
        remove.addEventListener('click', event => {
            event.stopPropagation();
            new DeleteCanvasModal(this.plugin, path, () => { void this.render(); }).open();
        });

        const open = () => { void this.plugin.openNarrativeCanvas(path); };
        card.addEventListener('click', event => {
            if ((event.target as HTMLElement).closest('button')) return;
            open();
        });
        card.addEventListener('keydown', event => {
            if (event.key !== 'Enter' && event.key !== ' ') return;
            event.preventDefault();
            open();
        });
    }

    private openNameModal(action: NameAction, path: string | null = null, initial = ''): void {
        new CanvasNameModal(this.plugin, action, initial, path, () => { void this.render(); }).open();
    }

    private formatFileSize(bytes: number): string {
        if (bytes < 1024) return `${bytes} B`;
        if (bytes < 1024 * 1024) return `${Math.max(1, Math.round(bytes / 1024))} KB`;
        return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
    }
}
