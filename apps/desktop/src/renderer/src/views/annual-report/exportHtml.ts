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
import { mediaUrl } from '../../lib/resourceUrl';

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
  /* 头像（导出预热版）：真脸 img / 首字圆牌共用同一形状语言。 */
  .avatar {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    border-radius: 50%;
    object-fit: cover;
    background: var(--paper-deep);
    outline: 0.25mm solid var(--hair);
    outline-offset: -0.25mm;
    font-family: var(--serif);
    color: var(--ink);
    flex: 0 0 auto;
  }
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
  /* 装扮页。预热成功的导出画真实九宫格气泡（border-image，同屏幕版几何），
     失败/未预热时退回排印引号（.dr-say）—— 两种表达都不会破版。 */
  .dr-top { margin-top: 4mm; padding-bottom: 6mm; border-bottom: 0.25mm solid var(--hair); }
  .dr-bubble {
    display: inline-block;
    align-self: flex-start;
    max-width: 150mm;
    padding: 8mm 10mm;
    border-style: solid;
    border-width: 0;
    border-image-slice: 48 48 48 48 fill;
    border-image-width: 8mm 8mm 8mm 8mm;
    border-image-repeat: stretch;
    font-family: var(--serif);
    font-size: 17pt;
    line-height: 1.55;
    letter-spacing: 1px;
    color: #16130d;
    word-break: break-word;
  }
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
  .fr-fuse-who { display: flex; flex-direction: column; position: relative; padding-left: 16mm; }
  .fr-fuse-who .avatar.fr-face-lg { position: absolute; left: 0; top: 50%; width: 13mm; height: 13mm; margin-top: -6.5mm; font-size: 6mm; }
  .fr-stack .avatar.fr-face-stack { width: 8mm; height: 8mm; font-size: 4mm; }
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
  .op-line { margin-top: 3.5mm; font-family: var(--serif); font-size: 11pt; line-height: 1.75; letter-spacing: 1px; color: var(--ink-soft); }
  .op-line .avatar.op-face { width: 11mm; height: 11mm; margin-right: 3mm; vertical-align: middle; }
  .op-line-say { display: inline; }
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
  /* 我的话页。导出版画不了真实表情贴图（weq-asset / weq-media 不自包含），
     所以系统表情和自定义表情都退回排印：只保留名字与次数，表情的「画面感」
     只属于屏幕版。主角仍是那句说熟了的词——静态产物里它是整页的视觉重心。 */
  .vc { flex: 1; display: flex; flex-direction: column; justify-content: center; text-align: center; }
  .vc-kicker { display: flex; justify-content: space-between; align-items: baseline; text-align: left; font-size: 8pt; letter-spacing: 3px; color: var(--ink-soft); }
  .vc-kicker-meta { font-size: 7.5pt; letter-spacing: 2px; color: var(--ink-faint); }
  .vc-kicker-meta b { font-family: var(--serif); font-size: 10pt; font-weight: 600; color: var(--ink-soft); }
  .vc-lede { margin-top: 12mm; font-family: var(--serif); font-size: 11.5pt; letter-spacing: 3px; color: var(--ink-soft); }
  .vc-word { margin-top: 1mm; font-family: var(--serif); font-size: 86pt; font-weight: 600; line-height: 1.05; letter-spacing: -2px; color: var(--ink); }
  .vc-word.long { font-size: 62pt; letter-spacing: 1px; }
  .vc-count { display: flex; justify-content: center; align-items: center; gap: 5mm; margin-top: 2mm; font-family: var(--serif); font-size: 10.5pt; letter-spacing: 3px; color: var(--voice); }
  .vc-count b { margin: 0 1mm; font-family: var(--serif); font-size: 15pt; font-weight: 600; color: var(--ink); }
  .vc-count i { display: inline-block; width: 14mm; height: 0.25mm; background: color-mix(in srgb, var(--voice) 58%, transparent); }
  .vc-faves { margin-top: 12mm; padding-top: 4mm; border-top: 0.25mm solid var(--hair); }
  .vc-faves-in { font-size: 8pt; letter-spacing: 5px; color: var(--ink-faint); }
  .vc-faves-row { display: flex; justify-content: center; gap: 16mm; margin-top: 7mm; }
  /* 系统表情文字榜：第一名字最大，老朋友顺位缩小。 */
  .vc-faceband { display: flex; align-items: center; gap: 7mm; }
  .vc-faceband-tag {
    writing-mode: vertical-rl;
    font-size: 8pt;
    font-weight: 600;
    letter-spacing: 4px;
    color: var(--voice);
  }
  .vc-face-tiles { display: flex; align-items: flex-end; gap: 13mm; }
  .vc-face-tiles .vc-fave { min-width: 0; }
  .vc-face .vc-fave-name { line-height: 1; }
  .vc-face.rank-0 .vc-fave-name { font-size: 34pt; }
  .vc-face.rank-1 .vc-fave-name { font-size: 25pt; }
  .vc-face.rank-2 .vc-fave-name { font-size: 20pt; }
  .vc-face.rank-3 .vc-fave-name { font-size: 17pt; }
  .vc-face.rank-0 .vc-fave-count { font-size: 9pt; }
  .vc-faves-sep { width: 0.25mm; height: 30mm; background: var(--hair); }
  .vc-fave { display: flex; flex-direction: column; align-items: center; gap: 2mm; }
  .vc-fave-label { font-size: 7.5pt; font-weight: 600; letter-spacing: 4px; color: var(--voice); }
  .vc-fave-name { font-family: var(--serif); font-size: 16pt; font-weight: 600; letter-spacing: 2px; color: var(--ink); }
  .vc-fave-count { font-family: var(--mono); font-size: 8pt; letter-spacing: 1px; color: var(--ink-faint); }
  .vc-fave-count b { font-family: var(--serif); font-size: 13pt; font-weight: 600; color: var(--voice); }
  .vc-mood { margin: 12mm auto 0; max-width: 150mm; font-family: var(--serif); font-size: 11pt; line-height: 2; letter-spacing: 2px; color: var(--ink-soft); }
  .vc { --voice: #9a4f3a; }
  @media (prefers-color-scheme: dark) {
    .vc { --voice: #e0a878; }
  }
  /* 我的主场页。静态产物画不了漂动的背景词云，所以让「群名 + 巨数」占据
     整页的视觉重心；等级 / 头衔只在页底签成一行小签名，五颗话题词收成
     一句可读的话 —— 换皮不换骨。 */
  .hm { flex: 1; display: flex; flex-direction: column; justify-content: center; text-align: center; }
  .hm { --home: #9a6b21; }
  .hm-kicker { display: flex; justify-content: space-between; align-items: baseline; text-align: left; font-size: 8pt; letter-spacing: 3px; color: var(--ink-soft); }
  .hm-kicker-meta { font-size: 7.5pt; letter-spacing: 2px; color: var(--ink-faint); }
  .hm-kicker-meta b { font-family: var(--serif); font-size: 10pt; font-weight: 600; color: var(--ink-soft); }
  .hm-lede { margin-top: 14mm; font-family: var(--serif); font-size: 12pt; letter-spacing: 3px; color: var(--ink-soft); }
  .hm-name { margin-top: 2mm; font-family: var(--serif); font-size: 58pt; font-weight: 600; line-height: 1.08; letter-spacing: -1px; color: var(--ink); white-space: nowrap; }
  .hm-name.long { font-size: 42pt; letter-spacing: 1px; }
  .hm-name.xl { font-size: 32pt; letter-spacing: 1px; }
  .hm-countline { display: flex; justify-content: center; align-items: baseline; gap: 4mm; margin-top: 1mm; }
  .hm-count { font-family: var(--serif); font-size: 94pt; font-weight: 600; letter-spacing: -3px; color: var(--home); line-height: 1.05; }
  .hm-unit { display: flex; flex-direction: column; gap: 1mm; font-family: var(--serif); color: var(--ink); line-height: 1; }
  .hm-unit b { font-size: 14pt; font-weight: 600; letter-spacing: 1px; }
  .hm-unit i { font-size: 7pt; font-style: normal; letter-spacing: 4px; color: var(--ink-muted); }
  .hm-share { display: flex; justify-content: center; align-items: center; gap: 3mm; margin-top: 2mm; font-family: var(--serif); font-size: 9.5pt; letter-spacing: 3px; color: var(--ink-soft); }
  .hm-share i { display: inline-block; width: 8mm; height: 0.25mm; background: color-mix(in srgb, var(--home) 60%, transparent); }
  .hm-sig { display: flex; justify-content: center; margin-top: 9mm; padding-top: 3mm; border-top: 0.25mm solid var(--hair); }
  .hm-sig-item { display: flex; align-items: baseline; gap: 2mm; }
  .hm-sig-item + .hm-sig-item { margin-left: 7mm; padding-left: 7mm; border-left: 0.25mm solid var(--hair); }
  .hm-sig-item i { font-size: 7pt; font-weight: 600; letter-spacing: 4px; color: var(--ink-faint); }
  .hm-sig-item b { font-family: var(--serif); font-size: 15pt; font-weight: 600; color: var(--ink); }
  .hm-sig-item em { font-family: var(--serif); font-size: 9pt; color: var(--home); }
  .hm-topics { margin-top: 10mm; }
  .hm-topics-in { font-size: 7.5pt; letter-spacing: 5px; color: var(--ink-faint); }
  .hm-topics-words { display: flex; justify-content: center; align-items: baseline; gap: 8mm; margin-top: 3mm; }
  .hm-topic { font-family: var(--serif); font-weight: 600; line-height: 1; color: var(--home); }
  .hm-topic.rank-0 { font-size: 30pt; }
  .hm-topic.rank-1 { font-size: 22pt; }
  .hm-topic.rank-2 { font-size: 19pt; }
  .hm-topic.rank-3 { font-size: 17pt; }
  .hm-topic.rank-4 { font-size: 15pt; }
  .hm-mood { margin: 9mm auto 0; max-width: 150mm; font-family: var(--serif); font-size: 10.5pt; line-height: 2; letter-spacing: 2px; color: var(--ink-soft); }
  @media (prefers-color-scheme: dark) {
    .hm { --home: #e6b866; }
  }
  /* 群聊互动页。静态产物没有涟漪动画，所以巨字「热闹」仍占视觉重心，
     四行事实用文字排版排成“发生的事”—— 数字嵌在句子里，不用面板。 */
  .it { flex: 1; display: flex; flex-direction: column; justify-content: center; text-align: center; }
  .it { --buzz: #a04e3c; }
  .it-kicker { display: flex; justify-content: space-between; align-items: baseline; text-align: left; font-size: 8pt; letter-spacing: 3px; color: var(--ink-soft); }
  .it-kicker-meta { font-size: 7.5pt; letter-spacing: 2px; color: var(--ink-faint); }
  .it-kicker-meta b { font-family: var(--serif); font-size: 10pt; font-weight: 600; color: var(--ink-soft); }
  .it-kicker-meta i { font-style: normal; margin: 0 1mm; opacity: 0.5; }
  .it-lede { margin-top: 9mm; font-family: var(--serif); font-size: 11.5pt; letter-spacing: 3px; color: var(--ink-soft); }
  .it-hero-label { margin-top: 8mm; font-family: var(--serif); font-size: 24pt; font-weight: 600; letter-spacing: 3px; color: var(--ink); }
  .it-hero-countline { display: flex; justify-content: center; align-items: baseline; gap: 4mm; margin-top: 3mm; }
  .it-hero-num { font-family: var(--serif); font-size: 96pt; font-weight: 600; letter-spacing: -2px; color: var(--buzz); line-height: 1; }
  .it-hero-unit { font-family: var(--serif); font-size: 26pt; letter-spacing: 5px; color: var(--ink-soft); }
  .it-hero-note { margin: 5mm auto 0; max-width: 134mm; font-family: var(--serif); font-size: 10pt; line-height: 1.9; letter-spacing: 2px; color: var(--ink-muted); }
  .it-hero-note em { color: var(--buzz); font-style: normal; font-weight: 600; }
  .it-hero-note b { font-family: var(--serif); font-size: 12pt; font-weight: 600; color: var(--buzz); }
  .it-hero-note .weq-echo-quote { color: var(--ink-soft); }
  .it-score { margin-top: 10mm; padding-top: 3mm; border-top: 0.25mm solid var(--hair); text-align: left; }
  .it-fact { display: grid; grid-template-columns: 10mm 16mm minmax(0, 1fr); column-gap: 3mm; row-gap: 1.4mm; align-items: baseline; padding: 2.7mm 0; }
  .it-mark { grid-row: 1 / span 2; color: color-mix(in srgb, var(--buzz) 70%, transparent); font-family: var(--serif); font-size: 22pt; font-weight: 600; line-height: 1; text-align: center; }
  .it-label { font-size: 7.5pt; font-weight: 600; letter-spacing: 3px; color: var(--buzz); }
  .it-main { font-family: var(--serif); font-size: 12pt; letter-spacing: 1px; color: var(--ink); white-space: nowrap; }
  .it-main b { font-family: var(--serif); font-size: 16pt; font-weight: 600; color: var(--buzz); }
  .it-main em { color: var(--buzz); font-style: normal; font-weight: 600; }
  .it-sub { grid-column: 2 / 4; overflow: hidden; font-family: var(--serif); font-size: 9pt; letter-spacing: 1px; color: var(--ink-muted); text-overflow: ellipsis; white-space: nowrap; }
  .it-sub em { color: var(--buzz); font-style: normal; font-weight: 600; }
  .it-sub b { font-family: var(--serif); font-size: 11pt; font-weight: 600; color: var(--ink-soft); }
  .it-mood { margin: 5mm auto 0; font-family: var(--serif); font-size: 9.5pt; letter-spacing: 2px; color: var(--ink-faint); }
  @media (prefers-color-scheme: dark) {
    .it { --buzz: #e79a74; }
  }
  /* 陪你走过 12 个月页。静态产物画不了头像贴图，年度聊伴退成排版里的大名 +
     一枚衬线数字；月历仍排成六列两行 —— 属于聊伴的月份染成胭脂色。 */
  .mo { flex: 1; display: flex; flex-direction: column; justify-content: center; text-align: center; }
  .mo { --mo: #a2435d; }
  .mo-kicker { display: flex; justify-content: space-between; align-items: baseline; text-align: left; font-size: 8pt; letter-spacing: 3px; color: var(--ink-soft); }
  .mo-kicker-meta { font-size: 7.5pt; letter-spacing: 2px; color: var(--ink-faint); }
  .mo-kicker-meta b { font-family: var(--serif); font-size: 10pt; font-weight: 600; color: var(--ink-soft); }
  .mo-lede { margin-top: 10mm; font-family: var(--serif); font-size: 11.5pt; letter-spacing: 3px; color: var(--ink-soft); }
  .mo-avatar { display: flex; align-items: center; justify-content: center; width: 32mm; height: 32mm; margin: 7mm auto 0; border-radius: 50%; border: 0.3mm solid color-mix(in srgb, var(--mo) 72%, transparent); box-shadow: 0 0 0 3mm color-mix(in srgb, var(--mo) 8%, transparent), 0 0 8mm color-mix(in srgb, var(--mo) 22%, transparent); font-family: var(--serif); font-size: 15mm; color: var(--ink); overflow: hidden; }
  .mo-avatar .avatar.mo-avatar-face { width: 100%; height: 100%; font-size: 15mm; border-radius: 50%; outline: none; }
  .mo-name { margin-top: 4mm; font-family: var(--serif); font-size: 46pt; font-weight: 600; line-height: 1.1; letter-spacing: 2px; color: var(--ink); white-space: nowrap; }
  .mo-name.long { font-size: 34pt; }
  .mo-name.xl { font-size: 28pt; }
  .mo-countline { display: flex; justify-content: center; align-items: center; gap: 5mm; margin-top: 1mm; }
  .mo-count { font-family: var(--serif); font-size: 86pt; font-weight: 600; line-height: 1; letter-spacing: -3px; color: var(--mo); }
  .mo-unit { display: flex; flex-direction: column; align-items: flex-start; gap: 1mm; text-align: left; }
  .mo-unit b { font-family: var(--serif); font-size: 15pt; font-weight: 600; letter-spacing: 1px; color: var(--ink); }
  .mo-unit i { font-size: 7pt; font-style: normal; letter-spacing: 4px; color: var(--ink-muted); }
  .mo-note { margin-top: 2mm; font-family: var(--serif); font-size: 10pt; letter-spacing: 2px; color: var(--ink-muted); }
  .mo-calendar { margin-top: 10mm; padding-top: 4mm; border-top: 0.25mm solid var(--hair); }
  .mo-calendar-head { font-size: 7.5pt; letter-spacing: 5px; color: var(--ink-faint); }
  .mo-months { display: grid; grid-template-columns: repeat(6, minmax(0, 1fr)); gap: 6mm 5mm; margin-top: 4mm; padding: 0; list-style: none; }
  .mo-month { display: flex; flex-direction: column; align-items: center; gap: 1.2mm; padding-bottom: 2mm; border-bottom: 0.25mm solid var(--hair); }
  .mo-month-label { font-size: 7pt; font-weight: 600; letter-spacing: 3px; color: var(--ink-faint); }
  .mo-mini { display: flex; align-items: center; justify-content: center; width: 9mm; height: 9mm; border-radius: 50%; border: 0.2mm solid color-mix(in srgb, var(--mo) 38%, transparent); font-family: var(--serif); font-size: 4mm; color: var(--ink-muted); overflow: hidden; }
  .mo-mini .avatar.mo-mini-face { width: 100%; height: 100%; font-size: 4mm; border-radius: 50%; outline: none; }
  .mo-mini .avatar.is-empty, span.mo-mini.is-empty { border: none; }
  .mo-month-name { max-width: 100%; overflow: hidden; font-size: 7pt; color: var(--ink-muted); text-overflow: ellipsis; white-space: nowrap; }
  .mo-month-count { font-family: var(--serif); font-size: 8pt; font-weight: 600; color: var(--ink-faint); }
  .mo-month.ours { border-bottom-color: color-mix(in srgb, var(--mo) 58%, transparent); }
  .mo-month.ours .mo-mini { border-color: color-mix(in srgb, var(--mo) 78%, transparent); color: var(--mo); }
  .mo-month.ours .mo-month-count { color: var(--mo); }
  .mo-month.quiet { border-bottom-style: dashed; }
  .mo-month.quiet .mo-mini { border-color: var(--hair); }
  .mo-month.carried { opacity: 0.62; }
  .mo-month.carried .mo-mini { border-style: dashed; }
  .mo-year-tag { margin-right: 2mm; font-size: 5.5pt; font-style: normal; font-weight: 600; letter-spacing: 2px; color: var(--ink-faint); }
  .mo-mood { margin: 8mm auto 0; max-width: 150mm; font-family: var(--serif); font-size: 10pt; line-height: 2; letter-spacing: 2px; color: var(--ink-muted); }
  @media (prefers-color-scheme: dark) {
    .mo { --mo: #eba3b7; }
  }
  /* 还没加好友的同路人页。静态产物没有慢转粒子，光环退成两圈静置的衬线圆；
     主体仍是冠军大头名 + 「N 个群」巨数，共同群名单和后续推荐排成发丝线内
     的证据，不画成卡片。 */
  .mt { flex: 1; display: flex; flex-direction: column; justify-content: center; position: relative; text-align: center; }
  .mt { --mt: #3f7f77; }
  .mt-kicker { display: flex; justify-content: space-between; align-items: baseline; text-align: left; font-size: 8pt; letter-spacing: 3px; color: var(--ink-soft); }
  .mt-kicker-meta { font-size: 7.5pt; letter-spacing: 2px; color: var(--ink-faint); }
  .mt-kicker-meta b { font-family: var(--serif); font-size: 10pt; font-weight: 600; color: var(--ink-soft); }
  .mt-orbit { position: absolute; left: 50%; top: 45%; z-index: 0; width: 148mm; height: 148mm; transform: translate(-50%, -50%); opacity: 0.9; pointer-events: none; }
  .mt-ring { position: absolute; inset: 0; border: 0.3mm solid color-mix(in srgb, var(--mt) 24%, transparent); border-radius: 50%; }
  .mt-ring.b { inset: 18mm; border-style: dashed; border-color: color-mix(in srgb, var(--mt) 16%, transparent); }
  .mt-dot { position: absolute; left: 50%; top: 50%; width: 1mm; height: 1mm; border-radius: 50%; background: color-mix(in srgb, var(--mt) 72%, transparent); box-shadow: 0 0 2mm color-mix(in srgb, var(--mt) 46%, transparent); }
  .mt-hero { position: relative; z-index: 1; display: flex; flex-direction: column; align-items: center; }
  .mt-lede { font-family: var(--serif); font-size: 11.5pt; letter-spacing: 3px; color: var(--ink-soft); }
  .mt-avatar { display: flex; align-items: center; justify-content: center; width: 36mm; height: 36mm; margin-top: 6mm; border-radius: 50%; border: 0.3mm solid color-mix(in srgb, var(--mt) 76%, transparent); box-shadow: 0 0 0 3.5mm color-mix(in srgb, var(--mt) 8%, transparent), 0 0 9mm color-mix(in srgb, var(--mt) 22%, transparent); font-family: var(--serif); font-size: 16mm; color: var(--ink); overflow: hidden; }
  .mt-avatar .avatar.mt-avatar-face { width: 100%; height: 100%; font-size: 16mm; border-radius: 50%; outline: none; }
  .mt-name { margin-top: 4mm; font-family: var(--serif); font-size: 50pt; font-weight: 600; line-height: 1.08; letter-spacing: 2px; color: var(--ink); white-space: nowrap; }
  .mt-name.long { font-size: 38pt; }
  .mt-name.xl { font-size: 30pt; }
  .mt-countline { display: flex; justify-content: center; align-items: center; gap: 5mm; margin-top: 1mm; }
  .mt-count { font-family: var(--serif); font-size: 92pt; font-weight: 600; line-height: 1; letter-spacing: -3px; color: var(--mt); }
  .mt-unit { display: flex; flex-direction: column; align-items: flex-start; gap: 1mm; text-align: left; }
  .mt-unit b { font-family: var(--serif); font-size: 16pt; font-weight: 600; letter-spacing: 1px; color: var(--ink); }
  .mt-unit i { font-size: 7pt; font-style: normal; letter-spacing: 4px; color: var(--ink-muted); }
  .mt-note { margin-top: 2mm; font-family: var(--serif); font-size: 10.5pt; letter-spacing: 2px; color: var(--ink-muted); }
  .mt-note b { color: var(--mt); }
  .mt-cluster { position: relative; z-index: 1; margin-top: 9mm; padding-top: 4mm; border-top: 0.25mm solid var(--hair); }
  .mt-cluster-in { font-size: 7.5pt; letter-spacing: 5px; color: var(--ink-faint); }
  .mt-chips { display: flex; flex-wrap: wrap; justify-content: center; align-items: baseline; gap: 2.5mm 8mm; margin-top: 3mm; }
  .mt-chip { max-width: 56mm; overflow: hidden; font-family: var(--serif); font-size: 10.5pt; letter-spacing: 1px; color: var(--ink-soft); text-overflow: ellipsis; white-space: nowrap; }
  .mt-chip i { margin-right: 1.5mm; font-family: var(--serif); font-size: 8pt; font-weight: 600; font-style: normal; color: var(--mt); }
  .mt-chip.more { color: var(--ink-muted); }
  .mt-more { position: relative; z-index: 1; display: flex; justify-content: center; align-items: center; gap: 10mm; margin-top: 5mm; padding-top: 3mm; border-top: 0.25mm solid var(--hair); list-style: none; }
  .mt-more-item { display: flex; align-items: center; gap: 1.6mm; min-width: 0; }
  .mt-rank { font-family: var(--serif); font-size: 8pt; font-weight: 600; color: var(--ink-faint); }
  .mt-mini { display: flex; align-items: center; justify-content: center; width: 6mm; height: 6mm; border-radius: 50%; border: 0.2mm solid color-mix(in srgb, var(--mt) 44%, transparent); font-family: var(--serif); font-size: 2.8mm; color: var(--ink-muted); }
  .mt-more-name { max-width: 40mm; overflow: hidden; font-family: var(--serif); font-size: 11pt; letter-spacing: 1px; color: var(--ink-soft); text-overflow: ellipsis; white-space: nowrap; }
  .mt-more-val { font-family: var(--serif); font-size: 15pt; font-weight: 600; color: var(--mt); }
  .mt-more-unit { font-size: 7pt; color: var(--ink-faint); }
  .mt-mood { position: relative; z-index: 1; margin: 7mm auto 0; max-width: 150mm; font-family: var(--serif); font-size: 10pt; line-height: 2; letter-spacing: 2px; color: var(--ink-muted); }
  @media (prefers-color-scheme: dark) {
    .mt { --mt: #77cfc2; }
  }
  /* QQ 空间回忆页。静态产物没有流动胶片与巨数轮播，主体仍是「N 条说说」的
     巨大数字；冠军回忆压缩成一行带引号的名句，脚下胶片退成一行条状帧 ——
     每帧是日期 + 文字摘录（含图/视频标记），不依赖远程图片也能离线读。 */
  .qz { flex: 1; display: flex; flex-direction: column; justify-content: center; text-align: center; }
  .qz { --qz: #2f6fa8; --qz-gold: #b07c38; }
  .qz-kicker { display: flex; justify-content: space-between; align-items: baseline; text-align: left; font-size: 8pt; letter-spacing: 3px; color: var(--ink-soft); }
  .qz-kicker-meta { font-size: 7.5pt; letter-spacing: 2px; color: var(--ink-faint); }
  .qz-kicker-meta b { font-family: var(--serif); font-size: 10pt; font-weight: 600; color: var(--ink-soft); }
  .qz-lede { margin-top: 9mm; font-family: var(--serif); font-size: 12pt; letter-spacing: 3px; color: var(--ink-soft); }
  .qz-countline { display: flex; justify-content: center; align-items: center; gap: 5mm; margin-top: 1mm; }
  .qz-count { font-family: var(--serif); font-size: 100pt; font-weight: 600; letter-spacing: -4px; line-height: 1; color: var(--qz); }
  .qz-unit { display: flex; flex-direction: column; align-items: flex-start; gap: 1mm; text-align: left; }
  .qz-unit b { font-family: var(--serif); font-size: 17pt; font-weight: 600; letter-spacing: 1px; color: var(--ink); }
  .qz-unit i { font-size: 7pt; font-style: normal; letter-spacing: 4px; color: var(--ink-muted); }
  .qz-mood { margin-top: 1mm; font-family: var(--serif); font-size: 9.5pt; letter-spacing: 2px; color: var(--ink-muted); }
  .qz-gem { display: grid; grid-template-columns: minmax(0, 1fr) 36mm; align-items: center; gap: 6mm; margin: 7mm auto 0; max-width: 168mm; padding-top: 4mm; border-top: 0.25mm solid var(--hair); text-align: left; }
  .qz-gem-copy { min-width: 0; }
  .qz-gem-eyebrow { font-size: 7.5pt; font-weight: 700; letter-spacing: 4px; color: var(--qz); }
  .qz-gem-quote { display: block; margin-top: 2mm; overflow: hidden; font-family: var(--serif); font-size: 14pt; line-height: 1.7; letter-spacing: 1px; color: var(--ink); text-overflow: ellipsis; white-space: nowrap; }
  .qz-gem-meta { margin-top: 1.5mm; font-size: 8pt; letter-spacing: 2px; color: var(--ink-faint); }
  .qz-gem-meta b { font-family: var(--serif); font-size: 12pt; font-weight: 600; color: var(--qz-gold); }
  .qz-gem-mark { display: flex; align-items: center; justify-content: center; width: 36mm; height: 24mm; border: 0.3mm solid color-mix(in srgb, var(--qz) 58%, transparent); font-family: var(--serif); font-size: 14mm; color: color-mix(in srgb, var(--qz) 62%, transparent); }
  .qz-reel { margin-top: 8mm; padding-top: 3mm; border-top: 0.25mm solid var(--hair); }
  .qz-reel-in { font-size: 7pt; letter-spacing: 5px; color: var(--ink-faint); }
  .qz-frames { display: flex; justify-content: center; gap: 2.6mm; margin-top: 3mm; }
  .qz-frame { flex: 1 1 0; min-width: 0; height: 17mm; padding: 1.6mm 2mm; background: color-mix(in srgb, var(--qz) 7%, var(--paper-deep)); border: 0.2mm solid color-mix(in srgb, var(--qz) 24%, var(--hair)); text-align: left; overflow: hidden; }
  .qz-frame-date { font-family: var(--serif); font-size: 6.5pt; color: var(--qz); letter-spacing: 1px; }
  .qz-frame-tag { margin-left: 1mm; font-size: 5.5pt; letter-spacing: 1px; color: var(--qz-gold); }
  .qz-frame-text { display: -webkit-box; margin-top: 1mm; overflow: hidden; font-family: var(--serif); font-size: 7pt; line-height: 1.45; letter-spacing: 0.5px; color: var(--ink-muted); -webkit-box-orient: vertical; -webkit-line-clamp: 2; }
  @media (prefers-color-scheme: dark) {
    .qz { --qz: #8fc0e8; --qz-gold: #e2ae74; }
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

/**
 * 导出 HTML 里的一颗头像。预热过（data URI 可用）就画真脸，否则退回首字
 * 圆牌 —— 与屏幕版同一种降级。`cls` 追加尺寸/修饰类。
 */
function avatarImg(uin: unknown, name: string, cls: string): string {
  const initial = Array.from(name)[0] ?? '?';
  const src =
    typeof uin === 'string' && /^\d+$/.test(uin)
      ? inlinedAsset(
          mediaUrl('avatar', {
            scope: 'user',
            uin,
            v: 'big',
            fb: `https://thirdqq.qlogo.cn/g?b=sdk&s=0&nk=${uin}`,
          }),
        )
      : null;
  if (!src) return `<span class="avatar ${cls}">${escapeHtml(initial)}</span>`;
  return `<img class="avatar ${cls}" src="${src}" alt="">`;
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
    bubbleId?: number;
    bubbleName: string;
    fontName: string;
    widgetName: string;
  };
  const outfits = (data.outfits ?? []) as Outfit[];
  const hero = outfits[0];
  // 预热过的九宫格贴图：有就画真实气泡（border-image，与屏幕版同一几何），
  // 没有退回排印引号 —— 两种表达并存，导出永不因图片失败而破版。
  const heroBubble =
    hero?.bubbleId && hero.bubbleId > 0
      ? inlinedAsset(mediaUrl('dressbubble', { id: hero.bubbleId }))
      : null;
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
             ${
               heroBubble
                 ? `<div class="dr-bubble" style="border-image-source:url('${heroBubble}')">${
                     heroLine ? escapeHtml(heroLine) : '&nbsp;'
                   }</div>`
                 : heroLine
                   ? `<div class="dr-say">${escapeHtml(heroLine)}</div>`
                   : ''
}
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
  type Entry = { peerUin?: string; peerName: string; value: number; messages: number };
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
           ${avatarImg(champSpark.peerUin, champSpark.peerName, 'fr-face fr-face-lg')}
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
                 ${index === 0 ? avatarImg(entry.peerUin, entry.peerName, 'fr-face fr-face-stack') : ''}
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
      peerUid?: string;
      peerUin?: string;
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
    const face = avatarImg(entry.peerUin, entry.peerName, 'op-face');
    if (role.kind === 'mine') {
      const minePct = Math.round((entry.selfStarts / entry.totalStarts) * 100);
      return `${face}<span class="op-line-say"><span class="op-line-role">${roleLabel}</span><span class="op-line-dot">·</span><em>${escapeHtml(
        entry.peerName,
      )}</em>，这 ${fmt(entry.totalStarts)} 场里你先发起 ${fmt(entry.selfStarts)} 次（发起率 ${minePct}%）—— 是你一直在把 TA 找回来。</span>`;
    }
    if (role.kind === 'peer') {
      const peerPct = Math.round((entry.peerStarts / entry.totalStarts) * 100);
      return `${face}<span class="op-line-say"><span class="op-line-role">${roleLabel}</span><span class="op-line-dot">·</span><em>${escapeHtml(
        entry.peerName,
      )}</em>，这 ${fmt(entry.totalStarts)} 场里 TA 先发起 ${fmt(entry.peerStarts)} 次（发起率 ${peerPct}%）—— 有人总比你早一步想你。</span>`;
    }
    const minePct = Math.round((entry.selfStarts / entry.totalStarts) * 100);
    const peerPct = 100 - minePct;
    return `${face}<span class="op-line-say"><span class="op-line-role">${roleLabel}</span><span class="op-line-dot">·</span><em>${escapeHtml(
      entry.peerName,
    )}</em>，开场 ${fmt(entry.selfStarts)} : ${fmt(
      entry.peerStarts,
    )}，发起率 ${minePct}% : ${peerPct}% —— 谁先想起谁，都不算抢先。</span>`;
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

/**
 * 我的话页的导出版。
 *
 * 屏幕版里那颗系统表情 / 自定义表情是有真实画面的（weq-asset / weq-media 协议），
 * 自包含 HTML 里画不出来 —— 所以导出版只留下排印：词是主角，两颗表情退成
 * 一排名字与次数的小注脚。与装扮页同一句取舍：换皮不换骨。
 */
function voiceSlide(data: Record<string, unknown>): string {
  const year = Number(data.year ?? 0);
  const allTime = isAllTimeYear(year);
  const sentTotal = Number(data.sentTotal ?? 0);
  const faceTotal = Number(data.faceTotal ?? 0);
  const picTotal = Number(data.picTotal ?? 0);
  const word = (data.word ?? null) as { word?: string; count?: number } | null;
  const faces = (data.faces ?? []) as Array<{
    name?: string;
    count?: number;
  }>;
  const pic = (data.pic ?? null) as { count?: number } | null;
  const heroWord = String(word?.word ?? '……');
  const heroCount = Number(word?.count ?? 0);
  const topFaces = faces.slice(0, 4);
  const hasFaves = topFaces.length > 0 || pic != null;
  const faveHtml = hasFaves
    ? `<div class="vc-faves">
        <p class="vc-faves-in">而表情，是你那句口头禅旁边的语气——</p>
        <div class="vc-faves-row">
          ${
            topFaces.length > 0
              ? `<div class="vc-faceband">
                  <span class="vc-faceband-tag">系统表情</span>
                  <div class="vc-face-tiles">
                    ${topFaces
                      .map(
                        (face, rank) =>
                          `<div class="vc-fave vc-face rank-${rank}">
                            <span class="vc-fave-name">${escapeHtml(String(face.name ?? '表情'))}</span>
                            <span class="vc-fave-count"><b>${fmt(Number(face.count ?? 0))}</b> 次</span>
                          </div>`,
                      )
                      .join('')}
                  </div>
                </div>`
              : ''
          }
          ${topFaces.length > 0 && pic ? '<span class="vc-faves-sep"></span>' : ''}
          ${
            pic
              ? `<div class="vc-fave vc-pic">
                  <span class="vc-fave-label">自定义表情</span>
                  <span class="vc-fave-name">这张最常被你拿出来</span>
                  <span class="vc-fave-count"><b>${fmt(Number(pic.count ?? 0))}</b> 次</span>
                </div>`
              : ''
          }
        </div>
      </div>`
    : '';

  return `${slideOpen('话')}
    <div class="vc">
      <div class="vc-kicker">
        <span>${escapeHtml(reportEraLabel(year))} · 我的话</span>
        <span class="vc-kicker-meta"><b>${fmt(sentTotal)}</b> 条发言 / <b>${fmt(
          faceTotal,
        )}</b> 个系统表情${picTotal > 0 ? ` / <b>${fmt(picTotal)}</b> 张自定义表情` : ''}</span>
      </div>
      <p class="vc-lede">${allTime ? '从有记录到现在' : `${year} 这一年`}，你说得最多的那个词是</p>
      <h2 class="vc-word${heroWord.length >= 5 ? ' long' : ''}">${escapeHtml(heroWord)}</h2>
      <p class="vc-count"><i aria-hidden></i>说了 <b>${fmt(heroCount)}</b> 次<i aria-hidden></i></p>
      ${hasFaves ? faveHtml : ''}
      <p class="vc-mood">${
        heroCount > 0
          ? `一句话说了 ${fmt(heroCount)} 次，不是因为词穷——是每一次，你都还想把它送到。`
          : '重复，是你最诚实的告白。'
      }</p>
    </div>${slideFoot(`${reportPeriodLabel(year)} · VOICE`)}`;
}

/**
 * 群聊互动页的导出版。没有涟漪与逐字落地的动画，版式钉死在静态：
 * 主体是四组统计里数字最大的那一枚巨数——每个人看到的署名都不同；
 * 下半行仍是四行“发生的事”，句子而非卡片。
 */
type InteractionsHeroKind = 'at' | 'called' | 'poke' | 'echo';

type InteractionsHero = {
  kind: InteractionsHeroKind;
  label: string;
  num: string;
  unit: string;
  note: string;
};

/** 与屏幕版同款主体选择：挑数字最大的那组，并列时 at 优先。 */
function interactionsHero(data: Record<string, unknown>): InteractionsHero | null {
  const pokeTotal = Number(data.pokeTotal ?? 0);
  const atTotal = Number(data.atTotal ?? 0);
  const atMeTotal = Number(data.atMeTotal ?? 0);
  const echoParticipated = Number(data.echoParticipated ?? 0);
  const echoLongest = (data.echoLongest ?? null) as {
    count?: number;
    groupName?: string;
    text?: string;
  } | null;
  const echoCount = Math.max(echoParticipated, Number(echoLongest?.count ?? 0));
  const candidates: Array<{ kind: InteractionsHeroKind; count: number }> = [
    { kind: 'at', count: atTotal },
    { kind: 'called', count: atMeTotal },
    { kind: 'poke', count: pokeTotal },
    { kind: 'echo', count: echoCount },
  ];
  let best: (typeof candidates)[number] | null = null;
  for (const candidate of candidates) {
    if (!best || candidate.count > best.count) best = candidate;
  }
  if (!best || best.count <= 0) return null;

  const atTop = (data.atTop ?? null) as { name?: string; count?: number } | null;
  const pokeTop = (data.pokeTop ?? null) as { name?: string; count?: number } | null;
  const atMeTop = (data.atMeTop ?? null) as { groupName?: string; count?: number } | null;

  switch (best.kind) {
    case 'at':
      return {
        kind: 'at',
        label: '我 @ 过别人',
        num: fmt(atTotal),
        unit: '次',
        note: atTop
          ? `名字喊得最响的是 <em>${escapeHtml(String(atTop.name ?? ''))}</em> · <b>${fmt(
              Number(atTop.count ?? 0),
            )}</b> 次——@ 是怕你错过，才把名字放到人前。`
          : '这一年你 @ 得不多——但每一次，都是怕有人错过。',
      };
    case 'called':
      return {
        kind: 'called',
        label: '我被人点名过',
        num: fmt(atMeTotal),
        unit: '次',
        note: atMeTop
          ? `最多发生在 <em>${escapeHtml(String(atMeTop.groupName ?? ''))}</em> · <b>${fmt(
              Number(atMeTop.count ?? 0),
            )}</b> 次——被点名，是被人想起的最短路径。`
          : '名字被念起的次数还不多——但每一次，都有人记得你。',
      };
    case 'poke':
      return {
        kind: 'poke',
        label: '我发起过戳一戳',
        num: fmt(pokeTotal),
        unit: '次',
        note: pokeTop
          ? `最常被你戳到 <em>${escapeHtml(String(pokeTop.name ?? ''))}</em> · <b>${fmt(
              Number(pokeTop.count ?? 0),
            )}</b> 次——戳一戳是最轻的搭话。`
          : '这一年你伸出的手不多——但每一下，都先越过了屏幕。',
      };
    case 'echo': {
      const longestCount = Number(echoLongest?.count ?? 0);
      if (echoLongest && longestCount > echoParticipated) {
        return {
          kind: 'echo',
          label: '最长的一次齐声',
          num: fmt(longestCount),
          unit: '条',
          note: `在 <em>${escapeHtml(String(echoLongest.groupName ?? ''))}</em>，大家把 <b class="weq-echo-quote">“${escapeHtml(
            String(echoLongest.text ?? ''),
          )}”</b> 连说了 <b>${fmt(longestCount)}</b> 次——一句话被那么多人接住，就不再只是一个人的了。`,
        };
      }
      return {
        kind: 'echo',
        label: '我跟上过复读',
        num: fmt(echoParticipated),
        unit: '场',
        note: echoLongest
          ? `最长一轮在 <em>${escapeHtml(String(echoLongest.groupName ?? ''))}</em>，连了 <b>${fmt(
              Number(echoLongest.count ?? 0),
            )}</b> 条——不想一个人笑的时候，你跟着大家开了口。`
          : `这一年你跟着大家开过 ${fmt(echoParticipated)} 次口——齐声最不怕吵。`,
      };
    }
  }
}

/** 群聊互动页的导出版。 */
function interactionsSlide(data: Record<string, unknown>): string {
  const year = Number(data.year ?? 0);
  const allTime = isAllTimeYear(year);
  const pokeTotal = Number(data.pokeTotal ?? 0);
  const atTotal = Number(data.atTotal ?? 0);
  const atMeTotal = Number(data.atMeTotal ?? 0);
  const echoParticipated = Number(data.echoParticipated ?? 0);
  const pokeTop = (data.pokeTop ?? null) as {
    name?: string;
    count?: number;
  } | null;
  const atTop = (data.atTop ?? null) as {
    name?: string;
    count?: number;
  } | null;
  const atMeTop = (data.atMeTop ?? null) as {
    groupName?: string;
    count?: number;
  } | null;
  const echoLongest = (data.echoLongest ?? null) as {
    groupName?: string;
    count?: number;
    text?: string;
  } | null;
  const hasEvidence =
    pokeTotal > 0 || atTotal > 0 || atMeTotal > 0 || echoParticipated > 0 || echoLongest != null;
  const hero = interactionsHero(data);
  const heroGhost = hero
    ? hero.kind === 'at'
      ? '@'
      : hero.kind === 'called'
        ? '呼'
        : hero.kind === 'poke'
          ? '戳'
          : '齐'
    : '安';

  const fact = (mark: string, label: string, main: string, sub: string): string =>
    `<p class="it-fact">
       <span class="it-mark">${escapeHtml(mark)}</span>
       <span class="it-label">${escapeHtml(label)}</span>
       <span class="it-main">${main}</span>
       <span class="it-sub">${sub}</span>
     </p>`;

  const era = allTime ? '有记录以来' : `${year} 年`;
  const body = hasEvidence
    ? `<div class="it-hero">
         <p class="it-lede">${era}，你在群聊里做过最多的那件事，是——</p>
         <h2 class="it-hero-label">${escapeHtml(hero?.label ?? '')}</h2>
         <p class="it-hero-countline">
           <span class="it-hero-num">${hero?.num ?? '0'}</span>
           <span class="it-hero-unit">${escapeHtml(hero?.unit ?? '')}</span>
         </p>
         ${hero ? `<p class="it-hero-note">${hero.note}</p>` : ''}
       </div>
       <div class="it-score">
         ${fact(
           '戳',
           '伸手',
           `我发起过 <b>${fmt(pokeTotal)}</b> 次戳一戳`,
           pokeTop
             ? `最常被你戳到：<em>${escapeHtml(String(pokeTop.name ?? ''))}</em> · ${fmt(
                 Number(pokeTop.count ?? 0),
               )} 次`
             : '这一年，你的「戳一戳」还没落到具体哪个人身上。',
         )}
         ${fact(
           '@',
           '点名',
           `我 @ 过别人 <b>${fmt(atTotal)}</b> 次`,
           atTop
             ? `名字喊得最响的：<em>${escapeHtml(String(atTop.name ?? ''))}</em> · ${fmt(
                 Number(atTop.count ?? 0),
               )} 次`
             : '这一年，你还不太习惯在群里点别人的名。',
         )}
         ${fact(
           '呼',
           '被惦记',
           atMeTop
             ? `被 @ 最多的群是 <em>${escapeHtml(String(atMeTop.groupName ?? ''))}</em>`
             : '这一年，还没有哪个群反复喊你的名字。',
           atMeTop
             ? `那里有 <b>${fmt(Number(atMeTop.count ?? 0))}</b> 次，别人把你的名字放进了自己的句子。`
             : '下一次开场，从你 @ 别人开始。',
         )}
         ${fact(
           '齐',
           '齐声',
           `我跟过 <b>${fmt(echoParticipated)}</b> 场复读`,
           echoLongest
             ? `最长一轮在 <em>${escapeHtml(String(echoLongest.groupName ?? ''))}</em>：${fmt(
                 Number(echoLongest.count ?? 0),
               )} 条“${escapeHtml(String(echoLongest.text ?? ''))}”`
             : '这一年没有足够长的齐声——热闹的下一条，可能由你开头。',
         )}
       </div>
       <p class="it-mood">你留在群里的，不只有话。每一次伸手、被点名、跟着大家开口——都是「你也在」的证据。</p>`
    : `<div class="it-hero">
         <p class="it-lede">${era}，你在群聊里更多是安静地听——</p>
         <h2 class="it-hero-label">你还没留下可统计的互动</h2>
         <p class="it-hero-note">戳一戳、@ 与复读的痕迹都还停在别处。没关系，
           下一条消息，可以从你开始。</p>
       </div>`;

  return `${slideOpen(heroGhost)}
    <div class="it">
      <div class="it-kicker">
        <span>${escapeHtml(reportEraLabel(year))} · 群聊互动</span>
        <span class="it-kicker-meta"><b>${fmt(pokeTotal)}</b> 次戳<i>/</i><b>${fmt(
          atTotal,
        )}</b> 次 @<i>/</i><b>${fmt(echoParticipated)}</b> 场齐声</span>
      </div>
      ${body}
    </div>${slideFoot(`${reportPeriodLabel(year)} · INTERACTIONS`)}`;
}

/**
 * 我的主场页的导出版。
 *
 * 屏幕版飘在后面的词云动画进不了自包含 HTML，因此这一版把排印钉死在静态上：
 * 群名 + 巨数占住视觉中心，等级 / 头衔 / 群规模作为发丝线分隔的小签名收在
 * 页底，五颗高频话题词排成一句可读的话。数据与屏幕版同源，不做二次统计。
 */
function homeSlide(data: Record<string, unknown>): string {
  const year = Number(data.year ?? 0);
  const allTime = isAllTimeYear(year);
  const activeGroupCount = Number(data.activeGroupCount ?? 0);
  const groupSentTotal = Number(data.groupSentTotal ?? 0);
  const top = (data.top ?? null) as {
    groupCode?: string;
    groupName?: string;
    sentCount?: number;
    groupTotal?: number;
    memberCount?: number;
    memberLevel?: number;
    levelName?: string;
    customTitle?: string;
    role?: string;
    topics?: Array<{ word?: string; count?: number }>;
  } | null;

  if (!top) {
    return `${slideOpen('群')}
      <div class="hm">
        <div class="hm-kicker"><span>${escapeHtml(reportEraLabel(year))} · 我的主场</span></div>
        <p class="hm-mood">群聊记录还在，但本地没有足够的群资料，讲不出这座主场。</p>
      </div>${slideFoot(`${reportPeriodLabel(year)} · HOME`)}`;
  }

  const name = String(top.groupName ?? top.groupCode ?? '这个群');
  const count = Number(top.sentCount ?? 0);
  const memberLevel = Number(top.memberLevel ?? 0);
  const memberCount = Number(top.memberCount ?? 0);
  const levelName = String(top.levelName ?? '');
  const customTitle = String(top.customTitle ?? '');
  const role = String(top.role ?? 'member');
  const share = groupSentTotal > 0 ? Math.round((count / groupSentTotal) * 100) : 0;

  const sig: Array<{ label: string; value: string; note: string }> = [];
  if (memberLevel > 0) {
    sig.push({ label: '群等级', value: `LV.${memberLevel}`, note: levelName });
  }
  if (customTitle) {
    sig.push({ label: '群头衔', value: customTitle, note: '' });
  } else if (role === 'owner' || role === 'admin') {
    sig.push({ label: '群头衔', value: role === 'owner' ? '群主' : '管理员', note: '' });
  }
  if (memberCount > 0) {
    sig.push({ label: '群成员', value: fmt(memberCount), note: '人' });
  }
  const sigHtml =
    sig.length > 0
      ? `<p class="hm-sig">${sig
          .map(
            (item) =>
              `<span class="hm-sig-item"><i>${escapeHtml(item.label)}</i><b>${escapeHtml(
                item.value,
              )}</b>${item.note ? `<em>${escapeHtml(item.note)}</em>` : ''}</span>`,
          )
          .join('')}</p>`
      : '';

  const topics = (top.topics ?? []).slice(0, 5);
  const topicsHtml =
    topics.length > 0
      ? `<div class="hm-topics">
          <p class="hm-topics-in">这一年，这个群里的话题集中在</p>
          <p class="hm-topics-words">
            ${topics
              .map(
                (topic, rank) =>
                  `<span class="hm-topic rank-${rank}">${escapeHtml(String(topic.word ?? ''))}</span>`,
              )
              .join('')}
          </p>
        </div>`
      : '';

  const width = [...name].reduce((sum, char) => sum + (/\p{Script=Han}/u.test(char) ? 1 : 0.62), 0);
  const nameClass = width > 11 ? ' xl' : width > 7 ? ' long' : '';

  return `${slideOpen('群')}
    <div class="hm">
      <div class="hm-kicker">
        <span>${escapeHtml(reportEraLabel(year))} · 我的主场</span>
        <span class="hm-kicker-meta"><b>${fmt(activeGroupCount)}</b> 个群说过话 / <b>${fmt(
          groupSentTotal,
        )}</b> 条群消息</span>
      </div>
      <p class="hm-lede">${allTime ? '有记录以来' : `${year} 年`}，你在群聊里说得最多的地方，是——</p>
      <h2 class="hm-name${nameClass}">${escapeHtml(name)}</h2>
      <p class="hm-countline">
        <span class="hm-count">${fmt(count)}</span>
        <span class="hm-unit"><b>条</b><i>消息</i></span>
      </p>
      <p class="hm-share"><i aria-hidden></i>${
        share >= 95 ? '你的群消息，几乎都落在这里' : `占你全部群消息的 ${share}%`
      }<i aria-hidden></i></p>
      ${sigHtml}
      ${topicsHtml}
      <p class="hm-mood">${fmt(count)} 次开口都有回声——热闹不是噪音，是总有人愿意接住你。</p>
    </div>${slideFoot(`${reportPeriodLabel(year)} · HOME`)}`;
}

/**
 * 陪你走过 12 个月页的导出版。
 *
 * 与屏幕版同一主体结构：年度聊伴的名字与「N 个月」巨数占住版心，十二格月历
 * 收在页底。静态产物画不了头像，所以主角退回一枚衬线首字 + 描边圆；属于聊伴
 * 的月份在月历里染成胭脂色，一眼就能看出谁「一路都在」。
 */
function monthsSlide(data: Record<string, unknown>): string {
  const year = Number(data.year ?? 0);
  const champion = (data.champion ?? null) as {
    peerUid?: string;
    peerUin?: string;
    peerName?: string;
    messages?: number;
  } | null;
  const championCells = Number(data.championMonths ?? 0);
  const monthCount = Number(data.monthCount ?? 0);
  const months = (data.months ?? []) as Array<{
    month?: number;
    monthMessages?: number;
    top?: { peerUid?: string; peerUin?: string; peerName?: string; messages?: number } | null;
  }>;
  const carryover = (data.carryoverMonths ?? []) as Array<{
    month?: number;
    top?: { peerUid?: string; peerUin?: string; peerName?: string; messages?: number } | null;
  }>;
  /** 去年尾部月份排在今年前面：9 月报告 = 去年 10/11/12 + 今年 1..9。 */
  const cells = [...carryover.map((cell) => ({ ...cell, carried: true as const })), ...months];
  const monthLabels = [
    '一月',
    '二月',
    '三月',
    '四月',
    '五月',
    '六月',
    '七月',
    '八月',
    '九月',
    '十月',
    '十一月',
    '十二月',
  ];
  const nameClass = (name: string): string => {
    const width = [...name].reduce(
      (sum, char) => sum + (/\p{Script=Han}/u.test(char) ? 1 : 0.6),
      0,
    );
    return width > 9 ? ' xl' : width > 6 ? ' long' : '';
  };

  const calendar = cells
    .map((cell) => {
      const top = cell.top ?? null;
      const label = monthLabels[Number(cell.month ?? 0) - 1] ?? `${cell.month}月`;
      const ours = champion && top && top.peerUid === champion.peerUid ? ' ours' : '';
      const quiet = top ? '' : ' quiet';
      const carried = 'carried' in cell && cell.carried;
      const face = top
        ? avatarImg(top.peerUin, String(top.peerName ?? ''), 'mo-mini-face')
        : '<span class="mo-mini is-empty">·</span>';
      return `<li class="mo-month${ours}${quiet}${carried ? ' carried' : ''}">
        <span class="mo-month-label">${carried ? '<em class="mo-year-tag">去年</em>' : ''}${escapeHtml(label)}</span>
        <span class="mo-mini">${face}</span>
        ${top ? `<span class="mo-month-name">${escapeHtml(String(top.peerName ?? ''))}</span>` : ''}
        ${top ? `<span class="mo-month-count">${fmt(Number(top.messages ?? 0))}</span>` : ''}
      </li>`;
    })
    .join('');

  return `${slideOpen(String(year))}
    <div class="mo">
      <div class="mo-kicker">
        <span>${escapeHtml(reportEraLabel(year))} · 陪你走过12个月</span>
        <span class="mo-kicker-meta"><b>${fmt(Number(data.friendCount ?? 0))}</b> 位好友 / <b>${fmt(
          Number(data.totalMessages ?? 0),
        )}</b> 条私聊</span>
      </div>
      ${
        champion
          ? `<div class="mo-lede">${escapeHtml(reportEraLabel(year))}${
              carryover.length > 0 ? '（近 12 个月）' : ''
            }，每个月聊得最多的人一直在换，
            可最后站在你身边的是——</div>
            <div class="mo-avatar">${avatarImg(
              champion.peerUin,
              String(champion.peerName ?? ''),
              'mo-avatar-face',
            )}</div>
            <h2 class="mo-name${nameClass(String(champion.peerName ?? ''))}">${escapeHtml(
              String(champion.peerName ?? ''),
            )}</h2>
            <div class="mo-countline">
              <span class="mo-count">${fmt(championCells)}</span>
              <span class="mo-unit"><b>个月</b><i>的聊天第一名</i></span>
            </div>
            <p class="mo-note">${
              championCells >= monthCount
                ? '整整一路，TA 都没有把第一让给别人。'
                : `TA 拿下了 ${fmt(championCells)} 个月的第一，${
                    monthCount < 12 ? '今年' : '全年'
                  }和你聊了 ${fmt(Number(champion.messages ?? 0))} 条。`
            }</p>
            <div class="mo-calendar">
              <p class="mo-calendar-head">每月的聊天第一名</p>
              <ol class="mo-months">${calendar}</ol>
            </div>
            <p class="mo-mood">真正陪你走过时间的，不是哪一条消息——是那个总在对话框另一边、从不缺席的人。</p>`
          : `<div class="mo-lede">${escapeHtml(reportEraLabel(year))}，这一年还没有足够多的双向私聊，
              讲不出「谁陪你走过」的故事。</div>`
      }
    </div>${slideFoot(`${reportPeriodLabel(year)} · MONTHS`)}`;
}

/**
 * 还没加好友的同路人页的导出版。
 *
 * 静态产物同样把冠军顶成主体：衬线首字圆 + 大名字 + 「N 个群」巨数；共同群
 * 名单排成页底一行可读的群名，冠军之外的推荐收进发丝线以上的小卡。数据与
 * 屏幕版同源，不做二次统计。
 */
function mateSlide(data: Record<string, unknown>): string {
  const year = Number(data.year ?? 0);
  const top = (data.top ?? null) as {
    uid?: string;
    uin?: string;
    peerUin?: string;
    name?: string;
    sharedCount?: number;
    groups?: Array<{ groupName?: string }>;
  } | null;
  const more = (data.more ?? []) as Array<{
    uid?: string;
    uin?: string;
    name?: string;
    sharedCount?: number;
  }>;
  const initial = (name: string): string => Array.from(name)[0] ?? '?';
  const nameClass = (name: string): string => {
    const width = [...name].reduce(
      (sum, char) => sum + (/\p{Script=Han}/u.test(char) ? 1 : 0.6),
      0,
    );
    return width > 9 ? ' xl' : width > 6 ? ' long' : '';
  };

  const dots = Array.from({ length: 8 }, (_, index) => {
    const angle = index * 45;
    return `<i class="mt-dot" style="transform: rotate(${angle}deg) translateY(-66mm) rotate(${-angle}deg)"></i>`;
  }).join('');
  const chips = (top?.groups ?? [])
    .slice(0, 5)
    .map(
      (group, index) =>
        `<span class="mt-chip"><i>${String(index + 1).padStart(2, '0')}</i>${escapeHtml(
          String(group.groupName ?? ''),
        )}</span>`,
    )
    .join('');
  const chipsPlus =
    (top?.sharedCount ?? 0) > (top?.groups ?? []).length
      ? `<span class="mt-chip more">+${fmt(
          Number(top?.sharedCount ?? 0) - (top?.groups ?? []).length,
        )}</span>`
      : '';
  const moreHtml = more
    .map(
      (candidate, index) => `<li class="mt-more-item">
        <span class="mt-rank">0${index + 2}</span>
        <span class="mt-mini">${escapeHtml(initial(String(candidate.name ?? '')))}</span>
        <span class="mt-more-name">${escapeHtml(String(candidate.name ?? ''))}</span>
        <b class="mt-more-val">${fmt(Number(candidate.sharedCount ?? 0))}</b>
        <span class="mt-more-unit">个群</span>
      </li>`,
    )
    .join('');

  return `${slideOpen('缘')}
    <div class="mt">
      <div class="mt-kicker">
        <span>${escapeHtml(reportEraLabel(year))} · 还没加好友的同路人</span>
        <span class="mt-kicker-meta"><b>${fmt(Number(data.groupCount ?? 0))}</b> 个群 / <b>${fmt(
          Number(data.personCount ?? 0),
        )}</b> 位未加好友的群友</span>
      </div>
      ${
        top
          ? `<div class="mt-orbit">
              <i class="mt-ring"></i>
              <i class="mt-ring b"></i>
              ${dots}
            </div>
            <div class="mt-hero">
              <p class="mt-lede">有些人你以为不认识，其实已经在群里见过很多面了——</p>
              <div class="mt-avatar">${avatarImg(
                top.uin ?? top.peerUin,
                String(top.name ?? ''),
                'mt-avatar-face',
              )}</div>
              <h2 class="mt-name${nameClass(String(top.name ?? ''))}">${escapeHtml(
                String(top.name ?? ''),
              )}</h2>
              <div class="mt-countline">
                <span class="mt-count">${fmt(Number(top.sharedCount ?? 0))}</span>
                <span class="mt-unit"><b>个群</b><i>里有 TA</i></span>
              </div>
              <p class="mt-note">你们还没有加好友——但同一个圈子里，已经重逢了
                <b>${fmt(Number(top.sharedCount ?? 0))}</b> 次。</p>
            </div>
            <div class="mt-cluster">
              <p class="mt-cluster-in">这些群，就是 TA 的「生态位」</p>
              <p class="mt-chips">${chips}${chipsPlus}</p>
            </div>
            ${more.length > 0 ? `<ol class="mt-more">${moreHtml}</ol>` : ''}
            <p class="mt-mood">世界很大，圈子很小。同频的人值得一句「你好」——也许加了好友以后，你们会更熟。</p>`
          : `<p class="mt-lede">在这些群里，还没有一个值得专门加好友的「重逢」。</p>`
      }
    </div>${slideFoot(`${reportPeriodLabel(year)} · MATE`)}`;
}

function endSlide(data: Record<string, unknown>): string {
  const year = Number(data.year ?? 0);
  const allTime = isAllTimeYear(year);
  return `${slideOpen('FIN', true)}
    <div class="end">
      <div class="end-line">${allTime ? '你说过的话，都在这里了。' : '这一年的话都说完了。'}</div>
      <div class="end-title">The End</div>
      <div class="end-sub">聊天记录只留在这台电脑上。<br>${
        allTime ? '往后的话，也还长。' : '明年这个时候，我们再看一次。'
      }</div>
    </div>${slideFoot(`${reportPeriodLabel(year)} · FIN`)}`;
}

/** QQ 空间说说正文 → 一行可读的安全摘录（提及 / 表情 token 只做文本兜底）。 */
function qzoneQuote(value: unknown): string {
  const clean = String(value ?? '')
    .replace(/@\{uin:[^,]+,[^}]+\}/g, '@朋友')
    .replace(/\[em\]e\d+\[\/em\]/g, '[表情]')
    .replace(/\s+/g, ' ')
    .trim();
  if (clean) return clean.length > 58 ? `${clean.slice(0, 58)}…` : clean;
  return '这条说说没有留下文字。';
}

/** `N月M日` / `YYYY年N月M日` —— 与屏幕版时光胶片同一份时间语言。 */
function qzoneDay(sec: number, withYear: boolean): string {
  if (!sec) return '';
  const date = new Date(sec * 1000);
  const label = `${date.getMonth() + 1}月${date.getDate()}日`;
  return withYear ? `${date.getFullYear()}年${label}` : label;
}

/** QQ 空间回忆页的导出版。 */
function qzoneSlide(data: Record<string, unknown>): string {
  const year = Number(data.year ?? 0);
  const allTime = isAllTimeYear(year);
  const gallery = (data.gallery ?? []) as Array<{
    tid?: string;
    time?: number;
    content?: string;
    images?: string[];
    videoCover?: string;
    hasVideo?: boolean;
    likeCount?: number | null;
    commentCount?: number;
    isPrivate?: boolean;
  }>;
  const highlight = (data.highlight ?? null) as {
    post?: (typeof gallery)[number];
    metric?: 'like' | 'comment';
    count?: number;
  } | null;
  const firstYear = Number(data.firstPostTime ?? 0)
    ? `${new Date(Number(data.firstPostTime) * 1000).getFullYear()} 年`
    : '';
  const frames = gallery
    .slice(0, 8)
    .map((post) => {
      const tags: string[] = [];
      if ((post.images?.length ?? 0) > 0) tags.push('图');
      if (post.hasVideo) tags.push('影');
      if (post.likeCount) tags.push(`♥${fmt(post.likeCount)}`);
      const date = qzoneDay(Number(post.time ?? 0), allTime);
      return `<div class="qz-frame"><span class="qz-frame-date">${escapeHtml(
        date,
      )}</span>${tags.length > 0 ? `<span class="qz-frame-tag">${tags.join(' · ')}</span>` : ''}<p class="qz-frame-text">${escapeHtml(
        qzoneQuote(post.content),
      )}</p></div>`;
    })
    .join('');

  const gem = highlight?.post
    ? `<div class="qz-gem">
        <div class="qz-gem-copy">
          <p class="qz-gem-eyebrow">${highlight.metric === 'like' ? '被赞得最多的一条' : '被评论最多的一条'}</p>
          <p class="qz-gem-quote">“${escapeHtml(qzoneQuote(highlight.post.content))}”</p>
          <p class="qz-gem-meta">${escapeHtml(
            qzoneDay(Number(highlight.post.time ?? 0), allTime),
          )} · <b>${fmt(Number(highlight.count ?? 0))}</b> ${highlight.metric === 'like' ? '次赞' : '条评论'}</p>
        </div>
        <div class="qz-gem-mark" aria-hidden>”</div>
      </div>`
    : '';

  return `${slideOpen('忆')}
    <div class="qz">
      <div class="qz-kicker">
        <span>${escapeHtml(reportEraLabel(year))} · QQ空间回忆</span>
        <span class="qz-kicker-meta">${allTime && firstYear ? `<b>${escapeHtml(firstYear.trim())}</b> 起 / ` : ''}<b>${fmt(
          Number(data.total ?? 0),
        )}</b> 条说说</span>
      </div>
      <p class="qz-lede">${allTime ? '这一路，你把生活寄放在空间里' : `${year} 这一年，你把生活的一部分寄存在空间里`}</p>
      <div class="qz-countline">
        <span class="qz-count">${fmt(Number(data.total ?? 0))}</span>
        <span class="qz-unit"><b>条</b><i>写下的说说</i></span>
      </div>
      <p class="qz-mood">它们未必被很多人看见，却都替你记着那时的你。</p>
      ${gem}
      ${
        frames
          ? `<div class="qz-reel">
              <p class="qz-reel-in">时光胶片 · ${allTime ? '往回翻，每一帧都是你' : `这一年，你留在空间里的画面`}</p>
              <div class="qz-frames">${frames}</div>
            </div>`
          : ''
      }
    </div>${slideFoot(`${reportPeriodLabel(year)} · QZONE`)}`;
}

function genericSlide(slide: ExportSlide): string {
  return `${slideOpen(slide.page.category)}
    <div class="eyebrow">${escapeHtml(slide.page.category)}</div>
    <div class="title">${escapeHtml(slide.page.title)}</div>
    <div class="desc">${escapeHtml(slide.page.description)}</div>
    <div class="note">这张卡片的数据暂未适配导出视图，导出里只保留标题。</div>${slideFoot(slide.page.id)}`;
}

/**
 * 导出用的资源内联器：把屏幕版走 `weq-media://` / CDN 协议的图片在导出时
 * 拉成字节并转成 data URI，自包含 HTML 因此能带真实贴图（装扮气泡、头像）。
 *
 * 由调用方（EndPage）注入实现 —— renderer 通过 tRPC 让主进程读文件并返回
 * base64；解析失败返回 null，导出版退回原来的排印表达，不阻塞导出。
 */
export type AssetInliner = (url: string) => Promise<string | null>;

/**
 * 预热好的 data URI 快照。buildReportHtml 的 slide 渲染是同步的，必须先把
 * 所有 data URI 在这里准备停当，同步的 `inlinedAsset` 才有东西可查。
 */
const assetValueCache = new Map<string, string | null>();

/**
 * 预热：把 slides 里引用到的所有协议图片先拉好。任一图失败只是缺席，
 * 导出退回排印表达，不阻塞。
 */
export async function preloadReportAssets(
  slides: ExportSlide[],
  resolve: AssetInliner,
): Promise<void> {
  const urls = collectAssetUrls(slides);
  assetValueCache.clear();
  await Promise.all(
    urls.map(async (url) => {
      let value: string | null = null;
      try {
        value = await resolve(url);
      } catch {
        value = null;
      }
      if (value) assetValueCache.set(url, value);
    }),
  );
}

/** 同步取已经预热好的 data URI；没预热过/解析失败返回 null（退回排印版）。 */
export function inlinedAsset(url: string | null | undefined): string | null {
  if (!url || assetValueCache.size === 0) return null;
  return assetValueCache.get(url) ?? null;
}

function collectAssetUrls(slides: ExportSlide[]): string[] {
  const urls = new Set<string>();
  for (const slide of slides) {
    const data = (slide.data ?? {}) as Record<string, unknown>;
    if (slide.page.id === 'dress') {
      const outfits = (data.outfits ?? []) as Array<{ bubbleId?: number }>;
      for (const outfit of outfits) {
        if (outfit.bubbleId && outfit.bubbleId > 0) {
          urls.add(mediaUrl('dressbubble', { id: outfit.bubbleId }));
        }
      }
    }
    // 头像：openers / months / friends / mate 各页的 peerUin。
    const collectUin = (value: unknown): void => {
      if (value && typeof value === 'object') {
        const uin = (value as { peerUin?: unknown }).peerUin;
        if (typeof uin === 'string' && /^\d+$/.test(uin)) {
          urls.add(
            mediaUrl('avatar', {
              scope: 'user',
              uin,
              v: 'big',
              fb: `https://thirdqq.qlogo.cn/g?b=sdk&s=0&nk=${uin}`,
            }),
          );
        }
        for (const nested of Object.values(value)) collectUin(nested);
      } else if (Array.isArray(value)) {
        for (const item of value) collectUin(item);
      }
    };
    collectUin(data);
  }
  return [...urls];
}

/**
 * 由已加载的页面数据拼出自包含 HTML 文档。口径文案（历史以来 / xxxx 年）
 * 由每页数据里的 `year` 自证，与屏幕版共用 `@weq/service/report-time`。
 *
 * 传了 `assets`（先 preloadReportAssets 预热过）时，装扮页画真实气泡贴图、
 * 人物页画真实头像（data URI 内联）；否则维持纯排印的退化版。
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
      if (slide.page.id === 'voice') return voiceSlide(data);
      if (slide.page.id === 'home') return homeSlide(data);
      if (slide.page.id === 'interactions') return interactionsSlide(data);
      if (slide.page.id === 'months') return monthsSlide(data);
      if (slide.page.id === 'mate') return mateSlide(data);
      if (slide.page.id === 'qzone') return qzoneSlide(data);
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
<style>${CSS}${INTERACTIVE_CSS}</style>
</head>
<body>
${body}
<script>${INTERACTIVE_JS}</script>
</body>
</html>`;
}

/**
 * 屏幕浏览专属的呈现层：居中纸面 + 滚动翻页动画。全部包在
 * `@media screen` 里 —— printToPDF 走 print 媒体，A4 分页与打印布局完全
 * 不受影响。翻页动画用 IntersectionObserver：翻到哪页哪页淡入上浮，
 * 无 JS 时（邮件附件预览等）优雅退化为普通滚动文档。
 */
const INTERACTIVE_CSS = `
  @media screen {
    body {
      display: flex;
      flex-direction: column;
      align-items: center;
      gap: 10mm;
      padding: 10mm 0 16mm;
    }
    .slide {
      box-shadow:
        0 1mm 3mm rgba(0, 0, 0, 0.18),
        0 12mm 32mm rgba(0, 0, 0, 0.22);
      opacity: 0;
      transform: translateY(26px) scale(0.985);
      transition:
        opacity 720ms cubic-bezier(0.22, 1, 0.36, 1),
        transform 720ms cubic-bezier(0.22, 1, 0.36, 1);
    }
    .slide.is-visible {
      opacity: 1;
      transform: none;
    }
    @media (prefers-reduced-motion: reduce) {
      .slide { opacity: 1; transform: none; transition: none; }
    }
  }
`;

const INTERACTIVE_JS = `
(function () {
  'use strict';
  var slides = document.querySelectorAll('.slide');
  if (!('IntersectionObserver' in window)) {
    for (var i = 0; i < slides.length; i++) slides[i].classList.add('is-visible');
    return;
  }
  var observer = new IntersectionObserver(
    function (entries) {
      for (var j = 0; j < entries.length; j++) {
        if (entries[j].isIntersecting) {
          entries[j].target.classList.add('is-visible');
          observer.unobserve(entries[j].target);
        }
      }
    },
    { threshold: 0.18 }
  );
  for (var k = 0; k < slides.length; k++) observer.observe(slides[k]);
})();
`;
