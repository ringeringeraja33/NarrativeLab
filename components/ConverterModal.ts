/* eslint-disable @typescript-eslint/no-misused-promises, @typescript-eslint/no-unnecessary-type-assertion -- Obsidian's API surface and several untyped third-party libraries force dynamic dispatch; floating promises are intentional in DOM/event handlers; matching enable at end of file */
import { Modal, Setting, Notice, DropdownComponent, ToggleComponent, normalizePath } from 'obsidian';
import { ExportService, ExportFormat, ExportScope } from '../services/ExportService';
import {
    ProjectBundleService,
    pickBundleJsonFile,
} from '../services/ProjectBundleService';
import { PlotlineNcanvasService } from '../services/PlotlineNcanvasService';
import { openConfirmModal } from './ConfirmModal';
import type SceneCardsPlugin from '../main';
import { t } from '../utils/i18n';

export type ConverterTab = 'export' | 'bundle' | 'plotline';

/**
 * Unified converter: manuscript export, project bundle I/O, plotline → ncanvas.
 */
export class ConverterModal extends Modal {
    private plugin: SceneCardsPlugin;
    private exportService: ExportService;
    private bundleService: ProjectBundleService;
    private plotlineNcanvas: PlotlineNcanvasService;
    private activeTab: ConverterTab;
    private bodyEl: HTMLElement | null = null;

    private format: ExportFormat = 'md';
    private exportScope: ExportScope = 'manuscript';
    private includeSceneTitles = true;
    private numberScenesOnExport = false;
    private includeCorkboardNotes = false;
    private includeInactiveScenes = false;
    private sceneSeparatorType: 'blank' | 'asterisks' | 'custom' = 'blank';
    private sceneSeparatorCustom = '';

    private selectedPlotlineIds = new Set<string>();
    private plotlineMode: 'new' | 'overwrite' = 'new';
    private newNcanvasName = '';
    private overwritePath = '';

    constructor(plugin: SceneCardsPlugin, opts?: { tab?: ConverterTab }) {
        super(plugin.app);
        this.plugin = plugin;
        this.activeTab = opts?.tab || 'export';
        this.exportService = new ExportService(plugin.app, plugin.sceneManager, plugin.characterManager, plugin.locationManager);
        this.bundleService = new ProjectBundleService(plugin.app, plugin);
        this.plotlineNcanvas = new PlotlineNcanvasService(plugin);
        this.sceneSeparatorType = plugin.settings.exportSceneSeparatorType || 'blank';
        this.sceneSeparatorCustom = plugin.settings.exportSceneSeparatorCustom || '';
        if (plugin.settings.docxSettings) this.exportService.setDocxSettings(plugin.settings.docxSettings);
        if (plugin.settings.pdfSettings) this.exportService.setPdfSettings(plugin.settings.pdfSettings);

        for (const d of plugin.plotlineManager.getPlotlineDefinitions()) {
            this.selectedPlotlineIds.add(d.id);
        }
        const project = plugin.sceneManager.activeProject;
        if (project) {
            this.newNcanvasName = t('Plotlines Canvas');
            const { candidates } = plugin.getNcanvasPathsForProject(project);
            this.overwritePath = candidates[0] || '';
        }
    }

    onOpen(): void {
        const { contentEl } = this;
        contentEl.empty();
        contentEl.addClass('storyline-export-modal');
        contentEl.addClass('nl-converter-modal');
        this.modalEl.addClass('mod-storyline-export');

        contentEl.createEl('h2', { text: t('Converter') });

        const project = this.plugin.sceneManager.activeProject;
        if (!project) {
            contentEl.createEl('p', { text: t('No active project. Open a project first.') });
            return;
        }

        contentEl.createEl('p', {
            text: t('Project: {title}', { title: project.title }),
            cls: 'storyline-export-project-name',
        });

        const tabs = contentEl.createDiv({ cls: 'nl-converter-tabs' });
        const tabDefs: Array<{ id: ConverterTab; label: string }> = [
            { id: 'export', label: t('Manuscript export') },
            { id: 'bundle', label: t('Project bundle') },
            { id: 'plotline', label: t('Plotlines to Canvas') },
        ];
        for (const def of tabDefs) {
            const btn = tabs.createEl('button', {
                cls: `nl-converter-tab${this.activeTab === def.id ? ' is-active' : ''}`,
                text: def.label,
                attr: { type: 'button' },
            });
            btn.addEventListener('click', () => {
                this.activeTab = def.id;
                this.renderBody();
                tabs.querySelectorAll('.nl-converter-tab').forEach(el => {
                    el.toggleClass('is-active', (el as HTMLElement).dataset.tab === def.id);
                });
            });
            btn.dataset.tab = def.id;
        }

        this.bodyEl = contentEl.createDiv({ cls: 'nl-converter-body' });
        this.renderBody();
    }

