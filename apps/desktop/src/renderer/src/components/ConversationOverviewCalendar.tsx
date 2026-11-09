import { useEffect, useMemo, useRef, useState } from 'react';
import { ChevronLeft, ChevronRight, RefreshCw, X } from 'lucide-react';
import {
  CALENDAR_SOURCE_LABELS,
  filterCalendarTargets,
  type CalendarAnchor,
  type CalendarTarget,
  type ConversationCalendarJob,
} from '@weq/service/conversation-calendar';
import type { QQWriteBinding } from '../hooks/useQQWriteSession';
import { client } from '../trpc/client';
import { beijingDay } from '../lib/messageCalendar';
import { calendarTargetsWithHiddenMessages } from '../lib/calendarHiddenMessages';
import { Modal } from './Dialog';
import { MessageCalendar } from './MessageCalendar';
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
  const [offset, setOffset] = useState(0);
  const [id, setId] = useState<string>();
  const [snapshot, setSnapshot] = useState<Snapshot>();
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [revision, setRevision] = useState(0);
  const [dirty, setDirty] = useState(false);
  const [visible, setVisible] = useState(document.visibilityState === 'visible');
  const active = useTabActive();
  const live = useRef(true);
  const latestId = useRef(id);
  latestId.current = id;
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
  const selectionKey = useMemo(() => JSON.stringify(selected), [selected]);
  useEffect(() => {
    if (sourceRevision !== undefined) setDirty(true);
  }, [sourceRevision]);
  const fullyCounted = snapshot?.days.every((value) => value.complete) && snapshot.complete;
  useEffect(() => {
    if (!dirty || !fullyCounted || !active || !visible) return;
    const timer = setTimeout(() => {
      setDirty(false);
      setRevision((value) => value + 1);
    }, 5000);
    return () => clearTimeout(timer);
  }, [dirty, fullyCounted, active, visible]);
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
    setSnapshot(undefined);
    setId(undefined);
    setError('');
    setDirty(false);
    if (!active || !visible || !ready || !binding) return;
    let cancelled = false;
    let task: string | undefined;
    const start = async () => {
      const targets = await calendarTargetsWithHiddenMessages(
        JSON.parse(selectionKey) as CalendarTarget[],
        localStorage,
        () => !cancelled,
      );
      if (cancelled) return undefined;
      return client.account.calendarOverview.start.mutate({ ...binding, month, targets });
    };
    void start()
      .then((result) => {
        if (!result) return;
        task = result.id;
        if (cancelled)
          void client.account.calendarOverview.stop
            .mutate({ ...binding, id: task })
            .catch(() => {});
        else setId(task);
      })
      .catch((failure: unknown) => {
        if (!cancelled) setError(failure instanceof Error ? failure.message : String(failure));
      });
    return () => {
      cancelled = true;
      if (task)
        void client.account.calendarOverview.stop.mutate({ ...binding, id: task }).catch(() => {});
    };
  }, [month, selectionKey, binding, ready, active, visible, revision]);
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
          offset,
        });
        if (cancelled) return;
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
        if (!cancelled) setError(failure instanceof Error ? failure.message : String(failure));
      }
    };
    void poll();
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [id, binding, day, offset, month, visible, active]);
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
      { complete: value.complete && !directoryError && !dirty },
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
      onLocate(result.target, result.anchor, result.record);
      onClose();
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : String(failure));
    } finally {
      setBusy(false);
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
            className="icon-button"
            title="重新统计"
            aria-label="重新统计"
            onClick={() => setRevision((value) => value + 1)}
          >
            <RefreshCw size={16} />
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
              setOffset(0);
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
              setSnapshot((current) =>
                current ? { ...current, rows: [], totalRows: 0, complete: false } : current,
              );
              setDay(value);
              setOffset(0);
            }}
            loading={!ready || !snapshot}
          />
          <section className="weq-overview-calendar-conversations" aria-label="当天会话">
            <h4>{day}</h4>
            <p role="status">
              {!ready
                ? '正在读取会话目录…'
                : directoryError
                  ? '部分会话目录尚未读取完整'
                  : snapshot?.days.find((value) => value.day === day)?.errors.length
                    ? '部分来源统计已暂停'
                    : snapshot?.cancelled
                      ? '统计已暂停，请点击刷新重试'
                      : !snapshot?.complete
                        ? '正在统计当天会话…'
                        : `${snapshot.totalRows} 个会话`}
            </p>
            <div className="weq-overview-calendar-rows" aria-busy={!snapshot?.complete}>
              {snapshot?.rows.map((row) => (
                <button
                  key={`${row.target.kind}:${row.target.conv}`}
                  type="button"
                  className="weq-overview-calendar-row"
                  disabled={busy}
                  onClick={() => void locate(row.target, row.anchor)}
                >
                  {row.target.avatar ? (
                    <img src={row.target.avatar} alt="" />
                  ) : (
                    <span className="weq-overview-calendar-avatar" aria-hidden>
                      {Array.from(row.target.name)[0]}
                    </span>
                  )}
                  <span className="weq-overview-calendar-name">
                    <strong title={row.target.name}>{row.target.name}</strong>
                    <small>{CALENDAR_SOURCE_LABELS[row.target.kind]}</small>
                  </span>
                  <span title={`${row.count.toLocaleString('zh-CN')} 条`}>
                    {row.count.toLocaleString('zh-CN')}
                    {snapshot.complete ? '' : '+'}
                  </span>
                </button>
              ))}
              {!directoryError && snapshot?.complete && !snapshot.rows.length ? (
                <p>当天没有消息</p>
              ) : null}
            </div>
            <nav aria-label="会话分页">
              <button
                type="button"
                className="icon-button"
                title="上一页"
                aria-label="上一页"
                disabled={offset === 0}
                onClick={() => setOffset((value) => Math.max(0, value - 50))}
              >
                <ChevronLeft size={16} />
              </button>
              <span>{Math.floor(offset / 50) + 1}</span>
              <button
                type="button"
                className="icon-button"
                title="下一页"
                aria-label="下一页"
                disabled={!snapshot || offset + 50 >= snapshot.totalRows}
                onClick={() => setOffset((value) => value + 50)}
              >
                <ChevronRight size={16} />
              </button>
            </nav>
          </section>
        </div>
        <div className="weq-overview-calendar-errors">
          {dirty ? <p role="status">记录有更新，统计完成后将重新校准</p> : null}
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
