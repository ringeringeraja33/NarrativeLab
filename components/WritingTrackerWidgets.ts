import { setIcon } from 'obsidian';
import type { WritingTracker } from '../services/WritingTracker';
import { t } from '../utils/i18n';
import {
    buildVerticalHeatmapWeeks,
    buildYearHeatmapWeeks,
    type HeatmapCell,
} from '../utils/writingTrackerHeatmap';

export type WritingTrackerScope = 'global' | 'project';

export function formatTrackerClock(ms: number): string {
    const total = Math.max(0, Math.round(ms / 1000));
    const mins = Math.floor(total / 60);
    const secs = total % 60;
    return `${String(mins).padStart(2, '0')}:${String(secs).padStart(2, '0')}`;
}

export function renderTrackerStatCard(
    parent: HTMLElement,
    icon: string,
    label: string,
    value: string,
): void {
    const card = parent.createDiv('nl-tracker-card');
    const iconEl = card.createSpan({ cls: 'nl-tracker-card-icon' });
    setIcon(iconEl, icon);
    card.createDiv({ cls: 'nl-tracker-card-value', text: value });
    card.createDiv({ cls: 'nl-tracker-card-label', text: label });
}

export function renderTrackerProgressRing(
    parent: HTMLElement,
    label: string,
    current: number,
    goal: number,
    color: string,
    size = 84,
): void {
    const wrap = parent.createDiv('nl-tracker-ring');
    wrap.createDiv({ cls: 'nl-tracker-ring-label', text: label });

    const safeGoal = goal > 0 ? goal : 1;
    const ratio = current / safeGoal;
    const pct = Math.round(ratio * 100);
    const reached = current >= goal && goal > 0;
    const stroke = 9;
    const r = (size - stroke) / 2;
    const c = size / 2;
    const circumference = 2 * Math.PI * r;
    const filled = Math.max(0, Math.min(1, ratio));
    const dash = circumference * filled;
    const arcColor = reached ? 'var(--sl-success, #4CAF50)' : color;

    const SVG_NS = 'http://www.w3.org/2000/svg';
    const svg = activeDocument.createElementNS(SVG_NS, 'svg');
    svg.setAttribute('width', String(size));
    svg.setAttribute('height', String(size));
    svg.setAttribute('viewBox', `0 0 ${size} ${size}`);
    svg.classList.add('nl-tracker-ring-svg');

    const track = activeDocument.createElementNS(SVG_NS, 'circle');
    track.setAttribute('cx', String(c));
    track.setAttribute('cy', String(c));
    track.setAttribute('r', String(r));
    track.setAttribute('fill', 'none');
    track.setAttribute('stroke', 'var(--background-modifier-border)');
    track.setAttribute('stroke-width', String(stroke));
    svg.appendChild(track);

    const arc = activeDocument.createElementNS(SVG_NS, 'circle');
    arc.setAttribute('cx', String(c));
    arc.setAttribute('cy', String(c));
    arc.setAttribute('r', String(r));
    arc.setAttribute('fill', 'none');
    arc.setAttribute('stroke', arcColor);
    arc.setAttribute('stroke-width', String(stroke));
    arc.setAttribute('stroke-linecap', 'round');
    arc.setAttribute('stroke-dasharray', `${dash} ${circumference}`);
    arc.setAttribute('transform', `rotate(-90 ${c} ${c})`);
    svg.appendChild(arc);

    const text = activeDocument.createElementNS(SVG_NS, 'text');
    text.setAttribute('x', String(c));
    text.setAttribute('y', String(c));
    text.setAttribute('text-anchor', 'middle');
    text.setAttribute('dominant-baseline', 'central');
    text.setAttribute('class', 'nl-tracker-ring-pct');
    text.textContent = `${pct}%`;
    svg.appendChild(text);

    wrap.appendChild(svg);
    wrap.createDiv({
        cls: 'nl-tracker-ring-sub',
        text: `${current.toLocaleString()} / ${goal.toLocaleString()}`,
    });
}

export function renderTrackerSparkline(
    parent: HTMLElement,
    label: string,
    days: Array<{ date: string; words: number }>,
    extraBarClass = '',
): void {
    const maxDay = Math.max(...days.map(d => d.words), 1);
    const section = parent.createDiv('nl-tracker-sparkline');
    section.createSpan({ cls: 'nl-tracker-sparkline-label', text: label });
    const row = section.createDiv('nl-tracker-spark-row');
    for (const day of days) {
        const col = row.createDiv('nl-tracker-spark-col');
        const hPct = (day.words / maxDay) * 100;
        const bar = col.createDiv(`nl-tracker-spark-bar${extraBarClass ? ` ${extraBarClass}` : ''}`);
        bar.setCssStyles({ height: `${Math.max(2, hPct)}%` });
        bar.setAttribute('title', t('{date}: {words} words', {
            date: day.date,
            words: day.words.toLocaleString(),
        }));
        col.createDiv({ cls: 'nl-tracker-spark-label', text: day.date.slice(5) });
    }
}

function heatmapTitle(cell: HeatmapCell): string {
    if (!cell.inRange) return cell.date;
    return t('{date}: {words} words', {
        date: cell.date,
        words: cell.words.toLocaleString(),
    });
}

