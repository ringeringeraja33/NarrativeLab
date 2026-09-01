import {
    LogLevel,
    Univer,
    type IUniverConfig,
    type Plugin,
    type PluginCtor,
} from '@univerjs/core';
import { FUniver } from '@univerjs/core/lib/facade';

type NarrativePluginConstructor = PluginCtor<Plugin>;

interface UniverPreset {
    plugins: unknown[];
}

type CreateUniverOptions = Omit<Partial<IUniverConfig>, 'locales'> & {
    locales?: Record<string, unknown>;
    presets: unknown[];
    plugins?: unknown[];
};

function isUnknownArray(value: unknown): value is unknown[] {
    return Array.isArray(value);
}

function readPreset(entry: unknown): UniverPreset {
    const candidate: unknown = isUnknownArray(entry) ? entry[0] : entry;
    if (!candidate || typeof candidate !== 'object') {
        throw new TypeError('Invalid Univer preset.');
    }
    const plugins = (candidate as Record<string, unknown>).plugins;
    if (!isUnknownArray(plugins)) throw new TypeError('Invalid Univer preset.');
    return { plugins };
}

function readPluginEntry(entry: unknown): [NarrativePluginConstructor, unknown] {
    const rawPlugin: unknown = isUnknownArray(entry) ? entry[0] : entry;
    const pluginOptions: unknown = isUnknownArray(entry) ? entry[1] : undefined;
    if (typeof rawPlugin !== 'function') {
        throw new TypeError('Invalid Univer plugin.');
    }
    const plugin = rawPlugin as NarrativePluginConstructor;
    if (typeof plugin.pluginName !== 'string') throw new TypeError('Invalid Univer plugin.');
    return [plugin, pluginOptions];
}

/**
 * Register only the presets used by NarrativeLab. Importing the aggregate
 * `@univerjs/presets` package installs every document, collaboration and Pro
 * preset even though the plot grid does not use them.
 */
export function createUniver(options: CreateUniverOptions): {
    univer: Univer;
    univerAPI: FUniver;
} {
    const { presets, plugins, ...config } = options;
    const univer = new Univer({ logLevel: LogLevel.WARN, ...config } as Partial<IUniverConfig>);
    const registered = new Map<string, { plugin: NarrativePluginConstructor; options?: unknown }>();

    for (const presetEntry of presets) {
        const preset = readPreset(presetEntry);
        for (const pluginEntry of preset.plugins) {
            const [plugin, pluginOptions] = readPluginEntry(pluginEntry);
            // Later presets deliberately replace an earlier registration.
            registered.delete(plugin.pluginName);
            registered.set(plugin.pluginName, { plugin, options: pluginOptions });
        }
    }

    for (const pluginEntry of plugins ?? []) {
        const [plugin, pluginOptions] = readPluginEntry(pluginEntry);
        if (registered.has(plugin.pluginName)) {
            throw new Error(`Plugin ${plugin.pluginName} is registered more than once.`);
        }
        registered.set(plugin.pluginName, { plugin, options: pluginOptions });
    }

    for (const { plugin, options: pluginOptions } of registered.values()) {
        univer.registerPlugin(plugin, pluginOptions);
    }

    return { univer, univerAPI: FUniver.newAPI(univer) };
}
