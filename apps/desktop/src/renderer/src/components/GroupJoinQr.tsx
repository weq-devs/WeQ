/**
 * 加群引导弹窗里那枚**圆点风格**二维码。
 *
 * 与 `QrImage`（标准方块 SVG）的区别只在观感：定位眼画成圆角框 + 圆点，数据位画成
 * 圆点，整体走「dots」设计语言。
 *
 * ⚠️ 可扫性靠两条硬约束守住，改样式时别破坏它们：
 *   1. **极性不能反** —— 必须是「浅底 + 深码点」。反色（深底亮点）在多数扫码器
 *      上直接不识别，实测 zbar / 手机 QQ 都不认。
 *   2. **静默区 ≥ 4 个模块** —— 这里画一圈白色底板（padding + margin），深色模式下
 *      也是白底，不让主题色渗进静默区。
 *
 * 配色：底板恒为白色（扫码器要的就是高对比），码点取**主题强调色的色相**但把饱和度
 * 压下来 —— 直接用品红/靛蓝那种高饱和强调色当码点会很扎眼，跟弹窗其它元素格格不入。
 * 具体做法见 {@link useQrPalette}：解析出当前 accent 的 HSL，色相照用、饱和度夹到
 * 一个低区间，再把明度钉在「白底上够黑」的那一档。
 */

import { useEffect, useMemo, useState, type ReactElement } from 'react';
import QRCode from 'qrcode';
import { useThemeStore } from '../state/theme';

/** 静默区宽度（模块数）。QR 规范要求 ≥ 4，`4` 是下限，别改小。 */
const QUIET_MODULES = 4;
/** 单个模块在 SVG 用户坐标里的边长（最终由 viewBox 缩放，与像素无关）。 */
const CELL = 12;
/** 数据点半径 = CELL 的比例。0.42 是实测既能扫、又有圆点感的甜点。 */
const DOT_RADIUS = 0.42;
/** 定位眼外框圆角（× CELL）。 */
const EYE_RING_RADIUS = 2.1;

/** 码点饱和度上限：强调色再艳，这里也压到这个值以下。 */
const INK_MAX_SAT = 0.26;
/** 码点明度：白底上要够黑才扫得稳，固定在这一档（与明暗主题无关）。 */
const INK_LIGHT = 0.23;
/** 定位眼饱和度上限（比码点略艳一点，做视觉重点，但仍远低于原强调色）。 */
const EYE_MAX_SAT = 0.4;
/** 定位眼明度。 */
const EYE_LIGHT = 0.46;
/** 强调色几乎是灰（无色相）时的兜底色相：中性偏靛。 */
const NEUTRAL_HUE = 248;

interface Rgb {
  r: number;
  g: number;
  b: number;
}

/** 用 canvas 把任意 CSS 颜色串（含 oklch / color-mix 的**计算值**）解析成 RGB。 */
function resolveCssColorToRgb(css: string): Rgb | null {
  if (typeof document === 'undefined') return null;
  const canvas = document.createElement('canvas');
  canvas.width = 1;
  canvas.height = 1;
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  if (!ctx) return null;
  // 先设一个哨兵色：非法输入会被静默忽略，从而暴露出「没解析成功」。
  ctx.fillStyle = '#010203';
  ctx.fillStyle = css;
  if (ctx.fillStyle === '#010203') return null;
  ctx.fillRect(0, 0, 1, 1);
  const [r = 0, g = 0, b = 0] = ctx.getImageData(0, 0, 1, 1).data;
  return { r, g, b };
}

function rgbToHsl({ r, g, b }: Rgb): { h: number; s: number; l: number } {
  const rn = r / 255;
  const gn = g / 255;
  const bn = b / 255;
  const max = Math.max(rn, gn, bn);
  const min = Math.min(rn, gn, bn);
  const delta = max - min;
  const l = (max + min) / 2;
  let h = 0;
  let s = 0;
  if (delta !== 0) {
    s = l > 0.5 ? delta / (2 - max - min) : delta / (max + min);
    if (max === rn) h = ((gn - bn) / delta) % 6;
    else if (max === gn) h = (bn - rn) / delta + 2;
    else h = (rn - gn) / delta + 4;
    h *= 60;
    if (h < 0) h += 360;
  }
  return { h, s, l };
}

function hslToHex(h: number, s: number, l: number): string {
  const c = (1 - Math.abs(2 * l - 1)) * s;
  const hp = (((h % 360) + 360) % 360) / 60;
  const x = c * (1 - Math.abs((hp % 2) - 1));
  let r = 0;
  let g = 0;
  let b = 0;
  if (hp < 1) [r, g, b] = [c, x, 0];
  else if (hp < 2) [r, g, b] = [x, c, 0];
  else if (hp < 3) [r, g, b] = [0, c, x];
  else if (hp < 4) [r, g, b] = [0, x, c];
  else if (hp < 5) [r, g, b] = [x, 0, c];
  else [r, g, b] = [c, 0, x];
  const m = l - c / 2;
  const toHex = (v: number): string =>
    Math.round(Math.min(255, Math.max(0, (v + m) * 255)))
      .toString(16)
      .padStart(2, '0');
  return `#${toHex(r)}${toHex(g)}${toHex(b)}`;
}

