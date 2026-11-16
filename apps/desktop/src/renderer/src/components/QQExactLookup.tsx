import { useId, useState } from 'react';
import { AlertCircle, Loader2, Search, X } from 'lucide-react';
import { trpc } from '../trpc/client';
import { useQQWriteSession } from '../hooks/useQQWriteSession';
import { Modal } from './Dialog';
import { withQQAccountScope } from './qq-actions/shared';
import '../styles/friend-directory.css';
import '../styles/qq-exact-lookup.css';

export type QQExactLookupKind = 'user' | 'group';
function QQExactLookupBody({
  kind,
  initial = '',
  onClose,
}: {
  kind: QQExactLookupKind;
  initial?: string;
  onClose: () => void;
}) {
  const session = useQQWriteSession('exact-lookup');
  const titleId = useId();
  const resultId = useId();
  const [number, setNumber] = useState(initial);
  const [submitted, setSubmitted] = useState<{ kind: 'user' | 'group'; target: string } | null>(
    null,
  );
  const valid = /^[1-9]\d{0,9}$/.test(number) && BigInt(number) <= 0xffffffffn;
  const title = kind === 'user' ? 'QQ 号搜索' : '群号搜索';
  const result = trpc.account.qqWrite.exactProfile.useQuery(
    { ...session.binding!, kind: submitted?.kind ?? kind, target: submitted?.target ?? '' },
    {
      enabled: session.available && Boolean(submitted),
      retry: false,
      staleTime: 0,
      refetchOnWindowFocus: false,
    },
  );
  return (
    <Modal
      centered
      width={440}
      labelledBy={titleId}
      title={title}
      className="weq-friend-directory-editor weq-exact-lookup"
      onClose={onClose}
    >
      <header>
        <h3 id={titleId}>{title}</h3>
        <button
          className="weq-set-iconbtn"
          type="button"
          title="关闭"
          aria-label="关闭"
          onClick={onClose}
        >
          <X size={18} aria-hidden />
        </button>
      </header>
      <form
        onSubmit={(event) => {
          event.preventDefault();
          if (valid && session.available && !result.isFetching) {
            setSubmitted({ kind, target: number });
            if (submitted?.kind === kind && submitted.target === number) void result.refetch();
          }
        }}
      >
        <label>
          {kind === 'user' ? 'QQ 号' : '群号'}
          <input
            autoFocus
            inputMode="numeric"
            className="weq-set-input weq-number weq-number-inherit"
            placeholder={kind === 'user' ? '输入 QQ 号' : '输入群号'}
            autoComplete="off"
            maxLength={10}
            required
            value={number}
            onChange={(event) => {
              setNumber(event.target.value.replace(/\D/g, ''));
              setSubmitted(null);
            }}
          />
        </label>
        {!session.available && (
          <p className="weq-directory-feedback" role="status">
            <AlertCircle size={16} aria-hidden />
            <span>QQ 在线能力未就绪</span>
          </p>
        )}
        {result.error && submitted && !result.isFetching && (
          <p className="weq-directory-feedback" role="alert">
            <AlertCircle size={16} aria-hidden />
            <span>{result.error.message}</span>
          </p>
        )}
        {result.data && submitted && !result.isFetching && !result.error && (
          <section className="weq-exact-lookup-result" aria-labelledby={resultId}>
            <h4 id={resultId}>
              {result.data.name || (result.data.kind === 'group' ? '群资料' : '用户资料')}
            </h4>
            <dl>
              <dt>{result.data.kind === 'group' ? '群号' : 'QQ 号'}</dt>
              <dd className="weq-number weq-number-inherit">{result.data.id}</dd>
              {result.data.level !== null && (
                <>
                  <dt>QQ 等级</dt>
                  <dd className="weq-number weq-number-inherit">{result.data.level}</dd>
                </>
              )}
              {result.data.category && (
                <>
                  <dt>群分类</dt>
                  <dd>{result.data.category}</dd>
                </>
              )}
            </dl>
          </section>
        )}
        <footer>
          <button type="button" className="weq-set-btn" onClick={onClose}>
            取消
          </button>
          <button
            className="weq-set-btn weq-set-btn-primary"
            type="submit"
            disabled={!valid || !session.available || result.isFetching}
          >
            {result.isFetching ? (
              <Loader2 size={16} className="animate-spin" aria-hidden />
            ) : (
              <Search size={16} aria-hidden />
            )}
            <span aria-live="polite">{result.isFetching ? '搜索中…' : '搜索'}</span>
          </button>
        </footer>
      </form>
    </Modal>
  );
}
export const QQExactLookup = withQQAccountScope(QQExactLookupBody);
