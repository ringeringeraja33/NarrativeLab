/**
 * Univer Sheets host for the Concept Grid (Plot Grid) view.
 * Instantiated on demand and bundled into the community-distributed main.js.
 */
import { LocaleType, mergeLocales, type Univer } from '@univerjs/core';
import { UniverSheetsCorePreset } from '@univerjs/preset-sheets-core';
import { UniverSheetsConditionalFormattingPreset } from '@univerjs/preset-sheets-conditional-formatting';
import { UniverSheetsDataValidationPreset } from '@univerjs/preset-sheets-data-validation';
import { UniverSheetsDrawingPreset } from '@univerjs/preset-sheets-drawing';
import { UniverSheetsFilterPreset } from '@univerjs/preset-sheets-filter';
import { UniverSheetsFindReplacePreset } from '@univerjs/preset-sheets-find-replace';
import { UniverSheetsHyperLinkPreset } from '@univerjs/preset-sheets-hyper-link';
import { UniverSheetsNotePreset } from '@univerjs/preset-sheets-note';
import { UniverSheetsSortPreset } from '@univerjs/preset-sheets-sort';
import { UniverSheetsTablePreset } from '@univerjs/preset-sheets-table';
import { UniverSheetsThreadCommentPreset } from '@univerjs/preset-sheets-thread-comment';
import { InsertFunctionOperation } from '@univerjs/sheets-formula-ui';
import { IMenuManagerService, RibbonFormulasGroup, RibbonPosition } from '@univerjs/ui';
import sheetsCoreEnUS from '@univerjs/preset-sheets-core/locales/en-US';
import sheetsCoreZhCN from '@univerjs/preset-sheets-core/locales/zh-CN';
import sheetsConditionalFormattingEnUS from '@univerjs/preset-sheets-conditional-formatting/locales/en-US';
import sheetsConditionalFormattingZhCN from '@univerjs/preset-sheets-conditional-formatting/locales/zh-CN';
import sheetsDataValidationEnUS from '@univerjs/preset-sheets-data-validation/locales/en-US';
import sheetsDataValidationZhCN from '@univerjs/preset-sheets-data-validation/locales/zh-CN';
import sheetsDrawingEnUS from '@univerjs/preset-sheets-drawing/locales/en-US';
import sheetsDrawingZhCN from '@univerjs/preset-sheets-drawing/locales/zh-CN';
import sheetsFilterEnUS from '@univerjs/preset-sheets-filter/locales/en-US';
import sheetsFilterZhCN from '@univerjs/preset-sheets-filter/locales/zh-CN';
import sheetsFindReplaceEnUS from '@univerjs/preset-sheets-find-replace/locales/en-US';
import sheetsFindReplaceZhCN from '@univerjs/preset-sheets-find-replace/locales/zh-CN';
import sheetsHyperLinkEnUS from '@univerjs/preset-sheets-hyper-link/locales/en-US';
import sheetsHyperLinkZhCN from '@univerjs/preset-sheets-hyper-link/locales/zh-CN';
import sheetsNoteEnUS from '@univerjs/preset-sheets-note/locales/en-US';
import sheetsNoteZhCN from '@univerjs/preset-sheets-note/locales/zh-CN';
import sheetsSortEnUS from '@univerjs/preset-sheets-sort/locales/en-US';
import sheetsSortZhCN from '@univerjs/preset-sheets-sort/locales/zh-CN';
import sheetsTableEnUS from '@univerjs/preset-sheets-table/locales/en-US';
import sheetsTableZhCN from '@univerjs/preset-sheets-table/locales/zh-CN';
import sheetsThreadCommentEnUS from '@univerjs/preset-sheets-thread-comment/locales/en-US';
import sheetsThreadCommentZhCN from '@univerjs/preset-sheets-thread-comment/locales/zh-CN';

import sheetsCoreCss from '@univerjs/preset-sheets-core/lib/index.css';
import sheetsConditionalFormattingCss from '@univerjs/preset-sheets-conditional-formatting/lib/index.css';
import sheetsDataValidationCss from '@univerjs/preset-sheets-data-validation/lib/index.css';
import sheetsDrawingCss from '@univerjs/preset-sheets-drawing/lib/index.css';
import sheetsFilterCss from '@univerjs/preset-sheets-filter/lib/index.css';
import sheetsFindReplaceCss from '@univerjs/preset-sheets-find-replace/lib/index.css';
import sheetsHyperLinkCss from '@univerjs/preset-sheets-hyper-link/lib/index.css';
import sheetsNoteCss from '@univerjs/preset-sheets-note/lib/index.css';
import sheetsSortCss from '@univerjs/preset-sheets-sort/lib/index.css';
import sheetsTableCss from '@univerjs/preset-sheets-table/lib/index.css';
import sheetsThreadCommentCss from '@univerjs/preset-sheets-thread-comment/lib/index.css';
import { createUniver } from '../utils/createUniver';

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

function mergePlotGridLocales(...locales: unknown[]): ReturnType<typeof mergeLocales> {
    return mergeLocales(...locales as Parameters<typeof mergeLocales>);
}

export function warmupPlotGridUniver(targetDocument: Document): void {
    injectUniverCss(targetDocument);
}

function injectUniverCss(activeDocument: Document): void {
    const id = 'narrativelab-univer-sheets-css';
    if (activeDocument.getElementById(id)) return;
    // The stylesheet is bundled as text and attached when the sheet host is
    // first mounted, avoiding global Univer CSS before the table is opened.
    const style = activeDocument.createElement('style');
    style.id = id;
    const sheets = [
        sheetsCoreCss,
        sheetsFilterCss,
        sheetsDrawingCss,
        sheetsHyperLinkCss,
        sheetsFindReplaceCss,
        sheetsSortCss,
        sheetsDataValidationCss,
        sheetsConditionalFormattingCss,
        sheetsNoteCss,
        sheetsTableCss,
        sheetsThreadCommentCss,
    ];
    style.textContent = sheets.map(item => (typeof item === 'string' ? item : String(item))).join('\n');
    activeDocument.head.appendChild(style);
}

