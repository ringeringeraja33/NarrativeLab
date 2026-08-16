import { Notice, WorkspaceLeaf, setIcon } from 'obsidian';
import { normalizePath } from 'obsidian';
import { t } from '../utils/i18n';
import type SceneCardsPlugin from '../main';
import { CharacterView } from './CharacterView';
import { LocationView } from './LocationView';
import { CodexView } from './CodexView';

type LibraryProfileSurface = 'character' | 'location' | 'codex';

function profileSurfaceFromKind(kind: string): LibraryProfileSurface {
    const key = String(kind || '').trim().toLowerCase();
    if (key === 'character' || key === 'characters') return 'character';
    if (key === 'location' || key === 'locations' || key === 'world') return 'location';
    return 'codex';
}

export interface LibraryProfileEmbedOptions {
    onBack: () => void;
    onDeleted?: () => void;
    hideVaultReferences?: boolean;
}

export interface CanvasLibraryProfilePayload {
    entryId: string;
    name: string;
    kind: string;
    codexFile: string;
}

export interface CanvasNodeBacklinkItem {
    nodeId: string;
    title: string;
    type: string;
}

export interface CanvasNodeBacklinkGroup {
    id: string;
    label: string;
    items: CanvasNodeBacklinkItem[];
}

type CanvasAppApi = {
    getNodeBacklinks?: (entryId: string) => CanvasNodeBacklinkGroup[];
    focusLibraryNode?: (nodeId: string) => void;
    closeLibraryProfile?: () => void;
    reloadCodexFiles?: (options?: { silent?: boolean; markDirty?: boolean; render?: boolean }) => Promise<boolean>;
};

function canvasApp(): CanvasAppApi | undefined {
    return (window as unknown as { NarrativeCanvasApp?: CanvasAppApi }).NarrativeCanvasApp;
}

type EmbeddedLibraryView = {
    mountEmbeddedDetail: (
        container: HTMLElement,
        filePath: string,
        options: LibraryProfileEmbedOptions,
    ) => Promise<boolean>;
    unmountEmbeddedDetail: () => Promise<void>;
};

interface CanvasLibraryProfileSession {
    overlay: HTMLElement;
    view: EmbeddedLibraryView | null;
}

const sessions = new WeakMap<HTMLElement, CanvasLibraryProfileSession>();

function createDetachedWorkspaceLeaf(app: SceneCardsPlugin['app']): WorkspaceLeaf {
    const doc = app.workspace.containerEl.ownerDocument;
    const containerEl = doc.createElement('div');
    const history = { backHistory: [] as unknown[], forwardHistory: [] as unknown[] };
    const leaf = {
        app,
        containerEl,
        parent: undefined,
        detached: true,
        pinned: false,
        history,
        getRoot() {
            return app.workspace.rootSplit;
        },
        getContainer() {
            return app.workspace.rootSplit;
        },
        getDisplayText() {
            return '';
        },
        getViewState() {
            return { type: 'empty', state: {} };
        },
        setViewState: async () => undefined,
        openFile: async () => undefined,
        detach() {},
        togglePinned() {},
        setPinned() {},
        canPin() {
            return false;
        },
        handleDrop() {
            return null;
        },
        on() {
            return { e: { off() {} } };
        },
        off() {},
        offref() {},
        trigger() {},
        tryTrigger() {},
        onResize() {},
        isDeferred: false,
        loadIfDeferred: async () => undefined,
        rebuildView: async () => undefined,
        setGroupMember() {},
        setGroup() {},
        getEphemeralState() {
            return {};
        },
        setEphemeralState() {},
        getIcon() {
            return '';
        },
        getViewType() {
            return 'empty';
        },
    } as unknown as WorkspaceLeaf;
    (leaf as unknown as { view: { app: SceneCardsPlugin['app']; containerEl: HTMLElement } }).view = {
        app,
        containerEl,
    };
    return leaf;
}

function hasLibraryEntity(
    plugin: SceneCardsPlugin,
    filePath: string,
    surface: LibraryProfileSurface,
): boolean {
    const path = normalizePath(filePath || '');
    if (!path) return false;
    if (surface === 'character') return Boolean(plugin.characterManager.getCharacter(path));
    if (surface === 'location') return Boolean(plugin.locationManager.getItem(path));
    return Boolean(plugin.codexManager.getEntry(path));
}

function resolveSurface(
    plugin: SceneCardsPlugin,
    filePath: string,
    kindHint: string,
): LibraryProfileSurface {
    const path = normalizePath(filePath || '');
    if (path && plugin.characterManager.getCharacter(path)) return 'character';
    if (path && plugin.locationManager.getItem(path)) return 'location';
    if (path && plugin.codexManager.getEntry(path)) return 'codex';
    return profileSurfaceFromKind(kindHint);
}

function createEmbeddedView(
    plugin: SceneCardsPlugin,
    surface: LibraryProfileSurface,
): EmbeddedLibraryView {
    const leaf = createDetachedWorkspaceLeaf(plugin.app);
    if (surface === 'character') {
        return new CharacterView(leaf, plugin, plugin.sceneManager);
    }
    if (surface === 'location') {
        return new LocationView(leaf, plugin, plugin.sceneManager);
    }
    return new CodexView(leaf, plugin, plugin.sceneManager);
}

function overlayParent(contentEl: HTMLElement): HTMLElement {
    return contentEl.parentElement || contentEl;
}

