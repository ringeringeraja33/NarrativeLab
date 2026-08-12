/**
 * Lazy-loaded Univer Sheets host for the Concept Grid (Plot Grid) view.
 * Bundled separately as plotgrid-univer.js to keep main.js lean.
 */
import { createUniver, LocaleType, mergeLocales } from '@univerjs/presets';
import type { Univer } from '@univerjs/core';
import { UniverSheetsCorePreset } from '@univerjs/preset-sheets-core';
import { UniverSheetsFilterPreset } from '@univerjs/preset-sheets-filter';
import { InsertFunctionOperation } from '@univerjs/sheets-formula-ui';
import { IMenuManagerService, RibbonFormulasGroup, RibbonPosition } from '@univerjs/ui';
import sheetsCoreEnUS from '@univerjs/preset-sheets-core/locales/en-US';
import sheetsCoreZhCN from '@univerjs/preset-sheets-core/locales/zh-CN';
import sheetsFilterEnUS from '@univerjs/preset-sheets-filter/locales/en-US';
import sheetsFilterZhCN from '@univerjs/preset-sheets-filter/locales/zh-CN';

import sheetsCoreCss from '@univerjs/preset-sheets-core/lib/index.css';

function withNarrativeLabZhTerminology(base: unknown): Record<string, unknown> {
    const locale = (base && typeof base === 'object' ? base : {}) as Record<string, unknown>;
    const sheetsUi = (locale['sheets-ui'] && typeof locale['sheets-ui'] === 'object'
        ? locale['sheets-ui']
        : {}) as Record<string, unknown>;
    const rightClick = (sheetsUi.rightClick && typeof sheetsUi.rightClick === 'object'
        ? sheetsUi.rightClick
        : {}) as Record<string, unknown>;
    return {
        ...locale,
        'sheets-ui': {
            ...sheetsUi,
            rightClick: {
                ...rightClick,
                freeze: '固定',
                freezeCell: '固定至活动单元格（{0}行{1}列）',
                freezeCol: '固定至第 {0} 列',
                freezeRow: '固定至第 {0} 行',
                freezeFirstCol: '固定首列',
                freezeFirstRow: '固定首行',
                cancelFreeze: '取消固定',
            },
        },
    };
}

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
import { cellHasNoteLink } from '../utils/plotGridCellEdit';
import {
    conceptGridContentFingerprint,
    documentToUniverWorkbookData,
    mergeUniverCellDataIntoDocument,
    moveConceptGridAxis,
    preserveConceptGridAxisSizes,
} from './PlotGridXlsxCodec';

export { cellRequiresMarkdownEditor } from '../utils/plotGridCellEdit';

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
    /** Ask the main plugin bundle to show Obsidian's native action menu. */
    onContextMenuRequest?: (position: { x: number; y: number }) => void;
    /** Show the expanded Connected notes menu (filenames → open note). */
    onShowConnectedNotes?: (position: { x: number; y: number }) => void;
    /** Hover card for a linked cell (after a long hover). */
    onShowConnectedNotesHover?: (info: {
        position: { x: number; y: number };
        sheetId: string;
        row: number;
        col: number;
    }) => void;
    /** Hide the hover card when the pointer leaves linked cells. */
    onHideConnectedNotesHover?: () => void;
    /**
     * Return true to cancel Univer's in-cell editor for this coordinate and
     * route editing through NarrativeLab's Markdown cell editor instead.
     */
    shouldBlockUniverCellEdit?: (sheetId: string, row: number, col: number) => boolean;
    /** Open the Markdown cell editor for the given Univer coordinates. */
    onRequestMarkdownCellEdit?: (info: { sheetId: string; row: number; col: number }) => void;
    onDocumentChange: (doc: ConceptGridDocument) => void;
    onSelectionChange?: (info: { sheetId: string; row: number; col: number }) => void;
}

