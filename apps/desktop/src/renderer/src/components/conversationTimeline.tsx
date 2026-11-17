/**
 * 私聊 / 群聊分析共用的「时间轴」组件。
 *
 * 三段：
 *   1. {@link GitHubTimeline} —— 所选区间的周柱状图（每周一根，随区间重排）；
 *   2. {@link RangeTimeline}  —— 消息曲线 + 可拖动的区间选择（默认最近一年）；
 *   3. {@link PersonWeekCard} —— 发言人卡片里的周 sparkline。
 *
 * 口径与后端 `analytics_weeks.ts` 一致：**周一是一周的第一天**，所有周序列都按
 * 北京时间对齐。这里只做展示与手势，不查库。
 */

import { NumericText } from './NumericText';
import {
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type PointerEvent as ReactPointerEvent,
  type ReactElement,
} from 'react';
import { formatNumber } from './analyticsCharts.shared';
import { EmptyState } from './EmptyState';
import { CalendarDays } from 'lucide-react';
import { beijingDay } from '../lib/messageCalendar';
import { ProfileAvatar } from './ProfileAvatar';
import { Avatar } from '../im-template/template/primitives';
import type { ProfileTarget } from '../lib/profileNavigation';
import {
  type WeeklyPoint,
  type RangeSelection,
  weeksInRange,
  parseDayKey,
  DAY_SECONDS,
  clamp,
  smoothLine,
  normalizeRange,
} from './conversationTimeline.shared';

export interface DailyPoint {
  /** `YYYY-MM-DD`（本地时区）。 */
  date: string;
  count: number;
}

function fmtDate(sec: number): string {
  if (!(sec > 0)) return '—';
  return beijingDay(new Date(sec * 1000)).replaceAll('-', '.');
}

/**
 * 顶部周柱状图：只画当前所选区间的周，一根柱子一周。
 *
 * 布局不是固定的「全历史一屏」：选中一年时大约 53 根，选中三个月时只有
 * 十几根。CSS Grid 的 `1fr` 让每根柱子随数量变宽/变窄；区间外的周不再
 * 「变淡保留」，而是直接从新布局里移除。
 */
export function GitHubTimeline({
  weeks,
  range,
}: {
  weeks: WeeklyPoint[];
  range: RangeSelection | null;
}): ReactElement {
  const shown = useMemo(() => weeksInRange(weeks, range), [weeks, range]);
  const max = useMemo(() => Math.max(1, ...shown.map((w) => w.count)), [shown]);

  if (shown.length === 0) {
    return <EmptyState variant="inline" icon={<CalendarDays />} title="暂无消息时间轴" />;
  }

  return (
    <div className="ca-github">
      <div
        className="ca-github-bars"
        data-count={shown.length}
        role="img"
        aria-label={`${shown[0]?.weekStart} 至 ${shown[shown.length - 1]?.weekStart} 每周消息数量`}
      >
        {shown.map((week, index) => {
          const level =
            week.count === 0 ? 0 : Math.min(4, 1 + Math.floor((week.count / max) * 3.999));
          return (
            <span
              // biome-ignore lint/suspicious/noArrayIndexKey: 周序列只按位置对齐，周键可能重复出现在损坏数据里
              key={`${week.weekStart}:${index}`}
              className="ca-github-bar"
              data-level={level}
              style={{ height: week.count === 0 ? 3 : `${18 + (week.count / max) * 82}%` }}
              title={`${week.weekStart} 起的一周 · ${formatNumber(week.count)} 条`}
            />
          );
        })}
      </div>
      <div className="ca-github-axis">
        <span>{shown[0]?.weekStart}</span>
        <span>{shown[shown.length - 1]?.weekStart}</span>
      </div>
    </div>
  );
}

/**
 * 消息曲线 + 拖拽选择。
 *
 * 手势：
 *   - 拖左右把手 → 改一端；
 *   - 拖选区中间 → 整体平移；
 *   - 在空白处横向拖 → 重新框选。
 * 只会把**松手后**的区间交给父组件（父组件据此重算统计）；拖动过程只动
 * 选区矩形，不会每帧扫一次库。
 */
