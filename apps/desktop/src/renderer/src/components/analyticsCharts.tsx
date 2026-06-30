// @ts-nocheck
/**
 * Shared analytics visualisations used by both the group (GroupAnalyticsDialog)
 * and private-chat (BuddyAnalyticsDialog) analysis pages:
 *   - HourlyBarChart      — 24-hour activity bars
 *   - ContributionHeatmap — GitHub-style daily heatmap (绿墙), full trailing year
 *   - WordCloud           — canvas-measured spiral layout, Chinese-friendly
 */

import { Loader2 } from "lucide-react";
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { cn } from "../im-template/template/classNames";

export const ACCENT = "var(--weq-accent-effective)";

export interface DailyActivityItem {
  date: string;
  count: number;
}

export interface WordCloudItem {
  word: string;
  count: number;
}

export function formatNumber(n: number): string {
  if (n >= 10000) return `${(n / 10000).toFixed(1)}万`;
  if (n >= 1000) return `${(n / 1000).toFixed(1)}k`;
  return String(n);
}

export function formatDate(ts: number | null): string {
  if (!ts) return "-";
  const d = new Date(ts * 1000);
  return `${d.getFullYear()}/${d.getMonth() + 1}/${d.getDate()}`;
}

/** Human-readable duration from seconds: 12秒 / 3分20秒 / 1.5小时 / 2天. */
export function formatDuration(sec: number): string {
  if (sec === null || sec === undefined || sec < 0 || !Number.isFinite(sec)) return "-";
  // Timestamps are second-resolution, so a 0s gap = replied within the same second.
  if (sec < 1) return "<1秒";
  if (sec < 60) return `${Math.round(sec)}秒`;
  if (sec < 3600) {
    const m = Math.floor(sec / 60);
    const s = Math.round(sec % 60);
    return s > 0 ? `${m}分${s}秒` : `${m}分`;
  }
  if (sec < 86400) return `${(sec / 3600).toFixed(1)}小时`;
  return `${(sec / 86400).toFixed(1)}天`;
}

/* ------------------------------------------------------------------ */
/* Donut chart (SVG, no deps) + legend                                 */
/* ------------------------------------------------------------------ */

export interface DonutSegment {
  label: string;
  value: number;
  color: string;
}

