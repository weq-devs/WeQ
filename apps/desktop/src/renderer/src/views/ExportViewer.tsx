import { useEffect, useRef, useState } from 'react';
import {
  ArrowLeft,
  ArrowRight,
  ExternalLink,
  FolderOpen,
  FileJson,
  RefreshCw,
  Search,
  X,
} from 'lucide-react';
import type { ExportViewerMessage, ExportViewerPart, ExportViewerSource } from '@weq/service';
import { client, trpc } from '../trpc/client';
import { useTabActive } from '../components/RetainedTabs';
import { openLightbox } from '../components/ImageLightbox';
import { mediaUrl } from '../lib/resourceUrl';
import '../styles/export-viewer.css';

type Source = ExportViewerSource & { id: string };
const time = (seconds: number) =>
  seconds
    ? new Date(seconds * 1000).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai', hour12: false })
    : '时间未知';

function Part({
  part,
  id,
  onError,
}: {
  part: ExportViewerPart;
  id: string;
  onError: (text: string) => void;
}) {
  const [failed, setFailed] = useState(false);
  if (part.type === 'forward')
    return (
      <details className="weq-ev-forward">
        <summary>
          合并转发{part.messages?.length ? ` · ${part.messages.length} 条` : ' · 未展开'}
        </summary>
        {part.messages?.map((message) => (
          <Message key={message.key} message={message} id={id} onError={onError} />
        ))}
      </details>
    );
  if (part.type === 'text') return <span>{part.text}</span>;
  if (!part.path || failed)
    return <span className="weq-ev-unavailable">{part.text} · 媒体不可用</span>;
  const src = mediaUrl('exportviewer', { id, path: part.path });
  if (part.type === 'image')
    return (
      <button
        type="button"
        className="weq-ev-image"
        title="查看原图"
        aria-label="查看原图"
        onClick={() => openLightbox(src, part.text)}
      >
        <img src={src} alt={part.text} loading="lazy" onError={() => setFailed(true)} />
      </button>
    );
  if (part.type === 'audio')
    return (
      <audio controls preload="none" src={src} onError={() => setFailed(true)}>
        <track kind="captions" />
      </audio>
    );
  if (part.type === 'video')
    return (
      <video controls preload="none" src={src} onError={() => setFailed(true)}>
        <track kind="captions" />
      </video>
    );
  return (
    <button
      type="button"
      onClick={() => {
        void client.exportViewer.revealMedia
          .mutate({ id, path: part.path! })
          .catch((e: Error) => onError(e.message));
      }}
    >
      <FolderOpen size={15} />
      {part.text}
    </button>
  );
}
function Message({
  message,
  id,
  onJump,
  onError,
}: {
  message: ExportViewerMessage;
  id: string;
  onJump?: (id: string) => void;
  onError: (text: string) => void;
}) {
  return (
    <article className="weq-ev-message">
      <header>
        <strong>{message.sender}</strong>
        <time>{time(message.sendTime)}</time>
        {onJump && /^\d+$/.test(message.msgId) ? (
          <button
            type="button"
            title="定位本机消息"
            aria-label="定位本机消息"
            onClick={() => onJump(message.msgId)}
          >
            <ExternalLink size={14} />
          </button>
        ) : null}
      </header>
      <div className="weq-ev-body">
        {message.parts.map((part) => (
          <Part key={part.key} part={part} id={id} onError={onError} />
        ))}
      </div>
    </article>
  );
}

