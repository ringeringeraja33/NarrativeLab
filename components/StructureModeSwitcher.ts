import { WorkspaceLeaf } from 'obsidian';
import * as obsidian from 'obsidian';
import type SceneCardsPlugin from '../main';
import { STORYLINE_VIEW_TYPE, TIMELINE_VIEW_TYPE } from '../constants';
import { t } from '../utils/i18n';
import { preservedNarrativeLabLeafState } from '../utils/narrativeLabLeafState';

export type StructureMode = 'timeline' | 'tracks' | 'plot-list' | 'subway';

interface StructureModeSwitcherOptions {
    onTimeline?: () => void;
    onTracks?: () => void;
    onPlotList?: () => void;
    onSubway?: () => void;
    onTemplates?: () => void;
}

export function renderStructureModeSwitcher(
    container: HTMLElement,
    current: StructureMode,
    plugin: SceneCardsPlugin,
    leaf: WorkspaceLeaf,
    options: StructureModeSwitcherOptions = {},
): HTMLElement {
    const switcher = container.createDiv('structure-mode-switcher');
    let switching = false;
    const switchView = async (type: string, after?: () => void): Promise<void> => {
        if (switching) return;
        switching = true;
        try {
            await leaf.setViewState({
                type,
                active: true,
                state: preservedNarrativeLabLeafState(leaf),
            });
            void plugin.app.workspace.revealLeaf(leaf);
            after?.();
        } finally {
            switching = false;
        }
    };
    const useLocalModeOrSwitch = (
        localAction: (() => void) | undefined,
        targetViewType: string,
        prepareSwitch?: () => void,
    ): void => {
        if (localAction) {
            localAction();
            return;
        }
        prepareSwitch?.();
        void switchView(targetViewType);
    };
    const items: Array<{ id: StructureMode | 'templates'; label: string; icon: string; action: () => void }> = [
        {
            id: 'timeline', label: 'Timeline', icon: 'list-ordered', action: () => {
                useLocalModeOrSwitch(options.onTimeline, TIMELINE_VIEW_TYPE, () => {
                    plugin.settings.timelineSwimlaneMode = false;
                    void plugin.saveSettings();
                });
            },
        },
        {
            id: 'tracks', label: 'Track comparison', icon: 'columns-2', action: () => {
                useLocalModeOrSwitch(options.onTracks, TIMELINE_VIEW_TYPE, () => {
                    plugin.settings.timelineSwimlaneMode = true;
                    void plugin.saveSettings();
                });
            },
        },
        {
            id: 'plot-list', label: 'Plot list', icon: 'list', action: () => {
                useLocalModeOrSwitch(options.onPlotList, STORYLINE_VIEW_TYPE, () => {
                    plugin.settings.lastStorylineViewMode = 'list';
                    void plugin.saveSettings();
                });
            },
        },
        {
            id: 'subway', label: 'Subway map', icon: 'chart-gantt', action: () => {
                useLocalModeOrSwitch(options.onSubway, STORYLINE_VIEW_TYPE, () => {
                    plugin.settings.lastStorylineViewMode = 'subway';
                    void plugin.saveSettings();
                });
            },
        },
        {
            id: 'templates', label: 'Chapter templates', icon: 'layers', action: () => {
                if (options.onTemplates) {
                    options.onTemplates();
                    return;
                }
                void switchView(TIMELINE_VIEW_TYPE, () => {
                    const view = leaf.view as unknown as { openStructureModal?: () => void };
                    view.openStructureModal?.();
                });
            },
        },
    ];
    for (const item of items) {
        const button = switcher.createEl('button', {
            cls: `structure-mode-button${item.id === current ? ' active' : ''}`,
            attr: {
                type: 'button',
                'aria-pressed': item.id === current ? 'true' : 'false',
            },
        });
        const icon = button.createSpan('structure-mode-icon');
        obsidian.setIcon(icon, item.icon);
        button.createSpan({ text: t(item.label) });
        button.addEventListener('click', item.action);
    }
    return switcher;
}
