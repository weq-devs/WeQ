import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { resolveResource } from '../resource';

let fontCache: Buffer | null = null;

/** Satori 需要单字体 TTF/OTF；优先打包字体，系统字体仅作原有兜底。 */
export function loadCjkFont(): Buffer {
  if (fontCache) return fontCache;
  const winFonts = process.env.WINDIR ? join(process.env.WINDIR, 'Fonts') : null;
  const candidates = [
    resolveResource('assistant', 'fonts', 'cover.ttf'),
    resolveResource('assistant', 'fonts', 'cover.otf'),
    winFonts ? join(winFonts, 'Deng.ttf') : null,
    winFonts ? join(winFonts, 'simhei.ttf') : null,
    winFonts ? join(winFonts, 'msyh.ttc') : null,
    winFonts ? join(winFonts, 'msyhl.ttc') : null,
    '/System/Library/Fonts/STHeiti Light.ttc',
    '/System/Library/Fonts/Hiragino Sans GB.ttc',
    '/Library/Fonts/Arial Unicode.ttf',
    '/usr/share/fonts/noto-cjk/NotoSansCJK-Regular.ttc',
    '/usr/share/fonts/opentype/noto/NotoSansCJK-Regular.ttc',
    '/usr/share/fonts/noto-cjk/NotoSansCJKsc-Regular.otf',
    '/usr/share/fonts/truetype/wqy/wqy-microhei.ttc',
    '/usr/share/fonts/wenquanyi/wqy-zenhei/wqy-zenhei.ttc',
  ].filter((path): path is string => !!path && existsSync(path));
  if (!candidates.length)
    throw new Error(
      '[weq-assistant/cover] no usable TTF/OTF font found (need a CJK .ttf/.otf). ' +
        'Install one of: Deng.ttf / simhei.ttf (Windows), Noto Sans CJK, or WenQuanYi.',
    );
  const picked = candidates.find((path) => !path.toLowerCase().endsWith('.ttc')) ?? candidates[0]!;
  try {
    fontCache = readFileSync(picked);
  } catch (error) {
    throw new Error(`[weq-assistant/cover] failed to read font ${picked}: ${String(error)}`);
  }
  return fontCache;
}
