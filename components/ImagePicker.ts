/* eslint-disable @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-argument, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-return, @typescript-eslint/no-floating-promises, @typescript-eslint/no-misused-promises, @typescript-eslint/no-unnecessary-type-assertion, @typescript-eslint/no-redundant-type-constituents, @typescript-eslint/no-unused-vars, no-unused-vars, no-useless-escape, no-control-regex, no-empty -- Obsidian's API surface and several untyped third-party libraries force dynamic dispatch; floating promises are intentional in DOM/event handlers; matching enable at end of file */
/**
 * ImagePicker — shared image selection component.
 *
 * Provides:
 *   - Import from computer (uses hidden <input type="file">, copies into vault)
 *   - Choose from vault (fuzzy suggest modal)
 *   - Remove image
 */
import { App, Modal, TFile, Notice, FuzzySuggestModal, normalizePath } from 'obsidian';
import * as obsidian from 'obsidian';
import { t } from '../utils/i18n';

function normalizeImagePath(imagePath: string): string {
    let normalized = imagePath.trim();
    if (!normalized) return '';

    normalized = normalized.replace(/\\/g, '/');

    if (normalized.startsWith('!')) {
        normalized = normalized.slice(1).trim();
    }

    const wikiMatch = normalized.match(/^\[\[([\s\S]+?)\]\]$/);
    if (wikiMatch) {
        normalized = wikiMatch[1].trim();
    }

    const pipeIndex = normalized.indexOf('|');
    if (pipeIndex >= 0) {
        normalized = normalized.slice(0, pipeIndex).trim();
    }

    const headingIndex = normalized.indexOf('#');
    if (headingIndex >= 0) {
        normalized = normalized.slice(0, headingIndex).trim();
    }

    normalized = normalized.replace(/^\/+/, '');
    return normalized;
}

/**
 * Helper function to resolve an image path to a valid resource URL
 * Tries multiple approaches to handle different image storage methods
 */
export function resolveImagePath(app: App, imagePath: string): string {
    if (!imagePath) return '';
    const normalizedPath = normalizeImagePath(imagePath);
    if (!normalizedPath) return '';
    
    // Handle direct URLs
    if (normalizedPath.startsWith('http://') || normalizedPath.startsWith('https://')) {
        return normalizedPath;
    }
    
    // Try to get the file object — vault.getResourcePath(TFile) is the most reliable
    try {
        const imageFile = app.vault.getAbstractFileByPath(normalizedPath);
        if (imageFile instanceof TFile) {
            return app.vault.getResourcePath(imageFile);
        }
    } catch { /* fall through */ }

    // Try Obsidian linkpath resolution (handles relative and extensionless paths)
    try {
        const linked = app.metadataCache.getFirstLinkpathDest(normalizedPath, '');
        if (linked instanceof TFile) {
            return app.vault.getResourcePath(linked);
        }
    } catch { /* fall through */ }

    // Fallback: match by basename when only filename was stored in frontmatter
    try {
        const lower = normalizedPath.toLowerCase();
        const allFiles = app.vault.getFiles();
        const byExactPath = allFiles.find(f => f.path.toLowerCase() === lower);
        if (byExactPath) return app.vault.getResourcePath(byExactPath);

        const byTail = allFiles.find(f => f.path.toLowerCase().endsWith(`/${lower}`));
        if (byTail) return app.vault.getResourcePath(byTail);

        // Project folders may be renamed outside NarrativeLab while older
        // frontmatter keeps the previous full path. Recover an unambiguous
        // image by filename instead of permanently losing the portrait.
        const basename = lower.split('/').pop() ?? '';
        if (basename) {
            const basenameMatches = allFiles.filter(f => f.name.toLowerCase() === basename);
            if (basenameMatches.length === 1) {
                return app.vault.getResourcePath(basenameMatches[0]);
            }
        }
    } catch { /* fall through */ }
    
    // Fallback to adapter resource path
    return app.vault.adapter.getResourcePath(normalizedPath);
}

async function ensureParentFolder(app: App, filePath: string): Promise<void> {
    const parts = normalizePath(filePath).split('/').slice(0, -1);
    let current = '';
    for (const part of parts) {
        current = current ? `${current}/${part}` : part;
        if (!await app.vault.adapter.exists(current)) await app.vault.createFolder(current);
    }
}

