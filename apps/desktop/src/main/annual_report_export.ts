/**
 * 年度报告导出 —— 共享同一份数据契约（renderer 已算好的页面 JSON）：
 *
 *   - HTML：renderer 侧拼好自包含 HTML 字符串，本模块只管落盘；
 *   - 长图：satori（JSX 元素树 → SVG）+ resvg（SVG → PNG），全部卡片竖排
 *     拼成一张 9:16 分享长图，无需任何 DOM 截图。
 *   - PDF ：把同一份 HTML 载入隔离窗口，`printToPDF` 按 A4 逐页输出 —— 该实现
 *     依赖 Electron，拆在 `annual_report_pdf.ts` 里由桌面 host 注入，避免把
 *     `electron` 带进共享 router / web bundle。
 *
 * 长图刻意不用「窗口截图再拼接」：没有拼图依赖，且 satori 输出确定、无字体
 * 落位抖动。与 weq_assistant/cover.ts 共用同一条 satori+resvg 管线与 CJK 字体。
 */

import { loadCjkFont } from './weq_assistant/cover';
import satori from 'satori';
import { Resvg } from '@resvg/resvg-js';
import { isAllTimeYear, reportEraLabel, reportSinceLabel } from '@weq/service/report-time';

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

function overviewTree(data: Record<string, unknown>): El {
  const year = Number(data.year ?? 0);
  const totalSent = Number(data.totalSent ?? 0);
  const totalReceived = Number(data.totalReceived ?? 0);
  const c2cSent = Number(data.c2cSent ?? 0);
  const groupSent = Number(data.groupSent ?? 0);
  const sentSum = Math.max(1, c2cSent + groupSent);
  const c2cPct = Math.round((c2cSent / sentSum) * 100);
  const groupPct = 100 - c2cPct;
  // 日均分母由服务端下发，屏幕版 / HTML / 长图三处同源。
  const perDay = totalSent / Math.max(1, Number(data.spanDays ?? 1));
  const echo = totalSent > 0 ? Math.round((totalReceived / totalSent) * 100) : 0;
  const firstMessageTime = typeof data.firstMessageTime === 'number' ? data.firstMessageTime : null;
  const since = reportSinceLabel(year, firstMessageTime);
  const eraLabel = reportEraLabel(year) + (since ? `（${since}）` : '');

  return slideFrame(
    [
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
    isAllTimeYear(year) ? 'ALL' : String(year),
  );
}

/**
 * 装扮页的长图版。
 *
 * 与 HTML 导出同一个取舍（见 exportHtml.ts 的 dressSlide）：屏幕上那页的主角是真实
 * 渲染的气泡贴图 + 头像挂件，而 satori 只画传进来的这棵树 —— 贴图要先读盘再内联，
 * 一张 9:16 长图会因此涨到几十 MB。
 *
 * 所以长图版换的是皮不是骨：单位仍然是「一套」，主角仍是最爱的那一身，回忆仍是当年
 * 真说过的话，只是气泡改用排印的引号来盛。装扮编号一律不出现。
 */
function dressTree(data: Record<string, unknown>): El {
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
  const heroLine = hero
    ? hero.samples.reduce((best, s) => (s.length > best.length ? s : best), '')
    : '';
  const wornAs = hero
    ? [
        hero.bubbleName && `气泡「${hero.bubbleName}」`,
        hero.fontName && `字体「${hero.fontName}」`,
        hero.widgetName && `挂件「${hero.widgetName}」`,
      ]
        .filter(Boolean)
        .join(' · ')
    : '';

  return slideFrame(
    [
      el(
        'div',
        { fontSize: 40, color: PALETTE.accent, letterSpacing: 10 },
        `${reportEraLabel(year)}，我最爱这身装扮`,
      ),
      ...(heroLine
        ? [
            el(
              'div',
              {
                marginTop: 40,
                fontSize: 72,
                fontWeight: 700,
                color: PALETTE.ink,
                lineHeight: 1.45,
              },
              `“${heroLine}”`,
            ),
          ]
        : []),
      ...(hero
        ? [
            el('div', { marginTop: 30, display: 'flex', alignItems: 'baseline' }, [
              el(
                'div',
                { fontSize: 128, fontWeight: 700, color: PALETTE.ink, letterSpacing: -4 },
                fmt(hero.count),
              ),
              el(
                'div',
                { marginLeft: 22, fontSize: 34, color: PALETTE.inkMuted, letterSpacing: 6 },
                '条消息使用这身装扮',
              ),
            ]),
          ]
        : []),
      ...(wornAs
        ? [el('div', { marginTop: 10, fontSize: 26, color: PALETTE.inkSoft }, wornAs)]
        : []),
      el('div', { marginTop: 40, width: SLIDE_W - 144, height: 1, backgroundColor: PALETTE.hair }),
      el(
        'div',
        { marginTop: 26, fontSize: 28, color: PALETTE.inkMuted, letterSpacing: 2 },
        `总共换过 ${fmt(outfitCount)} 身，打扮了 ${fmt(decorated)} 条消息${
          coverage > 0 ? `（占你发言的 ${coverage}%）` : ''
        }`,
      ),
      // 用过几款：与屏幕版数据带前三类同一份数字。一款都没有的类目这里不出现。
      ...(kinds.some(([, n]) => n > 0)
        ? [
            el(
              'div',
              { marginTop: 12, display: 'flex', fontSize: 26, color: PALETTE.inkSoft },
              kinds
                .filter(([, n]) => n > 0)
                .map(([label, n], index) =>
                  el('div', index === 0 ? {} : { marginLeft: 26 }, `${label} ${fmt(n)} 款`),
                ),
            ),
          ]
        : []),
    ],
    isAllTimeYear(year) ? 'ALL' : String(year),
  );
}

/**
 * 私聊火花页的长图版。绿墙固定渲染服务端下发的默认墙年（和 HTML 导出同一个
 * 口径），satori 不处理 CSS hover / 交互，所以只保留「一年一墙」的静态图。
 */
function sparkTree(data: Record<string, unknown>): El {
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
  const spark = (data.spark ?? null) as { days: number; peerName: string } | null;
  const sentTotal = Number(data.sentTotal ?? 0);
  const activeDays = Number(data.activeDays ?? 0);
  const longestSelfRun = Number(data.longestSelfRun ?? 0);
  const wall = wallDays.filter((day) => day.year === wallYear);

  const cells = (): El[] => {
    const countByDay = new Map<string, number>();
    for (const day of wall) countByDay.set(`${day.month}-${day.day}`, day.count);
    const start = new Date(wallYear, 0, 1);
    const mondayOffset = (start.getDay() + 6) % 7;
    const leap = (wallYear % 4 === 0 && wallYear % 100 !== 0) || wallYear % 400 === 0;
    const totalDays = leap ? 366 : 365;
    const weekCount = Math.ceil((mondayOffset + totalDays) / 7);
    const max = wall.length ? Math.max(...wall.map((d) => d.count)) : 1;
    const weeks: El[] = [];
    for (let week = 0; week < weekCount; week++) {
      const column: El[] = [];
      for (let dow = 0; dow < 7; dow++) {
        const dayOfYear = week * 7 + dow - mondayOffset;
        if (dayOfYear < 0 || dayOfYear >= totalDays) {
          column.push(cellEl(0));
        } else {
          const date = new Date(wallYear, 0, 1 + dayOfYear);
          const count = countByDay.get(`${date.getMonth() + 1}-${date.getDate()}`) ?? 0;
          column.push(cellEl(count === 0 ? 0 : Math.min(4, 1 + Math.ceil((count / max) * 3))));
        }
      }
      weeks.push(el('div', { display: 'flex', flexDirection: 'column', gap: 3 }, column));
    }
    return weeks;
  };

  const hero = top
    ? [
        el('div', { display: 'flex', justifyContent: 'space-between', alignItems: 'baseline' }, [
          el(
            'div',
            { fontSize: 26, color: PALETTE.inkSoft, letterSpacing: 6 },
            `${isAllTimeYear(year) ? '历史以来' : `${year} 年`} · 全部私聊里最用力的一天`,
          ),
          el(
            'div',
            { fontSize: 28, color: PALETTE.inkMuted, letterSpacing: 2, fontFamily: 'Report' },
            `${top.year} 年 ${top.month} 月 ${top.day} 日`,
          ),
        ]),
        el('div', { marginTop: 30, fontSize: 38, color: PALETTE.inkSoft, letterSpacing: 4 }, [
          `你和 `,
          el('span', { fontWeight: 700, color: PALETTE.ink }, top.peerName),
        ]),
        el('div', { marginTop: 4, display: 'flex', alignItems: 'baseline' }, [
          el(
            'div',
            { fontSize: 168, fontWeight: 700, color: PALETTE.ink, letterSpacing: -6 },
            fmt(top.total),
          ),
          el(
            'div',
            { marginLeft: 24, fontSize: 40, color: PALETTE.inkMuted, letterSpacing: 8 },
            '条消息',
          ),
        ]),
        ...(top.words?.[0]
          ? [
              el(
                'div',
                {
                  marginTop: 14,
                  display: 'flex',
                  alignItems: 'baseline',
                  flexWrap: 'wrap',
                  color: PALETTE.inkMuted,
                },
                [
                  el(
                    'div',
                    { fontSize: 26, color: PALETTE.inkMuted, letterSpacing: 3 },
                    '那天你们说得最多的，是',
                  ),
                  el(
                    'div',
                    {
                      marginLeft: 24,
                      fontSize: top.words[0].length > 8 ? 54 : 96,
                      fontWeight: 700,
                      color: '#3fae70',
                      letterSpacing: 2,
                      lineHeight: 1,
                    },
                    top.words[0],
                  ),
                ],
              ),
            ]
          : []),
      ]
    : [];

  const bandCell = (label: string, value: string, unit: string, note?: string): El =>
    el(
      'div',
      {
        flex: 1,
        display: 'flex',
        flexDirection: 'column',
        paddingTop: 22,
      },
      [
        el('div', { fontSize: 18, color: PALETTE.inkFaint, letterSpacing: 5 }, label),
        el('div', { marginTop: 10, display: 'flex', alignItems: 'baseline' }, [
          el('div', { fontSize: 52, fontWeight: 700, color: PALETTE.ink }, value),
          el(
            'div',
            { marginLeft: 8, fontSize: 22, color: PALETTE.inkMuted, letterSpacing: 3 },
            unit,
          ),
        ]),
        ...(note
          ? [el('div', { marginTop: 8, fontSize: 18, color: '#3fae70', letterSpacing: 1 }, note)]
          : []),
      ],
    );

  const band = el(
    'div',
    {
      marginTop: 64,
      display: 'flex',
      borderTop: `1px solid ${PALETTE.hair}`,
      width: SLIDE_W - 144,
    },
    [
      bandCell('私聊发出', fmt(sentTotal), '条'),
      el('div', { width: 1, marginTop: 22, height: 128, backgroundColor: PALETTE.hair }),
      bandCell('开口天数', fmt(activeDays), '天'),
      el('div', { width: 1, marginTop: 22, height: 128, backgroundColor: PALETTE.hair }),
      bandCell('最长连续发言', fmt(longestSelfRun), '天'),
      el('div', { width: 1, marginTop: 22, height: 128, backgroundColor: PALETTE.hair }),
      bandCell('最长火花', fmt(spark?.days ?? 0), '天', spark?.peerName ?? '还没有双向的火花'),
    ],
  );

  return slideFrame(
    [
      ...hero,
      el('div', { marginTop: 70, display: 'flex', flexDirection: 'column' }, [
        el('div', { display: 'flex', justifyContent: 'space-between', alignItems: 'baseline' }, [
          el('div', { fontSize: 30, color: PALETTE.ink, letterSpacing: 4 }, `${wallYear} 年`),
          el('div', { fontSize: 18, color: PALETTE.inkFaint, letterSpacing: 5 }, '我发出的私聊'),
        ]),
        el('div', { marginTop: 14, display: 'flex', gap: 3 }, cells()),
      ]),
      band,
    ],
    isAllTimeYear(year) ? 'ALL' : String(year),
  );
}

function cellEl(level: number): El {
  const leaf = (alpha: number): string => `rgba(63,174,112,${alpha})`;
  return el('div', {
    width: 12,
    height: 12,
    borderRadius: 2,
    backgroundColor:
      level === 0
        ? 'rgba(244,240,230,0.045)'
        : level === 1
          ? leaf(0.18)
          : level === 2
            ? leaf(0.38)
            : level === 3
              ? leaf(0.62)
              : '#3fae70',
  });
}

function endTree(data: Record<string, unknown>): El {
  const year = Number(data.year ?? 0);
  const allTime = isAllTimeYear(year);
  return slideFrame(
    [
      el('div', { display: 'flex', flexDirection: 'column', alignItems: 'center' }, [
        el(
          'div',
          { fontSize: 30, color: PALETTE.inkMuted, letterSpacing: 12 },
          allTime ? '你说过的话，都在这里了。' : '这一年的话都说完了。',
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
          allTime ? '往后的话，也还长。' : '明年这个时候，我们再看一次。',
        ),
        el('div', { marginTop: 78, width: 120, height: 1, backgroundColor: PALETTE.hair }),
        el(
          'div',
          { marginTop: 30, fontSize: 24, color: PALETTE.accent, letterSpacing: 10 },
          allTime ? '全部记录 · WEQ' : `${year} 年度报告`,
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

function treeForSlide(slide: ReportExportSlide): El {
  const data = (slide.data ?? {}) as Record<string, unknown>;
  if (slide.pageId === 'overview') return overviewTree(data);
  if (slide.pageId === 'dress') return dressTree(data);
  if (slide.pageId === 'spark') return sparkTree(data);
  if (slide.pageId === 'end') return endTree(data);
  return genericTree(slide);
}

/**
 * 把全部卡片竖排渲染成一张长图 PNG。卡片数量 × 1920px 可能很高，satori/resvg
 * 都能直接处理；输出按 SLIDE_W × 2 超采样，保证 CJK 清晰。
 *
 * 口径文案（历史以来 / xxxx 年）由每页数据里的 `year` 自证，与屏幕版和 HTML
 * 共用 `@weq/service/report-time`，不再靠调用方额外传 `startYear`。
 */
export async function renderLongImagePng(slides: ReportExportSlide[]): Promise<Buffer> {
  const fontData = loadCjkFont();
  const root = el(
    'div',
    {
      width: SLIDE_W,
      height: SLIDE_H * Math.max(1, slides.length),
      display: 'flex',
      flexDirection: 'column',
    },
    slides.map((slide) => treeForSlide(slide)),
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
