import { create } from 'zustand';
import type { MediaPreviewOptions } from './mediaPreviewTypes';

type OpenMediaPreviewOptions = Omit<MediaPreviewOptions, 'onClose'> & { onClose?: () => void };
type Session = MediaPreviewOptions & { id: number };
export type PreviewComponent = typeof import('./MediaPreview').MediaPreview;
export let loadedPreview: PreviewComponent | undefined;
let pendingPreview: Promise<PreviewComponent> | undefined;
export function loadPreview() {
  pendingPreview ??= import('./MediaPreview')
    .then((module) => {
      loadedPreview = module.MediaPreview;
      return loadedPreview;
    })
    .catch((error: unknown) => {
      pendingPreview = undefined;
      throw error;
    });
  return pendingPreview;
}

const createPreviewSessions = () => ({
  sequence: 0,
  store: create<{ sessions: Map<Document, Session> }>(() => ({ sessions: new Map() })),
});

// 等待手动重载时，新旧入口模块可能共存，必须与预览宿主共用会话状态。
const hotData = import.meta.hot?.data;
const previewSessions: ReturnType<typeof createPreviewSessions> =
  hotData?.mediaPreviewSessions ?? createPreviewSessions();
if (hotData) hotData.mediaPreviewSessions = previewSessions;
export const usePreviews = previewSessions.store;

export function closeMediaPreview(owner: Document, id?: number) {
  const sessions = new Map(usePreviews.getState().sessions);
  const current = sessions.get(owner);
  if (!current || (id !== undefined && current.id !== id)) return;
  sessions.delete(owner);
  usePreviews.setState({ sessions });
  current.onClose();
}

export function openMediaPreview(options: OpenMediaPreviewOptions) {
  void loadPreview().catch(() => {});
  const owner = options.ownerDocument ?? document;
  const existing = usePreviews.getState().sessions.get(owner);
  if (
    existing &&
    !options.initialKey &&
    !existing.initialKey &&
    !options.loadPage &&
    !existing.loadPage &&
    options.items.length === 1 &&
    existing.items.length === 1 &&
    options.items[0]?.key === existing.items[0]?.key &&
    options.items[0]?.src === existing.items[0]?.src &&
    options.items[0]?.kind === existing.items[0]?.kind
  )
    return previewHandle(owner, existing.id);
  closeMediaPreview(owner);
  const id = ++previewSessions.sequence;
  const sessions = new Map(usePreviews.getState().sessions);
  sessions.set(owner, {
    ...options,
    items: options.items.map((item) =>
      item.saveSource !== undefined || item.load || item.originalImage
        ? item
        : {
            ...item,
            saveSource: item.src.startsWith('blob:')
              ? null
              : { kind: 'url', url: item.src, name: item.title },
          },
    ),
    onClose: options.onClose ?? (() => {}),
    ownerDocument: owner,
    id,
  });
  usePreviews.setState({ sessions });
  return previewHandle(owner, id);
}

function previewHandle(owner: Document, id: number) {
  return {
    close: () => closeMediaPreview(owner, id),
    update: (items: MediaPreviewOptions['items']) => {
      const current = usePreviews.getState().sessions.get(owner);
      if (current?.id !== id) return;
      const next = new Map(usePreviews.getState().sessions);
      next.set(owner, { ...current, items });
      usePreviews.setState({ sessions: next });
    },
  };
}
