
import { App, TFile, Notice } from 'obsidian';
import { t } from '../utils/i18n';

/**
 * Types of undoable actions
 */
type UndoActionType = 'update' | 'create' | 'delete';

/**
 * Domain that the action belongs to — drives which manager re-applies changes.
 */
type UndoDomain = 'scene' | 'character' | 'location';

/**
 * A single undoable action.
 */
interface UndoAction {
    type: UndoActionType;
    /** Which domain this action belongs to */
    domain: UndoDomain;
    /** Human-readable description (e.g. "Update status of 'The Red Door'") */
    label: string;
    filePath: string;
    /** For 'update': exact file state and path before the change. */
    beforeContent?: string;
    beforePath?: string;
    /** For 'update': exact file state and path after the change. */
    afterContent?: string;
    afterPath?: string;
    /** For 'delete': full file content so we can re-create the file */
    fileContent?: string;
    /** For 'create': we store the content so undo can delete, redo can re-create */
    createdContent?: string;
}

const MAX_STACK = 50;

/**
 * Manages an undo/redo stack for scene operations.
 *
 * Usage:
 *  - Around an update:   `const token = await undoManager.beginUpdate(filePath, label)`
 *                       `await undoManager.commitUpdate(token, finalPath)`
 *  - Before a delete:   `undoManager.recordDelete(filePath, fileContent, label)`
 *  - After a create:    `undoManager.recordCreate(filePath, fileContent, label)`
 *  - Undo:              `await undoManager.undo()`
 *  - Redo:              `await undoManager.redo()`
 */
export class UndoManager {
    private app: App;
    private undoStack: UndoAction[] = [];
    private redoStack: UndoAction[] = [];
    private pendingUpdates = new Map<number, UndoAction>();
    private nextUpdateToken = 1;
    /** Callback fired after undo/redo so views can refresh */
    onAfterUndoRedo: (() => void) | null = null;

    constructor(app: App) {
        this.app = app;
    }

    // ─── Recording ──────────────────────────────────────────────

    async beginUpdate(filePath: string, label?: string, domain: UndoDomain = 'scene'): Promise<number | null> {
        const file = this.app.vault.getAbstractFileByPath(filePath);
        if (!(file instanceof TFile)) return null;

        try {
            const beforeContent = await this.app.vault.read(file);
            const token = this.nextUpdateToken++;
            this.pendingUpdates.set(token, {
                type: 'update',
                domain,
                label: label || `Update ${domain}`,
                filePath,
                beforePath: filePath,
                beforeContent,
            });
            return token;
        } catch (error) {
            console.error('NarrativeLab: could not capture file before update', error);
            new Notice(t('Could not record this change for undo.'));
            return null;
        }
    }

    async commitUpdate(token: number | null, afterPath?: string): Promise<void> {
        if (token === null) return;
        const action = this.pendingUpdates.get(token);
        if (!action) return;

        try {
            const resolvedPath = afterPath || action.beforePath || action.filePath;
            const file = this.app.vault.getAbstractFileByPath(resolvedPath);
            if (!(file instanceof TFile)) throw new Error(t('File not found'));
            action.afterPath = resolvedPath;
            action.afterContent = await this.app.vault.read(file);
            if (action.beforePath !== action.afterPath || action.beforeContent !== action.afterContent) {
                this.push(action);
            }
        } catch (error) {
            console.error('NarrativeLab: could not capture file after update', error);
            new Notice(t('Could not record this change for undo.'));
        } finally {
            this.pendingUpdates.delete(token);
        }
    }

    cancelUpdate(token: number | null): void {
        if (token !== null) this.pendingUpdates.delete(token);
    }

    /**
     * Record a deletion.
     * @param filePath     File path
     * @param fileContent  Full markdown content of the file (so it can be restored)
     * @param label        Human-readable description
     * @param domain       Which domain ('scene' | 'character' | 'location')
     */
    recordDelete(filePath: string, fileContent: string, label?: string, domain: UndoDomain = 'scene'): void {
        this.push({
            type: 'delete',
            domain,
            label: label || `Delete ${domain}`,
            filePath,
            fileContent,
        });
    }

    /**
     * Record a creation.
     * @param filePath       Newly-created file path
     * @param fileContent    Content that was written
     * @param label          Human-readable description
     * @param domain         Which domain ('scene' | 'character' | 'location')
     */
    recordCreate(filePath: string, fileContent: string, label?: string, domain: UndoDomain = 'scene'): void {
        this.push({
            type: 'create',
            domain,
            label: label || `Create ${domain}`,
            filePath,
            createdContent: fileContent,
        });
    }

    // ─── Undo / Redo ────────────────────────────────────────────

    get canUndo(): boolean {
        return this.undoStack.length > 0;
    }

    get canRedo(): boolean {
        return this.redoStack.length > 0;
    }

    async undo(): Promise<boolean> {
        const action = this.undoStack.pop();
        if (!action) {
            new Notice(t('Nothing to undo'));
            return false;
        }

        try {
            await this.applyReverse(action);
            this.redoStack.push(action);
            if (this.redoStack.length > MAX_STACK) this.redoStack.shift();
            new Notice(t('Undo: {action}', { action: action.label }));
            this.onAfterUndoRedo?.();
            return true;
        } catch (e) {
            this.undoStack.push(action);
            console.error('NarrativeLab: undo failed', e);
            new Notice(t('Undo failed: {message}', { message: (e as Error).message }));
            return false;
        }
    }

