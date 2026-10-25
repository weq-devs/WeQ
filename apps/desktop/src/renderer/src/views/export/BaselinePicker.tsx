import { useCallback, useEffect, useRef, useState } from 'react';
import { FolderOpen, RefreshCw, X } from 'lucide-react';
import { OverlayLayer } from '../../components/OverlayLayer';
import { client } from '../../trpc/client';
import type { CalendarTarget } from '../../lib/messageCalendar';

type Entry = Awaited<ReturnType<typeof client.account.listExportBaselines.query>>['items'][number];
export type BaselineSelection = { directory: string; byConversation: Record<string, string> };
const keyFor = (target: { kind: string; conv: string }) => `${target.kind}:${target.conv}`;
const date = (milliseconds: number) =>
  new Intl.DateTimeFormat('zh-CN', {
    timeZone: 'Asia/Shanghai',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  }).format(milliseconds);

export function BaselinePicker({
  initialDirectory,
  targets = [],
  onSelect,
  onClose,
}: {
  initialDirectory?: string;
  targets?: CalendarTarget[];
  onSelect: (selection: BaselineSelection | null) => void;
  onClose: () => void;
}) {
  const [directory, setDirectory] = useState(initialDirectory ?? '');
  const [items, setItems] = useState<Entry[]>([]);
  const [choices, setChoices] = useState<Record<string, string>>({});
  const [loaded, setLoaded] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [truncated, setTruncated] = useState(false);
  const revision = useRef(0);
  const latestTargets = useRef(targets);
  latestTargets.current = targets;
  const load = useCallback(async (root: string) => {
    const current = ++revision.current;
    setBusy(true);
    setError('');
    setLoaded(false);
    setItems([]);
    setChoices({});
    try {
      const result = await client.account.listExportBaselines.query({ directory: root });
      if (revision.current !== current) return;
      setDirectory(root);
      setItems(result.items);
      setTruncated(result.truncated);
      setLoaded(true);
      const groups = latestTargets.current.length ? latestTargets.current : result.items;
      const defaults: Record<string, string> = {};
      for (const target of groups) {
        const matches = result.items.filter((item) => keyFor(item) === keyFor(target));
        if (matches.length === 1) defaults[keyFor(target)] = matches[0]!.directory;
      }
      setChoices(defaults);
    } catch (e) {
      if (revision.current === current) setError(e instanceof Error ? e.message : String(e));
    } finally {
      if (revision.current === current) setBusy(false);
    }
  }, []);
  useEffect(() => {
    if (initialDirectory) void load(initialDirectory);
    return () => {
      revision.current++;
    };
  }, [initialDirectory, load]);
  const groups = [
    ...new Map(
      (targets.length ? targets : items).map((target) => [keyFor(target), target]),
    ).values(),
  ];
  const allowed = new Set(groups.map(keyFor));
  const ready =
    loaded &&
    !busy &&
    groups.length > 0 &&
    groups.every((group) => choices[keyFor(group)] !== undefined);
  const info = (item: Entry) => (
    <>
      <strong>{item.name}</strong>
      <span>
        {item.kind === 'group' ? '群聊' : '私聊'} {item.conv} ·{' '}
        {item.messageCount === null ? '条数未记录' : `约 ${item.messageCount} 条`} ·{' '}
        {item.formats.join(' / ').toUpperCase() || '格式未记录'} · 记录{' '}
        {(item.bytes / 1024 / 1024).toFixed(1)} MiB
      </span>
      <span>
        {item.range?.start == null ? '不限开始时间' : date(item.range.start * 1000)} 至{' '}
        {item.range?.end == null ? '不限结束时间' : date(item.range.end * 1000)} · 更新{' '}
        {item.updatedAt ? date(item.updatedAt) : '时间未记录'}（北京时间）
      </span>
      <small>{item.directory}</small>
    </>
  );
  return (
    <OverlayLayer onClose={onClose}>
      <div className="modal-scrim weq-export-auth-scrim">
        <section
          role="dialog"
          aria-modal="true"
          aria-label="选择增量基线"
          className="weq-export-authorization weq-export-baseline-picker"
        >
          <header>
            <strong>
              <FolderOpen size={17} />
              选择增量基线
            </strong>
            <button
              type="button"
              className="weq-exp-tool"
              title="关闭基线选择"
              aria-label="关闭基线选择"
              onClick={onClose}
            >
              <X size={16} />
            </button>
          </header>
          <div className="weq-export-baseline-root">
            <input
              aria-label="基线所在文件夹"
              disabled={busy}
              value={directory}
              onChange={(event) => {
                setDirectory(event.target.value);
                setLoaded(false);
              }}
              placeholder="导出文件夹或上级文件夹"
            />
            <button
              type="button"
              className="weq-exp-tool"
              title="浏览基线所在文件夹"
              aria-label="浏览基线所在文件夹"
              disabled={busy}
              onClick={() => {
                const current = revision.current;
                void client.account.pickExportBaselineDirectory
                  .mutate()
                  .then((path) => {
                    if (path && revision.current === current) void load(path);
                  })
                  .catch((e) => {
                    if (revision.current === current) setError(String(e));
                  });
              }}
            >
              <FolderOpen size={16} />
            </button>
            <button
              type="button"
              className="weq-exp-tool"
              title="读取导出文件夹列表"
              aria-label="读取导出文件夹列表"
              disabled={busy || !directory}
              onClick={() => void load(directory)}
            >
              <RefreshCw size={16} />
            </button>
          </div>
          {busy ? <p role="status">正在读取导出列表</p> : null}
          {error ? <p role="alert">{error}</p> : null}
          {truncated ? <p role="status">列表未列全，请选择更具体的文件夹。</p> : null}
          {loaded && !groups.length ? (
            <p role="status">未找到导出基线，可新建导出或选择其他文件夹。</p>
          ) : null}
          {loaded
            ? groups.map((group) => {
                const key = keyFor(group),
                  matches = items.filter((item) => keyFor(item) === key);
                return (
                  <fieldset key={key}>
                    <legend>
                      {group.conv} ·{' '}
                      {matches.length === 0
                        ? '未找到相同会话，可创建或重新选择'
                        : matches.length === 1
                          ? '已找到相同会话'
                          : `找到 ${matches.length} 个相同会话，请选择`}
                    </legend>
                    {matches.map((item) => (
                      <label className="weq-export-baseline-entry" key={item.directory}>
                        <input
                          type="radio"
                          name={`baseline-${key}`}
                          checked={choices[key] === item.directory}
                          onChange={() =>
                            setChoices((previous) => ({ ...previous, [key]: item.directory }))
                          }
                        />
                        <span>{info(item)}</span>
                      </label>
                    ))}
                    <label className="weq-export-baseline-new">
                      <input
                        type="radio"
                        name={`baseline-${key}`}
                        checked={choices[key] === ''}
                        onChange={() => setChoices((previous) => ({ ...previous, [key]: '' }))}
                      />
                      为此会话创建新导出
                    </label>
                  </fieldset>
                );
              })
            : null}
          {items.some((item) => !allowed.has(keyFor(item))) ? (
            <details open>
              <summary>其他会话的导出文件夹</summary>
              {items
                .filter((item) => !allowed.has(keyFor(item)))
                .map((item) => (
                  <div className="weq-export-baseline-entry" key={item.directory}>
                    <span>{info(item)}</span>
                  </div>
                ))}
            </details>
          ) : null}
          <footer>
            <button type="button" className="weq-exp-btn" onClick={() => onSelect(null)}>
              新建导出
            </button>
            <button
              type="button"
              className="weq-exp-btn is-primary"
              disabled={!ready}
              onClick={() =>
                onSelect({
                  directory,
                  byConversation: { ...choices },
                })
              }
            >
              使用所选基线
            </button>
          </footer>
        </section>
      </div>
    </OverlayLayer>
  );
}
