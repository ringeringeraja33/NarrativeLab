import { normalizePath } from 'obsidian';

/** Direction relative to the focus view's left → right endpoints. */
export type StoryGraphStrandDirection = 'ltr' | 'rtl' | 'both';
export type StoryGraphStrandLineStyle = 'solid' | 'dashed' | 'dotted';

/** Connection handle on a focus-view endpoint (multiple ports per side). */
export interface StoryGraphFocusPort {
    id: string;
}

/** Mid bend of a focus strand in left→right chord-local coordinates (px). */
export interface StoryGraphStrandMid {
    /** Offset along the chord from its midpoint. */
    along: number;
    /** Offset along the chord normal (perpendicular). */
    perp: number;
}

/** One internal strand under a parent edge — edited only in focus view. */
export interface StoryGraphStrand {
    id: string;
    direction: StoryGraphStrandDirection;
    /** Label shown on the strand inside focus (not on the main graph). */
    label: string;
    color: string;
    lineStyle: StoryGraphStrandLineStyle;
    /** Attach to a specific handle on the left endpoint. */
    leftPortId?: string;
    /** Attach to a specific handle on the right endpoint. */
    rightPortId?: string;
    /**
     * Manual mid bend (Excalidraw-style). When set, the curve passes through
     * chordMid + along*ux + perp*nx. When omitted, focus view auto-packs a bow.
     */
    mid?: StoryGraphStrandMid;
}

/** Normalized 0–1 position inside the focus sub-canvas. */
export interface StoryGraphFocusNodePos {
    x: number;
    y: number;
}

/**
 * Parent edge identity for focus bundles.
 * Examples: `link:skill`, `link:default`, `char:mentor`.
 */
export type StoryGraphFocusParentId = string;

export interface StoryGraphFocusBundle {
    leftPath: string;
    rightPath: string;
    leftName?: string;
    rightName?: string;
    /** Which main-graph edge this bundle belongs to. */
    parentId?: StoryGraphFocusParentId;
    /** Parent label shown on the main graph (e.g. 技能). */
    parentLabel?: string;
    parentColor?: string;
    strands: StoryGraphStrand[];
    /** Optional layout of the two endpoints in the focus sub-canvas. */
    leftPos?: StoryGraphFocusNodePos;
    rightPos?: StoryGraphFocusNodePos;
    /** Drag-connect handles on the left endpoint (same handle may host many strands). */
    leftPorts?: StoryGraphFocusPort[];
    /** Drag-connect handles on the right endpoint. */
    rightPorts?: StoryGraphFocusPort[];
}

export function clampFocusNodePos(pos: StoryGraphFocusNodePos | undefined, fallback: StoryGraphFocusNodePos): StoryGraphFocusNodePos {
    if (!pos || typeof pos.x !== 'number' || typeof pos.y !== 'number') return { ...fallback };
    return {
        x: Math.min(0.92, Math.max(0.08, pos.x)),
        y: Math.min(0.88, Math.max(0.12, pos.y)),
    };
}

export function storyGraphPairKey(pathA: string, pathB: string): string {
    const a = normalizePath(pathA);
    const b = normalizePath(pathB);
    return a < b ? `${a}::${b}` : `${b}::${a}`;
}

/** Focus storage key: path-pair + parent edge id (wikilink category / character style). */
export function storyGraphFocusKey(
    pathA: string,
    pathB: string,
    parentId: StoryGraphFocusParentId = 'link:default',
): string {
    const pair = storyGraphPairKey(pathA, pathB);
    const parent = (parentId || 'link:default').trim() || 'link:default';
    return `${pair}@@${parent}`;
}

/** Resolve a focus bundle: prefer parent-scoped key, fall back to legacy pair-only key. */
export function lookupStoryGraphFocusBundle(
    bundles: Record<string, unknown> | undefined,
    pathA: string,
    pathB: string,
    parentId: StoryGraphFocusParentId,
): { key: string; bundle: StoryGraphFocusBundle } | null {
    if (!bundles) return null;
    const scoped = storyGraphFocusKey(pathA, pathB, parentId);
    const scopedBundle = normalizeStoryGraphFocusBundle(bundles[scoped]);
    if (scopedBundle) return { key: scoped, bundle: scopedBundle };
    // Legacy pair-only keys (pre parent-scoped focus).
    const legacy = storyGraphPairKey(pathA, pathB);
    const legacyBundle = normalizeStoryGraphFocusBundle(bundles[legacy]);
    if (legacyBundle && (!legacyBundle.parentId || legacyBundle.parentId === parentId)) {
        return { key: legacy, bundle: legacyBundle };
    }
    return null;
}

