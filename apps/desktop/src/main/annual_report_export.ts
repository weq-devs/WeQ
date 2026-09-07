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
  open: '#d9a9cf',
  voice: '#e0a878',
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

/**
 * 好友榜页的长图版。
 *
 * satori 不取远程图，头像画不出来（屏幕版走的是 `weq-media://` 本地缓存协议），
 * 所以一律去脸。但**两幕的形状必须保留**：火花是横向引线（长度 = 天数）、
 * 消息量是纵向柱阵（高度 = 条数）—— 那是这一页区别于其它页的全部理由。
 *
 * satori 不支持 repeating-linear-gradient，柱身的「一层层消息」改用一叠等高
 * 小格子真的堆出来（每格 6px + 3px 缝），视觉目的一致而且更实在。
 */
function friendsTree(data: Record<string, unknown>): El {
  const year = Number(data.year ?? 0);
  type Entry = { peerName: string; value: number; messages: number };
  const sparkTop = (data.sparkTop ?? []) as Entry[];
  const messageTop = (data.messageTop ?? []) as Entry[];
  const friendCount = Number(data.friendCount ?? 0);
  const totalMessages = Number(data.totalMessages ?? 0);

  /** 火花幕的暖橙，与屏幕版 --rp-flame 深色档同色。 */
  const FLAME = '#e08b4a';
  /** 引线轨与柱阵可用的横向宽度。 */
  const TRACK_W = SLIDE_W - 144;

  const boardHead = (tone: string, eyebrow: string, sub: string): El =>
    el('div', { marginTop: 24, display: 'flex', alignItems: 'baseline' }, [
      el('div', { fontSize: 24, fontWeight: 700, color: tone, letterSpacing: 9 }, eyebrow),
      el('div', { marginLeft: 22, fontSize: 20, color: PALETTE.inkFaint, letterSpacing: 3 }, sub),
    ]);

  /** 以冠军为满格的比例，下限 4% —— 与屏幕版同一个口径。 */
  const ratio = (value: number, top: number): number => Math.max(0.04, value / Math.max(1, top));

  // ══ 第一幕：横向引线 ══
  const champSpark = sparkTop[0];
  const fuse: El[] = champSpark
    ? [
        el(
          'div',
          {
            marginTop: 16,
            display: 'flex',
            alignItems: 'baseline',
            justifyContent: 'space-between',
            width: TRACK_W,
          },
          [
            el('div', { display: 'flex', flexDirection: 'column' }, [
              el(
                'div',
                { fontSize: 38, color: PALETTE.ink, letterSpacing: 3 },
                champSpark.peerName,
              ),
              el(
                'div',
                { marginTop: 6, fontSize: 20, color: PALETTE.inkFaint, letterSpacing: 4 },
                `${fmt(champSpark.messages)} 条私聊`,
              ),
            ]),
            el('div', { display: 'flex', alignItems: 'baseline' }, [
              el(
                'div',
                { fontSize: 132, fontWeight: 700, color: PALETTE.ink, letterSpacing: -5 },
                fmt(champSpark.value),
              ),
              el('div', { marginLeft: 16, fontSize: 34, color: FLAME, letterSpacing: 6 }, '天'),
            ]),
          ],
        ),
        // 冠军的引线永远满格 —— 它就是这一幕的标尺。末端一枚火种收口。
        el(
          'div',
          {
            marginTop: 18,
            display: 'flex',
            alignItems: 'center',
            width: TRACK_W,
            height: 8,
            borderRadius: 4,
            backgroundColor: FLAME,
          },
          [
            el('div', {
              marginLeft: TRACK_W - 20,
              width: 20,
              height: 20,
              borderRadius: 10,
              backgroundColor: FLAME,
            }),
          ],
        ),
        ...sparkTop.slice(1).map((entry, index) =>
          el(
            'div',
            {
              marginTop: index === 0 ? 26 : 18,
              display: 'flex',
              alignItems: 'center',
              width: TRACK_W,
            },
            [
              el(
                'div',
                { width: 34, fontSize: 24, fontWeight: 700, color: PALETTE.inkFaint },
                `0${index + 2}`,
              ),
              el(
                'div',
                { width: 210, fontSize: 24, color: PALETTE.inkSoft, letterSpacing: 2 },
                entry.peerName,
              ),
              // 细轨：先画满宽的暗轨，再叠一段按比例的亮轨。
              el(
                'div',
                {
                  flex: 1,
                  display: 'flex',
                  height: 4,
                  borderRadius: 2,
                  backgroundColor: PALETTE.hair,
                },
                [
                  el('div', {
                    width: `${Math.round(ratio(entry.value, champSpark.value) * 100)}%`,
                    height: 4,
                    borderRadius: 2,
                    backgroundColor: 'rgba(224,139,74,0.58)',
                  }),
                ],
              ),
              el(
                'div',
                { marginLeft: 20, fontSize: 40, fontWeight: 700, color: PALETTE.ink },
                fmt(entry.value),
              ),
              el('div', { marginLeft: 6, fontSize: 20, color: PALETTE.inkFaint }, '天'),
            ],
          ),
        ),
      ]
    : [
        el(
          'div',
          { marginTop: 20, fontSize: 26, color: PALETTE.inkFaint, letterSpacing: 3 },
          '还没有连续两天都互相说话的人',
        ),
      ];

  // ══ 第二幕：纵向柱阵（前八名）══
  const champMsg = messageTop[0];
  /** 最高柱的像素高；其余按条数等比缩，最矮也留一层。 */
  const STACK_MAX_H = 200;
  const LAYER = 6;
  const GAP = 3;
  /** 八根柱平分整幅宽度。长图是竖幅，柱阵铺满一行才有「一片」的密度。 */
  const STACK_SLOT = Math.floor(TRACK_W / 8);
  const STACK_BAR_W = 56;
  const CHAMP_BAR_W = 84;

  /** 一根柱子：由 n 层小格子真的堆出来（satori 没有 repeating-linear-gradient）。 */
  const stackBar = (heightPx: number, width: number, champion: boolean): El => {
    const layers = Math.max(1, Math.round(heightPx / (LAYER + GAP)));
    return el(
      'div',
      { display: 'flex', flexDirection: 'column-reverse', width },
      Array.from({ length: layers }, (_, i) =>
        el('div', {
          marginTop: i === 0 ? 0 : GAP,
          width,
          height: LAYER,
          backgroundColor: champion ? 'rgba(201,162,39,0.86)' : 'rgba(201,162,39,0.4)',
        }),
      ),
    );
  };

  const vol: El[] = champMsg
    ? [
        // 冠军的巨数独占一行 —— 八根柱挤在它右边会把每根压到看不出高度差。
        el('div', { marginTop: 16, display: 'flex', alignItems: 'baseline' }, [
          el(
            'div',
            { fontSize: 126, fontWeight: 700, color: PALETTE.ink, letterSpacing: -5 },
            fmt(champMsg.value),
          ),
          el(
            'div',
            { marginLeft: 16, fontSize: 34, color: PALETTE.accent, letterSpacing: 6 },
            '条',
          ),
          el(
            'div',
            { marginLeft: 28, fontSize: 34, color: PALETTE.ink, letterSpacing: 3 },
            champMsg.peerName,
          ),
        ]),
        // 柱阵铺满整幅宽度，八根共基线。
        el(
          'div',
          {
            marginTop: 26,
            display: 'flex',
            alignItems: 'flex-end',
            width: TRACK_W,
          },
          messageTop.map((entry, index) => {
            const champion = index === 0;
            const height = Math.max(
              LAYER,
              Math.round(ratio(entry.value, champMsg.value) * STACK_MAX_H),
            );
            return el(
              'div',
              {
                width: STACK_SLOT,
                display: 'flex',
                flexDirection: 'column',
                alignItems: 'center',
              },
              [
                el(
                  'div',
                  {
                    fontSize: champion ? 30 : 20,
                    fontWeight: 700,
                    color: champion ? PALETTE.accent : PALETTE.inkMuted,
                  },
                  fmt(entry.value),
                ),
                el('div', { marginTop: 10, display: 'flex' }, [
                  stackBar(height, champion ? CHAMP_BAR_W : STACK_BAR_W, champion),
                ]),
                // 定宽 + ellipsis：八列并排时长名字必须截断，不能换行撑高柱阵。
                el(
                  'div',
                  {
                    marginTop: 12,
                    width: STACK_SLOT - 8,
                    display: 'flex',
                    justifyContent: 'center',
                    overflow: 'hidden',
                    whiteSpace: 'nowrap',
                    textOverflow: 'ellipsis',
                    fontSize: champion ? 19 : 17,
                    color: champion ? PALETTE.inkSoft : PALETTE.inkMuted,
                  },
                  entry.peerName,
                ),
              ],
            );
          }),
        ),
      ]
    : [
        el(
          'div',
          { marginTop: 20, fontSize: 26, color: PALETTE.inkFaint, letterSpacing: 3 },
          '还没有双向来往的私聊',
        ),
      ];

  return slideFrame(
    [
      el('div', { display: 'flex', justifyContent: 'space-between', alignItems: 'baseline' }, [
        el(
          'div',
          { fontSize: 26, color: PALETTE.inkSoft, letterSpacing: 6 },
          `${reportEraLabel(year)} · 和你来往最深的人`,
        ),
        el(
          'div',
          { fontSize: 20, color: PALETTE.inkFaint, letterSpacing: 3 },
          `${fmt(friendCount)} 位好友 / ${fmt(totalMessages)} 条私聊`,
        ),
      ]),
      el('div', { marginTop: 52, display: 'flex', flexDirection: 'column' }, [
        hair(0),
        boardHead(FLAME, '最长火花', '连着多少天，你们谁都没有断'),
        ...fuse,
      ]),
      el('div', { marginTop: 56, display: 'flex', flexDirection: 'column' }, [
        hair(0),
        boardHead(PALETTE.accent, '聊得最多', '这段时间里，你们一共说了这么多'),
        ...vol,
      ]),
    ],
    isAllTimeYear(year) ? 'ALL' : String(year),
  );
}

