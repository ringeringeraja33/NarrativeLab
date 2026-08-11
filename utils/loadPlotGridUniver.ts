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

function candidatePaths(plugin: Plugin): string[] {
    // eslint-disable-next-line @typescript-eslint/no-require-imports, @typescript-eslint/no-var-requires
    const pathMod = require('path') as typeof import('path');
    const paths: string[] = [];
    const manifestDir = (plugin.manifest as { dir?: string }).dir;

    // Prefer adapter basePath + vault-relative plugin dir (most reliable in Electron).
    try {
        const adapter = plugin.app.vault.adapter as { getBasePath?: () => string; basePath?: string };
        const base = typeof adapter.getBasePath === 'function'
            ? adapter.getBasePath()
            : (typeof adapter.basePath === 'string' ? adapter.basePath : '');
        if (base && manifestDir) {
            paths.push(pathMod.join(base, manifestDir, 'plotgrid-univer.js'));
        }
    } catch { /* ignore */ }

    // Absolute plugin dir (some Obsidian builds expose an absolute manifest.dir).
    if (manifestDir) {
        paths.push(pathMod.join(manifestDir, 'plotgrid-univer.js'));
        if (pathMod.isAbsolute(manifestDir)) {
            paths.push(pathMod.join(manifestDir, 'plotgrid-univer.js'));
        }
    }

    // Deduplicate while preserving order
    return [...new Set(paths.filter(Boolean))];
}

export async function loadPlotGridUniverModule(plugin: Plugin): Promise<UniverModule> {
    if (cached) return cached;

    const candidates = candidatePaths(plugin);
    if (!candidates.length) {
        throw new Error('Plugin directory unknown — cannot load plotgrid-univer.js');
    }

    // eslint-disable-next-line @typescript-eslint/no-require-imports, @typescript-eslint/no-var-requires
    const req = require as NodeRequire & { cache?: Record<string, unknown> };
    // eslint-disable-next-line @typescript-eslint/no-require-imports, @typescript-eslint/no-var-requires
    const fs = require('fs') as typeof import('fs');

    let lastError: unknown;
    for (const fullPath of candidates) {
        try {
            if (!fs.existsSync(fullPath)) continue;
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
            lastError = e;
            console.warn('[NarrativeLab] plotgrid-univer.js candidate failed:', fullPath, e);
        }
    }

    console.error('[NarrativeLab] Failed to load plotgrid-univer.js from', candidates, lastError);
    throw lastError instanceof Error
        ? lastError
        : new Error('Failed to load plotgrid-univer.js');
}

export function clearPlotGridUniverModuleCache(): void {
    cached = null;
}
