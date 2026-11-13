import {
  CALENDAR_SOURCE_ORDER,
  CALENDAR_SOURCE_LABELS,
  type CalendarTarget,
  type CalendarAnchor,
  type ConversationCalendarJob,
  type CalendarControlAction,
} from '@weq/service/conversation-calendar';
import { useCalendarKinds } from '../hooks/useCalendarKinds';
import { useMultiSelection } from '../hooks/useMultiSelection';
import {
  Bot,
  Layers,
  MessagesSquare,
  MonitorSmartphone,
  Newspaper,
  UserRound,
  UsersRound,
  Sparkles,
} from 'lucide-react';
import type { CalendarKind } from '@weq/service/conversation-calendar';
import '../styles/search-scope.css';
import { beijingDay } from '../lib/messageCalendar';
import { CalendarScanProgress } from './CalendarScanProgress';
import { CalendarConversationList } from './CalendarConversationList';
import { TaskLogDisclosure } from './TaskLogDisclosure';

export type CalendarSnapshot = ReturnType<ConversationCalendarJob['snapshot']>;
const contentOptions = [
  { id: 'c2c', label: '私聊', kinds: ['c2c'], Icon: UserRound },
  { id: 'group', label: '群聊', kinds: ['group'], Icon: UsersRound },
  { id: 'devices', label: '我的设备', kinds: ['dataline'], Icon: MonitorSmartphone },
  { id: 'feeds', label: '公众号/服务号', kinds: ['official', 'service'], Icon: Newspaper },
  { id: 'guild', label: '频道私聊', kinds: ['guild'], Icon: MessagesSquare },
  { id: 'clones', label: '克隆会话', kinds: ['persona', 'cloneGroup'], Icon: Bot },
  { id: 'assistant', label: 'WeQ 助手会话', kinds: ['assistant'], Icon: Sparkles },
] satisfies Array<{ id: string; label: string; kinds: CalendarKind[]; Icon: typeof Bot }>;
const contentIds = contentOptions.map((option) => option.id);
export function calendarReadLabel(snapshot?: CalendarSnapshot): string | undefined {
  if (!snapshot) return '正在读取统计进度…';
  if (snapshot.emptyReason) return snapshot.emptyReason;
  if (snapshot.cancelled) return '统计已暂停';
  if (snapshot.enabledKinds && !snapshot.enabledKinds.length) return '未选择统计内容';
  const state = snapshot.readState?.state;
  if (state === 'idle') return '正在为其他数据库读取让路…';
  if (state === 'queued') return '等待前序数据库查询结束…';
  if (state === 'reading') return '正在读取数据库…';
  if (!snapshot.activeScan && snapshot.controls?.day.state === 'paused') return '该日统计已暂停';
  if (!snapshot.activeScan && snapshot.controls?.month.state === 'paused') return '当月统计已暂停';
  if (snapshot.refreshing) return '正在重新获取统计…';
  if (!snapshot.days.every((value) => value.complete)) return '正在统计消息数量…';
  return undefined;
}
export function CalendarStatistics({
  snapshot,
  day,
  id,
  targets,
  busy,
  error,
  logOpen,
  onLogOpenChange,
  onLocate,
  onLoadMore,
  month,
  onDayChange,
  onControl,
  locateDisabled = false,
}: {
  snapshot?: CalendarSnapshot;
  day: string;
  id?: string;
  targets: Map<string, CalendarTarget>;
  busy: boolean;
  error?: string;
  logOpen: boolean;
  onLogOpenChange: (open: boolean) => void;
  onLocate: (target: CalendarTarget, anchor: CalendarAnchor) => void;
  onLoadMore: () => void;
  month?: string;
  onDayChange?: (day: string) => void;
  onControl?: (scope: 'month' | 'day', action: CalendarControlAction, day?: string) => void;
  locateDisabled?: boolean;
}) {
  const [kinds, setKinds] = useCalendarKinds();
  const allSelected = CALENDAR_SOURCE_ORDER.every((kind) => kinds.includes(kind));
  const selection = useMultiSelection({
    escapeClearsSelection: false,
    ids: contentIds,
    selected: new Set(
      contentOptions
        .filter((option) => option.kinds.every((kind) => kinds.includes(kind)))
        .map((option) => option.id),
    ),
    onChange: (selected) =>
      setKinds(
        contentOptions
          .filter((option) => selected.has(option.id))
          .flatMap((option) => option.kinds),
      ),
  });
  return (
    <section className="weq-overview-calendar-conversations" aria-label="当天会话">
      <h4>统计进度</h4>
      <div
        className="weq-search-scope weq-calendar-kinds"
        role="group"
        aria-label="统计内容"
        {...selection.rootProps}
      >
        <button
          type="button"
          aria-label="全部统计内容"
          aria-pressed={allSelected ? true : kinds.length ? 'mixed' : false}
          onClick={() => setKinds(allSelected ? [] : [...CALENDAR_SOURCE_ORDER])}
        >
          <Layers size={14} aria-hidden />
          全部
        </button>
        {contentOptions.map((option) => (
          <button
            key={option.id}
            type="button"
            aria-pressed={option.kinds.every((kind) => kinds.includes(kind))}
            {...selection.itemProps(option.id)}
          >
            <option.Icon size={14} aria-hidden />
            {option.label}
          </button>
        ))}
      </div>
      <CalendarScanProgress
        day={snapshot?.scanDayProgress?.day ?? snapshot?.activeScan?.day ?? day}
        progress={snapshot?.progress}
        controls={snapshot?.controls}
        busy={busy}
        onControl={onControl}
        dayProgress={
          snapshot?.scanDayProgress ??
          (snapshot?.activeScan && snapshot.activeScan.day !== day
            ? undefined
            : snapshot?.dayProgress)
        }
      />
      <p role="status">
        {error ??
          calendarReadLabel(snapshot) ??
          (snapshot?.complete ? `${snapshot.totalRows} 个会话` : '正在统计当天会话…')}
      </p>
      {snapshot?.activeScan ? (
        <p>
          {snapshot.activeScan.day} · {CALENDAR_SOURCE_LABELS[snapshot.activeScan.kind]}
          {snapshot.activeScan.progress
            ? ` · ${snapshot.activeScan.progress.phase} · 已处理 ${snapshot.activeScan.progress.processed.toLocaleString('zh-CN')} ${snapshot.activeScan.progress.unit}`
            : ''}
        </p>
      ) : null}
      <TaskLogDisclosure
        open={logOpen}
        onOpenChange={onLogOpenChange}
        lines={snapshot?.logs ?? []}
      />
      {onDayChange && month ? (
        <label className="weq-calendar-task-date">
          列表日期
          <input
            type="date"
            aria-label="列表日期"
            value={day}
            min={`${month}-01`}
            max={
              snapshot?.days.at(-1)?.day && snapshot.days.at(-1)!.day < beijingDay()
                ? snapshot.days.at(-1)!.day
                : beijingDay()
            }
            onChange={(event) => {
              if (event.target.value) onDayChange(event.target.value);
            }}
          />
        </label>
      ) : (
        <h4 className="weq-calendar-list-date">{day}</h4>
      )}
      {snapshot?.dayProgress && !snapshot.emptyReason ? (
        <p>
          {snapshot.complete
            ? `${snapshot.totalRows} 个会话`
            : `已完成 ${snapshot.dayProgress.completedSources}/${snapshot.dayProgress.totalSources} 个来源`}{' '}
          · 已计 {snapshot.dayProgress.count.toLocaleString('zh-CN')} 条
          {snapshot.dayProgress.paused ? ' · 该日已暂停' : ''}
        </p>
      ) : null}
      <CalendarConversationList
        key={`${id}:${day}`}
        rows={snapshot?.rows ?? []}
        total={snapshot?.totalRows ?? 0}
        complete={Boolean(snapshot?.complete || snapshot?.emptyReason)}
        busy={busy || locateDisabled}
        showEmpty={!error && kinds.length > 0 && !snapshot?.emptyReason}
        targets={targets}
        onLocate={onLocate}
        onLoadMore={onLoadMore}
      />
      {[
        ...new Set(
          [
            snapshot?.persistenceError,
            ...(snapshot?.days.flatMap((item) => item.errors) ?? []),
          ].filter(Boolean),
        ),
      ].map((message) => (
        <p role="alert" key={message}>
          {message}
        </p>
      ))}
    </section>
  );
}
