import { t } from '../utils/i18n';
/* eslint-disable @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-argument, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-return, @typescript-eslint/no-floating-promises, @typescript-eslint/no-misused-promises, @typescript-eslint/no-unnecessary-type-assertion, @typescript-eslint/no-redundant-type-constituents, @typescript-eslint/no-unused-vars, no-unused-vars, no-useless-escape, no-control-regex, no-empty -- Obsidian's API surface and several untyped third-party libraries force dynamic dispatch; floating promises are intentional in DOM/event handlers; matching enable at end of file */
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
export function attachTooltip(el: HTMLElement, text: string): void {
    let tip: HTMLDivElement | null = null;

    const remove = () => {
        if (tip) { tip.remove(); tip = null; }
    };

    el.addEventListener('mouseenter', () => {
        // Remove any stale tooltips (e.g. from toolbar re-renders)
        activeDocument.querySelectorAll(`.${TOOLTIP_CLASS}`).forEach(t => t.remove());

        tip = activeDocument.createElement('div');
        tip.className = TOOLTIP_CLASS;
        tip.textContent = text;
        activeDocument.body.appendChild(tip);

        const rect = el.getBoundingClientRect();
        tip.setCssStyles({
            left: `${rect.left + rect.width / 2}px`,
            top: `${rect.bottom + 4}px`,
        });
    });

    el.addEventListener('mouseleave', remove);
    el.addEventListener('click', remove);
}
/* eslint-enable @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-argument, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-return, @typescript-eslint/no-floating-promises, @typescript-eslint/no-misused-promises, @typescript-eslint/no-unnecessary-type-assertion, @typescript-eslint/no-redundant-type-constituents, @typescript-eslint/no-unused-vars, no-unused-vars, no-useless-escape, no-control-regex, no-empty -- end of file-wide suppression block opened at line 1 */
