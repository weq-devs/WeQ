import { useState } from 'react';
import { trpc } from '../trpc/client';
import { useQQWriteSession } from '../hooks/useQQWriteSession';
import { CopyButton } from './CopyButton';
import { EditorDialog } from './EditorDialog';

export function OnlineContactDirectory({ onClose }: { onClose: () => void }) {
  const session = useQQWriteSession('online-contact-directory');
  const query = trpc.account.qqActions.onlineDirectory.useQuery(session.binding!, {
    enabled: session.available,
    refetchOnWindowFocus: false,
    retry: false,
  });
  const [kind, setKind] = useState<'friends' | 'groups'>('friends');
  const [search, setSearch] = useState('');
  const [limit, setLimit] = useState(50);
  const rows =
    kind === 'friends'
      ? query.data?.friends?.map((row) => ({
          id: row.uin,
          name: row.name,
          hint: row.robotCandidate ? '命中机器人号段' : '',
        }))
      : query.data?.groups?.map((row) => ({ ...row, hint: '' }));
  const term = search.trim().toLowerCase();
  const matches = rows?.filter(
    (row) => !term || row.id.includes(term) || row.name.toLowerCase().includes(term),
  );
  return (
    <EditorDialog title="在线好友与群" onClose={onClose}>
      <div className="weq-join-settings">
        <div className="weq-qq-action-bar">
          <button
            type="button"
            className="weq-set-btn"
            aria-pressed={kind === 'friends'}
            onClick={() => {
              setKind('friends');
              setLimit(50);
            }}
          >
            好友
          </button>
          <button
            type="button"
            className="weq-set-btn"
            aria-pressed={kind === 'groups'}
            onClick={() => {
              setKind('groups');
              setLimit(50);
            }}
          >
            群聊
          </button>
          <button
            type="button"
            className="weq-set-btn"
            disabled={query.isFetching || !session.available}
            onClick={() => void query.refetch()}
          >
            刷新名册
          </button>
        </div>
        <label>
          查找
          <input
            value={search}
            onChange={(event) => {
              setSearch(event.target.value);
              setLimit(50);
            }}
            placeholder="昵称、群名或号码"
          />
        </label>
        {query.isFetching ? <p role="status">正在读取在线名册…</p> : null}
        {query.error ? <p role="alert">{query.error.message}</p> : null}
        {!query.isFetching && rows === undefined && query.data ? (
          <p role="alert">读取该名册失败。</p>
        ) : null}
        {matches && !matches.length ? <p>没有匹配的结果。</p> : null}
        <ul>
          {matches?.slice(0, limit).map((row) => (
            <li key={row.id} className="flex items-center justify-between gap-2 py-1">
              <span>
                {row.name || row.id}
                {row.hint ? <small> · {row.hint}</small> : null}
              </span>
              <CopyButton text={row.id} className="weq-set-btn">
                {row.id}
              </CopyButton>
            </li>
          ))}
        </ul>
        {matches && matches.length > limit ? (
          <button
            type="button"
            className="weq-set-btn"
            onClick={() => setLimit((value) => value + 50)}
          >
            显示更多
          </button>
        ) : null}
      </div>
    </EditorDialog>
  );
}
