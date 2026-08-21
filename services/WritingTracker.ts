
/**
 * WritingTracker — tracks session word counts and daily writing velocity.
 *
 * The tracker captures a "baseline" word count when the session starts and
 * computes session words = current total − baseline. Historical daily totals
 * are persisted through the plugin's data so streaks survive restarts.
 */

export interface DailyEntry {
    /** ISO date string (YYYY-MM-DD) */
    date: string;
    /** Words written that day */
    words: number;
}

export interface WritingTrackerData {
    /** Daily word counts keyed by ISO date */
    history: Record<string, number>;
    /** Daily revision counts (inserted + deleted readable word tokens) keyed by ISO date */
    revisionHistory?: Record<string, number>;
    /** Persisted sprint log entries */
    sprintLog?: SprintLogEntry[];
    /** Recoverable in-progress sprint state (restored when a project file is open). */
    activeSprint?: ActiveSprintState;
}

export interface ActiveSprintState {
    baselineWords: number;
    elapsedMs: number;
    durationMs: number;
    startedAt: number;
}

/** A completed sprint record */
export interface SprintLogEntry {
    date: string;       // ISO date
    endDate?: string;   // ISO date when a sprint crosses midnight
    words: number;      // net words written
    durationMs: number; // actual elapsed time
    wpm: number;        // words per minute
}

export class WritingTracker {
    /** Word count at the moment the session started – null until startSession() is called */
    private baselineWords: number | null = null;
    /** Active time accumulated while at least one file from this project was open. */
    private sessionElapsedMs = 0;
    /** Start of the current active interval; null while every project file is closed. */
    private sessionActiveSince: number | null = null;
    /** Project activity gate shared by session and sprint clocks. */
    private _projectFilesOpen = false;
    /** Persisted daily history */
    private history: Record<string, number> = {};
    /** Persisted daily revision (absolute change) history */
    private revisionHistory: Record<string, number> = {};
    /** Exact word-token churn waiting to be copied into the vault-wide ledger. */
    private pendingRevisionWords = 0;
    /** Session words already flushed to daily history — avoids double-counting */
    private _flushedSessionWords = 0;

    // ── Sprint state ───────────────────────────────────
    /** Whether a timed sprint is currently running */
    private _sprintRunning = false;
    /** Active sprint time accumulated across project-file open intervals. */
    private _sprintElapsedMs = 0;
    /** Start of the current active sprint interval; null while paused. */
    private _sprintActiveSince: number | null = null;
    /** Sprint baseline word count */
    private _sprintBaseline = 0;
    /** Wall-clock start used only for honest cross-midnight attribution. */
    private _sprintStartedAt = 0;
    /** Configured sprint duration (ms) */
    private _sprintDurationMs = 25 * 60_000; // default 25 min
    /** Completed sprint log */
    private _sprintLog: SprintLogEntry[] = [];

    /**
     * Start (or restart) a session, capturing the current total word count
     * as the baseline. Zero is a valid baseline for a new empty project.
     */
    startSession(currentTotalWords: number, projectFilesOpen = true, now = Date.now()): void {
        if (!Number.isFinite(currentTotalWords) || currentTotalWords < 0) return;

        this.baselineWords = currentTotalWords;
        this.sessionElapsedMs = 0;
        this._projectFilesOpen = projectFilesOpen;
        this.sessionActiveSince = projectFilesOpen ? now : null;
        if (this._sprintRunning) this._sprintActiveSince = projectFilesOpen ? now : null;
    }

    /** Words written this session (0 if session not started yet) */
    getSessionWords(currentTotalWords: number): number {
        if (this.baselineWords === null) {
            if (Number.isFinite(currentTotalWords) && currentTotalWords >= 0) {
                this.startSession(currentTotalWords, this._projectFilesOpen);
            }
            return 0;
        }
        return Number.isFinite(currentTotalWords) ? currentTotalWords - this.baselineWords : 0;
    }

