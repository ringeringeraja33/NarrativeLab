/** Persisted plotline registry entry (System/plotlines.json → definitions). */
export interface PlotlineDefinition {
    /** Stable identifier; matches the scene tag used for membership. */
    id: string;
    /** Display label (defaults to id; kept in sync on rename). */
    label: string;
    /** Navigator reading order within this plotline (membership is via scene tags). */
    scenePaths: string[];
}

export function normalizePlotlineDefinitions(raw: unknown): PlotlineDefinition[] {
    if (!Array.isArray(raw)) return [];
    const out: PlotlineDefinition[] = [];
    const seen = new Set<string>();
    for (const entry of raw) {
        if (!entry || typeof entry !== 'object') continue;
        const obj = entry as Record<string, unknown>;
        const id = typeof obj.id === 'string' ? obj.id.trim() : '';
        if (!id || seen.has(id)) continue;
        seen.add(id);
        const labelRaw = typeof obj.label === 'string' ? obj.label.trim() : '';
        const label = labelRaw || id;
        let scenePaths: string[] = [];
        if (Array.isArray(obj.scenePaths)) {
            scenePaths = obj.scenePaths.map(p => String(p)).filter(Boolean);
        }
        out.push({ id, label, scenePaths });
    }
    return out;
}

export function clonePlotlineDefinitions(defs: PlotlineDefinition[] | undefined | null): PlotlineDefinition[] {
    if (!Array.isArray(defs)) return [];
    return defs.map(d => ({
        id: d.id,
        label: d.label,
        scenePaths: [...d.scenePaths],
    }));
}
