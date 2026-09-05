import { Modal, Notice, Setting, type App } from 'obsidian';
import type SceneCardsPlugin from '../main';
import type { StoryLineProject } from '../models/StoryLineProject';
import {
    PROJECT_MODULE_IDS,
    PROJECT_PRESETS,
    capabilitiesForPreset,
    resolveModuleDependencies,
    type ProjectModuleId,
    type ProjectPresetId,
} from '../models/ProjectCapabilities';
import { t } from '../utils/i18n';

export const PROJECT_PRESET_LABELS: Record<ProjectPresetId, string> = {
    'plain-writing': 'Plain writing', essay: 'Essay', 'research-paper': 'Research paper',
    'literature-review': 'Literature review', novel: 'Novel',
    'full-narrative': 'Full narrative', custom: 'Custom', 'legacy-full': 'Legacy full',
};

export const PROJECT_MODULE_LABELS: Record<ProjectModuleId, string> = {
    manuscript: 'Manuscript', notes: 'Notes', outline: 'Outline',
    writingTracker: 'Writing tracker', writingStats: 'Writing statistics',
    research: 'Research', library: 'Library', table: 'Table', canvas: 'Canvas',
    citations: 'Citation helpers', scenes: 'Scenes', board: 'Board',
    structure: 'Structure', plotlines: 'Plotlines', timeline: 'Timeline',
    characters: 'Characters', locations: 'Locations', sceneDetails: 'Scene details',
    sceneNotes: 'Scene notes', synopsis: 'Synopsis', series: 'Series',
};

export class ProjectModulesModal extends Modal {
    private selected = new Set<ProjectModuleId>();
    private preset: ProjectPresetId;
    private wordCountProfile: import('../models/ProjectCapabilities').WordCountProfileId;

    constructor(app: App, private plugin: SceneCardsPlugin, private project: StoryLineProject) {
        super(app);
        const current = plugin.capabilityService.get(project);
        this.preset = current.preset;
        this.wordCountProfile = current.wordCountProfile;
        this.selected = new Set(current.modules);
    }

    onOpen(): void { this.render(); }
    onClose(): void { this.contentEl.empty(); }

    private render(): void {
        this.contentEl.empty();
        this.titleEl.setText(t('Project modules'));
        new Setting(this.contentEl).setName(t('Project preset')).addDropdown(dropdown => {
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
        this.contentEl.createEl('p', {
            cls: 'setting-item-description',
            text: t('Disabling a module keeps its files. Re-enable it to restore access.'),
        });
        new Setting(this.contentEl).setName(t('Word count profile')).addDropdown(dropdown => {
            dropdown.addOption('general', t('General'));
            dropdown.addOption('academic', t('Academic'));
            dropdown.addOption('narrative', t('Narrative'));
            dropdown.addOption('custom', t('Custom'));
            dropdown.setValue(this.wordCountProfile);
            dropdown.onChange(value => {
                this.wordCountProfile = value as import('../models/ProjectCapabilities').WordCountProfileId;
                this.preset = 'custom';
            });
        });
        for (const module of PROJECT_MODULE_IDS) {
            new Setting(this.contentEl).setName(t(PROJECT_MODULE_LABELS[module])).addToggle(toggle => {
                toggle.setValue(this.selected.has(module));
                toggle.onChange(enabled => {
                    if (enabled) this.selected.add(module); else this.selected.delete(module);
                    this.preset = 'custom';
                });
            });
        }
        new Setting(this.contentEl).addButton(button => button.setButtonText(t('Save')).setCta().onClick(async () => {
            const modules = resolveModuleDependencies(this.selected);
            const base = capabilitiesForPreset(this.preset);
            await this.plugin.capabilityService.apply(this.project, {
                ...base, preset: this.preset, modules, wordCountProfile: this.wordCountProfile,
            });
            this.plugin.closeDisabledProjectViews(this.project);
            await this.plugin.refreshOpenViews();
            new Notice(t('Project modules updated. Disabled module data was kept.'));
            this.close();
        })).addButton(button => button.setButtonText(t('Cancel')).onClick(() => this.close()));
    }
}
