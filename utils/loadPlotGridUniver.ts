/**
 * Resolve the Univer Plot Grid host from the community-safe main bundle.
 *
 * Obsidian community installs download only main.js, manifest.json, and
 * styles.css. Keeping the host in main.js therefore avoids an undeclared
 * runtime chunk and also removes the previous Electron-only require path.
 */
import type { Plugin } from 'obsidian';
import type {
    PlotGridUniverContextAction,
    PlotGridUniverHost,
    PlotGridUniverHostOptions,
} from '../services/PlotGridUniverHost';

export type { PlotGridUniverContextAction, PlotGridUniverHost, PlotGridUniverHostOptions };

type UniverModule = {
    createPlotGridUniverHost: (opts: PlotGridUniverHostOptions) => PlotGridUniverHost;
};

export async function loadPlotGridUniverModule(_plugin: Plugin): Promise<UniverModule> {
    // esbuild keeps this inside main.js but defers module evaluation until a
    // grid is opened. Static imports here initialize all presets at startup.
    return import('../services/PlotGridUniverHost');
}
