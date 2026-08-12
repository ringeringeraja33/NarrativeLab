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
import { Menu } from 'obsidian';

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
    moveConceptGridAxis,
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
    /** Run a NarrativeLab action from Univer's native cell context menu. */
    onContextMenuAction?: (action: PlotGridUniverContextAction) => void;
    onDocumentChange: (doc: ConceptGridDocument) => void;
    onSelectionChange?: (info: { sheetId: string; row: number; col: number }) => void;
}

export type PlotGridUniverContextAction =
    | 'open-linked-note'
    | 'convert-to-notes'
    | 'convert-to-scene'
    | 'convert-to-research'
    | 'reset-grid';

export interface PlotGridUniverHost {
    dispose: () => void;
    getDocument: () => ConceptGridDocument;
    setDocument: (doc: ConceptGridDocument) => void;
    /** Update host's metadata snapshot without recreating the workbook. */
    syncMeta: (doc: ConceptGridDocument) => void;
    setActiveSheet: (sheetId: string) => void;
    /** Apply NarrativeLab's legacy view controls to the embedded worksheet. */
    setZoom: (sheetId: string, ratio: number) => void;
    setFreeze: (sheetId: string, enabled: boolean, frozenColumns?: number, frozenRows?: number) => void;
    setActiveCell: (sheetId: string, row: number, col: number) => void;
    getActiveCell: () => { sheetId: string; row: number; col: number } | null;
    /** Force a sync pull from Univer cell matrix into the live document. */
    flush: () => void;
    focus: () => void;
}

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
    createMenu: (item: {
        id: string;
        title: string;
        action: () => void;
        order?: number;
    }) => UniverMenuBuilder;
    removeEvent?: (id: unknown) => void;
    disposeUnit?: (unitId: string) => void;
    dispose?: () => void;
};

type UniverMenuBuilder = {
    appendTo: (path: string | string[]) => void;
};

function addUniverSubscriptionDisposer(
    disposers: Array<() => void>,
    univerAPI: UniverAPI,
    subscription: unknown,
): void {
    disposers.push(() => {
        if (typeof subscription === 'function') {
            const dispose = subscription as () => void;
            dispose();
            return;
        }
        if (subscription && typeof subscription === 'object') {
            const disposable = subscription as { dispose?: () => void; unsubscribe?: () => void };
            if (typeof disposable.dispose === 'function') disposable.dispose();
            else disposable.unsubscribe?.();
            return;
        }
        if (subscription != null) univerAPI.removeEvent?.(subscription);
    });
}

const FINANCIAL_FORMULA_MENU_ORDER = 99;
const TEXT_TO_NUMBER_TOOLBAR_MENU_ID = 'sheet.toolbar.text-to-number';

function registerNarrativeLabContextMenu(
    univerAPI: UniverAPI,
    locale: 'en' | 'zh',
    container: HTMLElement,
    onAction?: (action: PlotGridUniverContextAction) => void,
): () => void {
    if (!onAction) return () => undefined;
    const labels = locale === 'zh'
        ? {
            root: 'NarrativeLab',
            notes: '转为笔记',
            scene: '转为场景',
            research: '转为研究资料',
            reset: '重置表格',
        }
        : {
            root: 'NarrativeLab',
            notes: 'Convert to Notes',
            scene: 'Convert to Scene',
            research: 'Convert to Research',
            reset: 'Reset spreadsheet',
        };
    let menuPosition = { x: 0, y: 0 };
    const rememberPosition = (event: MouseEvent) => {
        menuPosition = { x: event.clientX, y: event.clientY };
    };
    container.addEventListener('contextmenu', rememberPosition, true);
    const openActionsMenu = () => {
        const menu = new Menu();
        const add = (title: string, icon: string, action: PlotGridUniverContextAction) => {
            menu.addItem(item => item
                .setTitle(title)
                .setIcon(icon)
                .onClick(() => onAction(action)));
        };
        add(labels.notes, 'notebook-pen', 'convert-to-notes');
        add(labels.scene, 'clapperboard', 'convert-to-scene');
        add(labels.research, 'search', 'convert-to-research');
        menu.addSeparator();
        add(labels.reset, 'rotate-ccw', 'reset-grid');
        menu.showAtPosition(menuPosition);
    };
    univerAPI.createMenu({
        id: 'narrativelab.plot-grid.context-menu',
        title: `${labels.root}…`,
        action: openActionsMenu,
        order: 1000,
    })
        .appendTo(['contextMenu.mainArea', 'contextMenu.others']);
    return () => container.removeEventListener('contextmenu', rememberPosition, true);
}

