/**
 * Report or remove duplicate Chinese UI keys across the dictionaries merged by
 * utils/i18n.ts. The last dictionary wins at runtime, so --fix keeps the last
 * occurrence and removes only entries that are already shadowed.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const files = [
    'utils/i18n-main.zh.ts',
    'utils/i18n-views.zh.ts',
    'utils/i18n-entities.zh.ts',
    'utils/i18n-beats.zh.ts',
    'utils/i18n-extra.zh.ts',
    'utils/i18n.ts',
];
const entryPattern = /^\s*('(?:\\.|[^'\\])*'|"(?:\\.|[^"\\])*")\s*:/;
const records = [];

function decodeKey(raw) {
    const inner = raw.slice(1, -1);
    return inner
        .replace(/\\'/g, "'")
        .replace(/\\"/g, '"')
        .replace(/\\\\/g, '\\');
}

for (const relativePath of files) {
    const absolutePath = path.join(root, relativePath);
    const lines = fs.readFileSync(absolutePath, 'utf8').split('\n');
    lines.forEach((line, index) => {
        const match = entryPattern.exec(line);
        if (!match) return;
        records.push({ relativePath, absolutePath, lines, index, key: decodeKey(match[1]) });
    });
}

const lastByKey = new Map();
for (const record of records) lastByKey.set(record.key, record);
const shadowed = records.filter(record => lastByKey.get(record.key) !== record);

if (!process.argv.includes('--fix')) {
    console.log(`${shadowed.length} shadowed entries across ${new Set(shadowed.map(item => item.key)).size} keys`);
    process.exitCode = shadowed.length > 0 ? 1 : 0;
} else {
    for (const record of shadowed) record.lines[record.index] = null;
    for (const relativePath of files) {
        const matching = records.find(record => record.relativePath === relativePath);
        if (!matching) continue;
        const content = matching.lines.filter(line => line !== null).join('\n');
        fs.writeFileSync(matching.absolutePath, content);
    }
    console.log(`Removed ${shadowed.length} shadowed entries; effective translations are unchanged.`);
}
