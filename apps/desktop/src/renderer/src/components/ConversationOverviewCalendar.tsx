import { useEffect, useMemo, useRef, useState } from 'react';
import { ListTodo, X } from 'lucide-react';
import {
  filterCalendarTargets,
  calendarTargetKey,
  type CalendarAnchor,
  type CalendarTarget,
  type ConversationCalendarJob,
} from '@weq/service/conversation-calendar';
import type { QQWriteBinding } from '../hooks/useQQWriteSession';
import { client } from '../trpc/client';
import { beijingDay } from '../lib/messageCalendar';
import { calendarTargetsWithHiddenMessages } from '../lib/calendarHiddenMessages';
import { calendarTargetSetKey } from '../lib/calendarSourceRevision';
import { Modal } from './Dialog';
import { MessageCalendar } from './MessageCalendar';
import { CalendarScanProgress } from './CalendarScanProgress';
import { CalendarConversationList } from './CalendarConversationList';
import { TaskLogDisclosure } from './TaskLogDisclosure';
import { useTabActive } from './RetainedTabs';
import '../styles/conversation-overview-calendar.css';

type Snapshot = ReturnType<ConversationCalendarJob['snapshot']>;
type Located = Awaited<ReturnType<typeof client.account.calendarOverview.locate.mutate>>;
export function ConversationOverviewCalendar({
  targets,
  scope,
  query,
  ready,
  directoryError,
  sourceRevision,
  binding: providedBinding,
  onClose,
  onLocate,
}: {
  targets: CalendarTarget[];
  scope: 'all' | 'real' | 'virtual' | 'guild';
  query: string;
  ready: boolean;
  directoryError?: string;
  sourceRevision?: string;
  binding: QQWriteBinding | null;
  onClose: () => void;
  onLocate: (target: CalendarTarget, anchor: CalendarAnchor, record?: Located['record']) => void;
}) {
  const [month, setMonth] = useState(beijingDay().slice(0, 7));
  const [day, setDay] = useState(beijingDay());
  const [rowLimit, setRowLimit] = useState(50);
  const [snapshot, setSnapshot] = useState<Snapshot>();
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [logOpen, setLogOpen] = useState(false);
  const [revision, setRevision] = useState(0);
  const [dirty, setDirty] = useState(false);
  const [autoRefreshPending, setAutoRefreshPending] = useState(false);
  const [visible, setVisible] = useState(document.visibilityState === 'visible');
  const active = useTabActive();
  const live = useRef(true);
  const backgroundIds = useRef(new Set<string>());
  useEffect(() => {
    live.current = true;
    return () => {
      live.current = false;
    };
  }, []);
  const expectedAccountUin = providedBinding?.expectedAccountUin;
  const expectedAccountConfigId = providedBinding?.expectedAccountConfigId;
  const binding = useMemo(
    () =>
      expectedAccountUin && expectedAccountConfigId
        ? { expectedAccountUin, expectedAccountConfigId }
        : null,
    [expectedAccountUin, expectedAccountConfigId],
  );
  const selected = useMemo(
    () => filterCalendarTargets(targets, scope, query),
    [targets, scope, query],
  );
  const selectionKey = useMemo(() => calendarTargetSetKey(selected), [selected]);
  const selectedByKey = useMemo(
    () => new Map(selected.map((target) => [calendarTargetKey(target), target])),
    [selected],
  );
  const latestTargets = useRef(selected);
  latestTargets.current = selected;
  const latestDay = useRef(day);
  latestDay.current = day;
  const request = useMemo(
    () => ({ month, selectionKey, binding, ready, active, visible, revision }),
    [month, selectionKey, binding, ready, active, visible, revision],
  );
  const [job, setJob] = useState<{ id: string; request: typeof request }>();
  // 渲染切换时便停用旧句柄，不能等 effect 清空 ID 后才阻止旧月份轮询。
  const id = job?.request === request ? job.id : undefined;
  const currentRequest = useRef(request);
  currentRequest.current = request;
  const latestId = useRef(id);
  latestId.current = id;
  const completed = useRef(false);
  completed.current = Boolean(
    snapshot &&
      !snapshot.cancelled &&
      snapshot.days.every((value) => value.complete && !value.errors.length) &&
      snapshot.complete,
  );
  const observedSourceRevision = useRef(sourceRevision);
  useEffect(() => {
    const previous = observedSourceRevision.current;
    observedSourceRevision.current = sourceRevision;
    if (previous !== undefined && sourceRevision !== undefined && previous !== sourceRevision) {
      setDirty(true);
      // 只刷新已结束的快照；扫描期间的通知不能让大库不断从头重扫。
      if (completed.current) setAutoRefreshPending(true);
    }
  }, [sourceRevision]);
  useEffect(() => {
    if (!autoRefreshPending || !active || !visible) return;
    const timer = setTimeout(() => {
      setAutoRefreshPending(false);
      setDirty(false);
      setRevision((value) => value + 1);
    }, 5000);
    return () => clearTimeout(timer);
  }, [autoRefreshPending, active, visible]);
  useEffect(() => {
    const changed = () => setVisible(document.visibilityState === 'visible');
    const storageChanged = (event: StorageEvent) => {
      if (event.key?.startsWith('chat-template.hiddenMessages.virtual:clone:'))
        setRevision((value) => value + 1);
    };
    document.addEventListener('visibilitychange', changed);
    window.addEventListener('storage', storageChanged);
    return () => {
      document.removeEventListener('visibilitychange', changed);
      window.removeEventListener('storage', storageChanged);
    };
  }, []);
  useEffect(() => {
    const { month, binding, ready, active, visible } = request;
    setSnapshot(undefined);
    setRowLimit(50);
    setJob(undefined);
    setError('');
    setDirty(false);
    setAutoRefreshPending(false);
    if (!active || !visible || !ready || !binding) return;
    let cancelled = false;
    let task: string | undefined;
    const start = async () => {
      const targets = await calendarTargetsWithHiddenMessages(
        latestTargets.current,
        localStorage,
        () => !cancelled && currentRequest.current === request,
      );
      if (cancelled || currentRequest.current !== request) return undefined;
      return client.account.calendarOverview.start.mutate({
        ...binding,
        month,
        targets,
        day: latestDay.current.startsWith(`${month}-`) ? latestDay.current : undefined,
      });
    };
    void start()
      .then((result) => {
        if (!result) return;
        task = result.id;
        if (cancelled || currentRequest.current !== request)
          void client.account.calendarOverview.stop
            .mutate({ ...binding, id: task })
            .catch(() => {});
        else setJob({ id: task, request });
      })
      .catch((failure: unknown) => {
        if (!cancelled && currentRequest.current === request)
          setError(failure instanceof Error ? failure.message : String(failure));
      });
    return () => {
      cancelled = true;
      if (task && !backgroundIds.current.has(task))
        void client.account.calendarOverview.stop.mutate({ ...binding, id: task }).catch(() => {});
    };
  }, [request]);
  useEffect(() => {
    if (!id || !binding || !visible || !active) return;
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout>;
    const poll = async () => {
      try {
        const result = await client.account.calendarOverview.poll.query({
          ...binding,
          id,
          day: day.startsWith(month) ? day : undefined,
          limit: rowLimit,
          includeLogs: logOpen,
        });
        if (cancelled || currentRequest.current !== request) return;
        setSnapshot(result);
        if (
          !result.cancelled &&
          (!result.days.every((value) => value.complete || value.errors.length) ||
            (day.startsWith(month) &&
              !result.complete &&
              !result.days.find((value) => value.day === day)?.errors.length))
        )
          timer = setTimeout(() => void poll(), 500);
      } catch (failure) {
        if (!cancelled && currentRequest.current === request)
          setError(failure instanceof Error ? failure.message : String(failure));
      }
    };
    void poll();
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [id, binding, day, rowLimit, month, visible, active, request, logOpen]);
  const errors = [
    ...new Set(
      [directoryError, error, ...(snapshot?.days.flatMap((value) => value.errors) ?? [])].filter(
        Boolean,
      ),
    ),
  ];
  const status = Object.fromEntries(
    (snapshot?.days ?? []).map((value) => [
      value.day,
      { complete: value.complete && !directoryError },
    ]),
  );
  async function locate(target: CalendarTarget, anchor: CalendarAnchor) {
    if (!id || !binding || busy) return;
    setBusy(true);
    try {
      const result = await client.account.calendarOverview.locate.mutate({
        ...binding,
        id,
        target,
        anchor,
      });
      if (!live.current || latestId.current !== id) return;
      onLocate(
        selectedByKey.get(calendarTargetKey(result.target)) ?? result.target,
        result.anchor,
        result.record,
      );
      onClose();
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : String(failure));
    } finally {
      setBusy(false);
    }
  }
  async function background() {
    if (!id || !binding || busy) return;
    setBusy(true);
    backgroundIds.current.add(id);
    try {
      await client.account.calendarOverview.background.mutate({ ...binding, id });
      if (live.current && latestId.current === id) onClose();
    } catch (failure) {
      backgroundIds.current.delete(id);
      if (live.current && latestId.current === id)
        setError(failure instanceof Error ? failure.message : String(failure));
      else void client.account.calendarOverview.stop.mutate({ ...binding, id }).catch(() => {});
    } finally {
      if (live.current) setBusy(false);
    }
  }
  return (
    <Modal
      onClose={onClose}
      width={820}
      className="weq-overview-calendar-modal"
      labelledBy="conversation-overview-calendar-title"
    >
      <div className="weq-overview-calendar">
        <header>
          <h3 id="conversation-overview-calendar-title">会话日历</h3>
          <button
            type="button"
            className="weq-set-btn weq-set-btn-soft"
            title="将当月统计加入任务列表，在后台继续"
            disabled={!id || busy || Boolean(snapshot?.cancelled)}
            onClick={() => void background()}
          >
            <ListTodo size={16} />
            后台进行
          </button>
          <button
            type="button"
            className="weq-dialog-x"
            title="关闭"
            aria-label="关闭"
            onClick={onClose}
          >
            <X size={16} />
          </button>
        </header>
        <div className="weq-overview-calendar-body">
          <MessageCalendar
            month={month}
            onMonthChange={(value) => {
              setSnapshot(undefined);
              setMonth(value);
              setDay(`${value}-01`);
              setRowLimit(50);
            }}
            yearOptions={Array.from(
              { length: Number(beijingDay().slice(0, 4)) - 1968 },
              (_, index) => String(1970 + index),
            )}
            days={snapshot?.days}
            dayStatus={status}
            start={day}
            allowEmpty
            onPick={(value) => {
              setAutoRefreshPending(false);
              setSnapshot((current) =>
                current ? { ...current, rows: [], totalRows: 0, complete: false } : current,
              );
              setDay(value);
              setRowLimit(50);
            }}
            loading={!ready || !snapshot}
            statusText={
              !snapshot
                ? '正在读取消息数量…'
                : errors.length
                  ? '部分日期统计未完成'
                  : !snapshot.days.every((value) => value.complete)
                    ? snapshot.metrics.reads
                      ? '正在统计消息数量…'
                      : '等待数据库空闲…'
                    : dirty
                      ? '数据有变更'
                      : undefined
            }
          />
          <section className="weq-overview-calendar-conversations" aria-label="当天会话">
            <h4>{day}</h4>
            <CalendarScanProgress
              day={day}
              progress={snapshot?.progress}
              dayProgress={snapshot?.dayProgress}
            />
            <TaskLogDisclosure
              open={logOpen}
              onOpenChange={setLogOpen}
              lines={snapshot?.logs ?? []}
            />
            <p role="status">
              {!ready
                ? '正在读取会话目录…'
                : directoryError
                  ? '部分会话目录尚未读取完整'
                  : snapshot?.days.find((value) => value.day === day)?.errors.length
                    ? '部分来源统计已暂停'
                    : snapshot?.cancelled
                      ? '统计已暂停，请重新打开日历重试'
                      : !snapshot?.complete
                        ? snapshot?.dayProgress
                          ? `正在统计 · 已完成 ${snapshot.dayProgress.completedSources}/${snapshot.dayProgress.totalSources} 个来源 · 已计 ${snapshot.dayProgress.count.toLocaleString('zh-CN')} 条`
                          : '正在统计当天会话…'
                        : `${snapshot.totalRows} 个会话`}
            </p>
            <CalendarConversationList
              key={`${id}:${day}`}
              rows={snapshot?.rows ?? []}
              total={snapshot?.totalRows ?? 0}
              complete={Boolean(snapshot?.complete)}
              busy={busy}
              showEmpty={!directoryError}
              targets={selectedByKey}
              onLocate={(target, anchor) => void locate(target, anchor)}
              onLoadMore={() =>
                setRowLimit((limit) =>
                  snapshot && snapshot.rows.length >= limit
                    ? Math.min(limit + 50, snapshot.totalRows)
                    : limit,
                )
              }
            />
          </section>
        </div>
        <div className="weq-overview-calendar-errors">
          {errors.map((message) => (
            <p role="alert" key={message}>
              {message}
            </p>
          ))}
        </div>
      </div>
    </Modal>
  );
}