export type PlotGridUniverContextAction =
    | 'open-linked-note'
    | 'link-note'
    | 'unlink-note'
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
    /** Redraw link icons without replacing workbook content or selection. */
    refreshLinkMarkers: () => void;
    setActiveSheet: (sheetId: string) => void;
    /** Rename a worksheet to match NarrativeLab page tabs (Univer footer is hidden). */
    setSheetTitle: (sheetId: string, title: string) => void;
    /** Apply NarrativeLab's legacy view controls to the embedded worksheet. */
    setZoom: (sheetId: string, ratio: number) => void;
    setFreeze: (sheetId: string, enabled: boolean, frozenColumns?: number, frozenRows?: number) => void;
    setActiveCell: (sheetId: string, row: number, col: number) => void;
    getActiveCell: () => { sheetId: string; row: number; col: number } | null;
    /** True while the in-cell / formula editor or IME composition is active. */
    isEditorBusy: () => boolean;
    /** True when a debounced Univer→document pull is waiting (or editor still open). */
    hasPendingSync: () => boolean;
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
    executeCommand?: (id: string, params?: Record<string, unknown>) => unknown;
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
            setName?: (name: string) => unknown;
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
    createMenu: (item: {
        id: string;
        title: string;
        action: () => void;
        order?: number;
    }) => UniverMenuBuilder;
    createSubmenu?: (item: {
        id: string;
        title: string;
        order?: number;
    }) => UniverSubmenuBuilder;
    removeEvent?: (id: unknown) => void;
    disposeUnit?: (unitId: string) => void;
    dispose?: () => void;
};

type UniverMenuBuilder = {
    appendTo: (path: string | string[]) => void;
};

