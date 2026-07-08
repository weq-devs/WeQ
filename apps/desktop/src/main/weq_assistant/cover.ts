/**
 * ARK cover / preview image rendering — HTML-ish (satori element tree) → SVG
 * (satori) → PNG (@resvg/resvg-js).
 *
 * This is deliberately generic: the WeQ 助手 "每日推文" card is the first user,
 * but daily reports / diaries / any future push can reuse `renderCardPng` with a
 * different `CardSpec`. No per-card project update needed — the layout is data.
 *
 * Visuals: 浅色科技风 (呼应 banner) —— 双色光晕 + 淡网格纹理 + 半透明 logo 水印 +
 * 品牌行 + 大标题/副标题层级 + 日期胶囊。整套配色由「主色 + 深/浅」算出来
 * (见 ./theme buildPalette)，跟随 WeQ Desktop 的主题；深色模式自动转科技夜色。
 *
 * We avoid JSX so this compiles in the plain main-process build: satori accepts
 * React-element-shaped plain objects (`{ type, props: { style, children } }`).
 */

import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import satori from 'satori';
import { Resvg } from '@resvg/resvg-js';
import { resolveResource } from '../resource';
import { buildPalette, getWeqTheme, type WeqPalette, type WeqTheme } from './theme';

/** One line of body text under the title. */
export interface CardSpec {
  /** Big title line. */
  title: string;
  /** Secondary line under the title. */
  subtitle?: string;
  /** Small pill label at the bottom (date / source). */
  footer?: string;
  /** Top-right pill tag (e.g. 每日推文). */
  tag?: string;
  /** Theme override; defaults to the live pushed snapshot (getWeqTheme). */
  theme?: WeqTheme;
  /** Output size. Defaults to a 2:1 card. */
  width?: number;
  height?: number;
}

const DEFAULT_W = 720;
const DEFAULT_H = 360;
/** Supersample factor — render at 2× then downscale for crisp text/edges. */
const SCALE = 2;

/** Cached font buffer (loaded once). */
let fontCache: Buffer | null = null;
/** Cached logo data URI (loaded once). */
let logoUriCache: string | null | undefined;

/**
 * Locate a CJK-capable TTF/OTF. satori can't read `.ttc` collections, so we
 * prefer a bundled `.ttf`, then Windows' DengXian (`Deng.ttf`, a plain TTF that
 * ships with Win10/11). Throws if none is found — the caller surfaces it.
 */
function loadFont(): Buffer {
  if (fontCache) return fontCache;
  const candidates = [
    resolveResource('assistant', 'fonts', 'cover.ttf'),
    resolveResource('assistant', 'fonts', 'cover.otf'),
    process.env.WINDIR ? join(process.env.WINDIR, 'Fonts', 'Deng.ttf') : null,
    process.env.WINDIR ? join(process.env.WINDIR, 'Fonts', 'simhei.ttf') : null,
  ].filter((p): p is string => !!p && existsSync(p));
  if (candidates.length === 0) {
    throw new Error('[weq-assistant/cover] no usable TTF/OTF font found (need a CJK .ttf)');
  }
  fontCache = readFileSync(candidates[0]!);
  return fontCache;
}

/** WeQ logo as a data URI (satori embeds `<img src>` inline), or null if absent. */
function loadLogoUri(): string | null {
  if (logoUriCache !== undefined) return logoUriCache;
  const path = resolveResource('brand', 'logo.png');
  logoUriCache = path && existsSync(path)
    ? `data:image/png;base64,${readFileSync(path).toString('base64')}`
    : null;
  return logoUriCache;
}

/** satori element shorthand — a plain React-element-shaped object. */
type El = { type: string; props: Record<string, unknown> };
function el(type: string, style: Record<string, unknown>, children?: unknown): El {
  return { type, props: { style, children } };
}
/** `<img>` element (src is a prop, not a style). */
function img(src: string, style: Record<string, unknown>): El {
  return { type: 'img', props: { src, style } };
}

/**
 * A 38px grid tile as an inline SVG data URI, tinted by the palette. Repeated as
 * a background gives the subtle 科技风 graph-paper texture.
 */
function gridBackground(p: WeqPalette): string {
  const stroke = p.grid.replace(/rgba?\(([^)]+)\)/, 'rgb($1)'); // svg stroke wants rgb(...)
  const svg =
    `<svg xmlns='http://www.w3.org/2000/svg' width='38' height='38'>` +
    `<path d='M38 0H0V38' fill='none' stroke='${stroke}' stroke-width='1'/></svg>`;
  return `url("data:image/svg+xml,${encodeURIComponent(svg)}")`;
}

