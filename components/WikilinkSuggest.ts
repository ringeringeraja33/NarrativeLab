/**
 * WikilinkSuggest — a lightweight wikilink autocomplete for plain
 * <textarea> elements (issue #84).
 *
 * Watches typing in a textarea, detects an unclosed `[[` token before the
 * caret, and pops up a small fuzzy-matched list of vault notes. Pressing
 * Enter / Tab or clicking inserts `Name]]` at the caret.
 *
 * Unlike Obsidian's built-in EditorSuggest, this works on plain textareas
 * (which the NarrativeLab Inspector uses for the Notes / Comments field).
 */

import { App, FuzzySuggestModal, TFile } from 'obsidian';
import { t } from '../utils/i18n';

export interface WikilinkSuggestOptions {
    app: App;
    textareaEl: HTMLTextAreaElement;
    /** Maximum suggestions in the dropdown (default 8). */
    maxVisible?: number;
    /** Source note used by Obsidian to calculate the shortest unambiguous link text. */
    sourcePath?: string;
    /**
     * Use Obsidian's FuzzySuggestModal instead of a body-mounted dropdown.
     * Prefer this inside floating hosts (Plot Grid cell editor) where z-index /
     * overflow clipping make the custom menu unreliable.
     */
    preferModal?: boolean;
}

/** Note picker used when `preferModal` is enabled. */
class WikilinkNotePickerModal extends FuzzySuggestModal<TFile> {
    private files: TFile[];
    private onPick: (file: TFile) => void;
    private onCancelPick: () => void;
    private initialQuery: string;
    private picked = false;

    constructor(
        app: App,
        files: TFile[],
        query: string,
        onPick: (file: TFile) => void,
        onCancelPick: () => void,
    ) {
        super(app);
        this.files = files;
        this.onPick = onPick;
        this.onCancelPick = onCancelPick;
        this.initialQuery = query;
        this.setPlaceholder(t('Search notes…'));
        this.modalEl.addClass('nl-wikilink-suggest-modal');
    }

    onOpen(): void {
        void super.onOpen();
        // Floating cell editors used to sit at z-index 10000+ and covered Obsidian modals.
        const ownerDocument = this.containerEl.ownerDocument;
        ownerDocument.body.addClass('nl-wikilink-picker-open');
        const shell = this.containerEl.closest<HTMLElement>('.modal-container');
        shell?.addClass('nl-wikilink-suggest-shell');
        this.containerEl.addClass('nl-wikilink-suggest-container');
        if (!this.initialQuery) return;
        this.inputEl.value = this.initialQuery;
        this.inputEl.dispatchEvent(new Event('input'));
    }

    getItems(): TFile[] {
        return this.files;
    }

    getItemText(item: TFile): string {
        return item.path;
    }

    onChooseItem(item: TFile): void {
        this.picked = true;
        this.onPick(item);
    }

    onClose(): void {
        const ownerDocument = this.containerEl.ownerDocument;
        ownerDocument.body.removeClass('nl-wikilink-picker-open');
        if (!this.picked) this.onCancelPick();
    }
}

type WikilinkCandidate = {
    target: string;
    name: string;
    path: string;
};

type CaretRect = { left: number; top: number; bottom: number; height: number };

