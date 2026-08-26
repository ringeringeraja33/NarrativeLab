import type { SceneCardsSettings } from '../settings';

export const MIN_CUSTOM_FIELD_INPUT_HEIGHT = 34;
export const MAX_CUSTOM_FIELD_INPUT_HEIGHT = 1200;

/** Stable, collision-safe key for a resizable input shared by archive profiles. */
export function customFieldInputHeightKey(...parts: string[]): string {
    return parts.map(part => encodeURIComponent(part)).join('::');
}

export function normalizeCustomFieldInputHeight(value: unknown): number | undefined {
    if (typeof value !== 'number' || !Number.isFinite(value)) return undefined;
    return Math.min(MAX_CUSTOM_FIELD_INPUT_HEIGHT, Math.max(MIN_CUSTOM_FIELD_INPUT_HEIGHT, Math.round(value)));
}

/**
 * Give a profile text field a native vertical resize handle and remember the
 * chosen height in the current project's profile-layout settings.
 */
export function bindResizableCustomFieldInput(
    textarea: HTMLTextAreaElement,
    settings: SceneCardsSettings,
    key: string,
    save: () => Promise<void> | void,
    minHeight = MIN_CUSTOM_FIELD_INPUT_HEIGHT,
): void {
    textarea.addClass('nl-resizable-custom-field');
    textarea.setCssStyles({ minHeight: `${minHeight}px` });

    if (!settings.profileFieldInputHeights) settings.profileFieldInputHeights = {};
    const heights = settings.profileFieldInputHeights;
    const normalizedSavedHeight = normalizeCustomFieldInputHeight(heights[key]);
    // Older builds could observe a collapsed/detached multiline field as 0px
    // and clamp that bogus reading to 34px. Treat values below this field's
    // real minimum as unset so existing projects recover via natural sizing.
    const savedHeight = normalizedSavedHeight !== undefined && normalizedSavedHeight >= minHeight
        ? normalizedSavedHeight
        : undefined;

    let lastHeight = 0;
    let ready = false;
    let saveTimer: number | null = null;
    let savePending = false;
    let observer: ResizeObserver | null = null;
    const view = textarea.ownerDocument.defaultView ?? window;

    const persistPendingHeight = (): void => {
        if (saveTimer !== null) {
            view.clearTimeout(saveTimer);
            saveTimer = null;
        }
        if (!savePending) return;
        savePending = false;
        void Promise.resolve(save()).catch(error => {
            // Keep the in-memory height even when disk persistence fails. A
            // later resize/blur gets another chance to save it.
            savePending = true;
            console.error('[Narrative Lab] Failed to save profile field input height', error);
        });
    };

    const schedulePersist = (): void => {
        if (saveTimer !== null) view.clearTimeout(saveTimer);
        saveTimer = view.setTimeout(persistPendingHeight, 180);
    };

    const recordCurrentHeight = (flush: boolean): void => {
        if (!ready) return;
        if (!textarea.isConnected) {
            observer?.disconnect();
            if (flush) persistPendingHeight();
            return;
        }
        const measuredHeight = textarea.getBoundingClientRect().height;
        // Collapsed sections and detached lazy-render columns report zero.
        // Never turn that transient layout state into a stored minimum height.
        if (!Number.isFinite(measuredHeight) || measuredHeight <= 0) return;
        const height = normalizeCustomFieldInputHeight(Math.max(minHeight, measuredHeight));
        if (height === undefined) return;
        lastHeight = height;
        if (heights[key] !== height) {
            // Update the live project settings immediately. A synchronous
            // profile rerender must already see the newly dragged height.
            heights[key] = height;
            savePending = true;
        }
        if (!savePending) return;
        if (flush) persistPendingHeight();
        else schedulePersist();
    };

    view.requestAnimationFrame(() => {
        if (savedHeight !== undefined) {
            textarea.setCssStyles({ height: `${savedHeight}px` });
        } else {
            textarea.setCssStyles({ height: 'auto' });
            const naturalHeight = Math.max(minHeight, Math.min(MAX_CUSTOM_FIELD_INPUT_HEIGHT, textarea.scrollHeight));
            textarea.setCssStyles({ height: `${naturalHeight}px` });
        }
        lastHeight = Math.round(textarea.getBoundingClientRect().height);
        ready = true;
    });

    observer = new ResizeObserver(() => {
        if (!ready) return;
        if (!textarea.isConnected) {
            observer?.disconnect();
            persistPendingHeight();
            return;
        }
        const measuredHeight = textarea.getBoundingClientRect().height;
        if (!Number.isFinite(measuredHeight) || measuredHeight <= 0) return;
        const height = normalizeCustomFieldInputHeight(Math.max(minHeight, measuredHeight));
        if (height === undefined || (height === lastHeight && heights[key] === height)) return;
        recordCurrentHeight(false);
    });
    observer.observe(textarea);

    // ResizeObserver delivery is asynchronous. Capture the final drag size
    // synchronously on release/blur so closing or rerendering immediately after
    // a resize cannot lose the last movement.
    const flushHeight = (): void => recordCurrentHeight(true);
    textarea.addEventListener('pointerup', flushHeight);
    textarea.addEventListener('mouseup', flushHeight);
    textarea.addEventListener('touchend', flushHeight);
    textarea.addEventListener('blur', flushHeight);
}
