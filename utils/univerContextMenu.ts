/**
 * Univer sheet context-menu flyouts portal to document.body and open on
 * `mouseenter`. The hover path from a parent row to that portal is easy to
 * miss, so these helpers keep the flyout hittable without touching retired
 * leftovers the host already hid.
 */

const UNIVER_POPUP_SELECTOR = '.univer-popup';
const UNIVER_SUBMENU_SELECTOR = '[data-u-context-menu-submenu]';
const RETIRED_SUBMENU_CLASS = 'narrativelab-univer-submenu-retired';

export function isUniverContextMenuTarget(target: EventTarget | null): boolean {
    if (!target || typeof target !== 'object') return false;
    const el = target as { closest?: (selector: string) => Element | null };
    if (typeof el.closest !== 'function') return false;
    return Boolean(
        el.closest(UNIVER_POPUP_SELECTOR)
        || el.closest(UNIVER_SUBMENU_SELECTOR),
    );
}

function isHtmlElement(node: EventTarget | null): node is HTMLElement {
    if (!node || typeof node !== 'object') return false;
    const candidate = node as Node & { instanceOf?: (type: typeof HTMLElement) => boolean };
    if (typeof candidate.instanceOf === 'function') return candidate.instanceOf(HTMLElement);
    return typeof HTMLElement !== 'undefined' && node instanceof HTMLElement;
}

export function pointInRect(
    x: number,
    y: number,
    rect: { left: number; top: number; right: number; bottom: number },
    pad = 0,
): boolean {
    return x >= rect.left - pad
        && x <= rect.right + pad
        && y >= rect.top - pad
        && y <= rect.bottom + pad;
}

/**
 * The strip between a parent row and its flyout, including a little slack so
 * a diagonal move does not drop `mouseenter` on the portal.
 */
export function pointInMenuCorridor(
    x: number,
    y: number,
    parent: { left: number; top: number; right: number; bottom: number },
    submenu: { left: number; top: number; right: number; bottom: number },
): boolean {
    if (pointInRect(x, y, parent, 2) || pointInRect(x, y, submenu, 4)) return true;
    const submenuOnLeft = submenu.right < parent.left + 8;
    const gapLeft = submenuOnLeft ? submenu.right : parent.right;
    const gapRight = submenuOnLeft ? parent.left : submenu.left;
    const top = Math.min(parent.top, submenu.top) - 6;
    const bottom = Math.max(parent.bottom, submenu.bottom) + 6;
    const left = Math.min(gapLeft, gapRight) - 4;
    const right = Math.max(gapLeft, gapRight) + 4;
    return x >= left && x <= right && y >= top && y <= bottom;
}

function revealUniverSubmenu(el: HTMLElement): boolean {
    if (el.style.visibility === 'visible' && el.style.pointerEvents !== 'none') return true;
    const left = Number.parseFloat(el.style.left || '0');
    const top = Number.parseFloat(el.style.top || '0');
    if (el.style.visibility === 'hidden' && left === 0 && top === 0) return false;
    const rect = el.getBoundingClientRect();
    if (rect.width < 2 || rect.height < 2) return false;
    el.style.pointerEvents = 'auto';
    el.style.visibility = 'visible';
    return true;
}

function dispatchEnter(el: EventTarget): void {
    el.dispatchEvent(new MouseEvent('mouseenter', {
        bubbles: false,
        cancelable: true,
        view: isHtmlElement(el) ? el.ownerDocument.defaultView : null,
    }));
}

function innermostItemAt(items: Element[], x: number, y: number): Element | null {
    let match: Element | null = null;
    for (const item of items) {
        if (pointInRect(x, y, item.getBoundingClientRect())) match = item;
    }
    return match;
}

/**
 * While a Univer context menu is open, hold flyouts from pointer geometry so
 * the sheet canvas cannot steal the hover path. No-ops when no popup exists.
 */
export function installUniverContextMenuHoverAssist(doc: Document): () => void {
    let activeItem: Element | null = null;

    const onPointerMove = (event: PointerEvent) => {
        const popup = doc.querySelector(UNIVER_POPUP_SELECTOR);
        if (!popup) {
            activeItem = null;
            return;
        }

        const x = event.clientX;
        const y = event.clientY;
        const target = event.target instanceof Node ? event.target : null;
        const overItem = innermostItemAt(
            Array.from(popup.querySelectorAll(':scope .univer-relative')),
            x,
            y,
        );

        if (overItem && overItem !== activeItem) {
            // Native hover already reached this row — do not re-fire mouseenter
            // (Univer resets pointer-events:none on every parent enter).
            if (!target || !overItem.contains(target)) dispatchEnter(overItem);
            activeItem = overItem;
        } else if (overItem) {
            activeItem = overItem;
        }

        for (const node of Array.from(doc.querySelectorAll(UNIVER_SUBMENU_SELECTOR))) {
            if (!isHtmlElement(node) || node.classList.contains(RETIRED_SUBMENU_CLASS)) continue;
            revealUniverSubmenu(node);
            const submenuRect = node.getBoundingClientRect();
            const parentRect = activeItem?.getBoundingClientRect();
            const overSubmenu = pointInRect(x, y, submenuRect, 4);
            const inCorridor = parentRect
                ? pointInMenuCorridor(x, y, parentRect, submenuRect)
                : false;
            if ((overSubmenu || inCorridor) && (!target || !node.contains(target))) {
                dispatchEnter(node);
            }
        }
    };

    doc.addEventListener('pointermove', onPointerMove, true);
    return () => {
        doc.removeEventListener('pointermove', onPointerMove, true);
        activeItem = null;
    };
}
