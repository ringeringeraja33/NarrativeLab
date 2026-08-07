/**
 * Remove duplicate keys from uiTranslations.zh in canvas-runtime sources.
 * Keeps the first occurrence of each key (esbuild warns on later duplicates).
 */
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const files = [
  path.join(__dirname, '..', 'canvas-runtime', 'app.js'),
  path.join(__dirname, '..', 'canvas-runtime', 'main.js'),
];

function dedupeFile(file) {
  if (!fs.existsSync(file)) {
    console.warn(`skip missing: ${file}`);
    return;
  }
  const src = fs.readFileSync(file, 'utf8');
  const nl = src.includes('\r\n') ? '\r\n' : '\n';

  // Match both top-level and indented forms:
  //   const uiTranslations = {\n  zh: {
  //     const uiTranslations = {\n    zh: {
  const startRe = /(?:^|\n)([ \t]*const uiTranslations = \{)\r?\n([ \t]*zh: \{)/;
  const startMatch = startRe.exec(src);
  if (!startMatch) {
    console.error(`uiTranslations.zh not found in ${path.basename(file)}`);
    return;
  }

  const start = startMatch.index + (startMatch[0].startsWith('\n') ? 1 : 0);
  const zhOpen = start + startMatch[0].length - (startMatch[0].startsWith('\n') ? 1 : 0) - 1;

  let depth = 0;
  let end = -1;
  for (let i = zhOpen; i < src.length; i++) {
    const ch = src[i];
    if (ch === '{') depth++;
    else if (ch === '}') {
      depth--;
      if (depth === 0) {
        end = i;
        break;
      }
    }
  }
  if (end < 0) {
    console.error(`uiTranslations.zh end not found in ${path.basename(file)}`);
    return;
  }

  const before = src.slice(0, start);
  const zhOuter = src.slice(start, end + 1);
  const after = src.slice(end + 1);

  const entryRe = /^\s*"((?:\\.|[^"\\])*)"\s*:\s*"((?:\\.|[^"\\])*)"\s*,?\s*$/;
  const seen = new Set();
  let removed = 0;
  const kept = zhOuter.split(/\r?\n/).filter((line) => {
    const m = entryRe.exec(line);
    if (!m) return true;
    const key = m[1];
    if (seen.has(key)) {
      removed++;
      return false;
    }
    seen.add(key);
    return true;
  });

  fs.writeFileSync(file, before + kept.join(nl) + after);
  console.log(`${path.basename(file)}: removed ${removed} duplicate ZH keys (${seen.size} unique remain)`);
}

for (const file of files) dedupeFile(file);
