/* eslint-disable @typescript-eslint/no-misused-promises -- menu callbacks are fire-and-forget by design */
import { Menu, Modal, Notice, Setting, type App } from 'obsidian';
import type SceneCardsPlugin from '../main';
import type { StoryLineProject } from '../models/StoryLineProject';
import {
    BUILTIN_BEAT_SHEETS,
    BUILTIN_SCENE_TEMPLATES,
    type BeatSheetTemplate,
    type ProjectPresetTemplate,
    type SceneTemplate,
} from '../models/Scene';
import { readLibraryCategorySettings } from '../services/LibraryCategorySync';
import { localizeBeatSheet, localizeSceneTemplate, t } from '../utils/i18n';
import { showMenuSafely } from '../utils/obsidianMenu';
import {
    ProjectPresetEditorModal,
    StructureTemplateEditorModal,
    TemplateEditorModal,
} from '../settings';

/**
 * Right-click / overflow menu for a project row in the Navigator.
 * Project-scoped actions live here — not in the global Settings tab.
 */
export function showProjectNavigatorMenu(
    plugin: SceneCardsPlugin,
    project: StoryLineProject,
    event: MouseEvent,
): void {
    const menu = new Menu();
    const isActive = plugin.sceneManager.activeProject?.filePath === project.filePath;
    const inSeries = plugin.sceneManager.isProjectInValidSeries(project);
    const run = async (fn: () => Promise<void> | void) => {
        try {
            if (!isActive) await plugin.sceneManager.setActiveProject(project);
            await fn();
        } catch (err) {
            new Notice(t('Failed to open project: ') + String(err));
        }
    };

    menu.addItem(item => {
        item.setTitle(t('Open Project'));
        item.setIcon('folder-open');
        item.onClick(() => { void plugin.openBoardForProject(project); });
    });

    menu.addItem(item => {
        item.setTitle(t('Rename…'));
        item.setIcon('pencil');
        item.onClick(() => {
            void run(async () => {
                (plugin.app as unknown as { commands: { executeCommandById: (id: string) => void } })
                    .commands.executeCommandById('narrative-lab:rename-project');
            });
        });
    });

    if (!inSeries) {
        menu.addItem(item => {
            item.setTitle(t('Create Series…'));
            item.setIcon('library');
            item.onClick(() => {
                void run(async () => {
                    (plugin.app as unknown as { commands: { executeCommandById: (id: string) => void } })
                        .commands.executeCommandById('narrative-lab:create-series');
                });
            });
        });
    }

    menu.addItem(item => {
        item.setTitle(t('Manage Series…'));
        item.setIcon('list');
        item.onClick(() => {
            void run(() => {
                plugin.openSeriesManagementModal();
            });
        });
    });

    menu.addSeparator();

    menu.addItem(item => {
        item.setTitle(t('Use project-specific colors'));
        item.setIcon('palette');
        if (isActive) item.setChecked(!!plugin.settings.useProjectColors);
        item.onClick(() => {
            void run(async () => {
                await plugin.setUseProjectColors(!plugin.settings.useProjectColors);
                new Notice(plugin.settings.useProjectColors
                    ? t('Project-specific colors enabled for "{name}".', { name: project.title })
                    : t('Using global color defaults for "{name}".', { name: project.title }));
            });
        });
    });

    menu.addItem(item => {
        item.setTitle(t('Project templates…'));
        item.setIcon('layout-template');
        item.onClick(() => {
            void run(() => {
                new ProjectTemplatesModal(plugin.app, plugin).open();
            });
        });
    });

    menu.addItem(item => {
        item.setTitle(t('Save as global preset…'));
        item.setIcon('bookmark');
        item.onClick(() => {
            void run(() => {
                openCaptureGlobalPresetModal(plugin);
            });
        });
    });

    showMenuSafely(menu, event);
}

