import { Notice, setIcon } from 'obsidian';
import type { SceneCardsSettings } from '../settings';
import {
    getLibraryProfileOrientation,
    setLibraryProfileOrientation,
    type LibraryProfileOrientation,
} from '../utils/libraryProfileLayout';
import { t } from '../utils/i18n';
import { attachTooltip } from './Tooltip';

interface LibraryProfileOrientationToggleOptions {
    settings: SceneCardsSettings;
    categoryKey: string;
    save: () => Promise<void>;
    beforeChange?: () => Promise<void>;
    onChanged: () => void;
}

/**
 * Compact per-category Horizontal / Vertical profile-page control.
 * Horizontal = section columns arranged left-to-right (character board style).
 * Vertical = stacked accordion sections.
 */
export function renderLibraryProfileOrientationToggle(
    container: HTMLElement,
    options: LibraryProfileOrientationToggleOptions,
): HTMLElement {
    const current = getLibraryProfileOrientation(options.settings, options.categoryKey);
    const group = container.createDiv('library-profile-orientation');
    group.setAttr('role', 'group');
    group.setAttr('aria-label', t('Profile layout'));
    let changing = false;

    const choices: Array<{
        id: LibraryProfileOrientation;
        label: string;
        icon: string;
    }> = [
        { id: 'horizontal', label: 'Horizontal', icon: 'columns-2' },
        { id: 'vertical', label: 'Vertical', icon: 'rows-3' },
    ];

    for (const choice of choices) {
        const active = choice.id === current;
        const button = group.createEl('button', {
            cls: `library-profile-orientation-btn${active ? ' is-active' : ''}`,
            attr: {
                type: 'button',
                'aria-label': t(`${choice.label} layout`),
                'aria-pressed': active ? 'true' : 'false',
            },
        });
        const icon = button.createSpan('library-profile-orientation-icon');
        setIcon(icon, choice.icon);
        button.createSpan({
            cls: 'library-profile-orientation-label',
            text: t(choice.label),
        });
        attachTooltip(button, t(`${choice.label} layout`));
        button.addEventListener('click', () => {
            if (active || changing) return;
            changing = true;
            void (async () => {
                try {
                    await options.beforeChange?.();
                    await setLibraryProfileOrientation(
                        options.settings,
                        options.categoryKey,
                        choice.id,
                        options.save,
                    );
                    options.onChanged();
                } catch (error) {
                    new Notice(t('Could not change profile layout: {err}', { err: String(error) }));
                } finally {
                    changing = false;
                }
            })();
        });
    }
    return group;
}
