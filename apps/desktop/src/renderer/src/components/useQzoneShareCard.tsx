import { useRef, useState } from 'react';
import { Share2 } from 'lucide-react';
import { client } from '../trpc/client';
import type { QQWriteBinding } from '../hooks/useQQWriteSession';
import type { PublicJson } from '../lib/qzonePublic';
import { QzoneShareDialog, type ShareState } from './QzoneShareDialog';

type ShareTarget = { hostUin: string; tid: string } | { feed: PublicJson };

export function useQzoneShareCard(
  binding: QQWriteBinding | null,
  available: boolean,
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
  const latestScope = useRef(scope);
  latestScope.current = scope;
  const current = state?.scope === scope ? state : null;
  if (state && !current) setState(null);
  const generate = () => {
    if (!binding || !available || !target || current?.kind === 'loading') return;
    const request = ++attempt.current;
    const isCurrent = () => attempt.current === request && latestScope.current === scope;
    setState({ kind: 'loading', scope });
    void Promise.resolve()
      .then(() =>
        'tid' in target
          ? client.account.qqActions.qzoneOrdinaryShare.mutate({ ...binding, ...target })
          : client.account.qqActions.qzoneFeedShare.mutate({ ...binding, ...target }),
      )
      .then((result) => {
        if (isCurrent()) setState({ kind: 'ready', scope, result });
      })
      .catch((error: unknown) => {
        if (isCurrent())
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
          disabled: !binding || !available,
          action: generate,
        }
      : null,
    dialog: current ? (
      <QzoneShareDialog
        key={scope}
        current={current}
        binding={binding}
        available={available}
        generate={generate}
        onClose={() => {
          if (latestScope.current !== scope) return false;
          attempt.current++;
          setState(null);
          return true;
        }}
      />
    ) : null,
  };
}
