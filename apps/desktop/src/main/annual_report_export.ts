/**
 * 年度报告导出 —— 三种产物共享同一份数据契约（renderer 已算好的页面 JSON）：
 *
 *   - HTML：renderer 侧拼好自包含 HTML 字符串，本模块只管落盘；
 *   - PDF ：把同一份 HTML 载入隔离窗口，`printToPDF` 按 A4 逐页输出；
 *   - 长图：satori（JSX 元素树 → SVG）+ resvg（SVG → PNG），全部卡片竖排
 *     拼成一张 9:16 分享长图，无需任何 DOM 截图。
 *
 * 长图刻意不用「窗口截图再拼接」：没有拼图依赖，且 satori 输出确定、无字体
 * 落位抖动。与 weq_assistant/cover.ts 共用同一条 satori+resvg 管线与 CJK 字体。
 */

import { BrowserWindow } from 'electron';
import { loadCjkFont } from './weq_assistant/cover';
import satori from 'satori';
import { Resvg } from '@resvg/resvg-js';

/** 一张导出卡片的最小契约 —— 与 renderer 发送的页面数据对齐。 */
export type ReportExportSlide = {
  pageId: string;
  title: string;
  description: string;
  category: string;
  /** 该页面 compute 返回的纯 JSON 数据。 */
  data: unknown;
};

// ---- 长图（satori → PNG）------------------------------------------------

/** 长图单张卡片的画幅（9:16 竖屏，适合分享）。 */
const SLIDE_W = 1080;
const SLIDE_H = 1920;
/** 渲染超采样倍数 —— 2× 出图后由查看器缩放，CJK 边缘更干净。 */
const PNG_SCALE = 2;

type El = { type: string; props: Record<string, unknown> };
function el(type: string, style: Record<string, unknown>, children?: unknown): El {
  return { type, props: { style, children } };
}

/**
 * 深色 editorial 调色板 —— 与屏幕报告的深色主题同源（炭黑纸 + 暖金）。
 * 长图固定深色：分享出去的图不该跟着导出者的系统主题变。
 */
const PALETTE = {
  paper: '#0b0a09',
  paperDeep: '#060505',
  ink: '#f4f0e6',
  inkSoft: 'rgba(244,240,230,0.76)',
  inkMuted: 'rgba(244,240,230,0.46)',
  inkFaint: 'rgba(244,240,230,0.22)',
  hair: 'rgba(244,240,230,0.14)',
  accent: '#c9a227',
  ghostStroke: 'rgba(201,162,39,0.13)',
};

function fmt(n: number): string {
  return new Intl.NumberFormat('zh-CN').format(n);
}

/** 与屏幕版 OverviewPage 的 `formatPerDay` 同一口径，含「<0.1」低值档。 */
function formatPerDay(perDay: number): string {
  if (perDay >= 10) return fmt(Math.round(perDay));
  if (perDay >= 1) return perDay.toFixed(1);
  if (perDay >= 0.1) return perDay.toFixed(2);
  return perDay > 0 ? '<0.1' : '0';
}

/**
 * 这一年已经过完的天数。与屏幕版 OverviewPage 的 `elapsedDays` 同一口径：
 * 当年只算到今天，往年算整年 —— 否则同一份数据在屏幕上和长图里日均会不同。
 */
