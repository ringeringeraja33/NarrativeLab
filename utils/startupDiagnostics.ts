/** In-memory timings only; no vault paths or document contents are collected. */
export class StartupDiagnostics {
    private started = performance.now();
    private entries = new Map<string, { calls: number; totalMs: number; maxMs: number }>();

    start(label: string): () => void {
        const start = performance.now();
        let ended = false;
        return () => {
            if (ended) return;
            ended = true;
            const elapsed = performance.now() - start;
            const entry = this.entries.get(label) ?? { calls: 0, totalMs: 0, maxMs: 0 };
            entry.calls++;
            entry.totalMs += elapsed;
            entry.maxMs = Math.max(entry.maxMs, elapsed);
            this.entries.set(label, entry);
        };
    }

    measure<T>(label: string, work: () => T): T {
        const end = this.start(label);
        try { return work(); } finally { end(); }
    }

    async measureAsync<T>(label: string, work: () => Promise<T>): Promise<T> {
        const end = this.start(label);
        try { return await work(); } finally { end(); }
    }

    snapshot() {
        return {
            elapsedSincePluginConstructedMs: Math.round(performance.now() - this.started),
            note: 'Wall-clock timings overlap; do not add totals. Observer counts cover the current session.',
            phases: [...this.entries].map(([phase, entry]) => ({
                phase, calls: entry.calls,
                totalMs: Math.round(entry.totalMs * 10) / 10,
                maxMs: Math.round(entry.maxMs * 10) / 10,
            })),
        };
    }
}
