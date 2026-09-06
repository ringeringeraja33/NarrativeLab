import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import {
  isPathUnderLibraryRoots,
  isSkippedLibraryDirName,
  kindToLibraryCategoryId,
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
  isOfficialSampleNcanvasPath,
  mergeCanvasLibraryEntries,
  resolveLoadedLibraryNotes,
  resolveSyncedLibraryMarkdownBody,
  shouldRenameLibraryFileForEntryName,
} from "../canvas-runtime/ncanvas-library-sync.js";

const [pluginBundle, canvasApp, entityCache, mainTs] = await Promise.all([
  readFile(new URL("../canvas-runtime/main.js", import.meta.url), "utf8"),
  readFile(new URL("../canvas-runtime/app.js", import.meta.url), "utf8"),
  readFile(new URL("../services/EntityFileCache.ts", import.meta.url), "utf8"),
  readFile(new URL("../main.ts", import.meta.url), "utf8"),
]);

test("series Library is the primary canvas root when series.json exists", () => {
  assert.deepEqual(
    orderCodexLibraryRoots({
      seriesRoot: "Saga/Library",
      projectRoot: "Saga/Book One/Library",
    }),
    ["Saga/Library", "Saga/Book One/Library"],
  );
  assert.deepEqual(
    orderCodexLibraryRoots({ projectRoot: "Standalone/Library" }),
    ["Standalone/Library"],
  );
  assert.equal(
    isPathUnderLibraryRoots("Saga/Book One/Library/角色/Hero.md", [
      "Saga/Library",
      "Saga/Book One/Library",
    ]),
    true,
  );
  assert.equal(
    isPathUnderLibraryRoots("Other/Library/Hero.md", ["Saga/Library"]),
    false,
  );
});

test("library category ids match canvas kinds and display labels", () => {
  assert.equal(kindToLibraryCategoryId("custom-msriojlo"), "custom-msriojlo");
  assert.equal(libraryCategoryIdToCanvasKind("characters"), "Character");
  assert.equal(libraryCategoryIdToCanvasKind("locations"), "Location");
  assert.equal(libraryCategoryIdToCanvasKind("custom-msriojlo"), "custom-msriojlo");
  assert.equal(entryMatchesLibraryCategory(
    { kind: "Character" },
    { id: "characters", label: "人物", folder: "角色" },
  ), true);
  assert.equal(entryMatchesLibraryCategory(
    { kind: "custom-msriojlo" },
    { id: "custom-msriojlo", label: "队", folder: "队" },
  ), true);
  assert.equal(entryMatchesLibraryCategory(
    { kind: "队", codexFile: "Library/队/Scout.md" },
    { id: "custom-msriojlo", label: "队", folder: "队" },
  ), true);
  assert.equal(resolveLibraryCategoryDisplayLabel("custom-msriojlo", [
    { id: "custom-msriojlo", label: "队", folder: "队" },
  ]), "队");
  assert.equal(resolveLibraryCategoryDisplayLabel("Character", [
    { id: "characters", label: "人物", folder: "角色" },
  ]), "人物");
});

test("canvas and NarrativeLab share one kind/type mapping", () => {
  assert.equal(normalizeCanvasLibraryKind("characters"), "Character");
  assert.equal(normalizeCanvasLibraryKind("locations"), "Location");
  assert.equal(normalizeCanvasLibraryKind("items"), "Item");
  assert.equal(normalizeCanvasLibraryKind("item"), "Item");
  assert.equal(normalizeCanvasLibraryKind("custom-msriojlo"), "custom-msriojlo");
  assert.equal(kindToLibraryFrontmatterType("Character"), "character");
  assert.equal(kindToLibraryFrontmatterType("characters"), "character");
  assert.equal(kindToLibraryFrontmatterType("Item"), "items");
  assert.equal(kindToLibraryFrontmatterType("items"), "items");
  assert.equal(kindToLibraryFrontmatterType("Location"), "location");
  assert.equal(kindToLibraryFrontmatterType("custom-msriojlo"), "custom-msriojlo");
  assert.equal(kindToLibraryCategoryId("literature"), "literature");
  assert.equal(kindToLibraryCategoryId("claim"), "claims");
  assert.equal(kindToLibraryCategoryId("arguments"), "arguments");
  assert.equal(kindToLibraryCategoryId("fact"), "facts");
  assert.equal(kindToLibraryFrontmatterType("literature"), "literature");
  assert.equal(resolveLibraryProfileSurface("literature"), "codex");
  assert.equal(
    resolveCodexCategoryFolderName("literature", ["文献", "论点"], ""),
    "文献",
  );
  assert.equal(isCharacterLibraryKind("Character"), true);
  assert.equal(isCharacterLibraryKind("characters"), true);
  assert.equal(isCharacterLibraryKind("character"), true);
  assert.equal(isCharacterLibraryKind("Item"), false);
  assert.equal(isLocationLibraryKind("locations"), true);
  assert.equal(isLocationLibraryKind("world"), true);
  assert.equal(resolveLibraryProfileSurface("characters"), "character");
  assert.equal(resolveLibraryProfileSurface("world"), "location");
  assert.equal(resolveLibraryProfileSurface("items"), "codex");
});

