# NarrativeLab

[简体中文](./README.zh-CN.md) · [Changelog](./CHANGELOG.md) · [Support](./SUPPORT.md) · [Security](./SECURITY.md)

NarrativeLab is an Obsidian workspace for planning, drafting, and maintaining narrative projects. It keeps scenes, structure, research, reusable Library assets, spreadsheets, and interactive narrative canvases together while storing project content as ordinary files in your vault.

## What NarrativeLab provides

- **Project workspace:** board, manuscript, structure, statistics, notes, research, and Library views in one project-aware interface.
- **Scene planning:** acts, chapters, ordering, statuses, point of view, locations, characters, plotlines, setup/payoff links, custom fields, and templates.
- **Structure tools:** timeline, track comparison, plot list, subway map, chapter templates, beat sheets, and placeholder-scene generation.
- **Recursive Library:** Characters and Locations by default, plus any categories represented by direct subfolders under `Library/`. Folder creation, rename, and deletion stay synchronized with tabs and the native Obsidian Base.
- **Archive pages:** editable profile sections, custom fields, galleries, references, notes, and horizontal or vertical layouts saved separately for each category.
- **Concept Grid:** an embedded Univer spreadsheet saved as `Library/datasheet.xlsx`, with formatting, formulas, filters, cell sizing, Markdown, HTML, Obsidian wikilinks, and focused cell editing.
- **Narrative Canvas:** embedded `.ncanvas` authoring and playtesting, with optional projection to native Obsidian Canvas.
- **Series management:** shared and book-local Library assets, project promotion/demotion, membership changes, and transactional migration recovery.
- **Templates and exports:** scene, structure, and project templates; Markdown, HTML, PDF, DOCX, project bundle, Scrivener import, and canvas conversion workflows.
- **English and Simplified Chinese UI.**

## Requirements

- Obsidian **1.12.7 or later**.
- Desktop and mobile are supported. Scrivener import and native desktop folder pickers are available only in the desktop app.
- The Concept Grid is functional on mobile, but a desktop-sized workspace is recommended for large sheets.

## Quick start

1. Enable NarrativeLab in **Settings → Community plugins**.
2. Run **NarrativeLab: Open project** from the command palette or select the NarrativeLab ribbon icon.
3. Select **New project**, choose a name and optional vault location, then open it.
4. Create scenes from the Board or Structure workspace.
5. Add characters and locations from the Library. Create another direct `Library/` subfolder whenever the project needs a new category.
6. Open **Narrative Canvas** when you want node-based authoring or playtesting.

NarrativeLab never creates a replacement project merely because an existing project folder was moved. Open projects are bound to their own workspace leaves, so several projects may remain open together.

## Project files

A project can live anywhere in the vault. NarrativeLab discovers its Markdown manifest from frontmatter instead of requiring one global project root.

```text
Any folder/
  Project name/
    Project name.md       # type: narrative-lab
    Canvas/
      corkboard.canvas
      Project name.ncanvas
      Project name.narrative.canvas  # optional native projection
    Library/
      library.base
      datasheet.xlsx
      Characters/
      Locations/
      ...custom categories
    Scenes/
    Notes/
    Research/
    System/
      Templates/
      library-categories.json
      library-profile-layout.json
```

Legacy `type: storyline` manifests and `Codex/` folders remain readable. New projects use `type: narrative-lab` and `Library/`. NarrativeLab ignores Excalidraw Markdown drawings while indexing Library entities.

## Library behavior

The filesystem is the source of truth for project categories. Direct child folders under `Library/` become category tabs. Renaming a folder renames the corresponding category and Base view; deleting it removes that category after confirmation. Character and Location remain the initial built-in folders, and other categories are opt-in.

In a series, a project view can include shared series assets and project-local assets without mixing similarly named folders from another project. Unreferenced legacy Base files and orphan category state are cleaned during reconciliation.

## Templates

The Template Center manages:

- scene templates;
- narrative structures containing acts, chapters, and beats;
- project presets containing structure, Library categories, and field templates.

Templates can be global or project-scoped. Project templates are stored under `System/Templates/`, outside Library scanning. Applying a structure shows a change preview and does not delete existing scene files.

## Data, privacy, and network access

NarrativeLab is local-first.

- No account, payment, advertising, analytics, or telemetry is used.
- Project content stays in the vault. Plugin-wide preferences use Obsidian plugin data; project-specific layout and structure state is stored under the project's `System/` folder.
- NarrativeLab does not download or execute remote code.
- Network access occurs only when a user-authored document references a remote image and the user asks NarrativeLab to render or export that image. No vault text is uploaded.
- The desktop-only Scrivener importer can read a `.scriv` folder explicitly selected by the user. Other file operations use Obsidian's vault APIs.
- Uninstalling the plugin does not delete project Markdown, Library files, canvases, Bases, or spreadsheets.

See [Security](./SECURITY.md) for vulnerability reporting and [Support](./SUPPORT.md) for backup and troubleshooting guidance.

## Installation

### Community Plugins

After approval, install **NarrativeLab** from **Settings → Community plugins → Browse**.

### Manual or beta installation

Download `main.js`, `manifest.json`, and `styles.css` from a release whose tag exactly matches the manifest version. Place them in:

```text
<vault>/.obsidian/plugins/narrative-lab/
```

Reload Obsidian, then enable NarrativeLab. BRAT can also install the repository for beta testing.

## Development

```sh
git clone https://github.com/ringeringeraja33/NarrativeLab.git
cd NarrativeLab
npm ci
npm run check
```

Useful commands:

- `npm run dev` — watch and build.
- `npm test` — typecheck, translation audit, unit tests, and release metadata checks.
- `npm run lint:obsidian` — Obsidian plugin review lint rules.
- `npm run build` — production bundle. Set the path-delimited `NARRATIVE_LAB_DEPLOY_DIRS` environment variable to copy build outputs into one or more development-vault plugin folders.

The Community Plugins runtime is fully contained in `main.js`; releases do not require extra JavaScript chunks.

## Support and contributing

Before opening a bug report, reproduce the problem with the latest release and include the Obsidian version, operating system, NarrativeLab version, affected project layout, and relevant console errors. Do not attach private vault content unless it has been redacted.

See [CONTRIBUTING.md](./CONTRIBUTING.md) for development and pull-request requirements.

## License and attribution

NarrativeLab is distributed under **AGPL-3.0-only**. It combines work derived from NarrativeCanvas (AGPL-3.0) and obsidian-storyline (MIT). Original license notices are retained in [LICENSE-NarrativeCanvas](./LICENSE-NarrativeCanvas), [LICENSE-Storyline](./LICENSE-Storyline), and [NOTICE.md](./NOTICE.md).
