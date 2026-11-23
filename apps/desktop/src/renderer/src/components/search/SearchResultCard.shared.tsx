/** Renders one unified-search hit as a card (dropdown row + "more" modal row). */

import { createPinyinMatcher } from '@weq/codec/pinyin-search';
import { Fragment, type ReactElement } from 'react';

/** Group avatar CDN: https://p.qlogo.cn/gh/<code>/<code>/0 */
export function groupAvatarSrc(groupCode: string): string | null {
  return groupCode ? `https://p.qlogo.cn/gh/${groupCode}/${groupCode}/0` : null;
}

/** C2C avatar CDN by QQ number: https://thirdqq.qlogo.cn/g?b=sdk&s=0&nk=<uin> */
export function c2cAvatarSrc(uin: string): string | null {
  if (!uin || uin === '0') return null;
  return `https://thirdqq.qlogo.cn/g?b=sdk&s=0&nk=${uin}`;
}

/** 文件名 → 通用文件图标（resources 里的 png 名）。 */
export function fileExtIcon(fileName: string): string {
  const ext = fileName.split('.').pop()?.toLowerCase() ?? '';
  const map: Record<string, string> = {
    doc: 'doc.png',
    docx: 'doc.png',
    xls: 'xls.png',
    xlsx: 'xls.png',
    ppt: 'ppt.png',
    pptx: 'ppt.png',
    pdf: 'pdf.png',
    zip: 'zip.png',
    '7z': 'zip.png',
    gz: 'zip.png',
    tar: 'zip.png',
    rar: 'rar.png',
    exe: 'exe.png',
    msi: 'exe.png',
    mp3: 'audio.png',
    wav: 'audio.png',
    flac: 'audio.png',
    aac: 'audio.png',
    ogg: 'audio.png',
    m4a: 'audio.png',
    mp4: 'video.png',
    avi: 'video.png',
    mov: 'video.png',
    mkv: 'video.png',
    flv: 'video.png',
    wmv: 'video.png',
    png: 'image.png',
    jpg: 'image.png',
    jpeg: 'image.png',
    gif: 'image.png',
    webp: 'image.png',
    bmp: 'image.png',
    svg: 'image.png',
    txt: 'txt.png',
    md: 'markdown.png',
    log: 'txt.png',
    ai: 'ai.png',
    apk: 'apk.png',
    bak: 'bak.png',
    js: 'code.png',
    ts: 'code.png',
    jsx: 'code.png',
    tsx: 'code.png',
    py: 'code.png',
    java: 'code.png',
    c: 'code.png',
    cpp: 'code.png',
    cs: 'code.png',
    go: 'code.png',
    rs: 'code.png',
    html: 'code.png',
    css: 'code.png',
    dmg: 'dmg.png',
    ttf: 'font.png',
    otf: 'font.png',
    woff: 'font.png',
    woff2: 'font.png',
    ipa: 'ipa.png',
    key: 'keynote.png',
    xmind: 'mindmap.png',
    numbers: 'numbers.png',
    pages: 'pages.png',
    pkg: 'pkg.png',
    psd: 'ps.png',
    sketch: 'sketch.png',
  };
  return map[ext] ?? 'unknown.png';
}

export function createSearchHighlighter(keyword: string, matchPinyin = false) {
  const needle = keyword.trim();
  const literal = needle && new RegExp(needle.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'giu');
  const pinyin = matchPinyin ? createPinyinMatcher(needle) : undefined;
  const findRanges = (text: string): readonly (readonly [number, number])[] => {
    if (!literal) return [];
    const matches = Array.from(
      text.matchAll(literal),
      ({ index, 0: match }) => [index, index + match.length] as const,
    );
    return matches.length ? matches : (pinyin?.findRanges(text) ?? []);
  };
  return {
    matches: (text: string) => findRanges(text).length > 0,
    render(text: string): ReactElement {
      const ranges = findRanges(text);
      return (
        <>
          {ranges.map(([start, end], index) => (
            <Fragment key={start}>
              {text.slice(ranges[index - 1]?.[1] ?? 0, start)}
              <mark className="weq-search-hl">{text.slice(start, end)}</mark>
            </Fragment>
          ))}
          {text.slice(ranges.at(-1)?.[1] ?? 0)}
        </>
      );
    },
  };
}

export function highlightText(text: string, keyword: string): ReactElement {
  return createSearchHighlighter(keyword).render(text);
}
