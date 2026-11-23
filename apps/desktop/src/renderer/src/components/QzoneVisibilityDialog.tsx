import { useEffect, useId, useRef, useState } from 'react';
import { Loader2 } from 'lucide-react';
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
  onSave,
}: {
  binding: QQWriteBinding;
  tid: string;
  anchor: HTMLElement | null;
  busy: boolean;
  disabled: boolean;
  onClose: () => void;
  onSave: (expected: QzoneTextVisibility, visibility: QzoneTextVisibility) => Promise<void>;
}) {
  const titleId = useId();
  const surface = useRef<HTMLFormElement>(null);
  useEffect(() => surface.current?.focus({ preventScroll: true }), []);
  const [selected, setSelected] = useState<QzoneTextVisibility>();
  const query = trpc.account.qqActions.qzoneTextPostVisibility.useQuery(
    { ...binding, tid },
    { staleTime: 0, refetchOnMount: 'always', refetchOnWindowFocus: false, retry: false },
  );
  const current = query.data?.visibility;
  const visibility = selected ?? current;
  return (
    <OverlayLayer
      presentation="popover"
      anchor={anchor}
      anchorPlacement="side"
      consumeOutsidePress={false}
      className="weq-qzn-visibility-layer"
      onClose={busy ? undefined : onClose}
    >
      <form
        ref={surface}
        tabIndex={-1}
        role="dialog"
        aria-labelledby={titleId}
        aria-busy={busy || undefined}
        className="weq-qzn-visibility-popover"
        onSubmit={(event) => {
          event.preventDefault();
          if (
            current !== undefined &&
            visibility !== undefined &&
            current !== visibility &&
            !busy &&
            !disabled &&
            !query.isError &&
            !query.isFetching
          )
            void onSave(current, visibility);
        }}
      >
        <h2 id={titleId}>修改可见范围</h2>
        {query.isError ? (
          <p className="weq-qzn-error" role="alert">
            {query.error.message}
          </p>
        ) : visibility === undefined ? (
          <span role="status">正在读取可见范围…</span>
        ) : (
          <SegmentedControl<QzoneTextVisibility>
            value={visibility}
            label="说说可见范围"
            options={QZONE_VISIBILITY}
            disabled={busy || disabled || query.isFetching}
            onChange={setSelected}
          />
        )}
        <footer>
          <button
            type="button"
            className="weq-set-btn"
            disabled={busy}
            onClick={() => {
              onClose();
              anchor?.focus({ preventScroll: true });
            }}
          >
            取消
          </button>
          {query.isError ? (
            <button
              type="button"
              className="weq-set-btn"
              disabled={query.isFetching}
              onClick={() => {
                setSelected(undefined);
                void query.refetch();
              }}
            >
              重新读取
            </button>
          ) : (
            <button
              type="submit"
              className="weq-set-btn weq-set-btn-primary"
              disabled={
                busy ||
                disabled ||
                query.isFetching ||
                current === undefined ||
                visibility === current
              }
            >
              {busy ? <Loader2 className="weq-spin" size={14} aria-hidden /> : null}
              保存
            </button>
          )}
        </footer>
      </form>
    </OverlayLayer>
  );
}
