import { useEffect, useId, useRef, useState } from 'react';
import { Loader2, X } from 'lucide-react';
import type { QzoneTextVisibility } from '@weqbot/protocol/web';
import { QZONE_VISIBILITY } from '../../../shared/qzone';
import { trpc } from '../trpc/client';
import type { QQWriteBinding } from '../hooks/useQQWriteSession';
import { OverlayLayer } from './OverlayLayer';
import { SegmentedControl } from './SegmentedControl';
import '../styles/qzone-actions.css';

export function QzoneVisibilityDialog({
  binding,
  tid,
  anchor,
  busy,
  disabled,
  onClose,
  onChange,
}: {
  binding: QQWriteBinding;
  tid: string;
  anchor: HTMLElement | null;
  busy: boolean;
  disabled: boolean;
  onClose: () => void;
  onChange: (
    expected: QzoneTextVisibility,
    visibility: QzoneTextVisibility,
  ) => Promise<QzoneTextVisibility | undefined>;
}) {
  const titleId = useId();
  const surface = useRef<HTMLElement>(null);
  useEffect(() => surface.current?.focus({ preventScroll: true }), []);
  const [confirmed, setConfirmed] = useState<QzoneTextVisibility>();
  const query = trpc.account.qqActions.qzoneTextPostVisibility.useQuery(
    { ...binding, tid },
    {
      staleTime: 0,
      refetchOnMount: 'always',
      refetchOnWindowFocus: false,
      refetchOnReconnect: false,
      retry: false,
    },
  );
  const current = confirmed ?? query.data?.visibility;
  return (
    <OverlayLayer
      presentation="popover"
      anchor={anchor}
      anchorPlacement="side"
      consumeOutsidePress={false}
      className="weq-qzn-visibility-layer"
      onClose={busy ? undefined : onClose}
    >
      <section
        ref={surface}
        tabIndex={-1}
        role="dialog"
        aria-labelledby={titleId}
        aria-busy={busy || undefined}
        className="weq-qzn-visibility-popover"
      >
        <header>
          <h2 id={titleId}>修改可见范围</h2>
          {busy ? <Loader2 className="weq-spin" size={14} aria-hidden /> : null}
          <button
            type="button"
            className="weq-set-iconbtn"
            aria-label="关闭修改可见范围"
            title="关闭"
            disabled={busy}
            onClick={() => {
              onClose();
              anchor?.focus({ preventScroll: true });
            }}
          >
            <X size={15} aria-hidden />
          </button>
        </header>
        {query.isError ? (
          <div>
            <p className="weq-qzn-error" role="alert">
              {query.error.message}
            </p>
            <button
              type="button"
              className="weq-set-btn"
              disabled={query.isFetching}
              onClick={() => void query.refetch()}
            >
              重新读取
            </button>
          </div>
        ) : current === undefined ? (
          <span role="status">正在读取可见范围…</span>
        ) : (
          <SegmentedControl<QzoneTextVisibility>
            value={current}
            label="说说可见范围"
            options={QZONE_VISIBILITY}
            disabled={busy || disabled || query.isFetching}
            onChange={(visibility) => {
              if (visibility === current || busy || disabled || query.isFetching) return;
              void onChange(current, visibility).then((observed) => {
                if (observed !== undefined) setConfirmed(observed);
              });
            }}
          />
        )}
      </section>
    </OverlayLayer>
  );
}
