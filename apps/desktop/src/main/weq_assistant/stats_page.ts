/**
 * WeQ 助手「群数据周报」推文 —— 服务端渲染。
 *
 * 「推文」跳转页由 QQ 自己的 webview 打开（主进程 loopback server 直出 HTML），renderer
 * 的 React 图表组件跑不进去；所以这里把现有「群聊分析」的四个视图——发言排行 /
 * 活跃时段 / 每日热力图(绿墙) / 词云——**复刻成纯 HTML+CSS+内联 SVG**，配色一律走
 * theme.buildPalette（跟随 WeQ Desktop 的主色 + 深浅），与「每日推文」封面/页面观感统一。
 *
 * 数据只来自内存快照（getWeqStats），页面本身零计算：见 stats.ts 的缓存说明。
 *
 * 导出：
 *   renderStatsPageHtml(report)  —— 完整统计页（有快照）
 *   statsPendingHtml()           —— 「生成中」占位页（无快照 / 首次）
 *   statsCardSpec(report)        —— 封面 CardSpec（交给 cover.renderCardPng）
 */

import { readFileSync, existsSync } from 'node:fs';
import { resolveResource } from '../resource';
import { buildPalette, getWeqTheme, mix, rgba, type WeqPalette } from './theme';
import type { CardSpec } from './cover';
import type { WeqStatsReport } from './stats';

// ── 通用小工具 ────────────────────────────────────────────────────────────

