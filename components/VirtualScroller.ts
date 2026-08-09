/* eslint-disable @typescript-eslint/no-unnecessary-type-assertion -- Obsidian's API surface and several untyped third-party libraries force dynamic dispatch; floating promises are intentional in DOM/event handlers; matching enable at end of file */
/**
 * VirtualScroller — lightweight windowed renderer for lists inside a
 * scrollable container.
 *
 * Instead of creating DOM nodes for every item, it renders only the visible
 * window (plus a small overscan buffer) and uses padding to maintain the
 * correct scroll height.
 *
 * Usage:
 *   const vs = new VirtualScroller({ container, itemHeight, items, renderItem, overscan });
 *   vs.mount();          // starts observing scroll
 *   vs.destroy();        // cleanup
 *   vs.setItems(items);  // swap items and re-render
 */

export interface VirtualScrollerOptions<T> {
    /** The scrollable container element (must have overflow-y: auto/scroll) */
    container: HTMLElement;
    /** Fixed height per row (px). For variable-height cards, pick a good average. */
    itemHeight: number;
    /** Array of data items */
    items: T[];
    /** Render a single item and append it to parent. Should return the created element. */
    renderItem: (item: T, index: number, parent: HTMLElement) => HTMLElement;
    /** How many extra items to render above/below the viewport (default 5) */
    overscan?: number;
    /** Minimum item count before virtualisation kicks in (default 40) */
    threshold?: number;
}

export class VirtualScroller<T> {
    private container: HTMLElement;
    private itemHeight: number;
    private items: T[];
    private renderItem: (item: T, index: number, parent: HTMLElement) => HTMLElement;
    private overscan: number;
    private threshold: number;

    /** Inner wrapper that holds the spacer and the visible items */
    private innerEl: HTMLElement | null = null;
    /** Top spacer */
    private topSpacer: HTMLElement | null = null;
    /** Bottom spacer */
    private bottomSpacer: HTMLElement | null = null;
    /** Currently rendered items container */
    private contentEl: HTMLElement | null = null;

    private scrollHandler: (() => void) | null = null;
    private lastStart = -1;
    private lastEnd = -1;
    /** Measured heights per item index (px). Filled in as items render. */
    private measuredHeights: Map<number, number> = new Map();

    constructor(opts: VirtualScrollerOptions<T>) {
        this.container = opts.container;
        this.itemHeight = opts.itemHeight;
        this.items = opts.items;
        this.renderItem = opts.renderItem;
        this.overscan = opts.overscan ?? 5;
        this.threshold = opts.threshold ?? 40;
    }

    /** Build and start observing scroll events */
    mount(): void {
        // If below threshold, render everything normally (no virtualization)
        if (this.items.length < this.threshold) {
            for (let i = 0; i < this.items.length; i++) {
                this.renderItem(this.items[i], i, this.container);
            }
            return;
        }

        this.innerEl = this.container.createDiv({ cls: 'virtual-scroll-inner' });
        this.topSpacer = this.innerEl.createDiv({ cls: 'virtual-scroll-spacer' });
        this.contentEl = this.innerEl.createDiv({ cls: 'virtual-scroll-content' });
        this.bottomSpacer = this.innerEl.createDiv({ cls: 'virtual-scroll-spacer' });

        this.scrollHandler = () => this.onScroll();
        this.container.addEventListener('scroll', this.scrollHandler, { passive: true });

        // Initial render
        this.onScroll();
    }

    /** Replace items and re-render visible window */
    setItems(items: T[]): void {
        this.items = items;
        this.lastStart = -1;
        this.lastEnd = -1;
        this.measuredHeights.clear();
        if (this.innerEl) {
            this.onScroll();
        }
    }

    /** Cleanup */
    destroy(): void {
        if (this.scrollHandler) {
            this.container.removeEventListener('scroll', this.scrollHandler);
            this.scrollHandler = null;
        }
    }

    /**
     * Compute the cumulative pixel offset of item `index` using measured
     * heights where available, falling back to the estimate for unmeasured
     * items. This keeps spacer heights accurate even when cards have
     * variable heights (issue #218 — Kanban auto-scrolling).
     */
    private heightAt(index: number): number {
        return this.measuredHeights.get(index) ?? this.itemHeight;
    }

