import { NumericText } from './NumericText';
import { EmptyState } from './EmptyState';
import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import { Loader2, Forward } from 'lucide-react';
import { client } from '../trpc/client';
import { useQzoneRequests } from '../hooks/useQzoneRequests';
import type { QzoneForwardPage } from '../views/qzone_types';
import { QzonePageButton } from '../views/QzonePagination';
import { QzonePersonIdentity } from './QzoneProfileAvatar';
import type { PageDataCache } from '../lib/pageDataCache';

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
  cache,
  cacheKey,
}: {
  target: QzoneForwardTarget;
  onCount: (count: number | null) => void;
  onSpace?: (uin: string, nickname?: string) => void;
  renderContent?: (content: string) => ReactNode;
  paused?: boolean;
  enabled?: boolean;
  open?: boolean;
  cache?: PageDataCache | null;
  cacheKey?: string;
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
        const cached = !cursor && cacheKey ? cache?.get<QzoneForwardPage>(cacheKey) : undefined;
        const result =
          cached ??
          (await run(
            (requestId) =>
              client.account.qzone.forwards.query({
                selfUin,
                hostUin,
                tid,
                cursor,
                requestId,
              }),
            background,
          ));
        if (request !== generation.current) return;
        if (!cached && !cursor && cacheKey) cache?.put(cacheKey, result);
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
    [selfUin, hostUin, tid, paused, onCount, run, cache, cacheKey],
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
        <EmptyState variant="inline" icon={<Forward />} title="暂无可读取的转发记录" />
      ) : null}
      {loading && !page?.nextCursor ? (
        <p className="weq-qzn-status" role="status">
          <Loader2 size={14} className="weq-spin" />
          正在读取转发者…
        </p>
      ) : null}
      {error ? (
        <>
          <p className="weq-qzn-error" role="alert">
            {error}
          </p>
          <QzonePageButton
            label="重试"
            title="重试转发名单"
            retry
            onClick={() => void load(page?.nextCursor ?? null)}
          />
        </>
      ) : null}
      {page ? (
        <p className="weq-qzn-status">
          已读取 <span className="weq-number weq-number-inherit">{people}</span> 人
          {page.reportedTotal === null ? (
            ''
          ) : (
            <NumericText>{` · 共 ${page.reportedTotal} 次转发`}</NumericText>
          )}
        </p>
      ) : null}
      {page?.nextCursor && !error && !paused ? (
        <QzonePageButton
          label="加载更多"
          loading={loading}
          onClick={() => void load(page.nextCursor)}
        />
      ) : null}
      {page && !page.nextCursor && !loading ? (
        <p className="weq-qzn-status">
          {page.stopReason === 'complete' ? '已加载完毕' : '已到可读取末页'}
        </p>
      ) : null}
    </div>
  );
}
