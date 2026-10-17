import { useEffect, useState } from 'react';
import { ChevronDown, Search } from 'lucide-react';
import { client } from '../../trpc/client';

interface MessageChoice {
  msgId: string;
  content: string;
  senderName: string;
}
type Cursor = { time: number; rowId: string };

export function MessageScopePicker({
  kind,
  conv,
  selected,
  onChange,
}: {
  kind: 'group' | 'c2c';
  conv: string;
  selected: readonly string[] | undefined;
  onChange: (ids: string[] | undefined) => void;
}) {
  const [keyword, setKeyword] = useState('');
  const [cursor, setCursor] = useState<Cursor>();
  const [next, setNext] = useState<Cursor | null>(null);
  const [rows, setRows] = useState<MessageChoice[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  useEffect(() => {
    let cancelled = false;
    setBusy(true);
    setError('');
    void client.account.browseConversation
      .query({
        kind,
        conv,
        filter: { keyword: keyword.trim() || undefined },
        cursor,
        limit: 50,
      })
      .then((result) => {
        if (cancelled) return;
        setRows((current) => {
          const merged = new Map((cursor ? current : []).map((row) => [row.msgId, row]));
          for (const row of result.items) merged.set(row.msgId, row);
          return [...merged.values()];
        });
        setNext(result.cursor ?? null);
      })
      .catch((reason: unknown) => {
        if (!cancelled) setError(reason instanceof Error ? reason.message : String(reason));
      })
      .finally(() => {
        if (!cancelled) setBusy(false);
      });
    return () => {
      cancelled = true;
    };
  }, [kind, conv, keyword, cursor]);
  const ids = new Set(selected ?? []);
  return (
    <section className="weq-message-scope" aria-label="消息选择">
      <label className="weq-message-scope-mode">
        <input
          type="checkbox"
          checked={selected !== undefined}
          onChange={(event) => onChange(event.target.checked ? [] : undefined)}
        />
        <span>
          {selected === undefined ? '按会话及条件导出' : `仅导出已选 ${selected.length} 条消息`}
        </span>
      </label>
      {selected !== undefined ? (
        <>
          <label className="weq-message-scope-search">
            <Search size={15} />
            <input
              aria-label="筛选可选消息"
              value={keyword}
              placeholder="查找消息"
              onChange={(event) => {
                setKeyword(event.target.value);
                setCursor(undefined);
                setRows([]);
              }}
            />
          </label>
          {error ? <p role="alert">{error}</p> : null}
          <div className="weq-message-scope-rows">
            {rows.map((row) => (
              <label key={row.msgId}>
                <input
                  type="checkbox"
                  checked={ids.has(row.msgId)}
                  onChange={(event) => {
                    const updated = new Set(ids);
                    if (event.target.checked) updated.add(row.msgId);
                    else updated.delete(row.msgId);
                    onChange([...updated]);
                  }}
                />
                <span>
                  <strong>{row.senderName || '未知发送者'}</strong> {row.content || '[非文本消息]'}
                </span>
              </label>
            ))}
          </div>
          {busy ? (
            <p role="status">加载消息…</p>
          ) : next ? (
            <button type="button" onClick={() => setCursor(next)}>
              <ChevronDown size={15} />
              加载更多
            </button>
          ) : null}
          {selected.filter((id) => !rows.some((row) => row.msgId === id)).length > 0 ? (
            <details>
              <summary>当前列表之外的已选消息</summary>
              {selected
                .filter((id) => !rows.some((row) => row.msgId === id))
                .map((id) => (
                  <label key={id}>
                    <input
                      type="checkbox"
                      checked
                      onChange={() => onChange(selected.filter((value) => value !== id))}
                    />
                    <span>消息 {id}</span>
                  </label>
                ))}
            </details>
          ) : null}
        </>
      ) : null}
    </section>
  );
}
