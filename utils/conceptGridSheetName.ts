/** Excel / Univer worksheet names reject these characters. */
export const CONCEPT_GRID_SHEET_NAME_FORBIDDEN = ':\\/?*[]';

/** Excel / Univer worksheet names are capped at 31 characters. */
export const CONCEPT_GRID_SHEET_NAME_MAX_LENGTH = 31;

export type ConceptGridSheetNameError =
    | 'Sheet name cannot be empty.'
    | 'A sheet with this name already exists.'
    | 'Sheet names cannot contain: {chars}'
    | 'Sheet name is too long.';

export function validateConceptGridSheetName(
    raw: string,
    options: { existingTitles: string[]; currentTitle?: string },
): ConceptGridSheetNameError | null {
    const name = raw.trim();
    if (!name) return 'Sheet name cannot be empty.';
    if (name.length > CONCEPT_GRID_SHEET_NAME_MAX_LENGTH) return 'Sheet name is too long.';
    if ([...CONCEPT_GRID_SHEET_NAME_FORBIDDEN].some(char => name.includes(char))) {
        return 'Sheet names cannot contain: {chars}';
    }
    const current = (options.currentTitle ?? '').trim();
    if (name === current) return null;
    const taken = options.existingTitles.some(title => title.trim() === name);
    return taken ? 'A sheet with this name already exists.' : null;
}
