import { Platform, type App } from 'obsidian';

export type MarkdownInputAction =
    | 'bold'
    | 'italic'
    | 'strikethrough'
    | 'highlight'
    | 'inline-code'
    | 'wikilink'
    | 'blockquote'
    | 'bullet-list'
    | 'numbered-list'
    | 'task-list'
    | 'heading-1'
    | 'heading-2'
    | 'heading-3';

type ObsidianHotkey = { key?: string; modifiers?: string[] };

const COMMAND_ACTIONS: Array<[string[], MarkdownInputAction]> = [
    [['editor:toggle-bold'], 'bold'],
    [['editor:toggle-italics', 'editor:toggle-italic'], 'italic'],
    [['editor:toggle-strikethrough'], 'strikethrough'],
    [['editor:toggle-highlight'], 'highlight'],
    [['editor:toggle-code'], 'inline-code'],
    [['editor:insert-link', 'editor:insert-wikilink'], 'wikilink'],
    [['editor:toggle-blockquote'], 'blockquote'],
    [['editor:toggle-bullet-list'], 'bullet-list'],
    [['editor:toggle-numbered-list'], 'numbered-list'],
    [['editor:toggle-checklist-status', 'editor:toggle-task-list'], 'task-list'],
    [['editor:set-heading-1'], 'heading-1'],
    [['editor:set-heading-2'], 'heading-2'],
    [['editor:set-heading-3'], 'heading-3'],
];

function eventKey(event: KeyboardEvent): string {
    if (event.key === ' ') return 'Space';
    return event.key.length === 1 ? event.key.toUpperCase() : event.key;
}

function hotkeyMatches(event: KeyboardEvent, hotkey: ObsidianHotkey): boolean {
    const modifiers = new Set(hotkey.modifiers || []);
    const mod = Platform.isMacOS ? event.metaKey : event.ctrlKey;
    const wantsMod = modifiers.has('Mod');
    const wantsCtrl = modifiers.has('Ctrl');
    const wantsMeta = modifiers.has('Meta');
    if (wantsMod !== mod) return false;
    // `Mod` already represents Cmd on macOS and Ctrl elsewhere. Do not reject
    // that physical key merely because the hotkey omits the platform-specific
    // `Meta` / `Ctrl` modifier name.
    if (!wantsMod && wantsCtrl !== event.ctrlKey) return false;
    if (!wantsMod && wantsMeta !== event.metaKey) return false;
    if (modifiers.has('Alt') !== event.altKey) return false;
    if (modifiers.has('Shift') !== event.shiftKey) return false;
    return String(hotkey.key || '').toUpperCase() === eventKey(event).toUpperCase();
}

/** Resolve the user's current Obsidian hotkeys for Markdown editor commands. */
export function matchObsidianMarkdownShortcut(app: App, event: KeyboardEvent): MarkdownInputAction | null {
    const manager = (app as unknown as {
        hotkeyManager?: {
            getHotkeys?: (commandId: string) => ObsidianHotkey[] | null;
            customKeys?: Record<string, ObsidianHotkey[]>;
            defaultKeys?: Record<string, ObsidianHotkey[]>;
        };
    }).hotkeyManager;
    for (const [ids, action] of COMMAND_ACTIONS) {
        for (const id of ids) {
            const configured = manager?.getHotkeys?.(id)
                || manager?.customKeys?.[id]
                || manager?.defaultKeys?.[id]
                || [];
            if (configured.some(hotkey => hotkeyMatches(event, hotkey))) return action;
        }
    }
    // Obsidian's standard bindings remain available if an internal hotkey API
    // changes between desktop releases.
    const mod = Platform.isMacOS ? event.metaKey : event.ctrlKey;
    if (mod && !event.altKey && !event.shiftKey && event.key.toLowerCase() === 'b') return 'bold';
    if (mod && !event.altKey && !event.shiftKey && event.key.toLowerCase() === 'i') return 'italic';
    if (mod && !event.altKey && !event.shiftKey && event.key.toLowerCase() === 'k') return 'wikilink';
    return null;
}

