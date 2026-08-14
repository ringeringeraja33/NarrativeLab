# NarrativeLab

NarrativeLab is a unified Obsidian workspace for narrative planning. It combines Obsidian's native Canvas and Bases database capabilities with Storyline-style project organization, an embedded Univer spreadsheet workspace, and Narrative Canvas.

## What NarrativeLab combines

- **Obsidian native Canvas** — project corkboards and optional narrative projections use Obsidian's `.canvas` format and Canvas view.
- **Obsidian native Bases (Database)** — Library browsing uses Obsidian Bases as the native database/table surface for Markdown entities.
- **[Storyline](https://github.com/PixeroJan/obsidian-storyline)** — the project, scene, character, location, Library, and narrative-planning workflow builds on and extends ideas and code from the Storyline plugin.
- **[Univer](https://github.com/dream-num/univer)** — the Concept Grid embeds Univer Sheets for workbook editing, formulas, formatting, filtering, and Excel-compatible data exchange.
- **[Obsidian Univer Plugin](https://github.com/dream-num/obsidian-univer)** — NarrativeLab acknowledges the earlier Obsidian integration of Univer as an implementation reference. NarrativeLab's Concept Grid is integrated into its own project and data model rather than requiring the separate plugin.
- **[Narrative Canvas](https://github.com/ringeringeraja33/NarrativeCanvas)** — the node-based narrative workspace is bundled as an internal project view.

NarrativeLab is an independent project and is not affiliated with Obsidian, DreamNum/Univer, or the maintainers of the referenced plugins.

## Project layout

A project may live anywhere in the vault. NarrativeLab discovers its Markdown manifest by frontmatter instead of requiring a fixed plugin root.

```text
Any folder/
  Project name/
    Project name.md       # type: narrative-lab
    Canvas/
      Project name.ncanvas           # Narrative Canvas source
      Project name.canvas            # project corkboard
      Project name.narrative.canvas  # optional Obsidian projection of .ncanvas
    Library/              # recursively indexed
      Characters/
      Locations/
      ...any subfolders
    Scenes/
    Notes/
    Research/
    System/
      Templates/
        templates.json    # project-scoped scene, structure, and preset templates
```

Legacy `type: storyline` manifests and `Codex/` folders remain readable. New projects use `type: narrative-lab` and `Library/`.

New projects create only `Library/Characters` and `Library/Locations`. Any other direct `Library/` subfolder is adopted as a category; renaming or deleting that folder updates the Library tabs and generated project Bases. In a series, project Bases include both shared series assets and book-local Library assets.

Images imported by NarrativeLab are placed through Obsidian's global attachment-folder resolver. NarrativeLab does not impose a separate `Images/` directory.

The Template Center manages scene templates, narrative structures, and project presets. Templates can be global or project-scoped; project templates stay under `System/Templates/` so Library scanning never treats them as content categories. Applying a structure shows a merge/replace preview and never deletes existing scene files.

## Development

Canonical source lives **outside OneDrive** (avoids syncing ~18k `node_modules` files):

- Local: `~/Developer/NarrativeLab`
- GitHub: https://github.com/ringeringeraja33/NarrativeLab

```sh
cd ~/Developer/NarrativeLab
npm ci
npm run build
```

`npm run build` writes `main.js` / `manifest.json` / `styles.css` and copies them into your Obsidian vault plugin folders under OneDrive.

## Source and licensing

NarrativeLab combines, adapts, or integrates the following projects:

- [NarrativeCanvas](https://github.com/ringeringeraja33/NarrativeCanvas) by ringeringeraja33 — GNU Affero General Public License v3.
- [obsidian-storyline](https://github.com/PixeroJan/obsidian-storyline) by Jan Sandström / PixeroJan — MIT License.
- [Univer](https://github.com/dream-num/univer) and the bundled `@univerjs/*` runtime packages — Apache License 2.0.
- [Obsidian Univer Plugin](https://github.com/dream-num/obsidian-univer) by DreamNum — Apache License 2.0; acknowledged as an Obsidian integration reference.

NarrativeLab also interoperates with Obsidian's native Canvas and Bases APIs. Obsidian itself is not redistributed under this repository's license.

The combined NarrativeLab project is distributed under AGPL-3.0. Upstream license texts and attribution notices are retained in:

- `LICENSE-NarrativeCanvas`
- `LICENSE-Storyline`
- `LICENSE-Univer`
- `LICENSE-Obsidian-Univer`
