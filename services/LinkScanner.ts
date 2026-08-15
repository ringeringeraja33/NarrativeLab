/* eslint-disable @typescript-eslint/no-unused-vars, no-useless-escape -- Obsidian's API surface and several untyped third-party libraries force dynamic dispatch; floating promises are intentional in DOM/event handlers; matching enable at end of file */
/**
 * LinkScanner — extracts [[wikilinks]] AND plain-text character/location
 * mentions from scene body text and classifies each as a known character,
 * known location, or unclassified.
 *
 * This lets NarrativeLab surface entity mentions that appear organically in the
 * prose without requiring the author to manually add them to frontmatter
 * or wrap every name in [[wikilinks]].
 */

import { CharacterManager } from './CharacterManager';
import { LocationManager } from './LocationManager';
import { CodexManager } from './CodexManager';
import type { Scene } from '../models/Scene';

/** A single detected link with its classification */
export interface DetectedLink {
    /** Display name extracted from the wikilink or plain-text match */
    name: string;
    /** Entity type derived from cross-referencing managers */
    type: 'character' | 'location' | 'codex' | 'other';
    /** Library / Codex category id when type is `codex` */
    codexCategory?: string;
}

/** Scan result for one scene */
export interface LinkScanResult {
    /** All unique detected links, classified */
    links: DetectedLink[];
    /** Convenience: only the character names */
    characters: string[];
    /** Convenience: only the location names */
    locations: string[];
    /** Convenience: names that matched neither */
    other: string[];
}

/** An entity that references (or is referenced by) another entity */
export interface EntityReference {
    /** Display name of the referencing entity */
    name: string;
    /** Entity type */
    type: 'character' | 'location' | 'codex' | 'scene';
    /** Vault-relative file path */
    filePath: string;
    /** Codex category id (only when type === 'codex') */
    codexCategory?: string;
}

/**
 * Scans scene body text for [[wikilinks]] and plain-text name mentions,
 * then classifies them.
 */
export class LinkScanner {
    /** Cache keyed by scene filePath → scan result */
    private cache: Map<string, LinkScanResult> = new Map();
    /** Cache keyed by scene filePath → the Scene object itself, so
     *  buildEntityIndex() can read structured fields like codexLinks
     *  (issue #213: tagged Codex entries weren't shown in Referenced By). */
    private sceneCache: Map<string, Scene> = new Map();

    private characterManager: CharacterManager;
    private locationManager: LocationManager;
    private codexManager: CodexManager | null = null;

    /** Pre-built lookup sets (lowercased) — rebuilt on invalidate */
    private charNames: Set<string> = new Set();
    private locNames: Set<string> = new Set();
    private codexNames: Set<string> = new Set();

    /**
     * Maps a lowercased name/nickname to the canonical (display) character name.
     * E.g. "anna" → "Anna Svensson" when nickname is "Anna".
     */
    private charCanonical: Map<string, string> = new Map();
    /** Alias / nickname → official Codex entry name. */
    private codexCanonical: Map<string, string> = new Map();
    /** Lowercased Codex name / alias → category id. */
    private codexCategoryByName: Map<string, string> = new Map();

    /**
     * All character/location plain-text names to search for, sorted longest
     * first so that "Anna Svensson" is matched before "Anna".
     */
    private plainTextNames: string[] = [];

    /**
     * Issue #223 — per-codex-entry matching rules.
     * `codexEntryRules` maps a lowercased name (or alias) to the entry's
     * matching configuration: whether it's case-sensitive and which terms
     * should suppress a match. `codexCaseSensitiveNames` lists the names
     * that must be matched with exact case (kept in original casing).
     */
    private codexEntryRules: Map<string, { caseSensitive: boolean; excludeTerms: string[] }> = new Map();
    private codexCaseSensitiveNames: string[] = [];

    /** Last-used manual aliases (stored so internal calls can reuse them) */
    private lastManualAliases?: Record<string, string>;

    constructor(characterManager: CharacterManager, locationManager: LocationManager) {
        this.characterManager = characterManager;
        this.locationManager = locationManager;
    }

    /** Set the codex manager (called after initial construction) */
    setCodexManager(codexManager: CodexManager): void {
        this.codexManager = codexManager;
    }

    // ── Public API ─────────────────────────────────────

