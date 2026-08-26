/* eslint-disable @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-return -- Obsidian's API surface and several untyped third-party libraries force dynamic dispatch; floating promises are intentional in DOM/event handlers; matching enable at end of file */
import { App, normalizePath } from 'obsidian';
import { ensureVaultFolder, isTombstonedProjectPath } from '../utils/vaultFolders';
import { RESERVED_TOP_LEVEL_KEYS } from '../utils/libraryProfilePropertyOrder';
import { coerceString, coerceStringList } from '../utils/narrow';

// ═══════════════════════════════════════════════════════
//  Universal Field Template Service
//
//  Stores field template definitions in the project's
//  System/field-templates.json so they sync across devices.
// ═══════════════════════════════════════════════════════

/** Type of input control for a universal field */
export type UniversalFieldType = 'text' | 'textarea' | 'dropdown' | 'multi-select' | 'checkbox';

/** A single universal field template definition */
export interface UniversalFieldTemplate {
    /** Unique ID (generated once, stable across edits) */
    id: string;
    /** Human-readable label shown in the UI */
    label: string;
    /** Which section this field belongs to (must match a category section title) */
    section: string;
    /** Which entity category this field belongs to (e.g. 'character', 'location', 'items', 'creatures'). Empty/undefined = 'character' for backward compat. */
    category?: string;
    /** Input type */
    type: UniversalFieldType;
    /** Dropdown options (used when type === 'dropdown' or 'multi-select') */
    options: string[];
    /** Optional vault folder path whose note names are used as selectable options */
    folderSource?: string;
    /** Placeholder / hint text */
    placeholder: string;
    /** Sort order within the section (higher = further down, default 0) */
    order: number;
    /**
     * Issue #71 — when set, the field's value is mirrored to a top-level
     * YAML key with this name (in addition to `universalFields[id]`).
     * This makes the value visible to Obsidian Properties, Bases, and
     * Dataview without requiring users to dig into nested objects.
     */
    topLevelKey?: string;
    /**
     * Issue #77 — optional default value applied when a new entity
     * (currently scenes) is created. For multi-select fields this can be
     * a comma-separated string; the consumer normalises it.
     */
    defaultValue?: string;
}

/** A single entry in a section's merged display order (issue #92 follow-up). */
export interface SectionOrderEntry {
    /** 'builtin' = NarrativeLab-defined field (keyed by field.key), 'universal' = template (keyed by tpl.id). */
    kind: 'builtin' | 'universal';
    /** field.key for built-ins, tpl.id for universal fields. */
    key: string;
}

/**
 * Character profile sections merged over time. Templates / sectionOrders that
 * still use the old titles are remapped so fields stay visible.
 */
const CHARACTER_SECTION_ALIASES: Record<string, string> = {
    Backstory: 'Background and Arc',
    'Character Arc': 'Background and Arc',
    Personality: 'Personality and Appearance',
    'Physical Characteristics': 'Personality and Appearance',
    Relationships: 'Basic Information',
    Other: 'Personality and Appearance',
};

function normalizeTemplateSection(section: string, category?: string): string {
    const cat = category || 'character';
    if (cat !== 'character') return section;
    return CHARACTER_SECTION_ALIASES[section] ?? section;
}

/** On-disk shape of field-templates.json */
export interface FieldTemplateFile {
    version: number;
    fields: UniversalFieldTemplate[];
    /**
     * Per-section ordering of all visible fields (built-in + universal).
     * Map key is `${section}|${category||''}`. Missing keys fall back to
     * the natural order (built-ins first, then universals by `order`).
     * Added in v1.9.x to let users interleave universal fields between
     * built-in fields within a section.
     */
    sectionOrders?: Record<string, SectionOrderEntry[]>;
}


/**
 * Change event fired by {@link FieldTemplateService} after a template is
 * added, updated, or removed. The plugin uses this to keep entity files'
 * top-level YAML in sync with the template's `topLevelKey` / `folderSource`
 * settings (issue #71 follow-up: existing entries should auto-migrate).
 */
