import { WritingTracker, type WritingTrackerData } from './WritingTracker';
import { countWordRevisionChurn, type WordcountPrepareOptions } from '../utils/wordcountText';

export interface FolderScopeConfig {
    id: string;
    path: string;
    recursive: boolean;
    locale: string;
    tracker: WritingTrackerData;
    totalWords?: number;
    sprintInventoryTotal?: number;
}

export function folderContainsMarkdown(root: string, path: string, recursive: boolean): boolean {
    const prefix = root === '/' || !root ? '' : root.replace(/\/$/, '') + '/';
    if (!path.startsWith(prefix) || !path.toLowerCase().endsWith('.md')) return false;
    const relative = path.slice(prefix.length);
    return !!relative && !relative.split('/').some(part => part.startsWith('.'))
        && (recursive || !relative.includes('/'));
}

export function folderWritingBody(text: string): string {
    return text.replace(/^\uFEFF/, '').replace(/^---\s*\r?\n[\s\S]*?\r?\n(?:---|\.\.\.)[ \t]*(?:\r?\n|$)/, '');
}

/** Same metrics as a project, but an independent ledger and file baseline. */
export class FolderWritingScope {
    readonly tracker = new WritingTracker();
    readonly texts = new Map<string, string>();
    private counts = new Map<string, number>();
    totalWords = 0;
    constructor(readonly config: FolderScopeConfig, private options: WordcountPrepareOptions = {}) {
        this.tracker.importData(config.tracker);
        // Finalize an interrupted sprint at the last saved inventory, before
        // scanning offline changes. Its log survives; a fresh session starts.
        if (config.tracker.activeSprint) this.tracker.stopSprint(config.sprintInventoryTotal ?? config.totalWords ?? config.tracker.activeSprint.baselineWords);
    }
    accepts(path: string): boolean { return folderContainsMarkdown(this.config.path, path, this.config.recursive); }
    setText(path: string, raw: string, authored: boolean, now = Date.now()): void {
        if (!this.accepts(path)) return;
        const text = folderWritingBody(raw);
        const previous = this.texts.get(path);
        if (text === previous) return;
        // Auto detection in the shared locale helper needs a long sample.
        // Short Chinese drafts must use the same tokenizer as longer ones.
        const locale = this.config.locale === 'auto' && /[\u3400-\u9fff]/.test(text) ? 'zh' : this.config.locale;
        const count = countWordRevisionChurn('', text, locale, this.options);
        const delta = count - (this.counts.get(path) ?? 0);
        this.totalWords += delta;
        this.counts.set(path, count);
        this.texts.set(path, text);
        if (authored && previous !== undefined) {
            this.tracker.recordRevisionWords(countWordRevisionChurn(previous, text, locale, this.options), now);
            this.tracker.flushSession(this.totalWords, now);
        } else this.tracker.rebaseInventory(delta);
    }
    remove(path: string): void {
        const count = this.counts.get(path) ?? 0;
        this.totalWords -= count;
        this.tracker.rebaseInventory(-count);
        this.texts.delete(path); this.counts.delete(path);
    }
    snapshot(): FolderScopeConfig {
        const tracker = this.tracker.exportData();
        // Imported inventory can move the logical baseline below zero. Persist
        // an equivalent nonnegative coordinate for the shared sprint loader.
        const offset = Math.max(0, -(tracker.activeSprint?.baselineWords ?? 0));
        if (tracker.activeSprint) tracker.activeSprint.baselineWords += offset;
        return { ...this.config, totalWords:this.totalWords, sprintInventoryTotal:this.totalWords + offset, tracker };
    }
}
