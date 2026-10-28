import { useEffect, useId, useRef, useState, type ReactNode } from 'react';
import { Loader2, Repeat2, X } from 'lucide-react';
import { Modal } from './Dialog';
import { client } from '../trpc/client';
import { qzoneForwardDraft } from '../lib/qzoneActions';
import '../styles/qzone-actions.css';

export function QzoneForwardDialog({
  previousContent,
  children,
  onClose,
  submit,
  unavailableReason = '常规说说转发接口尚未接入，文案可编辑，暂不能发送。',
}: {
  previousContent: string;
  children: ReactNode;
  onClose: () => void;
  submit?: (reason: string) => Promise<void>;
  unavailableReason?: string;
}) {
  const titleId = useId();
  const [reason, setReason] = useState('');
  const [ready, setReady] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [retry, setRetry] = useState(0);
  const submitting = useRef(false);
  const input = useRef<HTMLTextAreaElement>(null);
  useEffect(() => {
    let live = true;
    setError('');
    void client.bootstrap.getSettings.query().then(
      (settings) => {
        if (!live) return;
        setReason(qzoneForwardDraft(settings.qzoneForwardQuotePrevious, previousContent));
        setReady(true);
      },
      (reason: unknown) => {
        if (live) setError(reason instanceof Error ? reason.message : '读取转发设置失败');
      },
    );
    return () => {
      live = false;
    };
  }, [previousContent, retry]);
  useEffect(() => {
    if (!ready) return;
    input.current?.focus();
    input.current?.setSelectionRange(0, 0);
  }, [ready]);
  async function send() {
    if (!submit || submitting.current || !ready) return;
    submitting.current = true;
    setBusy(true);
    setError('');
    try {
      await submit(reason);
      onClose();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : '转发失败');
    } finally {
      submitting.current = false;
      setBusy(false);
    }
  }
  return (
    <Modal width={560} onClose={busy ? undefined : onClose} labelledBy={titleId}>
      <section className="weq-qzn-forward-dialog">
        <header>
          <h2 id={titleId}>转发到我的空间</h2>
          <button type="button" title="关闭" aria-label="关闭" disabled={busy} onClick={onClose}>
            <X size={18} />
          </button>
        </header>
        <textarea
          ref={input}
          aria-label="转发语"
          placeholder="说点什么（可留空）"
          value={reason}
          maxLength={4096}
          disabled={busy || !ready}
          onChange={(event) => setReason(event.target.value)}
        />
        <section className="weq-qzn-forward-original" aria-label="原动态">
          {children}
        </section>
        {!submit ? <p className="weq-qzn-status">{unavailableReason}</p> : null}
        {error ? (
          <p className="weq-qzn-error" role="alert">
            {error}
            {!ready ? (
              <button type="button" onClick={() => setRetry((value) => value + 1)}>
                重试
              </button>
            ) : null}
          </p>
        ) : null}
        <footer>
          <button
            type="button"
            className="weq-qzn-primary"
            disabled={!submit || busy || !ready}
            onClick={() => void send()}
          >
            {busy ? <Loader2 size={15} className="weq-spin" /> : <Repeat2 size={15} />}转发
          </button>
        </footer>
      </section>
    </Modal>
  );
}
