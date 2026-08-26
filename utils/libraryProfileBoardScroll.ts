export interface LibraryProfileBoardScrollState {
    left: number;
    top: number;
    columns: number[];
}

const PROFILE_TRACK_SELECTOR = '.character-detail-board-track, .character-detail-vertical-track';
const COLUMN_BODY_SELECTOR = [
    ':scope > .character-section > .character-section-body',
    ':scope > .character-board-column > .character-section-body',
    ':scope > .codex-section > .codex-section-body',
    ':scope > .location-section > .location-section-body',
].join(', ');

function profileTrack(container: HTMLElement): HTMLElement | null {
    if (container.matches(PROFILE_TRACK_SELECTOR)) return container;
    return container.querySelector(PROFILE_TRACK_SELECTOR);
}

function columnBodies(track: HTMLElement): HTMLElement[] {
    return Array.from(track.querySelectorAll<HTMLElement>(COLUMN_BODY_SELECTOR));
}

/** Capture both axes before a profile re-render replaces its column DOM. */
export function captureLibraryProfileBoardScroll(
    container: HTMLElement,
): LibraryProfileBoardScrollState | null {
    const track = profileTrack(container);
    if (!track) return null;
    return {
        left: track.scrollLeft,
        top: track.scrollTop,
        columns: columnBodies(track).map(body => body.scrollTop),
    };
}

/** Restore immediately and after layout, when textarea heights are final. */
export function restoreLibraryProfileBoardScroll(
    container: HTMLElement,
    state: LibraryProfileBoardScrollState | null,
): void {
    if (!state) return;
    const apply = () => {
        if (!container.isConnected) return;
        const track = profileTrack(container);
        if (!track) return;
        track.scrollLeft = state.left;
        if (state.top > 0) track.scrollTop = state.top;
        const bodies = columnBodies(track);
        state.columns.forEach((top, index) => {
            if (top > 0 && bodies[index]) bodies[index].scrollTop = top;
        });
    };
    apply();
    const view = container.ownerDocument.defaultView;
    view?.requestAnimationFrame(() => {
        apply();
        view.requestAnimationFrame(apply);
    });
}
