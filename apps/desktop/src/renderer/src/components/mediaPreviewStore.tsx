import { create } from 'zustand';
import { useEffect, useRef } from 'react';
import { MediaPreview } from './MediaPreview';
import type { MediaPreviewOptions } from './mediaPreviewTypes';

type Session = MediaPreviewOptions & { id: number; hostKind: 'image' | 'video' };
let sequence = 0;
const usePreviews = create<{ sessions: Map<Document, Session> }>(() => ({ sessions: new Map() }));

export function closeMediaPreview(owner: Document, id?: number) {
  const sessions = new Map(usePreviews.getState().sessions);
  const current = sessions.get(owner);
  if (!current || (id !== undefined && current.id !== id)) return;
  sessions.delete(owner);
  usePreviews.setState({ sessions });
  current.onClose();
}

export function openMediaPreview(
  options: MediaPreviewOptions,
  hostKind: 'image' | 'video' = 'image',
) {
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
  sessions.set(owner, { ...options, ownerDocument: owner, id, hostKind });
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

export function MediaPreviewHost({ kind }: { kind?: 'image' | 'video' }) {
  const sessions = usePreviews((state) => state.sessions);
  const owned = useRef(sessions);
  owned.current = sessions;
  useEffect(
    () => () => {
      for (const session of owned.current.values())
        if (!kind || session.hostKind === kind)
          closeMediaPreview(session.ownerDocument!, session.id);
    },
    [kind],
  );
  return (
    <>
      {[...sessions.values()]
        .filter((session) => !kind || session.hostKind === kind)
        .map((session) => (
          <MediaPreview
            key={session.id}
            {...session}
            onClose={() => closeMediaPreview(session.ownerDocument!, session.id)}
          />
        ))}
    </>
  );
}
