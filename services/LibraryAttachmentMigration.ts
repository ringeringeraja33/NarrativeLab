/**
 * Move Library-referenced images from project-root Attachments into
 * Library/<Category>/Attachments, rewrite frontmatter + ncanvas paths,
 * then dedupe same-name / same-content attachment copies to a single file.
 */
import { TFile, TFolder, normalizePath, parseYaml, stringifyYaml } from 'obsidian';
import type SceneCardsPlugin from '../main';
import {
    DEFAULT_ATTACHMENT_FOLDER,
    deriveProjectFoldersFromFilePath,
    type StoryLineProject,
} from '../models/StoryLineProject';
import { invalidateImagePathCache } from '../components/ImagePicker';

const MARKER_NAME = 'library-attachments-v1.json';
const DEDUPE_MARKER_NAME = 'library-attachments-dedupe-v1.json';

const IMAGE_EXTENSIONS = new Set([
    'avif', 'bmp', 'gif', 'jpeg', 'jpg', 'png', 'svg', 'webp',
]);

function normalizeRefPath(raw: unknown): string {
    if (typeof raw !== 'string') return '';
    let normalized = raw.trim().replace(/\\/g, '/');
    if (!normalized) return '';
    if (normalized.startsWith('!')) normalized = normalized.slice(1).trim();
    const wiki = normalized.match(/^\[\[([\s\S]+?)\]\]$/);
    if (wiki) normalized = wiki[1].trim();
    const pipe = normalized.indexOf('|');
    if (pipe >= 0) normalized = normalized.slice(0, pipe).trim();
    const hash = normalized.indexOf('#');
    if (hash >= 0) normalized = normalized.slice(0, hash).trim();
    return normalizePath(normalized.replace(/^\/+/, ''));
}

function extractFmBlock(content: string): { fmText: string; body: string; fm: Record<string, unknown> } | null {
    const match = content.match(/^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/);
    if (!match) return null;
    let fm: Record<string, unknown>;
    try {
        fm = (parseYaml(match[1]) || {}) as Record<string, unknown>;
    } catch {
        return null;
    }
    if (!fm || typeof fm !== 'object' || Array.isArray(fm)) return null;
    return {
        fmText: match[1],
        body: content.slice(match[0].length),
        fm,
    };
}

function collectImageRefs(fm: Record<string, unknown>): string[] {
    const out: string[] = [];
    const push = (value: unknown) => {
        const path = normalizeRefPath(value);
        if (path) out.push(path);
    };
    push(fm.image);
    push(fm.imageFile);
    push(fm.image_preview);
    if (Array.isArray(fm.gallery)) {
        for (const item of fm.gallery) {
            if (typeof item === 'string') push(item);
            else if (item && typeof item === 'object') {
                const rec = item as Record<string, unknown>;
                push(rec.path ?? rec.file ?? rec.src);
            }
        }
    }
    if (Array.isArray(fm.images)) {
        for (const item of fm.images) {
            if (typeof item === 'string') push(item);
            else if (item && typeof item === 'object') {
                const rec = item as Record<string, unknown>;
                push(rec.path ?? rec.file ?? rec.src);
            }
        }
    }
    return out;
}

