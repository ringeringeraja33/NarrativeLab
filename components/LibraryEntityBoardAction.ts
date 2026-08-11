/**
 * Shared Create / Open board control for Library profile detail headers
 * (Characters, Locations, Codex categories).
 */
import * as obsidian from 'obsidian';
import { Notice } from 'obsidian';
import { attachTooltip } from './Tooltip';
import { t } from '../utils/i18n';
import type SceneCardsPlugin from '../main';

export interface LibraryEntityBoardActionOpts {
    plugin: SceneCardsPlugin;
    notePath: string;
    name: string;
    /** Optional seed image for a newly created board. */
    image?: string;
    /** Called after a board is created (e.g. re-render detail so the button flips to Open). */
    onCreated?: () => void;
}

/** Mount Create/Open board button into a detail header action row. */
export function mountLibraryEntityBoardAction(
    headerRight: HTMLElement,
    opts: LibraryEntityBoardActionOpts,
): HTMLButtonElement {
    const boardPath = opts.plugin.findLibraryEntityBoard(opts.notePath, opts.name);
    const btn = headerRight.createEl('button', {
        cls: 'codex-detail-action-btn',
        attr: { 'aria-label': boardPath ? t('Open board') : t('Create board') },
    });
    const icon = btn.createSpan();
    obsidian.setIcon(icon, 'layout-dashboard');
    attachTooltip(btn, boardPath ? t('Open board') : t('Create board'));
    btn.addEventListener('click', () => {
        void handleLibraryEntityBoardClick(opts, !!boardPath);
    });
    return btn;
}

async function handleLibraryEntityBoardClick(
    opts: LibraryEntityBoardActionOpts,
    hasBoard: boolean,
): Promise<void> {
    try {
        if (hasBoard) {
            const opened = await opts.plugin.openLibraryEntityBoard(opts.notePath, opts.name);
            if (!opened) new Notice(t('Could not find the board.'));
            return;
        }
        const path = await opts.plugin.createLibraryEntityBoard({
            name: opts.name,
            notePath: opts.notePath,
            codexFile: opts.notePath,
            images: opts.image ? [opts.image] : [],
        });
        new Notice(t('Board created.'));
        await opts.plugin.libraryEntityBoard.openBoard(path);
        opts.onCreated?.();
    } catch (e) {
        console.error(e);
        new Notice(t('Could not create the board.'));
    }
}