    /**
     * Scan a single scene's body and return classified links.
     * Returns a cached result if available.
     */
    scan(scene: Scene): LinkScanResult {
        const cached = this.cache.get(scene.filePath);
        if (cached) {
            // Keep the scene reference fresh even on cache hits
            this.sceneCache.set(scene.filePath, scene);
            return cached;
        }

        const result = this.performScan(scene);
        this.cache.set(scene.filePath, result);
        this.sceneCache.set(scene.filePath, scene);
        return result;
    }

    /**
     * Scan all scenes and return the full cache map.
     */
    scanAll(scenes: Scene[]): Map<string, LinkScanResult> {
        this.rebuildLookups(this.lastManualAliases);
        for (const scene of scenes) {
            if (!this.cache.has(scene.filePath)) {
                this.cache.set(scene.filePath, this.performScan(scene));
            }
            // Always refresh the scene reference so codexLinks stays current
            this.sceneCache.set(scene.filePath, scene);
        }
        return this.cache;
    }

    /**
     * Get a previously computed result (or null).
     */
    getResult(filePath: string): LinkScanResult | null {
        return this.cache.get(filePath) ?? null;
    }

    /**
     * Invalidate a single scene (e.g. when its body changes).
     */
    invalidate(filePath: string): void {
        this.cache.delete(filePath);
        this.sceneCache.delete(filePath);
    }

    /**
     * Clear the entire cache (e.g. after character/location changes).
     */
    invalidateAll(): void {
        this.cache.clear();
        this.sceneCache.clear();
    }

    /**
     * Rebuild the name-lookup sets from the current manager state.
     * Call once before a batch scan, or whenever entity lists change.
     *
     * @param manualAliases  Optional user-defined alias → canonical mappings
     *                       (from plugin settings.characterAliases).
     */
    rebuildLookups(manualAliases?: Record<string, string>): void {
        // Store for later internal calls
        if (manualAliases !== undefined) this.lastManualAliases = manualAliases;
        this.charNames.clear();
        this.locNames.clear();
        this.charCanonical.clear();

        // Count first-name occurrences to avoid ambiguous auto-aliases
        const firstNameCount = new Map<string, number>();
        for (const c of this.characterManager.getAllCharacters()) {
            const first = c.name.split(/\s+/)[0]?.toLowerCase();
            if (first) firstNameCount.set(first, (firstNameCount.get(first) || 0) + 1);
        }

        for (const c of this.characterManager.getAllCharacters()) {
            const nameLower = c.name.toLowerCase();
            this.charNames.add(nameLower);
            this.charCanonical.set(nameLower, c.name);

            // Auto-add first name as alias (only if unique across characters)
            const firstName = c.name.split(/\s+/)[0]?.toLowerCase();
            if (firstName && firstName !== nameLower && (firstNameCount.get(firstName) || 0) <= 1) {
                this.charNames.add(firstName);
                this.charCanonical.set(firstName, c.name);
            }

            if ((c as unknown as Record<string, unknown>).nickname) {
                // Support multiple comma-separated nicknames
                const nicknames = String((c as unknown as Record<string, unknown>).nickname)
                    .split(',')
                    .map((n: string) => n.trim())
                    .filter(Boolean);
                for (const nick of nicknames) {
                    const nickLower = nick.toLowerCase();
                    this.charNames.add(nickLower);
                    this.charCanonical.set(nickLower, c.name);
                }
            }
        }

        // Apply manual aliases (always win over auto-detected)
        if (manualAliases) {
            for (const [alias, canonical] of Object.entries(manualAliases)) {
                const aliasLower = alias.toLowerCase();
                this.charNames.add(aliasLower);
                this.charCanonical.set(aliasLower, canonical);
            }
        }

        for (const l of this.locationManager.getAllLocations()) {
            this.locNames.add(l.name.toLowerCase());
            // Support comma-separated nicknames for locations
            if (l.nickname) {
                const nicks = String(l.nickname).split(',').map(n => n.trim()).filter(Boolean);
                for (const nick of nicks) {
                    this.locNames.add(nick.toLowerCase());
                }
            }
        }
        // Also include worlds
        for (const w of this.locationManager.getAllWorlds()) {
            this.locNames.add(w.name.toLowerCase());
            // Support comma-separated nicknames for worlds
            if (w.nickname) {
                const nicks = String(w.nickname).split(',').map(n => n.trim()).filter(Boolean);
                for (const nick of nicks) {
                    this.locNames.add(nick.toLowerCase());
                }
            }
        }

        // Codex entry names, keyed to their Library category
        this.codexNames.clear();
        this.codexCanonical.clear();
        this.codexCategoryByName.clear();
        this.codexEntryRules.clear();
        this.codexCaseSensitiveNames = [];
        if (this.codexManager) {
            for (const cat of this.codexManager.getCategories()) {
                for (const entry of this.codexManager.getEntries(cat.id)) {
                    const caseSensitive = entry.caseSensitive === true;
                    const excludeRaw = typeof entry.excludeTerms === 'string' ? entry.excludeTerms : '';
                    const excludeTerms = excludeRaw
                        .split(/[,\n]/)
                        .map(term => term.trim().toLowerCase())
                        .filter(Boolean);
                    const rules = { caseSensitive, excludeTerms };
                    this.registerCodexName(entry.name, cat.id, entry.name, rules);
                    const aliasesRaw = typeof entry.aliases === 'string' ? entry.aliases : '';
                    for (const alias of aliasesRaw.split(/[,\n]/).map(a => a.trim()).filter(Boolean)) {
                        this.registerCodexName(alias, cat.id, entry.name, rules);
                    }
                    const nick = (entry as unknown as Record<string, unknown>).nickname;
                    if (typeof nick === 'string') {
                        for (const n of nick.split(',').map(part => part.trim()).filter(Boolean)) {
                            this.registerCodexName(n, cat.id, entry.name, rules);
                        }
                    }
                }
            }
        }

        // Build sorted list of all names for plain-text scanning (longest first
        // so "Anna Svensson" matches before "Anna")
        this.plainTextNames = [...this.charNames, ...this.locNames, ...this.codexNames]
            .sort((a, b) => b.length - a.length);
    }

