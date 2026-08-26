/* eslint-disable @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-assignment -- Obsidian's API surface and several untyped third-party libraries force dynamic dispatch; floating promises are intentional in DOM/event handlers; matching enable at end of file */
import { App, TFile, TFolder, normalizePath, parseYaml, stringifyYaml } from 'obsidian';
import { ResearchPost, ResearchType } from '../models/Research';
import type SceneCardsPlugin from '../main';
import { tokenizeWords, DEFAULT_STORYLINE_LOCALE } from '../utils/locale';
import { resolveLibraryEntityName } from '../utils/libraryEntityName';
import { ensureVaultFolder } from '../utils/vaultFolders';

/**
 * ResearchManager — CRUD, indexing, and search for research posts.
 *
 * Research posts are markdown files stored in `{project}/Research/`
 * with YAML frontmatter `type: research`.
 */
export class ResearchManager {
    private posts = new Map<string, ResearchPost>();
    /** Vault paths of linked notes (stored in .links.json) */
    private linkedPaths = new Set<string>();
    /** Whether linkedPaths has been loaded from disk at least once */
    private linksLoaded = false;
    private linksFileInvalid = false;
    private linksLoadedFromBackup = false;

    constructor(
        private app: App,
        private plugin: SceneCardsPlugin,
    ) {}

    // ────────────────────────────────────
    //  Scanning / indexing
    // ────────────────────────────────────

    /** Scan the active project's Research/ folder and index all posts, including linked notes. */
    async scan(): Promise<void> {
        this.posts.clear();
        const folder = this.getResearchFolder();
        if (!folder) return;

        const abstract = this.app.vault.getAbstractFileByPath(folder);
        if (!(abstract instanceof TFolder)) return;

        await this.scanFolder(abstract, undefined);

        // Load linked notes
        await this.loadLinks();
        for (const vaultPath of this.linkedPaths) {
            const file = this.app.vault.getAbstractFileByPath(vaultPath);
            if (file instanceof TFile) {
                const post = await this.parseLinkedFile(file);
                if (post) this.posts.set(post.filePath, post);
            }
        }
    }

    /** Recursively scan a folder for research posts. */
    private async scanFolder(folder: TFolder, subfolder: string | undefined): Promise<void> {
        for (const child of folder.children) {
            if (child instanceof TFile && child.extension === 'md') {
                const post = await this.parseFile(child);
                if (post) {
                    post.subfolder = subfolder;
                    this.posts.set(post.filePath, post);
                }
            } else if (child instanceof TFolder) {
                await this.scanFolder(child, child.name);
            }
        }
    }

    /** Get the active project's Research/ folder path, or undefined. */
    getResearchFolder(): string | undefined {
        const project = this.plugin.sceneManager?.activeProject;
        if (!project) return undefined;
        return project.researchFolder;
    }

    private async parseFile(file: TFile): Promise<ResearchPost | null> {
        const content = await this.app.vault.read(file);
        const fmMatch = content.match(/^---\r?\n([\s\S]*?)\r?\n---/);
        if (!fmMatch) return null;

        try {
            const fm = parseYaml(fmMatch[1]);
            if (fm?.type !== 'research') return null;

            const body = content.substring(fmMatch[0].length).trim();

            return {
                filePath: file.path,
                title: resolveLibraryEntityName(fm.title, file.path, fm.name),
                researchType: fm.researchType || 'note',
                tags: Array.isArray(fm.tags) ? fm.tags : [],
                body,
                sourceUrl: fm.sourceUrl || undefined,
                resolved: fm.resolved ?? false,
                inactive: Object.prototype.hasOwnProperty.call(fm, 'active')
                    ? fm.active !== true
                    : fm.inactive === true,
                created: fm.created || file.stat.ctime.toString(),
                modified: fm.modified || new Date(file.stat.mtime).toISOString(),
            };
        } catch {
            return null;
        }
    }

    // ────────────────────────────────────
    //  Getters
    // ────────────────────────────────────

    exportSnapshot(): Map<string, ResearchPost> {
        return new Map(this.posts);
    }

    restoreSnapshot(posts: Map<string, ResearchPost>): void {
        this.posts = new Map(posts);
    }

    getAllPosts(includeInactive = false): ResearchPost[] {
        const posts = Array.from(this.posts.values());
        return includeInactive ? posts : posts.filter(post => !post.inactive);
    }

