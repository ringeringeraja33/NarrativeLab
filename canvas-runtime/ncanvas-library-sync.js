/**
 * Shared helpers for Narrative Canvas ↔ NarrativeLab Library sync.
 * Keep this file free of Obsidian APIs so unit tests can import it directly.
 */

const SKIP_LIBRARY_DIR_NAMES = new Set(["attachments", "conflicts"]);

const KIND_TO_CATEGORY_ID = {
  character: "characters",
  characters: "characters",
  location: "locations",
  locations: "locations",
  item: "items",
  items: "items",
  creature: "creatures",
  creatures: "creatures",
  lore: "lore",
  organization: "organizations",
  organizations: "organizations",
  culture: "culture",
  system: "systems",
  systems: "systems",
  skill: "skills",
  skills: "skills",
  literature: "literature",
  claim: "claims",
  claims: "claims",
  argument: "arguments",
  arguments: "arguments",
  fact: "facts",
  facts: "facts",
};

const KIND_FOLDER_ALIASES = {
  character: ["Characters", "角色", "Character"],
  characters: ["Characters", "角色", "Character"],
  location: ["Locations", "地点", "Location"],
  locations: ["Locations", "地点", "Location"],
  item: ["Items", "物品", "Item"],
  items: ["Items", "物品", "Item"],
  creature: ["Creatures", "生物", "Creature"],
  creatures: ["Creatures", "生物", "Creature"],
  lore: ["Lore", "设定"],
  organization: ["Organizations", "组织"],
  organizations: ["Organizations", "组织"],
  culture: ["Culture", "文化"],
  system: ["Systems", "体系", "系统"],
  systems: ["Systems", "体系", "系统"],
  skill: ["Skills", "技能"],
  skills: ["Skills", "技能"],
  literature: ["Literature", "文献"],
  claim: ["Claims", "论点", "Claim"],
  claims: ["Claims", "论点", "Claim"],
  argument: ["Arguments", "论据", "Argument"],
  arguments: ["Arguments", "论据", "Argument"],
  fact: ["Facts", "事实", "Fact"],
  facts: ["Facts", "事实", "Fact"],
};

function normalizeVaultishPath(value) {
  return String(value || "").replace(/\\/g, "/").replace(/\/+$/, "").trim();
}

function isSkippedLibraryDirName(name) {
  return SKIP_LIBRARY_DIR_NAMES.has(String(name || "").trim().toLowerCase());
}

function isPathUnderLibraryRoots(filePath, roots) {
  const path = normalizeVaultishPath(filePath);
  if (!path) return false;
  return (Array.isArray(roots) ? roots : []).some((root) => {
    const prefix = normalizeVaultishPath(root);
    return !!prefix && (path === prefix || path.startsWith(`${prefix}/`));
  });
}

function orderCodexLibraryRoots({ seriesRoot = "", projectRoot = "" } = {}) {
  const out = [];
  const seen = new Set();
  for (const root of [seriesRoot, projectRoot]) {
    const normalized = normalizeVaultishPath(root);
    if (!normalized || seen.has(normalized)) continue;
    seen.add(normalized);
    out.push(normalized);
  }
  return out;
}

function kindToLibraryCategoryId(kind) {
  const raw = String(kind || "").trim();
  if (!raw) return "";
  const mapped = KIND_TO_CATEGORY_ID[raw.toLowerCase()];
  if (mapped) return mapped;
  if (/^custom-/i.test(raw)) return raw;
  return "";
}

function libraryCategoryAliases(category = {}) {
  const aliases = new Set();
  for (const value of [category.id, category.label, category.folder]) {
    const text = String(value || "").trim().toLowerCase();
    if (text) aliases.add(text);
  }
  const id = kindToLibraryCategoryId(category.id || category.label || "");
  if (id === "characters") {
    aliases.add("character");
    aliases.add("characters");
  } else if (id === "locations") {
    aliases.add("location");
    aliases.add("locations");
  } else if (id === "items") {
    aliases.add("item");
    aliases.add("items");
  } else if (id === "lore") {
    aliases.add("lore");
    aliases.add("设定");
  } else if (id === "literature") {
    aliases.add("literature");
    aliases.add("文献");
  } else if (id === "claims") {
    aliases.add("claim");
    aliases.add("claims");
    aliases.add("论点");
  } else if (id === "arguments") {
    aliases.add("argument");
    aliases.add("arguments");
    aliases.add("论据");
  } else if (id === "facts") {
    aliases.add("fact");
    aliases.add("facts");
    aliases.add("事实");
  }
  return aliases;
}

