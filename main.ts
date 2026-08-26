/* eslint-disable @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-argument, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-return, @typescript-eslint/no-floating-promises, @typescript-eslint/no-misused-promises, @typescript-eslint/no-unnecessary-type-assertion, @typescript-eslint/no-unused-vars, no-useless-escape -- Obsidian's API surface and several untyped third-party libraries force dynamic dispatch; floating promises are intentional in DOM/event handlers; matching enable at end of file */
import { AbstractInputSuggest, App, ButtonComponent, DropdownComponent, FileView, FuzzySuggestModal, ItemView, Modal, Notice, Platform, Plugin, Setting, TFile, TFolder, TextComponent, ToggleComponent, WorkspaceLeaf, normalizePath, parseYaml, setIcon, stringifyYaml } from 'obsidian';
import { SceneCardsSettings, SceneCardsSettingTab, DEFAULT_SETTINGS } from './settings';
import { asRecord, isRecord } from './utils/narrow';
import { countWordRevisionChurn } from './utils/wordcountText';
import { consumeTextareaUndoKey, isLocalTextUndoTarget, isRedoKey, isUndoKey } from './utils/textareaHistory';
import {
    OBSIDIAN_OPENABLE_EXTENSION_FALLBACK,
    shouldHideFileExplorerFile,
    shouldHideFileExplorerFolder,
    type FileExplorerVisibilityRules,
} from './utils/fileExplorerVisibility';
import {
    getLeafNarrativeLabProjectFile,
    narrativeLabLeafState,
} from './utils/narrativeLabLeafState';
import type { FilterPreset, ViewType } from './models/Scene';
import { SceneManager } from './services/SceneManager';
import { registerCustomStatuses } from './models/Scene';
import { setWriteSceneFieldsAsWikilinks, setWordcountExclusions, setWordcountLocale } from './services/MetadataParser';
import { normalizeStoryLineLocale } from './utils/locale';
import {
    localizePluginSubtree,
    normalizeUiLanguageSetting,
    resolveUiLanguage,
    setActiveUiLanguage,
    t,
    type UiLanguage,
    type UiLanguageSetting,
} from './utils/i18n';
import { ensureSeededCharacterRelationTypes } from './utils/storyGraphCharacterRelations';
import { setActiveTemplatesProvider, setTopLevelMirrorEnabled, mirrorUniversalFieldsToTopLevel, hydrateUniversalFieldsFromTopLevel, isReservedTopLevelKey, type FieldTemplateChange } from './services/FieldTemplateService';
import {
    BOARD_VIEW_TYPE,
    TIMELINE_VIEW_TYPE,
    STORYLINE_VIEW_TYPE,
    CHARACTER_VIEW_TYPE,
    STATS_VIEW_TYPE,
    PLOTGRID_VIEW_TYPE,
    LOCATION_VIEW_TYPE,
    NAVIGATOR_VIEW_TYPE,
    CODEX_VIEW_TYPE,
    SCENE_INSPECTOR_VIEW_TYPE,
    MANUSCRIPT_VIEW_TYPE,
    RESEARCH_VIEW_TYPE,
    NOTES_VIEW_TYPE,
    SYNOPSIS_VIEW_TYPE,
    DETAILS_VIEW_TYPE,
    NARRATIVE_CANVAS_VIEW_TYPE,
    NCANVAS_LIBRARY_VIEW_TYPE,
    WRITING_TRACKER_PANEL_TYPE,
    WRITING_TRACKER_VIEW_TYPE,
} from './constants';
import { PlotgridView } from './views/PlotgridView';
import {
    type ConceptGridDocument,
    type PlotGridAppearanceHit,
    type PlotGridData,
    countConceptGridFilledCells,
    isConceptGridDocumentEmpty,
    isDefaultEmptyConceptGrid,
    isIncompleteConceptGridPull,
    normalizeConceptGridDocument,
    shouldRefuseEmptyPlotGridWrite,
} from './models/PlotGridData';
import {
    decodePlotGridXlsx,
    documentFromNlMeta,
    encodePlotGridXlsx,
    extractEmbeddedNlMeta,
    countPlotGridXlsxFilledCells,
    releasePlotGridWorkbookCache,
    legacyLibraryPlotGridNlMetaPath,
    legacyPlotGridFolderXlsxPath,
    legacySystemPlotGridXlsxPath,
    plotGridFolderPath,
    plotGridNlMetaPath,
    plotGridNlMetaStructureMatchesDocument,
    plotGridWorkbookContentFingerprint,
    plotGridXlsxNeedsRewrite,
    plotGridXlsxPath,
    legacyPlotGridXlsxPath,
    serializePlotGridNlMeta,
    tryParseNlMeta,
    LEGACY_PLOTGRID_XLSX_FILENAME,
    PLOTGRID_XLSX_LEGACY_FILENAME,
    PLOTGRID_XLSX_PREFIX,
    type PlotGridNlMeta,
} from './services/PlotGridXlsxCodec';
import {
    deriveProjectFoldersFromFilePath,
    LEGACY_NCANVAS_FOLDER,
    LEGACY_SYSTEM_NCANVAS_FOLDER,
    type SeriesMetadata,
    type StoryLineProject,
} from './models/StoryLineProject';
import { BoardView } from './views/BoardView';
import { TimelineView } from './views/TimelineView';
import { StorylineView } from './views/StorylineView';
import { CharacterView } from './views/CharacterView';
import { StatsView } from './views/StatsView';
import { LocationView } from './views/LocationView';
import { NavigatorView } from './views/NavigatorView';
import { CodexView } from './views/CodexView';
import {
    isCanvasLibraryProfileMounted,
    mountCanvasLibraryProfile,
    unmountCanvasLibraryProfile,
} from './views/CanvasLibraryProfileHost';
import { SceneInspectorView } from './views/SceneInspectorView';
import { NotesView } from './views/NotesView';
import { SynopsisView } from './views/SynopsisView';
import { DetailsView } from './views/DetailsView';
import { ManuscriptView, clearLastManuscriptState } from './views/ManuscriptView';
import { ResearchView } from './views/ResearchView';
import { WritingTrackerPanel } from './views/WritingTrackerPanel';
import { WritingTrackerView } from './views/WritingTrackerView';
import { NCanvasLibraryView } from './views/NCanvasLibraryView';
import { ResearchManager } from './services/ResearchManager';
import { FloatingStickyNoteManager } from './services/FloatingStickyNoteManager';
import { LocationManager } from './services/LocationManager';
import { CharacterManager } from './services/CharacterManager';
import { CodexManager } from './services/CodexManager';
import { makeProfileCodexCategory, UNCATEGORIZED_CATEGORY_ID } from './models/Codex';
import { CHARACTER_CATEGORIES } from './models/Character';
import { LOCATION_CATEGORIES, WORLD_CATEGORIES } from './models/Location';
import {
    collectMarkdownFiles,
    invalidateAllEntityCaches,
    isExcalidrawFilePath,
    readVaultText,
    renameAllEntityCachePrefixes,
    renameAllEntityCaches,
} from './services/EntityFileCache';
import {
    adoptLibraryTargets,
    type LibraryAdoptTarget,
} from './services/LibraryEntityAdoption';
import {
    applyCategoryFolderLabels,
    applyLibraryCategorySettings,
    emptyLibraryCategorySettings,
    ensureSeededLibraryCategoryLabels,
    handleLibraryFolderVaultRename,
    LIBRARY_CATEGORIES_FILENAME,
    libraryCategorySettingsFromUnknown,
    listVisibleLibraryCategories,
    resolveLibraryCategoryLabelForKind,
    parentOfPath,
    readLibraryCategorySettings,
    reconcileLibraryCategoriesForActiveProject,
    seedStorylinePresetCategories,
} from './services/LibraryCategorySync';
import {
    applyLibraryProfileLayout,
    emptyLibraryProfileLayout,
    LIBRARY_PROFILE_LAYOUT_FILENAME,
    getOrderedProfileSectionIds,
    libraryProfileLayoutFromUnknown,
    readLibraryProfileLayout,
} from './utils/libraryProfileLayout';
import { vaultRelativeFolderPath } from './utils/vaultFolders';
import { clearPendingStoryGraphWikilinks } from './components/LibraryModeBar';
import { rebaseStoryGraphRelationPaths } from './utils/storyGraphRefs';
import { QuickAddModal } from './components/QuickAddModal';
import { ConverterModal, type ConverterTab } from './components/ConverterModal';
import { syncAllNativeLibraryBases } from './components/NativeLibraryBase';
import {
    buildCustomFieldTopLevelKeyMap,
    hydrateCustomFieldsFromTopLevel,
    mirrorCustomFieldsToTopLevel,
    orderLibraryEntityFrontmatter,
    setLibraryProfilePropertyOrderProvider,
    type LibraryProfilePropertyOrder,
} from './utils/libraryProfilePropertyOrder';
import { CUSTOM_SECTION_KEY_SEP, type CustomSection } from './components/CustomSectionsRenderer';
import { migrateLibraryAttachmentsForAllProjects } from './services/LibraryAttachmentMigration';
import {
    SAMPLE_NCANVAS_FILENAMES,
    type SampleNcanvasLanguage,
} from './components/NCanvasManagerModal';
import { WritingTracker, type WritingTrackerData } from './services/WritingTracker';
import { GlobalWritingTracker } from './services/GlobalWritingTracker';
import { SnapshotManager } from './services/SnapshotManager';
import { PlotlineManager } from './services/PlotlineManager';
import { clonePlotlineDefinitions, type PlotlineDefinition } from './models/Plotline';
import { LinkScanner } from './services/LinkScanner';
import { CascadeRenameService } from './services/CascadeRenameService';
import { FieldTemplateService } from './services/FieldTemplateService';
import { TemplateCenterService } from './services/TemplateCenterService';
import { SeriesManager } from './services/SeriesManager';
import {
    LibraryEntityBoardService,
    type CreateLibraryEntityBoardEntry,
} from './services/LibraryEntityBoardService';
import { buildFormattingToolbar } from './components/FormattingToolbar';
import { setupMobileKeyboardHandling } from './components/MobileAdapter';

function plotGridBinaryDigest(data: ArrayBuffer | Uint8Array): string {
    const bytes = data instanceof Uint8Array ? data : new Uint8Array(data);
    let hash = 2166136261;
    for (const byte of bytes) {
        hash ^= byte;
        hash = Math.imul(hash, 16777619);
    }
    return `${bytes.byteLength}:${(hash >>> 0).toString(16)}`;
}

function plotGridTextDigest(text: string): string {
    let hash = 2166136261;
    for (let i = 0; i < text.length; i++) {
        hash ^= text.charCodeAt(i);
        hash = Math.imul(hash, 16777619);
    }
    return `${text.length}:${(hash >>> 0).toString(16)}`;
}

function isTransientVaultIoError(error: unknown): boolean {
    const message = error instanceof Error ? `${error.message} ${error.name}` : String(error);
    return /UNKNOWN|EBUSY|EPERM|EACCES|EAGAIN|resource busy|locked|busy|access denied|sharing violation/i
        .test(message);
}

function waitForVaultRetry(ms: number): Promise<void> {
    return new Promise(resolve => window.setTimeout(resolve, ms));
}

interface PlotGridWriteJournal {
    schema: 1;
    previousXlsxDigest: string | null;
    nextXlsxDigest: string;
    meta: PlotGridNlMeta;
}

function plotGridWriteJournalPath(metaPath: string): string {
    return `${metaPath}.write-journal`;
}

type EmbeddedCanvasModule = Plugin & {
    onload: () => Promise<void>;
    unload: () => void;
    openProjectFile?: (path: string) => Promise<void>;
    openCanvas?: () => Promise<void>;
    openOrCreateProjectAtPath?: (path: string, title: string) => Promise<string>;
    writeAndOpenProjectAtPath?: (path: string, savedStateJson: string) => Promise<string>;
    createSampleProjectAtPath?: (path: string, language?: string) => Promise<string>;
    /** Overridden by NarrativeLab to share Library ↔ Canvas/<Name>.canvas creation. */
    createCodexCanvas?: (entry: CreateLibraryEntityBoardEntry) => Promise<string>;
    mountCanvasLibraryProfile?: (
        canvasView: { contentEl: HTMLElement },
        payload: { entryId: string; name: string; kind: string; codexFile: string },
    ) => Promise<boolean>;
    unmountCanvasLibraryProfile?: (canvasView: { contentEl: HTMLElement }) => Promise<void>;
    isCanvasLibraryProfileMounted?: (canvasView: { contentEl: HTMLElement }) => boolean;
    getNarrativeLabLibraryCategories?: () => Array<{ id: string; label: string; folder: string }>;
    resolveNarrativeLabLibraryCategoryLabel?: (kind: string) => string;
    openNarrativeLabLibraryCategoryManager?: (onDone?: () => void) => void;
    loadData: () => Promise<Record<string, unknown>>;
    saveData: (data: Record<string, unknown>) => Promise<void>;
    addSettingTab: (...args: unknown[]) => void;
    /** NarrativeLab injects the configured project attachment folder name. */
    getProjectAttachmentFolderName?: () => string;
    /** Active project's Library folder map (characters → 角色, …) for canvas writes. */
    getNarrativeLabLibraryFolderMap?: (projectPath?: string) => Record<string, string>;
    /** NarrativeLab owns the interface language when Canvas is embedded. */
    getNarrativeLabInterfaceLanguage?: () => UiLanguage;
    /** NarrativeLab owns light/dark UI theme when Canvas is embedded. */
    getNarrativeLabUiTheme?: () => 'light' | 'dark';
    onNarrativeLabUiThemeChanged?: (theme: 'light' | 'dark') => void;
    onNarrativeLabLanguageChanged?: (language: UiLanguage) => void;
    createSampleInActiveProject?: (language?: string) => Promise<string | null>;
    openNarrativeLabCanvasLibrary?: (canvasPath?: string) => Promise<void>;
    createCurrentProjectBackup?: () => Promise<string>;
    chooseProjectBackupToRestore?: () => Promise<string>;
    notifyCanvasSettingsChanged?: () => void;
    savePluginData?: () => Promise<void>;
    settings?: Record<string, unknown>;
};

type ProjectFolderChoice = {
    value: string | null;
    inputValue: string;
    label: string;
};

/** Editable vault-folder picker used by the new-project modal. */
class ProjectFolderSuggest extends AbstractInputSuggest<ProjectFolderChoice> {
    constructor(
        app: App,
        inputEl: HTMLInputElement,
        private defaultPath: string,
        private onSelectPath: (path: string | null) => void,
    ) {
        super(app, inputEl);
    }

    getSuggestions(query: string): ProjectFolderChoice[] {
        const choices: ProjectFolderChoice[] = [];
        if (this.defaultPath) {
            choices.push({
                value: null,
                inputValue: '',
                label: t('Default location ({path})', { path: this.defaultPath }),
            });
        }
        choices.push({ value: '', inputValue: '/', label: t('Vault root (/)') });

        const folders: TFolder[] = [];
        const walk = (folder: TFolder): void => {
            for (const child of folder.children) {
                if (!(child instanceof TFolder)) continue;
                const segments = child.path.split('/');
                if (segments.some(segment => segment.startsWith('.'))) continue;
                folders.push(child);
                walk(child);
            }
        };
        walk(this.app.vault.getRoot());
        const skipChild = new Set(['library', 'scenes', 'system', 'canvas', 'notes', 'research', 'scenenotes', 'archive', 'attachments']);
        for (const folder of folders.sort((a, b) => a.path.localeCompare(b.path))) {
            const name = folder.path.split('/').pop()?.toLowerCase() ?? '';
            if (skipChild.has(name)) continue;
            choices.push({ value: folder.path, inputValue: folder.path, label: folder.path });
        }

        const normalizedQuery = query.trim().toLowerCase();
        // `/` means vault root, not "list every folder".
        if (normalizedQuery === '/') {
            return choices.filter(choice => choice.value === null || choice.value === '');
        }
        if (!normalizedQuery) return choices.slice(0, 100);
        return choices
            .filter(choice => choice.label.toLowerCase().includes(normalizedQuery)
                || choice.inputValue.toLowerCase().includes(normalizedQuery))
            .slice(0, 100);
    }

    renderSuggestion(choice: ProjectFolderChoice, el: HTMLElement): void {
        el.setText(choice.label);
    }

    selectSuggestion(choice: ProjectFolderChoice): void {
        this.setValue(choice.inputValue);
        this.onSelectPath(choice.value);
        this.close();
    }
}

type EmbeddedCanvasConstructor = new (app: App, manifest: Plugin['manifest']) => EmbeddedCanvasModule;

/**
 * NarrativeLab Plugin for Obsidian
 *
 * Transforms your vault into a powerful book planning tool.
 */

export default class SceneCardsPlugin extends Plugin {
    settings: SceneCardsSettings = DEFAULT_SETTINGS;
    sceneManager!: SceneManager;
    /** Set to true once System/ migration is confirmed — guards saveSettings stripping */
    private _systemMigrationDone = false;
    /** Snapshot of colour settings from data.json (global defaults) */
    private _globalColorDefaults: Partial<SceneCardsSettings> = {};
    /**
     * One-time seed for migrating Library categories out of global data.json.
     * Captured at load; each project gets its own System/library-categories.json.
     */
    private _legacyLibraryCategoryDefaults = emptyLibraryCategorySettings();
    /** One-time seed when migrating profile field layout out of global data.json. */
    private _legacyLibraryProfileLayoutDefaults = emptyLibraryProfileLayout();
    locationManager!: LocationManager;
    characterManager!: CharacterManager;
    codexManager!: CodexManager;
    writingTracker: WritingTracker = new WritingTracker();
    /** Blocks delayed refresh/file events while a different project ledger is loading. */
    private _writingTrackerProjectSwitching = false;
    globalWritingTracker!: GlobalWritingTracker;
    private _writingTrackerSaveTimer: number | null = null;
    floatingStickyNotes!: FloatingStickyNoteManager;
    snapshotManager!: SnapshotManager;
    plotlineManager!: PlotlineManager;
    /** Per-project plotline registry (System/plotlines.json → definitions). */
    plotlineDefinitions: PlotlineDefinition[] = [];
    /** Project file that currently owns `plotlineDefinitions`. */
    plotlineRegistryOwner = '';
    /** True while System/ JSON for a project is being loaded after a switch. */
    private _loadingProjectSystemData = false;
    linkScanner!: LinkScanner;
    cascadeRename!: CascadeRenameService;
    fieldTemplates!: FieldTemplateService;
    templateCenter!: TemplateCenterService;
    seriesManager!: SeriesManager;
    researchManager!: ResearchManager;
    /** Shared Library note ↔ Canvas/<Name>.canvas boards (CharacterView + Narrative Canvas). */
    libraryEntityBoard!: LibraryEntityBoardService;
    canvasModule: EmbeddedCanvasModule | null = null;
    private _canvasModuleLoading: Promise<void> | null = null;
    /** Paths whose vault writes should not trigger open-view refresh (corkboard.canvas, etc.). */
    private _suppressVaultRefreshPaths = new Set<string>();
    /** Coalesce concurrent full / light view refreshes. */
    private _refreshOpenViewsPromise: Promise<void> | null = null;
    private _pendingOpenViewsRefresh: 'none' | 'views' | 'full' = 'none';
    /** Coalesce concurrent Library/entity reloads (Codex + Characters + Locations). */
    private _reloadEntitiesPromise: Promise<boolean> | null = null;
    /** A vault structure event arrived while a Library reload was in progress. */
    private _reloadEntitiesQueued = false;
    /** Bumps when Library category tabs are adopted from vault folders (live sync). */
    libraryCategoriesStructureEpoch = 0;
    /** Last decoded datasheet per project — skip ExcelJS on reopen when the file is unchanged. */
    private _plotGridDocCache = new Map<string, {
        projectFile: string;
        xlsxPath: string;
        mtime: number;
        size: number;
        xlsxDigest: string;
        metaDigest: string;
        doc: ConceptGridDocument;
    }>();
    /** Avoid writing the same rejected in-memory grid to recovery repeatedly in one session. */
    private _preservedPlotGridRecoveryPaths = new Map<string, string>();
    /** A rejected save stays visible without spamming every autosave tick. */
    private _reportedPlotGridRecoveryNotices = new Set<string>();
    /** Cached plotgrid mention scan — rebuilds are expensive on large grids. */
    private _plotGridScanCache: {
        projectFile: string;
        at: number;
        result: {
            characters: Map<string, Set<string>>;
            locations: Map<string, Set<string>>;
            tags: Map<string, Set<string>>;
            characterHits: Map<string, PlotGridAppearanceHit[]>;
            locationHits: Map<string, PlotGridAppearanceHit[]>;
            tagHits: Map<string, PlotGridAppearanceHit[]>;
            filePath: string;
        };
    } | null = null;
    private static readonly PLOTGRID_SCAN_TTL_MS = 60_000;
    /** Timestamp of the last completed reloadEntities() pass. */
    private _lastEntitiesReloadAt = 0;
    /** In-memory entity maps for background project tabs — avoids a full disk rescan on focus. */
    private _projectRuntimeCache = new Map<string, {
        scenes: ReturnType<SceneManager['exportSceneIndex']>;
        characters: ReturnType<CharacterManager['exportSnapshot']>;
        locations: ReturnType<LocationManager['exportSnapshot']>;
        codex: ReturnType<CodexManager['exportSnapshot']>;
        research: ReturnType<ResearchManager['exportSnapshot']>;
        plotlineDefinitions: PlotlineDefinition[];
        plotlineRegistryOwner: string;
        tagColors: Record<string, string>;
        tagTypeOverrides: Record<string, string>;
    }>();
    /** True while writing type/name frontmatter onto plain Library notes. */
    private _adoptingLibrary = false;
    /** True while UI-driven Library folder rename is in progress. */
    _syncingLibraryFolders = false;
    /** Files currently receiving/migrating the active frontmatter field. */
    private _activeFieldWrites = new Set<string>();
    /** Serialize per-scene revision snapshots so rapid saves cannot double-count churn. */
    private _writingRevisionQueues = new Map<string, Promise<void>>();
    /** Serialize writes to each System JSON file and protect unreadable originals. */
    private _systemJsonWriteQueues = new Map<string, Promise<void>>();
    /** Project roots temporarily frozen while a series operation moves them. */
    private _projectMoveWriteGuards = new Set<string>();
    private _invalidSystemJsonPaths = new Set<string>();
    private _reportedInvalidSystemJsonPaths = new Set<string>();
    /** Unreadable Library/datasheet.xlsx paths — block empty overwrite until explicit reset. */
    private _invalidPlotGridXlsxPaths = new Set<string>();
    private _reportedInvalidPlotGridXlsxPaths = new Set<string>();

    /** Suppress vault modify→refresh echo while the plugin writes a path. */
    withSuppressedVaultEcho<T>(filePath: string, fn: () => Promise<T>): Promise<T> {
        const path = normalizePath(filePath);
        this._activeFieldWrites.add(path);
        return fn().finally(() => {
            this._activeFieldWrites.delete(path);
        });
    }
    /** The leaf currently hosting a NarrativeLab view */
    storyLeaf: WorkspaceLeaf | null = null;
    /** Removes native browser tooltips (`title`) inside NarrativeLab UI */
    private nativeTooltipObserver: MutationObserver | null = null;
    /** Disables native spell-check inside NarrativeLab UI inputs (issue #189) */
    private spellcheckObserver: MutationObserver | null = null;
    /** Applies the selected language to dynamically rendered NarrativeLab UI. */
    private uiLanguageObserver: MutationObserver | null = null;
    /** Keeps Narrative Canvas in sync when Obsidian appearance changes (uiTheme = auto). */
    private uiThemeObserver: MutationObserver | null = null;
    private lastObservedObsidianTheme: 'light' | 'dark' | null = null;
    /** Keeps Obsidian's Files view free of NarrativeLab internals and unreadable files. */
    private fileExplorerVisibilityObserver: MutationObserver | null = null;
    private fileExplorerVisibilityRibbonEl: HTMLElement | null = null;
    /** Avoid rewriting every Library note more than once per project session. */
    private customFieldFrontmatterSyncedProjects = new Set<string>();

    /**
     * Resolve the Board that owns an undo shortcut. Corkboard Canvas runs in a
     * detached nested leaf, so Workspace's active ItemView is not a reliable
     * signal after the user clicks it.
     */
    private resolveCorkboardUndoBoard(event?: KeyboardEvent): BoardView | null {
        const boards = this.app.workspace.getLeavesOfType(BOARD_VIEW_TYPE)
            .map(leaf => leaf.view)
            .filter((view): view is BoardView => view instanceof BoardView);

        // Prefer the Canvas that actually received the key (or currently owns
        // focus). This also selects the correct project when several Boards are open.
        const eventOwner = boards.find(board => board.ownsCorkboardShortcutEvent(event));
        if (eventOwner) return eventOwner;

        const activeBoard = this.app.workspace.getActiveViewOfType(BoardView);
        if (activeBoard?.isCorkboardUndoContext()) return activeBoard;

        // Some Canvas gestures return focus to document.body. In that case use
        // the most recently interacted embedded Canvas for a short grace period.
        let recentBoard: BoardView | null = null;
        let recentAt = 0;
        for (const board of boards) {
            const interactedAt = board.getLastCorkboardInteractionAt();
            if (interactedAt > recentAt) {
                recentAt = interactedAt;
                recentBoard = board;
            }
        }
        return recentBoard && Date.now() - recentAt <= 5_000 ? recentBoard : null;
    }

    async onload(): Promise<void> {
        await this.loadSettings();
        this.updateFileExplorerVisibilityModeClass();
        this.applyUiTheme();
        this.observeObsidianUiTheme();
        setActiveUiLanguage(this.getEffectiveInterfaceLanguage());
        registerCustomStatuses(this.settings.customStatuses || []);
        this.applyImageSizingVariables();

        // Issue #189 — disable native spell-check in all NarrativeLab UI inputs,
        // textareas and contenteditables. Obsidian's "Disable spell check" only
        // applies to its own editor; plugin-rendered form fields inherit the
        // browser default (spellcheck on), causing red underlines for users
        // writing in languages like Vietnamese. A scoped MutationObserver
        // catches fields added dynamically (Inspector, modals, toolbar, etc.).
        this.disableSpellCheckInPluginUI();
        this.observePluginUiLanguage();
        this.app.workspace.onLayoutReady(() => this.observeFileExplorerVisibility());

        // Issue #190 — on mobile the soft keyboard can cover the focused
        // field in the Codex, Inspector, Corkboard note editor, etc. Install
        // a global focus/visual-viewport listener that scrolls the field
        // into the visible (above-keyboard) region. No-op on desktop.
        this.register(setupMobileKeyboardHandling());

        this.sceneManager = new SceneManager(this.app, this);
        this.plotlineManager = new PlotlineManager(this, this.sceneManager);
        this.locationManager = new LocationManager(this.app);
        this.characterManager = new CharacterManager(this.app);
        this.libraryEntityBoard = new LibraryEntityBoardService(this.app);
        // One-shot seed for player-editable Story Graph relation labels (Obsidian zh/en).
        void ensureSeededCharacterRelationTypes(this);
        this.codexManager = new CodexManager(this.app);
        this.snapshotManager = new SnapshotManager(
            this.app,
            () => this.sceneManager?.getEffectiveLocale()
                ?? this.settings.defaultProjectLanguage
                ?? 'en',
        );
        this.linkScanner = new LinkScanner(this.characterManager, this.locationManager);
        this.linkScanner.setCodexManager(this.codexManager);
        this.cascadeRename = new CascadeRenameService(this.sceneManager, this.characterManager, this.locationManager);
        this.fieldTemplates = new FieldTemplateService(this.app, () => this.getProjectSystemFolder());
        setLibraryProfilePropertyOrderProvider(categoryKey => this.resolveLibraryProfilePropertyOrder(categoryKey));
        this.register(() => setLibraryProfilePropertyOrderProvider(null));
        this.templateCenter = new TemplateCenterService(this.app, this);
        // Issue #71 — expose templates to parsers for top-level YAML mirroring
        setActiveTemplatesProvider(() => this.fieldTemplates.getAll());
        setTopLevelMirrorEnabled(this.settings.universalFieldsMirrorTopLevel !== false);
        // Issue #71 follow-up — when a template's topLevelKey or folderSource
        // changes, retro-mirror existing entities so users don't have to
        // re-edit every record by hand.
        this.fieldTemplates.setOnChange(async (change) => {
            await this.migrateUniversalFieldMirror(change);
        });
        this.seriesManager = new SeriesManager(this.app, this);
        this.researchManager = new ResearchManager(this.app, this);
        this.floatingStickyNotes = new FloatingStickyNoteManager(this);
        this.globalWritingTracker = new GlobalWritingTracker(this);
        const writingTrackerCheckpoint = window.setInterval(() => {
            if (this.writingTracker.isSprintRunning()) this.scheduleWritingTrackerSave();
        }, 30_000);
        this.register(() => window.clearInterval(writingTrackerCheckpoint));
        this.register(() => {
            void this.floatingStickyNotes.unloadAll();
        });

        // Wire up undo/redo to refresh views + re-index
        this.sceneManager.undoManager.onAfterUndoRedo = async () => {
            await this.sceneManager.initialize();
            this.refreshOpenViews();
        };

        // Register views
        this.registerView(BOARD_VIEW_TYPE, (leaf) =>
            new BoardView(leaf, this, this.sceneManager)
        );
        this.registerView(PLOTGRID_VIEW_TYPE, (leaf) =>
            new PlotgridView(leaf, this)
        );
        void import('./utils/loadPlotGridUniver').then(mod => {
            try { mod.warmupPlotGridUniver(activeDocument); } catch { /* first grid open still injects */ }
        });
        this.registerView(TIMELINE_VIEW_TYPE, (leaf) =>
            new TimelineView(leaf, this, this.sceneManager)
        );
        this.registerView(STORYLINE_VIEW_TYPE, (leaf) =>
            new StorylineView(leaf, this, this.sceneManager)
        );
        this.registerView(CHARACTER_VIEW_TYPE, (leaf) =>
            new CharacterView(leaf, this, this.sceneManager)
        );
        this.registerView(STATS_VIEW_TYPE, (leaf) =>
            new StatsView(leaf, this, this.sceneManager)
        );
        this.registerView(LOCATION_VIEW_TYPE, (leaf) =>
            new LocationView(leaf, this, this.sceneManager)
        );
        this.registerView(NAVIGATOR_VIEW_TYPE, (leaf) =>
            new NavigatorView(leaf, this, this.sceneManager)
        );
        this.registerView(CODEX_VIEW_TYPE, (leaf) =>
            new CodexView(leaf, this, this.sceneManager)
        );
        this.registerView(SCENE_INSPECTOR_VIEW_TYPE, (leaf) =>
            new SceneInspectorView(leaf, this, this.sceneManager)
        );
        this.registerView(NOTES_VIEW_TYPE, (leaf) =>
            new NotesView(leaf, this, this.sceneManager)
        );
        this.registerView(SYNOPSIS_VIEW_TYPE, (leaf) =>
            new SynopsisView(leaf, this, this.sceneManager)
        );
        this.registerView(DETAILS_VIEW_TYPE, (leaf) =>
            new DetailsView(leaf, this, this.sceneManager)
        );
        this.registerView(MANUSCRIPT_VIEW_TYPE, (leaf) =>
            new ManuscriptView(leaf, this, this.sceneManager)
        );
        this.registerView(RESEARCH_VIEW_TYPE, (leaf) =>
            new ResearchView(leaf, this, this.researchManager)
        );
        this.registerView(WRITING_TRACKER_PANEL_TYPE, (leaf) =>
            new WritingTrackerPanel(leaf, this)
        );
        this.registerView(WRITING_TRACKER_VIEW_TYPE, (leaf) =>
            new WritingTrackerView(leaf, this)
        );
        this.registerView(NCANVAS_LIBRARY_VIEW_TYPE, (leaf) =>
            new NCanvasLibraryView(leaf, this)
        );

        // Register layout bootstrap BEFORE awaiting Narrative Canvas.
        // Awaiting the embedded canvas inside onload delays Obsidian from
        // mounting saved sidebar leaves (navigator / inspector), which makes
        // the left & right sidebars visibly jump into place on startup.
        this.app.workspace.onLayoutReady(async () => {
            try {
            // Drop obsolete Help panes left in saved workspace layouts.
            for (const leaf of this.app.workspace.getLeavesOfType('narrative-lab-help')) {
                try { leaf.detach(); } catch { /* ignore */ }
            }
            // Apply frontmatter visibility (scoped to NarrativeLab files only — issue #104)
            this.updateFrontmatterVisibility({ collapseOpenFiles: true });
            window.setTimeout(() => {
                this.updateFrontmatterVisibility({ collapseOpenFiles: true });
            }, 200);
            // Apply toolbar visibility settings (v1.10.17) — hide the
            // Auto-collapse view-tab labels when the toolbar is narrow
            // when the toolbar is narrow.
            this.updateToolbarVisibility();

            await this.bootstrapProjects();
            // Re-initialize scene index now that the active project is set.
            // Views that opened before bootstrapProjects may have scanned a
            // fallback folder and found no scenes.
            await this.sceneManager.initialize();
            // Migrate legacy data from data.json into project frontmatter
            await this.migrateProjectDataFromSettings();
            // Load per-project data from System/ files (tagColors, aliases, etc.)
            await this.loadProjectSystemData();
            // These System/ reads do not depend on each other.
            await Promise.all([
                this.plotlineManager.ensureSeeded(),
                this.fieldTemplates.load(),
                this.templateCenter.load(),
                this.sceneManager.loadCorkboardPositions(),
            ]);
            // Load locations and characters for the active project
            try {
                await this.loadActiveProjectEntities();
            } catch { /* not set yet */ }
            // Scan extra source folders and route by frontmatter type
            try {
                await this.scanExtraFolders();
            } catch { /* not set yet */ }
            // Scan scene bodies for wikilinks after entities are loaded
            this.linkScanner.rebuildLookups(this.settings.characterAliases);
            this.linkScanner.scanAll(this.sceneManager.getAllScenes());
            // (createPlotGridIfMissing removed — it caused race-condition overwrites)

            // Initialize writing tracker from per-project System/stats.json
            this.writingTracker.startSession(
                this.getTrackedWordTotal(),
                this.hasOpenFileForProject(),
            );
            this.writingTracker.setSprintDuration(
                Math.max(1, this.settings.sprintDurationMinutes || 25) * 60_000,
            );
            try {
                await this.globalWritingTracker.load();
                await this.globalWritingTracker.reconcileProjectLedgers();
            } catch (trackErr) {
                console.warn('[NarrativeLab] Could not load writing tracker:', trackErr);
            }

            // If the navigator was already restored with the workspace, leave
            // the sidebars alone (revealLeaf/expand causes a visible jump).
            // Only create the leaf when it's missing.
            if (this.settings.autoOpenNavigator !== false) {
                try {
                    await this.openNavigator({ quiet: true });
                } catch (navErr) {
                    console.warn('[NarrativeLab] Could not open navigator:', navErr);
                }
            }

            if (this.settings.autoOpenWritingTrackerPanel) {
                try {
                    await this.openWritingTrackerPanel({ quiet: true });
                } catch (trackErr) {
                    console.warn('[NarrativeLab] Could not open writing tracker panel:', trackErr);
                }
            }

            // Refresh open views after sidebars are settled so a full redraw
            // doesn't fight the initial workspace paint.
            this.refreshOpenViews();
            try {
                await this.floatingStickyNotes.load();
                this.floatingStickyNotes.restoreFloatingNotes();
            } catch (noteErr) {
                console.warn('[NarrativeLab] Could not restore floating sticky notes:', noteErr);
            }

            // Vault-wide migrations are not needed to show Board/corkboard — defer.
            window.setTimeout(() => {
                void (async () => {
                    try {
                        await this.ensureActiveFieldForAllProjectContent();
                        // Every project: Library folders ↔ categories ↔ Bases
                        await this.reconcileLibraryCategoriesForAllProjects();
                        await migrateLibraryAttachmentsForAllProjects(this);
                    } catch (migErr) {
                        console.warn('[NarrativeLab] Deferred migration error:', migErr);
                    }
                })();
            }, 0);
            } catch (startupErr) {
                console.error('[NarrativeLab] Startup error:', startupErr);
            }
        });

        // Narrative Canvas: wait for idle so first workspace paint is not
        // competing with the bundled runtime. Openers still await ensureCanvasModuleReady().
        const startEmbeddedCanvas = (): void => {
            void this.loadEmbeddedCanvas().catch((canvasErr: unknown) => {
                console.error('[NarrativeLab] Narrative Canvas failed to load:', canvasErr);
                new Notice(t('Failed to open Narrative Canvas: {err}', { err: String(canvasErr) }));
            });
        };
        const idleWindow = window as Window & {
            requestIdleCallback?: (cb: () => void, opts?: { timeout: number }) => number;
            cancelIdleCallback?: (id: number) => void;
        };
        if (typeof idleWindow.requestIdleCallback === 'function') {
            const idleId = idleWindow.requestIdleCallback(startEmbeddedCanvas, { timeout: 2500 });
            this.register(() => idleWindow.cancelIdleCallback?.(idleId));
        } else {
            const timerId = window.setTimeout(startEmbeddedCanvas, 400);
            this.register(() => window.clearTimeout(timerId));
        }

        // Ribbon icons — open project chooser (load/create) so users can switch projects
        this.addRibbonIcon('book-open-text', t('NarrativeLab projects'), () => {
            const modal = new ProjectSelectModal(this.app, this);
            modal.open();
        });
        this.addRibbonIcon('sticky-note', t('New sticky note'), () => {
            this.floatingStickyNotes.createStickyNote();
        });
        this.addRibbonIcon('activity', t('Open writing tracker'), () => {
            void this.openWritingTracker();
        });
        this.fileExplorerVisibilityRibbonEl = this.addRibbonIcon(
            'eye',
            t('Show hidden project files'),
            () => { void this.toggleFileExplorerVisibility(); },
        );
        this.updateFileExplorerVisibilityRibbon();

        // Commands
        this.addCommand({
            id: 'open-board-view',
            name: t('Open board view'),            callback: () => this.activateView(BOARD_VIEW_TYPE),
        });

        this.addCommand({
            id: 'open-timeline-view',
            name: t('Open Order view'),
            callback: () => this.activateView(TIMELINE_VIEW_TYPE),
        });

        this.addCommand({
            id: 'open-plotgrid-view',
            name: t('Open concept grid view'),
            callback: () => this.activateView(PLOTGRID_VIEW_TYPE),
        });

        this.addCommand({
            id: 'open-plotlines-view',
            name: t('Open plotlines view'),
            callback: () => this.activateView(STORYLINE_VIEW_TYPE),
        });

        this.addCommand({
            id: 'open-character-view',
            name: t('Open character view'),            callback: () => this.activateView(CHARACTER_VIEW_TYPE),
        });

        this.addCommand({
            id: 'open-stats-view',
            name: t('Open statistics dashboard'),            callback: () => this.activateView(STATS_VIEW_TYPE),
        });

        this.addCommand({
            id: 'open-location-view',
            name: t('Open location view'),            callback: () => this.activateView(LOCATION_VIEW_TYPE),
        });

        this.addCommand({
            id: 'open-codex-view',
            name: t('Open Library'),            callback: () => this.activateView(CODEX_VIEW_TYPE),
        });

        this.addCommand({
            id: 'create-new-scene',
            name: t('Create new scene'),            callback: () => this.openQuickAdd(),
        });

        this.addCommand({
            id: 'create-new-project',
            name: t('Create new project'),
            callback: () => this.openNewProjectModal(),
        });

        this.addCommand({
            id: 'switch-project',
            name: t('Open or switch project'),
            callback: () => {
                const projects = this.sceneManager.getProjects();
                if (projects.length <= 1) {
                    new Notice(projects.length === 0 ? t('No projects found.') : t('Only one project exists.'));
                    return;
                }
                const modal = new ProjectSwitcherModal(
                    this.app,
                    projects,
                    project => this.sceneManager.isProjectInValidSeries(project),
                    async (project) => {
                        await this.openBoardForProject(project);
                        new Notice(t('Switched to "{title}"', { title: project.title }));
                    },
                );
                modal.open();
            },
        });

        this.addCommand({
            id: 'manage-ncanvas-files',
            name: t('Manage Canvas files'),
            callback: () => this.openNCanvasManager(),
        });

        this.addCommand({
            id: 'open-narrative-canvas',
            name: t('Open Narrative Canvas (last used)'),
            callback: () => {
                void this.openNarrativeCanvas();
            },
        });

        this.addCommand({
            id: 'fork-project',
            name: t('Fork current project'),
            callback: () => this.openForkProjectModal(),
        });

        this.addCommand({
            id: 'delete-project',
            name: t('Delete current project'),
            callback: () => this.openDeleteProjectModal(),
        });

        this.addCommand({
            id: 'undo',
            name: t('Undo last scene change'),
            checkCallback: (checking) => {
                if (isLocalTextUndoTarget()) return false;
                if (checking) return true;
                const board = this.resolveCorkboardUndoBoard();
                if (board) {
                    void board.handleBoardUndo();
                    return true;
                }
                void this.sceneManager.undoManager.undo();
                return true;
            },
        });

        this.addCommand({
            id: 'redo',
            name: t('Redo last scene change'),
            checkCallback: (checking) => {
                if (isLocalTextUndoTarget()) return false;
                if (checking) return true;
                const board = this.resolveCorkboardUndoBoard();
                if (board) {
                    void board.handleBoardRedo();
                    return true;
                }
                void this.sceneManager.undoManager.redo();
                return true;
            },
        });

        // Capture first so Univer / plugin hotkeys cannot steal Cmd+Z from a
        // focused cell-editor textarea (native history is also empty after
        // programmatic inserts such as wikilink picks).
        const onUndoKeyCapture = (evt: KeyboardEvent) => {
            if (!isUndoKey(evt) && !isRedoKey(evt)) return;
            if (!consumeTextareaUndoKey(evt)) return;
            evt.preventDefault();
            evt.stopPropagation();
            evt.stopImmediatePropagation();
        };
        const undoCaptureTarget = activeDocument.defaultView ?? window;
        undoCaptureTarget.addEventListener('keydown', onUndoKeyCapture, true);
        this.register(() => undoCaptureTarget.removeEventListener('keydown', onUndoKeyCapture, true));

        // Register a global keydown handler so Ctrl+Z / Ctrl+Shift+Z / Ctrl+Y
        // route to NarrativeLab's undo/redo when a NarrativeLab view is active and
        // the focus is not inside a text input, textarea, or contentEditable.
        this.registerDomEvent(activeDocument, 'keydown', (evt: KeyboardEvent) => {
            if (!isUndoKey(evt) && !isRedoKey(evt)) return;
            if (consumeTextareaUndoKey(evt)) {
                evt.preventDefault();
                evt.stopPropagation();
                return;
            }

            // Don't intercept if focus is in a text field or the cell editor.
            if (isLocalTextUndoTarget()) return;

            // A corkboard Canvas lives in a detached nested WorkspaceSplit, so
            // getActiveViewOfType(ItemView) may report a sidebar or another leaf.
            // Route by event ownership/recent Canvas interaction before checking
            // the outer active view.
            const corkboard = this.resolveCorkboardUndoBoard(evt);
            if (corkboard) {
                evt.preventDefault();
                evt.stopPropagation();
                if (isUndoKey(evt)) void corkboard.handleBoardUndo();
                else void corkboard.handleBoardRedo();
                return;
            }

            // Check if a NarrativeLab view is active
            const view = this.app.workspace.getActiveViewOfType(ItemView);
            if (!view) return;
            const viewType = view.getViewType();
            if (typeof viewType !== 'string') return;
            const slViewTypes = [
                BOARD_VIEW_TYPE, PLOTGRID_VIEW_TYPE, TIMELINE_VIEW_TYPE,
                STORYLINE_VIEW_TYPE, CHARACTER_VIEW_TYPE, STATS_VIEW_TYPE,
                LOCATION_VIEW_TYPE, CODEX_VIEW_TYPE, SCENE_INSPECTOR_VIEW_TYPE,
                NOTES_VIEW_TYPE, SYNOPSIS_VIEW_TYPE, DETAILS_VIEW_TYPE,
                MANUSCRIPT_VIEW_TYPE, RESEARCH_VIEW_TYPE,
                NAVIGATOR_VIEW_TYPE,
                WRITING_TRACKER_PANEL_TYPE, WRITING_TRACKER_VIEW_TYPE,
            ];
            if (!slViewTypes.includes(viewType)) return;

            // Board corkboard: route to Canvas history (do not steal with empty scene UndoManager).
            if (viewType === BOARD_VIEW_TYPE) {
                const board = view as BoardView;
                evt.preventDefault();
                evt.stopPropagation();
                if (isUndoKey(evt)) void board.handleBoardUndo();
                else void board.handleBoardRedo();
                return;
            }

            evt.preventDefault();
            evt.stopPropagation();
            if (isUndoKey(evt)) {
                void this.sceneManager.undoManager.undo();
            } else {
                void this.sceneManager.undoManager.redo();
            }
        });

        this.addCommand({
            id: 'open-converter',
            name: t('Open converter'),
            callback: () => {
                this.openConverter();
            },
        });

        this.addCommand({
            id: 'open-navigator',
            name: t('Open navigator'),
            callback: () => this.openNavigator(),
        });

        this.addCommand({
            id: 'open-scene-inspector',
            name: t('Open scene details sidebar'),
            callback: () => this.openSceneInspector(),
        });

        this.addCommand({
            id: 'open-scene-notes',
            name: t('Open scene notes sidebar'),
            callback: () => this.openNotesView(),
        });

        this.addCommand({
            id: 'open-writing-tracker',
            name: t('Open writing tracker'),
            icon: 'activity',
            callback: () => { void this.openWritingTracker(); },
        });

        this.addCommand({
            id: 'open-writing-tracker-panel',
            name: t('Open writing tracker panel'),
            icon: 'activity',
            callback: () => { void this.openWritingTrackerPanel(); },
        });

        this.addCommand({
            id: 'create-floating-sticky-note',
            name: t('Create sticky note'),
            icon: 'sticky-note',
            callback: () => this.floatingStickyNotes.createStickyNote(),
        });

        this.addCommand({
            id: 'toggle-floating-sticky-notes',
            name: t('Show or hide sticky notes'),
            icon: 'eye',
            callback: () => { void this.floatingStickyNotes.toggleVisibility(); },
        });

        this.addCommand({
            id: 'open-scene-notes-file',
            name: t('Open scene notes as file'),
            checkCallback: (checking: boolean) => {
                const scene = this.sceneManager.getScene(this.app.workspace.getActiveFile()?.path ?? '');
                if (!scene) return false;
                if (!checking) {
                    this.sceneManager.openSceneNotes(scene);
                }
                return true;
            },
        });

        this.addCommand({
            id: 'open-scene-synopsis',
            name: t('Open scene synopsis sidebar'),
            callback: () => this.openSynopsisView(),
        });

        this.addCommand({
            id: 'open-scene-details-view',
            name: t('Open scene details in own pane'),
            callback: () => this.openSceneDetailsLeaf(),
        });

        this.addCommand({
            id: 'open-research',
            name: t('Open research sidebar'),
            callback: () => this.openResearch(),
        });

        this.addCommand({
            id: 'create-series',
            name: t('Create new series from current project'),
            callback: () => this.openCreateSeriesModal(),
        });

        this.addCommand({
            id: 'add-to-series',
            name: t('Add current project to existing series'),
            callback: () => this.openAddToSeriesModal(),
        });

        this.addCommand({
            id: 'remove-from-series',
            name: t('Remove current project from series'),
            callback: async () => {
                const project = this.sceneManager.activeProject;
                if (!this.sceneManager.isProjectInValidSeries(project)) {
                    new Notice(t('This project is not part of a series.'));
                    return;
                }
                try {
                    await this.seriesManager.removeProjectFromSeries();
                    this.refreshOpenViews();
                } catch (e: unknown) {
                    new Notice((e instanceof Error ? e.message : String(e)), 10000);
                }
            },
        });

        this.addCommand({
            id: 'rename-project',
            name: t('Rename current project'),
            callback: () => this.openRenameProjectModal(),
        });

        this.addCommand({
            id: 'import-scrivener',
            name: t('Import Scrivener project'),
            callback: () => { void this.runScrivenerImport(); },
        });

        // Issue #83 \u2014 turn an arbitrary markdown note into a scene.
        this.addCommand({
            id: 'convert-note-to-scene',
            name: t('Convert note to scene'),
            checkCallback: (checking: boolean) => {
                const file = this.app.workspace.getActiveFile();
                if (!file || file.extension !== 'md') return false;
                if (!this.sceneManager.activeProject) return false;
                if (checking) return true;
                this.sceneManager.convertFileToScene(file.path).then(newPath => {
                    if (newPath) this.refreshOpenViews();
                });
                return true;
            },
        });

        // Show "Convert to scene" in the file context menu for markdown files
        // when a project is active and the file isn't already a real scene.
        this.registerEvent(
            this.app.workspace.on('file-menu', (menu, file) => {
                if (!(file instanceof TFile) || file.extension !== 'md') return;
                if (!this.sceneManager.activeProject) return;
                const existing = this.sceneManager.getScene(file.path);
                if (existing && existing.type === 'scene' && !existing.corkboardNote) return;
                menu.addItem(item => {
                    item.setTitle(t('Convert to scene'))
                        .setIcon('clapperboard')
                        .onClick(async () => {
                            const newPath = await this.sceneManager.convertFileToScene(file.path);
                            if (newPath) this.refreshOpenViews();
                        });
                });
            })
        );

        // Settings tab
        this.addSettingTab(new SceneCardsSettingTab(this.app, this));

        // Suppress native (browser) title tooltips inside NarrativeLab UI.
        this.enableNativeTooltipSuppression();

        // File watchers for reactive updates
        // We debounce the async refresh pipeline so multiple rapid edits
        // only trigger one re-render after the index has finished updating.
        const debouncedRefresh = this.debounce(() => this.refreshOpenViews(), 500);
        // Scene/note body edits: update scene index + views, skip Library entity reload.
        const debouncedViewsOnly = this.debounce(() => this.refreshViewsOnly(), 300);
        // Native Bases already updates its own rows and columns. Library note
        // edits only need a background manager refresh; remounting every open
        // NarrativeLab view here makes the entire embedded Base flash.
        const debouncedLibraryEntityReload = this.debounce(() => {
            void this.reloadEntities().then((categoriesChanged) => {
                // New Library/<Category> folders only show as tabs after a view rebuild.
                if (categoriesChanged) void this.refreshViewsOnly();
            });
        }, 500);
        let projectDeletionQueue: Promise<void> = Promise.resolve();
        const settleProjectTreeDelete = (
            result: ReturnType<SceneManager['handleProjectTreeDelete']>,
        ): void => {
            projectDeletionQueue = projectDeletionQueue
                .catch(() => undefined)
                .then(async () => {
                    for (const removed of result.removedProjectFiles) {
                        this._projectRuntimeCache.delete(normalizePath(removed));
                    }
                    if (result.activeProjectRemoved) {
                        // Save only the cleared global pointer. saveSettings() also
                        // writes System/* and could revive the deleted project tree.
                        await this.saveData(this.settings);
                        let replacement: StoryLineProject | undefined;
                        for (const project of this.sceneManager.getProjects()) {
                            if (await this.app.vault.adapter.exists(project.filePath)) {
                                replacement = project;
                                break;
                            }
                        }
                        if (replacement && !this.sceneManager.activeProject) {
                            await this.sceneManager.setActiveProject(replacement);
                        }
                    }
                    this.libraryCategoriesStructureEpoch += 1;
                    this.refreshOpenViews();
                })
                .catch(error => console.error('[NarrativeLab] Project deletion refresh failed:', error));
        };

        this.registerEvent(
            this.app.vault.on('modify', (file) => {
                if (this._adoptingLibrary) return;
                if (file instanceof TFile) {
                    if (file.extension.toLowerCase() === 'base') return;
                    const filePath = normalizePath(file.path);
                    const revisionChangedAt = Date.now();
                    this.invalidateForeignProjectRuntimeCache(filePath);
                    if (this._activeFieldWrites.has(filePath)) return;
                    if (this._suppressVaultRefreshPaths.has(filePath)) return;
                    // Corkboard / Obsidian Canvas JSON must not trigger a nuclear refresh
                    // (rewrite → modify → refresh → rewrite loop freezes the board).
                    if (file.extension.toLowerCase() === 'canvas') return;
                    // System/*.json writes must not thrash open views (stats,
                    // digests, plotlines, etc. are saved during refresh itself).
                    const systemFolder = normalizePath(this.getProjectSystemFolder() || '');
                    const plotXlsx = normalizePath(plotGridXlsxPath(this.getProjectBaseFolder() || ''));
                    const plotMeta = normalizePath(plotGridNlMetaPath(this.getProjectSystemFolder() || ''));
                    if (
                        /\/Library\/datasheet(?:-[^/]+)?\.xlsx$/i.test(filePath)
                        || /\/System\/datasheet\.nlmeta\.json$/i.test(filePath)
                        || /\/Library\/datasheet\.nlmeta\.json$/i.test(filePath)
                        || filePath === plotXlsx
                        || filePath === plotMeta
                    ) {
                        void this.refreshPlotGridViews(filePath);
                        return;
                    }
                    if (systemFolder
                        && (filePath === systemFolder || filePath.startsWith(`${systemFolder}/`))) {
                        // System/* writes stay suppressed (they often echo from our own saves).
                        return;
                    }
                    invalidateAllEntityCaches(file.path);
                    if (file.extension.toLowerCase() === 'md'
                        && this.isActiveLibraryPath(filePath)) {
                        debouncedLibraryEntityReload();
                        return;
                    }
                    const queuedProjectFile = this.isCurrentProjectManagedPath(filePath)
                        ? normalizePath(this.sceneManager.activeProject?.filePath || '')
                        : '';
                    const lightRefresh = file.extension.toLowerCase() === 'md'
                        && queuedProjectFile !== '';
                    const previousRevision = this._writingRevisionQueues.get(filePath) ?? Promise.resolve();
                    const revisionTask = previousRevision.catch(() => undefined).then(async () => {
                        if (queuedProjectFile && !this.canRecordWritingChange(queuedProjectFile)) return;
                        const previousSceneBody = this.sceneManager.getScene(filePath)?.body;
                        await this.sceneManager.handleFileChange(file);
                        await this.researchManager?.handleFileChange(file);
                        const nextSceneBody = this.sceneManager.getScene(filePath)?.body;
                        if (queuedProjectFile
                            && this.canRecordWritingChange(queuedProjectFile)
                            && previousSceneBody !== undefined
                            && nextSceneBody !== undefined) {
                            const churn = countWordRevisionChurn(
                                previousSceneBody,
                                nextSceneBody,
                                normalizeStoryLineLocale(this.sceneManager.getEffectiveLocale()),
                                {
                                    excludeComments: this.settings.excludeCommentsFromWordcount !== false,
                                    excludeChecklists: this.settings.excludeChecklistFromWordcount === true,
                                },
                            );
                            this.writingTracker.recordRevisionWords(churn, revisionChangedAt);
                            this.flushWritingTrackers(undefined, revisionChangedAt);
                        }
                        if (lightRefresh) debouncedViewsOnly();
                        else debouncedRefresh();
                    });
                    this._writingRevisionQueues.set(filePath, revisionTask);
                    void revisionTask.finally(() => {
                        if (this._writingRevisionQueues.get(filePath) === revisionTask) {
                            this._writingRevisionQueues.delete(filePath);
                        }
                    });
                }
            })
        );

        // Obsidian "New note" under Notes/ often fires create without an immediate
        // modify — adopt those files so they appear on the board with Notes ON.
        this.registerEvent(
            this.app.vault.on('create', (file) => {
                if (this._adoptingLibrary) return;
                if (file instanceof TFolder) {
                    // Creating Library/Skills (etc.) must adopt the category without waiting
                    // for a project reopen — file-only create handlers never see the folder.
                    // Skip while NL itself is renaming/creating folders (avoids prune races).
                    if (this._syncingLibraryFolders) return;
                    const folderPath = normalizePath(file.path);
                    if (this.isActiveLibraryRootOrDirectChild(folderPath)) {
                        debouncedLibraryEntityReload();
                    }
                    return;
                }
                if (file instanceof TFile) {
                    const createdAt = Date.now();
                    this.invalidateForeignProjectRuntimeCache(file.path);
                    if (file.extension.toLowerCase() === 'base') return;
                    const queuedProjectFile = this.isCurrentProjectManagedPath(file.path)
                        ? normalizePath(this.sceneManager.activeProject?.filePath || '')
                        : '';
                    if (file.extension.toLowerCase() === 'md' && queuedProjectFile) {
                        void this.ensureActiveField(file).then(() =>
                            this.sceneManager.handleFileCreate(file).then(async () => {
                                await this.researchManager?.handleFileCreate(file);
                                const createdBody = this.sceneManager.getScene(file.path)?.body;
                                if (this.canRecordWritingChange(queuedProjectFile)
                                    && createdBody !== undefined) {
                                    const churn = countWordRevisionChurn(
                                        '',
                                        createdBody,
                                        normalizeStoryLineLocale(this.sceneManager.getEffectiveLocale()),
                                        {
                                            excludeComments: this.settings.excludeCommentsFromWordcount !== false,
                                            excludeChecklists: this.settings.excludeChecklistFromWordcount === true,
                                        },
                                    );
                                    this.writingTracker.recordRevisionWords(churn, createdAt);
                                    this.flushWritingTrackers(undefined, createdAt);
                                }
                                debouncedRefresh();
                            }));
                        return;
                    }
                    const filePath = normalizePath(file.path);
                    if (file.extension.toLowerCase() === 'md'
                        && this.isActiveLibraryPath(filePath)) {
                        debouncedLibraryEntityReload();
                        return;
                    }
                    this.sceneManager.handleFileCreate(file).then(() => debouncedRefresh());
                }
            })
        );

        this.registerEvent(
            this.app.vault.on('delete', (file) => {
                if (file instanceof TFolder) {
                    const projectDelete = this.sceneManager.handleProjectTreeDelete(file.path, true);
                    if (projectDelete.changed) {
                        settleProjectTreeDelete(projectDelete);
                        return;
                    }
                    // Draft roots live at Scenes/<name>/ — drop ghost drafts when folder is trashed
                    this.sceneManager.handleDraftFolderDelete(file.path).then((changed) => {
                        if (changed) debouncedRefresh();
                    });
                    if (this._syncingLibraryFolders) return;
                    const folderPath = normalizePath(file.path);
                    if (this.isActiveLibraryRootOrDirectChild(folderPath)) {
                        debouncedLibraryEntityReload();
                    }
                    return;
                }
                if (file instanceof TFile) {
                    const deletedAt = Date.now();
                    this.invalidateForeignProjectRuntimeCache(file.path);
                    const projectDelete = this.sceneManager.handleProjectTreeDelete(file.path, false);
                    if (projectDelete.changed) {
                        invalidateAllEntityCaches(file.path);
                        settleProjectTreeDelete(projectDelete);
                        return;
                    }
                    if (file.extension.toLowerCase() === 'base') return;
                    invalidateAllEntityCaches(file.path);
                    const filePath = normalizePath(file.path);
                    if (file.extension.toLowerCase() === 'md'
                        && this.isActiveLibraryPath(filePath)) {
                        debouncedLibraryEntityReload();
                        return;
                    }
                    const deletedSceneBody = this.sceneManager.getScene(filePath)?.body;
                    this.sceneManager.handleFileDelete(file.path);
                    this.researchManager?.handleFileDelete(file.path);
                    const queuedProjectFile = this.isCurrentProjectManagedPath(filePath)
                        ? normalizePath(this.sceneManager.activeProject?.filePath || '')
                        : '';
                    if (queuedProjectFile
                        && this.canRecordWritingChange(queuedProjectFile)
                        && deletedSceneBody !== undefined) {
                        const churn = countWordRevisionChurn(
                            deletedSceneBody,
                            '',
                            normalizeStoryLineLocale(this.sceneManager.getEffectiveLocale()),
                            {
                                excludeComments: this.settings.excludeCommentsFromWordcount !== false,
                                excludeChecklists: this.settings.excludeChecklistFromWordcount === true,
                            },
                        );
                        this.writingTracker.recordRevisionWords(churn, deletedAt);
                        this.flushWritingTrackers(undefined, deletedAt);
                    }
                    debouncedRefresh();
                }
            })
        );

        this.registerEvent(
            this.app.vault.on('rename', (file, oldPath) => {
                this.invalidateForeignProjectRuntimeCache(oldPath);
                this.invalidateForeignProjectRuntimeCache(file.path);
                if (file instanceof TFolder) {
                    void (async () => {
                        // A folder move emits one folder-level rename event. Rebase
                        // project paths before any refresh can recreate the old tree.
                        const projectTreeChanged = await this.sceneManager.handleProjectTreeFolderRename(oldPath, file.path);
                        if (projectTreeChanged) {
                            renameAllEntityCachePrefixes(oldPath, file.path);
                        }
                        await rebaseStoryGraphRelationPaths(this, oldPath, file.path, true);
                        // Draft roots live at Scenes/<name>/ — keep sidebar label in sync
                        const draftChanged = await this.sceneManager.handleDraftFolderRename(oldPath, file.path);
                        let libraryChanged = false;
                        const touchesLibrary = this.isActiveLibraryRootOrDirectChild(oldPath)
                            || this.isActiveLibraryRootOrDirectChild(file.path);
                        if (!this._syncingLibraryFolders) {
                            libraryChanged = await handleLibraryFolderVaultRename(this, oldPath, file.path);
                        }
                        // During NL-driven renames, skip reload — mapping is updated in-place.
                        if (!this._syncingLibraryFolders && (touchesLibrary || libraryChanged)) {
                            debouncedLibraryEntityReload();
                        }
                        if (projectTreeChanged || draftChanged) debouncedRefresh();
                    })();
                    return;
                }
                if (file instanceof TFile) {
                    if (file.extension.toLowerCase() === 'base') return;
                    renameAllEntityCaches(oldPath, file.path);
                    const filePath = normalizePath(file.path);
                    const previousPath = normalizePath(oldPath);
                    if (file.extension.toLowerCase() === 'md'
                        && (this.isActiveLibraryPath(filePath)
                            || this.isActiveLibraryPath(previousPath))) {
                        // Library↔binder moves must still run Scene/Research adoption.
                        // Reloading Library entities alone leaves Notes/Scenes/Research stale.
                        void this.sceneManager.handleFileRename(file, oldPath).then(async () => {
                            await this.researchManager?.handleFileRename(file, oldPath);
                            await this.updatePlotGridLinkedSceneIds(oldPath, file.path);
                            await rebaseStoryGraphRelationPaths(this, oldPath, file.path);
                            debouncedLibraryEntityReload();
                            debouncedRefresh();
                        });
                        return;
                    }
                    this.sceneManager.handleFileRename(file, oldPath).then(async () => {
                        await this.researchManager?.handleFileRename(file, oldPath);
                        // Update any PlotGrid cells that reference the old path
                        await this.updatePlotGridLinkedSceneIds(oldPath, file.path);
                        await rebaseStoryGraphRelationPaths(this, oldPath, file.path);
                        debouncedRefresh();
                    });
                }
            })
        );

        // "Show in NarrativeLab" — command palette + file-menu entry
        // Detects whether the active file is a character, location, or codex entry
        // and navigates to the appropriate detail panel.
        this.addCommand({
            id: 'show-entity-details',
            name: t('Show in details view'),
            checkCallback: (checking) => {
                const file = this.app.workspace.getActiveFile();
                if (!file) return false;
                if (!this.resolveEntityType(file.path)) return false;
                if (!checking) this.showEntityDetails(file.path);
                return true;
            },
        });

        this.registerEvent(
            this.app.workspace.on('file-menu', (menu, file) => {
                if (!(file instanceof TFile)) return;
                if (!this.resolveEntityType(file.path)) return;
                menu.addItem((item) => {
                    item.setTitle(t('Show in NarrativeLab'))
                        .setIcon('book-open')
                        .onClick(() => this.showEntityDetails(file.path));
                });
            })
        );

        this.registerEvent(
            this.app.workspace.on('editor-menu', (menu, _editor, info) => {
                const file = info.file;
                if (!file) return;
                if (!this.resolveEntityType(file.path)) return;
                menu.addItem((item) => {
                    item.setTitle(t('Show in NarrativeLab'))
                        .setIcon('book-open')
                        .onClick(() => this.showEntityDetails(file.path));
                });
            })
        );

        // Issue #195 — add "Find & replace in manuscript" to the editor
        // right-click menu when the active view is the Manuscript view, so
        // it appears alongside Obsidian's own editor menu items.
        this.registerEvent(
            this.app.workspace.on('editor-menu', (menu) => {
                const view = this.app.workspace.getActiveViewOfType(ItemView);
                const viewType = (view as unknown as { getViewType?: () => string })?.getViewType?.();
                if (viewType !== MANUSCRIPT_VIEW_TYPE) return;
                menu.addItem((item) => {
                    item.setTitle(t('Find & replace in manuscript'))
                        .setIcon('search')
                        .onClick(() => {
                            const leaves = this.app.workspace.getLeavesOfType(MANUSCRIPT_VIEW_TYPE);
                            const mv = leaves[0]?.view as unknown as { toggleSearch?: () => void };
                            mv?.toggleSearch?.();
                        });
                });
            })
        );

        // Inject formatting toolbar into scene editors when Editing Toolbar is absent
        this.registerEvent(
            this.app.workspace.on('active-leaf-change', (leaf) => {
                this.injectFormattingToolbar(leaf);
                this.updateFrontmatterVisibility();
                void this.syncActiveProjectFromLeaf(leaf)
                    .finally(() => this.syncWritingTrackerActivity());
            })
        );

        // Re-apply scoped frontmatter visibility when layout changes or files open
        this.registerEvent(
            this.app.workspace.on('layout-change', () => {
                // CSS hide/show only — do not re-fold (would fight user expanding Properties).
                this.updateFrontmatterVisibility();
                this.observeFileExplorerVisibility();
                this.syncWritingTrackerActivity();
            })
        );
        this.registerEvent(
            this.app.workspace.on('file-open', () => {
                this.updateFrontmatterVisibility({ collapseOpenFiles: true });
                this.syncWritingTrackerActivity();
                // Metadata editor mounts slightly after file-open; fold again once ready.
                window.setTimeout(() => {
                    this.updateFrontmatterVisibility({ collapseOpenFiles: true });
                }, 120);
            })
        );
    }

    /** Resolved Properties display mode for NarrativeLab notes. */
    private getFrontmatterDisplayMode(): 'collapse' | 'hide' | 'visible' {
        const mode = this.settings.frontmatterDisplay;
        if (mode === 'hide' || mode === 'visible' || mode === 'collapse') return mode;
        return 'collapse';
    }

    /**
     * Issue #104 — Apply the frontmatter display preference by toggling CSS
     * (hide) and/or folding the Properties widget (collapse) on markdown leaves
     * whose file lives inside a NarrativeLab project. Does not change Obsidian's
     * global "Properties in document" setting.
     */
    public updateFrontmatterVisibility(opts?: { collapseOpenFiles?: boolean }): void {
        const mode = this.getFrontmatterDisplayMode();
        const hide = mode === 'hide';
        const collapse = mode === 'collapse';
        const projectRoots = this.sceneManager?.getProjects().map(project =>
            deriveProjectFoldersFromFilePath(project.filePath).baseFolder,
        ) ?? [];

        const body = activeDocument.body;
        if (body) {
            body.classList.toggle('sl-hide-frontmatter-global', hide);
            body.classList.toggle('sl-collapse-frontmatter-global', collapse);
        }

        const leaves: WorkspaceLeaf[] = [];
        this.app.workspace.iterateAllLeaves(l => { leaves.push(l); });
        for (const leaf of leaves) {
            const view = leaf.view as unknown as { getViewType?: () => string; file?: TFile | null };
            const filePath = view?.file?.path;
            const inStoryLine = !!filePath && projectRoots.some(root => filePath === root || filePath.startsWith(`${root}/`));
            const container = (leaf as unknown as { containerEl?: HTMLElement }).containerEl;
            const target = container?.querySelector('.view-content') as HTMLElement | null;
            if (!target) continue;
            if (hide && inStoryLine) {
                target.classList.add('sl-hide-frontmatter');
            } else {
                target.classList.remove('sl-hide-frontmatter');
            }
            if (collapse && inStoryLine && opts?.collapseOpenFiles) {
                this.collapsePropertiesInView(leaf.view);
            }
        }

        // Manuscript embeds / NL custom views — only on explicit open/settings,
        // never from per-scene mount (that was O(n²) and made large manuscripts crawl).
        if (collapse && opts?.collapseOpenFiles && body) {
            body.querySelectorAll(
                '.sl-manuscript-embedded-split .metadata-container, .workspace-leaf-content[data-type^="narrative-lab-"] .metadata-container',
            ).forEach((el) => {
                this.collapsePropertiesContainer(el as HTMLElement);
            });
        }
    }

    /** True for Markdown content stored in any project's Scenes, Notes, or Research tree. */
    private isActiveManagedPath(filePath: string): boolean {
        const path = normalizePath(filePath);
        for (const project of this.sceneManager?.getProjects() || []) {
            const roots = [project.sceneFolder, project.notesFolder, project.researchFolder]
                .map(root => normalizePath(root))
                .filter(Boolean);
            if (roots.some(root => path.startsWith(`${root}/`))) return true;
        }
        return false;
    }

    /** True only for the currently selected project's editable text trees. */
    private isCurrentProjectManagedPath(filePath: string): boolean {
        const project = this.sceneManager?.activeProject;
        if (!project) return false;
        const path = normalizePath(filePath);
        return [project.sceneFolder, project.notesFolder, project.researchFolder]
            .map(root => normalizePath(root))
            .filter(Boolean)
            .some(root => path === root || path.startsWith(`${root}/`));
    }

    /** Series projects can own both a shared and a book-local Library. */
    private getActiveLibraryRoots(): string[] {
        const roots = new Set<string>();
        const sharedOrProject = normalizePath(this.sceneManager?.getCodexFolder() || '');
        const projectLocal = normalizePath(this.sceneManager?.activeProject?.codexFolder || '');
        if (sharedOrProject) roots.add(sharedOrProject);
        if (projectLocal) roots.add(projectLocal);
        return [...roots];
    }

    private isActiveLibraryPath(filePath: string): boolean {
        const path = normalizePath(filePath);
        return this.getActiveLibraryRoots().some(root =>
            path === root || path.startsWith(`${root}/`));
    }

    private isActiveLibraryRootOrDirectChild(folderPath: string): boolean {
        const path = normalizePath(folderPath);
        return this.getActiveLibraryRoots().some(root =>
            path === root || parentOfPath(path) === root);
    }

    /**
     * Store visibility as a positive checkbox. Legacy `inactive` values are
     * inverted once, then removed so Properties only exposes `active`.
     */
    private async ensureActiveField(file: TFile): Promise<boolean> {
        if (file.extension.toLowerCase() !== 'md' || !this.isActiveManagedPath(file.path)) return false;
        const path = normalizePath(file.path);
        let changed = false;
        this._activeFieldWrites.add(path);
        try {
            await this.app.fileManager.processFrontMatter(file, frontmatter => {
                const hasActive = Object.prototype.hasOwnProperty.call(frontmatter, 'active');
                const hasInactive = Object.prototype.hasOwnProperty.call(frontmatter, 'inactive');
                if (!hasActive) {
                    const legacy = frontmatter.inactive;
                    const legacyInactive = legacy === true
                        || legacy === 1
                        || (typeof legacy === 'string' && legacy.trim().toLowerCase() === 'true');
                    frontmatter.active = hasInactive ? !legacyInactive : true;
                    changed = true;
                }
                if (hasInactive) {
                    delete frontmatter.inactive;
                    changed = true;
                }
            });
        } finally {
            this._activeFieldWrites.delete(path);
        }
        return changed;
    }

    /** Backfill the field across all discovered NarrativeLab projects. */
    private async ensureActiveFieldForAllProjectContent(): Promise<void> {
        for (const file of this.app.vault.getMarkdownFiles()) {
            if (this.isActiveManagedPath(file.path)) {
                await this.ensureActiveField(file);
            }
        }
    }

    /** Fold Properties inside one DOM subtree (e.g. a newly mounted manuscript embed). */
    public collapsePropertiesInElement(root: HTMLElement | null | undefined): void {
        if (!root || this.getFrontmatterDisplayMode() !== 'collapse') return;
        root.querySelectorAll('.metadata-container').forEach((el) => {
            this.collapsePropertiesContainer(el as HTMLElement);
        });
    }

    /** Fold Obsidian Properties via MetadataEditor when available. */
    private collapsePropertiesInView(view: unknown): void {
        const v = view as {
            metadataEditor?: { collapsed?: boolean; setCollapse?: (c: boolean, persist?: boolean) => void };
            editMode?: { metadataEditor?: { collapsed?: boolean; setCollapse?: (c: boolean, persist?: boolean) => void } };
            previewMode?: { metadataEditor?: { collapsed?: boolean; setCollapse?: (c: boolean, persist?: boolean) => void } };
            containerEl?: HTMLElement;
            contentEl?: HTMLElement;
        };
        const editors = [v?.metadataEditor, v?.editMode?.metadataEditor, v?.previewMode?.metadataEditor];
        let folded = false;
        for (const ed of editors) {
            if (!ed?.setCollapse) continue;
            try {
                if (ed.collapsed !== true) ed.setCollapse(true, true);
                folded = true;
            } catch {
                // Internal API — ignore version skew.
            }
        }
        if (folded) return;
        const root = v?.containerEl ?? v?.contentEl;
        if (root) {
            root.querySelectorAll('.metadata-container').forEach((el) => {
                this.collapsePropertiesContainer(el as HTMLElement);
            });
        }
    }

    /** Best-effort fold when MetadataEditor isn't reachable. */
    private collapsePropertiesContainer(container: HTMLElement): void {
        // Mark ready so first-paint CSS stops fighting the user's expand/collapse.
        const markReady = () => container.classList.add('sl-fm-ready');
        if (container.classList.contains('is-collapsed')) {
            markReady();
            return;
        }
        // Prefer the editor instance Obsidian attaches on the element when present.
        // persist=false — don't write Obsidian local-storage; we re-fold on open.
        const ed = (container as unknown as {
            metadataEditor?: { setCollapse?: (c: boolean, persist?: boolean) => void; collapsed?: boolean };
        }).metadataEditor;
        if (ed?.setCollapse) {
            try {
                if (ed.collapsed !== true) ed.setCollapse(true, false);
                markReady();
                return;
            } catch { /* fall through */ }
        }
        container.classList.add('is-collapsed');
        container.setAttribute('data-sl-collapsed', '1');
        const content = container.querySelector('.metadata-content') as HTMLElement | null;
        if (content) content.hide();
        const heading = container.querySelector('.metadata-properties-heading') as HTMLElement | null;
        if (heading) heading.setAttribute('aria-expanded', 'false');
        markReady();
    }

    /**
     * Apply the toolbar-related settings (v1.10.17):
     *   - `autoHideViewLabels` → toggle `sl-auto-hide-tab-labels` on body
     *
     * Pure CSS toggle — no DOM re-render is needed since every
     * NarrativeLab view's toolbar uses the shared `.view-tab-label` classes.
     */
    public updateToolbarVisibility(): void {
        const body = activeDocument.body;
        if (!body) return;
        // Default true; only opt out if explicitly false.
        if (this.settings.autoHideViewLabels === false) {
            body.classList.remove('sl-auto-hide-tab-labels');
        } else {
            body.classList.add('sl-auto-hide-tab-labels');
        }
    }

    /**
     * Issue #189 — disable native spell-check in all NarrativeLab UI inputs,
     * textareas and contenteditable elements. Obsidian's "Disable spell
     * check" setting only applies to its own editor; plugin-rendered form
     * fields inherit the browser default (spellcheck on), causing red
     * underlines for users writing in languages like Vietnamese.
     *
     * A scoped MutationObserver catches fields added dynamically (Inspector,
     * modals, toolbar, corkboard note editor, etc.) without touching the
     * user's manuscript editor (CM6 / `.cm-editor` / `.markdown-view`).
     */
    private disableSpellCheckInPluginUI(): void {
        // Any element whose class contains the plugin's prefix is considered
        // NarrativeLab-owned UI. We deliberately exclude the CodeMirror / markdown
        // editor so the user's manuscript keeps Obsidian's spell-check setting.
        const STORYLINE_SELECTOR = '[class*="story-line-"], [class*="storyline-"]';
        const EXCLUDE_SELECTOR = [
            '.cm-editor',
            '.markdown-view',
            '.cm-content',
            // Native corkboard hosts Obsidian Canvas — walking its DOM freezes the board.
            '.story-line-corkboard-native-host',
            '.canvas-wrapper',
            '[data-type="canvas"]',
        ].join(', ');
        const SPELL_FIELDS = 'input, textarea, [contenteditable="true"], [contenteditable=""]';

        const disableIn = (root: ParentNode): void => {
            if (root.instanceOf(Element) && root.closest(EXCLUDE_SELECTOR)) return;
            // Fields directly inside a NarrativeLab container…
            root.querySelectorAll(STORYLINE_SELECTOR).forEach(container => {
                if (container.closest(EXCLUDE_SELECTOR)
                    || container.matches('.story-line-corkboard-native-host')) {
                    return;
                }
                container.querySelectorAll(SPELL_FIELDS).forEach(field => {
                    // Skip fields that live inside the manuscript editor / Canvas.
                    if (field.closest(EXCLUDE_SELECTOR)) return;
                    const el = field as HTMLElement;
                    if (el.getAttribute('spellcheck') !== 'false') {
                        el.setAttribute('spellcheck', 'false');
                    }
                });
            });
            // …and a NarrativeLab container that is itself a spellable field.
            root.querySelectorAll(SPELL_FIELDS).forEach(field => {
                if (field.closest(EXCLUDE_SELECTOR)) return;
                if (field.closest(STORYLINE_SELECTOR)) {
                    const el = field as HTMLElement;
                    if (el.getAttribute('spellcheck') !== 'false') {
                        el.setAttribute('spellcheck', 'false');
                    }
                }
            });
        };

        const body = activeDocument.body;
        if (!body) return;

        // Initial pass for views/modals already rendered at load.
        disableIn(body);

        this.spellcheckObserver = new MutationObserver(mutations => {
            for (const m of mutations) {
                if (m.type !== 'childList' || m.addedNodes.length === 0) continue;
                m.addedNodes.forEach(node => {
                    if (node.nodeType !== Node.ELEMENT_NODE) return;
                    const el = node as HTMLElement;
                    if (el.closest?.(EXCLUDE_SELECTOR)
                        || el.matches?.('.story-line-corkboard-native-host, .canvas-wrapper, [data-type="canvas"]')) {
                        return;
                    }
                    disableIn(el);
                });
            }
        });
        this.spellcheckObserver.observe(body, {
            childList: true,
            subtree: true,
        });
    }

    getEffectiveInterfaceLanguage(): UiLanguage {
        return resolveUiLanguage(this.settings.interfaceLanguage, this.app);
    }

    getActiveProjectDisplayName(): string {
        return this.getProjectDisplayName(this.sceneManager?.activeProject?.filePath);
    }

    /** Title for a leaf-bound project — never borrow another tab's active project. */
    getProjectDisplayName(projectFile?: string | null): string {
        const path = typeof projectFile === 'string' && projectFile.trim()
            ? normalizePath(projectFile)
            : '';
        if (path) {
            const project = this.sceneManager?.getProjects()
                .find(item => normalizePath(item.filePath) === path);
            const title = project?.title?.trim();
            if (title) return title;
            const manifestName = path.split('/').pop()?.replace(/\.md$/i, '')?.trim();
            if (manifestName) return manifestName;
        }
        return t('No project selected');
    }

    async setInterfaceLanguage(value: UiLanguageSetting): Promise<void> {
        this.settings.interfaceLanguage = normalizeUiLanguageSetting(value);
        const language = this.getEffectiveInterfaceLanguage();
        setActiveUiLanguage(language);
        // Keep embedded Narrative Canvas settings in lockstep with NL.
        const canvasSettings = (this.settings.narrativeCanvasData as { settings?: { language?: string } } | undefined)?.settings;
        if (canvasSettings) canvasSettings.language = language;
        if (this.canvasModule) {
            const moduleSettings = (this.canvasModule as { settings?: { language?: string } }).settings;
            if (moduleSettings) moduleSettings.language = language;
            const notify = (this.canvasModule as { notifyCanvasSettingsChanged?: () => void }).notifyCanvasSettingsChanged;
            notify?.call(this.canvasModule);
        }
        await this.saveSettings();
        await this.refreshOpenViews();
        localizePluginSubtree(activeDocument.body);
        (window as unknown as {
            NarrativeCanvasApp?: { setLanguage?: (language: UiLanguage, options?: { force?: boolean }) => unknown };
        }).NarrativeCanvasApp?.setLanguage?.(language, { force: true });
    }

    private observePluginUiLanguage(): void {
        const body = activeDocument.body;
        if (!body) return;
        localizePluginSubtree(body);
        const SKIP_LOCALIZE = '.story-line-corkboard-native-host, .canvas-wrapper, [data-type="canvas"]';
        this.uiLanguageObserver = new MutationObserver(mutations => {
            for (const mutation of mutations) {
                mutation.addedNodes.forEach(node => {
                    if (node.nodeType === Node.ELEMENT_NODE) {
                        const el = node as HTMLElement;
                        if (el.closest?.(SKIP_LOCALIZE)
                            || el.matches?.(SKIP_LOCALIZE)) {
                            return;
                        }
                    }
                    localizePluginSubtree(node);
                });
            }
        });
        this.uiLanguageObserver.observe(body, { childList: true, subtree: true });
    }

    /**
     * Suppress vault-modify → refreshOpenViews for a path while we rewrite it
     * (e.g. corkboard.canvas membership sync).
     */
    beginSuppressVaultRefresh(path: string, holdMs = 750): () => void {
        const normalized = normalizePath(path);
        this._suppressVaultRefreshPaths.add(normalized);
        let released = false;
        return () => {
            if (released) return;
            released = true;
            // Keep suppression briefly so Obsidian's modify event can arrive first.
            window.setTimeout(() => {
                this._suppressVaultRefreshPaths.delete(normalized);
            }, Math.max(0, holdMs));
        };
    }

    onunload(): void {
        this.canvasModule?.unload();
        this.canvasModule = null;
        // Flush writing session into daily history and persist to System/stats.json
        try {
            if (this._writingTrackerSaveTimer !== null) {
                window.clearTimeout(this._writingTrackerSaveTimer);
                this._writingTrackerSaveTimer = null;
            }
            const totalWords = this.getTrackedWordTotal();
            // Stop any active sprint so it gets recorded
            if (this.writingTracker.isSprintRunning()) {
                this.writingTracker.stopSprint(totalWords);
            }
            this.flushWritingTrackers(totalWords);
            this.saveProjectSystemData();
            void this.globalWritingTracker?.save();
        } catch { /* best effort */ }

        try {
            activeDocument.body?.classList.remove('narrative-lab-theme-light', 'narrative-lab-theme-dark');
        } catch { /* best effort */ }

        if (this.nativeTooltipObserver) {
            this.nativeTooltipObserver.disconnect();
            this.nativeTooltipObserver = null;
        }
        if (this.spellcheckObserver) {
            this.spellcheckObserver.disconnect();
            this.spellcheckObserver = null;
        }
        if (this.uiLanguageObserver) {
            this.uiLanguageObserver.disconnect();
            this.uiLanguageObserver = null;
        }
        if (this.uiThemeObserver) {
            this.uiThemeObserver.disconnect();
            this.uiThemeObserver = null;
        }
        if (this.fileExplorerVisibilityObserver) {
            this.fileExplorerVisibilityObserver.disconnect();
            this.fileExplorerVisibilityObserver = null;
        }
        activeDocument.querySelectorAll('.sl-narrative-lab-hidden-file-tree-item')
            .forEach(el => el.classList.remove('sl-narrative-lab-hidden-file-tree-item'));
        activeDocument.body?.classList.remove('sl-narrative-lab-hide-file-explorer-internals');
        activeDocument.body?.classList.remove(
            'sl-narrative-lab-hide-system-folder',
            'sl-narrative-lab-hide-library-folder',
            'sl-narrative-lab-hide-canvas-folder',
            'sl-narrative-lab-hide-series-metadata',
        );

        // Clean up any floating lightbox windows left on activeDocument.body
        activeDocument.querySelectorAll('.gallery-lightbox-window').forEach(el => el.remove());
        void this.floatingStickyNotes?.unloadAll();
    }

    /**
     * Inject the NarrativeLab formatting toolbar into a standard MarkdownView
     * editor tab when: (1) the setting is enabled, (2) Editing Toolbar
     * plugin is not installed, and (3) the file belongs to the active project.
     */
    private injectFormattingToolbar(leaf: WorkspaceLeaf | null): void {
        // Helper: remove all injected toolbars everywhere (used when no leaf is eligible).
        const removeAll = () =>
            activeDocument.querySelectorAll('.sl-injected-fmt-toolbar').forEach(el => el.remove());

        if (!leaf || !this.settings.showFormattingToolbar) { removeAll(); return; }

        // Skip if Editing Toolbar plugin is installed
        const plugins = (this.app as unknown as { plugins?: { getPlugin?: (id: string) => unknown } }).plugins;
        if (plugins?.getPlugin?.('editing-toolbar')) { removeAll(); return; }

        // Only inject into markdown views in source/live-preview mode
        const view = leaf.view as unknown as {
            getViewType?: () => string;
            file?: TFile | null;
            editor?: { cm?: import('@codemirror/view').EditorView | null };
        };
        if (view?.getViewType?.() !== 'markdown') {
            // The active leaf is not a markdown editor (e.g. settings, a
            // sidebar, or another plugin's view). Do NOT tear down toolbars
            // that are already attached to other markdown leaves — removing
            // and re-inserting them when the user returns triggers a WebKit
            // scroll/cursor reset on iPad/iPhone (issue #215 follow-up:
            // switching tabs or opening/closing settings still jumped).
            return;
        }

        // Only inject for files that belong to the active project
        const file = view.file ?? null;
        const sf = this.sceneManager?.activeProject?.sceneFolder;
        const projectRoot = sf ? sf.replace(/\/Scenes$/, '') : undefined;
        if (!file || !projectRoot || !file.path.startsWith(projectRoot)) { removeAll(); return; }

        // Get the CM6 EditorView
        const cm: import('@codemirror/view').EditorView | null = view.editor?.cm ?? null;
        if (!cm) { removeAll(); return; }

        // Find the view-content container to insert the toolbar
        const viewContent = (leaf as unknown as { containerEl?: HTMLElement }).containerEl?.querySelector('.view-content');
        if (!viewContent) { removeAll(); return; }

        // This leaf is eligible. Remove toolbars from OTHER leaves only — avoids DOM
        // mutations inside the current editor that cause WebKit (iPad/iPhone) to jump
        // the scroll position to the top on every active-leaf-change (issue #215).
        activeDocument.querySelectorAll('.sl-injected-fmt-toolbar').forEach(el => {
            if (!viewContent.contains(el)) el.remove();
        });

        // Skip re-injection if the toolbar is already present in this viewContent.
        // Re-inserting on every focus event is what triggered the iPad scroll jump.
        if (viewContent.querySelector('.sl-injected-fmt-toolbar')) return;

        // Create and inject the toolbar at the top of view-content
        const toolbar = createDiv({ cls: 'sl-fmt-toolbar sl-injected-fmt-toolbar' });
        buildFormattingToolbar(toolbar, () => cm);
        viewContent.insertBefore(toolbar, viewContent.firstChild);
    }

    private canObsidianOpenExtension(extension: string): boolean {
        const normalized = extension.trim().replace(/^\./, '').toLowerCase();
        if (!normalized) return false;

        const viewRegistry = (this.app as unknown as {
            viewRegistry?: {
                getTypeByExtension?: (extension: string) => string | null | undefined;
            };
        }).viewRegistry;
        if (typeof viewRegistry?.getTypeByExtension === 'function') {
            try {
                return Boolean(viewRegistry.getTypeByExtension(normalized));
            } catch {
                // Fall back to Obsidian's standard formats on older builds.
            }
        }
        return OBSIDIAN_OPENABLE_EXTENSION_FALLBACK.has(normalized);
    }

    private fileExplorerVisibilityRules(): FileExplorerVisibilityRules {
        return {
            systemFolder: this.settings.hideSystemFolderInExplorer !== false,
            libraryFolder: this.settings.hideLibraryFolderInExplorer !== false,
            canvasFolder: this.settings.hideCanvasFolderInExplorer !== false,
            seriesMetadata: this.settings.hideSeriesMetadataInExplorer !== false,
            unsupportedFiles: this.settings.hideUnopenableFilesInExplorer !== false,
        };
    }

    /**
     * Hide only file-tree rows. Nothing is deleted, moved, excluded from search,
     * or made unavailable to NarrativeLab's own readers.
     */
    public updateFileExplorerVisibility(): void {
        const hiddenClass = 'sl-narrative-lab-hidden-file-tree-item';
        const enabled = this.settings.hideUnsupportedFilesInExplorer !== false;
        const rules = this.fileExplorerVisibilityRules();
        this.updateFileExplorerVisibilityModeClass();
        const explorers = activeDocument.querySelectorAll<HTMLElement>(
            '.workspace-leaf-content[data-type="file-explorer"]',
        );

        for (const explorer of Array.from(explorers)) {
            for (const title of Array.from(explorer.querySelectorAll<HTMLElement>('.nav-folder-title[data-path]'))) {
                const row = title.closest<HTMLElement>('.nav-folder');
                if (!row) continue;
                const path = title.dataset.path ?? '';
                row.classList.toggle(hiddenClass, enabled && shouldHideFileExplorerFolder(path, rules));
            }

            for (const title of Array.from(explorer.querySelectorAll<HTMLElement>('.nav-file-title[data-path]'))) {
                const row = title.closest<HTMLElement>('.nav-file');
                if (!row) continue;
                const path = title.dataset.path ?? '';
                const hidden = enabled && shouldHideFileExplorerFile(
                    path,
                    extension => this.canObsidianOpenExtension(extension),
                    rules,
                );
                row.classList.toggle(hiddenClass, hidden);
            }
        }
        this.updateFileExplorerVisibilityRibbon();
    }

    private updateFileExplorerVisibilityModeClass(): void {
        const body = activeDocument.body;
        if (!body) return;
        const enabled = this.settings.hideUnsupportedFilesInExplorer !== false;
        const rules = this.fileExplorerVisibilityRules();
        body.classList.toggle(
            'sl-narrative-lab-hide-file-explorer-internals',
            enabled,
        );
        body.classList.toggle('sl-narrative-lab-hide-system-folder', enabled && rules.systemFolder);
        body.classList.toggle('sl-narrative-lab-hide-library-folder', enabled && rules.libraryFolder);
        body.classList.toggle('sl-narrative-lab-hide-canvas-folder', enabled && rules.canvasFolder);
        body.classList.toggle('sl-narrative-lab-hide-series-metadata', enabled && rules.seriesMetadata);
    }

    private updateFileExplorerVisibilityRibbon(): void {
        const button = this.fileExplorerVisibilityRibbonEl;
        if (!button) return;
        const hidden = this.settings.hideUnsupportedFilesInExplorer !== false;
        const label = hidden
            ? t('Show hidden project files')
            : t('Hide project internal files');
        setIcon(button, hidden ? 'eye' : 'eye-off');
        button.setAttribute('aria-label', label);
        button.setAttribute('data-tooltip-position', 'right');
        button.classList.toggle('is-active', !hidden);
    }

    private async toggleFileExplorerVisibility(): Promise<void> {
        const previous = this.settings.hideUnsupportedFilesInExplorer !== false;
        this.settings.hideUnsupportedFilesInExplorer = !previous;
        try {
            await this.saveSettings();
            this.updateFileExplorerVisibility();
            new Notice(this.settings.hideUnsupportedFilesInExplorer
                ? t('Project internal files hidden')
                : t('Hidden project files shown'));
        } catch (error: unknown) {
            this.settings.hideUnsupportedFilesInExplorer = previous;
            this.updateFileExplorerVisibility();
            new Notice(t('Could not update project file visibility: {error}', {
                error: error instanceof Error ? error.message : String(error),
            }), 10000);
        }
    }

    private observeFileExplorerVisibility(): void {
        this.fileExplorerVisibilityObserver?.disconnect();
        this.updateFileExplorerVisibility();
        this.fileExplorerVisibilityObserver = new MutationObserver(mutations => {
            if (mutations.some(mutation => mutation.addedNodes.length > 0 || mutation.removedNodes.length > 0)) {
                // MutationObserver callbacks run before the browser's next
                // paint. Apply visibility immediately so newly mounted rows do
                // not appear for one frame when a folder is expanded.
                this.updateFileExplorerVisibility();
            }
        });
        const explorers = activeDocument.querySelectorAll<HTMLElement>(
            '.workspace-leaf-content[data-type="file-explorer"]',
        );
        for (const explorer of Array.from(explorers)) {
            this.fileExplorerVisibilityObserver.observe(explorer, { childList: true, subtree: true });
        }
    }

    private enableNativeTooltipSuppression(): void {
        const isInStoryLineUi = (el: HTMLElement): boolean => {
            let node: HTMLElement | null = el;
            while (node) {
                for (const cls of Array.from(node.classList)) {
                    if (cls.startsWith('story-line-')) return true;
                }
                node = node.parentElement;
            }
            return false;
        };

        const stripTitles = (root: ParentNode): void => {
            const rootNode = root as unknown as Node;
            if (!(rootNode.instanceOf(HTMLElement) || rootNode.instanceOf(Document) || rootNode.instanceOf(DocumentFragment))) return;
            const candidates = (root as ParentNode).querySelectorAll?.('[title]') || [];
            for (const node of Array.from(candidates)) {
                if (!node.instanceOf(HTMLElement)) continue;
                if (isInStoryLineUi(node) && node.hasAttribute('aria-label')) {
                    node.removeAttribute('title');
                }
            }
            if (rootNode.instanceOf(HTMLElement)
                && (root as HTMLElement).hasAttribute('title')
                && (root as HTMLElement).hasAttribute('aria-label')
                && isInStoryLineUi(root as HTMLElement)) {
                (root as HTMLElement).removeAttribute('title');
            }
        };

        stripTitles(activeDocument.body);

        this.nativeTooltipObserver = new MutationObserver((mutations) => {
            for (const mutation of mutations) {
                if (mutation.type === 'attributes') {
                    const target = mutation.target;
                    if (target.instanceOf(HTMLElement)
                        && target.hasAttribute('title')
                        && target.hasAttribute('aria-label')
                        && isInStoryLineUi(target)) {
                        target.removeAttribute('title');
                    }
                    continue;
                }
                for (const node of Array.from(mutation.addedNodes)) {
                    if (node.instanceOf(HTMLElement)) stripTitles(node);
                }
            }
        });

        this.nativeTooltipObserver.observe(activeDocument.body, {
            subtree: true,
            childList: true,
            attributes: true,
            attributeFilter: ['title'],
        });
    }

    async loadSettings(): Promise<void> {
        const ownData = (await this.loadData()) as Record<string, unknown> | null;
        let migratedData: Record<string, unknown> = ownData && typeof ownData === 'object' ? { ...ownData } : {};
        let importedLegacySettings = false;
        let removedObsoleteSettings = false;
        const configDir = this.app.vault.configDir;
        const readPluginData = async (pluginId: string): Promise<Record<string, unknown> | null> => {
            const path = normalizePath(`${configDir}/plugins/${pluginId}/data.json`);
            try {
                if (!await this.app.vault.adapter.exists(path)) return null;
                const parsed = JSON.parse(await this.app.vault.adapter.read(path));
                return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
                    ? parsed as Record<string, unknown>
                    : null;
            } catch { return null; }
        };

        // First-run migration keeps the two source plugins installed but reads
        // their settings into NarrativeLab's own data namespace.
        if (Object.keys(migratedData).length === 0) {
            const storylineData = await readPluginData('storyline');
            if (storylineData) {
                migratedData = { ...storylineData };
                importedLegacySettings = true;
            }
        }
        if (!migratedData.narrativeCanvasData) {
            const canvasData = await readPluginData('narrative-canvas');
            if (canvasData) {
                migratedData.narrativeCanvasData = canvasData;
                importedLegacySettings = true;
            }
        }

        // Adopt the previous standalone Canvas language on first upgrade so
        // users keep the same interface instead of unexpectedly switching.
        if (migratedData.interfaceLanguage === undefined) {
            const canvasData = migratedData.narrativeCanvasData as {
                settings?: { language?: unknown };
            } | undefined;
            migratedData.interfaceLanguage = normalizeUiLanguageSetting(
                canvasData?.settings?.language ?? 'auto',
            );
        }

        // Migrate legacy hideFrontmatter boolean → frontmatterDisplay tri-state.
        // Old "hide off" meant "don't fully hide" — that maps to folded-with-header,
        // not always-expanded. Users who want expanded pick it in Settings.
        if (migratedData.frontmatterDisplay === undefined) {
            migratedData.frontmatterDisplay = migratedData.hideFrontmatter === true
                ? 'hide'
                : 'collapse';
        }
        for (const key of [
            'hideFrontmatter',
            'lastStorylineArcFilter',
            'showWarnings',
            'characterTaglineField',
            'sharedCodex',
        ]) {
            if (key in migratedData) {
                delete migratedData[key];
                removedObsoleteSettings = true;
            }
        }

        this.settings = Object.assign({}, DEFAULT_SETTINGS, migratedData);
        if (
            !this.settings.libraryUiByProject
            || typeof this.settings.libraryUiByProject !== 'object'
            || Array.isArray(this.settings.libraryUiByProject)
        ) {
            this.settings.libraryUiByProject = {};
        }
        const navigatorCollapsedSections = Array.isArray(this.settings.navigatorCollapsedSections)
            ? this.settings.navigatorCollapsedSections.filter(
                (section): section is 'notes' | 'scenes' => section === 'notes' || section === 'scenes',
            )
            : [];
        this.settings.navigatorCollapsedSections = [...new Set(navigatorCollapsedSections)];
        if (!Array.isArray(this.settings.sceneTemplates)) {
            this.settings.sceneTemplates = [];
        } else {
            this.settings.sceneTemplates = this.settings.sceneTemplates
                .filter(template => template && typeof template === 'object')
                .map(template => ({
                    ...template,
                    id: typeof template.id === 'string' && template.id ? template.id : `scene_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`,
                    scope: 'global' as const,
                    defaultFields: { ...(template.defaultFields || {}) },
                    bodyTemplate: typeof template.bodyTemplate === 'string' ? template.bodyTemplate : '',
                }));
        }
        if (!Array.isArray(this.settings.structureTemplates)) {
            this.settings.structureTemplates = [];
        } else {
            this.settings.structureTemplates = this.settings.structureTemplates
                .filter(template => template && typeof template === 'object')
                .map(template => ({
                    ...template,
                    id: template.id || `structure_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`,
                    scope: 'global' as const,
                }));
        }
        if (!Array.isArray(this.settings.projectPresets)) {
            this.settings.projectPresets = [];
        } else {
            this.settings.projectPresets = this.settings.projectPresets
                .filter(template => template && typeof template === 'object')
                .map(template => ({
                    ...template,
                    id: template.id || `preset_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`,
                    scope: 'global' as const,
                }));
        }
        this.settings.interfaceLanguage = normalizeUiLanguageSetting(this.settings.interfaceLanguage);
        if (this.settings.frontmatterDisplay !== 'hide'
            && this.settings.frontmatterDisplay !== 'visible'
            && this.settings.frontmatterDisplay !== 'collapse') {
            this.settings.frontmatterDisplay = 'collapse';
        }
        if (importedLegacySettings || removedObsoleteSettings) await this.saveData(migratedData);
        // Issue #73 — propagate the wikilink-writer toggle to MetadataParser
        setWriteSceneFieldsAsWikilinks(this.settings.writeFieldsAsWikilinks !== false);
        // Issue #78 — propagate wordcount-exclusion toggles to MetadataParser
        setWordcountExclusions({
            comments: this.settings.excludeCommentsFromWordcount !== false,
            checklists: this.settings.excludeChecklistFromWordcount === true,
        });
        setWordcountLocale(normalizeStoryLineLocale(this.settings.defaultProjectLanguage));
        // Migrate any absolute OS paths in extraFolders to vault-relative
        // paths so the vault adapter can find them. Cross-platform safe.
        if (Array.isArray(this.settings.extraFolders) && this.settings.extraFolders.length > 0) {
            const migrated = this.settings.extraFolders.map(f => this.toVaultRelativePath(f)).filter(Boolean);
            if (migrated.join('|') !== this.settings.extraFolders.join('|')) {
                this.settings.extraFolders = migrated;
                await this.saveSettings();
            }
        }
        // Snapshot the global colour settings so we can restore them when
        // switching to a project that has no per-project overrides.
        // Default UI theme: follow Obsidian unless explicitly light/dark
        if (this.settings.uiTheme !== 'light' && this.settings.uiTheme !== 'dark' && this.settings.uiTheme !== 'auto') {
            this.settings.uiTheme = 'auto';
        }
        this._globalColorDefaults = {
            colorScheme: this.settings.colorScheme,
            plotlineHue: this.settings.plotlineHue,
            plotlineSaturation: this.settings.plotlineSaturation,
            plotlineLightness: this.settings.plotlineLightness,
            stickyNoteTheme: this.settings.stickyNoteTheme,
            stickyNoteHue: this.settings.stickyNoteHue,
            stickyNoteSaturation: this.settings.stickyNoteSaturation,
            stickyNoteLightness: this.settings.stickyNoteLightness,
            stickyNoteOverrides: { ...(this.settings.stickyNoteOverrides || {}) },
            stickyNoteFontColorLight: this.settings.stickyNoteFontColorLight,
            stickyNoteFontColorDark: this.settings.stickyNoteFontColorDark,
            uiTheme: this.settings.uiTheme,
        };
        // Library categories used to live in global data.json and leaked across
        // projects. Keep one seed for first-time per-project migration.
        this._legacyLibraryCategoryDefaults = readLibraryCategorySettings(this.settings);
        this._legacyLibraryProfileLayoutDefaults = readLibraryProfileLayout(this.settings);
    }

    /** Per-project field keys that live in System/ files, not data.json */
    private static readonly PROJECT_DATA_KEYS: string[] = [
        'tagColors', 'tagTypeOverrides', 'characterAliases', 'ignoredCharacters',
        'writingTrackerData', 'useProjectColors', 'uiTheme',
        // Legacy plotgrid data stored directly in data.json (before file-based storage)
        'rows', 'columns', 'cells', 'zoom', 'stickyHeaders',
        // Legacy / per-project keys that don't belong in global settings
        'filterPresets',
        // Library categories are one-config-per-project (System/library-categories.json)
        'codexEnabledCategories', 'codexCustomCategories', 'libraryCategoryOrder',
        'libraryHiddenFixedCategories', 'codexDeletedPresetCategories', 'codexPresetSeedVersion',
        // Archive profile field layout (System/library-profile-layout.json)
        'hiddenFields', 'removedBuiltinFields', 'removedBuiltinSections',
        'characterCustomSections', 'locationCustomSections', 'codexCategoryCustomSections',
        'codexCategoryFieldTemplates', 'profileOrientations', 'profileFieldInputHeights',
        'profileFieldOverrides', 'profileSectionOrders',
    ];

    /** Obsidian appearance → NL/ncanvas light|dark. */
    detectObsidianUiTheme(): 'light' | 'dark' {
        return activeDocument.body?.classList.contains('theme-dark') ? 'dark' : 'light';
    }

    /** Resolved light|dark used by chrome + Narrative Canvas (auto → Obsidian). */
    getEffectiveUiTheme(): 'light' | 'dark' {
        if (this.settings.uiTheme === 'light' || this.settings.uiTheme === 'dark') {
            return this.settings.uiTheme;
        }
        return this.detectObsidianUiTheme();
    }

    /**
     * Set project UI theme preference (auto / light / dark) and persist.
     * Canvas toggle passes light|dark and locks the project off auto.
     */
    async setUiTheme(theme: 'auto' | 'light' | 'dark', opts?: { skipCanvas?: boolean }): Promise<void> {
        const next = theme === 'light' || theme === 'dark' || theme === 'auto' ? theme : 'auto';
        this.settings.uiTheme = next;
        // Keep global snapshot when not using project-specific colors
        if (!this.settings.useProjectColors) {
            this._globalColorDefaults.uiTheme = next;
        }
        this.applyUiTheme();
        if (!opts?.skipCanvas) {
            const resolved = this.getEffectiveUiTheme();
            (window as unknown as {
                NarrativeCanvasApp?: { setTheme?: (t: 'light' | 'dark', o?: { force?: boolean; fromHost?: boolean }) => unknown };
            }).NarrativeCanvasApp?.setTheme?.(resolved, { force: true, fromHost: true });
        }
        // Theme is CSS-driven — do not remount open views (would flash / reset canvas).
        await this.saveSettings();
    }

    /** Enable/disable per-project color overrides (Navigator project menu). */
    async setUseProjectColors(enabled: boolean): Promise<void> {
        const next = !!enabled;
        if (this.settings.useProjectColors === next) return;
        this.settings.useProjectColors = next;
        if (!next) {
            const g = this._globalColorDefaults;
            if (g && Object.keys(g).length > 0) {
                if (g.colorScheme !== undefined) this.settings.colorScheme = g.colorScheme as SceneCardsSettings['colorScheme'];
                if (g.plotlineHue !== undefined) this.settings.plotlineHue = g.plotlineHue;
                if (g.plotlineSaturation !== undefined) this.settings.plotlineSaturation = g.plotlineSaturation;
                if (g.plotlineLightness !== undefined) this.settings.plotlineLightness = g.plotlineLightness;
                if (g.stickyNoteTheme !== undefined) this.settings.stickyNoteTheme = g.stickyNoteTheme as SceneCardsSettings['stickyNoteTheme'];
                if (g.stickyNoteHue !== undefined) this.settings.stickyNoteHue = g.stickyNoteHue;
                if (g.stickyNoteSaturation !== undefined) this.settings.stickyNoteSaturation = g.stickyNoteSaturation;
                if (g.stickyNoteLightness !== undefined) this.settings.stickyNoteLightness = g.stickyNoteLightness;
                this.settings.stickyNoteOverrides = { ...(g.stickyNoteOverrides || {}) };
                if (g.stickyNoteFontColorLight !== undefined) this.settings.stickyNoteFontColorLight = g.stickyNoteFontColorLight;
                if (g.stickyNoteFontColorDark !== undefined) this.settings.stickyNoteFontColorDark = g.stickyNoteFontColorDark;
            }
        } else if (Object.keys(this._globalColorDefaults).length === 0) {
            this._globalColorDefaults = {
                colorScheme: this.settings.colorScheme,
                plotlineHue: this.settings.plotlineHue,
                plotlineSaturation: this.settings.plotlineSaturation,
                plotlineLightness: this.settings.plotlineLightness,
                stickyNoteTheme: this.settings.stickyNoteTheme,
                stickyNoteHue: this.settings.stickyNoteHue,
                stickyNoteSaturation: this.settings.stickyNoteSaturation,
                stickyNoteLightness: this.settings.stickyNoteLightness,
                stickyNoteOverrides: { ...(this.settings.stickyNoteOverrides || {}) },
                stickyNoteFontColorLight: this.settings.stickyNoteFontColorLight,
                stickyNoteFontColorDark: this.settings.stickyNoteFontColorDark,
                uiTheme: this.settings.uiTheme,
            };
        }
        await this.saveSettings();
        this.refreshOpenViews();
    }

    /**
     * Apply project theme override classes. In `auto`, remove them so NL
     * chrome (including sidebars) follows Obsidian’s global appearance.
     */
    applyUiTheme(): void {
        const body = activeDocument.body;
        if (!body) return;
        const prefer = this.settings.uiTheme;
        const override = prefer === 'light' || prefer === 'dark' ? prefer : null;
        body.classList.toggle('narrative-lab-theme-light', override === 'light');
        body.classList.toggle('narrative-lab-theme-dark', override === 'dark');
    }

    /** When uiTheme is auto, push Obsidian appearance changes to Narrative Canvas. */
    private observeObsidianUiTheme(): void {
        const body = activeDocument.body;
        if (!body) return;
        this.lastObservedObsidianTheme = this.detectObsidianUiTheme();
        this.uiThemeObserver?.disconnect();
        this.uiThemeObserver = new MutationObserver(() => {
            const next = this.detectObsidianUiTheme();
            if (next === this.lastObservedObsidianTheme) return;
            this.lastObservedObsidianTheme = next;
            if (this.settings.uiTheme !== 'auto') return;
            this.applyUiTheme();
            (window as unknown as {
                NarrativeCanvasApp?: { setTheme?: (t: 'light' | 'dark', o?: { force?: boolean; fromHost?: boolean }) => unknown };
            }).NarrativeCanvasApp?.setTheme?.(next, { force: true, fromHost: true });
        });
        this.uiThemeObserver.observe(body, { attributes: true, attributeFilter: ['class'] });
    }

    async saveSettings(): Promise<void> {
        this.applyImageSizingVariables();
        registerCustomStatuses(this.settings.customStatuses || []);
        setWriteSceneFieldsAsWikilinks(this.settings.writeFieldsAsWikilinks !== false);
        setTopLevelMirrorEnabled(this.settings.universalFieldsMirrorTopLevel !== false);
        setWordcountExclusions({
            comments: this.settings.excludeCommentsFromWordcount !== false,
            checklists: this.settings.excludeChecklistFromWordcount === true,
        });
        setWordcountLocale(normalizeStoryLineLocale(this.sceneManager?.getEffectiveLocale() ?? this.settings.defaultProjectLanguage));
        const toSave: Record<string, unknown> = { ...this.settings };
        if (this._systemMigrationDone) {
            // Strip per-project data from the global data.json payload
            for (const key of SceneCardsPlugin.PROJECT_DATA_KEYS) {
                delete toSave[key];
            }
            // Keep empty Library category defaults in data.json so new vaults /
            // projects do not inherit the active project's working copy.
            const emptyCats = emptyLibraryCategorySettings();
            toSave.codexEnabledCategories = emptyCats.enabledCategories;
            toSave.codexCustomCategories = emptyCats.customCategories;
            toSave.libraryCategoryOrder = emptyCats.categoryOrder;
            toSave.libraryHiddenFixedCategories = emptyCats.hiddenFixedCategories;
            toSave.codexDeletedPresetCategories = emptyCats.deletedPresetCategories;
            toSave.codexPresetSeedVersion = emptyCats.presetSeedVersion;
            // Keep empty profile-layout defaults in data.json so projects do not
            // inherit the active project's working copy of hidden/removed fields.
            const emptyProfile = emptyLibraryProfileLayout();
            toSave.hiddenFields = emptyProfile.hiddenFields;
            toSave.removedBuiltinFields = emptyProfile.removedBuiltinFields;
            toSave.removedBuiltinSections = emptyProfile.removedBuiltinSections;
            toSave.characterCustomSections = emptyProfile.characterCustomSections;
            toSave.locationCustomSections = emptyProfile.locationCustomSections;
            toSave.codexCategoryCustomSections = emptyProfile.codexCategoryCustomSections;
            toSave.codexCategoryFieldTemplates = emptyProfile.codexCategoryFieldTemplates;
            toSave.profileOrientations = emptyProfile.profileOrientations;
            toSave.profileFieldInputHeights = emptyProfile.profileFieldInputHeights;
            toSave.profileFieldOverrides = emptyProfile.profileFieldOverrides;
            toSave.profileSectionOrders = emptyProfile.profileSectionOrders;
            // When using per-project colours, restore global defaults into
            // data.json so the global values are not overwritten by the
            // project-specific ones currently in memory.
            // uiTheme is always project-scoped — keep a global default for new projects
            toSave.uiTheme = this._globalColorDefaults.uiTheme ?? 'auto';
            if (this.settings.useProjectColors && Object.keys(this._globalColorDefaults).length > 0) {
                const g = this._globalColorDefaults;
                toSave.colorScheme = g.colorScheme;
                toSave.plotlineHue = g.plotlineHue;
                toSave.plotlineSaturation = g.plotlineSaturation;
                toSave.plotlineLightness = g.plotlineLightness;
                toSave.stickyNoteTheme = g.stickyNoteTheme;
                toSave.stickyNoteHue = g.stickyNoteHue;
                toSave.stickyNoteSaturation = g.stickyNoteSaturation;
                toSave.stickyNoteLightness = g.stickyNoteLightness;
                toSave.stickyNoteOverrides = g.stickyNoteOverrides ?? {};
                toSave.stickyNoteFontColorLight = g.stickyNoteFontColorLight;
                toSave.stickyNoteFontColorDark = g.stickyNoteFontColorDark;
            } else {
                // Keep global colour snapshot in sync so toggling
                // useProjectColors later doesn't revert to stale values.
                this._globalColorDefaults = {
                    colorScheme: this.settings.colorScheme,
                    plotlineHue: this.settings.plotlineHue,
                    plotlineSaturation: this.settings.plotlineSaturation,
                    plotlineLightness: this.settings.plotlineLightness,
                    stickyNoteTheme: this.settings.stickyNoteTheme,
                    stickyNoteHue: this.settings.stickyNoteHue,
                    stickyNoteSaturation: this.settings.stickyNoteSaturation,
                    stickyNoteLightness: this.settings.stickyNoteLightness,
                    stickyNoteOverrides: { ...(this.settings.stickyNoteOverrides || {}) },
                    stickyNoteFontColorLight: this.settings.stickyNoteFontColorLight,
                    stickyNoteFontColorDark: this.settings.stickyNoteFontColorDark,
                    uiTheme: this.settings.uiTheme,
                };
            }
        }
        await this.saveData(toSave);
        // Persist per-project data to System/ files (only after migration)
        if (this._systemMigrationDone) {
            await this.saveProjectSystemData();
        }
    }

    /** Canonical property order shared by profile editors, YAML writers, and Base views. */
    private resolveLibraryProfilePropertyOrder(categoryKey: string): LibraryProfilePropertyOrder | null {
        const codexDef = categoryKey === 'character' || categoryKey === 'world' || categoryKey === 'location'
            ? null
            : this.codexManager?.getCategoryDef(categoryKey);
        const sections = categoryKey === 'character'
            ? CHARACTER_CATEGORIES
            : categoryKey === 'world'
                ? WORLD_CATEGORIES
                : categoryKey === 'location'
                    ? LOCATION_CATEGORIES
                    : codexDef?.categories;
        if (!sections) return null;

        const templateCategory = categoryKey === 'world' || categoryKey === 'location'
            ? 'location'
            : categoryKey;
        const fieldSettingsKey = templateCategory;
        const defaultSectionIds = [...sections.map(section => section.title), 'Custom Fields'];
        const orderedSectionIds = getOrderedProfileSectionIds(
            this.settings,
            categoryKey,
            defaultSectionIds,
        );
        const removedSections = new Set(this.settings.removedBuiltinSections?.[categoryKey] ?? []);
        const removedFields = new Set(this.settings.removedBuiltinFields?.[fieldSettingsKey] ?? []);
        const hiddenFields = new Set(this.settings.hiddenFields?.[fieldSettingsKey] ?? []);
        const orderedKeys: string[] = [];
        const visibleKeys: string[] = [];
        const universalFieldIds: string[] = [];
        const customKeys: string[] = [];
        const visibilityKeys: Record<string, string> = {};
        const seenOrdered = new Set<string>();
        const seenVisible = new Set<string>();
        const seenUniversal = new Set<string>();
        const pushOrdered = (key: string): void => {
            if (!key || seenOrdered.has(key)) return;
            seenOrdered.add(key);
            orderedKeys.push(key);
        };
        const pushVisible = (key: string): void => {
            if (!key || seenVisible.has(key)) return;
            seenVisible.add(key);
            visibleKeys.push(key);
        };

        const customSections = (categoryKey === 'character'
            ? this.settings.characterCustomSections
            : categoryKey === 'world' || categoryKey === 'location'
                ? this.settings.locationCustomSections
                : this.settings.codexCategoryCustomSections?.[categoryKey]) as CustomSection[] | undefined;
        const knownCustomKeys: string[] = [];
        const addKnownCustomKey = (key: string): void => {
            const normalized = String(key || '').trim();
            if (normalized && !knownCustomKeys.includes(normalized)) knownCustomKeys.push(normalized);
        };
        for (const section of customSections ?? []) {
            for (const field of section.fields ?? []) {
                const name = typeof field === 'string' ? field : field.name;
                if (name) addKnownCustomKey(`${section.title}${CUSTOM_SECTION_KEY_SEP}${name}`);
            }
        }
        for (const name of this.settings.codexCategoryFieldTemplates?.[categoryKey] ?? []) {
            addKnownCustomKey(name);
        }
        const collectEntityCustomKeys = (entities: Array<{ custom?: Record<string, string> }>): void => {
            for (const entity of entities) {
                for (const key of Object.keys(entity.custom ?? {})) addKnownCustomKey(key);
            }
        };
        try {
            if (categoryKey === 'character') collectEntityCustomKeys(this.characterManager?.getAllCharacters() ?? []);
            else if (categoryKey === 'world') collectEntityCustomKeys(this.locationManager?.getAllWorlds() ?? []);
            else if (categoryKey === 'location') collectEntityCustomKeys(this.locationManager?.getAllLocations() ?? []);
            else collectEntityCustomKeys(this.codexManager?.getEntries(categoryKey) ?? []);
        } catch { /* managers may still be initialising during startup */ }
        const reservedProfileKeys = new Set<string>();
        for (const section of sections) {
            for (const field of section.fields) reservedProfileKeys.add(field.key);
        }
        for (const template of this.fieldTemplates.getAll()) {
            const templateCategory = template.category || 'character';
            const matchesCategory = templateCategory === categoryKey
                || ((categoryKey === 'world' || categoryKey === 'location') && templateCategory === 'location');
            const topLevelKey = template.topLevelKey?.trim();
            if (matchesCategory && topLevelKey) reservedProfileKeys.add(topLevelKey);
        }
        const customTopLevelKeys = buildCustomFieldTopLevelKeyMap(knownCustomKeys, reservedProfileKeys);
        const registerCustomKey = (key: string): void => {
            if (!key || customKeys.includes(key)) return;
            customKeys.push(key);
            const topLevelKey = customTopLevelKeys.get(key);
            if (!topLevelKey) return;
            pushOrdered(topLevelKey);
            pushVisible(topLevelKey);
        };
        const buckets: CustomSection[][] = Array.from(
            { length: orderedSectionIds.length + 1 },
            () => [],
        );
        for (const section of customSections ?? []) {
            const raw = Number(section.position);
            const slot = Number.isFinite(raw)
                ? Math.max(0, Math.min(orderedSectionIds.length, Math.trunc(raw)))
                : orderedSectionIds.length;
            buckets[slot].push(section);
        }
        const appendCustomSections = (slot: number): void => {
            if ((buckets[slot]?.length ?? 0) > 0) pushOrdered('custom');
            for (const section of buckets[slot] ?? []) {
                for (const field of section.fields ?? []) {
                    const name = typeof field === 'string' ? field : field.name;
                    const key = `${section.title}${CUSTOM_SECTION_KEY_SEP}${name}`;
                    if (name) registerCustomKey(key);
                }
            }
        };

        for (let index = 0; index < orderedSectionIds.length; index++) {
            appendCustomSections(index);
            const sectionId = orderedSectionIds[index];
            if (sectionId === 'Custom Fields') {
                pushOrdered('custom');
                for (const key of knownCustomKeys) {
                    if (!key.includes(CUSTOM_SECTION_KEY_SEP)) registerCustomKey(key);
                }
                continue;
            }
            const section = sections.find(item => item.title === sectionId);
            if (!section) continue;
            const builtInKeys = section.fields.map(field => field.key);
            const merged = this.fieldTemplates.getMergedOrder(section.title, templateCategory, builtInKeys);
            for (const entry of merged) {
                if (entry.kind === 'builtin') {
                    visibilityKeys[entry.key] = entry.key;
                    pushOrdered(entry.key);
                    if (!removedSections.has(section.title)
                        && !removedFields.has(entry.key)
                        && !hiddenFields.has(entry.key)) {
                        pushVisible(entry.key);
                    }
                    continue;
                }
                if (!seenUniversal.has(entry.key)) {
                    seenUniversal.add(entry.key);
                    universalFieldIds.push(entry.key);
                }
                pushOrdered('universalFields');
                const template = this.fieldTemplates.getById(entry.key);
                const topLevelKey = template?.topLevelKey?.trim();
                if (!topLevelKey) continue;
                visibilityKeys[topLevelKey] = `universal:${entry.key}`;
                pushOrdered(topLevelKey);
                if (!removedSections.has(section.title)
                    && !hiddenFields.has(`universal:${entry.key}`)) {
                    pushVisible(topLevelKey);
                }
            }
        }
        appendCustomSections(orderedSectionIds.length);
        // Preserve and expose custom keys whose section definition was removed
        // but whose values still exist in an entity file.
        for (const key of knownCustomKeys) registerCustomKey(key);

        return {
            orderedKeys,
            visibleKeys,
            customKeys,
            universalFieldIds,
            reservedKeys: [...reservedProfileKeys],
            visibilityKeys,
        };
    }

    /**
     * Apply a native Base Properties change to the matching profile layout.
     * Base `order` is its visible-column list; synchronising it here prevents
     * the canonical profile order from restoring a column the user just hid.
     */
    async syncLibraryProfileVisibilityFromBase(
        categoryId: string,
        visiblePropertyIds: readonly string[],
    ): Promise<boolean> {
        const profileCategoryKeys = categoryId === 'characters'
            ? ['character']
            : categoryId === 'locations'
                ? ['world', 'location']
                : categoryId === '__all-library__'
                    ? []
                    : [categoryId];
        if (profileCategoryKeys.length === 0) return false;

        const settingsKey = categoryId === 'characters'
            ? 'character'
            : categoryId === 'locations'
                ? 'location'
                : categoryId;
        const visibleNoteKeys = new Set(
            visiblePropertyIds
                .map(propertyId => propertyId.startsWith('note.')
                    ? propertyId.slice('note.'.length)
                    : (!propertyId.includes('.') ? propertyId : ''))
                .filter(Boolean),
        );
        const managed = new Map<string, string>();
        for (const profileCategoryKey of profileCategoryKeys) {
            const layout = this.resolveLibraryProfilePropertyOrder(profileCategoryKey);
            for (const [propertyKey, hiddenKey] of Object.entries(layout?.visibilityKeys ?? {})) {
                if (propertyKey !== 'name' && hiddenKey !== 'name') managed.set(propertyKey, hiddenKey);
            }
        }
        if (managed.size === 0) return false;

        const previous = [...(this.settings.hiddenFields?.[settingsKey] ?? [])];
        const hidden = new Set(previous);
        for (const [propertyKey, hiddenKey] of managed) {
            if (visibleNoteKeys.has(propertyKey)) hidden.delete(hiddenKey);
            else hidden.add(hiddenKey);
        }
        const next = [...hidden];
        if (next.length === previous.length && next.every(key => previous.includes(key))) return false;

        if (!this.settings.hiddenFields) this.settings.hiddenFields = {};
        this.settings.hiddenFields[settingsKey] = next;
        try {
            await this.saveSettings();
        } catch (error) {
            this.settings.hiddenFields[settingsKey] = previous;
            throw error;
        }
        return true;
    }

    private applyImageSizingVariables(): void {
        const root = activeDocument.documentElement;
        root.style.setProperty('--sl-character-card-portrait-size', `${this.settings.characterCardPortraitSize}px`);
    }

    /**
     * Scan all plotgrid cells for character, location, and tag mentions.
     * Returns a map of canonical-character-name → set of row labels where
     * that character is mentioned, plus similar maps for locations and tags,
     * and detailed hit lists (page / file / scene) for archive deep-links.
     *
     * Used by CharacterView to augment per-character scene counts with
     * plotgrid references.
     */
    async scanPlotGridCells(): Promise<{
        characters: Map<string, Set<string>>;
        locations: Map<string, Set<string>>;
        tags: Map<string, Set<string>>;
        characterHits: Map<string, PlotGridAppearanceHit[]>;
        locationHits: Map<string, PlotGridAppearanceHit[]>;
        tagHits: Map<string, PlotGridAppearanceHit[]>;
        filePath: string;
    }> {
        const projectFile = normalizePath(this.sceneManager.activeProject?.filePath || '');
        const cached = this._plotGridScanCache;
        if (
            cached
            && cached.projectFile === projectFile
            && Date.now() - cached.at < SceneCardsPlugin.PLOTGRID_SCAN_TTL_MS
        ) {
            return cached.result;
        }

        const characters = new Map<string, Set<string>>();
        const locations = new Map<string, Set<string>>();
        const tags = new Map<string, Set<string>>();
        const characterHits = new Map<string, PlotGridAppearanceHit[]>();
        const locationHits = new Map<string, PlotGridAppearanceHit[]>();
        const tagHits = new Map<string, PlotGridAppearanceHit[]>();
        const filePath = normalizePath(plotGridXlsxPath(this.getProjectBaseFolder()));

        const empty = {
            characters,
            locations,
            tags,
            characterHits,
            locationHits,
            tagHits,
            filePath,
        };

        const data = await this.loadPlotGrid();
        if (!data?.pages?.length) {
            this._plotGridScanCache = { projectFile, at: Date.now(), result: empty };
            return empty;
        }

        this.linkScanner.rebuildLookups(this.settings.characterAliases);

        // Build alias map for dedup
        const aliasMap = this.characterManager.buildAliasMap(this.settings.characterAliases);

        const upsertHit = (
            map: Map<string, PlotGridAppearanceHit[]>,
            key: string,
            hit: PlotGridAppearanceHit,
        ): void => {
            const list = map.get(key) || [];
            const existing = list.find(h => h.pageId === hit.pageId && h.rowId === hit.rowId);
            if (existing) {
                if (!existing.columnLabel && hit.columnLabel) {
                    existing.columnLabel = hit.columnLabel;
                    existing.columnId = hit.columnId;
                    existing.columnIndex = hit.columnIndex;
                }
                return;
            }
            list.push(hit);
            map.set(key, list);
        };

        for (const page of data.pages) {
          for (const [key, cell] of Object.entries(page.cells || {})) {
            if (!cell?.content?.trim()) continue;

            // Determine row label for context
            const rowId = key.split('-').slice(0, 2).join('-'); // row id is first part of key
            const rowIndex = page.rows.findIndex(r => key.startsWith(r.id + '-'));
            const row = rowIndex >= 0 ? page.rows[rowIndex] : undefined;
            const rowLabel = row?.label || rowId;
            const colIndex = row
                ? page.columns.findIndex(c => key === `${row.id}-${c.id}`)
                : -1;
            const col = colIndex >= 0 ? page.columns[colIndex] : undefined;

            const result = this.linkScanner.scanText(cell.content);
            const baseHit: PlotGridAppearanceHit = {
                pageId: page.id,
                pageTitle: page.title || t('Page {n}', { n: 1 }),
                rowId: row?.id || rowId,
                rowLabel,
                filePath,
                scenePath: row?.sourceId || undefined,
                columnId: col?.id,
                columnLabel: col?.label,
                rowIndex: rowIndex >= 0 ? rowIndex : 0,
                columnIndex: colIndex >= 0 ? colIndex : undefined,
            };

            // Characters (deduplicated via alias map)
            for (const name of result.characters) {
                const canonical = aliasMap.get(name.toLowerCase()) || name;
                const cKey = canonical.toLowerCase();
                if (!characters.has(cKey)) characters.set(cKey, new Set());
                characters.get(cKey)!.add(rowLabel);
                upsertHit(characterHits, cKey, { ...baseHit });
            }

            // Locations (deduplicated)
            for (const name of result.locations) {
                const lKey = name.toLowerCase();
                if (!locations.has(lKey)) locations.set(lKey, new Set());
                locations.get(lKey)!.add(rowLabel);
                upsertHit(locationHits, lKey, { ...baseHit });
            }

            // Tags
            for (const tag of result.tags) {
                const tKey = tag.toLowerCase();
                if (!tags.has(tKey)) tags.set(tKey, new Set());
                tags.get(tKey)!.add(rowLabel);
                upsertHit(tagHits, tKey, { ...baseHit });
            }
          }
        }

        const result = {
            characters,
            locations,
            tags,
            characterHits,
            locationHits,
            tagHits,
            filePath,
        };
        this._plotGridScanCache = { projectFile, at: Date.now(), result };
        return result;
    }

    /** Open Concept Grid focused on a plotgrid appearance hit from an archive page. */
    async openPlotGridAppearance(hit: PlotGridAppearanceHit): Promise<void> {
        const projectFile = this.findProjectFileForVaultPath(hit.filePath);
        await this.activateView(PLOTGRID_VIEW_TYPE, projectFile);
        const leaf = this.findBoundLeafOfType(PLOTGRID_VIEW_TYPE, projectFile);
        if (!leaf) return;
        this.app.workspace.revealLeaf(leaf);
        const view = leaf.view as PlotgridView;
        if (typeof view.navigateToAppearance === 'function') {
            view.navigateToAppearance(hit);
        }
    }

    /** True when per-project Library/datasheet-*.xlsx already exists. */
    async plotGridXlsxExists(projectFilePath?: string | null): Promise<boolean> {
        const target = normalizePath(projectFilePath || this.sceneManager.activeProject?.filePath || '');
        if (!target) return false;
        const baseFolder = normalizePath(deriveProjectFoldersFromFilePath(target).baseFolder);
        try {
            const adapter = this.app.vault.adapter;
            const canonical = normalizePath(plotGridXlsxPath(baseFolder));
            const legacy = normalizePath(legacyPlotGridXlsxPath(baseFolder));
            return await adapter.exists(canonical) || await adapter.exists(legacy);
        } catch {
            return false;
        }
    }

    /** In-memory datasheet for the current project — skip the xlsx wait on reopen. */
    peekPlotGridDoc(projectFile?: string | null): ConceptGridDocument | null {
        const target = normalizePath(projectFile || this.sceneManager.activeProject?.filePath || '');
        const cached = this.lookupPlotGridDocCache({ projectFile: target });
        if (!cached || !target || cached.projectFile !== target) return null;
        const doc = cached.doc;
        if (isDefaultEmptyConceptGrid(doc)) return null;
        if (countConceptGridFilledCells(doc) === 0 && (doc.pages?.length ?? 0) < 2) return null;
        return structuredClone(doc);
    }

    /** Drop cached plotgrid mention scan (call after plotgrid writes). */
    invalidatePlotGridScanCache(): void {
        this._plotGridScanCache = null;
    }

    private lookupPlotGridDocCache(options: {
        projectFile?: string;
        xlsxPath?: string;
    }): {
        projectFile: string;
        xlsxPath: string;
        mtime: number;
        size: number;
        xlsxDigest: string;
        metaDigest: string;
        doc: ConceptGridDocument;
    } | null {
        if (options.projectFile) {
            const hit = this._plotGridDocCache.get(normalizePath(options.projectFile));
            if (hit) return hit;
        }
        if (options.xlsxPath) {
            const path = normalizePath(options.xlsxPath);
            for (const hit of this._plotGridDocCache.values()) {
                if (hit.xlsxPath === path) return hit;
            }
        }
        return null;
    }

    private rememberPlotGridDocCache(
        projectFile: string,
        xlsxPath: string,
        doc: ConceptGridDocument,
        stat?: { mtime?: number; size?: number } | null,
        integrity?: { xlsx?: ArrayBuffer | Uint8Array; metaText?: string },
    ): void {
        const key = normalizePath(projectFile);
        this._plotGridDocCache.set(key, {
            projectFile: key,
            xlsxPath: normalizePath(xlsxPath),
            mtime: stat?.mtime ?? Date.now(),
            size: stat?.size ?? 0,
            xlsxDigest: integrity?.xlsx ? plotGridBinaryDigest(integrity.xlsx) : '',
            metaDigest: plotGridTextDigest(integrity?.metaText ?? ''),
            doc: structuredClone(doc),
        });
    }

    // ────────────────────────────────────
    //  Codex change detection
    // ────────────────────────────────────

    /**
     * Load stored codex content digests from System/codex-digests.json.
     */
    async loadCodexDigests(): Promise<Record<string, string>> {
        const data = await this.readSystemJson('codex-digests.json');
        return (data.digests || {}) as Record<string, string>;
    }

    /**
     * Save codex content digests to System/codex-digests.json.
     */
    async saveCodexDigests(digests: Record<string, string>): Promise<void> {
        await this.writeSystemJson('codex-digests.json', { digests });
    }

    /**
     * Ensure new codex entries get a baseline digest and deleted entries are
     * pruned. Does NOT overwrite existing digests (so changes are detectable).
     */
    async refreshCodexDigests(): Promise<void> {
        const stored = await this.loadCodexDigests();
        const current = this.linkScanner.computeCodexDigests();
        let changed = false;

        // Add digests for entries not yet tracked
        for (const [fp, digest] of Object.entries(current)) {
            if (!(fp in stored)) {
                stored[fp] = digest;
                changed = true;
            }
        }

        // Remove digests for deleted entries
        for (const fp of Object.keys(stored)) {
            if (!(fp in current)) {
                delete stored[fp];
                changed = true;
            }
        }

        if (changed) await this.saveCodexDigests(stored);
    }

    /**
     * Return codex entries whose content has changed since the last review,
     * along with the scenes that reference them.
     */
    async getStaleCodexEntries(): Promise<{ entry: import('./models/Codex').CodexEntry; affectedScenes: import('./services/LinkScanner').EntityReference[] }[]> {
        const stored = await this.loadCodexDigests();
        const current = this.linkScanner.computeCodexDigests();

        const stale: { entry: import('./models/Codex').CodexEntry; affectedScenes: import('./services/LinkScanner').EntityReference[] }[] = [];
        const index = this.linkScanner.buildEntityIndex();

        for (const [fp, digest] of Object.entries(current)) {
            if (fp in stored && stored[fp] !== digest) {
                const entry = this.codexManager.getAllEntries().find(e => e.filePath === fp);
                if (entry) {
                    const refs = index.get(entry.name.toLowerCase()) || [];
                    const sceneRefs = refs.filter(r => r.type === 'scene');
                    if (sceneRefs.length > 0) {
                        stale.push({ entry, affectedScenes: sceneRefs });
                    }
                }
            }
        }

        return stale;
    }

    /**
     * Mark a codex entry as reviewed — updates its stored digest to the
     * current content so it's no longer flagged as stale.
     */
    async markCodexEntryReviewed(filePath: string): Promise<void> {
        const stored = await this.loadCodexDigests();
        const current = this.linkScanner.computeCodexDigests();
        if (current[filePath]) {
            stored[filePath] = current[filePath];
        }
        await this.saveCodexDigests(stored);
    }

    // ────────────────────────────────────
    //  Project System folder helpers
    // ────────────────────────────────────

    /**
     * Return the base folder for the active project (parent of /Scenes).
     * Falls back to the configured NarrativeLab root when no project is active.
     */
    getProjectBaseFolder(): string {
        const project = this.sceneManager?.activeProject ?? null;
        let base = project
            ? project.sceneFolder.replace(/\\/g, '/').replace(/\/Scenes\/?$/, '')
            : this.settings.storyLineRoot.replace(/\\/g, '/');
        base = normalizePath(base);
        // Obsidian adapter expects vault-relative paths. If a project somehow
        // stored an absolute Windows path, strip the vault root so writes don't
        // race / fail with opaque UNKNOWN open errors.
        const adapter = this.app.vault.adapter as { getBasePath?: () => string };
        const vaultAbs = adapter.getBasePath?.();
        if (vaultAbs) {
            const abs = normalizePath(vaultAbs).replace(/\\/g, '/');
            const absLower = abs.toLowerCase();
            const baseLower = base.replace(/\\/g, '/').toLowerCase();
            if (baseLower === absLower) base = '';
            else if (baseLower.startsWith(`${absLower}/`)) {
                base = normalizePath(base.slice(abs.length).replace(/^[/\\]+/, ''));
            }
        }
        return base;
    }

    /**
     * Return the System/ subfolder path for the active project.
     */
    getProjectSystemFolder(): string {
        return normalizePath(`${this.getProjectBaseFolder()}/System`);
    }

    /** Reject late project autosaves after its manifest or folder was removed. */
    private async projectExistsForWrite(projectFilePath: string | undefined): Promise<boolean> {
        if (!projectFilePath) return false;
        const normalized = normalizePath(projectFilePath);
        if (this.sceneManager.isDeletedProjectPath(normalized)) return false;
        for (const root of this._projectMoveWriteGuards) {
            if (normalized === root || normalized.startsWith(`${root}/`)) return false;
        }
        return this.app.vault.adapter.exists(normalized);
    }

    // ────────────────────────────────────
    //  Issue #71 follow-up — universal-field migrations
    // ────────────────────────────────────

    /**
     * Transform the file's current text rather than Obsidian's possibly stale
     * metadata cache. This is required for startup migrations: a file restored
     * externally can be newer than MetadataCache, and processFrontMatter would
     * otherwise recreate the cached empty version over the restored content.
     */
    private async processReadableFrontmatter(
        file: TFile,
        mutate: (frontmatter: Record<string, unknown>) => void,
    ): Promise<boolean> {
        let changed = false;
        const transform = (content: string): string => {
            const match = content.match(/^---\r?\n([\s\S]*?)\r?\n---/);
            if (!match) return content;
            const parsed = parseYaml(match[1]) as unknown;
            if (!isRecord(parsed)) {
                throw new Error(`Frontmatter is unreadable; refusing migration overwrite: ${file.path}`);
            }
            const before = JSON.stringify(parsed);
            mutate(parsed);
            if (JSON.stringify(parsed) === before) return content;
            changed = true;
            return `---\n${stringifyYaml(parsed)}---${content.slice(match[0].length)}`;
        };
        if (typeof this.app.vault.process === 'function') {
            await this.app.vault.process(file, transform);
        } else {
            const current = await this.app.vault.read(file);
            const next = transform(current);
            if (next !== current) await this.app.vault.modify(file, next);
        }
        return changed;
    }

    /**
     * Re-mirror universal-field values to top-level YAML for every existing
     * entity (characters, codex entries, locations, scenes) after a template
     * change. This means users adding `topLevelKey` to a previously-saved
     * field — or turning the global mirror toggle on — instantly see their
     * existing data flow into Properties / Bases / Dataview without having
     * to re-edit each note. Folder-sourced selections are wrapped as
     * `[[wikilinks]]` automatically by the mirror function.
     *
     * Pass `change` from the FieldTemplateService to also clean up a renamed
     * topLevelKey or a deleted template's stale top-level YAML key. Pass
     * nothing to do a full re-mirror sweep (used when the global toggle
     * flips on).
     */
    async migrateUniversalFieldMirror(change?: FieldTemplateChange): Promise<void> {
        const oldKey = change?.oldTopLevelKey && change.topLevelKeyChanged ? change.oldTopLevelKey : undefined;
        const removedTpl = change?.type === 'remove';

        // Only run when something user-visible would actually change.
        // For add/update, skip if neither topLevelKey nor folderSource changed.
        if (change && change.type !== 'remove') {
            if (!change.topLevelKeyChanged && !change.folderSourceChanged) return;
        }
        // Mirror writes only happen when the global toggle is on; if it's off
        // we still want to clean up old top-level keys (rename / removal),
        // but skip the full re-mirror sweep otherwise.
        const mirrorOn = this.settings.universalFieldsMirrorTopLevel !== false;
        if (!mirrorOn && !oldKey && !removedTpl) return;

        const files = this.collectEntityFiles();
        let touched = 0;
        for (const file of files) {
            try {
                const didChange = await this.processReadableFrontmatter(file, (fm) => {
                    // Strip a renamed / removed top-level key.
                    if (oldKey && !isReservedTopLevelKey(oldKey) && fm[oldKey] !== undefined) {
                        delete fm[oldKey];
                    }
                    if (removedTpl && change?.oldTopLevelKey && !isReservedTopLevelKey(change.oldTopLevelKey)) {
                        if (fm[change.oldTopLevelKey] !== undefined) {
                            delete fm[change.oldTopLevelKey];
                        }
                    }
                    if (mirrorOn) {
                        // Hydrate first so values that only live in top-level
                        // YAML get a universalFields counterpart, then mirror
                        // back to apply the (possibly new) wikilink wrapping.
                        const stored = fm.universalFields && typeof fm.universalFields === 'object'
                            && !Array.isArray(fm.universalFields)
                            ? fm.universalFields as Record<string, unknown>
                            : undefined;
                        const hydrated = hydrateUniversalFieldsFromTopLevel(fm, stored);
                        if (hydrated !== fm.universalFields) fm.universalFields = hydrated;
                        mirrorUniversalFieldsToTopLevel(fm, hydrated);
                    }
                });
                if (didChange) touched++;
            } catch (e) {
                console.error('[NarrativeLab] migrateUniversalFieldMirror:', file.path, e);
            }
        }
        if (touched > 0) {
            new Notice(t('NarrativeLab: synced custom-field YAML in {n} file(s).', { n: touched }));
        }
    }

    /**
     * Collect every TFile that may carry `universalFields`: characters,
     * codex entries, locations, and scenes (across all loaded projects).
     */
    private collectEntityFiles(): TFile[] {
        const files: TFile[] = [];
        const seen = new Set<string>();
        const push = (p: string | undefined | null) => {
            if (!p || seen.has(p)) return;
            const af = this.app.vault.getAbstractFileByPath(p);
            if (af instanceof TFile && af.extension === 'md') {
                seen.add(p);
                files.push(af);
            }
        };
        try { for (const c of this.characterManager?.getAllCharacters() ?? []) push(c.filePath); } catch { /* noop */ }
        try { for (const e of this.codexManager?.getAllEntries() ?? []) push(e.filePath); } catch { /* noop */ }
        try { for (const l of this.locationManager?.getAllLocations() ?? []) push(l.filePath); } catch { /* noop */ }
        try { for (const s of this.sceneManager?.getAllScenes() ?? []) push(s.filePath); } catch { /* noop */ }
        return files;
    }

    /**
     * Read a JSON file from the current project's System/ folder.
     * Returns an empty object if the file doesn't exist. Invalid data is kept
     * intact and backed up before a later save is allowed to replace it.
     */
    private async readSystemJson(filename: string): Promise<Record<string, unknown>> {
        const adapter = this.app.vault.adapter;
        const filePath = normalizePath(`${this.getProjectSystemFolder()}/${filename}`);
        try {
            if (!await adapter.exists(filePath)) {
                this._invalidSystemJsonPaths.delete(filePath);
                this._reportedInvalidSystemJsonPaths.delete(filePath);
                return {};
            }
            const txt = await this.readVaultTextResilient(filePath);
            const parsed: unknown = JSON.parse(txt);
            if (!isRecord(parsed)) throw new Error(t('Expected a JSON object.'));
            this._invalidSystemJsonPaths.delete(filePath);
            this._reportedInvalidSystemJsonPaths.delete(filePath);
            return parsed;
        } catch (error) {
            this._invalidSystemJsonPaths.add(filePath);
            console.error(`[NarrativeLab] readSystemJson(${filename}):`, error);
            if (!this._reportedInvalidSystemJsonPaths.has(filePath)) {
                this._reportedInvalidSystemJsonPaths.add(filePath);
                new Notice(t('Project data file "{name}" is invalid. It will be preserved before the next save.', { name: filename }));
            }
            return {};
        }
    }

    /**
     * Write a JSON object to a file in the given project's System/ folder.
     * Creates the System/ folder if it doesn't exist.
     * Pass `projectFilePath` from a snapshot taken before any await so a
     * project switch cannot redirect the write.
     */
    private async writeSystemJson(
        filename: string,
        data: Record<string, unknown>,
        projectFilePath = this.sceneManager.activeProject?.filePath,
    ): Promise<void> {
        if (!await this.projectExistsForWrite(projectFilePath)) return;
        const baseFolder = deriveProjectFoldersFromFilePath(projectFilePath!).baseFolder;
        const filePath = normalizePath(`${baseFolder}/System/${filename}`);
        const previous = this._systemJsonWriteQueues.get(filePath) ?? Promise.resolve();
        const pending = previous
            .catch(() => undefined)
            .then(() => this.writeSystemJsonSafely(filename, filePath, data, projectFilePath!));
        this._systemJsonWriteQueues.set(filePath, pending);
        try {
            await pending;
        } catch (e) {
            console.error(`[NarrativeLab] writeSystemJson(${filename}):`, e);
            new Notice(t('Could not save project data "{name}": {message}', {
                name: filename,
                message: e instanceof Error ? e.message : String(e),
            }));
            throw e;
        } finally {
            if (this._systemJsonWriteQueues.get(filePath) === pending) {
                this._systemJsonWriteQueues.delete(filePath);
            }
        }
    }

    private statsPayloadHistorySize(data: Record<string, unknown>): number {
        const tracker = data.writingTrackerData;
        if (!tracker || typeof tracker !== 'object') return 0;
        const history = (tracker as { history?: Record<string, number> }).history;
        return history && typeof history === 'object' ? Object.keys(history).length : 0;
    }

    /** Block empty ledgers / unreadable-file recovery from wiping System JSON. */
    private shouldRefuseSparseSystemJsonWrite(
        filename: string,
        data: Record<string, unknown>,
        previousContent: string | null,
        unreadable: boolean,
    ): boolean {
        const sparse = Object.keys(data).length === 0
            || (filename === 'stats.json' && this.statsPayloadHistorySize(data) === 0);
        if (unreadable && sparse) return true;
        if (filename !== 'stats.json' || !previousContent) return false;
        try {
            const prev = JSON.parse(previousContent) as Record<string, unknown>;
            return this.statsPayloadHistorySize(prev) > 0 && this.statsPayloadHistorySize(data) === 0;
        } catch {
            return false;
        }
    }

    private async writeSystemJsonSafely(
        filename: string,
        filePath: string,
        data: Record<string, unknown>,
        projectFilePath: string,
    ): Promise<void> {
        const adapter = this.app.vault.adapter;
        if (!await this.projectExistsForWrite(projectFilePath)) return;
        const systemFolder = normalizePath(filePath.slice(0, filePath.lastIndexOf('/')));
        if (!await adapter.exists(systemFolder)) {
            if (!await this.projectExistsForWrite(projectFilePath)) return;
            await this.ensureVaultFolder(systemFolder);
        }

        const payload = JSON.stringify(data, null, 2);
        const tempPath = `${filePath}.tmp`;
        const backupPath = `${filePath}.bak`;
        const existed = await adapter.exists(filePath);
        let previousContent: string | null = null;
        if (existed) {
            try {
                previousContent = await this.readVaultTextResilient(filePath);
            } catch (error) {
                throw new Error(t('Could not safely read {name} before saving: {message}', {
                    name: filename,
                    message: error instanceof Error ? error.message : String(error),
                }));
            }
        }

        if (this.shouldRefuseSparseSystemJsonWrite(filename, data, previousContent, this._invalidSystemJsonPaths.has(filePath))) {
            console.warn(`[NarrativeLab] Refusing to overwrite ${filename} with an empty payload`);
            return;
        }

        // Stage the new payload first so a later destination failure still leaves
        // the intended content on disk beside the original file.
        await this.writeVaultTextOnceResilient(tempPath, payload);

        if (previousContent !== null) {
            // .bak is best-effort: Windows often locks *.bak (AV / indexer /
            // previous failed save), and that must not abort plotlines.json itself.
            try {
                await this.writeVaultTextOnceResilient(backupPath, previousContent);
            } catch (error) {
                console.warn(`[NarrativeLab] Could not refresh ${filename}.bak:`, error);
            }
            if (this._invalidSystemJsonPaths.has(filePath)) {
                const stamp = new Date().toISOString().replace(/[:.]/g, '-');
                try {
                    await this.writeVaultTextOnceResilient(
                        `${filePath}.corrupt-${stamp}.bak`,
                        previousContent,
                    );
                } catch (error) {
                    console.warn(`[NarrativeLab] Could not write corrupt backup for ${filename}:`, error);
                }
            }
        }

        try {
            await this.writeVaultTextOnceResilient(filePath, payload);
            this._invalidSystemJsonPaths.delete(filePath);
            this._reportedInvalidSystemJsonPaths.delete(filePath);
            await adapter.remove(tempPath).catch(() => undefined);
        } catch (error) {
            // A valid backup and the intended new payload remain beside the file.
            throw new Error(t('Safe write failed for {name}: {message}', {
                name: filename,
                message: error instanceof Error ? error.message : String(error),
            }));
        }
    }

    /** Single-path text write with short retries for Windows UNKNOWN/EBUSY locks. */
    private async writeVaultTextOnceResilient(filePath: string, contents: string): Promise<void> {
        const adapter = this.app.vault.adapter;
        const path = normalizePath(filePath);

        let lastError: unknown;
        for (let attempt = 0; attempt < 8; attempt++) {
            try {
                await adapter.write(path, contents);
                return;
            } catch (error) {
                lastError = error;
                if (!isTransientVaultIoError(error) || attempt === 7) break;
                await waitForVaultRetry(Math.min(1200, 50 * (attempt + 1) * (attempt + 1)));
            }
        }
        throw lastError instanceof Error ? lastError : new Error(String(lastError));
    }

    private async readVaultTextResilient(filePath: string): Promise<string> {
        const adapter = this.app.vault.adapter;
        const path = normalizePath(filePath);
        let lastError: unknown;
        for (let attempt = 0; attempt < 8; attempt++) {
            try {
                return await adapter.read(path);
            } catch (error) {
                lastError = error;
                if (!isTransientVaultIoError(error) || attempt === 7) break;
                await waitForVaultRetry(Math.min(1200, 50 * (attempt + 1) * (attempt + 1)));
            }
        }
        throw lastError instanceof Error ? lastError : new Error(String(lastError));
    }

    async loadProjectSystemData(): Promise<void> {
        this._loadingProjectSystemData = true;
        try {
            await this.loadProjectSystemDataNow();
        } finally {
            this._loadingProjectSystemData = false;
        }
    }

    /**
     * Load per-project data from System/ files into the in-memory settings.
     * Called after a project is loaded or switched.
     */
    private async loadProjectSystemDataNow(): Promise<void> {
        const targetProjectFile = this.sceneManager?.activeProject?.filePath
            ? normalizePath(this.sceneManager.activeProject.filePath)
            : '';
        const plotlines = await this.readSystemJson('plotlines.json');
        const characters = await this.readSystemJson('characters.json');
        const stats = await this.readSystemJson('stats.json');
        const libraryCategoriesRaw = await this.readSystemJson(LIBRARY_CATEGORIES_FILENAME);
        const storedLibraryCategories = libraryCategorySettingsFromUnknown(libraryCategoriesRaw);
        const migratingLibraryCategories = !storedLibraryCategories;

        // Overlay per-project Library categories. First open after the
        // global→per-project split seeds from the legacy data.json snapshot,
        // then Library/ subfolders become the source of truth for tabs.
        let libraryCategoriesDirty = migratingLibraryCategories;
        if (storedLibraryCategories) {
            applyLibraryCategorySettings(this, storedLibraryCategories);
        } else {
            applyLibraryCategorySettings(this, {
                enabledCategories: [...this._legacyLibraryCategoryDefaults.enabledCategories],
                customCategories: this._legacyLibraryCategoryDefaults.customCategories.map(c => ({ ...c })),
                categoryOrder: [...this._legacyLibraryCategoryDefaults.categoryOrder],
                hiddenFixedCategories: [...this._legacyLibraryCategoryDefaults.hiddenFixedCategories],
                deletedPresetCategories: [...this._legacyLibraryCategoryDefaults.deletedPresetCategories],
                presetSeedVersion: this._legacyLibraryCategoryDefaults.presetSeedVersion || 0,
            });
            libraryCategoriesDirty = true;
        }
        const presetsSeeded = seedStorylinePresetCategories(this);
        if (presetsSeeded) libraryCategoriesDirty = true;
        if (await reconcileLibraryCategoriesForActiveProject(
            this,
            (presetsSeeded || migratingLibraryCategories) ? { createMissingRegistered: true } : {},
        )) {
            libraryCategoriesDirty = true;
        }

        // Overlay per-project archive profile field layout (hide / remove / custom sections).
        const profileLayoutRaw = await this.readSystemJson(LIBRARY_PROFILE_LAYOUT_FILENAME);
        const storedProfileLayout = libraryProfileLayoutFromUnknown(profileLayoutRaw);
        let profileLayoutDirty = !storedProfileLayout;
        if (storedProfileLayout) {
            applyLibraryProfileLayout(this.settings, storedProfileLayout);
        } else {
            applyLibraryProfileLayout(this.settings, {
                hiddenFields: { ...this._legacyLibraryProfileLayoutDefaults.hiddenFields },
                removedBuiltinFields: { ...this._legacyLibraryProfileLayoutDefaults.removedBuiltinFields },
                removedBuiltinSections: { ...(this._legacyLibraryProfileLayoutDefaults.removedBuiltinSections || {}) },
                characterCustomSections: JSON.parse(JSON.stringify(this._legacyLibraryProfileLayoutDefaults.characterCustomSections)) as unknown[],
                locationCustomSections: JSON.parse(JSON.stringify(this._legacyLibraryProfileLayoutDefaults.locationCustomSections)) as unknown[],
                codexCategoryCustomSections: JSON.parse(JSON.stringify(this._legacyLibraryProfileLayoutDefaults.codexCategoryCustomSections)) as Record<string, unknown[]>,
                codexCategoryFieldTemplates: { ...this._legacyLibraryProfileLayoutDefaults.codexCategoryFieldTemplates },
                profileOrientations: { ...this._legacyLibraryProfileLayoutDefaults.profileOrientations },
                profileFieldInputHeights: { ...this._legacyLibraryProfileLayoutDefaults.profileFieldInputHeights },
                profileFieldOverrides: JSON.parse(JSON.stringify(this._legacyLibraryProfileLayoutDefaults.profileFieldOverrides)),
                profileSectionOrders: JSON.parse(JSON.stringify(this._legacyLibraryProfileLayoutDefaults.profileSectionOrders)),
            });
            profileLayoutDirty = true;
        }

        // Overlay per-project data onto settings (used as working copy)
        this.settings.tagColors = isRecord(plotlines.tagColors)
            ? (plotlines.tagColors as Record<string, string>)
            : {};
        this.settings.tagTypeOverrides = isRecord(plotlines.tagTypeOverrides)
            ? (plotlines.tagTypeOverrides as Record<string, string>)
            : {};

        this.plotlineManager.applyLoaded(plotlines.definitions, targetProjectFile);

        // Per-project colour overrides (if the project has them stored)
        if (isRecord(plotlines.projectColors)) {
            const pc = asRecord(plotlines.projectColors);
            // Flag this project as having per-project colours
            this.settings.useProjectColors = true;
            if (pc.colorScheme) this.settings.colorScheme = pc.colorScheme as typeof this.settings.colorScheme;
            if (typeof pc.plotlineHue === 'number') this.settings.plotlineHue = pc.plotlineHue;
            if (typeof pc.plotlineSaturation === 'number') this.settings.plotlineSaturation = pc.plotlineSaturation;
            if (typeof pc.plotlineLightness === 'number') this.settings.plotlineLightness = pc.plotlineLightness;
            if (pc.stickyNoteTheme) this.settings.stickyNoteTheme = pc.stickyNoteTheme as typeof this.settings.stickyNoteTheme;
            if (typeof pc.stickyNoteHue === 'number') this.settings.stickyNoteHue = pc.stickyNoteHue;
            if (typeof pc.stickyNoteSaturation === 'number') this.settings.stickyNoteSaturation = pc.stickyNoteSaturation;
            if (typeof pc.stickyNoteLightness === 'number') this.settings.stickyNoteLightness = pc.stickyNoteLightness;
            if (isRecord(pc.stickyNoteOverrides)) {
                this.settings.stickyNoteOverrides = pc.stickyNoteOverrides as Record<number, string>;
            }
            if (typeof pc.stickyNoteFontColorLight === 'string') this.settings.stickyNoteFontColorLight = pc.stickyNoteFontColorLight;
            if (typeof pc.stickyNoteFontColorDark === 'string') this.settings.stickyNoteFontColorDark = pc.stickyNoteFontColorDark;
            // Legacy: uiTheme used to live inside projectColors
            if (pc.uiTheme === 'light' || pc.uiTheme === 'dark' || pc.uiTheme === 'auto') {
                this.settings.uiTheme = pc.uiTheme;
            }
        } else {
            // No per-project overrides — restore the global colour defaults
            this.settings.useProjectColors = false;
            const g = this._globalColorDefaults;
            if (g && Object.keys(g).length > 0) {
                if (g.colorScheme !== undefined) this.settings.colorScheme = g.colorScheme;
                if (g.plotlineHue !== undefined) this.settings.plotlineHue = g.plotlineHue;
                if (g.plotlineSaturation !== undefined) this.settings.plotlineSaturation = g.plotlineSaturation;
                if (g.plotlineLightness !== undefined) this.settings.plotlineLightness = g.plotlineLightness;
                if (g.stickyNoteTheme !== undefined) this.settings.stickyNoteTheme = g.stickyNoteTheme;
                if (g.stickyNoteHue !== undefined) this.settings.stickyNoteHue = g.stickyNoteHue;
                if (g.stickyNoteSaturation !== undefined) this.settings.stickyNoteSaturation = g.stickyNoteSaturation;
                if (g.stickyNoteLightness !== undefined) this.settings.stickyNoteLightness = g.stickyNoteLightness;
                this.settings.stickyNoteOverrides = { ...(g.stickyNoteOverrides || {}) };
                if (g.stickyNoteFontColorLight !== undefined) this.settings.stickyNoteFontColorLight = g.stickyNoteFontColorLight;
                if (g.stickyNoteFontColorDark !== undefined) this.settings.stickyNoteFontColorDark = g.stickyNoteFontColorDark;
            }
        }

        // Project UI theme (NL + ncanvas) — top-level plotlines.json field.
        // uiThemeVersion < 2 only stored a resolved light|dark (often default dark);
        // migrate those to auto so chrome follows Obsidian until the user overrides.
        const themeVersion = typeof plotlines.uiThemeVersion === 'number' ? plotlines.uiThemeVersion : 0;
        if (themeVersion >= 2 && (plotlines.uiTheme === 'light' || plotlines.uiTheme === 'dark' || plotlines.uiTheme === 'auto')) {
            this.settings.uiTheme = plotlines.uiTheme;
        } else if (themeVersion < 2 && (plotlines.uiTheme === 'light' || plotlines.uiTheme === 'dark')) {
            this.settings.uiTheme = 'auto';
        } else if (plotlines.uiTheme === 'auto') {
            this.settings.uiTheme = 'auto';
        } else {
            const legacy = isRecord(plotlines.projectColors)
                ? asRecord(plotlines.projectColors).uiTheme
                : undefined;
            if (legacy === 'auto') {
                this.settings.uiTheme = 'auto';
            } else if (legacy === 'light' || legacy === 'dark') {
                this.settings.uiTheme = themeVersion >= 2 ? legacy : 'auto';
            } else {
                this.settings.uiTheme = this._globalColorDefaults.uiTheme ?? 'auto';
            }
        }
        this.applyUiTheme();
        (window as unknown as {
            NarrativeCanvasApp?: { setTheme?: (t: 'light' | 'dark', o?: { force?: boolean; fromHost?: boolean }) => unknown };
        }).NarrativeCanvasApp?.setTheme?.(this.getEffectiveUiTheme(), { force: true, fromHost: true });

        this.settings.characterAliases = isRecord(characters.characterAliases)
            ? (characters.characterAliases as Record<string, string>)
            : {};
        if (Array.isArray(characters.ignoredCharacters)) {
            this.settings.ignoredCharacters = characters.ignoredCharacters as string[];
        } else {
            this.settings.ignoredCharacters = [];
        }

        // Always replace the in-memory ledger. Skipping this when a project
        // has no stats.json would keep the previous book's daily totals.
        this.writingTracker.importData(
            isRecord(stats.writingTrackerData)
                ? stats.writingTrackerData as unknown as Parameters<typeof this.writingTracker.importData>[0]
                : undefined,
        );

        // Persist migrated / folder-adopted Library categories immediately so
        // the next project switch cannot fall back to the shared legacy seed.
        const activeProject = this.sceneManager?.activeProject;
        if (libraryCategoriesDirty && activeProject) {
            const catPath = normalizePath(`${this.getProjectSystemFolder()}/${LIBRARY_CATEGORIES_FILENAME}`);
            if (!this._invalidSystemJsonPaths.has(catPath)) {
                await this.writeSystemJson(
                    LIBRARY_CATEGORIES_FILENAME,
                    readLibraryCategorySettings(this.settings) as unknown as Record<string, unknown>,
                );
            }
            if (activeProject.libraryFolders) {
                await this.sceneManager.saveProjectFrontmatter(activeProject).catch(() => undefined);
            }
        }
        if (profileLayoutDirty && activeProject) {
            await this.writeSystemJson(
                LIBRARY_PROFILE_LAYOUT_FILENAME,
                {
                    version: 1,
                    ...readLibraryProfileLayout(this.settings),
                } as unknown as Record<string, unknown>,
            );
        }

        // System files are now the source of truth
        this._systemMigrationDone = true;
    }

    /**
     * Apply Library folder↔category↔Base rules to every known project.
     * Restores the previously active project's settings into memory afterward.
     */
    async reconcileLibraryCategoriesForAllProjects(): Promise<void> {
        const sm = this.sceneManager;
        if (!sm) return;
        const previous = sm.activeProject;
        const previousSettings = readLibraryCategorySettings(this.settings);
        const initProjectCategoryManager = () => {
            const customDefs = (this.settings.codexCustomCategories || []).map(
                (cc: { id: string; label: string; icon: string }) =>
                    makeProfileCodexCategory(cc.id, cc.label, cc.icon),
            );
            this.codexManager.initCategories(this.settings.codexEnabledCategories || [], customDefs);
            applyCategoryFolderLabels(this);
        };
        try {
            for (const project of sm.getProjects()) {
                await sm.withActiveProject(project, async () => {
                    const raw = await this.readSystemJson(LIBRARY_CATEGORIES_FILENAME);
                    const stored = libraryCategorySettingsFromUnknown(raw);
                    if (stored) {
                        applyLibraryCategorySettings(this, stored);
                    } else {
                        applyLibraryCategorySettings(this, {
                            enabledCategories: [...this._legacyLibraryCategoryDefaults.enabledCategories],
                            customCategories: this._legacyLibraryCategoryDefaults.customCategories.map(c => ({ ...c })),
                            categoryOrder: [...this._legacyLibraryCategoryDefaults.categoryOrder],
                            hiddenFixedCategories: [...this._legacyLibraryCategoryDefaults.hiddenFixedCategories],
                            deletedPresetCategories: [...this._legacyLibraryCategoryDefaults.deletedPresetCategories],
                            presetSeedVersion: this._legacyLibraryCategoryDefaults.presetSeedVersion || 0,
                        });
                    }
                    const presetsSeeded = seedStorylinePresetCategories(this);
                    // Base aliases and orphan detection must use this project's
                    // category definitions, not the previously active project.
                    initProjectCategoryManager();
                    await reconcileLibraryCategoriesForActiveProject(
                        this,
                        (presetsSeeded || !stored) ? { createMissingRegistered: true } : {},
                    );
                    const catPath = normalizePath(`${this.getProjectSystemFolder()}/${LIBRARY_CATEGORIES_FILENAME}`);
                    if (!this._invalidSystemJsonPaths.has(catPath)) {
                        await this.writeSystemJson(
                            LIBRARY_CATEGORIES_FILENAME,
                            readLibraryCategorySettings(this.settings) as unknown as Record<string, unknown>,
                        );
                    }
                    if (project.libraryFolders) {
                        await sm.saveProjectFrontmatter(project).catch(() => undefined);
                    }
                });
            }
        } catch (error) {
            console.warn('[NarrativeLab] reconcileLibraryCategoriesForAllProjects:', error);
        } finally {
            if (previous) {
                await sm.withActiveProject(previous, async () => {
                    const raw = await this.readSystemJson(LIBRARY_CATEGORIES_FILENAME);
                    const stored = libraryCategorySettingsFromUnknown(raw);
                    applyLibraryCategorySettings(this, stored || previousSettings);
                    initProjectCategoryManager();
                    await syncAllNativeLibraryBases(this).catch(() => undefined);
                    this.libraryCategoriesStructureEpoch += 1;
                });
            } else {
                applyLibraryCategorySettings(this, previousSettings);
                initProjectCategoryManager();
            }
        }
    }

    /**
     * Save per-project data from in-memory settings to System/ files.
     * Called when settings are saved or before switching projects.
     */
    async saveProjectSystemData(): Promise<void> {
        if (this._loadingProjectSystemData) return;
        if (this._writingTrackerSaveTimer !== null) {
            window.clearTimeout(this._writingTrackerSaveTimer);
            this._writingTrackerSaveTimer = null;
        }
        const projectFilePath = this.sceneManager?.activeProject?.filePath
            ? normalizePath(this.sceneManager.activeProject.filePath)
            : '';
        if (!projectFilePath) return;
        const owner = this.plotlineRegistryOwner
            ? normalizePath(this.plotlineRegistryOwner)
            : '';
        if (owner && owner !== projectFilePath) return;

        // Snapshot payloads before any await so a project switch cannot mix
        // this project's plotlines into another project's System/ files.
        const plotlinesPayload: Record<string, unknown> = {
            tagColors: { ...(this.settings.tagColors || {}) },
            tagTypeOverrides: { ...(this.settings.tagTypeOverrides || {}) },
            uiTheme: this.settings.uiTheme === 'light' || this.settings.uiTheme === 'dark' || this.settings.uiTheme === 'auto'
                ? this.settings.uiTheme
                : 'auto',
            uiThemeVersion: 2,
            definitions: clonePlotlineDefinitions(this.plotlineDefinitions).map(d => ({
                id: d.id,
                label: d.label,
                scenePaths: d.scenePaths,
            })),
        };

        if (this.settings.useProjectColors) {
            plotlinesPayload.projectColors = {
                colorScheme: this.settings.colorScheme,
                plotlineHue: this.settings.plotlineHue,
                plotlineSaturation: this.settings.plotlineSaturation,
                plotlineLightness: this.settings.plotlineLightness,
                stickyNoteTheme: this.settings.stickyNoteTheme,
                stickyNoteHue: this.settings.stickyNoteHue,
                stickyNoteSaturation: this.settings.stickyNoteSaturation,
                stickyNoteLightness: this.settings.stickyNoteLightness,
                stickyNoteOverrides: { ...(this.settings.stickyNoteOverrides || {}) },
                stickyNoteFontColorLight: this.settings.stickyNoteFontColorLight ?? '',
                stickyNoteFontColorDark: this.settings.stickyNoteFontColorDark ?? '',
            };
        }

        const charactersPayload: Record<string, unknown> = {
            characterAliases: { ...(this.settings.characterAliases || {}) },
            ignoredCharacters: [...(this.settings.ignoredCharacters || [])],
        };
        const statsPayload: Record<string, unknown> = {
            writingTrackerData: this.writingTracker.exportData(),
        };
        const libraryCategoriesPayload = readLibraryCategorySettings(this.settings) as unknown as Record<string, unknown>;
        const libraryLayoutPayload = {
            version: 1,
            ...readLibraryProfileLayout(this.settings),
        } as unknown as Record<string, unknown>;

        if (!await this.projectExistsForWrite(projectFilePath)) return;

        await this.writeSystemJson('plotlines.json', plotlinesPayload, projectFilePath);
        await this.writeSystemJson('characters.json', charactersPayload, projectFilePath);
        await this.writeSystemJson('stats.json', statsPayload, projectFilePath);
        await this.writeSystemJson(LIBRARY_CATEGORIES_FILENAME, libraryCategoriesPayload, projectFilePath);
        await this.writeSystemJson(LIBRARY_PROFILE_LAYOUT_FILENAME, libraryLayoutPayload, projectFilePath);
    }

    /** Persist only the tracker ledger; safe to call frequently from edit autosave. */
    async saveWritingTrackerData(
        projectFilePath = this.sceneManager?.activeProject?.filePath,
        trackerData = this.writingTracker.exportData(),
    ): Promise<void> {
        const target = projectFilePath ? normalizePath(projectFilePath) : '';
        if (!target || this._loadingProjectSystemData) return;
        await this.writeSystemJson('stats.json', {
            writingTrackerData: trackerData,
        }, target);
    }

    /** Safely apply a dated statistical delta to one selected project ledger. */
    async applyWritingTrackerHistoryDelta(
        projectFilePath: string,
        history: Record<string, number>,
        revisionHistory: Record<string, number>,
        existingStats: Record<string, unknown>,
        storedTrackerData: WritingTrackerData,
    ): Promise<void> {
        const target = normalizePath(projectFilePath);
        const activeTarget = this.sceneManager.activeProject?.filePath
            ? normalizePath(this.sceneManager.activeProject.filePath)
            : '';
        if (activeTarget === target && this._writingTrackerSaveTimer !== null) {
            window.clearTimeout(this._writingTrackerSaveTimer);
            this._writingTrackerSaveTimer = null;
        }

        let payload = storedTrackerData;
        if (activeTarget === target) {
            const adjusted = new WritingTracker();
            adjusted.importData(this.writingTracker.exportData());
            adjusted.mergePersistedHistory(history, revisionHistory);
            payload = adjusted.exportData();
        }

        await this.writeSystemJson('stats.json', {
            ...existingStats,
            writingTrackerData: payload,
        }, target);

        // Do not change the live tracker until the safe project write succeeds.
        if (activeTarget === target) {
            this.writingTracker.mergePersistedHistory(history, revisionHistory);
        }
    }

    scheduleWritingTrackerSave(): void {
        if (this._writingTrackerProjectSwitching) return;
        const projectFilePath = this.sceneManager?.activeProject?.filePath
            ? normalizePath(this.sceneManager.activeProject.filePath)
            : '';
        if (!projectFilePath) return;
        const trackerData = this.writingTracker.exportData();
        if (this._writingTrackerSaveTimer !== null) window.clearTimeout(this._writingTrackerSaveTimer);
        this._writingTrackerSaveTimer = window.setTimeout(() => {
            this._writingTrackerSaveTimer = null;
            void this.saveWritingTrackerData(projectFilePath, trackerData);
        }, 800);
    }

    /**
     * Save the plot grid to Library/datasheet.xlsx (Excel/Univer-readable sheets)
     * plus System/datasheet.nlmeta.json (NarrativeLab links / ids).
     * Queued + retried so Windows file locks don't toast-spam during autosave.
     */
    async savePlotGrid(
        data: ConceptGridDocument | PlotGridData,
        options: {
            allowEmptyOverwrite?: boolean;
            fromLiveEditor?: boolean;
            projectFilePath?: string;
        } = {},
    ): Promise<boolean> {
        // Snapshot before the first await. Views keep mutating their live model;
        // queued saves must never drift into a later project or partial edit.
        const documentSnapshot = normalizeConceptGridDocument(data);
        const projectFilePath = normalizePath(
            options.projectFilePath || this.sceneManager.activeProject?.filePath || '',
        );
        if (!await this.projectExistsForWrite(projectFilePath)) return false;
        const baseFolder = normalizePath(deriveProjectFoldersFromFilePath(projectFilePath).baseFolder);
        const libraryFolder = normalizePath(`${baseFolder}/Library`);
        const systemFolder = normalizePath(`${baseFolder}/System`);
        const filePath = normalizePath(plotGridXlsxPath(baseFolder));
        const writeOptions = {
            allowEmptyOverwrite: options.allowEmptyOverwrite,
            fromLiveEditor: options.fromLiveEditor,
        };
        const previous = this._systemJsonWriteQueues.get(filePath) ?? Promise.resolve();
        let saved = false;
        const pending = previous
            .catch(() => undefined)
            .then(async () => {
                saved = await this.savePlotGridSafely(
                    documentSnapshot,
                    writeOptions,
                    baseFolder,
                    libraryFolder,
                    systemFolder,
                    filePath,
                    projectFilePath,
                );
            });
        this._systemJsonWriteQueues.set(filePath, pending);
        try {
            await pending;
        } catch (e) {
            console.error('[NarrativeLab] savePlotGrid:', e);
            throw e;
        } finally {
            if (this._systemJsonWriteQueues.get(filePath) === pending) {
                this._systemJsonWriteQueues.delete(filePath);
            }
        }
        return saved;
    }

    private async writePlotGridPairResilient(
        xlsxPath: string,
        binary: ArrayBuffer,
        metaPath: string,
        metaJson: string,
        previousXlsxDigest: string | null,
    ): Promise<void> {
        const meta = tryParseNlMeta(metaJson);
        if (!meta) throw new Error('Refusing to write invalid Plot Grid metadata.');
        const journalPath = plotGridWriteJournalPath(metaPath);
        const journal: PlotGridWriteJournal = {
            schema: 1,
            previousXlsxDigest,
            nextXlsxDigest: plotGridBinaryDigest(binary),
            meta,
        };
        await this.writeVaultTextResilient(journalPath, `${JSON.stringify(journal)}\n`);
        await this.writeVaultBinaryResilient(xlsxPath, binary);
        await this.writeVaultTextResilient(metaPath, metaJson);
        await this.app.vault.adapter.remove(journalPath).catch(() => undefined);
    }

    /** Complete or preserve a save interrupted between xlsx and sidecar promotion. */
    private async recoverPlotGridWriteJournal(xlsxPath: string, metaPath: string): Promise<boolean> {
        const adapter = this.app.vault.adapter;
        const journalPath = plotGridWriteJournalPath(metaPath);
        await this.recoverVaultSwapBackup(xlsxPath);
        await this.recoverVaultSwapBackup(metaPath);
        await this.recoverVaultSwapBackup(journalPath);
        if (!await adapter.exists(journalPath)) return true;
        let journal: PlotGridWriteJournal | null = null;
        try {
            const parsed = JSON.parse(await adapter.read(journalPath)) as Partial<PlotGridWriteJournal>;
            const meta = parsed.meta && typeof parsed.meta === 'object'
                ? parsed.meta as PlotGridNlMeta
                : null;
            if (parsed.schema === 1
                && typeof parsed.nextXlsxDigest === 'string'
                && (typeof parsed.previousXlsxDigest === 'string' || parsed.previousXlsxDigest === null)
                && meta) {
                journal = {
                    schema: 1,
                    previousXlsxDigest: parsed.previousXlsxDigest,
                    nextXlsxDigest: parsed.nextXlsxDigest,
                    meta,
                };
            }
        } catch { /* preserve below */ }

        if (!journal) {
            const preserved = `${journalPath}.invalid-${Date.now()}.json`;
            await adapter.rename(journalPath, preserved).catch(() => undefined);
            console.warn('[NarrativeLab] Preserved an invalid Plot Grid write journal:', preserved);
            return true;
        }

        const exists = await adapter.exists(xlsxPath);
        const currentBinary = exists ? await adapter.readBinary(xlsxPath) : null;
        const currentDigest = currentBinary ? plotGridBinaryDigest(currentBinary) : null;
        const metaJson = `${JSON.stringify(journal.meta, null, 2)}\n`;
        if (currentDigest === journal.nextXlsxDigest) {
            await this.writeVaultTextResilient(metaPath, metaJson);
            await adapter.remove(journalPath).catch(() => undefined);
            return true;
        }
        if (currentDigest === journal.previousXlsxDigest) {
            const recovered = documentFromNlMeta(journal.meta);
            const binary = await encodePlotGridXlsx(recovered, { vaultName: this.app.vault.getName() });
            await this.writeVaultBinaryResilient(xlsxPath, binary);
            await this.writeVaultTextResilient(metaPath, metaJson);
            await adapter.remove(journalPath).catch(() => undefined);
            console.warn('[NarrativeLab] Recovered an interrupted Plot Grid save from its journal.');
            return true;
        }

        const preserved = `${journalPath}.conflict-${Date.now()}.json`;
        await adapter.rename(journalPath, preserved);
        new Notice(t('Spreadsheet recovery snapshot was preserved because datasheet.xlsx changed externally.'));
        return true;
    }

    private async savePlotGridSafely(
        data: ConceptGridDocument | PlotGridData,
        options: { allowEmptyOverwrite?: boolean; fromLiveEditor?: boolean },
        baseFolder: string,
        libraryFolder: string,
        systemFolder: string,
        filePath: string,
        projectFilePath: string,
    ): Promise<boolean> {
        if (!await this.projectExistsForWrite(projectFilePath)) return false;
        const adapter = this.app.vault.adapter;
        const document = normalizeConceptGridDocument(data);
        const path = normalizePath(filePath);
        const metaPath = normalizePath(plotGridNlMetaPath(systemFolder));
        const explicitPageRemoval = new Set(document.explicitlyRemovedPageIds || []);
        await this.recoverPlotGridWriteJournal(path, metaPath);
        const existed = await adapter.exists(path);
        let currentBinary: ArrayBuffer | null;
        let currentMetaText: string;
        try {
            currentBinary = existed ? await adapter.readBinary(path) : null;
            currentMetaText = await adapter.exists(metaPath)
                ? await adapter.read(metaPath)
                : '';
        } catch (error) {
            const recoveryPath = await this.preserveRejectedPlotGridSnapshot(
                document,
                systemFolder,
                projectFilePath,
                'canonical-unavailable',
            );
            console.warn('[NarrativeLab] Skipping datasheet write — canonical files could not be checked safely.', error);
            this.reportRejectedPlotGridSave('canonical-unavailable', projectFilePath, recoveryPath);
            return false;
        }

        // Never clobber an existing workbook with an empty in-memory model.
        // Autosave / tab-close / project-switch persist used to write a default
        // empty grid over a real datasheet (Evomon 1.2.0). Reset Grid is the
        // only explicit empty overwrite.
        if (shouldRefuseEmptyPlotGridWrite(document, {
            allowEmptyOverwrite: options.allowEmptyOverwrite || explicitPageRemoval.size > 0,
            fromLiveEditor: options.fromLiveEditor,
            existed,
        })) {
            // A rejected placeholder is an expected lifecycle race, not a user
            // action item. Keep the canonical workbook completely silently;
            // genuine read/conflict failures have actionable recovery notices.
            return false;
        }
        const cached = this.lookupPlotGridDocCache({ projectFile: projectFilePath, xlsxPath: path });
        const canonicalChangedExternally = Boolean(
            cached
            && cached.xlsxPath === path
            && cached.xlsxDigest
            && currentBinary
            && (
                cached.xlsxDigest !== plotGridBinaryDigest(currentBinary)
                || cached.metaDigest !== plotGridTextDigest(currentMetaText)
            )
        );
        if (canonicalChangedExternally && !options.allowEmptyOverwrite) {
            const recoveryPath = await this.preserveRejectedPlotGridSnapshot(
                document,
                systemFolder,
                projectFilePath,
                'external-change',
            );
            console.warn('[NarrativeLab] Skipping datasheet write — canonical files changed outside this editor.', recoveryPath);
            this.reportRejectedPlotGridSave('external-change', projectFilePath, recoveryPath);
            return false;
        }
        if (
            cached
            && cached.xlsxPath === path
            && !options.allowEmptyOverwrite
            && isIncompleteConceptGridPull(cached.doc, document)
        ) {
            const recoveryPath = await this.preserveRejectedPlotGridSnapshot(
                document,
                systemFolder,
                projectFilePath,
                'incomplete-snapshot',
            );
            console.warn('[NarrativeLab] Skipping datasheet write — snapshot is missing persisted sheets or axes.', recoveryPath);
            this.reportRejectedPlotGridSave('incomplete-snapshot', projectFilePath, recoveryPath);
            return false;
        }
        const documentToPersist = structuredClone(document);
        delete documentToPersist.explicitlyRemovedPageIds;
        delete documentToPersist.explicitlyRemovedRowIds;
        delete documentToPersist.explicitlyRemovedColumnIds;
        const deletesPersistedPage = explicitPageRemoval.size > 0
            && (!cached || cached.doc.pages.some(page => explicitPageRemoval.has(page.id)));

        // Destructive reset is recoverable even when the original workbook was healthy.
        if (deletesPersistedPage && (existed || await adapter.exists(metaPath))) {
            if (existed) await this.backupPlotGridFile(path, 'before-sheet-delete');
            if (await adapter.exists(metaPath)) {
                await this.backupPlotGridFile(metaPath, 'before-sheet-delete');
            }
        } else if (options.allowEmptyOverwrite && (existed || await adapter.exists(metaPath))) {
            if (existed) await this.backupPlotGridFile(path, 'before-reset');
            if (await adapter.exists(metaPath)) {
                await this.backupPlotGridFile(metaPath, 'before-reset');
            }
        } else if (existed && this._invalidPlotGridXlsxPaths.has(path)) {
            // Non-empty recovery write after corrupt load: keep a corrupt bak once.
            if (!await this.backupCorruptPlotGridXlsx(path)) {
                throw new Error('Could not preserve unreadable datasheet.xlsx before recovery write.');
            }
        }

        // Sidecar-only UI state (active sheet/sidebar/zoom/resources) must not
        // rebuild the workbook. Reuse the exact Excel bytes so externally
        // authored styles and workbook features remain untouched.
        const workbookContentUnchanged = Boolean(
            currentBinary
            && cached
            && cached.xlsxPath === path
            && !options.allowEmptyOverwrite
            && !deletesPersistedPage
            && plotGridWorkbookContentFingerprint(cached.doc)
                === plotGridWorkbookContentFingerprint(documentToPersist),
        );
        // Clean xlsx (no embedded meta) so Excel/Univer only see page sheets.
        const binary = workbookContentUnchanged
            ? currentBinary!
            : await encodePlotGridXlsx(documentToPersist, { vaultName: this.app.vault.getName() });
        const metaJson = serializePlotGridNlMeta(documentToPersist);
        const previousXlsxDigest = currentBinary
            ? plotGridBinaryDigest(currentBinary)
            : null;
        if (!await this.projectExistsForWrite(projectFilePath)) return false;
        await this.ensureVaultFolder(libraryFolder);
        await this.ensureVaultFolder(systemFolder);
        let latestBinary: ArrayBuffer | null;
        let latestMetaText: string;
        try {
            latestBinary = await adapter.exists(path) ? await adapter.readBinary(path) : null;
            latestMetaText = await adapter.exists(metaPath) ? await adapter.read(metaPath) : '';
        } catch (error) {
            const recoveryPath = await this.preserveRejectedPlotGridSnapshot(
                document,
                systemFolder,
                projectFilePath,
                'canonical-unavailable',
            );
            console.warn('[NarrativeLab] Skipping datasheet write — canonical files became unavailable before commit.', error);
            this.reportRejectedPlotGridSave('canonical-unavailable', projectFilePath, recoveryPath);
            return false;
        }
        const canonicalChangedBeforeCommit = (
            Boolean(latestBinary) !== Boolean(currentBinary)
            || Boolean(latestBinary && currentBinary
                && plotGridBinaryDigest(latestBinary) !== plotGridBinaryDigest(currentBinary))
            || plotGridTextDigest(latestMetaText) !== plotGridTextDigest(currentMetaText)
        );
        if (canonicalChangedBeforeCommit) {
            const recoveryPath = await this.preserveRejectedPlotGridSnapshot(
                document,
                systemFolder,
                projectFilePath,
                'external-change',
            );
            console.warn('[NarrativeLab] Skipping datasheet write — canonical files changed before commit.', recoveryPath);
            this.reportRejectedPlotGridSave('external-change', projectFilePath, recoveryPath);
            return false;
        }
        const endSuppressXlsx = this.beginSuppressVaultRefresh(path, 2500);
        const endSuppressMeta = this.beginSuppressVaultRefresh(metaPath, 2500);
        try {
            await this.writePlotGridPairResilient(
                path,
                binary,
                metaPath,
                metaJson,
                previousXlsxDigest,
            );
        } finally {
            endSuppressXlsx();
            endSuppressMeta();
        }
        this._invalidPlotGridXlsxPaths.delete(path);
        this._reportedInvalidPlotGridXlsxPaths.delete(path);
        this.rememberPlotGridDocCache(
            projectFilePath,
            path,
            documentToPersist,
            await adapter.stat(path).catch(() => null),
            { xlsx: binary, metaText: metaJson },
        );
        this.invalidatePlotGridScanCache();
        void this.cleanupLegacyPlotGridArtifacts(baseFolder, systemFolder).catch(() => undefined);
        return true;
    }

    /**
     * Ensure every Library custom field also exists as an individual top-level
     * YAML property. Nested `custom` data remains in place for compatibility.
     */
    async syncCustomFieldFrontmatter(categoryFilter?: string, force = false): Promise<number> {
        const projectPath = normalizePath(this.sceneManager?.activeProject?.filePath || '');
        if (!projectPath) return 0;
        if (!categoryFilter && !force && this.customFieldFrontmatterSyncedProjects.has(projectPath)) return 0;

        const targets = new Map<string, { file: TFile; categoryKey: string }>();
        const add = (filePath: string, categoryKey: string, custom?: Record<string, string>): void => {
            const matches = !categoryFilter
                || categoryFilter === categoryKey
                || (categoryFilter === 'location' && (categoryKey === 'world' || categoryKey === 'location'));
            if (!matches) return;
            const normalized = normalizePath(filePath);
            const file = this.app.vault.getAbstractFileByPath(normalized);
            if (!(file instanceof TFile) || file.extension !== 'md') return;
            const configured = this.resolveLibraryProfilePropertyOrder(categoryKey)?.customKeys ?? [];
            if (configured.length === 0 && Object.keys(custom ?? {}).length === 0) return;
            targets.set(normalized, { file, categoryKey });
        };
        for (const character of this.characterManager?.getAllCharacters() ?? []) {
            add(character.filePath, 'character', character.custom);
        }
        for (const world of this.locationManager?.getAllWorlds() ?? []) {
            add(world.filePath, 'world', world.custom);
        }
        for (const location of this.locationManager?.getAllLocations() ?? []) {
            add(location.filePath, 'location', location.custom);
        }
        for (const entry of this.codexManager?.getAllEntries() ?? []) {
            add(entry.filePath, entry.type, entry.custom);
        }

        let touched = 0;
        for (const { file, categoryKey } of targets.values()) {
            try {
                const didChange = await this.processReadableFrontmatter(file, fm => {
                    const meaningfulLeafCount = (value: unknown): number => {
                        if (value === undefined || value === null || value === '') return 0;
                        if (Array.isArray(value)) {
                            return value.reduce<number>((sum, item) => sum + meaningfulLeafCount(item), 0);
                        }
                        if (typeof value === 'object') {
                            return Object.values(value as Record<string, unknown>)
                                .reduce<number>((sum, item) => sum + meaningfulLeafCount(item), 0);
                        }
                        return 1;
                    };
                    const meaningfulBefore = meaningfulLeafCount(fm);
                    const previous = fm.custom && typeof fm.custom === 'object' && !Array.isArray(fm.custom)
                        ? fm.custom as Record<string, string>
                        : undefined;
                    const hydrated = hydrateCustomFieldsFromTopLevel(
                        fm,
                        // This is a disk migration, not an editor save. The
                        // manager snapshot may predate an external restore or
                        // Base edit, so only the current file is authoritative.
                        previous,
                        categoryKey,
                    );
                    if (hydrated && Object.keys(hydrated).length > 0) fm.custom = hydrated;
                    mirrorCustomFieldsToTopLevel(fm, hydrated, categoryKey, previous);
                    const ordered = orderLibraryEntityFrontmatter(fm, categoryKey);
                    if (meaningfulLeafCount(ordered) < meaningfulBefore) {
                        throw new Error(`Custom-field sync would discard populated YAML; refusing overwrite: ${file.path}`);
                    }
                    for (const key of Object.keys(fm)) delete fm[key];
                    Object.assign(fm, ordered);
                });
                if (didChange) touched++;
            } catch (error) {
                console.error('[NarrativeLab] syncCustomFieldFrontmatter:', file.path, error);
            }
        }
        if (!categoryFilter) this.customFieldFrontmatterSyncedProjects.add(projectPath);
        if (touched > 0 || categoryFilter) await syncAllNativeLibraryBases(this).catch(() => undefined);
        return touched;
    }

    /**
     * Preserve an editor snapshot that is unsafe to promote to the canonical workbook.
     * The recovery pair lives outside Library so it cannot be mistaken for the live
     * datasheet by NarrativeLab or another spreadsheet plugin.
     */
    private async preserveRejectedPlotGridSnapshot(
        document: ConceptGridDocument,
        systemFolder: string,
        projectFilePath: string,
        reason: 'canonical-unavailable' | 'external-change' | 'incomplete-snapshot',
    ): Promise<string> {
        const recoveryDocument = structuredClone(normalizeConceptGridDocument(document));
        delete recoveryDocument.explicitlyRemovedPageIds;
        delete recoveryDocument.explicitlyRemovedRowIds;
        delete recoveryDocument.explicitlyRemovedColumnIds;
        const metaJson = serializePlotGridNlMeta(recoveryDocument);
        const recoveryKey = `${normalizePath(projectFilePath)}|${reason}|${plotGridTextDigest(metaJson)}`;
        const recoveryFolder = normalizePath(`${systemFolder}/Spreadsheet Recovery`);
        const existingRecoveryPath = this._preservedPlotGridRecoveryPaths.get(recoveryKey);
        if (existingRecoveryPath) return existingRecoveryPath;

        await this.ensureVaultFolder(recoveryFolder);
        const binary = await encodePlotGridXlsx(recoveryDocument, { vaultName: this.app.vault.getName() });
        const stamp = new Date().toISOString().replace(/[:.]/g, '-');
        const baseName = `datasheet-${reason}-${stamp}`;
        const xlsxPath = normalizePath(`${recoveryFolder}/${baseName}.xlsx`);
        const metaPath = normalizePath(`${recoveryFolder}/${baseName}.nlmeta.json`);
        await this.writeVaultBinaryResilient(xlsxPath, binary);
        await this.writeVaultTextResilient(metaPath, metaJson);
        this._preservedPlotGridRecoveryPaths.set(recoveryKey, xlsxPath);
        return xlsxPath;
    }

    private reportRejectedPlotGridSave(
        reason: 'canonical-unavailable' | 'external-change' | 'incomplete-snapshot',
        projectFilePath: string,
        recoveryPath: string,
    ): void {
        const noticeKey = `${normalizePath(projectFilePath)}|${reason}`;
        if (this._reportedPlotGridRecoveryNotices.has(noticeKey)) return;
        this._reportedPlotGridRecoveryNotices.add(noticeKey);
        const message = reason === 'external-change'
            ? 'Spreadsheet changed outside NarrativeLab. The canonical file was kept and this editor snapshot was saved to {path}.'
            : reason === 'incomplete-snapshot'
                ? 'Incomplete spreadsheet save was blocked. The canonical file was kept and this editor snapshot was saved to {path}.'
                : 'Spreadsheet could not be checked safely. The canonical file was kept and this editor snapshot was saved to {path}.';
        new Notice(t(message, { path: recoveryPath }), 10_000);
    }

    private async backupPlotGridFile(filePath: string, label: string): Promise<string | null> {
        const adapter = this.app.vault.adapter;
        const path = normalizePath(filePath);
        if (!await adapter.exists(path)) return null;
        const bin = await adapter.readBinary(path);
        const stamp = new Date().toISOString().replace(/[:.]/g, '-');
        const baseBackupPath = `${path}.${label}-${stamp}`;
        let backupPath = `${baseBackupPath}.bak`;
        for (let suffix = 1; await adapter.exists(backupPath); suffix += 1) {
            backupPath = `${baseBackupPath}-${suffix}.bak`;
        }
        await adapter.writeBinary(backupPath, bin);
        return backupPath;
    }

    private async backupCorruptPlotGridXlsx(filePath: string): Promise<boolean> {
        try {
            await this.backupPlotGridFile(filePath, 'corrupt');
            return true;
        } catch (e) {
            console.warn('[NarrativeLab] Failed to backup corrupt datasheet.xlsx:', e);
            return false;
        }
    }

    /** Remove only disposable temp artifacts. Legacy workbooks may contain unique recovery data. */
    private async cleanupLegacyPlotGridArtifacts(baseFolder: string, systemFolder: string): Promise<void> {
        const adapter = this.app.vault.adapter;
        const gridFolder = normalizePath(plotGridFolderPath(systemFolder));
        const canonicalXlsx = normalizePath(plotGridXlsxPath(baseFolder));
        if (!await adapter.exists(canonicalXlsx)) return;
        if (!await adapter.exists(gridFolder)) return;
        try {
            const listing = await adapter.list(gridFolder);
            for (const filePath of listing.files || []) {
                const name = (filePath.split('/').pop() || '');
                const lower = name.toLowerCase();
                // Delete only interrupted-write temp files. Retain every workbook,
                // index and CSV because any of them may be the last recovery copy.
                const isKnown =
                    lower === `${PLOTGRID_XLSX_LEGACY_FILENAME}.tmp`
                    || (lower.startsWith(`${PLOTGRID_XLSX_PREFIX}-`) && lower.endsWith('.xlsx.tmp'))
                    || lower === `${LEGACY_PLOTGRID_XLSX_FILENAME}.tmp`
                    || lower === '_index.json.tmp';
                if (!isKnown) continue;
                try { await adapter.remove(filePath); } catch { /* ignore */ }
            }
            // Remove empty PlotGrid folder when possible
            const after = await adapter.list(gridFolder);
            const leftover = [...(after.files || []), ...(after.folders || [])];
            if (leftover.length === 0) {
                try { await adapter.rmdir(gridFolder, false); } catch { /* ignore */ }
            }
        } catch { /* ignore */ }
    }

    /**
     * Write text via temp file with short retries for Windows UNKNOWN/EBUSY locks.
     * Kept for System/*.json writers; datasheet canonical path uses the binary twin.
     */
    private async recoverVaultSwapBackup(path: string): Promise<void> {
        const adapter = this.app.vault.adapter;
        const backupPath = `${path}.swap-backup`;
        const pathExists = await adapter.exists(path);
        const backupExists = await adapter.exists(backupPath);
        if (!pathExists && backupExists) {
            await adapter.rename(backupPath, path);
        } else if (pathExists && backupExists) {
            await adapter.remove(backupPath);
        }
    }

    private async promoteVaultTempFile(path: string, tempPath: string): Promise<void> {
        const adapter = this.app.vault.adapter;
        const backupPath = `${path}.swap-backup`;
        // Recover an interrupted previous promotion before starting another.
        await this.recoverVaultSwapBackup(path);

        const hadOriginal = await adapter.exists(path);
        if (hadOriginal) await adapter.rename(path, backupPath);
        try {
            await adapter.rename(tempPath, path);
        } catch (error) {
            if (!await adapter.exists(path) && await adapter.exists(backupPath)) {
                await adapter.rename(backupPath, path).catch(() => undefined);
            }
            throw error;
        }
        if (await adapter.exists(backupPath)) {
            await adapter.remove(backupPath).catch(() => undefined);
        }
    }

    async writeVaultTextResilient(filePath: string, contents: string): Promise<void> {
        const adapter = this.app.vault.adapter;
        const path = normalizePath(filePath);
        const tempPath = `${path}.tmp`;
        let lastError: unknown;
        for (let attempt = 0; attempt < 5; attempt++) {
            try {
                await adapter.write(tempPath, contents);
                await this.promoteVaultTempFile(path, tempPath);
                return;
            } catch (error) {
                lastError = error;
                await adapter.remove(tempPath).catch(() => undefined);
                if (!isTransientVaultIoError(error) || attempt === 4) break;
                await waitForVaultRetry(40 * (attempt + 1) * (attempt + 1));
            }
        }
        throw lastError instanceof Error ? lastError : new Error(String(lastError));
    }

    /** Binary twin of writeVaultTextResilient (datasheet.xlsx). */
    private async writeVaultBinaryResilient(filePath: string, data: ArrayBuffer): Promise<void> {
        const adapter = this.app.vault.adapter;
        const path = normalizePath(filePath);
        const tempPath = `${path}.tmp`;
        let lastError: unknown;
        for (let attempt = 0; attempt < 5; attempt++) {
            try {
                await adapter.writeBinary(tempPath, data);
                await this.promoteVaultTempFile(path, tempPath);
                return;
            } catch (error) {
                lastError = error;
                await adapter.remove(tempPath).catch(() => undefined);
                if (!isTransientVaultIoError(error) || attempt === 4) break;
                await waitForVaultRetry(40 * (attempt + 1) * (attempt + 1));
            }
        }
        throw lastError instanceof Error ? lastError : new Error(String(lastError));
    }

    /**
     * Migrate plot grid xlsx into per-project Library/datasheet-<projectName>.xlsx
     * without opening the grid.
     * Safe to call on project switch so every project migrates even if Concept Grid stays closed.
     */
    async migratePlotGridToLibraryIfNeeded(projectFilePath?: string): Promise<void> {
        try {
            const targetProjectFile = normalizePath(
                projectFilePath || this.sceneManager.activeProject?.filePath || '',
            );
            if (!await this.projectExistsForWrite(targetProjectFile)) return;
            const baseFolder = normalizePath(
                deriveProjectFoldersFromFilePath(targetProjectFile).baseFolder,
            );
            if (!baseFolder) return;
            const libraryFolder = normalizePath(`${baseFolder}/Library`);
            const systemFolder = normalizePath(`${baseFolder}/System`);
            const adapter = this.app.vault.adapter;
            const canonical = normalizePath(plotGridXlsxPath(baseFolder));
            const legacyLibraryXlsx = normalizePath(legacyPlotGridXlsxPath(baseFolder));
            if (await adapter.exists(canonical)) {
                // Do not delete legacy recovery copies until the canonical file
                // has been decoded successfully by loadPlotGrid().
                return;
            }
            if (await adapter.exists(legacyLibraryXlsx)) {
                try {
                    const bin = await adapter.readBinary(legacyLibraryXlsx);
                    await this.ensureVaultFolder(libraryFolder);
                    await this.writeVaultBinaryResilient(canonical, bin);
                    const promoted = await adapter.readBinary(canonical);
                    if (plotGridBinaryDigest(promoted) !== plotGridBinaryDigest(bin)) {
                        throw new Error('Migrated datasheet verification failed.');
                    }
                    try { await adapter.remove(legacyLibraryXlsx); } catch { /* keep if remove fails */ }
                    void this.cleanupLegacyPlotGridArtifacts(baseFolder, systemFolder).catch(() => undefined);
                    return;
                } catch (e) {
                    console.warn('[NarrativeLab] datasheet rename migrate failed:', legacyLibraryXlsx, e);
                }
            }
            const candidates = [
                normalizePath(legacySystemPlotGridXlsxPath(systemFolder)),
                normalizePath(legacyPlotGridFolderXlsxPath(systemFolder)),
            ];
            for (const legacyPath of candidates) {
                if (legacyPath === canonical || !await adapter.exists(legacyPath)) continue;
                try {
                    const bin = await adapter.readBinary(legacyPath);
                    await this.ensureVaultFolder(libraryFolder);
                    await this.writeVaultBinaryResilient(canonical, bin);
                    const promoted = await adapter.readBinary(canonical);
                    if (plotGridBinaryDigest(promoted) !== plotGridBinaryDigest(bin)) {
                        throw new Error('Migrated datasheet verification failed.');
                    }
                    try { await adapter.remove(legacyPath); } catch { /* keep if remove fails */ }
                    void this.cleanupLegacyPlotGridArtifacts(baseFolder, systemFolder).catch(() => undefined);
                    return;
                } catch (e) {
                    console.warn('[NarrativeLab] datasheet migrate failed:', legacyPath, e);
                }
            }
        } catch (e) {
            console.warn('[NarrativeLab] migratePlotGridToLibraryIfNeeded:', e);
        }
    }

    /**
     * Load the concept/plot grid document from Library/datasheet.xlsx
     * (+ System/datasheet.nlmeta.json). Migrates legacy System plotgrid files,
     * Library/datasheet.nlmeta.json, and embedded `_nl_meta` sheets.
     */
    async loadPlotGrid(projectFilePath?: string): Promise<ConceptGridDocument | null> {
        const targetProjectFile = normalizePath(
            projectFilePath || this.sceneManager.activeProject?.filePath || '',
        );
        if (!await this.projectExistsForWrite(targetProjectFile)) return null;
        await this.migratePlotGridToLibraryIfNeeded(targetProjectFile);
        try {
            const baseFolder = normalizePath(
                deriveProjectFoldersFromFilePath(targetProjectFile).baseFolder,
            );
            const libraryFolder = normalizePath(`${baseFolder}/Library`);
            const systemFolder = normalizePath(`${baseFolder}/System`);
            const adapter = this.app.vault.adapter;
            const xlsxPath = normalizePath(plotGridXlsxPath(baseFolder));
            const metaPath = normalizePath(plotGridNlMetaPath(systemFolder));
            const pendingWrite = this._systemJsonWriteQueues.get(xlsxPath);
            if (pendingWrite) await pendingWrite.catch(() => undefined);
            await this.recoverPlotGridWriteJournal(xlsxPath, metaPath);
            let preloadedBinary: ArrayBuffer | null = null;
            let preloadedMetaText: string | null = null;
            const cached = this.lookupPlotGridDocCache({ projectFile: targetProjectFile, xlsxPath });
            if (
                cached
                && cached.projectFile === targetProjectFile
                && cached.xlsxPath === xlsxPath
                && await adapter.exists(xlsxPath)
            ) {
                const stat = await adapter.stat(xlsxPath);
                if (stat && stat.mtime === cached.mtime && stat.size === cached.size) {
                    preloadedBinary = await adapter.readBinary(xlsxPath);
                    preloadedMetaText = await adapter.exists(metaPath)
                        ? await adapter.read(metaPath)
                        : '';
                    if (cached.xlsxDigest === plotGridBinaryDigest(preloadedBinary)
                        && cached.metaDigest === plotGridTextDigest(preloadedMetaText)) {
                        return structuredClone(cached.doc);
                    }
                }
            }
            const legacyLibraryMetaPath = normalizePath(legacyLibraryPlotGridNlMetaPath(baseFolder));
            const legacyLibraryXlsxPath = normalizePath(legacyPlotGridXlsxPath(baseFolder));
            const legacySystemXlsxPath = normalizePath(legacySystemPlotGridXlsxPath(systemFolder));
            const folderXlsxPath = normalizePath(legacyPlotGridFolderXlsxPath(systemFolder));
            const jsonPath = normalizePath(`${systemFolder}/plotgrid.json`);

            const settleCanonical = async (doc: ConceptGridDocument) => {
                await this.ensureVaultFolder(libraryFolder);
                await this.ensureVaultFolder(systemFolder);
                const binary = await encodePlotGridXlsx(doc, { vaultName: this.app.vault.getName() });
                const metaJson = serializePlotGridNlMeta(doc);
                const previousXlsxDigest = await adapter.exists(xlsxPath)
                    ? plotGridBinaryDigest(await adapter.readBinary(xlsxPath))
                    : null;
                const endXlsx = this.beginSuppressVaultRefresh(xlsxPath);
                const endMeta = this.beginSuppressVaultRefresh(metaPath);
                try {
                    await this.writePlotGridPairResilient(
                        xlsxPath,
                        binary,
                        metaPath,
                        metaJson,
                        previousXlsxDigest,
                    );
                } finally {
                    endXlsx();
                    endMeta();
                }
                if (legacyLibraryMetaPath !== metaPath && await adapter.exists(legacyLibraryMetaPath)) {
                    try { await adapter.remove(legacyLibraryMetaPath); } catch { /* keep if remove fails */ }
                }
                void this.cleanupLegacyPlotGridArtifacts(baseFolder, systemFolder).catch(() => undefined);
                return doc;
            };

            const readSidecarMeta = async () => {
                for (const candidate of [metaPath, legacyLibraryMetaPath]) {
                    if (!await adapter.exists(candidate)) continue;
                    try {
                        const text = candidate === metaPath && preloadedMetaText != null
                            ? preloadedMetaText
                            : await adapter.read(candidate);
                        const parsed = tryParseNlMeta(text);
                        if (parsed) return { meta: parsed, path: candidate };
                    } catch {
                        /* try next */
                    }
                }
                return { meta: null, path: null as string | null };
            };

            // ── Import-file mechanism ──────────────────────────────────
            const importPath = normalizePath(`${baseFolder}/plotgrid-import.json`);
            const importPathAlt = normalizePath(`${baseFolder}/datasheet-import.json`);
            for (const candidate of [importPathAlt, importPath]) {
                if (!await adapter.exists(candidate)) continue;
                try {
                    let importTxt = await adapter.read(candidate);
                    if (importTxt.charCodeAt(0) === 0xFEFF) importTxt = importTxt.slice(1);
                    const imported = normalizeConceptGridDocument(JSON.parse(importTxt));
                    const hasExisting = await adapter.exists(xlsxPath);
                    if (hasExisting && isDefaultEmptyConceptGrid(imported)) {
                        throw new Error('Refusing to replace an existing spreadsheet with an empty import.');
                    }
                    if (hasExisting) await this.backupPlotGridFile(xlsxPath, 'before-import');
                    if (await adapter.exists(metaPath)) {
                        await this.backupPlotGridFile(metaPath, 'before-import');
                    }
                    await settleCanonical(imported);
                    try {
                        await adapter.remove(candidate);
                    } catch (removeError) {
                        const preserved = `${candidate}.applied-${Date.now()}.json`;
                        await adapter.rename(candidate, preserved).catch(() => undefined);
                        console.warn('[NarrativeLab] Applied import file could not be removed:', candidate, removeError);
                    }
                    return imported;
                } catch {
                    /* try next / fall through */
                }
            }

            if (await adapter.exists(xlsxPath)) {
                try {
                    const bin = preloadedBinary ?? await adapter.readBinary(xlsxPath);
                    const sidecar = await readSidecarMeta();
                    let meta = sidecar.meta;
                    if (!meta) meta = await extractEmbeddedNlMeta(bin);
                    const structuralRepair = await plotGridXlsxNeedsRewrite(bin);
                    const missingCanonicalSidecar = !await adapter.exists(metaPath)
                        || (!!sidecar.path && sidecar.path !== metaPath);
                    const doc = await decodePlotGridXlsx(bin, { meta });
                    const staleCanonicalSidecar = !!meta
                        && !plotGridNlMetaStructureMatchesDocument(meta, doc);
                    this._invalidPlotGridXlsxPaths.delete(xlsxPath);
                    this._reportedInvalidPlotGridXlsxPaths.delete(xlsxPath);
                    void this.cleanupLegacyPlotGridArtifacts(baseFolder, systemFolder).catch(() => undefined);

                    const xlsxFilled = await countPlotGridXlsxFilledCells(bin);
                    const docFilled = countConceptGridFilledCells(doc);

                    // Only rewrite xlsx when we will not lose richer sheet values.
                    if (structuralRepair && docFilled >= xlsxFilled && (docFilled > 0 || xlsxFilled === 0)) {
                        try {
                            await this.backupPlotGridFile(xlsxPath, 'before-repair');
                            if (await adapter.exists(metaPath)) {
                                await this.backupPlotGridFile(metaPath, 'before-repair');
                            }
                            await settleCanonical(doc);
                            new Notice(t('Repaired datasheet.xlsx for Excel/Univer interop. NarrativeLab metadata is in System/datasheet.nlmeta.json.'));
                        } catch (repairError) {
                            // A failed backup or repair must not turn a readable source
                            // workbook into a corrupt-load result.
                            console.warn('[NarrativeLab] Skipped automatic datasheet repair:', repairError);
                        }
                    } else if ((missingCanonicalSidecar || staleCanonicalSidecar)
                        && (docFilled > 0 || (doc.pages.some(p => (p.rows?.length ?? 0) > 0)))) {
                        // Sidecar move/create/structural repair must not re-encode
                        // a healthy xlsx. The workbook is the visible source of truth.
                        try {
                            if (await adapter.exists(metaPath)) {
                                await this.backupPlotGridFile(metaPath, 'before-repair');
                            }
                            await this.ensureVaultFolder(systemFolder);
                            await this.writeVaultTextResilient(metaPath, serializePlotGridNlMeta(doc));
                            if (legacyLibraryMetaPath !== metaPath && await adapter.exists(legacyLibraryMetaPath)) {
                                try { await adapter.remove(legacyLibraryMetaPath); } catch { /* keep recovery copy */ }
                            }
                        } catch (sidecarRepairError) {
                            console.warn('[NarrativeLab] Skipped datasheet metadata repair:', sidecarRepairError);
                        }
                    } else if (structuralRepair && xlsxFilled > docFilled) {
                        console.warn('[NarrativeLab] Skipping datasheet rewrite — Excel sheets have more cell text than recovered model.');
                        new Notice(t('datasheet.xlsx still has spreadsheet values that NarrativeLab could not fully merge; left the Excel file unchanged.'));
                    }
                    this.rememberPlotGridDocCache(
                        targetProjectFile,
                        xlsxPath,
                        doc,
                        await adapter.stat(xlsxPath),
                        {
                            xlsx: await adapter.readBinary(xlsxPath),
                            metaText: await adapter.exists(metaPath) ? await adapter.read(metaPath) : '',
                        },
                    );
                    return doc;
                } catch (e) {
                    console.warn('[NarrativeLab] datasheet.xlsx unreadable:', e);
                    const corruptBackedUp = await this.backupCorruptPlotGridXlsx(xlsxPath);
                    for (const legacyPath of corruptBackedUp
                        ? [legacyLibraryXlsxPath, legacySystemXlsxPath, folderXlsxPath]
                        : []) {
                        if (legacyPath === xlsxPath || !await adapter.exists(legacyPath)) continue;
                        try {
                            const legacyBinary = await adapter.readBinary(legacyPath);
                            const legacyMeta = await extractEmbeddedNlMeta(legacyBinary);
                            const recovered = await decodePlotGridXlsx(legacyBinary, { meta: legacyMeta });
                            await settleCanonical(recovered);
                            this._invalidPlotGridXlsxPaths.delete(xlsxPath);
                            this._reportedInvalidPlotGridXlsxPaths.delete(xlsxPath);
                            new Notice(t('Recovered datasheet.xlsx from a readable legacy workbook.'));
                            return recovered;
                        } catch (legacyError) {
                            console.warn('[NarrativeLab] Legacy datasheet recovery failed:', legacyPath, legacyError);
                        }
                    }
                    this._invalidPlotGridXlsxPaths.add(xlsxPath);
                    if (!this._reportedInvalidPlotGridXlsxPaths.has(xlsxPath)) {
                        this._reportedInvalidPlotGridXlsxPaths.add(xlsxPath);
                        new Notice(t('Could not read datasheet.xlsx — opened empty grid; empty autosave is blocked until Reset Grid.'));
                    }
                    // Return null so the view shows empty UI, but savePlotGridSafely
                    // will refuse to overwrite the corrupt file with empty data.
                    return null;
                } finally {
                    releasePlotGridWorkbookCache();
                }
            }

            // Migrate System/plotgrid.xlsx → Library/datasheet.xlsx
            if (legacySystemXlsxPath !== xlsxPath && await adapter.exists(legacySystemXlsxPath)) {
                try {
                    const bin = await adapter.readBinary(legacySystemXlsxPath);
                    const meta = await extractEmbeddedNlMeta(bin);
                    const doc = await decodePlotGridXlsx(bin, { meta });
                    await settleCanonical(doc);
                    try { await adapter.remove(legacySystemXlsxPath); } catch { /* keep if remove fails */ }
                    return doc;
                } catch (e) {
                    console.warn('[NarrativeLab] System/plotgrid.xlsx migrate failed:', e);
                }
            }

            // Migrate System/PlotGrid/plotgrid.xlsx → Library/datasheet.xlsx
            if (folderXlsxPath !== xlsxPath && await adapter.exists(folderXlsxPath)) {
                try {
                    const bin = await adapter.readBinary(folderXlsxPath);
                    const meta = await extractEmbeddedNlMeta(bin);
                    const doc = await decodePlotGridXlsx(bin, { meta });
                    await settleCanonical(doc);
                    try { await adapter.remove(folderXlsxPath); } catch { /* keep if remove fails */ }
                    return doc;
                } catch (e) {
                    console.warn('[NarrativeLab] PlotGrid/plotgrid.xlsx migrate failed:', e);
                }
            }

            // One-shot migrate legacy JSON → xlsx
            if (await adapter.exists(jsonPath)) {
                try {
                    const txt = await adapter.read(jsonPath);
                    const doc = normalizeConceptGridDocument(JSON.parse(txt));
                    await settleCanonical(doc);
                    try {
                        await adapter.rename(jsonPath, `${jsonPath}.bak`);
                    } catch {
                        /* keep json if rename fails */
                    }
                    return doc;
                } catch (e) {
                    console.warn('[NarrativeLab] plotgrid.json migrate failed:', e);
                }
            }

            return null;
        } catch (e) {
            return null;
        }
    }

    /** Main-area NarrativeLab view types that can carry a per-project leaf binding. */
    private static readonly PROJECT_SCOPED_VIEW_TYPES: string[] = [
        BOARD_VIEW_TYPE,
        PLOTGRID_VIEW_TYPE,
        TIMELINE_VIEW_TYPE,
        STORYLINE_VIEW_TYPE,
        CHARACTER_VIEW_TYPE,
        LOCATION_VIEW_TYPE,
        CODEX_VIEW_TYPE,
        STATS_VIEW_TYPE,
        MANUSCRIPT_VIEW_TYPE,
        RESEARCH_VIEW_TYPE,
        NCANVAS_LIBRARY_VIEW_TYPE,
        NARRATIVE_CANVAS_VIEW_TYPE,
    ];

    /**
     * Flush and temporarily unload every NarrativeLab tab bound to a project
     * folder before Windows renames that folder. Board's embedded Canvas and
     * Plot Grid autosave can otherwise keep reacquiring child-file handles for
     * the whole retry window. The returned callback restores the same leaves in
     * place, rebasing their persisted project binding only when the move stuck.
     */
    async quiesceProjectLeavesForFolderMove(
        sourceFolder: string,
        destinationFolder: string,
    ): Promise<(moved: boolean) => Promise<void>> {
        const source = normalizePath(sourceFolder);
        const destination = normalizePath(destinationFolder);
        const sourcePrefix = `${source}/`;
        const suspended: Array<{
            leaf: WorkspaceLeaf;
            viewState: ReturnType<WorkspaceLeaf['getViewState']>;
            boundProjectFile: string | null;
            wasActive: boolean;
        }> = [];
        const capturedLeaves = new Set<WorkspaceLeaf>();
        const activeLeaf = (this.app.workspace as unknown as { activeLeaf?: WorkspaceLeaf | null }).activeLeaf;

        const suspendLeaf = async (leaf: WorkspaceLeaf, boundProjectFile: string | null): Promise<void> => {
            if (capturedLeaves.has(leaf)) return;
            capturedLeaves.add(leaf);
            suspended.push({
                leaf,
                viewState: leaf.getViewState(),
                boundProjectFile,
                wasActive: leaf === activeLeaf,
            });
            try {
                // setViewState waits for onClose(): workbook, Canvas, Base and
                // Markdown editor buffers finish before the write freeze begins.
                await leaf.setViewState({ type: 'empty', state: {}, active: false });
            } catch (error) {
                console.warn('[NarrativeLab] Could not fully quiesce a project tab before moving it:', error);
            }
        };

        for (const viewType of SceneCardsPlugin.PROJECT_SCOPED_VIEW_TYPES) {
            for (const leaf of this.app.workspace.getLeavesOfType(viewType)) {
                const boundProjectFile = getLeafNarrativeLabProjectFile(leaf);
                if (!boundProjectFile) continue;
                const boundFolder = normalizePath(
                    deriveProjectFoldersFromFilePath(boundProjectFile).baseFolder,
                );
                if (boundFolder !== source) continue;
                await suspendLeaf(leaf, boundProjectFile);
            }
        }

        // Ordinary Obsidian Markdown/Base/Canvas leaves are not project-bound
        // NarrativeLab views, but their file buffers can still race a Windows
        // directory rename. Preserve and temporarily unload those leaves too.
        const fileLeaves: WorkspaceLeaf[] = [];
        this.app.workspace.iterateAllLeaves((leaf) => {
            if (!(leaf.view instanceof FileView)) return;
            const filePath = normalizePath(leaf.view.file?.path || '');
            if (filePath === source || filePath.startsWith(sourcePrefix)) fileLeaves.push(leaf);
        });
        for (const leaf of fileLeaves) await suspendLeaf(leaf, null);

        const activeProjectFile = this.sceneManager.activeProject?.filePath
            ? normalizePath(this.sceneManager.activeProject.filePath)
            : '';
        const activeProjectRoot = activeProjectFile
            ? normalizePath(deriveProjectFoldersFromFilePath(activeProjectFile).baseFolder)
            : '';
        if (activeProjectRoot === source) {
            this.flushWritingTrackers();
            await this.settleWritingTrackerChanges();
            await this.saveProjectSystemData().catch(error => {
                console.warn('[NarrativeLab] Could not complete the final project save before moving it:', error);
            });
        }

        // Block delayed layout/refresh timers from starting new writes against
        // the old root, then drain everything that was already queued.
        this._projectMoveWriteGuards.add(source);
        await this.settleProjectWritesForFolderMove(source);
        await new Promise<void>(resolve => window.setTimeout(resolve, 120));
        await this.settleProjectWritesForFolderMove(source);

        let restored = false;
        return async (moved: boolean): Promise<void> => {
            if (restored) return;
            restored = true;
            this._projectMoveWriteGuards.delete(source);
            let activeToReveal: WorkspaceLeaf | null = null;
            for (const item of suspended) {
                const previousState = (item.viewState.state || {}) as Record<string, unknown>;
                const previousBinding = previousState.narrativeLabProjectFile;
                let nextBinding = typeof previousBinding === 'string'
                    ? normalizePath(previousBinding)
                    : (item.boundProjectFile || '');
                const rebaseMovedPath = (value: string): string => {
                    const normalized = normalizePath(value);
                    if (!moved) return normalized;
                    if (normalized === source) return destination;
                    if (normalized.startsWith(sourcePrefix)) {
                        return normalizePath(`${destination}/${normalized.slice(sourcePrefix.length)}`);
                    }
                    return normalized;
                };
                if (nextBinding) nextBinding = rebaseMovedPath(nextBinding);
                const nextState: Record<string, unknown> = { ...previousState };
                if (typeof nextState.file === 'string') {
                    nextState.file = rebaseMovedPath(nextState.file);
                }
                try {
                    await item.leaf.setViewState({
                        ...item.viewState,
                        active: false,
                        state: nextBinding
                            ? narrativeLabLeafState(nextBinding, nextState)
                            : nextState,
                    });
                    if (item.wasActive) activeToReveal = item.leaf;
                } catch (error) {
                    console.warn('[NarrativeLab] Could not restore a project tab after moving it:', error);
                }
            }
            if (activeToReveal) this.app.workspace.revealLeaf(activeToReveal);
        };
    }

    private async settleProjectWritesForFolderMove(sourceFolder: string): Promise<void> {
        const source = normalizePath(sourceFolder);
        const prefix = `${source}/`;
        await this.settleWritingTrackerChanges();
        await this.sceneManager.settleProjectFrontmatterWrites();
        for (let pass = 0; pass < 4; pass++) {
            const pending = [...this._systemJsonWriteQueues.entries()]
                .filter(([path]) => path === source || path.startsWith(prefix))
                .map(([, promise]) => promise);
            if (pending.length === 0) break;
            await Promise.allSettled(pending);
        }
    }

    private countProjectScopedLeaves(): number {
        let n = 0;
        for (const viewType of SceneCardsPlugin.PROJECT_SCOPED_VIEW_TYPES) {
            n += this.app.workspace.getLeavesOfType(viewType).length;
        }
        return n;
    }

    /** Project manifest that owns this vault path (longest matching base folder). */
    private findProjectFileForVaultPath(filePath: string): string | null {
        const path = normalizePath(filePath);
        if (!path) return null;
        let best: { filePath: string; length: number } | null = null;
        for (const project of this.sceneManager?.getProjects() || []) {
            const base = normalizePath(deriveProjectFoldersFromFilePath(project.filePath).baseFolder);
            if (!base) continue;
            if (path === base || path.startsWith(`${base}/`)) {
                if (!best || base.length > best.length) {
                    best = { filePath: normalizePath(project.filePath), length: base.length };
                }
            }
        }
        return best?.filePath ?? null;
    }

    /** Prefer a leaf bound to `projectFile`, then the active project, then an unbound leaf. */
    private findBoundLeafOfType(viewType: string, projectFile?: string | null): WorkspaceLeaf | null {
        const leaves = this.app.workspace.getLeavesOfType(viewType);
        const wanted = projectFile?.trim() ? normalizePath(projectFile) : null;
        if (wanted) {
            const bound = leaves.find(item => getLeafNarrativeLabProjectFile(item) === wanted);
            if (bound) return bound;
        }
        const activePath = this.sceneManager.activeProject?.filePath
            ? normalizePath(this.sceneManager.activeProject.filePath)
            : null;
        if (activePath) {
            const bound = leaves.find(item => getLeafNarrativeLabProjectFile(item) === activePath);
            if (bound) return bound;
        }
        return leaves.find(item => !getLeafNarrativeLabProjectFile(item)) ?? leaves[0] ?? null;
    }

    /** Find an already-open NarrativeLab main-area tab for one project. */
    private findProjectScopedLeaf(projectFile: string): WorkspaceLeaf | null {
        const normalized = normalizePath(projectFile);
        for (const viewType of SceneCardsPlugin.PROJECT_SCOPED_VIEW_TYPES) {
            const leaf = this.app.workspace.getLeavesOfType(viewType)
                .find(item => getLeafNarrativeLabProjectFile(item) === normalized);
            if (leaf) return leaf;
        }
        return null;
    }

    /**
     * Activate a view type in the workspace
     */
    async activateView(viewType: string, projectFile?: string | null): Promise<void> {
        const { workspace } = this.app;

        let leaf: WorkspaceLeaf | null = null;
        const leaves = workspace.getLeavesOfType(viewType);
        const activePath = (projectFile?.trim()
            ? normalizePath(projectFile)
            : this.sceneManager.activeProject?.filePath
                ? normalizePath(this.sceneManager.activeProject.filePath)
                : null);

        if (leaves.length > 0 && activePath) {
            // Reuse only this project's leaf. Falling back to leaves[0] here
            // silently replaced another open project's content and title.
            leaf = leaves.find(item => getLeafNarrativeLabProjectFile(item) === activePath) ?? null;
            if (!leaf) {
                // Adopt one legacy, unbound leaf once; never adopt a leaf that
                // already belongs to another project.
                leaf = leaves.find(item => !getLeafNarrativeLabProjectFile(item)) ?? null;
                if (leaf) {
                    const previous = (leaf.getViewState()?.state || {}) as Record<string, unknown>;
                    await leaf.setViewState({
                        type: viewType,
                        active: true,
                        state: narrativeLabLeafState(activePath, previous),
                    });
                }
            }
        } else if (leaves.length > 0) {
            leaf = leaves[0] ?? null;
        }

        if (!leaf) {
            // Never replace another project's open tab — open beside it instead.
            const hasScopedLeaves = this.countProjectScopedLeaves() > 0;
            leaf = hasScopedLeaves ? workspace.getLeaf('tab') : workspace.getLeaf(false);
            if (leaf) {
                await leaf.setViewState({
                    type: viewType,
                    active: true,
                    state: narrativeLabLeafState(activePath),
                });
            }
        }

        if (leaf) {
            workspace.revealLeaf(leaf);
        }
    }

    /** Map the Default view setting to a registered workspace view type. */
    private resolveDefaultProjectViewType(): string {
        const bySetting: Record<ViewType, string> = {
            board: BOARD_VIEW_TYPE,
            manuscript: MANUSCRIPT_VIEW_TYPE,
            plotgrid: PLOTGRID_VIEW_TYPE,
            timeline: TIMELINE_VIEW_TYPE,
            storyline: STORYLINE_VIEW_TYPE,
            codex: CODEX_VIEW_TYPE,
            character: CHARACTER_VIEW_TYPE,
            location: LOCATION_VIEW_TYPE,
            stats: STATS_VIEW_TYPE,
        };
        return bySetting[this.settings.defaultView] || BOARD_VIEW_TYPE;
    }

    /**
     * Open a project without duplicating its existing NarrativeLab tab.
     * Prefer its Default-view tab; otherwise focus any main-area tab already bound to it.
     * A new tab is created only when that project has no open tab.
     */
    async openBoardForProject(project: StoryLineProject): Promise<void> {
        const projectFile = normalizePath(project.filePath);
        const { workspace } = this.app;
        const defaultType = this.resolveDefaultProjectViewType();
        const preferred = workspace.getLeavesOfType(defaultType);
        let leaf = preferred.find(item => getLeafNarrativeLabProjectFile(item) === projectFile) ?? null;

        if (!leaf) {
            leaf = this.findProjectScopedLeaf(projectFile);
        }

        if (!leaf) {
            // getLeaf(false) reuses the active leaf — that silently replaces a
            // Character/Location/Board tab when the previous project's Board was
            // switched away in-place. Always open a new tab whenever any
            // project-scoped NarrativeLab leaf already exists.
            const hasScopedLeaves = this.countProjectScopedLeaves() > 0;
            leaf = hasScopedLeaves ? workspace.getLeaf('tab') : workspace.getLeaf(false);
            await leaf.setViewState({
                type: defaultType,
                active: true,
                state: narrativeLabLeafState(projectFile),
            });
        }

        const current = this.sceneManager.activeProject;
        if (!current || normalizePath(current.filePath) !== projectFile) {
            await this.sceneManager.setActiveProject(project);
        } else {
            await this.refreshOpenViews();
        }
        workspace.revealLeaf(leaf);
        this.storyLeaf = leaf;
    }

    /** If the focused leaf is bound to another project, switch the active project. */
    private _pendingProjectLeaf: WorkspaceLeaf | null = null;
    private _projectLeafSyncPromise: Promise<void> | null = null;
    private syncActiveProjectFromLeaf(leaf: WorkspaceLeaf | null): Promise<void> {
        if (!leaf) return Promise.resolve();
        // Coalesce rapid tab focus changes to the latest leaf. The previous
        // boolean guard discarded the later project and left UI/data mismatched.
        this._pendingProjectLeaf = leaf;
        if (!this._projectLeafSyncPromise) {
            this._projectLeafSyncPromise = this.drainProjectLeafSyncQueue()
                .finally(() => {
                    this._projectLeafSyncPromise = null;
                    if (this._pendingProjectLeaf) {
                        void this.syncActiveProjectFromLeaf(this._pendingProjectLeaf);
                    }
                });
        }
        return this._projectLeafSyncPromise;
    }

    private async drainProjectLeafSyncQueue(): Promise<void> {
        while (this._pendingProjectLeaf) {
            const requestedLeaf = this._pendingProjectLeaf;
            this._pendingProjectLeaf = null;
            const bound = getLeafNarrativeLabProjectFile(requestedLeaf);
            if (!bound) continue;
            const activePath = this.sceneManager.activeProject?.filePath
                ? normalizePath(this.sceneManager.activeProject.filePath)
                : null;
            if (activePath === bound) continue;
            const project = this.sceneManager.getProjects()
                .find(p => normalizePath(p.filePath) === bound);
            if (!project) continue;
            try {
                await this.sceneManager.setActiveProject(project, { fromLeafFocus: true });
            } catch (err) {
                console.warn('[NarrativeLab] Failed to sync active project from leaf:', err);
            }
        }
    }

    /**
     * Determine what kind of NarrativeLab entity a file belongs to.
     * Returns 'character' | 'location' | 'codex' | null.
     */
    private resolveEntityType(filePath: string): 'character' | 'location' | 'codex' | null {
        const p = normalizePath(filePath);
        const charFolder = normalizePath(this.sceneManager.getCharacterFolder());
        if (p.startsWith(charFolder + '/') || p === charFolder) return 'character';
        const locFolder = normalizePath(this.sceneManager.getLocationFolder());
        if (p.startsWith(locFolder + '/') || p === locFolder) return 'location';
        const codexFolder = normalizePath(this.sceneManager.getCodexFolder());
        if (p.startsWith(codexFolder + '/') || p === codexFolder) return 'codex';
        return null;
    }

    /**
     * Open the appropriate NarrativeLab view and navigate to the entity's detail panel.
     */
    async showEntityDetails(filePath: string): Promise<void> {
        const kind = this.resolveEntityType(filePath);
        const projectFile = this.findProjectFileForVaultPath(filePath);
        switch (kind) {
            case 'character': {
                await this.activateView(CHARACTER_VIEW_TYPE, projectFile);
                const leaf = this.findBoundLeafOfType(CHARACTER_VIEW_TYPE, projectFile);
                if (leaf) await (leaf.view as CharacterView).navigateToCharacter(filePath);
                break;
            }
            case 'location': {
                await this.activateView(LOCATION_VIEW_TYPE, projectFile);
                const leaf = this.findBoundLeafOfType(LOCATION_VIEW_TYPE, projectFile);
                if (leaf) await (leaf.view as LocationView).navigateToItem(filePath);
                break;
            }
            case 'codex': {
                await this.activateView(CODEX_VIEW_TYPE, projectFile);
                const leaf = this.findBoundLeafOfType(CODEX_VIEW_TYPE, projectFile);
                if (leaf) await (leaf.view as CodexView).navigateToEntry(filePath);
                break;
            }
        }
    }

    /**
     * Open the Story Navigator in the left sidebar.
     * If already open, just reveal it (unless `quiet` — used on startup so we
     * don't expand/reveal sidebars that Obsidian already restored).
     */
    async openNavigator(opts?: { quiet?: boolean }): Promise<void> {
        const quiet = opts?.quiet === true;
        const { workspace } = this.app;
        const existing = workspace.getLeavesOfType(NAVIGATOR_VIEW_TYPE);
        if (existing.length > 0) {
            if (quiet) return;
            workspace.revealLeaf(existing[0]);
            // Ensure the left split is expanded if Obsidian collapsed it
            try {
                const leftSplit = (workspace as unknown as { leftSplit?: { expand?: () => void } }).leftSplit;
                leftSplit?.expand?.();
            } catch { /* older Obsidian */ }
            return;
        }

        // Prefer ensureSideLeaf when available (creates + activates reliably)
        const ensureSideLeaf = (workspace as unknown as {
            ensureSideLeaf?: (type: string, side: 'left' | 'right', opts?: { active?: boolean }) => Promise<WorkspaceLeaf>;
        }).ensureSideLeaf;
        if (typeof ensureSideLeaf === 'function') {
            // quiet: create without activating so we don't yank focus / animate splits
            const leaf = await ensureSideLeaf.call(workspace, NAVIGATOR_VIEW_TYPE, 'left', {
                active: !quiet,
            });
            if (!quiet && leaf) workspace.revealLeaf(leaf);
            return;
        }

        const leaf = workspace.getLeftLeaf(false) ?? workspace.getLeftLeaf(true);
        if (leaf) {
            await leaf.setViewState({ type: NAVIGATOR_VIEW_TYPE, active: !quiet });
            if (!quiet) workspace.revealLeaf(leaf);
        }
    }

    /**
     * Open a view in the right sidebar (creating it if needed), expand the
     * sidebar, focus the leaf, and flash its workspace tab so the user can
     * see which tab responded.
     */
    private async revealOrOpenRightSidebarView(viewType: string): Promise<WorkspaceLeaf | null> {
        const { workspace } = this.app;

        const rightSplit = workspace.rightSplit as { collapsed?: boolean; expand?: () => void } | null;
        if (rightSplit?.collapsed && typeof rightSplit.expand === 'function') {
            rightSplit.expand();
        }

        let leaf = workspace.getLeavesOfType(viewType)[0] ?? null;
        if (!leaf) {
            const rightLeaf = workspace.getRightLeaf(false);
            if (!rightLeaf) return null;
            leaf = rightLeaf;
            await leaf.setViewState({ type: viewType, active: true });
        }

        workspace.revealLeaf(leaf);
        workspace.setActiveLeaf(leaf, { focus: true });
        // Wait a frame so Obsidian finishes painting the tab header after reveal
        window.requestAnimationFrame(() => this.flashWorkspaceTab(leaf));
        return leaf;
    }

    /** Brief accent pulse on a leaf's workspace tab header. */
    private flashWorkspaceTab(leaf: WorkspaceLeaf): void {
        const withTab = leaf as unknown as { tabHeaderEl?: HTMLElement; containerEl?: HTMLElement };
        let tabHeader = withTab.tabHeaderEl ?? null;
        if (!tabHeader) {
            const leafEl = withTab.containerEl?.closest('.workspace-leaf') as HTMLElement | null;
            const tabs = leafEl?.parentElement?.parentElement;
            const headers = tabs?.querySelectorAll('.workspace-tab-header');
            if (headers && leafEl?.parentElement) {
                const children = Array.from(leafEl.parentElement.children);
                const idx = children.indexOf(leafEl);
                if (idx >= 0 && headers[idx]) tabHeader = headers[idx] as HTMLElement;
            }
        }
        if (!tabHeader) return;

        tabHeader.classList.remove('sl-tab-flash');
        // Restart CSS animation if already flashing
        void tabHeader.offsetWidth;
        tabHeader.classList.add('sl-tab-flash');
        window.setTimeout(() => tabHeader?.classList.remove('sl-tab-flash'), 1100);
    }

    /**
     * Open the Scene Details inspector in the right sidebar.
     * If already open, focus it and flash the tab.
     */
    async openSceneInspector(): Promise<void> {
        await this.revealOrOpenRightSidebarView(SCENE_INSPECTOR_VIEW_TYPE);
    }

    /**
     * Open (or reveal) the standalone Notes sidebar view.
     */
    async openNotesView(): Promise<void> {
        await this.revealOrOpenRightSidebarView(NOTES_VIEW_TYPE);
    }

    /**
     * Open (or reveal) the standalone Synopsis sidebar view. The leaf can be
     * dragged to dock above/below/beside any other pane.
     */
    async openSynopsisView(): Promise<void> {
        await this.revealOrOpenRightSidebarView(SYNOPSIS_VIEW_TYPE);
    }

    /**
     * Open (or reveal) the standalone Scene Details view (the full inspector
     * inside its own dockable leaf).
     */
    async openSceneDetailsLeaf(): Promise<void> {
        await this.revealOrOpenRightSidebarView(DETAILS_VIEW_TYPE);
    }

    async openWritingTrackerPanel(opts?: { quiet?: boolean }): Promise<void> {
        const quiet = opts?.quiet === true;
        const { workspace } = this.app;
        const existing = workspace.getLeavesOfType(WRITING_TRACKER_PANEL_TYPE);
        if (existing.length > 0) {
            if (quiet) return;
            await this.revealOrOpenRightSidebarView(WRITING_TRACKER_PANEL_TYPE);
            return;
        }
        const ensureSideLeaf = (workspace as unknown as {
            ensureSideLeaf?: (type: string, side: 'left' | 'right', opts?: { active?: boolean }) => Promise<WorkspaceLeaf>;
        }).ensureSideLeaf;
        if (typeof ensureSideLeaf === 'function') {
            const leaf = await ensureSideLeaf.call(workspace, WRITING_TRACKER_PANEL_TYPE, 'right', {
                active: !quiet,
            });
            if (!quiet && leaf) workspace.revealLeaf(leaf);
            return;
        }
        await this.revealOrOpenRightSidebarView(WRITING_TRACKER_PANEL_TYPE);
    }

    async openWritingTracker(): Promise<void> {
        const { workspace } = this.app;
        const existing = workspace.getLeavesOfType(WRITING_TRACKER_VIEW_TYPE);
        if (existing.length > 0) {
            workspace.revealLeaf(existing[0]);
            workspace.setActiveLeaf(existing[0], { focus: true });
            return;
        }
        const leaf = workspace.getLeaf('tab');
        await leaf.setViewState({ type: WRITING_TRACKER_VIEW_TYPE, active: true });
        workspace.revealLeaf(leaf);
    }

    /** Scene-index total used by the writing tracker (same exclusions everywhere). */
    getTrackedWordTotal(): number {
        return this.sceneManager.queryService.getStatistics(
            this.settings.excludeArcAnchorFromWordcount ?? true,
        ).totalWords;
    }

    /** Whether any file-backed workspace leaf belongs to the selected project folder. */
    hasOpenFileForProject(projectFilePath?: string | null): boolean {
        const target = normalizePath(
            projectFilePath || this.sceneManager.activeProject?.filePath || '',
        );
        if (!target) return false;
        const base = normalizePath(deriveProjectFoldersFromFilePath(target).baseFolder);
        if (!base) return false;
        const prefix = `${base}/`;
        let found = false;
        this.app.workspace.iterateAllLeaves((leaf) => {
            if (found || !(leaf.view instanceof FileView)) return;
            const path = normalizePath(leaf.view.file?.path || '');
            if (path === base || path.startsWith(prefix)) found = true;
        });
        return found;
    }

    /** Pause/resume project session and sprint clocks as project files open and close. */
    syncWritingTrackerActivity(): void {
        const project = this.sceneManager.activeProject;
        const changed = this.writingTracker.setProjectFilesOpen(
            project ? this.hasOpenFileForProject(project.filePath) : false,
        );
        if (!changed) return;
        for (const leaf of this.app.workspace.getLeavesOfType(WRITING_TRACKER_PANEL_TYPE)) {
            (leaf.view as WritingTrackerPanel).refresh?.();
        }
    }

    async settleWritingTrackerChanges(): Promise<void> {
        const pending = [...this._writingRevisionQueues.values()];
        if (pending.length > 0) await Promise.allSettled(pending);
    }

    flushWritingTrackers(totalWords?: number, now = Date.now()): void {
        if (this._writingTrackerProjectSwitching) return;
        try {
            const words = totalWords ?? this.getTrackedWordTotal();
            const delta = this.writingTracker.flushSession(words, now);
            this.globalWritingTracker?.recordFlush(delta, now);
            if (delta.words !== 0 || delta.revisions > 0) this.scheduleWritingTrackerSave();
        } catch { /* project may not be set yet */ }
    }

    /** Stop tracker mutations before activeProject changes but the old ledger is still in memory. */
    suspendWritingTrackerForProjectSwitch(): void {
        this._writingTrackerProjectSwitching = true;
        if (this._writingTrackerSaveTimer !== null) {
            window.clearTimeout(this._writingTrackerSaveTimer);
            this._writingTrackerSaveTimer = null;
        }
    }

    /** Whether an async text event still belongs to the project that queued it. */
    canRecordWritingChange(projectFilePath: string): boolean {
        if (this._writingTrackerProjectSwitching) return false;
        const active = normalizePath(this.sceneManager.activeProject?.filePath || '');
        return !!active && active === normalizePath(projectFilePath);
    }

    /**
     * Drop in-memory caches that are not keyed by project. Call after the new
     * project's System data + scene/entity indexes are loaded, and before views
     * refresh. Do not call from `withActiveProject()`.
     */
    isolateProjectTransientState(): void {
        this.invalidatePlotGridScanCache();
        this.linkScanner.invalidateAll();
        this.linkScanner.rebuildLookups(this.settings.characterAliases);
        this.linkScanner.scanAll(this.sceneManager.getAllScenes());
        this.sceneManager.undoManager.clear();
        this.sceneManager.queryService.clearCaches();
        this.sceneManager.rebuildSceneTitleToStemMap();
        clearPendingStoryGraphWikilinks();
        clearLastManuscriptState();
        this.floatingStickyNotes?.syncVisibleNotesForProject(
            this.sceneManager.activeProject?.filePath ?? null,
        );
        for (const leaf of this.app.workspace.getLeavesOfType(NAVIGATOR_VIEW_TYPE)) {
            const view = leaf.view as NavigatorView;
            view.resetProjectTransientUi?.();
        }
    }

    /** After a project switch, baseline the session on that book's scene total. */
    rebindWritingTrackerSession(): void {
        try {
            const words = this.getTrackedWordTotal();
            this.writingTracker.startSession(words, this.hasOpenFileForProject());
            this._writingTrackerProjectSwitching = false;
        } catch { /* project may not be set yet */ }
    }

    /** Returns true when the Scene Inspector sidebar is open and visible. */
    isSceneInspectorOpen(): boolean {
        const leaves = this.app.workspace.getLeavesOfType(SCENE_INSPECTOR_VIEW_TYPE);
        if (leaves.length === 0) return false;
        const leaf = leaves[0];
        // Check the sidebar containing this leaf is not collapsed
        const root = leaf.getRoot();
        if ((root as unknown as Record<string, unknown>).collapsed) return false;
        // Check this leaf is the active tab in its parent (not hidden behind another tab)
        const parent = ((leaf as unknown as Record<string, unknown>).parentSplit
            ?? (leaf as unknown as Record<string, unknown>).parent) as { children?: unknown[]; currentTab?: unknown; activeTab?: unknown } | undefined;
        if (parent && typeof parent.children !== 'undefined') {
            const activeChild = parent.currentTab ?? parent.activeTab;
            if (activeChild !== undefined && activeChild !== leaf) {
                // parent tracks a numeric index — compare by index
                const idx = (parent.children as unknown[]).indexOf(leaf);
                if (typeof activeChild === 'number' ? activeChild !== idx : true) return false;
            }
        }
        return true;
    }

    async openResearch(): Promise<void> {
        await this.revealOrOpenRightSidebarView(RESEARCH_VIEW_TYPE);
    }

    /**
     * Open the Quick Add modal
     */
    private openQuickAdd(): void {
        const modal = new QuickAddModal(
            this.app,
            this,
            this.sceneManager,
            async (sceneData, openAfter) => {
                const file = await this.sceneManager.createScene(sceneData);
                this.refreshOpenViews();

                if (openAfter) {
                    await this.app.workspace.getLeaf('tab').openFile(file, { state: { mode: 'source', source: false } });
                }
            }
        );
        modal.open();
    }

    /**
     * Load characters and locations for the active project.
     *
     * When the project belongs to a series, `getCharacterFolder()` /
     * `getLocationFolder()` already redirect to the shared series-level
     * Library folder. After loading from there we additionally scan the
     * per-project `Library/Characters/` and `Library/Locations/` folders so
     * book-only characters and locations can coexist with series-shared
     * ones. The series scan wins on file-path collisions because
     * `addFile()` skips paths that are already loaded.
     */
    /**
     * Reload all entity managers from the project folders AND re-apply
     * Additional Source Folders. This is the single entry point views
     * should call on open/refresh so that externally-scanned entries
     * (characters/locations/library entries stored outside the project Library)
     * survive view reloads.
     *
     * `loadActiveProjectEntities()` clears each manager and reloads from
     * the project folders; `scanExtraFolders()` then re-adds entries from
     * user-configured external folders. Calling both keeps the two in sync.
     */
    /** True when entity managers were reloaded within `maxAgeMs`. */
    entitiesFresh(maxAgeMs = 60_000): boolean {
        return this._lastEntitiesReloadAt > 0 && (Date.now() - this._lastEntitiesReloadAt) < maxAgeMs;
    }

    /**
     * Reload Library/character/location entities.
     * @returns true when Library category tabs were added/changed from vault folders.
     */
    async reloadEntities(): Promise<boolean> {
        if (!this.sceneManager.activeProject) return false;
        // Coalesce view-driven reads, but never lose a Finder/Explorer folder
        // event that arrives during the current pass.
        if (this._reloadEntitiesPromise) {
            this._reloadEntitiesQueued = true;
            return this._reloadEntitiesPromise.then(async changed => {
                if (!this._reloadEntitiesQueued) return changed;
                this._reloadEntitiesQueued = false;
                return (await this.reloadEntities()) || changed;
            });
        }
        this._reloadEntitiesPromise = this.reloadEntitiesUncoalesced()
            .then((categoriesChanged) => {
                this._lastEntitiesReloadAt = Date.now();
                return categoriesChanged;
            })
            .finally(() => {
                this._reloadEntitiesPromise = null;
            });
        return this._reloadEntitiesPromise;
    }

    private async reloadEntitiesUncoalesced(): Promise<boolean> {
        let categoriesChanged = false;
        // Discover Library/<Category> folders before initCategories so new tabs
        // (e.g. Skills) appear without reopening the project.
        const codexFolder = this.sceneManager.getCodexFolder();
        if (codexFolder) {
            categoriesChanged = await reconcileLibraryCategoriesForActiveProject(this);
            if (categoriesChanged) {
                const activeProject = this.sceneManager.activeProject;
                const catPath = normalizePath(`${this.getProjectSystemFolder()}/${LIBRARY_CATEGORIES_FILENAME}`);
                if (!this._invalidSystemJsonPaths.has(catPath)) {
                    await this.writeSystemJson(
                        LIBRARY_CATEGORIES_FILENAME,
                        readLibraryCategorySettings(this.settings) as unknown as Record<string, unknown>,
                    );
                }
                if (activeProject?.libraryFolders) {
                    await this.sceneManager.saveProjectFrontmatter(activeProject).catch(() => undefined);
                }
                // Keep Story Graph node-type colors aligned with Library folders.
                const { syncStoryGraphLibraryNodeTypes } = await import('./components/LibraryModeBar');
                if (syncStoryGraphLibraryNodeTypes(this)) {
                    await this.saveSettings();
                }
                // Force Library/Character/Location tab bars to rebuild (browse mode
                // otherwise skips remount to avoid flashing native Bases).
                this.libraryCategoriesStructureEpoch += 1;
            }

            const customDefs = (this.settings.codexCustomCategories || []).map(
                (cc: { id: string; label: string; icon: string }) =>
                    makeProfileCodexCategory(cc.id, cc.label, cc.icon)
            );
            this.codexManager.initCategories(this.settings.codexEnabledCategories || [], customDefs);
            await ensureSeededLibraryCategoryLabels(this);
            // Folder path + display label (editable names remain verbatim).
            applyCategoryFolderLabels(this);
        }

        // Plain .md dropped into Library/<Category>/ get type/name frontmatter.
        await this.adoptLibraryEntityFiles();

        await this.loadActiveProjectEntities();
        // Re-load codex entries from the project Library folder, then pick up
        // any remaining notes (root / misc folders) without re-reading files
        // already loaded by category scans. External folders are scanned once.
        if (codexFolder) {
            await this.codexManager.loadAll(codexFolder);
            await this.scanLibraryFolder(codexFolder, { skipLoaded: true });
            // Series projects also keep a project-local Library for book-only
            // assets. loadAll() clears the manager, so merge this second root
            // through the non-clearing type router.
            const localLibrary = this.sceneManager.activeProject?.codexFolder
                ? normalizePath(this.sceneManager.activeProject.codexFolder)
                : null;
            if (localLibrary && localLibrary !== normalizePath(codexFolder)) {
                await this.scanLibraryFolder(localLibrary, { skipLoaded: true });
            }
        }
        await this.scanExtraFolders();
        void this.syncCustomFieldFrontmatter().catch(error => {
            console.error('[NarrativeLab] Initial custom-field frontmatter sync failed:', error);
        });
        return categoriesChanged;
    }

    /**
     * Write minimal frontmatter onto vault files that were created outside
     * NarrativeLab under a known Library category folder (Characters,
     * Locations, Items, …). Preserves body text; skips files that already
     * declare a different entity type.
     */
    private async adoptLibraryEntityFiles(): Promise<void> {
        if (this._adoptingLibrary) return;
        const targets: LibraryAdoptTarget[] = [];

        const charFolder = this.sceneManager.getCharacterFolder();
        if (charFolder) targets.push({ folderPath: charFolder, type: 'character' });
        const localChar = this.sceneManager.getProjectLocalCharacterFolder();
        if (localChar && localChar !== charFolder) {
            targets.push({ folderPath: localChar, type: 'character' });
        }

        const locFolder = this.sceneManager.getLocationFolder();
        if (locFolder) {
            targets.push({
                folderPath: locFolder,
                type: 'location',
                allowedTypes: ['location', 'world'],
            });
        }
        const localLoc = this.sceneManager.getProjectLocalLocationFolder();
        if (localLoc && localLoc !== locFolder) {
            targets.push({
                folderPath: localLoc,
                type: 'location',
                allowedTypes: ['location', 'world'],
            });
        }

        const codexFolder = this.sceneManager.getCodexFolder();
        if (codexFolder) {
            for (const cat of this.codexManager.getCategories()) {
                targets.push({
                    folderPath: normalizePath(`${codexFolder}/${cat.folder}`),
                    type: cat.id,
                });
            }
            // Project-local Library when series redirects getCodexFolder() away.
            const project = this.sceneManager.activeProject;
            const projectCodex = project?.codexFolder
                ? normalizePath(project.codexFolder)
                : null;
            if (projectCodex && projectCodex !== normalizePath(codexFolder)) {
                for (const cat of this.codexManager.getCategories()) {
                    targets.push({
                        folderPath: normalizePath(`${projectCodex}/${cat.folder}`),
                        type: cat.id,
                    });
                }
            }
        }

        if (targets.length === 0) return;

        this._adoptingLibrary = true;
        try {
            await adoptLibraryTargets(this.app, targets);
        } finally {
            this._adoptingLibrary = false;
        }
    }

    /** Require vendored Narrative Canvas (bundled into main.js by esbuild). */
    private requireCanvasRuntime(): EmbeddedCanvasConstructor {
        // eslint-disable-next-line @typescript-eslint/no-require-imports, no-undef -- CJS require; esbuild inlines the vendored bundle
        return require('./canvas-runtime/main.js') as EmbeddedCanvasConstructor;
    }

    /**
     * Boot Narrative Canvas inside this plugin while keeping its settings in a
     * dedicated namespace. This prevents the embedded module from overwriting
     * NarrativeLab's database settings in data.json.
     */
    private async loadEmbeddedCanvas(): Promise<void> {
        if (this.canvasModule) return;
        if (this._canvasModuleLoading) {
            await this._canvasModuleLoading;
            return;
        }
        this._canvasModuleLoading = (async () => {
            // Vendored Narrative Canvas is bundled into main.js (esbuild).
            const EmbeddedNarrativeCanvas = this.requireCanvasRuntime();
            const canvas = new EmbeddedNarrativeCanvas(this.app, this.manifest);
            canvas.loadData = async () => this.settings.narrativeCanvasData ?? {};
            canvas.saveData = async (data: Record<string, unknown>) => {
                this.settings.narrativeCanvasData = data;
                await this.saveSettings();
            };
            canvas.getProjectAttachmentFolderName = () =>
                (this.settings.projectAttachmentFolder || 'Attachments').trim() || 'Attachments';
            canvas.getNarrativeLabLibraryFolderMap = (projectPath = '') => {
                const project = this.sceneManager.activeProject;
                if (!project?.libraryFolders) return {};
                const canvasPath = normalizePath(String(projectPath || ''));
                if (!canvasPath) return project.libraryFolders;
                const base = normalizePath(deriveProjectFoldersFromFilePath(project.filePath).baseFolder);
                if (canvasPath === base || canvasPath.startsWith(`${base}/`)) return project.libraryFolders;
                return {};
            };
            canvas.getNarrativeLabInterfaceLanguage = () => this.getEffectiveInterfaceLanguage();
            canvas.getNarrativeLabUiTheme = () => this.getEffectiveUiTheme();
            canvas.onNarrativeLabUiThemeChanged = (theme: 'light' | 'dark') => {
                void this.setUiTheme(theme, { skipCanvas: true });
            };
            canvas.onNarrativeLabLanguageChanged = (language: UiLanguage) => {
                void this.setInterfaceLanguage(language);
            };
            canvas.createSampleInActiveProject = (language?: string) =>
                this.createSampleNcanvasInActiveProject(language === 'zh' ? 'zh' : 'en');
            canvas.openNarrativeLabCanvasLibrary = (canvasPath?: string) =>
                this.openNCanvasLibraryForCanvasPath(canvasPath);
            canvas.getNarrativeLabLibraryCategories = () => listVisibleLibraryCategories(this);
            canvas.resolveNarrativeLabLibraryCategoryLabel = (kind: string) =>
                resolveLibraryCategoryLabelForKind(this, kind);
            canvas.openNarrativeLabLibraryCategoryManager = (onDone) => {
                void import('./views/CodexView').then(({ openManageLibraryCategoriesModal }) => {
                    openManageLibraryCategoriesModal(this, onDone);
                });
            };
            canvas.createCodexCanvas = (entry: CreateLibraryEntityBoardEntry) =>
                this.createLibraryEntityBoard(entry);
            canvas.mountCanvasLibraryProfile = (canvasView, payload) =>
                mountCanvasLibraryProfile(this, canvasView, payload);
            canvas.unmountCanvasLibraryProfile = (canvasView) =>
                unmountCanvasLibraryProfile(canvasView);
            canvas.isCanvasLibraryProfileMounted = (canvasView) =>
                isCanvasLibraryProfileMounted(canvasView);
            // NarrativeLab owns the single settings page; Canvas remains an internal feature.
            canvas.addSettingTab = () => undefined;

            // Enter the real Component lifecycle so unload() disposes the embedded
            // view, commands, extension associations, and event registrations.
            // Component.load() does not await an async onload(), so capture it here.
            const moduleOnload = canvas.onload.bind(canvas);
            let loadPromise: Promise<void> | undefined;
            canvas.onload = () => {
                loadPromise = Promise.resolve(moduleOnload()).then(() => undefined);
                return loadPromise;
            };
            canvas.load();
            const pending = loadPromise;
            if (!pending) {
                canvas.unload();
                throw new Error(t('Narrative Canvas did not finish loading.'));
            }
            try {
                await pending;
            } catch (error) {
                canvas.unload();
                throw error;
            }
            this.canvasModule = canvas;
            (window as unknown as {
                NarrativeCanvasApp?: { refreshLibraryCategories?: () => unknown };
            }).NarrativeCanvasApp?.refreshLibraryCategories?.();
        })();
        try {
            await this._canvasModuleLoading;
        } finally {
            this._canvasModuleLoading = null;
        }
    }

    /** Create a native .canvas board for a Library note (Character / Codex entry). */
    async createLibraryEntityBoard(entry: CreateLibraryEntityBoardEntry): Promise<string> {
        return this.libraryEntityBoard.createBoard(entry, {
            fallbackProjectRoot: this.getProjectBaseFolder(),
        });
    }

    findLibraryEntityBoard(notePath: string, displayName?: string): string | null {
        return this.libraryEntityBoard.findLinkedBoard(notePath, displayName);
    }

    async openLibraryEntityBoard(notePath: string, displayName?: string): Promise<string | null> {
        const path = this.findLibraryEntityBoard(notePath, displayName);
        if (!path) return null;
        await this.libraryEntityBoard.openBoard(path);
        return path;
    }

    /** Resolve .ncanvas paths for a NarrativeLab project (project-root Canvas/). */
    getNcanvasPathsForProject(project: StoryLineProject): { canvasFolder: string; candidates: string[] } {
        const folders = deriveProjectFoldersFromFilePath(project.filePath);
        const canvasFolder = normalizePath(folders.canvasFolder);
        const legacySystemNCanvasFolder = normalizePath(`${folders.baseFolder}/${LEGACY_SYSTEM_NCANVAS_FOLDER}`);
        const legacyNCanvasFolder = normalizePath(`${folders.baseFolder}/${LEGACY_NCANVAS_FOLDER}`);
        const baseFolder = normalizePath(folders.baseFolder);
        const isNcanvas = (file: TFile) => ['ncanvas', 'narrativecanvas'].includes(file.extension.toLowerCase());
        const belongsToProject = (path: string): boolean => {
            const normalized = normalizePath(path);
            const slash = normalized.lastIndexOf('/');
            const parent = slash >= 0 ? normalized.slice(0, slash) : '';
            return parent === canvasFolder
                || parent === legacySystemNCanvasFolder
                || parent === legacyNCanvasFolder
                || parent === baseFolder;
        };
        const filesInFolder = (folder: string) => this.app.vault.getFiles()
            .filter(file => {
                const slash = file.path.lastIndexOf('/');
                const parent = slash >= 0 ? file.path.slice(0, slash) : '';
                return parent === folder && isNcanvas(file);
            })
            .map(file => file.path)
            .sort((a, b) => a.localeCompare(b));

        const inCanvasFolder = filesInFolder(canvasFolder);
        const inLegacySystemNCanvas = filesInFolder(legacySystemNCanvasFolder);
        const inLegacyCanvas = filesInFolder(legacyNCanvasFolder);
        const legacyInBase = this.app.vault.getFiles()
            .filter(file => {
                const slash = file.path.lastIndexOf('/');
                const parent = slash >= 0 ? file.path.slice(0, slash) : '';
                return parent === baseFolder && isNcanvas(file);
            })
            .map(file => file.path)
            .sort((a, b) => a.localeCompare(b));

        const canvasData = this.settings.narrativeCanvasData as { settings?: { currentProjectPath?: string } } | undefined;
        const remembered = normalizePath(String(canvasData?.settings?.currentProjectPath || ''));
        const projectRemembered = normalizePath(String(
            this.settings.narrativeCanvasPathByProject?.[project.filePath] || '',
        ));
        const ordered = [...new Set([
            ...(projectRemembered && belongsToProject(projectRemembered)
                && this.app.vault.getAbstractFileByPath(projectRemembered) ? [projectRemembered] : []),
            ...(remembered && belongsToProject(remembered)
                && this.app.vault.getAbstractFileByPath(remembered) ? [remembered] : []),
            ...inCanvasFolder,
            ...inLegacySystemNCanvas,
            ...inLegacyCanvas,
            ...legacyInBase,
        ])];

        return { canvasFolder, candidates: ordered };
    }

    /** Create nested vault folders as needed (e.g. project-root NCanvas). */
    private async ensureVaultFolder(folder: string): Promise<void> {
        if (this.sceneManager.isDeletedProjectPath(folder)) return;
        const adapter = this.app.vault.adapter;
        const parts = normalizePath(folder).split('/').filter(Boolean);
        let cur = '';
        for (const part of parts) {
            cur = cur ? `${cur}/${part}` : part;
            if (this.sceneManager.isDeletedProjectPath(cur)) return;
            if (await adapter.exists(cur)) continue;
            try {
                await this.app.vault.createFolder(cur);
            } catch {
                // Race with another writer — continue only if the folder now exists.
                if (!(await adapter.exists(cur))) {
                    throw new Error(`Could not create folder: ${cur}`);
                }
            }
        }
    }

    /** Open the project-local Canvas card box. Kept as the public manager alias. */
    openNCanvasManager(): void {
        if (!this.sceneManager.activeProject) {
            new Notice(t('No active project. Open a project first.'));
            return;
        }
        void this.openNCanvasLibrary();
    }

    /** Open the Canvas card box, optionally replacing the supplied NarrativeLab leaf. */
    async openNCanvasLibrary(projectFile?: string | null, targetLeaf?: WorkspaceLeaf | null): Promise<void> {
        const projectPath = normalizePath(String(
            projectFile || this.sceneManager.activeProject?.filePath || '',
        ));
        if (!projectPath) {
            new Notice(t('No active project. Open a project first.'));
            return;
        }
        if (targetLeaf) {
            await targetLeaf.setViewState({
                type: NCANVAS_LIBRARY_VIEW_TYPE,
                active: true,
                state: narrativeLabLeafState(projectPath),
            });
            this.app.workspace.revealLeaf(targetLeaf);
            return;
        }
        await this.activateView(NCANVAS_LIBRARY_VIEW_TYPE, projectPath);
    }

    /** Return from an embedded canvas to the owning project's card box in the same tab. */
    async openNCanvasLibraryForCanvasPath(canvasPath?: string): Promise<void> {
        const normalized = normalizePath(String(canvasPath || ''));
        const project = this.sceneManager.getProjects().find(candidate =>
            this.getNcanvasPathsForProject(candidate).candidates
                .some(path => normalizePath(path) === normalized),
        ) || this.sceneManager.activeProject;
        if (!project) {
            new Notice(t('No active project. Open a project first.'));
            return;
        }
        const leaf = this.app.workspace.getLeavesOfType(NARRATIVE_CANVAS_VIEW_TYPE).find(candidate => {
            const state = candidate.getViewState()?.state as { file?: unknown; path?: unknown } | undefined;
            const statePath = typeof state?.file === 'string'
                ? state.file
                : (typeof state?.path === 'string' ? state.path : '');
            return normalizePath(statePath) === normalized;
        }) || null;
        const existingLibrary = this.app.workspace.getLeavesOfType(NCANVAS_LIBRARY_VIEW_TYPE)
            .find(candidate => getLeafNarrativeLabProjectFile(candidate) === normalizePath(project.filePath));
        if (existingLibrary) {
            await (existingLibrary.view as unknown as { refresh?: () => Promise<void> }).refresh?.();
            this.app.workspace.revealLeaf(existingLibrary);
            if (leaf) leaf.detach();
            return;
        }
        await this.openNCanvasLibrary(project.filePath, leaf);
    }

    /** Unified converter (manuscript export / project bundle / plotline → ncanvas). */
    openConverter(opts?: { tab?: ConverterTab }): void {
        new ConverterModal(this, opts).open();
    }

    /** Unique path under a canvas folder (public for plotline generator). */
    async allocateNcanvasPath(folder: string, filename: string): Promise<string> {
        await this.ensureVaultFolder(folder);
        return this.uniqueNcanvasPath(folder, filename);
    }

    /** Write saved-state JSON to a .ncanvas path, remember it, and open the canvas. */
    async writeAndOpenNcanvas(path: string, savedStateJson: string): Promise<string> {
        const project = this.sceneManager.activeProject;
        const canvas = await this.ensureCanvasModuleReady();
        if (!canvas?.writeAndOpenProjectAtPath) {
            throw new Error(t('Narrative Canvas is still loading.'));
        }
        const parent = path.includes('/') ? path.slice(0, path.lastIndexOf('/')) : '';
        if (parent) await this.ensureVaultFolder(parent);
        const written = await canvas.writeAndOpenProjectAtPath(path, savedStateJson);
        if (project) await this.rememberNcanvasPath(project, written || path);
        return written || path;
    }

    /** Desktop Scrivener import (shared by command + converter). */
    async runScrivenerImport(): Promise<void> {
        const { ScrivenerImporter } = await import('./services/ScrivenerImporter');
        if (!ScrivenerImporter.isAvailable()) {
            new Notice(t('Scrivener import is only available on desktop.'));
            return;
        }
        let remote: { dialog: { showOpenDialog: (opts: unknown) => Promise<{ canceled: boolean; filePaths?: string[] }> } } | undefined;
        const win = window as unknown as { require?: (m: string) => unknown };
        try { remote = win.require?.('@electron/remote') as typeof remote; }
        catch { try { remote = (win.require?.('electron') as { remote: typeof remote })?.remote; } catch { /* */ } }
        if (!remote) { new Notice(t('File dialog not available.')); return; }

        const result = await remote.dialog.showOpenDialog({
            title: t('Select Scrivener Project (.scriv)'),
            properties: ['openDirectory', 'openFile'],
            filters: [
                { name: 'Scrivener Project', extensions: ['scriv'] },
            ],
        });
        if (result.canceled || !result.filePaths?.length) return;
        const scrivPath = result.filePaths[0];
        if (!scrivPath.endsWith('.scriv')) {
            new Notice(t('Please select a .scriv folder.')); return;
        }
        new Notice(t('Importing Scrivener project…'));
        try {
            const importer = new ScrivenerImporter(this.app, this);
            const r = await importer.import(scrivPath);
            const parts = [`${r.scenesImported} scenes`, `${r.charactersImported} characters`, `${r.locationsImported} locations`];
            if (r.filesImported > 0) parts.push(`${r.filesImported} files`);
            new Notice(t('Imported "{title}": {parts}', { title: r.projectTitle, parts: parts.join(', ') }), 8000);
        } catch (err: unknown) {
            new Notice(t('Import failed: ') + (err instanceof Error ? err.message : String(err)));
        }
    }

    async ensureCanvasModuleReady(): Promise<EmbeddedCanvasModule | null> {
        if (!this.canvasModule) {
            try {
                await this.loadEmbeddedCanvas();
            } catch (err) {
                console.error('NarrativeLab: canvas load failed', err);
                new Notice(t('Failed to open Narrative Canvas: {err}', { err: String(err) }));
                return null;
            }
        }
        if (!this.canvasModule) {
            new Notice(t('Narrative Canvas is still loading.'));
            return null;
        }
        return this.canvasModule;
    }

    private async uniqueNcanvasPath(folder: string, filename: string): Promise<string> {
        const adapter = this.app.vault.adapter;
        const safeName = filename.replace(/[\\/:*?"<>|]/g, '-');
        let path = normalizePath(`${folder}/${safeName}`);
        if (!await adapter.exists(path)) return path;
        const match = safeName.match(/^(.*?)(\.[^.]+)$/);
        const base = match?.[1] || safeName;
        const ext = match?.[2] || '';
        let index = 2;
        while (await adapter.exists(normalizePath(`${folder}/${base}-${index}${ext}`))) {
            index += 1;
        }
        return normalizePath(`${folder}/${base}-${index}${ext}`);
    }

    private async rememberNcanvasPath(project: StoryLineProject, path: string): Promise<void> {
        this.settings.narrativeCanvasPathByProject = {
            ...(this.settings.narrativeCanvasPathByProject || {}),
            [project.filePath]: path,
        };
        await this.saveSettings();
    }

    private requireActiveProjectNcanvas(path: string): { project: StoryLineProject; file: TFile } {
        const project = this.sceneManager.activeProject;
        const normalized = normalizePath(path);
        const allowed = project && this.getNcanvasPathsForProject(project).candidates
            .some(candidate => normalizePath(candidate) === normalized);
        const file = this.app.vault.getAbstractFileByPath(normalized);
        if (!project || !allowed || !(file instanceof TFile)) {
            throw new Error(t('This canvas is not part of the active project.'));
        }
        return { project, file };
    }

    /** Rename a project canvas without overwriting another file. */
    async renameNcanvasInActiveProject(path: string, requestedName: string): Promise<string> {
        const { project, file } = this.requireActiveProjectNcanvas(path);
        const title = String(requestedName || '').trim();
        if (!title) throw new Error(t('Enter a canvas name.'));
        const safeTitle = title.replace(/[\\/:*?"<>|]/g, '-').replace(/\.n(?:arrative)?canvas$/i, '').trim();
        if (!safeTitle) throw new Error(t('Enter a canvas name.'));
        const parent = file.parent?.path || '';
        const intended = normalizePath(`${parent}/${safeTitle}.ncanvas`);
        if (intended === normalizePath(file.path)) return intended;
        const destination = await this.uniqueNcanvasPath(parent, `${safeTitle}.ncanvas`);
        await this.app.fileManager.renameFile(file, destination);
        if (normalizePath(String(this.settings.narrativeCanvasPathByProject?.[project.filePath] || ''))
            === normalizePath(path)) {
            await this.rememberNcanvasPath(project, destination);
        }
        new Notice(t('Renamed canvas to {name}', { name: destination.split('/').pop() || destination }));
        return destination;
    }

    /** Move one project canvas to Obsidian's configured trash and forget stale selection state. */
    async deleteNcanvasInActiveProject(path: string): Promise<void> {
        const { project, file } = this.requireActiveProjectNcanvas(path);
        const normalized = normalizePath(file.path);
        const matchingLeaves = this.app.workspace.getLeavesOfType(NARRATIVE_CANVAS_VIEW_TYPE)
            .filter(leaf => {
                const state = leaf.getViewState()?.state as { file?: unknown; path?: unknown } | undefined;
                const statePath = typeof state?.file === 'string'
                    ? state.file
                    : (typeof state?.path === 'string' ? state.path : '');
                return normalizePath(statePath) === normalized;
            });
        for (const leaf of matchingLeaves) {
            await leaf.setViewState({
                type: NCANVAS_LIBRARY_VIEW_TYPE,
                active: false,
                state: narrativeLabLeafState(project.filePath),
            });
        }
        await this.app.fileManager.trashFile(file);

        const remembered = normalizePath(String(
            this.settings.narrativeCanvasPathByProject?.[project.filePath] || '',
        ));
        if (remembered === normalized) {
            const next = this.getNcanvasPathsForProject(project).candidates
                .find(candidate => normalizePath(candidate) !== normalized);
            this.settings.narrativeCanvasPathByProject = {
                ...(this.settings.narrativeCanvasPathByProject || {}),
            };
            if (next) this.settings.narrativeCanvasPathByProject[project.filePath] = next;
            else delete this.settings.narrativeCanvasPathByProject[project.filePath];
            await this.saveSettings();
        }
        new Notice(t('Moved canvas to trash: {name}', { name: file.name }));
    }

    /** Create a blank .ncanvas in the active project's NCanvas folder and open it. */
    async createBlankNcanvasInActiveProject(name?: string): Promise<string | null> {
        const project = this.sceneManager.activeProject;
        if (!project) {
            new Notice(t('No active project. Open a project first.'));
            return null;
        }
        const canvas = await this.ensureCanvasModuleReady();
        if (!canvas?.openOrCreateProjectAtPath) {
            new Notice(t('Narrative Canvas is still loading.'));
            return null;
        }
        const { canvasFolder } = this.getNcanvasPathsForProject(project);
        await this.ensureVaultFolder(canvasFolder);
        const title = String(name || '').trim() || t('Untitled Canvas');
        const safeTitle = title.replace(/[\\/:*?"<>|]/g, '-');
        const path = await this.uniqueNcanvasPath(canvasFolder, `${safeTitle}.ncanvas`);
        await canvas.openOrCreateProjectAtPath(path, title);
        await this.rememberNcanvasPath(project, path);
        new Notice(t('Created ncanvas: {name}', { name: path.split('/').pop() || path }));
        return path;
    }

    /** Create or open the built-in guide sample (.ncanvas) in the active project's NCanvas folder. */
    async createSampleNcanvasInActiveProject(language: SampleNcanvasLanguage): Promise<string | null> {
        const project = this.sceneManager.activeProject;
        if (!project) {
            new Notice(t('No active project. Open a project first.'));
            return null;
        }
        const canvas = await this.ensureCanvasModuleReady();
        if (!canvas?.createSampleProjectAtPath) {
            new Notice(t('Narrative Canvas is still loading.'));
            return null;
        }
        const { canvasFolder } = this.getNcanvasPathsForProject(project);
        await this.ensureVaultFolder(canvasFolder);
        const filename = SAMPLE_NCANVAS_FILENAMES[language];
        const path = normalizePath(`${canvasFolder}/${filename}`);
        const created = await canvas.createSampleProjectAtPath(path, language);
        await this.rememberNcanvasPath(project, created || path);
        new Notice(t('Opened sample ncanvas: {name}', {
            name: (created || path).split('/').pop() || path,
        }));
        return created || path;
    }

    async openNarrativeCanvas(preferredPath?: string): Promise<void> {
        const canvas = await this.ensureCanvasModuleReady();
        if (!canvas) return;
        const project = this.sceneManager.activeProject;
        if (project && canvas.openOrCreateProjectAtPath) {
            const { canvasFolder, candidates } = this.getNcanvasPathsForProject(project);
            const adapter = this.app.vault.adapter;
            await this.ensureVaultFolder(canvasFolder);
            // Match the manually renamed project manifest/folder, while keeping
            // frontmatter `title` as the human-readable canvas title.
            const manifestName = project.filePath.split('/').pop()?.replace(/\.md$/i, '') || project.title;
            const safeTitle = manifestName.replace(/[\\/:*?"<>|]/g, '-');
            const normalizedPreferred = preferredPath ? normalizePath(preferredPath) : '';
            const preferredParent = normalizedPreferred.includes('/')
                ? normalizedPreferred.slice(0, normalizedPreferred.lastIndexOf('/'))
                : '';
            const projectBase = deriveProjectFoldersFromFilePath(project.filePath).baseFolder;
            const preferredBelongsToProject = preferredParent === canvasFolder
                || preferredParent === normalizePath(`${projectBase}/${LEGACY_SYSTEM_NCANVAS_FOLDER}`)
                || preferredParent === normalizePath(`${projectBase}/${LEGACY_NCANVAS_FOLDER}`)
                || preferredParent === projectBase;
            const path = (normalizedPreferred && preferredBelongsToProject && await adapter.exists(normalizedPreferred))
                ? normalizedPreferred
                : candidates[0] ?? normalizePath(`${canvasFolder}/${safeTitle}.ncanvas`);
            await canvas.openOrCreateProjectAtPath(path, project.title);
            await this.rememberNcanvasPath(project, path);
            return;
        }
        await canvas.openCanvas?.();
    }

    /** Keep an already-open Canvas leaf aligned with the newly active project. */
    async syncNarrativeCanvasToActiveProject(): Promise<void> {
        if (!this.canvasModule) return;
        const leaf = this.app.workspace.getLeavesOfType(NARRATIVE_CANVAS_VIEW_TYPE)[0];
        const project = this.sceneManager.activeProject;
        if (!leaf || !project) return;
        // A project switch must not guess which of several canvases to enter.
        await this.openNCanvasLibrary(project.filePath, leaf);
    }

    /**
     * Recursively route every markdown note in the active Library by its
     * frontmatter type. Category folders are conventions, not read barriers:
     * entries may live at the Library root or in any depth of subfolder.
     */
    private async scanLibraryFolder(
        folderPath: string,
        options: { skipLoaded?: boolean } = {},
    ): Promise<void> {
        const skipLoaded = options.skipLoaded === true;
        const libraryRoot = normalizePath(folderPath);
        const alreadyLoaded = (filePath: string): boolean =>
            !!this.codexManager.getEntry(filePath)
            || !!this.characterManager.getCharacter(filePath)
            || !!this.locationManager.getItem(filePath);
        const files = await collectMarkdownFiles(this.app, folderPath);
        for (const file of files) {
            try {
                const filePath = normalizePath(file.path);
                if (parentOfPath(filePath) === libraryRoot) continue;
                // After loadAll / loadCharacters / loadAll locations, category
                // folders were already read — skip those files to cut I/O ~2×.
                if (skipLoaded && alreadyLoaded(filePath)) continue;
                const content = await readVaultText(this.app, file);
                const type = this.extractFrontmatterType(content);
                if (!type) continue;
                if (type === 'character') this.characterManager.addFile(content, filePath);
                else if (type === 'location' || type === 'world') this.locationManager.addFile(content, filePath);
                else if (
                    type !== 'scene'
                    && type !== 'narrative-lab'
                    && type !== 'storyline'
                    && type !== UNCATEGORIZED_CATEGORY_ID
                ) {
                    this.codexManager.addFile(content, filePath);
                }
            } catch { /* unreadable Library entry */ }
        }
    }

    claimPlotlineRegistry(projectFile: string): void {
        this.plotlineRegistryOwner = projectFile ? normalizePath(projectFile) : '';
    }

    /**
     * Swap the in-memory plotline registry to the target project before any
     * await. Restores a cached snapshot when available; otherwise clears so
     * the previous project's thread names cannot paint or save as this one.
     */
    adoptPlotlineRegistryForProject(projectFile: string): void {
        const key = normalizePath(projectFile);
        if (!key) {
            this.plotlineDefinitions = [];
            this.plotlineRegistryOwner = '';
            this.plotlineManager?.markLoaded(false);
            return;
        }
        const cached = this._projectRuntimeCache.get(key);
        if (cached) {
            this.plotlineDefinitions = clonePlotlineDefinitions(cached.plotlineDefinitions);
            this.plotlineRegistryOwner = cached.plotlineRegistryOwner || key;
            this.settings.tagColors = { ...cached.tagColors };
            this.settings.tagTypeOverrides = { ...cached.tagTypeOverrides };
            this.plotlineManager?.markLoaded(this.plotlineDefinitions.length > 0);
            return;
        }
        this.plotlineDefinitions = [];
        this.plotlineRegistryOwner = key;
        this.plotlineManager?.markLoaded(false);
    }

    stashProjectRuntime(projectFile: string): void {
        const key = normalizePath(projectFile);
        if (!key) return;
        this._projectRuntimeCache.set(key, {
            scenes: this.sceneManager.exportSceneIndex(),
            characters: this.characterManager.exportSnapshot(),
            locations: this.locationManager.exportSnapshot(),
            codex: this.codexManager.exportSnapshot(),
            research: this.researchManager.exportSnapshot(),
            plotlineDefinitions: clonePlotlineDefinitions(this.plotlineDefinitions),
            plotlineRegistryOwner: this.plotlineRegistryOwner || key,
            tagColors: { ...(this.settings.tagColors || {}) },
            tagTypeOverrides: { ...(this.settings.tagTypeOverrides || {}) },
        });
    }

    restoreProjectRuntime(projectFile: string): boolean {
        const key = normalizePath(projectFile);
        const snapshot = this._projectRuntimeCache.get(key);
        if (!snapshot) return false;
        this.sceneManager.restoreSceneIndex(snapshot.scenes);
        this.characterManager.restoreSnapshot(snapshot.characters);
        this.locationManager.restoreSnapshot(snapshot.locations);
        this.codexManager.restoreSnapshot(snapshot.codex);
        this.researchManager.restoreSnapshot(snapshot.research);
        this.plotlineDefinitions = clonePlotlineDefinitions(snapshot.plotlineDefinitions);
        this.plotlineRegistryOwner = snapshot.plotlineRegistryOwner || key;
        this.settings.tagColors = { ...snapshot.tagColors };
        this.settings.tagTypeOverrides = { ...snapshot.tagTypeOverrides };
        this.plotlineManager?.markLoaded(this.plotlineDefinitions.length > 0);
        const customDefs = (this.settings.codexCustomCategories || []).map(
            (cc: { id: string; label: string; icon: string }) =>
                makeProfileCodexCategory(cc.id, cc.label, cc.icon),
        );
        this.codexManager.initCategories(this.settings.codexEnabledCategories || [], customDefs);
        return true;
    }

    invalidateForeignProjectRuntimeCache(filePath: string): void {
        const projectFile = this.findProjectFileForVaultPath(filePath);
        if (!projectFile) return;
        const active = this.sceneManager.activeProject?.filePath
            ? normalizePath(this.sceneManager.activeProject.filePath)
            : '';
        if (active && active === projectFile) return;
        this._projectRuntimeCache.delete(projectFile);
    }

    /**
     * Reload characters and locations from the active project's Codex
     * folders, then scan series-local Library folders if applicable. Used by
     * `reloadEntities()` and the bootstrap path.
     *
     * `loadCharacters`/`loadAll` clear the manager first, so callers that
     * also want external Additional Source Folder entries must run
     * `scanExtraFolders()` afterwards.
     */
    async loadActiveProjectEntities(): Promise<void> {
        const adapter = this.app.vault.adapter;
        void this.migratePlotGridToLibraryIfNeeded().catch(() => undefined);

        const locFolder = this.sceneManager.getLocationFolder();
        const charFolder = this.sceneManager.getCharacterFolder();
        await Promise.all([
            locFolder ? this.locationManager.loadAll(locFolder) : Promise.resolve(),
            charFolder ? this.characterManager.loadCharacters(charFolder) : Promise.resolve(),
        ]);

        // Series mode: also scan the per-project Library folder for book-only
        // characters and locations.
        if (!this.sceneManager.getSeriesFolder()) return;

        const localCharFolder = this.sceneManager.getProjectLocalCharacterFolder();
        const localLocFolder = this.sceneManager.getProjectLocalLocationFolder();
        const scanLocalChars = async (): Promise<void> => {
            if (!localCharFolder || localCharFolder === charFolder || !await adapter.exists(localCharFolder)) return;
            const listing = await adapter.list(localCharFolder);
            for (const f of listing.files) {
                if (!f.toLowerCase().endsWith('.md') || isExcalidrawFilePath(f)) continue;
                try {
                    const fp = normalizePath(f);
                    const content = await adapter.read(fp);
                    this.characterManager.addFile(content, fp);
                } catch { /* skip unreadable */ }
            }
        };
        const scanLocalLocs = async (): Promise<void> => {
            if (!localLocFolder || localLocFolder === locFolder) return;
            const scanLoc = async (folder: string): Promise<void> => {
                if (!await adapter.exists(folder)) return;
                const listing = await adapter.list(folder);
                for (const f of listing.files) {
                    if (!f.toLowerCase().endsWith('.md') || isExcalidrawFilePath(f)) continue;
                    try {
                        const fp = normalizePath(f);
                        const content = await adapter.read(fp);
                        this.locationManager.addFile(content, fp);
                    } catch { /* skip unreadable */ }
                }
                for (const sub of listing.folders) {
                    await scanLoc(normalizePath(sub));
                }
            };
            await scanLoc(localLocFolder);
        };
        await Promise.all([scanLocalChars(), scanLocalLocs()]);
    }

    /**
     * Recursively scan user-configured extra folders and route each .md
     * file to the appropriate manager based on its frontmatter type: field.
     */
    async scanExtraFolders(): Promise<void> {
        const folders = this.settings.extraFolders;
        if (!folders || folders.length === 0) return;

        const adapter = this.app.vault.adapter;
        // Resolve the vault root once so we can convert absolute OS paths
        // (e.g. "C:/Users/.../MyFolder" on Windows or "/Users/.../MyFolder"
        // on macOS/Linux) into vault-relative paths that the adapter
        // understands. On mobile the adapter basePath may be empty, in
        // which case we fall back to using the path as-is.
        let vaultRoot = '';
        try {
            if (typeof (adapter as unknown as { getBasePath?: () => string }).getBasePath === 'function') {
                vaultRoot = (adapter as unknown as { getBasePath: () => string }).getBasePath();
            }
        } catch { /* mobile / unsupported — leave vaultRoot empty */ }

        const toVaultRelative = (p: string): string => {
            if (!vaultRoot) return normalizePath(p);
            // Normalise separators so the comparison works cross-platform.
            const normRoot = vaultRoot.replace(/\\/g, '/').replace(/\/+$/, '');
            const normPath = p.replace(/\\/g, '/').replace(/^\/+/, '');
            if (normPath.toLowerCase().startsWith(normRoot.toLowerCase() + '/')) {
                return normalizePath(normPath.slice(normRoot.length + 1));
            }
            if (normPath.toLowerCase() === normRoot.toLowerCase()) {
                return '';
            }
            // Already vault-relative (or an unknown absolute path) — normalise
            // and let adapter.exists decide.
            return normalizePath(p);
        };

        const scan = async (folderPath: string): Promise<void> => {
            // Convert absolute OS paths to vault-relative, then normalise
            // (strips leading/trailing slashes, converts backslashes) so
            // adapter.exists() doesn't silently fail.
            const normalized = toVaultRelative(folderPath);
            if (!normalized || !await adapter.exists(normalized)) return;
            const listing = await adapter.list(normalized);
            for (const f of listing.files) {
                if (!f.endsWith('.md')) continue;
                try {
                    const fp = normalizePath(f);
                    const content = await adapter.read(fp);
                    const type = this.extractFrontmatterType(content);
                    if (!type) continue;
                    switch (type) {
                        case 'scene':
                            this.sceneManager.addFile(content, fp);
                            break;
                        case 'character':
                            this.characterManager.addFile(content, fp);
                            break;
                        case 'location':
                        case 'world':
                            this.locationManager.addFile(content, fp);
                            break;
                        default:
                            if (type === UNCATEGORIZED_CATEGORY_ID) break;
                            this.codexManager.addFile(content, fp);
                            break;
                    }
                } catch { /* skip unreadable */ }
            }
            for (const sub of listing.folders) {
                await scan(normalizePath(sub));
            }
        };

        for (const folder of folders) {
            if (folder) await scan(folder);
        }
    }

    /**
     * Convert an absolute OS filesystem path to a vault-relative path that
     * Obsidian's vault adapter understands. Works cross-platform (Windows,
     * macOS, Linux). If the path is already vault-relative (or the vault
     * root cannot be determined, e.g. on mobile), the path is normalised
     * and returned as-is.
     */
    toVaultRelativePath(p: string): string {
        const adapter = this.app.vault.adapter;
        let vaultRoot = '';
        try {
            if (typeof (adapter as unknown as { getBasePath?: () => string }).getBasePath === 'function') {
                vaultRoot = (adapter as unknown as { getBasePath: () => string }).getBasePath();
            }
        } catch { /* mobile / unsupported */ }
        if (!vaultRoot) return normalizePath(p);
        const normRoot = vaultRoot.replace(/\\/g, '/').replace(/\/+$/, '');
        const normPath = p.replace(/\\/g, '/').replace(/^\/+/, '');
        if (normPath.toLowerCase().startsWith(normRoot.toLowerCase() + '/')) {
            return normalizePath(normPath.slice(normRoot.length + 1));
        }
        if (normPath.toLowerCase() === normRoot.toLowerCase()) {
            return '';
        }
        return normalizePath(p);
    }

    /**
     * Quick extraction of the type: field from frontmatter.
     */
    private extractFrontmatterType(content: string): string | null {
        const clean = content.replace(/[\u200B-\u200F\u2028-\u202F\uFEFF]/g, '');
        const match = clean.match(/^---\r?\n([\s\S]*?)\r?\n---/);
        if (!match) return null;
        try {
            const fm = parseYaml(match[1]);
            return fm?.type ?? null;
        } catch {
            return null;
        }
    }

    /**
     * Refresh all open Scene Cards views
     */
    async refreshOpenViews(): Promise<void> {
        return this.enqueueOpenViewsRefresh(true);
    }

    /**
     * Lightweight refresh after scene/note body edits — skip Library entity reload
     * and full wikilink rescan (scene index already updated via handleFileChange).
     */
    async refreshViewsOnly(): Promise<void> {
        return this.enqueueOpenViewsRefresh(false);
    }

    /** Coalesce refresh storms without dropping changes that arrive mid-refresh. */
    private enqueueOpenViewsRefresh(full: boolean): Promise<void> {
        if (full || this._pendingOpenViewsRefresh === 'none') {
            this._pendingOpenViewsRefresh = full ? 'full' : 'views';
        }
        if (!this._refreshOpenViewsPromise) {
            this._refreshOpenViewsPromise = this.drainOpenViewsRefreshQueue()
                .finally(() => {
                    this._refreshOpenViewsPromise = null;
                    if (this._pendingOpenViewsRefresh !== 'none') {
                        void this.enqueueOpenViewsRefresh(
                            this._pendingOpenViewsRefresh === 'full',
                        );
                    }
                });
        }
        return this._refreshOpenViewsPromise;
    }

    private async drainOpenViewsRefreshQueue(): Promise<void> {
        while (this._pendingOpenViewsRefresh !== 'none') {
            const requested = this._pendingOpenViewsRefresh;
            this._pendingOpenViewsRefresh = 'none';
            await this.doRefreshOpenViews(requested === 'full');
        }
    }

    private async doRefreshOpenViews(full: boolean): Promise<void> {
        if (full) {
            // Single entity reload — views must not call reloadEntities() again in refresh().
            try {
                await this.reloadEntities();
            } catch { /* project may not be set yet */ }

            // Re-scan wikilinks after entity data is loaded
            this.linkScanner.invalidateAll();
            this.linkScanner.rebuildLookups(this.settings.characterAliases);
            this.linkScanner.scanAll(this.sceneManager.getAllScenes());

            // Update codex digests (baseline new entries, prune deleted ones)
            void this.refreshCodexDigests();

            // Drop plotgrid mention cache — Library/datasheet path is per-project.
            this.invalidatePlotGridScanCache();
            void this.migratePlotGridToLibraryIfNeeded().catch(() => undefined);
        }

        // Flush writing tracker so daily stats update in real-time
        this.flushWritingTrackers();

        const viewTypes = [
            BOARD_VIEW_TYPE,
            PLOTGRID_VIEW_TYPE,
            TIMELINE_VIEW_TYPE,
            STORYLINE_VIEW_TYPE,
            CHARACTER_VIEW_TYPE,
            LOCATION_VIEW_TYPE,
            CODEX_VIEW_TYPE,
            STATS_VIEW_TYPE,
            NAVIGATOR_VIEW_TYPE,
            MANUSCRIPT_VIEW_TYPE,
            RESEARCH_VIEW_TYPE,
            WRITING_TRACKER_PANEL_TYPE,
            WRITING_TRACKER_VIEW_TYPE,
            SCENE_INSPECTOR_VIEW_TYPE,
            DETAILS_VIEW_TYPE,
            NOTES_VIEW_TYPE,
            SYNOPSIS_VIEW_TYPE,
        ];

        const activePath = this.sceneManager.activeProject?.filePath
            ? normalizePath(this.sceneManager.activeProject.filePath)
            : null;
        const refreshTasks: Promise<void>[] = [];
        for (const viewType of viewTypes) {
            const leaves = this.app.workspace.getLeavesOfType(viewType);
            for (const leaf of leaves) {
                const bound = getLeafNarrativeLabProjectFile(leaf);
                // Keep other projects' tabs intact, and never refresh a
                // project-bound tab while no live project is active.
                if (bound && (!activePath || bound !== activePath)) {
                    continue;
                }
                refreshTasks.push((async () => {
                    const view = leaf.view as unknown as {
                        refresh?: (options?: { reloadFromDisk?: boolean }) => void | Promise<void>;
                    };
                    if (view && typeof view.refresh === 'function') {
                        try {
                            await Promise.resolve(view.refresh());
                        } catch { /* non-fatal per view */ }
                    }
                    // Title follows the leaf binding, not whichever project is focused.
                    const projectLabel = this.getProjectDisplayName(bound);
                    leaf.view.containerEl
                        .querySelectorAll('.story-line-view-title')
                        .forEach(el => { el.textContent = projectLabel; });
                    // Update the tab title so it reflects the project immediately.
                    (leaf as unknown as { updateHeader?: () => void }).updateHeader?.();
                })());
            }
        }
        await Promise.allSettled(refreshTasks);
    }

    /** Refresh Plot Grid leaves for the project that owns `changedPath`. */
    private async refreshPlotGridViews(changedPath?: string): Promise<void> {
        const activePath = this.sceneManager.activeProject?.filePath
            ? normalizePath(this.sceneManager.activeProject.filePath)
            : null;
        const targetProject = changedPath
            ? this.findProjectFileForVaultPath(changedPath)
            : activePath;
        const leaves = this.app.workspace.getLeavesOfType(PLOTGRID_VIEW_TYPE);
        for (const leaf of leaves) {
            const bound = getLeafNarrativeLabProjectFile(leaf);
            if (bound) {
                if (targetProject && bound !== targetProject) continue;
                if (!targetProject && activePath && bound !== activePath) continue;
            } else if (targetProject && activePath && targetProject !== activePath) {
                continue;
            }
            const view = leaf.view as unknown as {
                refresh?: (options?: { reloadFromDisk?: boolean }) => void | Promise<void>;
            };
            if (view && typeof view.refresh === 'function') {
                try {
                    await Promise.resolve(view.refresh({ reloadFromDisk: true }));
                } catch { /* non-fatal */ }
            }
        }
    }

    /**
     * Update any PlotGrid cell linkedSceneId references when a vault file is renamed.
     * Without this, cells that link to the old path become stale.
     */
    private async updatePlotGridLinkedSceneIds(oldPath: string, newPath: string): Promise<void> {
        try {
            const projectFile = this.findProjectFileForVaultPath(newPath)
                || this.findProjectFileForVaultPath(oldPath);
            if (!projectFile) return;
            const data = await this.loadPlotGrid(projectFile);
            if (!data?.pages?.length) return;

            let dirty = false;
            for (const page of data.pages) {
                for (const key of Object.keys(page.cells || {})) {
                    const cell = page.cells[key];
                    if (cell.linkedSceneId === oldPath) {
                        cell.linkedSceneId = newPath;
                        dirty = true;
                    }
                }
            }

            if (!dirty) return;
            await this.savePlotGrid(data, { projectFilePath: projectFile });
            const target = normalizePath(projectFile);
            for (const leaf of this.app.workspace.getLeavesOfType(PLOTGRID_VIEW_TYPE)) {
                if (getLeafNarrativeLabProjectFile(leaf) !== target) continue;
                const view = leaf.view as unknown as {
                    refresh?: (options?: { reloadFromDisk?: boolean }) => void | Promise<void>;
                };
                if (typeof view.refresh === 'function') {
                    await Promise.resolve(view.refresh({ reloadFromDisk: true }));
                }
            }
        } catch {
            // non-fatal — PlotGrid may not exist yet
        }
    }
    /**
     * Debounce utility
     */
    private debounce<T extends (...args: unknown[]) => unknown>(
        func: T,
        wait: number
    ): T {
        let timeout: number | null = null;
        return ((...args: unknown[]) => {
            if (timeout) window.clearTimeout(timeout);
            timeout = window.setTimeout(() => func(...args), wait);
        }) as unknown as T;
    }

    // ────────────────────────────────────
    //  Project bootstrap & modals
    // ────────────────────────────────────

    /**
     * Migrate legacy project-specific data from data.json into project frontmatter
     * and System/ files.
     *
     * Handles:
     *  - definedActs, definedChapters, filterPresets → project frontmatter
     *  - JSON files at project root → System/ subfolder
     *  - tagColors, tagTypeOverrides → System/plotlines.json
     *  - characterAliases, ignoredCharacters → System/characters.json
     *  - writingTrackerData → System/stats.json
     *
     * After successful migration the legacy keys are removed from data.json.
     */
    private async migrateProjectDataFromSettings(): Promise<void> {
        const rawAny: unknown = await this.loadData();
        if (!rawAny || !isRecord(rawAny)) return;
        const raw = rawAny as Record<string, unknown> & {
            definedActs?: Record<string, unknown>;
            definedChapters?: Record<string, unknown>;
            filterPresets?: unknown[];
            activeProjectFile?: string;
            rows?: unknown[];
            columns?: unknown[];
            cells?: unknown[];
        };

        let dirty = false;
        const adapter = this.app.vault.adapter;

        // ── Phase 1: legacy frontmatter migrations (definedActs, etc.) ──
        if (raw.definedActs && typeof raw.definedActs === 'object') {
            for (const [projectPath, acts] of Object.entries(raw.definedActs)) {
                if (!Array.isArray(acts) || acts.length === 0) continue;
                const project = this.sceneManager.getProjects().find(p => p.filePath === projectPath);
                if (project && project.definedActs.length === 0) {
                    project.definedActs = (acts as number[]).map(Number).filter(n => !isNaN(n));
                    await this.sceneManager.saveProjectFrontmatter(project);
                }
            }
            delete raw.definedActs;
            dirty = true;
        }

        if (raw.definedChapters && typeof raw.definedChapters === 'object') {
            for (const [projectPath, chapters] of Object.entries(raw.definedChapters)) {
                if (!Array.isArray(chapters) || chapters.length === 0) continue;
                const project = this.sceneManager.getProjects().find(p => p.filePath === projectPath);
                if (project && project.definedChapters.length === 0) {
                    project.definedChapters = (chapters as number[]).map(Number).filter(n => !isNaN(n));
                    await this.sceneManager.saveProjectFrontmatter(project);
                }
            }
            delete raw.definedChapters;
            dirty = true;
        }

        if (Array.isArray(raw.filterPresets) && raw.filterPresets.length > 0) {
            const activeProject = this.sceneManager.activeProject;
            if (activeProject && activeProject.filterPresets.length === 0) {
                activeProject.filterPresets = raw.filterPresets as FilterPreset[];
                await this.sceneManager.saveProjectFrontmatter(activeProject);
            }
        }

        for (const legacyKey of ['sceneFolder', 'characterFolder', 'locationFolder', 'plotGridFolder']) {
            if (legacyKey in raw) { delete raw[legacyKey]; dirty = true; }
        }

        // ── Phase 2: move JSON data to System/, but keep NCanvas as project content ──
        try {
            await this.migrateJsonFilesToSystem();
        } catch (e) {
            console.error('[NarrativeLab] migrateJsonFilesToSystem error:', e);
        }
        try {
            await this.migrateNCanvasFoldersToProjectRoot();
        } catch (e) {
            console.error('[NarrativeLab] migrateNCanvasFoldersToProjectRoot error:', e);
        }

        // ── Phase 3: migrate per-project data from data.json → System/ files ──
        // Derive the System folder from the active project path.
        // If no active project, try to derive from activeProjectFile setting.
        let sysFolder: string | null = null;
        const activeProject = this.sceneManager?.activeProject;
        if (activeProject) {
            const base = activeProject.sceneFolder.replace(/\\/g, '/').replace(/\/Scenes\/?$/, '');
            sysFolder = `${base}/System`;
        } else if (raw.activeProjectFile) {
            // Derive from file path: NarrativeLab/Foo/Foo.md → NarrativeLab/Foo/System
            const base = String(raw.activeProjectFile).replace(/\/[^\/]+\.md$/i, '');
            if (base) sysFolder = `${base}/System`;
        }

        // Check if there's actually any per-project data to migrate
        const hasLegacyData = SceneCardsPlugin.PROJECT_DATA_KEYS.some(k => k in raw);

        if (sysFolder && this.sceneManager.isDeletedProjectPath(sysFolder)) {
            sysFolder = null;
        }

        if (sysFolder && hasLegacyData) {
            // Ensure System folder exists
            try {
                if (!await adapter.exists(sysFolder)) {
                    await this.ensureVaultFolder(sysFolder);
                }
            } catch (e) {
                console.error('[NarrativeLab] Migration: failed to create System folder:', e);
            }
            const readExistingMigrationJson = async (
                path: string,
                label: string,
            ): Promise<{ data: Record<string, unknown>; writable: boolean }> => {
                if (!await adapter.exists(path)) return { data: {}, writable: true };
                try {
                    const parsed: unknown = JSON.parse(await this.readVaultTextResilient(path));
                    if (!isRecord(parsed)) throw new Error('Expected a JSON object');
                    return { data: parsed, writable: true };
                } catch (error) {
                    console.warn(`[NarrativeLab] Migration kept unreadable ${label}:`, error);
                    return { data: {}, writable: false };
                }
            };

            // ── plotgrid.json (rows/columns/cells/zoom/stickyHeaders) ──
            // Only write legacy plotgrid data if System/plotgrid.json is empty.
            // If it already has data (e.g. from gen_plotgrid.ps1), keep it.
            if ('rows' in raw || 'columns' in raw || 'cells' in raw) {
                try {
                    const pgPath = `${sysFolder}/plotgrid.json`;
                    let existingHasData = false;
                    if (await adapter.exists(pgPath)) {
                        try {
                            const existing = normalizeConceptGridDocument(JSON.parse(await adapter.read(pgPath)));
                            existingHasData = !isConceptGridDocumentEmpty(existing);
                        } catch { existingHasData = true; }
                    }
                    if (!existingHasData) {
                        const pgData: Record<string, unknown> = {};
                        if (Array.isArray(raw.rows)) pgData.rows = raw.rows;
                        if (Array.isArray(raw.columns)) pgData.columns = raw.columns;
                        if (raw.cells && typeof raw.cells === 'object') pgData.cells = raw.cells;
                        if (raw.zoom !== undefined) pgData.zoom = raw.zoom;
                        if (raw.stickyHeaders !== undefined) pgData.stickyHeaders = raw.stickyHeaders;
                        await this.writeVaultTextResilient(pgPath, JSON.stringify(pgData, null, 2));
                    }
                } catch (e) {
                    console.error('[NarrativeLab] Migration: plotgrid write failed:', e);
                }
            }

            // ── plotlines.json (tagColors, tagTypeOverrides) ──
            // Write from this.settings (the in-memory copy) which has values
            // regardless of whether these keys exist in data.json.
            {
                try {
                    const path = `${sysFolder}/plotlines.json`;
                    const { data: existing, writable } = await readExistingMigrationJson(path, 'plotlines.json');
                    // Merge: use raw (data.json) values if present, else keep existing System file values,
                    // else fall back to in-memory settings (which have defaults).
                    const merged: Record<string, unknown> = {
                        tagColors: raw.tagColors ?? existing.tagColors ?? this.settings.tagColors ?? {},
                        tagTypeOverrides: raw.tagTypeOverrides ?? existing.tagTypeOverrides ?? this.settings.tagTypeOverrides ?? {},
                        definitions: existing.definitions ?? [],
                    };
                    if (writable) {
                        await this.writeVaultTextResilient(path, JSON.stringify(merged, null, 2));
                    }
                } catch (e) {
                    console.error('[NarrativeLab] Migration: plotlines write failed:', e);
                }
            }

            // ── characters.json (characterAliases, ignoredCharacters) ──
            {
                try {
                    const path = `${sysFolder}/characters.json`;
                    const { data: existing, writable } = await readExistingMigrationJson(path, 'characters.json');
                    const merged: Record<string, unknown> = {
                        characterAliases: raw.characterAliases ?? existing.characterAliases ?? this.settings.characterAliases ?? {},
                        ignoredCharacters: raw.ignoredCharacters ?? existing.ignoredCharacters ?? this.settings.ignoredCharacters ?? [],
                    };
                    if (writable) {
                        await this.writeVaultTextResilient(path, JSON.stringify(merged, null, 2));
                    }
                } catch (e) {
                    console.error('[NarrativeLab] Migration: characters write failed:', e);
                }
            }

            // ── stats.json (writingTrackerData) ──
            {
                try {
                    const path = `${sysFolder}/stats.json`;
                    const { data: existing, writable } = await readExistingMigrationJson(path, 'stats.json');
                    const merged: Record<string, unknown> = {
                        writingTrackerData: raw.writingTrackerData ?? existing.writingTrackerData ?? null,
                    };
                    if (writable && merged.writingTrackerData) {
                        await this.writeVaultTextResilient(path, JSON.stringify(merged, null, 2));
                    }
                } catch (e) {
                    console.error('[NarrativeLab] Migration: stats write failed:', e);
                }
            }

            // Keep the legacy payload until loadProjectSystemData() has read
            // and validated every destination. A later normal saveSettings()
            // removes these keys only after System files are authoritative.
            // Do NOT set _systemMigrationDone here — that happens in
            // loadProjectSystemData() which runs next and loads the System
            // file contents into this.settings. Setting the flag here would
            // allow an intervening saveSettings() call to overwrite System
            // files with empty defaults before they're loaded into memory.
        } else if (!sysFolder) {
            console.warn('[NarrativeLab] Migration: no active project, skipping System/ writes');
        } else {
            // No legacy data to migrate — flag set by loadProjectSystemData()
        }

        if (dirty) {
            await this.saveData(raw);
        }
    }

    /**
     * Move legacy JSON files from each project's root folder into its System/ subfolder.
     * Runs once per project; harmless if System/ files already exist.
     */
    private async migrateJsonFilesToSystem(): Promise<void> {
        const adapter = this.app.vault.adapter;
        const jsonFiles = [
            'plotgrid.json', 'timeline.json', 'board.json', 'plotlines.json',
            'stats.json', 'characters.json', 'codex-digests.json', 'manuscript-state.json',
            'field-templates.json',
        ];

        for (const project of this.sceneManager.getProjects()) {
            const baseFolder = project.sceneFolder
                .replace(/\\/g, '/').replace(/\/Scenes\/?$/, '');
            const sysFolder = `${baseFolder}/System`;

            for (const filename of jsonFiles) {
                const oldPath = `${baseFolder}/${filename}`;
                const newPath = `${sysFolder}/${filename}`;

                try {
                    if (!await adapter.exists(oldPath)) continue;
                    // If System/ file already exists, skip (already migrated)
                    if (await adapter.exists(newPath)) {
                        // Delete the old file since System/ version exists
                        const oldFile = this.app.vault.getAbstractFileByPath(oldPath);
                        if (oldFile) await this.app.fileManager.trashFile(oldFile);
                        continue;
                    }

                    // Ensure System/ folder exists
                    await this.ensureVaultFolder(sysFolder);

                    // Read old file content and write to new location
                    const content = await adapter.read(oldPath);
                    await adapter.write(newPath, content);

                    // Delete old file
                    const oldFile = this.app.vault.getAbstractFileByPath(oldPath);
                    if (oldFile) await this.app.fileManager.trashFile(oldFile);
                } catch {
                    /* skip unreadable/unmovable paths */
                }
            }
        }
    }

    /**
     * Move former System/NCanvas/, root NCanvas/, and loose project-root
     * .ncanvas files into the project's authored Canvas/ folder.
     */
    private async migrateNCanvasFoldersToProjectRoot(): Promise<void> {
        const adapter = this.app.vault.adapter;

        for (const project of this.sceneManager.getProjects()) {
            const folders = deriveProjectFoldersFromFilePath(project.filePath);
            const destFolder = normalizePath(folders.canvasFolder);
            const baseFolder = normalizePath(folders.baseFolder);
            const legacyFolders = [
                normalizePath(`${baseFolder}/${LEGACY_SYSTEM_NCANVAS_FOLDER}`),
                normalizePath(`${baseFolder}/${LEGACY_NCANVAS_FOLDER}`), // former root NCanvas/
            ].filter(folder => folder !== destFolder);

            const moveFile = async (fromPath: string) => {
                const name = fromPath.split('/').pop();
                if (!name) return;
                let toPath = normalizePath(`${destFolder}/${name}`);
                try {
                    await this.ensureVaultFolder(destFolder);
                    if (await adapter.exists(toPath)) {
                        // Never discard authored canvases. Preserve both files
                        // when Canvas/ already has the same name.
                        toPath = await this.uniqueNcanvasPath(destFolder, name);
                    }
                    const file = this.app.vault.getAbstractFileByPath(fromPath);
                    if (file instanceof TFile) {
                        await this.app.fileManager.renameFile(file, toPath);
                    } else if (await adapter.exists(fromPath)) {
                        // Binary-safe copy for vault adapter files not yet indexed
                        const data = await adapter.readBinary(fromPath);
                        await adapter.writeBinary(toPath, data);
                        await adapter.remove(fromPath);
                    }
                } catch {
                    /* skip unreadable/unmovable paths */
                }
            };

            for (const legacy of legacyFolders) {
                if (!await adapter.exists(legacy)) continue;
                try {
                    const listing = await adapter.list(legacy);
                    for (const filePath of listing.files) {
                        const lower = filePath.toLowerCase();
                        if (lower.endsWith('.ncanvas') || lower.endsWith('.narrativecanvas')) {
                            await moveFile(normalizePath(filePath));
                        }
                    }
                    // Trash empty legacy folder (and ignore leftovers)
                    const after = await adapter.list(legacy);
                    if (after.files.length === 0 && after.folders.length === 0) {
                        const folderAf = this.app.vault.getAbstractFileByPath(legacy);
                        if (folderAf) await this.app.fileManager.trashFile(folderAf);
                    }
                } catch (e) {
                    console.warn(`[NarrativeLab] Failed scanning legacy canvas folder ${legacy}:`, e);
                }
            }

            // Loose .ncanvas sitting on the project root
            try {
                const rootListing = await adapter.list(baseFolder);
                for (const filePath of rootListing.files) {
                    const lower = filePath.toLowerCase();
                    if (lower.endsWith('.ncanvas') || lower.endsWith('.narrativecanvas')) {
                        await moveFile(normalizePath(filePath));
                    }
                }
            } catch { /* noop */ }
        }
    }

    /**
     * Scan for existing NarrativeLab projects.
     * If none are found, retry a few times in case the vault / metadata cache
     * hasn't finished indexing (common on mobile and after laptop wake).
     * Only prompt for a new project if retries are exhausted.
     */
    private async bootstrapProjects(): Promise<void> {
        let projects = await this.sceneManager.scanProjects();

        // If nothing found but we expect a project, retry after short delays
        // to let the vault / metadata cache finish indexing.
        if (projects.length === 0 && this.settings.activeProjectFile) {
            for (let attempt = 1; attempt <= 3; attempt++) {
                await new Promise(r => window.setTimeout(r, attempt * 1000));
                projects = await this.sceneManager.scanProjects();
                if (projects.length > 0) break;
            }
        }

        if (projects.length === 0) {
            // If we expect a project to exist (e.g. from a previous session),
            // verify that its file is actually missing before prompting creation.
            // This prevents the startup race condition from creating duplicate projects
            // when the vault/metadata cache is slow to index (e.g. synced folders).
            if (this.settings.activeProjectFile) {
                const exists = await this.app.vault.adapter.exists(this.settings.activeProjectFile);
                if (exists) {
                    // The file exists but wasn't found by scanProjects — retry once more
                    // with a longer delay to give the metadata cache time to catch up.
                    await new Promise(r => window.setTimeout(r, 5000));
                    projects = await this.sceneManager.scanProjects();
                    if (projects.length > 0) return;
                }
            }

            // Mobile (iOS / iPadOS / Android) suppression: the vault file
            // system on mobile can take a long time to populate, especially
            // with iCloud / Dropbox / OneDrive sync. Auto-opening the New
            // Project modal in that window leads to users seeing the dialog
            // before their existing projects have shown up, and accidentally
            // creating duplicates. Show a one-time notice instead and let
            // the user invoke the modal manually from the command palette
            // ("NarrativeLab: Create new project") once everything has loaded.
            if (Platform.isMobile) {
                new Notice(
                    t('NarrativeLab: no projects found yet. If sync is still running, give it a moment. Otherwise use the command palette → "NarrativeLab: Create new project".'),
                    8000,
                );
                return;
            }

            // Desktop: prompt the user to name their first project instead
            // of auto-creating a "Default" one.
            const project = await this.openNewProjectModal();
            if (project) {
                try {
                    await this.activateView(BOARD_VIEW_TYPE);
                } catch { /* non-critical: user can navigate manually */ }
            }
        }
    }

    /**
     * Open a modal to create a new NarrativeLab project
     */
    async openNewProjectModal(): Promise<StoryLineProject | null> {
        return new Promise<StoryLineProject | null>((resolve) => {
            const modal = new Modal(this.app);
            modal.titleEl.setText(t('New NarrativeLab Project'));
            let title = '';
            // null = configured default; empty string = explicit vault root.
            let customFolder: string | null = null;
            let locationInput: HTMLInputElement | null = null;
            let locationSuggest: ProjectFolderSuggest | null = null;
            let createAsSeries = false;
            let seriesName = '';

            // Series toggle at the top
            const seriesNameSetting = new Setting(modal.contentEl)
                .setName(t('Series name'))
                .setDesc(t('Characters, locations, and Library entries will be shared across all projects in this series.'))
                .addText((text: TextComponent) => {
                    text.setPlaceholder(t('My Trilogy'));
                    text.onChange((v: string) => (seriesName = v));
                });
            seriesNameSetting.settingEl.setCssStyles({ display: 'none' });

            new Setting(modal.contentEl)
                .setName(t('Create as series'))
                .setDesc(t('Wrap this project in a series folder with a shared Library.'))
                .addToggle((toggle: ToggleComponent) => {
                    toggle.setValue(false);
                    toggle.onChange((v: boolean) => {
                        createAsSeries = v;
                        seriesNameSetting.settingEl.setCssStyles({ display: v ? '' : 'none' });
                    });
                });

            // Project title
            new Setting(modal.contentEl)
                .setName(t('Project title'))
                .setDesc(t('The title of this project. Each project gets its own workspace folder.'))
                .addText((text: TextComponent) => {
                    text.setPlaceholder(t('My Project'));
                    text.onChange((v: string) => (title = v));
                });

            new Setting(modal.contentEl)
                .setName(t('Project location'))
                .setDesc(t('Leave empty to use {target}, or enter any vault folder path.', {
                    target: this.settings.storyLineRoot ? t('the default ({path})', { path: this.settings.storyLineRoot }) : t('the vault root'),
                }))
                .addText((text: TextComponent) => {
                    locationInput = text.inputEl;
                    text.setPlaceholder(this.settings.storyLineRoot || '/');
                    text.onChange((v: string) => {
                        const value = v.trim();
                        customFolder = value === '' ? null : value === '/' ? '' : value;
                    });
                    locationSuggest = new ProjectFolderSuggest(
                        this.app,
                        text.inputEl,
                        this.settings.storyLineRoot,
                        path => { customFolder = path; },
                    );
                });

            new Setting(modal.contentEl)
                .addButton((btn: ButtonComponent) => {
                    btn.buttonEl.addEventListener('pointerdown', () => {
                        locationSuggest?.close();
                    });
                    btn.setButtonText(t('Create')).setCta().onClick(async () => {
                        if (!title.trim()) return;
                        if (createAsSeries && !seriesName.trim()) {
                            new Notice(t('Please enter a series name.'));
                            return;
                        }
                        try {
                            const typed = (locationInput?.value ?? '').trim();
                            const chosen = typed !== '' ? (typed === '/' ? '' : typed) : customFolder;
                            const basePath = chosen === null
                                ? vaultRelativeFolderPath(this.settings.storyLineRoot)
                                : chosen === '' ? '' : vaultRelativeFolderPath(this.toVaultRelativePath(chosen));
                            const project = createAsSeries
                                ? await this.seriesManager.createSeriesWithNewProject(
                                    seriesName.trim(),
                                    title.trim(),
                                    '',
                                    basePath,
                                )
                                : await this.sceneManager.createProject(title.trim(), '', basePath);
                            if (!createAsSeries) await this.sceneManager.setActiveProject(project);

                            this.refreshOpenViews();
                            if (this.settings.autoOpenNavigator) this.openNavigator();
                            try { await this.activateView(BOARD_VIEW_TYPE); } catch { /* non-critical */ }
                            modal.close();
                            resolve(project);
                        } catch (err: unknown) {
                            new Notice((err instanceof Error ? err.message : String(err)), 10000);
                            resolve(null);
                        }
                    });
                })
                .addButton((btn: ButtonComponent) => {
                    btn.setButtonText(t('Cancel')).onClick(() => {
                        modal.close();
                        resolve(null);
                    });
                });

            modal.open();
        });
    }

    /**
     * Open a modal to fork the active project into a variant
     */
    private openForkProjectModal(): void {
        const activeProject = this.sceneManager.activeProject;
        if (!activeProject) {
            new Notice(t('No active project to fork'));
            return;
        }
        const modal = new Modal(this.app);
        modal.titleEl.setText(t('Fork "{title}"', { title: activeProject.title }));
        let newTitle = `${activeProject.title} - Variant`;

        new Setting(modal.contentEl)
            .setName(t('New project name'))
            .setDesc(t('All scenes from the current project will be copied.'))
            .addText((text: TextComponent) => {
                text.setValue(newTitle);
                text.onChange((v: string) => (newTitle = v));
            });

        new Setting(modal.contentEl)
            .addButton((btn: ButtonComponent) => {
                btn.setButtonText(t('Fork')).setCta().onClick(async () => {
                    if (!newTitle.trim()) return;
                    const forked = await this.sceneManager.forkProject(activeProject, newTitle.trim());
                    await this.sceneManager.setActiveProject(forked);
                    this.refreshOpenViews();
                    if (this.settings.autoOpenNavigator) this.openNavigator();
                    try { await this.activateView(BOARD_VIEW_TYPE); } catch { /* non-critical */ }
                    modal.close();
                });
            });
        modal.open();
    }

    /**
     * Open a confirmation modal to delete the active project.
     *
     * The project folder (and everything inside — scenes, codex, notes,
     * system data) is moved to the system trash / `.trash` according to
     * the user's "Deleted files" setting. If the project belongs to a
     * series it is also removed from `series.json`.
     */
    private openDeleteProjectModal(): void {
        const activeProject = this.sceneManager.activeProject;
        if (!activeProject) {
            new Notice(t('No active project to delete'));
            return;
        }

        const modal = new Modal(this.app);
        modal.titleEl.setText(t('Delete "{title}"', { title: activeProject.title }));

        // Warning banner
        const warningEl = modal.contentEl.createDiv({ cls: 'sl-delete-warning' });
        warningEl.createEl('p', {
            text: t('⚠️ This will permanently delete the project folder and everything inside it:'),
        });
        const list = warningEl.createEl('ul');
        list.createEl('li', { text: t('All scenes') });
        list.createEl('li', { text: t('All characters, locations and codex entries') });
        list.createEl('li', { text: t('All notes, research and archive items') });
        list.createEl('li', { text: t('Project settings and view data') });
        if (this.sceneManager.isProjectInValidSeries(activeProject)) {
            list.createEl('li', { text: t('The project will also be removed from its series.') });
        }
        warningEl.createEl('p', {
            text: t('This action cannot be undone. The folder will be moved to your system trash (or Obsidian\u2019s .trash folder, depending on your settings).'),
            cls: 'sl-delete-warning-strong',
        });

        // Type-to-confirm: user must type the project title to enable Delete.
        const expected = activeProject.title;
        let typed = '';
        new Setting(modal.contentEl)
            .setName(t('Confirm by typing the project title'))
            .setDesc(t('Type "{text}" to enable the Delete button.', { text: expected }))
            .addText((text: TextComponent) => {
                text.setPlaceholder(expected);
                text.onChange((v: string) => {
                    typed = v;
                    deleteBtn.setDisabled(v.trim() !== expected);
                });
                window.setTimeout(() => text.inputEl.focus(), 50);
            });

        let deleteBtn: ButtonComponent;
        new Setting(modal.contentEl)
            .addButton((btn: ButtonComponent) => {
                btn.setButtonText(t('Cancel')).onClick(() => modal.close());
            })
            .addButton((btn: ButtonComponent) => {
                deleteBtn = btn.setButtonText(t('Delete permanently')).setClass('mod-warning').setDisabled(true);
                btn.onClick(async () => {
                    if (typed.trim() !== expected) return;
                    modal.close();
                    try {
                        const ok = await this.sceneManager.deleteProject(activeProject);
                        if (ok) {
                            this.refreshOpenViews();
                        }
                    } catch (e: unknown) {
                        new Notice(t('Failed to delete project: ') + (e instanceof Error ? e.message : String(e)), 10000);
                    }
                });
            });
        modal.open();
    }

    // ────────────────────────────────────
    //  Series modals
    // ────────────────────────────────────

    private openCreateSeriesModal(): void {
        const project = this.sceneManager.activeProject;
        if (!project) {
            new Notice(t('No active project'));
            return;
        }
        if (this.sceneManager.isProjectInValidSeries(project)) {
            new Notice(t('This project is already part of a series.'));
            return;
        }

        const modal = new Modal(this.app);
        modal.titleEl.setText(t('Create New Series'));
        let seriesName = t('{title} Series', { title: project.title });

        new Setting(modal.contentEl)
            .setName(t('Series name'))
            .setDesc(t('"{title}" will become the first project in this series. Its Library will be shared.', { title: project.title }))
            .addText((text: TextComponent) => {
                text.setPlaceholder(t('My Trilogy'));
                text.setValue(seriesName);
                text.onChange((v: string) => (seriesName = v));
                window.setTimeout(() => text.inputEl.focus(), 50);
            });

        new Setting(modal.contentEl)
            .addButton((btn: ButtonComponent) => {
                btn.setButtonText(t('Create Series')).setCta().onClick(async () => {
                    if (!seriesName.trim()) {
                        new Notice(t('Please enter a series name.'));
                        return;
                    }
                    modal.close();
                    try {
                        await this.seriesManager.createSeriesFromProject(seriesName.trim());
                        this.refreshOpenViews();
                    } catch (e: unknown) {
                        new Notice((e instanceof Error ? e.message : String(e)), 10000);
                    }
                });
            });

        modal.open();
    }

    private async openAddToSeriesModal(): Promise<void> {
        const project = this.sceneManager.activeProject;
        if (!project) {
            new Notice(t('No active project'));
            return;
        }
        if (this.sceneManager.isProjectInValidSeries(project)) {
            new Notice(t('This project is already part of a series.'));
            return;
        }

        const seriesList = await this.seriesManager.discoverSeries();
        if (seriesList.length === 0) {
            new Notice(t('No series found. Create one first using "Create New Series from Current Project".'));
            return;
        }

        const modal = new Modal(this.app);
        modal.titleEl.setText(t('Add to Existing Series'));
        let selectedFolder = seriesList[0].folder;

        new Setting(modal.contentEl)
            .setName(t('Series'))
            .setDesc(t('"{title}" will be added to the selected series. Its Library will be merged into the shared series Library.', { title: project.title }))
            .addDropdown((dropdown: DropdownComponent) => {
                for (const s of seriesList) {
                    dropdown.addOption(s.folder, `${s.meta.name} (${s.meta.bookOrder.length} projects)`);
                }
                dropdown.onChange((v: string) => (selectedFolder = v));
            });

        new Setting(modal.contentEl)
            .addButton((btn: ButtonComponent) => {
                btn.setButtonText(t('Add to Series')).setCta().onClick(async () => {
                    modal.close();
                    try {
                        await this.seriesManager.addProjectToSeries(selectedFolder);
                        this.refreshOpenViews();
                    } catch (e: unknown) {
                        new Notice((e instanceof Error ? e.message : String(e)), 10000);
                    }
                });
            });

        modal.open();
    }

    private openRenameProjectModal(): void {
        const project = this.sceneManager.activeProject;
        if (!project) {
            new Notice(t('No active project to rename.'));
            return;
        }

        const modal = new Modal(this.app);
        modal.titleEl.setText(t('Rename Project'));
        let newTitle = project.title;

        new Setting(modal.contentEl)
            .setName(t('New title'))
            .setDesc(t('The project file and folder will be renamed. All links are updated automatically.'))
            .addText((text: TextComponent) => {
                text.setValue(project.title);
                text.onChange((v: string) => (newTitle = v));
                window.setTimeout(() => { text.inputEl.focus(); text.inputEl.select(); }, 50);
            });

        new Setting(modal.contentEl)
            .addButton((btn: ButtonComponent) => {
                btn.setButtonText(t('Rename')).setCta().onClick(async () => {
                    if (!newTitle.trim() || newTitle.trim() === project.title) {
                        modal.close();
                        return;
                    }
                    try {
                        this.seriesManager.checkLinkSettings();
                        await this.sceneManager.renameProject(project, newTitle.trim());
                        new Notice(t('Project renamed to "{title}"', { title: newTitle.trim() }));
                        modal.close();
                        this.refreshOpenViews();
                    } catch (e: unknown) {
                        new Notice((e instanceof Error ? e.message : String(e)), 10000);
                    }
                });
            });

        modal.open();
    }

    openSeriesManagementModal(): void {
        const modal = new SeriesManagementModal(this.app, this);
        modal.open();
    }
}

/**
 * Fuzzy-search modal for quick project switching from the command palette.
 */
class ProjectSwitcherModal extends FuzzySuggestModal<StoryLineProject> {
    private projects: StoryLineProject[];
    private isValidSeriesProject: (project: StoryLineProject) => boolean;
    private onChoose: (project: StoryLineProject) => void;

    constructor(
        app: App,
        projects: StoryLineProject[],
        isValidSeriesProject: (project: StoryLineProject) => boolean,
        onChoose: (project: StoryLineProject) => void,
    ) {
        super(app);
        this.projects = projects;
        this.isValidSeriesProject = isValidSeriesProject;
        this.onChoose = onChoose;
        this.setPlaceholder(t('Switch to project…'));
    }

    getItems(): StoryLineProject[] {
        return this.projects;
    }

    getItemText(project: StoryLineProject): string {
        return project.title + (project.seriesId && this.isValidSeriesProject(project) ? ` [${project.seriesId}]` : '');
    }

    onChooseItem(project: StoryLineProject): void {
        this.onChoose(project);
    }
}

/**
 * Modal to choose or create a NarrativeLab project from the NarrativeLab ribbon.
 */
class ProjectSelectModal extends Modal {
    plugin: SceneCardsPlugin;
    constructor(app: App, plugin: SceneCardsPlugin) {
        super(app);
        this.plugin = plugin;
        this.titleEl.setText(t('Open NarrativeLab Project'));
    }
    onOpen() {
        const { contentEl } = this;
        contentEl.empty();
        contentEl.addClass('narrative-lab-project-modal');
        const info = contentEl.createDiv({ cls: 'project-select-info' });
        info.createEl('p', { text: t('Select a project to load, or create a new one.') });

        const list = contentEl.createDiv({ cls: 'project-list' });

        // Create a select dropdown and actions
        const select = list.createEl('select', { cls: 'project-select-dropdown' });
        select.addEventListener('keydown', (e: KeyboardEvent) => e.stopPropagation());

        const fillSelect = (projects: StoryLineProject[], emptyLabel?: string) => {
            if (!select.isConnected) return;
            const previous = select.value;
            select.empty();
            if (projects.length === 0) {
                const opt = select.createEl('option', { text: emptyLabel ?? t('No projects found') });
                opt.setAttr('disabled', 'true');
                return;
            }
            const rootPath = this.plugin.settings.storyLineRoot;
            for (const p of projects) {
                const isCustom = !p.filePath.startsWith(rootPath + '/');
                const parentDir = p.filePath.substring(0, p.filePath.lastIndexOf('/'));
                const label = isCustom ? `${p.title}  (${parentDir})` : p.title;
                const opt = select.createEl('option', { text: label });
                opt.setAttr('value', p.filePath);
            }
            const active = this.plugin.sceneManager.activeProject;
            const preferred = previous
                || (active && projects.some((p: StoryLineProject) => p.filePath === active.filePath) ? active.filePath : '');
            select.value = projects.some((p: StoryLineProject) => p.filePath === preferred)
                ? preferred
                : projects[0].filePath;
        };

        const refreshSelect = async (noticeOnError = false) => {
            try {
                await this.plugin.sceneManager.scanProjects();
                fillSelect(this.plugin.sceneManager.getProjects());
            } catch (err) {
                if (this.plugin.sceneManager.getProjects().length === 0) {
                    fillSelect([], t('Error loading projects'));
                }
                if (noticeOnError) new Notice(t('Failed to refresh projects: ') + String(err));
            }
        };

        const actions = contentEl.createDiv({ cls: 'project-actions project-actions-primary' });
        const openSelected = async (destination: 'board' | 'canvas'): Promise<void> => {
            const val = select.value;
            const projects = this.plugin.sceneManager.getProjects();
            const selected = projects.find((p: StoryLineProject) => p.filePath === val);
            if (!selected) {
                new Notice(t('No project selected'));
                return;
            }
            try {
                if (this.plugin.settings.autoOpenNavigator) this.plugin.openNavigator();
                if (destination === 'canvas') {
                    await this.plugin.sceneManager.setActiveProject(selected);
                    this.plugin.refreshOpenViews();
                    this.close();
                    this.plugin.openNCanvasManager();
                    return;
                }
                await this.plugin.openBoardForProject(selected);
                this.close();
            } catch (err) {
                new Notice(t('Failed to open project: ') + String(err));
            }
        };

        const openBtn = actions.createEl('button', { text: t('Open Project'), cls: 'mod-cta' });
        openBtn.setAttr('type', 'button');
        openBtn.addEventListener('click', () => {
            void openSelected('board');
        });

        const canvasBtn = actions.createEl('button', { text: t('Open Canvas'), cls: 'mod-cta' });
        canvasBtn.setAttr('type', 'button');
        canvasBtn.setAttr('title', t('Choose, create, or open an ncanvas for this project'));
        canvasBtn.addEventListener('click', () => {
            void openSelected('canvas');
        });

        const managementActions = contentEl.createDiv({ cls: 'project-actions project-actions-secondary' });

        const createBtn = managementActions.createEl('button', { text: t('New Project'), cls: 'mod-cta' });
        createBtn.setAttr('type', 'button');
        createBtn.addEventListener('click', async () => {
            // open project creation modal and refresh list if a new project was created
            const created = await this.plugin.openNewProjectModal();
            if (created) {
                this.close();
                return;
            }
            await refreshSelect(true);
        });

        const cancel = managementActions.createEl('button', { text: t('Cancel'), cls: 'mod-quiet project-actions-cancel' });
        cancel.setAttr('type', 'button');
        cancel.addEventListener('click', () => this.close());

        const seriesBtn = managementActions.createEl('button', { text: t('Manage Series…'), cls: 'mod-cta' });
        seriesBtn.setAttr('type', 'button');
        seriesBtn.addEventListener('click', async () => {
            const seriesModal = new SeriesManagementModal(this.app, this.plugin);
            seriesModal.open();
        });

        // "Browse" button — manually pick a .md file as a NarrativeLab project
        const browseBtn = managementActions.createEl('button', { text: t('Browse Project…'), cls: 'mod-cta' });
        browseBtn.setAttr('type', 'button');
        browseBtn.addEventListener('click', async () => {
            // Build a list of all .md files in the vault for the user to pick from
            const browseModal = new Modal(this.app);
            browseModal.titleEl.setText(t('Select a NarrativeLab project file'));
            const container = browseModal.contentEl.createDiv({ cls: 'project-browse-list' });
            const fileList = container.createDiv();
            fileList.setCssStyles({
                maxHeight: '300px',
                overflowY: 'auto',
            });
            fileList.createDiv({ text: t('Scanning…') });

            const projectFiles: { path: string; title: string }[] = [];
            try {
                const known = this.plugin.sceneManager.getProjects();
                if (known.length > 0) {
                    for (const p of known) projectFiles.push({ path: p.filePath, title: p.title });
                } else {
                    for (const file of this.app.vault.getMarkdownFiles()) {
                        const cache = this.app.metadataCache.getFileCache(file);
                        const type = cache?.frontmatter?.type;
                        if (type !== 'narrative-lab' && type !== 'storyline') continue;
                        const title = typeof cache?.frontmatter?.title === 'string' && cache.frontmatter.title
                            ? cache.frontmatter.title
                            : file.basename;
                        projectFiles.push({ path: file.path, title });
                    }
                }
            } catch { /* vault index may still be loading */ }
            projectFiles.sort((a, b) => a.title.localeCompare(b.title));

            // Render the project list
            fileList.empty();
            if (projectFiles.length === 0) {
                fileList.createDiv({ text: t('No NarrativeLab projects found.') });
            }
            for (const pf of projectFiles) {
                const row = fileList.createDiv({ cls: 'project-browse-row' });
                row.setCssStyles({
                    padding: '4px 8px',
                    cursor: 'pointer',
                    borderRadius: '4px',
                });
                row.textContent = `${pf.title}  (${pf.path})`;
                row.addEventListener('mouseenter', () => { row.setCssStyles({ background: 'var(--background-modifier-hover)' }); });
                row.addEventListener('mouseleave', () => { row.setCssStyles({ background: '' }); });
                row.addEventListener('click', async () => {
                    try {
                        const adapter = this.app.vault.adapter;
                        const content = await adapter.read(pf.path);
                        // Re-scan and try to find / adopt this project
                        await this.plugin.sceneManager.scanProjects();
                        let project = this.plugin.sceneManager.getProjects().find((p: StoryLineProject) => p.filePath === pf.path);
                        if (!project) {
                            const sm = this.plugin.sceneManager as unknown as {
                                parseProjectContent: (content: string, path: string) => StoryLineProject | null;
                                projects: Map<string, StoryLineProject>;
                            };
                            const parsed = sm.parseProjectContent(content, pf.path);
                            if (parsed) {
                                sm.projects.set(pf.path, parsed);
                                project = parsed;
                            }
                        }
                        if (project) {
                            if (this.plugin.settings.autoOpenNavigator) this.plugin.openNavigator();
                            try { await this.plugin.openBoardForProject(project); } catch { /* */ }
                            browseModal.close();
                            this.close();
                        } else {
                            new Notice(t('Could not parse file as a NarrativeLab project'));
                        }
                    } catch (err) {
                        new Notice(t('Failed to open project: ') + String(err));
                    }
                });
            }

            browseModal.open();
        });

        // Paint the already-scanned list immediately; refresh in the background.
        const cached = this.plugin.sceneManager.getProjects();
        fillSelect(cached, cached.length === 0 ? t('Scanning…') : undefined);
        void refreshSelect();
    }
}

/**
 * Open a second modal above an already-open one.
 * Opening synchronously inside a click handler lets the same mouseup hit the
 * new dim overlay and immediately close the child — Convert / Dissolve looked dead.
 */
function openStackedModal(modal: Modal): void {
    window.setTimeout(() => {
        modal.open();
        const shell = modal.containerEl.closest<HTMLElement>('.modal-container');
        if (shell) {
            shell.addClass('nl-stacked-modal');
        }
        modal.containerEl.addClass('nl-stacked-modal-content');
    }, 0);
}

/**
 * Modal for managing series — view, rename, reorder books, add/remove books.
 */
class SeriesManagementModal extends Modal {
    plugin: SceneCardsPlugin;

    constructor(app: App, plugin: SceneCardsPlugin) {
        super(app);
        this.plugin = plugin;
        this.titleEl.setText(t('Manage Series'));
    }

    onOpen() {
        this.render();
    }

    private async render() {
        const { contentEl } = this;
        contentEl.empty();
        contentEl.addClass('sl-series-modal');

        const seriesList = await this.plugin.seriesManager.discoverSeries();
        const standaloneProjects = this.plugin.sceneManager.getProjects()
            .filter(project => !this.plugin.sceneManager.isProjectInValidSeries(project));

        if (seriesList.length === 0 && standaloneProjects.length === 0) {
            contentEl.createEl('p', {
                text: t('No NarrativeLab projects or series found.'),
                cls: 'sl-series-empty',
            });
            return;
        }

        if (standaloneProjects.length > 0) {
            contentEl.createEl('h3', { text: t('Standalone Projects'), cls: 'sl-series-section-title' });
            contentEl.createEl('p', {
                text: t('Projects that are not currently part of a series.'),
                cls: 'sl-series-section-desc',
            });
            const standaloneList = contentEl.createDiv({ cls: 'sl-series-project-list' });
            for (const project of standaloneProjects) {
                const row = standaloneList.createDiv({ cls: 'sl-series-project-row' });
                const info = row.createDiv({ cls: 'sl-series-project-info' });
                info.createDiv({ text: project.title, cls: 'sl-series-project-name' });
                info.createDiv({
                    text: deriveProjectFoldersFromFilePath(project.filePath).baseFolder,
                    cls: 'sl-series-project-path',
                });
                const convertBtn = row.createEl('button', {
                    text: t('Convert to Series…'),
                    cls: 'sl-series-convert-btn',
                    attr: { type: 'button' },
                });
                convertBtn.addEventListener('click', (event) => {
                    event.preventDefault();
                    event.stopPropagation();
                    this.convertProjectToSeries(project);
                });
            }
        }

        if (seriesList.length > 0) {
            contentEl.createEl('h3', { text: t('Series'), cls: 'sl-series-section-title' });
        }

        for (const { folder, meta } of seriesList) {
            const card = contentEl.createDiv({ cls: 'sl-series-card' });

            // ── Header row: series name + rename button ──
            const header = card.createDiv({ cls: 'sl-series-header' });
            header.createSpan({ cls: 'sl-series-title', text: meta.name });
            header.createSpan({
                cls: 'sl-series-folder-hint',
                text: folder.split('/').pop() ?? folder,
            });

            const renameBtn = header.createEl('button', { cls: 'clickable-icon sl-series-action', attr: { 'aria-label': t('Rename series') } });
            setIcon(renameBtn, 'pencil');
            renameBtn.addEventListener('click', () => this.renameSeries(folder, meta));

            // ── Book list ──
            const bookList = card.createDiv({ cls: 'sl-series-book-list' });

            for (let i = 0; i < meta.bookOrder.length; i++) {
                const bookName = meta.bookOrder[i];
                const row = bookList.createDiv({ cls: 'sl-series-book-row' });


                row.createSpan({ cls: 'sl-series-book-name', text: bookName });

                const bookActions = row.createDiv({ cls: 'sl-series-book-actions' });

                // Rename book
                const renameBookBtn = bookActions.createEl('button', { cls: 'clickable-icon', attr: { 'aria-label': t('Rename project') } });
                setIcon(renameBookBtn, 'pencil');
                renameBookBtn.addEventListener('click', () => this.renameBook(folder, meta, bookName));

                // Move up
                if (i > 0) {
                    const upBtn = bookActions.createEl('button', { cls: 'clickable-icon', attr: { 'aria-label': t('Move up') } });
                    setIcon(upBtn, 'chevron-up');
                    upBtn.addEventListener('click', () => this.reorderBook(folder, meta, i, i - 1));
                }

                // Move down
                if (i < meta.bookOrder.length - 1) {
                    const downBtn = bookActions.createEl('button', { cls: 'clickable-icon', attr: { 'aria-label': t('Move down') } });
                    setIcon(downBtn, 'chevron-down');
                    downBtn.addEventListener('click', () => this.reorderBook(folder, meta, i, i + 1));
                }

                // Remove from series
                const removeBtn = bookActions.createEl('button', { cls: 'clickable-icon sl-series-remove', attr: { 'aria-label': t('Remove from series') } });
                setIcon(removeBtn, 'x');
                removeBtn.addEventListener('click', () => this.removeBook(folder, meta, bookName));

                // Delete book permanently
                const deleteBookBtn = bookActions.createEl('button', { cls: 'clickable-icon sl-series-delete', attr: { 'aria-label': t('Delete project permanently') } });
                setIcon(deleteBookBtn, 'trash');
                deleteBookBtn.addEventListener('click', () => this.deleteBook(folder, meta, bookName));
            }

            // ── Add book button ──
            const addRow = card.createDiv({ cls: 'sl-series-add-row' });
            const addBtn = addRow.createEl('button', { text: t('Add project to this series'), cls: 'sl-series-add-btn' });
            setIcon(addBtn.createSpan({ prepend: true }), 'plus');
            addBtn.addEventListener('click', () => this.addBookToSeries(folder, meta));

            const dissolveBtn = addRow.createEl('button', {
                text: t('Convert series to standalone projects…'),
                cls: 'sl-series-add-btn sl-series-dissolve-btn',
                attr: { type: 'button' },
            });
            dissolveBtn.addEventListener('click', (event) => {
                event.preventDefault();
                event.stopPropagation();
                void this.dissolveSeries(folder, meta);
            });
        }
    }

    private convertProjectToSeries(project: StoryLineProject): void {
        const modal = new Modal(this.app);
        modal.titleEl.setText(t('Convert Project to Series'));
        let seriesName = t('{title} Series', { title: project.title });

        new Setting(modal.contentEl)
            .setName(t('Series name'))
            .setDesc(t('"{title}" will become the first project in this series. Its Library will be shared.', {
                title: project.title,
            }))
            .addText((text: TextComponent) => {
                text.setPlaceholder(t('My Trilogy'));
                text.setValue(seriesName);
                text.onChange(value => { seriesName = value; });
                window.setTimeout(() => text.inputEl.focus(), 50);
            });

        new Setting(modal.contentEl)
            .addButton((btn: ButtonComponent) => btn.setButtonText(t('Cancel')).onClick(() => modal.close()))
            .addButton((btn: ButtonComponent) => btn.setButtonText(t('Convert to Series')).setCta().onClick(async () => {
                if (!seriesName.trim()) {
                    new Notice(t('Please enter a series name.'));
                    return;
                }
                modal.close();
                try {
                    await this.plugin.seriesManager.createSeriesFromProject(seriesName.trim(), project);
                    await this.plugin.refreshOpenViews();
                    await this.render();
                } catch (error: unknown) {
                    new Notice(error instanceof Error ? error.message : String(error), 10000);
                }
            }));
        openStackedModal(modal);
    }

    private async dissolveSeries(folder: string, meta: SeriesMetadata): Promise<void> {
        const confirmed = await new Promise<boolean>(resolve => {
            const modal = new Modal(this.app);
            modal.titleEl.setText(t('Convert Series to Projects'));
            modal.contentEl.createEl('p', {
                text: t('Dissolve "{series}" into {count} standalone projects? The shared Library will be copied into every project, and the series container will be moved to trash.', {
                    series: meta.name,
                    count: meta.bookOrder.length,
                }),
            });
            new Setting(modal.contentEl)
                .addButton((btn: ButtonComponent) => btn.setButtonText(t('Cancel')).onClick(() => {
                    modal.close();
                    resolve(false);
                }))
                .addButton((btn: ButtonComponent) => btn.setButtonText(t('Convert to Projects')).setClass('mod-warning').onClick(() => {
                    modal.close();
                    resolve(true);
                }));
            openStackedModal(modal);
        });
        if (!confirmed) return;

        try {
            const projects = await this.plugin.seriesManager.dissolveSeries(folder);
            new Notice(t('Series "{name}" was converted into {count} standalone projects.', {
                name: meta.name,
                count: projects.length,
            }));
            await this.plugin.refreshOpenViews();
            await this.render();
        } catch (error: unknown) {
            new Notice(error instanceof Error ? error.message : String(error), 10000);
        }
    }

    private async renameSeries(folder: string, meta: SeriesMetadata) {
        const modal = new Modal(this.app);
        modal.titleEl.setText(t('Rename Series'));
        let newName = meta.name;

        new Setting(modal.contentEl)
            .setName(t('Series name'))
            .setDesc(t('The series folder will also be renamed. All links are updated automatically.'))
            .addText((text: TextComponent) => {
                text.setValue(meta.name);
                text.onChange((v: string) => (newName = v));
                window.setTimeout(() => { text.inputEl.focus(); text.inputEl.select(); }, 50);
            });

        new Setting(modal.contentEl)
            .addButton((btn: ButtonComponent) => {
                btn.setButtonText(t('Rename')).setCta().onClick(async () => {
                    if (!newName.trim() || newName.trim() === meta.name) {
                        modal.close();
                        return;
                    }
                    try {
                        // Pre-flight: ensure auto-update links is on
                        this.plugin.seriesManager.checkLinkSettings();

                        const safeName = newName.trim().replace(/[\\/:*?"<>|]/g, '-');
                        const parentPath = folder.substring(0, folder.lastIndexOf('/'));
                        const newFolder = normalizePath(`${parentPath}/${safeName}`);

                        // Rename folder on disk (updates all vault links)
                        if (normalizePath(folder) !== newFolder) {
                            const folderFile = this.app.vault.getAbstractFileByPath(folder);
                            if (folderFile) {
                                await this.app.fileManager.renameFile(folderFile, newFolder);
                            }
                        }

                        // Update series.json with new name
                        meta.name = newName.trim();
                        await this.plugin.seriesManager.saveSeriesMetadata(newFolder, meta);

                        // Update seriesId on all books inside the (now renamed) folder
                        await this.plugin.sceneManager.scanProjects();
                        const projects = this.plugin.sceneManager.getProjects();
                        for (const p of projects) {
                            if (normalizePath(p.filePath).startsWith(normalizePath(newFolder) + '/')) {
                                p.seriesId = safeName;
                                await this.plugin.sceneManager.saveProjectFrontmatter(p);
                            }
                        }

                        new Notice(t('Series renamed to "{name}"', { name: newName.trim() }));
                        modal.close();
                        this.plugin.refreshOpenViews();
                        this.render();
                    } catch (e: unknown) {
                        new Notice((e instanceof Error ? e.message : String(e)), 10000);
                    }
                });
            });

        openStackedModal(modal);
    }

    private async reorderBook(folder: string, meta: SeriesMetadata, fromIndex: number, toIndex: number) {
        const [book] = meta.bookOrder.splice(fromIndex, 1);
        meta.bookOrder.splice(toIndex, 0, book);
        await this.plugin.seriesManager.saveSeriesMetadata(folder, meta);
        this.render();
    }

    private findSeriesBookProject(folder: string, bookName: string): StoryLineProject | undefined {
        const seriesFolder = normalizePath(folder);
        return this.plugin.sceneManager.getProjects().find(project => {
            const projectFolder = normalizePath(deriveProjectFoldersFromFilePath(project.filePath).baseFolder);
            const projectParent = projectFolder.includes('/')
                ? projectFolder.slice(0, projectFolder.lastIndexOf('/'))
                : '';
            const projectFolderName = projectFolder.split('/').pop() ?? '';
            return projectParent === seriesFolder
                && (projectFolderName === bookName || project.title === bookName);
        });
    }

    private async removeBook(folder: string, meta: SeriesMetadata, bookName: string) {
        // Find the project for this book and activate it so removeProjectFromSeries works
        const bookProject = this.findSeriesBookProject(folder, bookName);

        if (!bookProject) {
            await this.removeMissingBookReference(folder, meta, bookName);
            return;
        }

        // Confirm
        const confirm = await new Promise<boolean>((resolve) => {
            const m = new Modal(this.app);
            m.titleEl.setText(t('Remove from Series'));
            m.contentEl.createEl('p', {
                text: t('Remove "{book}" from "{series}"? The shared Library will be copied into the project\'s local folder.', { book: bookName, series: meta.name }),
            });
            new Setting(m.contentEl)
                .addButton((btn: ButtonComponent) => btn.setButtonText(t('Remove')).setClass('mod-warning').onClick(() => { m.close(); resolve(true); }))
                .addButton((btn: ButtonComponent) => btn.setButtonText(t('Cancel')).onClick(() => { m.close(); resolve(false); }));
            openStackedModal(m);
        });
        if (!confirm) return;

        const previousActive = this.plugin.sceneManager.activeProject;
        await this.plugin.sceneManager.setActiveProject(bookProject);
        try {
            await this.plugin.seriesManager.removeProjectFromSeries();
        } catch (e: unknown) {
            new Notice((e instanceof Error ? e.message : String(e)), 10000);
        }
        // Restore previous active project if it wasn't the removed one
        if (previousActive && previousActive.filePath !== bookProject.filePath) {
            const refreshed = this.plugin.sceneManager.getProjects().find(p => p.filePath === previousActive.filePath);
            if (refreshed) await this.plugin.sceneManager.setActiveProject(refreshed);
        }
        this.plugin.refreshOpenViews();
        this.render();
    }

    /**
     * Clean a stale series.json entry when its project is no longer available.
     * No project files or folders are moved or deleted by this operation.
     */
    private async removeMissingBookReference(folder: string, meta: SeriesMetadata, bookName: string): Promise<void> {
        const confirmed = await new Promise<boolean>((resolve) => {
            const modal = new Modal(this.app);
            modal.titleEl.setText(t('Remove missing project entry'));
            modal.contentEl.createEl('p', {
                text: t('NarrativeLab cannot find "{book}". Remove its stale entry from the series "{series}"?', {
                    book: bookName,
                    series: meta.name,
                }),
            });
            modal.contentEl.createEl('p', {
                text: t('Only the series list will be updated. No files or folders will be moved or deleted.'),
                cls: 'setting-item-description',
            });
            new Setting(modal.contentEl)
                .addButton((btn: ButtonComponent) => btn.setButtonText(t('Cancel')).onClick(() => {
                    modal.close();
                    resolve(false);
                }))
                .addButton((btn: ButtonComponent) => btn.setButtonText(t('Remove entry')).setClass('mod-warning').onClick(() => {
                    modal.close();
                    resolve(true);
                }));
            openStackedModal(modal);
        });
        if (!confirmed) return;

        try {
            // Re-scan immediately before cleanup. If Obsidian has just finished
            // indexing the project, keep the entry and let the normal move flow
            // handle it on the next click.
            await this.plugin.sceneManager.scanProjects();
            const projectNowAvailable = this.findSeriesBookProject(folder, bookName);
            if (projectNowAvailable) {
                new Notice(t('Project "{name}" is available again. Nothing was removed.', { name: bookName }));
                await this.render();
                return;
            }

            const removed = await this.plugin.seriesManager.removeMissingProjectReference(folder, bookName);
            new Notice(removed
                ? t('Removed missing project entry "{name}" from the series. No files were deleted.', { name: bookName })
                : t('The missing project entry was already removed.'));
            await this.plugin.refreshOpenViews();
            await this.render();
        } catch (error: unknown) {
            new Notice(error instanceof Error ? error.message : String(error), 10000);
        }
    }

    /**
     * Permanently delete a book from a series.
     *
     * Shows a type-to-confirm warning modal, then trashes the book's folder
     * (scenes, codex, notes, etc.) and removes it from `series.json`.
     */
    private async deleteBook(folder: string, meta: SeriesMetadata, bookName: string) {
        const bookProject = this.findSeriesBookProject(folder, bookName);

        if (!bookProject) {
            await this.removeMissingBookReference(folder, meta, bookName);
            return;
        }

        const modal = new Modal(this.app);
        modal.titleEl.setText(t('Delete "{name}"', { name: bookName }));

        const warningEl = modal.contentEl.createDiv({ cls: 'sl-delete-warning' });
        warningEl.createEl('p', {
            text: t('⚠️ This will permanently delete "{name}" and everything inside it:', { name: bookName }),
        });
        const list = warningEl.createEl('ul');
        list.createEl('li', { text: t('All scenes') });
        list.createEl('li', { text: t('All characters, locations and codex entries') });
        list.createEl('li', { text: t('All notes, research and archive items') });
        list.createEl('li', { text: t('The project will be removed from the series "{name}".', { name: meta.name }) });
        warningEl.createEl('p', {
            text: t('This action cannot be undone. The folder will be moved to your system trash (or Obsidian\u2019s .trash folder, depending on your settings).'),
            cls: 'sl-delete-warning-strong',
        });

        const expected = bookName;
        let typed = '';
        let deleteBtn: ButtonComponent;
        new Setting(modal.contentEl)
            .setName(t('Confirm by typing the project title'))
            .setDesc(t('Type "{text}" to enable the Delete button.', { text: expected }))
            .addText((text: TextComponent) => {
                text.setPlaceholder(expected);
                text.onChange((v: string) => {
                    typed = v;
                    deleteBtn.setDisabled(v.trim() !== expected);
                });
                window.setTimeout(() => text.inputEl.focus(), 50);
            });

        new Setting(modal.contentEl)
            .addButton((btn: ButtonComponent) => {
                btn.setButtonText(t('Cancel')).onClick(() => modal.close());
            })
            .addButton((btn: ButtonComponent) => {
                deleteBtn = btn.setButtonText(t('Delete permanently')).setClass('mod-warning').setDisabled(true);
                btn.onClick(async () => {
                    if (typed.trim() !== expected) return;
                    modal.close();
                    try {
                        const ok = await this.plugin.sceneManager.deleteProject(bookProject);
                        if (ok) {
                            this.plugin.refreshOpenViews();
                            this.render();
                        }
                    } catch (e: unknown) {
                        new Notice(t('Failed to delete project: ') + (e instanceof Error ? e.message : String(e)), 10000);
                    }
                });
            });
        openStackedModal(modal);
    }

    private async renameBook(folder: string, _meta: SeriesMetadata, bookName: string) {
        const bookProject = this.findSeriesBookProject(folder, bookName);

        if (!bookProject) {
            new Notice(t('Could not find project "{name}".', { name: bookName }));
            return;
        }

        const modal = new Modal(this.app);
        modal.titleEl.setText(t('Rename Project'));
        let newTitle = bookProject.title;

        new Setting(modal.contentEl)
            .setName(t('New title'))
            .setDesc(t('The project folder and manifest file will be renamed. All links are updated automatically.'))
            .addText((text: TextComponent) => {
                text.setValue(bookProject.title);
                text.onChange((v: string) => (newTitle = v));
                window.setTimeout(() => { text.inputEl.focus(); text.inputEl.select(); }, 50);
            });

        new Setting(modal.contentEl)
            .addButton((btn: ButtonComponent) => {
                btn.setButtonText(t('Rename')).setCta().onClick(async () => {
                    if (!newTitle.trim() || newTitle.trim() === bookProject.title) {
                        modal.close();
                        return;
                    }
                    try {
                        this.plugin.seriesManager.checkLinkSettings();
                        await this.plugin.sceneManager.renameProject(bookProject, newTitle.trim());
                        new Notice(t('Project renamed to "{title}"', { title: newTitle.trim() }));
                        modal.close();
                        this.plugin.refreshOpenViews();
                        this.render();
                    } catch (e: unknown) {
                        new Notice((e instanceof Error ? e.message : String(e)), 10000);
                    }
                });
            });

        openStackedModal(modal);
    }

    private async addBookToSeries(folder: string, meta: SeriesMetadata) {
        const NEW_PROJECT_VALUE = '__nl_new_project__';
        const projects = this.plugin.sceneManager.getProjects()
            .filter(project => !this.plugin.sceneManager.isProjectInValidSeries(project));

        const modal = new Modal(this.app);
        modal.titleEl.setText(t('Add project to "{name}"', { name: meta.name }));
        let selectedPath = projects[0]?.filePath ?? NEW_PROJECT_VALUE;
        let newTitle = '';

        const projectSetting = new Setting(modal.contentEl)
            .setName(t('Project'))
            .setDesc(selectedPath === NEW_PROJECT_VALUE
                ? t('Create a new project in this series. It will use the shared series Library.')
                : t('Select a standalone project to add to this series.'));
        projectSetting.addDropdown((dropdown: DropdownComponent) => {
            dropdown.addOption(NEW_PROJECT_VALUE, t('New project'));
            for (const p of projects) {
                dropdown.addOption(p.filePath, p.title);
            }
            dropdown.setValue(selectedPath);
            dropdown.onChange((v: string) => {
                selectedPath = v;
                const creating = v === NEW_PROJECT_VALUE;
                titleSetting.settingEl.setCssStyles({ display: creating ? '' : 'none' });
                projectSetting.setDesc(creating
                    ? t('Create a new project in this series. It will use the shared series Library.')
                    : t('Select a standalone project to add to this series.'));
                actionBtn.setButtonText(creating ? t('Create') : t('Add to Series'));
            });
        });

        const titleSetting = new Setting(modal.contentEl)
            .setName(t('Project title'))
            .setDesc(t('The title of this project. Each project gets its own workspace folder.'))
            .addText((text: TextComponent) => {
                text.setPlaceholder(t('My Project'));
                text.onChange((v: string) => (newTitle = v));
                window.setTimeout(() => {
                    if (selectedPath === NEW_PROJECT_VALUE) {
                        text.inputEl.focus();
                    }
                }, 50);
            });
        titleSetting.settingEl.setCssStyles({ display: selectedPath === NEW_PROJECT_VALUE ? '' : 'none' });

        let actionBtn: ButtonComponent;
        new Setting(modal.contentEl)
            .addButton((btn: ButtonComponent) => {
                actionBtn = btn.setButtonText(selectedPath === NEW_PROJECT_VALUE ? t('Create') : t('Add to Series')).setCta();
                btn.onClick(async () => {
                    if (selectedPath === NEW_PROJECT_VALUE) {
                        if (!newTitle.trim()) {
                            new Notice(t('Please enter a project title.'));
                            return;
                        }
                        modal.close();
                        try {
                            await this.plugin.seriesManager.createProjectInSeries(folder, newTitle.trim());
                        } catch (e: unknown) {
                            new Notice((e instanceof Error ? e.message : String(e)), 10000);
                            return;
                        }
                        this.plugin.refreshOpenViews();
                        this.render();
                        return;
                    }

                    const bookProject = projects.find(p => p.filePath === selectedPath);
                    if (!bookProject) return;
                    modal.close();

                    const previousActive = this.plugin.sceneManager.activeProject;
                    await this.plugin.sceneManager.setActiveProject(bookProject);
                    try {
                        await this.plugin.seriesManager.addProjectToSeries(folder);
                    } catch (e: unknown) {
                        new Notice((e instanceof Error ? e.message : String(e)), 10000);
                        return;
                    }
                    if (previousActive && previousActive.filePath !== bookProject.filePath) {
                        await this.plugin.sceneManager.scanProjects();
                        const refreshed = this.plugin.sceneManager.getProjects().find(p => p.filePath === previousActive.filePath);
                        if (refreshed) await this.plugin.sceneManager.setActiveProject(refreshed);
                    }
                    this.plugin.refreshOpenViews();
                    this.render();
                });
            });

        openStackedModal(modal);
    }
}
/* eslint-enable @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-argument, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-return, @typescript-eslint/no-floating-promises, @typescript-eslint/no-misused-promises, @typescript-eslint/no-unnecessary-type-assertion, @typescript-eslint/no-unused-vars, no-useless-escape -- end of file-wide suppression block opened at line 1 */
