/**
 * 让单行输入框随内容自动增高（到上限后内部滚动），用于 AgentLab 的会话输入框：
 * 默认一行高度，Shift+Enter 换行时撑高输入框本身，不影响旁边的发送按钮。
 */

const MAX_HEIGHT = 140;

/** 依据内容把 textarea 高度收紧/撑高到 [一行, MAX_HEIGHT] 区间。 */
export function autoGrowTextarea(el: HTMLTextAreaElement | null, max = MAX_HEIGHT): void {
  if (!el) return;
  el.style.height = 'auto';
  el.style.height = `${Math.min(el.scrollHeight, max)}px`;
}
