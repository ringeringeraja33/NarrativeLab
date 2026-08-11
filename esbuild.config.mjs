import esbuild from "esbuild";
import process from "process";
import { copyFileSync, existsSync, mkdirSync, readdirSync } from "fs";
import { dirname, join } from "path";
import { fileURLToPath } from "url";
import { homedir } from "os";

const prod = process.argv[2] === "production";
const projectRoot = dirname(fileURLToPath(import.meta.url));
const oneDrive = join(homedir(), "Library/CloudStorage/OneDrive-个人/My Library");
const localVaultPlugin = join(homedir(), "Documents/Obsidian/.obsidian/plugins/narrative-lab");

/** Vault plugin folders that should receive the built plugin files. */
const DEPLOY_DIRS = [
  localVaultPlugin,
  join(oneDrive, "Projects/Game Design/.obsidian/plugins/narrative-lab"),
  join(oneDrive, ".obsidian/plugins/narrative-lab"),
].filter((dir) => existsSync(dirname(dir)) || existsSync(join(dirname(dir), "..")));

function deployPluginFiles() {
  const files = ["main.js", "manifest.json", "styles.css", "plotgrid-univer.js"];
  // Univer may emit CSS beside the chunk when using plugins; copy any plotgrid-univer*.css
  let extras = [];
  try {
    extras = readdirSync(projectRoot).filter(
      (name) => name.startsWith("plotgrid-univer") && name.endsWith(".css"),
    );
  } catch { /* ignore */ }
  for (const dir of DEPLOY_DIRS) {
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    for (const file of [...files, ...extras]) {
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

const univerContext = await esbuild.context({
  ...shared,
  entryPoints: [join(projectRoot, "services/plotgrid-univer-entry.ts")],
  outfile: join(projectRoot, "plotgrid-univer.js"),
  // CSS imported as text then injected at runtime by host if needed — also
  // keep a side-effect import path: inject via banner.
  banner: {
    js: "try{if(typeof document!=='undefined'){window.__NL_UNIVER_CSS__=window.__NL_UNIVER_CSS__||[];}}catch(e){}",
  },
});

if (prod) {
  await Promise.all([mainContext.rebuild(), univerContext.rebuild()]);
  deployPluginFiles();
  process.exit(0);
} else {
  await Promise.all([mainContext.watch(), univerContext.watch()]);
}