    /** How long the session has been running (ms) */
    getSessionDuration(now = Date.now()): number {
        return this.sessionElapsedMs
            + (this.sessionActiveSince === null ? 0 : Math.max(0, now - this.sessionActiveSince));
    }

    /** Pause/resume project clocks when the first project file opens or the last one closes. */
    setProjectFilesOpen(open: boolean, now = Date.now()): boolean {
        if (this._projectFilesOpen === open) return false;
        this._projectFilesOpen = open;
        if (this.baselineWords !== null) {
            if (open) {
                this.sessionActiveSince = now;
            } else if (this.sessionActiveSince !== null) {
                this.sessionElapsedMs += Math.max(0, now - this.sessionActiveSince);
                this.sessionActiveSince = null;
            }
        }
        if (this._sprintRunning) {
            if (open) {
                this._sprintActiveSince = now;
            } else if (this._sprintActiveSince !== null) {
                this._sprintElapsedMs += Math.max(0, now - this._sprintActiveSince);
                this._sprintActiveSince = null;
            }
        }
        return true;
    }

    isProjectFilesOpen(): boolean {
        return this._projectFilesOpen;
    }

    /** Words per minute for this session */
    getWordsPerMinute(currentTotalWords: number): number {
        const minutes = this.getSessionDuration() / 60_000;
        if (minutes < 0.5) return 0;
        return Math.round(this.getSessionWords(currentTotalWords) / minutes);
    }

    // ── Daily history ──────────────────────────────────

    /** Record today's total to history (call periodically or on save) */
    recordToday(sessionWords: number, now = Date.now()): void {
        if (!Number.isFinite(sessionWords) || sessionWords === 0) return;
        const today = this.todayKey(now);
        const next = (this.history[today] || 0) + sessionWords;
        // Keep an explicit zero so the safe JSON writer can distinguish an
        // intentional net rollback from an accidentally empty ledger.
        this.history[today] = next;
    }

    /**
     * Flush session words into today's daily total.
     * Safe to call multiple times — only the incremental difference since the
     * last flush is recorded, so daily history is never double-counted.
     */
    flushSession(currentTotalWords: number, now = Date.now()): { words: number; revisions: number } {
        if (!Number.isFinite(currentTotalWords) || currentTotalWords < 0) {
            return { words: 0, revisions: 0 };
        }
        if (this.baselineWords === null) {
            this.startSession(currentTotalWords, this._projectFilesOpen, now);
            return { words: 0, revisions: 0 };
        }
        const totalSessionWords = this.getSessionWords(currentTotalWords);
        const increment = totalSessionWords - this._flushedSessionWords;
        if (increment !== 0) this.recordToday(increment, now);
        this._flushedSessionWords = totalSessionWords;

        const revisions = this.pendingRevisionWords;
        this.pendingRevisionWords = 0;
        return { words: increment, revisions };
    }

    /** Record exact inserted + deleted word tokens from one text edit. */
    recordRevisionWords(churn: number, now = Date.now()): void {
        if (!Number.isFinite(churn) || churn <= 0) return;
        const amount = Math.round(churn);
        this.recordRevisionToday(amount, now);
        this.pendingRevisionWords += amount;
    }

    /** Record today's revision volume */
    private recordRevisionToday(absChange: number, now = Date.now()): void {
        const today = this.todayKey(now);
        this.revisionHistory[today] = (this.revisionHistory[today] || 0) + absChange;
    }

    /** Get words written today */
    getTodayWords(): number {
        return this.history[this.todayKey()] || 0;
    }

    /** Get revision volume for today (inserted + deleted readable word tokens) */
    getTodayRevisions(): number {
        return this.revisionHistory[this.todayKey()] || 0;
    }

    /** Get recent revision history (most recent first) */
    getRecentRevisionDays(count: number): DailyEntry[] {
        const entries: DailyEntry[] = [];
        const d = new Date();
        for (let i = 0; i < count; i++) {
            const key = this.dateKey(d);
            entries.push({ date: key, words: this.revisionHistory[key] || 0 });
            d.setDate(d.getDate() - 1);
        }
        return entries;
    }

