import { ItemView, Notice, WorkspaceLeaf } from 'obsidian';
import type SceneCardsPlugin from '../main';
import { WRITING_TRACKER_PANEL_TYPE } from '../constants';
import { t } from '../utils/i18n';
import type { WritingTracker } from '../services/WritingTracker';
import {
    formatTrackerClock,
    renderGoalRings,
    renderTrackerSparkline,
    renderTrackerStatCard,
    renderVerticalWordHeatmap,
    weekCountFromSettings,
    type WritingTrackerScope,
} from '../components/WritingTrackerWidgets';

/**
 * Right-sidebar writing tracker (Web Novel Assistant status-panel shape):
 * sprint, session, goal rings, then a vertical vault-wide net-word heatmap.
 */
export class WritingTrackerPanel extends ItemView {
    private plugin: SceneCardsPlugin;
    private root: HTMLElement | null = null;
    private trackerScope: WritingTrackerScope = 'global';
    private sprintTimerId: number | null = null;
    private sprintEndChimePlayed = false;

    constructor(leaf: WorkspaceLeaf, plugin: SceneCardsPlugin) {
        super(leaf);
        this.plugin = plugin;
    }

    getViewType(): string {
        return WRITING_TRACKER_PANEL_TYPE;
    }

    getDisplayText(): string {
        return t('Writing tracker');
    }

    getIcon(): string {
        return 'activity';
    }

    async onOpen(): Promise<void> {
        const container = this.containerEl.children[1] as HTMLElement;
        container.empty();
        container.addClass('nl-tracker-panel');
        this.root = container;
        this.render();
    }

    async onClose(): Promise<void> {
        this.clearSprintTimer();
        this.root = null;
    }

    refresh(): void {
        if (this.root?.isConnected) this.render();
    }

    private clearSprintTimer(): void {
        if (this.sprintTimerId !== null) {
            window.clearInterval(this.sprintTimerId);
            this.sprintTimerId = null;
        }
    }

    private currentTotalWords(): number {
        try {
            return this.plugin.sceneManager.queryService.getStatistics(
                this.plugin.settings.excludeArcAnchorFromWordcount ?? true,
            ).totalWords;
        } catch {
            return 0;
        }
    }

    private source(): WritingTracker {
        return this.trackerScope === 'global'
            ? this.plugin.globalWritingTracker.tracker
            : this.plugin.writingTracker;
    }

    private render(): void {
        const container = this.root;
        if (!container) return;
        this.clearSprintTimer();
        container.empty();

        const tabs = container.createDiv('nl-tracker-tabs');
        this.addScopeTab(tabs, 'global', t('Vault'));
        this.addScopeTab(tabs, 'project', t('Project'));

        const body = container.createDiv('nl-tracker-panel-body');
        const totalWords = this.currentTotalWords();
        if (this.trackerScope === 'project' && !this.plugin.sceneManager.activeProject) {
            body.createEl('p', {
                cls: 'nl-tracker-empty',
                text: t('Open a NarrativeLab project to see project stats.'),
            });
        } else {
            if (this.trackerScope === 'project') {
                const project = this.plugin.sceneManager.activeProject!;
                const context = body.createDiv('nl-tracker-project-context');
                const name = context.createDiv({
                    cls: 'nl-tracker-project-name',
                    text: t('Project: {title}', { title: project.title }),
                });
                name.setAttr('title', project.filePath);
                if (!this.plugin.writingTracker.isProjectFilesOpen()) {
                    context.createDiv({
                        cls: 'nl-tracker-project-status is-paused',
                        text: t('Paused — no project files are open.'),
                    });
                }
            }
            this.renderSprint(body, totalWords);
            this.renderSession(body, totalWords);
            renderGoalRings(
                body,
                this.source(),
                this.plugin.settings.dailyWordGoal || 1000,
                this.plugin.settings.weeklyWordGoal || 7000,
                this.plugin.settings.monthlyWordGoal || 30000,
            );
            const recent = this.source().getRecentDays(7).reverse();
            renderTrackerSparkline(body, t('Last 7 days:'), recent);
            const revisions = this.source().getRecentRevisionDays(7).reverse();
            if (revisions.some(d => d.words > 0)) {
                renderTrackerSparkline(body, t('Revisions (7 days):'), revisions, 'is-revision');
            }
        }

        renderVerticalWordHeatmap(
            body,
            this.source().getFullHistory(),
            weekCountFromSettings(this.plugin.settings.writingTrackerHeatmapWeeks),
            this.plugin.settings.dailyWordGoal || 1000,
        );
    }

