import { useState } from 'react';
import { Search, X } from 'lucide-react';
import { trpc } from '../trpc/client';
import { useQQWriteSession } from '../hooks/useQQWriteSession';
import { Modal } from './Dialog';
import { withQQAccountScope } from './qq-actions/shared';
import '../styles/friend-directory.css';

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
      title={title}
      className="weq-friend-directory-editor"
      onClose={onClose}
    >
      <header>
        <h3>{title}</h3>
        <button type="button" title="关闭" aria-label="关闭" onClick={onClose}>
          <X size={18} />
        </button>
      </header>
      <form
        onSubmit={(event) => {
          event.preventDefault();
          if (valid) {
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
            required
            value={number}
            onChange={(event) => {
              setNumber(event.target.value.replace(/\D/g, ''));
              setSubmitted(null);
            }}
          />
        </label>
        <footer>
          <button type="submit" disabled={!valid || !session.available || result.isFetching}>
            <Search size={16} />
            {result.isFetching ? '搜索中' : '搜索'}
          </button>
        </footer>
      </form>
      {!session.available && <p role="status">QQ 在线能力未就绪</p>}
      {result.error && submitted && <p role="alert">{result.error.message}</p>}
      {result.data && submitted && (
        <dl>
          <dt>{result.data.name || (result.data.kind === 'group' ? '群资料' : '用户资料')}</dt>
          <dd>{result.data.id}</dd>
          {result.data.level !== null && (
            <>
              <dt>QQ 等级</dt>
              <dd>{result.data.level}</dd>
            </>
          )}
          {result.data.category && (
            <>
              <dt>群分类</dt>
              <dd>{result.data.category}</dd>
            </>
          )}
        </dl>
      )}
    </Modal>
  );
}
export const QQExactLookup = withQQAccountScope(QQExactLookupBody);
