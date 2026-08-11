/**
 * Load the separately bundled Univer Plot Grid host from the plugin folder.
 */
import type { Plugin } from 'obsidian';
import type { PlotGridUniverHost, PlotGridUniverHostOptions } from '../services/PlotGridUniverHost';

export type { PlotGridUniverHost, PlotGridUniverHostOptions };

type UniverModule = {
    createPlotGridUniverHost: (opts: PlotGridUniverHostOptions) => PlotGridUniverHost;
};

let cached: UniverModule | null = null;

export async function loadPlotGridUniverModule(plugin: Plugin): Promise<UniverModule> {
    if (cached) return cached;

    // Prefer dynamic import of the sibling chunk (same folder as main.js).
    // Electron/Obsidian resolves relative to the plugin directory for require.
    const dir = (plugin.manifest as { dir?: string }).dir;
    if (!dir) {
        throw new Error('Plugin directory unknown — cannot load plotgrid-univer.js');
    }

    // eslint-disable-next-line @typescript-eslint/no-require-imports, @typescript-eslint/no-var-requires
    const pathMod = require('path') as typeof import('path');
    const fullPath = pathMod.join(dir, 'plotgrid-univer.js');

    try {
        // Clear cache so rebuilds are picked up after plugin reload
        // eslint-disable-next-line @typescript-eslint/no-require-imports, @typescript-eslint/no-var-requires
        const req = require as NodeRequire & { cache?: Record<string, unknown> };
        if (req.cache) {
            delete req.cache[fullPath];
            try {
                // eslint-disable-next-line @typescript-eslint/no-require-imports
                delete req.cache[require.resolve(fullPath)];
            } catch { /* resolve may throw if not yet loaded */ }
        }
        // eslint-disable-next-line @typescript-eslint/no-require-imports, @typescript-eslint/no-var-requires
        const mod = require(fullPath) as UniverModule;
        if (!mod?.createPlotGridUniverHost) {
            throw new Error('plotgrid-univer.js missing createPlotGridUniverHost export');
        }
        cached = mod;
        return mod;
    } catch (e) {
        console.error('[NarrativeLab] Failed to load plotgrid-univer.js from', fullPath, e);
        throw e;
    }
}

export function clearPlotGridUniverModuleCache(): void {
    cached = null;
}