export interface FieldTemplateChange {
    type: 'add' | 'update' | 'remove';
    id: string;
    /** Snapshot of the template *after* the change (undefined for `remove`). */
    template?: UniversalFieldTemplate;
    /** topLevelKey value *before* the change (set on update / remove). */
    oldTopLevelKey?: string;
    /** Whether the topLevelKey changed during this update. */
    topLevelKeyChanged?: boolean;
    /** Whether the folderSource flag changed during this update. */
    folderSourceChanged?: boolean;
}

/**
 * Manages universal field templates stored in the project's System/ folder.
 * Templates define extra fields that appear on *every* character sheet in the
 * chosen section.  The actual per-character data lives in the character's
 * `universalFields` record (keyed by template id).
 */
export class FieldTemplateService {
    private app: App;
    private templates: UniversalFieldTemplate[] = [];
    /** Per-section ordering (built-in + universal interleaved). See {@link SectionOrderEntry}. */
    private sectionOrders: Record<string, SectionOrderEntry[]> = {};
    /** Resolver set by the plugin so we don't depend on main.ts directly */
    private getSystemFolder: () => string;
    private onChange?: (change: FieldTemplateChange) => void | Promise<void>;
    /** True when field-templates.json existed but could not be parsed — refuse save overwrite. */
    private _invalidFile = false;
    private _loadedFromBackup = false;

    constructor(app: App, getSystemFolder: () => string) {
        this.app = app;
        this.getSystemFolder = getSystemFolder;
    }

    /** Register a callback to run after add/update/remove. Used for migrations. */
    setOnChange(fn: (change: FieldTemplateChange) => void | Promise<void>): void {
        this.onChange = fn;
    }


    // ── Accessors ──────────────────────────────────────

    /** All loaded templates */
    getAll(): UniversalFieldTemplate[] {
        return [...this.templates];
    }

    /** Templates belonging to a specific section, optionally scoped by category */
    getBySection(sectionTitle: string, category?: string): UniversalFieldTemplate[] {
        const want = normalizeTemplateSection(sectionTitle, category);
        return this.templates
            .filter(t => {
                const tCat = t.category || 'character';
                const tSection = normalizeTemplateSection(t.section, tCat);
                if (tSection !== want) return false;
                // Scope by category if provided
                if (category !== undefined) {
                    return tCat === category;
                }
                return true;
            })
            .sort((a, b) => a.order - b.order);
    }

    /** Single template by ID */
    getById(id: string): UniversalFieldTemplate | undefined {
        return this.templates.find(t => t.id === id);
    }

    // ── CRUD ───────────────────────────────────────────

    /**
     * Apply an in-memory edit only if its on-disk representation can be
     * persisted.  Without this transaction a failed write left the UI using
     * template state that disappeared after the next reload.
     */
    private async mutateAndSave(mutate: () => void): Promise<void> {
        const previousTemplates = this.templates.map(template => ({
            ...template,
            options: [...template.options],
        }));
        const previousSectionOrders = Object.fromEntries(
            Object.entries(this.sectionOrders).map(([key, entries]) => [
                key,
                entries.map(entry => ({ ...entry })),
            ]),
        );
        try {
            mutate();
            await this.save();
        } catch (error) {
            this.templates = previousTemplates;
            this.sectionOrders = previousSectionOrders;
            throw error;
        }
    }

    /** Add a new template and persist */
    async add(template: UniversalFieldTemplate): Promise<void> {
        await this.mutateAndSave(() => this.templates.push(template));
        try {
            await this.onChange?.({
                type: 'add',
                id: template.id,
                template,
                topLevelKeyChanged: !!template.topLevelKey,
                folderSourceChanged: !!template.folderSource,
            });
        } catch (e) { console.error('[NarrativeLab] FieldTemplate onChange (add):', e); }
    }

    /** Update an existing template in-place and persist */
    async update(id: string, patch: Partial<Omit<UniversalFieldTemplate, 'id'>>): Promise<void> {
        const t = this.templates.find(f => f.id === id);
        if (!t) return;
        const oldTopLevelKey = t.topLevelKey;
        const oldFolderSource = t.folderSource;
        await this.mutateAndSave(() => Object.assign(t, patch));
        const updated = this.templates.find(field => field.id === id);
        try {
            await this.onChange?.({
                type: 'update',
                id,
                template: updated ? { ...updated, options: [...updated.options] } : undefined,
                oldTopLevelKey,
                topLevelKeyChanged: oldTopLevelKey !== updated?.topLevelKey,
                folderSourceChanged: oldFolderSource !== updated?.folderSource,
            });
        } catch (e) { console.error('[NarrativeLab] FieldTemplate onChange (update):', e); }
    }

