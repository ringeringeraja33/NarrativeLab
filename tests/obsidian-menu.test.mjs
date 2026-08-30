import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const result = await build({
    entryPoints: [path.join(root, 'utils/obsidianMenu.ts')],
    bundle: true,
    format: 'esm',
    platform: 'node',
    write: false,
    external: ['obsidian'],
});
const source = result.outputFiles[0].text;
const {
    menuShowShouldGateOnTrailingContextMenu,
    menuShowShouldShieldTrailingPointerEvents,
} = await import(
    `data:text/javascript;base64,${Buffer.from(source).toString('base64')}`
);

test('gates right mouseup/pointerup so trailing contextmenu cannot dismiss the menu', () => {
    assert.equal(
        menuShowShouldGateOnTrailingContextMenu({ type: 'mouseup', button: 2 }),
        true,
    );
    assert.equal(
        menuShowShouldGateOnTrailingContextMenu({ type: 'pointerup', button: 2 }),
        true,
    );
    assert.equal(
        menuShowShouldGateOnTrailingContextMenu({ type: 'mousedown', button: 2 }),
        true,
    );
});

test('does not wait for another contextmenu when already handling contextmenu or left click', () => {
    assert.equal(
        menuShowShouldGateOnTrailingContextMenu({ type: 'contextmenu', button: 2 }),
        false,
    );
    assert.equal(
        menuShowShouldGateOnTrailingContextMenu({ type: 'click', button: 0 }),
        false,
    );
    assert.equal(
        menuShowShouldGateOnTrailingContextMenu({ x: 10, y: 20 }),
        false,
    );
});

test('shields auxclick after a contextmenu so the menu is not treated as outside-click', () => {
    assert.equal(
        menuShowShouldShieldTrailingPointerEvents({ type: 'contextmenu', button: 2 }),
        true,
    );
    assert.equal(
        menuShowShouldShieldTrailingPointerEvents({ type: 'mouseup', button: 2 }),
        true,
    );
    assert.equal(
        menuShowShouldShieldTrailingPointerEvents({ type: 'click', button: 0 }),
        false,
    );
    assert.equal(
        menuShowShouldShieldTrailingPointerEvents({ x: 10, y: 20 }),
        false,
    );
});

