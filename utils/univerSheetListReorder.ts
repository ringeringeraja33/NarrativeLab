/**
 * Univer's sheet-list dropdown (SheetBarMenu) is click-to-activate only.
 * Inject a grip on each item so worksheets can be reordered from that list.
 * Bottom tab dragging is left to Univer.
 */

import { t } from './i18n';

export type SheetListEntry = {
    id: string;
    title: string;
};

const MENU_SELECTOR = '[data-slot="dropdown-menu-content"]';
const ITEM_SELECTOR = '[data-slot="dropdown-menu-item"]';
const HANDLE_CLASS = 'narrativelab-sheet-list-handle';
const DROP_BEFORE_CLASS = 'narrativelab-sheet-list-drop-before';
const DROP_AFTER_CLASS = 'narrativelab-sheet-list-drop-after';
const DRAGGING_CLASS = 'narrativelab-sheet-list-dragging';
const CONTEXT_SUBMENU_SELECTOR = '[data-u-context-menu-submenu]';

function isHtmlElement(node: EventTarget | null): node is HTMLElement {
    if (!node || typeof node !== 'object') return false;
    const candidate = node as Node & { instanceOf?: (type: typeof HTMLElement) => boolean };
    if (typeof candidate.instanceOf === 'function') return candidate.instanceOf(HTMLElement);
    return typeof HTMLElement !== 'undefined' && node instanceof HTMLElement;
}

/**
 * Univer splice-removes the sheet first, then inserts at `order`.
 * `insertBefore` is the slot in the current list (0..length).
 */
export function sheetListReorderTargetIndex(fromIndex: number, insertBefore: number): number {
    if (fromIndex < 0 || insertBefore < 0) return fromIndex;
    if (insertBefore === fromIndex || insertBefore === fromIndex + 1) return fromIndex;
    if (insertBefore > fromIndex) return insertBefore - 1;
    return insertBefore;
}

export function matchSheetListMenu(
    itemLabels: string[],
    sheets: SheetListEntry[],
): SheetListEntry[] | null {
    if (sheets.length < 2 || itemLabels.length !== sheets.length) return null;
    const matched: SheetListEntry[] = [];
    for (let i = 0; i < sheets.length; i++) {
        if (normalizeLabel(itemLabels[i]) !== normalizeLabel(sheets[i].title)) return null;
        matched.push(sheets[i]);
    }
    return matched;
}

function normalizeLabel(value: string | null | undefined): string {
    return String(value ?? '').replace(/\s+/g, ' ').trim();
}