async function uniquePathInFolder(app: App, folder: string, fileName: string): Promise<string> {
    const normalizedFolder = normalizePath(folder);
    await ensureParentFolder(app, `${normalizedFolder}/${fileName}`);
    let candidate = normalizePath(`${normalizedFolder}/${fileName}`);
    if (!await app.vault.adapter.exists(candidate)) return candidate;
    const dot = fileName.lastIndexOf('.');
    const base = dot >= 0 ? fileName.slice(0, dot) : fileName;
    const ext = dot >= 0 ? fileName.slice(dot) : '';
    for (let index = 2; index < 1000; index += 1) {
        candidate = normalizePath(`${normalizedFolder}/${base}-${index}${ext}`);
        if (!await app.vault.adapter.exists(candidate)) return candidate;
    }
    throw new Error('Could not find an available attachment path.');
}

async function resolveAttachmentImportPath(app: App, fileName: string, attachmentSourcePath: string): Promise<string> {
    const source = normalizePath(attachmentSourcePath);
    if (source && !source.endsWith('.md')) {
        return uniquePathInFolder(app, source, fileName);
    }
    return normalizePath(await app.fileManager.getAvailablePathForAttachment(fileName, source));
}

/**
 * Import a file using Obsidian's global attachment-folder setting.
 * Returns the vault-relative path of the imported file, or undefined on cancel/error.
 */
function importImageFromComputer(app: App, attachmentSourcePath: string): Promise<string | undefined> {
    return new Promise((resolve) => {
        const input = activeDocument.createElement('input');
        input.type = 'file';
        input.accept = 'image/png,image/jpeg,image/gif,image/svg+xml,image/webp,image/bmp,image/avif';
        input.setCssStyles({ display: 'none' });
        activeDocument.body.appendChild(input);

        let settled = false;
        const complete = (result: string | undefined): void => {
            if (settled) return;
            settled = true;
            input.removeEventListener('change', onChange);
            input.removeEventListener('cancel', onCancel);
            window.removeEventListener('focus', onFocus);
            if (activeDocument.body.contains(input)) {
                activeDocument.body.removeChild(input);
            }
            resolve(result);
        };

        const onChange = async () => {
            const file = input.files?.[0];

            if (!file) {
                complete(undefined);
                return;
            }

            try {
                // Read file as ArrayBuffer
                const buffer = await file.arrayBuffer();
                const targetPath = await resolveAttachmentImportPath(app, file.name, attachmentSourcePath);
                await ensureParentFolder(app, targetPath);

                // Write to vault
                await app.vault.createBinary(targetPath, buffer);

                new Notice(t('Image imported: {name}', { name: targetPath.split('/').pop() ?? '' }));
                
                complete(targetPath);
            } catch (err) {
                console.error('[NarrativeLab] Image import failed:', err);
                new Notice(t('Failed to import image: {err}', { err: String(err) }));
                complete(undefined);
            }
        };

        const onCancel = () => {
            complete(undefined);
        };

        // Fallback for dialogs dismissed without firing 'change'/'cancel'.
        const onFocus = () => {
            window.setTimeout(() => {
                if (settled) return;
                if (input.files && input.files.length > 0) return;
                complete(undefined);
            }, 300);
        };

        input.addEventListener('change', onChange);
        input.addEventListener('cancel', onCancel);
        window.addEventListener('focus', onFocus);

        input.click();
    });
}

/**
 * Main entry point — opens a choice modal for picking / importing an image.
 *
 * @param app          Obsidian App
 * @param attachmentSourcePath  Project attachment folder, or legacy note path for Obsidian attachment settings
 * @param currentImage Current image path (or undefined)
 * @returns vault-relative path of selected image, empty string to remove, or undefined if cancelled
 */
export function pickImage(
    app: App,
    attachmentSourcePath: string,
    currentImage?: string,
): Promise<string | undefined> {
    return new Promise((resolve) => {
        const modal = new ImageChoiceModal(app, attachmentSourcePath, currentImage, resolve);
        modal.open();
    });
}

// ── Choice Modal ────────────────────────────────────

class ImageChoiceModal extends Modal {
    private attachmentSourcePath: string;
    private currentImage?: string;
    private onResult: (result: string | undefined) => void;
    private resolved = false;

    constructor(app: App, attachmentSourcePath: string, currentImage: string | undefined, onResult: (result: string | undefined) => void) {
        super(app);
        this.attachmentSourcePath = attachmentSourcePath;
        this.currentImage = currentImage;
        this.onResult = onResult;
    }