function replaceSelection(textarea: HTMLTextAreaElement, text: string, start: number, end: number): void {
    textarea.setRangeText(text, start, end, 'end');
    textarea.dispatchEvent(new Event('input', { bubbles: true }));
}

function wrapSelection(textarea: HTMLTextAreaElement, prefix: string, suffix = prefix): void {
    const start = textarea.selectionStart ?? textarea.value.length;
    const end = textarea.selectionEnd ?? start;
    const selected = textarea.value.slice(start, end);
    if (selected.startsWith(prefix) && selected.endsWith(suffix) && selected.length >= prefix.length + suffix.length) {
        replaceSelection(textarea, selected.slice(prefix.length, selected.length - suffix.length), start, end);
        textarea.setSelectionRange(start, Math.max(start, end - prefix.length - suffix.length));
        return;
    }
    replaceSelection(textarea, `${prefix}${selected}${suffix}`, start, end);
    textarea.setSelectionRange(start + prefix.length, start + prefix.length + selected.length);
}

function prefixLines(textarea: HTMLTextAreaElement, prefix: string, matcher?: RegExp): void {
    const selectionStart = textarea.selectionStart ?? 0;
    const selectionEnd = textarea.selectionEnd ?? selectionStart;
    const lineStart = textarea.value.lastIndexOf('\n', Math.max(0, selectionStart - 1)) + 1;
    const nextBreak = textarea.value.indexOf('\n', selectionEnd);
    const lineEnd = nextBreak < 0 ? textarea.value.length : nextBreak;
    const block = textarea.value.slice(lineStart, lineEnd);
    const lines = block.split('\n');
    const remove = matcher ? lines.every(line => matcher.test(line)) : lines.every(line => line.startsWith(prefix));
    const next = lines.map((line, index) => {
        if (remove) return matcher ? line.replace(matcher, '') : line.slice(prefix.length);
        if (matcher) return `${index + 1}. ${line.replace(matcher, '')}`;
        return `${prefix}${line}`;
    }).join('\n');
    replaceSelection(textarea, next, lineStart, lineEnd);
    textarea.setSelectionRange(lineStart, lineStart + next.length);
}

export function applyMarkdownInputAction(textarea: HTMLTextAreaElement, action: MarkdownInputAction): void {
    if (action === 'bold') wrapSelection(textarea, '**');
    else if (action === 'italic') wrapSelection(textarea, '*');
    else if (action === 'strikethrough') wrapSelection(textarea, '~~');
    else if (action === 'highlight') wrapSelection(textarea, '==');
    else if (action === 'inline-code') wrapSelection(textarea, '`');
    else if (action === 'wikilink') wrapSelection(textarea, '[[', ']]');
    else if (action === 'blockquote') prefixLines(textarea, '> ');
    else if (action === 'bullet-list') prefixLines(textarea, '- ');
    else if (action === 'numbered-list') prefixLines(textarea, '1. ', /^\d+\.\s/);
    else if (action === 'task-list') prefixLines(textarea, '- [ ] ', /^- \[[ xX]\]\s/);
    else if (action.startsWith('heading-')) {
        const level = Number(action.slice(-1));
        prefixLines(textarea, `${'#'.repeat(level)} `, /^#{1,6}\s/);
    }
    textarea.focus();
}

export function installObsidianMarkdownShortcuts(app: App, textarea: HTMLTextAreaElement): () => void {
    const handler = (event: KeyboardEvent): void => {
        const action = matchObsidianMarkdownShortcut(app, event);
        if (!action) return;
        event.preventDefault();
        event.stopPropagation();
        applyMarkdownInputAction(textarea, action);
    };
    textarea.addEventListener('keydown', handler);
    return () => textarea.removeEventListener('keydown', handler);
}
