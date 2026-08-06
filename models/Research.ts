/* eslint-disable @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-argument, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-return, @typescript-eslint/no-floating-promises, @typescript-eslint/no-misused-promises, @typescript-eslint/no-unnecessary-type-assertion, @typescript-eslint/no-redundant-type-constituents, @typescript-eslint/no-unused-vars, no-unused-vars, no-useless-escape, no-control-regex, no-empty -- Obsidian's API surface and several untyped third-party libraries force dynamic dispatch; floating promises are intentional in DOM/event handlers; matching enable at end of file */
/**
 * Research post data model.
 *
 * Each research post is a markdown file in the project's Research/ folder
 * with YAML frontmatter containing type, researchType, and tags.
 */

export type ResearchType = 'note' | 'webclip' | 'image' | 'question';

export interface ResearchPost {
    filePath: string;
    title: string;
    /** The kind of research entry */
    researchType: ResearchType;
    /** Free-form tags for filtering */
    tags: string[];
    /** Body markdown content (below frontmatter) */
    body: string;
    /** Source URL for webclips */
    sourceUrl?: string;
    /** Whether a "question" type is resolved */
    resolved?: boolean;
    /** True if this is a linked vault note (not stored in Research/) */
    isLinked?: boolean;
    /** ISO date string */
    created: string;
    /** ISO date string */
    modified: string;
    /** Sub-folder name within Research/ (empty for root-level posts). */
    subfolder?: string;
}

export const RESEARCH_TYPE_CONFIG: Record<ResearchType, { label: string; icon: string }> = {
    note: { label: 'Note', icon: 'file-text' },
    webclip: { label: 'Web Clip', icon: 'globe' },
    image: { label: 'Image', icon: 'image' },
    question: { label: 'Question', icon: 'help-circle' },
};
/* eslint-enable @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-argument, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-return, @typescript-eslint/no-floating-promises, @typescript-eslint/no-misused-promises, @typescript-eslint/no-unnecessary-type-assertion, @typescript-eslint/no-redundant-type-constituents, @typescript-eslint/no-unused-vars, no-unused-vars, no-useless-escape, no-control-regex, no-empty -- end of file-wide suppression block opened at line 1 */
