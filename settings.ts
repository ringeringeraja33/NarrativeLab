/* eslint-disable @typescript-eslint/no-floating-promises, @typescript-eslint/no-misused-promises, @typescript-eslint/no-unnecessary-type-assertion -- Obsidian's API surface and several untyped third-party libraries force dynamic dispatch; floating promises are intentional in DOM/event handlers; matching enable at end of file */
import type SceneCardsPlugin from './main';
import { SLDocxSettings, SL_DEFAULT_DOCX_SETTINGS } from './services/DocxConverter';
import { SLPdfSettings, SL_DEFAULT_PDF_SETTINGS } from './services/PdfConverter';
import { AddFieldModal } from './components/AddFieldModal';
import type { UniversalFieldTemplate } from './services/FieldTemplateService';
import { BeatSheetTemplate, BUILTIN_BEAT_SHEETS, BUILTIN_SCENE_TEMPLATES, ColorCodingMode, CustomStatusDef, ProjectPresetTemplate, SceneStatus, SceneTemplate, TemplateScope, ViewType, getStatusConfig, getStatusOrder, registerCustomStatuses } from './models/Scene';
import { App, FuzzySuggestModal, Modal, Notice, PluginSettingTab, Setting, TFile, TFolder, TextAreaComponent, AbstractInputSuggest } from 'obsidian';
import * as obsidian from 'obsidian';
import { SUPPORTED_STORYLINE_LOCALES, normalizeStoryLineLocale } from './utils/locale';
import { localizeBeatSheet, localizeElement, localizeSceneTemplate, t, type UiLanguageSetting } from './utils/i18n';
import type { CustomSection } from './components/CustomSectionsRenderer';
import { BeatSheetApplyModal } from './components/BeatSheetApplyModal';
import { applyLibraryCategorySettings, reconcileLibraryCategoriesForActiveProject } from './services/LibraryCategorySync';
import { syncAllNativeLibraryBases } from './components/NativeLibraryBase';

// ═══════════════════════════════════════════════════════
//  COLOR PALETTES — Catppuccin + Mood-based
// ═══════════════════════════════════════════════════════

export type ColorScheme =
    // Catppuccin
    | 'latte' | 'frappe' | 'macchiato' | 'mocha'
    // Mood-based
    | 'spring' | 'morning' | 'summer' | 'dusk'
    | 'midnight' | 'autumn' | 'ocean' | 'forest'
    | 'sunset' | 'arctic' | 'vintage' | 'neon'
    // Manual
    | 'custom';

export const COLOR_SCHEME_LABELS: Record<ColorScheme, string> = {
    // Catppuccin
    latte:     'Latte',
    frappe:    'Frappé',
    macchiato: 'Macchiato',
    mocha:     'Mocha',
    // Mood
    spring:    'Spring',
    morning:   'Morning',
    summer:    'Summer',
    dusk:      'Dusk',
    midnight:  'Midnight',
    autumn:    'Autumn',
    ocean:     'Ocean',
    forest:    'Forest',
    sunset:    'Sunset',
    arctic:    'Arctic',
    vintage:   'Vintage',
    neon:      'Neon',
    // Manual
    custom:    'Custom',
};

/** Short mood descriptions for the settings UI */
export const COLOR_SCHEME_HINTS: Record<ColorScheme, string> = {
    latte:     'Pastel on light',
    frappe:    'Soft on mid-dark',
    macchiato: 'Muted on dark',
    mocha:     'Pastel on darkest',
    spring:    'Fresh & floral',
    morning:   'Warm & golden',
    summer:    'Vivid & bold',
    dusk:      'Warm & moody',
    midnight:  'Deep & mysterious',
    autumn:    'Earthy & harvest',
    ocean:     'Aquatic blues',
    forest:    'Woodland greens',
    sunset:    'Fiery & dramatic',
    arctic:    'Icy & crisp',
    vintage:   'Muted & nostalgic',
    neon:      'Electric & vivid',
    custom:    'Manual per-tag',
};

/** 14 accent colors per palette, ordered for maximum visual distinction */
const COLOR_PALETTES: Record<Exclude<ColorScheme, 'custom'>, string[]> = {
    // ── Catppuccin ──────────────────────────────────
    latte: [
        '#8839ef', '#fe640b', '#1e66f5', '#40a02b', '#e64553',
        '#179299', '#df8e1d', '#7287fd', '#ea76cb', '#04a5e5',
        '#d20f39', '#209fb5', '#dd7878', '#dc8a78',
    ],
    frappe: [
        '#ca9ee6', '#ef9f76', '#8caaee', '#a6d189', '#e78284',
        '#81c8be', '#e5c890', '#babbf1', '#f4b8e4', '#99d1db',
        '#ea999c', '#85c1dc', '#eebebe', '#f2d5cf',
    ],
    macchiato: [
        '#c6a0f6', '#f5a97f', '#8aadf4', '#a6da95', '#ed8796',
        '#8bd5ca', '#eed49f', '#b7bdf8', '#f5bde6', '#91d7e3',
        '#ee99a0', '#7dc4e4', '#f0c6c6', '#f4dbd6',
    ],
    mocha: [
        '#cba6f7', '#fab387', '#89b4fa', '#a6e3a1', '#f38ba8',
        '#94e2d5', '#f9e2af', '#b4befe', '#f5c2e7', '#89dceb',
        '#eba0ac', '#74c7ec', '#f2cdcd', '#f5e0dc',
    ],

    // ── Mood-based ──────────────────────────────────

    spring: [
        '#e87898', // rose
        '#d458a0', // fuchsia
        '#b07cc8', // wisteria
        '#7888d8', // iris
        '#58a8e0', // cornflower
        '#48c4a8', // mint
        '#68c468', // clover
        '#98c448', // lime
        '#d4c040', // primrose
        '#e8a848', // marigold
        '#e87858', // coral
        '#c868a8', // peony
        '#58b8c8', // brook
        '#a8a858', // moss
    ],
    morning: [
        '#d89838', // sunrise
        '#c88040', // amber
        '#e0a870', // peach
        '#c88080', // blush
        '#a86898', // plum
        '#8880b8', // lavender
        '#6898c8', // sky
        '#58a890', // dewdrop
        '#80a860', // sage
        '#c8b850', // wheat
        '#d87840', // clay
        '#a85840', // brick
        '#589898', // mist
        '#9870a8', // violet
    ],
    summer: [
        '#e03058', // cherry
        '#e86020', // flame
        '#e8b008', // sun
        '#40b828', // lime
        '#08a868', // jade
        '#08b8c0', // cyan
        '#1880e0', // azure
        '#4058e0', // indigo
        '#8830d0', // violet
        '#d028a0', // pink
        '#c89818', // gold
        '#e84870', // raspberry
        '#189898', // teal
        '#984818', // rust
    ],
    dusk: [
        '#c07838', // glow
        '#986040', // umber
        '#886088', // mauve
        '#6868a0', // slate
        '#507888', // steel
        '#588870', // sage
        '#888850', // olive
        '#b89838', // ochre
        '#b06858', // terra
        '#785888', // plum
        '#907848', // bronze
        '#688868', // fern
        '#984858', // wine
        '#b89070', // sand
    ],
    midnight: [
        '#4858a8', // navy
        '#6040a0', // indigo
        '#384878', // deep
        '#286868', // teal
        '#703878', // plum
        '#587098', // steel
        '#784050', // wine
        '#607088', // storm
        '#305898', // sapphire
        '#287878', // cyan
        '#885888', // twilight
        '#506878', // slate
        '#388860', // aurora
        '#985878', // rose
    ],
    autumn: [
        '#c87020', // pumpkin
        '#a83020', // crimson
        '#788828', // olive
        '#c89820', // golden
        '#702820', // auburn
        '#984018', // rust
        '#689040', // sage
        '#b08020', // bronze
        '#901828', // cranberry
        '#a86830', // copper
        '#507028', // moss
        '#984838', // clay
        '#806028', // umber
        '#782030', // merlot
    ],
    ocean: [
        '#183870', // deep navy
        '#e07060', // coral
        '#188880', // teal
        '#70c8a8', // seafoam
        '#2870b8', // cobalt
        '#c8b070', // sand
        '#38b8a8', // aquamarine
        '#5070a0', // steel
        '#18a8c0', // turquoise
        '#c0a898', // driftwood
        '#085858', // abyss
        '#3090a0', // lagoon
        '#4888c8', // wave
        '#d08088', // shell
    ],
    forest: [
        '#2e6b3e', // pine
        '#5b7b3b', // moss
        '#4b9b4b', // fern
        '#7b6b4b', // bark
        '#9b8b7b', // mushroom
        '#7b9b5b', // sage
        '#2b8b5b', // emerald
        '#6b7b3b', // olive
        '#8b5b3b', // cedar
        '#8ba87b', // lichen
        '#b8883b', // amber
        '#4b5b3b', // understory
        '#8b3b5b', // berry
        '#b8a04b', // golden leaf
    ],
    sunset: [
        '#e86018', // blaze
        '#c82030', // crimson
        '#e838a0', // hot pink
        '#d8a010', // gold
        '#7830a8', // royal
        '#d018a0', // magenta
        '#e84828', // vermilion
        '#c89018', // amber
        '#8048c0', // violet
        '#d82838', // scarlet
        '#f08018', // tangerine
        '#c85878', // rose
        '#882878', // plum
        '#e86838', // flame
    ],
    arctic: [
        '#8ab8d8', // ice
        '#b0c8d8', // frost
        '#60c8a0', // aurora
        '#90b0d8', // polar
        '#a0a8b8', // cool gray
        '#58a8b8', // arctic teal
        '#b0a8c8', // snow lavender
        '#78c0d0', // glacier
        '#8898a8', // steel
        '#b0c0c8', // moonstone
        '#78c8d8', // pale cyan
        '#88d0b8', // mint
        '#a8b0b8', // silver
        '#68d0b0', // jade
    ],
    vintage: [
        '#c08888', // dusty rose
        '#88a880', // sage
        '#c0a050', // mustard
        '#883848', // burgundy
        '#508888', // teal
        '#a080a0', // mauve
        '#b8a060', // straw
        '#687840', // olive
        '#6878a0', // slate
        '#a86038', // rust
        '#885878', // plum
        '#487858', // forest
        '#a87850', // clay
        '#6888a8', // denim
    ],
    neon: [
        '#ff2890', // hot pink
        '#0098ff', // electric blue
        '#88ff28', // lime
        '#a828ff', // purple
        '#00e8e8', // cyan
        '#ffe800', // yellow
        '#ff28d8', // magenta
        '#28ff88', // neon green
        '#ff7800', // orange
        '#7828ff', // violet
        '#00d8d8', // turquoise
        '#ff2828', // red
        '#b8ff28', // chartreuse
        '#28ffd8', // aqua
    ],
};

/**
 * Get the palette array for a given scheme.
 * Returns undefined for 'custom'.
 */
export function getSchemeColors(scheme: ColorScheme): string[] | undefined {
    if (scheme === 'custom') return undefined;
    return COLOR_PALETTES[scheme];
}

// ── Sticky Note Color System ────────────────────────────────

/** 14 named base colors for sticky notes */
export const STICKY_NOTE_COLOR_NAMES = [
    'Yellow', 'Gold', 'Orange', 'Coral', 'Pink', 'Rose', 'Lavender',
    'Violet', 'Blue', 'Sky', 'Teal', 'Mint', 'Green', 'Sage',
] as const;

export type StickyNoteThemeId = 'classic' | 'pastel' | 'warm' | 'cool' | 'earth' | 'vivid';

export const STICKY_NOTE_THEME_LABELS: Record<StickyNoteThemeId, string> = {
    classic: 'Classic',
    pastel:  'Pastel',
    warm:    'Warm',
    cool:    'Cool',
    earth:   'Earth',
    vivid:   'Vivid',
};

export const STICKY_NOTE_THEME_HINTS: Record<StickyNoteThemeId, string> = {
    classic: 'Clean, balanced pastels',
    pastel:  'Very light & airy',
    warm:    'Soft sunny pastels',
    cool:    'Clear cool pastels',
    earth:   'Light natural pastels',
    vivid:   'Fresh, colourful pastels',
};

/** 14 harmonized colours per theme (order matches STICKY_NOTE_COLOR_NAMES) */
export const STICKY_NOTE_THEMES: Record<StickyNoteThemeId, string[]> = {
    classic: [
        '#FFF8CC', // Yellow
        '#FFF1C7', // Gold
        '#FFEAD5', // Orange
        '#FFE3DE', // Coral
        '#FFE3ED', // Pink
        '#FBE1F0', // Rose
        '#F0E5FA', // Lavender
        '#E8E5FA', // Violet
        '#E2EBFC', // Blue
        '#E1F3FC', // Sky
        '#DFF6F2', // Teal
        '#E3F8EA', // Mint
        '#EAF8E1', // Green
        '#F2F5DC', // Sage
    ],
    pastel: [
        '#FFFBE3', // Yellow
        '#FFF6DE', // Gold
        '#FFF0E5', // Orange
        '#FFEAE8', // Coral
        '#FFEAF2', // Pink
        '#FCE8F4', // Rose
        '#F4ECFC', // Lavender
        '#EDEBFC', // Violet
        '#EAF0FD', // Blue
        '#E9F6FD', // Sky
        '#E8F9F6', // Teal
        '#EBFAF0', // Mint
        '#F0FAEA', // Green
        '#F7F8E7', // Sage
    ],
    warm: [
        '#FFF6CF', // Yellow
        '#FFEBC7', // Gold
        '#FFE4D0', // Orange
        '#FFDDD8', // Coral
        '#FFDFE9', // Pink
        '#FADDEB', // Rose
        '#F1E2F3', // Lavender
        '#EAE2F3', // Violet
        '#E4EAF5', // Blue
        '#E1F0F5', // Sky
        '#E1F4EF', // Teal
        '#E5F6E8', // Mint
        '#ECF6DE', // Green
        '#F4F3D8', // Sage
    ],
    cool: [
        '#F9F7D9', // Yellow
        '#F4F0D8', // Gold
        '#F2EADF', // Orange
        '#F2E4E6', // Coral
        '#F1E2ED', // Pink
        '#ECE1F2', // Rose
        '#E9E4FA', // Lavender
        '#E2E5FC', // Violet
        '#DEE9FD', // Blue
        '#DCF2FD', // Sky
        '#DAF6F5', // Teal
        '#DFF8EC', // Mint
        '#E6F8E4', // Green
        '#EFF5DC', // Sage
    ],
    earth: [
        '#F8F3D8', // Yellow
        '#F4EBD7', // Gold
        '#F3E5D9', // Orange
        '#F3E0DE', // Coral
        '#F1DFE5', // Pink
        '#EDDEE7', // Rose
        '#EAE2EE', // Lavender
        '#E5E1EF', // Violet
        '#E0E6F0', // Blue
        '#DEEAF0', // Sky
        '#DDEEEB', // Teal
        '#E0F1E7', // Mint
        '#E6F1DE', // Green
        '#EEF0D9', // Sage
    ],
    vivid: [
        '#FFF3B8', // Yellow
        '#FFE6B3', // Gold
        '#FFDCC2', // Orange
        '#FFD1CB', // Coral
        '#FFD0E0', // Pink
        '#F8CCE6', // Rose
        '#EACFF8', // Lavender
        '#DDD0FA', // Violet
        '#D0DEFC', // Blue
        '#CDEEFE', // Sky
        '#CAF4EF', // Teal
        '#D0F7DF', // Mint
        '#DCF7CF', // Green
        '#EDF1C6', // Sage
    ],
};

// ── HSL helpers ─────────────────────────────────────────────

function hexToHSL(hex: string): [number, number, number] {
    const h = hex.replace('#', '');
    const r = Number.parseInt(h.slice(0, 2), 16) / 255;
    const g = Number.parseInt(h.slice(2, 4), 16) / 255;
    const b = Number.parseInt(h.slice(4, 6), 16) / 255;
    const max = Math.max(r, g, b), min = Math.min(r, g, b);
    const l = (max + min) / 2;
    if (max === min) return [0, 0, l * 100];
    const d = max - min;
    const s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
    let hue = 0;
    if (max === r) hue = ((g - b) / d + (g < b ? 6 : 0)) / 6;
    else if (max === g) hue = ((b - r) / d + 2) / 6;
    else hue = ((r - g) / d + 4) / 6;
    return [hue * 360, s * 100, l * 100];
}

function hslToHex(h: number, s: number, l: number): string {
    h = ((h % 360) + 360) % 360;
    s = Math.max(0, Math.min(100, s)) / 100;
    l = Math.max(0, Math.min(100, l)) / 100;
    const a = s * Math.min(l, 1 - l);
    const f = (n: number) => {
        const k = (n + h / 30) % 12;
        const c = l - a * Math.max(Math.min(k - 3, 9 - k, 1), -1);
        return Math.round(c * 255).toString(16).padStart(2, '0');
    };
    return `#${f(0)}${f(8)}${f(4)}`.toUpperCase();
}

/**
 * Apply hue-shift, saturation and lightness adjustments to a hex colour.
 * Adjustments are additive on the 0-100 / 0-360 scales.
 */
export function adjustHSL(hex: string, hueShift: number, satShift: number, lightShift: number): string {
    const [h, s, l] = hexToHSL(hex);
    return hslToHex(h + hueShift, s + satShift, l + lightShift);
}

