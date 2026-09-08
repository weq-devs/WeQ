import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type PointerEvent as ReactPointerEvent,
  type ReactElement,
  type WheelEvent as ReactWheelEvent,
} from 'react';
import { ChevronLeft, ChevronRight } from 'lucide-react';
import type { SparkPageData, SparkWallDay } from '@weq/service';
import { isAllTimeYear } from '@weq/service/report-time';
import { PageFrame, type ReportPageProps } from '../pageFrame';
import { Odometer, usePrefersReducedMotion } from '../Odometer';

function fmt(n: number): string {
  return new Intl.NumberFormat('zh-CN').format(n);
}

/**
 * 私聊火花 —— 报告里唯一只统计私聊的一页。
 *
 * 版面沿用总览页的排印叙事：一句引子 → 一个巨数（「那天你和他聊了多少条」）
 * → GitHub 式绿墙（每天自己发出的私聊，历史以来口径可一年一年切）→ 底部一条
 * 发丝线数据带（开口天数 / 最长连续 / 最长火花）。整个页面不出现会话 uid 与
 * 数据库痕迹，只有人和日期。
 */
export function SparkPage({ page, data, active }: ReportPageProps<SparkPageData>): ReactElement {
  const top = data.topDay;
  const allTime = isAllTimeYear(data.year);
  const wallYears = data.wallYears;
  const defaultWallIndex = Math.max(0, wallYears.indexOf(data.wallYear));
  const [wallIndex, setWallIndex] = useState(defaultWallIndex);
  const reduce = usePrefersReducedMotion();
  /** 当年的滚动窗口（近 12 个月）—— 非滚动墙为 null。 */
  const wallWindow = data.wallWindow ?? null;
  const rollingActive = wallWindow != null && wallIndex === defaultWallIndex;

  useEffect(() => {
    if (!active) setWallIndex(defaultWallIndex);
  }, [active, defaultWallIndex]);

  const activeYear = wallYears[wallIndex] ?? data.wallYear;
  const wallDays = useMemo(
    () => (rollingActive ? data.wallDays : data.wallDays.filter((day) => day.year === activeYear)),
    [data.wallDays, activeYear, rollingActive],
  );

  const moveWall = (delta: 1 | -1): void => {
    setWallIndex((current) =>
      Math.max(0, Math.min(Math.max(0, wallYears.length - 1), current + delta)),
    );
  };

  return (
    <PageFrame page={page} active={active} ghost={allTime ? 'ALL' : data.year} tone="#2f8a5b">
      <div className="weq-sp">
        <header className="weq-sp-kicker weq-report-line" style={{ '--i': 1 } as CSSProperties}>
          <span>{allTime ? '历史以来' : `${data.year} 年`} · 全部私聊里最用力的一天</span>
          {top ? (
            <span className="weq-sp-kicker-date">
              {top.year} 年 {top.month} 月 {top.day} 日
            </span>
          ) : null}
        </header>

        {top ? (
          <section className="weq-sp-hero weq-report-line" style={{ '--i': 2 } as CSSProperties}>
            <p className="weq-sp-hero-say">
              你和 <em>{top.peerName}</em>
            </p>
            <div className="weq-sp-hero-row">
              <Odometer value={top.total} active={active} className="weq-sp-hero-num" />
              <span className="weq-sp-hero-unit">
                条<i>消息，聊了一整天</i>
              </span>
            </div>
            {top.words.length > 0 ? (
              <p className="weq-sp-wordline">
                <span className="weq-sp-wordline-prefix">那天你们说得最多的，是</span>
                <b className={`weq-sp-wordline-word${top.words[0]!.length > 8 ? ' is-long' : ''}`}>
                  {top.words[0]}
                </b>
              </p>
            ) : (
              <p className="weq-sp-wordline is-empty">那天的话，存在这条记录里了</p>
            )}
          </section>
        ) : null}

        <GitWall
          year={activeYear}
          days={wallDays}
          allTime={allTime}
          rollingWindow={rollingActive ? wallWindow : null}
          yearLabel={
            allTime
              ? wallYears.length > 1
                ? '历史以来 · 一年一墙'
                : '历史以来'
              : rollingActive
                ? `${wallWindow!.fromYear} 年 ${wallWindow!.fromMonth} 月 — ${wallWindow!.toYear} 年 ${wallWindow!.toMonth} 月`
                : undefined
          }
          onPrev={wallIndex > 0 ? () => moveWall(-1) : null}
          onNext={wallIndex < wallYears.length - 1 ? () => moveWall(1) : null}
          reduce={reduce}
        />

        <dl className="weq-sp-band weq-report-line" style={{ '--i': 4 } as CSSProperties}>
          <BandCell label="私聊发出" value={fmt(data.sentTotal)} unit="条" />
          <BandCell label="开口天数" value={fmt(data.activeDays)} unit="天" />
          <BandCell label="最长连续发言" value={fmt(data.longestSelfRun)} unit="天" />
          <BandCell
            label="最长火花"
            value={fmt(data.spark?.days ?? 0)}
            unit="天"
            note={data.spark?.peerName ?? '还没有双向的火花'}
          />
        </dl>
      </div>
    </PageFrame>
  );
}

