/* eslint-disable @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-argument, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-return -- bulk-suppression for plugin-wide code-quality */
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

/** Read a string field from an unknown record, or return fallback. */
export function asString(v: unknown, fallback = ''): string {
    return typeof v === 'string' ? v : fallback;
}

/** Read a number field from an unknown record, or return fallback. */
export function asNumber(v: unknown, fallback = 0): number {
    return typeof v === 'number' && Number.isFinite(v) ? v : fallback;
}

/** Read a boolean field, or return fallback. */
export function asBool(v: unknown, fallback = false): boolean {
    return typeof v === 'boolean' ? v : fallback;
}

/** Cast `unknown` to typed value with default fallback (no runtime check beyond presence). */
export function asTyped<T>(v: unknown, fallback: T): T {
    return v === undefined || v === null ? fallback : (v as T);
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
/* eslint-enable @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-argument, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-return -- end bulk-suppression */
