import * as obsidian from 'obsidian';
import { Modal, Notice, normalizePath } from 'obsidian';
import type SceneCardsPlugin from '../main';
import { openStoryGraphRelationCategoriesModal } from './LibraryModeBar';
import { openStoryGraphRelationFocus, type StoryGraphFocusEdge } from './StoryGraphFocusView';
import { openConfirmModal } from './ConfirmModal';
import type { StoryGraphRelationCategory } from './StoryGraph';
import {
    clearFocusBundleForParent,
    linkAssignmentKey,
    readStoryRefsFromCache,
    removeManagedStoryGraphRelation,
    upsertManagedStoryGraphRelation,
    type ManagedStoryGraphRelation,
} from '../utils/storyGraphRefs';
import {
    flipStrandDirection,
    lookupStoryGraphFocusBundle,
    storyGraphFocusKey,
    storyGraphPairKey,
    type StoryGraphFocusBundle,
} from '../utils/storyGraphStrands';
import { resolveLibraryEntityName } from '../utils/libraryEntityName';
import { resolveLibraryCategoryLabel } from '../services/LibraryCategorySync';
import { t } from '../utils/i18n';

export interface LibraryRelationPanelEntity {
    name: string;
    filePath: string;
}

interface LibraryRelationDocument extends LibraryRelationPanelEntity {
    group: string;
}

interface CollectedManagedRelation extends ManagedStoryGraphRelation {
    mirrorCount: number;
}

const DEFAULT_CATEGORY_ID = 'default';

function makeRelationId(): string {
    const random = activeWindow.crypto?.randomUUID?.().replace(/-/g, '').slice(0, 12)
        || Math.random().toString(36).slice(2, 14);
    return `nlrel-${Date.now().toString(36)}-${random}`;
}

function collectLibraryDocuments(plugin: SceneCardsPlugin): LibraryRelationDocument[] {
    const docs = new Map<string, LibraryRelationDocument>();
    const add = (doc: LibraryRelationDocument) => {
        const filePath = normalizePath(doc.filePath || '');
        if (!filePath || docs.has(filePath)) return;
        docs.set(filePath, { ...doc, filePath });
    };
    for (const character of plugin.characterManager.getAllCharacters()) {
        add({
            name: resolveLibraryEntityName(character.name, character.filePath),
            filePath: character.filePath,
            group: t('Characters'),
        });
    }
    for (const world of plugin.locationManager.getAllWorlds()) {
        add({
            name: resolveLibraryEntityName(world.name, world.filePath),
            filePath: world.filePath,
            group: t('Locations'),
        });
    }
    for (const location of plugin.locationManager.getAllLocations()) {
        add({
            name: resolveLibraryEntityName(location.name, location.filePath),
            filePath: location.filePath,
            group: t('Locations'),
        });
    }
    for (const entry of plugin.codexManager.getAllEntries()) {
        add({
            name: resolveLibraryEntityName(entry.name, entry.filePath),
            filePath: entry.filePath,
            group: resolveLibraryCategoryLabel(plugin, entry.type, entry.type),
        });
    }
    return [...docs.values()].sort((a, b) => {
        const group = a.group.localeCompare(b.group, undefined, { sensitivity: 'base' });
        return group || a.name.localeCompare(b.name, undefined, { sensitivity: 'base' });
    });
}

