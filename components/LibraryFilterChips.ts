
import { attachTooltip } from './Tooltip';
import { t } from '../utils/i18n';

/**
 * Shared filter-chip bar for Library browse (Characters / Locations / Codex).
 * Selected keys are lowercased labels; OR semantics when filtering.
 */
export function renderLibraryFilterChips(
    host: HTMLElement,
    tagLabels: Map<string, string>,
    active: Set<string>,
    onChange: () => void,
    opts?: { emptyHint?: string },
): void {
    host.empty();
    host.addClass('story-line-filter-chips');
    host.addClass('character-tag-filter-chips');
    host.addClass('library-filter-chips');

    // Drop stale selections
    for (const key of [...active]) {
        if (!tagLabels.has(key)) active.delete(key);
    }

    if (tagLabels.size === 0) {
        if (opts?.emptyHint) {
            host.createSpan({ cls: 'library-filter-empty-hint', text: opts.emptyHint });
            host.show();
        } else {
            host.hide();
        }
        return;
    }

    host.show();
    const sorted = [...tagLabels.entries()].sort((a, b) =>
        a[1].localeCompare(b[1], undefined, { sensitivity: 'base' }));
    for (const [key, label] of sorted) {
        const chip = host.createEl('button', {
            cls: `story-line-chip${active.has(key) ? ' active' : ''}`,
            text: label,
            attr: { type: 'button' },
        });
        chip.addEventListener('click', (e) => {
            e.preventDefault();
            e.stopPropagation();
            if (active.has(key)) active.delete(key);
            else active.add(key);
            onChange();
        });
    }
    if (active.size > 0) {
        const clearBtn = host.createEl('button', {
            cls: 'story-line-chip story-line-chip-clear',
            text: t('Clear'),
            attr: { type: 'button' },
        });
        attachTooltip(clearBtn, t('Clear tag filters'));
        clearBtn.addEventListener('click', (e) => {
            e.preventDefault();
            e.stopPropagation();
            active.clear();
            onChange();
        });
    }
}

/** Split comma-separated type/tag strings into lowercase→display map entries. */
export function collectDelimitedTags(
    into: Map<string, string>,
    raw: string | undefined | null,
): void {
    if (!raw) return;
    for (const part of String(raw).split(',').map(s => s.trim()).filter(Boolean)) {
        const key = part.toLowerCase();
        if (!into.has(key)) into.set(key, part);
    }
}

/** Pull #hashtags from free-text fields (same spirit as character props). */
export function collectHashtagsFromText(
    into: Map<string, string>,
    text: string | undefined | null,
): void {
    if (!text) return;
    const re = /#([A-Za-z\u00C0-\u024F\u0400-\u04FF\u4E00-\u9FFF][\w\u00C0-\u024F\u0400-\u04FF\u4E00-\u9FFF-]*)/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(String(text))) !== null) {
        const label = m[1];
        const key = label.toLowerCase();
        if (!into.has(key)) into.set(key, label);
    }
}
