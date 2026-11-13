export const DEFAULT_ACCENT = '#0099ff';
export const DEFAULT_DARK_ACCENT = '#56a8f7';

export function normalizeHex(input: string | null | undefined): string | null {
  if (!input) return null;
  let hex = input.trim().replace(/^#/, '');
  if (/^[0-9a-f]{3}$/i.test(hex)) hex = [...hex].map((c) => c + c).join('');
  return /^[0-9a-f]{6}$/i.test(hex) ? `#${hex.toLowerCase()}` : null;
}

function channels(hex: string): number[] {
  const value = Number.parseInt((normalizeHex(hex) ?? DEFAULT_ACCENT).slice(1), 16);
  return [(value >> 16) & 255, (value >> 8) & 255, value & 255];
}

/** sRGB 插值；与助手封面原有的混色约定一致。 */
export function mix(a: string, b: string, ratio: number): string {
  const left = channels(a);
  const right = channels(b);
  return `#${left
    .map((value, index) =>
      Math.max(0, Math.min(255, Math.round(value + ((right[index] ?? 0) - value) * ratio)))
        .toString(16)
        .padStart(2, '0'),
    )
    .join('')}`;
}

function luminance(hex: string): number {
  const linear = channels(hex).map((value) => {
    const channel = value / 255;
    return channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4;
  });
  return (linear[0] ?? 0) * 0.2126 + (linear[1] ?? 0) * 0.7152 + (linear[2] ?? 0) * 0.0722;
}

export function contrastRatio(a: string, b: string): number {
  const left = luminance(a);
  const right = luminance(b);
  return (Math.max(left, right) + 0.05) / (Math.min(left, right) + 0.05);
}

/** WCAG 2.x 只看亮度差；APCA 更接近人眼对「深底浅字／浅底深字」的感知。 */
export function apcaLc(text: string, bg: string): number {
  const relative = (hex: string) => {
    const linear = channels(hex).map((value) => {
      const channel = value / 255;
      return channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4;
    });
    return (linear[0] ?? 0) * 0.2126 + (linear[1] ?? 0) * 0.7152 + (linear[2] ?? 0) * 0.0722;
  };
  const softClamp = (y: number) => (y > 0.022 ? y : y + (0.022 - y) ** Math.SQRT2);
  const sapc = (softClamp(relative(bg)) ** 0.56 - softClamp(relative(text)) ** 0.57) * 1.14;
  if (Math.abs(sapc) < 0.1) return 0;
  return Math.round((sapc > 0 ? sapc - 0.027 : sapc + 0.027) * 100);
}

/** 保留用户原色，分别派生文字与实心操作的可读配色。 */
export function accentColors(input: string, mode: 'light' | 'dark') {
  const accent = normalizeHex(input) ?? (mode === 'dark' ? DEFAULT_DARK_ACCENT : DEFAULT_ACCENT);
  const onAccent =
    contrastRatio(accent, '#000000') >= contrastRatio(accent, '#ffffff') ? '#000000' : '#ffffff';
  const surface = mode === 'dark' ? '#363636' : '#f7f7f7';
  const backgrounds = [surface, mix(surface, accent, 0.18)];
  const toward = mode === 'dark' ? '#ffffff' : '#000000';
  let ink = accent;
  for (let step = 0; step <= 100; step++) {
    ink = mix(accent, toward, step / 100);
    if (backgrounds.every((background) => contrastRatio(ink, background) >= 4.5)) break;
  }
  const hover = mix(accent, onAccent === '#000000' ? '#ffffff' : '#000000', 0.08);
  let solid = accent;
  let onSolid = onAccent;
  if (mode === 'light' && Math.abs(apcaLc('#000000', accent)) < 60) {
    // 中亮度强调色压黑字：WCAG 能到 7:1，但 APCA 只有 50 上下，观感发闷。
    // 实心控件改用白字，并把底色压到「白字同时满足 AA 4.5 与 APCA 60」。
    onSolid = '#ffffff';
    for (let step = 1; step <= 100; step++) {
      solid = mix(accent, '#000000', step / 100);
      if (contrastRatio(solid, '#ffffff') >= 4.5 && Math.abs(apcaLc('#ffffff', solid)) >= 60) break;
    }
  } else if (contrastRatio(solid, onSolid) < 7) {
    onSolid = '#ffffff';
    for (let step = 1; step <= 100; step++) {
      solid = mix(accent, '#000000', step / 100);
      if (contrastRatio(solid, onSolid) >= 7) break;
    }
  }
  const solidHover = mix(solid, onSolid === '#000000' ? '#ffffff' : '#000000', 0.08);
  return { accent, onAccent, ink, hover, solid, onSolid, solidHover };
}
