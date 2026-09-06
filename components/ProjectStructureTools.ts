/* eslint-disable @typescript-eslint/no-floating-promises, @typescript-eslint/no-misused-promises, @typescript-eslint/no-unnecessary-type-assertion -- Obsidian event handlers intentionally launch async work; matching enable at end of file */
import { App, Modal, Notice, Setting } from 'obsidian';
import type SceneCardsPlugin from '../main';
import type { SceneManager } from '../services/SceneManager';
import { BUILTIN_BEAT_SHEETS, BUILTIN_SCENE_TEMPLATES, type SceneStatus } from '../models/Scene';
import { t, localizeBeatSheet, localizeSceneTemplate } from '../utils/i18n';
import { BeatSheetApplyModal } from './BeatSheetApplyModal';
import { getActDisplayLabel } from '../utils/actChapter';

/** Project tool shared by settings and legacy restored structure views. */
export class ProjectStructureTools {
    constructor(private app: App, private plugin: SceneCardsPlugin, private sceneManager: SceneManager) {}
    open(): void {
        const modal = new Modal(this.app);
        modal.titleEl.setText(t('Chapter templates and structure'));
        modal.modalEl.addClass('nl-project-structure-tools');
        this.render(modal.contentEl, () => modal.close());
        modal.open();
    }
    render(contentEl: HTMLElement, onDone?: () => void): void {

        // ── Beat Sheet Templates section ──
        contentEl.createEl('h3', { text: t('Beat Sheet Templates') });
        contentEl.createEl('p', {
            cls: 'setting-item-description',
            text: t('Apply a template to pre-populate your act/chapter structure with named beats.')
        });

        const templateGrid = contentEl.createDiv('beat-sheet-list');
        const structureTemplates = [...BUILTIN_BEAT_SHEETS, ...this.plugin.templateCenter.getStructureTemplates()];
        for (const rawTemplate of structureTemplates) {
            const template = localizeBeatSheet(rawTemplate);
            const row = templateGrid.createDiv('beat-sheet-row');

            const textWrap = row.createDiv('beat-sheet-row-text');
            const headerLine = textWrap.createDiv('beat-sheet-row-header');
            headerLine.createSpan({ cls: 'beat-sheet-row-name', text: template.name });
            const info = headerLine.createSpan({ cls: 'beat-sheet-row-info' });
            const parts = [
                t('{n} beats', { n: template.beats.length }),
                t('{n} acts', { n: template.acts.length }),
            ];
            if (template.chapters.length > 0) parts.push(t('{n} chapters', { n: template.chapters.length }));
            info.textContent = parts.join(' · ');
            textWrap.createDiv({ cls: 'beat-sheet-row-summary', text: template.summary });

            // Expandable beat preview
            const beatList = row.createDiv('beat-sheet-beats-preview');
            for (const beat of template.beats) {
                const beatItem = beatList.createDiv('beat-sheet-beat-item');
                beatItem.createSpan({ cls: 'beat-sheet-beat-act', text: `A${beat.act}` });
                beatItem.createSpan({ cls: 'beat-sheet-beat-label', text: beat.label });
                beatItem.createSpan({ cls: 'beat-sheet-beat-desc', text: beat.description });
            }

            const expandBtn = row.createEl('button', { cls: 'beat-sheet-expand-btn clickable-icon', attr: { 'aria-label': t('Show beats') } });
            expandBtn.textContent = '▸';
            expandBtn.addEventListener('click', (e) => {
                e.stopPropagation();
                const isOpen = row.hasClass('is-expanded');
                // Close all others
                templateGrid.querySelectorAll('.beat-sheet-row.is-expanded').forEach(r => {
                    r.removeClass('is-expanded');
                    (r.querySelector('.beat-sheet-expand-btn') as HTMLElement).textContent = '▸';
                });
                if (!isOpen) {
                    row.addClass('is-expanded');
                    expandBtn.textContent = '▾';
                }
            });

            const applyBtn = row.createEl('button', { text: t('Apply'), cls: 'mod-cta beat-sheet-apply-btn' });
            applyBtn.addEventListener('click', () => {
                new BeatSheetApplyModal(
                    this.app,
                    this.sceneManager,
                    template,
                    [...BUILTIN_SCENE_TEMPLATES.map(localizeSceneTemplate), ...this.plugin.templateCenter.getSceneTemplates()],
                    async () => {
                        renderActsList();
                        renderChaptersList();
                        this.plugin.refreshOpenViews();
                    },
                ).open();
            });
        }

        contentEl.createEl('h3', { text: t('Quick Structure Generator') });
        contentEl.createEl('p', {
            cls: 'setting-item-description',
            text: t('Generate a regular act/chapter structure. Use Template Center when you want named beats or a reusable custom structure.'),
        });
        let generatedActs = 3;
        let chaptersPerAct = 5;
        let generatedScenesPerChapter = 1;
        let generateScenes = false;
        new Setting(contentEl).setName(t('Number of acts')).addText(input => {
            input.setValue('3').onChange(value => generatedActs = Math.max(1, Number(value) || 1));
            input.inputEl.type = 'number';
            input.inputEl.min = '1';
        });
        new Setting(contentEl).setName(t('Chapters per act')).addText(input => {
            input.setValue('5').onChange(value => chaptersPerAct = Math.max(1, Number(value) || 1));
            input.inputEl.type = 'number';
            input.inputEl.min = '1';
        });
        new Setting(contentEl).setName(t('Scenes per chapter')).addText(input => {
            input.setValue('1').onChange(value => generatedScenesPerChapter = Math.max(1, Number(value) || 1));
            input.inputEl.type = 'number';
            input.inputEl.min = '1';
        });
        new Setting(contentEl).setName(t('Create placeholder scenes')).addToggle(toggle => toggle.setValue(false).onChange(value => generateScenes = value));
        new Setting(contentEl).addButton(button => button.setButtonText(t('Generate Structure')).setCta().onClick(async () => {
            const result = await this.sceneManager.applyCustomStructure(generatedActs, chaptersPerAct, generatedScenesPerChapter, generateScenes);
            renderActsList();
            renderChaptersList();
            new Notice(t('Generated {acts} act(s), {chapters} chapter(s), and {scenes} scene(s).', result));
        }));

        // ── Acts section ──
        contentEl.createEl('h3', { text: t('Acts') });
        contentEl.createEl('p', {
            cls: 'setting-item-description',
            text: t('Define acts for your story. Empty acts appear on the timeline even without scenes.')
        });

        const actsList = contentEl.createDiv('structure-list');
        const scenesPerAct = new Map<number, number>();
        for (const scene of this.sceneManager.getAllScenes()) {
            if (scene.act !== undefined) {
                const n = Number(scene.act);
                scenesPerAct.set(n, (scenesPerAct.get(n) || 0) + 1);
            }
        }

        const renderActsList = () => {
            actsList.empty();
            const acts = this.sceneManager.getDefinedActs();
            const actLabels = this.sceneManager.getActLabels();
            const actDescriptions = this.sceneManager.getActDescriptions();
            if (acts.length === 0) {
                actsList.createEl('p', { cls: 'structure-empty', text: t('No acts defined yet.') });
            }
            for (const act of acts) {
                const count = scenesPerAct.get(act) || 0;
                const label = actLabels[act];
                const desc = actDescriptions[act] || '';
                const wrapper = actsList.createDiv('structure-item-wrapper');
                const row = wrapper.createDiv('structure-row');
                const cleanLabel = label?.replace(/^(Act|Prologue|Epilogue)\s*\d*\s*[—:]\s*/i, '');
                const actDisplay = getActDisplayLabel(act);
                const labelText = cleanLabel ? `${actDisplay} — ${cleanLabel}` : actDisplay;
                row.createSpan({ cls: 'structure-label', text: labelText });
                row.createSpan({
                    cls: 'structure-count',
                    text: count === 1 ? t('{count} scene', { count }) : t('{count} scenes', { count }),
                });

                // Edit label button
                const editBtn = row.createEl('button', {
                    cls: 'clickable-icon structure-edit',
                    attr: { 'aria-label': t('Edit label for {label}', { label: actDisplay }) }
                });
                editBtn.textContent = '✎';
                editBtn.addEventListener('click', () => {
                    const input = row.querySelector('.structure-label-input') as HTMLInputElement;
                    if (input) { input.focus(); return; }
                    // Create inline edit
                    const labelSpan = row.querySelector('.structure-label') as HTMLElement;
                    if (!labelSpan) return;
                    labelSpan.setCssStyles({ display: 'none' });
                    const editInput = activeDocument.createElement('input');
                    editInput.type = 'text';
                    editInput.value = label || '';
                    editInput.placeholder = t('e.g. Setup, Confrontation…');
                    editInput.className = 'structure-label-input';
                    row.insertBefore(editInput, labelSpan.nextSibling);
                    editInput.focus();
                    const commitEdit = async () => {
                        await this.sceneManager.setActLabel(act, editInput.value);
                        renderActsList();
                    };
                    editInput.addEventListener('blur', commitEdit);
                    editInput.addEventListener('keydown', (e: KeyboardEvent) => {
                        if (e.key === 'Enter') { e.preventDefault(); editInput.blur(); }
                        if (e.key === 'Escape') { labelSpan.setCssStyles({ display: '' }); editInput.remove(); }
                    });
                });

                const removeBtn = row.createEl('button', {
                    cls: 'clickable-icon structure-remove',
                    attr: { 'aria-label': t('Remove {label}', { label: actDisplay }) }
                });
                removeBtn.textContent = '×';
                removeBtn.addEventListener('click', async () => {
                    await this.sceneManager.removeAct(act);
                    renderActsList();
                });

                // Description textarea
                const descArea = wrapper.createEl('textarea', {
                    cls: 'structure-description',
                    attr: { placeholder: t('Description / notes for this act…'), rows: '2' }
                });
                descArea.value = desc;
                let descCommitTimer: number | null = null;
                descArea.addEventListener('input', () => {
                    // Auto-grow
                    descArea.setCssStyles({ height: "auto" });

                    descArea.setCssStyles({ height: descArea.scrollHeight + 'px' });
                    // Debounced save
                    if (descCommitTimer) window.clearTimeout(descCommitTimer);
                    descCommitTimer = window.setTimeout(async () => {
                        await this.sceneManager.setActDescription(act, descArea.value);
                    }, 600);
                });
                // Initial auto-grow
                window.setTimeout(() => {
                    descArea.setCssStyles({ height: "auto" });

                    descArea.setCssStyles({ height: descArea.scrollHeight + 'px' });
                }, 0);
            }
        };
        renderActsList();

        const addActRow = contentEl.createDiv('structure-add-row');
        new Setting(addActRow)
            .setName(t('Add acts'))
            .setDesc(t('Enter act numbers (e.g. "1,2,3,4,5")'))
            .addText(text => {
                text.setPlaceholder('1,2,3,4,5');
                text.inputEl.addClass('structure-input');
            })
            .addButton(btn => {
                btn.setButtonText(t('Add')).setCta().onClick(async () => {
                    const input = addActRow.querySelector('.structure-input') as HTMLInputElement;
                    if (!input?.value) return;
                    const nums = input.value.split(',')
                        .map(s => parseInt(s.trim()))
                        .filter(n => !isNaN(n) && n > 0);
                    if (nums.length === 0) {
                        new Notice(t('Enter valid act numbers (e.g. 1,2,3)'));
                        return;
                    }
                    await this.sceneManager.addActs(nums);
                    input.value = '';
                    renderActsList();
                    new Notice(t('Added {n} act(s)', { n: nums.length }));
                });
            });

        // ── Chapters section ──
        contentEl.createEl('h3', { text: t('Chapters') });
        contentEl.createEl('p', {
            cls: 'setting-item-description',
            text: t('Define chapters. Empty chapters appear when grouping by chapter.')
        });

        const chaptersList = contentEl.createDiv('structure-list');
        const scenesPerChapter = new Map<number, number>();
        for (const scene of this.sceneManager.getAllScenes()) {
            if (scene.chapter !== undefined) {
                const n = Number(scene.chapter);
                scenesPerChapter.set(n, (scenesPerChapter.get(n) || 0) + 1);
            }
        }

        const renderChaptersList = () => {
            chaptersList.empty();
            const chapters = this.sceneManager.getDefinedChapters();
            const chapterLabels = this.sceneManager.getChapterLabels();
            const chapterDescriptions = this.sceneManager.getChapterDescriptions();
            if (chapters.length === 0) {
                chaptersList.createEl('p', { cls: 'structure-empty', text: t('No chapters defined yet.') });
            }
            for (const ch of chapters) {
                const count = scenesPerChapter.get(ch) || 0;
                const label = chapterLabels[ch];
                const desc = chapterDescriptions[ch] || '';
                const wrapper = chaptersList.createDiv('structure-item-wrapper');
                const row = wrapper.createDiv('structure-row');
                const chDisplay = `${t('Chapter')} ${ch}`;
                const labelText = label ? `${chDisplay} — ${label}` : chDisplay;
                row.createSpan({ cls: 'structure-label', text: labelText });
                row.createSpan({
                    cls: 'structure-count',
                    text: count === 1 ? t('{count} scene', { count }) : t('{count} scenes', { count }),
                });

                // Edit label button
                const editBtn = row.createEl('button', {
                    cls: 'clickable-icon structure-edit',
                    attr: { 'aria-label': t('Edit label for {label}', { label: chDisplay }) }
                });
                editBtn.textContent = '✎';
                editBtn.addEventListener('click', () => {
                    const input = row.querySelector('.structure-label-input') as HTMLInputElement;
                    if (input) { input.focus(); return; }
                    const labelSpan = row.querySelector('.structure-label') as HTMLElement;
                    if (!labelSpan) return;
                    labelSpan.setCssStyles({ display: 'none' });
                    const editInput = activeDocument.createElement('input');
                    editInput.type = 'text';
                    editInput.value = label || '';
                    editInput.placeholder = t('e.g. The Journey Begins…');
                    editInput.className = 'structure-label-input';
                    row.insertBefore(editInput, labelSpan.nextSibling);
                    editInput.focus();
                    const commitEdit = async () => {
                        await this.sceneManager.setChapterLabel(ch, editInput.value);
                        renderChaptersList();
                    };
                    editInput.addEventListener('blur', commitEdit);
                    editInput.addEventListener('keydown', (e: KeyboardEvent) => {
                        if (e.key === 'Enter') { e.preventDefault(); editInput.blur(); }
                        if (e.key === 'Escape') { labelSpan.setCssStyles({ display: '' }); editInput.remove(); }
                    });
                });

                const removeBtn = row.createEl('button', {
                    cls: 'clickable-icon structure-remove',
                    attr: { 'aria-label': t('Remove {label}', { label: chDisplay }) }
                });
                removeBtn.textContent = '×';
                removeBtn.addEventListener('click', async () => {
                    await this.sceneManager.removeChapter(ch);
                    renderChaptersList();
                });

                // Description textarea
                const descArea = wrapper.createEl('textarea', {
                    cls: 'structure-description',
                    attr: { placeholder: t('Description / notes for this chapter…'), rows: '2' }
                });
                descArea.value = desc;
                let descCommitTimer: number | null = null;
                descArea.addEventListener('input', () => {
                    descArea.setCssStyles({ height: "auto" });

                    descArea.setCssStyles({ height: descArea.scrollHeight + 'px' });
                    if (descCommitTimer) window.clearTimeout(descCommitTimer);
                    descCommitTimer = window.setTimeout(async () => {
                        await this.sceneManager.setChapterDescription(ch, descArea.value);
                    }, 600);
                });
                window.setTimeout(() => {
                    descArea.setCssStyles({ height: "auto" });

                    descArea.setCssStyles({ height: descArea.scrollHeight + 'px' });
                }, 0);
            }
        };
        renderChaptersList();

        const addChapterRow = contentEl.createDiv('structure-add-row');
        let createScenesForChapters = false;
        new Setting(addChapterRow)
            .setName(t('Add chapters'))
            .setDesc(t('Enter chapter numbers (e.g. "1-10" or "1,2,3")'))
            .addText(text => {
                text.setPlaceholder('1-10');
                text.inputEl.addClass('structure-input');
            })
            .addButton(btn => {
                btn.setButtonText(t('Add')).setCta().onClick(async () => {
                    const input = addChapterRow.querySelector('.structure-input') as HTMLInputElement;
                    if (!input?.value) return;
                    let nums: number[] = [];
                    const val = input.value.trim();
                    const rangeMatch = val.match(/^(\d+)\s*-\s*(\d+)$/);
                    if (rangeMatch) {
                        const start = parseInt(rangeMatch[1] ?? '', 10);
                        const end = parseInt(rangeMatch[2] ?? '', 10);
                        for (let i = start; i <= end; i++) nums.push(i);
                    } else {
                        nums = val.split(',')
                            .map(s => parseInt(s.trim()))
                            .filter(n => !isNaN(n) && n > 0);
                    }
                    if (nums.length === 0) {
                        new Notice(t('Enter valid chapter numbers (e.g. 1-10 or 1,2,3)'));
                        return;
                    }
                    await this.sceneManager.addChapters(nums);

                    // Optionally create one empty scene per chapter
                    if (createScenesForChapters) {
                        const chapterLabels = this.sceneManager.getChapterLabels();
                        for (const ch of nums) {
                            const label = chapterLabels[ch];
                            const title = label ? `${t('Chapter')} ${ch} — ${label}` : `${t('Chapter')} ${ch}`;
                            await this.sceneManager.createScene({
                                title,
                                chapter: ch,
                                sequence: ch,
                                status: 'idea' as SceneStatus,
                            });
                        }
                    }

                    input.value = '';
                    renderChaptersList();
                    const msg = createScenesForChapters
                        ? t('Added {n} chapter(s) with empty scenes — visible in all views.', { n: nums.length })
                        : t('Added {n} chapter(s). Switch to Board view → Kanban → Group by Chapter to see them.', { n: nums.length });
                    new Notice(msg);
                });
            });

        new Setting(addChapterRow)
            .setName(t('Create an empty scene per chapter'))
            .setDesc(t('Makes new chapters immediately visible in all views.'))
            .addToggle(toggle => {
                toggle.setValue(false);
                toggle.onChange(v => { createScenesForChapters = v; });
            });

        // Close button
        if (onDone) {
            const closeRow = contentEl.createDiv('structure-close-row');
            const closeBtn = closeRow.createEl('button', { text: t('Done'), cls: 'mod-cta' });
            closeBtn.addEventListener('click', () => { onDone(); this.plugin.refreshOpenViews(); });
        }
    }
}
/* eslint-enable @typescript-eslint/no-floating-promises, @typescript-eslint/no-misused-promises, @typescript-eslint/no-unnecessary-type-assertion -- end of file-wide suppression block opened at line 1 */
