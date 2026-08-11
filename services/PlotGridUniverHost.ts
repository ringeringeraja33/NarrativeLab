/**
 * Lazy-loaded Univer Sheets host for the Concept Grid (Plot Grid) view.
 * Bundled separately as plotgrid-univer.js to keep main.js lean.
 */
import { createUniver, LocaleType, mergeLocales } from '@univerjs/presets';
import { UniverSheetsCorePreset } from '@univerjs/preset-sheets-core';
import sheetsCoreEnUS from '@univerjs/preset-sheets-core/locales/en-US';
import sheetsCoreZhCN from '@univerjs/preset-sheets-core/locales/zh-CN';

import sheetsCoreCss from '@univerjs/preset-sheets-core/lib/index.css';

function injectUniverCss(): void {
    const id = 'narrativelab-univer-sheets-css';
    if (typeof document === 'undefined') return;
    if (document.getElementById(id)) return;
    const style = document.createElement('style');
    style.id = id;
    style.textContent = typeof sheetsCoreCss === 'string' ? sheetsCoreCss : String(sheetsCoreCss);
    document.head.appendChild(style);
}

import type { ConceptGridDocument } from '../models/PlotGridData';
import {
    conceptGridContentFingerprint,
    documentToUniverWorkbookData,
    mergeUniverCellDataIntoDocument,
} from './PlotGridXlsxCodec';

export interface PlotGridUniverHostOptions {
    container: HTMLElement;
    document: ConceptGridDocument;
    locale: 'en' | 'zh';
    onDocumentChange: (doc: ConceptGridDocument) => void;
    onSelectionChange?: (info: { sheetId: string; row: number; col: number }) => void;
}

export interface PlotGridUniverHost {
    dispose: () => void;
    getDocument: () => ConceptGridDocument;
    setDocument: (doc: ConceptGridDocument) => void;
    getActiveCell: () => { sheetId: string; row: number; col: number } | null;
    /** Force a sync pull from Univer cell matrix into the live document. */
    flush: () => void;
    focus: () => void;
}

type UniverAPI = {
    createWorkbook: (data: Record<string, unknown>) => unknown;
    getActiveWorkbook: () => {
        getId: () => string;
        getActiveSheet: () => { getSheetId: () => string } | null;
        getSheetBySheetId: (id: string) => {
            getSheetId: () => string;
            getRange: (r: number, c: number) => { getValue: () => unknown; getCellData: () => { v?: unknown } | null };
            getCellMatrix?: () => { getMatrix: () => unknown };
        } | null;
        save: () => Record<string, unknown>;
    } | null;
    addEvent: (event: string | number, cb: (params: unknown) => void) => { dispose?: () => void } | number;
    removeEvent?: (id: unknown) => void;
    disposeUnit?: (unitId: string) => void;
    dispose?: () => void;
};

/**
 * Mount Univer Sheets into `container` and keep a ConceptGridDocument in sync.
 */
