import type { App, TFile } from 'obsidian';

const normalizeSourcePath = (path: string) => path.replace(/\\/g, '/').replace(/\/+/g, '/').replace(/^\//, '');

export interface TrackedDocument {
    id: string;
    path: string;
    label: string;
    file?: TFile;
}

export interface DocumentSource {
    id: string;
    label: string;
    listDocuments(): Promise<TrackedDocument[]>;
    readText(document: TrackedDocument): Promise<string>;
}

/** Project-neutral registry used by word-count consumers. */
export class DocumentSourceService {
    private sources = new Map<string, DocumentSource>();

    register(source: DocumentSource): () => void {
        this.sources.set(source.id, source);
        return () => { if (this.sources.get(source.id) === source) this.sources.delete(source.id); };
    }

    get(id: string): DocumentSource | undefined { return this.sources.get(id); }
    list(): DocumentSource[] { return [...this.sources.values()]; }
}

/** Markdown writing source for projects that do not use NarrativeLab scenes. */
export class ProjectMarkdownDocumentSource implements DocumentSource {
    readonly id = 'project-markdown';
    readonly label = 'Project Markdown';
    private readonly excludedFolders = new Set(['System', 'Library', 'Canvas', 'Attachments', 'Research']);

    constructor(private app: App, private baseFolder: string, private manifestPath: string) {}

    async listDocuments(): Promise<TrackedDocument[]> {
        const base = normalizeSourcePath(this.baseFolder);
        const prefix = `${base}/`;
        return this.app.vault.getMarkdownFiles()
            .filter(file => {
                const path = normalizeSourcePath(file.path);
                if (path === normalizeSourcePath(this.manifestPath) || !path.startsWith(prefix)) return false;
                const firstSegment = path.slice(prefix.length).split('/')[0];
                return !this.excludedFolders.has(firstSegment);
            })
            .map(file => ({ id: file.path, path: file.path, label: file.basename, file }));
    }

    async readText(document: TrackedDocument): Promise<string> {
        if (!document.file) return '';
        return this.app.vault.cachedRead(document.file);
    }
}
