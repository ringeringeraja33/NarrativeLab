import assert from 'node:assert/strict';
import fs from 'node:fs';

const packageJson = JSON.parse(fs.readFileSync('package.json', 'utf8'));
const manifest = JSON.parse(fs.readFileSync('manifest.json', 'utf8'));
const versions = JSON.parse(fs.readFileSync('versions.json', 'utf8'));

assert.equal(manifest.id, 'narrative-lab', 'manifest id must remain narrative-lab');
assert.equal(packageJson.version, manifest.version, 'package.json and manifest.json versions differ');
assert.equal(versions[manifest.version], manifest.minAppVersion, 'versions.json lacks the current release mapping');
assert.ok(fs.existsSync('main.js'), 'main.js has not been built');
assert.ok(fs.existsSync('styles.css'), 'styles.css is missing');
console.log(`Release metadata is consistent for NarrativeLab ${manifest.version}.`);
