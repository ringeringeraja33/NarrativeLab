import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';
import test from 'node:test';
import esbuild from 'esbuild';

const root = fileURLToPath(new URL('../', import.meta.url));

test('bundled grid loader defers evaluation and shares concurrent imports', async () => {
    const result = await esbuild.build({
        absWorkingDir: root,
        entryPoints: ['utils/loadPlotGridUniver.ts'],
        bundle: true, format: 'cjs', write: false, minify: true,
        plugins: [{
            name: 'observe-host-initialization',
            setup(build) {
                build.onLoad({ filter: /PlotGridUniverHost\.ts$/ }, () => ({
                    contents: `globalThis.hostLoads++;
                        export function createPlotGridUniverHost() { return 'ready'; }`,
                    loader: 'ts',
                }));
            },
        }],
    });
    const context = vm.createContext({ module: { exports: {} }, hostLoads: 0 });
    vm.runInContext(result.outputFiles[0].text, context);
    assert.equal(context.hostLoads, 0, 'importing the loader must not initialize Univer');
    const load = context.module.exports.loadPlotGridUniverModule;
    const [first, second] = await Promise.all([load({}), load({})]);
    assert.equal(context.hostLoads, 1);
    assert.equal(first, second);
    assert.equal(first.createPlotGridUniverHost(), 'ready');
    assert.equal(await load({}), first);
});

test('codec helpers do not initialize ExcelJS before workbook IO', async () => {
    const result = await esbuild.build({
        absWorkingDir: root,
        entryPoints: ['services/PlotGridXlsxCodec.ts'],
        bundle: true, format: 'cjs', write: false, minify: true,
        plugins: [{
            name: 'observe-excel-initialization',
            setup(build) {
                build.onResolve({ filter: /^exceljs$/ }, () => ({ path: 'exceljs', namespace: 'probe' }));
                build.onLoad({ filter: /.*/, namespace: 'probe' }, () => ({
                    contents: `globalThis.excelLoads++;
                        export default { Workbook: class {
                            constructor() { throw new Error('workbook IO reached'); }
                        } };`,
                }));
            },
        }],
    });
    const context = vm.createContext({ module: { exports: {} }, excelLoads: 0 });
    vm.runInContext(result.outputFiles[0].text, context);
    const codec = context.module.exports;
    codec.releasePlotGridWorkbookCache();
    assert.equal(context.excelLoads, 0);
    await assert.rejects(codec.encodePlotGridXlsx({}), /workbook IO reached/);
    assert.equal(context.excelLoads, 1);
    await assert.rejects(codec.decodePlotGridXlsx(new ArrayBuffer(0)), /workbook IO reached/);
    assert.equal(context.excelLoads, 1);
});

test('main bundle has no eager import path to spreadsheet dependencies', async (t) => {
    const result = await esbuild.build({
        absWorkingDir: root, entryPoints: ['main.ts'], bundle: true,
        format: 'cjs', write: false, metafile: true, minify: true,
        external: ['obsidian', 'electron', 'path', 'fs', 'os', '@codemirror/*', '@lezer/*'],
        loader: { '.md': 'text', '.css': 'text', '.svg': 'dataurl', '.png': 'dataurl', '.woff': 'dataurl', '.woff2': 'dataurl' },
        logLevel: 'silent',
    });
    const inputs = result.metafile.inputs;
    const eager = new Set();
    function visit(path) {
        if (eager.has(path)) return;
        eager.add(path);
        for (const entry of inputs[path]?.imports ?? []) {
            if (!entry.external && entry.kind !== 'dynamic-import') visit(entry.path);
        }
    }
    visit('main.ts');
    assert.ok(inputs['services/PlotGridUniverHost.ts'], 'Univer still ships in main.js');
    assert.ok(Object.keys(inputs).some(path => path.includes('node_modules/exceljs/')));
    assert.ok(!eager.has('services/PlotGridUniverHost.ts'));
    assert.ok(![...eager].some(path => /node_modules\/(?:@univerjs|exceljs)\//.test(path)));
    const main = await readFile(new URL('../main.ts', import.meta.url), 'utf8');
    assert.doesNotMatch(main, /warmupPlotGridUniver/);
    const deferredBytes = Object.entries(inputs)
        .filter(([path]) => !eager.has(path))
        .reduce((sum, [, input]) => sum + input.bytes, 0);
    t.diagnostic(`Deferred dependency source bytes: ${deferredBytes}; eager modules: ${eager.size}/${Object.keys(inputs).length}`);
});
