# Obsidian Community submission

This file contains the maintainer checklist and copy for NarrativeLab's first Community Plugins submission. It is not a substitute for the automated checks at `community.obsidian.md`.

## Directory entry

| Field | Value |
| --- | --- |
| Repository | `https://github.com/ringeringeraja33/NarrativeLab` |
| Plugin ID | `narrative-lab` |
| Name | `NarrativeLab` |
| Author | `ringeringeraja33` |
| Version | `1.0.0` |
| Minimum Obsidian version | `1.12.7` |
| Desktop only | No |
| Description | Plan, draft, and manage narrative projects with structured scenes, a recursive Library, spreadsheets, and Narrative Canvas. |

The ID `narrative-lab` was checked against the public Community Plugins list before this release was prepared and was not present at that time. The directory performs the authoritative uniqueness check during submission.

## Required repository files

- [x] `README.md` explains purpose, setup, use, privacy, support, and licensing.
- [x] `README.zh-CN.md` provides Simplified Chinese user documentation.
- [x] `LICENSE` contains AGPL-3.0-only.
- [x] `LICENSE-NarrativeCanvas`, `LICENSE-Storyline`, `LICENSE-WebNovelAssistant`, and `NOTICE.md` retain upstream notices.
- [x] `manifest.json` is at the repository root and matches `package.json`.
- [x] `versions.json` maps the current release to `minAppVersion`.
- [x] `main.js` and `styles.css` are production build outputs.
- [x] `SECURITY.md`, `SUPPORT.md`, and `CONTRIBUTING.md` define maintenance channels.
- [x] `package-lock.json` is committed.

## Required GitHub release

1. Merge the release preparation into the default branch.
2. Confirm `npm ci && npm run check` succeeds from a clean checkout.
3. Create and push the tag `1.0.0` with no `v` prefix.
4. The release workflow verifies that the tag equals `manifest.json#version`, builds from the tag, and creates a GitHub release.
5. Confirm the release has the individual assets `main.js`, `manifest.json`, and `styles.css`.
6. Install those exact assets in a clean vault and repeat the smoke test below.

## Smoke test

- Enable NarrativeLab in a clean vault and create a project outside the vault root.
- Create, edit, rename, move, deactivate, and restore a scene.
- Create Character and Location entries; add, rename, and remove a custom Library folder after reading the confirmation.
- Confirm `Library/library.base` opens and its New action creates a note in the selected category folder.
- Enter formulas, formatting, Markdown, and a wikilink in the Concept Grid; resize rows and columns; restart Obsidian; confirm the `.xlsx` round-trip.
- Apply a structure template in merge and replace-preview modes; verify no scene file is silently deleted.
- Open two projects in separate leaves and verify navigation, Library categories, and selections do not cross over.
- Open a Narrative Canvas, edit it, playtest it, and optionally create a native Canvas projection.
- Repeat core navigation in English and Simplified Chinese, light and dark themes, and a narrow window.
- On mobile, verify project discovery, basic editing, Library browsing, and the absence of desktop-only Scrivener controls.

## Disclosures for review

- Local-first; no account, payment, advertisements, telemetry, or analytics.
- No remote-code loading.
- Network requests are limited to fetching a remote image that the user already referenced when the user requests rendering/export.
- Vault content is not uploaded.
- The desktop Scrivener importer reads only a folder explicitly selected by the user.
- Project content remains in the vault after uninstall.
- NarrativeLab includes modified AGPL and MIT upstream work with retained notices.

## Submission steps

1. In the GitHub repository settings, enable private vulnerability reporting and confirm Issues and Actions are enabled.
2. Add repository topics such as `obsidian-plugin`, `writing`, `story-planning`, and `narrative-design`.
3. Sign in at [community.obsidian.md](https://community.obsidian.md) with the maintainer's Obsidian account.
4. Link the GitHub account that owns `ringeringeraja33/NarrativeLab`.
5. Select **Plugins → New plugin** and submit the repository URL.
6. Review and accept the current developer policies and maintenance commitment.
7. Resolve automated findings by committing fixes and publishing an incremented release; do not replace assets on an existing version.

Before submission, optionally add screenshots made from a clean demonstration vault. Do not publish screenshots from personal projects or screenshots containing private paths.

Obsidian reads `manifest.json` from the default branch and installs assets from the GitHub release whose tag exactly matches its version.
