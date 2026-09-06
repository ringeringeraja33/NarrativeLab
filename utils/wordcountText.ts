/**
 * Strip comments and markup so word/character counts follow readable prose,
 * not Markdown / HTML / Obsidian syntax.
 */

import type { WordCountProfileId } from '../models/ProjectCapabilities';
import {
    DEFAULT_STORYLINE_LOCALE,
    resolveLocale,
    tokenizeWords,
    type StoryLineLocale,
} from './locale';

export interface WordcountPrepareOptions {
    /** Drop `%%…%%` and `<!-- … -->` comment bodies. Default true. */
    excludeComments?: boolean;
    /** Drop Markdown task lines (`- [ ]`, `- [x]`). Default false. */
    excludeChecklists?: boolean;
    /** Drop footnote definition bodies (`[^id]: …`). Default false. */
    excludeFootnotes?: boolean;
    /** Drop citations and a trailing references section. Default false. */
    excludeCitationsAndReferences?: boolean;
}

export function wordcountOptionsForProfile(
    profile: WordCountProfileId | undefined,
    plugin: { excludeComments?: boolean; excludeChecklists?: boolean } = {},
): WordcountPrepareOptions {
    if (profile === 'academic') {
        return {
            excludeComments: true,
            excludeChecklists: true,
            excludeFootnotes: true,
            excludeCitationsAndReferences: true,
        };
    }
    if (profile === 'narrative') {
        return { excludeComments: true, excludeChecklists: true };
    }
    if (profile === 'custom') {
        return {
            excludeComments: plugin.excludeComments !== false,
            excludeChecklists: plugin.excludeChecklists === true,
        };
    }
    return { excludeComments: true, excludeChecklists: false };
}

const REFERENCE_HEADING = /^(?:#{1,6}[ \t]+)?(?:references|bibliography|works cited|endnotes|footnotes|参考文献|引用文献|参考书目|文献目录|尾注|脚注|注释)\s*$/i;

function stripTrailingReferenceSections(text: string): string {
    const lines = text.split('\n');
    for (let i = 0; i < lines.length; i++) {
        if (REFERENCE_HEADING.test(lines[i].trim())) return lines.slice(0, i).join('\n');
    }
    return text;
}

function stripAcademicCitations(text: string): string {
    let s = text;
    s = s.replace(/\[@[^\]]+\]/g, ' ');
    s = s.replace(/\\cite[pt]?\{[^}]+\}/gi, ' ');
    s = s.replace(
        /\(\s*[A-Z][\w'.-]+(?:\s+(?:and|&)\s+[A-Z][\w'.-]+)?(?:\s+et\s+al\.?)?,?\s+(?:19|20)\d{2}[a-z]?(?:\s*[,:;]\s*[^)]{0,40})?\s*\)/g,
        ' ',
    );
    s = s.replace(
        /（\s*[\u4e00-\u9fff]{1,20}(?:[、，,]\s*[\u4e00-\u9fff]{1,20})*\s*[，,、]?\s*(?:19|20)\d{2}[a-z]?(?:[，,、：:]\s*[^）]{0,30})?\s*）/g,
        ' ',
    );
    s = s.replace(
        /\[(\d{1,3}(?:\s*[-–—]\s*\d{1,3})?(?:\s*,\s*\d{1,3}(?:\s*[-–—]\s*\d{1,3})?){0,8})\]/g,
        ' ',
    );
    return s;
}

export function prepareTextForWordcount(
    text: string,
    opts: WordcountPrepareOptions = {},
): string {
    if (!text) return '';
    let s = text.replace(/\r\n/g, '\n');

    if (opts.excludeComments !== false) {
        s = s.replace(/%%[\s\S]*?%%/g, ' ');
        s = s.replace(/<!--[\s\S]*?-->/g, ' ');
    }

    s = s.replace(/^ {0,3}(`{3,}|~{3,})[^\n]*\n[\s\S]*?^ {0,3}\1[ \t]*$/gm, ' ');
    s = s.replace(/^ {0,3}(`{3,}|~{3,})[^\n]*\n[\s\S]*$/gm, ' ');

    s = s.replace(/!\[([^\]]*)\]\([^)]+\)/g, ' ');
    s = s.replace(/\[([^\]]+)\]\([^)]+\)/g, '$1');
    s = s.replace(/\[\[([^\]|#]+)(?:#[^\]|]*)?(?:\|([^\]]+))?\]\]/g, (_all, path: string, alias?: string) => {
        const label = (alias || path || '').trim();
        return label.replace(/\.md$/i, '').split('/').pop() || '';
    });

    s = s.replace(/<\/?[a-zA-Z][^>]*>/g, ' ');
    s = s.replace(/<!\[CDATA\[[\s\S]*?\]\]>/g, ' ');

    if (opts.excludeChecklists === true) {
        s = s.replace(/^[ \t]*[-*+]\s*\[[ xX]\]\s.*$/gm, ' ');
    }

    if (opts.excludeFootnotes === true) {
        s = s.replace(/^\[\^[^\]]+\]:.*(?:\n[ \t]+.*)*$/gm, ' ');
    }
    if (opts.excludeCitationsAndReferences === true) {
        s = stripTrailingReferenceSections(s);
        s = stripAcademicCitations(s);
    }

    s = s.replace(/^ {0,3}#{1,6}[ \t]+/gm, '');
    s = s.replace(/^ {0,3}(=+|-+)[ \t]*$/gm, ' ');
    s = s.replace(/^[ \t]{0,3}>[ \t]?/gm, '');
    s = s.replace(/^[ \t]*[-*+][ \t]+/gm, '');
    s = s.replace(/^[ \t]*\d+\.[ \t]+/gm, '');
    s = s.replace(/\[\^[^\]]+\]:?/g, ' ');
    s = s.replace(/^[ \t]*([-*_])(?:[ \t]*\1){2,}[ \t]*$/gm, ' ');
    s = s.replace(/\|/g, ' ');
    s = s.replace(/[*_~`]+/g, '');

    s = s.replace(/&nbsp;|&#160;/gi, ' ');
    s = s.replace(/&amp;/gi, '&');
    s = s.replace(/&lt;/gi, '<');
    s = s.replace(/&gt;/gi, '>');
    s = s.replace(/&quot;/gi, '"');
    s = s.replace(/&#\d+;/g, ' ');
    s = s.replace(/&[a-z]+;/gi, ' ');

    return s.replace(/\s+/g, ' ').trim();
}

/**
 * Count inserted + deleted readable word tokens between two scene bodies.
 * Token frequencies deliberately ignore pure reordering, while equal-length
 * replacements count as one deletion plus one insertion.
 */
export function countWordRevisionChurn(
    before: string,
    after: string,
    locale: StoryLineLocale = DEFAULT_STORYLINE_LOCALE,
    opts: WordcountPrepareOptions = {},
): number {
    const frequencies = (text: string): Map<string, number> => {
        const cleaned = prepareTextForWordcount(text, opts);
        const counts = new Map<string, number>();
        if (!cleaned) return counts;
        const resolved = resolveLocale(locale, cleaned, DEFAULT_STORYLINE_LOCALE);
        for (const token of tokenizeWords(cleaned, resolved)) {
            counts.set(token, (counts.get(token) || 0) + 1);
        }
        return counts;
    };

    const previous = frequencies(before);
    const current = frequencies(after);
    const tokens = new Set([...previous.keys(), ...current.keys()]);
    let churn = 0;
    for (const token of tokens) {
        churn += Math.abs((previous.get(token) || 0) - (current.get(token) || 0));
    }
    return churn;
}
