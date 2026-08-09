# NarrativeLab

NarrativeLab is a unified Obsidian workspace for narrative planning. It combines a structured narrative database with Narrative Canvas as an internal view.

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

NarrativeLab combines code derived from:

- NarrativeCanvas by ringeringeraja33 (GNU Affero General Public License v3)
- obsidian-storyline by Jan Sandström / PixeroJan (MIT License)

The combined project is distributed under AGPL-3.0. The original notices are retained in `LICENSE-NarrativeCanvas` and `LICENSE-Storyline`.
