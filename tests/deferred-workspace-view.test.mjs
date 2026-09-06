import assert from 'node:assert/strict';
import test from 'node:test';
import vm from 'node:vm';
import esbuild from 'esbuild';
const result = await esbuild.build({entryPoints: ['utils/deferWorkspaceView.ts'], bundle: true, write: false, format: 'cjs', external: ['obsidian']});
const context = vm.createContext({module: {exports: {}}, setTimeout, clearTimeout, console});
vm.runInContext(result.outputFiles[0].text, context);
const {deferWorkspaceView} = context.module.exports;
const tick = () => new Promise(resolve => setTimeout(resolve, 10));
function fixture() {
    let resolveReady, resolveOpen;
    const callbacks = [];
    const workspace = {layoutReady: false, on: (_, fn) => { callbacks.push(fn); }, onLayoutReady: fn => { callbacks.push(fn); }};
    const state = {visible: true, opens: 0, closes: 0, refreshes: 0, block: false};
    const view = {
        contentEl: {isConnected: true, getClientRects: () => state.visible ? [{}] : [], empty() {}, createDiv() {}, createEl: () => ({})},
        registerEvent() {},
        async onOpen() { state.opens++; if (state.block) await new Promise(resolve => { resolveOpen = resolve; }); },
        async onClose() { state.closes++; }, onResize() {}, refresh() { state.refreshes++; },
    };
    deferWorkspaceView(view, workspace, new Promise(resolve => { resolveReady = resolve; }), 'Loading');
    return {view, workspace, state, wake: () => callbacks.forEach(fn => fn()), ready: () => resolveReady(), finishOpen: () => resolveOpen()};
}
test('restoration returns before bootstrap and hidden views do no IO', async () => {
    const f = fixture();
    await f.view.onOpen();
    f.view.refresh(); await tick(); assert.equal(f.state.opens, 0);
    f.workspace.layoutReady = true; f.wake(); await tick(); assert.equal(f.state.opens, 0);
    f.state.visible = false; f.ready(); await tick(); assert.equal(f.state.opens, 0);
    f.state.visible = true; f.wake(); f.wake(); await tick(); assert.equal(f.state.opens, 1);
    f.view.refresh(); assert.equal(f.state.refreshes, 1);
    f.wake(); await tick(); assert.equal(f.state.opens, 1);
    await f.view.onClose(); assert.equal(f.state.closes, 1);
});
test('close cancels pending opens; in-flight mounts drain before teardown', async () => {
    const f = fixture(); await f.view.onOpen(); await f.view.onClose();
    f.workspace.layoutReady = true; f.ready(); f.wake(); await tick(); assert.equal(f.state.opens, 0);
    f.state.block = true; await f.view.onOpen(); await tick(); assert.equal(f.state.opens, 1);
    const closing = f.view.onClose(); assert.equal(f.state.closes, 0);
    f.finishOpen(); await closing; assert.equal(f.state.closes, 1);
    f.wake(); await tick(); assert.equal(f.state.opens, 1);
});
