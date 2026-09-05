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
assert.ok(fs.existsSync('README.md'), 'README.md is missing');
assert.ok(fs.existsSync('LICENSE'), 'LICENSE is missing');
assert.match(manifest.version, /^\d+\.\d+\.\d+$/, 'manifest version must use x.y.z SemVer');
assert.equal(manifest.author, 'ringeringeraja33', 'manifest author does not match the repository owner');
assert.equal(manifest.isDesktopOnly, false, 'mobile-compatible plugin must not be marked desktop-only');
assert.ok(!fs.existsSync('plotgrid-univer.js'), 'obsolete runtime chunk must not ship outside main.js');
const mainBundle = fs.readFileSync('main.js', 'utf8');
assert.ok(mainBundle.includes('narrativelab-univer-sheets-css'), 'main.js does not contain the integrated Univer host');
console.log(`Release metadata is consistent for WritingLab ${manifest.version}.`);
