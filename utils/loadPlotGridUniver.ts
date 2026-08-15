/**
 * Resolve the Univer Plot Grid host from the community-safe main bundle.
 *
 * Obsidian community installs download only main.js, manifest.json, and
 * styles.css. Keeping the host in main.js therefore avoids an undeclared
 * runtime chunk and also removes the previous Electron-only require path.
 */
import type { Plugin } from 'obsidian';
import { createPlotGridUniverHost, warmupPlotGridUniver } from '../services/PlotGridUniverHost';
import type {
    PlotGridUniverContextAction,
    PlotGridUniverHost,
    PlotGridUniverHostOptions,
} from '../services/PlotGridUniverHost';

export type { PlotGridUniverContextAction, PlotGridUniverHost, PlotGridUniverHostOptions };
export { warmupPlotGridUniver };

type UniverModule = {
    createPlotGridUniverHost: (opts: PlotGridUniverHostOptions) => PlotGridUniverHost;
};

const integratedModule: UniverModule = { createPlotGridUniverHost };

export async function loadPlotGridUniverModule(_plugin: Plugin): Promise<UniverModule> {
    return integratedModule;
}
