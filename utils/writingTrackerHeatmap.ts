/** ISO date (YYYY-MM-DD) in local time. */
export function writingTrackerDateKey(date: Date): string {
    const y = date.getFullYear();
    const m = String(date.getMonth() + 1).padStart(2, '0');
    const day = String(date.getDate()).padStart(2, '0');
    return `${y}-${m}-${day}`;
}

export function parseWritingTrackerDate(key: string): Date | null {
    const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(key);
    if (!match) return null;
    const year = Number(match[1]);
    const month = Number(match[2]);
    const day = Number(match[3]);
    const date = new Date(year, month - 1, day);
    return date.getFullYear() === year
        && date.getMonth() === month - 1
        && date.getDate() === day
        ? date
        : null;
}

export function addCalendarDays(date: Date, days: number): Date {
    const next = new Date(date.getFullYear(), date.getMonth(), date.getDate());
    next.setDate(next.getDate() + days);
    return next;
}

/** Monday as the first day of the week. */
export function startOfWeekMonday(date: Date): Date {
    const next = new Date(date.getFullYear(), date.getMonth(), date.getDate());
    const dow = next.getDay();
    const daysSinceMonday = dow === 0 ? 6 : dow - 1;
    next.setDate(next.getDate() - daysSinceMonday);
    return next;
}

export type HeatmapLevel = 0 | 1 | 2 | 3 | 4;

/** 0 empty, 1–3 partial, 4 at/over the daily goal. */
export function heatmapLevel(words: number, dailyGoal: number): HeatmapLevel {
    const count = Math.max(0, words);
    if (count <= 0) return 0;
    const goal = dailyGoal > 0 ? dailyGoal : 1000;
    const ratio = count / goal;
    if (ratio >= 1) return 4;
    if (ratio >= 0.5) return 3;
    if (ratio >= 0.25) return 2;
    return 1;
}

export interface HeatmapCell {
    date: string;
    words: number;
    level: HeatmapLevel;
    inRange: boolean;
}

export interface HeatmapWeek {
    start: string;
    days: HeatmapCell[];
}

function cellFor(
    date: Date,
    history: Record<string, number>,
    dailyGoal: number,
    inRange: boolean,
): HeatmapCell {
    const key = writingTrackerDateKey(date);
    const words = inRange ? (history[key] || 0) : 0;
    return {
        date: key,
        words,
        level: inRange ? heatmapLevel(words, dailyGoal) : 0,
        inRange,
    };
}

/**
 * Weeks as rows (newest at the top), Monday–Sunday across.
 * Suited to a narrow right sidebar.
 */
export function buildVerticalHeatmapWeeks(
    history: Record<string, number>,
    weekCount: number,
    dailyGoal: number,
    today = new Date(),
): HeatmapWeek[] {
    const weeks = Math.max(1, Math.min(52, Math.round(weekCount) || 16));
    const thisMonday = startOfWeekMonday(today);
    const out: HeatmapWeek[] = [];
    for (let w = 0; w < weeks; w++) {
        const monday = addCalendarDays(thisMonday, -7 * w);
        const days: HeatmapCell[] = [];
        for (let d = 0; d < 7; d++) {
            const day = addCalendarDays(monday, d);
            const inRange = day.getTime() <= today.getTime();
            days.push(cellFor(day, history, dailyGoal, inRange));
        }
        out.push({ start: writingTrackerDateKey(monday), days });
    }
    return out;
}

/**
 * Weeks as columns (newest on the left), Monday–Sunday as rows.
 */
export function buildYearHeatmapWeeks(
    history: Record<string, number>,
    year: number,
    dailyGoal: number,
    today = new Date(),
): HeatmapWeek[] {
    const start = new Date(year, 0, 1);
    const end = new Date(year, 11, 31);
    const firstMonday = startOfWeekMonday(start);
    const lastMonday = startOfWeekMonday(end);
    const out: HeatmapWeek[] = [];
    for (let monday = lastMonday; monday.getTime() >= firstMonday.getTime(); monday = addCalendarDays(monday, -7)) {
        const days: HeatmapCell[] = [];
        for (let d = 0; d < 7; d++) {
            const day = addCalendarDays(monday, d);
            const inYear = day.getFullYear() === year;
            const inRange = inYear && day.getTime() <= today.getTime();
            days.push(cellFor(day, history, dailyGoal, inRange));
        }
        out.push({ start: writingTrackerDateKey(monday), days });
    }
    return out;
}

export const WRITING_TRACKER_FILENAME = 'writing-tracker.json';

export interface ParsedWritingTrackerFile {
    history: Record<string, number>;
    revisionHistory: Record<string, number>;
    unattributedHistory: Record<string, number>;
    unattributedRevisionHistory: Record<string, number>;
}

function parseDatedValues(raw: unknown, positiveOnly = false): Record<string, number> {
    const values: Record<string, number> = {};
    if (!raw || typeof raw !== 'object') return values;
    for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
        if (!parseWritingTrackerDate(key)) continue;
        const number = Number(value);
        if (Number.isFinite(number) && (!positiveOnly || number > 0)) values[key] = number;
    }
    return values;
}

export function parseWritingTrackerFile(raw: unknown): ParsedWritingTrackerFile {
    const empty: ParsedWritingTrackerFile = {
        history: {},
        revisionHistory: {},
        unattributedHistory: {},
        unattributedRevisionHistory: {},
    };
    if (!raw || typeof raw !== 'object') return empty;
    const obj = raw as Record<string, unknown>;
    return {
        history: parseDatedValues(obj.history),
        revisionHistory: parseDatedValues(obj.revisionHistory, true),
        unattributedHistory: parseDatedValues(obj.unattributedHistory),
        unattributedRevisionHistory: parseDatedValues(obj.unattributedRevisionHistory, true),
    };
}

/**
 * Keep the project-derived ledger authoritative while retaining legacy-only
 * dates outside the totals so they can be inspected or recovered later.
 */
export function reconcileDerivedTrackerHistory(
    canonical: Record<string, number>,
    existing: Record<string, number>,
    previousUnattributed: Record<string, number>,
): { history: Record<string, number>; unattributedHistory: Record<string, number> } {
    const history = { ...canonical };
    const unattributedHistory = { ...previousUnattributed };
    for (const [date, words] of Object.entries(existing)) {
        if (!(date in history)) unattributedHistory[date] = words;
    }
    for (const date of Object.keys(history)) delete unattributedHistory[date];
    return { history, unattributedHistory };
}
