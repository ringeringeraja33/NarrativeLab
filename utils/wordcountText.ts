/**
 * Strip comments and markup so word/character counts follow readable prose,
 * not Markdown / HTML / Obsidian syntax.
 */

export interface WordcountPrepareOptions {
    /** Drop `%%…%%` and `<!-- … -->` comment bodies. Default true. */
    excludeComments?: boolean;
    /** Drop Markdown task lines (`- [ ]`, `- [x]`). Default false. */
    excludeChecklists?: boolean;
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