function collectManagedRelations(
    plugin: SceneCardsPlugin,
    documents: LibraryRelationDocument[],
    currentPath: string,
): CollectedManagedRelation[] {
    const current = normalizePath(currentPath);
    const byPath = new Map(documents.map(doc => [normalizePath(doc.filePath), doc]));
    const byId = new Map<string, CollectedManagedRelation>();
    const mirrorCounts = new Map<string, Set<string>>();

    for (const owner of documents) {
        const ownerPath = normalizePath(owner.filePath);
        for (const ref of readStoryRefsFromCache(plugin.app, ownerPath)) {
            if (!ref.managed || !ref.id || !ref.targetPath) continue;
            const sourcePath = normalizePath(ref.sourcePath || ownerPath);
            const ownerIsSource = sourcePath === ownerPath;
            const targetPath = ownerIsSource ? normalizePath(ref.targetPath) : ownerPath;
            if (sourcePath !== current && targetPath !== current) continue;
            const sourceDoc = byPath.get(sourcePath);
            const targetDoc = byPath.get(targetPath);
            if (sourcePath === targetPath) continue;
            if (!mirrorCounts.has(ref.id)) mirrorCounts.set(ref.id, new Set());
            mirrorCounts.get(ref.id)!.add(ownerPath);
            const candidate: CollectedManagedRelation = {
                id: ref.id,
                sourcePath,
                sourceName: sourceDoc?.name || (ownerIsSource ? owner.name : ref.target),
                targetPath,
                targetName: targetDoc?.name || (ownerIsSource ? ref.target : owner.name),
                category: ref.category || DEFAULT_CATEGORY_ID,
                label: ref.label,
                mirrorCount: 1,
            };
            // Prefer the source-side row if one mirror has stale denormalized data.
            if (!byId.has(ref.id) || ownerIsSource) byId.set(ref.id, candidate);
        }
    }
    for (const relation of byId.values()) {
        relation.mirrorCount = mirrorCounts.get(relation.id)?.size || 1;
    }
    return [...byId.values()].sort((a, b) => {
        const aOther = a.sourcePath === current ? a.targetName : a.sourceName;
        const bOther = b.sourcePath === current ? b.targetName : b.sourceName;
        return aOther.localeCompare(bOther, undefined, { sensitivity: 'base' });
    });
}

/**
 * Stable snapshot of everything that can change the shared relation card.
 * Detail views use this to ignore unrelated vault refreshes instead of
 * destroying and rebuilding an unchanged right rail (which visibly flashes).
 */
export function getLibraryRelationsPanelSignature(
    plugin: SceneCardsPlugin,
    currentEntity: LibraryRelationPanelEntity,
): string {
    const currentPath = normalizePath(currentEntity.filePath);
    const documents = collectLibraryDocuments(plugin);
    if (!documents.some(doc => normalizePath(doc.filePath) === currentPath)) {
        documents.push({
            name: currentEntity.name,
            filePath: currentPath,
            group: t('Other'),
        });
    }
    const relations = collectManagedRelations(plugin, documents, currentPath);
    return JSON.stringify({
        documents: documents.map(document => [document.filePath, document.name, document.group]),
        relations: relations.map(relation => [
            relation.id,
            relation.sourcePath,
            relation.sourceName,
            relation.targetPath,
            relation.targetName,
            relation.category,
            relation.label || '',
            relation.mirrorCount,
            focusNotes(focusBundleFor(plugin, relation)),
        ]),
        categories: (plugin.settings.storyGraphRelationCategories || []).map(category => [
            category.id,
            category.label,
            category.color || '',
        ]),
    });
}

function relationCategory(
    plugin: SceneCardsPlugin,
    categoryId: string,
): StoryGraphRelationCategory | undefined {
    return (plugin.settings.storyGraphRelationCategories || [])
        .find(category => category.id === categoryId);
}

function categoryLabel(plugin: SceneCardsPlugin, categoryId: string): string {
    if (!categoryId || categoryId === DEFAULT_CATEGORY_ID) return t('Default link');
    return relationCategory(plugin, categoryId)?.label || categoryId;
}

function categoryParentId(categoryId: string): string {
    return categoryId && categoryId !== DEFAULT_CATEGORY_ID
        ? `link:${categoryId}`
        : 'link:default';
}

function focusBundleFor(
    plugin: SceneCardsPlugin,
    relation: ManagedStoryGraphRelation,
): StoryGraphFocusBundle | null {
    return lookupStoryGraphFocusBundle(
        plugin.settings.storyGraphFocusBundles,
        relation.sourcePath,
        relation.targetPath,
        categoryParentId(relation.category),
    )?.bundle || null;
}

function focusNotes(bundle: StoryGraphFocusBundle | null): string[] {
    if (!bundle) return [];
    return bundle.strands.map(strand => strand.label.trim()).filter(Boolean);
}

