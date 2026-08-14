import esbuild from "esbuild";
import process from "process";
import { copyFileSync, existsSync, mkdirSync } from "fs";
import { delimiter, dirname, join, resolve } from "path";
import { fileURLToPath } from "url";

const prod = process.argv[2] === "production";
const projectRoot = dirname(fileURLToPath(import.meta.url));

/** Optional, path-delimited vault plugin folders that receive build outputs. */
const DEPLOY_DIRS = (process.env.NARRATIVE_LAB_DEPLOY_DIRS ?? "")
  .split(delimiter)
  .map((dir) => dir.trim())
  .filter(Boolean)
  .map((dir) => resolve(dir));

function deployPluginFiles() {
  // These are the only files downloaded by an Obsidian community install.
  const files = ["main.js", "manifest.json", "styles.css"];
  for (const dir of DEPLOY_DIRS) {
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
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
