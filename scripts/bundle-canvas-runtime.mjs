import { readFile, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const mainPath = path.join(root, "canvas-runtime", "main.js");
const cssPath = path.join(root, "canvas-runtime", "canvas.css");
const htmlPath = path.join(root, "canvas-runtime", "index.html");
const appPath = path.join(root, "canvas-runtime", "app.js");

const [mainSource, cssSource, htmlSource, rawAppSource] = await Promise.all([
  readFile(mainPath, "utf8"),
  readFile(cssPath, "utf8"),
  readFile(htmlPath, "utf8"),
  readFile(appPath, "utf8")
]);

function encodeLines(source, options = {}) {
  const encodeAngles = Boolean(options.encodeAngles);
  return source.replace(/\r\n/g, "\n").replace(/\n$/, "").split("\n").map((line) => {
    let encoded = JSON.stringify(line);
    if (encodeAngles) encoded = encoded.replaceAll("<", "\\u003c").replaceAll(">", "\\u003e");
    return `  ${encoded},`;
  }).join("\n");
}

function replaceDelimited(source, startMarker, endMarker, replacement) {
  const start = source.indexOf(startMarker);
  const end = source.indexOf(endMarker, start + startMarker.length);
  if (start < 0 || end < 0) throw new Error(`Could not find bundle markers: ${startMarker}`);
  return `${source.slice(0, start + startMarker.length)}\n${replacement}\n${source.slice(end)}`;
}

function replaceMarkedRuntime(source, name, replacement) {
  const startMarker = `// BEGIN WEB_RUNTIME:${name}`;
  const endMarker = `// END WEB_RUNTIME:${name}`;
  const start = source.indexOf(startMarker);
  const end = source.indexOf(endMarker, start + startMarker.length);
  if (start < 0 || end < 0) throw new Error(`Could not find web runtime block: ${name}`);
  return `${source.slice(0, start)}${replacement}${source.slice(end + endMarker.length)}`;
}

const shadowCss = cssSource
  .replace(/:root(\[[^\]]+\])/g, ":host($1)")
  .replace(/:root/g, ":host");

let appSource = rawAppSource;
appSource = replaceMarkedRuntime(appSource, "AI_CONFIG", `function getWebAiConfig() {
  return { endpoint: "", apiKey: "", model: "" };
}

function saveWebAiConfig() {
  return;
}`);
appSource = replaceMarkedRuntime(appSource, "AI_REQUEST", `async function requestWebAiCompletion(_payload, _options) {
  throw new Error("AI networking is only available through the Narrative Canvas host in Obsidian.");
}`);
appSource = replaceMarkedRuntime(appSource, "CLEAR_STORAGE", `async function clearBrowserStorageFromUi() {
  return;
}

async function clearBrowserStorageConfirmed() {
  return;
}`);
appSource = replaceMarkedRuntime(appSource, "PROJECT_STORAGE", `function loadWebState() {
  return null;
}

function saveWebState(_savedState) {
  return;
}

function getWebProjectStorage() {
  // Obsidian-plugin bundle: persistence runs through NarrativeCanvasHost, no browser storage.
  return null;
}`);

let nextMain = replaceDelimited(
  mainSource,
  "const CANVAS_STYLE_CSS = [",
  `].join("\\n");`,
  encodeLines(shadowCss)
);
nextMain = replaceDelimited(
  nextMain,
  "const CANVAS_INDEX_HTML = [",
  `].join("\\n");`,
  encodeLines(htmlSource, { encodeAngles: true })
);

const appStart = "  // BEGIN bundled app.js";
const appEnd = "  // END bundled app.js";
const indentedApp = appSource.replace(/\r\n/g, "\n").replace(/\n$/, "").split("\n").map((line) => line ? `  ${line}` : "").join("\n");
nextMain = replaceDelimited(nextMain, appStart, appEnd, indentedApp);

await writeFile(mainPath, nextMain);
console.log("Bundled canvas-runtime/index.html, canvas.css, and app.js into canvas-runtime/main.js");
