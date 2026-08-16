
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
