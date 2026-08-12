/* eslint-disable @typescript-eslint/no-unnecessary-type-assertion -- Obsidian's API surface and several untyped third-party libraries force dynamic dispatch; floating promises are intentional in DOM/event handlers; matching enable at end of file */
/**
 * Instant tooltip utility — attaches a zero-delay tooltip to any element.
 *
 * Uses a real DOM element appended to activeDocument.body, positioned via
 * getBoundingClientRect().  This avoids Obsidian's slow built-in tooltip
 * (~500 ms delay) and CSS ::after flicker issues.
 *
 * Usage:
 *   import { attachTooltip } from '../components/Tooltip';
 *   attachTooltip(myButton, t('Bold'));
 */

const TOOLTIP_CLASS = 'sl-instant-tooltip';

/**
 * Attach an instant tooltip to `el`.
 * The tooltip appears below the element on mouseenter and is removed on
 * mouseleave or click.  Any stale tooltips left behind by DOM re-renders
 * are cleaned up automatically.
 */
export function attachTooltip(el: HTMLElement, text: string | (() => string)): void {
    let tip: HTMLDivElement | null = null;
    const resolveText = (): string => typeof text === 'function' ? text() : text;
    if (!el.hasAttribute('aria-label')) el.setAttribute('aria-label', resolveText());
    // Our zero-delay tooltip replaces the browser title only after an
    // accessible name has been retained for keyboard and screen-reader users.
    el.removeAttribute('title');

    const remove = () => {
        if (tip) { tip.remove(); tip = null; }
    };

    el.addEventListener('mouseenter', () => {
        // Remove any stale tooltips (e.g. from toolbar re-renders)
        activeDocument.querySelectorAll(`.${TOOLTIP_CLASS}`).forEach(t => t.remove());

        // Skip when the same label is already visible inside the control
        // (avoids a floating "白板" sitting between toolbar rows).
        const visibleLabel = el.querySelector('.view-tab-label') as HTMLElement | null;
        if (visibleLabel && visibleLabel.offsetParent !== null) {
            const style = getComputedStyle(visibleLabel);
            if (style.display !== 'none' && style.visibility !== 'hidden') return;
        }

        tip = activeDocument.createElement('div');
        tip.className = TOOLTIP_CLASS;
        tip.textContent = resolveText();
        activeDocument.body.appendChild(tip);

        const rect = el.getBoundingClientRect();
        // Prefer above for top toolbars so the tip doesn't look like a misaligned label.
        const inToolbar = !!el.closest('.story-line-toolbar, .annotation-ea-toolbar');
        const showAbove = inToolbar || rect.bottom + 28 > window.innerHeight;
        tip.classList.toggle('is-above', showAbove);
        tip.setCssStyles({
            left: `${rect.left + rect.width / 2}px`,
            top: showAbove ? `${rect.top - 4}px` : `${rect.bottom + 4}px`,
        });
    });

    el.addEventListener('mouseleave', remove);
    el.addEventListener('click', remove);
}
/* eslint-enable @typescript-eslint/no-unnecessary-type-assertion -- end of file-wide suppression block opened at line 1 */