    /** Remove a template by ID and persist */
    async remove(id: string): Promise<void> {
        const removed = this.templates.find(t => t.id === id);
        if (!removed) return;
        await this.mutateAndSave(() => {
            this.templates = this.templates.filter(t => t.id !== id);
        });
        try {
            await this.onChange?.({
                type: 'remove',
                id,
                oldTopLevelKey: removed?.topLevelKey,
                topLevelKeyChanged: !!removed?.topLevelKey,
            });
        } catch (e) { console.error('[NarrativeLab] FieldTemplate onChange (remove):', e); }
    }

    /** Reorder: move template to a new position within its section */
    async reorder(id: string, newOrder: number): Promise<void> {
        const t = this.templates.find(f => f.id === id);
        if (!t) return;
        await this.mutateAndSave(() => { t.order = newOrder; });
    }

    /**
     * Issue #92 — move a template up by one position within its (section, category) scope.
     * Swaps order with the previous sibling.
     */
    async moveUp(id: string): Promise<void> {
        const t = this.templates.find(f => f.id === id);
        if (!t) return;
        const siblings = this.getBySection(t.section, t.category);
        const idx = siblings.findIndex(s => s.id === id);
        if (idx <= 0) return;
        // Normalize all sibling orders to 0..n then swap
        await this.mutateAndSave(() => {
            siblings.forEach((s, i) => { s.order = i; });
            const prev = siblings[idx - 1];
            const tmp = prev.order;
            prev.order = t.order;
            t.order = tmp;
        });
    }

    /**
     * Issue #92 — move a template down by one position within its (section, category) scope.
     */
    async moveDown(id: string): Promise<void> {
        const t = this.templates.find(f => f.id === id);
        if (!t) return;
        const siblings = this.getBySection(t.section, t.category);
        const idx = siblings.findIndex(s => s.id === id);
        if (idx < 0 || idx >= siblings.length - 1) return;
        await this.mutateAndSave(() => {
            siblings.forEach((s, i) => { s.order = i; });
            const next = siblings[idx + 1];
            const tmp = next.order;
            next.order = t.order;
            t.order = tmp;
        });
    }

    /**
     * Issue #92 / #197 — place an existing universal-field template at a
     * specific position within its (section, category)'s merged display order
     * (built-in + universal interleaved). Pass `null` to move to the very top,
     * a sibling id to insert after that sibling, or `undefined` to leave it at
     * the end (no-op).
     *
     * The previous implementation only shuffled the per-template `order` field,
     * which `getMergedOrder` ignores once a `sectionOrders` entry exists — so
     * the position was silently lost and every new field landed at the end
     * (issue #197). This version updates the persisted `sectionOrders` map so
     * the chosen position is honoured on the next render.
     */
    async moveAfter(
        section: string,
        category: string | undefined,
        builtInKeys: string[],
        id: string,
        afterId: string | null | undefined,
    ): Promise<void> {
        // No explicit position → leave at end (getMergedOrder already appends
        // new universals at the end by default).
        if (afterId === undefined) return;

        const order = this.getMergedOrder(section, category, builtInKeys);
        // Remove the entry we're moving.
        const fromIdx = order.findIndex(e => e.kind === 'universal' && e.key === id);
        if (fromIdx < 0) return;
        const [moved] = order.splice(fromIdx, 1);

        let insertIdx = 0;
        if (afterId === null) {
            insertIdx = 0;
        } else {
            const i = order.findIndex(e => e.key === afterId);
            insertIdx = i >= 0 ? i + 1 : order.length;
        }
        order.splice(insertIdx, 0, moved);
        await this.setSectionOrder(section, category, order);
    }

    // ── Merged ordering (built-in + universal) ─────────

    private sectionKey(section: string, category?: string): string {
        return `${normalizeTemplateSection(section, category)}|${category ?? ''}`;
    }