    private cumulativeOffset(index: number): number {
        let total = 0;
        for (let i = 0; i < index; i++) total += this.heightAt(i);
        return total;
    }

    /**
     * Find the item index whose cumulative offset contains `pixelOffset`.
     * Used to translate scrollTop into a starting item index accurately.
     */
    private indexOfPixelOffset(pixelOffset: number): number {
        let acc = 0;
        for (let i = 0; i < this.items.length; i++) {
            const h = this.heightAt(i);
            if (acc + h > pixelOffset) return i;
            acc += h;
        }
        return this.items.length;
    }

    private onScroll(): void {
        if (!this.contentEl || !this.topSpacer || !this.bottomSpacer) return;

        const scrollTop = this.container.scrollTop;
        const viewHeight = this.container.clientHeight;

        // Compute the visible window using measured heights where
        // available so variable-height cards don't cause the scroll to
        // jump (issue #218). We walk the cumulative offsets to find the
        // first item at or above the scroll position, then count forward
        // until we've covered the viewport (plus overscan).
        let start = this.indexOfPixelOffset(scrollTop) - this.overscan;
        if (start < 0) start = 0;

        let end = start;
        let covered = 0;
        // Start from the top of the `start` item (subtract the partial
        // offset so we don't under-count the first visible item).
        const startOffset = this.cumulativeOffset(start);
        const partial = scrollTop - startOffset;
        covered = partial > 0 ? this.heightAt(start) - partial : 0;
        while (end < this.items.length && covered < viewHeight) {
            covered += this.heightAt(end);
            end++;
        }
        end += this.overscan;
        if (end > this.items.length) end = this.items.length;

        // Skip re-render if window hasn't actually changed
        if (start === this.lastStart && end === this.lastEnd) return;

        // If a focusable element inside the visible window currently has
        // focus, re-rendering would unmount it and kick the user out of the
        // text box (issue #211). Defer the re-render until the focused
        // element is blurred or the window drifts far enough that the
        // focused item would scroll out anyway.
        const active = activeDocument.activeElement as HTMLElement | null;
        if (active && this.contentEl?.contains(active) &&
            active.matches('input, textarea, select, [contenteditable="true"], [contenteditable=""]')) {
            // Check whether the focused item's index is still in the new
            // window. If it is, skip this re-render entirely. If it has
            // scrolled out of range, we must re-render (and the focus loss
            // is unavoidable).
            const focusedIndex = (active.closest('[data-vs-index]') as HTMLElement | null)
                ?.getAttribute('data-vs-index');
            const idx = focusedIndex ? parseInt(focusedIndex, 10) : -1;
            if (idx >= 0 && idx >= start && idx < end) {
                // Focused item is still visible — skip the rebuild.
                this.lastStart = start;
                this.lastEnd = end;
                return;
            }
        }

        this.lastStart = start;
        this.lastEnd = end;

        // Update spacers using measured heights for accurate scroll height.
        const topPx = this.cumulativeOffset(start);
        let bottomPx = 0;
        for (let i = end; i < this.items.length; i++) bottomPx += this.heightAt(i);
        this.topSpacer.setCssStyles({ height: `${topPx}px` });
        this.bottomSpacer.setCssStyles({ height: `${bottomPx}px` });

        // Render visible items
        this.contentEl.empty();
        for (let i = start; i < end; i++) {
            const el = this.renderItem(this.items[i], i, this.contentEl);
            // Tag each rendered item with its index so we can detect when
            // the focused element is still in view (see focus-preservation
            // guard above).
            if (el) {
                el.setAttribute('data-vs-index', String(i));
                // Measure the actual height and cache it so subsequent
                // scroll calculations use the real value instead of the
                // fixed estimate (issue #218).
                const measured = el.getBoundingClientRect().height;
                if (measured > 0) this.measuredHeights.set(i, measured);
            }
        }
    }
}
/* eslint-enable @typescript-eslint/no-unnecessary-type-assertion -- end of file-wide suppression block opened at line 1 */
