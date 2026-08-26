/* eslint-disable @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-return, @typescript-eslint/no-unnecessary-type-assertion -- Obsidian's API surface and several untyped third-party libraries force dynamic dispatch; floating promises are intentional in DOM/event handlers; matching enable at end of file */
import { hydrateUniversalFieldsFromTopLevel, mergeUniversalFieldsForSafeSave, mirrorUniversalFieldsToTopLevel } from './FieldTemplateService';
import { App, TFile, TFolder, normalizePath, parseYaml, stringifyYaml } from 'obsidian';
import {
    CodexCategoryDef,
    CodexEntry,
    UNCATEGORIZED_CATEGORY_ID,
    getBuiltinCodexCategory,
    makeUncategorizedCodexCategory,
    withLinkingSection,
} from '../models/Codex';
import { collectMarkdownFiles, isExcalidrawFilePath, isLibraryEntityMarkdownFile, loadWithStampCache, setCachedEntry, fileStamp, rememberEntityAfterSave } from './EntityFileCache';
import { resolveLibraryEntityName } from '../utils/libraryEntityName';
import { coerceString, coerceStringList, coerceText } from '../utils/narrow';
import { ensureVaultFolder } from '../utils/vaultFolders';
import {
    hydrateCustomFieldsFromTopLevel,
    applyDefinedFrontmatterField,
    getLibraryProfilePropertyOrder,
    mergeCustomFieldsForSafeSave,
    mirrorCustomFieldsToTopLevel,
    orderLibraryEntityFrontmatter,
    RESERVED_TOP_LEVEL_KEYS,
} from '../utils/libraryProfilePropertyOrder';

export interface CodexSaveOptions {
    /** Snapshot loaded when the editor opened. Unchanged fields are rebased onto disk. */
    baseline?: CodexEntry;
}

function sameEntryValue(left: unknown, right: unknown): boolean {
    if (left === right) return true;
    try { return JSON.stringify(left) === JSON.stringify(right); } catch { return false; }
}

function reconcileEditedMapping<T>(
    disk: Record<string, T> | undefined,
    live: Record<string, T> | undefined,
    baseline: Record<string, T> | undefined,
): Record<string, T> | undefined {
    const result: Record<string, T> = { ...(disk || {}) };
    const keys = new Set([...Object.keys(baseline || {}), ...Object.keys(live || {})]);
    for (const key of keys) {
        const liveHas = Object.prototype.hasOwnProperty.call(live || {}, key);
        const baselineHas = Object.prototype.hasOwnProperty.call(baseline || {}, key);
        const liveValue = live?.[key];
        const baselineValue = baseline?.[key];
        if (liveHas === baselineHas && sameEntryValue(liveValue, baselineValue)) continue;
        if (liveHas) result[key] = liveValue as T;
        else delete result[key];
    }
    return Object.keys(result).length ? result : undefined;
}

/**
 * Manages generic Codex entries — loading, saving, creating, and deleting
 * .md files for any Codex category (Items, Creatures, Lore, Organizations,
 * Culture, Systems, and user-defined custom categories).
 *
 * Characters and Locations retain their specialised managers;
 * CodexManager handles everything else inside the project's Library/ folder.
 */
export class CodexManager {
    private app: App;

    /**  category-id → Map<filePath, CodexEntry> */
    private entriesByCategory: Map<string, Map<string, CodexEntry>> = new Map();

    /** Resolved category definitions (built-in + custom) */
    private categoryDefs: Map<string, CodexCategoryDef> = new Map();

    constructor(app: App) {
        this.app = app;
    }

    // ── Category management ────────────────────────────