    private registerCodexName(
        rawName: string,
        categoryId: string,
        canonicalName: string,
        rules: { caseSensitive: boolean; excludeTerms: string[] },
    ): void {
        const lower = rawName.toLowerCase();
        if (!lower || this.charNames.has(lower) || this.locNames.has(lower)) return;
        this.codexNames.add(lower);
        if (!this.codexCategoryByName.has(lower)) this.codexCategoryByName.set(lower, categoryId);
        if (!this.codexCanonical.has(lower)) this.codexCanonical.set(lower, canonicalName);
        this.codexEntryRules.set(lower, rules);
        if (rules.caseSensitive) this.codexCaseSensitiveNames.push(rawName);
    }

    /** Category id for a detected Codex / Library name, if known. */
    getCodexCategoryForName(name: string): string | undefined {
        return this.codexCategoryByName.get(name.toLowerCase());
    }

    // ── Internal ───────────────────────────────────────

    private performScan(scene: Scene): LinkScanResult {
        // Include image note caption in the scannable text
        const body = (scene.body || '') + (scene.corkboardNoteCaption ? '\n' + scene.corkboardNoteCaption : '');
        const rawLinks = this.extractWikilinks(body);

        // Ensure lookups are built (cheap if already done)
        if (this.charNames.size === 0 && this.locNames.size === 0) {
            this.rebuildLookups(this.lastManualAliases);
        }

        // Deduplicate (case-insensitive) while preserving first-seen casing
        const seen = new Map<string, string>(); // lowered → original
        for (const name of rawLinks) {
            const key = name.toLowerCase();
            if (!seen.has(key)) seen.set(key, name);
        }

        // Also scan plain text for character and location names
        const plainTextMentions = this.extractPlainTextMentions(body);
        for (const name of plainTextMentions) {
            const key = name.toLowerCase();
            // Use the canonical character name if available (maps nickname → full name)
            const canonical = this.charCanonical.get(key) || this.codexCanonical.get(key) || name;
            const canonKey = canonical.toLowerCase();
            if (!seen.has(canonKey)) seen.set(canonKey, canonical);
        }

        const links: DetectedLink[] = [];
        const characters: string[] = [];
        const locations: string[] = [];
        const other: string[] = [];

        for (const [key, name] of seen) {
            let type: DetectedLink['type'] = 'other';
            // Issue #223 — case-sensitive codex entries only match when the
            // original text casing equals the registered name's casing.
            if (this.codexNames.has(key)) {
                const rules = this.codexEntryRules.get(key);
                if (rules?.caseSensitive) {
                    // The registered case-sensitive names are stored in
                    // `codexCaseSensitiveNames` in their original casing. The
                    // current `name` preserves the first-seen casing from the
                    // text. Only keep the match if that casing is registered.
                    if (!this.codexCaseSensitiveNames.some(cs => cs.toLowerCase() === key && cs === name)) {
                        // Casing mismatch — treat as a non-match for this entry.
                        other.push(name);
                        links.push({ name, type: 'other' });
                        continue;
                    }
                }
            }
            if (this.charNames.has(key)) {
                type = 'character';
                characters.push(this.charCanonical.get(key) || name);
            } else if (this.locNames.has(key)) {
                type = 'location';
                locations.push(name);
            } else if (this.codexNames.has(key)) {
                type = 'codex';
            } else {
                other.push(name);
            }
            const display = type === 'codex'
                ? (this.codexCanonical.get(key) || name)
                : type === 'character'
                    ? (this.charCanonical.get(key) || name)
                    : name;
            links.push({
                name: display,
                type,
                ...(type === 'codex' ? { codexCategory: this.codexCategoryByName.get(key) } : {}),
            });
        }

        return { links, characters, locations, other };
    }