export function ExportViewer({
  onNavigate,
  onIncrement,
}: {
  onNavigate: () => void;
  onIncrement: (source: Source) => void;
}) {
  const active = useTabActive();
  const [sources, setSources] = useState<Source[]>([]);
  const [selected, setSelected] = useState('');
  const [picking, setPicking] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [search, setSearch] = useState('');
  const [query, setQuery] = useState('');
  const [date, setDate] = useState('');
  const [offset, setOffset] = useState(0);
  const owned = useRef<string[]>([]);
  const mounted = useRef(true);
  const activeRef = useRef(active);
  activeRef.current = active;
  const source = sources.find((item) => item.id === selected);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      if (owned.current.length)
        void client.exportViewer.close.mutate({ ids: owned.current }).catch(() => {});
    };
  }, []);
  useEffect(() => {
    const timer = setTimeout(() => {
      setQuery(search);
      setOffset(0);
    }, 300);
    return () => clearTimeout(timer);
  }, [search]);
  const page = trpc.exportViewer.page.useQuery(
    { id: selected, offset, query, date: date || undefined },
    {
      enabled: Boolean(source) && active,
      retry: false,
      staleTime: 30000,
      cacheTime: 0,
    },
  );
  const local = trpc.exportViewer.local.useQuery(
    { id: selected },
    {
      enabled: Boolean(source) && active,
      retry: false,
      refetchOnWindowFocus: true,
    },
  );
  useEffect(() => {
    if (!page.data || query || date) return;
    const count = page.data.total;
    setSources((previous) =>
      previous.some((item) => item.id === selected && item.messageCount === null)
        ? previous.map((item) => (item.id === selected ? { ...item, messageCount: count } : item))
        : previous,
    );
  }, [page.data, query, date, selected]);
  const pick = async (directory: boolean) => {
    setPicking(true);
    setError('');
    setNotice('');
    try {
      const result = await client.exportViewer.pick.mutate({ directory });
      if (!result) return;
      if (!mounted.current || !activeRef.current) {
        await client.exportViewer.close.mutate({ ids: result.sources.map((s) => s.id) });
        return;
      }
      const old = owned.current;
      owned.current = result.sources.map((s) => s.id);
      setSources(result.sources);
      setSelected(result.sources[0]?.id ?? '');
      setOffset(0);
      setSearch('');
      setQuery('');
      setDate('');
      if (old.length) await client.exportViewer.close.mutate({ ids: old });
      if (result.truncated) setNotice('目录或文件较多，列表可能不完整，请选择更具体的导出文件夹。');
    } catch (e) {
      if (mounted.current) setError(e instanceof Error ? e.message : String(e));
    } finally {
      if (mounted.current) setPicking(false);
    }
  };
  const jump = async (msgId?: string) => {
    if (!local.data) return;
    setError('');
    try {
      await client.exportViewer.jump.mutate({
        id: selected,
        msgId,
        expectedUin: local.data.uin,
        expectedConfigId: local.data.configId,
      });
      onNavigate();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };
  return (
    <section className="weq-export-viewer">
      <div className="weq-ev-toolbar">
        <button type="button" disabled={picking} onClick={() => void pick(true)}>
          <FolderOpen size={16} />
          打开文件夹
        </button>
        <button type="button" disabled={picking} onClick={() => void pick(false)}>
          <FileJson size={16} />
          打开 JSON / JSONL
        </button>
        {picking ? <span role="status">正在读取…</span> : null}
        {sources.length ? (
          <button
            type="button"
            title="关闭导出"
            aria-label="关闭导出"
            onClick={() => {
              void client.exportViewer.close.mutate({ ids: owned.current }).catch(() => {});
              owned.current = [];
              setSources([]);
              setSelected('');
            }}
          >
            <X size={16} />
          </button>
        ) : null}
      </div>
      {error || page.error ? (
        <p className="weq-ev-notice" role="alert">
          {error || page.error?.message}
        </p>
      ) : null}
      {notice ? <p className="weq-ev-notice">{notice}</p> : null}
      {local.error ? (
        <p className="weq-ev-notice">本机会话检查失败：{local.error.message}</p>
      ) : null}
      {!sources.length ? (
        <div className="weq-ev-empty">
          <FolderOpen size={36} />
          <p>尚未打开导出</p>
        </div>
      ) : (
        <div className="weq-ev-layout">
          <nav className="weq-ev-sources" aria-label="导出列表">
            {sources.map((item) => (
              <button
                type="button"
                key={item.id}
                aria-pressed={item.id === selected}
                onClick={() => {
                  setSelected(item.id);
                  setOffset(0);
                  setError('');
                }}
              >
                <strong>{item.name}</strong>
                <span>
                  {item.conversation
                    ? `${item.conversation.kind === 'group' ? '群聊' : '私聊'} ${item.conversation.conv}`
                    : '会话未识别'}
                </span>
                <span>
                  {item.messageCount === null ? '条数待统计' : `约 ${item.messageCount} 条`} ·{' '}
                  {item.format.toUpperCase()} · {(item.bytes / 1048576).toFixed(1)} MiB
                </span>
                <span>{time(item.updatedAt / 1000)}</span>
                {item.range ? (
                  <span>
                    {item.range.start ? time(item.range.start) : '不限起点'} 至{' '}
                    {item.range.end ? time(item.range.end) : '不限终点'}
                  </span>
                ) : null}
              </button>
            ))}
          </nav>
          <div className="weq-ev-content">
            <div className="weq-ev-actions">
              <label className="weq-ev-search">
                <Search size={15} />
                <input
                  aria-label="搜索导出消息"
                  placeholder="搜索消息"
                  value={search}
                  onChange={(e) => setSearch(e.target.value)}
                />
              </label>
              <input
                type="date"
                aria-label="消息日期（北京时间）"
                title="消息日期（北京时间）"
                value={date}
                onChange={(e) => {
                  setDate(e.target.value);
                  setOffset(0);
                }}
              />
              <button
                type="button"
                disabled={!local.data}
                title={local.data ? '打开本机会话' : '当前账号没有匹配会话'}
                onClick={() => void jump()}
              >
                <ExternalLink size={15} />
                打开会话
              </button>
              <button
                type="button"
                disabled={!local.data || !source?.baselineDirectory}
                title={
                  !source?.baselineDirectory
                    ? '缺少可用的增量基线'
                    : !local.data
                      ? '当前账号没有匹配会话'
                      : '增量导出'
                }
                onClick={() => source && onIncrement(source)}
              >
                <RefreshCw size={15} />
                增量导出
              </button>
            </div>
            {source && !source.conversation ? (
              <p className="weq-ev-notice">此文件没有稳定的会话标识，仅离线查看。</p>
            ) : null}
            <div className="weq-ev-messages" aria-busy={page.isFetching}>
              {page.isFetching ? (
                <p role="status">正在读取消息…</p>
              ) : page.data?.messages.length ? (
                page.data.messages.map((m) => (
                  <Message
                    key={`${selected}:${m.key}`}
                    message={m}
                    id={selected}
                    onJump={local.data ? (id) => void jump(id) : undefined}
                    onError={setError}
                  />
                ))
              ) : !page.error ? (
                <p>没有匹配的消息</p>
              ) : null}
            </div>
            <footer className="weq-ev-pagination">
              <button
                type="button"
                title="上一页"
                aria-label="上一页"
                disabled={!offset || page.isFetching}
                onClick={() => setOffset(Math.max(0, offset - 100))}
              >
                <ArrowLeft size={16} />
              </button>
              <span>
                {page.data?.total
                  ? `${offset + 1}–${Math.min(offset + 100, page.data.total)} / ${page.data.total}`
                  : '0 条'}
              </span>
              <button
                type="button"
                title="下一页"
                aria-label="下一页"
                disabled={!page.data || offset + 100 >= page.data.total || page.isFetching}
                onClick={() => setOffset(offset + 100)}
              >
                <ArrowRight size={16} />
              </button>
            </footer>
          </div>
        </div>
      )}
    </section>
  );
}
