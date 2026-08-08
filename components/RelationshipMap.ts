/**
 * Shared relationship types for Library Story Graph / relation menus.
 * (The old interactive RelationshipMap SVG class was removed; StoryGraph
 * owns the live graph UI.)
 */

export type RelationshipType = 'ally' | 'enemy' | 'romantic' | 'family' | 'mentor' | 'other';

export interface RelationshipEdgeInfo {
    from: string;
    to: string;
    type: RelationshipType;
    /** Graph style id when known (custom types / builtins). */
    styleId?: string;
}