function BandCell({
  label,
  value,
  unit,
  note,
}: {
  label: string;
  value: string;
  unit: string;
  note?: string;
}): ReactElement {
  return (
    <div className="weq-sp-band-cell">
      <dt>{label}</dt>
      <dd>
        <span className="weq-number">{value}</span>
        <i>{unit}</i>
      </dd>
      {note ? <p className="weq-sp-band-note">{note}</p> : null}
    </div>
  );
}

/**
 * GitHub 风格绿墙。一年是 53 × 7 的网格：列 = 周、行 = 周一..周日，
 * 颜色深浅 = 当天自己发出的私聊条数。
 */
function GitWall({
  year,
  days,
  allTime,
  rollingWindow,
  yearLabel,
  onPrev,
  onNext,
  reduce,
}: {
  year: number;
  days: SparkWallDay[];
  allTime: boolean;
  /** 滚动窗口（近 12 个月）；null = 完整自然年墙。 */
  rollingWindow: { fromYear: number; fromMonth: number; toYear: number; toMonth: number } | null;
  yearLabel?: string;
  onPrev: (() => void) | null;
  onNext: (() => void) | null;
  reduce: boolean;
}): ReactElement {
  const dragX = useRef<number | null>(null);

  const grid = useMemo(
    () => (rollingWindow ? buildRollingGrid(rollingWindow, days) : buildYearGrid(year, days)),
    [year, days, rollingWindow],
  );
  const maxCount = useMemo(
    () => grid.flat().reduce((max, cell) => Math.max(max, cell.count), 0),
    [grid],
  );

  function onWheel(event: ReactWheelEvent<HTMLDivElement>): void {
    // 横向滚轮切换年份；纵向仍然交给 deck 翻页。
    if (!allTime || Math.abs(event.deltaX) <= Math.abs(event.deltaY)) return;
    event.stopPropagation();
    if (event.deltaX > 0) onNext?.();
    else onPrev?.();
  }

  function onPointerDown(event: ReactPointerEvent<HTMLDivElement>): void {
    dragX.current = event.clientX;
  }

  function onPointerUp(event: ReactPointerEvent<HTMLDivElement>): void {
    const start = dragX.current;
    dragX.current = null;
    if (start == null || !allTime) return;
    const delta = event.clientX - start;
    if (Math.abs(delta) < 40) return;
    if (delta < 0) onNext?.();
    else onPrev?.();
  }

  const monthMarks = useMemo(() => buildMonthMarks(year, grid.length), [year, grid.length]);

  return (
    <section className="weq-sp-wall weq-report-line" style={{ '--i': 3 } as CSSProperties}>
      <div className="weq-sp-wall-head">
        <p className="weq-sp-wall-title">
          {allTime ? (yearLabel ?? `${year} 年`) : `${year} 年`}
          <span className="weq-sp-wall-sub">我发出的私聊</span>
        </p>
        {allTime && (onPrev || onNext) ? (
          // 历史以来的年份切换钮；滚动墙不参与切年。
          <div className="weq-sp-wall-nav" aria-label="切换绿墙年份">
            <button
              type="button"
              onClick={onPrev ?? undefined}
              disabled={!onPrev}
              aria-label="上一年"
            >
              <ChevronLeft size={14} aria-hidden />
            </button>
            <button
              type="button"
              onClick={onNext ?? undefined}
              disabled={!onNext}
              aria-label="下一年"
            >
              <ChevronRight size={14} aria-hidden />
            </button>
          </div>
        ) : null}
      </div>

      <div
        className="weq-sp-wall-cal"
        data-reduce={reduce ? 'yes' : 'no'}
        onWheel={onWheel}
        onPointerDown={onPointerDown}
        onPointerUp={onPointerUp}
      >
        <div className="weq-sp-wall-months" aria-hidden>
          {monthMarks.map((mark) => (
            <span key={mark.month} style={{ left: `${mark.left}%` }}>
              {mark.month}
            </span>
          ))}
        </div>
        <div className="weq-sp-wall-cols">
          {grid.map((week, weekIndex) => (
            // 列位置即稳定键：同一年 53 列不会增删，翻年整块重建。
            // biome-ignore lint/suspicious/noArrayIndexKey: 周列是固定序号，不会重排。
            <div className="weq-sp-wall-col" key={weekIndex} aria-hidden>
              {week.map((cell, dayIndex) => {
                const level =
                  cell.count === 0
                    ? 0
                    : Math.min(4, 1 + Math.ceil((cell.count / Math.max(1, maxCount)) * 3));
                return (
                  <span
                    // biome-ignore lint/suspicious/noArrayIndexKey: 一周七格位置即稳定键。
                    key={dayIndex}
                    className={`weq-sp-wall-cell is-${level}`}
                    data-tooltip={
                      cell.count > 0 ? `${cell.date} · ${cell.count} 条` : (cell.date ?? '')
                    }
                  />
                );
              })}
            </div>
          ))}
        </div>
        <div className="weq-sp-wall-legend">
          <span>少</span>
          {[0, 1, 2, 3, 4].map((level) => (
            <span key={level} className={`weq-sp-wall-cell is-${level}`} aria-hidden />
          ))}
          <span>多</span>
        </div>
      </div>
    </section>
  );
}