    /** Return the raw daily revision history record (date→words) */
    getFullRevisionHistory(): Record<string, number> {
        return { ...this.revisionHistory };
    }

    /** Get the last N days of history (most recent first) */
    getRecentDays(count: number): DailyEntry[] {
        const entries: DailyEntry[] = [];
        const d = new Date();
        for (let i = 0; i < count; i++) {
            const key = this.dateKey(d);
            entries.push({ date: key, words: this.history[key] || 0 });
            d.setDate(d.getDate() - 1);
        }
        return entries;
    }

    /** Current writing streak (consecutive days with > 0 words) */
    getStreak(): number {
        let streak = 0;
        const d = new Date();
        // If today has no words yet, start checking from yesterday
        if (!this.history[this.dateKey(d)]) {
            d.setDate(d.getDate() - 1);
        }
        while (true) {
            const key = this.dateKey(d);
            if ((this.history[key] || 0) > 0) {
                streak++;
                d.setDate(d.getDate() - 1);
            } else {
                break;
            }
        }
        return streak;
    }

    /** Return the raw daily history record (date→words) */
    getFullHistory(): Record<string, number> {
        return { ...this.history };
    }

    /** Sum of every stored daily net-word total. */
    getTotalHistoryWords(): number {
        let total = 0;
        for (const words of Object.values(this.history)) total += words || 0;
        return total;
    }

    /** Calendar-day mean from the first tracked date through today (zero days included). */
    getDailyAverage(now = Date.now()): number {
        const today = new Date(now);
        const todayOrdinal = Date.UTC(today.getFullYear(), today.getMonth(), today.getDate()) / 86_400_000;
        let firstOrdinal = Number.POSITIVE_INFINITY;
        let total = 0;
        for (const [key, words] of Object.entries(this.history)) {
            if (!this.isValidDateKey(key)) continue;
            const [year, month, day] = key.split('-').map(Number);
            const ordinal = Date.UTC(year, month - 1, day) / 86_400_000;
            if (ordinal > todayOrdinal) continue;
            firstOrdinal = Math.min(firstOrdinal, ordinal);
            total += words;
        }
        if (!Number.isFinite(firstOrdinal)) return 0;
        return Math.round(total / (todayOrdinal - firstOrdinal + 1));
    }

    /** Add net words to today's history without touching the session baseline. */
    addTodayWords(words: number, now = Date.now()): void {
        if (Number.isFinite(words) && words !== 0) this.recordToday(words, now);
    }

    /** Add revision volume to today's history. */
    addTodayRevisions(absChange: number, now = Date.now()): void {
        if (Number.isFinite(absChange) && absChange > 0) this.recordRevisionToday(absChange, now);
    }

    /** Sum of words written across the last N days (inclusive of today). */
    getWordsInLastDays(days: number): number {
        if (days <= 0) return 0;
        let total = 0;
        const d = new Date();
        for (let i = 0; i < days; i++) {
            total += this.history[this.dateKey(d)] || 0;
            d.setDate(d.getDate() - 1);
        }
        return total;
    }

    /** Words written from Monday of the current week through today (inclusive). */
    getThisWeekWords(): number {
        const now = new Date();
        // JS getDay(): 0 = Sunday, 1 = Monday, …, 6 = Saturday.
        // Treat Monday as the first day of the week.
        const dow = now.getDay();
        const daysSinceMonday = dow === 0 ? 6 : dow - 1;
        let total = 0;
        const d = new Date(now);
        for (let i = 0; i <= daysSinceMonday; i++) {
            total += this.history[this.dateKey(d)] || 0;
            d.setDate(d.getDate() - 1);
        }
        return total;
    }

    /** Words written from day 1 of the current calendar month through today. */
    getThisMonthWords(): number {
        const now = new Date();
        const day = now.getDate();
        let total = 0;
        const d = new Date(now);
        for (let i = 0; i < day; i++) {
            total += this.history[this.dateKey(d)] || 0;
            d.setDate(d.getDate() - 1);
        }
        return total;
    }

