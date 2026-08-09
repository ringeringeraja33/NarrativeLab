function undirectedNodePairKey(a: string, b: string): string {
    return a < b ? `${a}||${b}` : `${b}||${a}`;
}

/**
 * On the main Story Graph, drop plain「默认引用」wikilinks when the same
 * undirected pair already has a character relation or categorized wikilink.
 */
export function suppressDefaultReferenceEdges<T extends {
    source: string;
    target: string;
    kind: string;
    relationCategoryId?: string;
}>(edges: T[]): T[] {
    const pairsWithSpecific = new Set<string>();
    for (const edge of edges) {
        const isDefaultRef = edge.kind === 'wikilink' && !edge.relationCategoryId;
        if (!isDefaultRef) pairsWithSpecific.add(undirectedNodePairKey(edge.source, edge.target));
    }
    if (pairsWithSpecific.size === 0) return edges;
    return edges.filter(edge => {
        const isDefaultRef = edge.kind === 'wikilink' && !edge.relationCategoryId;
        if (!isDefaultRef) return true;
        return !pairsWithSpecific.has(undirectedNodePairKey(edge.source, edge.target));
    });
}
