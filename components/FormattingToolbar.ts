/* eslint-disable @typescript-eslint/no-unsafe-call -- Obsidian's API surface and several untyped third-party libraries force dynamic dispatch; floating promises are intentional in DOM/event handlers; matching enable at end of file */
import { setIcon } from 'obsidian';
import { EditorView } from '@codemirror/view';
import { undo, redo } from '@codemirror/commands';
import { t } from '../utils/i18n';

/**
 * Shared formatting toolbar used in both ManuscriptView (embedded editors)
 * and standalone scene editors (injected when Editing Toolbar is absent).
 *
 * Call `buildFormattingToolbar(el, cmProvider)` to populate a container
 * with icon buttons. `cmProvider` is a callback that returns the
 * currently active CM6 EditorView (or null).
 */

export function buildFormattingToolbar(
    el: HTMLElement,
    cmProvider: () => EditorView | null,
): void {
    const getCm = cmProvider;

    const btn = (icon: string, title: string, action: () => void): HTMLElement => {
        const b = el.createDiv({ cls: 'sl-fmt-btn', attr: { 'aria-label': title, title } });
        setIcon(b, icon);
        b.addEventListener('mousedown', (e) => {
            e.preventDefault();
            action();
        });
        return b;
    };

    const sep = () => el.createDiv('sl-fmt-sep');

    // ── Undo / Redo ──
    btn('undo-2', 'Undo', () => { const cm = getCm(); if (cm) undo(cm); });
    btn('redo-2', 'Redo', () => { const cm = getCm(); if (cm) redo(cm); });
    sep();

    // ── Clear formatting ──
    btn('eraser', 'Clear formatting', () => clearFormatting(getCm()));
    sep();

    // ── Headings ──
    btn('heading-2', 'Heading 2', () => setLinePrefix(getCm(), '## '));
    btn('heading-3', 'Heading 3', () => setLinePrefix(getCm(), '### '));

    // Hn dropdown (hover to reveal H1, H4, H5, H6)
    const hWrap = el.createDiv('sl-fmt-submenu');
    const hTrigger = hWrap.createDiv({ cls: 'sl-fmt-btn sl-fmt-text sl-fmt-has-sub', attr: { 'aria-label': t('More headings'), title: t('More headings') } });
    hTrigger.setText('Hn');
    const hPanel = hWrap.createDiv('sl-fmt-subpanel');
    for (const level of [1, 4, 5, 6]) {
        const item = hPanel.createDiv({ cls: 'sl-fmt-btn', attr: { 'aria-label': t('Heading {n}', { n: level }), title: t('Heading {n}', { n: level }) } });
        setIcon(item, `heading-${level}`);
        item.addEventListener('mousedown', (e) => {
            e.preventDefault();
            setLinePrefix(getCm(), '#'.repeat(level) + ' ');
        });
    }
    sep();

    // ── Inline formatting ──
    btn('bold', 'Bold', () => wrapSelection(getCm(), '**', '**'));
    btn('italic', 'Italic', () => wrapSelection(getCm(), '*', '*'));
    btn('strikethrough', 'Strikethrough', () => wrapSelection(getCm(), '~~', '~~'));
    btn('underline', 'Underline', () => wrapSelection(getCm(), '<u>', '</u>'));
    btn('highlighter', 'Highlight', () => wrapSelection(getCm(), '==', '=='));
    sep();

    // ── Lists dropdown ──
    const lWrap = el.createDiv('sl-fmt-submenu');
    const lTrigger = lWrap.createDiv({ cls: 'sl-fmt-btn sl-fmt-has-sub', attr: { 'aria-label': t('Lists'), title: t('Lists') } });
    setIcon(lTrigger, 'list');
    const lPanel = lWrap.createDiv('sl-fmt-subpanel');

    const lCheck = lPanel.createDiv({ cls: 'sl-fmt-btn', attr: { 'aria-label': t('Checklist'), title: t('Checklist') } });
    setIcon(lCheck, 'list-checks');
    lCheck.addEventListener('mousedown', (e) => { e.preventDefault(); toggleLinePrefix(getCm(), '- [ ] '); });

    const lNum = lPanel.createDiv({ cls: 'sl-fmt-btn', attr: { 'aria-label': t('Numbered list'), title: t('Numbered list') } });
    setIcon(lNum, 'list-ordered');
    lNum.addEventListener('mousedown', (e) => { e.preventDefault(); toggleNumberedList(getCm()); });

    const lBullet = lPanel.createDiv({ cls: 'sl-fmt-btn', attr: { 'aria-label': t('Bulleted list'), title: t('Bulleted list') } });
    setIcon(lBullet, 'list');
    lBullet.addEventListener('mousedown', (e) => { e.preventDefault(); toggleLinePrefix(getCm(), '- '); });

    const lOutdent = lPanel.createDiv({ cls: 'sl-fmt-btn', attr: { 'aria-label': t('Outdent'), title: t('Outdent') } });
    setIcon(lOutdent, 'indent-decrease');
    lOutdent.addEventListener('mousedown', (e) => { e.preventDefault(); outdentLines(getCm()); });

    const lIndent = lPanel.createDiv({ cls: 'sl-fmt-btn', attr: { 'aria-label': t('Indent'), title: t('Indent') } });
    setIcon(lIndent, 'indent-increase');
    lIndent.addEventListener('mousedown', (e) => { e.preventDefault(); indentLines(getCm()); });
}

// ── Formatting helpers ─────────────────────────────────

