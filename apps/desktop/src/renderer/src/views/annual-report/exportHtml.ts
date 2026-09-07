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