/** Measure a plain textarea caret with a hidden, style-matched mirror. */
function getTextareaCaretRect(textarea: HTMLTextAreaElement): CaretRect | null {
    const ownerDocument = textarea.ownerDocument;
    const ownerWindow = ownerDocument.defaultView || window;
    const rect = textarea.getBoundingClientRect();
    const style = ownerWindow.getComputedStyle(textarea);
    const mirror = ownerDocument.createElement('div');
    const copiedProperties = [
        'box-sizing', 'width', 'font-family', 'font-size', 'font-style', 'font-weight',
        'font-variant', 'font-stretch', 'line-height', 'letter-spacing', 'word-spacing',
        'text-align', 'text-indent', 'text-transform', 'tab-size', 'padding-top',
        'padding-right', 'padding-bottom', 'padding-left', 'border-top-width',
        'border-right-width', 'border-bottom-width', 'border-left-width',
    ];
    for (const property of copiedProperties) {
        mirror.style.setProperty(property, style.getPropertyValue(property));
    }
    mirror.setCssProps({
        position: 'fixed',
        left: `${rect.left}px`,
        top: `${rect.top}px`,
        width: `${rect.width}px`,
        height: `${rect.height}px`,
        whiteSpace: 'pre-wrap',
        overflow: 'auto',
        overflowWrap: 'break-word',
        wordBreak: 'break-word',
        visibility: 'hidden',
        pointerEvents: 'none',
        zIndex: '-1',
    });

    const caret = textarea.selectionStart ?? textarea.value.length;
    mirror.appendChild(ownerDocument.createTextNode(textarea.value.slice(0, caret)));
    const marker = ownerDocument.createElement('span');
    marker.textContent = textarea.value.slice(caret, caret + 1) || '\u200b';
    mirror.appendChild(marker);
    // Trailing text keeps wrap identical to the live textarea.
    mirror.appendChild(ownerDocument.createTextNode(textarea.value.slice(caret + 1) || ''));
    ownerDocument.body.appendChild(mirror);
    mirror.scrollTop = textarea.scrollTop;
    mirror.scrollLeft = textarea.scrollLeft;
    const markerRect = marker.getBoundingClientRect();
    mirror.remove();
    if (!Number.isFinite(markerRect.left) || !Number.isFinite(markerRect.top)) return null;
    const lineHeight = Number.parseFloat(style.lineHeight) || Number.parseFloat(style.fontSize) * 1.4 || 18;
    // markerRect is already viewport-relative — do not re-subtract scroll offsets.
    return {
        left: markerRect.left,
        top: markerRect.top,
        bottom: markerRect.top + lineHeight,
        height: lineHeight,
    };
}

function isMarkdownFile(file: unknown): file is TFile {
    if (file instanceof TFile) return file.extension === 'md';
    // Duck-type: avoids false negatives when `instanceof TFile` fails across bundles.
    const candidate = file as { extension?: unknown; basename?: unknown; path?: unknown };
    return candidate?.extension === 'md'
        && typeof candidate.basename === 'string'
        && typeof candidate.path === 'string';
}

export class WikilinkSuggest {
    private app: App;
    private textareaEl: HTMLTextAreaElement;
    private maxVisible: number;
    private sourcePath: string;
    private preferModal: boolean;
    private dropdown: HTMLDivElement | null = null;
    private items: { candidate: WikilinkCandidate; el: HTMLDivElement }[] = [];
    private activeIndex = -1;
    private alive = true;
    private triggerStart = -1; // caret index of the `[[`
    private hadTrigger = false;
    private forceOpenModal = false;
    private modalOpen = false;

    constructor(opts: WikilinkSuggestOptions) {
        this.app = opts.app;
        this.textareaEl = opts.textareaEl;
        this.maxVisible = opts.maxVisible ?? 8;
        this.sourcePath = opts.sourcePath || '';
        this.preferModal = !!opts.preferModal;

        this.textareaEl.addEventListener('input', this.handleInput);
        this.textareaEl.addEventListener('keydown', this.handleKeydown);
        this.textareaEl.addEventListener('blur', this.handleBlur);
        this.textareaEl.addEventListener('click', this.handleInput);
        this.textareaEl.addEventListener('keyup', this.handleInput);
        this.textareaEl.addEventListener('scroll', this.handlePositionChange);
        this.textareaEl.ownerDocument.defaultView?.addEventListener('resize', this.handlePositionChange);
    }

    /** Re-run trigger detection (e.g. after a toolbar inserted `[[`). */
    refresh(): void {
        if (this.preferModal) this.forceOpenModal = true;
        this.handleInput();
    }

    destroy(): void {
        this.alive = false;
        this.textareaEl.removeEventListener('input', this.handleInput);
        this.textareaEl.removeEventListener('keydown', this.handleKeydown);
        this.textareaEl.removeEventListener('blur', this.handleBlur);
        this.textareaEl.removeEventListener('click', this.handleInput);
        this.textareaEl.removeEventListener('keyup', this.handleInput);
        this.textareaEl.removeEventListener('scroll', this.handlePositionChange);
        this.textareaEl.ownerDocument.defaultView?.removeEventListener('resize', this.handlePositionChange);
        this.removeDropdown();
    }

    // ─── Trigger detection ────────────────────────────────────

