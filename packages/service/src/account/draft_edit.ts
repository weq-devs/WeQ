/**
 * 草稿内存副本的记账规则 —— 纯函数、零依赖，作为 `@weq/service/draft-edit`
 * 子路径导出（理由同 `report-time`：renderer 只 type-import 主 barrel，但它要能
 * 被真正 import 进浏览器包，也要能被单测直接跑）。
 *
 * 这里只有一条不变式，但它是「删了输入的内容、离开却清不掉草稿」那个 bug 的根因：
 *
 * > **「用户清空了」必须表达成「这个会话的值是空串」，不能表达成「没有这个键」。**
 *
 * 草稿只记在内存里，离开会话时才写回库。如果清空走 `delete`，那么「清空了」和
 * 「这次根本没动过」在内存里长得一模一样 —— 落库时无从区分，就只会把上一次落库的
 * 旧正文原样写回去。
 */

/**
 * 记录一次输入框改动。返回值是新的内存副本（不修改入参）。
 *
 * 只填空白字符视为清空（与 composer 的 trim 语义一致），落成空串。
 */
export function setLocalDraft(
  current: Readonly<Record<string, string>>,
  conversationId: string,
  value: string,
): Record<string, string> {
  const trimmed = value.trim();
  return { ...current, [conversationId]: trimmed ? value : '' };
}

/**
 * 取出要写回库的正文。空串 = 让后端删掉该会话的草稿。
 *
 * 只读内存副本，**不回退到已落库的旧值** —— 脏会话必然在这里有记录（见
 * {@link setLocalDraft}），拿别处的旧正文兜底正是清不掉草稿的原因。
 */
export function localDraftToWrite(
  current: Readonly<Record<string, string>>,
  conversationId: string,
): string {
  return current[conversationId] ?? '';
}
