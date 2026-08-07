import {
    Component,
    MarkdownRenderer,
    TFile,
    normalizePath,
    parseYaml,
    stringifyYaml,
} from 'obsidian';
import type SceneCardsPlugin from '../main';

const activeEmbeds = new WeakMap<Component, Component>();

function getCategoryFolder(plugin: SceneCardsPlugin, categoryId: string): string | null {
    if (!plugin.sceneManager.activeProject) return null;
    if (categoryId === 'uncategorized') {
        return normalizePath(plugin.sceneManager.getCodexFolder());
    }
    if (categoryId === 'characters') {
        return normalizePath(plugin.sceneManager.getCharacterFolder());
    }
    if (categoryId === 'locations') {
        return normalizePath(plugin.sceneManager.getLocationFolder());
    }
    const folderName = plugin.sceneManager.getLibraryFolderName(categoryId);
    return normalizePath(`${plugin.sceneManager.getCodexFolder()}/${folderName}`);
}

function collectNoteProperties(plugin: SceneCardsPlugin, folderPath: string, recursive: boolean): string[] {
    const keys = new Set<string>();
    for (const file of plugin.app.vault.getMarkdownFiles()) {
        const parentPath = normalizePath(file.parent?.path || '');
        const inScope = recursive
            ? parentPath === folderPath || parentPath.startsWith(`${folderPath}/`)
            : parentPath === folderPath;
        if (!inScope) continue;
        const frontmatter = plugin.app.metadataCache.getFileCache(file)?.frontmatter;
        if (!frontmatter) continue;
        for (const key of Object.keys(frontmatter)) {
            if (key !== 'position') keys.add(key);
        }
    }
    return Array.from(keys).sort((left, right) => left.localeCompare(right));
}

async function ensureNativeBase(
    plugin: SceneCardsPlugin,
    categoryId: string,
): Promise<{ basePath: string; folderPath: string } | null> {
    const folderPath = getCategoryFolder(plugin, categoryId);
    if (!folderPath) return null;
    if (!plugin.app.vault.getAbstractFileByPath(folderPath)) {
        await plugin.app.vault.createFolder(folderPath);
    }

    const basePath = normalizePath(`${folderPath}/_NarrativeLab.base`);
    const recursive = categoryId !== 'uncategorized';
    const scopeFilter = recursive
        ? `file.inFolder(${JSON.stringify(folderPath)})`
        : `file.folder == ${JSON.stringify(folderPath)}`;
    const requiredFilters = [scopeFilter, 'file.ext == "md"'];
    const existing = plugin.app.vault.getAbstractFileByPath(basePath);

    if (existing instanceof TFile) {
        const source = await plugin.app.vault.read(existing);
        let config: Record<string, unknown>;
        try {
            const parsed = parseYaml(source);
            config = parsed && typeof parsed === 'object'
                ? parsed as Record<string, unknown>
                : {};
        } catch {
            config = {};
        }
        config.filters = { and: requiredFilters };
        if (!Array.isArray(config.views) || config.views.length === 0) {
            config.views = [{
                type: 'table',
                name: 'Table',
                order: [
                    'file.name',
                    ...collectNoteProperties(plugin, folderPath, recursive).map(key => `note.${key}`),
                ],
            }];
        }
        const next = stringifyYaml(config);
        if (next.trim() !== source.trim()) {
            await plugin.app.vault.modify(existing, next);
        }
        return { basePath, folderPath };
    }

    const config = {
        filters: { and: requiredFilters },
        views: [{
            type: 'table',
            name: 'Table',
            order: [
                'file.name',
                ...collectNoteProperties(plugin, folderPath, recursive).map(key => `note.${key}`),
            ],
        }],
    };
    await plugin.app.vault.create(basePath, stringifyYaml(config));
    return { basePath, folderPath };
}

/**
 * Render an actual Obsidian Bases embed. Column drag/drop, property controls,
 * formulas, filters, grouping, summaries, and editing are provided by core.
 */
export async function renderNativeLibraryBase(
    container: HTMLElement,
    plugin: SceneCardsPlugin,
    categoryId: string,
    owner: Component,
): Promise<void> {
    const previous = activeEmbeds.get(owner);
    if (previous) {
        previous.unload();
    }

    container.empty();
    const host = container.createDiv('library-native-base-embed markdown-rendered');
    const loading = host.createDiv({ cls: 'library-native-base-loading', text: 'Loading Base…' });
    const resolved = await ensureNativeBase(plugin, categoryId);
    if (!resolved) {
        loading.setText('No active project');
        return;
    }

    loading.remove();
    const child = new Component();
    child.load();
    owner.register(() => child.unload());
    activeEmbeds.set(owner, child);
    const linkPath = resolved.basePath.replace(/\]/g, '\\]');
    await MarkdownRenderer.render(
        plugin.app,
        `![[${linkPath}]]`,
        host,
        resolved.basePath,
        child,
    );
}
