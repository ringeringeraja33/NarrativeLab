import { App, TFile, normalizePath } from 'obsidian';

/** Append a wikilink to the end of a note body if missing. */
export async function ensureWikilink(
    app: App,
    sourcePath: string,
    targetLabel: string,
    targetPath?: string,
): Promise<boolean> {
    const file = app.vault.getAbstractFileByPath(normalizePath(sourcePath));
    if (!(file instanceof TFile)) return false;
    const label = targetLabel.trim();
    if (!label) return false;

    const targetFile = targetPath
        ? app.vault.getAbstractFileByPath(normalizePath(targetPath))
        : null;
    // Prefer Obsidian's resolved link form so metadataCache picks it up reliably.
    const link = targetFile instanceof TFile
        ? app.fileManager.generateMarkdownLink(targetFile, file.path)
        : `[[${label}]]`;

    const content = await app.vault.read(file);
    // Already linked? Check common forms (display name, path, generated link).
    const alreadyLinked = content.includes(link)
        || content.includes(`[[${label}]]`)
        || (targetFile instanceof TFile && (
            content.includes(`[[${targetFile.basename}]]`)
            || content.includes(`[[${targetFile.path}]]`)
            || content.includes(`[[${targetFile.path.replace(/\.md$/i, '')}]]`)
        ));
    if (alreadyLinked) return false;

    const next = content.trimEnd() + (content.trimEnd() ? '\n\n' : '') + link + '\n';
    await app.vault.modify(file, next);
    return true;
}

/**
 * Wait until metadataCache resolves a directed wikilink (or timeout).
 * Needed because vault.modify → resolvedLinks is asynchronous.
 */
export async function waitForResolvedWikilink(
    app: App,
    sourcePath: string,
    targetPath: string,
    timeoutMs = 2000,
): Promise<boolean> {
    const src = normalizePath(sourcePath);
    const tgt = normalizePath(targetPath);
    const hasLink = (): boolean => {
        const fromResolved = app.metadataCache.resolvedLinks[src] || {};
        if (Object.keys(fromResolved).some(p => normalizePath(p) === tgt)) return true;
        const file = app.vault.getAbstractFileByPath(src);
        if (!(file instanceof TFile)) return false;
        const cache = app.metadataCache.getFileCache(file);
        for (const link of cache?.links || []) {
            const dest = app.metadataCache.getFirstLinkpathDest(link.link, src);
            if (dest && normalizePath(dest.path) === tgt) return true;
        }
        return false;
    };
    if (hasLink()) return true;

    return await new Promise<boolean>((resolve) => {
        const timer = window.setTimeout(() => {
            cleanup();
            resolve(hasLink());
        }, timeoutMs);
        const onChange = (file: TFile) => {
            if (normalizePath(file.path) !== src) return;
            if (hasLink()) {
                cleanup();
                resolve(true);
            }
        };
        const onResolved = () => {
            if (hasLink()) {
                cleanup();
                resolve(true);
            }
        };
        const refChange = app.metadataCache.on('changed', onChange);
        const refResolved = app.metadataCache.on('resolved', onResolved);
        const cleanup = () => {
            window.clearTimeout(timer);
            app.metadataCache.offref(refChange);
            app.metadataCache.offref(refResolved);
        };
        // One more tick in case modify already flushed before we subscribed.
        window.setTimeout(() => {
            if (hasLink()) {
                cleanup();
                resolve(true);
            }
        }, 30);
    });
}
