import { FormSelect } from '../../components/FormSelect';
import { useEffect, useLayoutEffect, useMemo, useRef, useState, type RefObject } from 'react';
import { ListTodo, Loader2, Play, RefreshCw, Square } from 'lucide-react';
import { client, trpc } from '../../trpc/client';
import { analysisPeriod } from '@weq/service/analysis-report';
import { eventTimeFormatter } from '@weq/time';
import { BuddyAnalyticsDialog } from '../../components/BuddyAnalyticsDialog';
import { GroupAnalyticsDialog } from '../../components/GroupAnalyticsDialog';
import { MemberAnalyticsDialog } from '../../components/MemberAnalyticsDialog';
import { useDialog } from '../../components/Dialog.shared';
import { backgroundResult } from '../../../../shared/task_archive';
import { taskNotificationForeground } from '../../lib/taskNotificationPresentation';
import { useWorkspaceMenu } from '../../state/workspaceMenu';
import type { AnalysisReportRequest } from './model';

export function SavedAnalysisBody({
  request,
  onClose,
  closeRequest,
}: {
  request: Exclude<AnalysisReportRequest, { kind: 'annual' }>;
  onClose: () => void;
  closeRequest?: RefObject<(() => void) | null>;
}) {
  const [ready, setReady] = useState(Boolean(request.existing));
  const [error, setError] = useState('');
  const [positionError, setPositionError] = useState('');
  const [version, setVersion] = useState(0);
  const root = useRef<HTMLDivElement>(null);
  const position = useRef<number | null>(null);
  const restored = useRef<number | null>(null);
  const { expectedAccountUin, expectedAccountConfigId } = request.scope;
  const input = useMemo(
    () => ({ expectedAccountUin, expectedAccountConfigId, id: request.id }),
    [expectedAccountUin, expectedAccountConfigId, request.id],
  );
  const initial = useRef(request);
  const creating = useRef<Promise<unknown> | null>(null);
  const ownsRun = useRef(!request.existing);
  const mounted = useRef(false);
  const pending = useRef<Promise<unknown> | null>(null);
  const [busy, setBusy] = useState(false);
  const confirm = useDialog((state) => state.confirm);
  const query = trpc.account.analysisReports.get.useQuery(input, {
    enabled: ready,
    refetchOnWindowFocus: false,
    retry: false,
    refetchInterval: (data) => (data?.status === 'running' ? 1000 : false),
  });
  useEffect(() => {
    mounted.current = true;
    if (!initial.current.existing) {
      creating.current ??= client.account.analysisReports.create.mutate(initial.current);
      void creating.current.then(
        () => {
          if (mounted.current) setReady(true);
        },
        (reason: unknown) => {
          ownsRun.current = false;
          if (mounted.current) setError(String(reason));
        },
      );
    }
    return () => {
      mounted.current = false;
      // StrictMode remounts effects synchronously. An actual removal relinquishes the foreground run.
      queueMicrotask(() => {
        if (mounted.current || !ownsRun.current) return;
        void Promise.allSettled([creating.current, pending.current])
          .then(() => {
            if (!mounted.current && ownsRun.current)
              return client.account.analysisReports.pauseForeground.mutate(input);
          })
          .catch(() => undefined);
      });
    };
  }, [input]);
  const saved = query.data;
  const completedAt = saved?.status === 'completed' && !version ? saved.updatedAt : undefined;
  useEffect(() => {
    if (completedAt === undefined) return;
    let active = true;
    let observed = false;
    const see = async () => {
      if (observed || !taskNotificationForeground()) return;
      observed = true;
      const tasks = await client.backgroundTasks.list.query({
        uin: expectedAccountUin,
        configId: expectedAccountConfigId,
      });
      const task = tasks.find(
        (row) =>
          row.reportId === input.id &&
          row.kind === 'analysis' &&
          row.status === 'completed' &&
          row.updatedAt === completedAt,
      );
      if (!active || !task || !taskNotificationForeground()) {
        observed = false;
        return;
      }
      const result = backgroundResult(task);
      const id = `background:host:${task.id}`;
      useWorkspaceMenu
        .getState()
        .readTask(JSON.stringify([expectedAccountUin, expectedAccountConfigId]), id, result);
      await client.taskArchive.change.mutate({
        expectedAccountUin,
        expectedAccountConfigId,
        action: 'auto',
        tasks: [{ id, result }],
      });
    };
    const onVisible = () => {
      void see().catch(() => {
        observed = false;
      });
    };
    onVisible();
    window.addEventListener('focus', onVisible);
    document.addEventListener('visibilitychange', onVisible);
    return () => {
      active = false;
      window.removeEventListener('focus', onVisible);
      document.removeEventListener('visibilitychange', onVisible);
    };
  }, [completedAt, input, expectedAccountConfigId, expectedAccountUin]);
  const versions = trpc.account.analysisReports.versions.useQuery(input, {
    enabled: ready,
    refetchOnWindowFocus: false,
  });
  const historical = trpc.account.analysisReports.version.useQuery(
    { ...input, version: version || 1 },
    { enabled: ready && version > 0, refetchOnWindowFocus: false, keepPreviousData: true },
  );
  const resultRevision =
    (version ? historical.data?.resultRevision : undefined) ?? saved?.resultRevision;
  const displayedRequest =
    historical.data && version
      ? historical.data.request
      : (saved?.resultRequest ?? saved?.request ?? request);
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
  async function perform(action: () => Promise<unknown>) {
    if (pending.current) return;
    const operation = Promise.resolve().then(action);
    pending.current = operation;
    setBusy(true);
    setError('');
    try {
      await operation;
    } catch (reason) {
      if (mounted.current) setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      pending.current = null;
      if (mounted.current) setBusy(false);
    }
  }
  const act = (action: 'resume' | 'cancel' | 'refresh') =>
    perform(async () => {
      if (action === 'refresh') setVersion(0);
      if (action === 'cancel') await client.account.analysisReports.cancel.mutate(input);
      else {
        ownsRun.current = true;
        await client.account.analysisReports.resume.mutate({
          ...input,
          refresh: action === 'refresh',
        });
      }
      await query.refetch();
    });
  const range = (next: { start: number; end: number }) =>
    void perform(async () => {
      setVersion(0);
      ownsRun.current = true;
      await client.account.analysisReports.revise.mutate({
        ...input,
        startTime: next.start,
        endTime: next.end,
      });
      await query.refetch();
    });
  const running = saved?.status === 'running';
  const foreground = saved?.taskHidden === true;
  useLayoutEffect(() => {
    if (!closeRequest) return;
    closeRequest.current = () => {
      if (pending.current) return;
      if (ownsRun.current && (!saved || (foreground && (running || saved.status === 'paused')))) {
        void perform(async () => {
          if (
            running &&
            !(await confirm(
              '暂停并关闭分析报告？',
              '已完成的阶段会保留。稍后可从「已保存的分析报告」继续。',
              { okLabel: '暂停并关闭', cancelLabel: '返回报告' },
            ))
          )
            return;
          await creating.current;
          await client.account.analysisReports.pauseForeground.mutate(input);
          ownsRun.current = false;
          if (mounted.current) onClose();
        });
      } else {
        ownsRun.current = false;
        onClose();
      }
    };
    return () => {
      closeRequest.current = null;
    };
  });
  const stage =
    running && saved.logs.at(-1)?.text.startsWith('正在计算') ? saved.logs.at(-1)?.text : undefined;
  const data = (version ? historical.data?.results : undefined) ?? saved?.results;
  const historyError = version > 0 ? historical.error : undefined;
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
      <div className="weq-saved-analysis-status">
        {saved?.resultRevision ? (
          <span>已保存结果 · 版本 {resultRevision}</span>
        ) : (
          <span>暂无已保存结果</span>
        )}
        {!saved || running || (version > 0 && historical.isFetching) ? (
          <Loader2
            size={16}
            className="weq-spin"
            aria-label={
              version > 0 && historical.isFetching
                ? '正在读取历史版本'
                : running
                  ? '正在分析'
                  : '正在读取报告'
            }
          />
        ) : null}
        <span role="status">
          {saved
            ? {
                running: '正在分析',
                paused: '待继续',
                completed: '分析完成',
                failed: '分析失败',
                cancelled: '已取消',
              }[saved.status]
            : '正在读取报告'}
        </span>
        {stage && <span>{stage}</span>}
        {saved && request.kind === 'group' && saved.status !== 'completed' && (
          <span>
            <span className="weq-number weq-number-inherit">{saved.completed.length}</span> / 3
          </span>
        )}
        {saved && (versions.data?.length ?? 0) > 1 ? (
          <FormSelect
            className="weq-saved-analysis-version"
            aria-label="报告结果版本"
            value={version}
            onChange={(event) => setVersion(Number(event.target.value))}
          >
            <option value={0}>最新结果 · 版本 {saved?.resultRevision}</option>
            {versions.data
              ?.filter((item) => item.resultRevision !== saved?.resultRevision)
              .map((item) => (
                <option key={item.resultRevision} value={item.resultRevision}>
                  版本 {item.resultRevision} · {analysisPeriod(item.request)} ·{' '}
                  {eventTimeFormatter.format(new Date(item.updatedAt))}
                </option>
              ))}
          </FormSelect>
        ) : null}
        {running && foreground && (
          <button
            type="button"
            className="weq-set-btn"
            disabled={busy}
            onClick={() =>
              void perform(async () => {
                await client.account.analysisReports.background.mutate(input);
                ownsRun.current = false;
                if (mounted.current) onClose();
              })
            }
          >
            <ListTodo size={16} aria-hidden />
            后台进行
          </button>
        )}
        {saved && (
          <button
            type="button"
            className="weq-set-iconbtn"
            disabled={busy}
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
              <RefreshCw size={16} aria-hidden />
            ) : (
              <Play size={16} />
            )}
          </button>
        )}
      </div>
      <p className="weq-analysis-period">
        {saved?.resultRevision ? '结果范围' : '分析范围'}：{analysisPeriod(displayedRequest)}
      </p>
      {saved?.resultRevision &&
      analysisPeriod(displayedRequest) !== analysisPeriod(saved.request) ? (
        <p className="weq-analysis-period">本次分析范围：{analysisPeriod(saved.request)}</p>
      ) : null}
      {error || query.error || historyError || saved?.error || positionError ? (
        <p role="alert">
          {error || query.error?.message || historyError?.message || saved?.error || positionError}
        </p>
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