    private renderBody(): void {
        if (!this.bodyEl) return;
        this.bodyEl.empty();
        if (this.activeTab === 'export') this.renderExportTab(this.bodyEl);
        else if (this.activeTab === 'bundle') this.renderBundleTab(this.bodyEl);
        else this.renderPlotlineTab(this.bodyEl);
    }

    // ── Tab 1: manuscript export (legacy ExportModal) ─────────────

    private renderExportTab(parent: HTMLElement): void {
        let scopeDropdown: DropdownComponent | undefined;
        let renderManuscriptOptions: () => void = () => {};

        new Setting(parent)
            .setName(t('Content'))
            .setDesc(t('What to include in the export'))
            .addDropdown(dd => {
                scopeDropdown = dd;
                dd.addOption('outline', t('Outline (metadata, stats, table)'));
                dd.addOption('manuscript', t('Manuscript (scene text in order)'));
                dd.setValue(this.exportScope);
                dd.onChange(v => {
                    this.exportScope = v as ExportScope;
                    renderManuscriptOptions();
                });
            });

        new Setting(parent)
            .setName(t('Format'))
            .addDropdown(dd => {
                dd.addOption('md', t('Markdown (.md)'));
                dd.addOption('docx', t('Word (.docx)'));
                dd.addOption('pdf', t('PDF (.pdf)'));
                dd.addOption('html', t('HTML (.html)'));
                dd.addOption('csv', t('CSV (.csv)'));
                dd.addOption('json', t('JSON (.json)'));
                dd.setValue(this.format);
                dd.onChange(v => {
                    this.format = v as ExportFormat;
                    if ((v === 'docx' || v === 'pdf') && this.exportScope !== 'manuscript') {
                        this.exportScope = 'manuscript';
                        scopeDropdown?.setValue('manuscript');
                        renderManuscriptOptions();
                    }
                });
            });

        const manuscriptOptions = parent.createDiv({ cls: 'storyline-export-options' });
        renderManuscriptOptions = () => {
            manuscriptOptions.empty();
            new Setting(manuscriptOptions)
                .setName(t('Include inactive scenes'))
                .setDesc(t('Include parked scenes marked inactive. Off by default.'))
                .addToggle(tg => {
                    tg.setValue(this.includeInactiveScenes);
                    tg.onChange(v => { this.includeInactiveScenes = v; });
                });

            if (this.exportScope !== 'manuscript') return;

            let titlesToggle: ToggleComponent | undefined;
            let numberToggle: ToggleComponent | undefined;

            new Setting(manuscriptOptions)
                .setName(t('Include scene titles'))
                .setDesc(t('Show "#### Scene Title" before each scene. Disable for a clean reader copy.'))
                .addToggle(tg => {
                    titlesToggle = tg;
                    tg.setValue(this.includeSceneTitles && !this.numberScenesOnExport);
                    tg.onChange(v => {
                        this.includeSceneTitles = v;
                        if (v) {
                            this.numberScenesOnExport = false;
                            numberToggle?.setValue(false);
                        }
                    });
                });

            new Setting(manuscriptOptions)
                .setName(t('Number scenes (1, 2, 3\u2026)'))
                .setDesc(t('Replace scene titles with sequential numbers in the export.'))
                .addToggle(tg => {
                    numberToggle = tg;
                    tg.setValue(this.numberScenesOnExport);
                    tg.onChange(v => {
                        this.numberScenesOnExport = v;
                        if (v) {
                            this.includeSceneTitles = false;
                            titlesToggle?.setValue(false);
                        }
                    });
                });

            new Setting(manuscriptOptions)
                .setName(t('Include corkboard notes'))
                .setDesc(t('Include sticky / brainstorm notes from the corkboard. Off by default.'))
                .addToggle(tg => {
                    tg.setValue(this.includeCorkboardNotes);
                    tg.onChange(v => { this.includeCorkboardNotes = v; });
                });

            new Setting(manuscriptOptions)
                .setName(t('Scene separator'))
                .setDesc(t('Separator used between scenes in manuscript exports.'))
                .addDropdown(dd => dd
                    .addOptions({
                        blank: t('Blank Line'),
                        asterisks: '* * *',
                        custom: t('Custom Separator'),
                    })
                    .setValue(this.sceneSeparatorType)
                    .onChange(async (v) => {
                        this.sceneSeparatorType = v as 'blank' | 'asterisks' | 'custom';
                        this.plugin.settings.exportSceneSeparatorType = this.sceneSeparatorType;
                        await this.plugin.saveSettings();
                        renderManuscriptOptions();
                    }));

            if (this.sceneSeparatorType === 'custom') {
                new Setting(manuscriptOptions)
                    .setName(t('Custom separator'))
                    .setDesc(t('Enter any UTF-8 character or text to use as a scene separator.'))
                    .addText(text => text
                        .setPlaceholder(t('e.g. ~ ~ ~'))
                        .setValue(this.sceneSeparatorCustom)
                        .onChange(async (v) => {
                            this.sceneSeparatorCustom = v;
                            this.plugin.settings.exportSceneSeparatorCustom = v;
                            await this.plugin.saveSettings();
                        }));
            }
        };
        renderManuscriptOptions();

        const actions = parent.createDiv({ cls: 'storyline-export-actions' });
        const exportBtn = actions.createEl('button', { text: t('Export'), cls: 'mod-cta', attr: { type: 'button' } });
        exportBtn.addEventListener('click', async () => {
            exportBtn.disabled = true;
            exportBtn.textContent = t('Exporting…');
            try {
                this.exportService.setExportOptions({
                    includeSceneTitles: this.includeSceneTitles,
                    numberScenesOnExport: this.numberScenesOnExport,
                    includeCorkboardNotes: this.includeCorkboardNotes,
                    includeInactiveScenes: this.includeInactiveScenes,
                });
                this.exportService.setSeparatorSettings(this.sceneSeparatorType, this.sceneSeparatorCustom);
                await this.exportService.export(this.format, this.exportScope);
                this.close();
            } catch (err) {
                new Notice(t('Export failed:') + ' ' + String(err));
                exportBtn.disabled = false;
                exportBtn.textContent = t('Export');
            }
        });
        actions.createEl('button', { text: t('Cancel'), attr: { type: 'button' } })
            .addEventListener('click', () => this.close());
    }

