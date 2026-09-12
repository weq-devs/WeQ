import { useEffect, useMemo, useState, type CSSProperties, type ReactElement } from 'react';
import type { RhythmPageData, RhythmWindow, RhythmWindowKind } from '@weq/service';
import { isAllTimeYear, reportEraLabel } from '@weq/service/report-time';
import { PageFrame, type ReportPageProps } from '../pageFrame';

function fmt(n: number): string {
  return new Intl.NumberFormat('zh-CN').format(n);
}

const HOUR_LABEL = (hour: number): string => `${String(hour).padStart(2, '0')}:00`;

/** 一周从周一开始排，数据行序是 `getDay()`（0 = 周日）。 */
const WEEKDAY_ROWS = [1, 2, 3, 4, 5, 6, 0] as const;
const WEEKDAY_NAMES: Record<number, string> = {
  0: '日',
  1: '一',
  2: '二',
  3: '三',
  4: '四',
  5: '五',
  6: '六',
};

/**
 * 我的作息 —— 一页只回答一个问题：你的消息更常在哪一段醒来。
 *
 * 主角不是曲线也不是绿墙，而是按时段强度归纳出来的那枚人设词
 * （夜猫子 / 早八人 / 美国作息…）。它占住左半边，右半边才是证据：
 * 上面一条平滑的 24 小时“心率”，下面是同一根时间轴的 7×24 周墙。
 * 两件图共享一天这条坐标，读起来是一件事，不是两张仪表盘。
 */
export function RhythmPage({ page, data, active }: ReportPageProps<RhythmPageData>): ReactElement {
  const allTime = isAllTimeYear(data.year);
  const [drawn, setDrawn] = useState(false);

  useEffect(() => {
    if (!active) {
      setDrawn(false);
      return undefined;
    }
    const timer = window.setTimeout(() => setDrawn(true), 480);
    return () => window.clearTimeout(timer);
  }, [active]);

  const main = useMemo(
    () => data.windows.find((window) => window.kind === data.label.kind) ?? null,
    [data.label.kind, data.windows],
  );
  const mainPct = main ? Math.round(main.share * 100) : 0;
  const mood = useMemo(() => moodFor(data, main, mainPct), [data, main, mainPct]);

  return (
    <PageFrame page={page} active={active} ghost="24h" ghostPlacement="bottom-right">
      <div className="weq-rh" data-kind={data.label.kind}>
        <header className="weq-rh-kicker weq-report-line" style={{ '--i': 1 } as CSSProperties}>
          <span>{reportEraLabel(data.year)} · 我的作息</span>
          <span className="weq-rh-kicker-meta">
            <b className="weq-number">{fmt(data.sentTotal)}</b> 条发言
            <i aria-hidden>/</i>
            一天<b className="weq-number">{data.activeHours}</b> 个小时在线
          </span>
        </header>

        <section className="weq-rh-stage">
          {/* 左：人设巨字，整页唯一的视觉主角 */}
          <div className="weq-rh-hero weq-report-line" style={{ '--i': 2 } as CSSProperties}>
            <p className="weq-rh-lede">
              {allTime ? '有记录以来' : `${data.year} 年`}，你的话有它自己的时区——
            </p>
            <h2 className={`weq-rh-word${data.label.word.length >= 4 ? ' is-long' : ''}`}>
              {data.label.word}
            </h2>
            <p className="weq-rh-badge">
              <span className="weq-rh-en">{data.label.english}</span>
              <span className="weq-rh-span">{data.label.span}</span>
              {main ? <span className="weq-rh-share">{mainPct}%</span> : null}
            </p>
            <p className="weq-rh-mood">{mood}</p>
          </div>

          {/* 右：一天的心率 + 一周的绿墙，共用 24 小时这根轴 */}
          <div className="weq-rh-evidence weq-report-line" style={{ '--i': 3 } as CSSProperties}>
            <Pulse
              hourly={data.hourly}
              peakHour={data.peakHour}
              peakCount={data.peakCount}
              activeHours={data.activeHours}
              drawn={drawn}
            />
            <WeekWall matrix={data.weekdayHourly} mainKind={data.label.kind} drawn={drawn} />
          </div>
        </section>
      </div>
    </PageFrame>
  );
}

