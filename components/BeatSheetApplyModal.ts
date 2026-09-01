/* eslint-disable @typescript-eslint/no-misused-promises -- Obsidian callbacks and DOM handlers intentionally run async work. */
import { App, Modal, Notice, Setting } from 'obsidian';
import type { BeatSheetApplyOptions, BeatSheetTemplate, ExistingSceneStructureHandling, SceneTemplate } from '../models/Scene';
import type { SceneManager } from '../services/SceneManager';
import { t } from '../utils/i18n';

export class BeatSheetApplyModal extends Modal {
    private options: BeatSheetApplyOptions = {
        mode: 'merge',
        existingScenes: 'keep',
        createPlaceholderScenes: false,
    };

    constructor(
        app: App,
        private sceneManager: SceneManager,
        private template: BeatSheetTemplate,
        private sceneTemplates: SceneTemplate[],
        private onApplied: (result: { scenesChanged: number; scenesCreated: number }) => void | Promise<void>,
        defaults?: BeatSheetApplyOptions,
    ) {
        super(app);
        this.options = { ...this.options, ...defaults };
    }

    onOpen(): void {
        this.titleEl.setText(t('Apply structure: {name}', { name: this.template.name }));
        const previewEl = this.contentEl.createDiv('template-apply-preview');
        const renderPreview = () => {
            previewEl.empty();
            const preview = this.sceneManager.previewBeatSheetApplication(this.template, this.options);
            previewEl.createEl('p', {
                text: t('Acts: {before} → {after}; chapters: {chaptersBefore} → {chaptersAfter}.', {
                    before: preview.actsBefore,
                    after: preview.actsAfter,
                    chaptersBefore: preview.chaptersBefore,
                    chaptersAfter: preview.chaptersAfter,
                }),
            });
            if (preview.scenesToRemap > 0) previewEl.createEl('p', { text: t('{n} existing scene(s) will be remapped.', { n: preview.scenesToRemap }) });
            if (preview.scenesToUncategorize > 0) previewEl.createEl('p', { text: t('{n} existing scene(s) will become uncategorized.', { n: preview.scenesToUncategorize }) });
            if (preview.placeholdersToCreate > 0) previewEl.createEl('p', { text: t('{n} missing beat scene(s) will be created.', { n: preview.placeholdersToCreate }) });
            previewEl.createEl('p', { cls: 'setting-item-description', text: t('Existing scene files are never deleted when applying a structure.') });
        };

        new Setting(this.contentEl)
            .setName(t('Apply mode'))
            .setDesc(t('Merge keeps the current structure. Replace uses the selected scene-handling rule.'))
            .addDropdown(dropdown => dropdown
                .addOption('merge', t('Merge with current structure'))
                .addOption('replace', t('Replace current structure'))
                .setValue(this.options.mode || 'merge')
                .onChange(value => {
                    this.options.mode = value === 'replace' ? 'replace' : 'merge';
                    sceneHandling.settingEl.toggle(this.options.mode === 'replace');
                    renderPreview();
                }));

        const sceneHandling = new Setting(this.contentEl)
            .setName(t('Existing scenes'))
            .setDesc(t('Choose how current act and chapter assignments are handled.'))
            .addDropdown(dropdown => dropdown
                .addOption('keep', t('Keep existing numbering'))
                .addOption('remap', t('Remap to the new structure'))
                .addOption('uncategorized', t('Move to uncategorized'))
                .setValue(this.options.existingScenes || 'keep')
                .onChange(value => {
                    this.options.existingScenes = value as ExistingSceneStructureHandling;
                    renderPreview();
                }));
        sceneHandling.settingEl.toggle(this.options.mode === 'replace');

        new Setting(this.contentEl)
            .setName(t('Create beat scenes'))
            .setDesc(t('Create one placeholder scene for every missing beat.'))
            .addToggle(toggle => toggle
                .setValue(this.options.createPlaceholderScenes === true)
                .onChange(value => {
                    this.options.createPlaceholderScenes = value;
                    sceneTemplateSetting.settingEl.toggle(value);
                    renderPreview();
                }));

        const sceneTemplateSetting = new Setting(this.contentEl)
            .setName(t('Placeholder scene template'))
            .setDesc(t('Optional fields and Markdown body for generated beat scenes.'))
            .addDropdown(dropdown => {
                dropdown.addOption('', t('Blank'));
                this.sceneTemplates.forEach((template, index) => dropdown.addOption(String(index), template.name));
                const selectedIndex = this.sceneTemplates.findIndex(template =>
                    template.id && this.options.sceneTemplate?.id
                        ? template.id === this.options.sceneTemplate.id
                        : template.name === this.options.sceneTemplate?.name,
                );
                dropdown.setValue(selectedIndex >= 0 ? String(selectedIndex) : '');
                dropdown.onChange(value => {
                    this.options.sceneTemplate = value === '' ? undefined : this.sceneTemplates[Number(value)];
                });
            });
        sceneTemplateSetting.settingEl.toggle(this.options.createPlaceholderScenes === true);
        renderPreview();

        const buttons = this.contentEl.createDiv('story-line-button-row');
        buttons.createEl('button', { text: t('Cancel') }).addEventListener('click', () => this.close());
        const apply = buttons.createEl('button', { text: t('Apply'), cls: 'mod-cta' });
        apply.addEventListener('click', async () => {
            apply.disabled = true;
            try {
                const result = await this.sceneManager.applyBeatSheet(this.template, this.options);
                await this.onApplied(result);
                new Notice(t('Applied "{name}": {changed} scene(s) updated, {created} created.', {
                    name: this.template.name,
                    changed: result.scenesChanged,
                    created: result.scenesCreated,
                }));
                this.close();
            } catch (error) {
                new Notice(t('Could not apply structure: {message}', { message: error instanceof Error ? error.message : String(error) }));
                apply.disabled = false;
            }
        });
    }

    onClose(): void {
        this.contentEl.empty();
    }
}
/* eslint-enable @typescript-eslint/no-misused-promises -- End Obsidian callback exception. */
