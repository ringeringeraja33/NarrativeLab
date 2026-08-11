/**
 * Lazy-loaded Univer Sheets host for the Concept Grid (Plot Grid) view.
 * Bundled separately as plotgrid-univer.js to keep main.js lean.
 */
import { createUniver, LocaleType, mergeLocales } from '@univerjs/presets';
import type { Univer } from '@univerjs/core';
import { UniverSheetsCorePreset } from '@univerjs/preset-sheets-core';
import { UniverSheetsFilterPreset } from '@univerjs/preset-sheets-filter';
import { InsertFunctionOperation } from '@univerjs/sheets-formula-ui';
import { IMenuManagerService, RibbonFormulasGroup } from '@univerjs/ui';
import sheetsCoreEnUS from '@univerjs/preset-sheets-core/locales/en-US';
import sheetsCoreZhCN from '@univerjs/preset-sheets-core/locales/zh-CN';
import sheetsFilterEnUS from '@univerjs/preset-sheets-filter/locales/en-US';
import sheetsFilterZhCN from '@univerjs/preset-sheets-filter/locales/zh-CN';

import sheetsCoreCss from '@univerjs/preset-sheets-core/lib/index.css';

function injectUniverCss(activeDocument: Document): void {
    const id = 'narrativelab-univer-sheets-css';
    if (activeDocument.getElementById(id)) return;
    // Univer's lazy bundle exports its stylesheet as text, so it is attached
    // when the sheet host is first mounted.
    const style = activeDocument.createElement('style');
    style.id = id;
    style.textContent = typeof sheetsCoreCss === 'string' ? sheetsCoreCss : String(sheetsCoreCss);
    activeDocument.head.appendChild(style);
}

import type { CellData, ConceptGridDocument } from '../models/PlotGridData';
import {
    conceptGridContentFingerprint,
    documentToUniverWorkbookData,
    mergeUniverCellDataIntoDocument,
} from './PlotGridXlsxCodec';

export interface PlotGridUniverHostOptions {
    container: HTMLElement;
    initialDocument: ConceptGridDocument;
    locale: 'en' | 'zh';
    /**
     * Latest NarrativeLab document (may include link/meta edits that live outside Univer).
     * Pull merges Univer cell values into this snapshot so metadata is not erased.
     */
    getAuthoritativeDocument?: () => ConceptGridDocument;
    /** Resolve a linked vault path to the title shown in the cell badge. */
    resolveLinkedLabel?: (path: string) => string;
    onDocumentChange: (doc: ConceptGridDocument) => void;
    onSelectionChange?: (info: { sheetId: string; row: number; col: number }) => void;
}

export interface PlotGridUniverHost {
    dispose: () => void;
    getDocument: () => ConceptGridDocument;
    setDocument: (doc: ConceptGridDocument) => void;
    /** Update host's metadata snapshot without recreating the workbook. */
    syncMeta: (doc: ConceptGridDocument) => void;
    /** Redraw link badges without replacing workbook content or selection. */
    refreshLinkMarkers: () => void;
    setActiveSheet: (sheetId: string) => void;
    /** Apply NarrativeLab's legacy view controls to the embedded worksheet. */
    setZoom: (sheetId: string, ratio: number) => void;
    setFreeze: (sheetId: string, enabled: boolean) => void;
    setActiveCell: (sheetId: string, row: number, col: number) => void;
    getActiveCell: () => { sheetId: string; row: number; col: number } | null;
    /** Force a sync pull from Univer cell matrix into the live document. */
    flush: () => void;
    focus: () => void;
}

type PlotGridCellRender = {
    zIndex?: number;
    drawWith: (ctx: CanvasRenderingContext2D, info: {
        subUnitId: string;
        row: number;
        col: number;
        primaryWithCoord: { startX: number; startY: number; endX: number; endY: number };
    }) => void;
};

type UniverAPI = {
    createWorkbook: (data: Record<string, unknown>) => unknown;
    getActiveWorkbook: () => {
        getId: () => string;
        getActiveSheet: () => { getSheetId: () => string; refreshCanvas?: () => unknown } | null;
        getActiveCell?: () => {
            getSheetId?: () => string;
            getRow?: () => number;
            getColumn?: () => number;
            getRange?: () => { startRow?: number; startColumn?: number };
        } | null;
        getSheetBySheetId: (id: string) => {
            getSheetId: () => string;
            activate?: () => void;
            zoom?: (ratio: number) => unknown;
            setFreeze?: (freeze: { startRow: number; startColumn: number; xSplit: number; ySplit: number }) => unknown;
            cancelFreeze?: () => unknown;
            refreshCanvas?: () => unknown;
            getRange: (r: number, c: number) => {
                getValue: () => unknown;
                getCellData: () => { v?: unknown } | null;
                activate?: () => unknown;
            };
            getCellMatrix?: () => { getMatrix: () => unknown };
        } | null;
        setActiveSheet?: (id: string) => void;
        save: () => Record<string, unknown>;
    } | null;
    addEvent: (event: string | number, cb: (params: unknown) => void) => { dispose?: () => void } | number;
    getSheetHooks?: () => {
        onCellRender?: (renders: PlotGridCellRender[]) => { dispose?: () => void };
    };
    removeEvent?: (id: unknown) => void;
    disposeUnit?: (unitId: string) => void;
    dispose?: () => void;
};