/** Keep every sticky-note colour clean and pastel, including legacy/custom values. */
export function cleanStickyNoteColor(hex: string): string {
    if (!/^#[0-9a-fA-F]{6}$/.test(hex)) return '#FFF8CC';
    const [h, s, l] = hexToHSL(hex);
    return hslToHex(h, Math.min(s, 68), Math.max(l, 88));
}

/**
 * Return '#fff' or '#000' depending on which has better contrast against the
 * given background colour (WCAG relative-luminance formula).
 */
export function contrastTextColor(bgHex: string): string {
    const h = bgHex.replace('#', '');
    const r = Number.parseInt(h.slice(0, 2), 16) / 255;
    const g = Number.parseInt(h.slice(2, 4), 16) / 255;
    const b = Number.parseInt(h.slice(4, 6), 16) / 255;
    const toLinear = (c: number) => c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
    const luminance = 0.2126 * toLinear(r) + 0.7152 * toLinear(g) + 0.0722 * toLinear(b);
    return luminance > 0.4 ? '#000' : '#fff';
}

/**
 * Resolve the final 14 sticky-note colours, applying:
 *  1. Theme base → 2. Per-index override → 3. Global HSL adjustments
 */
export function resolveStickyNoteColors(settings: {
    stickyNoteTheme: StickyNoteThemeId;
    stickyNoteOverrides: Record<number, string>;
    stickyNoteHue: number;
    stickyNoteSaturation: number;
    stickyNoteLightness: number;
    /**
     * Issue #205 — custom font colour for sticky-note text on LIGHT
     * backgrounds. Empty string means "auto" (derived by darkening the
     * note background). Paired with `stickyNoteFontColorDark` so users
     * can keep text readable across both bright and dark note colours.
     */
    stickyNoteFontColorLight?: string;
    /**
     * Issue #205 — custom font colour for sticky-note text on DARK
     * backgrounds. Empty string means "auto" (derived by lightening the
     * note background).
     */
    stickyNoteFontColorDark?: string;
}): Array<{ label: string; color: string }> {
    const base = STICKY_NOTE_THEMES[settings.stickyNoteTheme] ?? STICKY_NOTE_THEMES.classic;
    return base.map((c, i) => {
        const overridden = settings.stickyNoteOverrides[i] ?? c;
        const final = (settings.stickyNoteHue === 0 && settings.stickyNoteSaturation === 0 && settings.stickyNoteLightness === 0)
            ? overridden
            : adjustHSL(overridden, settings.stickyNoteHue, settings.stickyNoteSaturation, settings.stickyNoteLightness);
        return { label: STICKY_NOTE_COLOR_NAMES[i], color: cleanStickyNoteColor(final) };
    });
}

/**
 * Issue #205 — resolve the custom sticky-note font colour for a given
 * note background. Returns a `#rrggbb` hex string when the user has set a
 * custom font colour for the relevant brightness bucket, or `undefined`
 * when the colour should be auto-derived from the note background (the
 * historical behaviour).
 *
 * Two buckets are supported so a single global setting stays readable
 * across both bright pastels and dark note colours: the plugin picks the
 * light- or dark-background variant based on the WCAG relative luminance
 * of each note's background.
 */
export function resolveStickyNoteFontColor(
    _settings: { stickyNoteFontColorLight?: string; stickyNoteFontColorDark?: string },
    _noteBgHex: string,
): string {
    return '#111111';
}

/**
 * Resolve the effective color for a tag.
 * Priority: custom tagColors override > scheme auto-assignment > fallback.
 * HSL adjustments are applied to scheme-assigned colours (not custom overrides).
 */
export function resolveTagColor(
    tag: string,
    tagIndex: number,
    scheme: ColorScheme,
    tagColors: Record<string, string>,
    hslAdj?: { hue: number; sat: number; light: number },
): string {
    // Custom override always wins (no HSL applied — user chose exact colour)
    if (tagColors[tag]) return tagColors[tag];
    // Scheme auto-assign
    const palette = getSchemeColors(scheme);
    if (palette) {
        const base = palette[tagIndex % palette.length];
        if (hslAdj && (hslAdj.hue !== 0 || hslAdj.sat !== 0 || hslAdj.light !== 0)) {
            return adjustHSL(base, hslAdj.hue, hslAdj.sat, hslAdj.light);
        }
        return base;
    }
    // Fallback grey
    return '#888888';
}

/** Build the HSL adjustment object from plugin settings (for pass to resolveTagColor) */
export function getPlotlineHSL(settings: { plotlineHue: number; plotlineSaturation: number; plotlineLightness: number }): { hue: number; sat: number; light: number } {
    return { hue: settings.plotlineHue, sat: settings.plotlineSaturation, light: settings.plotlineLightness };
}

/**
 * Plugin settings interface
 */
export interface SceneCardsSettings {
    // Project setup
    /** NarrativeLab and embedded Canvas interface language. */
    interfaceLanguage: UiLanguageSetting;
    /** Default parent folder for newly created projects. Existing projects may live anywhere. */
    storyLineRoot: string;
    /** Folder name inside each project root where attachments are stored (default: Attachments). */
    projectAttachmentFolder: string;
    activeProjectFile: string;
    /** Namespaced settings and session data owned by the embedded Narrative Canvas module. */
    narrativeCanvasData?: Record<string, unknown>;
    /** Last-opened .ncanvas path keyed by NarrativeLab project manifest path. */
    narrativeCanvasPathByProject: Record<string, string>;

    // Scene defaults
    defaultStatus: SceneStatus;
    autoGenerateSequence: boolean;
    defaultTargetWordCount: number;
    /** User-defined custom statuses appended after the built-in six */
    customStatuses: CustomStatusDef[];

    // Display
    defaultView: ViewType;
    defaultBoardMode: 'corkboard' | 'kanban';
    /** Remembered board sub-mode from last session */
    lastBoardMode: 'corkboard' | 'kanban';
    /** Remembered kanban groupBy from last session */
    lastBoardGroupBy: string;
    /** Remembered Library content tab: Profiles / Browse / Story Graph */
    lastLibraryContentMode: 'profile' | 'browse' | 'story-graph';
    /** Remembered Library category tab (characters, locations, or a codex id) */
    lastLibraryCategoryId: string;
    /**
     * Remembered Structure sub-tab:
     * timeline / tracks (Timeline view) or plot-list / subway (Storyline view).
     */
    lastStructureMode: 'timeline' | 'tracks' | 'plot-list' | 'subway';
    /** Remembered Storyline (Plotlines) view mode from last session */
    lastStorylineViewMode: 'list' | 'subway';
    /** Remembered Storyline view sort mode from last session */
    lastStorylineSortMode: 'alpha' | 'scenes-desc' | 'scenes-asc' | 'reading-order';
    /** Remembered Storyline subway tag-pill visibility from last session */
    lastStorylineShowTagPills: boolean;
    /** Remembered Timeline order from last session */
    timelineOrder: 'reading' | 'chronological';
    /** Remembered Timeline swimlane mode from last session */
    timelineSwimlaneMode: boolean;
    /** Remembered Timeline swimlane group-by from last session */
    timelineSwimlaneGroupBy: string;
    /** Remembered Research view active tag filter */
    researchActiveTag: string | null;
    /** Remembered Research view active type filter */
    researchActiveType: string | null;
    /** Navigator folders whose collapsed state persists between view openings. */
    navigatorCollapsedSections: Array<'notes' | 'scenes'>;
    autoOpenNavigator: boolean;
    /**
     * Concept Grid: when true, ALL data cells open the Markdown cell editor
     * instead of Univer in-cell edit. When false (default), only linked-note /
     * wikilink cells are forced through the Markdown editor; plain cells stay
     * click-to-edit in Univer. Header labels and formula cells always use Univer.
     */
    plotGridMarkdownEditMode: boolean;
    showNotesInKanban: boolean;
    showScenesInCorkboard: boolean;
    colorCoding: ColorCodingMode;
    showWordCounts: boolean;
    /** Exclude Arc Point scenes from aggregate word counts and stats */
    excludeArcAnchorFromWordcount: boolean;
    showSceneNumberOnCards: boolean;
    compactCardView: boolean;
    /** What text to show beneath a scene card title: nothing, the synopsis field, or the first lines of the draft body. */
    cardPreviewSource: 'none' | 'synopsis' | 'body' | 'conflict';
    characterCardPortraitSize: number;

    // Writing goals
    dailyWordGoal: number;
    weeklyWordGoal: number;
    monthlyWordGoal: number;
    projectWordGoal: number;

    // Custom location types (user-defined)
    customLocationTypes?: string[];

    // Advanced
    enablePlotHoleDetection: boolean;

    // Scene templates
    sceneTemplates: SceneTemplate[];
    structureTemplates: BeatSheetTemplate[];
    projectPresets: ProjectPresetTemplate[];

    // Tag / plotline color scheme
    colorScheme: ColorScheme;

    // Tag / plotline color assignments (custom overrides)
    tagColors: Record<string, string>;

    // Plotline colour HSL adjustments (applied to scheme colours)
    plotlineHue: number;
    plotlineSaturation: number;
    plotlineLightness: number;

    // Manual tag-type overrides (tag name lowercased → 'prop' | 'location' | 'character' | 'other')
    tagTypeOverrides: Record<string, string>;

    /** User-defined semantic categories for wikilink edges in the Story Graph. */
    storyGraphRelationCategories?: Array<{
        id: string;
        label: string;
        color: string;
        /** `single` (default) or `double` arrows on the Story Graph. */
        arrow?: 'single' | 'double';
    }>;
    /** Directed source-path → target-path edge keys mapped to a relation category id. */
    storyGraphLinkRelationAssignments?: Record<string, string>;
    /**
     * Character↔character relation styles (labels/colors/arrows) for the Story Graph.
     * Bidirectionally merged with types found on character `relations[]`.
     */
    storyGraphCharacterRelationTypes?: Array<{
        id: string;
        label: string;
        color: string;
        arrow?: 'single' | 'double';
        baseType: 'ally' | 'enemy' | 'romantic' | 'family' | 'mentor' | 'other';
        category?: 'family' | 'romantic' | 'social' | 'conflict' | 'guidance' | 'professional' | 'story' | 'custom';
        builtin?: boolean;
    }>;
    /**
     * Story Graph node fill/border colors per entity type
     * (scene, character, location, codex, prop, other).
     */
    storyGraphEntityColors?: Partial<Record<
        'scene' | 'character' | 'location' | 'codex' | 'prop' | 'other',
        { fill?: string; border?: string }
    >>;
    /**
     * Story Graph node fill/border colors per Library category id
     * (skills, items, creatures, uncategorized, …).
     */
    storyGraphLibraryCategoryColors?: Record<string, { fill?: string; border?: string }>;
    /**
     * Saved Story Graph layouts keyed by project file path (or `__global__`).
     * Positions use node filePath when available, else stable node id.
     */
    storyGraphLayouts?: Record<string, {
        positions: Record<string, { x: number; y: number }>;
        /** Optional per-node image overrides (vault-relative paths). */
        nodeImages?: Record<string, string>;
        /** Global node size multiplier (default 1). */
        nodeScale?: number;
        panX?: number;
        panY?: number;
        zoom?: number;
    }>;
    /**
     * Focus-view strand bundles keyed by undirected pair `pathA::pathB`.
     * Each strand becomes one parallel edge on the Story Graph.
     */
    storyGraphFocusBundles?: Record<string, {
        leftPath: string;
        rightPath: string;
        leftName?: string;
        rightName?: string;
        strands: Array<{
            id: string;
            direction: 'ltr' | 'rtl' | 'both';
            label: string;
            color: string;
            lineStyle: 'solid' | 'dashed' | 'dotted';
        }>;
    }>;

    // Manual character alias mappings (lowercased alias → canonical character name)
    // e.g. { "sven": "Sven Andersson" } — user-defined via "Link to…" in Characters view
    characterAliases: Record<string, string>;

    // Character names to hide from the "no profile yet" list (lowercased)
    ignoredCharacters: string[];

    /**
     * How NarrativeLab notes show Obsidian Properties / frontmatter.
     * - collapse: show the "Properties" header, folded by default (default)
     * - hide: fully hide the properties block
     * - visible: leave properties expanded / as Obsidian shows them
     *
     * Legacy `hideFrontmatter` is migrated and removed on load.
     */
    frontmatterDisplay: 'collapse' | 'hide' | 'visible';

    /**
     * Show only the icon (not the text label) on each view-switcher tab
     * when the toolbar is too narrow to fit both. Default `true` because
     * the auto-hide is silent and additive — wide toolbars still show
     * label + icon as before.
     */
    autoHideViewLabels?: boolean;

    // DOCX export settings (adapted from ToWord plugin)
    docxSettings: SLDocxSettings;

    // PDF export settings (desktop print-to-PDF)
    pdfSettings: SLPdfSettings;

    // Sticky note colour theme
    stickyNoteTheme: StickyNoteThemeId;
    // Per-index colour overrides (index 0–13 → hex)
    stickyNoteOverrides: Record<number, string>;
    // Global HSL adjustments applied on top of theme + overrides
    stickyNoteHue: number;
    stickyNoteSaturation: number;
    stickyNoteLightness: number;
    /**
     * Issue #205 — custom font colour for sticky-note text on LIGHT
     * backgrounds. Empty string means "auto" (derived by darkening the
     * note background). Paired with `stickyNoteFontColorDark` so a single
     * global setting stays readable across both bright and dark notes.
     */
    stickyNoteFontColorLight?: string;
    /**
     * Issue #205 — custom font colour for sticky-note text on DARK
     * backgrounds. Empty string means "auto" (derived by lightening the
     * note background).
     */
    stickyNoteFontColorDark?: string;

    // Per-project colour override flag
    // When true, colorScheme, plotline HSL, stickyNote theme/HSL/overrides
    // are saved into/loaded from the project’s System/plotlines.json
    useProjectColors: boolean;

    /**
     * Shell theme for NarrativeLab + Narrative Canvas.
     * `auto` follows Obsidian; `light` / `dark` override for this project.
     * Persisted in System/plotlines.json (`uiTheme`).
     */
    uiTheme: 'auto' | 'light' | 'dark';

    // ── Codex settings (active-project working copy) ───
    // Persisted per project in System/library-categories.json — not shared.
    /** IDs of enabled codex categories (e.g. ['items', 'creatures']) */
    codexEnabledCategories: string[];
    /** User-defined order for all Library tabs, including Characters and Locations. */
    libraryCategoryOrder?: string[];
    /** Fixed Library categories hidden from the tab bar (their definitions remain available). */
    libraryHiddenFixedCategories?: string[];
    /** User-created categories plus optional label/icon overrides for presets. */
    codexCustomCategories: Array<{
        id: string;
        label: string;
        icon: string;
        showInSidebar?: boolean;
        /** Always true. Kept so older category JSON still round-trips. */
        hasProfilePage?: boolean;
        preset?: boolean;
    }>;
    /**
     * Preset category ids permanently removed from the category manager.
     * Kept so deleted presets do not reappear; there is no restore UI.
     */
    codexDeletedPresetCategories?: string[];
    /** One-time per-project migration marker for the original Storyline preset categories. */
    codexPresetSeedVersion?: number;
    /** Per-category Browse layout: list | cards | table (keys: characters, locations, items, …) */
    libraryBrowseLayout?: Record<string, 'list' | 'cards' | 'table'>;
    /** Optional visible table column keys per category */
    libraryTableColumns?: Record<string, string[]>;
    /** Active per-column sort in each Library table. */
    libraryTableSort?: Record<string, { key: string; direction: 'asc' | 'desc' }>;
    /** Bases-style computed columns per Library category. */
    libraryTableFormulas?: Record<string, Array<{ id: string; name: string; expression: string }>>;
    /**
     * Which profile fields feed archive filter chips (Characters / Locations / Codex).
     * Keyed by category id (`characters`, `locations`, or a codex category id).
     * Use `__hashtags__` to include #tags scanned from text fields.
     */
    libraryArchiveFilterFields?: Record<string, string[]>;

    // Per-category default custom field templates (#115). When a new entry is created
    // in this category, the listed field names are pre-populated with empty values.
    // Keyed by category id (e.g. 'items', 'creatures', or a custom id).
    codexCategoryFieldTemplates?: Record<string, string[]>;
    // Per-category user-defined custom sections (#114). Each section has a title,
    // an ordered list of fields, and an optional `position` slot describing where
    // the section is inserted among the built-in sections.
    //
    // Field entries can be either:
    //   * a bare string (legacy v1.10.15 — equivalent to `{ name, type: 'text' }`), or
    //   * a rich `{ name, type, placeholder?, options? }` definition added in
    //     v1.10.17 so users get the same input types they're used to from
    //     universal field templates (text, textarea, dropdown, multi-select,
    //     checkbox).
    //
    // Field values still live in `<entity>.custom` keyed by the composite
    // `${sectionTitle} :: ${fieldName}` so existing data round-trips cleanly.
    codexCategoryCustomSections?: Record<string, CustomSection[]>;
    /** User-defined custom sections for Characters (per project; System/library-profile-layout.json). */
    characterCustomSections?: CustomSection[];
    /** User-defined custom sections for Locations / Worlds (per project). */
    locationCustomSections?: CustomSection[];
    /**
     * Built-in profile fields removed from the form for this project + archive page.
     * Keyed like `hiddenFields` (`character`, `location`, or a Codex category id).
     * Note data is kept; fields can be restored from the archive UI.
     */
    removedBuiltinFields?: Record<string, string[]>;
    /** Built-in section titles removed as whole columns (per archive category key). */
    removedBuiltinSections?: Record<string, string[]>;
    /**
     * Archive profile detail orientation per category key
     * (`character` / `location` / `world` / Codex category id).
     * Horizontal = section columns left-to-right; vertical = stacked sections.
     */
    profileOrientations?: Record<string, 'horizontal' | 'vertical'>;
    /** Series name — groups projects that share a common universe / codex */
    series: string;
    /** Extra vault-relative folder paths to scan for NarrativeLab entities */
    extraFolders: string[];

    /** Hidden built-in field keys per archive page (per project; e.g. { character: ['fears'], items: ['previousOwners'] }) */
    hiddenFields: Record<string, string[]>;

    /** Show the built-in formatting toolbar in scene editors when Editing Toolbar plugin is not installed */
    showFormattingToolbar: boolean;

    /** Focus mode: how much to darken the whole UI (0–100, percentage) */
    focusDarkenAmount: number;
    /** Focus mode: blur radius in px for everything outside the text area (0–20) */
    focusBlurAmount: number;

    /** Timeline drag-scroll: pixels per animation frame when auto-scrolling (1–30) */
    timelineDragScrollSpeed: number;
    /** Timeline drag-scroll: pixel zone from viewport edge that triggers scrolling (20–200) */
    timelineDragScrollZone: number;

    /** Play a sound when the writing sprint timer ends */
    sprintEndSound: boolean;

    /**
     * Issue #73 — when true, scene/character/location references in YAML are
     * written as Obsidian wikilinks (`[[Name]]`). Existing plain-text values
     * remain readable; readers strip wikilink syntax in either case.
     */
    writeFieldsAsWikilinks?: boolean;

    /**
     * Issue #71 — when true, custom field values defined via Universal Field
     * Templates are mirrored to top-level YAML keys (in addition to the
     * `universalFields:` block) so they are visible to Obsidian Properties,
     * Bases, and Dataview. Each template controls its own `topLevelKey`.
     */
    universalFieldsMirrorTopLevel?: boolean;

    /**
     * Issue #78 — when true, Obsidian `%%comment%%` blocks are stripped
     * from scene bodies before counting words. Defaults to true so that
     * `wordcount` reflects what the reader will actually see.
     */
    /** Count unit for scene length displays: 'words' (default) or 'chars'. */
    countUnit?: 'words' | 'chars';
    excludeCommentsFromWordcount?: boolean;

    /**
     * Issue #78 — when true, markdown task lines (`- [ ] …`, `- [x] …`)
     * are also dropped from the wordcount. Defaults to false because some
     * authors keep checklists as production notes that ship with the manuscript.
     */
    excludeChecklistFromWordcount?: boolean;

    /**
     * Default BCP-47 language tag applied to newly created projects (e.g. `'en'`,
     * `'sv'`, `'zh'`, `'ja'`, `'th'`). Drives word tokenisation, reading time,
     * stop-word filtering, dialogue % and PDF wrapping. Use `'auto'` to
     * auto-detect from manuscript text. Existing projects keep whatever
     * `language:` value is in their frontmatter.
     */
    defaultProjectLanguage?: string;

    /**
     * Issue #77 — raw YAML snippet merged into the frontmatter of every
     * newly-created scene. Lets users default fields like
     * `cssclasses: [fountain]` for use with companion plugins. NarrativeLab's
     * own keys (type, title, act, chapter, sequence, status…) always win
     * on conflict.
     */
    defaultSceneFrontmatter?: string;

    /**
     * Type of separator to insert between scenes in manuscript exports.
     * Can be a blank line, three asterisks (* * *), or a custom text string.
     */
    exportSceneSeparatorType?: 'blank' | 'asterisks' | 'custom';

    /**
     * Custom text/separator string to insert between scenes in manuscript exports
     * when `exportSceneSeparatorType` is set to 'custom'.
     */
    exportSceneSeparatorCustom?: string;
}

/**
 * Default settings
 */
export const DEFAULT_SETTINGS: SceneCardsSettings = {
    interfaceLanguage: 'auto',
    storyLineRoot: '',
    projectAttachmentFolder: 'Attachments',
    activeProjectFile: '',
    narrativeCanvasPathByProject: {},

    defaultStatus: 'idea',
    autoGenerateSequence: true,
    defaultTargetWordCount: 800,
    customStatuses: [],

    defaultView: 'board',
    defaultBoardMode: 'corkboard',
    lastBoardMode: 'corkboard',
    lastBoardGroupBy: 'act',
    lastLibraryContentMode: 'profile',
    lastLibraryCategoryId: 'characters',
    lastStructureMode: 'timeline',
    lastStorylineViewMode: 'subway',
    lastStorylineSortMode: 'reading-order',
    lastStorylineShowTagPills: true,
    timelineOrder: 'reading',
    timelineSwimlaneMode: false,
    timelineSwimlaneGroupBy: 'pov',
    researchActiveTag: null,
    researchActiveType: null,
    navigatorCollapsedSections: [],
    autoOpenNavigator: true,
    plotGridMarkdownEditMode: false,
    showNotesInKanban: false,
    showScenesInCorkboard: true,
    colorCoding: 'status',
    showWordCounts: true,
    excludeArcAnchorFromWordcount: true,
    showSceneNumberOnCards: true,
    compactCardView: false,
    cardPreviewSource: 'none',
    characterCardPortraitSize: 64,

    dailyWordGoal: 1000,
    weeklyWordGoal: 7000,
    monthlyWordGoal: 30000,
    projectWordGoal: 80000,
    customLocationTypes: [],

    enablePlotHoleDetection: true,

    sceneTemplates: [],
    structureTemplates: [],
    projectPresets: [],

    colorScheme: 'mocha' as ColorScheme,

    tagColors: {},

    plotlineHue: 0,
    plotlineSaturation: 0,
    plotlineLightness: 0,

    tagTypeOverrides: {},
    storyGraphRelationCategories: [],
    storyGraphLinkRelationAssignments: {},
    storyGraphCharacterRelationTypes: [],
    storyGraphEntityColors: {},
    storyGraphLibraryCategoryColors: {},
    storyGraphLayouts: {},
    storyGraphFocusBundles: {},

    characterAliases: {},

    ignoredCharacters: [],

    frontmatterDisplay: 'collapse',
    autoHideViewLabels: true,

    docxSettings: { ...SL_DEFAULT_DOCX_SETTINGS },

    pdfSettings: { ...SL_DEFAULT_PDF_SETTINGS },

    stickyNoteTheme: 'classic' as StickyNoteThemeId,
    stickyNoteOverrides: {},
    stickyNoteHue: 0,
    stickyNoteSaturation: 0,
    stickyNoteLightness: 0,
    stickyNoteFontColorLight: '',
    stickyNoteFontColorDark: '',

    useProjectColors: false,

    uiTheme: 'auto' as 'auto' | 'light' | 'dark',

    codexEnabledCategories: [],
    libraryCategoryOrder: [],
    libraryHiddenFixedCategories: [],
    codexCustomCategories: [],
    codexDeletedPresetCategories: [],
    codexPresetSeedVersion: 0,
    libraryBrowseLayout: {},
    libraryTableColumns: {},
    libraryTableSort: {},
    libraryTableFormulas: {},
    libraryArchiveFilterFields: {},
    codexCategoryFieldTemplates: {},
    codexCategoryCustomSections: {},
    characterCustomSections: [],
    locationCustomSections: [],
    removedBuiltinFields: {},
    removedBuiltinSections: {},
    profileOrientations: {},
    series: '',
    extraFolders: [],

    hiddenFields: {},

    showFormattingToolbar: true,


    focusDarkenAmount: 40,
    focusBlurAmount: 1,

    timelineDragScrollSpeed: 8,
    timelineDragScrollZone: 60,
    sprintEndSound: true,
    writeFieldsAsWikilinks: true,
    universalFieldsMirrorTopLevel: true,
    excludeCommentsFromWordcount: true,
    excludeChecklistFromWordcount: false,
    defaultProjectLanguage: 'en',
    defaultSceneFrontmatter: '',
    exportSceneSeparatorType: 'blank',
    exportSceneSeparatorCustom: '',
};

/** Settings page horizontal tab ids */
type NarrativeLabSettingsTabId = 'general' | 'scenes' | 'templates' | 'display' | 'colors' | 'writing' | 'export';

/**
 * Settings tab for the NarrativeLab plugin
 */
export class SceneCardsSettingTab extends PluginSettingTab {
    plugin: SceneCardsPlugin;
    private settingsTabId: NarrativeLabSettingsTabId = 'general';

    constructor(app: App, plugin: SceneCardsPlugin) {
        super(app, plugin);
        this.plugin = plugin;
    }

    private refreshSettingsView(): void {
        this.renderSettingsTab();
    }

    display(): void {
        this.renderSettingsTab();
    }

    private renderSettingsTab(): void {
        const { containerEl } = this;
        containerEl.empty();
        containerEl.addClass('narrative-lab-settings');

        const tabs: Array<{ id: NarrativeLabSettingsTabId; label: string }> = [
            { id: 'general', label: 'General' },
            { id: 'scenes', label: 'Scenes' },
            { id: 'templates', label: 'Template Center' },
            { id: 'display', label: 'Display' },
            { id: 'colors', label: 'Colors' },
            { id: 'writing', label: 'Writing' },
            { id: 'export', label: 'Converter / Export & Import' },
        ];
        const tabBar = containerEl.createDiv('nl-settings-tabs');
        for (const tab of tabs) {
            const btn = tabBar.createEl('button', {
                cls: 'nl-settings-tab' + (this.settingsTabId === tab.id ? ' is-active' : ''),
                text: t(tab.label),
            });
            btn.setAttr('type', 'button');
            btn.addEventListener('click', () => {
                if (this.settingsTabId === tab.id) return;
                this.settingsTabId = tab.id;
                this.renderSettingsTab();
            });
        }

        const panel = containerEl.createDiv('nl-settings-panel');
        switch (this.settingsTabId) {
            case 'scenes':
                this.renderScenesSettingsTab(panel);
                break;
            case 'templates':
                this.renderTemplatesSettingsTab(panel);
                break;
            case 'display':
                this.renderDisplaySettingsTab(panel);
                break;
            case 'colors':
                this.renderColorsSettingsTab(panel);
                break;
            case 'writing':
                this.renderWritingSettingsTab(panel);
                break;
            case 'export':
                this.renderExportAdvancedSettingsTab(panel);
                break;
            case 'general':
            default:
                this.renderGeneralSettingsTab(panel);
                break;
        }

        localizeElement(containerEl);
    }

    private renderGeneralSettingsTab(panel: HTMLElement): void {
        new Setting(panel)
            .setName(t('Interface language'))
            .setDesc(t("Choose the language used throughout NarrativeLab and Narrative Canvas. Auto follows Obsidian's interface language."))
            .addDropdown(dropdown => dropdown
                .addOption('auto', t('Auto (follow Obsidian)'))
                .addOption('en', t('English'))
                .addOption('zh', t('Chinese'))
                .setValue(this.plugin.settings.interfaceLanguage || 'auto')
                .onChange(async value => {
                    await this.plugin.setInterfaceLanguage(value as UiLanguageSetting);
                    this.refreshSettingsView();
                }));

        new Setting(panel)
            .setName(t('Default new-project folder'))
            .setDesc(t('Optional. Existing NarrativeLab projects are discovered anywhere in the vault.'))
            .addText(text => text
                .setPlaceholder(t('Vault root'))
                .setValue(this.plugin.settings.storyLineRoot)
                .onChange(async (value) => {
                    this.plugin.settings.storyLineRoot = value.trim();
                    await this.plugin.saveSettings();
                }));

        new Setting(panel)
            .setName(t('Project attachment folder'))
            .setDesc(t('Folder inside each project for scene and general attachments (default: Attachments). Library card images are stored under Library/<category>/Attachments instead.'))
            .addText(text => text
                .setPlaceholder(t('Attachments'))
                .setValue(this.plugin.settings.projectAttachmentFolder || 'Attachments')
                .onChange(async (value) => {
                    this.plugin.settings.projectAttachmentFolder = value.trim() || 'Attachments';
                    await this.plugin.saveSettings();
                }));

        new Setting(panel)
            .setName(t('Auto-open Navigator'))
            .setDesc(t('Automatically open the NarrativeLab Navigator in the left sidebar when the plugin starts or a project loads'))
            .addToggle(toggle => toggle
                .setValue(this.plugin.settings.autoOpenNavigator ?? true)
                .onChange(async (value) => {
                    this.plugin.settings.autoOpenNavigator = value;
                    await this.plugin.saveSettings();
                }));

        new Setting(panel)
            .setName(t('Properties on NarrativeLab notes'))
            .setDesc(t('Controls the Obsidian Properties block on notes inside NarrativeLab projects only. Your global Obsidian "Properties in document" setting is left untouched.'))
            .addDropdown(dropdown => {
                dropdown
                    .addOption('collapse', t('Folded (show header)'))
                    .addOption('hide', t('Hidden'))
                    .addOption('visible', t('Expanded'))
                    .setValue(this.plugin.settings.frontmatterDisplay || 'collapse')
                    .onChange(async (value) => {
                        const mode = value === 'hide' || value === 'visible' ? value : 'collapse';
                        this.plugin.settings.frontmatterDisplay = mode;
                        await this.plugin.saveSettings();
                        this.plugin.updateFrontmatterVisibility({ collapseOpenFiles: mode === 'collapse' });
                    });
            });

        new Setting(panel)
            .setName(t('Collapse view-tab labels when toolbar is narrow'))
            .setDesc(t('When the NarrativeLab toolbar is too narrow to fit every view-tab label, show only the icon (Corkboard, Timeline, etc.). Disable to always show both icon and text — the labels will wrap or be clipped if the toolbar is small.'))
            .addToggle(toggle => toggle
                .setValue(this.plugin.settings.autoHideViewLabels !== false)
                .onChange(async (value) => {
                    this.plugin.settings.autoHideViewLabels = value;
                    await this.plugin.saveSettings();
                    this.plugin.updateToolbarVisibility();
                }));

    }

    private renderScenesSettingsTab(panel: HTMLElement): void {
        // ═══════════════════════════════════════════
        //  Scene Defaults & Templates
        // ═══════════════════════════════════════════
        new Setting(panel).setName(t('Scene Defaults')).setHeading();

        new Setting(panel)
            .setName(t('Default status'))
            .setDesc(t('Status for newly created scenes'))
            .addDropdown(dropdown => {
                const statuses = getStatusOrder();
                const cfg = getStatusConfig();
                statuses.forEach(s => {
                    const label = cfg[s]?.label ?? (s.charAt(0).toUpperCase() + s.slice(1));
                    dropdown.addOption(s, t(label));
                });
                dropdown.setValue(this.plugin.settings.defaultStatus);
                dropdown.onChange(async (value) => {
                    this.plugin.settings.defaultStatus = value as SceneStatus;
                    await this.plugin.saveSettings();
                });
            });

        new Setting(panel)
            .setName(t('Auto-generate sequence'))
            .setDesc(t('Automatically assign sequence numbers to new scenes'))
            .addToggle(toggle => toggle
                .setValue(this.plugin.settings.autoGenerateSequence)
                .onChange(async (value) => {
                    this.plugin.settings.autoGenerateSequence = value;
                    await this.plugin.saveSettings();
                }));

        new Setting(panel)
            .setName(t('Target word count'))
            .setDesc(t('Default target word count per scene'))
            .addText(text => text
                .setPlaceholder('800')
                .setValue(String(this.plugin.settings.defaultTargetWordCount))
                .onChange(async (value) => {
                    this.plugin.settings.defaultTargetWordCount = Number(value) || 800;
                    await this.plugin.saveSettings();
                }));

        // ── Custom Statuses ──
        new Setting(panel).setName(t('Custom Statuses')).setHeading();
        panel.createEl('p', {
            cls: 'setting-item-description',
            text: t('Add custom scene statuses after the built-in six (Idea → Final). Useful for editorial workflows like "Sent to Team", "Waiting", "Published", etc.')
        });

        const customStatusList = panel.createDiv('sl-custom-status-list');
        const renderCustomStatusList = () => {
            customStatusList.empty();
            const defs = this.plugin.settings.customStatuses || [];
            if (defs.length === 0) {
                customStatusList.createEl('p', { cls: 'setting-item-description', text: t('No custom statuses defined.') });
            }
            for (let i = 0; i < defs.length; i++) {
                const def = defs[i];
                const row = customStatusList.createDiv('sl-custom-status-row');
                row.setCssStyles({
                    display: 'flex',
                    alignItems: 'center',
                    gap: '8px',
                    marginBottom: '4px',
                });

                const colorSwatch = row.createEl('input', { type: 'color' });
                colorSwatch.value = def.color;
                colorSwatch.setCssStyles({
                    width: '32px',
                    height: '28px',
                    border: 'none',
                    cursor: 'pointer',
                });
                colorSwatch.addEventListener('change', async () => {
                    def.color = colorSwatch.value;
                    registerCustomStatuses(this.plugin.settings.customStatuses);
                    await this.plugin.saveSettings();
                });

                const labelInput = row.createEl('input', { type: 'text', value: def.label });
                labelInput.placeholder = t('Label');
                labelInput.setCssStyles({ flex: '1' });
                labelInput.addEventListener('change', async () => {
                    def.label = labelInput.value.trim() || def.id;
                    registerCustomStatuses(this.plugin.settings.customStatuses);
                    await this.plugin.saveSettings();
                });

                const writtenLabel = row.createEl('label');
                writtenLabel.setCssStyles({ display: 'flex', alignItems: 'center', gap: '4px', fontSize: '12px', whiteSpace: 'nowrap' });
                const writtenCheckbox = writtenLabel.createEl('input', { type: 'checkbox' });
                writtenCheckbox.checked = def.countsAsWritten === true;
                writtenLabel.createSpan({ text: t('Counts as written') });
                writtenCheckbox.addEventListener('change', async () => {
                    def.countsAsWritten = writtenCheckbox.checked;
                    registerCustomStatuses(this.plugin.settings.customStatuses);
                    await this.plugin.saveSettings();
                    this.plugin.refreshOpenViews();
                });

                const removeBtn = row.createEl('button', { text: '×', cls: 'clickable-icon' });
                removeBtn.addEventListener('click', async () => {
                    defs.splice(i, 1);
                    registerCustomStatuses(this.plugin.settings.customStatuses);
                    await this.plugin.saveSettings();
                    renderCustomStatusList();
                });
            }
        };
        renderCustomStatusList();

        new Setting(panel)
            .setName(t('Add custom status'))
            .setDesc(t('Enter a name for the new status (e.g. "Sent to Team")'))
            .addText(text => {
                text.setPlaceholder(t('Status name…'));
                (text.inputEl as unknown as Record<string, unknown>)._ref = text;
            })
            .addButton(btn => {
                btn.setButtonText(t('Add')).setCta().onClick(async () => {
                    const input = btn.buttonEl.parentElement?.parentElement?.querySelector('input[type="text"]') as HTMLInputElement;
                    const name = input?.value?.trim();
                    if (!name) return;
                    const id = name.toLowerCase().replace(/\s+/g, '_').replace(/[^a-z0-9_]/g, '');
                    if (!id) return;
                    const existing = getStatusOrder();
                    if (existing.includes(id)) {
                        new (obsidian as unknown as { Notice: new (msg: string) => void }).Notice(
                            t('Status "{id}" already exists.', { id })
                        );
                        return;
                    }
                    if (!this.plugin.settings.customStatuses) this.plugin.settings.customStatuses = [];
                    this.plugin.settings.customStatuses.push({
                        id,
                        label: name,
                        color: '#607D8B',
                        icon: 'circle',
                        countsAsWritten: false,
                    });
                    registerCustomStatuses(this.plugin.settings.customStatuses);
                    await this.plugin.saveSettings();
                    input.value = '';
                    renderCustomStatusList();
                });
            });

        // ═══════════════════════════════════════════
        //  Custom Location Types
        // ═══════════════════════════════════════════
        new Setting(panel).setName(t('Custom Location Types')).setHeading();

        const locTypesDesc = panel.createEl('p', {
            cls: 'setting-item-description',
            text: t('Add your own location types (e.g. Planet, Star System, Galaxy, Dimension) — they appear in the Type dropdown alongside the built-in options.'),
        });
        locTypesDesc.setCssStyles({ marginBottom: '8px' });

        const renderCustomTypes = () => {
            // Remove any previously rendered list (when re-rendering after add/remove)
            panel.querySelectorAll('.sl-custom-loc-type-row').forEach(el => el.remove());

            const types = this.plugin.settings.customLocationTypes ?? [];
            for (const locationType of types) {
                new Setting(panel)
                    .setClass('sl-custom-loc-type-row')
                    .setName(locationType)
                    .addButton(btn => btn
                        .setIcon('trash')
                        .setTooltip(t('Remove'))
                        .onClick(async () => {
                            const list = (this.plugin.settings.customLocationTypes ?? [])
                                .filter(x => x !== locationType);
                            this.plugin.settings.customLocationTypes = list;
                            await this.plugin.saveSettings();
                            renderCustomTypes();
                        }));
            }

            // Add input row at the bottom
            let pending = '';
            new Setting(panel)
                .setClass('sl-custom-loc-type-row')
                .setName(t('Add new type'))
                .addText(text => text
                    .setPlaceholder(t('e.g. Planet'))
                    .onChange(v => (pending = v)))
                .addButton(btn => btn
                    .setButtonText(t('Add'))
                    .setCta()
                    .onClick(async () => {
                        const trimmed = pending.trim();
                        if (!trimmed) return;
                        const list = this.plugin.settings.customLocationTypes ?? [];
                        if (list.some(x => x.toLowerCase() === trimmed.toLowerCase())) {
                            return;
                        }
                        list.push(trimmed);
                        this.plugin.settings.customLocationTypes = list;
                        await this.plugin.saveSettings();
                        renderCustomTypes();
                    }));
        };
        renderCustomTypes();

        // ═══════════════════════════════════════════
        //  Custom Scene Fields
        // ═══════════════════════════════════════════
        new Setting(panel).setName(t('Custom Scene Fields')).setHeading();
        panel.createEl('p', {
            text: t('Define your own metadata fields that appear on every scene\'s Inspector. Useful for Story Grid functions, Truby aspects, beat-sheet labels, genre conventions, and any other scene tagging your method requires. Dropdown and multi-select fields can also be used to filter and group scenes on the Board.'),
            cls: 'setting-item-description',
        });

        const sceneFieldListEl = panel.createDiv('story-line-scene-fields-list');
        this.renderSceneCustomFieldList(sceneFieldListEl);

        new Setting(panel)
            .addButton(btn => btn
                .setButtonText(t('Add Scene Field'))
                .setCta()
                .onClick(() => {
                    if (!this.plugin.fieldTemplates) return;
                    const modal = new AddFieldModal(
                        this.app,
                        'Scene',
                        null,
                        async (template) => {
                            template.category = 'scene';
                            await this.plugin.fieldTemplates.add(template);
                            this.renderSceneCustomFieldList(sceneFieldListEl);
                        },
                        undefined,
                        ['Scene'],
                    );
                    modal.open();
                }));

    }

    private renderTemplatesSettingsTab(panel: HTMLElement): void {
        new Setting(panel).setName(t('Template Center')).setHeading();
        panel.createEl('p', {
            text: t('Manage global scene templates, narrative structures and project presets. Project-scoped templates are managed from the Navigator (right-click a project).'),
            cls: 'setting-item-description',
        });
        const tools = panel.createDiv('story-line-button-row');
        tools.createEl('button', { text: t('Export all templates') }).addEventListener('click', async () => {
            try {
                const path = await this.plugin.templateCenter.exportBundle();
                new Notice(t('Template bundle written: {path}', { path }));
            } catch (error) {
                new Notice(t('Could not export templates: {message}', { message: error instanceof Error ? error.message : String(error) }));
            }
        });
        tools.createEl('button', { text: t('Import templates…') }).addEventListener('click', () => {
            new TemplateBundleSuggestModal(this.app, async path => {
                try {
                    const result = await this.plugin.templateCenter.importBundle(path, 'global');
                    new Notice(t('Imported {scenes} scene template(s), {structures} structure(s), and {presets} preset(s).', result));
                    this.display();
                } catch (error) {
                    new Notice(t('Could not import templates: {message}', { message: error instanceof Error ? error.message : String(error) }));
                }
            }).open();
        });

        new Setting(panel).setName(t('Scene Templates')).setHeading();
        panel.createEl('p', { text: t('Pre-fill scene fields and Markdown body. Built-in templates are bilingual.'), cls: 'setting-item-description' });
        const templateListEl = panel.createDiv('story-line-template-list');
        this.renderTemplateList(templateListEl);
        new Setting(panel)
            .setName(t('Create a template'))
            .setDesc(t('Custom templates appear immediately in the Template dropdown when creating a scene.'))
            .addButton(btn => btn
                .setButtonText(t('Add Template'))
                .setIcon('plus')
                .setCta()
                .onClick(() => {
                    new TemplateEditorModal(this.app, {
                        id: '', scope: 'global', name: '', description: '', defaultFields: {}, bodyTemplate: '',
                    }, async template => {
                        template.scope = 'global';
                        await this.plugin.templateCenter.saveSceneTemplate(template);
                        this.renderTemplateList(templateListEl);
                    }, { forceScope: 'global' }).open();
                }));

        new Setting(panel).setName(t('Narrative Structures')).setHeading();
        panel.createEl('p', { text: t('Define acts, chapters and beats. Applying a structure always shows a change preview.'), cls: 'setting-item-description' });
        const structureList = panel.createDiv('story-line-template-list');
        this.renderStructureTemplateList(structureList);
        new Setting(panel)
            .setName(t('Create a structure template'))
            .addButton(button => button.setButtonText(t('Add Structure')).setIcon('plus').setCta().onClick(() => {
                new StructureTemplateEditorModal(this.app, {
                    id: '', scope: 'global', name: '', summary: '', acts: [1, 2, 3], chapters: [], actLabels: {}, chapterLabels: {}, beats: [],
                }, async template => {
                    template.scope = 'global';
                    await this.plugin.templateCenter.saveStructureTemplate(template);
                    this.renderStructureTemplateList(structureList);
                }, { forceScope: 'global' }).open();
            }));

        new Setting(panel).setName(t('Project Presets')).setHeading();
        panel.createEl('p', { text: t('A preset can combine a narrative structure, Library categories and project field templates.'), cls: 'setting-item-description' });
        const presetList = panel.createDiv('story-line-template-list');
        this.renderProjectPresetList(presetList);
        new Setting(panel)
            .setName(t('Create a global preset'))
            .setDesc(t('Creates an empty global preset. To snapshot the active project\'s Library setup, use Save as global preset in the Navigator project menu.'))
            .addButton(button => button.setButtonText(t('Add Preset')).setIcon('plus').setCta().onClick(() => {
                const preset: ProjectPresetTemplate = {
                    id: '',
                    scope: 'global',
                    name: '',
                };
                new ProjectPresetEditorModal(
                    this.app,
                    preset,
                    [...BUILTIN_BEAT_SHEETS.map(localizeBeatSheet), ...this.plugin.templateCenter.getStructureTemplates()],
                    [...BUILTIN_SCENE_TEMPLATES.map(localizeSceneTemplate), ...this.plugin.templateCenter.getSceneTemplates()],
                    async updated => {
                        updated.scope = 'global';
                        await this.plugin.templateCenter.saveProjectPreset(updated);
                        this.renderProjectPresetList(presetList);
                    },
                    { forceScope: 'global' },
                ).open();
            }));
    }

    private renderDisplaySettingsTab(panel: HTMLElement): void {
        // ═══════════════════════════════════════════
        //  Display Options
        // ═══════════════════════════════════════════
        new Setting(panel).setName(t('Display')).setHeading();

        new Setting(panel)
            .setName(t('Default view'))
            .setDesc(t('Which view to open by default'))
            .addDropdown(dropdown => {
                dropdown.addOption('board', t('Board'));
                dropdown.addOption('manuscript', t('Manuscript'));
                dropdown.addOption('plotgrid', t('Plotgrid'));
                dropdown.addOption('timeline', t('Timeline'));
                dropdown.addOption('storyline', t('Plotlines'));
                dropdown.addOption('codex', t('Library'));
                dropdown.addOption('character', t('Characters'));
                dropdown.addOption('location', t('Locations'));
                dropdown.addOption('stats', t('Statistics'));
                dropdown.setValue(this.plugin.settings.defaultView);
                dropdown.onChange(async (value) => {
                    this.plugin.settings.defaultView = value as ViewType;
                    await this.plugin.saveSettings();
                });
            });

        new Setting(panel)
            .setName(t('Default Board mode'))
            .setDesc(t('Which sub-view opens first inside Board'))
            .addDropdown(dropdown => {
                dropdown.addOption('corkboard', t('Corkboard'));
                dropdown.addOption('kanban', t('Kanban'));
                dropdown.setValue(this.plugin.settings.defaultBoardMode || 'corkboard');
                dropdown.onChange(async (value) => {
                    this.plugin.settings.defaultBoardMode = value as 'corkboard' | 'kanban';
                    await this.plugin.saveSettings();
                    this.plugin.refreshOpenViews();
                });
            });

        new Setting(panel)
            .setName(t('Color coding'))
            .setDesc(t('How to color-code scene cards'))
            .addDropdown(dropdown => {
                dropdown.addOption('status', t('By Status'));
                dropdown.addOption('pov', t('By POV Character'));
                dropdown.addOption('emotion', t('By Emotion'));
                dropdown.addOption('act', t('By Act'));
                dropdown.addOption('tag', t('By Tag / Plotline'));
                dropdown.setValue(this.plugin.settings.colorCoding);
                dropdown.onChange(async (value) => {
                    this.plugin.settings.colorCoding = value as ColorCodingMode;
                    await this.plugin.saveSettings();
                });
            });

        new Setting(panel)
            .setName(t('Show notes in Kanban'))
            .setDesc(t('When enabled, corkboard notes are also visible in Kanban columns'))
            .addToggle(toggle => toggle
                .setValue(this.plugin.settings.showNotesInKanban ?? false)
                .onChange(async (value) => {
                    this.plugin.settings.showNotesInKanban = value;
                    await this.plugin.saveSettings();
                    this.plugin.refreshOpenViews();
                }));

        new Setting(panel)
            .setName(t('Show scenes in Corkboard'))
            .setDesc(t('When enabled, scene cards are visible on the corkboard alongside notes'))
            .addToggle(toggle => toggle
                .setValue(this.plugin.settings.showScenesInCorkboard ?? true)
                .onChange(async (value) => {
                    this.plugin.settings.showScenesInCorkboard = value;
                    await this.plugin.saveSettings();
                    this.plugin.refreshOpenViews();
                }));

        new Setting(panel)
            .setName(t('Show word counts'))
            .setDesc(t('Display word counts on scene cards'))
            .addToggle(toggle => toggle
                .setValue(this.plugin.settings.showWordCounts)
                .onChange(async (value) => {
                    this.plugin.settings.showWordCounts = value;
                    await this.plugin.saveSettings();
                }));

        new Setting(panel)
            .setName(t('Exclude Arc Points from word count'))
            .setDesc(t('When enabled, scenes marked as Arc Points are excluded from aggregate word counts in Stats and the Manuscript footer'))
            .addToggle(toggle => toggle
                .setValue(this.plugin.settings.excludeArcAnchorFromWordcount ?? true)
                .onChange(async (value) => {
                    this.plugin.settings.excludeArcAnchorFromWordcount = value;
                    await this.plugin.saveSettings();
                    this.plugin.refreshOpenViews();
                }));

        new Setting(panel)
            .setName(t('Show scene number on cards'))
            .setDesc(t('Display the sequence number badge in the card header'))
            .addToggle(toggle => toggle
                .setValue(this.plugin.settings.showSceneNumberOnCards ?? true)
                .onChange(async (value) => {
                    this.plugin.settings.showSceneNumberOnCards = value;
                    await this.plugin.saveSettings();
                    this.plugin.refreshOpenViews();
                }));

        new Setting(panel)
            .setName(t('Compact card view'))
            .setDesc(t('Show less detail on scene cards'))
            .addToggle(toggle => toggle
                .setValue(this.plugin.settings.compactCardView)
                .onChange(async (value) => {
                    this.plugin.settings.compactCardView = value;
                    await this.plugin.saveSettings();
                }));

        new Setting(panel)
            .setName(t('Scene card preview text'))
            .setDesc(t('Show a short preview beneath each scene card title'))
            .addDropdown(dd => dd
                .addOption('none', t('None'))
                .addOption('synopsis', t('Synopsis'))
                .addOption('body', t('First lines of draft'))
                .addOption('conflict', t('Conflict'))
                .setValue(this.plugin.settings.cardPreviewSource || 'none')
                .onChange(async (value) => {
                    this.plugin.settings.cardPreviewSource = value as 'none' | 'synopsis' | 'body' | 'conflict';
                    await this.plugin.saveSettings();
                    this.plugin.refreshOpenViews();
                }));

        new Setting(panel)
            .setName(t('Formatting toolbar'))
            .setDesc(t('Show a formatting toolbar in scene editors when the Editing Toolbar plugin is not installed'))
            .addToggle(toggle => toggle
                .setValue(this.plugin.settings.showFormattingToolbar)
                .onChange(async (value) => {
                    this.plugin.settings.showFormattingToolbar = value;
                    await this.plugin.saveSettings();
                }));

        const imageDetails = panel.createEl('details', { cls: 'story-line-color-section' });
        imageDetails.createEl('summary', { text: t('Image & frame sizes') });
        const imageBody = imageDetails.createDiv();
        imageBody.setCssStyles({ padding: '8px 0' });

        const numberSetting = (
            parent: HTMLElement,
            name: string,
            desc: string,
            value: number,
            min: number,
            max: number,
            fallback: number,
            onSet: (next: number) => void,
        ) => {
            new Setting(parent)
                .setName(name)
                .setDesc(desc)
                .addText(text => text
                    .setPlaceholder(String(fallback))
                    .setValue(String(value))
                    .onChange(async (raw) => {
                        const parsed = Number(raw);
                        const next = Number.isFinite(parsed)
                            ? Math.max(min, Math.min(max, Math.round(parsed)))
                            : fallback;
                        onSet(next);
                        await this.plugin.saveSettings();
                    }));
        };

        numberSetting(
            imageBody,
            t('Character card portrait size'),
            t('Size in px for the circular portrait on character cards (default 64).'),
            this.plugin.settings.characterCardPortraitSize,
            32,
            200,
            64,
            (next) => this.plugin.settings.characterCardPortraitSize = next,
        );

        new Setting(imageBody)
            .setName(t('Reset image sizes'))
            .setDesc(t('Restore all image/frame sizes to default values.'))
            .addButton(btn => btn
                .setButtonText(t('Reset to defaults'))
                .onClick(async () => {
                    this.plugin.settings.characterCardPortraitSize = DEFAULT_SETTINGS.characterCardPortraitSize;
                    await this.plugin.saveSettings();
                    this.refreshSettingsView();
                }));

        const focusDetails = panel.createEl('details', { cls: 'story-line-color-section' });
        focusDetails.createEl('summary', { text: t('Focus Mode Settings') });
        const focusBody = focusDetails.createDiv();
        focusBody.setCssStyles({ padding: '12px 16px' });

        const focusDesc = focusBody.createDiv({ cls: 'setting-item-description' });
        focusDesc.setCssStyles({ marginBottom: '16px' });
        focusDesc.setText(t('Control how the UI changes when Focus mode is enabled in Manuscript view.'));

        const createFocusSlider = (
            parent: HTMLElement,
            label: string,
            desc: string,
            value: number,
            min: number,
            max: number,
            step: number,
            unit: string,
            onChange: (v: number) => void,
        ) => {
            const row = parent.createDiv();
            row.setCssStyles({
                display: 'flex',
                alignItems: 'center',
                gap: '8px',
                marginBottom: '6px',
            });

            const lbl = row.createSpan();
            lbl.setCssStyles({
                fontSize: '12px',
                minWidth: '90px',
            });
            lbl.textContent = label;
            lbl.title = desc;

            const slider = row.createEl('input', {
                type: 'range',
                attr: { min: String(min), max: String(max), step: String(step) },
            });
            slider.value = String(value);
            slider.setCssStyles({ flex: '1' });

            const valEl = row.createSpan();
            valEl.setCssStyles({
                fontSize: '11px',
                minWidth: '36px',
                textAlign: 'right',
            });
            valEl.textContent = `${value}${unit}`;

            let debounceTimer: number | null = null;
            slider.addEventListener('input', () => {
                const v = Number.parseFloat(slider.value);
                valEl.textContent = `${v}${unit}`;
                onChange(v);
                if (debounceTimer) window.clearTimeout(debounceTimer);
                debounceTimer = window.setTimeout(() => {
                    this.plugin.saveSettings();
                    this.plugin.refreshOpenViews();
                }, 300);
            });
        };

        // ── Environment group ──

        createFocusSlider(
            focusBody, t('Darken'),
            t('Darken the entire Obsidian UI (higher = darker overlay)'),
            this.plugin.settings.focusDarkenAmount,
            0, 100, 5, '%',
            (v) => { this.plugin.settings.focusDarkenAmount = v; },
        );

        createFocusSlider(
            focusBody, t('Blur'),
            t('Blur everything outside the active text area (px)'),
            this.plugin.settings.focusBlurAmount,
            0, 20, 1, 'px',
            (v) => { this.plugin.settings.focusBlurAmount = v; },
        );

        // Reset
        const focusResetRow = focusBody.createDiv();
        focusResetRow.setCssStyles({ marginTop: '8px' });
        const focusResetBtn = focusResetRow.createEl('button', { text: t('Reset to defaults') });
        focusResetBtn.setCssStyles({
            fontSize: '11px',
            padding: '2px 10px',
        });
        focusResetBtn.addEventListener('click', async () => {
            this.plugin.settings.focusDarkenAmount = 40;
            this.plugin.settings.focusBlurAmount = 1;
            await this.plugin.saveSettings();
            this.plugin.refreshOpenViews();
            this.refreshSettingsView();
        });

        // ── Timeline Drag-Scroll Settings (collapsible) ──
        const tlDetails = panel.createEl('details', { cls: 'story-line-timeline-scroll-section' });
        tlDetails.createEl('summary', { text: t('Timeline Drag-Scroll') });
        const tlBody = tlDetails.createDiv();
        tlBody.setCssStyles({ padding: '8px 0' });

        new Setting(tlBody)
            .setName(t('Scroll speed'))
            .setDesc(t('Pixels scrolled per animation frame while dragging near the edge (1–30).'))
            .addSlider(slider => slider
                .setLimits(1, 30, 1)
                .setValue(this.plugin.settings.timelineDragScrollSpeed)
                .onChange(async (value) => {
                    this.plugin.settings.timelineDragScrollSpeed = value;
                    await this.plugin.saveSettings();
                })
            );

        new Setting(tlBody)
            .setName(t('Scroll zone'))
            .setDesc(t('Pixel distance from the viewport edge where drag-scrolling activates (20–200).'))
            .addSlider(slider => slider
                .setLimits(20, 200, 10)
                .setValue(this.plugin.settings.timelineDragScrollZone)
                .onChange(async (value) => {
                    this.plugin.settings.timelineDragScrollZone = value;
                    await this.plugin.saveSettings();
                })
            );

    }

    private renderColorsSettingsTab(panel: HTMLElement): void {
        // ═══════════════════════════════════════════
        //  Colors
        // ═══════════════════════════════════════════
        new Setting(panel).setName(t('Colors')).setHeading();

        // Auto / light / dark — shared by NarrativeLab chrome and Narrative Canvas
        const themeSetting = new Setting(panel)
            .setName(t('Interface theme'))
            .setDesc(t('Follows Obsidian by default. Choose Light or Dark to override NarrativeLab and Narrative Canvas.'));
        const themeRow = themeSetting.controlEl.createDiv({ cls: 'nl-ui-theme-toggle' });
        themeRow.setCssStyles({ display: 'inline-flex', gap: '6px', flexWrap: 'wrap' });
        const currentTheme = this.plugin.settings.uiTheme === 'light' || this.plugin.settings.uiTheme === 'dark'
            ? this.plugin.settings.uiTheme
            : 'auto';
        const themeModes: Array<{ id: 'auto' | 'light' | 'dark'; label: string }> = [
            { id: 'auto', label: t('Auto (follow Obsidian)') },
            { id: 'light', label: t('Light') },
            { id: 'dark', label: t('Dark') },
        ];
        for (const mode of themeModes) {
            const btn = themeRow.createEl('button', {
                cls: `mod-cta nl-ui-theme-btn${currentTheme === mode.id ? ' is-active' : ''}`,
                text: mode.label,
                attr: { type: 'button' },
            });
            if (currentTheme !== mode.id) btn.removeClass('mod-cta');
            btn.addEventListener('click', async () => {
                if (this.plugin.settings.uiTheme === mode.id) return;
                await this.plugin.setUiTheme(mode.id);
                this.refreshSettingsView();
            });
        }

        // --- Tag / Plotline Colors (collapsible) ---
        const colorDetails = panel.createEl('details', { cls: 'story-line-color-section' });
        colorDetails.createEl('summary', { text: t('Plotline Color Scheme') });

        const colorBody = colorDetails.createDiv();
        colorBody.setCssStyles({ padding: '8px 0' });
        colorBody.createEl('p', {
            cls: 'setting-item-description',
            text: t('These are global color defaults. To use different colors for one project, right-click it in the Navigator and enable project-specific colors.'),
        });

        // Compact scheme picker: grouped equal-width card grid
        const schemeContainer = colorBody.createDiv('sl-scheme-picker');

        const SCHEME_GROUPS: { label: string; schemes: ColorScheme[] }[] = [
            { label: 'Catppuccin', schemes: ['latte', 'frappe', 'macchiato', 'mocha'] },
            { label: 'Moods', schemes: ['spring', 'morning', 'summer', 'dusk', 'midnight', 'autumn', 'ocean', 'forest', 'sunset', 'arctic', 'vintage', 'neon'] },
            { label: '', schemes: ['custom'] },
        ];

        const renderSchemePicker = () => {
            schemeContainer.empty();
            const current = this.plugin.settings.colorScheme;

            for (const group of SCHEME_GROUPS) {
                if (group.label) {
                    schemeContainer.createDiv({
                        cls: 'sl-scheme-group-label',
                        text: t(group.label),
                    });
                }

                const schemeGrid = schemeContainer.createDiv(
                    group.schemes.length === 1 ? 'sl-scheme-grid is-single' : 'sl-scheme-grid',
                );

                for (const scheme of group.schemes) {
                    const label = COLOR_SCHEME_LABELS[scheme];
                    const hintText = COLOR_SCHEME_HINTS[scheme];
                    const palette = getSchemeColors(scheme);
                    const isActive = scheme === current;

                    const card = schemeGrid.createDiv({
                        cls: `sl-scheme-card${isActive ? ' is-active' : ''}`,
                        attr: {
                            role: 'button',
                            tabindex: '0',
                            'aria-pressed': isActive ? 'true' : 'false',
                            'aria-label': t(label),
                        },
                    });

                    card.createDiv({ cls: 'sl-scheme-card-name', text: t(label) });
                    card.createDiv({ cls: 'sl-scheme-card-hint', text: t(hintText) });

                    if (palette) {
                        const swatchRow = card.createDiv('sl-scheme-swatches');
                        for (let i = 0; i < Math.min(7, palette.length); i++) {
                            const dot = swatchRow.createDiv('sl-scheme-swatch');
                            dot.setCssStyles({ background: palette[i] });
                        }
                    } else {
                        const iconEl = card.createDiv('sl-scheme-card-icon');
                        obsidian.setIcon(iconEl, 'palette');
                    }

                    const activate = async () => {
                        if (this.plugin.settings.colorScheme === scheme) return;
                        this.plugin.settings.colorScheme = scheme;
                        await this.plugin.saveSettings();
                        renderSchemePicker();
                        this.plugin.refreshOpenViews();
                    };
                    card.addEventListener('click', () => { void activate(); });
                    card.addEventListener('keydown', (event) => {
                        if (event.key !== 'Enter' && event.key !== ' ') return;
                        event.preventDefault();
                        void activate();
                    });
                }
            }
        };

        renderSchemePicker();

        // Help text
        const helpText = colorBody.createEl('p', {
            cls: 'setting-item-description',
        });
        helpText.setCssStyles({ marginTop: '8px' });
        helpText.textContent = t('Colors are auto-assigned to plotline tags. To override a specific tag color, use the color picker in the Plotlines view.');

        // ── Plotline HSL sliders ──
        const plotSliderLabel = colorBody.createDiv();
        plotSliderLabel.setCssStyles({
            fontSize: '11px',
            fontWeight: '600',
            color: 'var(--text-muted)',
            textTransform: 'uppercase',
            letterSpacing: '0.05em',
            marginTop: '12px',
            marginBottom: '6px',
        });
        plotSliderLabel.textContent = t('Global Adjustments');

        // Preview swatch row
        const plotPreviewRow = colorBody.createDiv();
        plotPreviewRow.setCssStyles({
            display: 'flex',
            gap: '4px',
            flexWrap: 'wrap',
            marginBottom: '8px',
        });

        const updatePlotPreview = () => {
            plotPreviewRow.empty();
            const palette = getSchemeColors(this.plugin.settings.colorScheme);
            if (!palette) return;
            const adj = getPlotlineHSL(this.plugin.settings);
            const hasAdj = adj.hue !== 0 || adj.sat !== 0 || adj.light !== 0;
            for (let ci = 0; ci < Math.min(palette.length, 14); ci++) {
                const col = hasAdj ? adjustHSL(palette[ci], adj.hue, adj.sat, adj.light) : palette[ci];
                const dot = plotPreviewRow.createDiv();
                dot.setCssStyles({
                    width: '20px',
                    height: '20px',
                    borderRadius: '4px',
                    background: col,
                    border: '1px solid var(--background-modifier-border)',
                });
            }
        };
        updatePlotPreview();

        const createPlotSlider = (
            label: string,
            value: number,
            min: number,
            max: number,
            onChange: (v: number) => void,
        ) => {
            const row = colorBody.createDiv();
            row.setCssStyles({
                display: 'flex',
                alignItems: 'center',
                gap: '8px',
                marginBottom: '6px',
            });

            const lbl = row.createSpan();
            lbl.setCssStyles({
                fontSize: '12px',
                minWidth: '75px',
            });
            lbl.textContent = label;

            const slider = row.createEl('input', {
                type: 'range',
                attr: { min: String(min), max: String(max), step: '1' },
            });
            slider.value = String(value);
            slider.setCssStyles({ flex: '1' });

            const valEl = row.createSpan();
            valEl.setCssStyles({
                fontSize: '11px',
                minWidth: '30px',
                textAlign: 'right',
            });
            valEl.textContent = String(value);

            let debounceTimer: number | null = null;
            slider.addEventListener('input', () => {
                const v = Number.parseInt(slider.value, 10);
                valEl.textContent = String(v);
                onChange(v);
                updatePlotPreview();
                if (debounceTimer) window.clearTimeout(debounceTimer);
                debounceTimer = window.setTimeout(() => {
                    this.plugin.saveSettings();
                    this.plugin.refreshOpenViews();
                }, 300);
            });
        };

        const ps = this.plugin.settings;
        createPlotSlider('Hue shift', ps.plotlineHue, -30, 30, (v) => { ps.plotlineHue = v; });
        createPlotSlider('Saturation', ps.plotlineSaturation, -50, 50, (v) => { ps.plotlineSaturation = v; });
        createPlotSlider('Lightness', ps.plotlineLightness, -30, 30, (v) => { ps.plotlineLightness = v; });

        const plotResetRow = colorBody.createDiv();
        plotResetRow.setCssStyles({ marginBottom: '12px' });
        const plotResetBtn = plotResetRow.createEl('button', { text: t('Reset adjustments') });
        plotResetBtn.setCssStyles({
            fontSize: '11px',
            padding: '2px 10px',
        });
        plotResetBtn.addEventListener('click', async () => {
            ps.plotlineHue = 0;
            ps.plotlineSaturation = 0;
            ps.plotlineLightness = 0;
            await this.plugin.saveSettings();
            this.plugin.refreshOpenViews();
            this.refreshSettingsView();
        });

        // Per-tag overrides summary (compact — only show if there ARE overrides)
        const overrides = Object.entries(this.plugin.settings.tagColors || {});
        if (overrides.length > 0) {
            const overrideSection = colorBody.createDiv();
            overrideSection.setCssStyles({ marginTop: '10px' });
            const overrideHeader = overrideSection.createDiv();
            overrideHeader.setCssStyles({
                display: 'flex',
                alignItems: 'center',
                gap: '8px',
                marginBottom: '6px',
            });
            overrideHeader.createSpan({ text: t('Custom overrides'), cls: 'setting-item-name' });

            const clearBtn = overrideHeader.createEl('button', { text: t('Clear all') });
            clearBtn.setCssStyles({
                fontSize: '11px',
                padding: '2px 8px',
            });
            clearBtn.addEventListener('click', async () => {
                this.plugin.settings.tagColors = {};
                await this.plugin.saveSettings();
                overrideSection.remove();
                this.plugin.refreshOpenViews();
            });

            const chipRow = overrideSection.createDiv();
            chipRow.setCssStyles({
                display: 'flex',
                gap: '4px',
                flexWrap: 'wrap',
            });
            for (const [tag, color] of overrides) {
                const chip = chipRow.createSpan();
                chip.setCssStyles({
                    padding: '2px 8px',
                    borderRadius: '10px',
                    fontSize: '11px',
                    background: color,
                    color: contrastTextColor(color),
                    cursor: 'pointer',
                });
                chip.textContent = tag;
                chip.setAttribute('title', t('{tag}: {color} — click to remove', { tag, color }));
                chip.addEventListener('click', async () => {
                    delete this.plugin.settings.tagColors[tag];
                    await this.plugin.saveSettings();
                    chip.remove();
                    this.plugin.refreshOpenViews();
                });
            }
        }

        // --- Sticky Note Colors (collapsible) ---
        const noteColorDetails = panel.createEl('details', { cls: 'story-line-color-section' });
        noteColorDetails.createEl('summary', { text: t('Sticky Note Colors') });
        const noteColorBody = noteColorDetails.createDiv();
        noteColorBody.setCssStyles({ padding: '8px 0' });
        this.renderStickyNoteSettings(noteColorBody);

    }

    private renderWritingSettingsTab(panel: HTMLElement): void {
        // ═══════════════════════════════════════════
        //  Writing Goals & Focus
        // ═══════════════════════════════════════════
        new Setting(panel).setName(t('Writing Goals')).setHeading();

        new Setting(panel)
            .setName(t('Daily word goal'))
            .setDesc(t('Target number of words per day (shown in Stats view)'))
            .addText(text => text
                .setPlaceholder('1000')
                .setValue(String(this.plugin.settings.dailyWordGoal))
                .onChange(async (value) => {
                    this.plugin.settings.dailyWordGoal = Number(value) || 1000;
                    await this.plugin.saveSettings();
                }));

        new Setting(panel)
            .setName(t('Weekly word goal'))
            .setDesc(t('Target number of words per week (Monday → today, shown in Stats view)'))
            .addText(text => text
                .setPlaceholder('7000')
                .setValue(String(this.plugin.settings.weeklyWordGoal))
                .onChange(async (value) => {
                    this.plugin.settings.weeklyWordGoal = Number(value) || 7000;
                    await this.plugin.saveSettings();
                }));

        new Setting(panel)
            .setName(t('Monthly word goal'))
            .setDesc(t('Target number of words for the current calendar month (shown in Stats view)'))
            .addText(text => text
                .setPlaceholder('30000')
                .setValue(String(this.plugin.settings.monthlyWordGoal))
                .onChange(async (value) => {
                    this.plugin.settings.monthlyWordGoal = Number(value) || 30000;
                    await this.plugin.saveSettings();
                }));

        new Setting(panel)
            .setName(t('Project word goal'))
            .setDesc(t('Target total words for the active project (shown in Stats view)'))
            .addText(text => text
                .setPlaceholder('80000')
                .setValue(String(this.plugin.settings.projectWordGoal))
                .onChange(async (value) => {
                    this.plugin.settings.projectWordGoal = Number(value) || 80000;
                    await this.plugin.saveSettings();
                }));

        new Setting(panel)
            .setName(t('Sprint end sound'))
            .setDesc(t('Play a chime when the writing sprint timer reaches zero'))
            .addToggle(toggle => toggle
                .setValue(this.plugin.settings.sprintEndSound)
                .onChange(async (value) => {
                    this.plugin.settings.sprintEndSound = value;
                    await this.plugin.saveSettings();
                }));

        new Setting(panel)
            .setName(t('Write scene references as wikilinks'))
            .setDesc(t('Store scene references such as POV, location, characters, setup_scenes, and payoff_scenes as Obsidian [[wikilinks]] so they update automatically when files are renamed. Existing plain-text values continue to work.'))
            .addToggle(toggle => toggle
                .setValue(this.plugin.settings.writeFieldsAsWikilinks !== false)
                .onChange(async (value) => {
                    this.plugin.settings.writeFieldsAsWikilinks = value;
                    await this.plugin.saveSettings();
                }));

        new Setting(panel)
            .setName(t('Mirror custom fields to top-level YAML'))
            .setDesc(t('Also write Universal Field values as top-level YAML keys, using each template\'s “Top-level key”, so they appear in Obsidian Properties, Bases, and Dataview. Reserved NarrativeLab keys are skipped.'))
            .addToggle(toggle => toggle
                .setValue(this.plugin.settings.universalFieldsMirrorTopLevel !== false)
                .onChange(async (value) => {
                    const wasOn = this.plugin.settings.universalFieldsMirrorTopLevel !== false;
                    this.plugin.settings.universalFieldsMirrorTopLevel = value;
                    await this.plugin.saveSettings();
                    // When the user flips the toggle ON, retro-mirror every
                    // existing entity so values already saved in
                    // `universalFields:` flow into the top-level YAML keys
                    // without requiring a manual re-edit per record.
                    if (value && !wasOn) {
                        try { await this.plugin.migrateUniversalFieldMirror(); }
                        catch (e) { console.error('[NarrativeLab] mirror toggle migration:', e); }
                    }
                }));

        // ── Count unit (words vs characters) ──
        new Setting(panel)
            .setName(t('Count unit for scene lengths'))
            .setDesc(t('Choose whether scene cards, the Timeline, and the Inspector display scene length in words or characters. Useful for prose writers who track length in characters (e.g. Russian, Chinese, Japanese).'))
            .addDropdown(dropdown => {
                dropdown.addOption('words', t('Words'));
                dropdown.addOption('chars', t('Characters'));
                dropdown.setValue(this.plugin.settings.countUnit === 'chars' ? 'chars' : 'words');
                dropdown.onChange(async (value) => {
                    this.plugin.settings.countUnit = value as 'words' | 'chars';
                    await this.plugin.saveSettings();
                    this.plugin.refreshOpenViews();
                });
            });

        // ── Issue #78 — Wordcount exclusions ──
        new Setting(panel)
            .setName(t('Exclude `%%comments%%` from wordcount'))
            .setDesc(t('Exclude Obsidian comment blocks (text between `%%` markers) so the word count matches what readers see.'))
            .addToggle(toggle => toggle
                .setValue(this.plugin.settings.excludeCommentsFromWordcount !== false)
                .onChange(async (value) => {
                    this.plugin.settings.excludeCommentsFromWordcount = value;
                    await this.plugin.saveSettings();
                }));

        new Setting(panel)
            .setName(t('Also ignore checkbox lines (`- [ ]`, `- [x]`)'))
            .setDesc(t('Also exclude Markdown task lines from the word count. Off by default because some authors keep checklists in the manuscript body.'))
            .addToggle(toggle => toggle
                .setValue(this.plugin.settings.excludeChecklistFromWordcount === true)
                .onChange(async (value) => {
                    this.plugin.settings.excludeChecklistFromWordcount = value;
                    await this.plugin.saveSettings();
                }));

        // ── Multi-language support — default project language ──
        new Setting(panel)
            .setName(t('Default project language'))
            .setDesc(t('BCP-47 tag used for word counting, reading time, dialogue %, stop-word filtering and PDF line wrapping. Choose Auto-detect to infer the script from manuscript text. Per-project overrides still use the `language:` field in the project frontmatter.'))
            .addDropdown(dropdown => {
                dropdown.addOption('auto', t('Auto-detect from text'));
                for (const { code, label } of SUPPORTED_STORYLINE_LOCALES) {
                    dropdown.addOption(code, `${label} (${code})`);
                }
                dropdown.setValue(this.plugin.settings.defaultProjectLanguage ?? 'en');
                dropdown.onChange(async (value) => {
                    this.plugin.settings.defaultProjectLanguage = value;
                    try {
                        const { setWordcountLocale } = await import('./services/MetadataParser');
                        setWordcountLocale(normalizeStoryLineLocale(value));
                    } catch { /* non-fatal */ }
                    await this.plugin.saveSettings();
                });
            });

        // ── Issue #77 — Default scene frontmatter ──
        new Setting(panel)
            .setName(t('Default scene frontmatter'))
            .setDesc(t('Raw YAML merged into every newly created scene. Useful for companion plugins (e.g. `cssclasses: [fountain]`). NarrativeLab\'s own keys (type, title, act, chapter, sequence, status…) take priority on conflict.'))
            .addTextArea(ta => {
                // eslint-disable-next-line obsidianmd/ui/sentence-case -- YAML keys are case-sensitive.
                ta.setPlaceholder('cssclasses:\n  - fountain\n')
                    .setValue(this.plugin.settings.defaultSceneFrontmatter || '')
                    .onChange(async (value) => {
                        this.plugin.settings.defaultSceneFrontmatter = value;
                        await this.plugin.saveSettings();
                    });
                ta.inputEl.rows = 4;
                ta.inputEl.setCssStyles({
                    width: '100%',
                    fontFamily: 'var(--font-monospace)',
                });
            });

    }

    private renderExportAdvancedSettingsTab(panel: HTMLElement): void {
        // ═══════════════════════════════════════════
        //  Export & Import
        // ═══════════════════════════════════════════
        new Setting(panel).setName(t('Converter / Export & Import')).setHeading();

        new Setting(panel)
            .setName(t('Scene separator'))
            .setDesc(t('Separator used between scenes in manuscript exports (Markdown, Word, PDF, and HTML).'))
            .addDropdown(dropdown => dropdown
                .addOptions({
                    'blank': 'Blank Line',
                    'asterisks': '* * *',
                    'custom': 'Custom Separator',
                })
                .setValue(this.plugin.settings.exportSceneSeparatorType ?? 'blank')
                .onChange(async (value) => {
                    this.plugin.settings.exportSceneSeparatorType = value as 'blank' | 'asterisks' | 'custom';
                    await this.plugin.saveSettings();
                    this.refreshSettingsView();
                }));

        if (this.plugin.settings.exportSceneSeparatorType === 'custom') {
            new Setting(panel)
                .setName(t('Custom separator'))
                .setDesc(t('Enter any UTF-8 character or text to use as a scene separator.'))
                .addText(text => text
                    .setPlaceholder(t('e.g. ~ ~ ~'))
                    .setValue(this.plugin.settings.exportSceneSeparatorCustom ?? '')
                    .onChange(async (value) => {
                        this.plugin.settings.exportSceneSeparatorCustom = value;
                        await this.plugin.saveSettings();
                    }));
        }

        // --- DOCX Export Settings (collapsible) ---
        this.renderDocxSettings(panel);

        // --- PDF Export Settings (collapsible) ---
        this.renderPdfSettings(panel);

        // --- Import (desktop-only) ---
        this.renderImportSettings(panel);

        // ═══════════════════════════════════════════
        //  Advanced
        // ═══════════════════════════════════════════
        const advancedDetails = panel.createEl('details', { cls: 'story-line-color-section' });
        advancedDetails.createEl('summary', { text: t('Advanced') });
        const advancedBody = advancedDetails.createDiv();

        new Setting(advancedBody)
            .setName(t('Enable plot hole detection'))
            .setDesc(t('Show warnings for potential plot holes'))
            .addToggle(toggle => toggle
                .setValue(this.plugin.settings.enablePlotHoleDetection)
                .onChange(async (value) => {
                    this.plugin.settings.enablePlotHoleDetection = value;
                    await this.plugin.saveSettings();
                }));

        // --- Extra source folders (collapsible, experimental) ---
        const extraDetails = advancedBody.createEl('details', { cls: 'story-line-color-section' });
        extraDetails.createEl('summary', { text: t('Additional Source Folders (Experimental)') });
        const extraBody = extraDetails.createDiv();
        extraBody.setCssStyles({ padding: '8px 0' });

        const extraWarn = extraBody.createDiv({ cls: 'setting-item-description' });
        extraWarn.setCssStyles({
            color: 'var(--text-warning, orange)',
            marginBottom: '12px',
        });
        extraWarn.setText(t('⚠ Experimental — back up your files before linking external folders. Files in linked folders may be modified when you edit entities in NarrativeLab.'));

        const extraDesc = extraBody.createDiv({ cls: 'setting-item-description' });
        extraDesc.setCssStyles({ marginBottom: '12px' });
        extraDesc.setText(t('Point NarrativeLab to any folder in your vault. All .md files inside will be scanned and automatically sorted by their frontmatter type: field.'));

        // Render the current list of folders
        const listContainer = extraBody.createDiv();
        const renderFolderList = () => {
            listContainer.empty();
            const folders = this.plugin.settings.extraFolders || [];
            for (let i = 0; i < folders.length; i++) {
                const row = listContainer.createDiv();
                row.setCssStyles({
                    display: 'flex',
                    alignItems: 'center',
                    gap: '6px',
                    marginBottom: '4px',
                });

                const label = row.createSpan({ text: folders[i] });
                label.setCssStyles({
                    flex: '1',
                    fontFamily: 'var(--font-monospace)',
                    fontSize: '12px',
                });

                const removeBtn = row.createEl('button', { text: '×', cls: 'clickable-icon' });
                removeBtn.setCssStyles({
                    color: 'var(--text-error)',
                    fontSize: '16px',
                });
                removeBtn.addEventListener('click', async () => {
                    this.plugin.settings.extraFolders.splice(i, 1);
                    await this.plugin.saveSettings();
                    // Refresh views so entries from the removed folder clear.
                    try {
                        await this.plugin.refreshOpenViews();
                    } catch {
                        // best-effort
                    }
                    renderFolderList();
                });
            }
        };
        renderFolderList();

        // Add-folder row with folder suggest
        const addRow = extraBody.createDiv();
        addRow.setCssStyles({
            display: 'flex',
            alignItems: 'center',
            gap: '6px',
            marginTop: '8px',
        });

        const folderInput = addRow.createEl('input', { type: 'text', placeholder: t('Type or browse for a folder...') });
        folderInput.setCssStyles({ flex: '1' });
        folderInput.addClass('sl-folder-suggest-input');

        // Attach folder autocomplete
        new FolderSuggest(this.app, folderInput);

        const addBtn = addRow.createEl('button', { text: t('Add'), cls: 'mod-cta' });
        addBtn.setCssStyles({ flexShrink: '0' });
        addBtn.addEventListener('click', async () => {
            const raw = folderInput.value.trim();
            if (!raw) return;
            // Convert absolute OS paths (e.g. "C:/Users/.../Folder" on
            // Windows or "/Users/.../Folder" on macOS) to vault-relative
            // paths that the vault adapter understands, then normalise.
            const val = this.plugin.toVaultRelativePath(raw);
            if (!val) return;
            if (!this.plugin.settings.extraFolders) this.plugin.settings.extraFolders = [];
            if (!this.plugin.settings.extraFolders.includes(val)) {
                this.plugin.settings.extraFolders.push(val);
                await this.plugin.saveSettings();
                // Force an immediate re-scan + view refresh so newly linked
                // folders appear without requiring a project switch or reload.
                try {
                    await this.plugin.refreshOpenViews();
                } catch {
                    // refreshOpenViews is best-effort; ignore failures.
                }
            }
            folderInput.value = '';
            renderFolderList();
        });
    }

    /** Render the tag-color assignment list with color pickers */
    private renderTagColorList(container: HTMLElement): void {
        container.empty();
        const tagColors = this.plugin.settings.tagColors || {};
        const scheme = this.plugin.settings.colorScheme;
        const isCustom = scheme === 'custom';

        // Gather all known tags from the scene index
        let allTags: string[] = [];
        try {
            allTags = this.plugin.sceneManager?.queryService.getAllTags() || [];
        } catch { /* scene manager may not be ready yet */ }

        // Merge in any tags that already have a persisted color but no longer appear in scenes
        const extraTags = Object.keys(tagColors).filter(t => !allTags.includes(t));
        const combinedTags = [...allTags, ...extraTags].sort();

        if (combinedTags.length === 0) {
            container.createEl('p', {
                text: t('No tags found. Create scenes with tags to assign colors here.'),
                cls: 'setting-item-description',
            });
            return;
        }

        if (!isCustom) {
            container.createEl('p', {
                text: t('Colors are auto-assigned from the selected scheme. Use the color picker to override individual tags.'),
                cls: 'setting-item-description',
            });
        }

        for (let ti = 0; ti < combinedTags.length; ti++) {
            const tag = combinedTags[ti];
            const customColor = tagColors[tag] || '';
            const schemeColor = resolveTagColor(tag, ti, scheme, {}, getPlotlineHSL(this.plugin.settings));
            const effectiveColor = customColor || schemeColor;
            const isOverridden = !!customColor;

            const s = new Setting(container);

            // Color swatch before the name
            const nameEl = s.nameEl;
            const swatch = nameEl.createSpan();
            swatch.setCssStyles({
                display: 'inline-block',
                width: '14px',
                height: '14px',
                borderRadius: '4px',
                background: effectiveColor,
                marginRight: '8px',
                verticalAlign: 'middle',
                border: '1px solid var(--background-modifier-border)',
            });
            nameEl.createSpan({ text: tag });

            if (isOverridden) {
                s.setDesc(t('Custom: {color}', { color: customColor }));
            } else if (!isCustom) {
                s.setDesc(t('Scheme: {color}', { color: schemeColor }));
            } else {
                s.setDesc(t('No color assigned'));
            }

            // Color picker for override
            s.addColorPicker(picker => {
                picker.setValue(customColor || effectiveColor);
                picker.onChange(async (value) => {
                    this.plugin.settings.tagColors[tag] = value;
                    s.setDesc(t('Custom: {color}', { color: value }));
                    swatch.setCssStyles({ background: value });
                    await this.plugin.saveSettings();
                    this.plugin.refreshOpenViews();
                });
            });

            // Reset button
            s.addExtraButton(btn => btn
                .setIcon('x')
                .setTooltip(t('Remove custom override'))
                .onClick(async () => {
                    delete this.plugin.settings.tagColors[tag];
                    await this.plugin.saveSettings();
                    this.renderTagColorList(container);
                    this.plugin.refreshOpenViews();
                }));
        }
    }

    /**
     * When the sticky-note theme changes, remap any notes whose explicit
     * corkboardNoteColor matches an old preset to the corresponding new preset.
     * Notes with truly custom colours (not matching a preset) are left untouched.
     */
    private async migrateCorkboardNoteColors(
        oldPresets: Array<{ label: string; color: string }>,
        newPresets: Array<{ label: string; color: string }>,
    ): Promise<void> {
        const sm = this.plugin.sceneManager;
        if (!sm) return;
        // Build a map: normalised old hex → new hex (by index)
        const migration = new Map<string, string>();
        const len = Math.min(oldPresets.length, newPresets.length);
        for (let i = 0; i < len; i++) {
            const oldHex = oldPresets[i].color.toUpperCase();
            const newHex = newPresets[i].color.toUpperCase();
            if (oldHex !== newHex) migration.set(oldHex, newHex);
        }
        if (migration.size === 0) return;

        for (const scene of sm.getAllScenes()) {
            if (!scene.corkboardNoteColor) continue;
            const norm = scene.corkboardNoteColor.toUpperCase();
            const replacement = migration.get(norm);
            if (replacement) {
                await sm.updateScene(scene.filePath, { corkboardNoteColor: replacement });
                scene.corkboardNoteColor = replacement;
            }
        }
    }

    /** Render the sticky-note colour settings panel */
    private renderStickyNoteSettings(container: HTMLElement): void {
        // Snapshot of preset colors at the time this panel renders.
        // Used to detect which note colors should be migrated when
        // HSL sliders, per-swatch overrides, or reset/clear are used.
        let presetsSnapshot = resolveStickyNoteColors(this.plugin.settings);

        /** Migrate any notes whose stored color matches an old preset
         *  to the corresponding new preset, then update the snapshot. */
        const migrateAndUpdate = async () => {
            const newPresets = resolveStickyNoteColors(this.plugin.settings);
            await this.migrateCorkboardNoteColors(presetsSnapshot, newPresets);
            presetsSnapshot = newPresets;
        };

        const rerender = () => {
            container.empty();
            this.renderStickyNoteSettings(container);
            this.plugin.refreshOpenViews();
        };

        const settings = this.plugin.settings;

        // ── Theme picker — card grid ──
        const themeLabel = container.createDiv();
        themeLabel.setCssStyles({
            fontSize: '11px',
            fontWeight: '600',
            color: 'var(--text-muted)',
            textTransform: 'uppercase',
            letterSpacing: '0.05em',
            marginBottom: '6px',
        });
        themeLabel.textContent = t('Theme');

        const themeRow = container.createDiv();
        themeRow.setCssStyles({
            display: 'flex',
            gap: '8px',
            flexWrap: 'wrap',
            marginBottom: '12px',
        });

        const themeIds: StickyNoteThemeId[] = ['classic', 'pastel', 'warm', 'cool', 'earth', 'vivid'];
        for (const tid of themeIds) {
            const card = themeRow.createDiv();
            card.setCssStyles({
                cursor: 'pointer',
                padding: '6px 10px',
                borderRadius: '8px',
            });
            card.setCssStyles({ border: tid === settings.stickyNoteTheme
                ? '2px solid var(--interactive-accent)'
                : '2px solid var(--background-modifier-border)' });
            card.setCssStyles({ background: tid === settings.stickyNoteTheme
                ? 'var(--background-modifier-hover)'
                : 'transparent' });
            card.setCssStyles({
                minWidth: '90px',
                textAlign: 'center',
                transition: 'border-color 0.15s',
            });

            const nameEl = card.createDiv();
            nameEl.setCssStyles({
                fontSize: '11px',
                fontWeight: '600',
                marginBottom: '2px',
            });
            nameEl.textContent = STICKY_NOTE_THEME_LABELS[tid];

            const hint = card.createDiv();
            hint.setCssStyles({
                fontSize: '9px',
                color: 'var(--text-faint)',
                marginBottom: '4px',
            });
            hint.textContent = STICKY_NOTE_THEME_HINTS[tid];

            // Mini swatches
            const swatchRow = card.createDiv();
            swatchRow.setCssStyles({
                display: 'flex',
                gap: '2px',
                justifyContent: 'center',
                flexWrap: 'wrap',
            });
            const themeColors = STICKY_NOTE_THEMES[tid];
            for (let i = 0; i < 7; i++) {
                const dot = swatchRow.createDiv();
                dot.setCssStyles({
                    width: '10px',
                    height: '10px',
                    borderRadius: '50%',
                    background: themeColors[i],
                });
            }

            card.addEventListener('click', async () => {
                // Capture old resolved colors before changing theme
                const oldPresets = resolveStickyNoteColors(settings);
                settings.stickyNoteTheme = tid;
                settings.stickyNoteOverrides = {};
                // Migrate notes whose color matches an old preset to the new equivalent
                const newPresets = resolveStickyNoteColors(settings);
                await this.migrateCorkboardNoteColors(oldPresets, newPresets);
                await this.plugin.saveSettings();
                rerender();
            });
        }

        // ── Global HSL sliders ──
        const sliderLabel = container.createDiv();
        sliderLabel.setCssStyles({
            fontSize: '11px',
            fontWeight: '600',
            color: 'var(--text-muted)',
            textTransform: 'uppercase',
            letterSpacing: '0.05em',
            marginTop: '8px',
            marginBottom: '6px',
        });
        sliderLabel.textContent = t('Global Adjustments');

        const createSlider = (
            label: string,
            value: number,
            min: number,
            max: number,
            onChange: (v: number) => void,
        ) => {
            const row = container.createDiv();
            row.setCssStyles({
                display: 'flex',
                alignItems: 'center',
                gap: '8px',
                marginBottom: '6px',
            });

            const lbl = row.createSpan();
            lbl.setCssStyles({
                fontSize: '12px',
                minWidth: '75px',
            });
            lbl.textContent = label;

            const slider = row.createEl('input', {
                type: 'range',
                attr: { min: String(min), max: String(max), step: '1' },
            });
            slider.value = String(value);
            slider.setCssStyles({ flex: '1' });

            const valEl = row.createSpan();
            valEl.setCssStyles({
                fontSize: '11px',
                minWidth: '30px',
                textAlign: 'right',
            });
            valEl.textContent = String(value);

            let debounceTimer: number | null = null;
            slider.addEventListener('input', () => {
                const v = Number.parseInt(slider.value, 10);
                valEl.textContent = String(v);
                onChange(v);
                // Instant swatch preview
                updateSwatches();
                // Debounce the heavier save + view refresh
                if (debounceTimer) window.clearTimeout(debounceTimer);
                debounceTimer = window.setTimeout(async () => {
                    await migrateAndUpdate();
                    await this.plugin.saveSettings();
                    this.plugin.refreshOpenViews();
                }, 300);
            });
        };

        createSlider('Hue shift', settings.stickyNoteHue, -30, 30, (v) => { settings.stickyNoteHue = v; });
        createSlider('Saturation', settings.stickyNoteSaturation, -50, 50, (v) => { settings.stickyNoteSaturation = v; });
        createSlider('Lightness', settings.stickyNoteLightness, -30, 30, (v) => { settings.stickyNoteLightness = v; });

        // Reset sliders button
        const resetRow = container.createDiv();
        resetRow.setCssStyles({ marginBottom: '12px' });
        const resetBtn = resetRow.createEl('button', { text: t('Reset adjustments') });
        resetBtn.setCssStyles({
            fontSize: '11px',
            padding: '2px 10px',
        });
        resetBtn.addEventListener('click', async () => {
            const oldPresets = presetsSnapshot;
            settings.stickyNoteHue = 0;
            settings.stickyNoteSaturation = 0;
            settings.stickyNoteLightness = 0;
            const newPresets = resolveStickyNoteColors(settings);
            await this.migrateCorkboardNoteColors(oldPresets, newPresets);
            await this.plugin.saveSettings();
            rerender();
        });

        // ── Colour swatches with per-colour overrides ──
        const swatchLabel = container.createDiv();
        swatchLabel.setCssStyles({
            fontSize: '11px',
            fontWeight: '600',
            color: 'var(--text-muted)',
            textTransform: 'uppercase',
            letterSpacing: '0.05em',
            marginBottom: '6px',
        });
        swatchLabel.textContent = t('Preview & Individual Overrides');

        const swatchGrid = container.createDiv();
        swatchGrid.setCssStyles({
            display: 'flex',
            gap: '6px',
            flexWrap: 'wrap',
            marginBottom: '8px',
        });

        const updateSwatches = () => {
            swatchGrid.empty();
            const resolved = resolveStickyNoteColors(settings);
            for (let i = 0; i < resolved.length; i++) {
                const { label, color } = resolved[i];
                const isOverridden = settings.stickyNoteOverrides[i] !== undefined;

                const cell = swatchGrid.createDiv();
                cell.setCssStyles({
                    display: 'flex',
                    flexDirection: 'column',
                    alignItems: 'center',
                    gap: '2px',
                    width: '52px',
                });

                const dot = cell.createDiv();
                dot.setCssStyles({
                    width: '32px',
                    height: '32px',
                    borderRadius: '6px',
                    background: color,
                });
                dot.setCssStyles({ border: isOverridden
                    ? '2px solid var(--interactive-accent)'
                    : '1px solid var(--background-modifier-border)' });
                dot.setCssStyles({ cursor: 'pointer' });
                dot.title = t('{label}: {color}{custom}\nClick to change', { label, color, custom: isOverridden ? t(' (custom)') : '' });

                // Hidden colour picker
                const picker = cell.createEl('input', {
                    type: 'color',
                    attr: { value: color },
                });
                picker.setCssStyles({
                    position: 'absolute',
                    opacity: '0',
                    pointerEvents: 'none',
                    width: '0',
                    height: '0',
                });

                dot.addEventListener('click', () => picker.click());
                picker.addEventListener('input', async () => {
                    const oldPresets = presetsSnapshot;
                    settings.stickyNoteOverrides[i] = picker.value.toUpperCase();
                    dot.setCssStyles({
                        background: picker.value,
                        border: '2px solid var(--interactive-accent)',
                    });
                    const newPresets = resolveStickyNoteColors(settings);
                    await this.migrateCorkboardNoteColors(oldPresets, newPresets);
                    presetsSnapshot = newPresets;
                    await this.plugin.saveSettings();
                    this.plugin.refreshOpenViews();
                });

                // Right-click to reset
                dot.addEventListener('contextmenu', async (e) => {
                    e.preventDefault();
                    if (isOverridden) {
                        const oldPresets = presetsSnapshot;
                        delete settings.stickyNoteOverrides[i];
                        const newPresets = resolveStickyNoteColors(settings);
                        await this.migrateCorkboardNoteColors(oldPresets, newPresets);
                        presetsSnapshot = newPresets;
                        await this.plugin.saveSettings();
                        this.plugin.refreshOpenViews();
                        updateSwatches();
                    }
                });

                const nameEl = cell.createDiv();
                nameEl.setCssStyles({
                    fontSize: '9px',
                    color: 'var(--text-muted)',
                    textAlign: 'center',
                    lineHeight: '1.1',
                });
                nameEl.textContent = label;
            }
        };
        updateSwatches();

        const helpText = container.createEl('p', { cls: 'setting-item-description' });
        helpText.setCssStyles({ marginTop: '4px' });
        helpText.textContent = t('Click a swatch to override that colour. Right-click to reset it. Sliders tint all 14 colours at once.');

        // Clear all overrides
        if (Object.keys(settings.stickyNoteOverrides).length > 0) {
            const clearRow = container.createDiv();
            clearRow.setCssStyles({ marginTop: '4px' });
            const clearBtn = clearRow.createEl('button', { text: t('Clear all colour overrides') });
            clearBtn.setCssStyles({
                fontSize: '11px',
                padding: '2px 10px',
            });
            clearBtn.addEventListener('click', async () => {
                const oldPresets = presetsSnapshot;
                settings.stickyNoteOverrides = {};
                const newPresets = resolveStickyNoteColors(settings);
                await this.migrateCorkboardNoteColors(oldPresets, newPresets);
                await this.plugin.saveSettings();
                rerender();
            });
        }
    }

    /** Render the list of user-defined scene templates */
    private renderTemplateList(container: HTMLElement): void {
        container.empty();
        const templates = this.plugin.templateCenter.getSceneTemplates().filter(tpl => tpl.scope !== 'project');
        if (templates.length === 0) {
            container.createEl('p', { text: t('No custom templates yet. Built-in templates (Blank, Action Scene, Dialogue Scene, Flashback, Opening Chapter) are always available.'), cls: 'setting-item-description' });
            return;
        }
        for (let i = 0; i < templates.length; i++) {
            const tpl = templates[i];
            new Setting(container)
                .setName(tpl.name || '(unnamed)')
                .setDesc(tpl.description || '')
                .addExtraButton(btn => btn
                    .setIcon('arrow-up')
                    .setTooltip(t('Move up'))
                    .onClick(async () => {
                        if (tpl.id) await this.plugin.templateCenter.moveSceneTemplate(tpl.id, -1);
                        this.renderTemplateList(container);
                    }))
                .addExtraButton(btn => btn
                    .setIcon('arrow-down')
                    .setTooltip(t('Move down'))
                    .onClick(async () => {
                        if (tpl.id) await this.plugin.templateCenter.moveSceneTemplate(tpl.id, 1);
                        this.renderTemplateList(container);
                    }))
                .addExtraButton(btn => btn
                    .setIcon('copy')
                    .setTooltip(t('Duplicate template'))
                    .onClick(async () => {
                        await this.plugin.templateCenter.saveSceneTemplate({
                            ...tpl, id: '', name: `${tpl.name} ${t('Copy')}`, scope: 'global',
                        });
                        this.renderTemplateList(container);
                    }))
                .addExtraButton(btn => btn
                    .setIcon('pencil')
                    .setTooltip(t('Edit template'))
                    .onClick(() => {
                        new TemplateEditorModal(this.app, { ...tpl, scope: 'global' }, async (updated) => {
                            updated.scope = 'global';
                            await this.plugin.templateCenter.saveSceneTemplate(updated);
                            this.renderTemplateList(container);
                        }, { forceScope: 'global' }).open();
                    }))
                .addExtraButton(btn => btn
                    .setIcon('trash')
                    .setTooltip(t('Delete template'))
                    .onClick(async () => {
                        if (tpl.id) await this.plugin.templateCenter.deleteTemplate('scene', tpl.id);
                        this.renderTemplateList(container);
                    }));
        }
    }

    private renderStructureTemplateList(container: HTMLElement): void {
        container.empty();
        const templates = this.plugin.templateCenter.getStructureTemplates().filter(tpl => tpl.scope !== 'project');
        if (templates.length === 0) {
            container.createEl('p', { text: t('No custom structures yet. Built-in structures remain available.'), cls: 'setting-item-description' });
            return;
        }
        for (const template of templates) {
            new Setting(container)
                .setName(template.name)
                .setDesc(`${template.beats.length} ${t('beats')}`)
                .addButton(button => button.setButtonText(t('Apply')).onClick(() => {
                    new BeatSheetApplyModal(
                        this.app,
                        this.plugin.sceneManager,
                        template,
                        [...BUILTIN_SCENE_TEMPLATES.map(localizeSceneTemplate), ...this.plugin.templateCenter.getSceneTemplates()],
                        async () => this.plugin.refreshOpenViews(),
                    ).open();
                }))
                .addExtraButton(button => button.setIcon('copy').setTooltip(t('Duplicate template')).onClick(async () => {
                    await this.plugin.templateCenter.saveStructureTemplate({
                        ...template, id: '', name: `${template.name} ${t('Copy')}`, scope: 'global',
                    });
                    this.renderStructureTemplateList(container);
                }))
                .addExtraButton(button => button.setIcon('pencil').setTooltip(t('Edit template')).onClick(() => {
                    new StructureTemplateEditorModal(this.app, { ...template, scope: 'global' }, async updated => {
                        updated.scope = 'global';
                        await this.plugin.templateCenter.saveStructureTemplate(updated);
                        this.renderStructureTemplateList(container);
                    }, { forceScope: 'global' }).open();
                }))
                .addExtraButton(button => button.setIcon('trash').setTooltip(t('Delete template')).onClick(async () => {
                    if (template.id) await this.plugin.templateCenter.deleteTemplate('structure', template.id);
                    this.renderStructureTemplateList(container);
                }));
        }
    }

    private renderProjectPresetList(container: HTMLElement): void {
        container.empty();
        const presets = this.plugin.templateCenter.getProjectPresets().filter(preset => preset.scope !== 'project');
        if (presets.length === 0) {
            container.createEl('p', { text: t('No project presets yet.'), cls: 'setting-item-description' });
            return;
        }
        const structures = [...BUILTIN_BEAT_SHEETS.map(localizeBeatSheet), ...this.plugin.templateCenter.getStructureTemplates()];
        const sceneTemplates = [...BUILTIN_SCENE_TEMPLATES.map(localizeSceneTemplate), ...this.plugin.templateCenter.getSceneTemplates()];
        for (const preset of presets) {
            new Setting(container)
                .setName(preset.name)
                .setDesc(preset.description || '')
                .addButton(button => button.setButtonText(t('Apply')).onClick(async () => {
                    await this.applyProjectPreset(preset, structures, sceneTemplates);
                }))
                .addExtraButton(button => button.setIcon('pencil').setTooltip(t('Edit template')).onClick(() => {
                    new ProjectPresetEditorModal(this.app, { ...preset, scope: 'global' }, structures, sceneTemplates, async updated => {
                        updated.scope = 'global';
                        await this.plugin.templateCenter.saveProjectPreset(updated);
                        this.renderProjectPresetList(container);
                    }, { forceScope: 'global' }).open();
                }))
                .addExtraButton(button => button.setIcon('trash').setTooltip(t('Delete template')).onClick(async () => {
                    await this.plugin.templateCenter.deleteTemplate('preset', preset.id);
                    this.renderProjectPresetList(container);
                }));
        }
    }

    private async applyProjectPreset(
        preset: ProjectPresetTemplate,
        structures: BeatSheetTemplate[],
        sceneTemplates: SceneTemplate[],
    ): Promise<void> {
        const applyAssets = async () => {
            if (preset.libraryCategories) {
                applyLibraryCategorySettings(this.plugin, preset.libraryCategories);
                await reconcileLibraryCategoriesForActiveProject(this.plugin);
                await this.plugin.saveProjectSystemData();
                await syncAllNativeLibraryBases(this.plugin);
                this.plugin.libraryCategoriesStructureEpoch += 1;
            }
            for (const rawField of preset.fieldTemplates || []) {
                const field = rawField as unknown as UniversalFieldTemplate;
                if (!field.id || !field.label) continue;
                const existing = this.plugin.fieldTemplates.getById(field.id);
                if (existing) await this.plugin.fieldTemplates.update(field.id, field);
                else await this.plugin.fieldTemplates.add({ ...field });
            }
            if (preset.libraryFieldTemplates) {
                this.plugin.settings.codexCategoryFieldTemplates = {
                    ...(this.plugin.settings.codexCategoryFieldTemplates || {}),
                    ...Object.fromEntries(Object.entries(preset.libraryFieldTemplates).map(([category, fields]) => [category, [...fields]])),
                };
                await this.plugin.saveSettings();
            }
        };
        const structure = structures.find(template => template.id === preset.structureTemplateId || template.name === preset.structureTemplateId);
        if (structure) {
            const sceneTemplate = sceneTemplates.find(template => template.id === preset.placeholderSceneTemplateId || template.name === preset.placeholderSceneTemplateId);
            new BeatSheetApplyModal(
                this.app,
                this.plugin.sceneManager,
                structure,
                sceneTemplates,
                async () => {
                    await applyAssets();
                    await this.plugin.refreshOpenViews();
                },
                { createPlaceholderScenes: preset.createPlaceholderScenes, sceneTemplate },
            ).open();
        } else {
            await applyAssets();
            await this.plugin.refreshOpenViews();
            new Notice(t('Project preset applied.'));
        }
    }

    /** Render the list of user-defined custom scene fields */
    private renderSceneCustomFieldList(container: HTMLElement): void {
        container.empty();
        if (!this.plugin.fieldTemplates) {
            container.createEl('p', {
                text: t('Open a project first to manage scene custom fields (templates are stored per project).'),
                cls: 'setting-item-description',
            });
            return;
        }

        const sceneTpls: UniversalFieldTemplate[] = this.plugin.fieldTemplates.getAll()
            .filter(t => (t.category || 'character') === 'scene')
            .sort((a, b) => (a.order ?? 0) - (b.order ?? 0));

        if (sceneTpls.length === 0) {
            container.createEl('p', {
                text: t('No custom scene fields yet. Click "Add Scene Field" to create one.'),
                cls: 'setting-item-description',
            });
            return;
        }

        for (const tpl of sceneTpls) {
            const typeLabel = tpl.type === 'multi-select' ? 'Multi-select'
                : tpl.type.charAt(0).toUpperCase() + tpl.type.slice(1);
            const optionsHint = (tpl.type === 'dropdown' || tpl.type === 'multi-select') && tpl.options.length > 0
                ? ` — ${tpl.options.length} option${tpl.options.length === 1 ? '' : 's'}`
                : '';
            new Setting(container)
                .setName(tpl.label || '(unnamed)')
                .setDesc(`${typeLabel}${optionsHint}`)
                .addExtraButton(btn => btn
                    .setIcon('pencil')
                    .setTooltip(t('Edit field'))
                    .onClick(() => {
                        const modal = new AddFieldModal(
                            this.app,
                            tpl.section,
                            tpl,
                            async (updated) => {
                                await this.plugin.fieldTemplates.update(tpl.id, updated);
                                this.renderSceneCustomFieldList(container);
                            },
                            async () => {
                                await this.plugin.fieldTemplates.remove(tpl.id);
                                this.renderSceneCustomFieldList(container);
                            },
                            ['Scene'],
                        );
                        modal.open();
                    }))
                .addExtraButton(btn => btn
                    .setIcon('trash')
                    .setTooltip(t('Delete field'))
                    .onClick(async () => {
                        await this.plugin.fieldTemplates.remove(tpl.id);
                        this.renderSceneCustomFieldList(container);
                    }));
        }
    }

    /** Render collapsible DOCX export settings section */
    private renderDocxSettings(containerEl: HTMLElement): void {
        const details = containerEl.createEl('details', { cls: 'story-line-docx-settings' });
        details.createEl('summary', { text: t('DOCX Export Settings') });

        const body = details.createDiv();

        body.createEl('p', {
            text: t('Configure Word (.docx) export behavior. These settings apply when exporting via the Export dialog.'),
            cls: 'setting-item-description',
        });

        const ds = this.plugin.settings.docxSettings;

        // Font family
        new Setting(body)
            .setName(t('Default font family'))
            .setDesc(t('Font used in the exported document (e.g. Calibri, Times New Roman, Arial).'))
            .addText(text => text
                .setPlaceholder('Calibri')
                .setValue(ds.defaultFontFamily)
                .onChange(async (value) => {
                    this.plugin.settings.docxSettings.defaultFontFamily = value || 'Calibri';
                    await this.plugin.saveSettings();
                }));

        // Font size
        new Setting(body)
            .setName(t('Default font size'))
            .setDesc(t('Base font size in half-points (e.g. 24 = 12pt, 28 = 14pt).'))
            .addText(text => text
                .setPlaceholder('24')
                .setValue(String(ds.defaultFontSize))
                .onChange(async (value) => {
                    const num = parseInt(value, 10);
                    if (!isNaN(num) && num > 0) {
                        this.plugin.settings.docxSettings.defaultFontSize = num;
                        await this.plugin.saveSettings();
                    }
                }));

        // Include metadata (frontmatter)
        new Setting(body)
            .setName(t('Include metadata'))
            .setDesc(t('When enabled, YAML frontmatter is included in the exported document. Disabled by default.'))
            .addToggle(toggle => toggle
                .setValue(ds.includeMetadata)
                .onChange(async (value) => {
                    this.plugin.settings.docxSettings.includeMetadata = value;
                    await this.plugin.saveSettings();
                }));

        // Preserve formatting
        new Setting(body)
            .setName(t('Preserve formatting'))
            .setDesc(t('Maintain original Markdown formatting in the output (bold, italic, code, etc.).'))
            .addToggle(toggle => toggle
                .setValue(ds.preserveFormatting)
                .onChange(async (value) => {
                    this.plugin.settings.docxSettings.preserveFormatting = value;
                    await this.plugin.saveSettings();
                }));

        // Enable preprocessing
        new Setting(body)
            .setName(t('Enable preprocessing'))
            .setDesc(t('Preprocess Markdown before conversion (normalise line-breaks, clean up).'))
            .addToggle(toggle => toggle
                .setValue(ds.enablePreprocessing)
                .onChange(async (value) => {
                    this.plugin.settings.docxSettings.enablePreprocessing = value;
                    await this.plugin.saveSettings();
                }));

        // Use Obsidian appearance
        new Setting(body)
            .setName(t('Use Obsidian appearance'))
            .setDesc(t('Detect and apply the current Obsidian theme font settings to the document.'))
            .addToggle(toggle => toggle
                .setValue(ds.useObsidianAppearance)
                .onChange(async (value) => {
                    this.plugin.settings.docxSettings.useObsidianAppearance = value;
                    await this.plugin.saveSettings();
                }));

        // Include filename as header
        new Setting(body)
            .setName(t('Include filename as header'))
            .setDesc(t('Add the note filename as a heading at the top of the exported document.'))
            .addToggle(toggle => toggle
                .setValue(ds.includeFilenameAsHeader)
                .onChange(async (value) => {
                    this.plugin.settings.docxSettings.includeFilenameAsHeader = value;
                    await this.plugin.saveSettings();
                }));

        // Page size
        new Setting(body)
            .setName(t('Page size'))
            .setDesc(t('Paper size for the exported document.'))
            .addDropdown(dropdown => dropdown
                .addOptions({
                    'A4': 'A4',
                    'A5': 'A5',
                    'A3': 'A3',
                    'Letter': 'Letter',
                    'Legal': 'Legal',
                    'Tabloid': 'Tabloid',
                })
                .setValue(ds.pageSize)
                .onChange(async (value) => {
                    this.plugin.settings.docxSettings.pageSize = value as SLDocxSettings['pageSize'];
                    await this.plugin.saveSettings();
                }));

        // Chunking threshold
        new Setting(body)
            .setName(t('Chunking threshold'))
            .setDesc(t('Number of elements before chunked processing kicks in (for large documents). Default: 500.'))
            .addText(text => text
                .setPlaceholder('500')
                .setValue(String(ds.chunkingThreshold))
                .onChange(async (value) => {
                    const num = parseInt(value, 10);
                    if (!isNaN(num) && num > 0) {
                        this.plugin.settings.docxSettings.chunkingThreshold = num;
                        await this.plugin.saveSettings();
                    }
                }));
    }

    /** Render collapsible PDF export settings section */
    private renderPdfSettings(containerEl: HTMLElement): void {
        const details = containerEl.createEl('details', { cls: 'story-line-pdf-settings' });
        details.createEl('summary', { text: t('PDF Export Settings') });

        const body = details.createDiv();

        body.createEl('p', {
            text: t('Configure PDF export on desktop (page size, margins, and fonts). Generation uses Electron print-to-PDF.'),
            cls: 'setting-item-description',
        });

        const ps = this.plugin.settings.pdfSettings;

        // Font family
        new Setting(body)
            .setName(t('Font family'))
            .setDesc(t('Standard PDF font to use in the exported document.'))
            .addDropdown(dropdown => dropdown
                .addOptions({
                    'Helvetica': 'Helvetica (sans-serif)',
                    'TimesRoman': 'Times Roman (serif)',
                    'Courier': 'Courier (monospace)',
                })
                .setValue(ps.fontFamily)
                .onChange(async (value) => {
                    this.plugin.settings.pdfSettings.fontFamily = value as SLPdfSettings['fontFamily'];
                    await this.plugin.saveSettings();
                }));

        // Font size
        new Setting(body)
            .setName(t('Font size'))
            .setDesc(t('Base body font size in points (e.g. 11, 12).'))
            .addText(text => text
                .setPlaceholder('11')
                .setValue(String(ps.fontSize))
                .onChange(async (value) => {
                    const num = parseFloat(value);
                    if (!isNaN(num) && num > 0) {
                        this.plugin.settings.pdfSettings.fontSize = num;
                        await this.plugin.saveSettings();
                    }
                }));

        // Page size
        new Setting(body)
            .setName(t('Page size'))
            .setDesc(t('Paper size for the exported PDF.'))
            .addDropdown(dropdown => dropdown
                .addOptions({
                    'A4': 'A4',
                    'A5': 'A5',
                    'A3': 'A3',
                    'Letter': 'Letter',
                    'Legal': 'Legal',
                })
                .setValue(ps.pageSize)
                .onChange(async (value) => {
                    this.plugin.settings.pdfSettings.pageSize = value as SLPdfSettings['pageSize'];
                    await this.plugin.saveSettings();
                }));

        // Line spacing
        new Setting(body)
            .setName(t('Line spacing'))
            .setDesc(t('Line height multiplier (1.0 = single, 1.5, 2.0 = double).'))
            .addText(text => text
                .setPlaceholder('1.4')
                .setValue(String(ps.lineSpacing))
                .onChange(async (value) => {
                    const num = parseFloat(value);
                    if (!isNaN(num) && num > 0) {
                        this.plugin.settings.pdfSettings.lineSpacing = num;
                        await this.plugin.saveSettings();
                    }
                }));

        // Margins
        new Setting(body)
            .setName(t('Margins (pt)'))
            .setDesc(t('Top / Bottom / Left / Right margins in points. 72pt = 1 inch.'))
            .addText(text => text
                .setPlaceholder('72')
                .setValue(String(ps.marginTop))
                .onChange(async (value) => {
                    const num = parseFloat(value);
                    if (!isNaN(num) && num >= 0) {
                        this.plugin.settings.pdfSettings.marginTop = num;
                        this.plugin.settings.pdfSettings.marginBottom = num;
                        this.plugin.settings.pdfSettings.marginLeft = num;
                        this.plugin.settings.pdfSettings.marginRight = num;
                        await this.plugin.saveSettings();
                    }
                }));

        // Include metadata (frontmatter)
        new Setting(body)
            .setName(t('Include metadata'))
            .setDesc(t('When enabled, YAML frontmatter is included in the exported PDF. Disabled by default.'))
            .addToggle(toggle => toggle
                .setValue(ps.includeMetadata)
                .onChange(async (value) => {
                    this.plugin.settings.pdfSettings.includeMetadata = value;
                    await this.plugin.saveSettings();
                }));

        // Include page numbers
        new Setting(body)
            .setName(t('Include page numbers'))
            .setDesc(t('Show centered page numbers at the bottom of each page.'))
            .addToggle(toggle => toggle
                .setValue(ps.includePageNumbers)
                .onChange(async (value) => {
                    this.plugin.settings.pdfSettings.includePageNumbers = value;
                    await this.plugin.saveSettings();
                }));
    }

    /** Render the Import section (desktop-only Scrivener import) */
    private renderImportSettings(containerEl: HTMLElement): void {
        const nodeFsAvailable = !!(window as unknown as { require?: (m: string) => unknown }).require?.('fs');
        if (!nodeFsAvailable) return;   // hide entirely on mobile

        const details = containerEl.createEl('details', { cls: 'story-line-import-settings' });
        details.createEl('summary', { text: t('Import') });

        const body = details.createDiv();

        body.createEl('p', {
            text: t('Import a Scrivener project (.scriv folder) as a new NarrativeLab project. Converts scenes, characters, locations, and research notes. Desktop only.'),
            cls: 'setting-item-description',
        });

        new Setting(body)
            .setName(t('Import Scrivener project'))
            .setDesc(t('Select a .scriv folder to import.'))
            .addButton(btn => btn
                .setButtonText(t('Import .scriv'))
                .setCta()
                .onClick(async () => {
                    try {
                        await this.pickAndImportScrivener();
                    } catch (err: unknown) {
                        new Notice(t('Import failed:') + ' ' + (err instanceof Error ? err.message : String(err)));
                    }
                }));
    }

    /** Open a folder picker and run the Scrivener import. */
    private async pickAndImportScrivener(): Promise<void> {
        const { ScrivenerImporter } = await import('./services/ScrivenerImporter');
        if (!ScrivenerImporter.isAvailable()) {
            new Notice(t('Scrivener import is only available on desktop.'));
            return;
        }

        // Use Electron dialog to pick a .scriv folder
        let remote: { dialog: { showOpenDialog: (opts: unknown) => Promise<{ canceled: boolean; filePaths?: string[] }> } } | undefined;
        const win = window as unknown as { require?: (m: string) => unknown };
        try {
            remote = win.require?.('@electron/remote') as typeof remote;
        } catch {
            try {
                remote = (win.require?.('electron') as { remote: typeof remote })?.remote;
            } catch {
                new Notice(t('Could not access the file dialog. Desktop only.'));
                return;
            }
        }

        if (!remote) {
            new Notice(t('Could not access the file dialog. Desktop only.'));
            return;
        }

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
            new Notice(t('Please select a .scriv folder.'));
            return;
        }

        new Notice(t('Importing Scrivener project…'));

        const importer = new ScrivenerImporter(this.app, this.plugin);
        const importResult = await importer.import(scrivPath);

        // Summary notice
        const lines = [
            `✓ Project "${importResult.projectTitle}" imported`,
            `  Scenes: ${importResult.scenesImported}`,
            `  Characters: ${importResult.charactersImported}`,
            `  Locations: ${importResult.locationsImported}`,
            `  Research: ${importResult.researchImported}`,
            `  Notes: ${importResult.notesImported}`,
        ];
        if (importResult.codexImported > 0) {
            lines.push(`  Library: ${importResult.codexImported} (${importResult.codexCategoriesCreated.join(', ')})`);
        }
        if (importResult.filesImported > 0) {
            lines.push(`  Files (images/PDFs): ${importResult.filesImported}`);
        }
        if (importResult.warnings.length) {
            const missingContent = importResult.warnings.filter(w => w.includes('No content file'));
            if (missingContent.length > 0) {
                lines.push(`  ⚠ ${missingContent.length} item(s) had no content file`);
            }
            const otherWarnings = importResult.warnings.length - missingContent.length;
            if (otherWarnings > 0) {
                lines.push(`  ⚠ ${otherWarnings} other warning(s)`);
            }
            // Log full warnings to console for debugging
            console.warn('[NarrativeLab] Import warnings:', importResult.warnings);
        }
        new Notice(lines.join('\n'), 10000);
    }
}

