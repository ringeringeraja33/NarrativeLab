import type { ProjectModuleId } from './ProjectCapabilities';
import {
    BOARD_VIEW_TYPE, COLUMN_BOARD_VIEW_TYPE, PLOTGRID_VIEW_TYPE, TIMELINE_VIEW_TYPE,
    TRACK_COMPARISON_VIEW_TYPE, STORYLINE_VIEW_TYPE, SUBWAY_VIEW_TYPE,
    MANUSCRIPT_VIEW_TYPE, CODEX_VIEW_TYPE, NCANVAS_LIBRARY_VIEW_TYPE,
} from '../constants';

export interface ProjectPage {
    module: ProjectModuleId;
    type: string;
    label: string;
    icon: string;
}

export type ProjectTabGroupId = 'manuscript' | 'organize' | 'planning' | 'library' | 'presentation';

export interface ProjectTabGroup {
    id: ProjectTabGroupId;
    label: string;
    icon: string;
    modules: readonly ProjectModuleId[];
}

/** Tab bar folders. Grouping only organizes entries; modules stay independently toggleable. */
export const PROJECT_TAB_GROUPS: readonly ProjectTabGroup[] = [
    { id: 'manuscript', label: 'Manuscript', icon: 'book-open-text', modules: ['manuscript'] },
    { id: 'organize', label: 'Organize', icon: 'layout-dashboard', modules: ['flatCanvas', 'columnBoard', 'table'] },
    { id: 'planning', label: 'Narrative planning', icon: 'git-branch', modules: ['timeline', 'trackComparison', 'plotList', 'subwayMap'] },
    { id: 'library', label: 'Library', icon: 'library-big', modules: ['library'] },
    { id: 'presentation', label: 'Presentation', icon: 'monitor-play', modules: ['canvas'] },
];

export function sortByProjectPageOrder<T extends { type: string }>(
    items: T[],
    order: readonly ProjectModuleId[] | undefined,
): T[] {
    const rank = (type: string) => {
        const id = PROJECT_PAGES.find(page => page.type === type)?.module;
        const index = id && order ? order.indexOf(id) : -1;
        return index < 0 ? (order?.length ?? 0) : index;
    };
    return items.sort((a, b) => rank(a.type) - rank(b.type));
}

/** Keep dragged tabs first, then any previously saved or default pages. */
export function mergeProjectPageOrder(
    previous: readonly ProjectModuleId[] | undefined,
    visual: readonly ProjectModuleId[],
): ProjectModuleId[] {
    const seen = new Set<ProjectModuleId>();
    const merged: ProjectModuleId[] = [];
    for (const id of [...visual, ...(previous ?? []), ...PROJECT_PAGES.map(page => page.module)]) {
        if (seen.has(id)) continue;
        seen.add(id);
        merged.push(id);
    }
    return merged;
}

export function sortTabGroups<T extends { modules: readonly ProjectModuleId[] }>(
    groups: T[],
    pageOrder: readonly ProjectModuleId[] | undefined,
): T[] {
    const rank = (group: T) => {
        const indexes = group.modules.map(id => pageOrder?.indexOf(id) ?? -1).filter(index => index >= 0);
        return indexes.length ? Math.min(...indexes) : (pageOrder?.length ?? 0);
    };
    return [...groups].sort((a, b) => rank(a) - rank(b));
}

export function flattenTabGroupOrder(
    groupIds: readonly string[],
    previous: readonly ProjectModuleId[] | undefined,
): ProjectModuleId[] {
    const visual: ProjectModuleId[] = [];
    for (const id of groupIds) {
        const group = PROJECT_TAB_GROUPS.find(item => item.id === id);
        if (!group) continue;
        const members = [...group.modules].sort((a, b) => {
            const left = previous?.indexOf(a) ?? -1;
            const right = previous?.indexOf(b) ?? -1;
            return (left < 0 ? 999 : left) - (right < 0 ? 999 : right);
        });
        visual.push(...members);
    }
    return mergeProjectPageOrder(previous, visual);
}

export const PROJECT_PAGES: readonly ProjectPage[] = [
    { module: 'manuscript', type: MANUSCRIPT_VIEW_TYPE, label: 'Manuscript', icon: 'book-open-text' },
    { module: 'flatCanvas', type: BOARD_VIEW_TYPE, label: 'Flat canvas', icon: 'layout-dashboard' },
    { module: 'columnBoard', type: COLUMN_BOARD_VIEW_TYPE, label: 'Column board', icon: 'columns-3' },
    { module: 'table', type: PLOTGRID_VIEW_TYPE, label: 'Table', icon: 'table' },
    { module: 'timeline', type: TIMELINE_VIEW_TYPE, label: 'Timeline', icon: 'list-ordered' },
    { module: 'trackComparison', type: TRACK_COMPARISON_VIEW_TYPE, label: 'Track comparison', icon: 'columns-2' },
    { module: 'plotList', type: STORYLINE_VIEW_TYPE, label: 'Plot list', icon: 'list' },
    { module: 'subwayMap', type: SUBWAY_VIEW_TYPE, label: 'Plot subway map', icon: 'route' },
    { module: 'library', type: CODEX_VIEW_TYPE, label: 'Library', icon: 'library-big' },
    { module: 'canvas', type: NCANVAS_LIBRARY_VIEW_TYPE, label: 'Node-based presentation canvas', icon: 'monitor-play' },
];