const FINANCIAL_FORMULA_MENU_ORDER = 99;
const TEXT_TO_NUMBER_TOOLBAR_MENU_ID = 'sheet.toolbar.text-to-number';

function linkedCellAt(doc: ConceptGridDocument, sheetId: string, row: number, col: number): CellData | null {
    if (row < 1 || col < 1) return null;
    const page = doc.pages.find(item => item.id === sheetId);
    const rowMeta = page?.rows[row - 1];
    const colMeta = page?.columns[col - 1];
    if (!page || !rowMeta || !colMeta) return null;
    return page.cells[`${rowMeta.id}-${colMeta.id}`] || null;
}

function linkedPathLabel(path: string): string {
    const name = path.split('/').pop() || path;
    return name.replace(/\.[^.]+$/, '') || name;
}

function fitCanvasLabel(ctx: CanvasRenderingContext2D, label: string, maxWidth: number): string {
    const prefix = '🔗 ';
    const full = `${prefix}${label}`;
    if (ctx.measureText(full).width <= maxWidth) return full;
    if (ctx.measureText('🔗').width > maxWidth) return '';
    let shortened = label;
    while (shortened.length > 1 && ctx.measureText(`${prefix}${shortened}…`).width > maxWidth) {
        shortened = shortened.slice(0, -1);
    }
    return shortened.length > 1 ? `${prefix}${shortened}…` : '🔗';
}

function roundedRect(
    ctx: CanvasRenderingContext2D,
    x: number,
    y: number,
    width: number,
    height: number,
    radius: number,
): void {
    const r = Math.min(radius, width / 2, height / 2);
    ctx.beginPath();
    ctx.moveTo(x + r, y);
    ctx.lineTo(x + width - r, y);
    ctx.quadraticCurveTo(x + width, y, x + width, y + r);
    ctx.lineTo(x + width, y + height - r);
    ctx.quadraticCurveTo(x + width, y + height, x + width - r, y + height);
    ctx.lineTo(x + r, y + height);
    ctx.quadraticCurveTo(x, y + height, x, y + height - r);
    ctx.lineTo(x, y + r);
    ctx.quadraticCurveTo(x, y, x + r, y);
    ctx.closePath();
}

function moveFinancialFormulaMenuLast(univer: Univer): void {
    try {
        // Univer exposes this menu registry through an internal injector without
        // complete public TypeScript declarations in 0.25.x.
        // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-member-access
        const menuManager = univer.__getInjector().get(IMenuManagerService);
        // eslint-disable-next-line @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-member-access
        menuManager.mergeMenu({
            [RibbonFormulasGroup.BASIC]: {
                [`${InsertFunctionOperation.id}.financial`]: {
                    order: FINANCIAL_FORMULA_MENU_ORDER,
                },
            },
        });
    } catch (e) {
        console.warn('[NarrativeLab] Failed to reorder Univer formula menus:', e);
    }
}