    /**
     * Initialise category definitions from enabled ids and any custom defs.
     * Called once on project load / settings change.
     *
     * @param enabledIds   e.g. ['items', 'creatures', 'my-custom']
     * @param customDefs   User-created category definitions (from settings)
     */
    initCategories(
        enabledIds: string[],
        customDefs: CodexCategoryDef[] = [],
    ): void {
        this.categoryDefs.clear();
        for (const id of enabledIds) {
            const builtin = getBuiltinCodexCategory(id);
            const override = customDefs.find(c => c.id === id);
            if (builtin) {
                // Issue #209 — ensure every category exposes the shared
                // Linking & Matching section (aliases, type, case-sensitivity,
                // exclude terms) so codex entries are consistent across types.
                // Folder stays on the built-in/English path unless explicitly set;
                // label may be a localized/custom display name.
                this.categoryDefs.set(id, withLinkingSection({
                    ...builtin,
                    label: override?.label || builtin.label,
                    folder: override?.folder || builtin.folder,
                    icon: override?.icon || builtin.icon,
                }));
            } else {
                if (override) this.categoryDefs.set(id, withLinkingSection(override));
            }
        }
        // Library-root Markdown files always remain a non-deletable category,
        // while its tab label/icon may be customized like other fixed categories.
        const uncategorized = makeUncategorizedCodexCategory();
        const uncategorizedOverride = customDefs.find(c => c.id === UNCATEGORIZED_CATEGORY_ID);
        this.categoryDefs.set(UNCATEGORIZED_CATEGORY_ID, {
            ...uncategorized,
            label: uncategorizedOverride?.label || uncategorized.label,
            icon: uncategorizedOverride?.icon || uncategorized.icon,
        });
    }

    /** All resolved category definitions (respects current enabled list). */
    getCategories(): CodexCategoryDef[] {
        return Array.from(this.categoryDefs.values());
    }

    /** Lookup a single category definition. */
    getCategoryDef(id: string): CodexCategoryDef | undefined {
        return this.categoryDefs.get(id);
    }

    /** Keep a category visible without wiping already-loaded entries. */
    registerCategoryDef(def: CodexCategoryDef): void {
        if (!def?.id) return;
        this.categoryDefs.set(def.id, withLinkingSection(def));
    }

    /**
     * Update Library folder basename and optional display label.
     * Does not change the stable category id / frontmatter type.
     */
    setCategoryFolder(id: string, folderName: string, label?: string): void {
        const def = this.categoryDefs.get(id);
        if (!def) return;
        const name = folderName.trim();
        if (!name) return;
        const nextLabel = (label ?? def.label ?? name).trim() || name;
        this.categoryDefs.set(id, { ...def, folder: name, label: nextLabel });
    }

    // ── Load ───────────────────────────────────────────

    /**
     * Load all entries for every enabled category from the Library folder.
     * Expects structure:  `codexFolder/<CategoryFolder>/entry.md`
     */
    async loadAll(codexFolder: string): Promise<void> {
        this.entriesByCategory.clear();
        const adapter = this.app.vault.adapter;

        // Loading is read-only. Missing Library folders represent an empty
        // library and are created lazily when the first entry is added.
        if (!await adapter.exists(codexFolder)) return;

        for (const [catId, catDef] of this.categoryDefs) {
            const catMap = new Map<string, CodexEntry>();
            if (catId === UNCATEGORIZED_CATEGORY_ID) {
                await this.scanRootFolder(codexFolder, catDef, catMap);
            } else {
                const catFolder = normalizePath(`${codexFolder}/${catDef.folder}`);
                if (await adapter.exists(catFolder)) {
                    await this.scanFolder(catFolder, catDef, catMap);
                }
            }
            this.entriesByCategory.set(catId, catMap);
        }
    }

    /**
     * Load entries for a single category.
     */
    async loadCategory(codexFolder: string, categoryId: string): Promise<void> {
        const catDef = this.categoryDefs.get(categoryId);
        if (!catDef) return;

        const catMap = new Map<string, CodexEntry>();
        if (categoryId === UNCATEGORIZED_CATEGORY_ID) {
            await this.scanRootFolder(codexFolder, catDef, catMap);
            this.entriesByCategory.set(categoryId, catMap);
            return;
        }
        const catFolder = normalizePath(`${codexFolder}/${catDef.folder}`);
        const adapter = this.app.vault.adapter;
        if (await adapter.exists(catFolder)) {
            await this.scanFolder(catFolder, catDef, catMap);
        }
        this.entriesByCategory.set(categoryId, catMap);
    }