    /**
     * Resolve the full display order for a section, interleaving built-in
     * field keys with universal-field template ids. Newly introduced built-in
     * fields are inserted beside their nearest natural neighbour, so upgrades
     * do not strand a new default field at the bottom of a user-sorted section.
     */
    getMergedOrder(section: string, category: string | undefined, builtInKeys: string[]): SectionOrderEntry[] {
        const stored = this.sectionOrders[this.sectionKey(section, category)] ?? [];
        const builtInSet = new Set(builtInKeys);
        const universals = this.getBySection(section, category);
        const uniIds = new Set(universals.map(u => u.id));

        // Keep only stored entries that still exist; drop renames/removals.
        const result: SectionOrderEntry[] = [];
        const seen = new Set<string>();
        for (const e of stored) {
            if (e.kind === 'builtin' ? builtInSet.has(e.key) : uniIds.has(e.key)) {
                const tag = `${e.kind}:${e.key}`;
                if (!seen.has(tag)) { result.push(e); seen.add(tag); }
            }
        }
        // Insert missing built-ins beside an existing natural neighbour. This
        // preserves the user's stored order while keeping newly shipped fields
        // (for example `earlylife` after `family`) in a meaningful position.
        for (let index = 0; index < builtInKeys.length; index++) {
            const bk = builtInKeys[index];
            const tag = `builtin:${bk}`;
            if (seen.has(tag)) continue;

            let insertAt = -1;
            for (let previous = index - 1; previous >= 0; previous--) {
                const previousIndex = result.findIndex(entry =>
                    entry.kind === 'builtin' && entry.key === builtInKeys[previous]);
                if (previousIndex >= 0) {
                    insertAt = previousIndex + 1;
                    break;
                }
            }
            if (insertAt < 0) {
                for (let next = index + 1; next < builtInKeys.length; next++) {
                    const nextIndex = result.findIndex(entry =>
                        entry.kind === 'builtin' && entry.key === builtInKeys[next]);
                    if (nextIndex >= 0) {
                        insertAt = nextIndex;
                        break;
                    }
                }
            }
            if (insertAt < 0) {
                const firstUniversal = result.findIndex(entry => entry.kind === 'universal');
                insertAt = firstUniversal >= 0 ? firstUniversal : result.length;
            }
            result.splice(insertAt, 0, { kind: 'builtin', key: bk });
            seen.add(tag);
        }
        // Append any universals not yet ordered.
        for (const u of universals) {
            const tag = `universal:${u.id}`;
            if (!seen.has(tag)) { result.push({ kind: 'universal', key: u.id }); seen.add(tag); }
        }
        return result;
    }

    /** Persist a fully-resolved order for a section. */
    private async setSectionOrder(section: string, category: string | undefined, order: SectionOrderEntry[]): Promise<void> {
        await this.mutateAndSave(() => {
            this.sectionOrders[this.sectionKey(section, category)] = order.map(e => ({ kind: e.kind, key: e.key }));
        });
    }

    /** Move an entry (built-in or universal) one slot up within its section. */
    async moveEntryUp(
        section: string,
        category: string | undefined,
        builtInKeys: string[],
        kind: 'builtin' | 'universal',
        key: string,
    ): Promise<void> {
        const order = this.getMergedOrder(section, category, builtInKeys);
        const idx = order.findIndex(e => e.kind === kind && e.key === key);
        if (idx <= 0) return;
        [order[idx - 1], order[idx]] = [order[idx], order[idx - 1]];
        await this.setSectionOrder(section, category, order);
    }

    /** Move an entry one slot down within its section. */
    async moveEntryDown(
        section: string,
        category: string | undefined,
        builtInKeys: string[],
        kind: 'builtin' | 'universal',
        key: string,
    ): Promise<void> {
        const order = this.getMergedOrder(section, category, builtInKeys);
        const idx = order.findIndex(e => e.kind === kind && e.key === key);
        if (idx < 0 || idx >= order.length - 1) return;
        [order[idx + 1], order[idx]] = [order[idx], order[idx + 1]];
        await this.setSectionOrder(section, category, order);
    }

    // ── Persistence ────────────────────────────────────

