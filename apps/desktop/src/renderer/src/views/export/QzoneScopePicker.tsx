import { useEffect, useMemo, useState } from 'react';
import { ChevronDown, RotateCw, Search } from 'lucide-react';
import { client } from '../../trpc/client';
import { useQzoneRequests } from '../../hooks/useQzoneRequests';
import { useMultiSelection } from '../../hooks/useMultiSelection';
import { useTabActive } from '../../components/RetainedTabs';
import { WindowedList } from '../../components/WindowedList';

interface Choice {
  tid: string;
  content: string;
  time: number;
}
export function QzoneScopePicker({
  selfUin,
  hostUin,
  selected,
  onChange,
}: {
  selfUin: string;
  hostUin: string;
  selected: readonly string[] | undefined;
  onChange: (ids: string[] | undefined) => void;
}) {
  const active = useTabActive();
  const [rows, setRows] = useState<Choice[]>([]);
  const [offset, setOffset] = useState(0);
  const [next, setNext] = useState<number | null>(null);
  const [keyword, setKeyword] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [retry, setRetry] = useState(0);
  const { run, cancel } = useQzoneRequests();
  const exact = selected !== undefined;
  useEffect(() => {
    if (!exact) {
      setRows([]);
      setOffset(0);
      setNext(null);
      setBusy(false);
      setError('');
      return;
    }
    if (!active || !selfUin) return;
    let live = true;
    setBusy(true);
    setError('');
    void run((requestId) =>
      client.account.qzone.posts.query({ selfUin, hostUin, requestId, offset }),
    )
      .then((page) => {
        if (!live) return;
        setRows((current) => [
          ...new Map(
            [...(offset ? current : []), ...page.list].map((row) => [row.tid, row]),
          ).values(),
        ]);
        setNext(
          page.list.length && offset + page.list.length < page.total
            ? offset + page.list.length
            : null,
        );
      })
      .catch((reason: unknown) => {
        if (live) setError(reason instanceof Error ? reason.message : String(reason));
      })
      .finally(() => {
        if (live) setBusy(false);
      });
    return () => {
      live = false;
      cancel();
    };
  }, [exact, active, selfUin, hostUin, offset, retry, run, cancel]);
  const visible = useMemo(
    () =>
      rows.filter((row) =>
        row.content.toLocaleLowerCase().includes(keyword.trim().toLocaleLowerCase()),
      ),
    [rows, keyword],
  );
  const outside = (selected ?? []).filter((id) => !rows.some((row) => row.tid === id));
  const multi = useMultiSelection({
    ids: [...visible.map((row) => row.tid), ...outside],
    selected: new Set(selected ?? []),
    onChange: (ids) => onChange([...ids]),
    disabled: !exact,
  });
  return (
    <section className="weq-message-scope" aria-label="说说精确范围" {...multi.rootProps}>
      <label className="weq-message-scope-mode">
        <input
          type="checkbox"
          checked={exact}
          onChange={(event) => onChange(event.target.checked ? [] : undefined)}
        />
        <span>{exact ? `精确选中 ${selected.length} 条说说` : '按空间及日期导出'}</span>
      </label>
      {exact ? (
        <>
          <label className="weq-message-scope-search">
            <Search size={15} />
            <input
              aria-label="筛选已载入说说"
              placeholder="筛选已载入说说"
              value={keyword}
              onChange={(event) => setKeyword(event.target.value)}
            />
          </label>
          <WindowedList
            items={visible}
            height={300}
            rowHeight={64}
            itemKey={(row) => row.tid}
            resetKey={keyword}
            scrollToKey={multi.focusRequest?.id}
            scrollRevision={multi.focusRequest?.revision}
            renderItem={(row) => (
              <label className="weq-qzone-scope-row" {...multi.itemProps(row.tid)}>
                <input type="checkbox" readOnly checked={selected.includes(row.tid)} />
                <span title={row.content}>{row.content || '[无文字说说]'}</span>
              </label>
            )}
          />
          {outside.length ? (
            <details>
              <summary>当前列表之外已选 {outside.length} 条</summary>
              <WindowedList
                items={outside}
                height={180}
                rowHeight={40}
                itemKey={(id) => id}
                renderItem={(id) => (
                  <label className="weq-qzone-scope-row" {...multi.itemProps(id)}>
                    <input type="checkbox" readOnly checked />
                    <span>{id}</span>
                  </label>
                )}
              />
            </details>
          ) : null}
          {busy ? (
            <p role="status">读取说说…</p>
          ) : error ? (
            <div role="alert">
              <span>{error}</span>
              <button
                type="button"
                aria-label="重试读取说说范围"
                title="重试读取说说范围"
                onClick={() => setRetry((value) => value + 1)}
              >
                <RotateCw size={15} />
              </button>
            </div>
          ) : next !== null ? (
            <button type="button" onClick={() => setOffset(next)}>
              <ChevronDown size={15} />
              加载更多说说
            </button>
          ) : null}
        </>
      ) : null}
    </section>
  );
}