    private async scanFolder(
        folderPath: string,
        catDef: CodexCategoryDef,
        catMap: Map<string, CodexEntry>,
    ): Promise<void> {
        const files = await collectMarkdownFiles(this.app, folderPath);
        for (const file of files) {
            const fp = normalizePath(file.path);
            const entry = await loadWithStampCache(
                this.app,
                `codex:${catDef.id}`,
                file,
                (content, path) => this.parseEntry(content, path, catDef, /*folderFallback*/ true),
            );
            if (entry) catMap.set(fp, entry);
        }
    }

    private async scanRootFolder(
        folderPath: string,
        catDef: CodexCategoryDef,
        catMap: Map<string, CodexEntry>,
    ): Promise<void> {
        const folder = this.app.vault.getAbstractFileByPath(normalizePath(folderPath));
        if (!(folder instanceof TFolder)) return;
        for (const child of folder.children) {
            if (!(child instanceof TFile) || !isLibraryEntityMarkdownFile(child)) continue;
            const fp = normalizePath(child.path);
            const entry = await loadWithStampCache(
                this.app,
                `codex:${catDef.id}`,
                child,
                (content, path) => this.parseEntry(content, path, catDef, true),
            );
            if (entry) catMap.set(fp, entry);
        }
    }

    // ── External file ingestion ────────────────────────

    /**
     * Try to add a single file from an external folder scan.
     * Tests against all enabled codex categories.
     * Returns true if the file matched any category.
     */
    addFile(content: string, filePath: string): boolean {
        if (isExcalidrawFilePath(filePath)) return false;
        for (const [catId, catDef] of this.categoryDefs) {
            if (catId === UNCATEGORIZED_CATEGORY_ID) continue;
            const entry = this.parseEntry(content, filePath, catDef);
            if (entry) {
                let catMap = this.entriesByCategory.get(catId);
                if (!catMap) {
                    catMap = new Map();
                    this.entriesByCategory.set(catId, catMap);
                }
                if (!catMap.has(filePath)) {
                    catMap.set(filePath, entry);
                    const file = this.app.vault.getAbstractFileByPath(normalizePath(filePath));
                    if (file instanceof TFile) {
                        setCachedEntry(`codex:${catId}`, filePath, fileStamp(file), entry);
                    }
                    return true;
                }
            }
        }
        return false;
    }

    // ── Query ──────────────────────────────────────────

    /** All entries for a category, sorted by name. */
    getEntries(categoryId: string): CodexEntry[] {
        const catMap = this.entriesByCategory.get(categoryId);
        if (!catMap) return [];
        return Array.from(catMap.values()).sort((a, b) =>
            a.name.toLowerCase().localeCompare(b.name.toLowerCase()),
        );
    }

    /** Get a single entry by file path. */
    getEntry(filePath: string): CodexEntry | undefined {
        const path = normalizePath(filePath || '');
        if (!path) return undefined;
        for (const catMap of this.entriesByCategory.values()) {
            const direct = catMap.get(path) || catMap.get(filePath);
            if (direct) return direct;
            for (const [key, entry] of catMap) {
                if (normalizePath(key) === path) return entry;
            }
        }
        return undefined;
    }

    /** Find an entry by note title or file basename (Unicode-safe fallback). */
    findByFileNameOrName(name: string): CodexEntry | undefined {
        const key = String(name || '').replace(/\.md$/i, '').trim().toLowerCase();
        if (!key) return undefined;
        return this.getAllEntries().find(entry => {
            const entryName = String(entry.name || '').trim().toLowerCase();
            const base = normalizePath(entry.filePath).split('/').pop()?.replace(/\.md$/i, '').toLowerCase() || '';
            return entryName === key || base === key;
        });
    }

    /**
     * Register a vault note that the last Library scan missed (path
     * normalization, series vs project Library, just-created canvas files).
     */
    async ingestVaultFile(file: TFile, catDef: CodexCategoryDef): Promise<CodexEntry | null> {
        const path = normalizePath(file.path);
        const existing = this.getEntry(path);
        if (existing) return existing;
        const content = await this.app.vault.cachedRead(file);
        const entry = this.parseEntry(content, path, catDef, true);
        if (!entry) return null;
        if (!this.categoryDefs.has(catDef.id)) {
            this.categoryDefs.set(catDef.id, withLinkingSection(catDef));
        }
        let catMap = this.entriesByCategory.get(catDef.id);
        if (!catMap) {
            catMap = new Map();
            this.entriesByCategory.set(catDef.id, catMap);
        }
        catMap.set(path, entry);
        return entry;
    }

