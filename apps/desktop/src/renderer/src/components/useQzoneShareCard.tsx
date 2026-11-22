import { useRef, useState } from 'react';
import { Share2 } from 'lucide-react';
import { client } from '../trpc/client';
import type { QQWriteBinding } from '../hooks/useQQWriteSession';
import type { PublicJson } from '../lib/qzonePublic';
import { CopyButton } from './CopyButton';
import { EditorDialog } from './EditorDialog';
import { QqArk } from './ark/QqArk';

type ShareTarget = { hostUin: string; tid: string } | { feed: PublicJson };
type ShareResult = Awaited<ReturnType<typeof client.account.qqActions.qzoneOrdinaryShare.mutate>>;
type ShareState = { scope: string } & (
  | { kind: 'loading' }
  | { kind: 'error'; message: string }
  | { kind: 'ready'; result: ShareResult }
);

export function useQzoneShareCard(
  binding: QQWriteBinding | null,
  target: ShareTarget | null,
  key: string,
) {
  const [state, setState] = useState<ShareState | null>(null);
  const attempt = useRef(0);
  const scope = JSON.stringify([
    binding?.expectedAccountUin,
    binding?.expectedAccountConfigId,
    key,
  ]);
  const current = state?.scope === scope ? state : null;
  const generate = () => {
    if (!binding || !target || current?.kind === 'loading') return;
    const request = ++attempt.current;
    setState({ kind: 'loading', scope });
    void Promise.resolve()
      .then(() =>
        'tid' in target
          ? client.account.qqActions.qzoneOrdinaryShare.mutate({ ...binding, ...target })
          : client.account.qqActions.qzoneFeedShare.mutate({ ...binding, ...target }),
      )
      .then((result) => {
        if (attempt.current === request) setState({ kind: 'ready', scope, result });
      })
      .catch((error: unknown) => {
        if (attempt.current === request)
          setState({
            kind: 'error',
            scope,
            message: error instanceof Error ? error.message : String(error),
          });
      });
  };
  return {
    action: target
      ? {
          label: '分享卡片',
          icon: <Share2 size={16} aria-hidden />,
          disabled: !binding,
          action: generate,
        }
      : null,
    dialog: current ? (
      <EditorDialog
        title="分享卡片"
        onClose={() => {
          attempt.current++;
          setState(null);
        }}
      >
        <div className="weq-qzn-share-result">
          {current.kind === 'loading' ? <p role="status">正在生成分享卡片…</p> : null}
          {current.kind === 'error' ? (
            <>
              <p role="alert">{current.message}</p>
              <button type="button" className="weq-set-btn" disabled={!binding} onClick={generate}>
                重试生成
              </button>
            </>
          ) : null}
          {current.kind === 'ready' ? (
            <>
              <QqArk arkData={current.result.ark} />
              {current.result.notice ? <p>{current.result.notice}</p> : null}
              <div className="weq-qq-action-bar">
                <CopyButton text={current.result.ark} className="weq-set-btn weq-set-btn-primary">
                  {current.result.requires_confirmation ? '确认并复制卡片' : '复制卡片'}
                </CopyButton>
              </div>
            </>
          ) : null}
        </div>
      </EditorDialog>
    ) : null,
  };
}
