#!/usr/bin/env node
/**
 * NarrativeLab develops from ~/Developer/NarrativeLab (outside OneDrive).
 * Refuse to leave node_modules under CloudStorage — OneDrive follows symlinks
 * and floods sync with ~18k dependency files.
 */
const fs = require('fs');
const path = require('path');

const projectRoot = path.resolve(__dirname, '..');
const local = path.join(projectRoot, 'node_modules');
const underCloud = /\/(CloudStorage|OneDrive|iCloud)(\/|$)/i.test(projectRoot);

if (!underCloud) process.exit(0);

console.warn(
  '[narrative-lab] This tree is under cloud sync.\n' +
  '  Use ~/Developer/NarrativeLab (or git clone github.com/ringeringeraja33/NarrativeLab).\n' +
  '  Removing any node_modules symlink/folder here to protect OneDrive.'
);
try {
  if (fs.existsSync(local)) fs.rmSync(local, { recursive: true, force: true });
} catch (err) {
  console.warn('[narrative-lab]', err.message || err);
}