/**
 * Modal for editing a scene template
 */
export class TemplateEditorModal extends Modal {
    private template: SceneTemplate;
    private onSave: (tpl: SceneTemplate) => void;
    private forceScope?: TemplateScope;

    constructor(
        app: App,
        template: SceneTemplate,
        onSave: (tpl: SceneTemplate) => void,
        opts?: { forceScope?: TemplateScope },
    ) {
        super(app);
        this.template = { ...template, defaultFields: { ...template.defaultFields } };
        this.onSave = onSave;
        this.forceScope = opts?.forceScope;
        if (this.forceScope) this.template.scope = this.forceScope;
    }

    onOpen(): void {
        const { contentEl } = this;
        new Setting(contentEl).setName(t(this.template.name ? 'Edit Template' : 'New Template')).setHeading();

        new Setting(contentEl)
            .setName(t('Template name'))
            .addText(text => text
                .setPlaceholder(t('e.g. Climax Scene'))
                .setValue(this.template.name)
                .onChange(v => this.template.name = v));

        if (!this.forceScope) {
            new Setting(contentEl)
                .setName(t('Scope'))
                .setDesc(t('Project templates are saved under System/Templates/ and sync with the project.'))
                .addDropdown(dropdown => dropdown
                    .addOption('global', t('Global'))
                    .addOption('project', t('Project'))
                    .setValue(this.template.scope || 'global')
                    .onChange(value => this.template.scope = value as TemplateScope));
        }

        new Setting(contentEl)
            .setName(t('Description'))
            .addText(text => text
                .setPlaceholder(t('Short description…'))
                .setValue(this.template.description || '')
                .onChange(v => this.template.description = v || undefined));

        new Setting(contentEl)
            .setName(t('Default status'))
            .addDropdown(dd => {
                dd.addOption('', t('(none)'));
                const statuses = getStatusOrder();
                const cfg = getStatusConfig();
                statuses.forEach(s => {
                    const label = cfg[s]?.label ?? (s.charAt(0).toUpperCase() + s.slice(1));
                    dd.addOption(s, t(label));
                });
                dd.setValue(this.template.defaultFields.status || '');
                dd.onChange(v => {
                    if (v) this.template.defaultFields.status = v as SceneStatus;
                    else delete this.template.defaultFields.status;
                });
            });

        new Setting(contentEl)
            .setName(t('Default emotion'))
            .addText(text => text
                .setPlaceholder(t('e.g. tense, hopeful'))
                .setValue(this.template.defaultFields.emotion || '')
                .onChange(v => {
                    if (v) this.template.defaultFields.emotion = v;
                    else delete this.template.defaultFields.emotion;
                }));

        new Setting(contentEl)
            .setName(t('Default conflict'))
            .addText(text => text
                .setPlaceholder(t('What is the main conflict?'))
                .setValue(this.template.defaultFields.conflict || '')
                .onChange(v => {
                    if (v) this.template.defaultFields.conflict = v;
                    else delete this.template.defaultFields.conflict;
                }));

        new Setting(contentEl)
            .setName(t('Default tags'))
            .setDesc(t('Comma-separated'))
            .addText(text => text
                .setPlaceholder(t('flashback, dream'))
                .setValue((this.template.defaultFields.tags || []).join(', '))
                .onChange(v => {
                    const tags = v.split(',').map(t => t.trim()).filter(Boolean);
                    if (tags.length) this.template.defaultFields.tags = tags;
                    else delete this.template.defaultFields.tags;
                }));

        new Setting(contentEl)
            .setName(t('Target word count'))
            .addText(text => text
                .setPlaceholder(t('e.g. 1200'))
                .setValue(this.template.defaultFields.target_wordcount ? String(this.template.defaultFields.target_wordcount) : '')
                .onChange(v => {
                    const n = Number(v);
                    if (n > 0) this.template.defaultFields.target_wordcount = n;
                    else delete this.template.defaultFields.target_wordcount;
                }));

        contentEl.createEl('h4', { text: t('Body Template') });
        contentEl.createEl('p', { text: t('This text is inserted into the scene file body when using this template.'), cls: 'setting-item-description' });

        const bodyArea = new TextAreaComponent(contentEl);
        bodyArea.setValue(this.template.bodyTemplate);
        bodyArea.onChange(v => this.template.bodyTemplate = v);
        bodyArea.inputEl.rows = 10;
        bodyArea.inputEl.setCssStyles({
            width: '100%',
            fontFamily: 'var(--font-monospace)',
        });

        const btnRow = contentEl.createDiv({ cls: 'story-line-button-row' });
        const cancelBtn = btnRow.createEl('button', { text: t('Cancel') });
        cancelBtn.addEventListener('click', () => this.close());

        const saveBtn = btnRow.createEl('button', { text: t('Save'), cls: 'mod-cta' });
        saveBtn.addEventListener('click', () => {
            if (!this.template.name.trim()) {
                this.template.name = 'Untitled Template';
            }
            this.onSave(this.template);
            this.close();
        });
    }

