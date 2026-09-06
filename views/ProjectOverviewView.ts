import type { ViewStateResult, WorkspaceLeaf } from 'obsidian';
import type SceneCardsPlugin from '../main';
import { PROJECT_OVERVIEW_VIEW_TYPE } from '../constants';
import { renderViewSwitcher } from '../components/ViewSwitcher';
import { ProjectModulesModal } from '../components/ProjectModulesModal';
import { ProjectBoundItemView } from './ProjectBoundItemView';
import { t } from '../utils/i18n';

/** A lightweight, project-bound landing page; never initializes optional engines. */
export class ProjectOverviewView extends ProjectBoundItemView {
    private moduleDisabled = false;
    constructor(leaf: WorkspaceLeaf, private plugin: SceneCardsPlugin) {
        super(leaf);
        this.captureProjectBinding(plugin.sceneManager);
    }
    getViewType(): string { return PROJECT_OVERVIEW_VIEW_TYPE; }
    getDisplayText(): string { return this.plugin.getProjectDisplayName(this.getBoundProjectFile()); }
    getIcon(): string { return 'folder-open'; }
    async onOpen(): Promise<void> { this.refresh(); }
    async setState(state: Record<string, unknown>, result: ViewStateResult): Promise<void> {
        await super.setState(state, result);
        this.moduleDisabled = state.moduleDisabled === true;
        this.refresh();
    }
    getState(): Record<string, unknown> { return { ...super.getState(), moduleDisabled: this.moduleDisabled }; }
    refresh(): void {
        this.contentEl.empty();
        const toolbar = this.contentEl.createDiv('story-line-toolbar');
        toolbar.createEl('h3', { text: this.getDisplayText(), cls: 'story-line-view-title' });
        renderViewSwitcher(toolbar, this.getViewType(), this.plugin, this.leaf);
        const body = this.contentEl.createDiv('nl-project-overview');
        body.createEl('h2', { text: t(this.moduleDisabled ? 'This module is disabled' : 'Project overview') });
        body.createEl('p', { text: t('Choose a project tab or enable a module in project settings. Existing files are kept.') });
        const button = body.createEl('button', { text: t('Project settings'), cls: 'mod-cta' });
        button.addEventListener('click', () => {
            const project = this.plugin.sceneManager.getProjects().find(p => p.filePath === this.getBoundProjectFile());
            if (project) new ProjectModulesModal(this.app, this.plugin, project).open();
        });
    }
}
