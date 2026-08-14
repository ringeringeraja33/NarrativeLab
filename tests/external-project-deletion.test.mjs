import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const [mainTs, sceneManagerTs] = await Promise.all([
    readFile(new URL('../main.ts', import.meta.url), 'utf8'),
    readFile(new URL('../services/SceneManager.ts', import.meta.url), 'utf8'),
]);

test('folder and manifest deletion invalidate the project before ordinary refresh handlers', () => {
    const deleteWatcher = mainTs.slice(
        mainTs.indexOf("this.app.vault.on('delete'"),
        mainTs.indexOf("this.app.vault.on('rename'"),
    );
    assert.match(deleteWatcher, /handleProjectTreeDelete\(file\.path, true\)/);
    assert.match(deleteWatcher, /handleProjectTreeDelete\(file\.path, false\)/);
    assert.ok(
        deleteWatcher.indexOf('handleProjectTreeDelete(file.path, true)')
            < deleteWatcher.indexOf('handleDraftFolderDelete(file.path)'),
        'project invalidation must run before draft reconciliation can save data',
    );
});

test('external project deletion clears active state and tombstones its whole root', () => {
    const handler = sceneManagerTs.slice(
        sceneManagerTs.indexOf('handleProjectTreeDelete('),
        sceneManagerTs.indexOf('async withActiveProject'),
    );
    assert.match(handler, /this\.projects\.delete\(filePath\)/);
    assert.match(handler, /deletedProjectRoots\.add\(deriveProjectFoldersFromFilePath\(projectFile\)\.baseFolder\)/);
    assert.match(handler, /this\._activeProject = null/);
    assert.match(handler, /this\.plugin\.settings\.activeProjectFile = ''/);
    assert.match(handler, /this\.scenes\.clear\(\)/);
});

test('late System and datasheet saves verify the original project manifest', () => {
    assert.match(mainTs, /projectExistsForWrite\(projectFilePath/);
    assert.match(mainTs, /isDeletedProjectPath\(normalized\)/);
    assert.match(mainTs, /writeSystemJsonSafely\(filename, filePath, data, projectFilePath!/);
    assert.match(mainTs, /if \(!await this\.projectExistsForWrite\(projectFilePath\)\) return;/);
    assert.match(mainTs, /savePlotGridSafely\([\s\S]*projectFilePath\)/);
    assert.match(mainTs, /savePlotGridSafely\([\s\S]*if \(!await this\.projectExistsForWrite\(projectFilePath\)\) return;/);
});

test('a zero-project rescan cannot retain a stale active project', () => {
    const scan = sceneManagerTs.slice(
        sceneManagerTs.indexOf('async scanProjects()'),
        sceneManagerTs.indexOf('public getEffectiveLocale'),
    );
    assert.match(scan, /else \{[\s\S]*this\._activeProject = null;[\s\S]*activeProjectFile = '';/);
});