type UniverSubmenuBuilder = {
    addSubmenu: (menu: UniverMenuBuilder | UniverSubmenuBuilder) => UniverSubmenuBuilder;
    addSeparator: () => UniverSubmenuBuilder;
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
const FILTER_TOOLBAR_GROUP_ORDER = -100;

function hideUniverContextMenu(univer: Univer): void {
    try {
        // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-member-access
        const menuService = univer.__getInjector().get('ui.contextmenu.service');
        // eslint-disable-next-line @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-member-access
        menuService?.hideContextMenu?.();
    } catch {
        // Optional — older builds may not expose the service.
    }
}

function registerNarrativeLabContextMenu(
    univerAPI: UniverAPI,
    univer: Univer,
    container: HTMLElement,
    opts: {
        locale: 'en' | 'zh';
        onShowConnectedNotes?: (position: { x: number; y: number }) => void;
        onAction?: (action: PlotGridUniverContextAction) => void;
        onRequest?: (position: { x: number; y: number }) => void;
    },
): () => void {
    let menuPosition = { x: 0, y: 0 };
    const rememberPosition = (event: MouseEvent) => {
        menuPosition = { x: event.clientX, y: event.clientY };
    };
    container.addEventListener('contextmenu', rememberPosition, true);

    const zh = opts.locale === 'zh';
    const connectedTitle = zh ? '已连接笔记' : 'Connected notes';

    const openConnectedNotesMenu = () => {
        hideUniverContextMenu(univer);
        window.setTimeout(() => {
            if (opts.onShowConnectedNotes) opts.onShowConnectedNotes(menuPosition);
            else opts.onRequest?.(menuPosition);
        }, 0);
    };

    // Top-level entry — expands into a filename list (Obsidian menu).
    univerAPI.createMenu({
        id: 'narrativelab.plot-grid.connected',
        title: connectedTitle,
        action: openConnectedNotesMenu,
        order: -200,
    }).appendTo(['contextMenu.mainArea', 'contextMenu.others']);

    if (opts.onAction) {
        const append = (id: string, title: string, action: PlotGridUniverContextAction, order: number) => {
            univerAPI.createMenu({
                id,
                title,
                action: () => opts.onAction?.(action),
                order,
            }).appendTo(['contextMenu.mainArea', 'contextMenu.others']);
        };
        append('narrativelab.plot-grid.link', zh ? '链接笔记…' : 'Link Note…', 'link-note', 1000);
        append('narrativelab.plot-grid.unlink', zh ? '取消链接' : 'Unlink Note', 'unlink-note', 1001);
        append('narrativelab.plot-grid.to-notes', zh ? '转为笔记' : 'Convert to Notes', 'convert-to-notes', 1010);
        append('narrativelab.plot-grid.to-scene', zh ? '转为场景' : 'Convert to Scene', 'convert-to-scene', 1011);
        append('narrativelab.plot-grid.to-research', zh ? '转为调研' : 'Convert to Research', 'convert-to-research', 1012);
        append('narrativelab.plot-grid.reset', zh ? '重置表格' : 'Reset spreadsheet', 'reset-grid', 1020);
    } else if (opts.onRequest) {
        univerAPI.createMenu({
            id: 'narrativelab.plot-grid.context-menu',
            title: zh ? '更多操作…' : 'More actions…',
            action: () => {
                hideUniverContextMenu(univer);
                window.setTimeout(() => opts.onRequest?.(menuPosition), 0);
            },
            order: 1000,
        }).appendTo(['contextMenu.mainArea', 'contextMenu.others']);
    }

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

/** Tiny chain-link glyph in the cell's top-right corner. */
function drawTinyLinkIcon(
    ctx: CanvasRenderingContext2D,
    endX: number,
    startY: number,
    cellWidth: number,
    cellHeight: number,
): void {
    if (cellWidth < 16 || cellHeight < 14) return;
    const size = Math.min(11, Math.max(8, Math.min(cellWidth, cellHeight) * 0.2));
    const pad = 3;
    const box = size + 4;
    const x = endX - box - pad;
    const y = startY + pad;

    ctx.save();
    roundedRect(ctx, x, y, box, box, 3);
    ctx.fillStyle = 'rgba(47, 101, 220, 0.92)';
    ctx.fill();

    // Lucide-style link (two rings), scaled into the chip.
    const s = size / 16;
    ctx.translate(x + 2, y + 2);
    ctx.scale(s, s);
    ctx.strokeStyle = '#ffffff';
    ctx.lineWidth = Math.max(1.4, 1.8 / s);
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    ctx.beginPath();
    ctx.moveTo(8.5, 10.5);
    ctx.bezierCurveTo(7.2, 11.8, 5.2, 11.8, 3.9, 10.5);
    ctx.bezierCurveTo(2.6, 9.2, 2.6, 7.2, 3.9, 5.9);
    ctx.lineTo(5.6, 4.2);
    ctx.bezierCurveTo(6.9, 2.9, 8.9, 2.9, 10.2, 4.2);
    ctx.stroke();
    ctx.beginPath();
    ctx.moveTo(7.5, 5.5);
    ctx.bezierCurveTo(8.8, 4.2, 10.8, 4.2, 12.1, 5.5);
    ctx.bezierCurveTo(13.4, 6.8, 13.4, 8.8, 12.1, 10.1);
    ctx.lineTo(10.4, 11.8);
    ctx.bezierCurveTo(9.1, 13.1, 7.1, 13.1, 5.8, 11.8);
    ctx.stroke();
    ctx.restore();
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

/** Keep the filter control ahead of lower-priority items in the simple ribbon. */
function keepFilterInToolbar(univer: Univer): void {
    try {
        // The filter preset registers under ribbon.data. Univer's simple ribbon
        // collapses later groups first, so making Data first keeps Filter visible.
        // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-member-access
        const menuManager = univer.__getInjector().get(IMenuManagerService);
        // eslint-disable-next-line @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-member-access
        menuManager.mergeMenu({
            [RibbonPosition.DATA]: {
                order: FILTER_TOOLBAR_GROUP_ORDER,
            },
        });
    } catch (e) {
        console.warn('[NarrativeLab] Failed to pin Univer filter in the toolbar:', e);
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
    let changed = false;
    for (const range of params.ranges) {
        if (isRow) {
            const start = range.startRow ?? 0;
            const end = range.endRow ?? start;
            for (let worksheetRow = start; worksheetRow <= end; worksheetRow += 1) {
                const height = dimensionAt(params.rowHeight, worksheetRow);
                if (height == null || height <= 0) continue;
                const nextHeight = Math.round(height);
                if (worksheetRow === 0) {
                    if ((page.headerRowHeight || 0) !== nextHeight) {
                        page.headerRowHeight = nextHeight;
                        changed = true;
                    }
                    continue;
                }
                const row = page.rows[worksheetRow - 1];
                if (row && row.height !== nextHeight) {
                    row.height = nextHeight;
                    changed = true;
                }
            }
        } else {
            const start = range.startColumn ?? 0;
            const end = range.endColumn ?? start;
            for (let worksheetColumn = start; worksheetColumn <= end; worksheetColumn += 1) {
                const width = dimensionAt(params.colWidth, worksheetColumn);
                if (width == null || width <= 0) continue;
                const nextWidth = Math.round(width);
                if (worksheetColumn === 0) {
                    if ((page.labelColumnWidth || 0) !== nextWidth) {
                        page.labelColumnWidth = nextWidth;
                        changed = true;
                    }
                    continue;
                }
                const column = page.columns[worksheetColumn - 1];
                if (column && column.width !== nextWidth) {
                    column.width = nextWidth;
                    changed = true;
                }
            }
        }
    }
    return changed ? next : null;
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
        ? { [LocaleType.ZH_CN]: mergeLocales(withNarrativeLabZhTerminology(sheetsCoreZhCN), sheetsFilterZhCN) }
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
    keepFilterInToolbar(univerInstance);
    moveFinancialFormulaMenuLast(univerInstance);
    tryActivateSheet(univerAPI, liveDoc.activePageId);

    let disposed = false;
    let suppressUntil = 0;
    let lastSelection: { sheetId: string; row: number; col: number } | null = null;
    const disposers: Array<() => void> = [];
    try {
        disposers.push(registerNarrativeLabContextMenu(
            univerAPI,
            univerInstance,
            opts.container,
            {
                locale: opts.locale,
                onShowConnectedNotes: opts.onShowConnectedNotes,
                onAction: opts.onContextMenuAction,
                onRequest: opts.onContextMenuRequest,
            },
        ));
    } catch (error) {
        // A NarrativeLab extension must never take down Univer's native menu.
        console.warn('[NarrativeLab] Could not extend the Univer context menu.', error);
    }

    const refreshLinkMarkers = () => {
        try {
            univerAPI.getActiveWorkbook?.()?.getActiveSheet?.()?.refreshCanvas?.();
        } catch { /* drawing is cosmetic */ }
    };

    try {
        const linkIconRender: PlotGridCellRender = {
            zIndex: 100,
            drawWith: (ctx, info) => {
                const source = opts.getAuthoritativeDocument?.() ?? liveDoc;
                const cell = linkedCellAt(source, info.subUnitId, info.row, info.col);
                if (!cellHasNoteLink(cell)) return;
                const { startX, startY, endX, endY } = info.primaryWithCoord;
                drawTinyLinkIcon(ctx, endX, startY, endX - startX, endY - startY);
            },
        };
        const renderHook = univerAPI.getSheetHooks?.().onCellRender?.([linkIconRender]);
        if (renderHook && typeof renderHook.dispose === 'function') {
            disposers.push(() => renderHook.dispose?.());
        }
        refreshLinkMarkers();
    } catch (error) {
        console.warn('[NarrativeLab] Univer link icon renderer unavailable:', error);
    }

    // Long-hover (3s) on a linked cell → connected-notes floating card.
    const LINK_HOVER_MS = 3000;
    let lastPointer = { x: 0, y: 0 };
    let hoverKey: string | null = null;
    let hoverTimer = 0;
    let hoverShownKey: string | null = null;

    const clearLinkHoverTimer = () => {
        if (!hoverTimer) return;
        window.clearTimeout(hoverTimer);
        hoverTimer = 0;
    };

    const hideLinkHover = () => {
        clearLinkHoverTimer();
        hoverKey = null;
        if (hoverShownKey) {
            hoverShownKey = null;
            try { opts.onHideConnectedNotesHover?.(); } catch { /* ignore */ }
        }
    };

    const noteHoverOnCell = (sel: { sheetId: string; row: number; col: number } | null) => {
        if (!sel || isEditorBusy()) {
            hideLinkHover();
            return;
        }
        const source = opts.getAuthoritativeDocument?.() ?? liveDoc;
        const cell = linkedCellAt(source, sel.sheetId, sel.row, sel.col);
        const key = cellHasNoteLink(cell) ? `${sel.sheetId}:${sel.row}:${sel.col}` : null;
        if (key === hoverKey) return;
        clearLinkHoverTimer();
        if (hoverShownKey && hoverShownKey !== key) {
            hoverShownKey = null;
            try { opts.onHideConnectedNotesHover?.(); } catch { /* ignore */ }
        }
        hoverKey = key;
        if (!key || !opts.onShowConnectedNotesHover) return;
        hoverTimer = window.setTimeout(() => {
            hoverTimer = 0;
            if (hoverKey !== key || disposed) return;
            hoverShownKey = key;
            try {
                opts.onShowConnectedNotesHover?.({
                    position: { ...lastPointer },
                    sheetId: sel.sheetId,
                    row: sel.row,
                    col: sel.col,
                });
            } catch { /* ignore */ }
        }, LINK_HOVER_MS);
    };

    const onHostPointerMove = (event: PointerEvent) => {
        lastPointer = { x: event.clientX, y: event.clientY };
    };
    const onHostPointerLeave = () => hideLinkHover();
    opts.container.addEventListener('pointermove', onHostPointerMove);
    opts.container.addEventListener('pointerleave', onHostPointerLeave);
    disposers.push(() => {
        opts.container.removeEventListener('pointermove', onHostPointerMove);
        opts.container.removeEventListener('pointerleave', onHostPointerLeave);
        hideLinkHover();
    });

    const isSuppressed = () => disposed || Date.now() < suppressUntil;

    // Cell editor + IME: defer pull / remount until the session ends.
    // Declared before pullFromUniver so the closure never hits a TDZ read.
    let cellEditing = false;
    let composing = false;

    /** Ask Univer to commit the in-cell editor into the worksheet matrix. */
    const tryCommitCellEditor = () => {
        try {
            univerAPI.executeCommand?.('sheet.operation.set-cell-edit-visible', { visible: false });
        } catch { /* ignore */ }
        try {
            // Blur any leftover contenteditable so IME/editor buffers flush.
            const active = opts.container.ownerDocument?.activeElement;
            if (active instanceof HTMLElement && opts.container.contains(active)) {
                active.blur();
            }
        } catch { /* ignore */ }
    };

    const replaceWorkbook = (doc: ConceptGridDocument) => {
        suppressUntil = Date.now() + 800;
        disposeActiveWorkbook();
        createNativeWorkbook(doc);
        tryActivateSheet(univerAPI, doc.activePageId);
        // Workbook remount clears canvas overlays until the next paint.
        window.requestAnimationFrame(() => refreshLinkMarkers());
    };

    const pullFromUniver = (
        force = false,
        mergeOptions: { clearMissing?: boolean; mergeDimensions?: boolean } = {},
    ) => {
        if (disposed) return;
        if (!force && isSuppressed()) return;
        // Never pull while the in-cell / formula editor or IME is active — mid-edit
        // snapshots omit the active cell and remounts abort composition.
        if (!force && (cellEditing || composing)) return;
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

            // Dimensions are owned by resize mutations during polling. Mid-drag
            // workbook.save() often lags and would snap sizes back — but the host
            // liveDoc may already hold newer widths/heights that this.document
            // has not received yet. Keep those unless we explicitly merge from Univer.
            const clearMissing = mergeOptions.clearMissing === true;
            const mergeDimensions = mergeOptions.mergeDimensions === true;
            if (!mergeDimensions) {
                preserveConceptGridAxisSizes(base, liveDoc);
            }

            let next = base;
            for (const sheet of Object.values(saved.sheets)) {
                const id = sheet.id;
                if (!id || !sheet.cellData) continue;
                next = mergeUniverCellDataIntoDocument(
                    next,
                    id,
                    sheet.cellData,
                    saved.styles,
                    mergeDimensions ? sheet.rowData : undefined,
                    mergeDimensions ? sheet.columnData : undefined,
                    { clearMissing, mergeDimensions },
                );
                // NarrativeLab owns page titles via the bottom sheet tabs
                // (Univer's sheet bar is hidden). Do not overwrite NL titles
                // from workbook.save() sheet names — that snaps renames back.
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
    let dimNotifyTimer = 0;
    let dimPullTimer = 0;
    let pendingAfterEdit = false;
    let pendingSetDoc: ConceptGridDocument | null = null;
    let schedulePull: (opts?: { clearMissing?: boolean; mergeDimensions?: boolean }) => void = () => { /* assigned below */ };

    const isEditorBusy = () => {
        if (cellEditing || composing) return true;
        // Univer does not always emit set-cell-edit-visible for every edit path,
        // and the formula/cell editor may portal outside the host container.
        // Keep this narrow: matching any `[class*="univer"]` input blocked autosave
        // indefinitely whenever focus lingered on sheet chrome after an edit.
        try {
            const doc = opts.container.ownerDocument;
            const active = doc?.activeElement;
            if (!(active instanceof HTMLElement)) return false;
            const tag = active.tagName;
            const isField = active.isContentEditable || tag === 'TEXTAREA' || tag === 'INPUT';
            if (!isField) return false;
            // NarrativeLab's floating Markdown editor lives on <body> — never block saves for it.
            if (active.closest('.plot-grid-cell-editor-window, .modal, .prompt')) return false;
            if (active.closest(
                '.univer-cell-editor, .univer-editor-container, .univer-formula-bar, [class*="cell-editor"], [class*="formula-editor"]',
            )) {
                return true;
            }
            // In-host contenteditable only (the actual cell editor surface).
            if (opts.container.contains(active) && active.isContentEditable) return true;
            return false;
        } catch {
            return false;
        }
    };

    const applyPendingSetDoc = () => {
        if (disposed || !pendingSetDoc || isEditorBusy()) return;
        const next = pendingSetDoc;
        pendingSetDoc = null;
        liveDoc = next;
        contentFp = conceptGridContentFingerprint(liveDoc);
        // Let Univer finish compositionend / editor teardown before remounting.
        window.setTimeout(() => {
            if (disposed || isEditorBusy()) {
                pendingSetDoc = next;
                return;
            }
            replaceWorkbook(liveDoc);
        }, 0);
    };

    const onEditorSessionEnd = () => {
        if (disposed || isEditorBusy()) return;
        if (pendingSetDoc) {
            applyPendingSetDoc();
            return;
        }
        if (!pendingAfterEdit) return;
        pendingAfterEdit = false;
        // Editor closed: safe to treat omitted cells as clears (Delete / Backspace).
        schedulePull({ clearMissing: true });
    };

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
    schedulePull = (pullOpts = {}) => {
        if (disposed) return;
        if (isEditorBusy()) {
            pendingAfterEdit = true;
            return;
        }
        if (isSuppressed()) {
            pendingAfterSuppress = true;
            scheduleSuppressedDrain();
            return;
        }
        if (timer) window.clearTimeout(timer);
        const clearMissing = pullOpts.clearMissing === true;
        const mergeDimensions = pullOpts.mergeDimensions === true;
        // Keep this short: a long debounce left edits only in Univer while vault
        // refresh / tab close could reload or save a stale NarrativeLab document.
        timer = window.setTimeout(() => {
            timer = 0;
            if (isEditorBusy()) {
                pendingAfterEdit = true;
                return;
            }
            pullFromUniver(false, { clearMissing, mergeDimensions });
        }, 80);
    };

    const flushPendingDimensionNotify = () => {
        if (!dimNotifyTimer) return;
        window.clearTimeout(dimNotifyTimer);
        dimNotifyTimer = 0;
        if (disposed) return;
        contentFp = conceptGridContentFingerprint(liveDoc);
        opts.onDocumentChange(liveDoc);
    };

    const scheduleDimensionNotify = () => {
        if (disposed) return;
        if (dimNotifyTimer) window.clearTimeout(dimNotifyTimer);
        // Coalesce rapid drag deltas so we don't clone/normalize the whole doc
        // on every pointer move (jank + stale overwrites).
        dimNotifyTimer = window.setTimeout(() => {
            dimNotifyTimer = 0;
            if (disposed) return;
            contentFp = conceptGridContentFingerprint(liveDoc);
            opts.onDocumentChange(liveDoc);
        }, 120);
    };

    const scheduleDimensionPull = () => {
        if (disposed) return;
        if (dimPullTimer) window.clearTimeout(dimPullTimer);
        // Command-level resize events may not carry sizes; read them from Univer
        // after the mutation settles.
        dimPullTimer = window.setTimeout(() => {
            dimPullTimer = 0;
            if (disposed) return;
            schedulePull({ mergeDimensions: true });
        }, 150);
    };

    disposers.push(() => {
        if (suppressDrainTimer) window.clearTimeout(suppressDrainTimer);
        suppressDrainTimer = 0;
        if (dimNotifyTimer) window.clearTimeout(dimNotifyTimer);
        dimNotifyTimer = 0;
        if (dimPullTimer) window.clearTimeout(dimPullTimer);
        dimPullTimer = 0;
    });

    const commandId = (command: unknown): string => {
        const c = command as { id?: string };
        return typeof c?.id === 'string' ? c.id : '';
    };
    const commandParams = (command: unknown): Record<string, unknown> | undefined => {
        const c = command as { params?: Record<string, unknown> };
        return c?.params && typeof c.params === 'object' ? c.params : undefined;
    };
    const isDimensionCommand = (id: string) =>
        id === 'sheet.mutation.set-worksheet-row-height'
        || id === 'sheet.mutation.set-worksheet-col-width'
        || id === 'sheet.command.delta-row-height'
        || id === 'sheet.command.delta-column-width'
        || id === 'sheet.command.set-worksheet-row-height'
        || id === 'sheet.command.set-worksheet-col-width';

    try {
        const api = univerAPI as UniverAPI & {
            Event?: {
                CommandExecuted?: string;
                SelectionChanged?: string;
                CellPointerDown?: string;
                CellHover?: string;
                CellPointerMove?: string;
                BeforeSheetEditStart?: string;
            };
            onCommandExecuted?: (cb: (c: unknown) => void) => unknown;
        };
        if (api.Event?.CommandExecuted) {
            const sub = univerAPI.addEvent(api.Event.CommandExecuted, (command) => {
                const id = commandId(command);
                const params = commandParams(command);

                if (id === 'sheet.operation.set-cell-edit-visible'
                    || id === 'sheet.operation.set-cell-edit-visible-f2'
                    || id === 'sheet.operation.set-cell-edit-visible-arrow') {
                    const visible = params?.visible;
                    if (typeof visible === 'boolean') {
                        cellEditing = visible;
                        if (visible) hideLinkHover();
                        if (!visible) onEditorSessionEnd();
                    }
                    return;
                }

                if (id === 'doc.command.ime-input') {
                    if (params?.isCompositionStart) composing = true;
                    if (params?.isCompositionEnd) {
                        composing = false;
                        onEditorSessionEnd();
                    }
                    return;
                }

                // Resize / axis moves: update NL meta immediately; do not poll
                // workbook.save() mid-drag (it lags and snaps other sizes back).
                if (isDimensionCommand(id) || id === 'sheet.mutation.move-rows' || id === 'sheet.mutation.move-columns') {
                    // Apply onto liveDoc (not stale this.document) so successive
                    // resizes keep earlier width/height changes in the same gesture.
                    const mutated = applyDimensionMutation(liveDoc, command)
                        ?? applyAxisMoveMutation(liveDoc, command);
                    if (mutated) {
                        liveDoc = mutated;
                        scheduleDimensionNotify();
                    } else if (isDimensionCommand(id)) {
                        scheduleDimensionPull();
                    }
                    return;
                }

                // Value edits while the cell editor is open are deferred via isEditorBusy.
                // Also skip noisy formula/doc mutations until the editor session ends —
                // polling mid-keystroke causes autosave → vault refresh → workbook remount jumps.
                if (
                    id.startsWith('doc.mutation.')
                    || id.startsWith('doc.command.')
                    || id === 'sheet.mutation.set-range-values'
                    || id === 'sheet.mutation.set-range-formatted-value'
                    || id === 'sheet.command.set-range-values'
                ) {
                    if (isEditorBusy()) {
                        pendingAfterEdit = true;
                        return;
                    }
                }

                schedulePull();
            });
            addUniverSubscriptionDisposer(disposers, univerAPI, sub);
        } else if (typeof api.onCommandExecuted === 'function') {
            const sub = api.onCommandExecuted(() => schedulePull());
            addUniverSubscriptionDisposer(disposers, univerAPI, sub);
        } else {
            const id = window.setInterval(() => {
                if (!disposed && opts.container.isConnected && !isSuppressed() && !isEditorBusy()) {
                    schedulePull();
                }
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
                hideLinkHover();
                const event = (params as { event?: MouseEvent | PointerEvent }).event;
                if (!lastSelection) return;
                const source = opts.getAuthoritativeDocument?.() ?? liveDoc;
                const linked = linkedCellAt(
                    source,
                    lastSelection.sheetId,
                    lastSelection.row,
                    lastSelection.col,
                );
                // Cmd/Ctrl+click still opens the linked note.
                if ((event?.metaKey || event?.ctrlKey) && linked && cellHasNoteLink(linked)) {
                    event?.preventDefault();
                    event?.stopPropagation();
                    opts.onContextMenuAction?.('open-linked-note');
                    return;
                }
                // Double-click on a Markdown-routed cell opens the NL editor.
                if ((event?.detail ?? 0) >= 2
                    && opts.shouldBlockUniverCellEdit?.(
                        lastSelection.sheetId,
                        lastSelection.row,
                        lastSelection.col,
                    )) {
                    event?.preventDefault();
                    event?.stopPropagation();
                    opts.onRequestMarkdownCellEdit?.(lastSelection);
                }
            });
            addUniverSubscriptionDisposer(disposers, univerAPI, sub);
        }

        // Cancel Univer in-cell edit for Markdown-routed cells and open NL editor.
        if (api.Event?.BeforeSheetEditStart) {
            let lastRequestAt = 0;
            let lastRequestKey = '';
            const sub = univerAPI.addEvent(api.Event.BeforeSheetEditStart, (raw) => {
                const params = raw as {
                    cancel?: boolean;
                    row?: number;
                    column?: number;
                    worksheet?: { getSheetId?: () => string };
                };
                const fallback = univerAPI.getActiveWorkbook()?.getActiveSheet()?.getSheetId?.() ?? null;
                const sheetId = params.worksheet?.getSheetId?.() || fallback;
                const row = params.row;
                const col = params.column;
                if (sheetId == null || row == null || col == null) return;
                if (!opts.shouldBlockUniverCellEdit?.(sheetId, row, col)) return;
                params.cancel = true;
                const key = `${sheetId}:${row}:${col}`;
                const now = Date.now();
                if (key === lastRequestKey && now - lastRequestAt < 400) return;
                lastRequestKey = key;
                lastRequestAt = now;
                window.setTimeout(() => {
                    opts.onRequestMarkdownCellEdit?.({ sheetId, row, col });
                }, 0);
            });
            addUniverSubscriptionDisposer(disposers, univerAPI, sub);
        }

        const handleCellHover = (params: unknown) => {
            try {
                const fallback = univerAPI.getActiveWorkbook()?.getActiveSheet()?.getSheetId?.() ?? null;
                const sel = extractSelection(params, fallback);
                noteHoverOnCell(sel);
            } catch { /* ignore */ }
        };
        if (api.Event?.CellHover) {
            const sub = univerAPI.addEvent(api.Event.CellHover, handleCellHover);
            addUniverSubscriptionDisposer(disposers, univerAPI, sub);
        } else if (api.Event?.CellPointerMove) {
            const sub = univerAPI.addEvent(api.Event.CellPointerMove, handleCellHover);
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
            if (dimPullTimer) {
                window.clearTimeout(dimPullTimer);
                dimPullTimer = 0;
            }
            // Flush coalesced resize notifies BEFORE the final pull so sizes
            // are already on the authoritative document snapshot.
            flushPendingDimensionNotify();
            tryCommitCellEditor();
            cellEditing = false;
            composing = false;
            // Final commit: read live axis sizes from Univer (drag has finished).
            try { pullFromUniver(true, { clearMissing: false, mergeDimensions: true }); } catch { /* ignore */ }
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
            const next = structuredClone(doc);
            if (isEditorBusy()) {
                // Remounting mid-edit / mid-IME clears the cell and aborts composition.
                pendingSetDoc = next;
                return;
            }
            liveDoc = next;
            contentFp = conceptGridContentFingerprint(liveDoc);
            replaceWorkbook(liveDoc);
        },
        syncMeta: (doc: ConceptGridDocument) => {
            // Keep host snapshot aligned with NL meta without remounting Univer.
            // Preserve live resize sizes that may not have been pushed to the
            // parent document yet (syncMeta is called from wikilink sync, zoom…).
            const next = structuredClone(doc);
            preserveConceptGridAxisSizes(next, liveDoc);
            liveDoc = next;
            contentFp = conceptGridContentFingerprint(liveDoc);
            refreshLinkMarkers();
        },
        refreshLinkMarkers,
        setActiveSheet: (sheetId: string) => {
            tryActivateSheet(univerAPI, sheetId);
        },
        setSheetTitle: (sheetId: string, title: string) => {
            const name = title.trim();
            if (!name) return;
            const page = liveDoc.pages.find(item => item.id === sheetId);
            if (page) page.title = name;
            contentFp = conceptGridContentFingerprint(liveDoc);
            try {
                const sheet = univerAPI.getActiveWorkbook?.()?.getSheetBySheetId?.(sheetId);
                sheet?.setName?.(name);
            } catch (error) {
                console.warn('[NarrativeLab] Could not rename Univer sheet:', error);
            }
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
        isEditorBusy,
        hasPendingSync: () => {
            if (disposed) return false;
            return isEditorBusy()
                || pendingAfterEdit
                || timer !== 0
                || pendingAfterSuppress
                || dimNotifyTimer !== 0
                || dimPullTimer !== 0;
        },
        flush: () => {
            // Commit the open editor first so workbook.save() includes typed text.
            tryCommitCellEditor();
            cellEditing = false;
            composing = false;
            pendingAfterEdit = false;
            pendingAfterSuppress = false;
            pendingSetDoc = null;
            if (timer) {
                window.clearTimeout(timer);
                timer = 0;
            }
            if (dimPullTimer) {
                window.clearTimeout(dimPullTimer);
                dimPullTimer = 0;
            }
            flushPendingDimensionNotify();
            // clearMissing:false — forced flush snapshots are often sparse and
            // must not blank cells that were merely omitted from the dump.
            // mergeDimensions:true — capture finished resize gesture sizes.
            pullFromUniver(true, { clearMissing: false, mergeDimensions: true });
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
        headerRowHeight: p.headerRowHeight || 0,
        labelColumnWidth: p.labelColumnWidth || 0,
        frozenColumns: p.frozenColumns,
        frozenRows: p.frozenRows,
    }));
}

export type { ConceptGridDocument };