function readNodeBacklinks(entryId: string): CanvasNodeBacklinkGroup[] {
    const groups = canvasApp()?.getNodeBacklinks?.(entryId);
    return Array.isArray(groups) ? groups : [];
}

function renderNodeBacklinks(rail: HTMLElement, entryId: string): void {
    rail.empty();
    const title = rail.createEl('h3', { cls: 'nl-canvas-library-backlinks-title' });
    title.setText(t('Referenced nodes'));
    const groups = readNodeBacklinks(entryId).filter((group) => group.items.length);
    const count = groups.reduce((total, group) => total + group.items.length, 0);
    title.createEl('small', { text: String(count) });

    if (!groups.length) {
        rail.createDiv({
            cls: 'nl-canvas-library-backlinks-empty',
            text: t('No linked scenes yet'),
        });
        return;
    }

    for (const group of groups) {
        const details = rail.createEl('details', { cls: 'nl-canvas-library-backlink-group' });
        details.open = true;
        const summary = details.createEl('summary');
        summary.createSpan({ text: group.label });
        summary.createEl('small', { text: String(group.items.length) });
        const list = details.createDiv({ cls: 'nl-canvas-library-backlink-list' });
        for (const item of group.items) {
            const button = list.createEl('button', {
                cls: 'nl-canvas-library-backlink',
                attr: { type: 'button' },
            });
            const icon = button.createSpan({ cls: 'nl-canvas-library-backlink-icon' });
            setIcon(icon, 'git-branch');
            const main = button.createDiv({ cls: 'nl-canvas-library-backlink-main' });
            main.createEl('strong', { text: item.title || item.type });
            main.createEl('small', { text: item.type });
            button.addEventListener('click', () => {
                void canvasApp()?.focusLibraryNode?.(item.nodeId);
            });
        }
    }
}

export async function unmountCanvasLibraryProfile(
    canvasView: { contentEl: HTMLElement },
): Promise<void> {
    const session = sessions.get(canvasView.contentEl);
    if (!session) return;
    sessions.delete(canvasView.contentEl);
    canvasView.contentEl.classList.remove('nl-canvas-library-profile-open');
    try {
        await session.view?.unmountEmbeddedDetail();
    } catch (error) {
        console.warn('NarrativeLab: could not close embedded library profile', error);
    }
    session.overlay.remove();
}

export async function mountCanvasLibraryProfile(
    plugin: SceneCardsPlugin,
    canvasView: { contentEl: HTMLElement },
    payload: CanvasLibraryProfilePayload,
): Promise<boolean> {
    let filePath = normalizePath(String(payload.codexFile || '').trim());
    if (!filePath) {
        new Notice(t('Library profile needs a vault file first.'));
        return false;
    }

    await unmountCanvasLibraryProfile(canvasView);
    try {
        await plugin.reloadEntities();
    } catch {
        /* project may not be ready */
    }

    const noteName = String(payload.name || '').trim()
        || filePath.split('/').pop()?.replace(/\.md$/i, '')
        || '';
    const namedCodex = noteName ? plugin.codexManager.findByFileNameOrName(noteName) : undefined;
    if (namedCodex) filePath = namedCodex.filePath;

    let surface = resolveSurface(plugin, filePath, payload.kind);
    if (!hasLibraryEntity(plugin, filePath, surface)) {
        try {
            await plugin.reloadEntities();
        } catch {
            /* retry once after a just-created vault file */
        }
        const retryCodex = noteName ? plugin.codexManager.findByFileNameOrName(noteName) : undefined;
        if (retryCodex) filePath = retryCodex.filePath;
        surface = resolveSurface(plugin, filePath, payload.kind);
    }
    const parent = overlayParent(canvasView.contentEl);
    const overlay = parent.createDiv({
        cls: 'nl-canvas-library-profile-host',
        attr: { 'aria-label': payload.name || t('Library') },
    });
    const rail = overlay.createDiv({ cls: 'nl-canvas-library-profile-rail' });
    const main = overlay.createDiv({
        cls: 'nl-canvas-library-profile-main story-line-character-container story-line-codex-container story-line-character-content story-line-codex-content',
    });

    const session: CanvasLibraryProfileSession = { overlay, view: null };
    sessions.set(canvasView.contentEl, session);
    canvasView.contentEl.classList.add('nl-canvas-library-profile-open');
    renderNodeBacklinks(rail, payload.entryId);

    const closeToOverview = () => {
        void canvasApp()?.closeLibraryProfile?.();
    };

    try {
        const view = createEmbeddedView(plugin, surface);
        session.view = view;
        const opened = await view.mountEmbeddedDetail(main, filePath, {
            onBack: closeToOverview,
            onDeleted: () => {
                void canvasApp()?.reloadCodexFiles?.({ silent: true, markDirty: false });
                closeToOverview();
            },
            hideVaultReferences: true,
        });
        if (!opened) {
            await unmountCanvasLibraryProfile(canvasView);
            new Notice(t('Could not open library profile.'));
            return false;
        }
        return true;
    } catch (error) {
        console.error('NarrativeLab: canvas library profile failed', error);
        await unmountCanvasLibraryProfile(canvasView);
        new Notice(t('Could not open library profile.'));
        return false;
    }
}

export function isCanvasLibraryProfileMounted(canvasView: { contentEl: HTMLElement }): boolean {
    return sessions.has(canvasView.contentEl);
}
