/* eslint-disable @typescript-eslint/no-misused-promises -- Obsidian's API surface and several untyped third-party libraries force dynamic dispatch; floating promises are intentional in DOM/event handlers; matching enable at end of file */
import * as obsidian from 'obsidian';
import type { ViewSnapshotService, ViewSnapshotMeta } from '../services/ViewSnapshotService';
import { App, Modal, Notice } from 'obsidian';
import { t } from '../utils/i18n';

/* ─── Manage Snapshots Modal ──────────────────────────────── */

export function openManageSnapshotsModal(
    app: App,
    service: ViewSnapshotService,
): void {
    new ManageSnapshotsModal(app, service).open();
}

class ManageSnapshotsModal extends Modal {
    private service: ViewSnapshotService;
    private listEl!: HTMLElement;

    constructor(app: App, service: ViewSnapshotService) {
        super(app);
        this.service = service;
    }

    async onOpen() {
        this.titleEl.setText(t('View Snapshots'));
        this.modalEl.addClass('sl-snapshot-modal');

        // Header row
        const header = this.contentEl.createDiv({ cls: 'sl-snapshot-header' });
        header.createEl('span', { text: t('Board & plot grid layouts for this project.') });

        const newDiv = header.createDiv({ cls: 'sl-snapshot-new-btn clickable-icon' });
        obsidian.setIcon(newDiv, 'plus');
        newDiv.setAttribute('aria-label', t('New Snapshot'));
        newDiv.setAttribute('title', t('Capture current board & plot grid'));
        newDiv.addEventListener('click', async () => {
            const snap = await this.service.createSnapshot(`Snapshot ${await this.service.getNextId()}`);
            new Notice(t('Created snapshot #{id}', { id: snap.id }));
            await this.renderList();
        });

        this.listEl = this.contentEl.createDiv({ cls: 'sl-snapshot-list' });
        await this.renderList();
    }

    private async renderList() {
        this.listEl.empty();
        const metas = await this.service.listSnapshots();
        const activeId = this.service.activeSnapshotId;

        if (metas.length === 0) {
            this.listEl.createEl('p', {
                text: t('No snapshots yet. Click + to capture the current board and plot grid layout.'),
                cls: 'sl-snapshot-empty',
            });
            return;
        }

        this.listEl.createEl('p', {
            text: t('Click a snapshot or Restore to apply its board & plot grid layout.'),
            cls: 'sl-snapshot-hint',
        });

        for (const meta of metas) {
            this.renderSnapshotItem(meta, meta.id === activeId);
        }
    }

