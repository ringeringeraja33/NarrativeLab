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
    /**
     * Latest NarrativeLab document (may include link/meta edits that live outside Univer).
     * Pull merges Univer cell values into this snapshot so metadata is not erased.
     */
    getAuthoritativeDocument?: () => ConceptGridDocument;
    onDocumentChange: (doc: ConceptGridDocument) => void;
    onSelectionChange?: (info: { sheetId: string; row: number; col: number }) => void;
}

export interface PlotGridUniverHost {
    dispose: () => void;
    getDocument: () => ConceptGridDocument;
    setDocument: (doc: ConceptGridDocument) => void;
    /** Update host's metadata snapshot without recreating the workbook. */
    syncMeta: (doc: ConceptGridDocument) => void;
    setActiveSheet: (sheetId: string) => void;
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
            activate?: () => void;
            getRange: (r: number, c: number) => { getValue: () => unknown; getCellData: () => { v?: unknown } | null };
            getCellMatrix?: () => { getMatrix: () => unknown };
        } | null;
        setActiveSheet?: (id: string) => void;
        save: () => Record<string, unknown>;
    } | null;
    addEvent: (event: string | number, cb: (params: unknown) => void) => { dispose?: () => void } | number;
    removeEvent?: (id: unknown) => void;
    disposeUnit?: (unitId: string) => void;
    dispose?: () => void;
};

