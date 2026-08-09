
import { App, Modal, Notice, Setting } from 'obsidian';
import { UniversalFieldTemplate, UniversalFieldType, generateId, suggestTopLevelKey, isReservedTopLevelKey } from '../services/FieldTemplateService';
import { CHARACTER_CATEGORIES } from '../models/Character';
import { t } from '../utils/i18n';

// ═══════════════════════════════════════════════════════
//  Add / Edit Universal Field Modal
// ═══════════════════════════════════════════════════════

/**
 * Modal to create or edit a universal field template.
 * Opens when the user clicks the '+' button in a section header.
 */
export class AddFieldModal extends Modal {
    private existing: UniversalFieldTemplate | null;
    private onSubmit: (template: UniversalFieldTemplate, positionAfterId?: string | null) => void;
    private onDelete?: () => void;
    private customSectionNames?: string[];
    /** Issue #92 — siblings (same section + category) used to populate the Position dropdown */
    private siblings: Array<{ id: string; label: string }> = [];
    /** Issue #92 — selected position: undefined = at end (default), null = at top, string = after that sibling id */
    private positionAfterId: string | null | undefined = undefined;

    // Working state
    private label = '';
    private labelInput: HTMLInputElement | null = null;
    private type: UniversalFieldType = 'text';
    private section = '';
    private placeholder = '';
    private options: string[] = [];
    private folderSource = '';
    private topLevelKey = '';
    private topLevelKeyTouched = false;
    private defaultValue = '';

    /**
     * @param app            Obsidian App
     * @param defaultSection The section title to pre-select (e.g. 'Basic Information')
     * @param existing       If editing, the existing template; null for new
     * @param onSubmit       Called when the user confirms
     * @param onDelete       Called when the user clicks Delete (edit mode only)
     * @param sectionNames   Optional override for section dropdown (e.g. Codex categories)
     */
    constructor(
        app: App,
        defaultSection: string,
        existing: UniversalFieldTemplate | null,
        onSubmit: (template: UniversalFieldTemplate, positionAfterId?: string | null) => void,
        onDelete?: () => void,
        sectionNames?: string[],
        siblings?: Array<{ id: string; label: string }>,
    ) {
        super(app);
        this.existing = existing;
        this.onSubmit = onSubmit;
        this.onDelete = onDelete;
        this.customSectionNames = sectionNames;
        this.siblings = (siblings || []).filter(s => !existing || s.id !== existing.id);

        if (existing) {
            this.label = existing.label;
            this.type = existing.type;
            this.section = existing.section;
            this.placeholder = existing.placeholder;
            this.options = [...existing.options];
            this.folderSource = existing.folderSource ?? '';
            this.topLevelKey = existing.topLevelKey ?? '';
            this.topLevelKeyTouched = !!existing.topLevelKey;
            this.defaultValue = existing.defaultValue ?? '';
        } else {
            this.section = defaultSection;
        }
    }

