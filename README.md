# WritingLab

WritingLab is a modular workspace for essays, research papers, literature reviews, and long-form narrative projects. Its lightweight writing core can be extended per project with Obsidian Canvas and Bases, a Library, Univer spreadsheets, research tools, and structured narrative planning.

## What WritingLab combines

- **Obsidian native Canvas** — project corkboards and optional narrative projections use Obsidian's `.canvas` format and Canvas view.
- **Obsidian native Bases (Database)** — Library browsing uses Obsidian Bases as the native database/table surface for Markdown entities.
- **[Storyline](https://github.com/PixeroJan/obsidian-storyline)** — the project, scene, character, location, Library, and narrative-planning workflow builds on and extends ideas and code from the Storyline plugin.
- **[obsidian-webnovel-assistant](https://github.com/HatanoChihiro/obsidian-webnovel-assistant)** — the writing tracker sidebar, word-count heatmap, and floating sticky notes absorb and adapt work from HatanoChihiro's Web Novel Assistant.
- **[Univer](https://github.com/dream-num/univer)** — the Concept Grid embeds Univer Sheets for workbook editing, formulas, formatting, filtering, and Excel-compatible data exchange.
- **[Obsidian Univer Plugin](https://github.com/dream-num/obsidian-univer)** — WritingLab acknowledges the earlier Obsidian integration of Univer as an implementation reference. WritingLab's Concept Grid is integrated into its own project and data model rather than requiring the separate plugin.
- **[Narrative Canvas](https://github.com/ringeringeraja33/NarrativeCanvas)** — the node-based narrative workspace is bundled as an internal project view.

WritingLab is an independent project and is not affiliated with Obsidian, DreamNum/Univer, or the maintainers of the referenced plugins.

WritingLab stores project content as ordinary files in your vault. Every project chooses only the modules it needs, and modules can be enabled or disabled later without deleting their data.

## What WritingLab provides

- **Modular project workspace:** lightweight manuscript and word tracking, with optional notes, research, Library, tables, Canvas, scenes, structure, and narrative tools.
- **Project presets:** plain writing, essay, research paper, literature review, novel, full narrative, and custom module selections.
- **Native document list:** projects without Scenes open their Markdown documents through a project-specific Obsidian Base.
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

1. Enable WritingLab in **Settings → Community plugins**.
2. Run **WritingLab: Open project** from the command palette or select the WritingLab ribbon icon.
3. Select **New project**, choose a name and optional vault location, then open it.
4. Create scenes from the Board or Structure workspace.
5. Add characters and locations from the Library. Create another direct `Library/` subfolder whenever the project needs a new category.
6. Open **Narrative Canvas** when you want node-based authoring or playtesting.

WritingLab never creates a replacement project merely because an existing project folder was moved. Open projects are bound to their own workspace leaves, so several projects may remain open together.

## Project files

A project can live anywhere in the vault. WritingLab discovers its Markdown manifest from frontmatter instead of requiring one global project root.

```text
Any folder/
  Project name/
    Project name.md       # type: narrative-lab
    writing-<projectName>.base  # native document list when Scenes is disabled
    Canvas/
      corkboard-<projectName>.canvas
      Project name.ncanvas
      Project name.narrative.canvas  # optional native projection
    Library/
      library-<projectName>.base
      datasheet-<projectName>.xlsx
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

Legacy `type: storyline` manifests and `Codex/` folders remain readable. New projects use `type: narrative-lab` and `Library/`. WritingLab ignores Excalidraw Markdown drawings while indexing Library entities.

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

WritingLab is local-first.

- No account, payment, advertising, analytics, or telemetry is used.
- Project content stays in the vault. Plugin-wide preferences use Obsidian plugin data; project-specific layout and structure state is stored under the project's `System/` folder.
- WritingLab does not download or execute remote code.
- Network access occurs only when a user-authored document references a remote image and the user asks WritingLab to render or export that image. No vault text is uploaded.
- The desktop-only Scrivener importer can read a `.scriv` folder explicitly selected by the user. Other file operations use Obsidian's vault APIs.
- Uninstalling the plugin does not delete project Markdown, Library files, canvases, Bases, or spreadsheets.

See [Security](./SECURITY.md) for vulnerability reporting and [Support](./SUPPORT.md) for backup and troubleshooting guidance.

## Installation

Download `main.js`, `manifest.json`, and `styles.css` from a release whose tag exactly matches the manifest version. Place them in:

```text
<vault>/.obsidian/plugins/narrative-lab/
```

Reload Obsidian, then enable WritingLab. BRAT can also install the repository for beta testing.

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
- `npm run build` — production bundle. Copies `main.js`, `manifest.json`, and `styles.css` into every discovered `plugins/narrative-lab` folder (`.obsidian` and `.obsidianMac`).

The Community Plugins runtime is fully contained in `main.js`; releases do not require extra JavaScript chunks.

## Support and contributing

Before opening a bug report, reproduce the problem with the latest release and include the Obsidian version, operating system, WritingLab version, affected project layout, and relevant console errors. Do not attach private vault content unless it has been redacted.

WritingLab combines, adapts, or integrates the following projects:

- [NarrativeCanvas](https://github.com/ringeringeraja33/NarrativeCanvas) by ringeringeraja33 — GNU Affero General Public License v3.
- [obsidian-storyline](https://github.com/PixeroJan/obsidian-storyline) by Jan Sandström / PixeroJan — MIT License.
- [obsidian-webnovel-assistant](https://github.com/HatanoChihiro/obsidian-webnovel-assistant) by HatanoChihiro — MIT License.
- [Univer](https://github.com/dream-num/univer) and the bundled `@univerjs/*` runtime packages — Apache License 2.0.
- [Obsidian Univer Plugin](https://github.com/dream-num/obsidian-univer) by DreamNum — Apache License 2.0; acknowledged as an Obsidian integration reference.

WritingLab also interoperates with Obsidian's native Canvas and Bases APIs. Obsidian itself is not redistributed under this repository's license.

The combined WritingLab project is distributed under AGPL-3.0. Upstream license texts and attribution notices are retained in:

- `LICENSE-NarrativeCanvas`
- `LICENSE-Storyline`
- `LICENSE-WebNovelAssistant`
- `LICENSE-Univer`
- `LICENSE-Obsidian-Univer`