function elapsedDays(year: number): number {
  const now = new Date();
  if (year !== now.getFullYear()) {
    const isLeap = (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0;
    return isLeap ? 366 : 365;
  }
  const diff = (now.getTime() - new Date(year, 0, 1).getTime()) / 86_400_000;
  return Math.max(1, Math.ceil(diff));
}

/** 一条发丝分隔线。satori 没有 border 简写的完整支持，用实心 div 更稳。 */
function hair(marginTop = 0): El {
  return el('div', {
    marginTop,
    width: SLIDE_W - 144,
    height: 1,
    backgroundColor: PALETTE.hair,
  });
}

/**
 * 一张长图卡片的骨架：顶部品牌行 + 出血幽灵字 + 居中内容 + 底部页脚。
 * `ghost` 传年份或 FIN，`ghostCenter` 决定是压在右下角还是正中。
 *
 * satori 不支持 -webkit-text-stroke，所以幽灵字用极低不透明度的实心大字代替，
 * 视觉目的（衬底层次）一致。位置用 top 而不是 bottom 定位：satori 对
 * `bottom` + 大 fontSize 的基线计算会把整行推到画布外，用 top 可控。
 */
function slideFrame(children: unknown[], ghost?: string, ghostCenter = false): El {
  const ghostEl = ghost
    ? el(
        'div',
        ghostCenter
          ? {
              position: 'absolute',
              top: SLIDE_H / 2 - 260,
              left: 0,
              width: SLIDE_W,
              display: 'flex',
              justifyContent: 'center',
              fontSize: 420,
              fontWeight: 700,
              color: PALETTE.ghostStroke,
              lineHeight: 1,
            }
          : {
              // 右下角出血：字宽溢出右侧，下缘约 1/3 被画布裁掉。
              position: 'absolute',
              top: SLIDE_H - 330,
              left: 300,
              width: 1200,
              display: 'flex',
              fontSize: 470,
              fontWeight: 700,
              color: PALETTE.ghostStroke,
              lineHeight: 1,
            },
        ghost,
      )
    : null;

  return el(
    'div',
    {
      width: SLIDE_W,
      height: SLIDE_H,
      display: 'flex',
      position: 'relative',
      overflow: 'hidden',
      fontFamily: 'Report',
      backgroundColor: PALETTE.paper,
      backgroundImage: `linear-gradient(168deg, ${PALETTE.paper} 0%, ${PALETTE.paperDeep} 100%)`,
    },
    [
      ...(ghostEl ? [ghostEl] : []),
      // 顶部品牌行 + 发丝线
      el(
        'div',
        {
          position: 'absolute',
          top: 78,
          left: 72,
          width: SLIDE_W - 144,
          display: 'flex',
          flexDirection: 'column',
        },
        [
          el('div', { display: 'flex', justifyContent: 'space-between', alignItems: 'center' }, [
            el(
              'div',
              { fontSize: 22, fontWeight: 700, color: PALETTE.accent, letterSpacing: 10 },
              'WEQ 年度报告',
            ),
            el(
              'div',
              { fontSize: 20, color: PALETTE.inkFaint, letterSpacing: 7 },
              'QQ CHAT WRAPPED',
            ),
          ]),
          hair(22),
        ],
      ),
      // 底部页脚 + 发丝线
      el(
        'div',
        {
          position: 'absolute',
          bottom: 76,
          left: 72,
          width: SLIDE_W - 144,
          display: 'flex',
          flexDirection: 'column',
        },
        [
          hair(0),
          el(
            'div',
            {
              marginTop: 20,
              fontSize: 19,
              color: PALETTE.inkFaint,
              letterSpacing: 5,
            },
            '数据来自本机 QQ 聊天记录 · 私聊 + 群聊',
          ),
        ],
      ),
      // 内容层（垂直居中）
      el(
        'div',
        {
          position: 'absolute',
          top: 0,
          left: 0,
          width: SLIDE_W,
          height: SLIDE_H,
          display: 'flex',
          flexDirection: 'column',
          justifyContent: 'center',
          padding: '210px 72px 200px',
        },
        children,
      ),
    ],
  );
}

/** 「私聊 / 群聊」分割轨 —— 一条 6px 实线，两段颜色，配左右对齐的图例。 */
function railBlock(c2cSent: number, groupSent: number, c2cPct: number, groupPct: number): El {
  const legendSide = (
    parts: Array<{ text: string; size: number; color: string; spacing?: number }>,
  ): El =>
    el(
      'div',
      { display: 'flex', alignItems: 'baseline' },
      parts.map((part, index) =>
        el(
          'div',
          {
            marginLeft: index === 0 ? 0 : 16,
            fontSize: part.size,
            fontWeight: 700,
            color: part.color,
            letterSpacing: part.spacing ?? 0,
          },
          part.text,
        ),
      ),
    );

  return el('div', { marginTop: 74, display: 'flex', flexDirection: 'column' }, [
    el('div', { display: 'flex', width: SLIDE_W - 144, height: 6 }, [
      el('div', { width: `${c2cPct}%`, height: 6, backgroundColor: PALETTE.accent }),
      el('div', { width: `${groupPct}%`, height: 6, backgroundColor: 'rgba(244,240,230,0.34)' }),
    ]),
    el(
      'div',
      { marginTop: 26, display: 'flex', justifyContent: 'space-between', width: SLIDE_W - 144 },
      [
        legendSide([
          { text: `${c2cPct}%`, size: 52, color: PALETTE.accent },
          { text: '私聊', size: 26, color: PALETTE.ink, spacing: 6 },
          { text: fmt(c2cSent), size: 22, color: PALETTE.inkFaint },
        ]),
        legendSide([
          { text: fmt(groupSent), size: 22, color: PALETTE.inkFaint },
          { text: '群聊', size: 26, color: PALETTE.ink, spacing: 6 },
          { text: `${groupPct}%`, size: 52, color: PALETTE.inkSoft },
        ]),
      ],
    ),
  ]);
}

/**
 * 底部三格数据带。satori 不落地 `borderLeft` 简写（传 undefined 还会直接崩），
 * 所以格间分隔改用一条显式的 1px 实心竖线 div。
 */
function bandBlock(cells: Array<{ label: string; value: string; unit: string }>): El {
  const CELL_H = 132;
  const divider = el('div', {
    width: 1,
    height: CELL_H,
    marginTop: 32,
    backgroundColor: PALETTE.hair,
  });
  const cellEl = (cell: { label: string; value: string; unit: string }, index: number): El =>
    el(
      'div',
      {
        display: 'flex',
        flex: 1,
        height: CELL_H,
        paddingTop: 32,
        paddingLeft: index === 0 ? 0 : 34,
        paddingRight: 34,
        flexDirection: 'column',
      },
      [
        el('div', { fontSize: 20, color: PALETTE.inkFaint, letterSpacing: 6 }, cell.label),
        el('div', { marginTop: 14, display: 'flex', alignItems: 'baseline' }, [
          el('div', { fontSize: 60, fontWeight: 700, color: PALETTE.ink }, cell.value),
          el(
            'div',
            { marginLeft: 10, fontSize: 24, color: PALETTE.inkMuted, letterSpacing: 4 },
            cell.unit,
          ),
        ]),
      ],
    );

  const row: El[] = [];
  cells.forEach((cell, index) => {
    if (index > 0) row.push(divider);
    row.push(cellEl(cell, index));
  });

  return el('div', { marginTop: 96, display: 'flex', flexDirection: 'column' }, [
    hair(0),
    el('div', { display: 'flex', width: SLIDE_W - 144 }, row),
  ]);
}

function overviewTree(data: Record<string, unknown>, startYear: number): El {
  const year = Number(data.year ?? 0);
  const totalSent = Number(data.totalSent ?? 0);
  const totalReceived = Number(data.totalReceived ?? 0);
  const c2cSent = Number(data.c2cSent ?? 0);
  const groupSent = Number(data.groupSent ?? 0);
  const sentSum = Math.max(1, c2cSent + groupSent);
  const c2cPct = Math.round((c2cSent / sentSum) * 100);
  const groupPct = 100 - c2cPct;
  const perDay = totalSent / elapsedDays(year);
  const echo = totalSent > 0 ? Math.round((totalReceived / totalSent) * 100) : 0;
  // 与屏幕版同一条文案规则：最早有记录的那年用「历史以来」。
  const eraLabel = year === startYear ? '历史以来' : `${year} 年`;

  return slideFrame(
    [
      el(
        'div',
        { fontSize: 22, letterSpacing: 12, color: PALETTE.accent, fontWeight: 700 },
        '年度总览 · OVERVIEW',
      ),
      el(
        'div',
        { marginTop: 40, fontSize: 40, color: PALETTE.inkSoft, letterSpacing: 6 },
        `${eraLabel}，你一共说出了`,
      ),
      // 主角：巨型数字 + 基线对齐的单位
      el('div', { marginTop: 10, display: 'flex', alignItems: 'baseline' }, [
        el(
          'div',
          { fontSize: 200, fontWeight: 700, color: PALETTE.ink, letterSpacing: -6 },
          fmt(totalSent),
        ),
        el(
          'div',
          { marginLeft: 28, fontSize: 46, color: PALETTE.inkMuted, letterSpacing: 8 },
          '条消息',
        ),
      ]),
      railBlock(c2cSent, groupSent, c2cPct, groupPct),
      bandBlock([
        {
          label: '日均',
          value: formatPerDay(perDay),
          unit: '条',
        },
        { label: '收到', value: fmt(totalReceived), unit: '条' },
        { label: '你说 100 句，回声', value: fmt(echo), unit: '句' },
      ]),
    ],
    String(year),
  );
}

function endTree(data: Record<string, unknown>): El {
  const year = Number(data.year ?? 0);
  return slideFrame(
    [
      el('div', { display: 'flex', flexDirection: 'column', alignItems: 'center' }, [
        el(
          'div',
          { fontSize: 30, color: PALETTE.inkMuted, letterSpacing: 12 },
          '这一年的话都说完了。',
        ),
        el(
          'div',
          { marginTop: 26, fontSize: 168, fontWeight: 700, color: PALETTE.ink, letterSpacing: 14 },
          '辛苦了',
        ),
        el(
          'div',
          { marginTop: 52, fontSize: 30, color: PALETTE.inkSoft, letterSpacing: 4 },
          '聊天记录只留在这台电脑上。',
        ),
        el(
          'div',
          { marginTop: 18, fontSize: 30, color: PALETTE.inkSoft, letterSpacing: 4 },
          '明年这个时候，我们再看一次。',
        ),
        el('div', { marginTop: 78, width: 120, height: 1, backgroundColor: PALETTE.hair }),
        el(
          'div',
          { marginTop: 30, fontSize: 24, color: PALETTE.accent, letterSpacing: 10 },
          `${year} 年度报告`,
        ),
      ]),
    ],
    'FIN',
    true,
  );
}

function genericTree(slide: ReportExportSlide): El {
  return slideFrame(
    [
      el(
        'div',
        { fontSize: 22, letterSpacing: 12, color: PALETTE.accent, fontWeight: 700 },
        slide.category,
      ),
      el(
        'div',
        { marginTop: 40, fontSize: 92, fontWeight: 700, color: PALETTE.ink, letterSpacing: 2 },
        slide.title,
      ),
      el(
        'div',
        { marginTop: 30, fontSize: 32, color: PALETTE.inkSoft, lineHeight: 1.8 },
        slide.description,
      ),
      el('div', { marginTop: 70, display: 'flex', flexDirection: 'column' }, [
        hair(0),
        el(
          'div',
          { marginTop: 26, fontSize: 24, color: PALETTE.inkFaint, letterSpacing: 4 },
          '这张卡片的数据暂未适配导出视图，导出里只保留标题。',
        ),
      ]),
    ],
    slide.category,
  );
}

function treeForSlide(slide: ReportExportSlide, startYear: number): El {
  const data = (slide.data ?? {}) as Record<string, unknown>;
  if (slide.pageId === 'overview') return overviewTree(data, startYear);
  if (slide.pageId === 'end') return endTree(data);
  return genericTree(slide);
}

/**
 * 把全部卡片竖排渲染成一张长图 PNG。卡片数量 × 1920px 可能很高，satori/resvg
 * 都能直接处理；输出按 SLIDE_W × 2 超采样，保证 CJK 清晰。
 *
 * `startYear` 是账号最早有记录的年份，用于「历史以来 / xxxx 年」文案分支。
 */
export async function renderLongImagePng(
  slides: ReportExportSlide[],
  startYear = 0,
): Promise<Buffer> {
  const fontData = loadCjkFont();
  const root = el(
    'div',
    {
      width: SLIDE_W,
      height: SLIDE_H * Math.max(1, slides.length),
      display: 'flex',
      flexDirection: 'column',
    },
    slides.map((slide) => treeForSlide(slide, startYear)),
  );
  const svg = await satori(root as unknown as import('react').ReactNode, {
    width: SLIDE_W,
    height: SLIDE_H * Math.max(1, slides.length),
    fonts: [
      { name: 'Report', data: fontData, weight: 400, style: 'normal' },
      { name: 'Report', data: fontData, weight: 700, style: 'normal' },
    ],
  });
  return new Resvg(svg, { fitTo: { mode: 'width', value: SLIDE_W * PNG_SCALE } }).render().asPng();
}

// ---- PDF（隐藏窗口 + printToPDF）----------------------------------------

/**
 * 把 renderer 拼好的自包含 HTML（内联样式、无外部依赖）渲染成 PDF。
 * 复用 link_shot 的隔离窗口范式：不可见、沙箱、无 preload、不碰账号会话。
 */
export async function renderPdfFromHtml(html: string): Promise<Buffer> {
  const win = new BrowserWindow({
    width: 900,
    height: 1300,
    show: false,
    webPreferences: {
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
      javascript: true,
    },
  });
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  try {
    const loaded = win.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(html)}`);
    await Promise.race([loaded, new Promise((resolve) => setTimeout(resolve, 8000))]);
    if (win.isDestroyed()) throw new Error('窗口已销毁');
    // 等字体/布局落定，避免首帧缺字。
    await win.webContents
      .executeJavaScript('document.fonts.ready.then(() => true)')
      .catch(() => true);
    const pdf = await win.webContents.printToPDF({
      printBackground: true,
      pageSize: 'A4',
      margins: { top: 0, bottom: 0, left: 0, right: 0 },
      preferCSSPageSize: true,
    });
    if (pdf.length === 0) throw new Error('printToPDF 返回空文件');
    return pdf;
  } finally {
    if (!win.isDestroyed()) win.destroy();
  }
}
