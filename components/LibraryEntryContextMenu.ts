import { Menu, Notice, TFile, normalizePath } from 'obsidian';
import type SceneCardsPlugin from '../main';
import { t } from '../utils/i18n';
import { showMenuSafely } from '../utils/obsidianMenu';
import { ensureVaultFolder, isTombstonedProjectPath } from '../utils/vaultFolders';
import { openConfirmModal } from './ConfirmModal';

export interface LibraryEntryMove {
    destination: string;
    toShared: boolean;
}

/** Preserve the actual category and nested folders, including renamed categories. */
export function getLibraryEntryMove(
    filePath: string,
    projectLibrary: string,
    sharedLibrary: string,
): LibraryEntryMove | null {
    const path = normalizePath(filePath);
    const local = normalizePath(projectLibrary);
    const shared = normalizePath(sharedLibrary);
    if (!local || !shared || local === shared) return null;
    const roots = [
        { source: local, target: shared, toShared: true },
        { source: shared, target: local, toShared: false },
    ];
    for (const { source, target, toShared } of roots) {
        if (!path.startsWith(`${source}/`)) continue;
        const relative = path.slice(source.length + 1);
        if (!relative || relative.split('/').some(part => part === '..' || part === '.')) return null;
        return { destination: normalizePath(`${target}/${relative}`), toShared };
    }
    return null;
}

/** Move the existing note only; never serialize a stale profile or overwrite another file. */
export async function moveLibraryEntry(
    plugin: SceneCardsPlugin,
    sourcePath: string,
    projectFile: string,
    move: LibraryEntryMove,
): Promise<void> {
    const { app } = plugin;
    const validate = (): TFile => {
        const project = plugin.sceneManager.activeProject;
        if (!project || normalizePath(project.filePath) !== projectFile
            || !(app.vault.getAbstractFileByPath(projectFile) instanceof TFile)
            || !plugin.sceneManager.getSeriesFolderForProject(project)
            || isTombstonedProjectPath(move.destination)) {
            throw new Error(t('The project changed. Reopen the entry menu and try again.'));
        }
        const file = app.vault.getAbstractFileByPath(sourcePath);
        if (!(file instanceof TFile)) throw new Error(t('File not found'));
        if (app.vault.getAbstractFileByPath(move.destination)) {
            throw new Error(t('A file already exists at {path}. Nothing was overwritten.', { path: move.destination }));
        }
        return file;
    };
    const file = validate();
    if (await app.vault.adapter.exists(move.destination)) {
        throw new Error(t('A file already exists at {path}. Nothing was overwritten.', { path: move.destination }));
    }
    validate();
    await ensureVaultFolder(app, move.destination.slice(0, move.destination.lastIndexOf('/')));
    if (await app.vault.adapter.exists(move.destination)) {
        throw new Error(t('A file already exists at {path}. Nothing was overwritten.', { path: move.destination }));
    }
    if (validate() !== file || normalizePath(file.path) !== sourcePath) {
        throw new Error(t('File not found'));
    }
    await app.fileManager.renameFile(file, move.destination);
}

/** One compact menu for file-backed Character, Location, and Codex profile entries. */
export function showLibraryEntryContextMenu(
    plugin: SceneCardsPlugin,
    options: {
        filePath: string;
        name: string;
        projectFile: string | null;
        onOpenProfile: () => void | Promise<void>;
    },
    event: MouseEvent,
): void {
    const sourcePath = normalizePath(options.filePath);
    const projectFile = normalizePath(options.projectFile || plugin.sceneManager.activeProject?.filePath || '');
    const project = plugin.sceneManager.getProjects().find(p => normalizePath(p.filePath) === projectFile);
    const run = async (action: () => void | Promise<void>): Promise<void> => {
        try {
            if (!(plugin.app.vault.getAbstractFileByPath(sourcePath) instanceof TFile)) {
                throw new Error(t('File not found'));
            }
            await action();
        } catch (error) {
            new Notice(error instanceof Error ? error.message : String(error));
        }
    };
    const menu = new Menu();
    menu.addItem(item => item.setTitle(t('Open profile')).setIcon('contact').onClick(() => run(async () => {
        if (projectFile !== normalizePath(plugin.sceneManager.activeProject?.filePath || '')) {
            throw new Error(t('The project changed. Reopen the entry menu and try again.'));
        }
        await options.onOpenProfile();
    })));
    menu.addItem(item => item.setTitle(t('Open source file in new tab')).setIcon('file-text').onClick(() => run(async () => {
        const file = plugin.app.vault.getAbstractFileByPath(sourcePath);
        if (file instanceof TFile) await plugin.app.workspace.getLeaf('tab').openFile(file);
    })));

    const seriesFolder = plugin.sceneManager.getSeriesFolderForProject(project);
    if (project && seriesFolder) {
        const sharedRoot = normalizePath(`${seriesFolder}/Library`);
        const legacyRoot = normalizePath(`${seriesFolder}/Codex`);
        const sharedLibrary = plugin.app.vault.getAbstractFileByPath(sharedRoot)
            ? sharedRoot
            : (plugin.app.vault.getAbstractFileByPath(legacyRoot) ? legacyRoot : sharedRoot);
        const move = getLibraryEntryMove(sourcePath, project.codexFolder, sharedLibrary);
        if (move) {
            const label = move.toShared
                ? t('Move to shared series Library')
                : t('Move to "{project}" Library', { project: project.title });
            const performMove = () => run(async () => {
                await moveLibraryEntry(plugin, sourcePath, projectFile, move);
                new Notice(move.toShared
                    ? t('Moved "{name}" to the shared series Library', { name: options.name })
                    : t('Moved "{name}" to the current project Library', { name: options.name }));
                await plugin.refreshOpenViews();
            });
            menu.addSeparator();
            menu.addItem(item => item.setTitle(label).setIcon('folder-input').onClick(async () => {
                if (move.toShared) {
                    await performMove();
                    return;
                }
                openConfirmModal(plugin.app, {
                    title: label,
                    message: t('Move "{name}" out of the shared Library? Other projects will no longer load this entry from the shared Library. Its contents and properties will be preserved.', { name: options.name }),
                    confirmLabel: t('Move'),
                    onConfirm: performMove,
                });
            }));
        }
    }
    showMenuSafely(menu, event);
}