test("canvas kinds route to the matching NarrativeLab profile surface", () => {
  assert.equal(resolveLibraryProfileSurface("Character"), "character");
  assert.equal(resolveLibraryProfileSurface("Location"), "location");
  assert.equal(resolveLibraryProfileSurface("Lore"), "codex");
  assert.equal(resolveLibraryProfileSurface("刀派"), "codex");
});

test("canvas category folders follow localized and custom Library names", () => {
  assert.equal(kindToLibraryCategoryId("Character"), "characters");
  assert.equal(
    resolveCodexCategoryFolderName("Character", ["角色", "地点"], ""),
    "角色",
  );
  assert.equal(
    resolveCodexCategoryFolderName("Character", ["角色"], "角色"),
    "角色",
  );
  assert.equal(
    resolveCodexCategoryFolderName("Character", [], "角色"),
    "角色",
  );
  assert.equal(
    resolveCodexCategoryFolderName("刀派", ["刀派", "角色"], ""),
    "刀派",
  );
  assert.equal(
    resolveCodexCategoryFolderName("Skills", ["角色"], ""),
    "",
  );
});

test("Attachments and Conflicts notes are not library entries", () => {
  assert.equal(isSkippedLibraryDirName("Attachments"), true);
  assert.equal(isSkippedLibraryDirName("Conflicts"), true);
  assert.equal(isSkippedLibraryDirName("角色"), false);
});

test("NL profile notes stay in the markdown body across canvas reload/save", () => {
  const loaded = resolveLoadedLibraryNotes({
    hasFrontmatterNotes: false,
    body: "She hides the letter.",
  });
  assert.equal(loaded.notes, "She hides the letter.");
  assert.equal(loaded.markdownBody, "She hides the letter.");

  const staleFrontmatter = resolveLoadedLibraryNotes({
    hasFrontmatterNotes: true,
    fmNotes: "old canvas copy",
    body: "She hides the letter.",
  });
  assert.equal(staleFrontmatter.notes, "She hides the letter.");
  assert.equal(staleFrontmatter.markdownBody, "She hides the letter.");

  const written = resolveSyncedLibraryMarkdownBody({
    modelNotes: "She burns the letter.",
    diskNotes: "She hides the letter.",
    diskBody: "She hides the letter.",
  });
  assert.equal(written, "She burns the letter.");
});

test("canvas-native embed bodies keep notes in frontmatter", () => {
  const loaded = resolveLoadedLibraryNotes({
    hasFrontmatterNotes: true,
    fmNotes: "A wandering swordsman.",
    body: "![[Canvas/Hero.canvas]]",
  });
  assert.equal(loaded.notes, "A wandering swordsman.");
  assert.equal(loaded.markdownBody, "![[Canvas/Hero.canvas]]");

  const written = resolveSyncedLibraryMarkdownBody({
    modelNotes: "A retired swordsman.",
    diskNotes: "A wandering swordsman.",
    diskBody: "![[Canvas/Hero.canvas]]",
  });
  assert.equal(written, "![[Canvas/Hero.canvas]]");
});

test("stolen empty-body notes are restored into the profile body", () => {
  const written = resolveSyncedLibraryMarkdownBody({
    modelNotes: "Recovered profile text.",
    diskNotes: "Recovered profile text.",
    diskBody: "",
  });
  assert.equal(written, "Recovered profile text.");
});

test("opening a canvas keeps unwritten sample characters and drops deleted files", () => {
  const merged = mergeCanvasLibraryEntries({
    diskEntries: [{ id: "c-live", name: "Hildegard", codexFile: "Library/Characters/Hildegard.md" }],
    embeddedEntries: [
      { id: "c0", name: "你", codexFile: "" },
      { id: "c1", name: "向导", codexFile: "" },
      { id: "c-gone", name: "Deleted Skill", codexFile: "Library/Skills/Old.md" },
    ],
  });
  assert.deepEqual(merged.map((entry) => entry.id), ["c-live", "c0", "c1"]);
  assert.equal(isOfficialSampleNcanvasPath("Canvas/叙事画布功能指南示例.ncanvas"), true);
  assert.equal(isOfficialSampleNcanvasPath("Canvas/Nachtlied.ncanvas"), false);
});