function openCaptureGlobalPresetModal(plugin: SceneCardsPlugin): void {
    const preset: ProjectPresetTemplate = {
        id: '',
        scope: 'global',
        name: plugin.sceneManager.activeProject?.title
            ? t('{name} preset', { name: plugin.sceneManager.activeProject.title })
            : '',
        libraryCategories: readLibraryCategorySettings(plugin.settings),
        fieldTemplates: plugin.fieldTemplates.getAll().map(field => ({ ...field })),
        libraryFieldTemplates: Object.fromEntries(
            Object.entries(plugin.settings.codexCategoryFieldTemplates || {})
                .map(([category, fields]) => [category, [...fields]]),
        ),
    };
    const structures = [
        ...BUILTIN_BEAT_SHEETS.map(localizeBeatSheet),
        ...plugin.templateCenter.getStructureTemplates(),
    ];
    const sceneTemplates = [
        ...BUILTIN_SCENE_TEMPLATES.map(localizeSceneTemplate),
        ...plugin.templateCenter.getSceneTemplates(),
    ];
    new ProjectPresetEditorModal(
        plugin.app,
        preset,
        structures,
        sceneTemplates,
        async updated => {
            updated.scope = 'global';
            await plugin.templateCenter.saveProjectPreset(updated);
            new Notice(t('Saved global preset "{name}".', { name: updated.name }));
        },
        { forceScope: 'global' },
    ).open();
}

/** Manage templates stored under the active project's System/Templates/. */
class ProjectTemplatesModal extends Modal {
    constructor(app: App, private plugin: SceneCardsPlugin) {
        super(app);
    }

    onOpen(): void {
        this.titleEl.setText(t('Project templates'));
        this.renderBody();
    }

    onClose(): void {
        this.contentEl.empty();
    }

    private renderBody(): void {
        const { contentEl } = this;
        contentEl.empty();
        contentEl.createEl('p', {
            cls: 'setting-item-description',
            text: t('These templates are saved under System/Templates/ for the active project only. Global templates stay in Settings → Template Center.'),
        });

        const scenes = this.plugin.templateCenter.getSceneTemplates().filter(t => t.scope === 'project');
        const structures = this.plugin.templateCenter.getStructureTemplates().filter(t => t.scope === 'project');
        const presets = this.plugin.templateCenter.getProjectPresets().filter(t => t.scope === 'project');

        contentEl.createEl('h4', { text: t('Scene Templates') });
        this.renderSceneList(contentEl, scenes);
        new Setting(contentEl).addButton(btn => btn
            .setButtonText(t('Add Template'))
            .setCta()
            .onClick(() => {
                new TemplateEditorModal(this.app, {
                    id: '', scope: 'project', name: '', description: '', defaultFields: {}, bodyTemplate: '',
                }, async template => {
                    template.scope = 'project';
                    await this.plugin.templateCenter.saveSceneTemplate(template);
                    this.renderBody();
                }, { forceScope: 'project' }).open();
            }));

        contentEl.createEl('h4', { text: t('Narrative Structures') });
        this.renderStructureList(contentEl, structures);
        new Setting(contentEl).addButton(btn => btn
            .setButtonText(t('Add Structure'))
            .setCta()
            .onClick(() => {
                new StructureTemplateEditorModal(this.app, {
                    id: '', scope: 'project', name: '', summary: '', acts: [1, 2, 3], chapters: [],
                    actLabels: {}, chapterLabels: {}, beats: [],
                }, async template => {
                    template.scope = 'project';
                    await this.plugin.templateCenter.saveStructureTemplate(template);
                    this.renderBody();
                }, { forceScope: 'project' }).open();
            }));

        contentEl.createEl('h4', { text: t('Project Presets') });
        this.renderPresetList(contentEl, presets);
        new Setting(contentEl).addButton(btn => btn
            .setButtonText(t('Add Preset'))
            .setCta()
            .onClick(() => {
                const preset: ProjectPresetTemplate = {
                    id: '',
                    scope: 'project',
                    name: '',
                    libraryCategories: readLibraryCategorySettings(this.plugin.settings),
                    fieldTemplates: this.plugin.fieldTemplates.getAll().map(field => ({ ...field })),
                    libraryFieldTemplates: Object.fromEntries(
                        Object.entries(this.plugin.settings.codexCategoryFieldTemplates || {})
                            .map(([category, fields]) => [category, [...fields]]),
                    ),
                };
                new ProjectPresetEditorModal(
                    this.app,
                    preset,
                    [...BUILTIN_BEAT_SHEETS.map(localizeBeatSheet), ...this.plugin.templateCenter.getStructureTemplates()],
                    [...BUILTIN_SCENE_TEMPLATES.map(localizeSceneTemplate), ...this.plugin.templateCenter.getSceneTemplates()],
                    async updated => {
                        updated.scope = 'project';
                        await this.plugin.templateCenter.saveProjectPreset(updated);
                        this.renderBody();
                    },
                    { forceScope: 'project' },
                ).open();
            }));
    }