/**
 * 谁先开口页的长图版。satori 不取头像（`weq-media://` 画不出来），三位朋友
 * 就只用名字写进句子；轨上的星标没有动画，直接落在你先开口的比例处 —— 巨数、
 * 一句裁决和一枚指向「TA / 我」之间的光点，就是这一页的全部。
 */
function openersTree(data: Record<string, unknown>): El {
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

  const line = (role: CastRole): El => {
    const entry = role.entry as {
      peerName: string;
      selfStarts: number;
      peerStarts: number;
      totalStarts: number;
    };
    const name = el('span', { color: PALETTE.open, fontWeight: 700 }, entry.peerName);
    const roleLabel =
      role.kind === 'mine'
        ? '你发起占比最高'
        : role.kind === 'peer'
          ? 'TA 发起占比最高'
          : '最接近 50%';
    const roleEl = el('span', { fontSize: 22, color: PALETTE.open, letterSpacing: 5 }, roleLabel);
    if (role.kind === 'mine') {
      const minePct = Math.round((entry.selfStarts / entry.totalStarts) * 100);
      return el('div', { marginTop: 22, fontSize: 34, color: PALETTE.inkSoft, letterSpacing: 1 }, [
        roleEl,
        ' · ',
        name,
        `，这 ${fmt(entry.totalStarts)} 场里你先发起 ${fmt(entry.selfStarts)} 次（发起率 ${minePct}%）—— 是你一直在把 TA 找回来。`,
      ]);
    }
    if (role.kind === 'peer') {
      const peerPct = Math.round((entry.peerStarts / entry.totalStarts) * 100);
      return el('div', { marginTop: 22, fontSize: 34, color: PALETTE.inkSoft, letterSpacing: 1 }, [
        roleEl,
        ' · ',
        name,
        `，这 ${fmt(entry.totalStarts)} 场里 TA 先发起 ${fmt(entry.peerStarts)} 次（发起率 ${peerPct}%）—— 有人总比你早一步想你。`,
      ]);
    }
    const minePct = Math.round((entry.selfStarts / entry.totalStarts) * 100);
    const peerPct = 100 - minePct;
    return el('div', { marginTop: 22, fontSize: 34, color: PALETTE.inkSoft, letterSpacing: 1 }, [
      roleEl,
      ' · ',
      name,
      `，开场 ${fmt(entry.selfStarts)} : ${fmt(entry.peerStarts)}，发起率 ${minePct}% : ${peerPct}% —— 谁先想起谁，都不算抢先。`,
    ]);
  };

  return slideFrame(
    [
      el('div', { display: 'flex', justifyContent: 'space-between', alignItems: 'baseline' }, [
        el(
          'div',
          { fontSize: 30, color: PALETTE.inkSoft, letterSpacing: 6 },
          `${reportEraLabel(year)} · 谁先开口`,
        ),
        el(
          'div',
          { fontSize: 22, color: PALETTE.inkFaint, letterSpacing: 4 },
          `${fmt(peerCount)} 位朋友 / ${fmt(totalStarts)} 场开场`,
        ),
      ]),
      el(
        'div',
        {
          marginTop: 80,
          fontSize: 40,
          color: PALETTE.inkSoft,
          letterSpacing: 3,
        },
        [
          `${allTime ? '有记录以来' : '这一年'}你一共发起了 `,
          el('span', { fontWeight: 700, color: PALETTE.ink }, fmt(selfStarts)),
          ' 场聊天，占全部开场的',
        ],
      ),
      el('div', { marginTop: 8, display: 'flex', alignItems: 'baseline' }, [
        el(
          'div',
          { fontSize: 240, fontWeight: 700, color: PALETTE.ink, letterSpacing: -10, lineHeight: 1 },
          `${selfPct}`,
        ),
        el('div', { marginLeft: 20, fontSize: 72, fontWeight: 700, color: PALETTE.open }, '%'),
        el(
          'div',
          { marginLeft: 44, fontSize: 38, color: PALETTE.inkSoft, letterSpacing: 10 },
          '是你先开口',
        ),
      ]),
      el('div', { marginTop: 6, fontSize: 32, color: PALETTE.inkMuted, letterSpacing: 4 }, mood),
      // 开场轨：左右 50% 各一段发丝 + 中点刻度 + 一枚停在实际比例上的星标。
      el(
        'div',
        {
          marginTop: 64,
          width: SLIDE_W - 144,
          display: 'flex',
          alignItems: 'center',
        },
        [
          el(
            'div',
            { fontSize: 22, color: PALETTE.inkFaint, letterSpacing: 3, whiteSpace: 'nowrap' },
            `TA 先开口 ${fmt(peerStarts)}`,
          ),
          el(
            'div',
            { position: 'relative', flex: 1, marginLeft: 28, marginRight: 28, height: 12 },
            [
              el('div', {
                position: 'absolute',
                top: 5,
                left: 0,
                width: '50%',
                height: 1,
                backgroundColor: PALETTE.hair,
              }),
              el('div', {
                position: 'absolute',
                top: 5,
                right: 0,
                width: '50%',
                height: 1,
                backgroundColor: 'rgba(217,169,207,0.6)',
              }),
              el('div', {
                position: 'absolute',
                left: '50%',
                top: 0,
                width: 1,
                height: 12,
                backgroundColor: PALETTE.hair,
              }),
              el('div', {
                position: 'absolute',
                top: 0,
                left: `${selfPct}%`,
                width: 12,
                height: 12,
                marginLeft: -6,
                borderRadius: 6,
                backgroundColor: PALETTE.open,
              }),
            ],
          ),
          el(
            'div',
            { fontSize: 22, color: PALETTE.inkFaint, letterSpacing: 3, whiteSpace: 'nowrap' },
            `${fmt(selfStarts)} 我先开口`,
          ),
        ],
      ),
      ...(cast.length > 0
        ? [
            el(
              'div',
              {
                marginTop: 64,
                display: 'flex',
                flexDirection: 'column',
                borderTop: `1px solid ${PALETTE.hair}`,
                paddingTop: 24,
              },
              [
                el(
                  'div',
                  { fontSize: 20, color: PALETTE.inkFaint, letterSpacing: 6 },
                  '而这几位朋友，把「先开口」写成了不同的样子',
                ),
                ...cast.map((role) => line(role)),
              ],
            ),
          ]
        : []),
    ],
    allTime ? 'ALL' : String(year),
  );
}

