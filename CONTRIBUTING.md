# Contributing to NarrativeLab

Bug fixes, tests, documentation, translations, and focused feature improvements are welcome.

## Set up

```sh
git clone https://github.com/ringeringeraja33/NarrativeLab.git
cd NarrativeLab
npm ci
npm run check
```

Use a current Node.js LTS release. `package-lock.json` is authoritative; do not replace it with another package manager's lockfile.

## Development rules

- Keep vault operations inside Obsidian's Vault and FileManager APIs unless a feature is explicitly desktop-only.
- Use `normalizePath()` for constructed or user-provided vault paths.
- Preserve unknown frontmatter and note bodies when changing metadata.
- Treat project `Library/` folders as the category source of truth.
- Do not add telemetry, advertising, remote code, or silent network requests.
- Use Obsidian DOM helpers and CSS classes; do not place user content into `innerHTML`.
- Add English UI text through `t()` and supply Simplified Chinese coverage.
- Register long-lived events and disposables through the plugin lifecycle.
- Do not commit private vaults, screenshots with manuscript text, access tokens, or machine-specific plugin data.

## Checks

Run before opening a pull request:

```sh
npm run lint:obsidian
npm test
npm run build
```

Changes affecting project switching, filesystem transactions, Library synchronization, Base generation, spreadsheet persistence, or imports need a regression test. UI changes should be checked in English and Chinese, light and dark themes, and a narrow window. Mobile-sensitive changes should be checked without Node or Electron APIs.

## Pull requests

Keep a pull request limited to one coherent change. Explain the user-visible behavior, root cause for fixes, data-migration or compatibility impact, and validation performed. Include screenshots only when they contain no private data.

By contributing, you agree that your contribution is licensed under AGPL-3.0-only and that any retained third-party notices remain intact.