    onClose(): void {
        this.contentEl.empty();
    }
}

function parseNumberList(value: string): number[] {
    const result = new Set<number>();
    for (const part of value.split(',')) {
        const range = part.trim().match(/^(\d+)\s*-\s*(\d+)$/);
        if (range) {
            const start = Number(range[1]);
            const end = Number(range[2]);
            for (let value = Math.min(start, end); value <= Math.max(start, end); value++) result.add(value);
        } else {
            const number = Number(part.trim());
            if (Number.isInteger(number) && number >= 0) result.add(number);
        }
    }
    return [...result].sort((a, b) => a - b);
}

function labelsToText(labels: Record<number, string>): string {
    return Object.entries(labels).map(([number, label]) => `${number}|${label}`).join('\n');
}

function parseLabels(value: string): Record<number, string> {
    const result: Record<number, string> = {};
    for (const line of value.split('\n')) {
        const [number, ...labelParts] = line.split('|');
        const key = Number(number?.trim());
        const label = labelParts.join('|').trim();
        if (Number.isInteger(key) && label) result[key] = label;
    }
    return result;
}

export class StructureTemplateEditorModal extends Modal {
    private template: BeatSheetTemplate;
    private forceScope?: TemplateScope;

    constructor(
        app: App,
        template: BeatSheetTemplate,
        private onSave: (template: BeatSheetTemplate) => void | Promise<void>,
        opts?: { forceScope?: TemplateScope },
    ) {
        super(app);
        this.forceScope = opts?.forceScope;
        this.template = {
            ...template,
            scope: opts?.forceScope || template.scope || 'global',
            acts: [...template.acts],
            chapters: [...template.chapters],
            actLabels: { ...template.actLabels },
            chapterLabels: { ...template.chapterLabels },
            beats: template.beats.map(beat => ({ ...beat })),
        };
    }