    private addScopeTab(parent: HTMLElement, scope: WritingTrackerScope, label: string): void {
        const btn = parent.createEl('button', {
            cls: 'nl-tracker-tab' + (this.trackerScope === scope ? ' is-active' : ''),
            text: label,
        });
        btn.setAttr('type', 'button');
        btn.addEventListener('click', () => {
            if (this.trackerScope === scope) return;
            this.trackerScope = scope;
            this.render();
        });
    }

    private renderSprint(parent: HTMLElement, currentTotalWords: number): void {
        const tracker = this.plugin.writingTracker;
        const section = parent.createDiv('nl-tracker-section');
        section.createEl('h4', { text: t('Writing Sprint') });

        const controls = section.createDiv('nl-tracker-sprint');
        const durationRow = controls.createDiv('nl-tracker-duration-row');
        durationRow.createSpan({ text: t('Duration:') });
        const durationInput = durationRow.createEl('input', {
            cls: 'nl-tracker-duration-input',
            attr: { type: 'number', min: '1', max: '120', step: '1' },
        });
        durationInput.value = String(Math.round(tracker.getSprintDuration() / 60_000));
        durationInput.addEventListener('change', () => {
            const mins = Math.max(1, Math.min(120, Number(durationInput.value) || 25));
            durationInput.value = String(mins);
            tracker.setSprintDuration(mins * 60_000);
            this.plugin.settings.sprintDurationMinutes = mins;
            void this.plugin.saveSettings();
        });
        durationRow.createSpan({ text: t('min') });

        const timerEl = controls.createDiv('nl-tracker-timer');
        const timerDisplay = timerEl.createSpan({ cls: 'nl-tracker-timer-display' });
        const sprintWordsEl = timerEl.createSpan({ cls: 'nl-tracker-timer-meta' });
        const sprintWpmEl = timerEl.createSpan({ cls: 'nl-tracker-timer-meta' });

        const btnRow = controls.createDiv('nl-tracker-btn-row');
        const startBtn = btnRow.createEl('button', { cls: 'nl-tracker-btn is-start', text: t('Start') });
        const stopBtn = btnRow.createEl('button', { cls: 'nl-tracker-btn is-stop', text: t('Stop') });
        const resetBtn = btnRow.createEl('button', { cls: 'nl-tracker-btn', text: t('Reset') });

        const updateTimerDisplay = (knownTotal?: number) => {
            const totalNow = knownTotal ?? this.currentTotalWords();
            if (tracker.isSprintRunning()) {
                const remaining = tracker.getSprintRemaining();
                timerDisplay.textContent = formatTrackerClock(remaining);
                timerDisplay.classList.toggle('is-overtime', remaining === 0);
                if (remaining === 0) {
                    if (!this.sprintEndChimePlayed && this.plugin.settings.sprintEndSound) {
                        this.sprintEndChimePlayed = true;
                        this.playSprintEndChime();
                    }
                    const overtime = tracker.getSprintElapsed() - tracker.getSprintDuration();
                    timerDisplay.textContent = `+${formatTrackerClock(overtime)}`;
                }
                sprintWordsEl.textContent = t('{words} words', {
                    words: tracker.getSprintWords(totalNow).toLocaleString(),
                });
                sprintWpmEl.textContent = t('{wpm} wpm', { wpm: tracker.getSprintWpm(totalNow) });
                startBtn.disabled = true;
                stopBtn.disabled = false;
                durationInput.disabled = true;
            } else {
                timerDisplay.textContent = formatTrackerClock(tracker.getSprintDuration());
                timerDisplay.classList.remove('is-overtime');
                sprintWordsEl.textContent = '';
                sprintWpmEl.textContent = '';
                startBtn.disabled = !tracker.isProjectFilesOpen();
                stopBtn.disabled = true;
                durationInput.disabled = false;
            }
        };

        startBtn.addEventListener('click', () => {
            this.sprintEndChimePlayed = false;
            const totalNow = this.currentTotalWords();
            if (!tracker.startSprint(totalNow)) {
                new Notice(t('Cannot start a sprint until the project word count is ready.'));
                return;
            }
            this.clearSprintTimer();
            this.sprintTimerId = window.setInterval(updateTimerDisplay, 1000);
            updateTimerDisplay(totalNow);
        });
        stopBtn.addEventListener('click', () => {
            const totalNow = this.currentTotalWords();
            const entry = tracker.stopSprint(totalNow);
            this.clearSprintTimer();
            updateTimerDisplay(totalNow);
            void this.plugin.saveProjectSystemData();
            if (entry) {
                new Notice(t('Sprint complete: {words} words in {mins} min ({wpm} wpm)', {
                    words: entry.words,
                    mins: Math.round(entry.durationMs / 60_000),
                    wpm: entry.wpm,
                }));
            }
        });
        resetBtn.addEventListener('click', () => {
            tracker.resetSprint();
            this.clearSprintTimer();
            updateTimerDisplay();
        });

        if (tracker.isSprintRunning() && tracker.isProjectFilesOpen()) {
            this.sprintTimerId = window.setInterval(updateTimerDisplay, 1000);
        }
        updateTimerDisplay(currentTotalWords);
    }

