/** 新版 TXT 保留文件名与附件行，识别文字保留换行以及引用／转发的缩进。 */
export function rewritePlainMedia(
  content: string,
  kind: '图片' | '语音',
  fileName: string,
  text: string,
): { content: string; replaced: number; skipped: number } {
  const escaped = fileName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const re = new RegExp(
    `(^|\\n)([ >]*)\\[${kind}: ${escaped}\\]((?:\\n\\2附件：[^\\n]*)?)(?=\\n|$)`,
    'g',
  );
  const marker = kind === '图片' ? '[图片文字]' : '[语音转写]';
  let replaced = 0;
  const next = content.replace(
    re,
    (match: string, _start: string, indent: string, _path: string, offset: number) => {
      if (content.slice(offset + match.length).startsWith(`\n${indent}${marker}\n`)) return match;
      replaced++;
      const body = text
        .replace(/\r\n?/g, '\n')
        .split('\n')
        .map((line) => `${indent}${line}`)
        .join('\n');
      return `${match}\n${indent}${marker}\n${body}`;
    },
  );
  return { content: next, replaced, skipped: 0 };
}