    /**
     * Look back from the caret for the most recent `[[`. Return the
     * query (text after `[[`) or null when no active trigger exists,
     * e.g. when a `]]` has already closed the link.
     */
    private detectTrigger(): { start: number; query: string } | null {
        const value = this.textareaEl.value;
        const caret = this.textareaEl.selectionStart ?? value.length;
        const before = value.slice(0, caret);
        const open = before.lastIndexOf('[[');
        if (open === -1) return null;
        const between = before.slice(open + 2);
        // Cancel if user already started closing the link or jumped to a new line.
        if (between.includes(']]') || between.includes('\n')) return null;
        return { start: open + 2, query: between };
    }

    private handleInput = () => {
        if (!this.alive) return;
        try {
            const trigger = this.detectTrigger();
            if (!trigger) {
                this.hadTrigger = false;
                this.removeDropdown();
                return;
            }
            this.triggerStart = trigger.start;
            if (this.preferModal) {
                const justOpened = !this.hadTrigger;
                this.hadTrigger = true;
                if ((justOpened || this.forceOpenModal) && !this.modalOpen) {
                    this.forceOpenModal = false;
                    this.openNotePickerModal(trigger.query);
                }
                return;
            }
            this.renderDropdown(trigger.query);
        } catch (error) {
            console.warn('[NarrativeLab] Wikilink suggest failed:', error);
            this.removeDropdown();
        }
    };

    private openNotePickerModal(query: string): void {
        if (this.modalOpen) return;
        let files: TFile[] = [];
        try {
            files = (this.app.vault.getMarkdownFiles() || []).filter(isMarkdownFile);
        } catch (error) {
            console.warn('[NarrativeLab] Could not list markdown files for wikilink suggest:', error);
            return;
        }
        this.modalOpen = true;
        const modal = new WikilinkNotePickerModal(
            this.app,
            files,
            query,
            (file) => {
                this.modalOpen = false;
                try {
                    const target = this.app.metadataCache.fileToLinktext(file, this.sourcePath, true)
                        || file.basename;
                    this.commit(target);
                } catch {
                    this.commit(file.basename);
                }
                this.hadTrigger = false;
            },
            () => {
                this.modalOpen = false;
                // Keep hadTrigger true so canceling does not immediately re-open.
                window.setTimeout(() => this.textareaEl.focus(), 0);
            },
        );
        modal.open();
    }

    private handleKeydown = (e: KeyboardEvent) => {
        if (this.preferModal) {
            if (e.key === '[' || e.key === 'Process') {
                window.setTimeout(() => this.handleInput(), 0);
            }
            return;
        }
        if (!this.dropdown) {
            // `[` may arrive via keydown before input in some IME / shortcut paths.
            if (e.key === '[' || e.key === 'Process') {
                window.setTimeout(() => this.handleInput(), 0);
            }
            return;
        }
        if (e.key === 'ArrowDown') {
            e.preventDefault();
            this.moveSelection(1);
        } else if (e.key === 'ArrowUp') {
            e.preventDefault();
            this.moveSelection(-1);
        } else if (e.key === 'Enter' || e.key === 'Tab') {
            if (this.activeIndex >= 0 && this.activeIndex < this.items.length) {
                e.preventDefault();
                this.commit(this.items[this.activeIndex].candidate.target);
            }
        } else if (e.key === 'Escape') {
            e.preventDefault();
            this.removeDropdown();
        }
    };

    private handleBlur = () => {
        // Delay so a click on a dropdown item still registers.
        window.setTimeout(() => {
            if (!this.alive || !this.dropdown) return;
            const active = this.textareaEl.ownerDocument.activeElement;
            if (active && this.dropdown.contains(active)) return;
            if (active === this.textareaEl) return;
            this.removeDropdown();
        }, 150);
    };

    private handlePositionChange = () => {
        if (this.dropdown) this.positionDropdown();
    };

    // ─── Suggestions ──────────────────────────────────────────