    // ── Tab 2: project bundle ─────────────────────────────────────

    private renderBundleTab(parent: HTMLElement): void {
        parent.createEl('p', {
            cls: 'setting-item-description',
            text: t('Export or import a full text asset pack: scenes, library, notes, research, System JSON, and ncanvas files. Attachments are not included.'),
        });

        new Setting(parent)
            .setName(t('Export project bundle'))
            .setDesc(t('Writes a JSON pack under the project Exports folder.'))
            .addButton(btn => btn
                .setButtonText(t('Export bundle'))
                .setCta()
                .onClick(async () => {
                    try {
                        const path = await this.bundleService.exportActiveProject();
                        new Notice(t('Project bundle written: {path}', { path }));
                    } catch (err) {
                        new Notice(t('Export failed:') + ' ' + String(err));
                    }
                }));

        new Setting(parent)
            .setName(t('Import project bundle into current project'))
            .setDesc(t('Overwrites matching relative paths in the active project.'))
            .addButton(btn => btn
                .setButtonText(t('Import into current…'))
                .onClick(async () => {
                    const file = await pickBundleJsonFile(this.app);
                    if (!file) return;
                    const ok = await this.confirm(
                        t('Import bundle into current project?'),
                        t('Files in the bundle will overwrite the same relative paths under this project.'),
                    );
                    if (!ok) return;
                    try {
                        const raw = await this.app.vault.read(file);
                        const bundle = this.bundleService.parseBundle(raw);
                        const { written } = await this.bundleService.importIntoActiveProject(bundle);
                        new Notice(t('Imported {n} files into the current project.', { n: written }));
                        this.close();
                    } catch (err) {
                        new Notice(t('Import failed: ') + (err instanceof Error ? err.message : String(err)));
                    }
                }));

        new Setting(parent)
            .setName(t('Import project bundle as new project'))
            .setDesc(t('Creates a new project folder and loads the bundle into it.'))
            .addButton(btn => btn
                .setButtonText(t('Import as new…'))
                .onClick(async () => {
                    const file = await pickBundleJsonFile(this.app);
                    if (!file) return;
                    try {
                        const raw = await this.app.vault.read(file);
                        const bundle = this.bundleService.parseBundle(raw);
                        const { written, projectPath } = await this.bundleService.importAsNewProject(bundle);
                        new Notice(t('Created project and imported {n} files: {path}', {
                            n: written,
                            path: projectPath,
                        }));
                        this.close();
                    } catch (err) {
                        new Notice(t('Import failed: ') + (err instanceof Error ? err.message : String(err)));
                    }
                }));

        new Setting(parent)
            .setName(t('Import Scrivener project'))
            .setDesc(t('Import a Scrivener project (.scriv folder) as a new NarrativeLab project. Converts scenes, characters, locations, and research notes. Desktop only.'))
            .addButton(btn => btn
                .setButtonText(t('Import Scrivener…'))
                .onClick(() => {
                    this.close();
                    void this.plugin.runScrivenerImport();
                }));
    }