test("library markdown files rename to follow the canvas entry name", () => {
  assert.equal(shouldRenameLibraryFileForEntryName({
    currentFileName: "Character 1.md",
    nextName: "Hildegard",
  }), true);
  assert.equal(shouldRenameLibraryFileForEntryName({
    currentFileName: "Character 1-2.md",
    nextName: "Hildegard",
  }), true);
  assert.equal(shouldRenameLibraryFileForEntryName({
    currentFileName: "Hildegard.md",
    nextName: "Hildegard",
  }), false);
  assert.equal(shouldRenameLibraryFileForEntryName({
    currentFileName: "Hildegard-2.md",
    nextName: "Hildegard",
  }), false);
});

test("canvas host wires series roots, localized folders, and body-preserving notes", () => {
  assert.match(pluginBundle, /getCodexLibraryRootsForProject/);
  assert.match(pluginBundle, /ncanvas-library-sync/);
  assert.match(pluginBundle, /series\.json/);
  assert.match(pluginBundle, /resolveLoadedLibraryNotes/);
  assert.match(pluginBundle, /resolveSyncedLibraryMarkdownBody/);
  assert.match(pluginBundle, /shouldRenameLibraryFileForEntryName/);
  assert.match(pluginBundle, /applyCodexFilePaths/);
  assert.match(pluginBundle, /syncLibraryFromCanvas/);
  assert.match(canvasApp, /ensureOfficialSampleLibraryEntries/);
  assert.match(canvasApp, /seedMissingLibraryFiles/);
  assert.match(pluginBundle, /isSkippedLibraryDirName/);
  assert.match(entityCache, /isSkippedLibraryScanFolder/);
  assert.match(mainTs, /getNarrativeLabLibraryFolderMap/);
  assert.match(mainTs, /mountCanvasLibraryProfile/);
  assert.match(mainTs, /getNarrativeLabLibraryCategories/);
  assert.match(mainTs, /resolveNarrativeLabLibraryCategoryLabel/);
  assert.match(mainTs, /resolveLibraryCategoryLabelForKind\(this, kind\)/);
  assert.match(mainTs, /openNarrativeLabLibraryCategoryManager/);
  assert.match(mainTs, /refreshLibraryCategories\?\.\(\)/);
  assert.match(pluginBundle, /mountLibraryProfile/);
  assert.match(pluginBundle, /getLibraryCategories/);
  assert.match(pluginBundle, /resolveLibraryCategoryLabel/);
  assert.match(pluginBundle, /openLibraryCategoryManager/);
  assert.match(pluginBundle, /refreshLibraryCategories\?\.\(\)/);
  assert.match(canvasApp, /getHostLibraryCategories/);
  assert.match(canvasApp, /hasHostLibraryCategoryBridge/);
  assert.match(canvasApp, /refreshLibraryCategories/);
  assert.match(canvasApp, /if \(hasHostLibraryCategoryBridge\(\)\)/);
  assert.match(canvasApp, /getCodexKindLabel/);
  assert.match(canvasApp, /openHostLibraryCategoryManager/);
  assert.match(canvasApp, /isCharacterLibraryKind/);
  assert.match(canvasApp, /getCodexKindSortIndex/);
  assert.match(pluginBundle, /kindToLibraryFrontmatterType/);
  assert.match(pluginBundle, /normalizeCanvasLibraryKind/);
});

test("canvas Codex profiles resolve by file name and keep project styling", async () => {
  const [host, view, manager] = await Promise.all([
    readFile(new URL("../views/CanvasLibraryProfileHost.ts", import.meta.url), "utf8"),
    readFile(new URL("../views/CodexView.ts", import.meta.url), "utf8"),
    readFile(new URL("../services/CodexManager.ts", import.meta.url), "utf8"),
  ]);
  assert.match(host, /story-line-codex-container/);
  assert.match(host, /findByFileNameOrName/);
  assert.match(view, /ingestCodexFileFromVault/);
  assert.match(view, /findByFileNameOrName/);
  assert.match(view, /ensureCategoryDef/);
  assert.match(view, /async navigateToEntry\(filePath: string\): Promise<void> \{[\s\S]*?ingestCodexFileFromVault/);
  assert.match(manager, /async ingestVaultFile/);
  assert.match(manager, /findByFileNameOrName/);
  assert.match(manager, /registerCategoryDef/);
});