/** Main-graph stroke width from internal strand count (more strands → thicker). */
export function storyGraphEdgeStrokeWidth(strandCount: number, base = 2): number {
    const n = Math.max(0, Math.floor(strandCount));
    if (n <= 0) return base;
    return Math.min(10, base + n * 0.85);
}

export function flipStrandDirection(dir: StoryGraphStrandDirection): StoryGraphStrandDirection {
    if (dir === 'ltr') return 'rtl';
    if (dir === 'rtl') return 'ltr';
    return 'both';
}

export function createFocusPort(id?: string): StoryGraphFocusPort {
    return {
        id: id || `port-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`,
    };
}

export function normalizeStrandMid(raw: unknown): StoryGraphStrandMid | undefined {
    if (!raw || typeof raw !== 'object') return undefined;
    const m = raw as Record<string, unknown>;
    if (typeof m.along !== 'number' || typeof m.perp !== 'number') return undefined;
    if (!Number.isFinite(m.along) || !Number.isFinite(m.perp)) return undefined;
    return {
        along: Math.max(-800, Math.min(800, m.along)),
        perp: Math.max(-800, Math.min(800, m.perp)),
    };
}

export function createStoryGraphStrand(
    partial?: Partial<StoryGraphStrand>,
): StoryGraphStrand {
    const mid = normalizeStrandMid(partial?.mid);
    return {
        id: partial?.id || `strand-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`,
        direction: partial?.direction === 'rtl' || partial?.direction === 'both'
            ? partial.direction
            : 'ltr',
        label: typeof partial?.label === 'string' ? partial.label : '',
        color: typeof partial?.color === 'string' && partial.color.trim()
            ? partial.color.trim()
            : '#6C7AE0',
        lineStyle: partial?.lineStyle === 'dashed' || partial?.lineStyle === 'dotted'
            ? partial.lineStyle
            : 'solid',
        leftPortId: typeof partial?.leftPortId === 'string' ? partial.leftPortId : undefined,
        rightPortId: typeof partial?.rightPortId === 'string' ? partial.rightPortId : undefined,
        mid,
    };
}

function normalizePorts(raw: unknown): StoryGraphFocusPort[] {
    if (!Array.isArray(raw)) return [];
    const out: StoryGraphFocusPort[] = [];
    const seen = new Set<string>();
    for (const item of raw) {
        if (!item || typeof item !== 'object') continue;
        const id = typeof (item as { id?: unknown }).id === 'string'
            ? (item as { id: string }).id.trim()
            : '';
        if (!id || seen.has(id)) continue;
        seen.add(id);
        out.push({ id });
    }
    return out;
}

/** Ensure each side has ≥1 port and every strand references valid port ids. */
export function ensureFocusPorts(
    leftPorts: StoryGraphFocusPort[] | undefined,
    rightPorts: StoryGraphFocusPort[] | undefined,
    strands: StoryGraphStrand[],
): { leftPorts: StoryGraphFocusPort[]; rightPorts: StoryGraphFocusPort[]; strands: StoryGraphStrand[] } {
    const left = (leftPorts || []).map(p => ({ id: p.id }));
    const right = (rightPorts || []).map(p => ({ id: p.id }));
    const leftIds = new Set(left.map(p => p.id));
    const rightIds = new Set(right.map(p => p.id));
    for (const s of strands) {
        if (s.leftPortId && !leftIds.has(s.leftPortId)) {
            left.push({ id: s.leftPortId });
            leftIds.add(s.leftPortId);
        }
        if (s.rightPortId && !rightIds.has(s.rightPortId)) {
            right.push({ id: s.rightPortId });
            rightIds.add(s.rightPortId);
        }
    }
    if (left.length === 0) left.push(createFocusPort());
    if (right.length === 0) right.push(createFocusPort());
    const nextStrands = strands.map(s => ({
        ...s,
        leftPortId: s.leftPortId && leftIds.has(s.leftPortId) ? s.leftPortId : left[0].id,
        rightPortId: s.rightPortId && rightIds.has(s.rightPortId) ? s.rightPortId : right[0].id,
    }));
    return { leftPorts: left, rightPorts: right, strands: nextStrands };
}

