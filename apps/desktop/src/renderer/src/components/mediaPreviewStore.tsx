import { useEffect, useRef, useState } from 'react';
import { RefreshCw } from 'lucide-react';
import { MediaPreviewShell } from './MediaPreviewShell';
import { LoadingIndicator } from './LoadingIndicator';
import {
  usePreviews,
  type PreviewComponent,
  loadedPreview,
  loadPreview,
  closeMediaPreview,
} from './mediaPreviewStore.shared';

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