    // ── Tab 3: plotlines → ncanvas ────────────────────────────────

    private renderPlotlineTab(parent: HTMLElement): void {
        const project = this.plugin.sceneManager.activeProject;
        if (!project) return;

        parent.createEl('p', {
            cls: 'setting-item-description',
            text: t('Each selected plotline becomes a Location Frame; each scene becomes a fillable Story Sequence with a link to its note.'),
        });

        const defs = this.plugin.plotlineManager.getPlotlineDefinitions();
        if (defs.length === 0) {
            parent.createEl('p', { text: t('No plotlines in this project yet.') });
        } else {
            const toolbar = parent.createDiv({ cls: 'nl-converter-plotline-toolbar' });
            toolbar.createEl('button', { text: t('Select all'), attr: { type: 'button' } })
                .addEventListener('click', () => {
                    defs.forEach(d => this.selectedPlotlineIds.add(d.id));
                    this.renderBody();
                });
            toolbar.createEl('button', { text: t('Select none'), attr: { type: 'button' } })
                .addEventListener('click', () => {
                    this.selectedPlotlineIds.clear();
                    this.renderBody();
                });

            const list = parent.createDiv({ cls: 'nl-converter-plotline-list' });
            for (const def of defs) {
                const row = list.createDiv({ cls: 'nl-converter-plotline-row' });
                const label = row.createEl('label');
                const cb = label.createEl('input', { attr: { type: 'checkbox' } }) as HTMLInputElement;
                cb.checked = this.selectedPlotlineIds.has(def.id);
                cb.addEventListener('change', () => {
                    if (cb.checked) this.selectedPlotlineIds.add(def.id);
                    else this.selectedPlotlineIds.delete(def.id);
                });
                const scenes = this.plugin.plotlineManager.getScenesOrderedForPlotline(def.id);
                label.createSpan({
                    text: `${def.label || def.id} (${scenes.length})`,
                });
            }
        }

        new Setting(parent)
            .setName(t('Write mode'))
            .addDropdown(dd => {
                dd.addOption('new', t('Create new ncanvas'));
                dd.addOption('overwrite', t('Overwrite existing ncanvas'));
                dd.setValue(this.plotlineMode);
                dd.onChange(v => {
                    this.plotlineMode = v as 'new' | 'overwrite';
                    this.renderBody();
                });
            });

        if (this.plotlineMode === 'new') {
            new Setting(parent)
                .setName(t('File name'))
                .addText(text => {
                    text.setPlaceholder(t('Plotlines Canvas'));
                    text.setValue(this.newNcanvasName);
                    text.onChange(v => { this.newNcanvasName = v; });
                });
        } else {
            const { candidates } = this.plugin.getNcanvasPathsForProject(project);
            if (candidates.length === 0) {
                parent.createEl('p', { text: t('No .ncanvas files yet. Create one or choose “Create new ncanvas”.') });
            } else {
                if (!this.overwritePath || !candidates.includes(this.overwritePath)) {
                    this.overwritePath = candidates[0];
                }
                new Setting(parent)
                    .setName(t('Target ncanvas'))
                    .addDropdown(dd => {
                        for (const path of candidates) {
                            dd.addOption(path, path.split('/').pop() || path);
                        }
                        dd.setValue(this.overwritePath);
                        dd.onChange(v => { this.overwritePath = v; });
                    });
            }
        }

        const actions = parent.createDiv({ cls: 'storyline-export-actions' });
        const runBtn = actions.createEl('button', {
            text: t('Generate Canvas'),
            cls: 'mod-cta',
            attr: { type: 'button' },
        });
        runBtn.addEventListener('click', () => { void this.runPlotlineGenerate(runBtn); });
        actions.createEl('button', { text: t('Cancel'), attr: { type: 'button' } })
            .addEventListener('click', () => this.close());
    }