function esc(input: unknown): string {
  return String(input ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/** 大数缩写：12345 → 1.2万 / 3400 → 3.4k。 */
function fmtNum(n: number): string {
  if (n >= 10000) return `${(n / 10000).toFixed(1)}万`;
  if (n >= 1000) return `${(n / 1000).toFixed(1)}k`;
  return String(n);
}

function fmtDate(ts: number | null): string {
  if (!ts) return '-';
  const d = new Date(ts * 1000);
  return `${d.getFullYear()}/${d.getMonth() + 1}/${d.getDate()}`;
}

function todayLabel(): string {
  const d = new Date();
  const pad = (n: number): string => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

/** WeQ logo 作 data URI（页面头像/水印用），缺失回 null。 */
let logoUriCache: string | null | undefined;
function brandLogoDataUri(): string | null {
  if (logoUriCache !== undefined) return logoUriCache;
  const path = resolveResource('brand', 'logo.png');
  logoUriCache =
    path && existsSync(path)
      ? `data:image/png;base64,${readFileSync(path).toString('base64')}`
      : null;
  return logoUriCache;
}

/** 消息类型配色（与 renderer 的 GroupAnalyticsDialog 一致）。 */
const TYPE_COLORS: Array<{ key: keyof WeqStatsReport['stats']['totals']; label: string; color: string }> = [
  { key: 'textMessages', label: '文本', color: '#3b82f6' },
  { key: 'imageMessages', label: '图片', color: '#22c55e' },
  { key: 'voiceMessages', label: '语音', color: '#f97316' },
  { key: 'videoMessages', label: '视频', color: '#a855f7' },
  { key: 'emojiMessages', label: '表情', color: '#ec4899' },
  { key: 'otherMessages', label: '其他', color: '#6b7280' },
];

// ── 环形图（消息类型占比，conic-gradient） ──────────────────────────────────

function renderDonut(report: WeqStatsReport, p: WeqPalette): string {
  const t = report.stats.totals;
  const segs = TYPE_COLORS.map((c) => ({ label: c.label, color: c.color, value: t[c.key] as number })).filter(
    (s) => s.value > 0,
  );
  const total = segs.reduce((s, x) => s + x.value, 0);

  let acc = 0;
  const stops: string[] = [];
  if (total > 0) {
    for (const s of segs) {
      const start = (acc / total) * 100;
      acc += s.value;
      const end = (acc / total) * 100;
      stops.push(`${s.color} ${start.toFixed(2)}% ${end.toFixed(2)}%`);
    }
  } else {
    stops.push(`${p.pillBorder} 0% 100%`);
  }

  const legend = segs
    .map((s) => {
      const pct = total > 0 ? Math.round((s.value / total) * 100) : 0;
      return `<div class="st-lg-item"><span class="st-lg-dot" style="background:${s.color}"></span>
        <span class="st-lg-lbl">${esc(s.label)}</span>
        <span class="st-lg-val">${fmtNum(s.value)} · ${pct}%</span></div>`;
    })
    .join('');

  return `<div class="st-donut-wrap">
    <div class="st-donut" style="background:conic-gradient(${stops.join(',')})">
      <div class="st-donut-hole">
        <b>${fmtNum(total)}</b><small>条消息</small>
      </div>
    </div>
    <div class="st-legend">${legend}</div>
  </div>`;
}

// ── 发言排行（top N，含名次奖牌 + 占比条） ──────────────────────────────────

const MEDALS = ['🥇', '🥈', '🥉'];

function renderRanking(report: WeqStatsReport, p: WeqPalette): string {
  const list = report.stats.ranking;
  if (list.length === 0) return `<p class="st-empty">暂无发言数据</p>`;
  const max = Math.max(...list.map((r) => r.messageCount), 1);
  const rows = list
    .map((item, idx) => {
      const pct = Math.max((item.messageCount / max) * 100, 3);
      const rank = idx < 3 ? MEDALS[idx] : String(idx + 1);
      const top = idx < 3 ? ' is-top' : '';
      return `<div class="st-rk-row${top}">
        <span class="st-rk-num">${rank}</span>
        <div class="st-rk-main">
          <div class="st-rk-name">${esc(item.displayName)}</div>
          <div class="st-rk-track"><div class="st-rk-fill" style="width:${pct.toFixed(1)}%;background:${p.accentInk}"></div></div>
        </div>
        <span class="st-rk-count">${fmtNum(item.messageCount)}</span>
      </div>`;
    })
    .join('');
  return `<div class="st-ranking">${rows}</div>`;
}

// ── 活跃时段（24 小时柱状图） ───────────────────────────────────────────────

function renderHourly(report: WeqStatsReport, p: WeqPalette): string {
  const data = report.stats.timeDistribution;
  const max = Math.max(...Object.values(data), 1);
  const bars = Array.from({ length: 24 }, (_, hour) => {
    const value = data[hour] ?? 0;
    const h = max > 0 ? Math.max((value / max) * 100, value > 0 ? 3 : 0) : 0;
    const label = hour % 3 === 0 ? String(hour) : '';
    return `<div class="st-bar-col" title="${hour}:00 · ${value} 条">
      <div class="st-bar-track"><div class="st-bar-fill" style="height:${h.toFixed(1)}%;background:${p.accentInk}"></div></div>
      <div class="st-bar-hour">${label}</div>
    </div>`;
  }).join('');
  return `<div class="st-bars">${bars}</div>`;
}

// ── 每日热力图（绿墙，移植自 analyticsCharts.ContributionHeatmap） ────────────

const MONTH_NAMES = ['1月', '2月', '3月', '4月', '5月', '6月', '7月', '8月', '9月', '10月', '11月', '12月'];
const DAY_MS = 86400000;
const HEATMAP_DAYS = 371;

function parseYmd(s: string): Date {
  const [y, m, d] = s.split('-').map(Number);
  return new Date(y!, (m ?? 1) - 1, d ?? 1);
}
function fmtYmd(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}
function intensityLevel(count: number, max: number): number {
  if (count <= 0) return 0;
  const r = count / max;
  if (r > 0.66) return 4;
  if (r > 0.33) return 3;
  if (r > 0.12) return 2;
  return 1;
}

function renderHeatmap(report: WeqStatsReport, p: WeqPalette): string {
  const data = report.stats.daily;
  if (!data || data.length === 0) return `<p class="st-empty">暂无活跃数据</p>`;

  const counts = new Map(data.map((d) => [d.date, d.count]));
  const last = parseYmd(data[data.length - 1]!.date);
  const start = new Date(last.getTime() - (HEATMAP_DAYS - 1) * DAY_MS);
  const gridStart = new Date(start.getTime() - start.getDay() * DAY_MS);

  const weeks: Array<Array<{ date: string; count: number; inRange: boolean }>> = [];
  const monthLabels: string[] = [];
  let max = 1;
  const cur = new Date(gridStart);
  let lastMonth = -1;
  while (cur.getTime() <= last.getTime()) {
    const week: Array<{ date: string; count: number; inRange: boolean }> = [];
    let labelForWeek = '';
    for (let i = 0; i < 7; i++) {
      const key = fmtYmd(cur);
      const inRange = cur.getTime() >= start.getTime() && cur.getTime() <= last.getTime();
      const count = inRange ? counts.get(key) ?? 0 : 0;
      if (inRange) {
        if (count > max) max = count;
        if (cur.getDate() <= 7 && cur.getMonth() !== lastMonth && !labelForWeek) {
          labelForWeek = MONTH_NAMES[cur.getMonth()]!;
          lastMonth = cur.getMonth();
        }
      }
      week.push({ date: key, count, inRange });
      cur.setTime(cur.getTime() + DAY_MS);
    }
    weeks.push(week);
    monthLabels.push(labelForWeek);
  }

  // 各强度等级的颜色：跟随主色，由浅到深（空/无数据回落到淡描边色）。
  const levelColor = (lvl: number): string => {
    if (lvl <= 0) return p.mode === 'dark' ? 'rgba(255,255,255,0.06)' : rgba(p.accent, 0.06);
    return rgba(p.accent, [0, 0.28, 0.48, 0.72, 1][lvl] ?? 1);
  };

  const monthsRow = monthLabels.map((l) => `<span class="st-hm-month">${esc(l)}</span>`).join('');
  const grid = weeks
    .map((week) => {
      const cells = week
        .map((cell) => {
          if (!cell.inRange) return `<div class="st-hm-cell" style="background:transparent"></div>`;
          const lvl = intensityLevel(cell.count, max);
          return `<div class="st-hm-cell" style="background:${levelColor(lvl)}" title="${cell.date} · ${cell.count} 条"></div>`;
        })
        .join('');
      return `<div class="st-hm-week">${cells}</div>`;
    })
    .join('');

  const legendCells = [0, 1, 2, 3, 4]
    .map((lvl) => `<i style="background:${levelColor(lvl)}"></i>`)
    .join('');

  return `<div class="st-heatmap">
    <div class="st-hm-scroll"><div class="st-hm-inner">
      <div class="st-hm-months">${monthsRow}</div>
      <div class="st-hm-grid">${grid}</div>
    </div></div>
    <div class="st-hm-legend"><span>少</span>${legendCells}<span>多</span></div>
  </div>`;
}

// ── 词云（按频次流式排布，字号随频次；服务端预排，无需浏览器计算） ───────────

function renderWordCloud(report: WeqStatsReport, p: WeqPalette): string {
  const words = report.stats.words.slice(0, 64);
  if (words.length === 0) return `<p class="st-empty">暂无足够文本生成词云</p>`;
  const colors = [
    p.accentInk,
    mix(p.accent, '#8b5cf6', 0.4),
    mix(p.accent, '#ec4899', 0.4),
    mix(p.accent, '#22c55e', 0.42),
    mix(p.accent, '#f59e0b', 0.45),
    p.sub,
  ];
  const maxC = words[0]!.count || 1;
  const minC = words[words.length - 1]!.count || 1;
  const spans = words
    .map((w, i) => {
      const t = maxC === minC ? 1 : (w.count - minC) / (maxC - minC);
      const fs = Math.round(13 + Math.pow(t, 1.6) * (36 - 13));
      const weight = fs > 30 ? 800 : fs > 22 ? 700 : fs > 16 ? 600 : 500;
      return `<span class="st-wc-word" style="font-size:${fs}px;font-weight:${weight};color:${colors[i % colors.length]}" title="${esc(
        w.word,
      )} · ${w.count} 次">${esc(w.word)}</span>`;
    })
    .join('');
  return `<div class="st-wordcloud">${spans}</div>`;
}

// ── 页面组装 ──────────────────────────────────────────────────────────────

function pageShell(p: WeqPalette, bodyHtml: string): string {
  return `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>WeQ 助手 · 群数据周报</title>
<style>
  :root {
    --accent: ${p.accent};
    --base: ${p.base};
    --glow1: ${p.glow1};
    --glow2: ${p.glow2};
    --grid: ${p.grid};
    --title: ${p.title};
    --body: ${p.body};
    --sub: ${p.sub};
    --tag-bg: ${p.tagBg};
    --tag-ink: ${p.tagInk};
    --pill-bg: ${p.pillBg};
    --pill-border: ${p.pillBorder};
    --pill-ink: ${p.pillInk};
    --accent-ink: ${p.accentInk};
    --card: ${p.mode === 'dark' ? 'rgba(255,255,255,0.05)' : 'rgba(255,255,255,0.72)'};
    --card-border: ${p.mode === 'dark' ? 'rgba(255,255,255,0.10)' : 'rgba(15,23,42,0.06)'};
    --card-shadow: ${p.mode === 'dark' ? '0 24px 60px -28px rgba(0,0,0,0.7)' : '0 24px 60px -30px rgba(15,23,42,0.28)'};
    --track: ${p.mode === 'dark' ? 'rgba(255,255,255,0.08)' : rgba(p.accent, 0.09)};
    color-scheme: ${p.mode};
  }
  * { box-sizing: border-box; }
  body {
    margin: 0; min-height: 100vh;
    font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", "PingFang SC",
      "Microsoft YaHei", Roboto, system-ui, sans-serif;
    color: var(--body); background-color: var(--base);
    background-image:
      radial-gradient(720px 420px at 100% -6%, var(--glow1), transparent),
      radial-gradient(680px 460px at -8% 108%, var(--glow2), transparent),
      linear-gradient(var(--grid) 1px, transparent 1px),
      linear-gradient(90deg, var(--grid) 1px, transparent 1px);
    background-size: auto, auto, 38px 38px, 38px 38px;
    -webkit-font-smoothing: antialiased;
  }
  .wrap { max-width: 680px; margin: 0 auto; padding: 40px 20px 64px; }
  .brand { display: flex; align-items: center; gap: 12px; margin-bottom: 20px; }
  .logo { width: 40px; height: 40px; border-radius: 11px; box-shadow: 0 8px 20px -8px var(--accent); }
  .logo--fallback { display: flex; align-items: center; justify-content: center;
    background: var(--accent); color: #fff; font-weight: 800; font-size: 20px; }
  .brand .name { font-size: 17px; font-weight: 700; color: var(--title); }
  .tag { margin-left: auto; font-size: 13px; font-weight: 700; color: var(--tag-ink);
    background: var(--tag-bg); padding: 6px 13px; border-radius: 999px; }

  .hero { margin-bottom: 18px; }
  .hero h1 { margin: 0; font-size: 27px; line-height: 1.3; color: var(--title); font-weight: 800; letter-spacing: -0.01em; }
  .hero .subline { display: flex; flex-wrap: wrap; gap: 8px; margin-top: 12px; }
  .pill { display: inline-flex; align-items: center; gap: 7px; font-size: 13px; font-weight: 600;
    color: var(--pill-ink); background: var(--pill-bg); border: 1px solid var(--pill-border);
    padding: 6px 13px; border-radius: 999px; }
  .pill .dot { width: 7px; height: 7px; border-radius: 999px; background: var(--accent-ink); }

  .card { position: relative; overflow: hidden; background: var(--card); border: 1px solid var(--card-border);
    border-radius: 20px; padding: 22px 22px; margin-bottom: 16px;
    box-shadow: var(--card-shadow); backdrop-filter: blur(10px); -webkit-backdrop-filter: blur(10px); }
  .card > h2 { margin: 0 0 16px; font-size: 15px; font-weight: 700; color: var(--title);
    display: flex; align-items: center; gap: 8px; }
  .card > h2::before { content: ""; width: 4px; height: 15px; border-radius: 2px; background: var(--accent); }

  /* 概览卡片 */
  .st-stats { display: grid; grid-template-columns: repeat(2, 1fr); gap: 10px; }
  .st-stat { background: var(--pill-bg); border: 1px solid var(--pill-border); border-radius: 14px; padding: 13px 15px; }
  .st-stat b { display: block; font-size: 22px; font-weight: 800; color: var(--title); line-height: 1.1; }
  .st-stat span { display: block; margin-top: 4px; font-size: 12.5px; color: var(--sub); }
  .st-stat.wide { grid-column: 1 / -1; }
  .st-stat.wide b { font-size: 15.5px; }

  /* 环形图 */
  .st-donut-wrap { display: flex; align-items: center; gap: 20px; flex-wrap: wrap; }
  .st-donut { position: relative; width: 132px; height: 132px; border-radius: 50%; flex: none; }
  .st-donut-hole { position: absolute; inset: 20px; border-radius: 50%; background: var(--card);
    display: flex; flex-direction: column; align-items: center; justify-content: center; }
  .st-donut-hole b { font-size: 21px; font-weight: 800; color: var(--title); }
  .st-donut-hole small { font-size: 11px; color: var(--sub); }
  .st-legend { flex: 1; min-width: 180px; display: flex; flex-direction: column; gap: 7px; }
  .st-lg-item { display: flex; align-items: center; gap: 9px; font-size: 13px; }
  .st-lg-dot { width: 10px; height: 10px; border-radius: 3px; flex: none; }
  .st-lg-lbl { color: var(--body); }
  .st-lg-val { margin-left: auto; color: var(--sub); font-variant-numeric: tabular-nums; }

  /* 发言排行 */
  .st-ranking { display: flex; flex-direction: column; gap: 10px; }
  .st-rk-row { display: flex; align-items: center; gap: 11px; }
  .st-rk-num { flex: none; width: 26px; text-align: center; font-size: 14px; font-weight: 700; color: var(--sub); }
  .st-rk-row.is-top .st-rk-num { font-size: 18px; }
  .st-rk-main { flex: 1; min-width: 0; }
  .st-rk-name { font-size: 13.5px; color: var(--title); font-weight: 600; margin-bottom: 5px;
    white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .st-rk-track { height: 7px; border-radius: 999px; background: var(--track); overflow: hidden; }
  .st-rk-fill { height: 100%; border-radius: 999px; }
  .st-rk-count { flex: none; font-size: 12.5px; font-weight: 600; color: var(--sub); font-variant-numeric: tabular-nums; }

  /* 24h 柱状 */
  .st-bars { display: flex; align-items: flex-end; gap: 3px; height: 132px; }
  .st-bar-col { flex: 1; display: flex; flex-direction: column; align-items: center; height: 100%; }
  .st-bar-track { flex: 1; width: 100%; display: flex; align-items: flex-end; }
  .st-bar-fill { width: 100%; border-radius: 3px 3px 0 0; min-height: 0; }
  .st-bar-hour { margin-top: 5px; font-size: 10px; color: var(--sub); height: 12px; }

  /* 热力图 */
  .st-hm-scroll { overflow-x: auto; padding-bottom: 6px; }
  .st-hm-inner { display: inline-block; }
  .st-hm-months { display: flex; margin-bottom: 4px; }
  .st-hm-month { width: 15px; font-size: 10px; color: var(--sub); white-space: nowrap; }
  .st-hm-grid { display: flex; gap: 3px; }
  .st-hm-week { display: flex; flex-direction: column; gap: 3px; }
  .st-hm-cell { width: 11px; height: 11px; border-radius: 2px; }
  .st-hm-legend { display: flex; align-items: center; gap: 4px; margin-top: 10px; font-size: 11px; color: var(--sub); }
  .st-hm-legend i { width: 11px; height: 11px; border-radius: 2px; display: inline-block; }

  /* 词云 */
  .st-wordcloud { display: flex; flex-wrap: wrap; align-items: center; justify-content: center;
    gap: 6px 14px; padding: 10px 4px; line-height: 1.15; }
  .st-wc-word { white-space: nowrap; }

  .st-empty { text-align: center; color: var(--sub); font-size: 13px; padding: 18px 0; }
  .foot { margin-top: 24px; text-align: center; font-size: 12px; color: var(--sub); }
  .foot .lock { opacity: 0.85; }
</style>
</head>
<body><div class="wrap">${bodyHtml}</div></body>
</html>`;
}

function brandRow(): string {
  const logo = brandLogoDataUri();
  const logoTag = logo
    ? `<img class="logo" src="${logo}" alt="WeQ" />`
    : '<div class="logo logo--fallback">W</div>';
  return `<div class="brand">${logoTag}<span class="name">WeQ 助手</span><span class="tag">群数据周报</span></div>`;
}

/** 完整统计页（有快照时）。 */
export function renderStatsPageHtml(report: WeqStatsReport): string {
  const p = buildPalette(getWeqTheme());
  const t = report.stats.totals;
  const gen = new Date(report.generatedAt);
  const genLabel = `${gen.getFullYear()}-${String(gen.getMonth() + 1).padStart(2, '0')}-${String(
    gen.getDate(),
  ).padStart(2, '0')}`;
  const period =
    t.firstMessageTime && t.lastMessageTime
      ? `${fmtDate(t.firstMessageTime)} — ${fmtDate(t.lastMessageTime)}`
      : '-';

  const hero = `<div class="hero">
    <h1>${esc(report.group.name)}</h1>
    <div class="subline">
      <span class="pill"><span class="dot"></span>${genLabel} · 本机生成</span>
      <span class="pill">我的等级 LV${report.group.myLevel}</span>
      <span class="pill">${fmtNum(report.group.memberCount)} 名成员</span>
    </div>
  </div>`;

  const overview = `<div class="card">
    <h2>数据概览</h2>
    <div class="st-stats">
      <div class="st-stat"><b>${fmtNum(t.totalMessages)}</b><span>总消息数</span></div>
      <div class="st-stat"><b>${fmtNum(t.speakerCount)}</b><span>发言人数</span></div>
      <div class="st-stat"><b>${t.activeDays}</b><span>活跃天数</span></div>
      <div class="st-stat"><b>${fmtNum(report.stats.ranking[0]?.messageCount ?? 0)}</b><span>群龙王发言</span></div>
      <div class="st-stat wide"><b>${period}</b><span>活跃周期</span></div>
    </div>
  </div>`;

  const donut = `<div class="card"><h2>消息类型占比</h2>${renderDonut(report, p)}</div>`;
  const ranking = `<div class="card"><h2>发言排行榜</h2>${renderRanking(report, p)}</div>`;
  const hourly = `<div class="card"><h2>全天活跃时段</h2>${renderHourly(report, p)}</div>`;
  const heatmap = `<div class="card"><h2>每日消息热力图</h2>${renderHeatmap(report, p)}</div>`;
  const wordcloud = `<div class="card"><h2>群词云</h2>${renderWordCloud(report, p)}</div>`;

  const foot = `<div class="foot"><span class="lock">🔒</span> 数据全部来自你本机的 WeQ 服务 · 127.0.0.1</div>`;

  return pageShell(p, brandRow() + hero + overview + donut + ranking + hourly + heatmap + wordcloud + foot);
}

/** 「生成中」占位页（无快照 / 首次开启，后台正在算）。 */
export function statsPendingHtml(): string {
  const p = buildPalette(getWeqTheme());
  const body = `${brandRow()}
    <div class="hero"><h1>群数据周报生成中…</h1>
      <div class="subline"><span class="pill"><span class="dot"></span>${todayLabel()} · 本机生成</span></div>
    </div>
    <div class="card">
      <p style="margin:0;line-height:1.9;font-size:15px;color:var(--body)">
        WeQ 助手正在遍历你的群聊、挑出<b style="color:var(--title)">你等级最高的那个群</b>，
        并统计发言排行、活跃时段、每日热力图与群词云。<br/>
        数据算好后会<b style="color:var(--title)">存下来</b>，稍等片刻，回到会话重新点开本推文即可查看～
      </p>
    </div>
    <div class="foot"><span class="lock">🔒</span> 数据全部来自你本机的 WeQ 服务 · 127.0.0.1</div>`;
  return pageShell(p, body);
}

/**
 * 封面 CardSpec（交给 cover.renderCardPng 出 PNG）。无快照时给「生成中」文案。
 */
export function statsCardSpec(report: WeqStatsReport | null): CardSpec {
  if (!report) {
    return {
      title: '群数据周报生成中…',
      subtitle: 'WeQ 助手正在统计你最活跃的群聊',
      footer: todayLabel(),
      tag: '群数据周报',
    };
  }
  const t = report.stats.totals;
  return {
    title: report.group.name,
    subtitle: `共 ${fmtNum(t.totalMessages)} 条消息 · 活跃 ${t.activeDays} 天 · ${fmtNum(t.speakerCount)} 人发言`,
    footer: `我的等级 LV${report.group.myLevel} · ${todayLabel()}`,
    tag: '群数据周报',
  };
}