export function RangeTimeline({
  weeks,
  daily,
  firstTime,
  lastTime,
  range,
  onChange,
}: {
  weeks: WeeklyPoint[];
  daily: DailyPoint[];
  firstTime: number | null;
  lastTime: number | null;
  range: RangeSelection | null;
  onChange: (range: RangeSelection) => void;
}): ReactElement {
  const [draft, setDraft] = useState<RangeSelection | null>(null);
  const draftRef = useRef<RangeSelection | null>(null);
  const dragRef = useRef<{
    mode: 'start' | 'end' | 'move' | 'new';
    startX: number;
    anchor: number;
    base: RangeSelection | null;
    /** 框选模式下是否已经真正拖动过；只点一下不该改变区间。 */
    moved: boolean;
  } | null>(null);
  const svgRef = useRef<SVGSVGElement | null>(null);

  const min = firstTime ?? parseDayKey(weeks[0]?.weekStart ?? '') ?? 0;
  const max =
    lastTime ??
    (weeks.length > 0 ? parseDayKey(weeks[weeks.length - 1]!.weekStart) + 6 * DAY_SECONDS : 0);
  const active = draft ?? range;
  const span = Math.max(1, max - min);

  // 曲线用「天」还是「周」：跨度太大时周点更干净；三个月以内用天，能看出起伏。
  const useDaily = daily.length > 0 && span <= 120 * DAY_SECONDS;
  const points = useMemo(() => {
    if (useDaily) {
      return daily
        .map((d) => ({ t: parseDayKey(d.date), v: d.count }))
        .filter((p) => p.t > 0)
        .sort((a, b) => a.t - b.t);
    }
    return weeks
      .map((w) => ({ t: parseDayKey(w.weekStart), v: w.count }))
      .filter((p) => p.t > 0)
      .sort((a, b) => a.t - b.t);
  }, [useDaily, daily, weeks]);

  const maxCount = Math.max(1, ...points.map((p) => p.v));
  const W = 720;
  const H = 96;
  const PAD = { left: 6, right: 6, top: 12, bottom: 18 };
  const x = (t: number): number =>
    PAD.left + ((clamp(t, min, max) - min) / span) * (W - PAD.left - PAD.right);
  const y = (v: number): number => PAD.top + (1 - v / maxCount) * (H - PAD.top - PAD.bottom);

  const line = smoothLine(points.map((p) => [x(p.t), y(p.v)] as const));
  const area =
    points.length > 0
      ? `${line} L${x(points[points.length - 1]!.t).toFixed(2)},${H - PAD.bottom} L${x(
          points[0]!.t,
        ).toFixed(2)},${H - PAD.bottom} Z`
      : '';

  const timeAtClientX = (clientX: number): number => {
    const rect = svgRef.current?.getBoundingClientRect();
    if (!rect || rect.width <= 0) return min;
    const ratio = clamp((clientX - rect.left) / rect.width, 0, 1);
    return Math.round(min + ratio * span);
  };

  const updateDraft = (next: RangeSelection): void => {
    draftRef.current = next;
    setDraft(next);
  };

  const commit = (next: RangeSelection | null): void => {
    draftRef.current = null;
    setDraft(null);
    if (next) onChange(normalizeRange(next.start, next.end, min, max));
  };

  const onPointerDown = (event: ReactPointerEvent<SVGSVGElement>): void => {
    if (!(max > min)) return;
    const target = event.target as Element;
    const mode = (target.getAttribute('data-handle') as 'start' | 'end' | null) ?? null;
    const onSelection = target.closest('[data-selection="yes"]') !== null;
    const t = timeAtClientX(event.clientX);
    if (mode) {
      dragRef.current = { mode, startX: event.clientX, anchor: t, base: active, moved: true };
    } else if (onSelection && active) {
      dragRef.current = {
        mode: 'move',
        startX: event.clientX,
        anchor: t,
        base: active,
        moved: true,
      };
    } else {
      // 先只记下起点；真的横向拖动超过阈值才进入框选，避免单击把区间改成一天。
      dragRef.current = { mode: 'new', startX: event.clientX, anchor: t, base: null, moved: false };
    }
    event.currentTarget.setPointerCapture(event.pointerId);
    event.preventDefault();
  };

  const onPointerMove = (event: ReactPointerEvent<SVGSVGElement>): void => {
    const drag = dragRef.current;
    if (!drag) return;
    if (drag.mode === 'new') {
      if (!drag.moved) {
        if (Math.abs(event.clientX - drag.startX) < 4) return;
        drag.moved = true;
      }
      updateDraft(normalizeRange(drag.anchor, timeAtClientX(event.clientX), min, max));
      return;
    }
    if (!drag.base) return;
    const delta = timeAtClientX(event.clientX) - drag.anchor;
    if (drag.mode === 'move') {
      const width = drag.base.end - drag.base.start;
      let start = drag.base.start + delta;
      start = clamp(start, min, max - width);
      updateDraft({ start, end: start + width });
    } else if (drag.mode === 'start') {
      updateDraft(normalizeRange(timeAtClientX(event.clientX), drag.base.end, min, max));
    } else {
      updateDraft(normalizeRange(drag.base.start, timeAtClientX(event.clientX), min, max));
    }
  };

  const endDrag = (event: ReactPointerEvent<SVGSVGElement>): void => {
    const drag = dragRef.current;
    if (!drag) return;
    // 只是点了一下：不提交，保持原区间。
    if (drag.mode === 'new' && !drag.moved) {
      dragRef.current = null;
      return;
    }
    const next = draftRef.current;
    dragRef.current = null;
    try {
      event.currentTarget.releasePointerCapture(event.pointerId);
    } catch {
      /* capture 可能已经丢了，不影响提交 */
    }
    commit(next);
  };

  if (points.length === 0) {
    return <EmptyState variant="inline" icon={<CalendarDays />} title="暂无消息时间轴" />;
  }

  const selLeft = active ? x(active.start) : 0;
  const selRight = active ? x(active.end) : 0;

  return (
    <div className="ca-range">
      <div className="ca-range-head">
        <div className="ca-range-labels">
          <strong>
            {active ? (
              <span className="weq-number weq-number-inherit">{fmtDate(active.start)}</span>
            ) : (
              '—'
            )}
          </strong>
          <span aria-hidden>→</span>
          <strong>
            {active ? (
              <span className="weq-number weq-number-inherit">{fmtDate(active.end)}</span>
            ) : (
              '—'
            )}
          </strong>
        </div>
        <span className="ca-range-hint">拖动把手或空白处选择区间 · 松手后重算</span>
      </div>
      <svg
        ref={svgRef}
        className="ca-range-svg"
        viewBox={`0 0 ${W} ${H}`}
        preserveAspectRatio="none"
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={endDrag}
        onPointerCancel={endDrag}
        role="img"
        aria-label="消息数量曲线，可拖动选择时间范围"
      >
        <defs>
          <linearGradient id="ca-range-fill" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor="var(--weq-accent-effective)" stopOpacity="0.28" />
            <stop offset="100%" stopColor="var(--weq-accent-effective)" stopOpacity="0.01" />
          </linearGradient>
        </defs>
        {active ? (
          <rect
            className="ca-range-selection-bg"
            x={selLeft}
            y={0}
            width={Math.max(0, selRight - selLeft)}
            height={H}
            data-selection="yes"
          />
        ) : null}
        <path className="ca-range-area" d={area} fill="url(#ca-range-fill)" />
        <path className="ca-range-line" d={line} />
        {active ? (
          <>
            <rect
              className="ca-range-selection-edge"
              data-selection="yes"
              x={selLeft}
              y={0}
              width={Math.max(0, selRight - selLeft)}
              height={H}
            />
            <rect
              className="ca-range-handle"
              data-handle="start"
              x={selLeft - 4}
              y={0}
              width={8}
              height={H}
            />
            <rect
              className="ca-range-handle"
              data-handle="end"
              x={selRight - 4}
              y={0}
              width={8}
              height={H}
            />
          </>
        ) : null}
        <line
          className="ca-range-baseline"
          x1={PAD.left}
          y1={H - PAD.bottom}
          x2={W - PAD.right}
          y2={H - PAD.bottom}
        />
      </svg>
      <div className="ca-range-axis">
        <span>
          <span className="weq-number weq-number-inherit">{fmtDate(min)}</span>
        </span>
        <span>
          <span className="weq-number weq-number-inherit">{fmtDate(max)}</span>
        </span>
      </div>
    </div>
  );
}

