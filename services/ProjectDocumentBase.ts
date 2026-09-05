import { normalizePath, TFile, type App } from 'obsidian';
import type { StoryLineProject } from '../models/StoryLineProject';
import { deriveProjectFoldersFromFilePath } from '../models/StoryLineProject';
import { t } from '../utils/i18n';

const LEGACY_DOCUMENT_BASE_FILENAME = 'writing.base';
const EXCLUDED_FOLDERS = ['System', 'Library', 'Canvas', 'Attachments', 'Research', 'Notes', 'Scenes'];

function yamlString(value: string): string {
    return JSON.stringify(value);
}

export function projectDocumentBasePath(project: StoryLineProject): string {
    const baseFolder = deriveProjectFoldersFromFilePath(project.filePath).baseFolder;
    const safeProjectName = project.title.trim()
        .replace(/[\\/:*?"<>|]/g, '-')
        .replace(/[. ]+$/g, '') || 'Project';
    return normalizePath([baseFolder, `writing-${safeProjectName}.base`].filter(Boolean).join('/'));
}

function legacyProjectDocumentBasePath(project: StoryLineProject): string {
    const baseFolder = deriveProjectFoldersFromFilePath(project.filePath).baseFolder;
    return normalizePath([baseFolder, LEGACY_DOCUMENT_BASE_FILENAME].filter(Boolean).join('/'));
}

export function buildProjectDocumentBase(project: StoryLineProject): string {
    const baseFolder = normalizePath(deriveProjectFoldersFromFilePath(project.filePath).baseFolder);
    const filters = [
        `    - if(file, file.inFolder(${yamlString(baseFolder)}), false)`,
        '    - if(file, file.ext == "md", false)',
        `    - if(file, file.path != ${yamlString(normalizePath(project.filePath))}, false)`,
        ...EXCLUDED_FOLDERS.map(folder =>
            `    - if(file, file.inFolder(${yamlString(normalizePath(`${baseFolder}/${folder}`))}) == false, false)`),
    ];
    return [
        'filters:',
        '  and:',
        ...filters,
        'views:',
        '  - type: table',
        `    name: ${yamlString(t('Document list'))}`,
        '    order:',
        '      - file.name',
        '      - file.mtime',
        '',
    ].join('\n');
}

export async function ensureProjectDocumentBase(app: App, project: StoryLineProject): Promise<TFile> {
    const path = projectDocumentBasePath(project);
    const existing = app.vault.getAbstractFileByPath(path);
    if (existing instanceof TFile) return existing;
    if (existing) throw new Error(`Cannot create document Base over a folder: ${path}`);
    const legacy = app.vault.getAbstractFileByPath(legacyProjectDocumentBasePath(project));
    if (legacy instanceof TFile) {
        await app.fileManager.renameFile(legacy, path);
        return legacy;
    }
    return app.vault.create(path, buildProjectDocumentBase(project));
}