function linkedCellAt(doc: ConceptGridDocument, sheetId: string, row: number, col: number): CellData | null {
    if (row < 1 || col < 1) return null;
    const page = doc.pages.find(item => item.id === sheetId);
    const rowMeta = page?.rows[row - 1];
    const colMeta = page?.columns[col - 1];
    if (!page || !rowMeta || !colMeta) return null;
    return page.cells[`${rowMeta.id}-${colMeta.id}`] || null;
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

type DimensionMutation = {
    id?: string;
    params?: {
        subUnitId?: string;
        ranges?: Array<{ startRow?: number; endRow?: number; startColumn?: number; endColumn?: number }>;
        rowHeight?: number | Record<number, number>;
        colWidth?: number | Record<number, number>;
    };
};

type AxisMoveMutation = {
    id?: string;
    params?: {
        subUnitId?: string;
        sourceRange?: { startRow?: number; endRow?: number; startColumn?: number; endColumn?: number };
        targetRange?: { startRow?: number; startColumn?: number };
    };
};

function dimensionAt(value: number | Record<number, number> | undefined, index: number): number | undefined {
    return typeof value === 'number' ? value : value?.[index];
}

/** Apply resize mutations directly; workbook.save() can lag behind drag completion. */
function applyDimensionMutation(doc: ConceptGridDocument, command: unknown): ConceptGridDocument | null {
    const { id, params } = command as DimensionMutation;
    if (!params?.subUnitId || !Array.isArray(params.ranges)) return null;
    const isRow = id === 'sheet.mutation.set-worksheet-row-height';
    const isColumn = id === 'sheet.mutation.set-worksheet-col-width';
    if (!isRow && !isColumn) return null;
    const next = structuredClone(doc);
    const page = next.pages.find(item => item.id === params.subUnitId);
    if (!page) return null;
    for (const range of params.ranges) {
        if (isRow) {
            const start = range.startRow ?? 0;
            const end = range.endRow ?? start;
            for (let worksheetRow = start; worksheetRow <= end; worksheetRow += 1) {
                const height = dimensionAt(params.rowHeight, worksheetRow);
                const row = page.rows[worksheetRow - 1];
                if (worksheetRow > 0 && height != null && height > 0 && row) {
                    row.height = height;
                }
            }
        } else {
            const start = range.startColumn ?? 0;
            const end = range.endColumn ?? start;
            for (let worksheetColumn = start; worksheetColumn <= end; worksheetColumn += 1) {
                const width = dimensionAt(params.colWidth, worksheetColumn);
                const column = page.columns[worksheetColumn - 1];
                if (worksheetColumn > 0 && width != null && width > 0 && column) {
                    column.width = width;
                }
            }
        }
    }
    return next;
}

function applyAxisMoveMutation(doc: ConceptGridDocument, command: unknown): ConceptGridDocument | null {
    const { id, params } = command as AxisMoveMutation;
    if (!params?.subUnitId || !params.sourceRange || !params.targetRange) return null;
    if (id === 'sheet.mutation.move-rows') {
        const from = params.sourceRange.startRow;
        const end = params.sourceRange.endRow;
        const target = params.targetRange.startRow;
        if (from == null || end == null || target == null) return null;
        return moveConceptGridAxis(doc, params.subUnitId, 'rows', from, end - from + 1, target);
    }
    if (id === 'sheet.mutation.move-columns') {
        const from = params.sourceRange.startColumn;
        const end = params.sourceRange.endColumn;
        const target = params.targetRange.startColumn;
        if (from == null || end == null || target == null) return null;
        return moveConceptGridAxis(doc, params.subUnitId, 'columns', from, end - from + 1, target);
    }
    return null;
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
                    toolbar: true,
                    formulaBar: true,
                    // Simple ribbon is Univer's own compact layout. It keeps
                    // the complete command registry in the overflow menu.
                    ribbonType: 'simple',
                    contextMenu: true,
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
                    toolbar: true,
                    formulaBar: true,
                    ribbonType: 'simple',
                    contextMenu: true,
                    menu: {
                        [TEXT_TO_NUMBER_TOOLBAR_MENU_ID]: { hidden: true },
                    },
                }),
                UniverSheetsFilterPreset(),
            ],
        }) as unknown as { univer: Univer; univerAPI: UniverAPI });
    }

    const nativeLinkColor = getComputedStyle(opts.container).getPropertyValue('--link-color').trim()
        || getComputedStyle(opts.container).getPropertyValue('--interactive-accent').trim()
        || '#5e6ad2';
    let nativeRichTextEnabled = true;
    const disposeActiveWorkbook = () => {
        try {
            const existing = univerAPI.getActiveWorkbook?.();
            const unitId = existing?.getId?.();
            if (unitId && typeof univerAPI.disposeUnit === 'function') univerAPI.disposeUnit(unitId);
        } catch { /* ignore cleanup failures */ }
    };
    const createNativeWorkbook = (doc: ConceptGridDocument) => {
        const workbookData = documentToUniverWorkbookData(doc, {
            linkColor: nativeLinkColor,
            richText: nativeRichTextEnabled,
        });
        try {
            return univerAPI.createWorkbook(workbookData);
        } catch (error) {
            if (!nativeRichTextEnabled) throw error;
            console.warn('[NarrativeLab] Univer rich-text cells failed; retrying with native plain cells.', error);
            disposeActiveWorkbook();
            nativeRichTextEnabled = false;
            return univerAPI.createWorkbook(documentToUniverWorkbookData(doc, {
                linkColor: nativeLinkColor,
                richText: false,
            }));
        }
    };
    createNativeWorkbook(liveDoc);
    moveFinancialFormulaMenuLast(univerInstance);
    tryActivateSheet(univerAPI, liveDoc.activePageId);

    let disposed = false;
    let suppressUntil = 0;
    let lastSelection: { sheetId: string; row: number; col: number } | null = null;
    const disposers: Array<() => void> = [];
    try {
        disposers.push(registerNarrativeLabContextMenu(
            univerAPI,
            opts.locale,
            opts.container,
            opts.onContextMenuAction,
        ));
    } catch (error) {
        // A NarrativeLab extension must never take down Univer's native menu.
        console.warn('[NarrativeLab] Could not extend the Univer context menu.', error);
    }

    const isSuppressed = () => disposed || Date.now() < suppressUntil;

    const replaceWorkbook = (doc: ConceptGridDocument) => {
        suppressUntil = Date.now() + 800;
        disposeActiveWorkbook();
        createNativeWorkbook(doc);
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
                    cellData?: Record<number, Record<number, {
                        v?: unknown;
                        f?: unknown;
                        p?: unknown;
                        custom?: Record<string, unknown>;
                        s?: unknown;
                    }>>;
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
    let suppressDrainTimer = 0;
    const scheduleSuppressedDrain = () => {
        if (suppressDrainTimer || disposed) return;
        const delay = Math.max(16, suppressUntil - Date.now() + 16);
        suppressDrainTimer = window.setTimeout(() => {
            suppressDrainTimer = 0;
            if (disposed || !pendingAfterSuppress) return;
            if (isSuppressed()) {
                scheduleSuppressedDrain();
                return;
            }
            pendingAfterSuppress = false;
            schedulePull();
        }, delay);
    };
    const schedulePull = () => {
        if (disposed) return;
        if (isSuppressed()) {
            pendingAfterSuppress = true;
            scheduleSuppressedDrain();
            return;
        }
        if (timer) window.clearTimeout(timer);
        timer = window.setTimeout(() => {
            timer = 0;
            pullFromUniver();
        }, 600);
    };

    disposers.push(() => {
        if (suppressDrainTimer) window.clearTimeout(suppressDrainTimer);
        suppressDrainTimer = 0;
    });

    try {
        const api = univerAPI as UniverAPI & {
            Event?: {
                CommandExecuted?: string;
                SelectionChanged?: string;
                CellPointerDown?: string;
            };
            onCommandExecuted?: (cb: (c: unknown) => void) => unknown;
        };
        if (api.Event?.CommandExecuted) {
            const sub = univerAPI.addEvent(api.Event.CommandExecuted, (command) => {
                const authoritative = opts.getAuthoritativeDocument?.() ?? liveDoc;
                const mutated = applyDimensionMutation(authoritative, command)
                    ?? applyAxisMoveMutation(authoritative, command);
                if (mutated) {
                    liveDoc = mutated;
                    contentFp = conceptGridContentFingerprint(liveDoc);
                    opts.onDocumentChange(liveDoc);
                }
                schedulePull();
            });
            addUniverSubscriptionDisposer(disposers, univerAPI, sub);
        } else if (typeof api.onCommandExecuted === 'function') {
            const sub = api.onCommandExecuted(() => schedulePull());
            addUniverSubscriptionDisposer(disposers, univerAPI, sub);
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
            addUniverSubscriptionDisposer(disposers, univerAPI, sub);
        }
        // SelectionChanged may lag or be skipped when NarrativeLab's toolbar
        // takes focus immediately after a sheet click. PointerDown carries the
        // exact row/column and keeps toolbar actions in sync.
        if (api.Event?.CellPointerDown) {
            const sub = univerAPI.addEvent(api.Event.CellPointerDown, (params) => {
                handleSelection(params);
                const event = (params as { event?: MouseEvent | PointerEvent }).event;
                if (!(event?.metaKey || event?.ctrlKey) || !lastSelection) return;
                const source = opts.getAuthoritativeDocument?.() ?? liveDoc;
                if (linkedCellAt(source, lastSelection.sheetId, lastSelection.row, lastSelection.col)?.linkedSceneId) {
                    opts.onContextMenuAction?.('open-linked-note');
                }
            });
            addUniverSubscriptionDisposer(disposers, univerAPI, sub);
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
            if (suppressDrainTimer) {
                window.clearTimeout(suppressDrainTimer);
                suppressDrainTimer = 0;
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
        },
        setActiveSheet: (sheetId: string) => {
            tryActivateSheet(univerAPI, sheetId);
        },
        setZoom: (sheetId: string, ratio: number) => {
            const sheet = univerAPI.getActiveWorkbook?.()?.getSheetBySheetId?.(sheetId);
            sheet?.zoom?.(Math.min(4, Math.max(0.1, ratio)));
        },
        setFreeze: (sheetId: string, enabled: boolean, frozenColumns = 1, frozenRows = 1) => {
            const sheet = univerAPI.getActiveWorkbook?.()?.getSheetBySheetId?.(sheetId);
            if (!sheet) return;
            if (enabled) {
                const columnCount = Math.max(1, Math.floor(frozenColumns));
                const rowCount = Math.max(1, Math.floor(frozenRows));
                sheet.setFreeze?.({
                    startRow: rowCount,
                    startColumn: columnCount,
                    xSplit: columnCount,
                    ySplit: rowCount,
                });
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
                linkedViaWikilink: c?.linkedViaWikilink,
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
        frozenColumns: p.frozenColumns,
        frozenRows: p.frozenRows,
    }));
}

export type { ConceptGridDocument };