export function createPlotGridUniverHost(opts: PlotGridUniverHostOptions): PlotGridUniverHost {
    let liveDoc = structuredClone(opts.document) as ConceptGridDocument;
    let contentFp = conceptGridContentFingerprint(liveDoc);
    const locale = opts.locale === 'zh' ? LocaleType.ZH_CN : LocaleType.EN_US;
    const locales = opts.locale === 'zh'
        ? { [LocaleType.ZH_CN]: mergeLocales(sheetsCoreZhCN) }
        : { [LocaleType.EN_US]: mergeLocales(sheetsCoreEnUS) };

    injectUniverCss();

    opts.container.empty();
    opts.container.addClass('plot-grid-univer-host');
    opts.container.setCssStyles({
        width: '100%',
        height: '100%',
        minHeight: '420px',
        position: 'relative',
    });

    const { univerAPI } = createUniver({
        locale,
        locales,
        presets: [
            UniverSheetsCorePreset({
                container: opts.container,
            }),
        ],
    }) as { univerAPI: UniverAPI };

    const workbookData = documentToUniverWorkbookData(liveDoc);
    univerAPI.createWorkbook(workbookData);

    let disposed = false;
    let suppressUntil = 0;
    let lastSelection: { sheetId: string; row: number; col: number } | null = null;
    const disposers: Array<() => void> = [];

    const isSuppressed = () => disposed || Date.now() < suppressUntil;

    const replaceWorkbook = (doc: ConceptGridDocument) => {
        suppressUntil = Date.now() + 800;
        try {
            const existing = univerAPI.getActiveWorkbook?.();
            const unitId = existing?.getId?.();
            if (unitId && typeof univerAPI.disposeUnit === 'function') {
                try { univerAPI.disposeUnit(unitId); } catch { /* ignore */ }
            }
        } catch { /* ignore */ }
        univerAPI.createWorkbook(documentToUniverWorkbookData(doc));
    };

    const pullFromUniver = () => {
        if (isSuppressed()) return;
        try {
            const wb = univerAPI.getActiveWorkbook?.();
            if (!wb) return;
            const saved = wb.save?.() as {
                sheets?: Record<string, {
                    id?: string;
                    cellData?: Record<number, Record<number, { v?: unknown }>>;
                }>;
            } | undefined;
            if (!saved?.sheets) return;
            let next = liveDoc;
            for (const sheet of Object.values(saved.sheets)) {
                const id = sheet.id;
                if (!id || !sheet.cellData) continue;
                next = mergeUniverCellDataIntoDocument(next, id, sheet.cellData);
            }
            const nextFp = conceptGridContentFingerprint(next);
            if (nextFp === contentFp) return;
            liveDoc = next;
            contentFp = nextFp;
            opts.onDocumentChange(liveDoc);
        } catch (e) {
            console.warn('[NarrativeLab] Univer → document sync failed:', e);
        }
    };

    // Debounced command listener — Univer fires many mutations while editing.
    let timer = 0;
    const schedulePull = () => {
        if (isSuppressed()) return;
        if (timer) window.clearTimeout(timer);
        timer = window.setTimeout(() => {
            timer = 0;
            pullFromUniver();
        }, 600);
    };

    try {
        // Facade event name varies by version; try common hooks.
        const api = univerAPI as UniverAPI & {
            Event?: { CommandExecuted?: string; SelectionChanged?: string };
            onCommandExecuted?: (cb: (c: unknown) => void) => void;
        };
        if (api.Event?.CommandExecuted) {
            const sub = univerAPI.addEvent(api.Event.CommandExecuted, () => schedulePull());
            disposers.push(() => {
                if (sub && typeof sub === 'object' && typeof sub.dispose === 'function') sub.dispose();
            });
        } else if (typeof api.onCommandExecuted === 'function') {
            api.onCommandExecuted(() => schedulePull());
        } else {
            // Gentle backup only when command hooks are missing — fingerprint skip prevents save spam.
            const id = window.setInterval(() => {
                if (!disposed && opts.container.isConnected && !isSuppressed()) schedulePull();
            }, 3000);
            disposers.push(() => window.clearInterval(id));
        }
        const handleSelection = (params: unknown) => {
            try {
                const p = params as {
                    sheetId?: string;
                    selections?: Array<{ range?: { startRow?: number; startColumn?: number } }>;
                };
                const range = p.selections?.[0]?.range;
                const sheetId = p.sheetId
                    || univerAPI.getActiveWorkbook()?.getActiveSheet()?.getSheetId?.();
                if (sheetId != null && range?.startRow != null && range?.startColumn != null) {
                    lastSelection = {
                        sheetId,
                        row: range.startRow,
                        col: range.startColumn,
                    };
                    opts.onSelectionChange?.(lastSelection);
                }
            } catch { /* ignore */ }
        };

        if (api.Event?.SelectionChanged) {
            const sub = univerAPI.addEvent(api.Event.SelectionChanged, handleSelection);
            disposers.push(() => {
                if (sub && typeof sub === 'object' && typeof sub.dispose === 'function') sub.dispose();
            });
        }
    } catch (e) {
        console.warn('[NarrativeLab] Univer event hook failed:', e);
    }

    // Initial settle — ignore bootstrap commands from createWorkbook.
    suppressUntil = Date.now() + 800;

    return {
        dispose: () => {
            disposed = true;
            if (timer) window.clearTimeout(timer);
            for (const d of disposers) {
                try { d(); } catch { /* ignore */ }
            }
            try {
                univerAPI.dispose?.();
            } catch { /* ignore */ }
            opts.container.empty();
        },
        getDocument: () => liveDoc,
        setDocument: (doc: ConceptGridDocument) => {
            liveDoc = structuredClone(doc) as ConceptGridDocument;
            contentFp = conceptGridContentFingerprint(liveDoc);
            replaceWorkbook(liveDoc);
        },
        getActiveCell: () => {
            if (lastSelection) return lastSelection;
            try {
                const sheet = univerAPI.getActiveWorkbook()?.getActiveSheet?.();
                const sheetId = sheet?.getSheetId?.();
                if (!sheetId) return null;
                return { sheetId, row: 0, col: 0 };
            } catch {
                return null;
            }
        },
        flush: () => pullFromUniver(),
        focus: () => {
            opts.container.querySelector<HTMLElement>('[contenteditable], canvas, .univer-workbook')?.focus?.();
        },
    };
}

export type { ConceptGridDocument };
