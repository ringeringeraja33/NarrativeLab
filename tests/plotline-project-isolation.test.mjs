import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const [mainTs, sceneManager, plotlineManager, plotlineModel] = await Promise.all([
    readFile(new URL('../main.ts', import.meta.url), 'utf8'),
    readFile(new URL('../services/SceneManager.ts', import.meta.url), 'utf8'),
    readFile(new URL('../services/PlotlineManager.ts', import.meta.url), 'utf8'),
    readFile(new URL('../models/Plotline.ts', import.meta.url), 'utf8'),
]);

const saveSystem = mainTs.slice(
    mainTs.indexOf('async saveProjectSystemData()'),
    mainTs.indexOf('async savePlotGrid('),
);

const writeSystem = mainTs.slice(
    mainTs.indexOf('private async writeSystemJson('),
    mainTs.indexOf('private async writeSystemJsonSafely('),
);

const switchProject = sceneManager.slice(
    sceneManager.indexOf('async setActiveProject('),
    sceneManager.indexOf('async renameProject('),
);

const getPlotlines = sceneManager.slice(
    sceneManager.indexOf('getPlotlines(): string[]'),
    sceneManager.indexOf('async addPlotline('),
);

const updateTags = sceneManager.slice(
    sceneManager.indexOf('async updateSceneTags('),
    sceneManager.indexOf('async renameTag('),
);

test('plotline registry is cloned and owner-stamped per project', () => {
    assert.match(plotlineModel, /export function clonePlotlineDefinitions/);
    assert.match(mainTs, /plotlineRegistryOwner = ''/);
    assert.match(mainTs, /claimPlotlineRegistry\(projectFile: string\)/);
    assert.match(mainTs, /adoptPlotlineRegistryForProject\(projectFile: string\)/);
    assert.match(plotlineManager, /this\.plugin\.claimPlotlineRegistry\(projectFile/);
});

test('saveProjectSystemData snapshots plotlines before any await and skips a mismatched owner', () => {
    assert.match(saveSystem, /if \(this\._loadingProjectSystemData\) return/);
    assert.match(saveSystem, /if \(owner && owner !== projectFilePath\) return/);
    assert.match(saveSystem, /clonePlotlineDefinitions\(this\.plotlineDefinitions\)/);
    assert.ok(
        saveSystem.indexOf('clonePlotlineDefinitions(this.plotlineDefinitions)')
            < saveSystem.indexOf('await this.projectExistsForWrite'),
        'plotline definitions must be copied before the first await',
    );
    assert.match(saveSystem, /writeSystemJson\('plotlines\.json', plotlinesPayload, projectFilePath\)/);
});

test('writeSystemJson accepts an explicit project path instead of re-reading activeProject after await', () => {
    assert.match(writeSystem, /projectFilePath = this\.sceneManager\.activeProject\?\.filePath/);
    assert.doesNotMatch(
        writeSystem.replace(/projectFilePath = this\.sceneManager\.activeProject\?\.filePath/, ''),
        /this\.sceneManager\.activeProject/,
    );
});

test('runtime cache round-trips plotline definitions with the project snapshot', () => {
    assert.match(mainTs, /plotlineDefinitions: clonePlotlineDefinitions\(this\.plotlineDefinitions\)/);
    assert.match(mainTs, /this\.plotlineDefinitions = clonePlotlineDefinitions\(snapshot\.plotlineDefinitions\)/);
    assert.match(mainTs, /this\.plotlineDefinitions = clonePlotlineDefinitions\(cached\.plotlineDefinitions\)/);
});

test('switching projects adopts the plotline registry before loading System JSON', () => {
    assert.match(switchProject, /_setActiveProjectQueue/);
    assert.match(switchProject, /adoptPlotlineRegistryForProject\(project\.filePath\)/);
    assert.ok(
        switchProject.indexOf('adoptPlotlineRegistryForProject(project.filePath)')
            < switchProject.indexOf('loadProjectSystemData()'),
        'in-memory plotlines must swap before the async System load',
    );
});

test('getPlotlines ignores a foreign registry and only counts scenes under the active project folder', () => {
    assert.match(getPlotlines, /plotlineRegistryOwner/);
    assert.match(getPlotlines, /registryBelongsHere/);
    assert.match(getPlotlines, /!normalizePath\(scene\.filePath\)\.startsWith\(base\)/);
});

test('updateSceneTags does not append plotlines onto a project the scene file is not under', () => {
    assert.match(updateTags, /deriveProjectFoldersFromFilePath\(project\.filePath\)\.baseFolder/);
    assert.match(updateTags, /normalizePath\(filePath\)\.startsWith\(base\)/);
});

test('plotline tag sync is a no-op while the registry belongs to another project', () => {
    const sync = plotlineManager.slice(
        plotlineManager.indexOf('syncSceneTags('),
        plotlineManager.indexOf('async syncScenePath('),
    );
    assert.match(sync, /plotlineRegistryOwner/);
    assert.match(sync, /owner !== activeFile/);
});