    getPost(filePath: string): ResearchPost | undefined {
        return this.posts.get(filePath);
    }

    /** Get all unique tags across all research posts. */
    getAllTags(): string[] {
        const tags = new Set<string>();
        for (const post of this.getAllPosts()) {
            post.tags.forEach(t => tags.add(t));
        }
        return Array.from(tags).sort();
    }

    /** Count of unresolved questions. */
    getOpenQuestionCount(): number {
        let count = 0;
        for (const post of this.getAllPosts()) {
            if (post.researchType === 'question' && !post.resolved) count++;
        }
        return count;
    }

    // ────────────────────────────────────
    //  Search
    // ────────────────────────────────────

    /**
     * Search posts by free text query. Matches title, body, and tags.
     * Uses case-insensitive prefix matching for a lightweight fuzzy feel.
     */
    search(query: string, tagFilter?: string, typeFilter?: ResearchType, includeInactive = false): ResearchPost[] {
        let results = this.getAllPosts(includeInactive);

        if (typeFilter) {
            results = results.filter(p => p.researchType === typeFilter);
        }

        if (tagFilter) {
            const tag = tagFilter.toLowerCase();
            results = results.filter(p => p.tags.some(t => t.toLowerCase() === tag));
        }

        if (query.trim()) {
            const locale = this.plugin.sceneManager?.getEffectiveLocale(query) ?? DEFAULT_STORYLINE_LOCALE;
            const terms = tokenizeWords(query.toLowerCase(), locale).filter(Boolean);
            results = results.filter(post => {
                const haystack = `${post.title} ${post.body} ${post.tags.join(' ')}`.toLowerCase();
                return terms.every(term => haystack.includes(term));
            });
        }

        return results;
    }

    /**
     * Auto-suggest: find posts relevant to the current scene's metadata.
     * Matches scene characters, location, tags, and title words against post content.
     */
    autoSuggest(sceneKeywords: string[], includeInactive = false): ResearchPost[] {
        if (sceneKeywords.length === 0) return [];
        const lower = sceneKeywords.map(k => k.toLowerCase());

        const scored: { post: ResearchPost; score: number }[] = [];
        for (const post of this.getAllPosts(includeInactive)) {
            const haystack = `${post.title} ${post.body} ${post.tags.join(' ')}`.toLowerCase();
            let score = 0;
            for (const kw of lower) {
                if (kw.length < 2) continue;
                if (haystack.includes(kw)) score++;
            }
            if (score > 0) scored.push({ post, score });
        }

        scored.sort((a, b) => b.score - a.score);
        return scored.map(s => s.post);
    }

    // ────────────────────────────────────
    //  CRUD
    // ────────────────────────────────────

