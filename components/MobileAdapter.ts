/* eslint-disable @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-argument, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-return, @typescript-eslint/no-floating-promises, @typescript-eslint/no-misused-promises, @typescript-eslint/no-unnecessary-type-assertion, @typescript-eslint/no-redundant-type-constituents, @typescript-eslint/no-unused-vars, no-unused-vars, no-useless-escape, no-control-regex, no-empty -- Obsidian's API surface and several untyped third-party libraries force dynamic dispatch; floating promises are intentional in DOM/event handlers; matching enable at end of file */
/**
 * Mobile support adapter for NarrativeLab.
 *
 * Centralises all platform detection and mobile-specific helpers.
 * Desktop code paths never execute mobile logic — the guards
 * early-return so existing desktop rendering is untouched.
 */
import { Platform } from 'obsidian';

// ── Platform detection ────────────────────────────────

/** True on iOS, iPadOS, or Android (Obsidian mobile app) */
export const isMobile: boolean = Platform.isMobile;

/** True on tablet-sized screens (iPad, Android tablets) */
export const isTablet: boolean = ((Platform as unknown as Record<string, unknown>).isTablet as boolean | undefined) ?? false;

/** True on phone-sized screens */
export const isPhone: boolean = isMobile && !isTablet;

// ── Desktop-only views ────────────────────────────────

import {
    PLOTGRID_VIEW_TYPE,
} from '../constants';

/**
 * View types that should be hidden on mobile devices.
 * These use dense grids, complex SVG, or precision mouse
 * interactions that don't translate to touch screens.
 */
export const DESKTOP_ONLY_VIEWS: Set<string> = new Set([
    PLOTGRID_VIEW_TYPE,
]);

// ── Helpers ───────────────────────────────────────────

/**
 * Add the `sl-mobile` class to an element when running on mobile.
 * Use this on root containers so CSS can scope mobile-only styles.
 */
export function applyMobileClass(el: HTMLElement): void {
    if (isMobile) {
        el.addClass('sl-mobile');
        if (isPhone) el.addClass('sl-phone');
        if (isTablet) el.addClass('sl-tablet');
    }
}

/**
 * Attach touch-based drag-and-drop to a card element on mobile.
 *
 * On mobile, HTML5 DnD doesn't work. This provides a long-press
 * initiated touch-move reorder that mirrors the desktop drag.
 *
 * @param card      The draggable card element
 * @param filePath  The scene's file path (the drag data)
 * @param onDrop    Callback when the card is dropped onto a target
 */