test('plugin sources show Obsidian menus through showMenuSafely', async () => {
    const skip = new Set([
        path.join(root, 'utils', 'obsidianMenu.ts'),
    ]);
    const hits = [];
    async function walk(dir) {
        for (const entry of await fs.readdir(dir, { withFileTypes: true })) {
            const full = path.join(dir, entry.name);
            if (entry.isDirectory()) {
                if (entry.name === 'node_modules' || entry.name === 'canvas-runtime') continue;
                await walk(full);
                continue;
            }
            if (!entry.name.endsWith('.ts')) continue;
            if (skip.has(full)) continue;
            const text = await fs.readFile(full, 'utf8');
            if (/\.showAtMouseEvent\(/.test(text) || /menu\.showAtPosition\(/.test(text)) {
                hits.push(path.relative(root, full));
            }
        }
    }
    await walk(path.join(root, 'components'));
    await walk(path.join(root, 'views'));
    await walk(path.join(root, 'services'));
    await walk(path.join(root, 'utils'));
    for (const file of ['main.ts', 'settings.ts']) {
        const text = await fs.readFile(path.join(root, file), 'utf8');
        if (/\.showAtMouseEvent\(/.test(text) || /menu\.showAtPosition\(/.test(text)) {
            hits.push(file);
        }
    }
    assert.deepEqual(hits, []);
});

// Exercise the real menu callbacks and file-move guards without a live vault.
const menuMock = { menus: [], notices: [], confirmations: [] };
globalThis.__nlEntryMenuMock = menuMock;
const entryMenuBuild = await build({
    entryPoints: [path.join(root, 'components/LibraryEntryContextMenu.ts')],
    bundle: true,
    format: 'esm',
    platform: 'node',
    write: false,
    plugins: [{
        name: 'entry-menu-host',
        setup(builder) {
            builder.onResolve({ filter: /^(obsidian|.*\/i18n|.*\/obsidianMenu|.*\/ConfirmModal)$/ }, args => ({
                path: args.path,
                namespace: 'entry-menu-host',
            }));
            builder.onLoad({ filter: /.*/, namespace: 'entry-menu-host' }, args => {
                if (args.path.endsWith('/i18n')) return { contents: `
                    export const t = (text, values = {}) => text.replace(/\\{([^}]+)\\}/g, (_, key) => String(values[key] ?? key));
                ` };
                if (args.path.endsWith('/obsidianMenu')) return { contents: 'export const showMenuSafely = () => {};' };
                if (args.path.endsWith('/ConfirmModal')) return { contents: `
                    export const openConfirmModal = (_app, options) => globalThis.__nlEntryMenuMock.confirmations.push(options);
                ` };
                return { contents: `
                    const mock = globalThis.__nlEntryMenuMock;
                    export const normalizePath = path => path.replace(/\\\\/g, '/').replace(/\\/+/g, '/').replace(/\\/$/, '');
                    export class TFile { constructor(path) { this.path = path; } }
                    mock.TFile = TFile;
                    export class Menu {
                        constructor() { this.items = []; mock.menus.push(this); }
                        addSeparator() {}
                        addItem(build) {
                            const item = {
                                setTitle(title) { this.title = title; return this; },
                                setIcon(icon) { this.icon = icon; return this; },
                                onClick(click) { this.click = click; return this; },
                            };
                            build(item);
                            this.items.push(item);
                        }
                    }
                    export class Notice { constructor(message) { mock.notices.push(message); } }
                ` };
            });
        },
    }],
});
const { getLibraryEntryMove, moveLibraryEntry, showLibraryEntryContextMenu } = await import(
    `data:text/javascript;base64,${Buffer.from(entryMenuBuild.outputFiles[0].text).toString('base64')}`
);

function entryMenuFixture({ shared = true, series = true } = {}) {
    menuMock.menus.length = menuMock.notices.length = menuMock.confirmations.length = 0;
    const project = { filePath: 'Series/Book/Book.md', title: 'Book', codexFolder: 'Series/Book/Library', seriesId: series ? 'series' : undefined };
    const source = `${shared ? 'Series/Library' : project.codexFolder}/改名分类/子目录/Entry.md`;
    const file = new menuMock.TFile(source);
    file.content = '---\nbooks: [Other]\ncustom: keep me\n---\nUnchanged prose and [[links]].';
    const files = new Map([
        [source, file],
        [project.filePath, new menuMock.TFile(project.filePath)],
        ['Series/Library', {}],
        [project.codexFolder, {}],
    ]);
    const unindexed = new Set();
    const renamed = [];
    const opened = [];
    const created = [];
    const plugin = {
        app: {
            vault: {
                getAbstractFileByPath: key => files.get(key) ?? null,
                adapter: { exists: async key => files.has(key) || unindexed.has(key) },
                createFolder: async key => { created.push(key); files.set(key, {}); },
            },
            fileManager: {
                renameFile: async (target, destination) => {
                    assert.equal(files.has(destination), false);
                    renamed.push([target.path, destination]);
                    files.delete(target.path);
                    target.path = destination;
                    files.set(destination, target);
                },
            },
            workspace: { getLeaf: kind => { assert.equal(kind, 'tab'); return { openFile: async target => opened.push(target.path) }; } },
        },
        sceneManager: {
            activeProject: project,
            getProjects: () => [project],
            getSeriesFolderForProject: p => p?.seriesId ? 'Series' : null,
        },
        refreshOpenViews: async () => {},
    };
    return { plugin, project, source, file, files, renamed, opened, unindexed, created };
}

test('Library entry moves preserve renamed categories and nested paths in either direction', () => {
    const local = 'Series/Book/Library';
    const shared = 'Series/Library';
    const move = getLibraryEntryMove(`${shared}/人物/子目录/A.md`, local, shared);
    assert.deepEqual(move, { destination: `${local}/人物/子目录/A.md`, toShared: false });
    assert.deepEqual(getLibraryEntryMove(move.destination, local, shared), {
        destination: `${shared}/人物/子目录/A.md`, toShared: true,
    });
    assert.equal(getLibraryEntryMove('Series/Library-other/A.md', local, shared), null);
    assert.equal(getLibraryEntryMove(`${shared}/A.md`, shared, shared), null);
    assert.equal(getLibraryEntryMove(`${shared}/../A.md`, local, shared), null);
});

test('standalone profile menus have two distinct working open actions and no membership controls', async () => {
    const f = entryMenuFixture({ shared: false, series: false });
    let profiles = 0;
    showLibraryEntryContextMenu(f.plugin, {
        filePath: f.source, name: 'Entry', projectFile: f.project.filePath, onOpenProfile: () => { profiles++; },
    }, {});
    const items = menuMock.menus[0].items;
    assert.deepEqual(items.map(item => item.title), ['Open profile', 'Open source file in new tab']);
    await items[0].click();
    await items[1].click();
    assert.equal(profiles, 1);
    assert.deepEqual(f.opened, [f.source]);
});

test('shared profile menu offers one confirmed move and preserves all file contents', async () => {
    const f = entryMenuFixture();
    const before = f.file.content;
    showLibraryEntryContextMenu(f.plugin, {
        filePath: f.source, name: 'Entry', projectFile: f.project.filePath, onOpenProfile: () => {},
    }, {});
    const items = menuMock.menus[0].items;
    assert.equal(items.length, 3);
    assert.equal(items[2].title, 'Move to "Book" Library');
    await items[2].click();
    assert.equal(f.renamed.length, 0);
    assert.equal(menuMock.confirmations.length, 1);
    await menuMock.confirmations[0].onConfirm();
    assert.deepEqual(f.renamed, [[f.source, `${f.project.codexFolder}/改名分类/子目录/Entry.md`]]);
    assert.equal(f.file.content, before);
    assert.equal(menuMock.notices.length, 1);
});

test('local profile menu moves the actual note to the shared category', async () => {
    const f = entryMenuFixture({ shared: false });
    showLibraryEntryContextMenu(f.plugin, {
        filePath: f.source, name: 'Entry', projectFile: f.project.filePath, onOpenProfile: () => {},
    }, {});
    await menuMock.menus[0].items[2].click();
    assert.deepEqual(f.renamed, [[f.source, 'Series/Library/改名分类/子目录/Entry.md']]);
});

test('missing sources and on-disk name collisions never report a successful move', async () => {
    for (const failure of ['missing', 'indexed-conflict', 'unindexed-conflict']) {
        const f = entryMenuFixture();
        const move = getLibraryEntryMove(f.source, f.project.codexFolder, 'Series/Library');
        if (failure === 'missing') f.files.delete(f.source);
        if (failure === 'indexed-conflict') f.files.set(move.destination, new menuMock.TFile(move.destination));
        if (failure === 'unindexed-conflict') f.unindexed.add(move.destination);
        await assert.rejects(moveLibraryEntry(f.plugin, f.source, f.project.filePath, move));
        assert.deepEqual(f.renamed, []);
        assert.deepEqual(f.created, []);
    }
});

test('project switches during asynchronous move preflight cancel the move', async () => {
    const f = entryMenuFixture();
    const move = getLibraryEntryMove(f.source, f.project.codexFolder, 'Series/Library');
    f.plugin.app.vault.adapter.exists = async () => {
        f.plugin.sceneManager.activeProject = { ...f.project, filePath: 'Series/Other/Other.md' };
        return false;
    };
    await assert.rejects(moveLibraryEntry(f.plugin, f.source, f.project.filePath, move), /project changed/);
    assert.deepEqual(f.renamed, []);
    assert.deepEqual(f.created, []);
});

test('legacy Codex shared roots get the same move action without creating a new category', async () => {
    const f = entryMenuFixture();
    f.files.delete('Series/Library');
    f.files.delete(f.source);
    f.files.set('Series/Codex', {});
    const source = f.source.replace('Series/Library/', 'Series/Codex/');
    f.file.path = source;
    f.files.set(source, f.file);
    showLibraryEntryContextMenu(f.plugin, {
        filePath: source, name: 'Entry', projectFile: f.project.filePath, onOpenProfile: () => {},
    }, {});
    await menuMock.menus[0].items[2].click();
    await menuMock.confirmations[0].onConfirm();
    assert.deepEqual(f.renamed, [[source, `${f.project.codexFolder}/改名分类/子目录/Entry.md`]]);
});

test('a delayed confirmation cannot move a shared entry into a newly selected project', async () => {
    const f = entryMenuFixture();
    showLibraryEntryContextMenu(f.plugin, {
        filePath: f.source, name: 'Entry', projectFile: f.project.filePath, onOpenProfile: () => {},
    }, {});
    await menuMock.menus[0].items[2].click();
    f.plugin.sceneManager.activeProject = { ...f.project, filePath: 'Series/Other/Other.md' };
    await menuMock.confirmations[0].onConfirm();
    assert.deepEqual(f.renamed, []);
    assert.match(menuMock.notices[0], /project changed/);
});

test('all profile entry types use the shared menu and retired membership actions stay removed', async () => {
    for (const name of ['CharacterView', 'LocationView', 'CodexView']) {
        const text = await fs.readFile(path.join(root, `views/${name}.ts`), 'utf8');
        assert.match(text, /showLibraryEntryContextMenu\(this\.plugin/);
        assert.match(text, /projectFile: this\.getBoundProjectFile\(\)/);
        assert.doesNotMatch(text, /setCharacterBooks|setItemBooks|Keep in current project only|Promote to series \(shared\)/);
    }
});