    /** Create a new research post. Returns the created post. */
    async createPost(title: string, researchType: ResearchType, body = '', tags: string[] = [], sourceUrl?: string): Promise<ResearchPost> {
        const folder = this.getResearchFolder();
        if (!folder) throw new Error('No active project');

        await this.ensureFolder(folder);
        const safeName = title.replace(/[\\/:*?"<>|]/g, '-').substring(0, 100);
        let filePath = normalizePath(`${folder}/${safeName}.md`);

        // Handle name collision
        let counter = 1;
        while (this.app.vault.getAbstractFileByPath(filePath)) {
            filePath = normalizePath(`${folder}/${safeName} (${counter}).md`);
            counter++;
        }

        const now = new Date().toISOString();
        const fm: Record<string, unknown> = {
            type: 'research',
            title,
            researchType,
            tags,
            active: true,
            created: now,
            modified: now,
        };
        if (sourceUrl) fm.sourceUrl = sourceUrl;
        if (researchType === 'question') fm.resolved = false;

        const content = `---\n${stringifyYaml(fm)}---\n${body}\n`;
        await this.app.vault.create(filePath, content);

        const post: ResearchPost = {
            filePath,
            title,
            researchType,
            tags,
            body,
            sourceUrl,
            resolved: researchType === 'question' ? false : undefined,
            created: now,
            modified: now,
        };
        this.posts.set(filePath, post);
        return post;
    }

    /** Update frontmatter fields on an existing post. */
    async updatePost(filePath: string, updates: Partial<Pick<ResearchPost, 'title' | 'tags' | 'researchType' | 'sourceUrl' | 'resolved' | 'inactive'>>): Promise<void> {
        const post = this.posts.get(filePath);
        if (!post) return;

        const file = this.app.vault.getAbstractFileByPath(filePath);
        if (!(file instanceof TFile)) return;

        const content = await this.app.vault.read(file);
        const fmMatch = content.match(/^---\r?\n([\s\S]*?)\r?\n---/);
        if (!fmMatch) return;

        const fm = parseYaml(fmMatch[1]) || {};
        const body = content.substring(fmMatch[0].length);

        if (updates.title !== undefined) { fm.title = updates.title; post.title = updates.title; }
        if (updates.tags !== undefined) { fm.tags = updates.tags; post.tags = updates.tags; }
        if (updates.researchType !== undefined) { fm.researchType = updates.researchType; post.researchType = updates.researchType; }
        if (updates.sourceUrl !== undefined) { fm.sourceUrl = updates.sourceUrl; post.sourceUrl = updates.sourceUrl; }
        if (updates.resolved !== undefined) { fm.resolved = updates.resolved; post.resolved = updates.resolved; }
        if (updates.inactive !== undefined) {
            fm.active = !updates.inactive;
            delete fm.inactive;
            post.inactive = updates.inactive;
        }

        fm.modified = new Date().toISOString();
        post.modified = fm.modified;

        const newContent = `---\n${stringifyYaml(fm)}---${body}`;
        await this.app.vault.modify(file, newContent);
    }

    /** Enable or disable a post without deleting its file. */
    async setPostActive(filePath: string, active: boolean): Promise<void> {
        await this.updatePost(filePath, { inactive: !active });
    }

    // ────────────────────────────────────
    //  Linked notes
    // ────────────────────────────────────

    /** Read the .links.json manifest from the Research/ folder. */
    private async loadLinks(): Promise<void> {
        this.linkedPaths.clear();
        this.linksLoaded = false;
        this.linksFileInvalid = false;
        this.linksLoadedFromBackup = false;
        const folder = this.getResearchFolder();
        if (!folder) {
            this.linksLoaded = true;
            return;
        }
        const linksPath = normalizePath(`${folder}/.links.json`);
        const adapter = this.app.vault.adapter;
        let foundCandidate = false;
        for (const candidate of [`${linksPath}.tmp`, linksPath, `${linksPath}.bak`]) {
            try {
                if (!await adapter.exists(candidate)) continue;
                foundCandidate = true;
                const data = JSON.parse(await adapter.read(candidate)) as unknown;
                if (!Array.isArray(data) || !data.every(entry =>
                    typeof entry === 'string'
                    || (!!entry && typeof entry === 'object' && typeof (entry as Record<string, unknown>).path === 'string')
                )) throw new Error('invalid linked-note manifest');
                this.linkedPaths = new Set(data.map(entry => typeof entry === 'string'
                    ? entry
                    : String((entry as Record<string, unknown>).path)));
                this.linksLoaded = true;
                this.linksLoadedFromBackup = candidate !== linksPath;
                return;
            } catch (error) {
                console.error(`[NarrativeLab] Could not load linked research notes from ${candidate}:`, error);
            }
        }
        this.linksFileInvalid = foundCandidate;
        this.linksLoaded = !foundCandidate;
    }

    /** Persist the linked paths to .links.json. */
    private async saveLinks(): Promise<void> {
        if (this.linksFileInvalid) {
            throw new Error('Cannot save linked research notes because the existing manifest is unreadable.');
        }
        const folder = this.getResearchFolder();
        if (!folder) return;
        await this.ensureFolder(folder);
        const linksPath = normalizePath(`${folder}/.links.json`);
        const data = Array.from(this.linkedPaths);
        const adapter = this.app.vault.adapter;
        const content = JSON.stringify(data, null, 2);
        const tempPath = `${linksPath}.tmp`;
        const backupPath = `${linksPath}.bak`;
        await adapter.write(tempPath, content);
        if (!this.linksLoadedFromBackup && await adapter.exists(linksPath)) {
            await adapter.write(backupPath, await adapter.read(linksPath));
        }
        await adapter.write(linksPath, content);
        await adapter.remove(tempPath).catch(() => undefined);
        this.linksLoadedFromBackup = false;
    }

    /** Parse any vault file as a linked research post. */
    private async parseLinkedFile(file: TFile): Promise<ResearchPost | null> {
        const ext = file.extension.toLowerCase();
        const isBinary = !['md', 'txt', 'csv', 'json', 'html', 'xml'].includes(ext);

        let title = file.basename;
        let tags: string[] = [];
        let body = '';
        let researchType: ResearchType = 'note';
        let inactive = false;

        if (isBinary) {
            // Images and other binary files — show as image type with path reference
            if (['png', 'jpg', 'jpeg', 'gif', 'svg', 'webp', 'bmp'].includes(ext)) {
                researchType = 'image';
                body = `![[${file.path}]]`;
            } else {
                body = `Linked file: \`${file.path}\``;
            }
        } else {
            const content = await this.app.vault.read(file);
            body = content;

            if (ext === 'md') {
                const fmMatch = content.match(/^---\r?\n([\s\S]*?)\r?\n---/);
                if (fmMatch) {
                    try {
                        const fm = parseYaml(fmMatch[1]);
                        if (fm?.title) title = fm.title;
                        if (Array.isArray(fm?.tags)) tags = fm.tags;
                        inactive = Object.prototype.hasOwnProperty.call(fm || {}, 'active')
                            ? fm.active !== true
                            : fm?.inactive === true;
                    } catch { /* ignore bad frontmatter */ }
                    body = content.substring(fmMatch[0].length).trim();
                }
            }
        }

        return {
            filePath: file.path,
            title,
            researchType,
            tags,
            body,
            inactive,
            isLinked: true,
            created: new Date(file.stat.ctime).toISOString(),
            modified: new Date(file.stat.mtime).toISOString(),
        };
    }

    /** Link an existing vault note to the Research panel. */
    async linkNote(vaultPath: string): Promise<void> {
        // Ensure linkedPaths is loaded from disk before modifying
        if (!this.linksLoaded) {
            await this.loadLinks();
        }
        const alreadyLinked = this.linkedPaths.has(vaultPath);
        this.linkedPaths.add(vaultPath);
        try {
            await this.saveLinks();
        } catch (error) {
            if (!alreadyLinked) this.linkedPaths.delete(vaultPath);
            throw error;
        }
        // Index it immediately
        const file = this.app.vault.getAbstractFileByPath(vaultPath);
        if (file instanceof TFile) {
            const post = await this.parseLinkedFile(file);
            if (post) this.posts.set(post.filePath, post);
        }
    }

    /** Unlink a note from the Research panel (does not delete the file). */
    async unlinkNote(vaultPath: string): Promise<void> {
        if (!this.linksLoaded) {
            await this.loadLinks();
        }
        const linked = this.linkedPaths.has(vaultPath);
        const post = this.posts.get(vaultPath);
        this.linkedPaths.delete(vaultPath);
        this.posts.delete(vaultPath);
        try {
            await this.saveLinks();
        } catch (error) {
            if (linked) this.linkedPaths.add(vaultPath);
            if (post) this.posts.set(vaultPath, post);
            throw error;
        }
    }

    /** Check if a path is a linked note. */
    isLinked(vaultPath: string): boolean {
        return this.linkedPaths.has(vaultPath);
    }

    /** Get all linked note paths. */
    getLinkedPaths(): string[] {
        return Array.from(this.linkedPaths);
    }

    // ────────────────────────────────────
    //  Binder adoption / conversion helpers
    // ────────────────────────────────────

    isPathUnderResearch(filePath: string): boolean {
        const folder = this.getResearchFolder();
        if (!folder) return false;
        const root = normalizePath(folder);
        const path = normalizePath(filePath);
        return path === root || path.startsWith(`${root}/`);
    }

    /** Drop a path from the in-memory Research index (file may still exist). */
    forgetPath(filePath: string): void {
        this.posts.delete(normalizePath(filePath));
        this.posts.delete(filePath);
    }

    /**
     * Adopt a Markdown file under Research/ as `type: research`.
     * Plain notes and scene/note binder files are rewritten; other entity
     * types (character/location/codex) are left alone.
     */
    async ensureResearchFileIndexed(file: TFile): Promise<ResearchPost | null> {
        if (file.extension !== 'md') return null;
        if (!this.isPathUnderResearch(file.path)) return null;
        if (file.name === '.links.json') return null;

        const path = normalizePath(file.path);
        const content = await this.app.vault.read(file);
        const fmMatch = content.match(/^---\r?\n([\s\S]*?)\r?\n---/);
        let fm: Record<string, unknown> = {};
        let body = content;
        if (fmMatch) {
            try {
                fm = (parseYaml(fmMatch[1]) || {}) as Record<string, unknown>;
            } catch {
                return null;
            }
            body = content.substring(fmMatch[0].length).trim();
        }

        const type = typeof fm.type === 'string' ? fm.type : '';
        if (type && type !== 'research' && type !== 'scene') {
            // Characters / locations / codex entries must not be hijacked.
            return null;
        }

        if (type !== 'research') {
            const now = new Date().toISOString();
            const nextFm: Record<string, unknown> = {
                type: 'research',
                title: resolveLibraryEntityName(fm.title, file.path, fm.name) || file.basename,
                researchType: 'note',
                tags: Array.isArray(fm.tags) ? fm.tags : [],
                active: fm.active !== false,
                created: fm.created || now,
                modified: now,
            };
            // Preserve useful research-ish fields if present.
            if (typeof fm.sourceUrl === 'string' && fm.sourceUrl.trim()) {
                nextFm.sourceUrl = fm.sourceUrl;
                nextFm.researchType = 'webclip';
            }
            if (typeof fm.researchType === 'string') nextFm.researchType = fm.researchType;
            if (fm.resolved !== undefined) nextFm.resolved = fm.resolved;

            const newContent = `---\n${stringifyYaml(nextFm)}---\n${body}\n`;
            await this.app.vault.modify(file, newContent);
        }

        const post = await this.parseFile(file);
        if (post) this.posts.set(path, post);
        return post;
    }

    /** Re-index after a vault create/rename into (or out of) Research/. */
    async adoptMovedResearchFile(file: TFile, oldPath?: string): Promise<void> {
        if (file.extension !== 'md') return;
        const path = normalizePath(file.path);
        const prev = oldPath ? normalizePath(oldPath) : undefined;
        if (prev && prev !== path) this.forgetPath(prev);

        if (!this.isPathUnderResearch(path)) {
            this.forgetPath(path);
            return;
        }
        await this.ensureResearchFileIndexed(file);
    }

    async handleFileChange(file: TFile): Promise<void> {
        if (!this.isPathUnderResearch(file.path)) return;
        await this.ensureResearchFileIndexed(file);
    }

    async handleFileCreate(file: TFile): Promise<void> {
        await this.handleFileChange(file);
    }

    handleFileDelete(filePath: string): void {
        this.forgetPath(filePath);
        // Keep linked-manifest entries unless explicitly unlinked.
    }

    async handleFileRename(file: TFile, oldPath: string): Promise<void> {
        await this.adoptMovedResearchFile(file, oldPath);
        // Rebase linked paths when a linked file moves.
        // Always load the manifest first — linkedPaths may be empty before Research opens.
        if (!this.linksLoaded) await this.loadLinks();
        const oldN = normalizePath(oldPath);
        const newN = normalizePath(file.path);
        if (this.linkedPaths.has(oldN) || this.linkedPaths.has(oldPath)) {
            this.linkedPaths.delete(oldN);
            this.linkedPaths.delete(oldPath);
            this.linkedPaths.add(newN);
            await this.saveLinks();
        }
    }

    getUniquePathInFolder(folder: string, fileName: string, currentPath?: string): string {
        const current = currentPath ? normalizePath(currentPath) : '';
        const dot = fileName.lastIndexOf('.');
        const base = dot >= 0 ? fileName.slice(0, dot) : fileName;
        const ext = dot >= 0 ? fileName.slice(dot) : '';
        let candidate = normalizePath(`${folder}/${fileName}`);
        let dedupe = 1;
        while (this.app.vault.getAbstractFileByPath(candidate)
            && normalizePath(candidate) !== current) {
            candidate = normalizePath(`${folder}/${base} (${dedupe})${ext}`);
            dedupe++;
        }
        return candidate;
    }

    // ────────────────────────────────────
    //  Helpers
    // ────────────────────────────────────

    private async ensureFolder(path: string): Promise<void> {
        await ensureVaultFolder(this.app, path);
    }
}
/* eslint-enable @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-assignment -- end of file-wide suppression block opened at line 1 */
