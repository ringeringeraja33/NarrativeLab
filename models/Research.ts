
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
    /** Disabled posts stay on disk but are hidden from normal views and the corkboard. */
    inactive?: boolean;
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