    onOpen(): void {
        this.titleEl.setText(t(this.template.name ? 'Edit Structure Template' : 'New Structure Template'));
        new Setting(this.contentEl).setName(t('Template name')).addText(input => input.setValue(this.template.name).onChange(value => this.template.name = value));
        new Setting(this.contentEl).setName(t('Summary')).addText(input => input.setValue(this.template.summary).onChange(value => this.template.summary = value));
        if (!this.forceScope) {
            new Setting(this.contentEl).setName(t('Scope')).addDropdown(dropdown => dropdown
                .addOption('global', t('Global')).addOption('project', t('Project'))
                .setValue(this.template.scope || 'global').onChange(value => this.template.scope = value as TemplateScope));
        }
        new Setting(this.contentEl).setName(t('Acts')).setDesc(t('Comma-separated numbers or ranges.')).addText(input => input
            .setPlaceholder('1,2,3').setValue(this.template.acts.join(','))
            .onChange(value => this.template.acts = parseNumberList(value)));
        new Setting(this.contentEl).setName(t('Chapters')).setDesc(t('Comma-separated numbers or ranges.')).addText(input => input
            .setPlaceholder('1-15').setValue(this.template.chapters.join(','))
            .onChange(value => this.template.chapters = parseNumberList(value)));
        this.addTextArea(t('Act labels'), t('One per line: number|label'), labelsToText(this.template.actLabels), value => this.template.actLabels = parseLabels(value));
        this.addTextArea(t('Chapter labels'), t('One per line: number|label'), labelsToText(this.template.chapterLabels), value => this.template.chapterLabels = parseLabels(value));
        this.addTextArea(
            t('Beats'),
            t('One per line: act|chapter|label|description. Chapter may be blank.'),
            this.template.beats.map(beat => `${beat.act}|${beat.chapter ?? ''}|${beat.label}|${beat.description}`).join('\n'),
            value => {
                this.template.beats = value.split('\n').map(line => {
                    const [actRaw, chapterRaw, labelRaw, ...description] = line.split('|');
                    return {
                        act: Number(actRaw) || 1,
                        ...(chapterRaw?.trim() ? { chapter: Number(chapterRaw) || 1 } : {}),
                        label: labelRaw?.trim() || '',
                        description: description.join('|').trim(),
                    };
                }).filter(beat => beat.label);
            },
            10,
        );
        const buttons = this.contentEl.createDiv('story-line-button-row');
        buttons.createEl('button', { text: t('Cancel') }).addEventListener('click', () => this.close());
        buttons.createEl('button', { text: t('Save'), cls: 'mod-cta' }).addEventListener('click', async () => {
            if (!this.template.name.trim()) {
                new Notice(t('Enter a template name.'));
                return;
            }
            await this.onSave(this.template);
            this.close();
        });
    }

