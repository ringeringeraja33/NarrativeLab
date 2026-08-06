/* eslint-disable @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-argument, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-return, @typescript-eslint/no-floating-promises, @typescript-eslint/no-misused-promises, @typescript-eslint/no-unnecessary-type-assertion, @typescript-eslint/no-redundant-type-constituents, @typescript-eslint/no-unused-vars, no-unused-vars, no-useless-escape, no-control-regex, no-empty -- Obsidian's API surface and several untyped third-party libraries force dynamic dispatch; floating promises are intentional in DOM/event handlers; matching enable at end of file */
import { Modal, App, Setting } from 'obsidian';
import { RenamePreview } from '../services/CascadeRenameService';
import { t } from '../utils/i18n';

/**
 * Modal that shows the user what a rename will affect and asks for confirmation.
 *
 * Displays a summary like:
 *   Rename "John" → "Jonathan"?
 *   This will update 12 scenes and 3 relationships.
 *
 * - "Update References" — cascades the rename across the project
 * - "Cancel" — reverts the name back to the original
 */
export class RenameConfirmModal extends Modal {
    private resolved = false;

    constructor(
        app: App,
        private entityType: 'character' | 'world' | 'location',
        private oldName: string,
        private newName: string,
        private preview: RenamePreview,
        private summaryText: string,
        private onConfirm: () => void | Promise<void>,
        private onCancel?: () => void,
    ) {
        super(app);
    }

    onOpen(): void {
        const { contentEl } = this;
        const label = this.entityType.charAt(0).toUpperCase() + this.entityType.slice(1);

        this.titleEl.setText(t('Rename {label}', { label: t(label) }));

        // Description
        contentEl.createEl('p', {
            text: t('Rename "{old}" → "{new}"?', { old: this.oldName, new: this.newName }),
        }).setCssStyles({ fontWeight: '600' });

        contentEl.createEl('p', {
            text: this.summaryText,
            cls: 'setting-item-description',
        });

        // Detail breakdown
        const details = contentEl.createEl('div');
        details.setCssStyles({
            marginBottom: '12px',
            fontSize: '13px',
            color: 'var(--text-muted)',
        });

        if (this.preview.sceneCount > 0) {
            details.createEl('div', { text: t('• {n} scene(s) (pov, characters, location fields)', { n: this.preview.sceneCount }) });
        }
        if (this.preview.relationCount > 0) {
            details.createEl('div', { text: t('• {n} character relationship(s)', { n: this.preview.relationCount }) });
        }
        if (this.preview.locationCount > 0) {
            details.createEl('div', { text: t('• {n} child location(s) (world/parent fields)', { n: this.preview.locationCount }) });
        }
        if (this.preview.characterLocationCount > 0) {
            details.createEl('div', { text: t('• {n} character location reference(s)', { n: this.preview.characterLocationCount }) });
        }

        // Buttons
        new Setting(contentEl)
            .addButton(btn => {
                btn.setButtonText(t('Cancel'))
                    .onClick(() => {
                        this.resolved = true;
                        this.close();
                        this.onCancel?.();
                    });
            })
            .addButton(btn => {
                btn.setButtonText(t('Update References'))
                    .setCta()
                    .onClick(async () => {
                        this.resolved = true;
                        this.close();
                        await this.onConfirm();
                    });
            });
    }

    onClose(): void {
        if (!this.resolved) {
            // User closed modal without choosing (Escape key) — revert name
            this.onCancel?.();
        }
        this.contentEl.empty();
    }
}
/* eslint-enable @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-argument, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-return, @typescript-eslint/no-floating-promises, @typescript-eslint/no-misused-promises, @typescript-eslint/no-unnecessary-type-assertion, @typescript-eslint/no-redundant-type-constituents, @typescript-eslint/no-unused-vars, no-unused-vars, no-useless-escape, no-control-regex, no-empty -- end of file-wide suppression block opened at line 1 */