    private renderSnapshotItem(meta: ViewSnapshotMeta, isActive: boolean) {
        const row = this.listEl.createDiv({ cls: `sl-snapshot-item${isActive ? ' is-active' : ''}` });
        row.setAttribute('role', 'button');
        row.setAttribute('tabindex', '0');
        row.setAttribute(
            'aria-label',
            t('Restore snapshot #{id} "{name}"', { id: meta.id, name: meta.name }),
        );

        // Info
        const info = row.createDiv({ cls: 'sl-snapshot-info' });
        const titleLine = info.createDiv({ cls: 'sl-snapshot-title-line' });
        titleLine.createEl('span', { text: `#${meta.id}`, cls: 'sl-snapshot-id' });
        titleLine.createEl('span', { text: meta.name || t('Untitled'), cls: 'sl-snapshot-name' });
        if (isActive) {
            titleLine.createEl('span', { text: t('Active'), cls: 'sl-snapshot-badge' });
        }

        const dateStr = new Date(meta.modified ?? meta.created).toLocaleString();
        info.createEl('div', { text: dateStr, cls: 'sl-snapshot-date' });
        if (meta.description) {
            info.createEl('div', { text: meta.description, cls: 'sl-snapshot-desc' });
        }

        // Actions (divs, not buttons)
        const actions = row.createDiv({ cls: 'sl-snapshot-actions' });

        const restoreDiv = actions.createDiv({
            cls: 'sl-snapshot-action-btn sl-snapshot-restore clickable-icon',
            attr: {
                'aria-label': t('Restore'),
                title: isActive
                    ? t('Reload this snapshot (discard unsaved layout changes)')
                    : t('Restore this snapshot'),
            },
        });
        obsidian.setIcon(restoreDiv, 'upload');
        restoreDiv.createEl('span', { text: t('Restore') });
        restoreDiv.addEventListener('click', (e) => {
            e.stopPropagation();
            void this.restore(meta);
        });

        const editDiv = actions.createDiv({
            cls: 'sl-snapshot-action-btn clickable-icon',
            attr: { 'aria-label': t('Edit'), title: t('Edit') },
        });
        obsidian.setIcon(editDiv, 'pencil');
        editDiv.addEventListener('click', (e) => {
            e.stopPropagation();
            this.openEditInline(meta, row);
        });

        const deleteDiv = actions.createDiv({
            cls: 'sl-snapshot-action-btn clickable-icon sl-snapshot-delete',
            attr: { 'aria-label': t('Delete'), title: t('Delete') },
        });
        obsidian.setIcon(deleteDiv, 'trash-2');
        deleteDiv.addEventListener('click', async (e) => {
            e.stopPropagation();
            await this.service.deleteSnapshot(meta.id);
            new Notice(t('Deleted snapshot #{id}.', { id: meta.id }));
            await this.renderList();
        });

        // Clicking the row (outside action icons) restores the snapshot.
        row.addEventListener('click', (e) => {
            if ((e.target as HTMLElement | null)?.closest('.sl-snapshot-actions')) return;
            void this.restore(meta);
        });
        row.addEventListener('keydown', (e) => {
            if (e.key !== 'Enter' && e.key !== ' ') return;
            e.preventDefault();
            void this.restore(meta);
        });
    }

    private async restore(meta: ViewSnapshotMeta): Promise<void> {
        const ok = await this.service.restoreSnapshot(meta.id);
        if (ok) {
            new Notice(t('Loaded snapshot #{id} "{name}".', { id: meta.id, name: meta.name }));
            this.close();
        } else {
            new Notice(t('Failed to load snapshot.'));
        }
    }

    private openEditInline(meta: ViewSnapshotMeta, row: HTMLElement) {
        row.empty();
        row.removeAttribute('role');
        row.removeAttribute('tabindex');
        row.addClass('sl-snapshot-editing');

        const form = row.createDiv({ cls: 'sl-snapshot-edit-form' });

        const nameInput = form.createEl('input', { type: 'text', cls: 'sl-snapshot-edit-input', value: meta.name });
        nameInput.placeholder = t('Name');

        const descInput = form.createEl('input', { type: 'text', cls: 'sl-snapshot-edit-input', value: meta.description ?? '' });
        descInput.placeholder = t('Description (optional)');

        const btns = form.createDiv({ cls: 'sl-snapshot-edit-btns' });
        const saveDiv = btns.createDiv({ cls: 'sl-snapshot-action-btn clickable-icon', attr: { 'aria-label': t('Save') } });
        obsidian.setIcon(saveDiv, 'check');
        saveDiv.createEl('span', { text: t('Save') });
        saveDiv.addEventListener('click', async () => {
            const n = nameInput.value.trim();
            if (!n) { new Notice(t('Name is required.')); return; }
            await this.service.updateMeta(meta.id, n, descInput.value.trim());
            await this.renderList();
        });

        const cancelDiv = btns.createDiv({ cls: 'sl-snapshot-action-btn clickable-icon', attr: { 'aria-label': t('Cancel') } });
        obsidian.setIcon(cancelDiv, 'x');
        cancelDiv.addEventListener('click', () => this.renderList());

        window.setTimeout(() => nameInput.focus(), 30);
    }
}
/* eslint-enable @typescript-eslint/no-misused-promises -- end of file-wide suppression block opened at line 1 */