    async redo(): Promise<boolean> {
        const action = this.redoStack.pop();
        if (!action) {
            new Notice(t('Nothing to redo'));
            return false;
        }

        try {
            await this.applyForward(action);
            this.undoStack.push(action);
            if (this.undoStack.length > MAX_STACK) this.undoStack.shift();
            new Notice(t('Redo: {action}', { action: action.label }));
            this.onAfterUndoRedo?.();
            return true;
        } catch (e) {
            this.redoStack.push(action);
            console.error('NarrativeLab: redo failed', e);
            new Notice(t('Redo failed: {message}', { message: (e as Error).message }));
            return false;
        }
    }

    /**
     * Clear all history (e.g. on project switch)
     */
    clear(): void {
        this.undoStack = [];
        this.redoStack = [];
        this.pendingUpdates.clear();
    }

    // ─── Internal ───────────────────────────────────────────────

    private push(action: UndoAction): void {
        this.undoStack.push(action);
        if (this.undoStack.length > MAX_STACK) this.undoStack.shift();
        // A new action always clears the redo stack
        this.redoStack = [];
    }

    /**
     * Apply the *reverse* of an action (for undo).
     */
    private async applyReverse(action: UndoAction): Promise<void> {
        switch (action.type) {
            case 'update': {
                await this.restoreUpdate(action, 'undo');
                break;
            }
            case 'delete': {
                // Re-create the deleted file
                if (action.fileContent === undefined) throw new Error(t('No saved content is available to restore this file.'));
                await this.ensureParentFolder(action.filePath);
                await this.app.vault.create(action.filePath, action.fileContent);
                break;
            }
            case 'create': {
                // Delete the created file
                const file = this.app.vault.getAbstractFileByPath(action.filePath);
                if (file && file instanceof TFile) {
                    const currentContent = await this.app.vault.read(file);
                    if (currentContent !== action.createdContent) {
                        throw new Error(t('The file changed outside NarrativeLab. Undo was cancelled to protect the newer content.'));
                    }
                    await this.app.fileManager.trashFile(file);
                }
                break;
            }
        }
    }

    /**
     * Apply an action forward (for redo).
     */
    private async applyForward(action: UndoAction): Promise<void> {
        switch (action.type) {
            case 'update': {
                await this.restoreUpdate(action, 'redo');
                break;
            }
            case 'delete': {
                // Delete the file again
                const file = this.app.vault.getAbstractFileByPath(action.filePath);
                if (file && file instanceof TFile) {
                    const currentContent = await this.app.vault.read(file);
                    if (currentContent !== action.fileContent) {
                        throw new Error(t('The file changed outside NarrativeLab. Redo was cancelled to protect the newer content.'));
                    }
                    await this.app.fileManager.trashFile(file);
                }
                break;
            }
            case 'create': {
                // Re-create the file
                if (action.createdContent === undefined) throw new Error(t('No saved content is available to recreate this file.'));
                await this.ensureParentFolder(action.filePath);
                await this.app.vault.create(action.filePath, action.createdContent);
                break;
            }
        }
    }

    private async restoreUpdate(action: UndoAction, direction: 'undo' | 'redo'): Promise<void> {
        const sourcePath = direction === 'undo' ? action.afterPath : action.beforePath;
        const targetPath = direction === 'undo' ? action.beforePath : action.afterPath;
        const expectedContent = direction === 'undo' ? action.afterContent : action.beforeContent;
        const targetContent = direction === 'undo' ? action.beforeContent : action.afterContent;
        if (!sourcePath || !targetPath || expectedContent === undefined || targetContent === undefined) {
            throw new Error(t('No saved content is available to restore this file.'));
        }

        const source = this.app.vault.getAbstractFileByPath(sourcePath);
        const target = this.app.vault.getAbstractFileByPath(targetPath);
        let file: TFile;
        if (!(source instanceof TFile)) {
            // A previous attempt may have completed the rename but failed before modifying content.
            if (target instanceof TFile) file = target;
            else throw new Error(t('File not found'));
        } else if (sourcePath !== targetPath && target) {
            throw new Error(t('A file already exists at the restore location.'));
        } else {
            file = source;
        }

        const currentContent = await this.app.vault.read(file);
        if (currentContent !== expectedContent) {
            throw new Error(t('The file changed outside NarrativeLab. {action} was cancelled to protect the newer content.', {
                action: direction === 'undo' ? t('Undo') : t('Redo'),
            }));
        }

        if (file.path !== targetPath) {
            await this.ensureParentFolder(targetPath);
            await this.app.fileManager.renameFile(file, targetPath);
            const renamed = this.app.vault.getAbstractFileByPath(targetPath);
            if (!(renamed instanceof TFile)) throw new Error(t('File not found'));
            file = renamed;
        }
        await this.app.vault.modify(file, targetContent);
    }

    private async ensureParentFolder(filePath: string): Promise<void> {
        const parts = filePath.split('/');
        parts.pop(); // remove filename
        if (parts.length === 0) return;
        const folder = parts.join('/');
        const existing = this.app.vault.getAbstractFileByPath(folder);
        if (!existing) {
            await this.app.vault.createFolder(folder);
        }
    }
}