    private async runPlotlineGenerate(btn: HTMLButtonElement): Promise<void> {
        const project = this.plugin.sceneManager.activeProject;
        if (!project) return;
        const ids = [...this.selectedPlotlineIds];
        if (ids.length === 0) {
            new Notice(t('Select at least one plotline.'));
            return;
        }

        const { canvasFolder } = this.plugin.getNcanvasPathsForProject(project);
        let path = '';
        let title = this.newNcanvasName.trim() || t('Plotlines Canvas');

        if (this.plotlineMode === 'new') {
            path = await this.plugin.allocateNcanvasPath(canvasFolder, `${title}.ncanvas`);
        } else {
            path = normalizePath(this.overwritePath);
            if (!path) {
                new Notice(t('Choose an ncanvas file to overwrite.'));
                return;
            }
            const ok = await this.confirm(
                t('Overwrite ncanvas?'),
                t('“{name}” will be replaced entirely with plotline frames.', {
                    name: path.split('/').pop() || path,
                }),
            );
            if (!ok) return;
            title = (path.split('/').pop() || title).replace(/\.ncanvas$/i, '');
        }

        btn.disabled = true;
        btn.textContent = t('Generating…');
        try {
            const written = await this.plotlineNcanvas.writeAndOpen({
                path,
                title,
                plotlineIds: ids,
            });
            new Notice(t('Wrote plotline canvas: {name}', {
                name: written.split('/').pop() || written,
            }));
            this.close();
        } catch (err) {
            new Notice(t('Failed to create ncanvas: {err}', { err: String(err) }));
            btn.disabled = false;
            btn.textContent = t('Generate Canvas');
        }
    }

    private confirm(title: string, message: string): Promise<boolean> {
        return new Promise((resolve) => {
            openConfirmModal(this.app, {
                title,
                message,
                confirmLabel: t('Confirm'),
                cancelLabel: t('Cancel'),
                confirmClass: 'mod-warning',
                onConfirm: () => resolve(true),
                onCancel: () => resolve(false),
            });
        });
    }

    onClose(): void {
        this.contentEl.empty();
        this.bodyEl = null;
    }
}
/* eslint-enable @typescript-eslint/no-misused-promises, @typescript-eslint/no-unnecessary-type-assertion -- end of file-wide suppression block opened at line 1 */