    private addTextArea(name: string, description: string, value: string, onChange: (value: string) => void, rows = 5): void {
        const setting = new Setting(this.contentEl).setName(name).setDesc(description);
        const area = new TextAreaComponent(setting.controlEl);
        area.setValue(value).onChange(onChange);
        area.inputEl.rows = rows;
        area.inputEl.addClass('story-line-wide-input');
    }

    onClose(): void { this.contentEl.empty(); }
}

export class ProjectPresetEditorModal extends Modal {
    private preset: ProjectPresetTemplate;
    private forceScope?: TemplateScope;

    constructor(
        app: App,
        preset: ProjectPresetTemplate,
        private structures: BeatSheetTemplate[],
        private sceneTemplates: SceneTemplate[],
        private onSave: (preset: ProjectPresetTemplate) => void | Promise<void>,
        opts?: { forceScope?: TemplateScope },
    ) {
        super(app);
        this.forceScope = opts?.forceScope;
        this.preset = { ...preset, scope: opts?.forceScope || preset.scope || 'global' };
    }

    onOpen(): void {
        this.titleEl.setText(t(this.preset.name ? 'Edit Project Preset' : 'New Project Preset'));
        new Setting(this.contentEl).setName(t('Preset name')).addText(input => input.setValue(this.preset.name).onChange(value => this.preset.name = value));
        new Setting(this.contentEl).setName(t('Description')).addText(input => input.setValue(this.preset.description || '').onChange(value => this.preset.description = value || undefined));
        if (!this.forceScope) {
            new Setting(this.contentEl).setName(t('Scope')).addDropdown(dropdown => dropdown
                .addOption('global', t('Global')).addOption('project', t('Project'))
                .setValue(this.preset.scope || 'global').onChange(value => this.preset.scope = value as TemplateScope));
        }
        new Setting(this.contentEl).setName(t('Narrative structure')).addDropdown(dropdown => {
            dropdown.addOption('', t('(none)'));
            for (const structure of this.structures) dropdown.addOption(structure.id || structure.name, structure.name);
            dropdown.setValue(this.preset.structureTemplateId || '');
            dropdown.onChange(value => this.preset.structureTemplateId = value || undefined);
        });
        new Setting(this.contentEl).setName(t('Create beat scenes')).addToggle(toggle => toggle
            .setValue(this.preset.createPlaceholderScenes === true)
            .onChange(value => this.preset.createPlaceholderScenes = value));
        new Setting(this.contentEl).setName(t('Placeholder scene template')).addDropdown(dropdown => {
            dropdown.addOption('', t('Blank'));
            for (const template of this.sceneTemplates) dropdown.addOption(template.id || template.name, template.name);
            dropdown.setValue(this.preset.placeholderSceneTemplateId || '');
            dropdown.onChange(value => this.preset.placeholderSceneTemplateId = value || undefined);
        });
        this.contentEl.createEl('p', {
            cls: 'setting-item-description',
            text: t('This preset contains {categories} Library category definition(s) and {fields} field template(s).', {
                categories: this.preset.libraryCategories?.customCategories.length || 0,
                fields: (this.preset.fieldTemplates?.length || 0)
                    + Object.values(this.preset.libraryFieldTemplates || {}).reduce((sum, fields) => sum + fields.length, 0),
            }),
        });
        const buttons = this.contentEl.createDiv('story-line-button-row');
        buttons.createEl('button', { text: t('Cancel') }).addEventListener('click', () => this.close());
        buttons.createEl('button', { text: t('Save'), cls: 'mod-cta' }).addEventListener('click', async () => {
            if (!this.preset.name.trim()) {
                new Notice(t('Enter a preset name.'));
                return;
            }
            await this.onSave(this.preset);
            this.close();
        });
    }