/** 每个时段的煽情句 —— 巨字负责“是什么”，这句负责“为什么值得被记住”。 */
function moodFor(data: RhythmPageData, main: RhythmWindow | null, mainPct: number): string {
  const peak = `${String(data.peakHour).padStart(2, '0')}:00`;
  if (main?.kind === 'night') {
    return `深夜 ${data.label.span.replace('–', '到')} 的发言占全天的 ${mainPct}%。别人按下晚安，你的话才刚说到一半；最醒着的那一小时，是 ${peak}。`;
  }
  if (main?.kind === 'us') {
    return `凌晨 ${data.label.span.replace('–', '到')} 占了全天的 ${mainPct}%：那时你还在线，像隔着十二个小时时差，给还没睡的人留了一句言。`;
  }
  if (main?.kind === 'early') {
    return `上午 ${data.label.span.replace('–', '到')} 就贡献了全天的 ${mainPct}%：天亮不久，你的消息已经把一天叫醒了，${peak} 是最忙的那一小时。`;
  }
  if (main?.kind === 'afternoon') {
    return `午后 ${data.label.span.replace('–', '到')} 的 ${mainPct}% 发言是每天的续航：困意压不住话匣子，${peak} 前后的对话框最热闹。`;
  }
  if (main?.kind === 'dusk') {
    return `黄昏 ${data.label.span.replace('–', '到')} 的发言占全天的 ${mainPct}%：下班、放学、吃完饭，所有人都上线了，${peak} 是这一天的社交高光。`;
  }
  return `你的一天没有固定的分时区，${data.activeHours}/24 个小时都可能说话；出现得最勤的是 ${peak}，但你的「收到」从来不挑时间。`;
}

/** 平滑 24 小时曲线。刻意不画坐标轴——它是一条心率，不是一个图表。 */
function Pulse({
  hourly,
  peakHour,
  peakCount,
  activeHours,
  drawn,
}: {
  hourly: number[];
  peakHour: number;
  peakCount: number;
  activeHours: number;
  drawn: boolean;
}): ReactElement {
  const W = 448;
  const H = 118;
  const TOP = 12;
  const BOTTOM = 10;
  const max = Math.max(1, ...hourly);

  const { line, area, peak } = useMemo(() => {
    const xs = (hour: number): number => (hour / 23) * W;
    const ys = (count: number): number => H - BOTTOM - (count / max) * (H - TOP - BOTTOM);
    const points = hourly.map((count, hour) => [xs(hour), ys(count)] as const);
    const smooth = smoothLine(points);
    const baselineY = H - BOTTOM;
    return {
      line: `M ${smooth}`,
      area: `M 0 ${baselineY} L 0 ${ys(hourly[0] ?? 0)} ${smooth} L ${W} ${baselineY} Z`,
      peak: { x: xs(peakHour), y: ys(hourly[peakHour] ?? 0) },
    };
  }, [H, W, hourly, max, peakHour]);

  return (
    <div className="weq-rh-pulse" data-drawn={drawn ? 'yes' : 'no'}>
      <div className="weq-rh-evidence-head">
        <p className="weq-rh-evidence-name">一天的心率</p>
        <p className="weq-rh-evidence-note">
          <b className="weq-number">{String(peakHour).padStart(2, '0')}:00</b> · {fmt(peakCount)}{' '}
          条，{activeHours}/24 小时有人说话
        </p>
      </div>
      <svg
        className="weq-rh-pulse-svg"
        viewBox={`0 0 ${W} ${H}`}
        role="img"
        aria-label="一天 24 小时发出的消息曲线"
        preserveAspectRatio="none"
      >
        <defs>
          <linearGradient id="weq-rh-pulse-fill" x1="0" y1="0" x2="0" y2="1">
            <stop className="weq-rh-pulse-stop-top" offset="0%" />
            <stop className="weq-rh-pulse-stop-bottom" offset="100%" />
          </linearGradient>
        </defs>
        <line className="weq-rh-pulse-floor" x1="0" y1={H - 1} x2={W} y2={H - 1} />
        <line className="weq-rh-pulse-peak-line" x1={peak.x} y1={TOP} x2={peak.x} y2={H - BOTTOM} />
        <path className="weq-rh-pulse-area" d={area} fill="url(#weq-rh-pulse-fill)" />
        <path className="weq-rh-pulse-line" d={line} />
        <circle className="weq-rh-pulse-dot" cx={peak.x} cy={peak.y} r="4.2" />
      </svg>
      <div className="weq-rh-pulse-axis" aria-hidden>
        <span>00</span>
        <span>06</span>
        <span>12</span>
        <span>18</span>
        <span>24</span>
      </div>
    </div>
  );
}

