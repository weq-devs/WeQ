/**
 * 聊天时间线的键盘焦点移动。
 *
 * 消息行本身用 `tabIndex={-1}` 进入可聚焦状态，由聊天区容器统一接管方向键：
 * 这里只负责“当前条目的上一条 / 下一条是哪条”，不碰 DOM、不碰虚拟列表。
 * 之后由 `chatPane` 负责滚动与聚焦；这样虚拟化、窗口分页和消息过滤都不会
 * 影响这套纯逻辑，也方便单测覆盖首尾边界。
 */

/** 当前消息在列表中的上一条 / 下一条；到达边界返回 undefined。 */
export function adjacentMessageId(
  ids: readonly string[],
  currentId: string | null | undefined,
  direction: 1 | -1,
): string | undefined {
  if (!currentId || ids.length === 0) return undefined;
  const index = ids.indexOf(currentId);
  if (index === -1) return undefined;
  return ids[index + direction];
}

/** 列表首条 / 末条消息 id，供 Home / End 与空焦点时的初始落点使用。 */
export function edgeMessageId(ids: readonly string[], edge: 'first' | 'last'): string | undefined {
  if (ids.length === 0) return undefined;
  return edge === 'first' ? ids[0] : ids[ids.length - 1];
}
