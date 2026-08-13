# Support

Use [GitHub Issues](https://github.com/ringeringeraja33/NarrativeLab/issues) for reproducible bugs and focused feature requests. Use GitHub Discussions, when enabled, for workflows and open-ended design questions.

Before filing an issue:

1. Update to the latest NarrativeLab release and a supported Obsidian version.
2. Reload Obsidian and reproduce the issue in the same project.
3. Check whether the issue also occurs with a small test project.
4. Back up the vault before testing file moves, category deletion, series conversion, or project import.
5. Search existing issues.

A useful report includes the NarrativeLab version, Obsidian version, operating system, interface language, exact actions, expected result, actual result, console errors, and a redacted sample project if the failure depends on file structure.

Do not post private manuscript text, personal file paths, access tokens, or unredacted vault screenshots. Report security issues through [SECURITY.md](./SECURITY.md), not a public issue.

## Recovery notes

- NarrativeLab project content remains ordinary vault files after the plugin is disabled.
- Project configuration and transaction journals are stored under the project's `System/` directory.
- Files moved through Obsidian's trash mechanism can usually be recovered according to the vault's **Files and links → Deleted files** setting.
- Keep an external or versioned backup; sync is not a backup.