    /** Find entry by name within a category (case-insensitive). */
    findByName(categoryId: string, name: string): CodexEntry | undefined {
        const lower = name.toLowerCase();
        const entries = this.getEntries(categoryId);
        return entries.find(e => e.name.toLowerCase() === lower);
    }

    exportSnapshot(): Map<string, Map<string, CodexEntry>> {
        const out = new Map<string, Map<string, CodexEntry>>();
        for (const [categoryId, entries] of this.entriesByCategory) {
            out.set(categoryId, new Map(entries));
        }
        return out;
    }

    restoreSnapshot(entries: Map<string, Map<string, CodexEntry>>): void {
        this.entriesByCategory = new Map();
        for (const [categoryId, categoryEntries] of entries) {
            this.entriesByCategory.set(categoryId, new Map(categoryEntries));
        }
    }

    /** All entries across every category. */
    getAllEntries(): CodexEntry[] {
        const all: CodexEntry[] = [];
        for (const catMap of this.entriesByCategory.values()) {
            for (const entry of catMap.values()) all.push(entry);
        }
        return all.sort((a, b) =>
            a.name.toLowerCase().localeCompare(b.name.toLowerCase()),
        );
    }

    /** Total entry count across all categories. */
    get totalCount(): number {
        let count = 0;
        for (const catMap of this.entriesByCategory.values()) count += catMap.size;
        return count;
    }

    // ── Create ─────────────────────────────────────────

