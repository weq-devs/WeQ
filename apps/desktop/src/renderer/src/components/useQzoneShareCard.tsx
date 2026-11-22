import { useContext, useId, useRef, useState } from 'react';
import { Forward, Loader2, Share2, X } from 'lucide-react';
import { client } from '../trpc/client';
import type { QQWriteBinding } from '../hooks/useQQWriteSession';
import { useModalBackground } from '../lib/modalBackground';
import { QzoneShareForwardContext } from '../lib/qzoneNavigation';
import type { PublicJson } from '../lib/qzonePublic';
import { Modal } from './Dialog';
import { NumericText } from './NumericText';
import { useTabActive } from './RetainedTabs.shared';
import { useToastApi } from './Toast.shared';
import { QqArk } from './ark/QqArk';
import { MergeForwardTargets } from './mergeForward/MergeForwardTargets';
import '../styles/qzone-actions.css';

type ShareTarget = { hostUin: string; tid: string } | { feed: PublicJson };
type ShareResult = Awaited<ReturnType<typeof client.account.qqActions.qzoneOrdinaryShare.mutate>>;
type ShareState = { scope: string } & (
  | { kind: 'loading' }
  | { kind: 'error'; message: string }
  | { kind: 'ready'; result: ShareResult }
);

function QzoneShareDialog({
  current,
  binding,
  available,
  generate,
  onClose,
}: {
  current: ShareState;
  binding: QQWriteBinding | null;
  available: boolean;
  generate: () => void;
  onClose: () => boolean;
}) {
  const forward = useContext(QzoneShareForwardContext);
  const toast = useToastApi();
  const titleId = useId();
  const dialog = useRef<HTMLDivElement>(null);
  const active = useTabActive();
  useModalBackground(dialog, active);
  const sending = useRef(false);
  const [busy, setBusy] = useState(false);
  const [selected, setSelected] = useState(() => new Set<string>());
  const [outcomes, setOutcomes] = useState<
    { id: string; name: string; status: 'sent' | 'unconfirmed' | 'failed'; error?: string }[]
  >([]);
  const settled = new Set(outcomes.filter(({ status }) => status !== 'failed').map(({ id }) => id));
  const targets = forward?.targets.filter(({ id }) => !settled.has(id)) ?? [];
  const picked = targets.filter(({ id }) => selected.has(id));

  async function send() {
    if (
      !forward ||
      !binding ||
      !available ||
      current.kind !== 'ready' ||
      sending.current ||
      !picked.length
    )
      return;
    sending.current = true;
    setBusy(true);
    const next = outcomes.filter(({ id }) => !selected.has(id));
    const failed = new Set<string>();
    for (const target of picked) {
      const { id, name } = target;
      try {
        const status = (await forward.send(current.result.ark, target, binding)) ?? 'sent';
        next.push({ id, name, status });
      } catch (error) {
        failed.add(id);
        next.push({
          id,
          name,
          status: 'failed',
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
    sending.current = false;
    setBusy(false);
    setSelected(failed);
    setOutcomes(next);
    if (next.every(({ status }) => status === 'sent') && onClose())
      toast.push({ tone: 'success', title: `已转发到 ${next.length} 个会话` });
  }

  return (
    <Modal
      width={560}
      labelledBy={titleId}
      className="weq-mf-modal"
      onClose={busy ? undefined : onClose}
      dismissOnOutside={false}
      focusContainerOnOpen
    >
      <div
        ref={dialog}
        className="weq-mf weq-qzn-share"
        data-picking={current.kind === 'ready' && targets.length > 0 ? '' : undefined}
        aria-busy={busy}
      >
        <header className="weq-mf-head">
          <div className="weq-mf-head-title">
            <strong id={titleId}>分享卡片</strong>
          </div>
          <button
            type="button"
            className="weq-mf-icon-btn"
            title="关闭分享卡片"
            aria-label="关闭分享卡片"
            disabled={busy}
            onClick={onClose}
          >
            <X size={16} aria-hidden />
          </button>
        </header>
        <div className="weq-mf-body weq-qzn-share-body">
          {current.kind === 'loading' ? (
            <p className="weq-qzn-share-status" role="status">
              正在生成分享卡片…
            </p>
          ) : null}
          {current.kind === 'error' ? (
            <p className="weq-qzn-share-status" role="alert">
              {current.message}
            </p>
          ) : null}
          {current.kind === 'ready' ? (
            <>
              <section className="weq-qzn-share-preview" aria-label="卡片预览">
                <QqArk arkData={current.result.ark} />
              </section>
              {current.result.notice ? (
                <p className="weq-qzn-share-status">{current.result.notice}</p>
              ) : null}
              {outcomes.length ? (
                <ul className="weq-qzn-share-outcomes" aria-live="polite">
                  {outcomes.map(({ id, name, status, error }) => (
                    <li key={id}>
                      {name}：
                      {status === 'sent'
                        ? '已转发'
                        : status === 'unconfirmed'
                          ? '发送结果未确认，请先核对会话'
                          : error}
                    </li>
                  ))}
                </ul>
              ) : null}
              {targets.length ? (
                <div className="weq-qzn-share-picker" inert={busy}>
                  <MergeForwardTargets
                    targets={targets}
                    selected={selected}
                    onChange={setSelected}
                  />
                </div>
              ) : !outcomes.length ? (
                <p className="weq-qzn-share-status">没有可转发的会话</p>
              ) : null}
            </>
          ) : null}
        </div>
        <footer className="weq-mf-foot">
          {current.kind === 'ready' && targets.length ? (
            <span className="weq-qzn-share-count" role="status">
              <NumericText>{`已选 ${picked.length} 个会话`}</NumericText>
            </span>
          ) : null}
          <div className="weq-mf-foot-group weq-mf-foot-actions">
            <button type="button" className="weq-mf-soft" disabled={busy} onClick={onClose}>
              {current.kind === 'ready' && !targets.length && outcomes.length ? '关闭' : '取消'}
            </button>
            {current.kind === 'error' ? (
              <button
                type="button"
                className="weq-mf-primary"
                disabled={!available}
                onClick={generate}
              >
                重试生成
              </button>
            ) : null}
            {current.kind === 'ready' ? (
              <button
                type="button"
                className="weq-mf-primary"
                disabled={busy || !available || !picked.length}
                onClick={() => void send()}
              >
                {busy ? (
                  <Loader2 size={15} className="weq-spin" aria-hidden />
                ) : (
                  <Forward size={15} aria-hidden />
                )}
                {busy
                  ? '正在转发…'
                  : current.result.requires_confirmation
                    ? '确认并转发'
                    : '转发到会话'}
              </button>
            ) : null}
          </div>
        </footer>
      </div>
    </Modal>
  );
}

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
