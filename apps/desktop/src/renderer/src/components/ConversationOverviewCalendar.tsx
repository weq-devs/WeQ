import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { replaceEqualDeep } from '@tanstack/react-query';
import { ListTodo, X } from 'lucide-react';
import {
  filterCalendarTargets,
  CALENDAR_SOURCE_ORDER,
  calendarTargetKey,
  type CalendarAnchor,
  type CalendarKind,
  type CalendarTarget,
  type ConversationCalendarJob,
  type CalendarControlAction,
} from '@weq/service/conversation-calendar';
import type { QQWriteBinding } from '../hooks/useQQWriteSession';
import { client } from '../trpc/client';
import { beijingDay } from '../lib/messageCalendar';
import { calendarTargetsWithHiddenMessages } from '../lib/calendarHiddenMessages';
import { calendarTargetSetKey } from '../lib/calendarSourceRevision';
import type { CalendarTaskOpening } from '../lib/calendarNavigation';
import { Modal } from './Dialog';
import { MessageCalendar } from './MessageCalendar';
import { CalendarStatistics } from './CalendarStatistics';
import { calendarReadLabel } from './CalendarStatistics.shared';
import { CalendarStatisticsProgress } from './CalendarStatisticsProgress';
import { SegmentedControl } from './SegmentedControl';
import { useTabActive } from './RetainedTabs.shared';
import '../styles/conversation-overview-calendar.css';
import { CONVERSATION_VIEW_LABELS, type ConversationView } from '../lib/conversationViews';

type Snapshot = ReturnType<ConversationCalendarJob['snapshot']>;
type Located = Awaited<ReturnType<typeof client.account.calendarOverview.locate.mutate>>;
const kindOptions = [
  { value: 'all', label: '当前视图全部' },
  { value: 'c2c', label: '私聊' },
  { value: 'group', label: '群聊' },
] as const;
type KindFilter = (typeof kindOptions)[number]['value'];
const calendarKinds: Record<KindFilter, CalendarKind[]> = {
  all: [...CALENDAR_SOURCE_ORDER],
  c2c: ['c2c'],
  group: ['group'],
};