function entryMatchesLibraryCategory(entry = {}, category = {}) {
  const kind = String(entry.kind || entry.category || "").trim().toLowerCase();
  const aliases = libraryCategoryAliases(category);
  if (kind && aliases.has(kind)) return true;
  const entryCategoryId = kindToLibraryCategoryId(entry.kind || entry.category);
  const categoryId = String(category.id || "").trim();
  if (entryCategoryId && categoryId && entryCategoryId === categoryId) return true;
  const filePath = String(entry.codexFile || "").replace(/\\/g, "/");
  const folder = filePath.split("/").slice(-2, -1)[0] || "";
  const categoryFolder = String(category.folder || "").trim().toLowerCase();
  return Boolean(folder && categoryFolder && folder.toLowerCase() === categoryFolder);
}

function resolveLibraryCategoryDisplayLabel(kind, categories = []) {
  const list = Array.isArray(categories) ? categories : [];
  const match = list.find((category) => entryMatchesLibraryCategory({ kind }, category));
  if (match?.label) return match.label;
  const raw = String(kind || "").trim();
  return raw;
}

function libraryCategoryIdToCanvasKind(categoryId) {
  const id = String(categoryId || "").trim();
  const mapped = kindToLibraryCategoryId(id);
  if (mapped === "characters") return "Character";
  if (mapped === "locations") return "Location";
  if (mapped === "items") return "Item";
  if (mapped === "lore") return "Lore";
  return id || "Character";
}

function normalizeCanvasLibraryKind(value) {
  const raw = String(value || "").trim();
  if (!raw) return "Character";
  const categoryId = kindToLibraryCategoryId(raw);
  if (categoryId) return libraryCategoryIdToCanvasKind(categoryId);
  return raw;
}

function kindToLibraryFrontmatterType(kind) {
  const raw = String(kind || "").trim();
  if (raw.toLowerCase() === "world") return "world";
  const categoryId = kindToLibraryCategoryId(raw);
  if (categoryId === "characters") return "character";
  if (categoryId === "locations") return "location";
  if (categoryId) return categoryId;
  return raw || "character";
}

function isCharacterLibraryKind(kind) {
  return kindToLibraryCategoryId(kind) === "characters" || normalizeCanvasLibraryKind(kind) === "Character";
}

function isLocationLibraryKind(kind) {
  const raw = String(kind || "").trim().toLowerCase();
  return raw === "world" || kindToLibraryCategoryId(kind) === "locations" || normalizeCanvasLibraryKind(kind) === "Location";
}

function resolveLibraryProfileSurface(kind) {
  if (isCharacterLibraryKind(kind)) return "character";
  if (isLocationLibraryKind(kind)) return "location";
  return "codex";
}

function resolveCodexCategoryFolderName(kind, existingFolderNames = [], mappedFolderName = "") {
  const kindRaw = String(kind || "").trim();
  const kindLower = kindRaw.toLowerCase();
  const existing = (Array.isArray(existingFolderNames) ? existingFolderNames : [])
    .map((name) => String(name || "").trim())
    .filter((name) => name && !isSkippedLibraryDirName(name));
  const mapped = String(mappedFolderName || "").trim();
  const aliases = [
    mapped,
    kindRaw,
    ...(KIND_FOLDER_ALIASES[kindLower] || []),
  ].filter(Boolean);

  for (const alias of aliases) {
    const hit = existing.find((name) => name.toLowerCase() === alias.toLowerCase());
    if (hit) return hit;
  }
  // NarrativeLab's live mapping is the folder we should create, even if it
  // is not on disk yet (localized Characters → 角色, custom 刀派, …).
  if (mapped && !isSkippedLibraryDirName(mapped)) return mapped;
  // Do not invent deleted English seed folders just because a canvas kind
  // mentions them. Custom kinds may use an existing same-named folder.
  if (kindRaw) {
    const exact = existing.find((name) => name.toLowerCase() === kindLower);
    if (exact) return exact;
  }
  return "";
}

function isEmbedOnlyMarkdown(value) {
  const stripped = String(value || "")
    .replace(/!\[\[[^\]]+\]\]/g, "")
    .replace(/\[\[[^\]]+\]\]/g, "")
    .trim();
  return !stripped;
}