export function enableTouchDrag(
    card: HTMLElement,
    _filePath: string,
    onDrop: (targetEl: HTMLElement, insertBefore: boolean) => void,
): (() => void) | null {
    if (!isMobile) return null;

    let longPressTimer: number | null = null;
    let isDragging = false;
    let ghost: HTMLElement | null = null;
    let startX = 0;
    let startY = 0;
    /** Suppress the synthetic click that fires after touchend */
    let suppressClick = false;

    const LONG_PRESS_MS = 300;
    const MOVE_THRESHOLD = 20;

    /** Find all scrollable ancestors up to the document */
    function getScrollParents(el: HTMLElement): HTMLElement[] {
        const parents: HTMLElement[] = [];
        let parent = el.parentElement;
        while (parent) {
            const style = getComputedStyle(parent);
            if (/(auto|scroll)/.test(style.overflowY || '') ||
                /(auto|scroll)/.test(style.overflow || '')) {
                parents.push(parent);
            }
            parent = parent.parentElement;
        }
        return parents;
    }

    let scrollParents: HTMLElement[] = [];

    function cleanup() {
        isDragging = false;
        if (ghost) {
            ghost.remove();
            ghost = null;
        }
        if (longPressTimer) {
            window.clearTimeout(longPressTimer);
            longPressTimer = null;
        }
        card.removeClass('touch-dragging');
        card.style.removeProperty('touch-action');
        // Re-enable scrolling on all locked ancestors
        for (const sp of scrollParents) {
            sp.style.removeProperty('overflow-y');
            sp.style.removeProperty('touch-action');
        }
        scrollParents = [];
        // Remove all drop indicators
        activeDocument.querySelectorAll('.drop-above, .drop-below, .drag-over').forEach(el => {
            el.removeClass('drop-above', 'drop-below', 'drag-over');
        });
    }

    function onTouchStart(e: TouchEvent) {
        if (e.touches.length > 1) return; // Ignore multi-touch
        const touch = e.touches[0];
        startX = touch.clientX;
        startY = touch.clientY;

        longPressTimer = window.setTimeout(() => {
            isDragging = true;
            suppressClick = true;
            card.addClass('touch-dragging');

            // Disable scrolling on the card and all scroll ancestors
            card.setCssStyles({ touchAction: 'none' });
            scrollParents = getScrollParents(card);
            for (const sp of scrollParents) {
                sp.setCssStyles({
                    overflowY: 'hidden',
                    touchAction: 'none',
                });
            }

            // Create ghost element
            ghost = card.cloneNode(true) as HTMLElement;
            ghost.addClass('sl-touch-ghost');
            ghost.setCssStyles({
                position: 'fixed',
                zIndex: '10000',
                pointerEvents: 'none',
                opacity: '0.85',
                width: card.offsetWidth + 'px',
                transform: 'scale(1.05)',
                left: (startX - card.offsetWidth / 2) + 'px',
                top: (startY - 20) + 'px',
            });
            activeDocument.body.appendChild(ghost);

            // Haptic feedback on supported devices
            if (navigator.vibrate) navigator.vibrate(50);
        }, LONG_PRESS_MS);
    }

    function onTouchMove(e: TouchEvent) {
        const touch = e.touches[0];

        // If we haven't started dragging yet, cancel if moved too far
        if (!isDragging) {
            const dx = touch.clientX - startX;
            const dy = touch.clientY - startY;
            if (Math.abs(dx) > MOVE_THRESHOLD || Math.abs(dy) > MOVE_THRESHOLD) {
                if (longPressTimer) {
                    window.clearTimeout(longPressTimer);
                    longPressTimer = null;
                }
            }
            return;
        }

        // Prevent scrolling while dragging
        e.preventDefault();
        e.stopPropagation();

        // Move ghost
        if (ghost) {
            ghost.setCssStyles({
                left: (touch.clientX - card.offsetWidth / 2) + 'px',
                top: (touch.clientY - 20) + 'px',
            });
        }

        // Find the card under the touch point
        if (ghost) ghost.setCssStyles({ display: 'none' });
        const target = activeDocument.elementFromPoint(touch.clientX, touch.clientY);
        if (ghost) ghost.setCssStyles({ display: '' });

        // Clear previous indicators
        activeDocument.querySelectorAll('.drop-above, .drop-below').forEach(el => {
            el.removeClass('drop-above', 'drop-below');
        });

        // Highlight drop target
        const targetCard = target?.closest('.scene-card') as HTMLElement | null;
        if (targetCard && targetCard !== card) {
            const rect = targetCard.getBoundingClientRect();
            const midY = rect.top + rect.height / 2;
            if (touch.clientY < midY) {
                targetCard.addClass('drop-above');
            } else {
                targetCard.addClass('drop-below');
            }
        }
    }

    function onTouchEnd(e: TouchEvent) {
        if (!isDragging) {
            cleanup();
            return;
        }

        const touch = e.changedTouches[0];

        // Find drop target
        if (ghost) ghost.setCssStyles({ display: 'none' });
        const target = activeDocument.elementFromPoint(touch.clientX, touch.clientY);
        if (ghost) ghost.setCssStyles({ display: '' });

        const targetCard = target?.closest('.scene-card') as HTMLElement | null;
        if (targetCard && targetCard !== card) {
            const rect = targetCard.getBoundingClientRect();
            const midY = rect.top + rect.height / 2;
            const insertBefore = touch.clientY < midY;
            onDrop(targetCard, insertBefore);
        }

        cleanup();

        // Suppress the synthetic click event that the browser fires after touchend
        // Use a short timeout so the flag resets even if click never fires
        window.setTimeout(() => { suppressClick = false; }, 400);
    }

    function onClickCapture(e: MouseEvent) {
        if (suppressClick) {
            e.stopPropagation();
            e.preventDefault();
            suppressClick = false;
        }
    }

    card.addEventListener('touchstart', onTouchStart, { passive: true });
    card.addEventListener('touchmove', onTouchMove, { passive: false });
    card.addEventListener('touchend', onTouchEnd, { passive: true });
    card.addEventListener('touchcancel', () => { cleanup(); suppressClick = false; }, { passive: true });
    // Capture-phase click handler to suppress click after drag
    card.addEventListener('click', onClickCapture, { capture: true });

    // Return cleanup function
    return () => {
        cleanup();
        card.removeEventListener('touchstart', onTouchStart);
        card.removeEventListener('touchmove', onTouchMove);
        card.removeEventListener('touchend', onTouchEnd);
        card.removeEventListener('touchcancel', cleanup);
        card.removeEventListener('click', onClickCapture, { capture: true });
    };
}
// ── Soft-keyboard / viewport handling ─────────────────

/**
 * NarrativeLab UI containers whose scroll context should be panned when the
 * soft keyboard appears. The focused field is scrolled into the visible
 * (above-keyboard) region.
 */
const STORYLINE_UI_SELECTOR = '[class*="story-line-"], [class*="storyline-"], [class*="sl-"]';
const FOCUSABLE_SELECTOR = 'input, textarea, select, [contenteditable="true"], [contenteditable=""]';

/**
 * Install global listeners that keep the focused NarrativeLab field visible
 * above the mobile soft keyboard.
 *
 * On mobile, when a textarea/input inside the Codex, Inspector, Corkboard
 * note editor, or any other NarrativeLab panel gains focus, the soft keyboard
 * can cover it. Obsidian's webview does not always scroll the focused
 * element into view reliably. We use the Visual Viewport API to compute
 * the visible (keyboard-free) region and scroll the nearest scrollable
 * ancestor so the field lands in the upper portion of the visible area.
 *
 * Returns a cleanup function that removes the listeners.
 */