async function syncAssignment(
    plugin: SceneCardsPlugin,
    relation: ManagedStoryGraphRelation,
    oldKey?: string,
): Promise<void> {
    const assignments = { ...(plugin.settings.storyGraphLinkRelationAssignments || {}) };
    if (oldKey) delete assignments[oldKey];
    const key = linkAssignmentKey(relation.sourcePath, relation.targetPath);
    if (relation.category && relation.category !== DEFAULT_CATEGORY_ID) {
        assignments[key] = relation.category;
    } else {
        delete assignments[key];
    }
    plugin.settings.storyGraphLinkRelationAssignments = assignments;
    await plugin.saveSettings();
}

async function migrateFocusParent(
    plugin: SceneCardsPlugin,
    relation: ManagedStoryGraphRelation,
    oldCategory: string,
): Promise<void> {
    const oldParent = categoryParentId(oldCategory);
    const nextParent = categoryParentId(relation.category);
    if (oldParent === nextParent) return;
    const found = lookupStoryGraphFocusBundle(
        plugin.settings.storyGraphFocusBundles,
        relation.sourcePath,
        relation.targetPath,
        oldParent,
    );
    if (!found) return;
    const all = { ...(plugin.settings.storyGraphFocusBundles || {}) };
    const category = relationCategory(plugin, relation.category);
    const next: StoryGraphFocusBundle = {
        ...found.bundle,
        parentId: nextParent,
        parentLabel: categoryLabel(plugin, relation.category),
        parentColor: category?.color,
    };
    delete all[found.key];
    all[storyGraphFocusKey(relation.sourcePath, relation.targetPath, nextParent)] = next;
    plugin.settings.storyGraphFocusBundles = all;
}

async function migrateFocusPair(
    plugin: SceneCardsPlugin,
    oldRelation: ManagedStoryGraphRelation,
    nextRelation: ManagedStoryGraphRelation,
    currentPath: string,
): Promise<void> {
    const oldParent = categoryParentId(oldRelation.category);
    const found = lookupStoryGraphFocusBundle(
        plugin.settings.storyGraphFocusBundles,
        oldRelation.sourcePath,
        oldRelation.targetPath,
        oldParent,
    );
    if (!found) return;
    const currentWasRight = normalizePath(found.bundle.rightPath) === normalizePath(currentPath);
    const strands = currentWasRight
        ? found.bundle.strands.map(strand => ({ ...strand, direction: flipStrandDirection(strand.direction) }))
        : found.bundle.strands.map(strand => ({ ...strand }));
    const category = relationCategory(plugin, nextRelation.category);
    const next: StoryGraphFocusBundle = {
        ...found.bundle,
        leftPath: nextRelation.sourcePath,
        rightPath: nextRelation.targetPath,
        leftName: nextRelation.sourceName,
        rightName: nextRelation.targetName,
        parentId: categoryParentId(nextRelation.category),
        parentLabel: categoryLabel(plugin, nextRelation.category),
        parentColor: category?.color,
        strands,
    };
    const all = { ...(plugin.settings.storyGraphFocusBundles || {}) };
    delete all[found.key];
    delete all[storyGraphPairKey(oldRelation.sourcePath, oldRelation.targetPath)];
    all[storyGraphFocusKey(
        nextRelation.sourcePath,
        nextRelation.targetPath,
        categoryParentId(nextRelation.category),
    )] = next;
    plugin.settings.storyGraphFocusBundles = all;
}

function populateDocumentSelect(
    select: HTMLSelectElement,
    documents: LibraryRelationDocument[],
    currentPath: string,
    value?: string,
    unavailablePaths: Set<string> = new Set(),
    missingLabel?: string,
): void {
    select.createEl('option', { text: t('Select related note…'), attr: { value: '' } });
    let currentGroup = '';
    let group: HTMLOptGroupElement | null = null;
    for (const document of documents) {
        if (normalizePath(document.filePath) === normalizePath(currentPath)) continue;
        if (document.group !== currentGroup) {
            currentGroup = document.group;
            group = activeDocument.createElement('optgroup');
            group.label = currentGroup;
            select.appendChild(group);
        }
        const option = activeDocument.createElement('option');
        option.value = document.filePath;
        option.textContent = document.name;
        option.title = document.filePath;
        option.disabled = unavailablePaths.has(normalizePath(document.filePath))
            && normalizePath(document.filePath) !== normalizePath(value || '');
        group?.appendChild(option);
    }
    if (value && !documents.some(document => normalizePath(document.filePath) === normalizePath(value))) {
        const missing = activeDocument.createElement('option');
        missing.value = value;
        missing.textContent = `${missingLabel || value} — ${t('Missing note')}`;
        missing.title = value;
        select.insertBefore(missing, select.firstChild?.nextSibling || null);
    }
    select.value = value || '';
}