import { installUniverContextMenuHoverAssist, retireUniverSubmenus } from '../utils/univerContextMenu';
import { installUniverSheetListReorder } from '../utils/univerSheetListReorder';
import type { CellData, ConceptGridDocument } from '../models/PlotGridData';
import { conceptGridDocumentsSharePage, isDefaultEmptyConceptGrid, isIncompleteConceptGridPull, normalizeUniverStyleMap, normalizeUniverWorkbookResources, workbookSnapshotBelongsToDocument } from '../models/PlotGridData';
import { cellHasNoteLink, getPlotGridCellAtUniverCoords } from '../utils/plotGridCellEdit';
import {
    conceptGridContentFingerprint,
    documentToUniverWorkbookData,
    mergeUniverCellDataIntoDocument,
    univerCellPlainText,
    reconcileUniverSheetsIntoDocument,
    applyUniverSheetChromeMutation,
    moveConceptGridAxis,
    overlayConceptGridCellMeta,
    preserveConceptGridAxisSizes,
    spliceConceptGridAxis,
    plotGridSourceToUniverRichText,
    PLOTGRID_SOURCE_FIELD,
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
    /** Notes linked from the active cell — used to fill the hover submenu. */
    getConnectedNotes?: () => Array<{ path: string; name: string }>;
    /** Open a connected note from the Univer hover submenu. */
    onOpenConnectedNote?: (path: string) => void;
    /**
     * Return true to cancel Univer's in-cell editor for this coordinate and
     * route editing through NarrativeLab's Markdown cell editor instead.
     */
    shouldBlockUniverCellEdit?: (sheetId: string, row: number, col: number) => boolean;
    /** Open the Markdown cell editor for the given Univer coordinates. */
    onRequestMarkdownCellEdit?: (info: { sheetId: string; row: number; col: number }) => void;
    /** True while NarrativeLab's floating Markdown editor is open. */
    isExternalEditorBusy?: () => boolean;
    /** Fired once the real workbook (not Univer's default blank) is on screen. */
    onReady?: () => void;
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
    /** Rename a worksheet (Univer sheet bar is the primary rename UI). */
    setSheetTitle: (sheetId: string, title: string) => void;
    /** Apply NarrativeLab's legacy view controls to the embedded worksheet. */
    setZoom: (sheetId: string, ratio: number) => void;
    setFreeze: (sheetId: string, enabled: boolean, frozenColumns?: number, frozenRows?: number) => void;
    setActiveCell: (sheetId: string, row: number, col: number) => void;
    getActiveCell: () => { sheetId: string; row: number; col: number } | null;
    /** Write one cell's Markdown source without remounting the workbook. */
    applyCellSource: (sheetId: string, row: number, col: number, source: string) => void;
    /** Display text currently painted by Univer, or null if the cell cannot be read. */
    readLiveCellPlainText: (sheetId: string, row: number, col: number) => string | null;
    /** True while the in-cell / formula editor or IME composition is active. */
    isEditorBusy: () => boolean;
    /** True when a debounced Univer→document pull is waiting (or editor still open). */
    hasPendingSync: () => boolean;
    /** Force a sync pull from Univer cell matrix into the live document. */
    flush: () => void;
    /** Resize / repaint this host without pulling a foreign workbook. */
    relayout: () => void;
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
        getSheets?: () => Array<{
            getSheetId: () => string;
            getSheetName?: () => string;
            getName?: () => string;
        }>;
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
                getCellData: () => { v?: unknown; p?: unknown; f?: unknown; custom?: Record<string, unknown> } | null;
                setValue?: (value: unknown) => unknown;
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
/** Classic ribbon: Start, Data, Insert, Formulas, View. */
const RIBBON_TAB_ORDER = {
    start: 0,
    data: 1,
    insert: 2,
    formulas: 3,
    view: 4,
    others: 5,
} as const;

const UNIVER_CONTEXT_SUBMENU_SELECTOR = '[data-u-context-menu-submenu="true"]';
const UNIVER_CONTEXT_MENU_HOST_ID = 'desktop-context-menu';

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

function isUniverContextMenuOpen(univer: Univer, doc: Document): boolean {
    try {
        // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-member-access
        const menuService = univer.__getInjector().get('ui.contextmenu.service');
        // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access
        if (menuService?.visible) return true;
    } catch {
        // Optional — older builds may not expose the service.
    }
    return !!doc.getElementById(UNIVER_CONTEXT_MENU_HOST_ID)
        || !!doc.querySelector(UNIVER_CONTEXT_SUBMENU_SELECTOR);
}

/** Hide leftover flyouts immediately. Univer keeps the previous one for 500ms
 * even after a new parent row opens its own flyout (including a still-hidden
 * measuring frame). Keep only the newest DOM node. */
function retireOlderVisibleUniverSubmenus(doc: Document): void {
    retireUniverSubmenus(doc, { keepLatest: true });
}

/** Univer measures submenu position on one rAF and only retries on scroll/resize.
 * A missed first frame leaves the flyout `visibility: hidden` forever. */
function kickUniverSubmenuPosition(doc: Document): void {
    const pending = Array.from(doc.querySelectorAll(UNIVER_CONTEXT_SUBMENU_SELECTOR))
        .some(node => node.instanceOf(HTMLElement) && node.style.visibility === 'hidden');
    if (!pending) return;
    const view = doc.defaultView;
    if (!view) return;
    view.requestAnimationFrame(() => {
        view.requestAnimationFrame(() => {
            view.dispatchEvent(new Event('scroll'));
        });
    });
}

function installUniverContextMenuGuard(
    univer: Univer,
    doc: Document,
    container: HTMLElement,
    onMenuOpened: () => void,
    onMenuClosed: () => void,
): () => void {
    let wasOpen = false;
    let frame = 0;
    const sync = () => {
        const open = isUniverContextMenuOpen(univer, doc);
        if (open) {
            retireOlderVisibleUniverSubmenus(doc);
            kickUniverSubmenuPosition(doc);
            if (!wasOpen) onMenuOpened();
        } else if (wasOpen) {
            onMenuClosed();
        }
        wasOpen = open;
    };
    const onChange = () => {
        if (frame) return;
        frame = doc.defaultView?.requestAnimationFrame(() => {
            frame = 0;
            sync();
        }) ?? 0;
        if (!frame) sync();
    };
    const onContextMenu = () => {
        onMenuOpened();
    };
    const observer = new MutationObserver(onChange);
    observer.observe(doc.body, {
        childList: true,
        subtree: true,
        attributes: true,
        attributeFilter: ['style', 'class'],
    });
    container.addEventListener('contextmenu', onContextMenu, true);
    doc.addEventListener('pointerdown', onChange, true);
    return () => {
        observer.disconnect();
        container.removeEventListener('contextmenu', onContextMenu, true);
        doc.removeEventListener('pointerdown', onChange, true);
        if (frame) doc.defaultView?.cancelAnimationFrame(frame);
    };
}

const CONNECTED_NOTES_MENU_ID = 'narrativelab.plot-grid.connected';
const CONNECTED_NOTES_EMPTY_ID = 'narrativelab.plot-grid.connected.empty';
const CONNECTED_NOTES_SLOT_MAX = 24;

type UniverInjector = {
    get: (id: string) => unknown;
};

type UniverMenuManager = {
    mergeMenu: (schema: unknown) => void;
};

type UniverCommandService = {
    hasCommand?: (id: string) => boolean;
    registerCommand: (command: unknown) => void;
};

function getUniverInjector(univer: Univer): UniverInjector | null {
    const host = univer as Univer & { __getInjector?: () => unknown };
    const getInjector = host.__getInjector;
    if (typeof getInjector !== 'function') return null;
    const injector: unknown = getInjector.call(host);
    if (!injector || typeof injector !== 'object') return null;
    const get = (injector as UniverInjector).get;
    return typeof get === 'function' ? { get } : null;
}

function registerConnectedNotesHoverSubmenu(
    univerAPI: UniverAPI,
    univer: Univer,
    opts: {
        title: string;
        emptyTitle: string;
        getNotes: () => Array<{ path: string; name: string }>;
        onOpenNote: (path: string) => void;
    },
): boolean {
    if (typeof univerAPI.createSubmenu !== 'function') return false;
    try {
        const injector = getUniverInjector(univer);
        const menuManager = injector?.get('univer.menu-manager-service') as UniverMenuManager | undefined;
        const commandService = injector?.get('univer.core.command-service') as UniverCommandService | undefined;
        if (typeof menuManager?.mergeMenu !== 'function' || typeof commandService?.registerCommand !== 'function') {
            return false;
        }

        univerAPI.createSubmenu({
            id: CONNECTED_NOTES_MENU_ID,
            title: opts.title,
            order: -200,
        }).appendTo(['contextMenu.mainArea', 'contextMenu.others']);

        const group: Record<string, { order: number; menuItemFactory: () => unknown }> = {
            [CONNECTED_NOTES_EMPTY_ID]: {
                order: 0,
                menuItemFactory: () => {
                    if (opts.getNotes().length > 0) return null;
                    return {
                        id: CONNECTED_NOTES_EMPTY_ID,
                        type: 0,
                        title: opts.emptyTitle,
                    };
                },
            },
        };
        for (let i = 0; i < CONNECTED_NOTES_SLOT_MAX; i++) {
            const itemId = `${CONNECTED_NOTES_MENU_ID}.note-${i}`;
            const commandId = `${itemId}.action`;
            if (typeof commandService.hasCommand !== 'function' || !commandService.hasCommand(commandId)) {
                commandService.registerCommand({
                    id: commandId,
                    type: 0,
                    handler: () => {
                        const note = opts.getNotes()[i];
                        if (note) opts.onOpenNote(note.path);
                    },
                });
            }
            group[itemId] = {
                order: i + 1,
                menuItemFactory: () => {
                    const note = opts.getNotes()[i];
                    if (!note) return null;
                    return {
                        id: itemId,
                        type: 0,
                        title: note.name,
                        commandId,
                    };
                },
            };
        }
        menuManager.mergeMenu({
            'contextMenu.mainArea': {
                'contextMenu.others': {
                    [CONNECTED_NOTES_MENU_ID]: {
                        [`${CONNECTED_NOTES_MENU_ID}-group-0`]: group,
                    },
                },
            },
        });
        return true;
    } catch {
        return false;
    }
}

function registerNarrativeLabContextMenu(
    univerAPI: UniverAPI,
    univer: Univer,
    container: HTMLElement,
    opts: {
        locale: 'en' | 'zh';
        onShowConnectedNotes?: (position: { x: number; y: number }) => void;
        getConnectedNotes?: () => Array<{ path: string; name: string }>;
        onOpenConnectedNote?: (path: string) => void;
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
    const emptyTitle = zh ? '暂无已连接笔记' : 'No connected notes';

    const openConnectedNotesMenu = () => {
        hideUniverContextMenu(univer);
        window.setTimeout(() => {
            if (opts.onShowConnectedNotes) opts.onShowConnectedNotes(menuPosition);
            else opts.onRequest?.(menuPosition);
        }, 0);
    };

    const registeredHoverSubmenu = registerConnectedNotesHoverSubmenu(univerAPI, univer, {
        title: connectedTitle,
        emptyTitle,
        getNotes: () => {
            try {
                return opts.getConnectedNotes?.() ?? [];
            } catch {
                return [];
            }
        },
        onOpenNote: (path) => {
            hideUniverContextMenu(univer);
            if (opts.onOpenConnectedNote) opts.onOpenConnectedNote(path);
            else openConnectedNotesMenu();
        },
    });
    if (!registeredHoverSubmenu) {
        univerAPI.createMenu({
            id: CONNECTED_NOTES_MENU_ID,
            title: connectedTitle,
            action: openConnectedNotesMenu,
            order: -200,
        }).appendTo(['contextMenu.mainArea', 'contextMenu.others']);
    }

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
        append('narrativelab.plot-grid.to-research', zh ? '转为研究' : 'Convert to Research', 'convert-to-research', 1012);
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
    const page = doc.pages.find(item => item.id === sheetId);
    return getPlotGridCellAtUniverCoords(page, row, col);
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

/** Put Data immediately after Start, matching Excel-style ribbon order. */
function orderRibbonTabs(univer: Univer): void {
    try {
        // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-member-access
        const menuManager = univer.__getInjector().get(IMenuManagerService);
        // eslint-disable-next-line @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-member-access
        menuManager.mergeMenu({
            [RibbonPosition.START]: { order: RIBBON_TAB_ORDER.start },
            [RibbonPosition.DATA]: { order: RIBBON_TAB_ORDER.data },
            [RibbonPosition.INSERT]: { order: RIBBON_TAB_ORDER.insert },
            [RibbonPosition.FORMULAS]: { order: RIBBON_TAB_ORDER.formulas },
            [RibbonPosition.VIEW]: { order: RIBBON_TAB_ORDER.view },
            [RibbonPosition.OTHERS]: { order: RIBBON_TAB_ORDER.others },
        });
    } catch (e) {
        console.warn('[NarrativeLab] Failed to order Univer ribbon tabs:', e);
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

type AxisStructureMutation = {
    id?: string;
    params?: {
        subUnitId?: string;
        range?: { startRow?: number; endRow?: number; startColumn?: number; endColumn?: number };
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
 * Apply Univer cell mutations immediately. workbook.save() lags behind typing
 * and a later pull would persist only the first half of a burst of edits.
 */
function applyRangeValuesMutation(doc: ConceptGridDocument, command: unknown): ConceptGridDocument | null {
    const { id, params } = command as {
        id?: string;
        params?: {
            subUnitId?: string;
            cellValue?: Record<number, Record<number, {
                v?: unknown;
                f?: unknown;
                p?: unknown;
                custom?: Record<string, unknown>;
                s?: unknown;
            } | null>>;
            range?: { startRow?: number; startColumn?: number };
            value?: {
                v?: unknown;
                f?: unknown;
                p?: unknown;
                custom?: Record<string, unknown>;
                s?: unknown;
            };
        };
    };
    if (!id || !/set-range-values|set-range-formatted-value/i.test(id)) return null;
    const sheetId = params?.subUnitId;
    if (!sheetId) return null;
    let cellData = params?.cellValue;
    if (!cellData && params?.range && params.value) {
        const row = params.range.startRow ?? 0;
        const col = params.range.startColumn ?? 0;
        cellData = { [row]: { [col]: params.value } };
    }
    if (!cellData) return null;
    const clone = structuredClone(doc);
    const next = mergeUniverCellDataIntoDocument(
        clone,
        sheetId,
        cellData,
    );
    // Unchanged clones must not count as applied — otherwise a header Delete
    // that Univer stored as null/`{}` could be mistaken for a sparse omission.
    return next === clone ? null : next;
}

/** Apply Clear contents / Clear all only to the ranges named by the command. */
function applyClearSelectionMutation(
    doc: ConceptGridDocument,
    command: unknown,
    fallback: { sheetId: string; row: number; col: number } | null,
): ConceptGridDocument | null {
    const { id, params } = command as {
        id?: string;
        params?: {
            subUnitId?: string;
            ranges?: Array<{
                startRow?: number;
                endRow?: number;
                startColumn?: number;
                endColumn?: number;
            }>;
        };
    };
    if (id !== 'sheet.command.clear-selection-all'
        && id !== 'sheet.command.clear-selection-content') return null;
    const sheetId = params?.subUnitId || fallback?.sheetId;
    if (!sheetId) return null;
    const page = doc.pages.find(item => item.id === sheetId);
    if (!page) return null;
    const ranges = params?.ranges?.length
        ? params.ranges
        : (fallback && fallback.sheetId === sheetId
            ? [{
                startRow: fallback.row,
                endRow: fallback.row,
                startColumn: fallback.col,
                endColumn: fallback.col,
            }]
            : []);
    if (!ranges.length) return null;

    const cellData: Record<number, Record<number, null>> = {};
    const lastRow = page.rows.length;
    const lastColumn = page.columns.length;
    for (const range of ranges) {
        const startRow = Math.max(0, Math.min(lastRow, Math.floor(range.startRow ?? 0)));
        const endRow = Math.max(startRow, Math.min(lastRow, Math.floor(range.endRow ?? startRow)));
        const startColumn = Math.max(0, Math.min(lastColumn, Math.floor(range.startColumn ?? 0)));
        const endColumn = Math.max(startColumn, Math.min(lastColumn, Math.floor(range.endColumn ?? startColumn)));
        for (let row = startRow; row <= endRow; row += 1) {
            const bucket = cellData[row] ?? (cellData[row] = {});
            for (let column = startColumn; column <= endColumn; column += 1) {
                bucket[column] = null;
            }
        }
    }
    const next = structuredClone(doc);
    return mergeUniverCellDataIntoDocument(next, sheetId, cellData);
}

/** Keep stable row/column ids aligned with Univer native insert/delete actions. */
function applyAxisStructureMutation(doc: ConceptGridDocument, command: unknown): ConceptGridDocument | null {
    const { id, params } = command as AxisStructureMutation;
    if (!params?.subUnitId || !params.range) return null;

    let axis: 'rows' | 'columns';
    let action: 'insert' | 'remove';
    let start: number | undefined;
    let end: number | undefined;
    if (id === 'sheet.mutation.insert-row' || id === 'sheet.mutation.remove-rows') {
        axis = 'rows';
        action = id === 'sheet.mutation.insert-row' ? 'insert' : 'remove';
        start = params.range.startRow;
        end = params.range.endRow;
    } else if (id === 'sheet.mutation.insert-col' || id === 'sheet.mutation.remove-col') {
        axis = 'columns';
        action = id === 'sheet.mutation.insert-col' ? 'insert' : 'remove';
        start = params.range.startColumn;
        end = params.range.endColumn;
    } else {
        return null;
    }
    if (start == null || end == null || end < start) return null;

    const next = spliceConceptGridAxis(
        doc,
        params.subUnitId,
        axis,
        action,
        start,
        end - start + 1,
    );
    return next === doc ? null : next;
}

const livePlotGridRelayouts = new Set<() => void>();

function createPlotGridWorkbookUnitId(): string {
    return `nl-plotgrid-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

function commandWorkbookUnitId(params: Record<string, unknown> | undefined): string {
    const raw = params?.unitId ?? params?.unitID ?? params?.workbookId;
    return typeof raw === 'string' ? raw : '';
}

function notifySiblingPlotGridHosts(except?: () => void): void {
    for (const relayout of livePlotGridRelayouts) {
        if (relayout === except) continue;
        try { relayout(); } catch { /* keep other workbooks painted */ }
    }
}

function scheduleSiblingPlotGridRelayout(except?: () => void): void {
    const kick = () => notifySiblingPlotGridHosts(except);
    kick();
    // Univer's React unmount is delayed (~500ms). Repaint survivors after that.
    window.setTimeout(kick, 50);
    window.setTimeout(kick, 320);
    window.setTimeout(kick, 600);
}

/**
 * Mount Univer Sheets into `container` and keep a ConceptGridDocument in sync.
 */
export function createPlotGridUniverHost(opts: PlotGridUniverHostOptions): PlotGridUniverHost {
    let liveDoc = structuredClone(opts.initialDocument);
    let contentFp = conceptGridContentFingerprint(liveDoc);
    const workbookUnitId = createPlotGridWorkbookUnitId();
    const locale = opts.locale === 'zh' ? LocaleType.ZH_CN : LocaleType.EN_US;
    const locales = opts.locale === 'zh'
        ? {
            [LocaleType.ZH_CN]: mergePlotGridLocales(
                withNarrativeLabZhTerminology(sheetsCoreZhCN),
                sheetsFilterZhCN,
                sheetsDrawingZhCN,
                sheetsHyperLinkZhCN,
                sheetsFindReplaceZhCN,
                sheetsSortZhCN,
                sheetsDataValidationZhCN,
                sheetsConditionalFormattingZhCN,
                sheetsNoteZhCN,
                sheetsTableZhCN,
                sheetsThreadCommentZhCN,
            ),
        }
        : {
            [LocaleType.EN_US]: mergePlotGridLocales(
                sheetsCoreEnUS,
                sheetsFilterEnUS,
                sheetsDrawingEnUS,
                sheetsHyperLinkEnUS,
                sheetsFindReplaceEnUS,
                sheetsSortEnUS,
                sheetsDataValidationEnUS,
                sheetsConditionalFormattingEnUS,
                sheetsNoteEnUS,
                sheetsTableEnUS,
                sheetsThreadCommentEnUS,
            ),
        };

    injectUniverCss(opts.container.ownerDocument);

    opts.container.empty();
    opts.container.addClass('plot-grid-univer-host');
    opts.container.addClass('is-univer-pending');
    opts.container.setCssStyles({
        width: '100%',
        height: '100%',
        minHeight: '0',
        flex: '1 1 auto',
        position: 'relative',
        overflow: 'hidden',
    });

    const univerFooter = {
        sheetBar: true,
        statisticBar: true,
        menus: true,
        zoomSlider: true,
        addSheetButtonConfig: {
            show: true,
            defaultRowCount: 50,
            defaultColumnCount: 20,
        },
    };
    // Prefer Univer's classic ribbon + native sheet bar (hide / tab color / rename).
    let univerAPI: UniverAPI;
    let univerInstance: Univer;
    ({ univer: univerInstance, univerAPI } = createUniver({
        locale,
        locales,
        presets: [
            UniverSheetsCorePreset({
                container: opts.container,
                popupRootId: `nl-univer-popup-${workbookUnitId}`,
                footer: univerFooter,
                toolbar: true,
                formulaBar: true,
                ribbonType: 'classic',
                contextMenu: true,
                menu: {
                    [TEXT_TO_NUMBER_TOOLBAR_MENU_ID]: { hidden: true },
                },
            }),
            UniverSheetsFilterPreset(),
            UniverSheetsDrawingPreset({ allowImageSize: 8 * 1024 * 1024 }),
            UniverSheetsHyperLinkPreset(),
            UniverSheetsFindReplacePreset(),
            UniverSheetsSortPreset(),
            UniverSheetsDataValidationPreset(),
            UniverSheetsConditionalFormattingPreset(),
            UniverSheetsNotePreset(),
            UniverSheetsTablePreset(),
            UniverSheetsThreadCommentPreset(),
        ],
    }) as unknown as { univer: Univer; univerAPI: UniverAPI });

    const nativeLinkColor = getComputedStyle(opts.container).getPropertyValue('--link-color').trim()
        || getComputedStyle(opts.container).getPropertyValue('--interactive-accent').trim()
        || '#5e6ad2';
    let nativeRichTextEnabled = true;
    let disposed = false;
    let disposing = false;
    let syncEnabled = false;
    let ourUnitId: string | null = null;
    const recentlyClearedCells = new Set<string>();
    const markClearedUniverCells = (
        sheetId: string | undefined,
        cellValue: Record<number, Record<number, unknown>> | undefined,
    ) => {
        if (!sheetId || !cellValue) return;
        for (const [rowKey, rowBucket] of Object.entries(cellValue)) {
            if (!rowBucket || typeof rowBucket !== 'object') continue;
            for (const [colKey, raw] of Object.entries(rowBucket)) {
                const snapshot = raw as { v?: unknown; p?: unknown } | null;
                const empty = snapshot == null
                    || (!('v' in snapshot) && !('p' in snapshot))
                    || univerCellPlainText(snapshot) === '';
                if (empty) recentlyClearedCells.add(`${sheetId}:${rowKey}:${colKey}`);
            }
        }
    };
    let revealFrame = 0;
    let revealTries = 0;
    const disposeOwnedWorkbook = () => {
        try {
            if (ourUnitId && typeof univerAPI.disposeUnit === 'function') {
                univerAPI.disposeUnit(ourUnitId);
            }
        } catch { /* ignore cleanup failures */ }
        ourUnitId = null;
    };
    const disposeActiveWorkbook = () => {
        try {
            const existing = univerAPI.getActiveWorkbook?.();
            const unitId = existing?.getId?.();
            if (unitId && typeof univerAPI.disposeUnit === 'function') univerAPI.disposeUnit(unitId);
        } catch { /* ignore cleanup failures */ }
        ourUnitId = null;
    };
    const createNativeWorkbook = (doc: ConceptGridDocument) => {
        const workbookData = documentToUniverWorkbookData(doc, {
            linkColor: nativeLinkColor,
            richText: nativeRichTextEnabled,
            workbookId: workbookUnitId,
        });
        try {
            const created = univerAPI.createWorkbook(workbookData);
            ourUnitId = univerAPI.getActiveWorkbook?.()?.getId?.() ?? null;
            return created;
        } catch (error) {
            if (!nativeRichTextEnabled) throw error;
            console.warn('[NarrativeLab] Univer rich-text cells failed; retrying with native plain cells.', error);
            disposeActiveWorkbook();
            nativeRichTextEnabled = false;
            const created = univerAPI.createWorkbook(documentToUniverWorkbookData(doc, {
                linkColor: nativeLinkColor,
                richText: false,
                workbookId: workbookUnitId,
            }));
            ourUnitId = univerAPI.getActiveWorkbook?.()?.getId?.() ?? null;
            return created;
        }
    };
    const revealWhenOurs = () => {
        if (disposed) return;
        revealFrame = 0;
        const wb = univerAPI.getActiveWorkbook?.();
        const activeId = wb?.getId?.() ?? null;
        if (ourUnitId && activeId && activeId !== ourUnitId) {
            try { univerAPI.disposeUnit?.(activeId); } catch { /* keep ours */ }
            tryActivateSheet(univerAPI, liveDoc.activePageId);
        }
        const saved = wb?.save?.() as { sheets?: Record<string, { id?: string }> } | undefined;
        const ours = workbookSnapshotBelongsToDocument(saved, liveDoc);
        revealTries += 1;
        if (!ours && revealTries < 40) {
            if (revealTries === 1 || revealTries === 8 || revealTries === 20) {
                disposeActiveWorkbook();
                createNativeWorkbook(liveDoc);
                tryActivateSheet(univerAPI, liveDoc.activePageId);
            }
            revealFrame = window.requestAnimationFrame(revealWhenOurs);
            return;
        }
        opts.container.removeClass('is-univer-pending');
        syncEnabled = true;
        opts.onReady?.();
    };
    const scheduleReveal = () => {
        syncEnabled = false;
        opts.container.addClass('is-univer-pending');
        revealTries = 0;
        if (revealFrame) window.cancelAnimationFrame(revealFrame);
        revealFrame = window.requestAnimationFrame(revealWhenOurs);
    };
    // UniverSheetsCorePreset paints a blank default workbook first. Dispose it
    // before creating ours so a restored tab never flashes an empty sheet.
    disposeActiveWorkbook();
    createNativeWorkbook(liveDoc);
    tryActivateSheet(univerAPI, liveDoc.activePageId);
    scheduleReveal();
    orderRibbonTabs(univerInstance);
    moveFinancialFormulaMenuLast(univerInstance);

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
                getConnectedNotes: opts.getConnectedNotes,
                onOpenConnectedNote: opts.onOpenConnectedNote,
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

    const relayout = () => {
        if (disposed || disposing || !syncEnabled) return;
        if (!opts.container.isConnected) return;
        if (opts.container.clientWidth < 8 || opts.container.clientHeight < 8) return;
        try {
            const wb = univerAPI.getActiveWorkbook?.();
            const wbId = wb?.getId?.();
            if (ourUnitId && wbId && wbId !== ourUnitId) {
                if (!isDefaultEmptyConceptGrid(liveDoc)) replaceWorkbook(liveDoc);
                return;
            }
            const saved = wb?.save?.() as { sheets?: Record<string, { id?: string }> } | undefined;
            if (!workbookSnapshotBelongsToDocument(saved, liveDoc)) {
                if (!isDefaultEmptyConceptGrid(liveDoc)) replaceWorkbook(liveDoc);
                return;
            }
            void opts.container.offsetWidth;
            wb?.getActiveSheet?.()?.refreshCanvas?.();
        } catch { /* sibling dispose must not take this grid down */ }
    };
    livePlotGridRelayouts.add(relayout);

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
            // Blur leftover editors so IME/formula-bar buffers flush.
            // The formula bar lives in Univer chrome and may be outside `container`.
            const active = opts.container.ownerDocument?.activeElement;
            if (!(active instanceof HTMLElement)) return;
            const inHost = opts.container.contains(active);
            const inFormula = Boolean(active.closest('.univer-formula-bar, [class*="formula-editor"]'));
            if (inHost || inFormula) active.blur();
        } catch { /* ignore */ }
    };

    const replaceWorkbook = (doc: ConceptGridDocument) => {
        suppressUntil = Date.now() + 800;
        disposeOwnedWorkbook();
        createNativeWorkbook(doc);
        tryActivateSheet(univerAPI, doc.activePageId);
        scheduleReveal();
        // Workbook remount clears canvas overlays until the next paint.
        window.requestAnimationFrame(() => refreshLinkMarkers());
    };

    const pullFromUniver = (
        force = false,
        mergeOptions: { clearMissing?: boolean; mergeDimensions?: boolean; silent?: boolean } = {},
    ) => {
        if (disposed) return;
        if (!force && isSuppressed()) return;
        // Never pull while the in-cell / formula editor or IME is active — mid-edit
        // snapshots omit the active cell and remounts abort composition.
        if (!force && (cellEditing || composing)) return;
        try {
            const wb = univerAPI.getActiveWorkbook?.();
            if (!wb) return;
            const wbId = wb.getId?.();
            if (ourUnitId && wbId && wbId !== ourUnitId) return;
            const saved = wb.save?.() as {
                sheetOrder?: string[];
                resources?: Array<{ name?: string; data?: string }>;
                styles?: Record<string, {
                    bg?: { rgb?: string } | null;
                    cl?: { rgb?: string } | null;
                    bl?: number | boolean | null;
                    it?: number | boolean | null;
                    ht?: number | null;
                }>;
                sheets?: Record<string, {
                    id?: string;
                    name?: string;
                    tabColor?: string;
                    hidden?: number | boolean | string;
                    zoomRatio?: number;
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
            if (!workbookSnapshotBelongsToDocument(saved, liveDoc)) return;

            // Merge Univer cells into the host snapshot first so in-flight edits
            // are not replaced by a lagging parent document. Copy note links
            // from the view afterwards — Univer does not own those fields.
            const authoritative = structuredClone(
                (opts.getAuthoritativeDocument?.() ?? liveDoc),
            );
            const liveIsSafe = conceptGridDocumentsSharePage(authoritative, liveDoc)
                && !isIncompleteConceptGridPull(authoritative, liveDoc);
            const base = liveIsSafe ? structuredClone(liveDoc) : authoritative;
            if (liveIsSafe) overlayConceptGridCellMeta(base, authoritative);

            // Dimensions are owned by resize mutations during polling. Mid-drag
            // workbook.save() often lags and would snap sizes back — but the host
            // liveDoc may already hold newer widths/heights that this.document
            // has not received yet. Keep those unless we explicitly merge from Univer.
            const clearMissing = mergeOptions.clearMissing === true;
            const mergeDimensions = mergeOptions.mergeDimensions === true;
            if (!mergeDimensions) {
                preserveConceptGridAxisSizes(base, liveDoc);
            }

            const activeSheetId = wb.getActiveSheet?.()?.getSheetId?.();
            // Univer's sheet bar owns name / hide / tab color / order / add / delete.
            // Reconcile those first so a newly inserted sheet has an NL page before
            // cell merge, and so link metadata on matching page ids is kept.
            let next = reconcileUniverSheetsIntoDocument(
                base,
                saved.sheets,
                saved.sheetOrder,
                activeSheetId,
            );
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
            }
            const snapshotIds = new Set(Object.keys(saved.sheets));
            const snapshotOmitsPages = base.pages.some(page => !snapshotIds.has(page.id));
            if (!snapshotOmitsPages) {
                next.univerResources = normalizeUniverWorkbookResources(saved.resources);
                next.univerStyles = normalizeUniverStyleMap(saved.styles);
            }
            if (isIncompleteConceptGridPull(base, next)) return;
            const nextFp = conceptGridContentFingerprint(next);
            // Also detect meta drift (links) even when display text is unchanged.
            const metaChanged = JSON.stringify(pickMeta(next)) !== JSON.stringify(pickMeta(liveDoc));
            if (nextFp === contentFp && !metaChanged && !force) {
                liveDoc = next;
                return;
            }
            liveDoc = next;
            contentFp = nextFp;
            if (!mergeOptions.silent) opts.onDocumentChange(liveDoc);
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
    let pendingAfterMenu = false;
    let menuHoldUntil = 0;
    let pendingSetDoc: ConceptGridDocument | null = null;
    let pendingClearMissing = false;
    let pendingMergeDimensions = false;
    let schedulePull: (opts?: { clearMissing?: boolean; mergeDimensions?: boolean }) => void = () => { /* assigned below */ };

    const applyCellSource = (sheetId: string, row: number, col: number, source: string): void => {
        const page = liveDoc.pages.find(item => item.id === sheetId);
        const cell = page ? getPlotGridCellAtUniverCoords(page, row, col) : null;
        if (cell) {
            cell.content = source;
            cell.manualContent = true;
        }
        contentFp = conceptGridContentFingerprint(liveDoc);
        suppressUntil = Date.now() + 400;
        try {
            const sheet = univerAPI.getActiveWorkbook?.()?.getSheetBySheetId?.(sheetId);
            const rich = source ? plotGridSourceToUniverRichText(source, nativeLinkColor) : null;
            const hasLinkMarkup = /\[\[[^\]]+/.test(source)
                || /\[[^\]]+\]\([^)]*\)/.test(source)
                || /<a\b/i.test(source);
            const payload: Record<string, unknown> = {
                v: source ? (rich?.displayText ?? source) : '',
                p: source && nativeRichTextEnabled && rich ? rich.cellDocument : null,
                custom: source ? { [PLOTGRID_SOURCE_FIELD]: source } : { [PLOTGRID_SOURCE_FIELD]: '' },
            };
            // Drop leftover link color when the source is now plain text.
            if (!hasLinkMarkup && !(cell?.textColor || '').trim()) {
                payload.s = { cl: null };
            }
            sheet?.getRange?.(row, col)?.setValue?.(payload);
        } catch (error) {
            console.warn('[NarrativeLab] Univer applyCellSource failed:', error);
        }
        refreshLinkMarkers();
    };

    const readLiveCellPlainText = (sheetId: string, row: number, col: number): string | null => {
        try {
            const sheet = univerAPI.getActiveWorkbook?.()?.getSheetBySheetId?.(sheetId);
            const range = sheet?.getRange?.(row, col);
            if (!range) return null;
            const data = range.getCellData?.();
            const value = range.getValue?.();
            const asText = (raw: unknown): string => {
                if (raw == null) return '';
                if (typeof raw === 'string' || typeof raw === 'number' || typeof raw === 'boolean') return String(raw);
                return '';
            };
            if (data && typeof data === 'object') {
                const fromCell = univerCellPlainText(data);
                if (fromCell != null) return fromCell;
                if (!('v' in data) && !('p' in data) && !('f' in data)) return '';
            }
            return asText(value);
        } catch {
            return null;
        }
    };

    const isEditorBusy = () => {
        // Floating Markdown editors must not freeze Univer pulls — they persist
        // themselves. Remounts are gated separately via isExternalEditorBusy.
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
            if (active.closest('.univer-cell-editor, .univer-editor-container, [class*="cell-editor"]')) {
                return true;
            }
            // Formula bar is always an input. Only block while Univer reports an
            // edit session — otherwise focus lingering there froze autosave.
            if (active.closest('.univer-formula-bar, [class*="formula-editor"]')) {
                return cellEditing || composing;
            }
            // In-host contenteditable only (the actual cell editor surface).
            if (opts.container.contains(active) && active.isContentEditable) return true;
            return false;
        } catch {
            return false;
        }
    };

    const applyPendingSetDoc = () => {
        if (disposed || !pendingSetDoc || isEditorBusy() || opts.isExternalEditorBusy?.()) return;
        const next = pendingSetDoc;
        pendingSetDoc = null;
        liveDoc = next;
        contentFp = conceptGridContentFingerprint(liveDoc);
        // Let Univer finish compositionend / editor teardown before remounting.
        window.setTimeout(() => {
            if (disposed || isEditorBusy() || opts.isExternalEditorBusy?.()) {
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
        // Explicit range-value/clear mutations own deletions. A saved workbook is
        // sparse even after the editor closes, so omitted cells are never deletes.
        schedulePull();
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
        pendingClearMissing ||= pullOpts.clearMissing === true;
        pendingMergeDimensions ||= pullOpts.mergeDimensions === true;
        // Keep this short: a long debounce left edits only in Univer while vault
        // refresh / tab close could reload or save a stale NarrativeLab document.
        // Never save while the context menu is open: workbook.save() steals the
        // rAF Univer uses to un-hide the flyout, so "Clear / Insert" never appear
        // and leftover flyouts stack for 500ms. Hold a short window after
        // right-click because Univer shows the menu on the next animation frame.
        if (Date.now() < menuHoldUntil || isUniverContextMenuOpen(univerInstance, opts.container.ownerDocument)) {
            pendingAfterMenu = true;
            return;
        }
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
        // Keep this short: a long debounce left edits only in Univer while vault
        // refresh / tab close could reload or save a stale NarrativeLab document.
        timer = window.setTimeout(() => {
            timer = 0;
            if (Date.now() < menuHoldUntil || isUniverContextMenuOpen(univerInstance, opts.container.ownerDocument)) {
                pendingAfterMenu = true;
                return;
            }
            if (isEditorBusy()) {
                pendingAfterEdit = true;
                return;
            }
            const clearMissing = pendingClearMissing;
            const mergeDimensions = pendingMergeDimensions;
            pendingClearMissing = false;
            pendingMergeDimensions = false;
            pullFromUniver(false, { clearMissing, mergeDimensions });
        }, 80);
    };

    let stopHoverAssist: (() => void) | null = null;
    const startHoverAssist = () => {
        if (stopHoverAssist) return;
        stopHoverAssist = installUniverContextMenuHoverAssist(opts.container.ownerDocument);
    };
    const endHoverAssist = () => {
        stopHoverAssist?.();
        stopHoverAssist = null;
    };
    disposers.push(endHoverAssist);
    disposers.push(installUniverSheetListReorder({
        doc: opts.container.ownerDocument,
        getSheets: () => {
            const workbook = univerAPI.getActiveWorkbook?.();
            const sheets = workbook?.getSheets?.() ?? [];
            if (sheets.length) {
                return sheets.map(sheet => ({
                    id: sheet.getSheetId(),
                    title: sheet.getSheetName?.() || sheet.getName?.() || '',
                }));
            }
            return liveDoc.pages.map(page => ({ id: page.id, title: page.title }));
        },
        getUnitId: () => univerAPI.getActiveWorkbook?.()?.getId?.() ?? null,
        reorderSheet: (sheetId, order, unitId) => {
            univerAPI.executeCommand?.('sheet.command.set-worksheet-order', {
                order,
                subUnitId: sheetId,
                unitId,
            });
        },
    }));
    disposers.push(installUniverContextMenuGuard(
        univerInstance,
        opts.container.ownerDocument,
        opts.container,
        () => {
            pendingAfterMenu = true;
            menuHoldUntil = Date.now() + 500;
            startHoverAssist();
            if (timer) {
                window.clearTimeout(timer);
                timer = 0;
            }
        },
        () => {
            endHoverAssist();
            if (disposed || !pendingAfterMenu) return;
            pendingAfterMenu = false;
            schedulePull();
        },
    ));

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
                BeforeSheetEditStart?: string;
            };
            onCommandExecuted?: (cb: (c: unknown) => void) => unknown;
        };
        if (api.Event?.CommandExecuted) {
            const sub = univerAPI.addEvent(api.Event.CommandExecuted, (command) => {
                const id = commandId(command);
                const params = commandParams(command);
                // Univer's default blank workbook emits insert/remove while ours
                // is still replacing it. Ignore that until the real sheets paint.
                if (disposing || !syncEnabled) return;
                const commandUnit = commandWorkbookUnitId(params);
                if (ourUnitId && commandUnit && commandUnit !== ourUnitId) return;

                if (id === 'sheet.operation.set-cell-edit-visible'
                    || id === 'sheet.operation.set-cell-edit-visible-f2'
                    || id === 'sheet.operation.set-cell-edit-visible-arrow') {
                    const visible = params?.visible;
                    if (typeof visible === 'boolean') {
                        cellEditing = visible;
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

                const structured = applyAxisStructureMutation(liveDoc, command);
                if (structured) {
                    liveDoc = structured;
                    contentFp = conceptGridContentFingerprint(liveDoc);
                    // Publish the new stable axis ids immediately. The following
                    // pull deliberately starts from the parent's authoritative
                    // document, so it must already include this splice.
                    opts.onDocumentChange(liveDoc);
                    // Native row/column insertion produces sparse blank buckets.
                    // Clearing omitted cells is safe after the structural mutation
                    // settles and prevents old content from duplicating into them.
                    schedulePull({ mergeDimensions: true });
                    return;
                }

                const sheetChrome = applyUniverSheetChromeMutation(liveDoc, command);
                if (sheetChrome) {
                    liveDoc = sheetChrome;
                    contentFp = conceptGridContentFingerprint(liveDoc);
                    opts.onDocumentChange(liveDoc);
                    window.setTimeout(() => {
                        if (!disposed) schedulePull({ mergeDimensions: true });
                    }, 120);
                    return;
                }

                // Sheet-bar add/copy/delete/reorder: workbook.save() lags one
                // frame and can omit existing tabs. Pull after Univer settles.
                if (
                    /insert-sheet|remove-sheet|copy-sheet|set-worksheet-order|set-tab-color/i.test(id)
                ) {
                    window.setTimeout(() => {
                        if (!disposed) schedulePull({ mergeDimensions: true });
                    }, 120);
                    return;
                }

                // Value edits while the cell editor is open are deferred via isEditorBusy.
                // Also skip noisy formula/doc mutations until the editor session ends —
                // polling mid-keystroke causes autosave → vault refresh → workbook remount jumps.
                if (id.startsWith('doc.mutation.') || id.startsWith('doc.command.')) {
                    if (isEditorBusy()) {
                        pendingAfterEdit = true;
                        return;
                    }
                }
                // Delete / Clear contents / Clear all / paste commit as range values
                // without opening the in-cell editor. Sparse workbook.save() omits
                // those cells (or stores null), so omissions must be treated as clears
                // or the Markdown source comes back in the cell editor.
                if (
                    id === 'sheet.command.clear-selection-all'
                    || id === 'sheet.command.clear-selection-content'
                    || id === 'sheet.mutation.set-range-values'
                    || id === 'sheet.mutation.set-range-formatted-value'
                    || id === 'sheet.command.set-range-values'
                ) {
                    const sheetId = typeof params?.subUnitId === 'string' ? params.subUnitId : lastSelection?.sheetId;
                    markClearedUniverCells(
                        sheetId,
                        params?.cellValue as Record<number, Record<number, unknown>> | undefined,
                    );
                    if (
                        (id === 'sheet.command.clear-selection-all'
                            || id === 'sheet.command.clear-selection-content')
                        && lastSelection
                    ) {
                        recentlyClearedCells.add(
                            `${lastSelection.sheetId}:${lastSelection.row}:${lastSelection.col}`,
                        );
                    }
                    const mutated = applyClearSelectionMutation(liveDoc, command, lastSelection)
                        ?? applyRangeValuesMutation(liveDoc, command);
                    if (mutated) {
                        liveDoc = mutated;
                        contentFp = conceptGridContentFingerprint(liveDoc);
                        opts.onDocumentChange(liveDoc);
                    }
                    if (isEditorBusy()) {
                        pendingAfterEdit = true;
                        return;
                    }
                    // Mutations already captured typed cells. workbook.save() lags
                    // and a clearMissing pull would drop the rest of the sheet.
                    if (mutated) return;
                    schedulePull();
                    return;
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
                if (pendingAfterEdit && !cellEditing && !composing) onEditorSessionEnd();
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
    } catch (e) {
        console.warn('[NarrativeLab] Univer event hook failed:', e);
    }

    // Initial settle — ignore bootstrap commands from createWorkbook.
    suppressUntil = Date.now() + 800;

    return {
        dispose: () => {
            if (disposed || disposing) return;
            disposing = true;
            if (revealFrame) {
                window.cancelAnimationFrame(revealFrame);
                revealFrame = 0;
            }
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
            // Teardown snapshots are sparse. Never treat omitted cells as deletes,
            // and never publish this pull back into the view (it already flushed).
            try {
                pullFromUniver(true, {
                    clearMissing: false,
                    mergeDimensions: true,
                    silent: true,
                });
            } catch { /* ignore */ }
            pendingClearMissing = false;
            pendingMergeDimensions = false;
            recentlyClearedCells.clear();
            disposed = true;
            livePlotGridRelayouts.delete(relayout);
            for (const d of disposers) {
                try { d(); } catch { /* ignore */ }
            }
            try {
                disposeOwnedWorkbook();
            } catch { /* ignore */ }
            try {
                univerAPI.dispose?.();
            } catch { /* ignore */ }
            opts.container.empty();
            scheduleSiblingPlotGridRelayout(relayout);
        },
        getDocument: () => liveDoc,
        setDocument: (doc: ConceptGridDocument) => {
            const next = structuredClone(doc);
            if (isEditorBusy() || opts.isExternalEditorBusy?.()) {
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
            if (!next.univerResources?.length && liveDoc.univerResources?.length) {
                next.univerResources = liveDoc.univerResources;
            }
            if (!next.univerStyles && liveDoc.univerStyles) {
                next.univerStyles = liveDoc.univerStyles;
            }
            for (const page of next.pages) {
                const livePage = liveDoc.pages.find(item => item.id === page.id);
                if (livePage?.univerExtras && !page.univerExtras) page.univerExtras = livePage.univerExtras;
            }
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
        applyCellSource,
        readLiveCellPlainText,
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
                || pendingAfterMenu
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
            pendingAfterMenu = false;
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
            // Forced snapshots are normally sparse and keep omitted cells. A
            // completed axis splice explicitly upgrades this to clearMissing:true
            // so newly inserted blank rows/columns cannot inherit old content.
            // mergeDimensions:true — capture finished resize gesture sizes.
            // pendingAfterEdit means Univer value mutations ran while the editor
            // was busy; those omitted cells are real clears once we flush.
            pendingAfterEdit = false;
            pendingClearMissing = false;
            pendingMergeDimensions = false;
            // Do not clear omitted cells here — workbook.save() still lags the
            // mutation stream and would persist only part of a typing burst.
            pullFromUniver(true, { clearMissing: false, mergeDimensions: true });
            // Prefer the live active cell, including an empty value (Delete).
            const active = lastSelection;
            if (active) {
                const text = readLiveCellPlainText(active.sheetId, active.row, active.col);
                const clearedKey = `${active.sheetId}:${active.row}:${active.col}`;
                // Stale getValue() after Delete must not resurrect header/body text
                // the mutation stream already cleared.
                if (text != null && !(text && recentlyClearedCells.has(clearedKey))) {
                    const next = mergeUniverCellDataIntoDocument(liveDoc, active.sheetId, {
                        [active.row]: { [active.col]: { v: text } },
                    });
                    const nextFp = conceptGridContentFingerprint(next);
                    if (nextFp !== contentFp) {
                        liveDoc = next;
                        contentFp = nextFp;
                        opts.onDocumentChange(liveDoc);
                    }
                }
            }
            recentlyClearedCells.clear();
        },
        relayout,
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
                univerStyle: c?.univerStyle,
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