function paintHeatmapCell(parent: HTMLElement, cell: HeatmapCell): void {
    const el = parent.createDiv(`nl-tracker-heat-cell nl-tracker-heat-l${cell.level}`);
    if (!cell.inRange) el.addClass('nl-tracker-heat-out');
    el.setAttribute('title', heatmapTitle(cell));
}

const HEATMAP_WEEKDAY_KEYS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'] as const;

export function heatmapWeekdayLabels(): string[] {
    return HEATMAP_WEEKDAY_KEYS.map(key => Array.from(t(key).trim())[0] ?? '');
}

export function renderVerticalWordHeatmap(
    parent: HTMLElement,
    history: Record<string, number>,
    weekCount: number,
    dailyGoal: number,
): void {
    const section = parent.createDiv('nl-tracker-heatmap nl-tracker-heatmap-vertical');
    const header = section.createDiv('nl-tracker-heatmap-header');
    header.createSpan({ text: t('Net words') });
    const today = new Date();
    const todayKey = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, '0')}-${String(today.getDate()).padStart(2, '0')}`;
    header.createSpan({
        cls: 'nl-tracker-heatmap-today',
        text: t('Today: {words}', { words: (history[todayKey] || 0).toLocaleString() }),
    });

    const dow = section.createDiv('nl-tracker-heatmap-dow');
    for (const label of heatmapWeekdayLabels()) {
        dow.createSpan({ text: label });
    }

    const grid = section.createDiv('nl-tracker-heatmap-grid');
    const weeks = buildVerticalHeatmapWeeks(history, weekCount, dailyGoal, today);
    for (const week of weeks) {
        const row = grid.createDiv('nl-tracker-heatmap-week');
        for (const cell of week.days) paintHeatmapCell(row, cell);
    }

    renderHeatmapLegend(section);
}

export function renderYearWordHeatmap(
    parent: HTMLElement,
    history: Record<string, number>,
    year: number,
    dailyGoal: number,
): void {
    const section = parent.createDiv('nl-tracker-heatmap nl-tracker-heatmap-year');
    const weeks = buildYearHeatmapWeeks(history, year, dailyGoal);
    const grid = section.createDiv('nl-tracker-heatmap-year-grid');
    const labels = grid.createDiv('nl-tracker-heatmap-year-dow');
    for (const label of heatmapWeekdayLabels()) {
        labels.createSpan({ text: label });
    }
    const cols = grid.createDiv('nl-tracker-heatmap-year-cols');
    for (const week of weeks) {
        const col = cols.createDiv('nl-tracker-heatmap-year-col');
        const monthStart = week.days.find(cell => (
            cell.date.startsWith(`${year}-`) && cell.date.endsWith('-01')
        ));
        if (monthStart) {
            col.createSpan({ cls: 'nl-tracker-heatmap-month', text: monthStart.date.slice(5, 7) });
        } else {
            col.createSpan({ cls: 'nl-tracker-heatmap-month is-empty', text: '' });
        }
        for (const cell of week.days) paintHeatmapCell(col, cell);
    }
    renderHeatmapLegend(section);
}

function renderHeatmapLegend(parent: HTMLElement): void {
    const legend = parent.createDiv('nl-tracker-heatmap-legend');
    legend.createSpan({ text: t('Less') });
    for (const level of [0, 1, 2, 3, 4]) {
        legend.createDiv(`nl-tracker-heat-cell nl-tracker-heat-l${level}`);
    }
    legend.createSpan({ text: t('More') });
}

export function renderGoalRings(
    parent: HTMLElement,
    source: WritingTracker,
    dailyGoal: number,
    weeklyGoal: number,
    monthlyGoal: number,
): void {
    const todayWords = source.getTodayWords();
    const weekWords = source.getThisWeekWords();
    const monthWords = source.getThisMonthWords();
    const goalPct = Math.min(100, Math.round((todayWords / (dailyGoal || 1)) * 100));

    const goalRow = parent.createDiv('nl-tracker-goal');
    goalRow.createSpan({
        text: t('Today: {current} / {goal} words ({pct}%)', {
            current: todayWords.toLocaleString(),
            goal: dailyGoal.toLocaleString(),
            pct: goalPct,
        }),
    });
    const bar = goalRow.createDiv('nl-tracker-bar');
    const fill = bar.createDiv('nl-tracker-bar-fill');
    fill.setCssStyles({
        width: `${goalPct}%`,
        backgroundColor: goalPct >= 100 ? 'var(--sl-success, #4CAF50)' : 'var(--sl-info, #2196F3)',
    });

    const rings = parent.createDiv('nl-tracker-rings');
    renderTrackerProgressRing(rings, t("Today's goal"), todayWords, dailyGoal, 'var(--sl-info, #2196F3)');
    renderTrackerProgressRing(rings, t("This week's goal"), weekWords, weeklyGoal, 'var(--sl-accent, #9c6bff)');
    renderTrackerProgressRing(rings, t("This month's goal"), monthWords, monthlyGoal, 'var(--sl-warning, #ffb74d)');
}

export function weekCountFromSettings(weeks: number | undefined): number {
    const n = Number(weeks);
    if (!Number.isFinite(n)) return 16;
    return Math.max(4, Math.min(52, Math.round(n)));
}