/** 平滑路径：把相邻点用三次贝塞尔接起来（Catmull-Rom → Bezier），不抖动。 */
function smoothLine(points: ReadonlyArray<readonly [number, number]>): string {
  if (points.length === 0) return '';
  if (points.length === 1) return `${points[0]![0]} ${points[0]![1]}`;
  let d = `${points[0]![0]} ${points[0]![1]}`;
  for (let i = 0; i < points.length - 1; i++) {
    const p0 = points[Math.max(0, i - 1)]!;
    const p1 = points[i]!;
    const p2 = points[i + 1]!;
    const p3 = points[Math.min(points.length - 1, i + 2)]!;
    const c1x = p1[0] + (p2[0] - p0[0]) / 6;
    const c1y = p1[1] + (p2[1] - p0[1]) / 6;
    const c2x = p2[0] - (p3[0] - p1[0]) / 6;
    const c2y = p2[1] - (p3[1] - p1[1]) / 6;
    d += ` C ${c1x} ${c1y}, ${c2x} ${c2y}, ${p2[0]} ${p2[1]}`;
  }
  return d;
}

/** 7×24 周墙：行是周一..周日，列是小时；同一根轴，颜色深浅 = 发出的条数。 */
function WeekWall({
  matrix,
  mainKind,
  drawn,
}: {
  matrix: number[][];
  mainKind: RhythmWindowKind | 'all';
  drawn: boolean;
}): ReactElement {
  const max = useMemo(
    () => Math.max(1, ...matrix.flat().map((count) => Number(count || 0))),
    [matrix],
  );
  return (
    <div className="weq-rh-week" data-drawn={drawn ? 'yes' : 'no'}>
      <p className="weq-rh-evidence-name is-week">一周 · 7×24</p>
      <div className="weq-rh-week-body" aria-hidden>
        {WEEKDAY_ROWS.map((dow) => (
          <div className="weq-rh-week-row" key={dow}>
            <span className="weq-rh-weekday">{WEEKDAY_NAMES[dow]}</span>
            <div className="weq-rh-week-hours">
              {Array.from({ length: 24 }, (_, hour) => {
                const count = Number(matrix[dow]?.[hour] ?? 0);
                const level = count === 0 ? 0 : Math.min(4, 1 + Math.ceil((count / max) * 3));
                const active = mainKind !== 'all' && inRhythmWindow(mainKind, hour);
                return (
                  <i
                    // biome-ignore lint/suspicious/noArrayIndexKey: 24 个固定小时位即稳定键，不会重排。
                    key={hour}
                    className={`weq-rh-cell is-${level}${active ? ' is-rhythm' : ''}`}
                    data-tooltip={`${WEEKDAY_NAMES[dow]} ${HOUR_LABEL(hour)} · ${count} 条`}
                  />
                );
              })}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

/** 小时是否落在人设时段内（22–08 跨越午夜，先按 hour 归一化再判）。 */
function inRhythmWindow(kind: RhythmWindowKind, hour: number): boolean {
  switch (kind) {
    case 'night':
      return hour >= 22 || hour < 2;
    case 'us':
      return hour >= 2 && hour < 8;
    case 'early':
      return hour >= 8 && hour < 12;
    case 'afternoon':
      return hour >= 12 && hour < 18;
    case 'dusk':
      return hour >= 18 && hour < 22;
  }
}
