/**
 * 年度报告 → 自包含 HTML。一份产物三种用途：
 *   - 直接保存为 .html 在浏览器里看；
 *   - 主进程 `printToPDF` 把它按 A4 逐页转成 .pdf；
 *   - 深色/浅色由 `prefers-color-scheme` 自适应（PDF 以当前系统主题为准）。
 *
 * 全部样式内联、无外部依赖、无远程图片 —— 离线可看可打。
 * 视觉与屏幕上的报告同一套语言：巨型衬线数字、发丝线分隔、出血描边幽灵字，
 * 不用卡片与面板底；每张卡片一页 A4 竖版，与 satori 长图共用同一份 JSON。
 */
import type { ReportPageManifest } from '@weq/service';
import {
  isAllTimeYear,
  reportEraLabel,
  reportPeriodLabel,
  reportSinceLabel,
} from '@weq/service/report-time';

export type ExportSlide = {
  page: ReportPageManifest;
  data: unknown;
};

function escapeHtml(value: unknown): string {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function fmt(n: number): string {
  return new Intl.NumberFormat('zh-CN').format(n);
}

/** 与屏幕版 OverviewPage 的 `formatPerDay` 同一口径，含「<0.1」低值档。 */
function formatPerDay(perDay: number): string {
  if (perDay >= 10) return fmt(Math.round(perDay));
  if (perDay >= 1) return perDay.toFixed(1);
  if (perDay >= 0.1) return perDay.toFixed(2);
  return perDay > 0 ? '&lt;0.1' : '0';
}

const CSS = `
  * { margin: 0; padding: 0; box-sizing: border-box; }
  :root {
    --paper: #f4f1ea;
    --paper-deep: #ebe6db;
    --ink: #16130d;
    --ink-soft: rgba(22,19,13,0.72);
    --ink-muted: rgba(22,19,13,0.46);
    --ink-faint: rgba(22,19,13,0.24);
    --hair: rgba(22,19,13,0.14);
    --accent: #1c5f8f;
    --ghost-stroke: rgba(22,19,13,0.10);
    --leaf: #2e7d55;
    --open: #6d4f93;
    --rhythm: #9a7440;
    --serif: "Playfair Display", Georgia, "Noto Serif CJK SC", "Noto Serif SC",
      "Source Han Serif SC", "Songti SC", SimSun, "Times New Roman", serif;
    --sans: ui-sans-serif, system-ui, -apple-system, "Segoe UI", "PingFang SC",
      "Microsoft YaHei", sans-serif;
    --mono: ui-monospace, SFMono-Regular, Menlo, monospace;
  }
  @media (prefers-color-scheme: dark) {
    :root {
      --paper: #0b0a09;
      --paper-deep: #060505;
      --ink: #f4f0e6;
      --ink-soft: rgba(244,240,230,0.76);
      --ink-muted: rgba(244,240,230,0.46);
      --ink-faint: rgba(244,240,230,0.20);
      --hair: rgba(244,240,230,0.13);
      --accent: #c9a227;
      --ghost-stroke: rgba(201,162,39,0.14);
      --leaf: #3fae70;
      --open: #d9a9cf;
      --rhythm: #e2bd79;
    }
  }
  @page { size: A4; margin: 0; }
  html, body { background: var(--paper); }
  body { font-family: var(--sans); color: var(--ink); -webkit-font-smoothing: antialiased; }
  .slide {
    position: relative;
    width: 210mm;
    height: 297mm;
    overflow: hidden;
    display: flex;
    flex-direction: column;
    padding: 20mm 20mm 18mm;
    background: linear-gradient(168deg, var(--paper) 0%, var(--paper-deep) 100%);
    page-break-after: always;
  }
  .slide:last-child { page-break-after: auto; }
  /* 出血描边幽灵字。用 left/top 显式定位：nowrap 的超宽元素配 right 定位会
     被撑到画布左侧（宽度从右边界往左量），位置不可控。 */
  .ghost {
    position: absolute;
    left: 120mm;
    top: 176mm;
    font-family: var(--serif);
    font-size: 130mm;
    font-weight: 600;
    line-height: 1;
    letter-spacing: -0.02em;
    color: transparent;
    -webkit-text-stroke: 0.5mm var(--ghost-stroke);
    white-space: nowrap;
  }
  .ghost.center {
    left: 50%;
    top: 50%;
    transform: translate(-50%, -50%);
    font-size: 105mm;
  }
  .brand {
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding-bottom: 4mm;
    border-bottom: 0.25mm solid var(--hair);
  }
  .brand-name { font-size: 8pt; letter-spacing: 4px; color: var(--accent); font-weight: 600; }
  .brand-tag { font-size: 7.5pt; letter-spacing: 3px; color: var(--ink-faint); font-family: var(--mono); }
  .body { position: relative; z-index: 1; flex: 1; display: flex; flex-direction: column; justify-content: center; }
  .eyebrow { font-size: 8pt; letter-spacing: 5px; font-weight: 600; color: var(--accent); }
  .lede { margin-top: 6mm; font-family: var(--serif); font-size: 14pt; letter-spacing: 2px; color: var(--ink-soft); }
  .hero { display: flex; align-items: baseline; gap: 5mm; margin-top: 2mm; }
  .hero-num {
    font-family: var(--serif);
    font-size: 68pt;
    font-weight: 600;
    letter-spacing: -2px;
    color: var(--ink);
    font-variant-numeric: tabular-nums;
  }
  .hero-unit { font-family: var(--serif); font-size: 16pt; letter-spacing: 3px; color: var(--ink-muted); }
  .rail { margin-top: 10mm; }
  .rail-track { display: flex; height: 1mm; background: var(--hair); }
  .rail-c2c { height: 1mm; background: var(--accent); }
  .rail-group { height: 1mm; background: color-mix(in srgb, var(--ink) 42%, transparent); }
  .rail-legend { display: flex; justify-content: space-between; margin-top: 4mm; }
  .rail-side { display: flex; align-items: baseline; gap: 3mm; }
  .rail-pct { font-family: var(--serif); font-size: 18pt; font-weight: 600; color: var(--accent); }
  .rail-side.right .rail-pct { color: var(--ink-soft); }
  .rail-name { font-size: 10pt; letter-spacing: 3px; color: var(--ink); }
  .rail-count { font-family: var(--mono); font-size: 8pt; color: var(--ink-faint); }
  .band { display: flex; margin-top: 13mm; border-top: 0.25mm solid var(--hair); }
  .band-cell { flex: 1; padding: 6mm 7mm 0 0; }
  .band-cell + .band-cell { padding-left: 7mm; border-left: 0.25mm solid var(--hair); }
  .band-dt { font-size: 7.5pt; letter-spacing: 3px; color: var(--ink-faint); }
  .band-dd { margin-top: 2mm; display: flex; align-items: baseline; gap: 1.5mm; }
  .band-num { font-family: var(--serif); font-size: 22pt; font-weight: 600; color: var(--ink); }
  .band-unit { font-size: 9pt; letter-spacing: 2px; color: var(--ink-muted); }
  /* 私聊火花页 */
  .sp-kicker { display: flex; justify-content: space-between; align-items: baseline; font-size: 8pt; letter-spacing: 3px; color: var(--ink-soft); }
  .sp-kicker-date { font-family: var(--serif); font-size: 12pt; letter-spacing: 1px; color: var(--ink-faint); }
  .sp-say { margin-top: 5mm; font-family: var(--serif); font-size: 13pt; letter-spacing: 2px; color: var(--ink-soft); }
  .sp-say b { color: var(--ink); font-weight: 600; }
  .sp-hero { display: flex; align-items: baseline; gap: 3mm; margin-top: 2mm; }
  .sp-hero-num { font-family: var(--serif); font-size: 58pt; font-weight: 600; letter-spacing: -2px; color: var(--ink); }
  .sp-hero-unit { font-family: var(--serif); font-size: 15pt; letter-spacing: 4px; color: var(--ink-muted); }
  .sp-wordline { display: flex; align-items: baseline; flex-wrap: wrap; gap: 4mm; margin-top: 2mm; font-family: var(--serif); font-size: 10pt; color: var(--ink-muted); letter-spacing: 1px; }
  .sp-wordline-word { font-family: var(--serif); font-size: 28pt; font-weight: 600; color: var(--leaf); letter-spacing: 1px; line-height: 0.9; }
  .sp-wall { margin-top: 8mm; }
  .sp-wall-head { display: flex; justify-content: space-between; align-items: baseline; }
  .sp-wall-title { font-family: var(--serif); font-size: 12pt; letter-spacing: 2px; color: var(--ink); }
  .sp-wall-sub { font-size: 7pt; letter-spacing: 2px; color: var(--ink-faint); }
  .sp-cols { margin-top: 3mm; display: flex; gap: 0.65mm; }
  .sp-col { display: flex; flex-direction: column; gap: 0.65mm; }
  .sp-cell { width: 1.65mm; height: 1.65mm; border-radius: 0.25mm; background: transparent; outline: 0.2mm solid var(--hair); outline-offset: -0.2mm; }
  .sp-cell.is-1 { background: color-mix(in srgb, var(--leaf) 18%, transparent); }
  .sp-cell.is-2 { background: color-mix(in srgb, var(--leaf) 38%, transparent); }
  .sp-cell.is-3 { background: color-mix(in srgb, var(--leaf) 62%, transparent); }
  .sp-cell.is-4 { background: var(--leaf); outline: none; }
  .sp-band { display: flex; margin-top: 10mm; border-top: 0.25mm solid var(--hair); }
  .sp-cell-band { flex: 1; padding: 3mm 3mm 0 0; }
  .sp-cell-band + .sp-cell-band { padding-left: 3mm; border-left: 0.25mm solid var(--hair); }
  .sp-dt { font-size: 7pt; letter-spacing: 2px; color: var(--ink-faint); white-space: nowrap; }
  .sp-dd { margin-top: 1mm; display: flex; align-items: baseline; gap: 1mm; }
  .sp-num { font-family: var(--serif); font-size: 17pt; font-weight: 600; color: var(--ink); }
  .sp-unit { font-size: 8pt; color: var(--ink-muted); }
  .sp-note { margin-top: 1mm; font-size: 7pt; color: var(--leaf); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  /* 装扮页。屏幕版画的是真气泡，导出版画不了（见 dressSlide），改用引号盛那句话。 */
  .dr-top { margin-top: 4mm; padding-bottom: 6mm; border-bottom: 0.25mm solid var(--hair); }
  .dr-say {
    position: relative;
    padding-left: 8mm;
    font-family: var(--serif);
    font-size: 24pt;
    font-weight: 600;
    line-height: 1.5;
    color: var(--ink);
  }
  .dr-say::before {
    position: absolute;
    left: 0;
    top: -1mm;
    content: "“";
    font-family: var(--serif);
    font-size: 34pt;
    color: var(--accent);
  }
  .dr-worn { margin-top: 2mm; font-size: 9pt; letter-spacing: 1px; color: var(--ink-soft); }
  .dr-sum { margin-top: 5mm; font-size: 9.5pt; letter-spacing: 1px; color: var(--ink-muted); }
  /* 用过几款：与屏幕版数据带前三类同一份数字，排成一行发丝线分隔的小字
     （屏幕版的「全年装扮率」一格并入上方 dr-sum）。 */
  .dr-kinds { margin-top: 3mm; display: flex; gap: 5mm; font-size: 9pt; color: var(--ink-soft); }
  .dr-kinds span + span { padding-left: 5mm; border-left: 0.25mm solid var(--hair); }
  /* 好友榜页。屏幕版头像走自定义本地缓存协议，导出必须自包含，所以这里
     一律不画脸。但**两幕的形状照旧分开**：火花是横向引线（长度 = 天数），
     消息量是纵向柱阵（高度 = 条数）—— 那才是这一页区别于其它页的地方，
     丢了形状就只剩两组数字。静态产物没有动画，引线和柱子直接画在终态。 */
  .fr-kicker { display: flex; justify-content: space-between; align-items: baseline; font-size: 8pt; letter-spacing: 3px; color: var(--ink-soft); }
  .fr-kicker-meta { font-size: 7.5pt; letter-spacing: 2px; color: var(--ink-faint); }
  .fr-board { margin-top: 7mm; padding-top: 4mm; border-top: 0.25mm solid var(--hair); }
  .fr-board.spark { --tone: #c2703d; }
  .fr-board.msg { --tone: var(--accent); }
  .fr-head { display: flex; align-items: baseline; gap: 5mm; }
  .fr-eyebrow { font-size: 8pt; letter-spacing: 4px; font-weight: 600; color: var(--tone); }
  .fr-sub { font-size: 7.5pt; letter-spacing: 1px; color: var(--ink-faint); }
  .fr-empty { margin-top: 3mm; font-family: var(--serif); font-size: 10pt; color: var(--ink-faint); }
  .fr-num { font-family: var(--serif); font-weight: 600; letter-spacing: -2pt; color: var(--ink); }
  /* ── 火花幕：横向引线 ── */
  .fr-fuse-head { display: flex; align-items: baseline; justify-content: space-between; gap: 6mm; margin-top: 2mm; }
  .fr-fuse-who { display: flex; flex-direction: column; }
  .fr-fuse-name { font-family: var(--serif); font-size: 13pt; letter-spacing: 1px; color: var(--ink); }
  .fr-fuse-msgs { margin-top: 1mm; font-size: 7.5pt; letter-spacing: 2px; color: var(--ink-faint); }
  .fr-fuse-val { display: flex; align-items: baseline; gap: 2.5mm; }
  .fr-fuse-num { font-size: 42pt; }
  .fr-fuse-unit { font-family: var(--serif); font-size: 12pt; letter-spacing: 3px; color: var(--tone); }
  /* 冠军引线满格，末端一枚火种（静态产物里它不跳，只是一个实心圆头）。 */
  .fr-fuse-track { position: relative; height: 1.4mm; margin-top: 3mm; border-radius: 0.7mm; background: var(--hair); }
  .fr-fuse-burn {
    position: relative;
    display: block;
    height: 100%;
    border-radius: 0.7mm;
    background: linear-gradient(90deg, color-mix(in srgb, var(--tone) 14%, transparent), var(--tone));
  }
  .fr-fuse-ember { position: absolute; right: -1.6mm; top: -1.1mm; width: 3.6mm; height: 3.6mm; border-radius: 50%; background: var(--tone); }
  .fr-fuse-runner { display: flex; align-items: center; gap: 3mm; margin-top: 3mm; }
  .fr-fuse-rank { font-family: var(--serif); font-size: 9pt; font-weight: 600; color: var(--ink-faint); }
  .fr-fuse-rname { width: 26mm; overflow: hidden; font-size: 8.5pt; letter-spacing: 1px; color: var(--ink-soft); text-overflow: ellipsis; white-space: nowrap; }
  .fr-fuse-rtrack { flex: 1; height: 0.7mm; border-radius: 0.35mm; background: var(--hair); }
  .fr-fuse-rtrack span { display: block; height: 100%; border-radius: 0.35mm; background: color-mix(in srgb, var(--tone) 58%, transparent); }
  .fr-fuse-rnum { font-family: var(--serif); font-size: 13pt; font-weight: 600; color: var(--ink); }
  .fr-fuse-runit { font-size: 7pt; color: var(--ink-faint); }
  /* ── 消息幕：纵向柱阵。巨数在左，八根柱共基线在右（列宽等分，名字截断）。 ── */
  .fr-vol { display: flex; align-items: flex-end; gap: 9mm; margin-top: 2mm; }
  .fr-vol-champ { display: flex; flex-direction: column; padding-bottom: 1mm; }
  .fr-vol-row { display: flex; align-items: baseline; gap: 2.5mm; }
  .fr-vol-num { font-size: 40pt; }
  .fr-vol-unit { font-family: var(--serif); font-size: 12pt; letter-spacing: 3px; color: var(--tone); }
  .fr-vol-name { margin-top: 1.5mm; font-family: var(--serif); font-size: 12pt; letter-spacing: 1px; color: var(--ink); }
  .fr-stacks { flex: 1; display: flex; align-items: flex-end; gap: 2mm; }
  .fr-stack { flex: 1; min-width: 0; display: flex; flex-direction: column; align-items: center; gap: 1.4mm; }
  .fr-stack-val { display: flex; align-items: baseline; gap: 0.6mm; }
  .fr-stack-val b { font-family: var(--serif); font-size: 8pt; font-weight: 600; color: var(--ink-muted); }
  .fr-stack.champ .fr-stack-val b { font-size: 12pt; color: var(--tone); }
  .fr-stack-val i { font-size: 6pt; font-style: normal; color: var(--ink-faint); }
  /* 八列并排时「条」字只会撑宽列、挤掉名字 —— 只有冠军那根保留。 */
  .fr-stack:not(.champ) .fr-stack-val i { display: none; }
  /* 柱身的横纹 = 一层层摞起来的消息。冠军那根更宽、更实。 */
  .fr-stack-bar {
    width: 100%;
    max-width: 6mm;
    border-radius: 0.6mm 0.6mm 0 0;
    background: repeating-linear-gradient(180deg, color-mix(in srgb, var(--tone) 42%, transparent) 0 0.8mm, transparent 0.8mm 1.6mm);
    outline: 0.2mm solid color-mix(in srgb, var(--tone) 24%, transparent);
    outline-offset: -0.2mm;
  }
  .fr-stack.champ .fr-stack-bar {
    max-width: 11mm;
    outline: none;
    background: repeating-linear-gradient(180deg, color-mix(in srgb, var(--tone) 82%, transparent) 0 0.8mm, color-mix(in srgb, var(--tone) 28%, transparent) 0.8mm 1.6mm);
  }
  .fr-stack-name { max-width: 100%; overflow: hidden; font-size: 6pt; letter-spacing: 0; color: var(--ink-muted); text-overflow: ellipsis; white-space: nowrap; }
  .fr-stack.champ .fr-stack-name { font-size: 7pt; color: var(--ink-soft); }
  /* 谁先开口页 */
  .op-kicker { display: flex; justify-content: space-between; align-items: baseline; font-size: 8pt; letter-spacing: 3px; color: var(--ink-soft); }
  .op-kicker-meta { font-size: 7.5pt; letter-spacing: 2px; color: var(--ink-faint); }
  .op-kicker-meta b { font-family: var(--serif); font-size: 10pt; font-weight: 600; color: var(--ink-soft); }
  .op-lede { margin-top: 10mm; font-family: var(--serif); font-size: 11.5pt; letter-spacing: 2px; color: var(--ink-soft); }
  .op-lede b { font-family: var(--serif); font-size: 1.1em; font-weight: 600; color: var(--ink); }
  .op-punch { display: flex; align-items: baseline; flex-wrap: wrap; gap: 0 6mm; margin-top: 1mm; }
  .op-num { font-family: var(--serif); font-size: 90pt; font-weight: 600; letter-spacing: -4px; color: var(--ink); line-height: 1; font-variant-numeric: tabular-nums; }
  .op-unit { font-family: var(--serif); font-size: 27pt; font-weight: 600; color: var(--open); }
  .op-word { font-family: var(--serif); font-size: 15pt; letter-spacing: 5px; color: var(--ink-soft); white-space: nowrap; }
  .op-mood { margin-top: 1mm; font-family: var(--serif); font-size: 12pt; letter-spacing: 2px; color: var(--ink-muted); }
  .op-beam { display: flex; align-items: center; gap: 6mm; margin-top: 10mm; }
  .op-side { font-size: 8pt; letter-spacing: 2px; color: var(--ink-faint); white-space: nowrap; }
  .op-side b { font-family: var(--serif); font-size: 12pt; font-weight: 600; color: var(--ink-soft); }
  .op-track { position: relative; flex: 1; height: 2mm; }
  .op-half-peer, .op-half-mine { position: absolute; top: 50%; height: 0.35mm; }
  .op-half-peer { left: 0; width: 50%; background: var(--hair); }
  .op-half-mine { right: 0; width: 50%; background: color-mix(in srgb, var(--open) 62%, transparent); }
  .op-mid { position: absolute; left: 50%; top: 0.35mm; width: 0.25mm; height: 1.3mm; background: var(--hair); }
  .op-dot { position: absolute; top: 0; width: 2mm; height: 2mm; margin-left: -1mm; border-radius: 50%; background: var(--open); box-shadow: 0 0 2mm color-mix(in srgb, var(--open) 55%, transparent); }
  .op-tales { margin-top: 10mm; padding-top: 4mm; border-top: 0.25mm solid var(--hair); }
  .op-tales-in { font-size: 7.5pt; letter-spacing: 4px; color: var(--ink-faint); }
  .op-line { margin-top: 2.5mm; font-family: var(--serif); font-size: 11pt; line-height: 1.75; letter-spacing: 1px; color: var(--ink-soft); }
  .op-line em { color: var(--open); font-weight: 600; font-style: normal; }
  .op-line-role { margin-right: 3mm; color: var(--open); font-family: var(--sans); font-size: 7.5pt; font-weight: 600; letter-spacing: 3px; }
  .op-line-dot { margin-right: 3mm; color: var(--ink-faint); }
  /* 我的作息页。人设词走墨色，曲线/墙面用 data-kind 各自的时间色。 */
  .rh-body { flex: 1; display: flex; flex-direction: column; justify-content: center; }
  .rh-kicker { display: flex; justify-content: space-between; align-items: baseline; font-size: 8pt; letter-spacing: 3px; color: var(--ink-soft); }
  .rh-kicker-meta { font-size: 7.5pt; letter-spacing: 2px; color: var(--ink-faint); }
  .rh-kicker-meta b { font-family: var(--serif); font-size: 10pt; font-weight: 600; color: var(--ink-soft); }
  .rh-lede { margin-top: 7mm; font-family: var(--serif); font-size: 11.5pt; letter-spacing: 2px; color: var(--ink-soft); }
  .rh-word { margin-top: 1mm; font-family: var(--serif); font-size: 62pt; font-weight: 600; line-height: 1; letter-spacing: 1px; color: var(--ink); }
  .rh-word.long { font-size: 48pt; }
  .rh-badge { display: flex; align-items: baseline; gap: 5mm; margin-top: 3mm; font-size: 8pt; letter-spacing: 3px; color: var(--ink-faint); }
  .rh-badge .rh-en { color: var(--rhythm); font-weight: 600; letter-spacing: 4px; }
  .rh-badge .rh-share { font-family: var(--serif); font-size: 20pt; font-weight: 600; letter-spacing: 0; color: var(--rhythm); }
  .rh-mood { margin-top: 3mm; max-width: 150mm; font-family: var(--serif); font-size: 11pt; line-height: 1.9; letter-spacing: 1px; color: var(--ink-soft); }
  .rh-pulse { margin-top: 7mm; }
  .rh-pulse-head { display: flex; justify-content: space-between; align-items: baseline; }
  .rh-pulse-title { font-size: 7.5pt; font-weight: 600; letter-spacing: 4px; color: var(--rhythm); }
  .rh-pulse-note { font-size: 7.5pt; letter-spacing: 2px; color: var(--ink-faint); }
  .rh-pulse-note b { font-family: var(--serif); font-size: 11pt; font-weight: 600; color: var(--ink-soft); }
  .rh-pulse-svg { display: block; width: 100%; height: 34mm; margin-top: 1mm; overflow: visible; }
  .rh-pulse-floor { stroke: var(--hair); stroke-width: 1; vector-effect: non-scaling-stroke; }
  .rh-pulse-peak { stroke: var(--rhythm); stroke-width: 0.8; stroke-dasharray: 2 4; vector-effect: non-scaling-stroke; opacity: 0.55; }
  .rh-pulse-area { fill: url(#rh-fill); }
  .rh-fill-top { stop-color: var(--rhythm); stop-opacity: 0.28; }
  .rh-fill-bottom { stop-color: var(--rhythm); stop-opacity: 0; }
  .rh-pulse-line { fill: none; stroke: var(--rhythm); stroke-width: 2.2; stroke-linecap: round; stroke-linejoin: round; vector-effect: non-scaling-stroke; }
  .rh-pulse-dot { fill: var(--rhythm); }
  .rh-pulse-axis { display: flex; justify-content: space-between; margin-top: 1.5mm; color: var(--ink-faint); font-family: var(--mono); font-size: 6.5pt; }
  .rh-week { margin-top: 6mm; padding-top: 3mm; border-top: 0.25mm solid var(--hair); }
  .rh-week-title { font-size: 7.5pt; font-weight: 600; letter-spacing: 4px; color: var(--rhythm); }
  .rh-week-rows { margin-top: 2mm; display: flex; flex-direction: column; gap: 0.6mm; }
  .rh-week-row { display: flex; align-items: center; gap: 2mm; }
  .rh-weekday { width: 4mm; text-align: right; font-family: var(--serif); font-size: 7pt; color: var(--ink-faint); }
  .rh-cells { flex: 1; display: grid; grid-template-columns: repeat(24, 1fr); gap: 0.7mm; }
  .rh-cell { display: block; height: 2.3mm; border-radius: 0.3mm; background: transparent; outline: 0.18mm solid var(--hair); outline-offset: -0.18mm; }
  .rh-cell.rhythm { outline-color: color-mix(in srgb, var(--rhythm) 76%, transparent); }
  .rh-cell.is-1 { background: color-mix(in srgb, var(--rhythm) 16%, transparent); }
  .rh-cell.is-2 { background: color-mix(in srgb, var(--rhythm) 38%, transparent); }
  .rh-cell.is-3 { background: color-mix(in srgb, var(--rhythm) 66%, transparent); }
  .rh-cell.is-4 { background: var(--rhythm); outline: none; }
  .rh-body.night { --rhythm: #66509f; }
  .rh-body.us { --rhythm: #4c668b; }
  .rh-body.early { --rhythm: #ab6d34; }
  .rh-body.afternoon { --rhythm: #3f7b61; }
  .rh-body.dusk { --rhythm: #b55349; }
  @media (prefers-color-scheme: dark) {
    .rh-body.night { --rhythm: #c3aae6; }
    .rh-body.us { --rhythm: #9db8da; }
    .rh-body.early { --rhythm: #e5ad68; }
    .rh-body.afternoon { --rhythm: #7bc29e; }
    .rh-body.dusk { --rhythm: #e29990; }
    .rh-body { --rhythm: #e2bd79; }
  }
  /* 结尾页 */
  .end { text-align: center; }
  .end-line { font-family: var(--serif); font-size: 12pt; letter-spacing: 5px; color: var(--ink-muted); }
  .end-title { margin-top: 4mm; font-family: var(--serif); font-size: 52pt; font-weight: 600; letter-spacing: 4px; color: var(--ink); }
  .end-sub { margin-top: 8mm; font-family: var(--serif); font-size: 11.5pt; line-height: 2; color: var(--ink-soft); }
  /* 兜底页 */
  .title { margin-top: 6mm; font-family: var(--serif); font-size: 34pt; font-weight: 600; letter-spacing: 1px; color: var(--ink); }
  .desc { margin-top: 5mm; font-family: var(--serif); font-size: 11.5pt; line-height: 1.9; color: var(--ink-soft); }
  .note { margin-top: 12mm; padding-top: 5mm; border-top: 0.25mm solid var(--hair); font-size: 9pt; color: var(--ink-faint); }
  .foot {
    position: relative;
    z-index: 1;
    display: flex;
    justify-content: space-between;
    padding-top: 4mm;
    border-top: 0.25mm solid var(--hair);
    font-size: 7.5pt;
    letter-spacing: 2px;
    color: var(--ink-faint);
  }
`;

function slideOpen(ghost: string, ghostCenter = false): string {
  const ghostEl = ghost
    ? `<div class="ghost${ghostCenter ? ' center' : ''}">${escapeHtml(ghost)}</div>`
    : '';
  return `<section class="slide">${ghostEl}
    <div class="brand">
      <span class="brand-name">WEQ 年度报告</span>
      <span class="brand-tag">QQ CHAT WRAPPED</span>
    </div>
    <div class="body">`;
}

function slideFoot(right: string): string {
  return `</div>
    <div class="foot"><span>数据来自本机 QQ 聊天记录 · 私聊 + 群聊</span><span>${escapeHtml(right)}</span></div>
  </section>`;
}

function overviewSlide(data: Record<string, unknown>): string {
  const year = Number(data.year ?? 0);
  const totalSent = Number(data.totalSent ?? 0);
  const totalReceived = Number(data.totalReceived ?? 0);
  const c2cSent = Number(data.c2cSent ?? 0);
  const groupSent = Number(data.groupSent ?? 0);
  const sum = Math.max(1, c2cSent + groupSent);
  const c2cPct = Math.round((c2cSent / sum) * 100);
  const groupPct = 100 - c2cPct;
  // 日均分母由服务端下发（自然年整年 / 历史以来从首条消息算起），屏幕与导出同源。
  const perDay = totalSent / Math.max(1, Number(data.spanDays ?? 1));
  const echo = totalSent > 0 ? Math.round((totalReceived / totalSent) * 100) : 0;
  const firstMessageTime = typeof data.firstMessageTime === 'number' ? data.firstMessageTime : null;
  const since = reportSinceLabel(year, firstMessageTime);
  const eraLabel = reportEraLabel(year) + (since ? `（${since}）` : '');

  return `${slideOpen(isAllTimeYear(year) ? 'ALL' : String(year))}
    <div class="lede">${escapeHtml(eraLabel)}，你一共说出了</div>
    <div class="hero">
      <span class="hero-num">${fmt(totalSent)}</span>
      <span class="hero-unit">条消息</span>
    </div>
    <div class="rail">
      <div class="rail-track">
        <span class="rail-c2c" style="width:${c2cPct}%"></span>
        <span class="rail-group" style="width:${groupPct}%"></span>
      </div>
      <div class="rail-legend">
        <span class="rail-side">
          <span class="rail-pct">${c2cPct}%</span><span class="rail-name">私聊</span><span class="rail-count">${fmt(c2cSent)}</span>
        </span>
        <span class="rail-side right">
          <span class="rail-count">${fmt(groupSent)}</span><span class="rail-name">群聊</span><span class="rail-pct">${groupPct}%</span>
        </span>
      </div>
    </div>
    <div class="band">
      <div class="band-cell">
        <div class="band-dt">日均</div>
        <div class="band-dd"><span class="band-num">${formatPerDay(perDay)}</span><span class="band-unit">条</span></div>
      </div>
      <div class="band-cell">
        <div class="band-dt">收到</div>
        <div class="band-dd"><span class="band-num">${fmt(totalReceived)}</span><span class="band-unit">条</span></div>
      </div>
      <div class="band-cell">
        <div class="band-dt">你说 100 句，回声</div>
        <div class="band-dd"><span class="band-num">${fmt(echo)}</span><span class="band-unit">句</span></div>
      </div>
    </div>${slideFoot(`${reportPeriodLabel(year)} · 01`)}`;
}

/**
 * 装扮页的导出版。
 *
 * 屏幕上那一页的主角是**真实渲染的气泡贴图 + 头像挂件**，而导出产物必须自包含、
 * 离线可看 —— 九宫格 PNG 和挂件帧都在主进程的共享缓存里，`weq-media://` 协议在导出的
 * HTML 里解析不了，内联成 base64 又会让一份 A4 报告涨到几十 MB。
 *
 * 所以导出版换一套表达，但**换的是皮不是骨**：单位仍然是「一套」，主角仍然是最爱的
 * 那一身，回忆仍然是当年真说过的话 —— 只是气泡画不出来，改用排印的引号来盛。
 * 装扮编号一律不出现（屏幕版也不出现）：款名有就写，没有就只写话。
 */
function dressSlide(data: Record<string, unknown>): string {
  const year = Number(data.year ?? 0);
  const decorated = Number(data.decorated ?? 0);
  const totalSent = Number(data.totalSent ?? 0);
  const coverage = totalSent > 0 ? Math.round((decorated / totalSent) * 100) : 0;

  type Outfit = {
    key: string;
    count: number;
    samples: string[];
    bubbleName: string;
    fontName: string;
    widgetName: string;
  };
  const outfits = (data.outfits ?? []) as Outfit[];
  const hero = outfits[0];
  // 「换过几身」读服务端下发的总数：`outfits` 有 JSON 体积护栏，会被截断。
  const outfitCount = Number(data.outfitCount ?? outfits.length);
  const kinds = [
    ['气泡', Number((data.bubble as { distinct?: number } | undefined)?.distinct ?? 0)],
    ['字体', Number((data.font as { distinct?: number } | undefined)?.distinct ?? 0)],
    ['挂件', Number((data.widget as { distinct?: number } | undefined)?.distinct ?? 0)],
  ] as const;

  /** 那套的三件款名连成一行。都没记过元数据就是空串，整行不出现。 */
  const wornAs = (outfit: Outfit): string =>
    [
      outfit.bubbleName && `气泡「${outfit.bubbleName}」`,
      outfit.fontName && `字体「${outfit.fontName}」`,
      outfit.widgetName && `挂件「${outfit.widgetName}」`,
    ]
      .filter(Boolean)
      .join(' · ');

  const heroLine = hero
    ? hero.samples.reduce((best, s) => (s.length > best.length ? s : best), '')
    : '';

  return `${slideOpen(isAllTimeYear(year) ? 'ALL' : String(year))}
    <div class="lede">${escapeHtml(reportEraLabel(year))}，我最爱这身装扮</div>
    ${
      hero
        ? `<div class="dr-top">
             ${heroLine ? `<div class="dr-say">${escapeHtml(heroLine)}</div>` : ''}
             <div class="hero"><span class="hero-num">${fmt(hero.count)}</span><span class="hero-unit">条消息使用这身装扮</span></div>
             ${wornAs(hero) ? `<div class="dr-worn">${escapeHtml(wornAs(hero))}</div>` : ''}
           </div>`
        : ''
    }
    <div class="dr-sum">总共换过 ${fmt(outfitCount)} 身，打扮了 ${fmt(decorated)} 条消息${
      coverage > 0 ? `（占你发言的 ${coverage}%）` : ''
    }</div>
    <div class="dr-kinds">${kinds
      .filter(([, n]) => n > 0)
      .map(([label, n]) => `<span>${label} ${fmt(n)} 款</span>`)
      .join('')}</div>
    ${slideFoot(`${reportPeriodLabel(year)} · DRESS`)}`;
}

/**
 * 私聊火花页的导出版。屏幕版中间的绿墙可以在「历史以来」口径下逐年切换；
 * 导出是静态的，所以固定渲染服务端下发的默认墙年（自然年 = 该年，历史以来 =
 * 最近一个有私聊发言的年份），正文和巨数口径不变。
 */
function sparkSlide(data: Record<string, unknown>): string {
  const year = Number(data.year ?? 0);
  const top = (data.topDay ?? null) as {
    year: number;
    month: number;
    day: number;
    peerName: string;
    total: number;
    mine: number;
    words: string[];
  } | null;
  const wallYear = Number(data.wallYear ?? year);
  const wallDays = (data.wallDays ?? []) as Array<{
    year: number;
    month: number;
    day: number;
    count: number;
  }>;
  const spark = (data.spark ?? null) as {
    days: number;
    peerName: string;
  } | null;
  const sentTotal = Number(data.sentTotal ?? 0);
  const activeDays = Number(data.activeDays ?? 0);
  const longestSelfRun = Number(data.longestSelfRun ?? 0);
  const wall = wallDays.filter((day) => day.year === wallYear);

  const hero =
    top == null
      ? ''
      : `
    <div class="sp-kicker">
      <span>${escapeHtml(isAllTimeYear(year) ? '历史以来' : `${year} 年`)} · 全部私聊里最用力的一天</span>
      <span class="sp-kicker-date">${top.year} 年 ${top.month} 月 ${top.day} 日</span>
    </div>
    <div class="sp-say">你和 <b>${escapeHtml(top.peerName)}</b></div>
    <div class="sp-hero">
      <span class="sp-hero-num">${fmt(top.total)}</span>
      <span class="sp-hero-unit">条消息</span>
    </div>
    ${
      top.words?.[0]
        ? `<div class="sp-wordline"><span>那天你们说得最多的，是</span><b class="sp-wordline-word">${escapeHtml(top.words[0])}</b></div>`
        : ''
    }`;

  const bands = [
    { label: '私聊发出', value: fmt(sentTotal), unit: '条' },
    { label: '开口天数', value: fmt(activeDays), unit: '天' },
    { label: '最长连续发言', value: fmt(longestSelfRun), unit: '天' },
    {
      label: '最长火花',
      value: fmt(spark?.days ?? 0),
      unit: '天',
      note: spark?.peerName ?? '还没有双向的火花',
    },
  ];

  return `${slideOpen(isAllTimeYear(year) ? 'ALL' : String(year))}
    ${hero}
    <div class="sp-wall">
      <div class="sp-wall-head">
        <span class="sp-wall-title">${wallYear} 年</span>
        <span class="sp-wall-sub">我发出的私聊</span>
      </div>
      ${exportWall(wallYear, wall)}
    </div>
    <div class="sp-band">
      ${bands
        .map(
          (band) => `
        <div class="sp-cell-band">
          <div class="sp-dt">${escapeHtml(band.label)}</div>
          <div class="sp-dd"><span class="sp-num">${band.value}</span><span class="sp-unit">${band.unit}</span></div>
          ${band.note ? `<div class="sp-note">${escapeHtml(band.note)}</div>` : ''}
        </div>`,
        )
        .join('')}
    </div>${slideFoot(`${reportPeriodLabel(year)} · SPARK`)}`;
}

/** GitHub 绿墙的静态 HTML：一周一列、一列七格，颜色 = 当天自己发出的条数。 */
function exportWall(
  year: number,
  days: Array<{ month: number; day: number; count: number }>,
): string {
  const countByDay = new Map<string, number>();
  for (const day of days) countByDay.set(`${day.month}-${day.day}`, day.count);
  const start = new Date(year, 0, 1);
  const mondayOffset = (start.getDay() + 6) % 7;
  const leap = (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0;
  const totalDays = leap ? 366 : 365;
  const weekCount = Math.ceil((mondayOffset + totalDays) / 7);
  const counts = [...countByDay.values()];
  const maxCount = counts.length ? Math.max(...counts) : 1;
  const columns: string[] = [];

  for (let week = 0; week < weekCount; week++) {
    let column = '<div class="sp-col">';
    for (let dow = 0; dow < 7; dow++) {
      const dayOfYear = week * 7 + dow - mondayOffset;
      if (dayOfYear < 0 || dayOfYear >= totalDays) {
        column += '<span class="sp-cell is-0"></span>';
      } else {
        const date = new Date(year, 0, 1 + dayOfYear);
        const count = countByDay.get(`${date.getMonth() + 1}-${date.getDate()}`) ?? 0;
        const level = count === 0 ? 0 : Math.min(4, 1 + Math.ceil((count / maxCount) * 3));
        column += `<span class="sp-cell is-${level}"></span>`;
      }
    }
    column += '</div>';
    columns.push(column);
  }
  return `<div class="sp-cols">${columns.join('')}</div>`;
}

/**
 * 好友榜页的导出版。
 *
 * 头像在自包含产物里画不出来（`weq-media://` 解析不了，内联 base64 会让一份 A4
 * 报告涨好几 MB），所以一律去脸。但**两幕的形状必须保留**：火花是横向引线、
 * 消息量是纵向柱阵 —— 那是这一页区别于其它页的全部理由，只留数字就等于把这页
 * 退化成一张表。静态产物没有动画，引线和柱子直接画在终态。
 */
function friendsSlide(data: Record<string, unknown>): string {
  const year = Number(data.year ?? 0);
  type Entry = { peerName: string; value: number; messages: number };
  const sparkTop = (data.sparkTop ?? []) as Entry[];
  const messageTop = (data.messageTop ?? []) as Entry[];
  const friendCount = Number(data.friendCount ?? 0);
  const totalMessages = Number(data.totalMessages ?? 0);

  /** 幕头：幕名 + 副题。色调由外层 `.fr-board.spark` / `.msg` 的 --tone 决定。 */
  const head = (eyebrow: string, sub: string): string =>
    `<div class="fr-head"><span class="fr-eyebrow">${escapeHtml(eyebrow)}</span><span class="fr-sub">${escapeHtml(sub)}</span></div>`;

  /** 以冠军为满格的百分比，与屏幕版同一个下限（4%）。 */
  const ratio = (value: number, top: number): number =>
    Math.max(4, Math.round((value / Math.max(1, top)) * 100));

  // ── 第一幕：横向引线 ──
  const champSpark = sparkTop[0];
  const fuse = champSpark
    ? `<div class="fr-fuse-head">
         <div class="fr-fuse-who">
           <span class="fr-fuse-name">${escapeHtml(champSpark.peerName)}</span>
           <span class="fr-fuse-msgs">${fmt(champSpark.messages)} 条私聊</span>
         </div>
         <div class="fr-fuse-val">
           <span class="fr-num fr-fuse-num">${fmt(champSpark.value)}</span>
           <span class="fr-fuse-unit">天</span>
         </div>
       </div>
       <div class="fr-fuse-track">
         <span class="fr-fuse-burn" style="width:100%"><span class="fr-fuse-ember"></span></span>
       </div>
       ${sparkTop
         .slice(1)
         .map(
           (entry, index) => `<div class="fr-fuse-runner">
             <span class="fr-fuse-rank">0${index + 2}</span>
             <span class="fr-fuse-rname">${escapeHtml(entry.peerName)}</span>
             <span class="fr-fuse-rtrack"><span style="width:${ratio(entry.value, champSpark.value)}%"></span></span>
             <span class="fr-fuse-rnum">${fmt(entry.value)}</span>
             <span class="fr-fuse-runit">天</span>
           </div>`,
         )
         .join('')}`
    : '<div class="fr-empty">还没有连续两天都互相说话的人</div>';

  // ── 第二幕：纵向柱阵（前八名）。最高柱 30mm，最矮也留 3mm。 ──
  const champMsg = messageTop[0];
  const vol = champMsg
    ? `<div class="fr-vol">
         <div class="fr-vol-champ">
           <div class="fr-vol-row">
             <span class="fr-num fr-vol-num">${fmt(champMsg.value)}</span>
             <span class="fr-vol-unit">条</span>
           </div>
           <div class="fr-vol-name">${escapeHtml(champMsg.peerName)}</div>
         </div>
         <div class="fr-stacks">
           ${messageTop
             .map((entry, index) => {
               const h = Math.max(
                 3,
                 Math.round((entry.value / Math.max(1, champMsg.value)) * 30 * 10) / 10,
               );
               return `<div class="fr-stack${index === 0 ? ' champ' : ''}">
                 <span class="fr-stack-val"><b>${fmt(entry.value)}</b><i>条</i></span>
                 <span class="fr-stack-bar" style="height:${h}mm"></span>
                 <span class="fr-stack-name">${escapeHtml(entry.peerName)}</span>
               </div>`;
             })
             .join('')}
         </div>
       </div>`
    : '<div class="fr-empty">还没有双向来往的私聊</div>';

  return `${slideOpen(isAllTimeYear(year) ? 'ALL' : String(year))}
    <div class="fr-kicker">
      <span>${escapeHtml(reportEraLabel(year))} · 和你来往最深的人</span>
      <span class="fr-kicker-meta">${fmt(friendCount)} 位好友 / ${fmt(totalMessages)} 条私聊</span>
    </div>
    <div class="fr-board spark">
      ${head('最长火花', '连着多少天，你们谁都没有断')}
      ${fuse}
    </div>
    <div class="fr-board msg">
      ${head('聊得最多', '这段时间里，你们一共说了这么多')}
      ${vol}
    </div>
    ${slideFoot(`${reportPeriodLabel(year)} · FRIENDS`)}`;
}

/**
 * 谁先开口页的导出版。屏幕版的主角是巨数 + 一句裁决、轨上的星标自己会滑；
 * 静态产物里星标直接落在最终位置 —— 它把「主动」画成一枚指向 TA / 我之间的
 * 光点，数字和句子都只是这枚光点的注脚。
 */
function openersSlide(data: Record<string, unknown>): string {
  const year = Number(data.year ?? 0);
  const allTime = isAllTimeYear(year);
  const peerCount = Number(data.peerCount ?? 0);
  const totalStarts = Number(data.totalStarts ?? 0);
  const selfStarts = Number(data.selfStarts ?? 0);
  const peerStarts = Number(data.peerStarts ?? 0);
  const selfPct = Math.round(Number(data.selfRatio ?? 0) * 100);
  const mood =
    selfPct >= 60
      ? '原来，你总是那个先想到别人的人。'
      : selfPct <= 40
        ? '原来，有人总比你先想到你。'
        : '原来，你们总在差不多的时候，想起彼此。';

  type CastRole = { kind: 'mine' | 'peer' | 'balanced'; entry: Record<string, unknown> | null };
  const mostMine = (data.mostMine ?? null) as Record<string, unknown> | null;
  const mostPeer = (data.mostPeer ?? null) as Record<string, unknown> | null;
  const balanced = (data.balanced ?? null) as Record<string, unknown> | null;
  const cast: CastRole[] = [];
  const seen = new Set<string>();
  const push = (kind: CastRole['kind'], entry: Record<string, unknown> | null): void => {
    const uid = entry?.peerUid ? String(entry.peerUid) : '';
    if (entry && !seen.has(uid)) {
      seen.add(uid);
      cast.push({ kind, entry });
    }
  };
  if (selfPct >= 55) {
    push('mine', mostMine);
    push('balanced', balanced);
    push('peer', mostPeer);
  } else if (selfPct <= 45) {
    push('peer', mostPeer);
    push('balanced', balanced);
    push('mine', mostMine);
  } else {
    push('balanced', balanced);
    push('mine', mostMine);
    push('peer', mostPeer);
  }

  const line = (role: CastRole): string => {
    const entry = role.entry as {
      peerName: string;
      selfStarts: number;
      peerStarts: number;
      totalStarts: number;
    };
    const roleLabel =
      role.kind === 'mine'
        ? '你发起占比最高'
        : role.kind === 'peer'
          ? 'TA 发起占比最高'
          : '最接近 50%';
    if (role.kind === 'mine') {
      const minePct = Math.round((entry.selfStarts / entry.totalStarts) * 100);
      return `<span class="op-line-role">${roleLabel}</span><span class="op-line-dot">·</span><em>${escapeHtml(
        entry.peerName,
      )}</em>，这 ${fmt(entry.totalStarts)} 场里你先发起 ${fmt(entry.selfStarts)} 次（发起率 ${minePct}%）—— 是你一直在把 TA 找回来。`;
    }
    if (role.kind === 'peer') {
      const peerPct = Math.round((entry.peerStarts / entry.totalStarts) * 100);
      return `<span class="op-line-role">${roleLabel}</span><span class="op-line-dot">·</span><em>${escapeHtml(
        entry.peerName,
      )}</em>，这 ${fmt(entry.totalStarts)} 场里 TA 先发起 ${fmt(entry.peerStarts)} 次（发起率 ${peerPct}%）—— 有人总比你早一步想你。`;
    }
    const minePct = Math.round((entry.selfStarts / entry.totalStarts) * 100);
    const peerPct = 100 - minePct;
    return `<span class="op-line-role">${roleLabel}</span><span class="op-line-dot">·</span><em>${escapeHtml(
      entry.peerName,
    )}</em>，开场 ${fmt(entry.selfStarts)} : ${fmt(
      entry.peerStarts,
    )}，发起率 ${minePct}% : ${peerPct}% —— 谁先想起谁，都不算抢先。`;
  };

  return `${slideOpen(allTime ? 'ALL' : String(year))}
    <div class="op-kicker">
      <span>${escapeHtml(reportEraLabel(year))} · 谁先开口</span>
      <span class="op-kicker-meta">${fmt(peerCount)} 位朋友 / ${fmt(totalStarts)} 场开场</span>
    </div>
    <div class="op-lede">${allTime ? '有记录以来' : '这一年'}你一共发起了 <b>${fmt(
      selfStarts,
    )}</b> 场聊天，占全部开场的</div>
    <div class="op-punch">
      <span class="op-num">${selfPct}</span>
      <span class="op-unit">%</span>
      <span class="op-word">是你先开口</span>
    </div>
    <div class="op-mood">${escapeHtml(mood)}</div>
    <div class="op-beam">
      <span class="op-side"><span>TA 先开口 </span><b>${fmt(peerStarts)}</b></span>
      <div class="op-track">
        <span class="op-half-peer"></span>
        <span class="op-half-mine"></span>
        <span class="op-mid"></span>
        <span class="op-dot" style="left:${selfPct}%"></span>
      </div>
      <span class="op-side"><b>${fmt(selfStarts)}</b><span> 我先开口</span></span>
    </div>
    ${
      cast.length > 0
        ? `<div class="op-tales">
             <div class="op-tales-in">而这几位朋友，把「先开口」写成了不同的样子</div>
             ${cast.map((role) => `<p class="op-line">${line(role)}</p>`).join('')}
           </div>`
        : ''
    }
    ${slideFoot(`${reportPeriodLabel(year)} · OPENERS`)}`;
}

/** 作息页的导出版。动画在静态产物里没有，所以曲线直接落终态、墙面满色。 */
function rhythmSlide(data: Record<string, unknown>): string {
  const year = Number(data.year ?? 0);
  const allTime = isAllTimeYear(year);
  const sentTotal = Number(data.sentTotal ?? 0);
  const activeHours = Number(data.activeHours ?? 0);
  const peakHour = Number(data.peakHour ?? 0);
  const peakCount = Number(data.peakCount ?? 0);
  const label = (data.label ?? {}) as {
    kind?: string;
    word?: string;
    english?: string;
    span?: string;
  };
  const kind = String(label.kind ?? 'all');
  const word = String(label.word ?? '随缘上线');
  const english = String(label.english ?? 'WHENEVER');
  const span = String(label.span ?? '00:00 – 24:00');
  const hourly = (data.hourly ?? []) as number[];
  const matrix = (data.weekdayHourly ?? []) as number[][];
  const windows = (data.windows ?? []) as Array<Record<string, unknown>>;
  const main = windows.find((window) => String(window.kind) === kind) ?? null;
  const mainPct = main ? Math.round(Number(main.share ?? 0) * 100) : 0;
  const mood = exportRhythmMood({
    allTime,
    year,
    label: { kind, word, span },
    mainKind: kind,
    mainPct,
    peakHour,
    activeHours,
  });

  return `${slideOpen('24h')}
    <div class="rh-body ${escapeHtml(kind)}">
      <div class="rh-kicker">
        <span>${escapeHtml(reportEraLabel(year))} · 我的作息</span>
        <span class="rh-kicker-meta"><b>${fmt(sentTotal)}</b> 条发言 / 一天 <b>${activeHours}</b> 个小时在线</span>
      </div>
      <div class="rh-lede">${allTime ? '有记录以来' : `${year} 年`}，你的话有它自己的时区——</div>
      <h2 class="rh-word${word.length >= 4 ? ' long' : ''}">${escapeHtml(word)}</h2>
      <div class="rh-badge">
        <span class="rh-en">${escapeHtml(english)}</span>
        <span>${escapeHtml(span)}</span>
        ${main ? `<span class="rh-share">${mainPct}%</span>` : ''}
      </div>
      <p class="rh-mood">${escapeHtml(mood)}</p>
      <div class="rh-pulse">
        <div class="rh-pulse-head">
          <span class="rh-pulse-title">一天的心率</span>
          <span class="rh-pulse-note"><b>${String(peakHour).padStart(2, '0')}:00</b> · ${fmt(
            peakCount,
          )} 条</span>
        </div>
        ${exportPulse(hourly, peakHour)}
      </div>
      <div class="rh-week">
        <span class="rh-week-title">一周 · 7×24</span>
        ${exportRhythmWeek(matrix, kind)}
      </div>
    </div>${slideFoot(`${reportPeriodLabel(year)} · RHYTHM`)}`;
}

/** 静态 SVG 曲线。坐标与屏幕版同一套 Catmull-Rom 平滑。 */
function exportPulse(hourly: number[], peakHour: number): string {
  const W = 800;
  const H = 220;
  const top = 14;
  const bottom = 12;
  const max = Math.max(1, ...hourly);
  const xs = (hour: number): number => (hour / 23) * W;
  const ys = (count: number): number => H - bottom - (count / max) * (H - top - bottom);
  const points = hourly.map((count, hour) => [xs(hour), ys(count)] as const);
  const smooth = smoothExportPath(points);
  const line = `M ${smooth}`;
  const area = `M 0 ${H - bottom} L 0 ${ys(hourly[0] ?? 0)} ${smooth} L ${W} ${H - bottom} Z`;
  const peakX = xs(peakHour);
  const peakY = ys(hourly[peakHour] ?? 0);
  return `<svg class="rh-pulse-svg" viewBox="0 0 ${W} ${H}" preserveAspectRatio="none" role="img" aria-label="一天 24 小时发出的消息曲线">
      <defs>
        <linearGradient id="rh-fill" x1="0" y1="0" x2="0" y2="1">
          <stop class="rh-fill-top" offset="0%" />
          <stop class="rh-fill-bottom" offset="100%" />
        </linearGradient>
      </defs>
      <line class="rh-pulse-floor" x1="0" y1="${H - 1}" x2="${W}" y2="${H - 1}" />
      <line class="rh-pulse-peak" x1="${peakX}" y1="${top}" x2="${peakX}" y2="${H - bottom}" />
      <path class="rh-pulse-area" d="${area}" />
      <path class="rh-pulse-line" d="${line}" />
      <circle class="rh-pulse-dot" cx="${peakX}" cy="${peakY}" r="6" />
    </svg>
    <div class="rh-pulse-axis"><span>00</span><span>06</span><span>12</span><span>18</span><span>24</span></div>`;
}

function smoothExportPath(points: ReadonlyArray<readonly [number, number]>): string {
  if (points.length === 0) return '';
  if (points.length === 1) return `${points[0]![0]} ${points[0]![1]}`;
  let d = `${points[0]![0]} ${points[0]![1]}`;
  for (let i = 0; i < points.length - 1; i++) {
    const p0 = points[Math.max(0, i - 1)]!;
    const p1 = points[i]!;
    const p2 = points[i + 1]!;
    const p3 = points[Math.min(points.length - 1, i + 2)]!;
    d += ` C ${p1[0] + (p2[0] - p0[0]) / 6} ${p1[1] + (p2[1] - p0[1]) / 6}, ${
      p2[0] - (p3[0] - p1[0]) / 6
    } ${p2[1] - (p3[1] - p1[1]) / 6}, ${p2[0]} ${p2[1]}`;
  }
  return d;
}

function exportRhythmWeek(matrix: number[][], kind: string): string {
  const max = Math.max(1, ...matrix.flat().map((count) => Number(count || 0)));
  const names: Record<number, string> = {
    0: '日',
    1: '一',
    2: '二',
    3: '三',
    4: '四',
    5: '五',
    6: '六',
  };
  const rows = [1, 2, 3, 4, 5, 6, 0];
  const rowHtml = rows
    .map(
      (dow) => `<div class="rh-week-row">
          <span class="rh-weekday">${names[dow]}</span>
          <div class="rh-cells">
            ${Array.from({ length: 24 }, (_, hour) => {
              const count = Number(matrix[dow]?.[hour] ?? 0);
              const level = count === 0 ? 0 : Math.min(4, 1 + Math.ceil((count / max) * 3));
              const rhythm = kind !== 'all' && exportInWindow(kind, hour);
              return `<i class="rh-cell is-${level}${rhythm ? ' rhythm' : ''}"></i>`;
            }).join('')}
          </div>
        </div>`,
    )
    .join('');
  return `<div class="rh-week-rows">${rowHtml}</div>`;
}

function exportInWindow(kind: string, hour: number): boolean {
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
    default:
      return false;
  }
}

/** 与屏幕版同源的煽情句。 */
function exportRhythmMood(input: {
  allTime: boolean;
  year: number;
  label: { kind: string; word: string; span: string };
  mainKind: string;
  mainPct: number;
  peakHour: number;
  activeHours: number;
}): string {
  const peak = `${String(input.peakHour).padStart(2, '0')}:00`;
  if (input.mainKind === 'night') {
    return `深夜 ${input.label.span.replace('–', '到')} 的发言占全天的 ${input.mainPct}%。别人按下晚安，你的话才刚说到一半；最醒着的那一小时，是 ${peak}。`;
  }
  if (input.mainKind === 'us') {
    return `凌晨 ${input.label.span.replace('–', '到')} 占了全天的 ${input.mainPct}%：那时你还在线，像隔着十二个小时时差，给还没睡的人留了一句言。`;
  }
  if (input.mainKind === 'early') {
    return `上午 ${input.label.span.replace('–', '到')} 就贡献了全天的 ${input.mainPct}%：天亮不久，你的消息已经把一天叫醒了，${peak} 是最忙的那一小时。`;
  }
  if (input.mainKind === 'afternoon') {
    return `午后 ${input.label.span.replace('–', '到')} 的 ${input.mainPct}% 发言是每天的续航：困意压不住话匣子，${peak} 前后的对话框最热闹。`;
  }
  if (input.mainKind === 'dusk') {
    return `黄昏 ${input.label.span.replace('–', '到')} 的发言占全天的 ${input.mainPct}%：下班、放学、吃完饭，所有人都上线了，${peak} 是这一天的社交高光。`;
  }
  return `你的一天没有固定的分时区，${input.activeHours}/24 个小时都可能说话；出现得最勤的是 ${peak}，但你的「收到」从来不挑时间。`;
}

function endSlide(data: Record<string, unknown>): string {
  const year = Number(data.year ?? 0);
  const allTime = isAllTimeYear(year);
  return `${slideOpen('FIN', true)}
    <div class="end">
      <div class="end-line">${allTime ? '你说过的话，都在这里了。' : '这一年的话都说完了。'}</div>
      <div class="end-title">辛苦了</div>
      <div class="end-sub">聊天记录只留在这台电脑上。<br>${
        allTime ? '往后的话，也还长。' : '明年这个时候，我们再看一次。'
      }</div>
    </div>${slideFoot(`${reportPeriodLabel(year)} · FIN`)}`;
}

function genericSlide(slide: ExportSlide): string {
  return `${slideOpen(slide.page.category)}
    <div class="eyebrow">${escapeHtml(slide.page.category)}</div>
    <div class="title">${escapeHtml(slide.page.title)}</div>
    <div class="desc">${escapeHtml(slide.page.description)}</div>
    <div class="note">这张卡片的数据暂未适配导出视图，导出里只保留标题。</div>${slideFoot(slide.page.id)}`;
}

/**
 * 由已加载的页面数据拼出自包含 HTML 文档。口径文案（历史以来 / xxxx 年）
 * 由每页数据里的 `year` 自证，与屏幕版共用 `@weq/service/report-time`。
 */
export function buildReportHtml(year: number, slides: ExportSlide[]): string {
  const body = slides
    .map((slide) => {
      const data = (slide.data ?? {}) as Record<string, unknown>;
      if (slide.page.id === 'overview') return overviewSlide(data);
      if (slide.page.id === 'dress') return dressSlide(data);
      if (slide.page.id === 'spark') return sparkSlide(data);
      if (slide.page.id === 'friends') return friendsSlide(data);
      if (slide.page.id === 'openers') return openersSlide(data);
      if (slide.page.id === 'rhythm') return rhythmSlide(data);
      if (slide.page.id === 'end') return endSlide(data);
      return genericSlide(slide);
    })
    .join('\n');
  return `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(reportPeriodLabel(year))} 年度报告</title>
<style>${CSS}</style>
</head>
<body>
${body}
</body>
</html>`;
}