function populateCategorySelect(
    select: HTMLSelectElement,
    plugin: SceneCardsPlugin,
    value: string,
): void {
    select.createEl('option', {
        text: t('Default link'),
        attr: { value: DEFAULT_CATEGORY_ID },
    });
    for (const category of plugin.settings.storyGraphRelationCategories || []) {
        select.createEl('option', { text: category.label, attr: { value: category.id } });
    }
    if (value
        && value !== DEFAULT_CATEGORY_ID
        && !(plugin.settings.storyGraphRelationCategories || []).some(category => category.id === value)) {
        select.createEl('option', {
            text: `${value} — ${t('Unknown type')}`,
            attr: { value },
        });
    }
    select.value = value || DEFAULT_CATEGORY_ID;
}

function openFocusEditor(
    plugin: SceneCardsPlugin,
    relation: ManagedStoryGraphRelation,
    onSaved: () => void,
): void {
    const category = relationCategory(plugin, relation.category);
    const modal = new Modal(plugin.app);
    modal.titleEl.setText(t('Relationship notes'));
    const edge: StoryGraphFocusEdge = {
        left: { name: relation.sourceName, filePath: relation.sourcePath },
        right: { name: relation.targetName, filePath: relation.targetPath },
        parentId: categoryParentId(relation.category),
        parentLabel: categoryLabel(plugin, relation.category),
        parentColor: category?.color,
    };
    let focus: ReturnType<typeof openStoryGraphRelationFocus> | null = null;
    modal.onOpen = () => {
        focus = openStoryGraphRelationFocus(
            modal.contentEl,
            plugin,
            edge,
            () => modal.close(),
            onSaved,
        );
    };
    modal.onClose = () => {
        focus?.destroy();
        focus = null;
        onSaved();
    };
    modal.open();
}

/**
 * Shared Character / Location / Library-entry relationship editor. Relations
 * are mirrored in both notes' frontmatter and emitted as first-class Story
 * Graph edges without inserting or deleting prose in either note body.
 */
