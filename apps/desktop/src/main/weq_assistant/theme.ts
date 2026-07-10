/**
 * WeQ 助手 推送视觉主题 —— 封面卡片 (satori→PNG) 与点击跳转页 (HTML) 共用。
 *
 * 封面/页面都在**主进程**渲染，读不到 renderer 的 localStorage 主题。所以 renderer
 * 的 `applyTheme` 会把当前 { accent, 深/浅 } 通过 preload 桥推到主进程，存成这里的
 * 内存快照；QQ 来抓封面/页面时，渲染代码读快照即可跟随 WeQ Desktop 的主题。
 *
 * 快照是纯内存的：app 每次启动 hydrate()→applyTheme() 都会重推一遍，所以总是最新；
 * 首次推送到达前（几乎瞬间）回落到 WeQ 默认蓝 + 浅色。
 *
 * 一整套配色由「主色 + 深/浅」算出来（见 buildPalette），换主色/换深浅全自动联动，
 * 不用为每种颜色单独写样式。
 */

/** WeQ 默认主色（与设置页 DEFAULT_ACCENT 一致）。 */
export const DEFAULT_ACCENT = '#0099ff';

export type WeqThemeMode = 'light' | 'dark';

export interface WeqTheme {
  /** 主色 hex（`#rrggbb`）。空值回落到 DEFAULT_ACCENT。 */
  accent: string;
  mode: WeqThemeMode;
}

// ── 主题快照 ────────────────────────────────────────────────────────────────

let current: WeqTheme = { accent: DEFAULT_ACCENT, mode: 'light' };

/** 当前主题快照（渲染封面/页面时读它）。 */
export function getWeqTheme(): WeqTheme {
  return current;
}

/** renderer 推送主题时更新快照。非法输入被忽略，保持上一次有效值。 */
export function setWeqTheme(next: Partial<WeqTheme> | null | undefined): WeqTheme {
  if (!next) return current;
  const accent = normalizeHex(next.accent) ?? current.accent;
  const mode = next.mode === 'light' || next.mode === 'dark' ? next.mode : current.mode;
  current = { accent, mode };
  return current;
}

// ── 颜色工具 ────────────────────────────────────────────────────────────────

interface Rgb {
  r: number;
  g: number;
  b: number;
}

/** `#rgb` / `#rrggbb` → 规范化 `#rrggbb`；非法返回 null。 */
function normalizeHex(input: string | undefined | null): string | null {
  if (!input) return null;
  let h = input.trim().replace(/^#/, '');
  if (/^[0-9a-fA-F]{3}$/.test(h)) h = h.split('').map((c) => c + c).join('');
  if (!/^[0-9a-fA-F]{6}$/.test(h)) return null;
  return `#${h.toLowerCase()}`;
}

function hexToRgb(hex: string): Rgb {
  const h = normalizeHex(hex) ?? DEFAULT_ACCENT;
  const n = parseInt(h.slice(1), 16);
  return { r: (n >> 16) & 255, g: (n >> 8) & 255, b: n & 255 };
}

function rgbToHex({ r, g, b }: Rgb): string {
  const clamp = (v: number): string =>
    Math.max(0, Math.min(255, Math.round(v))).toString(16).padStart(2, '0');
  return `#${clamp(r)}${clamp(g)}${clamp(b)}`;
}

/** 线性插值混色：t=0 → a，t=1 → b。 */
export function mix(a: string, b: string, t: number): string {
  const A = hexToRgb(a);
  const B = hexToRgb(b);
  return rgbToHex({
    r: A.r + (B.r - A.r) * t,
    g: A.g + (B.g - A.g) * t,
    b: A.b + (B.b - A.b) * t,
  });
}

/** hex + alpha → `rgba(...)`。 */
export function rgba(hex: string, alpha: number): string {
  const { r, g, b } = hexToRgb(hex);
  return `rgba(${r}, ${g}, ${b}, ${alpha})`;
}

// ── 调色板 ──────────────────────────────────────────────────────────────────

/**
 * 由「主色 + 深/浅」派生出的整套渲染色。封面卡片与跳转页共用同一套，保证两处观感统一。
 * `accent2` 是主色向紫罗兰偏移的第二色，用于双色光晕的对角渐变。
 */
export interface WeqPalette {
  mode: WeqThemeMode;
  accent: string;
  accent2: string;
  /** 底色。 */
  base: string;
  /** 两团背景光晕。 */
  glow1: string;
  glow2: string;
  /** 网格纹理线色。 */
  grid: string;
  /** 顶部主色细线。 */
  hair: string;
  /** 标题 / 正文 / 次要文字。 */
  title: string;
  body: string;
  sub: string;
  /** 「每日推文」标签底/字。 */
  tagBg: string;
  tagInk: string;
  /** 胶囊 / 卡片：底、描边、字。 */
  pillBg: string;
  pillBorder: string;
  pillInk: string;
  /** 提亮到可读的主色（小圆点 / 强调字）。 */
  accentInk: string;
  /** logo 芯片底色。 */
  chipBg: string;
  chipShadow: string;
  /** logo 水印不透明度。 */
  watermark: number;
}

export function buildPalette(theme: WeqTheme): WeqPalette {
  const accent = normalizeHex(theme.accent) ?? DEFAULT_ACCENT;
  const accent2 = mix(accent, '#8b5cf6', 0.55); // 主色 → 紫罗兰，双色对角光晕
  if (theme.mode === 'dark') {
    return {
      mode: 'dark',
      accent,
      accent2,
      base: mix('#0a1020', accent, 0.06),
      glow1: rgba(accent, 0.4),
      glow2: rgba(accent2, 0.3),
      grid: rgba('#ffffff', 0.05),
      hair: accent,
      title: '#f3f7ff',
      body: 'rgba(255, 255, 255, 0.82)',
      sub: 'rgba(255, 255, 255, 0.66)',
      tagBg: rgba(accent, 0.24),
      tagInk: mix(accent, '#ffffff', 0.5),
      pillBg: 'rgba(255, 255, 255, 0.08)',
      pillBorder: 'rgba(255, 255, 255, 0.14)',
      pillInk: 'rgba(255, 255, 255, 0.85)',
      accentInk: mix(accent, '#ffffff', 0.35),
      chipBg: 'rgba(255, 255, 255, 0.10)',
      chipShadow: 'rgba(0, 0, 0, 0.45)',
      watermark: 0.1,
    };
  }
  return {
    mode: 'light',
    accent,
    accent2,
    base: mix('#ffffff', accent, 0.05),
    glow1: rgba(accent, 0.22),
    glow2: rgba(accent2, 0.16),
    grid: rgba(accent, 0.06),
    hair: accent,
    title: mix('#0a1830', accent, 0.1),
    body: '#3f4d63',
    sub: '#5b6b86',
    tagBg: rgba(accent, 0.12),
    tagInk: mix(accent, '#000000', 0.22),
    pillBg: rgba(accent, 0.1),
    pillBorder: rgba(accent, 0.2),
    pillInk: mix(accent, '#000000', 0.15),
    accentInk: mix(accent, '#000000', 0.12),
    chipBg: '#ffffff',
    chipShadow: 'rgba(15, 23, 42, 0.28)',
    watermark: 0.09,
  };
}