export function normalizeStoryGraphFocusBundle(
    raw: unknown,
): StoryGraphFocusBundle | null {
    if (!raw || typeof raw !== 'object') return null;
    const rec = raw as Record<string, unknown>;
    const leftPath = typeof rec.leftPath === 'string' ? normalizePath(rec.leftPath) : '';
    const rightPath = typeof rec.rightPath === 'string' ? normalizePath(rec.rightPath) : '';
    if (!leftPath || !rightPath || leftPath === rightPath) return null;
    const strandsRaw = Array.isArray(rec.strands) ? rec.strands : [];
    const strands = strandsRaw
        .map(item => {
            if (!item || typeof item !== 'object') return null;
            const s = item as Record<string, unknown>;
            return createStoryGraphStrand({
                id: typeof s.id === 'string' ? s.id : undefined,
                direction: s.direction as StoryGraphStrandDirection,
                label: typeof s.label === 'string' ? s.label : '',
                color: typeof s.color === 'string' ? s.color : undefined,
                lineStyle: s.lineStyle as StoryGraphStrandLineStyle,
                leftPortId: typeof s.leftPortId === 'string' ? s.leftPortId : undefined,
                rightPortId: typeof s.rightPortId === 'string' ? s.rightPortId : undefined,
                mid: normalizeStrandMid(s.mid),
            });
        })
        .filter((s): s is StoryGraphStrand => !!s);
    const readPos = (rawPos: unknown): StoryGraphFocusNodePos | undefined => {
        if (!rawPos || typeof rawPos !== 'object') return undefined;
        const p = rawPos as Record<string, unknown>;
        if (typeof p.x !== 'number' || typeof p.y !== 'number') return undefined;
        return clampFocusNodePos({ x: p.x, y: p.y }, { x: 0.5, y: 0.5 });
    };
    const ensured = ensureFocusPorts(
        normalizePorts(rec.leftPorts),
        normalizePorts(rec.rightPorts),
        strands,
    );
    return {
        leftPath,
        rightPath,
        leftName: typeof rec.leftName === 'string' ? rec.leftName : undefined,
        rightName: typeof rec.rightName === 'string' ? rec.rightName : undefined,
        parentId: typeof rec.parentId === 'string' ? rec.parentId : undefined,
        parentLabel: typeof rec.parentLabel === 'string' ? rec.parentLabel : undefined,
        parentColor: typeof rec.parentColor === 'string' ? rec.parentColor : undefined,
        strands: ensured.strands,
        leftPorts: ensured.leftPorts,
        rightPorts: ensured.rightPorts,
        leftPos: readPos(rec.leftPos),
        rightPos: readPos(rec.rightPos),
    };
}

/** Load strands for a focus orientation, flipping directions if the pair was saved swapped. */
export function strandsForFocusOrientation(
    bundle: StoryGraphFocusBundle | undefined,
    leftPath: string,
    rightPath: string,
): StoryGraphStrand[] {
    if (!bundle) return [];
    const left = normalizePath(leftPath);
    const swapped = normalizePath(bundle.leftPath) !== left;
    if (!swapped) {
        return bundle.strands.map(s => ({
            ...s,
            mid: s.mid ? { ...s.mid } : undefined,
        }));
    }
    return bundle.strands.map(s => ({
        ...s,
        direction: flipStrandDirection(s.direction),
        leftPortId: s.rightPortId,
        rightPortId: s.leftPortId,
        // Chord frame flips with the endpoints — invert mid in both axes.
        mid: s.mid ? { along: -s.mid.along, perp: -s.mid.perp } : undefined,
    }));
}

/** Ports for a focus orientation (swap sides when bundle was saved flipped). */
export function portsForFocusOrientation(
    bundle: StoryGraphFocusBundle | undefined,
    leftPath: string,
    rightPath: string,
): { leftPorts: StoryGraphFocusPort[]; rightPorts: StoryGraphFocusPort[] } {
    if (!bundle) {
        return { leftPorts: [createFocusPort()], rightPorts: [createFocusPort()] };
    }
    const swapped = normalizePath(bundle.leftPath) !== normalizePath(leftPath);
    const ensured = ensureFocusPorts(bundle.leftPorts, bundle.rightPorts, bundle.strands);
    if (!swapped) {
        return { leftPorts: ensured.leftPorts, rightPorts: ensured.rightPorts };
    }
    return { leftPorts: ensured.rightPorts, rightPorts: ensured.leftPorts };
}

export function strandDashArray(style: StoryGraphStrandLineStyle): string {
    if (style === 'dashed') return '6,4';
    if (style === 'dotted') return '2,3';
    return '';
}