    onOpen(): void {
        const { contentEl } = this;
        contentEl.empty();
        contentEl.addClass('storyline-image-choice-modal');

        contentEl.createEl('h3', { text: t('Set Image') });

        // Current image preview
        if (this.currentImage) {
            const preview = contentEl.createDiv('image-choice-preview');
            try {
                // Use the helper function to resolve the image path
                const imgSrc = resolveImagePath(this.app, this.currentImage);
                
                const img = preview.createEl('img', { attr: { src: imgSrc } });
                img.setCssStyles({
                    maxWidth: '160px',
                    maxHeight: '120px',
                    borderRadius: '8px',
                    objectFit: 'cover',
                    border: '1px solid var(--background-modifier-border)',
                });
                
                // Add error handler to show placeholder if image fails to load
                img.onerror = () => {
                    img.remove();
                    const placeholder = preview.createDiv('image-choice-preview-placeholder');
                    placeholder.setText(t('Image not found'));
                    console.log('Failed to load image in picker:', this.currentImage);
                };
            } catch (error) {
                console.error('Error loading image in picker:', error);
                const placeholder = preview.createDiv('image-choice-preview-placeholder');
                placeholder.setText(t('Image not found'));
            }

            const pathLabel = preview.createDiv();
            pathLabel.setCssStyles({
                fontSize: '11px',
                color: 'var(--text-muted)',
                marginTop: '4px',
            });
            pathLabel.textContent = this.currentImage;
        }

        const btnRow = contentEl.createDiv('image-choice-buttons');

        // Import from computer
        const importBtn = btnRow.createEl('button', { cls: 'mod-cta', text: t('Import from computer') });
        const importIcon = importBtn.createSpan({ cls: 'image-choice-btn-icon' });
        obsidian.setIcon(importIcon, 'upload');
        importBtn.prepend(importIcon);
        importBtn.addEventListener('click', async () => {
            this.resolved = true;
            this.close();
            const result = await importImageFromComputer(this.app, this.attachmentSourcePath);
            this.onResult(result);
        });

        // Choose from vault
        const vaultBtn = btnRow.createEl('button', { text: t('Choose from vault') });
        const vaultIcon = vaultBtn.createSpan({ cls: 'image-choice-btn-icon' });
        obsidian.setIcon(vaultIcon, 'folder-open');
        vaultBtn.prepend(vaultIcon);
        vaultBtn.addEventListener('click', () => {
            this.resolved = true;
            this.close();

            const allFiles = this.app.vault.getFiles()
                .filter(f => /\.(png|jpe?g|gif|svg|webp|bmp|avif)$/i.test(f.path))
                .sort((a, b) => a.path.localeCompare(b.path));

            const picker = new VaultImagePickerModal(this.app, allFiles, (result) => {
                this.onResult(result);
            });
            picker.open();
        });

        // Remove image (only if one is set)
        if (this.currentImage) {
            const removeBtn = btnRow.createEl('button', { cls: 'mod-warning', text: t('Remove image') });
            const removeIcon = removeBtn.createSpan({ cls: 'image-choice-btn-icon' });
            obsidian.setIcon(removeIcon, 'x');
            removeBtn.prepend(removeIcon);
            removeBtn.addEventListener('click', () => {
                this.resolved = true;
                this.onResult('');
                this.close();
            });
        }
    }

    onClose(): void {
        this.contentEl.empty();
        if (!this.resolved) {
            this.onResult(undefined);
        }
    }
}

// ── Vault Image Picker (fuzzy suggest) ──────────────

class VaultImagePickerModal extends FuzzySuggestModal<TFile> {
    private imageFiles: TFile[];
    private onSelect: (path: string | undefined) => void;
    private settled = false;

    constructor(app: App, files: TFile[], onSelect: (path: string | undefined) => void) {
        super(app);
        this.imageFiles = files;
        this.onSelect = onSelect;
        this.setPlaceholder(t('Search for an image file…'));
    }

    getItems(): TFile[] {
        return this.imageFiles;
    }

    getItemText(item: TFile): string {
        return item.path;
    }

    private emitOnce(path: string | undefined): void {
        if (this.settled) return;
        this.settled = true;
        this.onSelect(path);
    }

    onChooseItem(item: TFile, _evt: MouseEvent | KeyboardEvent): void {
        this.emitOnce(item.path);
    }

    onClose(): void {
        super.onClose();
        // Defer cancel emission to avoid event-order race where close can fire
        // before choose callback in some modal stacks.
        window.setTimeout(() => this.emitOnce(undefined), 0);
    }
}
/* eslint-enable @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-argument, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-return, @typescript-eslint/no-floating-promises, @typescript-eslint/no-misused-promises, @typescript-eslint/no-unnecessary-type-assertion, @typescript-eslint/no-redundant-type-constituents, @typescript-eslint/no-unused-vars, no-unused-vars, no-useless-escape, no-control-regex, no-empty -- end of file-wide suppression block opened at line 1 */
