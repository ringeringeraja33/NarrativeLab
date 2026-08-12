import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const [app, html, css, pluginBundle] = await Promise.all([
  readFile(new URL("../canvas-runtime/app.js", import.meta.url), "utf8"),
  readFile(new URL("../canvas-runtime/index.html", import.meta.url), "utf8"),
  readFile(new URL("../canvas-runtime/canvas.css", import.meta.url), "utf8"),
  readFile(new URL("../canvas-runtime/main.js", import.meta.url), "utf8")
]);

test("basic canvas mode keeps the four common creation types", () => {
  assert.match(app, /BASIC_NODE_TYPE_SET = new Set\(\["Content", "Dialog", "Choice", "Event"\]\)/);
  assert.match(app, /function getAddableNodeTypeEntries\(\)/);
  assert.match(app, /BASIC_NODE_TYPE_SET\.has\(type\) \|\| meta\.custom/);
});

test("advanced canvas surfaces are hidden without removing their controls", () => {
  assert.match(css, /data-ui-mode="basic"\] \.nc-advanced-only/);
  assert.match(html, /data-file-id="document"[^>]*nc-advanced-only|nc-advanced-only[^>]*data-file-id="document"/);
  assert.match(html, /data-file-id="variables"[^>]*nc-advanced-only|nc-advanced-only[^>]*data-file-id="variables"/);
  assert.doesNotMatch(html, /data-file-id="events"[^>]*nc-advanced-only|nc-advanced-only[^>]*data-file-id="events"/);
  assert.match(html, /id="aiFloatingButton"[^>]*nc-advanced-only|nc-advanced-only[^>]*id="aiFloatingButton"/);
  assert.match(html, /id="uiModeToggle"/);
});

test("event table stays basic while edit document is advanced-only", () => {
  assert.match(app, /\["document", "variables"\]\.includes\(fileId\)/);
  assert.match(app, /\["document", "variables"\]\.includes\(state\.activeFileId\)/);
  assert.equal((app.match(/\["events", "variables"\]\.includes\(/g) || []).length, 0);
});

test("inspector uses one current-panel float control", () => {
  assert.equal((html.match(/data-action="float-current-inspector"/g) || []).length, 1);
  assert.equal((html.match(/data-action="float-inspector-panel"/g) || []).length, 0);
});

test("Obsidian bundle contains the simplified canvas UI", () => {
  assert.match(pluginBundle, /uiModeToggle/);
  assert.match(pluginBundle, /float-current-inspector/);
  assert.match(pluginBundle, /More export and import options/);
  assert.match(pluginBundle, /data-ui-mode/);
});

test("native Canvas sync stays in advanced project tools", () => {
  assert.match(app, /data-action="\$\{escapeAttr\(item\.action\)\}"/);
  assert.match(app, /action: "sync-native-canvas"/);
  assert.match(app, /action: "read-native-canvas"/);
  assert.match(app, /project-export-controls nc-disclosure nc-advanced-only/);
  assert.match(pluginBundle, /getNarrativeCanvasProjectionPath/);
  assert.match(pluginBundle, /validateNarrativeCanvasProjection/);
});

test("library files and preview images share aligned controls", () => {
  assert.equal((app.match(/class="codex-asset-toolbar/g) || []).length, 2);
  assert.match(app, /class="small-button codex-asset-add-button"/);
  assert.match(app, /class="vision-board-expand-button"[^>]*data-action="open-vision-board"/);
  assert.match(css, /\.codex-asset-toolbar\s*\{[\s\S]*?grid-template-columns:/);
  assert.match(css, /\.vision-board-expand-button\s*\{[\s\S]*?position:\s*absolute;[\s\S]*?top:\s*8px;[\s\S]*?right:\s*8px;/);
  assert.match(pluginBundle, /vision-board-expand-button/);
});