function extractSelection(params: unknown, fallbackSheetId?: string | null): { sheetId: string; row: number; col: number } | null {
    const p = params as {
        sheetId?: string;
        worksheet?: { getSheetId?: () => string };
        row?: number;
        column?: number;
        col?: number;
        selections?: Array<
            | {
                range?: { startRow?: number; startColumn?: number };
                startRow?: number;
                startColumn?: number;
                getRange?: () => { startRow?: number; startColumn?: number };
                getRow?: () => number;
                getColumn?: () => number;
                getSheetId?: () => string;
            }
            | { startRow?: number; startColumn?: number }
        >;
    };
    const first = p.selections?.[0];
    const facadeRange = first && 'getRange' in first ? first.getRange?.() : undefined;
    const range = facadeRange || (first && 'range' in first && first.range ? first.range : first);
    const row = p.row ?? (first && 'getRow' in first && typeof first.getRow === 'function'
        ? first.getRow()
        : (range && typeof range === 'object' ? (range as { startRow?: number }).startRow : undefined));
    const col = p.column ?? p.col ?? (first && 'getColumn' in first && typeof first.getColumn === 'function'
        ? first.getColumn()
        : (range && typeof range === 'object' ? (range as { startColumn?: number }).startColumn : undefined));
    const sheetId = p.sheetId
        || (first && 'getSheetId' in first ? first.getSheetId?.() : undefined)
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
    let liveDoc = structuredClone(opts.initialDocument);
    let contentFp = conceptGridContentFingerprint(liveDoc);
    const locale = opts.locale === 'zh' ? LocaleType.ZH_CN : LocaleType.EN_US;
    const locales = opts.locale === 'zh'
        ? { [LocaleType.ZH_CN]: mergeLocales(sheetsCoreZhCN, sheetsFilterZhCN) }
        : { [LocaleType.EN_US]: mergeLocales(sheetsCoreEnUS, sheetsFilterEnUS) };

    injectUniverCss(opts.container.ownerDocument);

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
    let univerInstance: Univer;
    try {
        ({ univer: univerInstance, univerAPI } = createUniver({
            locale,
            locales,
            presets: [
                UniverSheetsCorePreset({
                    container: opts.container,
                    footer: false,
                    ribbonType: 'simple',
                    // NarrativeLab owns the cell context menu so note links,
                    // conversions and row/column actions stay in one menu.
                    contextMenu: false,
                    menu: {
                        [TEXT_TO_NUMBER_TOOLBAR_MENU_ID]: { hidden: true },
                    },
                }),
                UniverSheetsFilterPreset(),
            ],
        }) as unknown as { univer: Univer; univerAPI: UniverAPI });
    } catch {
        ({ univer: univerInstance, univerAPI } = createUniver({
            locale,
            locales,
            presets: [
                UniverSheetsCorePreset({
                    container: opts.container,
                    ribbonType: 'simple',
                    contextMenu: false,
                    menu: {
                        [TEXT_TO_NUMBER_TOOLBAR_MENU_ID]: { hidden: true },
                    },
                }),
                UniverSheetsFilterPreset(),
            ],
        }) as unknown as { univer: Univer; univerAPI: UniverAPI });
    }

    const workbookData = documentToUniverWorkbookData(liveDoc);
    univerAPI.createWorkbook(workbookData);
    moveFinancialFormulaMenuLast(univerInstance);
    tryActivateSheet(univerAPI, liveDoc.activePageId);

    let disposed = false;
    let suppressUntil = 0;
    let lastSelection: { sheetId: string; row: number; col: number } | null = null;
    const disposers: Array<() => void> = [];

    const refreshLinkMarkers = () => {
        try {
            univerAPI.getActiveWorkbook?.()?.getActiveSheet?.()?.refreshCanvas?.();
        } catch { /* drawing is cosmetic */ }
    };

    try {
        const linkBadgeRender: PlotGridCellRender = {
            zIndex: 100,
            drawWith: (ctx, info) => {
                const source = opts.getAuthoritativeDocument?.() ?? liveDoc;
                const cell = linkedCellAt(source, info.subUnitId, info.row, info.col);
                const path = cell?.linkedSceneId;
                if (!path) return;

                const { startX, startY, endX, endY } = info.primaryWithCoord;
                const cellWidth = endX - startX;
                const cellHeight = endY - startY;
                if (cellWidth < 18 || cellHeight < 14) return;

                let label = linkedPathLabel(path);
                try { label = opts.resolveLinkedLabel?.(path) || label; } catch { /* keep filename */ }

                ctx.save();
                ctx.beginPath();
                ctx.rect(startX + 1, startY + 1, cellWidth - 2, cellHeight - 2);
                ctx.clip();
                ctx.font = '600 10px -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif';
                ctx.textBaseline = 'middle';
                const maxBadgeWidth = Math.min(180, cellWidth - 6);
                const text = fitCanvasLabel(ctx, label, maxBadgeWidth - 10);
                if (!text) {
                    ctx.restore();
                    return;
                }
                const badgeHeight = Math.min(18, cellHeight - 6);
                const badgeWidth = Math.min(maxBadgeWidth, Math.ceil(ctx.measureText(text).width) + 10);
                const x = endX - badgeWidth - 3;
                const y = startY + 3;
                roundedRect(ctx, x, y, badgeWidth, badgeHeight, 5);
                ctx.fillStyle = 'rgba(47, 101, 220, 0.94)';
                ctx.fill();
                ctx.fillStyle = '#ffffff';
                ctx.fillText(text, x + 5, y + badgeHeight / 2);
                ctx.restore();
            },
        };
        const renderHook = univerAPI.getSheetHooks?.().onCellRender?.([linkBadgeRender]);
        if (renderHook && typeof renderHook.dispose === 'function') {
            disposers.push(() => renderHook.dispose?.());
        }
        refreshLinkMarkers();
    } catch (e) {
        console.warn('[NarrativeLab] Univer link badge renderer unavailable:', e);
    }

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
                styles?: Record<string, {
                    bg?: { rgb?: string } | null;
                    cl?: { rgb?: string } | null;
                    bl?: number | boolean | null;
                    it?: number | boolean | null;
                    ht?: number | null;
                }>;
                sheets?: Record<string, {
                    id?: string;
                    cellData?: Record<number, Record<number, { v?: unknown; f?: unknown; s?: unknown }>>;
                    rowData?: Record<number, { h?: number; ah?: number }>;
                    columnData?: Record<number, { w?: number }>;
                }>;
            } | undefined;
            if (!saved?.sheets) return;

            // Always merge into the latest NL document so link/meta edits survive.
            const base = structuredClone(
                (opts.getAuthoritativeDocument?.() ?? liveDoc),
            );

            let next = base;
            for (const sheet of Object.values(saved.sheets)) {
                const id = sheet.id;
                if (!id || !sheet.cellData) continue;
                next = mergeUniverCellDataIntoDocument(
                    next,
                    id,
                    sheet.cellData,
                    saved.styles,
                    sheet.rowData,
                    sheet.columnData,
                );
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
            Event?: {
                CommandExecuted?: string;
                SelectionChanged?: string;
                CellPointerDown?: string;
            };
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
        // SelectionChanged may lag or be skipped when NarrativeLab's toolbar
        // takes focus immediately after a sheet click. PointerDown carries the
        // exact row/column and keeps link-note actions in sync.
        if (api.Event?.CellPointerDown) {
            const sub = univerAPI.addEvent(api.Event.CellPointerDown, handleSelection);
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
            liveDoc = structuredClone(doc);
            contentFp = conceptGridContentFingerprint(liveDoc);
            replaceWorkbook(liveDoc);
        },
        syncMeta: (doc: ConceptGridDocument) => {
            // Keep host snapshot aligned with NL meta without remounting Univer.
            liveDoc = structuredClone(doc);
            contentFp = conceptGridContentFingerprint(liveDoc);
            refreshLinkMarkers();
        },
        refreshLinkMarkers,
        setActiveSheet: (sheetId: string) => {
            tryActivateSheet(univerAPI, sheetId);
        },
        setZoom: (sheetId: string, ratio: number) => {
            const sheet = univerAPI.getActiveWorkbook?.()?.getSheetBySheetId?.(sheetId);
            sheet?.zoom?.(Math.min(4, Math.max(0.1, ratio)));
        },
        setFreeze: (sheetId: string, enabled: boolean) => {
            const sheet = univerAPI.getActiveWorkbook?.()?.getSheetBySheetId?.(sheetId);
            if (!sheet) return;
            if (enabled) {
                sheet.setFreeze?.({ startRow: 1, startColumn: 1, xSplit: 1, ySplit: 1 });
            } else {
                sheet.cancelFreeze?.();
            }
        },
        setActiveCell: (sheetId: string, row: number, col: number) => {
            const sheet = univerAPI.getActiveWorkbook?.()?.getSheetBySheetId?.(sheetId);
            sheet?.getRange?.(row, col)?.activate?.();
            lastSelection = { sheetId, row, col };
        },
        getActiveCell: () => {
            try {
                const workbook = univerAPI.getActiveWorkbook?.();
                const active = workbook?.getActiveCell?.();
                if (active) {
                    const range = active.getRange?.();
                    const sheetId = active.getSheetId?.() || workbook?.getActiveSheet?.()?.getSheetId?.();
                    const row = active.getRow?.() ?? range?.startRow;
                    const col = active.getColumn?.() ?? range?.startColumn;
                    if (sheetId != null && row != null && col != null) return { sheetId, row, col };
                }
            } catch {
                // Fall through to the last event-backed selection.
            }
            return lastSelection;
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
                formula: c?.formula,
                manualContent: c?.manualContent,
                bgColor: c?.bgColor,
                textColor: c?.textColor,
                bold: c?.bold,
                italic: c?.italic,
                align: c?.align,
            }]),
        ),
        rows: (p.rows || []).map(r => ({ id: r.id, height: r.height, sourceId: r.sourceId, sourceType: r.sourceType })),
        columns: (p.columns || []).map(c => ({ id: c.id, width: c.width, sourceId: c.sourceId, sourceType: c.sourceType })),
    }));
}

export type { ConceptGridDocument };
