import { normalizePath } from 'obsidian';
import type SceneCardsPlugin from '../main';
import type { PlotlineDefinition } from '../models/Plotline';
import type { Scene } from '../models/Scene';
import { t } from '../utils/i18n';

const LOCATION_FRAME_TYPE = {
    type: 'LocationFrame',
    label: 'Location Frame',
    badge: 'LF',
    color: '#6f8fcf',
    width: 560,
    kind: 'frame',
    badgeCustom: true,
    fields: [
        { key: 'region', label: 'Region' },
        { key: 'mood', label: 'Mood' },
    ],
    hidden: false,
    eventSheetHidden: true,
};

const STORY_SEQUENCE_TYPE = {
    type: 'StorySequence',
    label: 'Story Sequence',
    badge: 'SS',
    color: '#b48cff',
    width: 540,
    kind: 'frame',
    badgeCustom: true,
    fields: [
        { key: 'location', label: 'Location' },
        { key: 'timeWeather', label: 'Time / Weather' },
        { key: 'questEpisode', label: 'Quest Ep.' },
        { key: 'status', label: 'Status' },
    ],
    hidden: false,
    eventSheetHidden: false,
};

const FRAME_PAD_X = 40;
const FRAME_PAD_Y = 56;
const SCENE_W = 320;
const SCENE_H = 220;
const SCENE_GAP_X = 36;
const SCENE_GAP_Y = 36;
const SCENES_PER_ROW = 3;
const PLOTLINE_GAP_X = 80;
const PLOTLINE_GAP_Y = 100;
const START_X = 80;
const START_Y = 80;

function localizedFrameTypes() {
    return [LOCATION_FRAME_TYPE, STORY_SEQUENCE_TYPE].map(type => ({
        ...type,
        label: t(type.label),
        fields: type.fields.map(field => ({ ...field, label: t(field.label) })),
    }));
}

function uid(prefix: string, index: number): string {
    return `${prefix}${index.toString(36)}`;
}

function scenePlaceholderBody(scene: Scene): string {
    const synopsis = String(scene.synopsis || '').trim();
    if (synopsis) return synopsis;
    return t('To fill — scene beats / dialog / outcomes.');
}

/**
 * Build an ncanvas saved-state from selected plotlines:
 * each plotline → LocationFrame; each ordered scene → child StorySequence (to-fill).
 */
export class PlotlineNcanvasService {
    constructor(private plugin: SceneCardsPlugin) {}

