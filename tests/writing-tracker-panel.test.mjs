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

const [mainTs, settings, panel, page, widgets, globalTracker] = await Promise.all([
    readFile(new URL('../main.ts', import.meta.url), 'utf8'),
    readFile(new URL('../settings.ts', import.meta.url), 'utf8'),
    readFile(new URL('../views/WritingTrackerPanel.ts', import.meta.url), 'utf8'),
    readFile(new URL('../views/WritingTrackerView.ts', import.meta.url), 'utf8'),
    readFile(new URL('../components/WritingTrackerWidgets.ts', import.meta.url), 'utf8'),
    readFile(new URL('../services/GlobalWritingTracker.ts', import.meta.url), 'utf8'),
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
    assert.equal(weeks[3].days[6].date, '2026-08-16');
    assert.equal(weeks[3].days[6].words, 120);
    assert.equal(weeks[3].days[6].level, 1);
    assert.equal(weeks[3].days[6].inRange, true);
});

test('year heatmap stays inside the requested calendar year', () => {
    const weeks = buildYearHeatmapWeeks({ '2026-01-01': 50 }, 2026, 100, new Date(2026, 0, 2));
    assert.ok(weeks.length >= 52);
    const firstInYear = weeks[0].days.find(d => d.inRange);
    assert.equal(firstInYear.date, '2026-01-01');
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

test('sidebar panel splits vault/project and pins a vertical global heatmap', () => {
    assert.match(panel, /WRITING_TRACKER_PANEL_TYPE/);
    assert.match(panel, /trackerScope: WritingTrackerScope = 'global'/);
    assert.match(panel, /renderVerticalWordHeatmap/);
    assert.match(panel, /globalWritingTracker\.tracker\.getFullHistory\(\)/);
    assert.match(widgets, /buildVerticalHeatmapWeeks/);
});

test('ribbon tracker page is vault-wide and not project-bound', () => {
    assert.match(page, /WRITING_TRACKER_VIEW_TYPE/);
    assert.doesNotMatch(page, /ProjectBoundItemView/);
    assert.match(page, /renderYearWordHeatmap/);
    assert.match(mainTs, /addRibbonIcon\('activity', t\('Open writing tracker'\)/);
    assert.match(mainTs, /ensureSideLeaf\.call\(workspace, WRITING_TRACKER_PANEL_TYPE, 'right'/);
    assert.match(mainTs, /async openWritingTracker\(/);
});

test('tracker settings are a dedicated settings tab', () => {
    assert.match(settings, /id: 'tracker'/);
    assert.match(settings, /renderTrackerSettingsTab/);
    assert.match(settings, /autoOpenWritingTrackerPanel/);
    assert.match(settings, /writingTrackerHeatmapWeeks/);
    assert.match(settings, /sprintDurationMinutes/);
});

test('session flush records into the vault-wide tracker file', () => {
    assert.match(mainTs, /flushWritingTrackers/);
    assert.match(mainTs, /globalWritingTracker\?\.recordFlush\(delta\)/);
    assert.match(globalTracker, /WRITING_TRACKER_FILENAME/);
    assert.match(globalTracker, /seedFromProjectIfEmpty/);
});
