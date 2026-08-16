import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { build } from 'esbuild';

const result = await build({
    entryPoints: ['utils/writingTrackerHeatmap.ts'],
    bundle: true,
    format: 'esm',
    platform: 'node',
    write: false,
});
const source = result.outputFiles[0].text;
const {
    heatmapLevel,
    buildVerticalHeatmapWeeks,
    buildYearHeatmapWeeks,
    parseWritingTrackerFile,
    writingTrackerDateKey,
    startOfWeekMonday,
    WRITING_TRACKER_FILENAME,
} = await import(`data:text/javascript;base64,${Buffer.from(source).toString('base64')}`);

const trackerBuild = await build({
    entryPoints: ['services/WritingTracker.ts'],
    bundle: true,
    format: 'esm',
    platform: 'node',
    write: false,
});
const { WritingTracker } = await import(
    `data:text/javascript;base64,${Buffer.from(trackerBuild.outputFiles[0].text).toString('base64')}`
);

const [mainTs, settings, panel, page, widgets, globalTracker, sceneManager] = await Promise.all([
    readFile(new URL('../main.ts', import.meta.url), 'utf8'),
    readFile(new URL('../settings.ts', import.meta.url), 'utf8'),
    readFile(new URL('../views/WritingTrackerPanel.ts', import.meta.url), 'utf8'),
    readFile(new URL('../views/WritingTrackerView.ts', import.meta.url), 'utf8'),
    readFile(new URL('../components/WritingTrackerWidgets.ts', import.meta.url), 'utf8'),
    readFile(new URL('../services/GlobalWritingTracker.ts', import.meta.url), 'utf8'),
    readFile(new URL('../services/SceneManager.ts', import.meta.url), 'utf8'),
]);

test('heatmap levels follow the daily goal', () => {
    assert.equal(heatmapLevel(0, 1000), 0);
    assert.equal(heatmapLevel(100, 1000), 1);
    assert.equal(heatmapLevel(300, 1000), 2);
    assert.equal(heatmapLevel(600, 1000), 3);
    assert.equal(heatmapLevel(1000, 1000), 4);
    assert.equal(heatmapLevel(2000, 1000), 4);
});

test('vertical heatmap is weeks-as-rows Monday through Sunday', () => {
    const today = new Date(2026, 7, 16); // Sunday
    const monday = startOfWeekMonday(today);
    assert.equal(writingTrackerDateKey(monday), '2026-08-10');
    const weeks = buildVerticalHeatmapWeeks({ '2026-08-16': 120 }, 4, 1000, today);
    assert.equal(weeks.length, 4);
    assert.equal(weeks[0].days.length, 7);
    assert.equal(weeks[0].start, '2026-08-10');
    assert.equal(weeks[0].days[6].date, '2026-08-16');
    assert.equal(weeks[0].days[6].words, 120);
    assert.equal(weeks[0].days[6].level, 1);
    assert.equal(weeks[0].days[6].inRange, true);
    assert.equal(weeks[3].start, '2026-07-20');
});

test('year heatmap stays inside the requested calendar year', () => {
    const weeks = buildYearHeatmapWeeks({ '2026-01-01': 50 }, 2026, 100, new Date(2026, 0, 2));
    assert.ok(weeks.length >= 52);
    const jan1 = weeks.flatMap(week => week.days).find(day => day.date === '2026-01-01');
    assert.equal(jan1?.words, 50);
    assert.equal(jan1?.inRange, true);
    assert.ok(weeks[weeks.length - 1].days.some(day => day.date === '2026-01-01'));
    assert.ok(weeks[0].start >= '2026-12-21');
});

test('parseWritingTrackerFile keeps dated totals only', () => {
    const parsed = parseWritingTrackerFile({
        history: { '2026-08-16': 12, nope: 3, '2026-08-17': '8' },
        revisionHistory: { '2026-08-16': 4 },
    });
    assert.equal(parsed.history['2026-08-16'], 12);
    assert.equal(parsed.history['2026-08-17'], 8);
    assert.equal(parsed.history.nope, undefined);
    assert.equal(parsed.revisionHistory['2026-08-16'], 4);
    assert.equal(WRITING_TRACKER_FILENAME, 'writing-tracker.json');
});