/** 当前主题强调色 → 低饱和的二维码配色（色相跟随主题，饱和度与明度按上文夹紧）。 */
function useQrPalette(): { ink: string; eye: string } {
  // 订阅主题：换强调色 / 换明暗时重新取色（自定义属性是运行时算出来的，得重解析）。
  const accent = useThemeStore((state) => state.accent);
  const resolved = useThemeStore((state) => state.resolved);

  return useMemo(() => {
    const accentCss =
      getComputedStyle(document.documentElement)
        .getPropertyValue('--weq-accent-effective')
        .trim() || '#5b6b9a';
    const probed = resolveCssColorToRgb(accentCss) ?? { r: 91, g: 107, b: 154 };
    const { h, s } = rgbToHsl(probed);
    // 强调色接近灰时色相不可靠，退回中性偏靛。
    const hue = s < 0.03 ? NEUTRAL_HUE : h;
    return {
      ink: hslToHex(hue, Math.min(s, INK_MAX_SAT), INK_LIGHT),
      eye: hslToHex(hue, Math.min(s, EYE_MAX_SAT), EYE_LIGHT),
    };
    // accent / resolved 只是「变更信号」，实际取色走 CSS 变量。
  }, [accent, resolved]);
}

export function GroupJoinQr({
  url,
  size = 196,
  /** 底板颜色。白底是为静默区服务，一般不要改。 */
  plateColor = '#ffffff',
}: {
  url: string;
  size?: number;
  plateColor?: string;
}): ReactElement {
  const { ink, eye } = useQrPalette();
  const [matrix, setMatrix] = useState<{ size: number; data: Uint8Array } | null>(null);

  useEffect(() => {
    let cancelled = false;
    // errorCorrectionLevel 'H'（30%）：容错最高，圆点化后仍能扫。
    const qr = QRCode.create(url, { errorCorrectionLevel: 'H' });
    if (!cancelled) setMatrix({ size: qr.modules.size, data: qr.modules.data });
    return () => {
      cancelled = true;
    };
  }, [url]);

  const svg = useMemo(() => {
    if (!matrix) return null;
    const { size: modules, data } = matrix;
    const isDark = (r: number, c: number): boolean => Boolean(data[r * modules + c]);
    // 三个定位眼占 7×7，单独画成圆角框 + 圆点，数据位跳过它们。
    const inEye = (r: number, c: number): boolean =>
      (r < 7 && c < 7) || (r < 7 && c >= modules - 7) || (r >= modules - 7 && c < 7);

    const span = modules + QUIET_MODULES * 2;
    const view = span * CELL;
    const parts: string[] = [`<rect width="${view}" height="${view}" fill="${plateColor}"/>`];

    for (let r = 0; r < modules; r++) {
      for (let c = 0; c < modules; c++) {
        if (!isDark(r, c) || inEye(r, c)) continue;
        const cx = (c + QUIET_MODULES) * CELL + CELL / 2;
        const cy = (r + QUIET_MODULES) * CELL + CELL / 2;
        parts.push(`<circle cx="${cx}" cy="${cy}" r="${CELL * DOT_RADIUS}" fill="${ink}"/>`);
      }
    }

    for (const [r0, c0] of [
      [0, 0],
      [0, modules - 7],
      [modules - 7, 0],
    ] as const) {
      const x = (c0 + QUIET_MODULES) * CELL;
      const y = (r0 + QUIET_MODULES) * CELL;
      const w = 7 * CELL;
      parts.push(
        `<rect x="${x + CELL / 2}" y="${y + CELL / 2}" width="${w - CELL}" height="${w - CELL}" rx="${CELL * EYE_RING_RADIUS}" fill="none" stroke="${eye}" stroke-width="${CELL}"/>`,
      );
      parts.push(
        `<rect x="${x + 2 * CELL}" y="${y + 2 * CELL}" width="${3 * CELL}" height="${3 * CELL}" rx="${CELL * 1.05}" fill="${eye}"/>`,
      );
    }

    return `<svg xmlns="http://www.w3.org/2000/svg" width="${view}" height="${view}" viewBox="0 0 ${view} ${view}" shape-rendering="geometricPrecision">${parts.join('')}</svg>`;
  }, [matrix, ink, eye, plateColor]);

  if (!svg) return <div style={{ width: size, height: size }} aria-hidden />;
  return (
    <img
      src={`data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`}
      alt="WeQ 交流群二维码"
      width={size}
      height={size}
      style={{ width: size, height: size, display: 'block' }}
    />
  );
}