    private renderSession(parent: HTMLElement, currentTotalWords: number): void {
        const tracker = this.plugin.writingTracker;
        const source = this.source();
        parent.createEl('h5', {
            cls: 'nl-tracker-subtitle',
            text: this.trackerScope === 'global'
                ? t('Vault totals')
                : t('Session (since project opened)'),
        });
        const row = parent.createDiv('nl-tracker-cards');
        if (this.trackerScope === 'project') {
            renderTrackerStatCard(row, 'pencil', t('Session'), t('{words} words', {
                words: tracker.getSessionWords(currentTotalWords).toLocaleString(),
            }));
            renderTrackerStatCard(row, 'clock', t('Duration'), t('{minutes} min', {
                minutes: Math.floor(tracker.getSessionDuration() / 60_000),
            }));
            renderTrackerStatCard(row, 'zap', t('Speed'), t('{wpm} wpm', {
                wpm: tracker.getWordsPerMinute(currentTotalWords),
            }));
        } else {
            renderTrackerStatCard(row, 'pencil', t('Net words'), source.getTotalHistoryWords().toLocaleString());
            renderTrackerStatCard(row, 'calendar', t('Daily average'), source.getDailyAverage().toLocaleString());
        }
        const streak = source.getStreak();
        renderTrackerStatCard(row, 'flame', t('Streak'), streak > 1
            ? t('{count} days', { count: streak })
            : t('{count} day', { count: streak }));
        const revisions = source.getTodayRevisions();
        if (revisions > 0) {
            renderTrackerStatCard(row, 'rotate-cw', t('Revisions'), t('{words} words', {
                words: revisions.toLocaleString(),
            }));
        }
    }

    private playSprintEndChime(): void {
        try {
            const Ctx = window.AudioContext || (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
            if (!Ctx) return;
            const ctx = new Ctx();
            const playTone = (freq: number, startTime: number, duration: number) => {
                const osc = ctx.createOscillator();
                const gain = ctx.createGain();
                osc.type = 'sine';
                osc.frequency.value = freq;
                gain.gain.setValueAtTime(0.3, startTime);
                gain.gain.exponentialRampToValueAtTime(0.01, startTime + duration);
                osc.connect(gain);
                gain.connect(ctx.destination);
                osc.start(startTime);
                osc.stop(startTime + duration);
            };
            const now = ctx.currentTime;
            playTone(880, now, 0.15);
            playTone(1108.73, now + 0.15, 0.15);
            playTone(1318.51, now + 0.3, 0.3);
        } catch { /* silent */ }
    }
}
