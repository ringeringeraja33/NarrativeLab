import { Menu } from 'obsidian';

export type MenuAnchor = MouseEvent | { x: number; y: number };

const TRAILING_CONTEXTMENU_MS = 80;
/** Keep eating right-button leftovers after the menu is on screen. */
const POST_SHOW_SHIELD_MS = 160;

/**
 * True when `anchor` is a right-button press/release. Those events are followed
 * by `contextmenu` (and often `auxclick`), and an Obsidian Menu shown too early
 * is dismissed by them.
 */
export function menuShowShouldGateOnTrailingContextMenu(anchor: MenuAnchor): boolean {
    const type = 'type' in anchor ? String(anchor.type || '') : '';
    const button = 'button' in anchor && typeof (anchor as { button?: unknown }).button === 'number'
        ? (anchor as { button: number }).button
        : -1;
    if (button !== 2) return false;
    return type === 'mouseup'
        || type === 'pointerup'
        || type === 'mousedown'
        || type === 'pointerdown';
}

export function menuShowShouldShieldTrailingPointerEvents(anchor: MenuAnchor): boolean {
    if (menuShowShouldGateOnTrailingContextMenu(anchor)) return true;
    const type = 'type' in anchor ? String(anchor.type || '') : '';
    const button = 'button' in anchor && typeof (anchor as { button?: unknown }).button === 'number'
        ? (anchor as { button: number }).button
        : -1;
    return type === 'contextmenu' || button === 2;
}

/**
 * Show an Obsidian Menu after the current pointer event (and any trailing
 * right-click `contextmenu` / `auxclick`) has finished, so the menu is not
 * immediately hidden.
 */
export function showMenuSafely(menu: Menu, anchor: MenuAnchor): void {
    const pos = isMouseEventLike(anchor)
        ? { x: anchor.clientX, y: anchor.clientY }
        : { x: anchor.x, y: anchor.y };
    const win = resolveEventWindow(anchor);
    if (isMouseEventLike(anchor)) {
        try {
            anchor.preventDefault();
            anchor.stopPropagation();
        } catch {
            /* event may already be uncancelable */
        }
    }
    const show = () => menu.showAtPosition(pos);
    if (menuShowShouldGateOnTrailingContextMenu(anchor)) {
        waitForTrailingContextMenu(win, show);
        return;
    }
    if (menuShowShouldShieldTrailingPointerEvents(anchor)) {
        showWithRightClickShield(win, show);
        return;
    }
    win.setTimeout(show, 0);
}

function isMouseEventLike(anchor: MenuAnchor): anchor is MouseEvent {
    return typeof anchor === 'object'
        && anchor !== null
        && 'clientX' in anchor
        && 'clientY' in anchor
        && typeof anchor.clientX === 'number'
        && typeof anchor.clientY === 'number';
}

function resolveEventWindow(anchor: MenuAnchor): Window {
    if (isMouseEventLike(anchor)) {
        if (anchor.view) return anchor.view;
        const target = anchor.target;
        if (target && typeof target === 'object' && 'ownerDocument' in target) {
            const owner = (target as Node).ownerDocument?.defaultView;
            if (owner) return owner;
        }
    }
    return window;
}

function swallowRightButtonTail(event: Event): void {
    const button = (event as MouseEvent).button;
    if (event.type !== 'contextmenu' && event.type !== 'auxclick' && button !== 2) return;
    event.preventDefault();
    event.stopPropagation();
    if ('stopImmediatePropagation' in event) {
        event.stopImmediatePropagation();
    }
}

function addRightClickShield(win: Window): () => void {
    const types = ['contextmenu', 'auxclick', 'click', 'mouseup', 'pointerup'] as const;
    for (const type of types) {
        win.addEventListener(type, swallowRightButtonTail, true);
        win.document.addEventListener(type, swallowRightButtonTail, true);
    }
    return () => {
        for (const type of types) {
            win.removeEventListener(type, swallowRightButtonTail, true);
            win.document.removeEventListener(type, swallowRightButtonTail, true);
        }
    };
}

/**
 * Show on the next frames, while capturing right-button leftovers so Obsidian
 * Menu's outside-click handler cannot treat them as "click outside".
 */
function showWithRightClickShield(win: Window, show: () => void): void {
    const remove = addRightClickShield(win);
    const run = () => {
        try {
            show();
        } finally {
            win.setTimeout(remove, POST_SHOW_SHIELD_MS);
        }
    };
    win.requestAnimationFrame(() => {
        win.requestAnimationFrame(run);
    });
}

function waitForTrailingContextMenu(win: Window, show: () => void): void {
    let done = false;
    const finish = () => {
        if (done) return;
        done = true;
        win.removeEventListener('contextmenu', onContextMenu, true);
        showWithRightClickShield(win, show);
    };
    const onContextMenu = (event: Event) => {
        swallowRightButtonTail(event);
        finish();
    };
    win.addEventListener('contextmenu', onContextMenu, true);
    win.setTimeout(finish, TRAILING_CONTEXTMENU_MS);
}
