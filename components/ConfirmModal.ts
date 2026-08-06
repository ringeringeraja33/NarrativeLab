/* eslint-disable @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-argument, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-return, @typescript-eslint/no-floating-promises, @typescript-eslint/no-misused-promises, @typescript-eslint/no-unnecessary-type-assertion, @typescript-eslint/no-redundant-type-constituents, @typescript-eslint/no-unused-vars, no-unused-vars, no-useless-escape, no-control-regex, no-empty -- Obsidian's API surface and several untyped third-party libraries force dynamic dispatch; floating promises are intentional in DOM/event handlers; matching enable at end of file */
import { Modal, App, Setting } from 'obsidian';
import { t } from '../utils/i18n';

/**
 * A reusable confirmation dialog that replaces native `confirm()`.
 *
 * Uses Obsidian's Modal API so it integrates with the theme, doesn't
 * block the UI thread, and works on mobile.
 *
 * Usage:
 *   openConfirmModal(app, {
 *       title: t('Delete Scene'),
 *       message: 'Are you sure you want to delete "The Chase"?',
 *       confirmLabel: 'Delete',
 *       confirmClass: 'mod-warning',
 *       onConfirm: () => { ... },
 *   });
 */

export interface ConfirmModalOptions {
    /** Title shown in the modal header */
    title: string;
    /** Body message (can include HTML-safe text) */
    message: string;
    /** Label for the confirm button (default: "Confirm") */
    confirmLabel?: string;
    /** CSS class for the confirm button (default: "mod-warning") */
    confirmClass?: string;
    /** Label for the cancel button (default: "Cancel") */
    cancelLabel?: string;
    /** Called when the user clicks confirm */
    onConfirm: () => void | Promise<void>;
    /** Called when the user clicks cancel (optional) */
    onCancel?: () => void;
}

export function openConfirmModal(app: App, opts: ConfirmModalOptions): void {
    const modal = new Modal(app);
    modal.titleEl.setText(opts.title);
    modal.contentEl.createEl('p', { text: opts.message });

    new Setting(modal.contentEl)
        .addButton(btn => {
            btn.setButtonText(opts.cancelLabel ?? 'Cancel')
                .onClick(() => {
                    modal.close();
                    opts.onCancel?.();
                });
        })
        .addButton(btn => {
            const b = btn.setButtonText(opts.confirmLabel ?? 'Confirm');
            if (opts.confirmClass === 'mod-cta') {
                b.setCta();
            } else {
                b.setClass(opts.confirmClass ?? 'mod-warning');
            }
            b.onClick(async () => {
                modal.close();
                await opts.onConfirm();
            });
        });

    modal.open();
}
/* eslint-enable @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-argument, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-return, @typescript-eslint/no-floating-promises, @typescript-eslint/no-misused-promises, @typescript-eslint/no-unnecessary-type-assertion, @typescript-eslint/no-redundant-type-constituents, @typescript-eslint/no-unused-vars, no-unused-vars, no-useless-escape, no-control-regex, no-empty -- end of file-wide suppression block opened at line 1 */