    /** Load templates from System/field-templates.json */
    async load(): Promise<void> {
        try {
            const adapter = this.app.vault.adapter;
            const filePath = normalizePath(`${this.getSystemFolder()}/field-templates.json`);
            const candidates = [`${filePath}.tmp`, filePath, `${filePath}.bak`];
            const existingCandidates: string[] = [];
            for (const candidate of candidates) {
                if (await adapter.exists(candidate)) existingCandidates.push(candidate);
            }
            if (existingCandidates.length === 0) {
                this._invalidFile = false;
                this._loadedFromBackup = false;
                this.templates = [];
                this.sectionOrders = {};
                return;
            }
            let data: FieldTemplateFile | undefined;
            let loadedCandidate = '';
            for (const candidate of existingCandidates) {
                try {
                    const raw = JSON.parse(await adapter.read(candidate)) as unknown;
                    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
                        throw new Error('invalid field template object');
                    }
                    const parsed = raw as Partial<FieldTemplateFile>;
                    if (!Array.isArray(parsed.fields)
                        || (parsed.sectionOrders !== undefined
                            && (!parsed.sectionOrders || typeof parsed.sectionOrders !== 'object'
                                || Array.isArray(parsed.sectionOrders)))) {
                        throw new Error('invalid field template structure');
                    }
                    data = parsed as FieldTemplateFile;
                    loadedCandidate = candidate;
                    break;
                } catch (error) {
                    console.error(`[NarrativeLab] Could not load field templates from ${candidate}:`, error);
                }
            }
            if (!data) throw new Error('No readable field template file or backup was found.');
            this.sectionOrders = {};
            if (data.sectionOrders && typeof data.sectionOrders === 'object') {
                for (const [k, v] of Object.entries(data.sectionOrders)) {
                    if (!Array.isArray(v)) continue;
                    this.sectionOrders[k] = v
                        .filter((e): e is SectionOrderEntry =>
                            !!e && typeof e === 'object'
                            && (e.kind === 'builtin' || e.kind === 'universal')
                            && typeof e.key === 'string')
                        .map(e => ({ kind: e.kind, key: e.key }));
                }
            }
            if (Array.isArray(data.fields)) {
                this.templates = data.fields.map(f => {
                    const category = f.category;
                    const rawSection = f.section ?? 'Personality and Appearance';
                    return {
                        id: f.id ?? generateId(),
                        label: f.label ?? 'Untitled',
                        section: normalizeTemplateSection(rawSection, category || 'character'),
                        category,
                        type: f.type ?? 'text',
                        options: Array.isArray(f.options) ? f.options : [],
                        folderSource: f.folderSource,
                        placeholder: f.placeholder ?? '',
                        order: typeof f.order === 'number' ? f.order : 0,
                        topLevelKey: typeof f.topLevelKey === 'string' && f.topLevelKey.trim() ? f.topLevelKey.trim() : undefined,
                        defaultValue: typeof f.defaultValue === 'string' && f.defaultValue.length > 0 ? f.defaultValue : undefined,
                    };
                });
            } else {
                this.templates = [];
            }
            // Merge legacy character section order keys into the combined section.
            const mergedOrders: Record<string, SectionOrderEntry[]> = {};
            for (const [k, v] of Object.entries(this.sectionOrders)) {
                const pipe = k.indexOf('|');
                const section = pipe >= 0 ? k.slice(0, pipe) : k;
                const category = pipe >= 0 ? k.slice(pipe + 1) : '';
                const normalized = `${normalizeTemplateSection(section, category || 'character')}|${category}`;
                const prev = mergedOrders[normalized] ?? [];
                const seen = new Set(prev.map(e => `${e.kind}:${e.key}`));
                for (const e of v) {
                    const tag = `${e.kind}:${e.key}`;
                    if (seen.has(tag)) continue;
                    prev.push(e);
                    seen.add(tag);
                }
                mergedOrders[normalized] = prev;
            }
            this.sectionOrders = mergedOrders;
            this._invalidFile = false;
            this._loadedFromBackup = loadedCandidate !== filePath;
        } catch {
            this._invalidFile = true;
            this._loadedFromBackup = false;
        }
    }

    /** Save templates to System/field-templates.json */
    async save(): Promise<void> {
        if (this._invalidFile) {
            throw new Error('Cannot save field templates because the existing file is unreadable.');
        }
        try {
            const adapter = this.app.vault.adapter;
            const systemFolder = normalizePath(this.getSystemFolder());
            if (isTombstonedProjectPath(systemFolder)) {
                throw new Error('Cannot save field templates for a project being removed.');
            }
            if (!await adapter.exists(systemFolder)) {
                await ensureVaultFolder(this.app, systemFolder);
            }
            const data: FieldTemplateFile = {
                version: 1,
                fields: this.templates,
                sectionOrders: this.sectionOrders,
            };
            const filePath = normalizePath(`${systemFolder}/field-templates.json`);
            const tempPath = `${filePath}.tmp`;
            const backupPath = `${filePath}.bak`;
            const content = JSON.stringify(data, null, 2);
            await adapter.write(tempPath, content);
            if (!this._loadedFromBackup && await adapter.exists(filePath)) {
                await adapter.write(backupPath, await adapter.read(filePath));
            }
            await adapter.write(filePath, content);
            await adapter.remove(tempPath).catch(() => undefined);
            this._loadedFromBackup = false;
        } catch (e) {
            console.error('[NarrativeLab] FieldTemplateService.save():', e);
            throw e;
        }
    }
}