/**
 * 我的作息页的长图版。
 *
 * satori 不支持 SVG，屏幕与 HTML 里的那条平滑 24 小时心率在这里落成
 * 24 根圆头柱（等高 = 同时长，柱高 = 那一小时发了多少）——静态分享图
 * 不逐帧画动画，但这根“脉动”的轮廓和下面的 7×24 墙共用同一条时间轴。
 * 颜色跟着人设走：深宵紫、日出琥珀、午后叶绿…
 */
function rhythmTree(data: Record<string, unknown>): El {
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
  const color = rhythmColor(kind);

  const mood =
    kind === 'night'
      ? `深夜 ${span.replace('–', '到')} 的发言占全天的 ${mainPct}%。别人按下晚安，你的话才刚说到一半；最醒着的那一小时，是 ${padHour(peakHour)}。`
      : kind === 'us'
        ? `凌晨 ${span.replace('–', '到')} 占了全天的 ${mainPct}%：那时你还在线，像隔着十二个小时时差，给还没睡的人留了一句言。`
        : kind === 'early'
          ? `上午 ${span.replace('–', '到')} 就贡献了全天的 ${mainPct}%：天亮不久，你的消息已经把一天叫醒了，${padHour(peakHour)} 是最忙的那一小时。`
          : kind === 'afternoon'
            ? `午后 ${span.replace('–', '到')} 的 ${mainPct}% 发言是每天的续航：困意压不住话匣子，${padHour(peakHour)} 前后的对话框最热闹。`
            : kind === 'dusk'
              ? `黄昏 ${span.replace('–', '到')} 的发言占全天的 ${mainPct}%：下班、放学、吃完饭，所有人都上线了，${padHour(peakHour)} 是这一天的社交高光。`
              : `你的一天没有固定的分时区，${activeHours}/24 个小时都可能说话；出现得最勤的是 ${padHour(peakHour)}，但你的「收到」从来不挑时间。`;

  const max = Math.max(1, ...hourly.map((count) => Number(count || 0)));
  const pulseRow = el(
    'div',
    {
      marginTop: 26,
      width: SLIDE_W - 144,
      display: 'flex',
      flexDirection: 'row',
      alignItems: 'flex-end',
      gap: 8,
      height: 220,
    },
    hourly.map((count, hour) =>
      el('div', {
        flex: 1,
        height: Math.max(8, Math.round((Number(count || 0) / max) * 212)),
        borderRadius: hour === peakHour ? 9 : 5,
        backgroundColor:
          hour === peakHour
            ? color
            : Number(count || 0) === 0
              ? rgba(color, 0.07)
              : rgba(color, 0.22 + (Number(count || 0) / max) * 0.62),
      }),
    ),
  );

  const pulseAxis = el(
    'div',
    {
      marginTop: 14,
      width: SLIDE_W - 144,
      display: 'flex',
      flexDirection: 'row',
      justifyContent: 'space-between',
      fontSize: 17,
      color: PALETTE.inkFaint,
      letterSpacing: 3,
    },
    ['00', '06', '12', '18', '24'],
  );

  // 一周从周一开始排；数据行序是 getDay()（0 = 周日）。
  const names: Record<number, string> = {
    0: '日',
    1: '一',
    2: '二',
    3: '三',
    4: '四',
    5: '五',
    6: '六',
  };
  const cell = (count: number): El => {
    const level = count === 0 ? 0 : Math.min(4, 1 + Math.ceil((count / max) * 3));
    return el('div', {
      width: 22,
      height: 22,
      borderRadius: 4,
      backgroundColor:
        level === 0
          ? 'rgba(244,240,230,0.045)'
          : level === 1
            ? rgba(color, 0.16)
            : level === 2
              ? rgba(color, 0.38)
              : level === 3
                ? rgba(color, 0.66)
                : color,
    });
  };
  const weekRows = [1, 2, 3, 4, 5, 6, 0].map((dow) =>
    el('div', { marginTop: 9, display: 'flex', alignItems: 'center' }, [
      el(
        'div',
        {
          width: 28,
          textAlign: 'right',
          fontSize: 20,
          color: PALETTE.inkFaint,
          fontFamily: 'Report',
        },
        names[dow],
      ),
      el(
        'div',
        { marginLeft: 14, display: 'flex', flexDirection: 'row', gap: 5 },
        Array.from({ length: 24 }, (_, hour) => cell(Number(matrix[dow]?.[hour] ?? 0))),
      ),
    ]),
  );

  return slideFrame(
    [
      el('div', { display: 'flex', justifyContent: 'space-between', alignItems: 'baseline' }, [
        el(
          'div',
          { fontSize: 30, color: PALETTE.inkSoft, letterSpacing: 6 },
          `${reportEraLabel(year)} · 我的作息`,
        ),
        el(
          'div',
          { fontSize: 22, color: PALETTE.inkFaint, letterSpacing: 4 },
          `${fmt(sentTotal)} 条发言 / 一天 ${activeHours} 个小时在线`,
        ),
      ]),
      el(
        'div',
        { marginTop: 58, fontSize: 40, color: PALETTE.inkSoft, letterSpacing: 3 },
        `${allTime ? '有记录以来' : `${year} 年`}，你的话有它自己的时区——`,
      ),
      el(
        'div',
        {
          marginTop: 12,
          fontSize: word.length >= 4 ? 150 : 190,
          fontWeight: 700,
          color: PALETTE.ink,
          letterSpacing: word.length >= 4 ? 4 : 0,
          lineHeight: 1,
        },
        word,
      ),
      el('div', { marginTop: 22, display: 'flex', alignItems: 'baseline' }, [
        el('div', { fontSize: 24, color, letterSpacing: 8, fontWeight: 700 }, english),
        el(
          'div',
          { marginLeft: 24, fontSize: 22, color: PALETTE.inkFaint, letterSpacing: 4 },
          span,
        ),
        main
          ? el(
              'div',
              {
                marginLeft: 28,
                fontSize: 52,
                fontWeight: 700,
                color,
                letterSpacing: -1,
              },
              `${mainPct}%`,
            )
          : null,
      ]),
      el('div', { marginTop: 24, fontSize: 30, color: PALETTE.inkSoft, lineHeight: 1.75 }, mood),
      el('div', { marginTop: 64, display: 'flex', flexDirection: 'column' }, [
        el('div', { display: 'flex', justifyContent: 'space-between', alignItems: 'baseline' }, [
          el('div', { fontSize: 24, color, letterSpacing: 8, fontWeight: 700 }, '一天的心率'),
          el('div', { fontSize: 22, color: PALETTE.inkFaint, letterSpacing: 3 }, [
            el(
              'span',
              { fontSize: 30, fontWeight: 700, color: PALETTE.inkSoft },
              padHour(peakHour),
            ),
            ` · ${fmt(peakCount)} 条，${activeHours}/24 小时有人说话`,
          ]),
        ]),
        pulseRow,
        pulseAxis,
      ]),
      el('div', { marginTop: 56, display: 'flex', flexDirection: 'column' }, [
        el('div', { fontSize: 24, color, letterSpacing: 8, fontWeight: 700 }, '一周 · 7×24'),
        el('div', { marginTop: 14, display: 'flex', flexDirection: 'column' }, weekRows),
      ]),
    ],
    '24h',
  );
}