    /**
     * Scan plain text (excluding wikilinks) for known character names,
     * nicknames, and location names. Returns matched names (lowercased).
     */
    private extractPlainTextMentions(text: string): string[] {
        if (this.plainTextNames.length === 0) return [];

        // Strip wikilinks from the text so we don't double-count them
        const stripped = text.replace(/\[\[[^\]]+\]\]/g, ' ');

        const results: string[] = [];
        const foundKeys = new Set<string>();

        for (const nameLower of this.plainTextNames) {
            if (foundKeys.has(nameLower)) continue;

            // Issue #223 — per-entry matching rules for codex entries.
            const rules = this.codexEntryRules.get(nameLower);
            const isCaseSensitive = rules?.caseSensitive === true;
            const excludeTerms = rules?.excludeTerms ?? [];

            let matched = false;
            // Multi-language support — \b word boundaries don't exist in CJK
            // (no whitespace between tokens). Fall back to a case-insensitive
            // substring search whenever the name itself contains CJK glyphs.
            if (/[\u3400-\u4DBF\u4E00-\u9FFF\uF900-\uFAFF\u3040-\u30FF\uAC00-\uD7AF]/.test(nameLower)) {
                matched = isCaseSensitive
                    ? stripped.includes(nameLower)
                    : stripped.toLowerCase().includes(nameLower);
            } else {
                const escaped = nameLower.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
                // Case-sensitive codex entries match exact case only.
                const flags = isCaseSensitive ? '' : 'i';
                const re = new RegExp(`\\b${escaped}\\b`, flags);
                matched = re.test(stripped);
            }

            // Issue #223 — suppress the match if any exclude term appears in
            // the surrounding text. We check the whole stripped text for any
            // of the entry's exclude terms (lowercased), so "Saint" won't link
            // when "Dawnguard Saint" is present.
            if (matched && excludeTerms.length > 0) {
                const lowered = stripped.toLowerCase();
                for (const term of excludeTerms) {
                    if (lowered.includes(term)) {
                        matched = false;
                        break;
                    }
                }
            }

            if (matched) {
                foundKeys.add(nameLower);
                results.push(nameLower);
                // If this is a canonical (full) name, also mark its parts as found
                // so the shorter nickname won't create a duplicate entry
                // (the canonical name is already in the result)
            }
        }

