/** 公共空间富文本的可读文字；保留 QQ 表情 token，不把媒体结构当正文。 */
export function publicRichText(items: unknown): string {
  if (!Array.isArray(items)) return '';
  return items
    .map((item) => {
      if (!item || typeof item !== 'object') return '';
      const value = item as Record<string, unknown>;
      const type =
        typeof value.type === 'number'
          ? value.type
          : typeof value.type === 'string' && /^-?\d+$/.test(value.type.trim())
            ? Number(value.type)
            : null;
      return type === 0 && typeof value.content === 'string' ? value.content : '';
    })
    .join('')
    .trim();
}