export function ConversationOverviewCalendar({
  task,
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
  task?: CalendarTaskOpening;
  targets: CalendarTarget[];
  scope: ConversationView;
  query: string;
  ready: boolean;
  directoryError?: string;
  sourceRevision?: string;
  binding: QQWriteBinding | null;
  onClose: () => void;
  onLocate: (target: CalendarTarget, anchor: CalendarAnchor, record?: Located['record']) => void;
}) {
  const [month, setMonth] = useState(() => task?.month ?? beijingDay().slice(0, 7));
  const [day, setDay] = useState(() => task?.day ?? (task ? `${task.month}-01` : beijingDay()));
  const [kindFilter, setKindFilter] = useState<KindFilter>('all');
  const [rowLimit, setRowLimit] = useState(50);
  const [snapshot, setSnapshot] = useState<Snapshot>();
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [logOpen, setLogOpen] = useState(true);
  const [revision, setRevision] = useState(0);
  const [controlRevision, setControlRevision] = useState(0);
  const [dirty, setDirty] = useState(false);
  const [autoRefreshPending, setAutoRefreshPending] = useState(false);
  const [visible, setVisible] = useState(document.visibilityState === 'visible');
  const active = useTabActive();
  const today = beijingDay();
  const currentYear = Number(today.slice(0, 4));
  const yearOptions = useMemo(
    () => Array.from({ length: currentYear - 1968 }, (_, index) => String(1970 + index)),
    [currentYear],
  );
  const live = useRef(true);
  const backgroundIds = useRef(new Set<string>());
  const sentRefreshRevision = useRef(0);
  const canFilterKinds =
    !task && (scope === 'regular' || scope === 'all' || scope === 'hidden' || scope === 'deleted');
  const kinds = task?.kinds ?? calendarKinds[canFilterKinds ? kindFilter : 'all'];
  const latestKinds = useRef(kinds);
  latestKinds.current = kinds;
  const viewLabel =
    scope === 'regular' || scope === 'all'
      ? CONVERSATION_VIEW_LABELS[scope]
      : `${scope === 'assistant' ? '仅 ' : '仅'}${CONVERSATION_VIEW_LABELS[scope]}`;
  const scopeLabel = task ? (task.scopeLabel ?? '任务范围') : viewLabel;
  const latestScopeLabel = useRef(scopeLabel);
  latestScopeLabel.current = scopeLabel;
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
    () => task?.targets ?? filterCalendarTargets(targets, 'all', query),
    [task, targets, query],
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
    () => ({ month, selectionKey, binding, ready, active, visible, revision, task }),
    [month, selectionKey, binding, ready, active, visible, revision, task],
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
      !snapshot.hasPending &&
      snapshot.controls?.month.state !== 'paused' &&
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
      if (!task && event.key?.startsWith('chat-template.hiddenMessages.virtual:clone:'))
        setRevision((value) => value + 1);
    };
    document.addEventListener('visibilitychange', changed);
    window.addEventListener('storage', storageChanged);
    return () => {
      document.removeEventListener('visibilitychange', changed);
      window.removeEventListener('storage', storageChanged);
    };
  }, [task]);
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
      if (request.task?.month === month) {
        return client.account.calendarOverview.start.mutate({
          ...binding,
          taskId: request.task.taskId,
        });
      }
      const targets =
        request.task?.targets ??
        (await calendarTargetsWithHiddenMessages(
          latestTargets.current,
          localStorage,
          () => !cancelled && currentRequest.current === request,
        ));
      if (cancelled || currentRequest.current !== request) return undefined;
      const refresh = request.revision > sentRefreshRevision.current;
      sentRefreshRevision.current = request.revision;
      return client.account.calendarOverview.start.mutate({
        ...binding,
        month,
        targets,
        kinds: latestKinds.current,
        scopeLabel: latestScopeLabel.current,
        refresh,
        day: latestDay.current.startsWith(`${month}-`) ? latestDay.current : undefined,
      });
    };
    void start()
      .then((result) => {
        if (!result) return;
        task = result.id;
        if (result.background) backgroundIds.current.add(result.id);
        if (cancelled || currentRequest.current !== request) {
          if (!result.background)
            void client.account.calendarOverview.stop
              .mutate({ ...binding, id: task })
              .catch(() => {});
        } else {
          if (result.day) setDay(result.day);
          setJob({ id: task, request });
        }
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
          kinds,
        });
        if (cancelled || currentRequest.current !== request || latestKinds.current !== kinds)
          return;
        setSnapshot((previous) => replaceEqualDeep(previous, result));
        if (
          !result.cancelled &&
          result.controls?.month.state !== 'empty' &&
          (result.hasPending ||
            !result.days.every((value) => value.complete || value.errors.length) ||
            (day.startsWith(month) &&
              !result.complete &&
              !result.days.find((value) => value.day === day)?.errors.length))
        )
          timer = setTimeout(() => void poll(), 500);
      } catch (failure) {
        if (!cancelled && currentRequest.current === request && latestKinds.current === kinds)
          setError(failure instanceof Error ? failure.message : String(failure));
      }
    };
    void poll();
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [
    id,
    binding,
    day,
    rowLimit,
    month,
    visible,
    active,
    request,
    logOpen,
    controlRevision,
    kinds,
  ]);
  async function control(
    scope: 'month' | 'day',
    action: CalendarControlAction,
    selectedDay?: string,
  ) {
    if (!id || !binding || busy) return;
    setBusy(true);
    setError('');
    try {
      const result = await client.account.calendarOverview.control.mutate({
        ...binding,
        id,
        scope,
        action,
        day: selectedDay,
      });
      if (live.current && latestId.current === id) {
        setSnapshot((previous) => replaceEqualDeep(previous, result));
        setControlRevision((value) => value + 1);
      }
    } catch (failure) {
      if (live.current) setError(failure instanceof Error ? failure.message : String(failure));
    } finally {
      if (live.current) setBusy(false);
    }
  }
  const errors = [
    ...new Set(
      [directoryError, error, ...(snapshot?.days.flatMap((value) => value.errors) ?? [])].filter(
        Boolean,
      ),
    ),
  ];
  const status = useMemo(
    () =>
      Object.fromEntries(
        (snapshot?.days ?? []).map((value) => [
          value.day,
          {
            complete: value.complete && !directoryError,
            reason: value.emptyReason,
            paused: value.paused,
          },
        ]),
      ),
    [snapshot?.days, directoryError],
  );
  const pickDay = useCallback(
    (value: string) => {
      if (value === day) return;
      setAutoRefreshPending(false);
      setSnapshot((current) =>
        current ? { ...current, rows: [], totalRows: 0, complete: false } : current,
      );
      setDay(value);
      setRowLimit(50);
    },
    [day],
  );
  const changeMonth = useCallback((value: string) => {
    setSnapshot(undefined);
    setMonth(value);
    setDay(`${value}-01`);
    setRowLimit(50);
  }, []);
  function changeKindFilter(value: KindFilter) {
    if (value === kindFilter) return;
    latestKinds.current = calendarKinds[value];
    setKindFilter(value);
    setSnapshot(undefined);
    setRowLimit(50);
    setError('');
  }
  const loadedRows = snapshot?.rows.length ?? 0;
  const totalRows = snapshot?.totalRows ?? 0;
  const loadMore = useCallback(() => {
    setRowLimit((limit) => (loadedRows >= limit ? Math.min(limit + 50, totalRows) : limit));
  }, [loadedRows, totalRows]);
  const locate = useCallback(
    async (target: CalendarTarget, anchor: CalendarAnchor) => {
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
    },
    [id, binding, busy, onLocate, onClose, selectedByKey],
  );
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
  const dayError = day > today ? '未来日期不统计' : !ready ? '正在读取会话目录…' : directoryError;
  return (
    <Modal
      onClose={onClose}
      width={820}
      className="weq-overview-calendar-modal"
      labelledBy="conversation-overview-calendar-title"
    >
      <div className="weq-overview-calendar" data-conversation-view={scope}>
        <header>
          <h3 id="conversation-overview-calendar-title">会话日历（{scopeLabel}）</h3>
          <button
            type="button"
            className="weq-set-btn weq-set-btn-soft"
            title="将当月统计加入任务列表，在后台继续"
            disabled={
              !id ||
              !snapshot ||
              busy ||
              snapshot.cancelled ||
              snapshot.controls?.month.state === 'empty'
            }
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
          <div className="weq-overview-calendar-left">
            {canFilterKinds ? (
              <SegmentedControl
                label="会话类型"
                options={kindOptions}
                value={kindFilter}
                onChange={changeKindFilter}
                disabled={busy}
              />
            ) : null}
            <MessageCalendar
              maxDay={today}
              fixedWeekCount={false}
              month={month}
              onMonthChange={changeMonth}
              yearOptions={yearOptions}
              days={snapshot?.days}
              dayStatus={status}
              start={day}
              allowEmpty
              onPick={pickDay}
              loading={!ready || !snapshot}
              statusText=""
            />
            <CalendarStatisticsProgress
              snapshot={snapshot}
              busy={busy}
              statusText={
                month > today.slice(0, 7)
                  ? '未来日期不统计'
                  : !snapshot
                    ? '正在读取消息数量…'
                    : errors.length
                      ? '部分日期统计未完成'
                      : (calendarReadLabel(snapshot) ?? (dirty ? '数据有变更' : undefined))
              }
              logOpen={logOpen}
              onLogOpenChange={setLogOpen}
              onControl={(scope, action, day) => void control(scope, action, day)}
            />
          </div>
          <CalendarStatistics
            snapshot={snapshot}
            day={day}
            id={id}
            busy={busy}
            error={dayError}
            targets={selectedByKey}
            onLocate={locate}
            onLoadMore={loadMore}
          />
        </div>
        <div className="weq-overview-calendar-errors">
          {[
            ...new Set(
              [directoryError, error].filter((message) => message && message !== dayError),
            ),
          ].map((message) => (
            <p role="alert" key={message}>
              {message}
            </p>
          ))}
        </div>
      </div>
    </Modal>
  );
}
