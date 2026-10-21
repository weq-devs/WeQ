import { useEffect, useState } from 'react';
import { ChevronDown, Search } from 'lucide-react';
import { client } from '../../trpc/client';
import { useMultiSelection } from '../../hooks/useMultiSelection';
import { previewNodes, previewNodesToText } from '../../lib/conversationPreview';

interface MessageChoice {
  msgId: string;
  content: string;
  senderName: string;
}
type Cursor = { time: number; rowId: string; msgId?: string };

export function MessageScopePicker({
  kind,
  conv,
  selected,
  onChange,
}: {
  kind: 'group' | 'c2c' | 'guild';
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
  const exact = selected !== undefined;
  useEffect(() => {
    if (!exact) {
      setRows([]);
      setCursor(undefined);
      setNext(null);
      setBusy(false);
      setError('');
      return;
    }
    let cancelled = false;
    setBusy(true);
    setError('');
    const query =
      kind === 'guild'
        ? (cursor
            ? client.account.guildDirectBefore.query({
                nodeId: conv,
                beforeSeq: cursor.rowId,
                beforeMsgId: cursor.msgId,
                limit: 50,
              })
            : client.account.guildDirectLatest.query({
                nodeId: conv,
                limit: 50,
                stablePaging: true,
              })
          ).then((items) => ({
            items: items.map((row) => ({
              msgId: row.msgId,
              content: row.elements
                .map((element) => previewNodesToText(previewNodes(element)))
                .filter(Boolean)
                .join(' '),
              senderName: row.sendType === '0' ? '对方' : '我',
            })),
            cursor:
              items.length >= 50
                ? { time: 0, rowId: items.at(-1)!.msgSeq, msgId: items.at(-1)!.msgId }
                : null,
          }))
        : client.account.browseConversation.query({
            kind,
            conv,
            filter: { keyword: keyword.trim() || undefined },
            cursor,
            limit: 50,
          });
    void query
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
  }, [kind, conv, keyword, cursor, exact]);
  const ids = new Set(selected ?? []);
  const multi = useMultiSelection({
    ids: [...new Set([...rows.map((row) => row.msgId), ...(selected ?? [])])],
    selected: ids,
    onChange: (nextIds) => onChange([...nextIds]),
    disabled: selected === undefined,
  });
  return (
    <section className="weq-message-scope" aria-label="消息选择" {...multi.rootProps}>
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
          {kind !== 'guild' ? (
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
          ) : null}
          {error ? <p role="alert">{error}</p> : null}
          <div className="weq-message-scope-rows">
            {rows.map((row) => (
              <label key={row.msgId} {...multi.itemProps(row.msgId)}>
                <input type="checkbox" checked={ids.has(row.msgId)} readOnly />
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
                  <label key={id} {...multi.itemProps(id)}>
                    <input type="checkbox" checked readOnly />
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
