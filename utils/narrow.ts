
/**
 * Tiny type-narrowing helpers used throughout the plugin to bridge
 * `unknown` JSON / settings values to typed access without resorting to `any`.
 */

/** True if value is a plain object (not null, not array). */
export function isRecord(v: unknown): v is Record<string, unknown> {
    return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/** Cast `unknown` to `Record<string, unknown>` (fallback to empty object). */
export function asRecord(v: unknown): Record<string, unknown> {
    return isRecord(v) ? v : {};
}

/**
 * Safely coerce an unknown value to a string. Strings pass through; numbers
 * and booleans are stringified. Anything else (objects, arrays, null, undefined)
 * returns the fallback. Avoids the "[object Object]" trap that the Obsidian
 * reviewer linter flags when calling `String(unknown)` directly.
 */
export function coerceString(v: unknown, fallback = ''): string {
    if (typeof v === 'string') return v;
    if (typeof v === 'number' || typeof v === 'boolean') return String(v);
    return fallback;
}

/** Convert scalar values or nested scalar lists into clean display text. */
export function coerceText(v: unknown, separator = ', '): string {
    if (!Array.isArray(v)) return coerceString(v);
    return v
        .map(value => coerceText(value, separator).trim())
        .filter(Boolean)
        .join(separator);
}

/** Normalize a scalar/list boundary without ever stringifying objects. */
export function coerceStringList(v: unknown, splitPattern?: RegExp): string[] {
    const result: string[] = [];
    const visit = (value: unknown): void => {
        if (Array.isArray(value)) {
            for (const item of value) visit(item);
            return;
        }
        const text = coerceString(value).trim();
        if (!text) return;
        const parts = splitPattern ? text.split(splitPattern) : [text];
        for (const part of parts) {
            const normalized = part.trim();
            if (normalized) result.push(normalized);
        }
    };
    visit(v);
    return result;
}
