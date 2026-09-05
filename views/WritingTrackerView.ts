import { ItemView, WorkspaceLeaf } from 'obsidian';
import type SceneCardsPlugin from '../main';
import { WRITING_TRACKER_VIEW_TYPE } from '../constants';
import { t } from '../utils/i18n';
import {
    renderGoalRings,
    renderTrackerSparkline,
    renderTrackerStatCard,
    renderYearWordHeatmap,
} from '../components/WritingTrackerWidgets';

/**
 * Main-area vault tracker (ribbon). Metric cards, year heatmap, recent bars.
 */
export class WritingTrackerView extends ItemView {
    private plugin: SceneCardsPlugin;
    private root: HTMLElement | null = null;
    private year = new Date().getFullYear();
    private chartDays = 30;

    constructor(leaf: WorkspaceLeaf, plugin: SceneCardsPlugin) {
        super(leaf);
        this.plugin = plugin;
    }

    getViewType(): string {
        return WRITING_TRACKER_VIEW_TYPE;
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
        container.addClass('nl-tracker-page');
        this.root = container;
        this.render();
    }

    async onClose(): Promise<void> {
        this.root = null;
    }

    refresh(): void {
        if (this.root?.isConnected) this.render();
    }

    private findScrollParent(el: HTMLElement): HTMLElement {
        let node: HTMLElement | null = el;
        const view = el.ownerDocument.defaultView;
        while (node) {
            const overflowY = view?.getComputedStyle(node).overflowY ?? '';
            if (
                (overflowY === 'auto' || overflowY === 'scroll' || overflowY === 'overlay')
                && node.scrollHeight > node.clientHeight + 1
            ) {
                return node;
            }
            node = node.parentElement;
        }
        return el;
    }

    private restoreScroll(scroller: HTMLElement, top: number): void {
        scroller.scrollTop = top;
        scroller.ownerDocument.defaultView?.requestAnimationFrame(() => {
            if (scroller.isConnected) scroller.scrollTop = top;
        });
    }

    private render(): void {
        const container = this.root;
        if (!container) return;
        const scroller = this.findScrollParent(container);
        const top = scroller.scrollTop;
        container.empty();

        const header = container.createDiv('nl-tracker-page-header');
        header.createEl('h3', { text: t('Writing tracker') });
        header.createEl('p', {
            cls: 'nl-tracker-page-lead',
            text: t('Vault-wide net words. Project sprint and scene totals stay on the Statistics tab.'),
        });

        const source = this.plugin.globalWritingTracker.tracker;
        const session = this.plugin.writingTracker;
        let sessionWords = 0;
        let wpm = 0;
        let minutes = 0;
        try {
            const total = this.plugin.getTrackedWordTotal();
            sessionWords = session.getSessionWords(total);
            wpm = session.getWordsPerMinute(total);
            minutes = Math.floor(session.getSessionDuration() / 60_000);
        } catch { /* no project */ }

        const cards = container.createDiv('nl-tracker-page-cards');
        renderTrackerStatCard(cards, 'flame', t('Streak'), source.getStreak() > 1
            ? t('{count}-day streak', { count: source.getStreak() })
            : t('{count}-day streak', { count: source.getStreak() }));
        renderTrackerStatCard(cards, 'clock', t('Session'), minutes > 0 ? t('{minutes} min', { minutes }) : '—');
        renderTrackerStatCard(cards, 'zap', t('Writing speed'), wpm > 0 ? t('{wpm} wpm', { wpm }) : '—');
        renderTrackerStatCard(cards, 'hash', t('Daily average'), String(source.getDailyAverage()));
        renderTrackerStatCard(cards, 'pencil', t('Net words'), source.getTotalHistoryWords().toLocaleString());
        renderTrackerStatCard(cards, 'sun', t('Today'), source.getTodayWords().toLocaleString());
        renderTrackerStatCard(cards, 'calendar', t('This week'), source.getThisWeekWords().toLocaleString());
        renderTrackerStatCard(cards, 'calendar-check', t('This month'), source.getThisMonthWords().toLocaleString());
        if (sessionWords > 0) {
            renderTrackerStatCard(cards, 'pen-tool', t('This session'), t('{words} words', {
                words: sessionWords.toLocaleString(),
            }));
        }

        renderGoalRings(
            container,
            source,
            this.plugin.settings.dailyWordGoal || 1000,
            this.plugin.settings.weeklyWordGoal || 7000,
            this.plugin.settings.monthlyWordGoal || 30000,
        );

        const heatHead = container.createDiv('nl-tracker-heatmap-toolbar');
        heatHead.createEl('h4', { text: t('Word heatmap') });
        const yearRow = heatHead.createDiv('nl-tracker-year-row');
        const yearInput = yearRow.createEl('input', {
            cls: 'nl-tracker-year-input',
            attr: { type: 'number', min: '2000', max: '2100', step: '1' },
        });
        yearInput.value = String(this.year);
        yearInput.addEventListener('change', () => {
            const next = Number(yearInput.value) || new Date().getFullYear();
            this.year = Math.max(2000, Math.min(2100, Math.round(next)));
            yearInput.value = String(this.year);
            this.render();
        });
        const thisYearBtn = yearRow.createEl('button', { text: t('This year') });
        thisYearBtn.setAttr('type', 'button');
        thisYearBtn.addEventListener('click', () => {
            if (this.year === new Date().getFullYear()) return;
            this.year = new Date().getFullYear();
            this.render();
        });

        renderYearWordHeatmap(
            container,
            source.getFullHistory(),
            this.year,
            this.plugin.settings.dailyWordGoal || 1000,
        );

        const chartHead = container.createDiv('nl-tracker-chart-toolbar');
        chartHead.createEl('h4', { text: t('Recent writing') });
        const ranges = chartHead.createDiv('nl-tracker-range-row');
        const chartsHost = container.createDiv('nl-tracker-recent-charts');
        const paintRecentCharts = () => {
            chartsHost.empty();
            const recent = source.getRecentDays(this.chartDays).reverse();
            renderTrackerSparkline(chartsHost, t('Net words'), recent);
            const revisions = source.getRecentRevisionDays(this.chartDays).reverse();
            if (revisions.some(d => d.words > 0)) {
                renderTrackerSparkline(chartsHost, t('Revisions'), revisions, 'is-revision');
            }
        };
        for (const days of [7, 30, 90]) {
            const btn = ranges.createEl('button', {
                cls: 'nl-tracker-range-btn' + (this.chartDays === days ? ' is-active' : ''),
                text: t('{n}d', { n: days }),
            });
            btn.setAttr('type', 'button');
            btn.addEventListener('click', () => {
                if (this.chartDays === days) return;
                this.chartDays = days;
                for (const other of Array.from(ranges.children)) {
                    other.classList.toggle('is-active', other === btn);
                }
                paintRecentCharts();
            });
        }
        paintRecentCharts();
        this.restoreScroll(scroller, top);
    }
}
