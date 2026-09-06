import { Modal, Notice, Setting, setIcon, type App } from 'obsidian';
import type SceneCardsPlugin from '../main';
import type { StoryLineProject } from '../models/StoryLineProject';
import {
    PROJECT_PRESETS,
    capabilitiesForPreset,
    resolveModuleDependencies,
    type ProjectModuleId,
    type ProjectPresetId,
} from '../models/ProjectCapabilities';
import { t } from '../utils/i18n';
import { renderProjectModulePicker } from './ProjectModulePicker';
import { PROJECT_PAGES, PROJECT_TAB_GROUPS } from '../models/ProjectPages';
export { PROJECT_MODULE_LABELS } from './ProjectModulePicker';

export const PROJECT_PRESET_LABELS: Record<ProjectPresetId, string> = {
    'plain-writing': 'Plain writing', essay: 'Essay', 'research-paper': 'Research paper',
    'literature-review': 'Literature review', novel: 'Novel',
    'full-narrative': 'Full narrative', custom: 'Custom', 'legacy-full': 'Legacy full',
};

export class ProjectModulesModal extends Modal {
    private static nextId = 0;
    private readonly panelId = `nl-project-settings-${++ProjectModulesModal.nextId}`;
    private activeSection: 'modules' | 'layout' | 'counting' = 'modules';
    private selected = new Set<ProjectModuleId>();
    private preset: ProjectPresetId;
    private wordCountProfile: import('../models/ProjectCapabilities').WordCountProfileId;
    private navigation: NonNullable<import('../models/ProjectCapabilities').ProjectCapabilities['navigation']>;

    constructor(app: App, private plugin: SceneCardsPlugin, private project: StoryLineProject) {
        super(app);
        const current = plugin.capabilityService.get(project);
        this.preset = current.preset;
        this.wordCountProfile = current.wordCountProfile;
        this.selected = new Set(current.modules);
        this.navigation = current.navigation ?? { order: PROJECT_PAGES.map(page => page.module), hidden: [] };
    }

    onOpen(): void { this.render(); }
    onClose(): void { this.contentEl.empty(); }