    private getCandidates(query: string): WikilinkCandidate[] {
        let files: TFile[] = [];
        try {
            files = this.app.vault.getMarkdownFiles() || [];
        } catch (error) {
            console.warn('[NarrativeLab] Could not list markdown files for wikilink suggest:', error);
            return [];
        }
        const q = query.toLowerCase();
        const scored: { candidate: WikilinkCandidate; score: number }[] = [];
        for (const f of files) {
            if (!isMarkdownFile(f)) continue;
            try {
                const target = this.app.metadataCache.fileToLinktext(f, this.sourcePath, true)
                    || f.basename;
                const searchable = `${f.basename} ${f.path}`.toLowerCase();
                const score = Math.min(
                    this.fuzzyScore(q, f.basename.toLowerCase()),
                    this.fuzzyScore(q, searchable),
                );
                if (score >= 0) {
                    scored.push({
                        candidate: { target, name: f.basename, path: f.path },
                        score,
                    });
                }
            } catch {
                // Skip files that fail link-text resolution.
            }
        }
        scored.sort((a, b) => a.score - b.score
            || a.candidate.name.localeCompare(b.candidate.name)
            || a.candidate.path.localeCompare(b.candidate.path));
        // Link text is already disambiguated by Obsidian; deduplicate exact targets only.
        const seen = new Set<string>();
        const out: WikilinkCandidate[] = [];
        for (const s of scored) {
            if (seen.has(s.candidate.target)) continue;
            seen.add(s.candidate.target);
            out.push(s.candidate);
            if (out.length >= this.maxVisible) break;
        }
        return out;
    }

    private fuzzyScore(query: string, target: string): number {
        if (!query) return 0;
        let qi = 0;
        let score = 0;
        let last = -1;
        for (let ti = 0; ti < target.length && qi < query.length; ti++) {
            if (target[ti] === query[qi]) {
                score += ti === last + 1 ? 0 : (ti - (last + 1));
                last = ti;
                qi++;
            }
        }
        return qi === query.length ? score : -1;
    }

    private renderDropdown(query: string): void {
        const candidates = this.getCandidates(query);
        if (candidates.length === 0) {
            this.removeDropdown();
            return;
        }

        this.ensureDropdown();
        if (!this.dropdown) return;
        this.dropdown.empty();
        this.items = [];
        this.activeIndex = 0;

        for (let i = 0; i < candidates.length; i++) {
            const candidate = candidates[i];
            const item = this.dropdown.createDiv('sl-suggest-item');
            item.createDiv({ cls: 'sl-suggest-title', text: candidate.name });
            item.createDiv({ cls: 'sl-suggest-note', text: candidate.path });
            if (i === 0) {
                item.addClass('is-active');
                item.addClass('sl-suggest-active');
            }
            item.addEventListener('mousedown', (ev) => {
                // mousedown (not click) so we run before blur removes the dropdown.
                ev.preventDefault();
                this.commit(candidate.target);
            });
            this.items.push({ candidate, el: item });
        }

        this.positionDropdown();
    }

    /** Floating hosts that sit above Obsidian chrome. */
    private resolveStackingHost(): HTMLElement | null {
        return this.textareaEl.closest<HTMLElement>(
            '.plot-grid-cell-editor-window, .modal, .vertical-tab-content',
        );
    }

    private resolveDropdownZIndex(): number {
        const host = this.resolveStackingHost();
        let hostZ = 0;
        if (host) {
            const inline = Number.parseInt(host.style.zIndex || '', 10);
            const computed = Number.parseInt(
                (host.ownerDocument.defaultView || window).getComputedStyle(host).zIndex,
                10,
            );
            hostZ = Math.max(
                Number.isFinite(inline) ? inline : 0,
                Number.isFinite(computed) ? computed : 0,
            );
        }
        // Stay above floating cell editors (10000–29999) and Obsidian popovers.
        return Math.max(hostZ + 100, 2147483000);
    }

    private ensureDropdown(): void {
        if (this.dropdown) return;
        const ownerDocument = this.textareaEl.ownerDocument;
        const dd = ownerDocument.createElement('div');
        dd.className = 'sl-suggest-dropdown sl-wikilink-suggest';
        // Always mount on body — editor windows use overflow:hidden and would clip us.
        ownerDocument.body.appendChild(dd);
        this.dropdown = dd;
    }

    private removeDropdown(): void {
        if (!this.dropdown) return;
        this.dropdown.remove();
        this.dropdown = null;
        this.items = [];
        this.activeIndex = -1;
    }

