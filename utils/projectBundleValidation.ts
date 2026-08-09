export function normalizeProjectBundleRelativePath(value: string): string {
    const raw = value.trim().replace(/\\/g, '/');
    if (!raw || raw.startsWith('/') || /^[A-Za-z]:\//.test(raw) || raw.includes('\0')) {
        throw new Error(`Unsafe project bundle path: ${value}`);
    }
    const parts = raw.split('/');
    if (parts.some(part => !part || part === '.' || part === '..')) {
        throw new Error(`Unsafe project bundle path: ${value}`);
    }
    return parts.join('/');
}

export function isRootProjectManifest(relativePath: string, content: string): boolean {
    return !relativePath.includes('/')
        && /\.md$/i.test(relativePath)
        && /^---[\s\S]*?type:\s*(?:storyline|narrative-lab)\b/m.test(content);
}
