import assert from 'node:assert/strict';
import test from 'node:test';
import { build } from 'esbuild';

const result = await build({
    entryPoints: ['models/Scene.ts'],
    bundle: true,
    format: 'esm',
    platform: 'node',
    write: false,
});
const source = result.outputFiles[0].text;
const { coerceSceneLocations, sceneHasLocation, sceneLocationNames } = await import(
    `data:text/javascript;base64,${Buffer.from(source).toString('base64')}`
);

test('coerceSceneLocations accepts a scalar, a list, and the locations alias', () => {
    assert.deepEqual(coerceSceneLocations('Harbor'), ['Harbor']);
    assert.deepEqual(coerceSceneLocations(['Harbor', 'Castle']), ['Harbor', 'Castle']);
    assert.deepEqual(coerceSceneLocations('Harbor', ['Castle', 'harbor']), ['Harbor', 'Castle']);
    assert.deepEqual(coerceSceneLocations(undefined, null, ''), []);
});

test('scene helpers treat location as a list', () => {
    const scene = { location: ['Harbor', 'Castle'] };
    assert.deepEqual(sceneLocationNames(scene), ['Harbor', 'Castle']);
    assert.equal(sceneHasLocation(scene, 'castle'), true);
    assert.equal(sceneHasLocation(scene, 'Forest'), false);
});