export function installUniverSheetListReorder(opts: {
    doc: Document;
    getSheets: () => SheetListEntry[];
    getUnitId: () => string | null;
    reorderSheet: (sheetId: string, order: number, unitId: string) => void;
}): () => void {
    const doc = opts.doc;
    let disposed = false;
    let decorating = false;
    let frame = 0;
    let drag: {
        fromIndex: number;
        sheetId: string;
        pointerId: number;
        handle: HTMLElement;
        items: HTMLElement[];
        moved: boolean;
    } | null = null;

    const decorate = () => {
        if (disposed || decorating || drag) return;
        decorating = true;
        try {
            const sheets = opts.getSheets();
            const menus = Array.from(doc.querySelectorAll(MENU_SELECTOR));
            for (const menu of menus) {
                if (!isHtmlElement(menu)) continue;
                if (menu.closest(CONTEXT_SUBMENU_SELECTOR)) continue;
                const items = Array.from(menu.querySelectorAll(ITEM_SELECTOR))
                    .filter(isHtmlElement);
                const matched = matchSheetListMenu(items.map(readItemLabel), sheets);
                if (!matched) continue;
                for (let i = 0; i < items.length; i++) {
                    ensureHandle(items[i], matched[i], i);
                }
            }
        } finally {
            decorating = false;
        }
    };

    const scheduleDecorate = () => {
        if (disposed || frame || drag) return;
        frame = doc.defaultView?.requestAnimationFrame(() => {
            frame = 0;
            decorate();
        }) ?? 0;
        if (!frame) decorate();
    };

    const onPointerMove = (event: PointerEvent) => {
        if (!drag || event.pointerId !== drag.pointerId) return;
        event.preventDefault();
        const insertBefore = insertBeforeFromPoint(drag.items, event.clientY);
        if (insertBefore !== drag.fromIndex && insertBefore !== drag.fromIndex + 1) {
            drag.moved = true;
        }
        paintDropTarget(drag.items, insertBefore);
    };

    const finishDrag = (event: PointerEvent) => {
        if (!drag || event.pointerId !== drag.pointerId) return;
        const session = drag;
        drag = null;
        clearDropTarget(session.items);
        session.items[session.fromIndex]?.classList.remove(DRAGGING_CLASS);
        try {
            session.handle.releasePointerCapture(session.pointerId);
        } catch { /* already released */ }
        doc.removeEventListener('pointermove', onPointerMove, true);
        doc.removeEventListener('pointerup', finishDrag, true);
        doc.removeEventListener('pointercancel', finishDrag, true);
        const liveItems = session.items.filter(item => item.isConnected);
        const insertBefore = insertBeforeFromPoint(liveItems.length ? liveItems : session.items, event.clientY);
        const fromIndex = liveItems.length
            ? liveItems.findIndex(item => item.dataset.narrativelabSheetId === session.sheetId)
            : session.fromIndex;
        const resolvedFrom = fromIndex < 0 ? session.fromIndex : fromIndex;
        const order = sheetListReorderTargetIndex(resolvedFrom, insertBefore);
        if (session.moved && order !== resolvedFrom) {
            event.preventDefault();
            event.stopPropagation();
            const unitId = opts.getUnitId();
            if (unitId) opts.reorderSheet(session.sheetId, order, unitId);
            const swallow = (click: Event) => {
                click.preventDefault();
                click.stopPropagation();
            };
            doc.addEventListener('click', swallow, { capture: true, once: true });
        }
        scheduleDecorate();
    };

    const onHandlePointerDown = (event: PointerEvent) => {
        if (event.button !== 0) return;
        const handle = event.currentTarget;
        if (!isHtmlElement(handle)) return;
        const item = handle.closest(ITEM_SELECTOR);
        if (!isHtmlElement(item)) return;
        const menu = item.closest(MENU_SELECTOR);
        if (!isHtmlElement(menu)) return;
        const items = Array.from(menu.querySelectorAll(ITEM_SELECTOR))
            .filter(isHtmlElement);
        const fromIndex = items.indexOf(item);
        const sheetId = item.dataset.narrativelabSheetId;
        if (fromIndex < 0 || !sheetId) return;
        event.preventDefault();
        event.stopPropagation();
        drag = {
            fromIndex,
            sheetId,
            pointerId: event.pointerId,
            handle,
            items,
            moved: false,
        };
        item.classList.add(DRAGGING_CLASS);
        try {
            handle.setPointerCapture(event.pointerId);
        } catch { /* capture is optional */ }
        doc.addEventListener('pointermove', onPointerMove, true);
        doc.addEventListener('pointerup', finishDrag, true);
        doc.addEventListener('pointercancel', finishDrag, true);
    };

    const ensureHandle = (item: HTMLElement, sheet: SheetListEntry, index: number) => {
        item.dataset.narrativelabSheetId = sheet.id;
        item.dataset.narrativelabSheetIndex = String(index);
        const existing = item.querySelector(`.${HANDLE_CLASS}`);
        if (isHtmlElement(existing)) {
            existing.title = t('Drag to reorder');
            existing.setAttribute('aria-label', t('Drag to reorder'));
            return;
        }
        const handle = doc.createElement('span');
        handle.className = HANDLE_CLASS;
        handle.setAttribute('role', 'button');
        handle.tabIndex = -1;
        handle.title = t('Drag to reorder');
        handle.setAttribute('aria-label', t('Drag to reorder'));
        const grip = doc.createElement('span');
        grip.className = 'narrativelab-sheet-list-handle-grip';
        grip.setAttribute('aria-hidden', 'true');
        handle.appendChild(grip);
        handle.addEventListener('pointerdown', onHandlePointerDown);
        handle.addEventListener('click', (event) => {
            event.preventDefault();
            event.stopPropagation();
        });
        item.appendChild(handle);
    };

    const observer = new MutationObserver(scheduleDecorate);
    observer.observe(doc.body, { childList: true, subtree: true });
    scheduleDecorate();

    return () => {
        disposed = true;
        observer.disconnect();
        if (frame) doc.defaultView?.cancelAnimationFrame(frame);
        doc.removeEventListener('pointermove', onPointerMove, true);
        doc.removeEventListener('pointerup', finishDrag, true);
        doc.removeEventListener('pointercancel', finishDrag, true);
        drag = null;
        for (const handle of Array.from(doc.querySelectorAll(`.${HANDLE_CLASS}`))) {
            handle.remove();
        }
    };
}

function readItemLabel(item: HTMLElement): string {
    const parts: string[] = [];
    for (const child of Array.from(item.children)) {
        if (child.classList.contains(HANDLE_CLASS)) continue;
        parts.push(child.textContent ?? '');
    }
    return normalizeLabel(parts.join(' ') || item.textContent);
}

function insertBeforeFromPoint(items: HTMLElement[], y: number): number {
    for (let i = 0; i < items.length; i++) {
        const rect = items[i].getBoundingClientRect();
        if (y < rect.top + rect.height / 2) return i;
    }
    return items.length;
}

function paintDropTarget(items: HTMLElement[], insertBefore: number): void {
    clearDropTarget(items);
    if (insertBefore >= items.length) {
        items[items.length - 1]?.classList.add(DROP_AFTER_CLASS);
        return;
    }
    items[insertBefore]?.classList.add(DROP_BEFORE_CLASS);
}

function clearDropTarget(items: HTMLElement[]): void {
    for (const item of items) {
        item.classList.remove(DROP_BEFORE_CLASS, DROP_AFTER_CLASS);
    }
}