        return results;
    }

    /**
     * Extract wikilink names from raw markdown body text.
     * Handles [[Name]] and [[Name|alias]] (returns the Name portion).
     */
    private extractWikilinks(text: string): string[] {
        const re = /\[\[([^\]]+)\]\]/g;
        const results: string[] = [];
        let m: RegExpExecArray | null;
        while ((m = re.exec(text)) !== null) {
            let link = m[1];
            // Handle [[target|display]] — keep the target (left side)
            const pipe = link.indexOf('|');
            if (pipe !== -1) link = link.substring(0, pipe);
            // Strip any heading/block refs  [[Page#heading]]
            const hash = link.indexOf('#');
            if (hash !== -1) link = link.substring(0, hash);
            const trimmed = link.trim();
            if (trimmed) results.push(trimmed);
        }
        return results;
    }

    // ── Public: arbitrary text scanning ────────────────

    /**
     * Scan an arbitrary text string for character names, location names,
     * and #tags.  Returns the same LinkScanResult shape but also includes
     * a `tags` array.
     *
     * This is used by the PlotGrid Cell Inspector so that text typed into
     * any cell is cross-referenced with the character/location databases.
     */
    scanText(text: string): LinkScanResult & { tags: string[] } {
        // Ensure lookups are built
        if (this.charNames.size === 0 && this.locNames.size === 0) {
            this.rebuildLookups(this.lastManualAliases);
        }

        const seen = new Map<string, string>(); // lowered → display name

        // 1. Wikilinks
        for (const name of this.extractWikilinks(text)) {
            const key = name.toLowerCase();
            if (!seen.has(key)) seen.set(key, name);
        }

        // 2. Plain-text character/location mentions
        for (const name of this.extractPlainTextMentions(text)) {
            const key = name.toLowerCase();
            const canonical = this.charCanonical.get(key) || this.codexCanonical.get(key) || name;
            const canonKey = canonical.toLowerCase();
            if (!seen.has(canonKey)) seen.set(canonKey, canonical);
        }

        // 3. #tags — accept any non-punctuation/whitespace run after `#`, so
        // tags like `#主角` (Chinese) or `#キャラ` (Japanese) work alongside ASCII.
        // Strip [[...]] wikilinks first so section headers like [[Page#heading]]
        // are not mistaken for #tags.
        const tagRe = /#([^\s#.,;:!?()\[\]{}'"“”‘’「」『』，。！？、]+)/g;
        const tags: string[] = [];
        const tagSeen = new Set<string>();
        let tm: RegExpExecArray | null;
        const textForTags = text.replace(/\[\[[^\]]*\]\]/g, ' ');
        while ((tm = tagRe.exec(textForTags)) !== null) {
            const tag = tm[1];
            const low = tag.toLowerCase();
            if (!tagSeen.has(low)) { tagSeen.add(low); tags.push(tag); }
        }

        // Classify
        const links: DetectedLink[] = [];
        const characters: string[] = [];
        const locations: string[] = [];
        const other: string[] = [];

        for (const [key, name] of seen) {
            let type: DetectedLink['type'] = 'other';
            if (this.charNames.has(key)) {
                type = 'character';
                characters.push(this.charCanonical.get(key) || name);
            } else if (this.locNames.has(key)) {
                type = 'location';
                locations.push(name);
            } else if (this.codexNames.has(key)) {
                type = 'codex';
            } else {
                other.push(name);
            }
            const display = type === 'codex'
                ? (this.codexCanonical.get(key) || name)
                : type === 'character'
                    ? (this.charCanonical.get(key) || name)
                    : name;
            links.push({
                name: display,
                type,
                ...(type === 'codex' ? { codexCategory: this.codexCategoryByName.get(key) } : {}),
            });
        }

        return { links, characters, locations, other, tags };
    }

    // ── Cross-entity reference index ───────────────────

    /**
     * Build a reverse-lookup index: for each entity name, which other entities
     * mention it in their text fields.
     *
     * Returns a Map keyed by lowercased entity name → array of referencing entities.
     */
    buildEntityIndex(): Map<string, EntityReference[]> {
        // Ensure lookups are built
        if (this.charNames.size === 0 && this.locNames.size === 0) {
            this.rebuildLookups(this.lastManualAliases);
        }

        const index = new Map<string, EntityReference[]>();

        const addRefs = (sourceName: string, sourceType: EntityReference['type'], sourceFilePath: string, text: string, codexCategory?: string) => {
            if (!text) return;
            const result = this.scanText(text);
            for (const link of result.links) {
                const key = link.name.toLowerCase();
                // Don't reference yourself
                if (key === sourceName.toLowerCase()) continue;
                if (!index.has(key)) index.set(key, []);
                const refs = index.get(key)!;
                // Deduplicate by filePath
                if (!refs.some(r => r.filePath === sourceFilePath)) {
                    refs.push({ name: sourceName, type: sourceType, filePath: sourceFilePath, codexCategory });
                }
            }
            // Also match #tags against entity names (e.g. #Aragorn → character Aragorn)
            for (const tag of result.tags) {
                const key = tag.toLowerCase();
                if (key === sourceName.toLowerCase()) continue;
                if (!index.has(key)) index.set(key, []);
                const refs = index.get(key)!;
                if (!refs.some(r => r.filePath === sourceFilePath)) {
                    refs.push({ name: sourceName, type: sourceType, filePath: sourceFilePath, codexCategory });
                }
            }
        };

        // Scan characters
        for (const c of this.characterManager.getAllCharacters()) {
            const textFields = [
                (c as unknown as Record<string, unknown>).backstory, (c as unknown as Record<string, unknown>).appearance, (c as unknown as Record<string, unknown>).personality,
                (c as unknown as Record<string, unknown>).internalMotivation, (c as unknown as Record<string, unknown>).externalMotivation,
                (c as unknown as Record<string, unknown>).strengths, (c as unknown as Record<string, unknown>).flaws, (c as unknown as Record<string, unknown>).fears,
                (c as unknown as Record<string, unknown>).belief, (c as unknown as Record<string, unknown>).misbelief, (c as unknown as Record<string, unknown>).notes,
            ].filter(Boolean).join('\n');
            addRefs(c.name, 'character', c.filePath, textFields);
        }

        // Scan locations and worlds
        for (const l of this.locationManager.getAllLocations()) {
            const textFields = [
                l.description, l.atmosphere, l.significance,
                l.inhabitants, l.connectedLocations, l.mapNotes, l.notes,
            ].filter(Boolean).join('\n');
            addRefs(l.name, 'location', l.filePath, textFields);
        }
        for (const w of this.locationManager.getAllWorlds()) {
            const textFields = [
                w.description, w.geography, w.culture, w.politics,
                w.magicTechnology, w.beliefs, w.economy, w.history, w.notes,
            ].filter(Boolean).join('\n');
            addRefs(w.name, 'location', w.filePath, textFields);
        }

        // Scan codex entries
        if (this.codexManager) {
            for (const entry of this.codexManager.getAllEntries()) {
                const textParts: string[] = [];
                // Gather all string values from the entry
                for (const [key, val] of Object.entries(entry)) {
                    if (key === 'filePath' || key === 'type' || key === 'name' || key === 'image' ||
                        key === 'gallery' || key === 'created' || key === 'modified' || key === 'books') continue;
                    if (typeof val === 'string' && val.length > 0) {
                        textParts.push(val);
                    }
                }
                if (entry.notes) textParts.push(entry.notes);
                const codexCat = entry.type || undefined;
                addRefs(entry.name, 'codex', entry.filePath, textParts.join('\n'), codexCat);
            }
        }

        // Scan scenes (already cached)
        for (const [filePath, result] of this.cache) {
            const sceneName = filePath.split('/').pop()?.replace(/\.md$/i, '') ?? filePath;
            for (const link of result.links) {
                const key = link.name.toLowerCase();
                if (!index.has(key)) index.set(key, []);
                const refs = index.get(key)!;
                if (!refs.some(r => r.filePath === filePath)) {
                    refs.push({ name: sceneName, type: 'scene', filePath });
                }
            }

            // Also honour explicit Codex links tagged via the Inspector
            // (scene.codexLinks). Previously these were stored in frontmatter
            // but never surfaced in the Referenced By panel because the
            // reverse-lookup only scanned scene body text. (Issue #213)
            const scene = this.sceneCache.get(filePath);
            if (scene?.codexLinks) {
                for (const [_catId, names] of Object.entries(scene.codexLinks)) {
                    if (!Array.isArray(names)) continue;
                    for (const name of names) {
                        if (!name) continue;
                        const key = name.toLowerCase();
                        if (!index.has(key)) index.set(key, []);
                        const refs = index.get(key)!;
                        if (!refs.some(r => r.filePath === filePath)) {
                            refs.push({ name: sceneName, type: 'scene', filePath });
                        }
                    }
                }
            }
        }

        return index;
    }

    // ── Codex change detection ─────────────────────────

    /**
     * Compute a content digest for every codex entry.
     * Returns a map of filePath → hash string.
     * Used to detect when a codex entry has been edited since the last review.
     */
    computeCodexDigests(): Record<string, string> {
        if (!this.codexManager) return {};
        const digests: Record<string, string> = {};
        for (const entry of this.codexManager.getAllEntries()) {
            const textParts: string[] = [];
            for (const [key, val] of Object.entries(entry)) {
                if (key === 'filePath' || key === 'type' || key === 'name' || key === 'image' ||
                    key === 'gallery' || key === 'created' || key === 'modified' || key === 'books') continue;
                if (typeof val === 'string' && val.length > 0) textParts.push(val);
            }
            const text = textParts.join('\n');
            if (text) digests[entry.filePath] = this.djb2(text);
        }
        return digests;
    }

    /** Simple DJB2 hash — fast, non-cryptographic, sufficient for change detection */
    private djb2(str: string): string {
        let h = 5381;
        for (let i = 0; i < str.length; i++) {
            h = ((h << 5) + h) + str.charCodeAt(i);
            h |= 0;
        }
        return h.toString(36);
    }
}
/* eslint-enable @typescript-eslint/no-unused-vars, no-useless-escape -- end of file-wide suppression block opened at line 1 */
