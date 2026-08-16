import esbuild from "esbuild";
import process from "process";
import { copyFileSync, existsSync, readdirSync, realpathSync } from "fs";
import { homedir } from "os";
import { basename, delimiter, dirname, join, resolve } from "path";
import { fileURLToPath } from "url";

const prod = process.argv[2] === "production";
const projectRoot = dirname(fileURLToPath(import.meta.url));
const home = homedir();

const SKIP_DIR_NAMES = new Set([
  "node_modules",
  ".git",
  ".Trash",
  ".npm",
  ".cache",
  "Caches",
  "Cache",
  "DerivedData",
  "Logs",
]);

const SEARCH_ROOTS = [
  join(home, "Documents"),
  join(home, "Desktop"),
  join(home, "Library/CloudStorage"),
  join(home, "OneDrive"),
  join(home, "iCloudDrive"),
  join(home, "Library/Mobile Documents"),
  join(home, "Library/Group Containers"),
];

function extraPaths(envName) {
  return (process.env[envName] || "")
    .split(delimiter)
    .map((dir) => dir.trim())
    .filter(Boolean)
    .map((dir) => resolve(dir));
}

function isPluginDir(dir) {
  return basename(dir) === "narrative-lab" && basename(dirname(dir)) === "plugins";
}

function collectNarrativeLabPluginDirs(root, found, walked) {
  if (!existsSync(root)) return;
  let real;
  try {
    real = realpathSync(root);
  } catch {
    return;
  }
  if (walked.has(real)) return;
  walked.add(real);

  let entries;
  try {
    entries = readdirSync(root, { withFileTypes: true });
  } catch {
    return;
  }

  for (const entry of entries) {
    if (!entry.isDirectory() && !entry.isSymbolicLink()) continue;
    const name = entry.name;
    if (SKIP_DIR_NAMES.has(name)) continue;
    if (name.startsWith(".") && name !== ".obsidian" && name !== ".obsidianMac") continue;
    const full = join(root, name);
    if (name === "narrative-lab" && isPluginDir(full)) {
      if (resolve(full) === projectRoot) continue;
      found.add(full);
      continue;
    }
    collectNarrativeLabPluginDirs(full, found, walked);
  }
}

function discoverDeployDirs() {
  const found = new Set();
  const walked = new Set();
  for (const root of [...SEARCH_ROOTS, ...extraPaths("NARRATIVE_LAB_DEPLOY_ROOTS")]) {
    collectNarrativeLabPluginDirs(root, found, walked);
  }
  for (const dir of extraPaths("NARRATIVE_LAB_DEPLOY_DIRS")) {
    if (existsSync(dir) && isPluginDir(dir)) found.add(dir);
  }
  return [...found].sort();
}

function deployPluginFiles() {
  const files = ["main.js", "manifest.json", "styles.css"];
  const dirs = discoverDeployDirs();
  if (dirs.length === 0) {
    console.warn("[deploy] no narrative-lab plugin folders found");
    return;
  }
  for (const dir of dirs) {
    for (const file of files) {
      const src = join(projectRoot, file);
      if (!existsSync(src)) continue;
      copyFileSync(src, join(dir, file));
    }
    console.log(`[deploy] → ${dir}`);
  }
}

const shared = {
  absWorkingDir: projectRoot,
  bundle: true,
  external: [
    "obsidian",
    "electron",
    "path",
    "fs",
    "os",
    "@codemirror/autocomplete",
    "@codemirror/collab",
    "@codemirror/commands",
    "@codemirror/language",
    "@codemirror/lint",
    "@codemirror/search",
    "@codemirror/state",
    "@codemirror/view",
    "@lezer/common",
    "@lezer/highlight",
    "@lezer/lr",
  ],
  format: "cjs",
  target: "es2018",
  logLevel: "info",
  sourcemap: prod ? false : "inline",
  treeShaking: true,
  minify: prod,
  loader: {
    ".md": "text",
    ".css": "text",
    ".svg": "dataurl",
    ".png": "dataurl",
    ".woff": "dataurl",
    ".woff2": "dataurl",
  },
};

const mainContext = await esbuild.context({
  ...shared,
  entryPoints: [join(projectRoot, "main.ts")],
  outfile: join(projectRoot, "main.js"),
  plugins: [
    {
      name: "deploy-to-vault",
      setup(build) {
        build.onEnd((result) => {
          if (result.errors.length === 0) {
            try {
              deployPluginFiles();
            } catch (err) {
              console.warn("[deploy] skipped:", err instanceof Error ? err.message : err);
            }
          }
        });
      },
    },
  ],
});

if (prod) {
  await mainContext.rebuild();
  process.exit(0);
} else {
  await mainContext.watch();
}
