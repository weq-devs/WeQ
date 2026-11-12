import { useEffect, useMemo, useRef, useState } from 'react';
import { Loader2, Play, RotateCw, Square } from 'lucide-react';
import { client, trpc } from '../../trpc/client';
import { BuddyAnalyticsDialog } from '../../components/BuddyAnalyticsDialog';
import { GroupAnalyticsDialog } from '../../components/GroupAnalyticsDialog';
import { MemberAnalyticsDialog } from '../../components/MemberAnalyticsDialog';
import type { AnalysisReportRequest } from './model';

export function SavedAnalysisBody({
  request,
  onClose,
}: {
  request: Exclude<AnalysisReportRequest, { kind: 'annual' }>;
  onClose: () => void;
}) {
  const [ready, setReady] = useState(false);
  const [error, setError] = useState('');
  const [positionError, setPositionError] = useState('');
  const [version, setVersion] = useState(0);
  const root = useRef<HTMLDivElement>(null);
  const position = useRef<number | null>(null);
  const restored = useRef<number | null>(null);
  const input = useMemo(() => ({ ...request.scope, id: request.id }), [request]);
  const query = trpc.account.analysisReports.get.useQuery(input, {
    enabled: ready,
    refetchOnWindowFocus: false,
    retry: false,
    refetchInterval: (data) => (data?.status === 'running' ? 1000 : false),
  });
  useEffect(() => {
    let active = true;
    void client.account.analysisReports.create
      .mutate(request)
      .then(() => {
        if (active) setReady(true);
      })
      .catch((reason: unknown) => {
        if (active) setError(String(reason));
      });
    return () => {
      active = false;
    };
  }, [request]);
  const saved = query.data;
  const versions = trpc.account.analysisReports.versions.useQuery(input, {
    enabled: ready,
    refetchOnWindowFocus: false,
  });
  const historical = trpc.account.analysisReports.version.useQuery(
    { ...input, version: version || 1 },
    { enabled: ready && version > 0, refetchOnWindowFocus: false },
  );
  const resultRevision = version || saved?.resultRevision;
  const displayedRequest =
    historical.data && version ? historical.data.request : (saved?.request ?? request);
  useEffect(() => {
    if (resultRevision === undefined || restored.current === resultRevision) return;
    const body = root.current?.querySelector<HTMLElement>('.group-album-body');
    if (body) {
      body.scrollTop = position.current ?? saved?.position ?? 0;
      restored.current = resultRevision;
    }
  }, [resultRevision, saved?.position]);
  useEffect(() => {
    let active = true;
    let previous: number | null = null;
    const save = () => {
      const current = position.current;
      if (current !== null && current !== previous)
        void client.account.analysisReports.position
          .mutate({ ...input, position: current })
          .then(() => {
            previous = current;
            if (active) setPositionError('');
          })
          .catch(() => {
            if (active) setPositionError('阅读位置暂未保存，将自动重试');
          });
    };
    const timer = setInterval(save, 2000);
    return () => {
      active = false;
      clearInterval(timer);
      save();
    };
  }, [input]);
  trpc.account.analysisReports.onChange.useSubscription(request.scope, {
    enabled: ready,
    onData: (id) => {
      if (id === request.id) {
        void query.refetch();
        void versions.refetch();
      }
    },
  });
  async function act(action: 'resume' | 'cancel' | 'refresh') {
    try {
      setError('');
      if (action === 'cancel') await client.account.analysisReports.cancel.mutate(input);
      else
        await client.account.analysisReports.resume.mutate({
          ...input,
          refresh: action === 'refresh',
        });
      await query.refetch();
    } catch (reason) {
      setError(String(reason));
    }
  }
  const range = (next: { start: number; end: number }) => {
    void client.account.analysisReports.revise
      .mutate({ ...input, startTime: next.start, endTime: next.end })
      .then(() => query.refetch())
      .catch((reason: unknown) => setError(String(reason)));
  };
  const running = saved?.status === 'running';
  const data = version ? historical.data?.results : saved?.results;
  return (
    <div
      ref={root}
      className="weq-saved-analysis"
      onScrollCapture={(event) => {
        if (
          event.target instanceof HTMLElement &&
          event.target.classList.contains('group-album-body')
        )
          position.current = event.target.scrollTop;
      }}
    >
      <div className="weq-saved-analysis-status" role="status">
        {!saved || running ? (
          <Loader2 size={16} className="weq-spin" aria-label="正在计算" />
        ) : null}
        <span>
          {saved
            ? {
                running: '正在分析',
                paused: '待继续',
                completed: '已保存',
                failed: '分析失败',
                cancelled: '已取消',
              }[saved.status]
            : '正在读取报告'}
        </span>
        {saved && (
          <span>
            {saved.completed.length} / {request.kind === 'group' ? 3 : 1}
          </span>
        )}
        {(versions.data?.length ?? 0) > 0 ? (
          <select
            aria-label="报告结果版本"
            value={version}
            onChange={(event) => setVersion(Number(event.target.value))}
          >
            <option value={0}>当前结果</option>
            {versions.data?.map((item) => (
              <option key={item.resultRevision} value={item.resultRevision}>
                版本 {item.resultRevision}
              </option>
            ))}
          </select>
        ) : null}
        {saved && (
          <button
            type="button"
            className="weq-set-iconbtn"
            title={running ? '取消分析' : saved.status === 'completed' ? '重新分析' : '继续分析'}
            aria-label={
              running ? '取消分析' : saved.status === 'completed' ? '重新分析' : '继续分析'
            }
            onClick={() =>
              void act(running ? 'cancel' : saved.status === 'completed' ? 'refresh' : 'resume')
            }
          >
            {running ? (
              <Square size={16} />
            ) : saved.status === 'completed' ? (
              <RotateCw size={16} />
            ) : (
              <Play size={16} />
            )}
          </button>
        )}
      </div>
      {error || query.error || saved?.error || positionError ? (
        <p role="alert">{error || query.error?.message || saved?.error || positionError}</p>
      ) : null}
      {data?.report !== undefined ? (
        request.kind === 'buddy' ? (
          <BuddyAnalyticsDialog
            key={resultRevision}
            peerUid={request.peerUid}
            peerName={request.name}
            scope={displayedRequest.scope}
            initialData={data.report}
            embedded
            onClose={onClose}
            onRangeChange={range}
          />
        ) : request.kind === 'group' ? (
          <GroupAnalyticsDialog
            key={resultRevision}
            groupCode={request.groupCode}
            groupName={request.name}
            scope={displayedRequest.scope}
            initialData={data}
            embedded
            onClose={onClose}
            onRangeChange={range}
          />
        ) : (
          <MemberAnalyticsDialog
            key={resultRevision}
            groupCode={request.groupCode}
            groupName={request.groupName}
            member={{ uid: request.memberUid, uin: request.memberUin, name: request.name }}
            scope={displayedRequest.scope}
            initialData={data.report}
            embedded
            onClose={onClose}
          />
        )
      ) : null}
    </div>
  );
}
