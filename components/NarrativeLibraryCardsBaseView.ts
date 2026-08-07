import {
    BasesView,
    type BasesPropertyId,
    type QueryController,
    normalizePath,
    setIcon,
} from 'obsidian';
import type SceneCardsPlugin from '../main';
import { resolveImagePath } from './ImagePicker';

export const NARRATIVE_LIBRARY_CARDS_VIEW_TYPE = 'narrative-lab-cards';

function asText(value: unknown): string {
    if (Array.isArray(value)) return value.map(item => asText(item)).filter(Boolean).join(', ');
    if (value && typeof value === 'object') {
        const record = value as Record<string, unknown>;
        return asText(record.role ?? record.name ?? record.label ?? '');
    }
    return value == null ? '' : String(value);
}

/**
 * Native Bases view backed by the old NarrativeLab Library cards.
 * The Base still owns filtering/sorting/properties; activating a card opens
 * the existing Character, Location, or Codex detail editor.
 */
export class NarrativeLibraryCardsBaseView extends BasesView {
    readonly type = NARRATIVE_LIBRARY_CARDS_VIEW_TYPE;
    private readonly containerEl: HTMLElement;

    constructor(
        controller: QueryController,
        parentEl: HTMLElement,
        private readonly plugin: SceneCardsPlugin,
    ) {
        super(controller);
        this.containerEl = parentEl.createDiv('narrative-library-base-cards');
    }

    onDataUpdated(): void {
        this.containerEl.empty();
        const cardSize = Number(this.config.get('cardSize')) || 180;
        const imageProperty = (this.config.get('image') as BasesPropertyId | undefined) || 'note.image';
        const imageFit = this.config.get('imageFit') === 'contain' ? 'contain' : 'cover';
        const imageAspectRatio = Number(this.config.get('imageAspectRatio')) || 1;
        const grid = this.containerEl.createDiv('codex-entry-cards');
        grid.style.gridTemplateColumns = `repeat(auto-fill, minmax(${cardSize}px, 1fr))`;

        for (const entry of this.data?.data || []) {
            const file = entry.file;
            const filePath = normalizePath(file.path);
            const frontmatter = this.plugin.app.metadataCache.getFileCache(file)?.frontmatter as
                Record<string, unknown> | undefined;
            const type = asText(frontmatter?.type).toLowerCase();
            const characterFolder = normalizePath(this.plugin.sceneManager.getCharacterFolder());
            const locationFolder = normalizePath(this.plugin.sceneManager.getLocationFolder());
            const isCharacter = type === 'character'
                || filePath.startsWith(`${characterFolder}/`);
            const isLocation = type === 'world'
                || type === 'location'
                || filePath.startsWith(`${locationFolder}/`);
            const name = asText(frontmatter?.name) || file.basename;
            const configuredImage = entry.getValue(imageProperty)?.toString() || '';
            const image = configuredImage || asText(frontmatter?.image);

            if (isCharacter) {
                this.renderCharacterCard(grid, filePath, name, frontmatter, image, imageFit);
            } else {
                this.renderLibraryCard(
                    grid,
                    filePath,
                    name,
                    frontmatter,
                    image,
                    imageFit,
                    imageAspectRatio,
                    isLocation,
                );
            }
        }
    }

    private renderCharacterCard(
        grid: HTMLElement,
        filePath: string,
        name: string,
        frontmatter: Record<string, unknown> | undefined,
        image: string,
        imageFit: 'cover' | 'contain',
    ): void {
        const card = grid.createDiv('character-overview-card');
        const roles = asText(frontmatter?.role);
        if (roles) {
            const badges = card.createDiv('character-role-badges');
            for (const role of roles.split(',').map(item => item.trim()).filter(Boolean)) {
                badges.createDiv({ cls: 'character-role-badge', text: role });
            }
        }

        const portrait = card.createDiv('character-card-portrait');
        this.renderImage(
            portrait,
            image,
            name,
            'circle-user-round',
            'character-portrait-img',
            'character-portrait-placeholder',
            imageFit,
        );
        card.createEl('h4', { text: name });

        const snippet = asText(
            frontmatter?.personality
            || frontmatter?.occupation
            || frontmatter?.description
            || frontmatter?.summary,
        );
        if (snippet) card.createEl('p', { cls: 'character-card-snippet', text: snippet });
        this.makeInteractive(card, filePath);
    }

    private renderLibraryCard(
        grid: HTMLElement,
        filePath: string,
        name: string,
        frontmatter: Record<string, unknown> | undefined,
        image: string,
        imageFit: 'cover' | 'contain',
        imageAspectRatio: number,
        isLocation: boolean,
    ): void {
        const card = grid.createDiv('codex-entry-card');
        const cover = card.createDiv('codex-entry-card-cover');
        cover.style.height = `${Math.max(64, Math.round(120 / imageAspectRatio))}px`;
        this.renderImage(
            cover,
            image,
            name,
            isLocation ? 'map-pin' : 'file-text',
            '',
            '',
            imageFit,
        );
        card.createEl('h4', { text: name });
        const typeLabel = asText(frontmatter?.world || frontmatter?.entryType || frontmatter?.type);
        if (typeLabel) card.createSpan({ cls: 'codex-entry-card-meta', text: typeLabel });
        const description = asText(frontmatter?.description || frontmatter?.summary);
        if (description) card.createEl('p', { cls: 'character-card-snippet', text: description });
        this.makeInteractive(card, filePath);
    }

    private renderImage(
        container: HTMLElement,
        image: string,
        alt: string,
        fallbackIcon: string,
        imageClass: string,
        placeholderClass: string,
        imageFit: 'cover' | 'contain',
    ): void {
        const src = image ? resolveImagePath(this.plugin.app, image) : '';
        if (src) {
            const img = container.createEl('img', {
                cls: imageClass,
                attr: { src, alt, loading: 'lazy', decoding: 'async' },
            });
            img.style.objectFit = imageFit;
            img.addEventListener('error', () => {
                img.remove();
                const placeholder = container.createDiv(placeholderClass);
                setIcon(placeholder, fallbackIcon);
            }, { once: true });
            return;
        }
        const placeholder = container.createDiv(placeholderClass);
        setIcon(placeholder, fallbackIcon);
    }

    private makeInteractive(card: HTMLElement, filePath: string): void {
        card.tabIndex = 0;
        card.setAttribute('role', 'button');
        card.addEventListener('click', () => {
            void this.plugin.showEntityDetails(filePath);
        });
        card.addEventListener('keydown', event => {
            if (event.key !== 'Enter' && event.key !== ' ') return;
            event.preventDefault();
            void this.plugin.showEntityDetails(filePath);
        });
    }
}
