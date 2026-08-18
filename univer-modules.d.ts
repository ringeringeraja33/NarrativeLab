/** Ambient modules for Univer packages (no published @types; runtime bundled separately). */
declare module '@univerjs/core/lib/facade' {
    import type { Univer } from '@univerjs/core';

    export class FUniver {
        static newAPI(univer: Univer): FUniver;
    }
}

declare module '@univerjs/preset-sheets-core' {
    export function UniverSheetsCorePreset(options: Record<string, unknown>): unknown;
}

declare module '@univerjs/preset-sheets-filter' {
    export function UniverSheetsFilterPreset(options?: Record<string, unknown>): unknown;
}

declare module '@univerjs/preset-sheets-drawing' {
    export function UniverSheetsDrawingPreset(options?: Record<string, unknown>): unknown;
}

declare module '@univerjs/preset-sheets-hyper-link' {
    export function UniverSheetsHyperLinkPreset(options?: Record<string, unknown>): unknown;
}

declare module '@univerjs/preset-sheets-find-replace' {
    export function UniverSheetsFindReplacePreset(options?: Record<string, unknown>): unknown;
}

declare module '@univerjs/preset-sheets-sort' {
    export function UniverSheetsSortPreset(options?: Record<string, unknown>): unknown;
}

declare module '@univerjs/preset-sheets-data-validation' {
    export function UniverSheetsDataValidationPreset(options?: Record<string, unknown>): unknown;
}

declare module '@univerjs/preset-sheets-conditional-formatting' {
    export function UniverSheetsConditionalFormattingPreset(options?: Record<string, unknown>): unknown;
}

declare module '@univerjs/preset-sheets-note' {
    export function UniverSheetsNotePreset(options?: Record<string, unknown>): unknown;
}

declare module '@univerjs/preset-sheets-table' {
    export function UniverSheetsTablePreset(options?: Record<string, unknown>): unknown;
}

declare module '@univerjs/preset-sheets-thread-comment' {
    export function UniverSheetsThreadCommentPreset(options?: Record<string, unknown>): unknown;
}

declare module '@univerjs/preset-sheets-core/locales/en-US' {
    const locale: unknown;
    export default locale;
}

declare module '@univerjs/preset-sheets-core/locales/zh-CN' {
    const locale: unknown;
    export default locale;
}

declare module '@univerjs/preset-sheets-filter/locales/en-US' {
    const locale: unknown;
    export default locale;
}

declare module '@univerjs/preset-sheets-filter/locales/zh-CN' {
    const locale: unknown;
    export default locale;
}

declare module '@univerjs/preset-sheets-drawing/locales/en-US' {
    const locale: unknown;
    export default locale;
}

declare module '@univerjs/preset-sheets-drawing/locales/zh-CN' {
    const locale: unknown;
    export default locale;
}

declare module '@univerjs/preset-sheets-hyper-link/locales/en-US' {
    const locale: unknown;
    export default locale;
}

declare module '@univerjs/preset-sheets-hyper-link/locales/zh-CN' {
    const locale: unknown;
    export default locale;
}

declare module '@univerjs/preset-sheets-find-replace/locales/en-US' {
    const locale: unknown;
    export default locale;
}

declare module '@univerjs/preset-sheets-find-replace/locales/zh-CN' {
    const locale: unknown;
    export default locale;
}

declare module '@univerjs/preset-sheets-sort/locales/en-US' {
    const locale: unknown;
    export default locale;
}

declare module '@univerjs/preset-sheets-sort/locales/zh-CN' {
    const locale: unknown;
    export default locale;
}

declare module '@univerjs/preset-sheets-data-validation/locales/en-US' {
    const locale: unknown;
    export default locale;
}

declare module '@univerjs/preset-sheets-data-validation/locales/zh-CN' {
    const locale: unknown;
    export default locale;
}

declare module '@univerjs/preset-sheets-conditional-formatting/locales/en-US' {
    const locale: unknown;
    export default locale;
}

declare module '@univerjs/preset-sheets-conditional-formatting/locales/zh-CN' {
    const locale: unknown;
    export default locale;
}

declare module '@univerjs/preset-sheets-note/locales/en-US' {
    const locale: unknown;
    export default locale;
}

declare module '@univerjs/preset-sheets-note/locales/zh-CN' {
    const locale: unknown;
    export default locale;
}

declare module '@univerjs/preset-sheets-table/locales/en-US' {
    const locale: unknown;
    export default locale;
}

declare module '@univerjs/preset-sheets-table/locales/zh-CN' {
    const locale: unknown;
    export default locale;
}

declare module '@univerjs/preset-sheets-thread-comment/locales/en-US' {
    const locale: unknown;
    export default locale;
}

declare module '@univerjs/preset-sheets-thread-comment/locales/zh-CN' {
    const locale: unknown;
    export default locale;
}

declare module '@univerjs/preset-sheets-core/lib/index.css' {
    const css: string;
    export default css;
}

declare module '@univerjs/preset-sheets-filter/lib/index.css' {
    const css: string;
    export default css;
}

declare module '@univerjs/preset-sheets-drawing/lib/index.css' {
    const css: string;
    export default css;
}

declare module '@univerjs/preset-sheets-hyper-link/lib/index.css' {
    const css: string;
    export default css;
}

declare module '@univerjs/preset-sheets-find-replace/lib/index.css' {
    const css: string;
    export default css;
}

declare module '@univerjs/preset-sheets-sort/lib/index.css' {
    const css: string;
    export default css;
}

declare module '@univerjs/preset-sheets-data-validation/lib/index.css' {
    const css: string;
    export default css;
}

declare module '@univerjs/preset-sheets-conditional-formatting/lib/index.css' {
    const css: string;
    export default css;
}

declare module '@univerjs/preset-sheets-note/lib/index.css' {
    const css: string;
    export default css;
}

declare module '@univerjs/preset-sheets-table/lib/index.css' {
    const css: string;
    export default css;
}

declare module '@univerjs/preset-sheets-thread-comment/lib/index.css' {
    const css: string;
    export default css;
}

declare module '*.css' {
    const css: string;
    export default css;
}
