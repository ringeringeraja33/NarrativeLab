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

test('moving a project folder tombstones the old root so empty folders are not recreated', async () => {
    const handler = sceneManagerTs.slice(
        sceneManagerTs.indexOf('async handleProjectTreeFolderRename'),
        sceneManagerTs.indexOf('private async syncDraftScenePaths'),
    );
    assert.match(handler, /deletedProjectRoots\.add\(from\)/);
    assert.match(handler, /deletedProjectRoots\.add\(deriveProjectFoldersFromFilePath\(project\.filePath\)\.baseFolder\)/);
    assert.match(handler, /deletedProjectRoots\.delete\(to\)/);
    assert.ok(
        handler.indexOf('deletedProjectRoots.add(from)')
            < handler.indexOf('await this.plugin.saveData'),
        'old root must be tombstoned before any await',
    );
    const ensure = sceneManagerTs.slice(
        sceneManagerTs.indexOf('private async ensureFolder(folderPath: string)'),
        sceneManagerTs.indexOf('private parseDefaultSceneFrontmatter'),
    );
    assert.match(ensure, /ensureVaultFolder\(this\.app, folderPath\)/);
    assert.match(sceneManagerTs, /registerDeletedProjectPathGuard/);
    assert.match(mainTs, /isDeletedProjectPath\(folder\)/);

    const [vaultFolders, characterManager, locationManager, codexManager, researchManager] = await Promise.all([
        readFile(new URL('../utils/vaultFolders.ts', import.meta.url), 'utf8'),
        readFile(new URL('../services/CharacterManager.ts', import.meta.url), 'utf8'),
        readFile(new URL('../services/LocationManager.ts', import.meta.url), 'utf8'),
        readFile(new URL('../services/CodexManager.ts', import.meta.url), 'utf8'),
        readFile(new URL('../services/ResearchManager.ts', import.meta.url), 'utf8'),
    ]);
    assert.match(vaultFolders, /isTombstonedProjectPath\(normalized\)/);
    assert.match(vaultFolders, /isTombstonedProjectPath\(current\)/);
    for (const source of [characterManager, locationManager, codexManager, researchManager]) {
        assert.match(source, /ensureVaultFolder\(this\.app,/);
    }
});

test('deleteProject tombstones the root before any await and lifts it if trash fails', () => {
    const fn = sceneManagerTs.slice(
        sceneManagerTs.indexOf('async deleteProject('),
        sceneManagerTs.indexOf('async forkProject('),
    );
    assert.match(fn, /deletedProjectRoots\.add\(baseFolder\)/);
    assert.match(fn, /deletedProjectRoots\.delete\(baseFolder\)/);
    assert.ok(
        fn.indexOf('deletedProjectRoots.add(baseFolder)')
            < fn.indexOf('await this.plugin.seriesManager.loadSeriesMetadata'),
        'UI delete must tombstone before any await',
    );
    assert.ok(
        fn.indexOf('deletedProjectRoots.delete(baseFolder)')
            < fn.indexOf('throw error'),
        'failed trash must lift the tombstone so a retry can write again',
    );
});

test('startup attachment migration skips tombstoned project roots', async () => {
    const migration = await readFile(new URL('../services/LibraryAttachmentMigration.ts', import.meta.url), 'utf8');
    assert.equal(
        (migration.match(/if \(plugin\.sceneManager\.isDeletedProjectPath\(baseFolder\)\) return false;/g) || []).length,
        2,
    );
});

test('a zero-project rescan cannot retain a stale active project', () => {
    const scan = sceneManagerTs.slice(
        sceneManagerTs.indexOf('async scanProjects()'),
        sceneManagerTs.indexOf('public getEffectiveLocale'),
    );
    assert.match(scan, /else \{[\s\S]*this\._activeProject = null;[\s\S]*activeProjectFile = '';/);
});