    /**
     * Create a new entry .md file.
     */
    async createEntry(
        codexFolder: string,
        categoryId: string,
        name: string,
    ): Promise<CodexEntry> {
        const catDef = this.categoryDefs.get(categoryId);
        if (!catDef) throw new Error(`Unknown codex category: ${categoryId}`);

        const catFolder = normalizePath(`${codexFolder}/${catDef.folder}`);
        await this.ensureFolder(catFolder);

        const safeName = name.replace(/[\\/:*?"<>|]/g, '-');
        const filePath = normalizePath(`${catFolder}/${safeName}.md`);

        if (this.app.vault.getAbstractFileByPath(filePath)) {
            throw new Error(`Entry already exists: ${filePath}`);
        }

        const now = new Date().toISOString().split('T')[0];
        const fm: Record<string, unknown> = {
            name,
            created: now,
            modified: now,
        };
        if (categoryId !== UNCATEGORIZED_CATEGORY_ID) {
            fm.type = catDef.id;
        }

        await this.app.vault.create(filePath, `---\n${stringifyYaml(fm)}---\n`);

        const entry: CodexEntry = { filePath, type: catDef.id, name, created: now, modified: now };
        let catMap = this.entriesByCategory.get(categoryId);
        if (!catMap) {
            catMap = new Map();
            this.entriesByCategory.set(categoryId, catMap);
        }
        catMap.set(filePath, entry);
        return entry;
    }

    // ── Save ───────────────────────────────────────────

    /**
     * Save an entry back to its .md file.
     */
    async saveEntry(entry: CodexEntry, options: CodexSaveOptions = {}): Promise<void> {
        const normalizedPath = normalizePath(entry.filePath);
        const file = this.app.vault.getAbstractFileByPath(normalizedPath);
        if (!(file instanceof TFile)) {
            throw new Error(`Codex entry file not found: ${normalizedPath}`);
        }

        const catDef = this.categoryDefs.get(entry.type);
        const fieldKeys = catDef?.fieldKeys ?? [];

        const content = await this.app.vault.read(file);
        const existingFm = this.extractFrontmatter(content);
        if (/^[\uFEFF\u200B-\u200F\u2028-\u202F]*---\r?\n/.test(content) && !existingFm) {
            throw new Error(`Codex frontmatter is unreadable; refusing to overwrite ${normalizedPath}`);
        }
        const diskFm = existingFm ?? {};
        const body = this.extractBody(content);

        const fm: Record<string, unknown> = { ...diskFm };
        const uncategorizedDef = this.categoryDefs.get(UNCATEGORIZED_CATEGORY_ID);
        const isUncategorizedEntry = uncategorizedDef
            && this.entriesByCategory.get(UNCATEGORIZED_CATEGORY_ID)?.has(normalizedPath);
        if (isUncategorizedEntry) {
            const preservedType = diskFm.type;
            if (preservedType && preservedType !== UNCATEGORIZED_CATEGORY_ID) {
                fm.type = preservedType;
            } else {
                delete fm.type;
            }
        } else {
            fm.type = entry.type;
        }
        const baseline = options.baseline;
        const changedSinceBaseline = (key: string): boolean =>
            !baseline || !sameEntryValue(entry[key], baseline[key]);
        if (changedSinceBaseline('name') || !coerceString(fm.name).trim()) fm.name = entry.name;
        fm.modified = new Date().toISOString().split('T')[0];
        if (entry.created && (changedSinceBaseline('created') || !fm.created)) fm.created = entry.created;

        // Standard fields for this category
        for (const key of fieldKeys) {
            if (key === 'name') continue;
            if (!changedSinceBaseline(key)) continue;
            const val = entry[key];
            applyDefinedFrontmatterField(fm, key, val);
        }

        // Series-ready: books list
        if (changedSinceBaseline('books')) applyDefinedFrontmatterField(fm, 'books', entry.books);

        const previousCustom = diskFm.custom && typeof diskFm.custom === 'object' && !Array.isArray(diskFm.custom)
            ? diskFm.custom as Record<string, string>
            : undefined;
        const diskCustom = hydrateCustomFieldsFromTopLevel(diskFm, previousCustom, entry.type);
        const resolvedCustom = baseline
            ? reconcileEditedMapping(diskCustom, entry.custom, baseline.custom)
            : hydrateCustomFieldsFromTopLevel(
                diskFm,
                mergeCustomFieldsForSafeSave(previousCustom, entry.custom),
                entry.type,
            );
        // Custom fields
        if (resolvedCustom && Object.keys(resolvedCustom).length > 0) {
            fm.custom = resolvedCustom;
        } else {
            delete fm.custom;
        }
        mirrorCustomFieldsToTopLevel(fm, resolvedCustom, entry.type, previousCustom);

        // Universal field template values
        const previousUniversal = diskFm.universalFields && typeof diskFm.universalFields === 'object'
            && !Array.isArray(diskFm.universalFields)
            ? diskFm.universalFields as Record<string, unknown>
            : undefined;
        const diskUniversal = hydrateUniversalFieldsFromTopLevel(diskFm, previousUniversal) as
            Record<string, string | string[]> | undefined;
        const resolvedUniversal = baseline
            ? reconcileEditedMapping(diskUniversal, entry.universalFields, baseline.universalFields)
            : hydrateUniversalFieldsFromTopLevel(
                diskFm,
                mergeUniversalFieldsForSafeSave(previousUniversal, entry.universalFields),
            ) as Record<string, string | string[]> | undefined;
        if (resolvedUniversal && Object.keys(resolvedUniversal).length > 0) {
            fm.universalFields = resolvedUniversal;
        } else {
            delete fm.universalFields;
        }
        // Issue #71 — mirror to top-level YAML keys for templates that opt in
        mirrorUniversalFieldsToTopLevel(fm, resolvedUniversal);

        const finalBody = changedSinceBaseline('notes') ? (entry.notes ?? '') : body;
        const orderedFm = orderLibraryEntityFrontmatter(fm, entry.type);
        const newContent = `---\n${stringifyYaml(orderedFm)}---\n${finalBody ? '\n' + finalBody : ''}`;
        await this.app.vault.modify(file, newContent);
        entry.custom = resolvedCustom;
        entry.universalFields = resolvedUniversal;

        // Update in-memory + stamp caches together (see CharacterManager.saveCharacter).
        const saved: CodexEntry = {
            ...entry,
            filePath: normalizedPath,
            custom: resolvedCustom,
            universalFields: resolvedUniversal,
        };
        for (const [catId, catMap] of this.entriesByCategory.entries()) {
            if (!catMap.has(normalizedPath)) continue;
            catMap.set(normalizedPath, saved);
            rememberEntityAfterSave(this.app, `codex:${catId}`, normalizedPath, saved);
            break;
        }
    }

    // ── Delete ─────────────────────────────────────────

    async deleteEntry(filePath: string): Promise<void> {
        const normalizedPath = normalizePath(filePath);
        const file = this.app.vault.getAbstractFileByPath(normalizedPath);
        if (file instanceof TFile) {
            await this.app.fileManager.trashFile(file);
        }
        for (const catMap of this.entriesByCategory.values()) {
            catMap.delete(normalizedPath);
        }
    }

    // ── Rename ─────────────────────────────────────────

    async renameEntry(
        entry: CodexEntry,
        newName: string,
        codexFolder: string,
    ): Promise<CodexEntry> {
        const catDef = this.categoryDefs.get(entry.type);
        if (!catDef) throw new Error(`Unknown category: ${entry.type}`);

        const catFolder = normalizePath(`${codexFolder}/${catDef.folder}`);
        const safeName = newName.replace(/[\\/:*?"<>|]/g, '-');
        const newPath = normalizePath(`${catFolder}/${safeName}.md`);
        const oldPath = normalizePath(entry.filePath);

        const file = this.app.vault.getAbstractFileByPath(oldPath);
        if (file instanceof TFile && newPath !== oldPath) {
            await this.app.fileManager.renameFile(file, newPath);
        }

        // Update cache
        for (const catMap of this.entriesByCategory.values()) {
            if (catMap.has(oldPath)) {
                catMap.delete(oldPath);
                break;
            }
        }

        const updated: CodexEntry = { ...entry, filePath: newPath, name: newName };
        let catMap = this.entriesByCategory.get(entry.type);
        if (!catMap) {
            catMap = new Map();
            this.entriesByCategory.set(entry.type, catMap);
        }
        catMap.set(newPath, updated);
        await this.saveEntry(updated);
        return updated;
    }

    // ── Parsing helpers ────────────────────────────────

    private parseEntry(
        content: string,
        filePath: string,
        catDef: CodexCategoryDef,
        folderFallback = false,
    ): CodexEntry | null {
        const fm = this.extractFrontmatter(content);
        // If frontmatter is missing entirely, only accept when folder-based
        // fallback applies (file lives inside the category folder — issue #74).
        const safeFm = (fm ?? {}) as Partial<CodexEntry> & Record<string, unknown>;
        if (!fm && !folderFallback) return null;

        // Accept entries whose type matches the category id.
        // Folder-based fallback (issue #74): when the file already lives in
        // the category folder (e.g. user inserted a template that wiped
        // `type:`), still recognise it so it doesn't vanish from the Codex.
        if (safeFm.type !== catDef.id && !folderFallback) return null;

        const body = this.extractBody(content);

        const entry: CodexEntry = {
            filePath,
            type: catDef.id,
            name: resolveLibraryEntityName(safeFm.name, filePath, safeFm.title),
            image: coerceString(safeFm.image).trim() || undefined,
            gallery: this.parseGallery(safeFm.gallery),
            created: coerceString(safeFm.created).trim() || undefined,
            modified: coerceString(safeFm.modified).trim() || undefined,
            notes: body || coerceString(safeFm.notes) || undefined,
            custom: hydrateCustomFieldsFromTopLevel(
                safeFm,
                safeFm.custom && typeof safeFm.custom === 'object' && !Array.isArray(safeFm.custom)
                    ? safeFm.custom as Record<string, string>
                    : undefined,
                catDef.id,
            ),
            universalFields: hydrateUniversalFieldsFromTopLevel(
                safeFm,
                safeFm.universalFields && typeof safeFm.universalFields === 'object' ? safeFm.universalFields as Record<string, unknown> : undefined,
            ) as Record<string, string | string[]> | undefined,
            books: (() => {
                const books = coerceStringList(safeFm.books);
                return books.length ? books : undefined;
            })(),
        };

        // Load all standard field values
        for (const key of catDef.fieldKeys) {
            if (key === 'name' || key === 'image' || key === 'gallery') continue;
            const value = safeFm[key];
            if (value === undefined || value === null) continue;
            const field = catDef.categories.flatMap(category => category.fields)
                .find(candidate => candidate.key === key);
            if (field?.toggle) {
                entry[key] = value === true || ['true', 'yes', '1'].includes(coerceString(value).trim().toLowerCase());
                continue;
            }
            if (Array.isArray(value)) {
                const values = coerceStringList(value);
                if (values.length) entry[key] = values;
                continue;
            }
            const text = coerceText(value);
            if (text) entry[key] = text;
        }

        // Library-root notes may have originated in any deleted category, and
        // blank user categories may be authored directly through Obsidian Base.
        // Preserve unfamiliar top-level properties as visible custom fields so
        // a missing template/layout definition cannot make valid data vanish.
        const preservesLooseTopLevelFields = catDef.id === UNCATEGORIZED_CATEGORY_ID
            || (!catDef.builtIn && catDef.categories.length === 0);
        if (preservesLooseTopLevelFields) {
            const reserved = new Set([
                ...RESERVED_TOP_LEVEL_KEYS,
                'type', 'name', 'image', 'gallery', 'created', 'modified',
                'custom', 'universalFields', 'books',
                ...catDef.fieldKeys,
                ...(getLibraryProfilePropertyOrder(catDef.id)?.reservedKeys ?? []),
            ]);
            const custom = { ...(entry.custom || {}) };
            for (const [key, value] of Object.entries(safeFm)) {
                if (reserved.has(key) || value === undefined || value === null) continue;
                if (typeof value === 'string') custom[key] = value;
                else if (typeof value === 'number' || typeof value === 'boolean') {
                    custom[key] = String(value);
                } else if (Array.isArray(value)) {
                    custom[key] = value.map(String).join(', ');
                } else {
                    try {
                        const serialized = JSON.stringify(value);
                        if (typeof serialized === 'string') custom[key] = serialized;
                    } catch {
                        // Unsupported custom values are omitted instead of becoming "[object Object]".
                    }
                }
            }
            entry.custom = Object.keys(custom).length ? custom : undefined;
        }

        return entry;
    }

    private extractFrontmatter(content: string): Record<string, unknown> | null {
        // Strip BOM + invisible zero-width characters before matching
        const clean = content.replace(/[\u200B-\u200F\u2028-\u202F\uFEFF]/g, '');
        const match = clean.match(/^---\r?\n([\s\S]*?)\r?\n---/);
        if (!match) return null;
        try {
            return parseYaml(match[1]);
        } catch {
            return null;
        }
    }

    private extractBody(content: string): string {
        const clean = content.replace(/[\u200B-\u200F\u2028-\u202F\uFEFF]/g, '');
        const match = clean.match(/^---\r?\n[\s\S]*?\r?\n---\r?\n?([\s\S]*)$/);
        if (match) return match[1].trim();
        // No frontmatter delimiter — the entire file is body content.
        // Returning '' here would wipe notes when saving entries that were
        // moved into a category folder without frontmatter (issue #221).
        return clean.trim();
    }

    private parseGallery(
        value: unknown,
    ): Array<{ path: string; caption: string }> | undefined {
        if (!Array.isArray(value)) return undefined;
        const parsed: Array<{ path: string; caption: string }> = [];
        for (const item of value) {
            if (!item || typeof item !== 'object') continue;
            const p = typeof item.path === 'string' ? item.path : '';
            const c = typeof item.caption === 'string' ? item.caption : '';
            if (!p) continue;
            parsed.push({ path: p, caption: c });
        }
        return parsed.length ? parsed : undefined;
    }

    private async ensureFolder(folderPath: string): Promise<void> {
        await ensureVaultFolder(this.app, folderPath);
    }
}
/* eslint-enable @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-return, @typescript-eslint/no-unnecessary-type-assertion -- end of file-wide suppression block opened at line 1 */
