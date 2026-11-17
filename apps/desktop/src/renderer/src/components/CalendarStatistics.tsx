import { NumericText } from './NumericText';
import {
  CALENDAR_SOURCE_ORDER,
  type CalendarTarget,
  type CalendarAnchor,
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
import { CalendarConversationList } from './CalendarConversationList';
import type { CalendarSnapshot } from './CalendarStatistics.shared';

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
function CalendarKindSelection() {
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
  );
}
export function CalendarStatistics({
  snapshot,
  day,
  id,
  targets,
  busy,
  error,
  onLocate,
  onLoadMore,
  month,
  onDayChange,
  locateDisabled = false,
  showKindSelection = true,
}: {
  snapshot?: CalendarSnapshot;
  day: string;
  id?: string;
  targets: Map<string, CalendarTarget>;
  busy: boolean;
  error?: string;
  onLocate: (target: CalendarTarget, anchor: CalendarAnchor) => void;
  onLoadMore: () => void;
  month?: string;
  onDayChange?: (day: string) => void;
  locateDisabled?: boolean;
  showKindSelection?: boolean;
}) {
  return (
    <section className="weq-overview-calendar-conversations" aria-label="当天会话">
      {showKindSelection ? <CalendarKindSelection /> : null}
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
      <p role="status">
        {error ??
          snapshot?.emptyReason ??
          (snapshot?.dayProgress ? (
            <>
              <NumericText>{`${snapshot.totalRows}${snapshot.complete ? '' : '+'} 个会话`}</NumericText>{' '}
              · 已计{' '}
              <span className="weq-number weq-number-inherit">
                {snapshot.dayProgress.count.toLocaleString('zh-CN')}
              </span>{' '}
              条{snapshot.dayProgress.paused ? ' · 该日已暂停' : ''}
            </>
          ) : snapshot?.complete ? (
            <NumericText>{`${snapshot.totalRows} 个会话`}</NumericText>
          ) : (
            '正在统计当天会话…'
          ))}
      </p>
      <CalendarConversationList
        key={`${id}:${day}`}
        rows={snapshot?.rows ?? []}
        total={snapshot?.totalRows ?? 0}
        complete={Boolean(snapshot?.complete || snapshot?.emptyReason)}
        busy={busy || locateDisabled}
        showEmpty={!error && snapshot?.enabledKinds?.length !== 0 && !snapshot?.emptyReason}
        targets={targets}
        onLocate={onLocate}
        onLoadMore={onLoadMore}
      />
    </section>
  );
}
export type { CalendarSnapshot } from './CalendarStatistics.shared';
