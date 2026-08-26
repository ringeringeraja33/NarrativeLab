import type { SceneCardsSettings } from '../settings';

export const MIN_CUSTOM_FIELD_INPUT_HEIGHT = 34;
export const MAX_CUSTOM_FIELD_INPUT_HEIGHT = 1200;

/** Stable, collision-safe key for a custom input shared by archive profiles. */
export function customFieldInputHeightKey(...parts: string[]): string {
    return parts.map(part => encodeURIComponent(part)).join('::');
}

export function normalizeCustomFieldInputHeight(value: unknown): number | undefined {
    if (typeof value !== 'number' || !Number.isFinite(value)) return undefined;
    return Math.min(MAX_CUSTOM_FIELD_INPUT_HEIGHT, Math.max(MIN_CUSTOM_FIELD_INPUT_HEIGHT, Math.round(value)));
}

/**
 * Give a custom text field a native vertical resize handle and remember the
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
    const savedHeight = normalizeCustomFieldInputHeight(heights[key]);

    let lastHeight = 0;
    let ready = false;
    let saveTimer: number | null = null;
    const view = textarea.ownerDocument.defaultView ?? window;

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

    const observer = new ResizeObserver(() => {
        if (!ready) return;
        const height = normalizeCustomFieldInputHeight(textarea.getBoundingClientRect().height);
        if (height === undefined || height === lastHeight) return;
        lastHeight = height;
        if (saveTimer !== null) view.clearTimeout(saveTimer);
        saveTimer = view.setTimeout(() => {
            saveTimer = null;
            if (heights[key] === height) return;
            heights[key] = height;
            void Promise.resolve(save()).catch(error => {
                console.error('[Narrative Lab] Failed to save custom field input height', error);
            });
        }, 180);
    });
    observer.observe(textarea);
}
