/** Ambient modules for Univer packages (no published @types; runtime bundled separately). */
declare module '@univerjs/presets' {
    export const LocaleType: { ZH_CN: string; EN_US: string };
    export function mergeLocales(...locales: unknown[]): unknown;
    export function createUniver(options: Record<string, unknown>): { univerAPI: unknown };
}

declare module '@univerjs/preset-sheets-core' {
    export function UniverSheetsCorePreset(options: Record<string, unknown>): unknown;
}

declare module '@univerjs/preset-sheets-core/locales/en-US' {
    const locale: unknown;
    export default locale;
}

declare module '@univerjs/preset-sheets-core/locales/zh-CN' {
    const locale: unknown;
    export default locale;
}

declare module '@univerjs/preset-sheets-filter' {
    export function UniverSheetsFilterPreset(options?: Record<string, unknown>): unknown;
}

declare module '@univerjs/preset-sheets-filter/locales/en-US' {
    const locale: unknown;
    export default locale;
}

declare module '@univerjs/preset-sheets-filter/locales/zh-CN' {
    const locale: unknown;
    export default locale;
}

declare module '@univerjs/preset-sheets-core/lib/index.css' {
    const css: string;
    export default css;
}

declare module '*.css' {
    const css: string;
    export default css;
}
