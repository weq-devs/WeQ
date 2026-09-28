/**
 * 弹射个数的紧凑写法 —— 角标只有十几个字符宽，`2,147,483,647` 放不下，
 * 用 `21.47亿` / `1.5万` 这种。
 *
 * 面板预览（`BounceEmojiPanel`）和聊天窗口里的角标（`QqEmojiBounce`）共用一份，
 * 否则同一个数字在两处会长得不一样。
 */
export function formatBounceCount(count: number): string {
  if (!Number.isFinite(count)) return '—';
  if (count < 10000) return String(count);
  if (count >= 100000000) {
    const text = Math.round((count / 100000000) * 100) / 100;
    return `${text}亿`;
  }
  const text = Math.round((count / 10000) * 100) / 100;
  return `${text}万`;
}