    onOpen(): void {
        const { contentEl } = this;
        contentEl.empty();
        contentEl.addClass('storyline-add-field-modal');

        contentEl.createEl('h3', {
            text: this.existing ? t('Edit Universal Field') : t('Add Universal Field'),
        });

        const sheetLabel = this.customSectionNames ? 'entry' : 'character sheet';
        contentEl.createEl('p', {
            cls: 'storyline-add-field-desc',
            text: t('This field will appear on every {sheet} in the chosen section.', { sheet: sheetLabel }),
        });

        // ── Label ──
        let topLevelKeyInput: HTMLInputElement | null = null;
        new Setting(contentEl)
            .setName(t('Field label'))
            .setDesc(t('The name shown next to the input'))
            .addText(text => {
                text.setPlaceholder(t('e.g. Species'))
                    .setValue(this.label)
                    .onChange(v => {
                        this.label = v.trim();
                        if (!this.topLevelKeyTouched && topLevelKeyInput) {
                            this.topLevelKey = suggestTopLevelKey(this.label);
                            topLevelKeyInput.value = this.topLevelKey;
                        }
                    });
                this.labelInput = text.inputEl;
                text.inputEl.focus();
            });

        // ── Section ──
        const sectionNames = this.customSectionNames || CHARACTER_CATEGORIES.map(c => c.title);
        new Setting(contentEl)
            .setName(t('Section'))
            .setDesc(t('Where this field appears on the {sheet}', { sheet: sheetLabel }))
            .addDropdown(dd => {
                for (const name of sectionNames) {
                    dd.addOption(name, name);
                }
                dd.setValue(this.section || sectionNames[0]);
                dd.onChange(v => { this.section = v; });
            });

        // ── Type ──
        let optionsContainer: HTMLElement | null = null;
        let folderSourceContainer: HTMLElement | null = null;
        new Setting(contentEl)
            .setName(t('Input type'))
            .addDropdown(dd => {
                dd.addOption('text', 'Text (single line)');
                dd.addOption('textarea', 'Text block (multi-line)');
                dd.addOption('dropdown', 'Dropdown menu');
                dd.addOption('multi-select', 'Multi-select (tags)');
                dd.addOption('checkbox', 'Checkbox (yes/no)');
                dd.setValue(this.type);
                dd.onChange(v => {
                    this.type = v as UniversalFieldType;
                    const showOpts = this.type === 'dropdown' || this.type === 'multi-select';
                    if (optionsContainer) {
                        optionsContainer.setCssStyles({ display: showOpts ? '' : 'none' });
                    }
                    if (folderSourceContainer) {
                        const showFolderSrc = this.type === 'multi-select' || this.type === 'dropdown';
                        folderSourceContainer.setCssStyles({ display: showFolderSrc ? '' : 'none' });
                    }
                });
            });

        // ── Placeholder ──
        new Setting(contentEl)
            .setName(t('Placeholder'))
            .setDesc(t('Hint text shown when the field is empty'))
            .addText(text => {
                text.setPlaceholder(t('e.g. Human, Elf, Dwarf…'))
                    .setValue(this.placeholder)
                    .onChange(v => { this.placeholder = v; });
            });

        // ── Dropdown options ──
        optionsContainer = contentEl.createDiv('storyline-field-options-container');
        if (this.type !== 'dropdown' && this.type !== 'multi-select') optionsContainer.setCssStyles({ display: 'none' });

        const optionsLabel = optionsContainer.createEl('div', {
            cls: 'setting-item-name',
            text: t('Dropdown options'),
        });
        optionsLabel.setCssStyles({ marginBottom: '4px' });

        const optionsList = optionsContainer.createDiv('storyline-field-options-list');
        const renderOptions = () => {
            optionsList.empty();
            for (let i = 0; i < this.options.length; i++) {
                const row = optionsList.createDiv('storyline-field-option-row');
                const input = row.createEl('input', {
                    cls: 'storyline-field-option-input',
                    type: 'text',
                    attr: { placeholder: t('Option {n}', { n: i + 1 }) },
                });
                input.value = this.options[i];
                input.addEventListener('input', () => {
                    this.options[i] = input.value;
                });

                const removeBtn = row.createEl('button', {
                    cls: 'storyline-field-option-remove',
                    text: '×',
                    attr: { title: t('Remove option') },
                });
                removeBtn.addEventListener('click', () => {
                    this.options.splice(i, 1);
                    renderOptions();
                });
            }
        };
        renderOptions();

        const addOptBtn = optionsContainer.createEl('button', {
            cls: 'storyline-field-option-add',
            text: t('+ Add option'),
        });
        addOptBtn.addEventListener('click', () => {
            this.options.push('');
            renderOptions();
            // Focus the new input
            const inputs = optionsList.querySelectorAll('input');
            if (inputs.length) inputs[inputs.length - 1].focus();
        });

        // ── Folder source (dropdown / multi-select) ──
        folderSourceContainer = contentEl.createDiv('storyline-field-folder-source-container');
        if (this.type !== 'multi-select' && this.type !== 'dropdown') folderSourceContainer.setCssStyles({ display: 'none' });
        new Setting(folderSourceContainer)
            .setName(t('Folder source (optional)'))
            .setDesc(t('Vault folder path whose note names become selectable options (e.g. Traits/)'))
            .addText(text => {
                text.setPlaceholder(t('e.g. World/Traits'))
                    .setValue(this.folderSource)
                    .onChange(v => { this.folderSource = v.trim(); });
            });

        // ── Top-level YAML key (issue #71) ──
        new Setting(contentEl)
            .setName(t('Top-level YAML key (optional)'))
            .setDesc(t('When set, this field\'s value is also written as a top-level YAML key so it appears in Obsidian Properties / Bases / Dataview. Leave blank to keep it inside `universalFields:` only. Reserved NarrativeLab keys are not allowed.'))
            .addText(text => {
                text.setPlaceholder(suggestTopLevelKey(this.label || 'field'))
                    .setValue(this.topLevelKey)
                    .onChange(v => {
                        this.topLevelKey = v.trim();
                        this.topLevelKeyTouched = true;
                    });
                topLevelKeyInput = text.inputEl;
            });

        // ── Default value (issue #77) ──
        new Setting(contentEl)
            .setName(t('Default value (optional)'))
            .setDesc(t('Pre-fill this field on newly-created entities (currently applied to scenes). For multi-select fields, separate values with commas.'))
            .addText(text => {
                text.setPlaceholder(t('e.g. Draft, fountain, Setup'))
                    .setValue(this.defaultValue)
                    .onChange(v => { this.defaultValue = v; });
            });

        // ── Position (issue #92) ──
        if (this.siblings.length > 0) {
            new Setting(contentEl)
                .setName(t('Position'))
                .setDesc(t('Where the field appears in the section'))
                .addDropdown(dd => {
                    dd.addOption('__end__', 'At end (default)');
                    dd.addOption('__top__', 'At top');
                    for (const s of this.siblings) {
                        dd.addOption(s.id, `After: ${s.label}`);
                    }
                    dd.setValue('__end__');
                    dd.onChange(v => {
                        if (v === '__end__') this.positionAfterId = undefined;
                        else if (v === '__top__') this.positionAfterId = null;
                        else this.positionAfterId = v;
                    });
                });
        }

        // ── Action buttons ──
        const footer = contentEl.createDiv('storyline-add-field-footer');

        if (this.existing && this.onDelete) {
            const deleteBtn = footer.createEl('button', {
                cls: 'mod-warning storyline-field-delete-btn',
                text: t('Delete field'),
            });
            deleteBtn.addEventListener('click', () => {
                this.onDelete!();
                this.close();
            });
        }


        const cancelBtn = footer.createEl('button', { text: t('Cancel') });
        cancelBtn.addEventListener('click', () => this.close());

        const confirmBtn = footer.createEl('button', {
            cls: 'mod-cta',
            text: this.existing ? t('Save') : t('Add field'),
        });
        confirmBtn.addEventListener('click', () => {
            // Read input value directly in case onChange hasn't fired yet (issue #115)
            if (this.labelInput) {
                const raw = this.labelInput.value.trim();
                if (raw) this.label = raw;
            }
            if (!this.label) {
                // Highlight label field
                const labelInput = contentEl.querySelector('.setting-item:first-child input') as HTMLInputElement;
                if (labelInput) {
                    labelInput.addClass('is-invalid');
                    labelInput.focus();
                }
                return;
            }

            // Filter empty options
            const cleanOptions = this.options.map(o => o.trim()).filter(Boolean);

            const tlk = this.topLevelKey.trim();
            if (tlk) {
                if (!/^[A-Za-z][A-Za-z0-9_]*$/.test(tlk)) {
                    new Notice(t('Top-level YAML key must start with a letter and use only letters, numbers, or underscores.'));
                    return;
                }
                if (isReservedTopLevelKey(tlk)) {
                    new Notice(t('"{key}" is reserved by NarrativeLab. Choose a different key.', { key: tlk }));
                    return;
                }
            }

            const template: UniversalFieldTemplate = {
                id: this.existing?.id ?? generateId(),
                label: this.label,
                section: this.section || CHARACTER_CATEGORIES[0].title,
                category: this.existing?.category,
                type: this.type,
                options: (this.type === 'dropdown' || this.type === 'multi-select') ? cleanOptions : [],
                folderSource: (this.type === 'multi-select' || this.type === 'dropdown') && this.folderSource ? this.folderSource : undefined,
                placeholder: this.placeholder,
                topLevelKey: tlk || undefined,
                defaultValue: this.defaultValue.trim() ? this.defaultValue.trim() : undefined,
                order: this.existing?.order ?? Date.now(),
            };

            this.onSubmit(template, this.positionAfterId);
            this.close();
        });
    }

    onClose(): void {
        this.contentEl.empty();
    }
}