/** 深色长图的作息色 —— 与屏幕版各 data-kind 的深色档同源。 */
function rhythmColor(kind: string): string {
  switch (kind) {
    case 'night':
      return '#c3aae6';
    case 'us':
      return '#9db8da';
    case 'early':
      return '#e5ad68';
    case 'afternoon':
      return '#7bc29e';
    case 'dusk':
      return '#e29990';
    default:
      return '#e2bd79';
  }
}

function padHour(hour: number): string {
  return `${String(hour).padStart(2, '0')}:00`;
}

/**
 * 我的话页的长图版。
 *
 * 长图同样画不了协议图（weq-asset / weq-media），所以与 HTML 导出版同一取舍：
 * 那句说熟了的词是整页唯一主角，系统表情榜与自定义表情退成名字次数的小注脚。
 * 词越大越居中，重复就有多重。
 */
function voiceTree(data: Record<string, unknown>): El {
  const year = Number(data.year ?? 0);
  const allTime = isAllTimeYear(year);
  const sentTotal = Number(data.sentTotal ?? 0);
  const faceTotal = Number(data.faceTotal ?? 0);
  const picTotal = Number(data.picTotal ?? 0);
  const word = (data.word ?? null) as { word?: string; count?: number } | null;
  const faces = (data.faces ?? []) as Array<{ name?: string; count?: number }>;
  const topFaces = faces.slice(0, 4);
  const pic = (data.pic ?? null) as { count?: number } | null;
  const heroWord = String(word?.word ?? '……');
  const heroCount = Number(word?.count ?? 0);
  const faceFontSizes = [56, 44, 38, 32];

  const center = el(
    'div',
    {
      width: SLIDE_W - 144,
      display: 'flex',
      flexDirection: 'column',
      alignItems: 'center',
    },
    [
      el('div', { display: 'flex', justifyContent: 'space-between', width: '100%' }, [
        el(
          'div',
          { fontSize: 28, color: PALETTE.inkSoft, letterSpacing: 7 },
          `${reportEraLabel(year)} · 我的话`,
        ),
        el(
          'div',
          { fontSize: 21, color: PALETTE.inkFaint, letterSpacing: 4 },
          `${fmt(sentTotal)} 条发言 / ${fmt(faceTotal)} 个系统表情${
            picTotal > 0 ? ` / ${fmt(picTotal)} 张自定义` : ''
          }`,
        ),
      ]),
      el(
        'div',
        { marginTop: 86, fontSize: 36, color: PALETTE.inkSoft, letterSpacing: 4 },
        `${allTime ? '从有记录到现在' : `${year} 这一年`}，你说得最多的那个词是`,
      ),
      el(
        'div',
        {
          marginTop: 18,
          fontSize: heroWord.length >= 5 ? 148 : 220,
          fontWeight: 700,
          color: PALETTE.ink,
          lineHeight: 1.05,
          letterSpacing: heroWord.length >= 5 ? 4 : -2,
        },
        heroWord,
      ),
      el('div', { marginTop: 26, display: 'flex', alignItems: 'center' }, [
        el('div', { width: 58, height: 1, backgroundColor: rgba(PALETTE.voice, 0.65) }),
        el(
          'div',
          {
            marginLeft: 22,
            marginRight: 22,
            fontSize: 28,
            color: PALETTE.voice,
            letterSpacing: 5,
          },
          '说了',
        ),
        el(
          'div',
          {
            marginRight: 18,
            fontSize: 48,
            fontWeight: 700,
            color: PALETTE.ink,
            letterSpacing: 0,
          },
          fmt(heroCount),
        ),
        el('div', { fontSize: 28, color: PALETTE.voice, letterSpacing: 5 }, '次'),
        el('div', { width: 58, height: 1, backgroundColor: rgba(PALETTE.voice, 0.65) }),
      ]),
      ...(topFaces.length > 0 || pic
        ? [
            el(
              'div',
              { marginTop: 90, display: 'flex', flexDirection: 'column', alignItems: 'center' },
              [
                el(
                  'div',
                  { fontSize: 20, color: PALETTE.inkFaint, letterSpacing: 12 },
                  '而表情，是你那句口头禅旁边的语气——',
                ),
                el(
                  'div',
                  { marginTop: 42, display: 'flex', flexDirection: 'row', alignItems: 'flex-end' },
                  [
                    topFaces.length > 0
                      ? el(
                          'div',
                          { display: 'flex', flexDirection: 'column', alignItems: 'center' },
                          [
                            el(
                              'div',
                              {
                                fontSize: 20,
                                color: PALETTE.voice,
                                letterSpacing: 10,
                                fontWeight: 700,
                              },
                              '系统表情',
                            ),
                            el(
                              'div',
                              {
                                marginTop: 24,
                                display: 'flex',
                                flexDirection: 'row',
                                alignItems: 'flex-end',
                                gap: 54,
                              },
                              topFaces.map((face, index) =>
                                el(
                                  'div',
                                  {
                                    display: 'flex',
                                    flexDirection: 'column',
                                    alignItems: 'center',
                                  },
                                  [
                                    el(
                                      'div',
                                      {
                                        fontSize: faceFontSizes[index] ?? 32,
                                        fontWeight: 700,
                                        color: PALETTE.ink,
                                        lineHeight: 1.1,
                                        letterSpacing: index === 0 ? 1 : 0,
                                      },
                                      String(face.name ?? '表情'),
                                    ),
                                    el(
                                      'div',
                                      {
                                        marginTop: 10,
                                        fontSize: 21,
                                        color: PALETTE.inkFaint,
                                      },
                                      `${fmt(Number(face.count ?? 0))} 次`,
                                    ),
                                  ],
                                ),
                              ),
                            ),
                          ],
                        )
                      : null,
                    topFaces.length > 0 && pic
                      ? el('div', {
                          width: 1,
                          height: 96,
                          marginLeft: 62,
                          marginRight: 62,
                          backgroundColor: PALETTE.hair,
                        })
                      : null,
                    pic
                      ? el(
                          'div',
                          { display: 'flex', flexDirection: 'column', alignItems: 'center' },
                          [
                            el(
                              'div',
                              {
                                fontSize: 20,
                                color: PALETTE.voice,
                                letterSpacing: 10,
                                fontWeight: 700,
                              },
                              '自定义表情',
                            ),
                            el(
                              'div',
                              {
                                marginTop: 24,
                                fontSize: 38,
                                fontWeight: 700,
                                color: PALETTE.ink,
                                letterSpacing: 2,
                              },
                              '这张最常被你拿出来',
                            ),
                            el(
                              'div',
                              { marginTop: 10, fontSize: 21, color: PALETTE.inkFaint },
                              `${fmt(Number(pic.count ?? 0))} 次`,
                            ),
                          ],
                        )
                      : null,
                  ],
                ),
              ],
            ),
          ]
        : []),
      el(
        'div',
        {
          marginTop: 76,
          maxWidth: 760,
          fontSize: 28,
          color: PALETTE.inkSoft,
          lineHeight: 1.8,
          letterSpacing: 3,
          textAlign: 'center',
        },
        heroCount > 0
          ? `一句话说了 ${fmt(heroCount)} 次，不是因为词穷——是每一次，你都还想把它送到。`
          : '重复，是你最诚实的告白。',
      ),
    ],
  );

  return slideFrame([center], '话');
}

/** '#rrggbb' + alpha → rgba()。satori 不支持 color-mix，只能拼字符串。 */
function rgba(hex: string, alpha: number): string {
  const value = hex.replace('#', '');
  const r = Number.parseInt(value.slice(0, 2), 16);
  const g = Number.parseInt(value.slice(2, 4), 16);
  const b = Number.parseInt(value.slice(4, 6), 16);
  return `rgba(${r},${g},${b},${alpha})`;
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
  if (slide.pageId === 'friends') return friendsTree(data);
  if (slide.pageId === 'openers') return openersTree(data);
  if (slide.pageId === 'rhythm') return rhythmTree(data);
  if (slide.pageId === 'voice') return voiceTree(data);
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