    // ── Sprint controls ────────────────────────────────

    /** Start a timed writing sprint. Returns false when the project word count is not ready. */
    startSprint(currentTotalWords: number, now = Date.now()): boolean {
        if (!Number.isFinite(currentTotalWords) || currentTotalWords < 0 || !this._projectFilesOpen) return false;
        this._sprintRunning = true;
        this._sprintElapsedMs = 0;
        this._sprintActiveSince = now;
        this._sprintBaseline = currentTotalWords;
        this._sprintStartedAt = now;
        return true;
    }

    /** Stop the current sprint and record it */
    stopSprint(currentTotalWords: number, now = Date.now()): SprintLogEntry | null {
        if (!this._sprintRunning) return null;
        const elapsed = this.getSprintElapsed(now);
        this._sprintRunning = false;
        this._sprintActiveSince = null;
        const words = Number.isFinite(currentTotalWords) ? currentTotalWords - this._sprintBaseline : 0;
        const minutes = elapsed / 60_000;
        const wpm = minutes >= 0.5 ? Math.round(words / minutes) : 0;
        const startDate = this.todayKey(this._sprintStartedAt || now);
        const endDate = this.todayKey(now);
        const entry: SprintLogEntry = {
            date: startDate,
            ...(endDate === startDate ? {} : { endDate }),
            words,
            durationMs: elapsed,
            wpm,
        };
        this._sprintLog.push(entry);
        return entry;
    }

    /** Reset sprint state without recording */
    resetSprint(): void {
        this._sprintRunning = false;
        this._sprintElapsedMs = 0;
        this._sprintActiveSince = null;
        this._sprintBaseline = 0;
        this._sprintStartedAt = 0;
    }

    /** Is a sprint currently active? */
    isSprintRunning(): boolean { return this._sprintRunning; }

    /** Elapsed sprint time (ms) */
    getSprintElapsed(now = Date.now()): number {
        if (!this._sprintRunning) return 0;
        return this._sprintElapsedMs
            + (this._sprintActiveSince === null ? 0 : Math.max(0, now - this._sprintActiveSince));
    }

    /** Remaining sprint time (ms). Returns 0 if overtime. */
    getSprintRemaining(): number {
        if (!this._sprintRunning) return this._sprintDurationMs;
        return Math.max(0, this._sprintDurationMs - this.getSprintElapsed());
    }

    /** Words written during the current sprint */
    getSprintWords(currentTotalWords: number): number {
        if (!this._sprintRunning) return 0;
        return Number.isFinite(currentTotalWords) ? currentTotalWords - this._sprintBaseline : 0;
    }

    /** WPM during the current sprint */
    getSprintWpm(currentTotalWords: number): number {
        const minutes = this.getSprintElapsed() / 60_000;
        if (minutes < 0.5) return 0;
        return Math.round(this.getSprintWords(currentTotalWords) / minutes);
    }

    /** Get/set sprint duration (ms) */
    getSprintDuration(): number { return this._sprintDurationMs; }
    setSprintDuration(ms: number): void { this._sprintDurationMs = Math.max(60_000, ms); }

    /** Get completed sprint log */
    getSprintLog(): SprintLogEntry[] { return [...this._sprintLog]; }

    /** Sprint log summary: total sprints, total words, average wpm */
    getSprintSummary(): { count: number; totalWords: number; avgWpm: number; totalDurationMs: number } {
        const log = this._sprintLog;
        if (log.length === 0) return { count: 0, totalWords: 0, avgWpm: 0, totalDurationMs: 0 };
        const totalWords = log.reduce((s, e) => s + e.words, 0);
        const totalMs = log.reduce((s, e) => s + e.durationMs, 0);
        const avgWpm = totalMs > 30_000 ? Math.round(totalWords / (totalMs / 60_000)) : 0;
        return { count: log.length, totalWords, avgWpm, totalDurationMs: totalMs };
    }

    // ── Persistence ────────────────────────────────────