// ── Helpers ────────────────────────────────────────────

/** Generate a short unique ID */
export function generateId(): string {
    return `uf_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 7)}`;
}

// ── Issue #71 — top-level YAML mirror for custom fields ──

/**
 * Reserved frontmatter keys that universal-field topLevelKey values must
 * never collide with. Editing these from a custom field would corrupt
 * core NarrativeLab data.
 */
/** Slugify a label into a YAML-safe top-level key. */
export function suggestTopLevelKey(label: string): string {
    return String(label || '')
        .trim()
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '_')
        .replace(/^_+|_+$/g, '')
        .slice(0, 40)
        || 'field';
}

/** True if a top-level key is safe to use (not reserved). */
export function isReservedTopLevelKey(key: string): boolean {
    return RESERVED_TOP_LEVEL_KEYS.has(String(key || '').trim());
}

/** Module-level template provider so parsers don't depend on plugin instance. */
let _templatesProvider: () => UniversalFieldTemplate[] = () => [];
let _topLevelMirrorEnabled = true;
export function setActiveTemplatesProvider(fn: () => UniversalFieldTemplate[]): void {
    _templatesProvider = fn;
}
export function setTopLevelMirrorEnabled(on: boolean): void {
    _topLevelMirrorEnabled = !!on;
}
export function getActiveTemplates(): UniversalFieldTemplate[] {
    try { return _templatesProvider() || []; } catch { return []; }
}

/**
 * Strip Obsidian wikilink brackets and any pipe-aliases off a value, leaving
 * just the target name. Safe to call on plain strings, wikilink strings, or
 * arrays mixing both. Used when reading universal-field values back from a
 * top-level YAML key that may have been written as `[[Note]]` for a
 * folder-sourced field.
 */
export function stripWikilinks(value: unknown): unknown {
    const strip = (s: string): string => {
        const m = s.match(/^\[\[([^\]]+)\]\]$/);
        if (!m) return s;
        const inner = m[1];
        const pipeIdx = inner.indexOf('|');
        return (pipeIdx >= 0 ? inner.slice(0, pipeIdx) : inner).trim();
    };
    if (Array.isArray(value)) {
        return value.map(v => (typeof v === 'string' ? strip(v) : v));
    }
    if (typeof value === 'string') return strip(value);
    return value;
}

function normalizeUniversalValue(value: unknown): string | string[] | undefined {
    if (Array.isArray(value)) {
        const values = coerceStringList(value);
        return values.length ? values : undefined;
    }
    const text = coerceString(value);
    return text || undefined;
}

function normalizeUniversalMap(value: unknown): Record<string, string | string[]> {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
    const result: Record<string, string | string[]> = {};
    for (const [id, raw] of Object.entries(value as Record<string, unknown>)) {
        const normalized = normalizeUniversalValue(raw);
        if (normalized !== undefined) result[id] = normalized;
    }
    return result;
}

function sameUniversalValue(left: unknown, right: unknown): boolean {
    if (left === right) return true;
    try { return JSON.stringify(left) === JSON.stringify(right); } catch { return false; }
}

/**
 * Wrap a folder-sourced field value as Obsidian wikilink(s) for top-level
 * YAML mirroring, so the property becomes clickable in Properties / Bases /
 * Dataview. The internal `universalFields[id]` representation stays as plain
 * names to keep the dropdown UI matching its options. Already-wikilinked
 * input is left untouched.
 */
