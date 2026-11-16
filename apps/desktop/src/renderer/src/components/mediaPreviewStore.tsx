import { create } from 'zustand';
import { useEffect, useRef, useState } from 'react';
import { RefreshCw } from 'lucide-react';
import { MediaPreviewShell } from './MediaPreviewShell';
import { LoadingIndicator } from './LoadingIndicator';
import type { MediaPreviewOptions } from './mediaPreviewTypes';

type OpenMediaPreviewOptions = Omit<MediaPreviewOptions, 'onClose'> & { onClose?: () => void };
type Session = MediaPreviewOptions & { id: number };
let sequence = 0;
type PreviewComponent = typeof import('./MediaPreview').MediaPreview;
let loadedPreview: PreviewComponent | undefined;
let pendingPreview: Promise<PreviewComponent> | undefined;
function loadPreview() {
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
const usePreviews = create<{ sessions: Map<Document, Session> }>(() => ({ sessions: new Map() }));

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
  const id = ++sequence;
  const sessions = new Map(usePreviews.getState().sessions);
  sessions.set(owner, {
    ...options,
    items: options.items.map((item) =>
      item.saveSource !== undefined || item.load
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

export function MediaPreviewHost() {
  const sessions = usePreviews((state) => state.sessions);
  const [Preview, setPreview] = useState<PreviewComponent | undefined>(() => loadedPreview);
  const [failed, setFailed] = useState(false);
  const [retry, setRetry] = useState(0);
  const requested = sessions.size > 0;
  useEffect(() => {
    if (!requested || Preview) return;
    let active = true;
    setFailed(false);
    void loadPreview()
      .then((component) => {
        if (active) setPreview(() => component);
      })
      .catch(() => {
        if (active) setFailed(true);
      });
    return () => {
      active = false;
    };
  }, [requested, Preview, retry]);
  const owned = useRef(sessions);
  owned.current = sessions;
  useEffect(
    () => () => {
      for (const session of owned.current.values())
        closeMediaPreview(session.ownerDocument!, session.id);
    },
    [],
  );
  return (
    <>
      {[...sessions.values()].map((session) =>
        Preview ? (
          <Preview
            key={session.id}
            {...session}
            onClose={() => closeMediaPreview(session.ownerDocument!, session.id)}
          />
        ) : (
          <MediaPreviewShell
            key={session.id}
            title={session.label ?? '媒体预览'}
            active={session.active}
            ownerDocument={session.ownerDocument}
            onClose={() => closeMediaPreview(session.ownerDocument!, session.id)}
          >
            <div className="weq-panel-loading" role={failed ? 'alert' : 'status'}>
              {failed ? (
                <button
                  type="button"
                  className="weq-set-btn"
                  onClick={() => setRetry((value) => value + 1)}
                >
                  <RefreshCw size={16} aria-hidden />
                  重新加载预览
                </button>
              ) : (
                <LoadingIndicator />
              )}
            </div>
          </MediaPreviewShell>
        ),
      )}
    </>
  );
}
