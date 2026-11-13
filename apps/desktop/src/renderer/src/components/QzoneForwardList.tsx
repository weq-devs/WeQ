import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import { ChevronDown, Loader2, RefreshCw } from 'lucide-react';
import { client } from '../trpc/client';
import { useQzoneRequests } from '../hooks/useQzoneRequests';
import type { QzoneForwardPage } from '../views/qzone_types';
import { QzonePersonIdentity } from './QzoneProfileAvatar';

export interface QzoneForwardTarget {
  selfUin: string;
  hostUin: string;
  tid: string;
}

export function QzoneForwardList({
  target,
  onCount,
  onSpace,
  renderContent,
  paused = false,
  enabled = true,
  open = true,
}: {
  target: QzoneForwardTarget;
  onCount: (count: number | null) => void;
  onSpace?: (uin: string, nickname?: string) => void;
  renderContent?: (content: string) => ReactNode;
  paused?: boolean;
  enabled?: boolean;
  open?: boolean;
}) {
  const { selfUin, hostUin, tid } = target;
  const [page, setPage] = useState<QzoneForwardPage | null>(null);
  const [rows, setRows] = useState<QzoneForwardPage['forwards']>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const busy = useRef(false);
  const generation = useRef(0);
  const firstRead = useRef(false);
  const { run, cancel } = useQzoneRequests();
  const load = useCallback(
    async (cursor: QzoneForwardPage['nextCursor'], background = false) => {
      if (busy.current || paused) return;
      busy.current = true;
      const request = ++generation.current;
      setLoading(true);
      setError('');
      try {
        const result = await run(
          (requestId) =>
            client.account.qzone.forwards.query({
              selfUin,
              hostUin,
              tid,
              cursor,
              requestId,
            }),
          background,
        );
        if (request !== generation.current) return;
        setRows((previous) => {
          const merged = new Map((cursor ? previous : []).map((row) => [row.key, row]));
          for (const row of result.forwards) merged.set(row.key, row);
          return [...merged.values()];
        });
        setPage(result);
        firstRead.current = true;
        onCount(result.reportedTotal);
      } catch (reason) {
        if (request === generation.current)
          setError(reason instanceof Error ? reason.message : String(reason));
      } finally {
        if (request === generation.current) {
          busy.current = false;
          setLoading(false);
        }
      }
    },
    [selfUin, hostUin, tid, paused, onCount, run],
  );
  useEffect(() => {
    if (enabled && !paused && !firstRead.current) void load(null, true);
    else setLoading(false);
    return () => {
      generation.current++;
      busy.current = false;
      cancel();
    };
  }, [load, cancel, enabled, paused]);
  if (!open) return null;
  const people = new Set(rows.map((row) => row.uin)).size;
  return (
    <div className="weq-qzn-forward-list">
      {rows.map((row) => (
        <div className="weq-qzn-forward-row" key={row.key}>
          <QzonePersonIdentity uin={row.uin} nickname={row.nickname} size={24} onSpace={onSpace} />
          {row.content ? <p>{renderContent ? renderContent(row.content) : row.content}</p> : null}
        </div>
      ))}
      {paused ? <p className="weq-qzn-status">读取已暂停</p> : null}
      {!paused && !loading && !error && rows.length === 0 ? (
        <p className="weq-qzn-status">暂无可读取的转发记录</p>
      ) : null}
      {loading ? (
        <p className="weq-qzn-status" role="status">
          <Loader2 size={14} className="weq-spin" />
          正在读取转发者…
        </p>
      ) : null}
      {error ? (
        <p className="weq-qzn-error" role="alert">
          {error}
          <button
            type="button"
            title="重试转发名单"
            aria-label="重试转发名单"
            onClick={() => void load(page?.nextCursor ?? null)}
          >
            <RefreshCw size={14} />
            重试
          </button>
        </p>
      ) : null}
      {page ? (
        <p className="weq-qzn-status">
          已读取 {people} 人
          {page.reportedTotal === null ? '' : ` · 共 ${page.reportedTotal} 次转发`}
        </p>
      ) : null}
      {page?.nextCursor && !loading && !error && !paused ? (
        <button
          className="weq-qzn-forward-more"
          type="button"
          onClick={() => void load(page.nextCursor)}
        >
          <ChevronDown size={14} />
          加载更多
        </button>
      ) : null}
      {page && !page.nextCursor && !loading ? (
        <p className="weq-qzn-status">
          {page.stopReason === 'complete' ? '已加载完毕' : '已到可读取末页'}
        </p>
      ) : null}
    </div>
  );
}