    /** Export data for saving */
    exportData(now = Date.now()): WritingTrackerData {
        const data: WritingTrackerData = {
            history: { ...this.history },
            revisionHistory: { ...this.revisionHistory },
            sprintLog: [...this._sprintLog],
        };
        if (this._sprintRunning) {
            data.activeSprint = {
                baselineWords: this._sprintBaseline,
                elapsedMs: this.getSprintElapsed(now),
                durationMs: this._sprintDurationMs,
                startedAt: this._sprintStartedAt || now,
            };
        }
        return data;
    }

    /**
     * Replace persisted history with another project's (or empty) ledger.
     * Session state is cleared; a validated persisted sprint is restored paused.
     */
    importData(data: WritingTrackerData | undefined): void {
        this.resetSession();
        this.history = this.sanitiseDailyRecord(data?.history, true);
        this.revisionHistory = this.sanitiseDailyRecord(data?.revisionHistory, false);
        this._sprintLog = Array.isArray(data?.sprintLog)
            ? data.sprintLog.filter((entry): entry is SprintLogEntry => this.isValidSprintLogEntry(entry))
                .map(entry => ({ ...entry }))
            : [];
        const active = data?.activeSprint;
        if (active
            && Number.isFinite(active.baselineWords) && active.baselineWords >= 0
            && Number.isFinite(active.elapsedMs) && active.elapsedMs >= 0
            && Number.isFinite(active.durationMs) && active.durationMs >= 60_000
            && Number.isFinite(active.startedAt) && active.startedAt > 0) {
            this._sprintRunning = true;
            this._sprintBaseline = active.baselineWords;
            this._sprintElapsedMs = active.elapsedMs;
            this._sprintDurationMs = active.durationMs;
            this._sprintStartedAt = active.startedAt;
            this._sprintActiveSince = null;
        }
    }

    /** Drop the in-memory session so the next startSession belongs to this project. */
    resetSession(): void {
        this.baselineWords = null;
        this.pendingRevisionWords = 0;
        this._flushedSessionWords = 0;
        this.sessionElapsedMs = 0;
        this.sessionActiveSince = null;
        this._projectFilesOpen = false;
        this.resetSprint();
    }

    // ── Helpers ────────────────────────────────────────

    private todayKey(now = Date.now()): string {
        return this.dateKey(new Date(now));
    }

    private dateKey(d: Date): string {
        const y = d.getFullYear();
        const m = String(d.getMonth() + 1).padStart(2, '0');
        const day = String(d.getDate()).padStart(2, '0');
        return `${y}-${m}-${day}`;
    }

    private isValidDateKey(key: string): boolean {
        const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(key);
        if (!match) return false;
        const year = Number(match[1]);
        const month = Number(match[2]);
        const day = Number(match[3]);
        const date = new Date(year, month - 1, day);
        return date.getFullYear() === year
            && date.getMonth() === month - 1
            && date.getDate() === day;
    }

    private sanitiseDailyRecord(
        source: Record<string, number> | undefined,
        allowNegative: boolean,
    ): Record<string, number> {
        const clean: Record<string, number> = {};
        if (!source || typeof source !== 'object') return clean;
        for (const [key, raw] of Object.entries(source)) {
            const value = Number(raw);
            if (!this.isValidDateKey(key) || !Number.isFinite(value)) continue;
            if (!allowNegative && value <= 0) continue;
            clean[key] = value;
        }
        return clean;
    }

    private isValidSprintLogEntry(entry: unknown): entry is SprintLogEntry {
        if (!entry || typeof entry !== 'object') return false;
        const value = entry as Partial<SprintLogEntry>;
        return typeof value.date === 'string' && this.isValidDateKey(value.date)
            && (value.endDate === undefined || (typeof value.endDate === 'string' && this.isValidDateKey(value.endDate)))
            && typeof value.words === 'number' && Number.isFinite(value.words)
            && typeof value.durationMs === 'number' && Number.isFinite(value.durationMs) && value.durationMs >= 0
            && typeof value.wpm === 'number' && Number.isFinite(value.wpm);
    }
}