function wrapSelection(cm: EditorView | null, prefix: string, suffix: string): void {
    if (!cm) return;
    const sel = cm.state.selection.main;
    const selected = cm.state.sliceDoc(sel.from, sel.to);
    if (
        selected.length >= prefix.length + suffix.length &&
        selected.startsWith(prefix) &&
        selected.endsWith(suffix)
    ) {
        const inner = selected.slice(prefix.length, selected.length - suffix.length);
        cm.dispatch({ changes: { from: sel.from, to: sel.to, insert: inner } });
    } else {
        cm.dispatch({
            changes: { from: sel.from, to: sel.to, insert: prefix + selected + suffix },
            selection: { anchor: sel.from + prefix.length, head: sel.from + prefix.length + selected.length },
        });
    }
}

function setLinePrefix(cm: EditorView | null, prefix: string): void {
    if (!cm) return;
    const { from, to } = cm.state.selection.main;
    const startLine = cm.state.doc.lineAt(from);
    const endLine = cm.state.doc.lineAt(to);
    const changes: { from: number; to: number; insert: string }[] = [];
    for (let i = startLine.number; i <= endLine.number; i++) {
        const line = cm.state.doc.line(i);
        const stripped = line.text.replace(/^#{1,6}\s*/, '');
        if (prefix && line.text.startsWith(prefix)) {
            changes.push({ from: line.from, to: line.to, insert: stripped });
        } else {
            changes.push({ from: line.from, to: line.to, insert: prefix + stripped });
        }
    }
    cm.dispatch({ changes });
}

function toggleLinePrefix(cm: EditorView | null, prefix: string): void {
    if (!cm) return;
    const { from, to } = cm.state.selection.main;
    const startLine = cm.state.doc.lineAt(from);
    const endLine = cm.state.doc.lineAt(to);
    const changes: { from: number; to: number; insert: string }[] = [];
    for (let i = startLine.number; i <= endLine.number; i++) {
        const line = cm.state.doc.line(i);
        if (line.text.startsWith(prefix)) {
            changes.push({ from: line.from, to: line.from + prefix.length, insert: '' });
        } else {
            changes.push({ from: line.from, to: line.from, insert: prefix });
        }
    }
    cm.dispatch({ changes });
}

function toggleNumberedList(cm: EditorView | null): void {
    if (!cm) return;
    const { from, to } = cm.state.selection.main;
    const startLine = cm.state.doc.lineAt(from);
    const endLine = cm.state.doc.lineAt(to);
    const allNumbered = (() => {
        for (let i = startLine.number; i <= endLine.number; i++) {
            if (!/^\d+\.\s/.test(cm.state.doc.line(i).text)) return false;
        }
        return true;
    })();
    const changes: { from: number; to: number; insert: string }[] = [];
    for (let i = startLine.number; i <= endLine.number; i++) {
        const line = cm.state.doc.line(i);
        if (allNumbered) {
            changes.push({ from: line.from, to: line.to, insert: line.text.replace(/^\d+\.\s/, '') });
        } else {
            const num = i - startLine.number + 1;
            if (/^\d+\.\s/.test(line.text)) {
                changes.push({ from: line.from, to: line.to, insert: `${num}. ${line.text.replace(/^\d+\.\s/, '')}` });
            } else {
                changes.push({ from: line.from, to: line.from, insert: `${num}. ` });
            }
        }
    }
    cm.dispatch({ changes });
}

function clearFormatting(cm: EditorView | null): void {
    if (!cm) return;
    const { from, to } = cm.state.selection.main;
    if (from === to) return;
    let text = cm.state.sliceDoc(from, to);
    text = text.replace(/\*\*\*(.+?)\*\*\*/g, '$1');
    text = text.replace(/\*\*(.+?)\*\*/g, '$1');
    text = text.replace(/\*(.+?)\*/g, '$1');
    text = text.replace(/~~(.+?)~~/g, '$1');
    text = text.replace(/<u>(.+?)<\/u>/gi, '$1');
    text = text.replace(/==(.+?)==/g, '$1');
    text = text.replace(/`(.+?)`/g, '$1');
    text = text.replace(/^#{1,6}\s*/gm, '');
    text = text.replace(/^[-*+]\s/gm, '');
    text = text.replace(/^\d+\.\s/gm, '');
    text = text.replace(/^>\s?/gm, '');
    cm.dispatch({ changes: { from, to, insert: text } });
}

function indentLines(cm: EditorView | null): void {
    if (!cm) return;
    const { from, to } = cm.state.selection.main;
    const startLine = cm.state.doc.lineAt(from);
    const endLine = cm.state.doc.lineAt(to);
    const changes: { from: number; to: number; insert: string }[] = [];
    for (let i = startLine.number; i <= endLine.number; i++) {
        const line = cm.state.doc.line(i);
        changes.push({ from: line.from, to: line.from, insert: '\t' });
    }
    cm.dispatch({ changes });
}

function outdentLines(cm: EditorView | null): void {
    if (!cm) return;
    const { from, to } = cm.state.selection.main;
    const startLine = cm.state.doc.lineAt(from);
    const endLine = cm.state.doc.lineAt(to);
    const changes: { from: number; to: number; insert: string }[] = [];
    for (let i = startLine.number; i <= endLine.number; i++) {
        const line = cm.state.doc.line(i);
        if (line.text.startsWith('\t')) {
            changes.push({ from: line.from, to: line.from + 1, insert: '' });
        } else {
            const m = line.text.match(/^ {1,4}/);
            if (m) changes.push({ from: line.from, to: line.from + m[0].length, insert: '' });
        }
    }
    if (changes.length) cm.dispatch({ changes });
}
/* eslint-enable @typescript-eslint/no-unsafe-call -- end of file-wide suppression block opened at line 1 */