export function DonutChart({
  segments,
  size = 132,
  thickness = 20,
  centerLabel,
  centerSub,
  stack = false,
}: {
  segments: DonutSegment[];
  size?: number;
  thickness?: number;
  centerLabel?: string;
  centerSub?: string;
  /** Stack the legend below the ring (centered) instead of beside it. */
  stack?: boolean;
}) {
  const total = segments.reduce((s, x) => s + Math.max(0, x.value), 0);
  const radius = (size - thickness) / 2;
  const circumference = 2 * Math.PI * radius;
  const cx = size / 2;
  let acc = 0;

  return (
    <div className={cn("ba-donut", stack && "ba-donut-stack")}>
      <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`} className="ba-donut-svg">
        <circle
          cx={cx}
          cy={cx}
          r={radius}
          fill="none"
          stroke="var(--weq-bg-elevated)"
          strokeWidth={thickness}
        />
        {total > 0 &&
          segments.map((s, i) => {
            if (s.value <= 0) return null;
            const dash = (s.value / total) * circumference;
            const node = (
              <circle
                key={i}
                cx={cx}
                cy={cx}
                r={radius}
                fill="none"
                stroke={s.color}
                strokeWidth={thickness}
                strokeDasharray={`${dash} ${circumference - dash}`}
                strokeDashoffset={-acc}
                transform={`rotate(-90 ${cx} ${cx})`}
              />
            );
            acc += dash;
            return node;
          })}
        {centerLabel ? (
          <text textAnchor="middle">
            <tspan x={cx} y={cx - (centerSub ? 4 : -2)} className="ba-donut-center-main">
              {centerLabel}
            </tspan>
            {centerSub ? (
              <tspan x={cx} y={cx + 15} className="ba-donut-center-sub">
                {centerSub}
              </tspan>
            ) : null}
          </text>
        ) : null}
      </svg>
      <div className="ba-donut-legend">
        {segments.map((s, i) => {
          const pct = total > 0 ? Math.round((s.value / total) * 100) : 0;
          return (
            <div className="ba-donut-legend-item" key={i}>
              <span className="ba-donut-dot" style={{ background: s.color }} />
              <span className="ba-donut-lbl">{s.label}</span>
              <span className="ba-donut-val">
                {formatNumber(s.value)} · {pct}%
              </span>
            </div>
          );
        })}
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* 24-hour bar chart                                                   */
/* ------------------------------------------------------------------ */

export function HourlyBarChart({
  data,
  color = ACCENT,
}: {
  data: Record<number, number>;
  color?: string;
}) {
  const max = Math.max(...Object.values(data), 1);
  return (
    <div className="ga-bar-chart">
      {Array.from({ length: 24 }, (_, hour) => {
        const value = data[hour] ?? 0;
        const heightPct = max > 0 ? (value / max) * 100 : 0;
        return (
          <div className="ga-bar-col" key={hour}>
            <div className="ga-bar-value-label">{value > 0 ? formatNumber(value) : ""}</div>
            <div className="ga-bar-track">
              <div
                className="ga-bar-fill"
                style={{
                  height: `${Math.max(heightPct, value > 0 ? 2 : 0)}%`,
                  backgroundColor: color,
                }}
              />
            </div>
            <div className="ga-bar-hour-label">{hour}</div>
          </div>
        );
      })}
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* GitHub-style contribution heatmap (绿墙)                            */
/* ------------------------------------------------------------------ */

const MONTH_NAMES = ["1月", "2月", "3月", "4月", "5月", "6月", "7月", "8月", "9月", "10月", "11月", "12月"];
const DAY_MS = 86400000;
/** The heatmap always renders a full trailing year (53 weeks ≈ 371 days). */
const HEATMAP_DAYS = 371;

function parseYmd(s: string): Date {
  const [y, m, d] = s.split("-").map(Number);
  return new Date(y, m - 1, d);
}
function fmtYmd(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(
    d.getDate(),
  ).padStart(2, "0")}`;
}

function intensityLevel(count: number, max: number): number {
  if (count <= 0) return 0;
  const r = count / max;
  if (r > 0.66) return 4;
  if (r > 0.33) return 3;
  if (r > 0.12) return 2;
  return 1;
}

export function ContributionHeatmap({ data }: { data: DailyActivityItem[] }) {
  const model = useMemo(() => {
    if (!data || data.length === 0) return null;
    const counts = new Map(data.map((d) => [d.date, d.count]));
    const last = parseYmd(data[data.length - 1].date);

    // Always show a full trailing year ending at the latest active day; older
    // groups are trimmed to the last year, shorter ones are padded back to one.
    const start = new Date(last.getTime() - (HEATMAP_DAYS - 1) * DAY_MS);
    // Align grid start to the Sunday on/just before `start`.
    const gridStart = new Date(start.getTime() - start.getDay() * DAY_MS);

    const weeks: Array<Array<{ date: string; count: number; inRange: boolean }>> = [];
    const monthLabels: string[] = [];
    let max = 1;
    let total = 0;
    let activeDays = 0;

    const cur = new Date(gridStart);
    let lastMonth = -1;
    while (cur.getTime() <= last.getTime()) {
      const week: Array<{ date: string; count: number; inRange: boolean }> = [];
      let labelForWeek = "";
      for (let i = 0; i < 7; i++) {
        const key = fmtYmd(cur);
        const inRange = cur.getTime() >= start.getTime() && cur.getTime() <= last.getTime();
        const count = inRange ? counts.get(key) ?? 0 : 0;
        if (inRange) {
          if (count > max) max = count;
          if (count > 0) {
            total += count;
            activeDays += 1;
          }
          if (cur.getDate() <= 7 && cur.getMonth() !== lastMonth && !labelForWeek) {
            labelForWeek = MONTH_NAMES[cur.getMonth()];
            lastMonth = cur.getMonth();
          }
        }
        week.push({ date: key, count, inRange });
        cur.setTime(cur.getTime() + DAY_MS);
      }
      weeks.push(week);
      monthLabels.push(labelForWeek);
    }

    return { weeks, monthLabels, max, total, activeDays };
  }, [data]);

  if (!model) return <p className="ga-placeholder">暂无活跃数据</p>;

  return (
    <div className="ga-heatmap">
      <div className="ga-hm-meta">
        <span>
          共 <strong>{formatNumber(model.total)}</strong> 条消息 · 活跃 <strong>{model.activeDays}</strong> 天
        </span>
      </div>
      <div className="ga-hm-scroll">
        <div className="ga-hm-inner">
          <div className="ga-hm-months">
            {model.monthLabels.map((label, i) => (
              <span className="ga-hm-month" key={i}>
                {label}
              </span>
            ))}
          </div>
          <div className="ga-hm-grid">
            {model.weeks.map((week, wi) => (
              <div className="ga-hm-week" key={wi}>
                {week.map((cell, di) => (
                  <div
                    key={di}
                    className={cn("ga-hm-cell", !cell.inRange && "is-empty")}
                    data-level={cell.inRange ? intensityLevel(cell.count, model.max) : undefined}
                    title={cell.inRange ? `${cell.date} · ${cell.count} 条` : undefined}
                  />
                ))}
              </div>
            ))}
          </div>
        </div>
      </div>
      <div className="ga-hm-legend">
        <span>少</span>
        <i data-level={0} />
        <i data-level={1} />
        <i data-level={2} />
        <i data-level={3} />
        <i data-level={4} />
        <span>多</span>
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Word cloud (canvas-measured spiral layout, Chinese-friendly)        */
/* ------------------------------------------------------------------ */

const WC_COLORS = [
  "var(--weq-accent-effective)",
  "color-mix(in srgb, var(--weq-accent-effective) 72%, #8b5cf6)",
  "color-mix(in srgb, var(--weq-accent-effective) 60%, #ec4899)",
  "color-mix(in srgb, var(--weq-accent-effective) 65%, #22c55e)",
  "color-mix(in srgb, var(--weq-accent-effective) 70%, #f59e0b)",
  "color-mix(in srgb, var(--weq-fg-primary) 62%, transparent)",
];

interface PlacedWord {
  word: string;
  count: number;
  x: number;
  y: number;
  fontSize: number;
  color: string;
  weight: number;
}

function rectsOverlap(a: { x: number; y: number; w: number; h: number }, b: typeof a): boolean {
  const pad = 3;
  return !(
    a.x + a.w + pad < b.x ||
    b.x + b.w + pad < a.x ||
    a.y + a.h + pad < b.y ||
    b.y + b.h + pad < a.y
  );
}

function layoutWords(
  words: WordCloudItem[],
  width: number,
  height: number,
  fontFamily: string,
): PlacedWord[] {
  if (width <= 0 || words.length === 0) return [];
  const canvas = document.createElement("canvas");
  const ctx = canvas.getContext("2d");
  if (!ctx) return [];

  const list = words.slice(0, 80);
  const maxCount = list[0].count || 1;
  const minCount = list[list.length - 1].count || 1;
  const minFs = 12;
  const maxFs = Math.min(68, Math.max(36, Math.floor(width / 7)));

  const placed: PlacedWord[] = [];
  const rects: Array<{ x: number; y: number; w: number; h: number }> = [];
  const cx = width / 2;
  const cy = height / 2;

  list.forEach((item, idx) => {
    const t = maxCount === minCount ? 1 : (item.count - minCount) / (maxCount - minCount);
    // 用 >1 的幂曲线拉开高低频差距，凸显重点词（而非线性的"科学计数"）。
    const fontSize = Math.round(minFs + Math.pow(t, 1.6) * (maxFs - minFs));
    const weight = fontSize > 34 ? 800 : fontSize > 24 ? 700 : fontSize > 17 ? 600 : 500;
    ctx.font = `${weight} ${fontSize}px ${fontFamily}`;
    const w = ctx.measureText(item.word).width;
    const h = fontSize * 1.28;

    let found: { x: number; y: number; w: number; h: number } | null = null;
    for (let tt = 0; tt < 480; tt += 0.32) {
      const r = 3.6 * tt;
      const px = cx + r * Math.cos(tt) - w / 2;
      const py = cy + r * Math.sin(tt) * 0.62 - h / 2;
      if (px < 2 || py < 2 || px + w > width - 2 || py + h > height - 2) continue;
      const rect = { x: px, y: py, w, h };
      if (!rects.some((o) => rectsOverlap(o, rect))) {
        found = rect;
        break;
      }
    }
    if (found) {
      rects.push(found);
      placed.push({
        word: item.word,
        count: item.count,
        x: found.x,
        y: found.y,
        fontSize,
        color: WC_COLORS[idx % WC_COLORS.length],
        weight,
      });
    }
  });
  return placed;
}

export function WordCloud({ words, height = 300 }: { words: WordCloudItem[]; height?: number }) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const [width, setWidth] = useState(0);
  const [placed, setPlaced] = useState<PlacedWord[]>([]);

  useLayoutEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const update = () => setWidth(el.clientWidth);
    update();
    const ro = new ResizeObserver(update);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  useEffect(() => {
    const el = containerRef.current;
    if (!el || width <= 0) {
      setPlaced([]);
      return;
    }
    const fontFamily = getComputedStyle(el).fontFamily || "sans-serif";
    setPlaced(layoutWords(words, width, height, fontFamily));
  }, [words, width, height]);

  return (
    <div className="ga-wordcloud" ref={containerRef} style={{ height }}>
      {placed.length === 0 && words.length > 0 ? (
        <div className="ga-loading">
          <Loader2 size={24} className="weq-spin" />
        </div>
      ) : null}
      {placed.map((p, i) => (
        <span
          key={`${p.word}-${i}`}
          className="ga-wc-word"
          style={{
            left: p.x,
            top: p.y,
            fontSize: p.fontSize,
            color: p.color,
            fontWeight: p.weight,
          }}
          title={`${p.word} · ${p.count} 次`}
        >
          {p.word}
        </span>
      ))}
    </div>
  );
}
