import { t } from './i18n';
import type { StoryGraphRelationCategory } from '../components/StoryGraph';

/** Wikilink edge types for research / literature-review graphs. */
export const ACADEMIC_STORY_GRAPH_LINK_CATEGORY_IDS = ['cites', 'supports', 'refutes'] as const;

export function academicStoryGraphLinkCategories(): StoryGraphRelationCategory[] {
    return [
        { id: 'cites', label: t('Cites'), color: '#3878BC', arrow: 'single' },
        { id: 'supports', label: t('Supports'), color: '#2E7D32', arrow: 'single' },
        { id: 'refutes', label: t('Refutes'), color: '#C62828', arrow: 'single' },
    ];
}

/** Put cite / support / refute first; keep any user-defined categories after. */
export function mergeAcademicStoryGraphLinkCategories(
    saved: readonly StoryGraphRelationCategory[],
): StoryGraphRelationCategory[] {
    const seen = new Set(saved.map(category => category.id));
    return [
        ...academicStoryGraphLinkCategories().filter(category => !seen.has(category.id)),
        ...saved,
    ];
}
