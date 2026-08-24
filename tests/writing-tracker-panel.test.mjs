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
    reconcileDerivedTrackerHistory,
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
const revisionBuild = await build({
    entryPoints: ['utils/wordcountText.ts'],
    bundle: true,
    format: 'esm',
    platform: 'node',
    write: false,
});
const { countWordRevisionChurn } = await import(
    `data:text/javascript;base64,${Buffer.from(revisionBuild.outputFiles[0].text).toString('base64')}`
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

test('year heatmap runs chronologically from left to right and stays inside the requested year', () => {
    const weeks = buildYearHeatmapWeeks({ '2026-01-01': 50 }, 2026, 100, new Date(2026, 0, 2));
    assert.ok(weeks.length >= 52);
    const jan1 = weeks.flatMap(week => week.days).find(day => day.date === '2026-01-01');
    assert.equal(jan1?.words, 50);
    assert.equal(jan1?.inRange, true);
    assert.ok(weeks[0].days.some(day => day.date === '2026-01-01'));
    assert.ok(weeks[weeks.length - 1].start >= '2026-12-21');
    for (let i = 1; i < weeks.length; i++) {
        assert.ok(weeks[i - 1].start < weeks[i].start);
    }
});

test('parseWritingTrackerFile keeps dated totals only', () => {
    const parsed = parseWritingTrackerFile({
        history: { '2026-08-16': 12, nope: 3, '2026-08-17': '8', '2026-08-18': 0, '2026-02-31': 99 },
        revisionHistory: { '2026-08-16': 4, '2026-08-17': -3 },
        unattributedHistory: { '2026-08-13': '5382', invalid: 7 },
        unattributedRevisionHistory: { '2026-08-13': 12, '2026-08-14': -1 },
    });
    assert.equal(parsed.history['2026-08-16'], 12);
    assert.equal(parsed.history['2026-08-17'], 8);
    assert.equal(parsed.history['2026-08-18'], 0);
    assert.equal(parsed.history.nope, undefined);
    assert.equal(parsed.history['2026-02-31'], undefined);
    assert.equal(parsed.revisionHistory['2026-08-16'], 4);
    assert.equal(parsed.revisionHistory['2026-08-17'], undefined);
    assert.equal(parsed.unattributedHistory['2026-08-13'], 5382);
    assert.equal(parsed.unattributedHistory.invalid, undefined);
    assert.equal(parsed.unattributedRevisionHistory['2026-08-13'], 12);
    assert.equal(parsed.unattributedRevisionHistory['2026-08-14'], undefined);
    assert.equal(WRITING_TRACKER_FILENAME, 'writing-tracker.json');
});

test('project-derived totals quarantine legacy-only dates without deleting them', () => {
    const first = reconcileDerivedTrackerHistory(
        { '2026-08-14': 20 },
        { '2026-08-07': 5, '2026-08-13': 5382, '2026-08-14': 999 },
        {},
    );
    assert.deepEqual(first.history, { '2026-08-14': 20 });
    assert.deepEqual(first.unattributedHistory, {
        '2026-08-07': 5,
        '2026-08-13': 5382,
        '2026-08-14': 979,
    });

    const repeated = reconcileDerivedTrackerHistory(first.history, first.history, first.unattributedHistory);
    assert.deepEqual(repeated, first);

    const laterAttributed = reconcileDerivedTrackerHistory(
        { '2026-08-13': 30, '2026-08-14': 20 },
        first.history,
        first.unattributedHistory,
    );
    assert.deepEqual(laterAttributed.history, { '2026-08-13': 30, '2026-08-14': 20 });
    assert.deepEqual(laterAttributed.unattributedHistory, first.unattributedHistory);
});

test('recovered history merges without resetting a live session or sprint', () => {
    const tracker = new WritingTracker();
    tracker.importData({ history: { '2026-08-10': 10 }, revisionHistory: { '2026-08-10': 4 } });
    tracker.startSession(100, true, 1000);
    assert.equal(tracker.startSprint(100, 2000), true);
    tracker.mergePersistedHistory(
        { '2026-08-10': 5, '2026-08-11': 20 },
        { '2026-08-10': 3, '2026-08-11': 7 },
    );
    assert.deepEqual(tracker.getFullHistory(), { '2026-08-10': 15, '2026-08-11': 20 });
    assert.deepEqual(tracker.getFullRevisionHistory(), { '2026-08-10': 7, '2026-08-11': 7 });
    assert.equal(tracker.isSprintRunning(), true);
    assert.equal(tracker.getSessionWords(120), 20);
});

test('sidebar panel splits vault/project and pins a vertical heatmap for the active scope', async () => {
    const styles = await readFile(new URL('../styles.css', import.meta.url), 'utf8');
    assert.match(panel, /WRITING_TRACKER_PANEL_TYPE/);
    assert.match(panel, /trackerScope: WritingTrackerScope = 'global'/);
    assert.match(panel, /renderVerticalWordHeatmap/);
    assert.match(panel, /this\.source\(\)\.getFullHistory\(\)/);
    assert.match(widgets, /buildVerticalHeatmapWeeks/);
    assert.match(styles, /\.nl-tracker-heatmap-vertical \.nl-tracker-heatmap-week \{[^}]*grid-template-columns:\s*repeat\(7, 18px\)/s);
    assert.match(styles, /\.nl-tracker-heatmap-vertical \.nl-tracker-heatmap-dow > span \{[^}]*white-space:\s*nowrap/s);
    assert.match(styles, /\.nl-tracker-heatmap-vertical \.nl-tracker-heat-cell \{[^}]*width:\s*11px/s);
    assert.match(styles, /\.nl-tracker-panel,\s*\n\.nl-tracker-page \{[^}]*text-align:\s*center/s);
    assert.match(styles, /\.nl-tracker-cards,\s*\n\.nl-tracker-page-cards \{[^}]*justify-content:\s*center/s);
});

test('project tracker names its project and follows open project files', () => {
    assert.match(panel, /Project: \{title\}/);
    assert.match(panel, /Paused — no project files are open\./);
    assert.match(mainTs, /hasOpenFileForProject/);
    assert.match(mainTs, /leaf\.view instanceof FileView/);
    assert.match(mainTs, /setProjectFilesOpen/);
    assert.match(mainTs, /workspace\.on\('layout-change'/);
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
    assert.match(mainTs, /globalWritingTracker\?\.recordFlush\(delta, now\)/);
    assert.match(mainTs, /rebindWritingTrackerSession/);
    assert.match(sceneManager, /flushWritingTrackers/);
    assert.match(sceneManager, /rebindWritingTrackerSession/);
    assert.match(globalTracker, /WRITING_TRACKER_FILENAME/);
    assert.match(globalTracker, /reconcileProjectLedgers/);
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

test('empty projects start at zero and keep their first words', () => {
    const tracker = new WritingTracker();
    tracker.startSession(0);
    assert.equal(tracker.flushSession(25).words, 25);
    assert.equal(tracker.getTodayWords(), 25);
    assert.equal(tracker.startSprint(0, 2000), true);
    tracker.resetSprint();
    assert.equal(tracker.startSprint(-3), false);
    assert.equal(tracker.startSprint(13408), true);
    assert.match(panel, /if \(!tracker\.startSprint\(totalNow\)\)/);
    assert.match(panel, /Cannot start a sprint until the project word count is ready/);
});

test('project session and sprint clocks pause while every project file is closed', () => {
    const tracker = new WritingTracker();
    tracker.startSession(1000, true, 1000);
    assert.equal(tracker.getSessionDuration(4000), 3000);
    assert.equal(tracker.startSprint(1000, 2000), true);
    assert.equal(tracker.getSprintElapsed(4000), 2000);

    assert.equal(tracker.setProjectFilesOpen(false, 4000), true);
    assert.equal(tracker.getSessionDuration(9000), 3000);
    assert.equal(tracker.getSprintElapsed(9000), 2000);

    assert.equal(tracker.setProjectFilesOpen(true, 9000), true);
    assert.equal(tracker.getSessionDuration(11000), 5000);
    assert.equal(tracker.getSprintElapsed(11000), 4000);
    assert.equal(tracker.stopSprint(1010, 11000)?.durationMs, 4000);
});

test('daily net words roll back deletions instead of retaining a high-water mark', () => {
    const tracker = new WritingTracker();
    tracker.startSession(1000);
    assert.equal(tracker.flushSession(1100).words, 100);
    assert.equal(tracker.flushSession(1000).words, -100);
    assert.equal(tracker.getTodayWords(), 0);
    assert.ok(Object.values(tracker.getFullHistory()).includes(0));
    assert.equal(tracker.flushSession(1050).words, 50);
    assert.equal(tracker.getTodayWords(), 50);
});

test('starting a session never deletes a legitimate large daily total', () => {
    const today = writingTrackerDateKey(new Date());
    const tracker = new WritingTracker();
    tracker.importData({ history: { [today]: 800 } });
    tracker.startSession(1000);
    assert.equal(tracker.getTodayWords(), 800);
});

test('revision volume counts inserted and deleted tokens including equal-length replacements', () => {
    assert.equal(countWordRevisionChurn('alpha beta', 'alpha gamma', 'en'), 2);
    assert.equal(countWordRevisionChurn('alpha beta', 'beta alpha', 'en'), 0);
    assert.equal(countWordRevisionChurn('Alpha', 'alpha', 'en'), 2);
    const tracker = new WritingTracker();
    tracker.startSession(2);
    tracker.recordRevisionWords(2);
    assert.equal(tracker.flushSession(2).revisions, 2);
    assert.equal(tracker.getTodayRevisions(), 2);
});

test('daily average includes zero-output calendar days', () => {
    const tracker = new WritingTracker();
    tracker.importData({
        history: {
            '2026-08-10': 100,
            '2026-08-12': 200,
        },
    });
    assert.equal(tracker.getDailyAverage(new Date(2026, 7, 12, 12).getTime()), 100);
});

test('flush timestamps and sprint ranges preserve cross-midnight attribution', () => {
    const dayOne = new Date(2026, 7, 20, 23, 59, 50).getTime();
    const dayTwo = new Date(2026, 7, 21, 0, 0, 10).getTime();
    const tracker = new WritingTracker();
    tracker.startSession(100, true, dayOne);
    tracker.flushSession(110, dayTwo);
    assert.equal(tracker.getFullHistory()['2026-08-21'], 10);
    assert.equal(tracker.startSprint(110, dayOne), true);
    const sprint = tracker.stopSprint(120, dayTwo);
    assert.equal(sprint?.date, '2026-08-20');
    assert.equal(sprint?.endDate, '2026-08-21');
});

test('running sprint survives project ledger save and restore', () => {
    const tracker = new WritingTracker();
    tracker.startSession(1000, true, 1000);
    tracker.startSprint(1000, 2000);
    const saved = tracker.exportData(5000);
    const restored = new WritingTracker();
    restored.importData(saved);
    assert.equal(restored.isSprintRunning(), true);
    restored.startSession(1010, true, 10000);
    assert.equal(restored.getSprintElapsed(11000), 4000);
    assert.equal(restored.stopSprint(1015, 11000)?.words, 15);
});

test('vault totals reconcile every project and tracker deltas autosave safely', () => {
    assert.match(globalTracker, /reconcileProjectLedgers/);
    assert.match(globalTracker, /for \(const project of this\.plugin\.sceneManager\.getProjects\(\)\)/);
    assert.match(globalTracker, /tempPath/);
    assert.match(globalTracker, /unattributedHistory/);
    assert.doesNotMatch(panel, /getUnattributedWordTotal|nl-tracker-ledger-warning/);
    assert.match(globalTracker, /if \(!complete\) return false/);
    assert.match(settings, /renderWordCountCorrections/);
    assert.match(settings, /assignUnattributedToProject/);
    assert.match(settings, /Assign to project/);
    assert.match(settings, /Delete records/);
    assert.match(settings, /applyProjectWordCorrection/);
    assert.match(globalTracker, /applyWritingTrackerHistoryDelta/);
    assert.match(mainTs, /Do not change the live tracker until the safe project write succeeds/);
    assert.match(mainTs, /scheduleWritingTrackerSave/);
    assert.match(mainTs, /this\.writingTracker\.recordRevisionWords/);
});

test('settings assignment writes the project before clearing preserved legacy records', () => {
    const recovery = globalTracker.slice(globalTracker.indexOf('async assignUnattributedToProject'));
    assert.ok(recovery.indexOf('reconcileProjectLedgers()') < recovery.indexOf('const history ='));
    assert.ok(recovery.indexOf('applyWritingTrackerHistoryDelta(') < recovery.indexOf('delete this.unattributedHistory'));
    assert.ok(recovery.indexOf('delete this.unattributedHistory') < recovery.indexOf('await this.save()'));
    const projectWrite = mainTs.slice(mainTs.indexOf('async applyWritingTrackerHistoryDelta'));
    assert.ok(projectWrite.indexOf("writeSystemJson('stats.json'") < projectWrite.indexOf('this.writingTracker.mergePersistedHistory'));
    assert.match(projectWrite, /\.\.\.existingStats/);
});

test('manual corrections are project-first and unattributed records can be deleted', () => {
    const correction = globalTracker.slice(
        globalTracker.indexOf('async applyProjectWordCorrection'),
        globalTracker.indexOf('async deleteUnattributedHistory'),
    );
    assert.ok(correction.indexOf('reconcileProjectLedgers()') < correction.indexOf('loadProjectTracker'));
    assert.ok(correction.indexOf('applyWritingTrackerHistoryDelta(') < correction.indexOf('this.tracker.mergePersistedHistory'));
    assert.ok(correction.indexOf('this.tracker.mergePersistedHistory') < correction.indexOf('this.save()'));
    const deletion = globalTracker.slice(globalTracker.indexOf('async deleteUnattributedHistory'));
    assert.match(deletion, /previousHistory/);
    assert.match(deletion, /this\.unattributedHistory = \{\}/);
    assert.match(deletion, /this\.unattributedHistory = previousHistory/);
    assert.match(settings, /never edit, create, restore, or delete manuscript files/);
    assert.doesNotMatch(settings, /Restore writing history|Restore to project/);
    assert.match(globalTracker, /prefer it over the older canonical ledger/);
});
