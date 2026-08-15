import type { App, WorkspaceLeaf } from 'obsidian';
import { Notice } from 'obsidian';
import { t } from './i18n';

export {
    buildProjectFileGraphQuery,
    buildProjectGraphQuery,
    quoteGraphSearchTerm,
} from './obsidianGraphQuery';

type GraphEngineLike = {
    getOptions?: () => Record<string, unknown>;
    setOptions?: (opts: Record<string, unknown>) => void;
    filterOptions?: { search?: string };
    updateSearch?: () => void;
    render?: () => void;
};

type GraphViewLike = {
    dataEngine?: GraphEngineLike;
    engine?: GraphEngineLike;
    containerEl: HTMLElement;
};

export interface OpenNativeGraphOptions {
    /** Focus the graph leaf. Default true. */
    reveal?: boolean;
    /** Open a split Graph tab when none exists. Default follows `reveal`. */
    splitIfMissing?: boolean;
}

/**
 * Open or reuse the core Graph view and write `query` into its search filter.
 * Relies on undocumented engine / DOM hooks; fails soft if Graph is disabled.
 */
export async function openNativeGraphWithQuery(
    app: App,
    query: string,
    options: OpenNativeGraphOptions = {},
): Promise<boolean> {
    const reveal = options.reveal !== false;
    const splitIfMissing = options.splitIfMissing ?? reveal;

    if (!isGraphPluginEnabled(app)) {
        if (reveal) new Notice(t('Graph view is disabled'));
        return false;
    }

    let leaf = findGraphLeaf(app);
    if (!leaf) {
        if (!splitIfMissing) return false;
        try {
            leaf = app.workspace.getLeaf('split');
            await leaf.setViewState({ type: 'graph', active: reveal });
        } catch (error) {
            console.error('[NarrativeLab] Failed to open Graph view', error);
            if (reveal) new Notice(t('Could not open Graph view'));
            return false;
        }
    } else if (reveal) {
        await app.workspace.revealLeaf(leaf);
    }

    await waitForGraphReady(leaf);
    if (applyGraphSearch(leaf, query)) return true;
    await delay(80);
    return applyGraphSearch(leaf, query);
}

function isGraphPluginEnabled(app: App): boolean {
    const internals = (app as App & {
        internalPlugins?: {
            getEnabledPluginById?: (id: string) => unknown;
            plugins?: Record<string, { enabled?: boolean }>;
        };
    }).internalPlugins;
    if (typeof internals?.getEnabledPluginById === 'function') {
        return Boolean(internals.getEnabledPluginById('graph'));
    }
    const plugin = internals?.plugins?.graph;
    if (plugin && typeof plugin.enabled === 'boolean') return plugin.enabled;
    return true;
}

function findGraphLeaf(app: App): WorkspaceLeaf | undefined {
    return app.workspace.getLeavesOfType('graph')[0];
}

async function waitForGraphReady(leaf: WorkspaceLeaf): Promise<void> {
    for (let i = 0; i < 12; i++) {
        if (graphEngine(leaf) || findFilterInput(leaf)) return;
        await delay(40);
    }
}

function graphEngine(leaf: WorkspaceLeaf): GraphEngineLike | null {
    const view = leaf.view as GraphViewLike;
    return view.dataEngine || view.engine || null;
}

function applyGraphSearch(leaf: WorkspaceLeaf, query: string): boolean {
    const engine = graphEngine(leaf);
    if (engine?.setOptions) {
        const current = typeof engine.getOptions === 'function' ? engine.getOptions() : {};
        engine.setOptions({ ...current, search: query });
        return true;
    }
    if (engine?.filterOptions) {
        engine.filterOptions.search = query;
        engine.updateSearch?.();
        engine.render?.();
        return true;
    }
    const input = findFilterInput(leaf);
    if (!input) return false;
    setNativeInputValue(input, query);
    return true;
}

function findFilterInput(leaf: WorkspaceLeaf): HTMLInputElement | null {
    const root = leaf.view.containerEl;
    const selectors = [
        '.graph-controls .mod-filter input[type="search"]',
        '.graph-controls input[type="search"]',
    ];
    for (const sel of selectors) {
        const el = root.querySelector(sel);
        if (el instanceof HTMLInputElement) return el;
    }
    return null;
}

function setNativeInputValue(input: HTMLInputElement, value: string): void {
    const desc = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value');
    if (desc?.set) desc.set.call(input, value);
    else input.value = value;
    input.dispatchEvent(new Event('input', { bubbles: true }));
}

function delay(ms: number): Promise<void> {
    return new Promise(resolve => window.setTimeout(resolve, ms));
}
