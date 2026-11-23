import { useContext, useId, useMemo, useRef, useState } from 'react';
import { Forward, Loader2, X } from 'lucide-react';
import type { client } from '../trpc/client';
import type { QQWriteBinding } from '../hooks/useQQWriteSession';
import { useModalBackground } from '../lib/modalBackground';
import { notificationSource } from '../lib/notificationNavigation.shared';
import { QzoneShareForwardContext } from '../lib/qzoneNavigation';
import { Modal } from './Dialog';
import { NumericText } from './NumericText';
import { useTabActive } from './RetainedTabs.shared';
import { useToastApi } from './Toast.shared';
import { QqArk } from './ark/QqArk';
import { MergeForwardTargets } from './mergeForward/MergeForwardTargets';
import type { ForwardedConversationTarget } from './mergeForward/model';
import '../styles/qzone-actions.css';

type ShareResult = Awaited<ReturnType<typeof client.account.qqActions.qzoneOrdinaryShare.mutate>>;
export type ShareState = { scope: string } & (
  | { kind: 'loading' }
  | { kind: 'error'; message: string }
  | { kind: 'ready'; result: ShareResult }
);

export function QzoneShareDialog({
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
    {
      target: ForwardedConversationTarget;
      status: 'sent' | 'unconfirmed' | 'failed';
      error?: string;
    }[]
  >([]);
  const sourceTargets = forward?.targets;
  const targets = useMemo(() => {
    if (!sourceTargets || !outcomes.length) return sourceTargets ?? [];
    const settled = new Set(
      outcomes.filter(({ status }) => status !== 'failed').map(({ target }) => target.id),
    );
    return sourceTargets.filter(({ id }) => !settled.has(id));
  }, [sourceTargets, outcomes]);
  const picked = useMemo(() => targets.filter(({ id }) => selected.has(id)), [targets, selected]);

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
    const next = outcomes.filter(({ target }) => !selected.has(target.id));
    const failed = new Set<string>();
    for (const target of picked) {
      try {
        const result = await forward.send(current.result.ark, target, binding);
        next.push(
          result === 'unconfirmed'
            ? { target, status: 'unconfirmed' }
            : { target: { ...target, ...result }, status: 'sent' },
        );
      } catch (error) {
        failed.add(target.id);
        next.push({
          target,
          status: 'failed',
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
    sending.current = false;
    setBusy(false);
    setSelected(failed);
    setOutcomes(next);
    if (next.every(({ status }) => status === 'sent') && onClose()) {
      toast.push({
        tone: 'success',
        title: `已转发到 ${next.length} 个会话`,
        source: notificationSource(
          { kind: 'forwarded-conversations', targets: next.map(({ target }) => target), binding },
          next.length > 1
            ? '选择转发会话'
            : next[0]?.target.messageId
              ? '定位已转发的消息'
              : '打开转发会话',
          binding,
        ),
      });
    }
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
                  {outcomes.map(({ target, status, error }) => (
                    <li key={target.id}>
                      {target.name}：
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