function extractSelection(params: unknown, fallbackSheetId?: string | null): { sheetId: string; row: number; col: number } | null {
    const p = params as {
        sheetId?: string;
        worksheet?: { getSheetId?: () => string };
        selections?: Array<
            | { range?: { startRow?: number; startColumn?: number }; startRow?: number; startColumn?: number }
            | { startRow?: number; startColumn?: number }
        >;
    };
    const first = p.selections?.[0];
    const range = first && 'range' in first && first.range
        ? first.range
        : first;
    const row = range && typeof range === 'object' ? (range as { startRow?: number }).startRow : undefined;
    const col = range && typeof range === 'object' ? (range as { startColumn?: number }).startColumn : undefined;
    const sheetId = p.sheetId
        || p.worksheet?.getSheetId?.()
        || fallbackSheetId
        || null;
    if (sheetId == null || row == null || col == null) return null;
    return { sheetId, row, col };
}

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
        minHeight: '0',
        flex: '1 1 auto',
        position: 'relative',
        overflow: 'hidden',
    });

    // Prefer hiding Univer's sheet bar (NL has its own page tabs). Fall back if unsupported.
    let univerAPI: UniverAPI;
    try {
        ({ univerAPI } = createUniver({
            locale,
            locales,
            presets: [
                UniverSheetsCorePreset({
                    container: opts.container,
                    footer: false,
                } as Record<string, unknown>),
            ],
        }) as { univerAPI: UniverAPI });
    } catch {
        ({ univerAPI } = createUniver({
            locale,
            locales,
            presets: [
                UniverSheetsCorePreset({
                    container: opts.container,
                }),
            ],
        }) as { univerAPI: UniverAPI });
    }

    const workbookData = documentToUniverWorkbookData(liveDoc);
    univerAPI.createWorkbook(workbookData);
    tryActivateSheet(univerAPI, liveDoc.activePageId);

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
        tryActivateSheet(univerAPI, doc.activePageId);
    };

    const pullFromUniver = (force = false) => {
        if (disposed) return;
        if (!force && isSuppressed()) return;
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

            // Always merge into the latest NL document so link/meta edits survive.
            const base = structuredClone(
                (opts.getAuthoritativeDocument?.() ?? liveDoc),
            ) as ConceptGridDocument;

            let next = base;
            for (const sheet of Object.values(saved.sheets)) {
                const id = sheet.id;
                if (!id || !sheet.cellData) continue;
                next = mergeUniverCellDataIntoDocument(next, id, sheet.cellData);
            }
            const nextFp = conceptGridContentFingerprint(next);
            // Also detect meta drift (links) even when display text is unchanged.
            const metaChanged = JSON.stringify(pickMeta(next)) !== JSON.stringify(pickMeta(liveDoc));
            if (nextFp === contentFp && !metaChanged && !force) {
                liveDoc = next;
                return;
            }
            liveDoc = next;
            contentFp = nextFp;
            opts.onDocumentChange(liveDoc);
        } catch (e) {
            console.warn('[NarrativeLab] Univer → document sync failed:', e);
        }
    };

    // Debounced command listener — Univer fires many mutations while editing.
    let timer = 0;
    let pendingAfterSuppress = false;
    const schedulePull = () => {
        if (disposed) return;
        if (isSuppressed()) {
            pendingAfterSuppress = true;
            return;
        }
        if (timer) window.clearTimeout(timer);
        timer = window.setTimeout(() => {
            timer = 0;
            pullFromUniver();
        }, 600);
    };

    // Drain pulls that were deferred during workbook bootstrap/replace.
    const suppressWatcher = window.setInterval(() => {
        if (disposed) return;
        if (pendingAfterSuppress && !isSuppressed()) {
            pendingAfterSuppress = false;
            schedulePull();
        }
    }, 200);
    disposers.push(() => window.clearInterval(suppressWatcher));

    try {
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
            const id = window.setInterval(() => {
                if (!disposed && opts.container.isConnected && !isSuppressed()) schedulePull();
            }, 3000);
            disposers.push(() => window.clearInterval(id));
        }

        const handleSelection = (params: unknown) => {
            try {
                const fallback = univerAPI.getActiveWorkbook()?.getActiveSheet()?.getSheetId?.() ?? null;
                const sel = extractSelection(params, fallback);
                if (!sel) return;
                lastSelection = sel;
                opts.onSelectionChange?.(sel);
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
            if (disposed) return;
            // Commit any pending edits before tearing down.
            if (timer) {
                window.clearTimeout(timer);
                timer = 0;
            }
            try { pullFromUniver(true); } catch { /* ignore */ }
            disposed = true;
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
        syncMeta: (doc: ConceptGridDocument) => {
            // Keep host snapshot aligned with NL meta without remounting Univer.
            liveDoc = structuredClone(doc) as ConceptGridDocument;
            contentFp = conceptGridContentFingerprint(liveDoc);
        },
        setActiveSheet: (sheetId: string) => {
            tryActivateSheet(univerAPI, sheetId);
        },
        getActiveCell: () => {
            if (lastSelection) return lastSelection;
            try {
                const sheet = univerAPI.getActiveWorkbook()?.getActiveSheet?.();
                const sheetId = sheet?.getSheetId?.();
                if (!sheetId) return null;
                return null; // no reliable selection without events — don't fake 0,0
            } catch {
                return null;
            }
        },
        flush: () => {
            if (timer) {
                window.clearTimeout(timer);
                timer = 0;
            }
            pullFromUniver(true);
        },
        focus: () => {
            opts.container.querySelector<HTMLElement>('[contenteditable], canvas, .univer-workbook')?.focus?.();
        },
    };
}

function tryActivateSheet(univerAPI: UniverAPI, sheetId?: string): void {
    if (!sheetId) return;
    try {
        const wb = univerAPI.getActiveWorkbook?.();
        if (!wb) return;
        if (typeof wb.setActiveSheet === 'function') {
            wb.setActiveSheet(sheetId);
            return;
        }
        const sheet = wb.getSheetBySheetId?.(sheetId);
        sheet?.activate?.();
    } catch { /* ignore */ }
}

function pickMeta(doc: ConceptGridDocument): unknown {
    return doc.pages.map(p => ({
        id: p.id,
        cells: Object.fromEntries(
            Object.entries(p.cells || {}).map(([k, c]) => [k, {
                linkedSceneId: c?.linkedSceneId,
                manualContent: c?.manualContent,
            }]),
        ),
        rows: (p.rows || []).map(r => ({ id: r.id, sourceId: r.sourceId, sourceType: r.sourceType })),
        columns: (p.columns || []).map(c => ({ id: c.id, sourceId: c.sourceId, sourceType: c.sourceType })),
    }));
}

export type { ConceptGridDocument };
