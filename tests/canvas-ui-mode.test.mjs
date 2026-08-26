import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const [app, html, css, pluginBundle] = await Promise.all([
  readFile(new URL("../canvas-runtime/app.js", import.meta.url), "utf8"),
  readFile(new URL("../canvas-runtime/index.html", import.meta.url), "utf8"),
  readFile(new URL("../canvas-runtime/canvas.css", import.meta.url), "utf8"),
  readFile(new URL("../canvas-runtime/main.js", import.meta.url), "utf8")
]);

test("removed chrome is optional so canvas can still boot", () => {
  assert.match(app, /optionalDomKeys = new Set\(\[[^\]]*?"uiModeToggle"/);
  assert.doesNotMatch(html, /id="uiModeToggle"/);
});

test("canvas always exposes the full node library", () => {
  assert.match(app, /function isAdvancedUiMode\(\) \{\s*return true;/);
  assert.match(app, /function getAddableNodeTypeEntries\(\) \{\s*return getNodeTypeEntries\(\);/);
  assert.doesNotMatch(app, /BASIC_NODE_TYPE_SET/);
});

test("project file actions keep Open, sample, and Save without Reload or New", () => {
  assert.match(html, /data-action="open-project-file"/);
  assert.match(html, /data-action="open-sample-project"/);
  assert.match(html, /data-action="save-project"/);
  assert.doesNotMatch(html, /data-action="reload-project-file"/);
  assert.doesNotMatch(html, /data-action="new-project"/);
  assert.doesNotMatch(html, /id="uiModeToggle"/);
  assert.doesNotMatch(css, /data-ui-mode="basic"\] \.nc-advanced-only/);
});

test("event table stays basic while edit document is advanced-only", () => {
  assert.match(app, /\["document", "variables"\]\.includes\(fileId\)/);
  assert.match(app, /\["document", "variables"\]\.includes\(state\.activeFileId\)/);
  assert.equal((app.match(/\["events", "variables"\]\.includes\(/g) || []).length, 0);
});

test("inspector tabs can open a centered floating window", () => {
  assert.equal((html.match(/data-action="float-inspector-panel"/g) || []).length, 3);
  assert.match(html, /data-float-panel="project"/);
  assert.match(html, /data-float-panel="node"/);
  assert.match(html, /data-float-panel="story"/);
  assert.match(css, /\.inspector-tab-group\s*\{[\s\S]*?grid-template-columns:\s*minmax\(0,\s*1fr\)\s*26px/);
});

test("Obsidian bundle contains the full canvas chrome", () => {
  assert.doesNotMatch(pluginBundle, /id="uiModeToggle"/);
  assert.match(pluginBundle, /float-inspector-panel/);
  assert.match(pluginBundle, /More export and import options/);
  assert.match(pluginBundle, /function isAdvancedUiMode\(\) \{\s*return true;/);
});

test("only Entry stays locked in the node library", () => {
  assert.match(app, /function isProtectedNodeType\(type\) \{\s*return type === "Entry";/);
  assert.match(app, /function isRestorableDefaultNodeType\(type\)/);
  assert.match(app, /system: isProtectedNodeType\(typeDef\.type\)/);
  assert.match(app, /system: isProtectedNodeType\(type\)/);
  assert.match(app, /isProtectedNodeType\(type\)\s*\?/);
  assert.doesNotMatch(app, /if \(typeDef\.system\)/);
});

test("node library uses catalog badges and icon buttons instead of lock/x text", () => {
  assert.match(app, /getNormalizedNodeTypeBadge\(typeDef\.type,\s*typeDef\.label,\s*typeDef\.badge/);
  assert.match(app, /CATALOG_NODE_TYPE_BADGES/);
  assert.match(app, /PALETTE_LOCK_ICON/);
  assert.match(app, /PALETTE_DELETE_ICON/);
  assert.doesNotMatch(app, /system-lock-button[^>]*>lock</);
  assert.match(css, /\.palette-action-icon/);
});

test("canvas language follows NarrativeLab and hides the local toggle in Obsidian", () => {
  assert.match(html, /id="languageToggle"[^>]*data-web-only/);
  assert.doesNotMatch(html, /id="themeToggle"[^>]*data-web-only/);
  assert.doesNotMatch(html, /data-action="open-sample-project"[^>]*data-web-only/);
  assert.match(app, /createSampleInActiveProject/);
});

test("canvas defaults to the full NarrativeCanvas chrome and fills the Obsidian leaf", async () => {
  const styles = await readFile(new URL("../styles.css", import.meta.url), "utf8");
  assert.match(app, /uiMode:\s*"advanced"/);
  assert.doesNotMatch(html, /id="uiModeToggle"/);
  assert.match(css, /display:\s*block;[\s\S]*?width:\s*100%;[\s\S]*?height:\s*100%;/);
  assert.match(styles, /\.narrative-canvas-plugin-host\s*\{/);
  assert.match(styles, /data-type="narrative-lab-canvas-view"/);
  assert.match(styles, /padding:\s*0\s*!important/);
});

test("native Canvas sync stays in advanced project tools", () => {
  assert.match(app, /data-action="\$\{escapeAttr\(item\.action\)\}"/);
  assert.match(app, /action: "sync-native-canvas"/);
  assert.match(app, /action: "read-native-canvas"/);
  assert.match(app, /project-export-controls nc-disclosure nc-advanced-only/);
  assert.match(pluginBundle, /getNarrativeCanvasProjectionPath/);
  assert.match(pluginBundle, /validateNarrativeCanvasProjection/);
});

test("flat corkboard exposes its native Obsidian Canvas at the far right", async () => {
  const [board, styles] = await Promise.all([
    readFile(new URL("../views/BoardView.ts", import.meta.url), "utf8"),
    readFile(new URL("../styles.css", import.meta.url), "utf8"),
  ]);
  assert.match(board, /story-line-open-native-action/);
  assert.match(board, /openCorkboardCanvasInTab\(\)/);
  assert.match(styles, /\.story-line-open-native-action\s*\{[\s\S]*?margin-left:\s*auto/);
});

test("library files and preview images share aligned controls", () => {
  assert.equal((app.match(/class="codex-asset-toolbar/g) || []).length, 2);
  assert.match(app, /class="small-button codex-asset-add-button"/);
  assert.match(app, /class="vision-board-expand-button"[^>]*data-action="open-vision-board"/);
  assert.match(css, /\.codex-asset-toolbar\s*\{[\s\S]*?grid-template-columns:/);
  assert.match(css, /\.vision-board-expand-button\s*\{[\s\S]*?position:\s*absolute;[\s\S]*?top:\s*8px;[\s\S]*?right:\s*8px;/);
  assert.match(pluginBundle, /vision-board-expand-button/);
});

test("canvas app exposes sample project creation at an exact path", () => {
  assert.match(app, /async function createSampleProjectAtPath\(/);
  assert.match(app, /createSampleProjectAtPath,/);
  assert.match(app, /writeAndOpenProjectAtPath/);
  assert.match(pluginBundle, /waitForCanvasAppMethod/);
  assert.match(pluginBundle, /createSampleProjectAtPath\(normalized, language\)/);
});

test("canvas library detail mounts the project profile outside shadow DOM", () => {
  assert.match(app, /mountLibraryProfile/);
  assert.match(app, /function getNodeBacklinks\(/);
  assert.match(app, /function focusLibraryNode\(/);
  assert.match(app, /closeLibraryProfile:\s*closeCodexEntryDetail/);
  assert.match(pluginBundle, /mountLibraryProfile/);
  assert.match(pluginBundle, /unmountLibraryProfile/);
});

test("canvas paints the host theme before the first frame", () => {
  assert.match(app, /function applyBootTheme\(\)/);
  assert.match(app, /applyBootTheme\(\);\s*const restoredView = await loadSavedState\(false\)/);
  assert.match(pluginBundle, /function mountCanvasShadow\(shadowRoot, bodyHtml, theme\)/);
  assert.match(pluginBundle, /setAttribute\("data-theme", bootTheme\)/);
  assert.match(pluginBundle, /mountCanvasShadow\(shadow, bodyHtml, bootTheme\)/);
  assert.match(pluginBundle, /querySelector\("\.app-shell"\)\?\.setAttribute\("data-theme", resolvedTheme\)/);
});

test("ncanvas library sync keeps unwritten embeds and drops deleted files", () => {
  assert.match(app, /Keep embeds that were never written/);
  assert.match(app, /was deleted — those keep a codexFile path/);
  assert.doesNotMatch(app, /if \(!Array\.isArray\(loaded\) \|\| !loaded\.length\) return false;/);
  assert.match(pluginBundle, /resolveCodexCategoryFolder/);
  assert.match(pluginBundle, /Never recreate from \.ncanvas snapshot/);
  assert.match(pluginBundle, /Brand-new canvas entry with no vault file yet/);
  assert.match(pluginBundle, /getCodexLibraryRootsForProject/);
  assert.match(pluginBundle, /resolveLoadedLibraryNotes/);
});

test("project canvas entry opens a card box before an individual canvas", async () => {
  const [main, constants, switcher, libraryView, styles] = await Promise.all([
    readFile(new URL("../main.ts", import.meta.url), "utf8"),
    readFile(new URL("../constants.ts", import.meta.url), "utf8"),
    readFile(new URL("../components/ViewSwitcher.ts", import.meta.url), "utf8"),
    readFile(new URL("../views/NCanvasLibraryView.ts", import.meta.url), "utf8"),
    readFile(new URL("../styles.css", import.meta.url), "utf8"),
  ]);
  assert.match(constants, /NCANVAS_LIBRARY_VIEW_TYPE\s*=\s*'narrative-lab-canvas-library'/);
  assert.match(main, /registerView\(NCANVAS_LIBRARY_VIEW_TYPE/);
  assert.match(main, /openNCanvasLibraryForCanvasPath/);
  assert.match(switcher, /openNCanvasLibrary\(getLeafNarrativeLabProjectFile\(leaf\), leaf\)/);
  assert.match(libraryView, /nl-ncanvas-card-grid/);
  assert.match(libraryView, /createBlankNcanvasInActiveProject/);
  assert.match(libraryView, /renameNcanvasInActiveProject/);
  assert.match(libraryView, /deleteNcanvasInActiveProject/);
  assert.match(styles, /\.nl-ncanvas-card-grid\s*\{/);
});

test("canvas card actions stay project-scoped and deletion uses Obsidian trash", async () => {
  const main = await readFile(new URL("../main.ts", import.meta.url), "utf8");
  assert.match(main, /requireActiveProjectNcanvas\(path: string\)/);
  assert.match(main, /getNcanvasPathsForProject\(project\)\.candidates/);
  assert.match(main, /await this\.app\.fileManager\.renameFile\(file, destination\)/);
  assert.match(main, /await this\.app\.fileManager\.trashFile\(file\)/);
  assert.match(main, /type: NCANVAS_LIBRARY_VIEW_TYPE,[\s\S]*?await this\.app\.fileManager\.trashFile/);
});

test("embedded canvas can return to the project canvas box", () => {
  assert.match(html, /data-action="open-canvas-library"/);
  assert.match(app, /window\.NarrativeCanvasHost\?\.openCanvasLibrary\?\.\(\)/);
  assert.match(pluginBundle, /openCanvasLibrary:\s*\(\)\s*=>/);
  assert.match(pluginBundle, /openNarrativeLabCanvasLibrary\(this\.file\)/);
});
