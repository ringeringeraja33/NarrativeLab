/** Visit each connected inserted branch once, even when a batch contains its descendants. */
export function addedMutationRoots(mutations: readonly MutationRecord[]): Element[] {
    const candidates = new Set<Element>();
    for (const mutation of mutations) {
        for (const node of Array.from(mutation.addedNodes)) {
            const element = node.nodeType === 1 ? node as Element : node.parentElement;
            if (element?.isConnected) candidates.add(element);
        }
    }
    return outermostElements(candidates);
}

export function outermostElements(elements: Iterable<Element>): Element[] {
    const candidates = new Set(elements);
    return [...candidates].filter(element => {
        for (let parent = element.parentElement; parent; parent = parent.parentElement) {
            if (candidates.has(parent)) return false;
        }
        return true;
    });
}

/** Include the root itself: mutations can insert a title/input without a wrapper. */
export function matchingElements(root: ParentNode, selector: string): Element[] {
    const element = root as Element;
    return [
        ...(typeof element.matches === 'function' && element.matches(selector) ? [element] : []),
        ...Array.from(root.querySelectorAll(selector)),
    ];
}
