// CSS regression against the real web app and its Shadow DOM embedding.
// Uses isolated browser storage; no vault files or plugin settings are opened.
import assert from 'node:assert/strict';
import { readFile, mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { chromium } = require(process.env.NARRATIVE_LAB_PLAYWRIGHT || 'playwright');
const css = await readFile('canvas-runtime/canvas.css', 'utf8');
const files = {
    '/empty': ['text/html', '<!doctype html><meta charset="utf-8"><body></body>'],
    '/index.html': ['text/html', await readFile('canvas-runtime/index.html', 'utf8')],
    '/canvas.css': ['text/css', css],
    '/app.js': ['text/javascript', await readFile('canvas-runtime/app.js', 'utf8')],
};
const browser = await chromium.launch({ headless: true, ...(process.env.NARRATIVE_LAB_BROWSER ? { executablePath: process.env.NARRATIVE_LAB_BROWSER } : {}) });
const output = await mkdtemp(join(tmpdir(), 'writinglab-canvas-type-'));
try {
    const page = await browser.newPage({ viewport: { width: 1440, height: 920 }, locale: 'zh-CN' });
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    await page.route('**/*', route => {
        const file = files[new URL(route.request().url()).pathname];
        return file ? route.fulfill({contentType: file[0] + '; charset=utf-8', body:file[1]}) : route.fulfill({status:404,body:''});
    });
    await page.goto('http://writinglab.test/index.html');
    await page.locator('.node').first().waitFor();
    await page.evaluate(() => {
        document.documentElement.dataset.theme = 'light';
        document.querySelector('.app-shell').dataset.theme = 'light';
    });
    const sizes = () => page.evaluate(() => {
        const scope = document.querySelector('#canvas-test-host')?.shadowRoot || document;
        return Object.fromEntries(['.app-shell','.toolbar-button','.inspector-tab','.small-button','.field input','.confirm-actions button','.node','.node-title','.node-text'].map(selector => {
            const el = scope.querySelector(selector);
            if (!el) throw new Error('Missing typography target: ' + selector);
            return [selector, getComputedStyle(el).fontSize];
        }));
    });
    const web = await sizes();
    for (const selector of ['.app-shell','.toolbar-button','.inspector-tab','.field input','.confirm-actions button']) assert.equal(web[selector],'13px',selector);
    assert.equal(web['.node'],'14px','card reading size stays independent');
    const rendered = await page.locator('body').innerHTML();
    await page.screenshot({path:join(output,'canvas-web.png')});

    // Reuse real rendered markup in a fresh document so the running web app
    // cannot mutate it while checking the plugin's shadow styling.
    await page.goto('http://writinglab.test/empty');
    await page.evaluate(({markup,css}) => {
        document.body.innerHTML = '';
        Object.assign(document.body.style,{margin:'0',fontSize:'28px',fontFamily:'serif',height:'100vh'});
        const host=document.createElement('div');
        host.id='canvas-test-host';host.dataset.theme='light';
        Object.assign(host.style,{height:'100%',fontSize:'28px'});
        document.body.append(host);
        const root=host.attachShadow({mode:'open'});
        root.innerHTML='<style>'+css+'</style>'+markup.replace(/<script\b[\s\S]*?<\/script>/gi,'');
    }, {markup:rendered,css:css.replace(/:root(\[[^\]]+\])/g,':host($1)').replace(/:root/g,':host')});
    const embedded = await sizes();
    assert.deepEqual(embedded,web,'host editor font cannot enlarge canvas controls or card text');
    await page.screenshot({path:join(output,'canvas-shadow-large-host.png')});
    await page.evaluate(() => document.querySelector('#canvas-test-host').shadowRoot.querySelector('#genericConfirmDialog').showModal());
    assert.equal((await sizes())['.confirm-actions button'],'13px','top-layer dialog controls stay compact');
    await page.evaluate(() => document.querySelector('#canvas-test-host').shadowRoot.querySelector('#genericConfirmDialog').close());
    await page.evaluate(() => {
        const host=document.querySelector('#canvas-test-host');host.dataset.theme='dark';
        host.shadowRoot.querySelector('.app-shell').dataset.theme='dark';
    });
    assert.deepEqual(await sizes(),web,'dark mode has the same type scale');
    await page.screenshot({path:join(output,'canvas-shadow-dark.png')});
    assert.deepEqual(errors,[]);
    console.log(JSON.stringify({passed:true,output,web,embedded},null,2));
} finally { await browser.close(); }
