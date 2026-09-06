import type { ItemView, Workspace } from 'obsidian';
import { t } from './i18n';

/** Keep disk IO and editor construction out of Obsidian's layout restore await. */
export function deferWorkspaceView<T extends ItemView & { onOpen(): Promise<void>; onClose(): Promise<void> }>(
    view: T,
    workspace: Workspace,
    ready: Promise<void>,
    loadingText: string,
): T {
    const open = view.onOpen.bind(view);
    const close = view.onClose.bind(view);
    const resize = view.onResize.bind(view);
    const refreshable = view as T & { refresh?: (...args: unknown[]) => unknown };
    const refresh = refreshable.refresh?.bind(view);
    let opened = false;
    let readyToMount = false;
    let mounted = false;
    let mountAttempted = false;
    let mounting: Promise<void> | null = null;
    let timer: ReturnType<typeof setTimeout> | null = null;

    const request = () => {
        if (!opened || !readyToMount || !workspace.layoutReady || mounted || mounting || timer !== null) return;
        timer = setTimeout(() => {
            timer = null;
            if (!opened || mounted || !view.contentEl.isConnected || view.contentEl.getClientRects().length === 0) return;
            mountAttempted = true;
            mounting = Promise.resolve().then(open).then(() => { mounted = true; }).catch(error => {
                console.error('[WritingLab] View initialization failed:', error);
                if (opened) {
                    view.contentEl.empty();
                    view.contentEl.createDiv({text: String(error)});
                    view.contentEl.createEl('button', {text: t('Retry')}).onclick = request;
                }
            }).finally(() => { mounting = null; });
        }, 0);
    };
    view.registerEvent(workspace.on('active-leaf-change', request));
    view.registerEvent(workspace.on('layout-change', request));
    workspace.onLayoutReady(request);
    void ready.then(() => { readyToMount = true; request(); });
    view.onOpen = async () => {
        opened = true;
        view.contentEl.empty();
        view.contentEl.createDiv({cls: 'story-line-empty-state', text: loadingText});
        request();
    };
    view.onResize = () => { if (mounted) resize(); else request(); };
    if (refresh) refreshable.refresh = (...args: unknown[]) => {
        if (!mounted) { request(); return; }
        return refresh(...args);
    };
    view.onClose = async () => {
        opened = false;
        if (timer !== null) clearTimeout(timer);
        timer = null;
        // An in-flight open owns this view's containers. Drain it before closing
        // so a late read cannot resurrect a detached editor or save to a new tab.
        if (mounting) await mounting;
        if (mountAttempted) await close();
        mounted = false;
        mountAttempted = false;
    };
    return view;
}
