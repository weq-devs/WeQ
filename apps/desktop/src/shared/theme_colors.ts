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

/** 不改用户原色，只派生用于实心底和中性色表面的文字颜色。 */
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
  return { accent, onAccent, ink, hover };
}