function resolveLoadedLibraryNotes({
  hasFrontmatterNotes = false,
  fmNotes = "",
  description = "",
  body = "",
} = {}) {
  const text = String(body || "");
  const fm = hasFrontmatterNotes ? String(fmNotes ?? "") : "";
  if (!hasFrontmatterNotes) {
    return {
      notes: String(description || "") || text,
      markdownBody: text,
    };
  }
  if (!text.trim()) {
    return { notes: fm, markdownBody: text };
  }
  if (text === fm) {
    return { notes: text, markdownBody: text };
  }
  // Canvas-native files keep a short notes field plus embed-only body.
  if (isEmbedOnlyMarkdown(text)) {
    return { notes: fm, markdownBody: text };
  }
  // Diverged profile body (NarrativeLab) wins over a stale notes: key.
  return { notes: text, markdownBody: text };
}

function stripMarkdownFileName(fileName) {
  return String(fileName || "").replace(/\.md$/i, "").trim();
}

function escapeRegExp(value) {
  return String(value || "").replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function libraryFileTracksEntryName(fileName, entryName) {
  const base = stripMarkdownFileName(fileName);
  const name = String(entryName || "").trim();
  if (!base || !name) return false;
  if (base.localeCompare(name, undefined, { sensitivity: "accent" }) === 0) return true;
  return new RegExp(`^${escapeRegExp(name)}(?:[ -]\\d+)?$`, "i").test(base);
}

function shouldRenameLibraryFileForEntryName({
  currentFileName = "",
  nextName = "",
} = {}) {
  const current = String(currentFileName || "").trim();
  const next = String(nextName || "").trim();
  if (!current || !next) return false;
  return !libraryFileTracksEntryName(current, next);
}

const OFFICIAL_SAMPLE_NCANVAS_NAMES = new Set([
  "Narrative Canvas Guide Sample.ncanvas",
  "叙事画布功能指南示例.ncanvas",
]);

function isOfficialSampleNcanvasPath(path) {
  const name = String(path || "").replace(/\\/g, "/").split("/").pop() || "";
  return OFFICIAL_SAMPLE_NCANVAS_NAMES.has(name);
}

function mergeCanvasLibraryEntries({ diskEntries = [], embeddedEntries = [] } = {}) {
  const disk = Array.isArray(diskEntries) ? diskEntries.filter((entry) => entry && entry.id) : [];
  const diskIds = new Set(disk.map((entry) => String(entry.id).trim()).filter(Boolean));
  const pending = (Array.isArray(embeddedEntries) ? embeddedEntries : []).filter((entry) => {
    const id = String(entry?.id || "").trim();
    if (!id || diskIds.has(id)) return false;
    return !String(entry?.codexFile || "").trim();
  });
  return [...disk, ...pending];
}

function resolveSyncedLibraryMarkdownBody({
  modelNotes = "",
  diskNotes = "",
  diskBody = "",
} = {}) {
  const body = String(diskBody || "");
  const disk = String(diskNotes || "");
  const model = String(modelNotes || "");
  if (body.trim() && isEmbedOnlyMarkdown(body)) return body;
  const notesLiveInBody = !body.trim() || body === disk || !isEmbedOnlyMarkdown(body);
  if (notesLiveInBody && model !== disk) return model;
  return body || model;
}

module.exports = {
  KIND_FOLDER_ALIASES,
  SKIP_LIBRARY_DIR_NAMES,
  isEmbedOnlyMarkdown,
  isOfficialSampleNcanvasPath,
  isPathUnderLibraryRoots,
  isSkippedLibraryDirName,
  mergeCanvasLibraryEntries,
  kindToLibraryCategoryId,
  libraryCategoryAliases,
  entryMatchesLibraryCategory,
  resolveLibraryCategoryDisplayLabel,
  libraryCategoryIdToCanvasKind,
  normalizeCanvasLibraryKind,
  kindToLibraryFrontmatterType,
  isCharacterLibraryKind,
  isLocationLibraryKind,
  resolveLibraryProfileSurface,
  orderCodexLibraryRoots,
  resolveCodexCategoryFolderName,
  libraryFileTracksEntryName,
  resolveLoadedLibraryNotes,
  resolveSyncedLibraryMarkdownBody,
  shouldRenameLibraryFileForEntryName,
  stripMarkdownFileName,
};
