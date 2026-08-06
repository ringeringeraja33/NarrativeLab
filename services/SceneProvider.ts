/* eslint-disable @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-argument, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-return, @typescript-eslint/no-floating-promises, @typescript-eslint/no-misused-promises, @typescript-eslint/no-unnecessary-type-assertion, @typescript-eslint/no-redundant-type-constituents, @typescript-eslint/no-unused-vars, no-unused-vars, no-useless-escape, no-control-regex, no-empty -- Obsidian's API surface and several untyped third-party libraries force dynamic dispatch; floating promises are intentional in DOM/event handlers; matching enable at end of file */
// ═══════════════════════════════════════════════════════
//  Scene Provider — Issue #66 Phase 1 foundation
// ═══════════════════════════════════════════════════════
//
// This file is the indirection point that future Series Arc View work
// will build on. Today every view pulls scenes from `plugin.sceneManager`
// which is bound to the active project root. To support a cross-book
// "Series Arc" scope we need a thin wrapper that can either:
//
//   - return scenes from a single project (BookSceneProvider), or
//   - return the union of scenes across every book project under a
//     series root (SeriesSceneProvider), tagged with virtual book
//     metadata (`_bookId`, `_bookLabel`, `_bookOrder`) derived from
//     each scene's file path. These virtual fields are NEVER written
//     back to YAML.
//
// Phase 1 scope (per the team triage note in
// `Övrigt/issues 20260423.md`):
//   - Manuscript + Kanban + Plot Grid in Arc View as read-only
//   - Skip Subway cross-book connectors and Corkboard zones
//   - Skip writes/drag in Arc View, or route writes back to the
//     scene's owning book project
//
// This module currently exposes only the interface and a thin
// BookSceneProvider so the rest of the codebase can start migrating
// view code through it incrementally without behaviour changes.

import type SceneCardsPlugin from '../main';
import { Scene } from '../models/Scene';

/** Virtual per-scene book metadata, never persisted to YAML. */
export interface BookContext {
    /** Stable id for the book — typically the book's project folder path. */
    bookId: string;
    /** Display label for the book — derived from the project name/folder. */
    bookLabel: string;
    /** Sort order taken from `series.json` `bookOrder`; -1 if unknown. */
    bookOrder: number;
}

/** A scene plus its book context (for series scope). */
export interface ScopedScene {
    scene: Scene;
    book: BookContext;
}

/**
 * Read-only abstraction over scene sources. Each provider returns scopedscenes
 * tagged with their owning book. Single-book providers always return one
 * BookContext; series providers return many.
 */
export interface SceneProvider {
    /** True if this provider aggregates more than one book. */
    isMultiBook(): boolean;
    /** Return all scenes the provider currently exposes. */
    getAll(): ScopedScene[];
    /** List the book contexts this provider knows about, in display order. */
    getBooks(): BookContext[];
}

/**
 * Wraps the active project's SceneManager. Phase 1 keeps every existing view
 * working unchanged — they can opt into this provider when they're ready.
 */
export class BookSceneProvider implements SceneProvider {
    constructor(private plugin: SceneCardsPlugin) {}

    isMultiBook(): boolean {
        return false;
    }

    getAll(): ScopedScene[] {
        const project = this.plugin.sceneManager.activeProject;
        const folder = project?.sceneFolder.replace(/\/Scenes\/?$/, '') || '';
        const label = project?.title || folder.split('/').filter(Boolean).pop() || 'Project';
        const book: BookContext = {
            bookId: folder,
            bookLabel: label,
            bookOrder: 0,
        };
        return this.plugin.sceneManager.getAllScenes().map(scene => ({ scene, book }));
    }

    getBooks(): BookContext[] {
        const project = this.plugin.sceneManager.activeProject;
        const folder = project?.sceneFolder.replace(/\/Scenes\/?$/, '') || '';
        const label = project?.title || folder.split('/').filter(Boolean).pop() || 'Project';
        return [{ bookId: folder, bookLabel: label, bookOrder: 0 }];
    }
}

/**
 * STUB — to be implemented in a follow-up commit.
 *
 * Aggregates scenes from every book project listed in the active series'
 * `series.json` `bookOrder`. Each scene is tagged with the book context of
 * its source project. Virtual `_bookId/_bookLabel/_bookOrder` derived from
 * the scene's `filePath` against `bookOrder`.
 *
 * Implementation notes for the follow-up:
 *  - Use `plugin.seriesManager.getActiveSeriesFolder()` and
 *    `loadSeriesMetadata()` to discover sibling book folders.
 *  - For each book folder, instantiate a transient SceneManager-equivalent
 *    or re-use a lightweight scanner that reads `*.md` from the book's
 *    Scenes/ folder and routes through `MetadataParser.parseContent`.
 *  - Cache results and invalidate on `vault.modify`/`rename` for any path
 *    under the series folder.
 */
export class SeriesSceneProvider implements SceneProvider {
    constructor(_plugin: SceneCardsPlugin) {
        // Intentionally empty — see TODO above.
    }

    isMultiBook(): boolean {
        return true;
    }

    getAll(): ScopedScene[] {
        // TODO(#66 Phase 1): aggregate scenes from sibling book projects.
        return [];
    }

    getBooks(): BookContext[] {
        // TODO(#66 Phase 1): return books from series.json bookOrder.
        return [];
    }
}

/**
 * Factory: pick the right provider based on the user's current scope choice.
 * Until the Series Arc View is fully wired, this always returns a
 * BookSceneProvider so behaviour is unchanged.
 */
export function getActiveSceneProvider(plugin: SceneCardsPlugin): SceneProvider {
    if (plugin.settings.seriesArcView && plugin.settings.series) {
        return new SeriesSceneProvider(plugin);
    }
    return new BookSceneProvider(plugin);
}
/* eslint-enable @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-argument, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-return, @typescript-eslint/no-floating-promises, @typescript-eslint/no-misused-promises, @typescript-eslint/no-unnecessary-type-assertion, @typescript-eslint/no-redundant-type-constituents, @typescript-eslint/no-unused-vars, no-unused-vars, no-useless-escape, no-control-regex, no-empty -- end of file-wide suppression block opened at line 1 */
