/** Minimal key shape so undo detection can be unit-tested without a DOM. */
export type UndoKeyLike = {
    ctrlKey: boolean;
    metaKey: boolean;
    altKey: boolean;
    shiftKey: boolean;
    key: string;
};

export function isUndoKey(event: UndoKeyLike): boolean {
    const mod = event.ctrlKey || event.metaKey;
    return mod && !event.altKey && !event.shiftKey && event.key.toLowerCase() === 'z';
}

/** True when Cmd+Z should stay with the focused field, not workspace undo. */
export function isLocalTextUndoTarget(doc: Document = activeDocument): boolean {
    const active = doc.activeElement;
    if (!active || !active.instanceOf(HTMLElement)) return false;
    const tag = active.tagName;
    if (tag === 'TEXTAREA' || tag === 'INPUT') return true;
    if (active.isContentEditable) return true;
    return !!active.closest('.plot-grid-cell-editor-window');
}

export function isRedoKey(event: UndoKeyLike): boolean {
    const mod = event.ctrlKey || event.metaKey;
    if (!mod || event.altKey) return false;
    if (event.key.toLowerCase() === 'y' && !event.shiftKey) return true;
    return event.key.toLowerCase() === 'z' && event.shiftKey;
}

/** Replace the whole value without dropping the native undo entry when possible. */
export function replaceTextareaValue(
    textarea: HTMLTextAreaElement,
    next: string,
    caret?: number,
): void {
    textarea.setRangeText(next, 0, textarea.value.length, 'end');
    if (caret != null) textarea.setSelectionRange(caret, caret);
    textarea.dispatchEvent(new Event('input', { bubbles: true }));
}

type Snapshot = { value: string; start: number; end: number };

type UndoSession = {
    handle(event: KeyboardEvent): boolean;
};

const sessions = new Set<UndoSession>();
const consumedKeys = new WeakSet<KeyboardEvent>();

/** True when a cell-editor (or other) textarea session consumed the key. */
export function consumeTextareaUndoKey(event: KeyboardEvent): boolean {
    if (!isUndoKey(event) && !isRedoKey(event)) return false;
    if (consumedKeys.has(event)) return true;
    for (const session of sessions) {
        if (session.handle(event)) {
            consumedKeys.add(event);
            return true;
        }
    }
    return false;
}

export function installTextareaUndoHistory(
    textarea: HTMLTextAreaElement,
    options?: {
        shouldHandle?: (event: KeyboardEvent) => boolean;
        /** Extra target for capture-phase keys (pop-out windows). */
        captureTarget?: EventTarget | null;
    },
): () => void {
    const history: Snapshot[] = [];
    let index = -1;
    let lastAt = 0;
    let applying = false;
    let composing = false;

    const capture = (): Snapshot => ({
        value: textarea.value,
        start: textarea.selectionStart ?? textarea.value.length,
        end: textarea.selectionEnd ?? textarea.selectionStart ?? textarea.value.length,
    });

    const apply = (snap: Snapshot): void => {
        applying = true;
        textarea.value = snap.value;
        textarea.setSelectionRange(snap.start, snap.end);
        textarea.dispatchEvent(new Event('input', { bubbles: true }));
        applying = false;
        textarea.focus();
    };

    const push = (force = false): void => {
        if (applying) return;
        const next = capture();
        const last = index >= 0 ? history[index] : undefined;
        if (last && last.value === next.value) {
            history[index] = next;
            return;
        }
        const now = Date.now();
        const coalesce = !force && last != null && (now - lastAt) < 400
            && Math.abs(next.value.length - last.value.length) <= 2;
        history.splice(index + 1);
        if (coalesce && index >= 0) {
            history[index] = next;
        } else {
            history.push(next);
            if (history.length > 200) history.shift();
            index = history.length - 1;
        }
        lastAt = now;
    };

    const undo = (): boolean => {
        if (index <= 0) return true;
        index -= 1;
        lastAt = 0;
        apply(history[index]);
        return true;
    };

    const redo = (): boolean => {
        if (index < 0 || index >= history.length - 1) return true;
        index += 1;
        lastAt = 0;
        apply(history[index]);
        return true;
    };

    const handle = (event: KeyboardEvent): boolean => {
        if (!isUndoKey(event) && !isRedoKey(event)) return false;
        if (options?.shouldHandle && !options.shouldHandle(event)) return false;
        if (isUndoKey(event)) return undo();
        return redo();
    };

    const session: UndoSession = { handle };
    sessions.add(session);
    push(true);

    const onInput = (): void => {
        if (composing) return;
        push();
    };
    const onCompositionStart = (): void => { composing = true; };
    const onCompositionEnd = (): void => {
        composing = false;
        push(true);
    };
    textarea.addEventListener('input', onInput);
    textarea.addEventListener('compositionstart', onCompositionStart);
    textarea.addEventListener('compositionend', onCompositionEnd);

    const captureTarget = options?.captureTarget
        ?? textarea.ownerDocument.defaultView
        ?? null;
    const onCapture = (event: Event): void => {
        const keyEvent = event as KeyboardEvent;
        if (!handle(keyEvent)) return;
        keyEvent.preventDefault();
        keyEvent.stopPropagation();
        keyEvent.stopImmediatePropagation();
    };
    captureTarget?.addEventListener('keydown', onCapture, true);

    return () => {
        sessions.delete(session);
        textarea.removeEventListener('input', onInput);
        textarea.removeEventListener('compositionstart', onCompositionStart);
        textarea.removeEventListener('compositionend', onCompositionEnd);
        captureTarget?.removeEventListener('keydown', onCapture, true);
    };
}
