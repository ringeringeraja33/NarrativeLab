# NarrativeLab

NarrativeLab is a unified Obsidian workspace for narrative planning. It combines a structured narrative database with Narrative Canvas as an internal view.

## Project layout

A project may live anywhere in the vault. NarrativeLab discovers its Markdown manifest by frontmatter instead of requiring a fixed plugin root.

```text
Any folder/
  Project name/
    Project name.md       # type: narrative-lab
    Project name.ncanvas  # canvas for the same project
    Library/              # recursively indexed
      Characters/
      Locations/
      ...any subfolders
    Scenes/
    Notes/
    Research/
    System/
```

Legacy `type: storyline` manifests and `Codex/` folders remain readable. New projects use `type: narrative-lab` and `Library/`.

Images imported by NarrativeLab are placed through Obsidian's global attachment-folder resolver. NarrativeLab does not impose a separate `Images/` directory.

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