/** Build the satori element tree for a card. */
function buildCardTree(spec: CardSpec, width: number, height: number): El {
  const theme = spec.theme ?? getWeqTheme();
  const p = buildPalette(theme);
  const logo = loadLogoUri();

  const brandRow: unknown[] = [];
  if (logo) {
    brandRow.push(
      el(
        'div',
        {
          display: 'flex',
          width: 46,
          height: 46,
          borderRadius: 12,
          backgroundColor: p.chipBg,
          alignItems: 'center',
          justifyContent: 'center',
          boxShadow: `0 6px 16px -6px ${p.chipShadow}`,
        },
        [img(logo, { width: 34, height: 35 })],
      ),
    );
  }
  brandRow.push(
    el(
      'div',
      {
        display: 'flex',
        marginLeft: logo ? 14 : 0,
        fontSize: 23,
        fontWeight: 700,
        color: p.title,
      },
      'WeQ 助手',
    ),
  );
  if (spec.tag) {
    brandRow.push(
      el(
        'div',
        {
          display: 'flex',
          marginLeft: 'auto',
          fontSize: 15,
          fontWeight: 700,
          color: p.tagInk,
          backgroundColor: p.tagBg,
          padding: '7px 14px',
          borderRadius: 999,
        },
        spec.tag,
      ),
    );
  }

  const content: unknown[] = [
    el('div', { display: 'flex', alignItems: 'center', width: width - 96 }, brandRow),
    el(
      'div',
      {
        display: 'flex',
        marginTop: 34,
        fontSize: 44,
        fontWeight: 700,
        color: p.title,
        lineHeight: 1.2,
        maxWidth: width - 150,
      },
      spec.title,
    ),
  ];
  if (spec.subtitle) {
    content.push(
      el(
        'div',
        {
          display: 'flex',
          marginTop: 14,
          fontSize: 21,
          color: p.sub,
          lineHeight: 1.45,
          maxWidth: width - 160,
        },
        spec.subtitle,
      ),
    );
  }
  if (spec.footer) {
    content.push(
      el(
        'div',
        { display: 'flex', marginTop: 'auto', alignItems: 'center' },
        [
          el(
            'div',
            {
              display: 'flex',
              alignItems: 'center',
              fontSize: 16,
              fontWeight: 600,
              color: p.pillInk,
              backgroundColor: p.pillBg,
              border: `1px solid ${p.pillBorder}`,
              padding: '8px 15px',
              borderRadius: 999,
            },
            [
              el('div', {
                display: 'flex',
                width: 7,
                height: 7,
                borderRadius: 999,
                backgroundColor: p.accentInk,
                marginRight: 9,
              }),
              spec.footer,
            ],
          ),
        ],
      ),
    );
  }

  const layers: unknown[] = [
    // grid texture
    el('div', {
      position: 'absolute',
      top: 0,
      left: 0,
      width,
      height,
      display: 'flex',
      backgroundImage: gridBackground(p),
      backgroundRepeat: 'repeat',
    }),
  ];
  // logo watermark (bleeds off the bottom-right corner)
  if (logo) {
    layers.push(
      img(logo, {
        position: 'absolute',
        right: -46,
        bottom: -64,
        width: 260,
        height: 264,
        opacity: p.watermark,
      }),
    );
  }
  // top accent hairline
  layers.push(
    el('div', {
      position: 'absolute',
      top: 0,
      left: 0,
      width,
      height: 5,
      display: 'flex',
      backgroundColor: p.hair,
    }),
  );
  // content column
  layers.push(
    el(
      'div',
      {
        position: 'absolute',
        top: 0,
        left: 0,
        width,
        height,
        display: 'flex',
        flexDirection: 'column',
        padding: '46px 48px',
      },
      content,
    ),
  );

  return el(
    'div',
    {
      width,
      height,
      display: 'flex',
      position: 'relative',
      fontFamily: 'Cover',
      backgroundColor: p.base,
      backgroundImage:
        `radial-gradient(560px 320px at 100% -8%, ${p.glow1}, transparent), ` +
        `radial-gradient(520px 340px at -6% 108%, ${p.glow2}, transparent)`,
    },
    layers,
  );
}

/** Render a card spec to a PNG buffer. */
export async function renderCardPng(spec: CardSpec): Promise<Buffer> {
  const width = spec.width ?? DEFAULT_W;
  const height = spec.height ?? DEFAULT_H;

  const root = buildCardTree(spec, width, height);

  const svg = await satori(root as unknown as import('react').ReactNode, {
    width,
    height,
    fonts: [{ name: 'Cover', data: loadFont(), weight: 400, style: 'normal' }],
  });

  // Supersample: render the SVG at SCALE× device width, downscaled by the viewer,
  // for crisp CJK glyphs and clean gradient/edge anti-aliasing.
  const png = new Resvg(svg, { fitTo: { mode: 'width', value: width * SCALE } }).render().asPng();
  return png;
}

/** The default WeQ 助手 欢迎使用 cover. */
export function dailyCardSpec(dateLabel: string): CardSpec {
  return {
    title: '欢迎使用 WeQ！',
    subtitle: 'NTQQ 本地消息数据库解密 · 解析 · 导出工具',
    footer: dateLabel,
    tag: '欢迎使用',
  };
}