export function setupMobileKeyboardHandling(): () => void {
    if (!isMobile) return () => {};

    let rafId: number | null = null;

    const isStoryLineField = (el: Element | null): boolean => {
        if (!el) return false;
        return !!el.closest(STORYLINE_UI_SELECTOR);
    };

    const revealFocusedField = (target: EventTarget | null): void => {
        if (rafId !== null) window.cancelAnimationFrame(rafId);
        rafId = window.requestAnimationFrame(() => {
            rafId = null;
            const el = target as HTMLElement | null;
            if (!el || !isStoryLineField(el)) return;

            // Compute the visible top region (above the keyboard).
            // visualViewport.height shrinks when the keyboard is shown.
            const vv = window.visualViewport;
            if (!vv) {
                el.scrollIntoView({ block: 'center', behavior: 'smooth' });
                return;
            }

            const visibleTop = vv.offsetTop;
            const visibleHeight = vv.height;
            // Compute the actual keyboard height by comparing the visual
            // viewport to the layout viewport. This avoids the old fixed
            // 45% heuristic which over-scrolled when the keyboard was small
            // or absent (issue #190: content peeking above sticky toolbars).
            const layoutHeight = window.innerHeight;
            const keyboardHeight = Math.max(0, layoutHeight - visibleHeight - visibleTop);
            // Reserve the keyboard region plus a small margin. If no
            // keyboard is visible, this collapses to the full viewport.
            const safeBottom = visibleTop + visibleHeight - 16;

            const rect = el.getBoundingClientRect();
            // Already within the safe region — nothing to do.
            if (rect.top >= visibleTop + 8 && rect.bottom <= safeBottom) return;

            // Find the nearest scrollable ancestor and scroll it so the
            // field lands ~24px below the visible top.
            let parent: HTMLElement | null = el.parentElement;
            while (parent) {
                const style = getComputedStyle(parent);
                const overflowY = style.overflowY;
                const canScroll = (overflowY === 'auto' || overflowY === 'scroll' ||
                    (style.overflow === 'auto' || style.overflow === 'scroll'));
                if (canScroll && parent.scrollHeight > parent.clientHeight) {
                    const parentRect = parent.getBoundingClientRect();
                    const desiredTop = Math.max(parentRect.top + 24, visibleTop + 24);
                    const delta = rect.top - desiredTop;
                    if (delta > 0 || rect.bottom > safeBottom) {
                        parent.scrollTop += delta > 0 ? delta : (rect.bottom - safeBottom + 24);
                    }
                    break;
                }
                parent = parent.parentElement;
            }

            // NOTE: the previous fallback `el.scrollIntoView({ block: 'nearest' })`
            // was removed because it fought the manual ancestor-scroll logic
            // and could push content above sticky toolbars on mobile
            // (issue #190: toolbar not aligned to top, content peeking above
            // it when scrolling). The ancestor-scroll above is sufficient;
            // if no scrollable ancestor was found, the field is already in
            // a non-scrolling context and the browser will handle it.
            void keyboardHeight;
        });
    };

    const onFocusIn = (e: FocusEvent): void => {
        const target = e.target as HTMLElement | null;
        if (!target || !target.matches(FOCUSABLE_SELECTOR)) return;
        if (!isStoryLineField(target)) return;
        revealFocusedField(target);
    };

    // When the visual viewport resizes (keyboard shown/hidden), re-check
    // the currently focused element. Debounced because `resize` fires
    // continuously while the keyboard animates in/out — each fire used to
    // re-scroll and fight the user's own scroll position (issue #190/#211).
    let resizeTimer: number | null = null;
    const onViewportResize = (): void => {
        if (resizeTimer !== null) window.clearTimeout(resizeTimer);
        resizeTimer = window.setTimeout(() => {
            resizeTimer = null;
            const active = activeDocument.activeElement as HTMLElement | null;
            if (active && active.matches(FOCUSABLE_SELECTOR) && isStoryLineField(active)) {
                revealFocusedField(active);
            }
        }, 120);
    };

    const opts: AddEventListenerOptions = { capture: true, passive: true };
    activeDocument.addEventListener('focusin', onFocusIn, opts);
    window.visualViewport?.addEventListener('resize', onViewportResize, opts);
    window.visualViewport?.addEventListener('scroll', onViewportResize, opts);

    return () => {
        if (rafId !== null) window.cancelAnimationFrame(rafId);
        if (resizeTimer !== null) window.clearTimeout(resizeTimer);
        activeDocument.removeEventListener('focusin', onFocusIn, opts);
        window.visualViewport?.removeEventListener('resize', onViewportResize, opts);
        window.visualViewport?.removeEventListener('scroll', onViewportResize, opts);
    };
}/* eslint-enable @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-argument, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-return, @typescript-eslint/no-floating-promises, @typescript-eslint/no-misused-promises, @typescript-eslint/no-unnecessary-type-assertion, @typescript-eslint/no-redundant-type-constituents, @typescript-eslint/no-unused-vars, no-unused-vars, no-useless-escape, no-control-regex, no-empty -- end of file-wide suppression block opened at line 1 */
