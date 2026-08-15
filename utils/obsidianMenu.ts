import { Menu } from 'obsidian';

export type MenuAnchor = MouseEvent | { x: number; y: number };

const TRAILING_CONTEXTMENU_MS = 80;

/**
 * True when `anchor` is a right-button press/release. Those events are followed
 * by `contextmenu`, and an Obsidian Menu shown too early is dismissed by it.
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

/**
 * Show an Obsidian Menu after the current pointer event (and any trailing
 * right-click `contextmenu`) has finished, so the menu is not immediately hidden.
 */
export function showMenuSafely(menu: Menu, anchor: MenuAnchor): void {
    const pos = isMouseEvent(anchor)
        ? { x: anchor.clientX, y: anchor.clientY }
        : { x: anchor.x, y: anchor.y };
    if (isMouseEvent(anchor)) {
        try {
            anchor.preventDefault();
            anchor.stopPropagation();
        } catch {
            /* event may already be uncancelable */
        }
    }
    const show = () => menu.showAtPosition(pos);
    if (menuShowShouldGateOnTrailingContextMenu(anchor)) {
        waitForTrailingContextMenu(show);
        return;
    }
    window.setTimeout(show, 0);
}

function isMouseEvent(anchor: MenuAnchor): anchor is MouseEvent {
    return typeof MouseEvent !== 'undefined' && anchor instanceof MouseEvent;
}

function waitForTrailingContextMenu(show: () => void): void {
    let done = false;
    const finish = () => {
        if (done) return;
        done = true;
        window.removeEventListener('contextmenu', onContextMenu, true);
        window.setTimeout(show, 0);
    };
    const onContextMenu = (event: Event) => {
        event.preventDefault();
        event.stopPropagation();
        if ('stopImmediatePropagation' in event) {
            event.stopImmediatePropagation();
        }
        finish();
    };
    window.addEventListener('contextmenu', onContextMenu, true);
    window.setTimeout(finish, TRAILING_CONTEXTMENU_MS);
}