    private render(): void {
        this.contentEl.empty();
        this.modalEl.addClass('nl-project-settings-modal', 'nl-project-settings-editor');
        this.contentEl.addClass('nl-settings-shell');
        this.titleEl.setText(t('Project settings'));
        const identity = this.contentEl.createDiv('nl-settings-identity');
        setIcon(identity.createSpan('nl-settings-project-icon'), 'folder');
        identity.createSpan({ text: this.project.title, cls: 'nl-project-settings-name' });
        const tabs = this.contentEl.createDiv({ cls: 'nl-settings-tabs', attr: { role: 'tablist', 'aria-label': t('Project settings') } });
        const viewport = this.contentEl.createDiv('nl-settings-viewport');
        const panels = {
            modules: viewport.createDiv('nl-settings-panel'),
            layout: viewport.createDiv('nl-settings-panel'),
            counting: viewport.createDiv('nl-settings-panel'),
        };
        const sections = [
            { id: 'modules' as const, label: t('Modules'), icon: 'blocks' },
            { id: 'layout' as const, label: t('Tab layout'), icon: 'panel-top' },
            { id: 'counting' as const, label: t('Word counting'), icon: 'text-cursor-input' },
        ];
        const tabButtons: HTMLButtonElement[] = [];
        const selectSection = (id: typeof this.activeSection) => {
            this.activeSection = id;
            for (const [index, section] of sections.entries()) {
                const selected = section.id === id;
                panels[section.id].hidden = !selected;
                tabButtons[index].setAttr('aria-selected', String(selected));
                tabButtons[index].tabIndex = selected ? 0 : -1;
            }
            viewport.scrollTop = 0;
        };
        for (const [index, section] of sections.entries()) {
            const id = `${this.panelId}-${section.id}`;
            panels[section.id].setAttr('id', id);
            panels[section.id].setAttr('role', 'tabpanel');
            panels[section.id].setAttr('aria-labelledby', `${id}-tab`);
            const button = tabs.createEl('button', { cls: 'nl-settings-tab', attr: { type: 'button', role: 'tab', id: `${id}-tab`, 'aria-controls': id } });
            setIcon(button.createSpan({ cls: 'nl-settings-tab-icon', attr: { 'aria-hidden': 'true' } }), section.icon);
            button.createSpan({ text: section.label });
            button.addEventListener('click', () => selectSection(section.id));
            button.addEventListener('keydown', event => {
                const delta = event.key === 'ArrowRight' ? 1 : event.key === 'ArrowLeft' ? -1 : 0;
                if (!delta && event.key !== 'Home' && event.key !== 'End') return;
                event.preventDefault();
                const target = event.key === 'Home' ? 0 : event.key === 'End' ? sections.length - 1 : (index + delta + sections.length) % sections.length;
                selectSection(sections[target].id);
                tabButtons[target].focus();
            });
            tabButtons.push(button);
        }
        selectSection(this.activeSection);
        const presetSetting = new Setting(panels.modules).setName(t('Project preset')).addDropdown(dropdown => {
            for (const id of Object.keys(PROJECT_PRESETS) as ProjectPresetId[]) {
                if (id === 'legacy-full') continue;
                dropdown.addOption(id, t(PROJECT_PRESET_LABELS[id]));
            }
            dropdown.setValue(this.preset === 'legacy-full' ? 'full-narrative' : this.preset);
            dropdown.onChange(value => {
                this.preset = value as ProjectPresetId;
                const capabilities = capabilitiesForPreset(this.preset);
                this.selected = new Set(capabilities.modules);
                this.wordCountProfile = capabilities.wordCountProfile;
                this.render();
            });
        });
        presetSetting.settingEl.addClass('nl-settings-preset');
        new Setting(panels.counting).setName(t('Word count profile'))
            .setDesc(t('General counts readable prose, including checklists. Academic also skips citations, footnotes, and a trailing references section. Narrative skips comments and checklists but keeps footnotes. Custom follows the comment and checklist switches in plugin settings. Language still follows the project locale.'))
            .addDropdown(dropdown => {
            dropdown.addOption('general', t('General'));
            dropdown.addOption('academic', t('Academic'));
            dropdown.addOption('narrative', t('Narrative'));
            dropdown.addOption('custom', t('Custom'));
            dropdown.setValue(this.wordCountProfile);
            dropdown.onChange(value => {
                this.wordCountProfile = value as import('../models/ProjectCapabilities').WordCountProfileId;
                this.preset = 'custom';
                presetSetting.settingEl.querySelector<HTMLSelectElement>('select')!.value = 'custom';
            });
        });
        const layoutBody = panels.layout;
        const renderLayout = () => {
            layoutBody.empty();
            new Setting(layoutBody).setName(t('Default project page')).addDropdown(dropdown => {
                dropdown.addOption('', t('Automatic'));
                for (const page of PROJECT_PAGES.filter(page => this.selected.has(page.module))) dropdown.addOption(page.module, t(page.label));
                dropdown.setValue(this.navigation.defaultPage ?? '');
                dropdown.onChange(value => { this.navigation.defaultPage = value ? value as ProjectModuleId : undefined; });
            });
            layoutBody.createEl('p', { text: t('Tab groups only organize the tab bar. Each page can still be turned on or off in Modules.'), cls: 'setting-item-description' });
            layoutBody.createEl('p', { text: t('Hidden tabs remain available in More. Modules and files are not disabled.'), cls: 'setting-item-description' });
            const order = [...new Set([...this.navigation.order, ...PROJECT_PAGES.map(page => page.module)])];
            const pages = order.map(id => PROJECT_PAGES.find(page => page.module === id)).filter(page => page && this.selected.has(page.module));
            let lastGroup = '';
            for (const [index, page] of pages.entries()) {
                if (!page) continue;
                const group = PROJECT_TAB_GROUPS.find(item => item.modules.includes(page.module));
                if (group && group.id !== lastGroup) {
                    lastGroup = group.id;
                    layoutBody.createEl('h4', { text: t(group.label), cls: 'nl-layout-group-heading' });
                }
                const setting = new Setting(layoutBody).setName(t(page.label));
                setting.addButton(button => button.setIcon('arrow-up').setTooltip(t('Move up')).setDisabled(index === 0).onClick(() => {
                    const previous = pages[index - 1];
                    if (!previous) return;
                    const a = order.indexOf(page.module), b = order.indexOf(previous.module);
                    [order[a], order[b]] = [order[b], order[a]];
                    this.navigation.order = order;
                    renderLayout();
                }));
                setting.addButton(button => button.setIcon('arrow-down').setTooltip(t('Move down')).setDisabled(index === pages.length - 1).onClick(() => {
                    const next = pages[index + 1];
                    if (!next) return;
                    const a = order.indexOf(page.module), b = order.indexOf(next.module);
                    [order[a], order[b]] = [order[b], order[a]];
                    this.navigation.order = order;
                    renderLayout();
                }));
                setting.addToggle(toggle => toggle.setValue(!this.navigation.hidden.includes(page.module)).setTooltip(t('Show in tab bar')).onChange(show => {
                    this.navigation.hidden = this.navigation.hidden.filter(id => id !== page.module);
                    if (!show) this.navigation.hidden.push(page.module);
                }));
            }
        };
        renderLayout();
        renderProjectModulePicker(panels.modules.createDiv('nl-project-module-choices'), this.selected, next => {
            this.selected = next;
            this.preset = 'custom';
            presetSetting.settingEl.querySelector<HTMLSelectElement>('select')!.value = 'custom';
            renderLayout();
        }, {
            chapterTemplatesAvailable: this.plugin.capabilityService.isEnabled('chapterTemplates', this.project),
            openChapterTemplates: () => { void this.plugin.openChapterTemplates(this.project).catch(error => new Notice(String(error))); },
        });
        const footer = this.contentEl.createDiv('nl-settings-footer');
        footer.createSpan({ cls: 'nl-settings-safety-note', text: t('Disabled modules keep their data.') });
        new Setting(footer).addButton(button => button.setButtonText(t('Cancel')).onClick(() => this.close()))
        .addButton(button => button.setButtonText(t('Save')).setCta().onClick(async () => {
            button.setDisabled(true);
            try {
                const modules = resolveModuleDependencies(this.selected);
                const base = capabilitiesForPreset(this.preset);
                await this.plugin.updateProjectModules(this.project, {
                    ...base, preset: this.preset, modules, wordCountProfile: this.wordCountProfile, navigation: this.navigation,
                });
                new Notice(t('Project modules updated. Disabled module data was kept.'));
                this.close();
            } catch (error) {
                new Notice(t('Could not save project settings. Your files were kept.') + ' ' + String(error));
                button.setDisabled(false);
            }
        }));
    }
}