test('sidebar panel splits vault/project and pins a vertical heatmap for the active scope', async () => {
    const styles = await readFile(new URL('../styles.css', import.meta.url), 'utf8');
    assert.match(panel, /WRITING_TRACKER_PANEL_TYPE/);
    assert.match(panel, /trackerScope: WritingTrackerScope = 'global'/);
    assert.match(panel, /renderVerticalWordHeatmap/);
    assert.match(panel, /this\.source\(\)\.getFullHistory\(\)/);
    assert.match(widgets, /buildVerticalHeatmapWeeks/);
    assert.match(styles, /\.nl-tracker-heatmap-vertical \.nl-tracker-heatmap-week \{[^}]*grid-template-columns:\s*repeat\(7, 11px\)/s);
    assert.match(styles, /\.nl-tracker-heatmap-vertical \.nl-tracker-heat-cell \{[^}]*width:\s*11px/s);
    assert.match(styles, /\.nl-tracker-panel,\s*\n\.nl-tracker-page \{[^}]*text-align:\s*center/s);
    assert.match(styles, /\.nl-tracker-cards,\s*\n\.nl-tracker-page-cards \{[^}]*justify-content:\s*center/s);
});

test('ribbon tracker page is vault-wide and not project-bound', () => {
    assert.match(page, /WRITING_TRACKER_VIEW_TYPE/);
    assert.doesNotMatch(page, /ProjectBoundItemView/);
    assert.match(page, /renderYearWordHeatmap/);
    assert.match(page, /paintRecentCharts/);
    assert.match(page, /restoreScroll/);
    assert.match(mainTs, /addRibbonIcon\('activity', t\('Open writing tracker'\)/);
    assert.match(mainTs, /ensureSideLeaf\.call\(workspace, WRITING_TRACKER_PANEL_TYPE, 'right'/);
    assert.match(mainTs, /async openWritingTracker\(/);
});

test('tracker settings are a dedicated settings tab', () => {
    assert.match(settings, /id: 'tracking'/);
    assert.match(settings, /renderTrackingSettingsTab/);
    assert.match(settings, /autoOpenWritingTrackerPanel/);
    assert.match(settings, /writingTrackerHeatmapWeeks/);
    assert.match(settings, /sprintDurationMinutes/);
    const trackingStart = settings.indexOf('private renderTrackingSettingsTab');
    const trackingEnd = settings.indexOf('private renderExportAdvancedSettingsTab');
    const trackingTab = settings.slice(trackingStart, trackingEnd);
    assert.doesNotMatch(trackingTab, /writeFieldsAsWikilinks/);
    assert.doesNotMatch(trackingTab, /defaultSceneFrontmatter/);
    assert.match(settings, /private renderScenesSettingsTab[\s\S]*writeFieldsAsWikilinks/);
});

test('session flush records into the vault-wide tracker file', () => {
    assert.match(mainTs, /flushWritingTrackers/);
    assert.match(mainTs, /globalWritingTracker\?\.recordFlush\(delta\)/);
    assert.match(mainTs, /rebindWritingTrackerSession/);
    assert.match(sceneManager, /flushWritingTrackers/);
    assert.match(sceneManager, /rebindWritingTrackerSession/);
    assert.match(globalTracker, /WRITING_TRACKER_FILENAME/);
    assert.match(globalTracker, /seedFromProjectIfEmpty/);
});

test('importing another project ledger replaces history and clears the session', () => {
    const tracker = new WritingTracker();
    tracker.importData({ history: {} });
    tracker.startSession(1000);
    tracker.flushSession(1250);
    assert.equal(tracker.getTodayWords(), 250);
    const today = Object.keys(tracker.getFullHistory())[0];
    tracker.importData({ history: { [today]: 40 } });
    assert.equal(tracker.getTodayWords(), 40);
    assert.equal(tracker.getSessionWords(2000), 0);
    tracker.startSession(2000);
    assert.equal(tracker.flushSession(2100).words, 100);
    assert.equal(tracker.getTodayWords(), 140);
});

test('sprints refuse a zero or missing word-count baseline', () => {
    const tracker = new WritingTracker();
    assert.equal(tracker.startSprint(0), false);
    assert.equal(tracker.startSprint(-3), false);
    assert.equal(tracker.startSprint(13408), true);
    assert.match(panel, /if \(!tracker\.startSprint\(totalNow\)\)/);
    assert.match(panel, /Cannot start a sprint until the project word count is ready/);
});

test('revisions ignore empty-index recounts and only measure positive totals', () => {
    const tracker = new WritingTracker();
    tracker.startSession(13408);
    assert.equal(tracker.flushSession(0).revisions, 0);
    assert.equal(tracker.getTodayRevisions(), 0);
    assert.equal(tracker.flushSession(13408).revisions, 0);
    assert.equal(tracker.flushSession(13420).revisions, 12);
    assert.equal(tracker.getTodayRevisions(), 12);
});