    buildSavedState(opts: {
        title: string;
        plotlineIds: string[];
    }): string {
        const defs = this.plugin.plotlineManager.getPlotlineDefinitions()
            .filter(d => opts.plotlineIds.includes(d.id));
        if (defs.length === 0) {
            throw new Error(t('Select at least one plotline.'));
        }

        const nodes: Record<string, unknown>[] = [];
        const links: Record<string, unknown>[] = [];
        let nodeIndex = 1;
        let linkIndex = 1;

        const entryId = 'n0';
        nodes.push({
            id: entryId,
            type: 'Entry',
            title: t('Start'),
            body: t('Plotline frames generated from NarrativeLab.'),
            x: START_X,
            y: START_Y - 160,
        });

        let cursorX = START_X;
        let cursorY = START_Y;
        let maxRowHeight = 0;
        let firstSceneId: string | null = null;
        let prevPlotlineLastId: string | null = null;

        for (const def of defs) {
            const scenes = this.plugin.plotlineManager.getScenesOrderedForPlotline(def.id);
            const cols = Math.max(1, Math.min(SCENES_PER_ROW, Math.max(scenes.length, 1)));
            const rows = Math.max(1, Math.ceil(Math.max(scenes.length, 1) / cols));
            const frameW = FRAME_PAD_X * 2 + cols * SCENE_W + (cols - 1) * SCENE_GAP_X;
            const frameH = FRAME_PAD_Y + 40 + rows * SCENE_H + (rows - 1) * SCENE_GAP_Y + FRAME_PAD_X;

            // Wrap to next row of plotline frames when getting too wide
            if (cursorX > START_X && cursorX + frameW > START_X + 2400) {
                cursorX = START_X;
                cursorY += maxRowHeight + PLOTLINE_GAP_Y;
                maxRowHeight = 0;
            }

            const frameId = uid('lf', nodeIndex++);
            nodes.push({
                id: frameId,
                type: 'LocationFrame',
                x: cursorX,
                y: cursorY,
                width: frameW,
                height: frameH,
                frameId: '',
                title: def.label || def.id,
                body: t('Plotline workspace — fill region / mood as needed.'),
                customFields: {
                    region: '',
                    mood: '',
                },
            });

            const sceneIdsForPlotline: string[] = [];
            if (scenes.length === 0) {
                const sid = uid('ss', nodeIndex++);
                nodes.push(this.makeStorySequenceNode({
                    id: sid,
                    frameId,
                    x: cursorX + FRAME_PAD_X,
                    y: cursorY + FRAME_PAD_Y,
                    scene: null,
                    plotline: def,
                    index: 0,
                }));
                sceneIdsForPlotline.push(sid);
            } else {
                scenes.forEach((scene, i) => {
                    const col = i % cols;
                    const row = Math.floor(i / cols);
                    const sid = uid('ss', nodeIndex++);
                    const x = cursorX + FRAME_PAD_X + col * (SCENE_W + SCENE_GAP_X);
                    const y = cursorY + FRAME_PAD_Y + row * (SCENE_H + SCENE_GAP_Y);
                    nodes.push(this.makeStorySequenceNode({
                        id: sid,
                        frameId,
                        x,
                        y,
                        scene,
                        plotline: def,
                        index: i,
                    }));
                    sceneIdsForPlotline.push(sid);
                });
            }
            if (!firstSceneId && sceneIdsForPlotline[0]) firstSceneId = sceneIdsForPlotline[0];

            for (let i = 1; i < sceneIdsForPlotline.length; i++) {
                links.push({
                    id: uid('l', linkIndex++),
                    from: sceneIdsForPlotline[i - 1],
                    to: sceneIdsForPlotline[i],
                    label: '',
                });
            }

            if (prevPlotlineLastId && sceneIdsForPlotline[0]) {
                links.push({
                    id: uid('l', linkIndex++),
                    from: prevPlotlineLastId,
                    to: sceneIdsForPlotline[0],
                    label: t('Next plotline'),
                });
            }
            if (sceneIdsForPlotline.length) {
                prevPlotlineLastId = sceneIdsForPlotline[sceneIdsForPlotline.length - 1];
            }

            cursorX += frameW + PLOTLINE_GAP_X;
            maxRowHeight = Math.max(maxRowHeight, frameH);
        }

        if (firstSceneId) {
            links.unshift({
                id: uid('l', linkIndex++),
                from: entryId,
                to: firstSceneId,
                label: t('Begin'),
            });
        }

        const saved = {
            version: 1,
            savedAt: new Date().toISOString(),
            project: {
                title: opts.title,
                notes: t('Generated from NarrativeLab plotlines. Frames are ready to fill.'),
                variables: {},
                characters: [],
                nodeTypes: localizedFrameTypes(),
                nodes,
                links,
            },
            ui: {
                selectedNodeId: entryId,
                selectedLinkId: null,
                panel: 'project',
                activeFileId: 'adventure',
                theme: this.plugin.getEffectiveUiTheme?.() || 'dark',
                view: { x: 0, y: 0, scale: 0.45 },
                snapToGrid: false,
            },
        };

        return JSON.stringify(saved, null, 2);
    }

    private makeStorySequenceNode(opts: {
        id: string;
        frameId: string;
        x: number;
        y: number;
        scene: Scene | null;
        plotline: PlotlineDefinition;
        index: number;
    }): Record<string, unknown> {
        const scene = opts.scene;
        const title = scene?.title
            || t('Scene {n}', { n: opts.index + 1 });
        const body = scene ? scenePlaceholderBody(scene) : t('To fill — add a scene to this plotline in NarrativeLab.');
        const node: Record<string, unknown> = {
            id: opts.id,
            type: 'StorySequence',
            x: opts.x,
            y: opts.y,
            width: SCENE_W,
            height: SCENE_H,
            frameId: opts.frameId,
            title,
            body,
            beatList: '',
            eventType: opts.plotline.label || opts.plotline.id,
            eventDescription: '',
            location: (scene?.location || []).join(', '),
            timeWeather: '',
            questEpisode: '',
            act: scene?.act != null ? String(scene.act) : '',
            chapter: scene?.chapter != null ? String(scene.chapter) : '',
            customFields: {
                status: scene?.status || '',
            },
        };
        if (scene?.filePath) {
            node.vaultFiles = [{ path: normalizePath(scene.filePath) }];
        }
        return node;
    }

    /**
     * Write generated state to a new or existing .ncanvas path and open it.
     */
    async writeAndOpen(opts: {
        path: string;
        title: string;
        plotlineIds: string[];
    }): Promise<string> {
        const json = this.buildSavedState({
            title: opts.title,
            plotlineIds: opts.plotlineIds,
        });
        return this.plugin.writeAndOpenNcanvas(opts.path, json);
    }
}