    private renderSceneList(parent: HTMLElement, templates: SceneTemplate[]): void {
        if (templates.length === 0) {
            parent.createEl('p', { cls: 'setting-item-description', text: t('No project scene templates yet.') });
            return;
        }
        for (const tpl of templates) {
            new Setting(parent)
                .setName(tpl.name || '(unnamed)')
                .setDesc(tpl.description || '')
                .addExtraButton(btn => btn.setIcon('pencil').setTooltip(t('Edit template')).onClick(() => {
                    new TemplateEditorModal(this.app, { ...tpl }, async updated => {
                        updated.scope = 'project';
                        await this.plugin.templateCenter.saveSceneTemplate(updated);
                        this.renderBody();
                    }, { forceScope: 'project' }).open();
                }))
                .addExtraButton(btn => btn.setIcon('trash').setTooltip(t('Delete template')).onClick(async () => {
                    if (tpl.id) await this.plugin.templateCenter.deleteTemplate('scene', tpl.id);
                    this.renderBody();
                }));
        }
    }

    private renderStructureList(parent: HTMLElement, templates: BeatSheetTemplate[]): void {
        if (templates.length === 0) {
            parent.createEl('p', { cls: 'setting-item-description', text: t('No project structures yet.') });
            return;
        }
        for (const template of templates) {
            new Setting(parent)
                .setName(template.name)
                .setDesc(`${template.beats.length} ${t('beats')}`)
                .addExtraButton(btn => btn.setIcon('pencil').setTooltip(t('Edit template')).onClick(() => {
                    new StructureTemplateEditorModal(this.app, { ...template }, async updated => {
                        updated.scope = 'project';
                        await this.plugin.templateCenter.saveStructureTemplate(updated);
                        this.renderBody();
                    }, { forceScope: 'project' }).open();
                }))
                .addExtraButton(btn => btn.setIcon('trash').setTooltip(t('Delete template')).onClick(async () => {
                    if (template.id) await this.plugin.templateCenter.deleteTemplate('structure', template.id);
                    this.renderBody();
                }));
        }
    }

    private renderPresetList(parent: HTMLElement, presets: ProjectPresetTemplate[]): void {
        if (presets.length === 0) {
            parent.createEl('p', { cls: 'setting-item-description', text: t('No project presets yet.') });
            return;
        }
        const structures = [...BUILTIN_BEAT_SHEETS.map(localizeBeatSheet), ...this.plugin.templateCenter.getStructureTemplates()];
        const sceneTemplates = [...BUILTIN_SCENE_TEMPLATES.map(localizeSceneTemplate), ...this.plugin.templateCenter.getSceneTemplates()];
        for (const preset of presets) {
            new Setting(parent)
                .setName(preset.name)
                .setDesc(preset.description || '')
                .addExtraButton(btn => btn.setIcon('pencil').setTooltip(t('Edit template')).onClick(() => {
                    new ProjectPresetEditorModal(this.app, { ...preset }, structures, sceneTemplates, async updated => {
                        updated.scope = 'project';
                        await this.plugin.templateCenter.saveProjectPreset(updated);
                        this.renderBody();
                    }, { forceScope: 'project' }).open();
                }))
                .addExtraButton(btn => btn.setIcon('trash').setTooltip(t('Delete template')).onClick(async () => {
                    await this.plugin.templateCenter.deleteTemplate('preset', preset.id);
                    this.renderBody();
                }));
        }
    }
}