function rewriteFmPaths(fm: Record<string, unknown>, remap: Map<string, string>): boolean {
    let changed = false;
    const rewriteOne = (value: unknown): unknown => {
        if (typeof value !== 'string') return value;
        const trimmed = value.trim();
        const normalized = normalizeRefPath(trimmed);
        const next = remap.get(normalized);
        if (!next) return value;
        changed = true;
        // Preserve wikilink wrapping when present
        if (/^!?\[\[/.test(trimmed)) {
            const bang = trimmed.startsWith('!') ? '!' : '';
            const inner = trimmed.replace(/^!?\[\[/, '').replace(/\]\]$/, '');
            const pipe = inner.indexOf('|');
            const alias = pipe >= 0 ? inner.slice(pipe) : '';
            return `${bang}[[${next}${alias}]]`;
        }
        return next;
    };

    if (typeof fm.image === 'string') fm.image = rewriteOne(fm.image);
    if (typeof fm.imageFile === 'string') fm.imageFile = rewriteOne(fm.imageFile);
    if (typeof fm.image_preview === 'string') fm.image_preview = rewriteOne(fm.image_preview);

    if (Array.isArray(fm.gallery)) {
        fm.gallery = fm.gallery.map((item: unknown): unknown => {
            if (typeof item === 'string') return rewriteOne(item);
            if (item && typeof item === 'object') {
                const rec = { ...(item as Record<string, unknown>) };
                for (const key of ['path', 'file', 'src'] as const) {
                    if (typeof rec[key] === 'string') rec[key] = rewriteOne(rec[key]);
                }
                return rec;
            }
            return item;
        });
    }
    if (Array.isArray(fm.images)) {
        fm.images = fm.images.map((item: unknown): unknown => {
            if (typeof item === 'string') return rewriteOne(item);
            if (item && typeof item === 'object') {
                const rec = { ...(item as Record<string, unknown>) };
                for (const key of ['path', 'file', 'src'] as const) {
                    if (typeof rec[key] === 'string') rec[key] = rewriteOne(rec[key]);
                }
                return rec;
            }
            return item;
        });
    }
    return changed;
}

function categoryFolderFromLibraryPath(filePath: string, libraryRoot: string): string {
    const normalized = normalizePath(filePath);
    const root = normalizePath(libraryRoot);
    if (!normalized.startsWith(`${root}/`)) return '';
    const rel = normalized.slice(root.length + 1);
    const seg = rel.split('/')[0] || '';
    if (!seg || seg === DEFAULT_ATTACHMENT_FOLDER) return '';
    return seg;
}

async function uniqueDestPath(plugin: SceneCardsPlugin, folder: string, fileName: string): Promise<string> {
    const adapter = plugin.app.vault.adapter;
    await plugin.app.vault.createFolder(folder).catch(() => undefined);
    let candidate = normalizePath(`${folder}/${fileName}`);
    if (!await adapter.exists(candidate)) return candidate;
    const dot = fileName.lastIndexOf('.');
    const base = dot >= 0 ? fileName.slice(0, dot) : fileName;
    const ext = dot >= 0 ? fileName.slice(dot) : '';
    for (let i = 2; i < 1000; i++) {
        candidate = normalizePath(`${folder}/${base}-${i}${ext}`);
        if (!await adapter.exists(candidate)) return candidate;
    }
    throw new Error(`Could not allocate attachment path in ${folder}`);
}

function collectMarkdownFiles(folder: TFolder, out: TFile[]): void {
    for (const child of folder.children) {
        if (child instanceof TFolder) collectMarkdownFiles(child, out);
        else if (child instanceof TFile && child.extension.toLowerCase() === 'md') out.push(child);
    }
}

function collectNcanvasFiles(folder: TFolder, out: TFile[]): void {
    for (const child of folder.children) {
        if (child instanceof TFolder) collectNcanvasFiles(child, out);
        else if (child instanceof TFile) {
            const ext = child.extension.toLowerCase();
            if (ext === 'ncanvas' || ext === 'narrativecanvas') out.push(child);
        }
    }
}

function collectAttachmentImages(folder: TFolder, out: TFile[]): void {
    for (const child of folder.children) {
        if (child instanceof TFolder) collectAttachmentImages(child, out);
        else if (child instanceof TFile && IMAGE_EXTENSIONS.has(child.extension.toLowerCase())) {
            out.push(child);
        }
    }
}

function isUnderLibraryAttachments(path: string, libraryRoot: string): boolean {
    const p = normalizePath(path);
    const root = normalizePath(libraryRoot);
    if (!p.startsWith(`${root}/`)) return false;
    return p.includes(`/${DEFAULT_ATTACHMENT_FOLDER}/`) || p.endsWith(`/${DEFAULT_ATTACHMENT_FOLDER}`);
}

async function rewriteProjectRefs(
    plugin: SceneCardsPlugin,
    baseFolder: string,
    libraryRoot: string,
    remap: Map<string, string>,
): Promise<void> {
    if (remap.size === 0) return;

    const libraryFolder = plugin.app.vault.getAbstractFileByPath(libraryRoot);
    if (libraryFolder instanceof TFolder) {
        const mdFiles: TFile[] = [];
        collectMarkdownFiles(libraryFolder, mdFiles);
        for (const file of mdFiles) {
            const content = await plugin.app.vault.read(file);
            const parsed = extractFmBlock(content);
            if (!parsed) continue;
            // Also resolve linkpaths that equal a remap key after dest lookup
            const resolvedRemap = new Map(remap);
            for (const [from, to] of remap) {
                resolvedRemap.set(from, to);
            }
            // Expand remap with resolved vault paths for wiki-style refs in this note
            for (const ref of collectImageRefs(parsed.fm)) {
                const linked = plugin.app.metadataCache.getFirstLinkpathDest(ref, file.path);
                if (linked instanceof TFile) {
                    const linkedPath = normalizePath(linked.path);
                    if (remap.has(linkedPath) && !resolvedRemap.has(ref)) {
                        resolvedRemap.set(ref, remap.get(linkedPath)!);
                    }
                }
            }
            if (!rewriteFmPaths(parsed.fm, resolvedRemap)) continue;
            const next = `---\n${stringifyYaml(parsed.fm)}---${parsed.body.startsWith('\n') ? parsed.body : `\n${parsed.body}`}`;
            await plugin.app.vault.modify(file, next);
        }
    }

    const ncanvasFiles: TFile[] = [];
    const projectRoot = plugin.app.vault.getAbstractFileByPath(baseFolder);
    if (projectRoot instanceof TFolder) collectNcanvasFiles(projectRoot, ncanvasFiles);
    for (const file of ncanvasFiles) {
        let text: string;
        try {
            text = await plugin.app.vault.read(file);
        } catch {
            continue;
        }
        let next = text;
        for (const [from, to] of remap) {
            if (from === to) continue;
            next = next.split(from).join(to);
            next = next.split(JSON.stringify(from).slice(1, -1)).join(JSON.stringify(to).slice(1, -1));
        }
        if (next !== text) await plugin.app.vault.modify(file, next);
    }
}

function simpleHash(bytes: ArrayBuffer): string {
    // Fast non-crypto fingerprint for duplicate detection
    const view = new Uint8Array(bytes);
    let h1 = 2166136261;
    let h2 = 2166136261 ^ (view.length * 2654435761);
    for (let i = 0; i < view.length; i++) {
        h1 ^= view[i];
        h1 = Math.imul(h1, 16777619);
        if ((i & 3) === 0) {
            h2 ^= view[i];
            h2 = Math.imul(h2, 16777619);
        }
    }
    return `${view.length.toString(16)}-${(h1 >>> 0).toString(16)}-${(h2 >>> 0).toString(16)}`;
}

/**
 * Keep one copy per duplicate basename / identical content among project
 * attachment folders; rewrite all library + ncanvas refs; trash the rest.
 */
async function dedupeProjectAttachments(
    plugin: SceneCardsPlugin,
    project: StoryLineProject,
): Promise<boolean> {
    const folders = deriveProjectFoldersFromFilePath(project.filePath);
    const baseFolder = normalizePath(folders.baseFolder);
    const libraryRoot = normalizePath(project.codexFolder || folders.codexFolder);
    const systemFolder = normalizePath(`${baseFolder}/System`);
    const markerPath = normalizePath(`${systemFolder}/${DEDUPE_MARKER_NAME}`);
    const adapter = plugin.app.vault.adapter;

    if (await adapter.exists(markerPath)) return false;

    const attachName = (plugin.settings.projectAttachmentFolder || DEFAULT_ATTACHMENT_FOLDER)
        .trim()
        .replace(/^\/+|\/+$/g, '') || DEFAULT_ATTACHMENT_FOLDER;
    const rootAttachments = normalizePath(`${baseFolder}/${attachName}`);

    const candidates: TFile[] = [];
    const rootFolder = plugin.app.vault.getAbstractFileByPath(rootAttachments);
    if (rootFolder instanceof TFolder) collectAttachmentImages(rootFolder, candidates);

    const libraryFolder = plugin.app.vault.getAbstractFileByPath(libraryRoot);
    if (libraryFolder instanceof TFolder) {
        for (const child of libraryFolder.children) {
            if (!(child instanceof TFolder)) continue;
            const att = plugin.app.vault.getAbstractFileByPath(
                normalizePath(`${child.path}/${DEFAULT_ATTACHMENT_FOLDER}`),
            );
            if (att instanceof TFolder) collectAttachmentImages(att, candidates);
        }
    }

    if (candidates.length < 2) {
        await plugin.app.vault.createFolder(systemFolder).catch(() => undefined);
        await adapter.write(markerPath, JSON.stringify({ deduped: true, removed: 0 }, null, 2));
        return false;
    }

    // Count references per path (library notes)
    const refCounts = new Map<string, number>();
    if (libraryFolder instanceof TFolder) {
        const mdFiles: TFile[] = [];
        collectMarkdownFiles(libraryFolder, mdFiles);
        for (const file of mdFiles) {
            let content: string;
            try {
                content = await plugin.app.vault.cachedRead(file);
            } catch {
                continue;
            }
            const parsed = extractFmBlock(content);
            if (!parsed) continue;
            for (const ref of collectImageRefs(parsed.fm)) {
                const linked = plugin.app.metadataCache.getFirstLinkpathDest(ref, file.path);
                const path = linked instanceof TFile ? normalizePath(linked.path) : ref;
                refCounts.set(path, (refCounts.get(path) || 0) + 1);
            }
        }
    }

    const pickCanonical = (files: TFile[]): TFile => {
        return files.slice().sort((a, b) => {
            const aLib = isUnderLibraryAttachments(a.path, libraryRoot) ? 0 : 1;
            const bLib = isUnderLibraryAttachments(b.path, libraryRoot) ? 0 : 1;
            if (aLib !== bLib) return aLib - bLib;
            const aRefs = refCounts.get(normalizePath(a.path)) || 0;
            const bRefs = refCounts.get(normalizePath(b.path)) || 0;
            if (aRefs !== bRefs) return bRefs - aRefs;
            return a.path.localeCompare(b.path);
        })[0];
    };

    const remap = new Map<string, string>();
    const toDelete: TFile[] = [];

    // 1) Same basename (case-insensitive)
    const byName = new Map<string, TFile[]>();
    for (const file of candidates) {
        const key = file.name.toLowerCase();
        const list = byName.get(key);
        if (list) list.push(file);
        else byName.set(key, [file]);
    }
    for (const group of byName.values()) {
        if (group.length < 2) continue;
        const keep = pickCanonical(group);
        const keepPath = normalizePath(keep.path);
        for (const file of group) {
            const path = normalizePath(file.path);
            if (path === keepPath) continue;
            remap.set(path, keepPath);
            toDelete.push(file);
        }
    }

    // 2) Same binary content among remaining (catches foo.png vs foo-2.png)
    const remaining = candidates.filter(f => !remap.has(normalizePath(f.path)));
    const bySize = new Map<number, TFile[]>();
    for (const file of remaining) {
        const size = file.stat?.size ?? 0;
        if (size <= 0) continue;
        const list = bySize.get(size);
        if (list) list.push(file);
        else bySize.set(size, [file]);
    }
    const byHash = new Map<string, TFile[]>();
    for (const group of bySize.values()) {
        if (group.length < 2) continue;
        for (const file of group) {
            try {
                const bytes = await adapter.readBinary(file.path);
                const hash = simpleHash(bytes);
                const list = byHash.get(hash);
                if (list) list.push(file);
                else byHash.set(hash, [file]);
            } catch {
                /* skip unreadable */
            }
        }
    }
    for (const group of byHash.values()) {
        if (group.length < 2) continue;
        const keep = pickCanonical(group);
        const keepPath = normalizePath(keep.path);
        for (const file of group) {
            const path = normalizePath(file.path);
            if (path === keepPath || remap.has(path)) continue;
            remap.set(path, keepPath);
            toDelete.push(file);
        }
    }

    if (remap.size === 0) {
        await plugin.app.vault.createFolder(systemFolder).catch(() => undefined);
        await adapter.write(markerPath, JSON.stringify({ deduped: true, removed: 0 }, null, 2));
        return false;
    }

    await rewriteProjectRefs(plugin, baseFolder, libraryRoot, remap);

    const keepPaths = new Set(remap.values());
    const deletePaths = [...new Set(toDelete.map(f => normalizePath(f.path)))]
        .filter(path => !keepPaths.has(path));
    let removed = 0;
    for (const path of deletePaths) {
        const still = plugin.app.vault.getAbstractFileByPath(path);
        if (!(still instanceof TFile)) continue;
        try {
            await plugin.app.fileManager.trashFile(still);
            removed += 1;
        } catch {
            try {
                await adapter.remove(still.path);
                removed += 1;
            } catch {
                /* keep file if delete fails */
            }
        }
    }

    await plugin.app.vault.createFolder(systemFolder).catch(() => undefined);
    await adapter.write(markerPath, JSON.stringify({
        deduped: true,
        removed,
        remapped: Object.fromEntries(remap),
    }, null, 2));

    return removed > 0 || remap.size > 0;
}

async function migrateProjectLibraryAttachments(
    plugin: SceneCardsPlugin,
    project: StoryLineProject,
): Promise<boolean> {
    const folders = deriveProjectFoldersFromFilePath(project.filePath);
    const baseFolder = normalizePath(folders.baseFolder);
    const libraryRoot = normalizePath(project.codexFolder || folders.codexFolder);
    const systemFolder = normalizePath(`${baseFolder}/System`);
    const markerPath = normalizePath(`${systemFolder}/${MARKER_NAME}`);
    const adapter = plugin.app.vault.adapter;

    if (await adapter.exists(markerPath)) return false;

    const attachName = (plugin.settings.projectAttachmentFolder || DEFAULT_ATTACHMENT_FOLDER)
        .trim()
        .replace(/^\/+|\/+$/g, '') || DEFAULT_ATTACHMENT_FOLDER;
    const rootAttachments = normalizePath(`${baseFolder}/${attachName}`);

    const libraryFolder = plugin.app.vault.getAbstractFileByPath(libraryRoot);
    if (!(libraryFolder instanceof TFolder)) {
        await plugin.app.vault.createFolder(systemFolder).catch(() => undefined);
        await adapter.write(markerPath, JSON.stringify({ migrated: true, skipped: 'no-library' }, null, 2)).catch(() => undefined);
        return false;
    }

    const mdFiles: TFile[] = [];
    collectMarkdownFiles(libraryFolder, mdFiles);

    /** oldPath → first category folder that referenced it */
    const ownership = new Map<string, string>();
    /** note path → image refs under root Attachments */
    const noteRefs = new Map<string, string[]>();

    for (const file of mdFiles) {
        const category = categoryFolderFromLibraryPath(file.path, libraryRoot);
        if (!category) continue;
        let content: string;
        try {
            content = await plugin.app.vault.cachedRead(file);
        } catch {
            continue;
        }
        const parsed = extractFmBlock(content);
        if (!parsed) continue;
        const refs = collectImageRefs(parsed.fm)
            .map(path => {
                // Resolve linkpath → vault path when possible
                const linked = plugin.app.metadataCache.getFirstLinkpathDest(path, file.path);
                return linked instanceof TFile ? normalizePath(linked.path) : path;
            })
            .filter(path => path === rootAttachments || path.startsWith(`${rootAttachments}/`));
        if (!refs.length) continue;
        noteRefs.set(file.path, refs);
        for (const path of refs) {
            if (!ownership.has(path)) ownership.set(path, category);
        }
    }

    if (ownership.size === 0) {
        await plugin.app.vault.createFolder(systemFolder).catch(() => undefined);
        await adapter.write(markerPath, JSON.stringify({ migrated: true, moved: 0 }, null, 2));
        return false;
    }

    const remap = new Map<string, string>();
    let moved = 0;

    for (const [oldPath, category] of ownership) {
        const src = plugin.app.vault.getAbstractFileByPath(oldPath);
        if (!(src instanceof TFile)) continue;
        const destFolder = normalizePath(`${libraryRoot}/${category}/${DEFAULT_ATTACHMENT_FOLDER}`);
        const destPath = await uniqueDestPath(plugin, destFolder, src.name);
        if (normalizePath(src.path) === destPath) {
            remap.set(oldPath, destPath);
            continue;
        }
        try {
            await plugin.app.fileManager.renameFile(src, destPath);
            remap.set(oldPath, destPath);
            moved += 1;
        } catch {
            // Fall back to binary copy + remove if rename fails
            try {
                const data = await adapter.readBinary(oldPath);
                await adapter.writeBinary(destPath, data);
                await adapter.remove(oldPath);
                remap.set(oldPath, destPath);
                moved += 1;
            } catch {
                /* skip this file */
            }
        }
    }

    // Rewrite library note frontmatter
    for (const [notePath, refs] of noteRefs) {
        const relevant = refs.some(r => remap.has(r));
        if (!relevant) continue;
        const file = plugin.app.vault.getAbstractFileByPath(notePath);
        if (!(file instanceof TFile)) continue;
        const content = await plugin.app.vault.read(file);
        const parsed = extractFmBlock(content);
        if (!parsed) continue;
        if (!rewriteFmPaths(parsed.fm, remap)) continue;
        const next = `---\n${stringifyYaml(parsed.fm)}---${parsed.body.startsWith('\n') ? parsed.body : `\n${parsed.body}`}`;
        await plugin.app.vault.modify(file, next);
    }

    // Rewrite ncanvas library image paths (project root + NCanvas folder)
    const ncanvasFiles: TFile[] = [];
    const projectRoot = plugin.app.vault.getAbstractFileByPath(baseFolder);
    if (projectRoot instanceof TFolder) collectNcanvasFiles(projectRoot, ncanvasFiles);

    for (const file of ncanvasFiles) {
        let text: string;
        try {
            text = await plugin.app.vault.read(file);
        } catch {
            continue;
        }
        let next = text;
        for (const [from, to] of remap) {
            if (from === to) continue;
            // Replace path occurrences in JSON (escaped and raw)
            next = next.split(from).join(to);
            next = next.split(JSON.stringify(from).slice(1, -1)).join(JSON.stringify(to).slice(1, -1));
        }
        if (next !== text) await plugin.app.vault.modify(file, next);
    }

    await plugin.app.vault.createFolder(systemFolder).catch(() => undefined);
    await adapter.write(markerPath, JSON.stringify({
        migrated: true,
        moved,
        remapped: Object.fromEntries(remap),
    }, null, 2));

    return moved > 0 || remap.size > 0;
}

/** Migrate library attachments for all known projects (idempotent). */
export async function migrateLibraryAttachmentsForAllProjects(plugin: SceneCardsPlugin): Promise<void> {
    const projects = plugin.sceneManager.getProjects();
    let any = false;
    for (const project of projects) {
        try {
            if (await migrateProjectLibraryAttachments(plugin, project)) any = true;
        } catch {
            /* continue other projects */
        }
        try {
            if (await dedupeProjectAttachments(plugin, project)) any = true;
        } catch {
            /* continue other projects */
        }
    }
    if (any) {
        invalidateImagePathCache();
        void plugin.refreshOpenViews();
    }
}