export function renderLibraryRelationsPanel(
    container: HTMLElement,
    plugin: SceneCardsPlugin,
    currentEntity: LibraryRelationPanelEntity,
): HTMLElement {
    const section = container.createDiv('library-relations-panel');
    const render = () => {
        section.empty();
        const currentPath = normalizePath(currentEntity.filePath);
        const documents = collectLibraryDocuments(plugin);
        if (!documents.some(doc => normalizePath(doc.filePath) === currentPath)) {
            documents.push({
                name: currentEntity.name,
                filePath: currentPath,
                group: t('Other'),
            });
        }
        const byPath = new Map(documents.map(doc => [normalizePath(doc.filePath), doc]));
        const relations = collectManagedRelations(plugin, documents, currentPath);
        const relatedPaths = new Set(relations.map(relation => normalizePath(
            relation.sourcePath === currentPath ? relation.targetPath : relation.sourcePath,
        )));

        const header = section.createDiv('library-relations-header');
        header.createEl('h4', { text: t('Related notes') });
        const headerActions = header.createDiv('library-relations-header-actions');
        const manageButton = headerActions.createEl('button', {
            cls: 'library-relations-icon-button',
            attr: {
                type: 'button',
                'aria-label': t('Manage relation categories'),
                title: t('Manage relation categories'),
            },
        });
        obsidian.setIcon(manageButton, 'settings-2');
        manageButton.addEventListener('click', () => {
            openStoryGraphRelationCategoriesModal(plugin, render);
        });
        const addButton = headerActions.createEl('button', {
            cls: 'library-relations-icon-button',
            attr: { type: 'button', 'aria-label': t('Add relation'), title: t('Add relation') },
        });
        obsidian.setIcon(addButton, 'plus');
        const availableTargets = documents.filter(document => (
            normalizePath(document.filePath) !== currentPath
            && !relatedPaths.has(normalizePath(document.filePath))
        ));
        addButton.disabled = availableTargets.length === 0;
        if (addButton.disabled) {
            addButton.title = t('All available notes are already related');
            addButton.setAttribute('aria-label', t('All available notes are already related'));
        }

        const list = section.createDiv('library-relations-list');
        if (relations.length === 0) {
            list.createDiv({ cls: 'library-relations-empty', text: t('No related notes yet') });
        }

        const rerenderAfterCache = () => {
            // Metadata cache updates are asynchronous. Render once quickly and
            // once after its normal debounce window; both passes are idempotent.
            window.setTimeout(render, 90);
            window.setTimeout(render, 320);
        };

        const saveNew = async (targetPath: string, category = DEFAULT_CATEGORY_ID) => {
            const target = byPath.get(normalizePath(targetPath));
            if (!target) return;
            const relation: ManagedStoryGraphRelation = {
                id: makeRelationId(),
                sourcePath: currentPath,
                sourceName: currentEntity.name,
                targetPath: target.filePath,
                targetName: target.name,
                category,
                label: categoryLabel(plugin, category),
            };
            try {
                await upsertManagedStoryGraphRelation(plugin.app, relation);
                await syncAssignment(plugin, relation);
                rerenderAfterCache();
            } catch (error) {
                console.error('[NarrativeLab] failed to add managed relation', error);
                new Notice(t('The association was not fully synchronized. Note bodies were not changed, and recoverable YAML data was kept. Please retry.'));
            }
        };

        const addDraftRow = () => {
            const existing = list.querySelector('.library-relation-row.is-new');
            if (existing) {
                existing.querySelector<HTMLSelectElement>('select')?.focus();
                return;
            }
            list.querySelector('.library-relations-empty')?.remove();
            const row = list.createDiv('library-relation-row is-new');
            const controls = row.createDiv('library-relation-controls');
            const targetSelect = controls.createEl('select', {
                cls: 'dropdown library-relation-target',
                attr: { 'aria-label': t('Related note') },
            });
            populateDocumentSelect(targetSelect, documents, currentPath, undefined, relatedPaths);
            const typeSelect = controls.createEl('select', {
                cls: 'dropdown library-relation-type',
                attr: { 'aria-label': t('Connection type') },
            });
            populateCategorySelect(typeSelect, plugin, DEFAULT_CATEGORY_ID);
            const confirm = controls.createEl('button', {
                cls: 'library-relations-icon-button is-confirm',
                attr: { type: 'button', 'aria-label': t('Add relation'), title: t('Add relation') },
            });
            obsidian.setIcon(confirm, 'check');
            confirm.disabled = true;
            const cancel = controls.createEl('button', {
                cls: 'library-relations-icon-button',
                attr: { type: 'button', 'aria-label': t('Cancel'), title: t('Cancel') },
            });
            obsidian.setIcon(cancel, 'x');
            cancel.addEventListener('click', () => render());
            const commit = () => {
                if (!targetSelect.value) return;
                targetSelect.disabled = true;
                typeSelect.disabled = true;
                confirm.disabled = true;
                cancel.disabled = true;
                row.addClass('is-busy');
                row.setAttribute('aria-busy', 'true');
                void saveNew(targetSelect.value, typeSelect.value);
            };
            targetSelect.addEventListener('change', () => {
                confirm.disabled = !targetSelect.value;
            });
            confirm.addEventListener('click', commit);
            row.addEventListener('keydown', event => {
                if (event.key !== 'Enter' || !targetSelect.value) return;
                event.preventDefault();
                commit();
            });
            window.setTimeout(() => targetSelect.focus(), 0);
        };
        addButton.addEventListener('click', addDraftRow);

        for (const relation of relations) {
            const otherPath = normalizePath(
                relation.sourcePath === currentPath ? relation.targetPath : relation.sourcePath,
            );
            const row = list.createDiv('library-relation-row');
            row.setAttribute('data-relation-id', relation.id);
            row.setAttribute('data-direction', relation.sourcePath === currentPath ? 'outgoing' : 'incoming');
            const category = relationCategory(plugin, relation.category);
            row.style.setProperty('--nl-relation-color', category?.color || 'var(--interactive-accent)');
            const controls = row.createDiv('library-relation-controls');
            const targetSelect = controls.createEl('select', {
                cls: 'dropdown library-relation-target',
                attr: { 'aria-label': t('Related note') },
            });
            const unavailableForRow = new Set([...relatedPaths].filter(path => path !== otherPath));
            const otherName = relation.sourcePath === currentPath ? relation.targetName : relation.sourceName;
            populateDocumentSelect(
                targetSelect,
                documents,
                currentPath,
                otherPath,
                unavailableForRow,
                otherName,
            );
            targetSelect.title = relation.sourcePath === currentPath
                ? `${relation.sourceName} → ${relation.targetName}`
                : `${relation.sourceName} → ${relation.targetName} (${t('Incoming relation')})`;
            const typeSelect = controls.createEl('select', {
                cls: 'dropdown library-relation-type',
                attr: { 'aria-label': t('Connection type') },
            });
            populateCategorySelect(typeSelect, plugin, relation.category);
            typeSelect.title = categoryLabel(plugin, relation.category);

            const relatedFile = plugin.app.vault.getAbstractFileByPath(otherPath);
            const openButton = controls.createEl('button', {
                cls: 'library-relations-icon-button',
                attr: {
                    type: 'button',
                    'aria-label': t('Open related note: {name}', { name: otherName }),
                    title: t('Open related note: {name}', { name: otherName }),
                },
            });
            obsidian.setIcon(openButton, 'file-text');
            openButton.disabled = !(relatedFile instanceof obsidian.TFile);
            if (openButton.disabled) {
                openButton.title = t('Related note is missing');
                openButton.setAttribute('aria-label', t('Related note is missing'));
            } else {
                openButton.addEventListener('click', () => {
                    void plugin.app.workspace.openLinkText(otherPath, currentPath, true);
                });
            }

            const focusButton = controls.createEl('button', {
                cls: 'library-relations-icon-button',
                attr: {
                    type: 'button',
                    'aria-label': t('Edit relationship notes'),
                    title: t('Edit relationship notes'),
                },
            });
            obsidian.setIcon(focusButton, 'scan-eye');
            focusButton.addEventListener('click', () => openFocusEditor(plugin, relation, rerenderAfterCache));

            const remove = controls.createEl('button', {
                cls: 'library-relations-icon-button is-danger',
                attr: { type: 'button', 'aria-label': t('Remove relation'), title: t('Remove relation') },
            });
            obsidian.setIcon(remove, 'trash-2');
            const removeRelation = async () => {
                controls.querySelectorAll('button, select').forEach(control => {
                    (control as HTMLButtonElement | HTMLSelectElement).disabled = true;
                });
                row.addClass('is-busy');
                row.setAttribute('aria-busy', 'true');
                try {
                    await removeManagedStoryGraphRelation(
                        plugin.app,
                        relation.id,
                        [relation.sourcePath, relation.targetPath],
                    );
                    const assignments = { ...(plugin.settings.storyGraphLinkRelationAssignments || {}) };
                    delete assignments[linkAssignmentKey(relation.sourcePath, relation.targetPath)];
                    plugin.settings.storyGraphLinkRelationAssignments = assignments;
                    clearFocusBundleForParent(
                        plugin,
                        relation.sourcePath,
                        relation.targetPath,
                        categoryParentId(relation.category),
                    );
                    await plugin.saveSettings();
                    rerenderAfterCache();
                } catch (error) {
                    console.error('[NarrativeLab] failed to remove managed relation', error);
                    new Notice(t('The association was not fully synchronized. Note bodies were not changed, and recoverable YAML data was kept. Please retry.'));
                    render();
                }
            };
            remove.addEventListener('click', () => {
                openConfirmModal(plugin.app, {
                    title: t('Remove relation'),
                    message: t(
                        'Remove the association between "{from}" and "{to}"? Both note bodies will be kept.',
                        { from: relation.sourceName, to: relation.targetName },
                    ),
                    confirmLabel: t('Remove relation'),
                    onConfirm: removeRelation,
                });
            });

            const retargetRelation = async (target: LibraryRelationDocument) => {
                controls.querySelectorAll('button, select').forEach(control => {
                    (control as HTMLButtonElement | HTMLSelectElement).disabled = true;
                });
                row.addClass('is-busy');
                row.setAttribute('aria-busy', 'true');
                const next: ManagedStoryGraphRelation = {
                    id: makeRelationId(),
                    sourcePath: currentPath,
                    sourceName: currentEntity.name,
                    targetPath: target.filePath,
                    targetName: target.name,
                    category: relation.category,
                    label: categoryLabel(plugin, relation.category),
                };
                try {
                    // Create the replacement first. If it fails, the old relation
                    // remains fully intact on both notes.
                    await upsertManagedStoryGraphRelation(plugin.app, next);
                    await migrateFocusPair(plugin, relation, next, currentPath);
                    await syncAssignment(
                        plugin,
                        next,
                        linkAssignmentKey(relation.sourcePath, relation.targetPath),
                    );
                    await removeManagedStoryGraphRelation(
                        plugin.app,
                        relation.id,
                        [relation.sourcePath, relation.targetPath],
                    );
                    await plugin.saveSettings();
                    rerenderAfterCache();
                } catch (error) {
                    console.error('[NarrativeLab] failed to retarget managed relation', error);
                    new Notice(t('The association was not fully synchronized. Note bodies were not changed, and recoverable YAML data was kept. Please retry.'));
                    render();
                }
            };
            targetSelect.addEventListener('change', () => {
                const target = byPath.get(normalizePath(targetSelect.value));
                if (!target || normalizePath(target.filePath) === otherPath) {
                    targetSelect.value = otherPath;
                    return;
                }
                // Keep the committed value visible while the confirmation is open.
                targetSelect.value = otherPath;
                openConfirmModal(plugin.app, {
                    title: t('Change related note'),
                    message: t(
                        'Move this association from "{from}" to "{to}"? Its type and relationship notes will move with it.',
                        { from: otherName, to: target.name },
                    ),
                    confirmLabel: t('Change'),
                    confirmClass: 'mod-cta',
                    onConfirm: () => retargetRelation(target),
                });
            });

            typeSelect.addEventListener('change', () => { void (async () => {
                const nextCategory = typeSelect.value || DEFAULT_CATEGORY_ID;
                if (nextCategory === relation.category) return;
                typeSelect.disabled = true;
                row.addClass('is-busy');
                row.setAttribute('aria-busy', 'true');
                const next: ManagedStoryGraphRelation = {
                    ...relation,
                    category: nextCategory,
                    label: categoryLabel(plugin, nextCategory),
                };
                try {
                    await upsertManagedStoryGraphRelation(plugin.app, next);
                    await migrateFocusParent(plugin, next, relation.category);
                    await syncAssignment(plugin, next);
                    rerenderAfterCache();
                } catch (error) {
                    console.error('[NarrativeLab] failed to change managed relation category', error);
                    new Notice(t('The association was not fully synchronized. Note bodies were not changed, and recoverable YAML data was kept. Please retry.'));
                    render();
                }
            })(); });

            const notes = focusNotes(focusBundleFor(plugin, relation));
            if (notes.length > 0) {
                const noteRow = row.createEl('button', {
                    cls: 'library-relation-notes',
                    attr: {
                        type: 'button',
                        title: t('Edit relationship notes'),
                        'aria-label': t('Edit relationship notes'),
                    },
                });
                noteRow.createSpan({ text: notes.join(' · ') });
                noteRow.addEventListener('click', () => openFocusEditor(plugin, relation, rerenderAfterCache));
            }

            if (relation.mirrorCount < 2) {
                row.addClass('is-partial');
                const syncWarning = t('The other note is not synchronized yet. Your data is still kept here.');
                row.setAttribute('title', syncWarning);
                row.setAttribute('aria-label', syncWarning);
            }
        }
    };
    render();
    return section;
}