type GridCell = { month: number; day: number; count: number; date: string | null };

/**
 * 滚动窗口的网格：从 fromYear/fromMonth 到 toYear/toMonth，一周一列，
 * 与自然年墙同一套画法 —— 列 = 周、行 = 周一..周日。窗口不足整周时
 * 首尾用空格补齐。
 */
function buildRollingGrid(
  window: { fromYear: number; fromMonth: number; toYear: number; toMonth: number },
  days: SparkWallDay[],
): GridCell[][] {
  const countByDay = new Map<string, number>();
  for (const day of days) countByDay.set(`${day.year}-${day.month}-${day.day}`, day.count);

  const start = new Date(window.fromYear, window.fromMonth - 1, 1);
  const end = new Date(window.toYear, window.toMonth, 0); // 当月最后一天
  const totalDays = Math.round((end.getTime() - start.getTime()) / 86_400_000) + 1;
  const mondayOffset = (start.getDay() + 6) % 7;
  const weekCount = Math.ceil((mondayOffset + totalDays) / 7);

  const grid: GridCell[][] = [];
  for (let week = 0; week < weekCount; week++) {
    const column: GridCell[] = [];
    for (let dow = 0; dow < 7; dow++) {
      const dayOffset = week * 7 + dow - mondayOffset;
      if (dayOffset < 0 || dayOffset >= totalDays) {
        column.push({ month: 0, day: 0, count: 0, date: null });
      } else {
        const date = new Date(window.fromYear, window.fromMonth - 1, 1 + dayOffset);
        const y = date.getFullYear();
        const month = date.getMonth() + 1;
        const day = date.getDate();
        column.push({
          month,
          day,
          count: countByDay.get(`${y}-${month}-${day}`) ?? 0,
          date: `${month} 月 ${day} 日`,
        });
      }
    }
    grid.push(column);
  }
  return grid;
}

/** 一行 = 周一..周日 的一周；横向一周一列。 */
function buildYearGrid(year: number, days: SparkWallDay[]): GridCell[][] {
  const countByDay = new Map<string, number>();
  for (const day of days) {
    countByDay.set(`${day.month}-${day.day}`, day.count);
  }
  const start = new Date(year, 0, 1);
  const mondayOffset = (start.getDay() + 6) % 7;
  const leap = (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0;
  const totalDays = leap ? 366 : 365;
  const weekCount = Math.ceil((mondayOffset + totalDays) / 7);
  const grid: GridCell[][] = [];
  for (let week = 0; week < weekCount; week++) {
    const column: GridCell[] = [];
    for (let dow = 0; dow < 7; dow++) {
      const dayOfYear = week * 7 + dow - mondayOffset;
      if (dayOfYear < 0 || dayOfYear >= totalDays) {
        column.push({ month: 0, day: 0, count: 0, date: null });
      } else {
        const date = new Date(year, 0, 1 + dayOfYear);
        const month = date.getMonth() + 1;
        const day = date.getDate();
        column.push({
          month,
          day,
          count: countByDay.get(`${month}-${day}`) ?? 0,
          date: `${month} 月 ${day} 日`,
        });
      }
    }
    grid.push(column);
  }
  return grid;
}

/** 每个月的首月大致落在第几列，用来在墙顶标 1..12。 */
function buildMonthMarks(year: number, weekCount: number): Array<{ month: number; left: number }> {
  const start = new Date(year, 0, 1);
  const mondayOffset = (start.getDay() + 6) % 7;
  const marks: Array<{ month: number; left: number }> = [];
  for (let month = 1; month <= 12; month++) {
    const dayOfYear = Math.floor(
      (new Date(year, month - 1, 1).getTime() - start.getTime()) / 86_400_000,
    );
    const week = Math.floor((dayOfYear + mondayOffset) / 7);
    marks.push({ month, left: (week / Math.max(1, weekCount)) * 100 });
  }
  return marks;
}