function wrapAsWikilinks(value: unknown): unknown {
    const wrap = (s: string): string => {
        const trimmed = s.trim();
        if (!trimmed) return s;
        if (/^\[\[[^\]]+\]\]$/.test(trimmed)) return trimmed;
        return `[[${trimmed}]]`;
    };
    if (Array.isArray(value)) {
        return value.map(v => (typeof v === 'string' && v.trim() ? wrap(v) : v));
    }
    if (typeof value === 'string') return wrap(value);
    return value;
}

/**
 * Hydrate `universalFields` from any matching top-level YAML keys. If a
 * template's `topLevelKey` is present in fm and the corresponding
 * universalFields[id] is missing, copy the value across. Issue #71.
 *
 * For folder-sourced templates, top-level YAML may store `[[Wikilinks]]`
 * (so Obsidian Properties shows them as clickable links). We strip the
 * brackets when copying back so the in-memory value matches the dropdown
 * option strings.
 */
export function hydrateUniversalFieldsFromTopLevel(
    fm: Record<string, unknown>,
    universalFields: Record<string, unknown> | undefined,
): Record<string, unknown> | undefined {
    const templates = getActiveTemplates();
    if (!templates.length) return universalFields;
    const diskValues = normalizeUniversalMap(fm.universalFields);
    const result: Record<string, unknown> = normalizeUniversalMap(universalFields);
    for (const t of templates) {
        const k = t.topLevelKey;
        if (!k || isReservedTopLevelKey(k)) continue;
        if (!Object.prototype.hasOwnProperty.call(fm, k)) continue;
        const top = normalizeUniversalValue(fm[k]);
        const current = result[t.id];
        const disk = diskValues[t.id];
        if (current === undefined || sameUniversalValue(current, disk)) {
            if (top === undefined) {
                delete result[t.id];
            } else {
                const isFolderSourced = !!t.folderSource && (t.type === 'dropdown' || t.type === 'multi-select');
                result[t.id] = isFolderSourced ? stripWikilinks(top) : top;
            }
        } else if (sameUniversalValue(top, disk)) {
            result[t.id] = current;
        }
    }
    return Object.keys(result).length ? result : undefined;
}

/** Preserve values omitted by a partial editor snapshot while allowing an
 * explicitly supplied empty value to clear an individual field. */
export function mergeUniversalFieldsForSafeSave(
    diskFields: Record<string, unknown> | undefined,
    liveFields: Record<string, unknown> | undefined,
): Record<string, unknown> | undefined {
    const diskEntries = Object.entries(diskFields ?? {});
    const liveEntries = Object.entries(liveFields ?? {});
    if (diskEntries.length === 0 && liveEntries.length === 0) return undefined;
    return Object.fromEntries([...diskEntries, ...liveEntries]);
}

/**
 * Mirror universal-field values back to top-level YAML keys for templates
 * that opt in via `topLevelKey`. Mutates `fm` in place. Issue #71.
 * Removes the top-level key when the value is empty so the YAML stays clean.
 *
 * For folder-sourced dropdown / multi-select templates, the mirrored value
 * is wrapped in `[[wikilinks]]` so it becomes clickable in Obsidian
 * Properties / Bases / Dataview.
 */
export function mirrorUniversalFieldsToTopLevel(
    fm: Record<string, unknown>,
    universalFields: Record<string, unknown> | undefined,
): void {
    if (!_topLevelMirrorEnabled) return;
    const templates = getActiveTemplates();
    if (!templates.length) return;
    for (const t of templates) {
        const k = t.topLevelKey;
        if (!k || isReservedTopLevelKey(k)) continue;
        const rawValue = universalFields ? universalFields[t.id] : undefined;
        const v = normalizeUniversalValue(rawValue);
        if (v === undefined) {
            delete fm[k];
        } else {
            const isFolderSourced = !!t.folderSource && (t.type === 'dropdown' || t.type === 'multi-select');
            fm[k] = isFolderSourced ? wrapAsWikilinks(v) : v;
        }
    }
}
/* eslint-enable @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-return -- end of file-wide suppression block opened at line 1 */