    private moveSelection(delta: number): void {
        if (this.items.length === 0) return;
        this.activeIndex = (this.activeIndex + delta + this.items.length) % this.items.length;
        for (let i = 0; i < this.items.length; i++) {
            const active = i === this.activeIndex;
            this.items[i].el.toggleClass('is-active', active);
            this.items[i].el.toggleClass('sl-suggest-active', active);
        }
        this.items[this.activeIndex].el.scrollIntoView({ block: 'nearest' });
    }

    private positionDropdown(): void {
        if (!this.dropdown) return;
        const textareaRect = this.textareaEl.getBoundingClientRect();
        const ownerWindow = this.textareaEl.ownerDocument.defaultView || window;
        const host = this.resolveStackingHost();
        // Modals: keep the menu inside the dialog. Floating cell editors: use the
        // viewport — the window is overflow:hidden and clamping to it hides the menu.
        const useHostBoundary = !!host && host.classList.contains('modal');
        const hostRect = useHostBoundary ? host?.getBoundingClientRect() ?? null : null;
        const boundary = hostRect || {
            left: 0,
            top: 0,
            right: ownerWindow.innerWidth,
            bottom: ownerWindow.innerHeight,
        };
        const caret = getTextareaCaretRect(this.textareaEl) || {
            left: textareaRect.left + 12,
            top: textareaRect.top + 12,
            bottom: textareaRect.top + 30,
            height: 18,
        };
        const margin = 8;
        const availableWidth = Math.max(180, boundary.right - boundary.left - margin * 2);
        const width = Math.min(420, Math.max(260, Math.min(textareaRect.width || 360, 360)), availableWidth);
        const left = Math.max(
            boundary.left + margin,
            Math.min(caret.left, boundary.right - width - margin),
        );
        this.dropdown.setCssProps({
            position: 'fixed',
            left: `${Math.round(left)}px`,
            top: `${Math.round(caret.bottom + 4)}px`,
            width: `${Math.round(width)}px`,
            minWidth: '180px',
            maxWidth: `${Math.round(availableWidth)}px`,
            maxHeight: '240px',
            overflowY: 'auto',
            zIndex: String(this.resolveDropdownZIndex()),
            background: 'var(--background-primary)',
            border: '1px solid var(--background-modifier-border)',
            borderRadius: '6px',
            boxShadow: '0 4px 16px rgba(0,0,0,0.18)',
            padding: '4px 0',
            visibility: 'hidden',
        });

        const dropdownRect = this.dropdown.getBoundingClientRect();
        const spaceBelow = boundary.bottom - caret.bottom - margin;
        const spaceAbove = caret.top - boundary.top - margin;
        const openAbove = dropdownRect.height > spaceBelow && spaceAbove > spaceBelow;
        const top = openAbove
            ? Math.max(boundary.top + margin, caret.top - dropdownRect.height - 4)
            : Math.min(caret.bottom + 4, Math.max(boundary.top + margin, boundary.bottom - dropdownRect.height - margin));
        this.dropdown.setCssProps({
            top: `${Math.round(top)}px`,
            visibility: 'visible',
        });
    }

    // ─── Commit ───────────────────────────────────────────────

    private commit(name: string): void {
        if (this.triggerStart < 0) {
            this.removeDropdown();
            return;
        }
        const value = this.textareaEl.value;
        const caret = this.textareaEl.selectionStart ?? value.length;
        const before = value.slice(0, this.triggerStart);
        const after = value.slice(caret);
        // Insert "<name>]]" replacing the in-progress query.
        // If the toolbar already closed with `]]`, drop the duplicate closer.
        const inserted = after.startsWith(']]') ? name : `${name}]]`;
        const newValue = `${before}${inserted}${after.startsWith(']]') ? after.slice(2) : after}`;
        const newCaret = before.length + inserted.length;
        this.textareaEl.value = newValue;
        this.textareaEl.setSelectionRange(newCaret, newCaret);
        // Trigger input + change so listeners (e.g. autosave) react.
        this.textareaEl.dispatchEvent(new Event('input', { bubbles: true }));
        this.textareaEl.dispatchEvent(new Event('change', { bubbles: true }));
        this.removeDropdown();
        this.textareaEl.focus();
    }
}