/** 发言人卡片里的周 sparkline（每根柱子一周，按卡片内最大值归一化）。 */
export function WeekSpark({ weekly, accent }: { weekly: number[]; accent?: string }): ReactElement {
  const max = Math.max(1, ...weekly);
  if (weekly.length === 0) return <span className="ca-spark is-empty" />;
  return (
    <span
      className="ca-spark"
      style={accent ? ({ '--ca-spark-accent': accent } as CSSProperties) : undefined}
      role="img"
      aria-label="每周发言量"
    >
      {weekly.map((count, index) => (
        <span
          // biome-ignore lint/suspicious/noArrayIndexKey: sparkline 只按周位置对齐
          key={index}
          className="ca-spark-bar"
          data-empty={count === 0 ? 'yes' : 'no'}
          style={{ height: count === 0 ? '6%' : `${12 + (count / max) * 88}%` }}
        />
      ))}
    </span>
  );
}

/** 一位发言人的卡片：头像 + 名字 + 条数 + 周 sparkline。 */
export function PersonWeekCard({
  name,
  avatarUrl,
  count,
  weekly,
  rank,
  accent,
  subtitle,
  profile,
}: {
  name: string;
  avatarUrl?: string | null;
  count: number;
  weekly: number[];
  rank?: number;
  accent?: string;
  subtitle?: string;
  profile?: ProfileTarget;
}): ReactElement {
  return (
    <div
      className="ca-person"
      style={accent ? ({ '--ca-person-accent': accent } as CSSProperties) : undefined}
    >
      <div className="ca-person-head">
        <ProfileAvatar target={profile} className="weq-identity-link">
          <span className="ca-person-avatar">
            <Avatar
              name={name}
              avatarUrl={avatarUrl}
              seed={profile?.identity || profile?.uin || name}
            />
          </span>
          <strong title={name}>{name}</strong>
        </ProfileAvatar>
        <span className="ca-person-meta">
          <em>
            <NumericText>{subtitle ?? `${formatNumber(count)} 条`}</NumericText>
          </em>
        </span>
        {rank !== undefined ? (
          <span className="ca-person-rank">
            <span className="weq-number weq-number-inherit">{rank}</span>
          </span>
        ) : null}
      </div>
      <WeekSpark weekly={weekly} accent={accent} />
      <span className="ca-person-count">
        <span className="weq-number weq-number-inherit">{formatNumber(count)}</span> 条
      </span>
    </div>
  );
}
export type { RangeSelection, WeeklyPoint } from './conversationTimeline.shared';
