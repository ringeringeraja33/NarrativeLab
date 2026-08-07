import esbuild from "esbuild";
import process from "process";
import { copyFileSync, existsSync, mkdirSync } from "fs";
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
  // Narrative Canvas is bundled into main.js — do not copy canvas-runtime/ to vaults.
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

const context = await esbuild.context({
  absWorkingDir: projectRoot,
  entryPoints: [join(projectRoot, "main.ts")],
  bundle: true,
  external: [
    "obsidian",
    "electron",
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
  outfile: join(projectRoot, "main.js"),
  minify: prod,
  loader: {
    ".md": "text",
  },
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
  await context.rebuild();
  process.exit(0);
} else {
  await context.watch();
}