    onClose(): void { this.contentEl.empty(); }
}

class TemplateBundleSuggestModal extends FuzzySuggestModal<TFile> {
    constructor(app: App, private onChoose: (path: string) => void) { super(app); }
    getItems(): TFile[] {
        return this.app.vault.getFiles().filter(file => file.extension === 'json' && /(^|\/)System\/Templates\//.test(file.path));
    }
    getItemText(file: TFile): string { return file.path; }
    onChooseItem(file: TFile): void { this.onChoose(file.path); }
    onOpen(): void { super.onOpen(); this.setPlaceholder(t('Choose a NarrativeLab template bundle…')); }
}

/**
 * Folder-path autocomplete for text inputs.
 * Lists all vault folders and filters as you type.
 */
class FolderSuggest extends AbstractInputSuggest<TFolder> {
    getSuggestions(query: string): TFolder[] {
        const lower = query.toLowerCase();
        const folders: TFolder[] = [];
        const root = this.app.vault.getRoot();
        const walk = (folder: TFolder) => {
            if (folder.path && folder.path !== '/') {
                if (folder.path.toLowerCase().contains(lower)) {
                    folders.push(folder);
                }
            }
            for (const child of folder.children) {
                if (child instanceof TFolder) walk(child);
            }
        };
        walk(root);
        return folders.sort((a, b) => a.path.localeCompare(b.path));
    }

    renderSuggestion(folder: TFolder, el: HTMLElement): void {
        el.setText(folder.path);
    }

    selectSuggestion(folder: TFolder): void {
        this.setValue(folder.path);
        this.close();
    }
}
/* eslint-enable @typescript-eslint/no-floating-promises, @typescript-eslint/no-misused-promises, @typescript-eslint/no-unnecessary-type-assertion -- end of file-wide suppression block opened at line 1 */
