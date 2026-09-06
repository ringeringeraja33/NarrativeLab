import { Setting, setIcon } from 'obsidian';
import { toggleProjectModule, type ProjectModuleId } from '../models/ProjectCapabilities';
import { t } from '../utils/i18n';

export const PROJECT_MODULE_LABELS: Record<ProjectModuleId, string> = {
    manuscript: 'Manuscript', notes: 'Notes', outline: 'Outline',
    writingTracker: 'Writing tracker', writingStats: 'Writing statistics',
    research: 'Research', library: 'Library', table: 'Table', canvas: 'Node-based presentation canvas',
    citations: 'Citation helpers', scenes: 'Scenes', board: 'Board',
    structure: 'Structure', plotlines: 'Plotlines', timeline: 'Timeline',
    flatCanvas: 'Flat canvas', columnBoard: 'Column board', trackComparison: 'Track comparison',
    plotList: 'Plot list', subwayMap: 'Plot subway map', chapterTemplates: 'Chapter templates',
    characters: 'Characters', locations: 'Locations', sceneDetails: 'Scene details',
    sceneNotes: 'Scene notes', synopsis: 'Synopsis', series: 'Series',
};

export const PROJECT_MODULE_GROUPS: { label: string; icon: string; modules: ProjectModuleId[] }[] = [
    { label: 'Writing', icon: 'pen-line', modules: ['manuscript', 'notes', 'outline'] },
    { label: 'Canvases and organization', icon: 'layout-dashboard', modules: ['flatCanvas', 'columnBoard', 'table', 'canvas'] },
    { label: 'Narrative planning', icon: 'git-branch', modules: ['timeline', 'trackComparison', 'plotList', 'subwayMap', 'chapterTemplates'] },
    { label: 'Narrative content', icon: 'notebook-tabs', modules: ['scenes', 'characters', 'locations', 'sceneDetails', 'sceneNotes', 'synopsis', 'series'] },
    { label: 'Materials and research', icon: 'library', modules: ['library', 'research', 'citations'] },
    { label: 'Writing progress', icon: 'chart-no-axes-column', modules: ['writingTracker', 'writingStats'] },
];

const DESCRIPTIONS: Partial<Record<ProjectModuleId, string>> = {
    manuscript: 'The main writing page for drafts.',
    notes: 'A Notes folder in the binder for freeform files.',
    outline: 'A structured outline of the work.',
    flatCanvas: 'Arrange note cards freely on a flat canvas.',
    columnBoard: 'Organize note cards in columns.',
    table: 'A spreadsheet for lists, indexes, and data.',
    canvas: 'Connect nodes and present a sequence.',
    timeline: 'Arrange scenes in reading or chronological order.',
    trackComparison: 'Compare parallel narrative tracks.',
    plotList: 'Review scenes grouped by plotline.',
    subwayMap: 'Visualize plotline intersections as a route map.',
    chapterTemplates: 'Apply and manage act and chapter templates.',
    scenes: 'Scene cards. Timeline, plot views, and scene sidebars need this.',
    characters: 'Character profiles and the Characters tab in Library. Save settings to hide that tab.',
    locations: 'Location profiles and the Locations tab in Library. Save settings to hide that tab.',
    sceneDetails: 'The scene inspector sidebar: status, POV, and metadata.',
    sceneNotes: 'A sidebar for notes attached to the current scene.',
    synopsis: 'A sidebar for the short synopsis of each scene.',
    series: 'Share library entries across books in a series.',
    library: 'The Library archive. Research projects start with literature, claims, arguments, and facts; narrative projects start with worldbuilding categories.',
    research: 'A Research folder in the binder for source notes.',
    citations: 'Does not add a page. Reserved for inserting and managing citations in drafts.',
    writingTracker: 'Daily word-count goals and writing sessions.',
    writingStats: 'Length and readability statistics.',
};

/** One picker for creation and existing projects. No nested scrolling. */
export function renderProjectModulePicker(
    container: HTMLElement,
    selected: Set<ProjectModuleId>,
    onChange: (next: Set<ProjectModuleId>) => void,
    tools?: { openChapterTemplates: () => void; chapterTemplatesAvailable: boolean },
): void {
    container.empty();
    container.addClass('nl-project-module-picker');
    for (const [groupIndex, group] of PROJECT_MODULE_GROUPS.entries()) {
        const section = container.createEl('section', { cls: 'nl-module-group' });
        if (groupIndex === PROJECT_MODULE_GROUPS.length - 1) section.addClass('nl-module-group-tracking');
        const heading = section.createDiv('nl-module-group-heading');
        setIcon(heading.createSpan('nl-module-group-icon'), group.icon);
        heading.createEl('h3', { text: t(group.label) });
        heading.createSpan({ cls: 'nl-module-group-count', text: `${group.modules.filter(id => selected.has(id)).length} / ${group.modules.length}` });
        const grid = section.createDiv('nl-module-grid');
        for (const module of group.modules) {
            const setting = new Setting(grid).setName(t(PROJECT_MODULE_LABELS[module]));
            setting.settingEl.dataset.module = module;
            setting.settingEl.setAttr('data-enabled', String(selected.has(module)));
            const description = DESCRIPTIONS[module];
            if (description) setting.setDesc(t(description));
            setting.addToggle(toggle => {
                toggle.setValue(selected.has(module));
                toggle.setTooltip(t(PROJECT_MODULE_LABELS[module]));
                toggle.onChange(enabled => {
                    const next = new Set(toggleProjectModule(selected, module, enabled));
                    onChange(next);
                    renderProjectModulePicker(container, next, onChange, tools);
                    container.querySelector<HTMLElement>(`[data-module="${module}"] .checkbox-container`)?.focus();
                });
            });
            if (module === 'chapterTemplates' && tools) {
                setting.addButton(button => button.setButtonText(t('Open')).setTooltip(t('Chapter templates and structure'))
                    .setDisabled(!selected.has(module) || !tools.chapterTemplatesAvailable)
                    .onClick(tools.openChapterTemplates));
            }
        }
    }
    container.createEl('p', { cls: 'nl-module-dependency-note', text: t('Required content modules are selected automatically. Turning them off also disables dependent views.') });
}
