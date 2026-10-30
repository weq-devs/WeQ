/**
 * 闪照（阅后即焚图）在**渲染层**的识别与占位处理。
 *
 * 背景（`docs/database/nt_msg/elements/pic.md`）：闪照在本地库 `40800` 里只剩一条
 * 纯文本 `[闪照]请使用新版手机QQ查看闪照。`，真正的 `commonElem(serviceType=3)`
 * 元素从来没落过库。所以离线看到的永远是这句话，图片本体也不在磁盘上。
 *
 * 要看内容只有一条路：**走协议拉取**（`SsoGetC2cMsg` / `SsoGetGroupMsg`，服务端
 * 漫游里这条消息仍然带着完整的闪照元素），拿到后按 `pic` + `isFlash` 重新渲染。
 * 这条链路需要在线 QQ + 完整模式，所以本模块只负责「识别」和「文案」，拉取由
 * `MainView` 在会话层触发。
 */

/**
 * 闪照的兜底文案 —— 与 `@weq/protocol` 的 `FLASH_PHOTO_FALLBACK_TEXT` 同值。
 *
 * 不直接 import：渲染层不能依赖 protocol 包（那边带 node / native 依赖，会被打进
 * 渲染进程的 bundle）。两处都改的话请一起改，协议包有测试钉住这个字面量。
 */
export const FLASH_PHOTO_PLACEHOLDER_TEXT = '[闪照]请使用新版手机QQ查看闪照。';

/** 这条纯文本是不是闪照的兜底文案（用于触发协议补拉）。 */
export function isFlashPhotoPlaceholderText(text: string): boolean {
  return text.trim() === FLASH_PHOTO_PLACEHOLDER_TEXT;
}

/** 同一条闪照最多尝试补拉几次（瞬时失败放回队列，靠这个上限收口）。 */
export const FLASH_PHOTO_MAX_ATTEMPTS = 3;

/** 补拉回来的一条消息（只保留判定要用的字段）。 */
export interface FlashPhotoFetchedRow {
  msgSeq: string;
  elements: readonly unknown[];
  sourceFormat?: 'native' | 'protocol';
}

/**
 * 从补拉结果里挑出可以回填的那条。
 *
 * **必须按 `msgSeq` 匹配，不能按 `msgId`**：本地库里那条是 QQ 写入的
 * （`7702493945254447733`），漫游回来的是服务端另一套 id
 * （`72057595742500046`）——同一个 seq，两个 id，按 msgId 比永远对不上。
 * 这正是「补拉成功了但界面一直显示兜底文案」的根因。
 *
 * 只认带 `pic` + `isFlash` 的结果：同一 seq 上其他形态的消息（比如只剩一条
 * 普通文本）不能拿来顶替。
 */
export function pickFlashPhotoFetch<T extends FlashPhotoFetchedRow>(
  rows: readonly T[],
  msgSeq: string,
): T | null {
  const hit = rows.find((row) => String(row.msgSeq) === String(msgSeq));
  if (!hit) return null;
  const hasFlash = hit.elements.some(
    (element) =>
      (element as { type?: string } | null)?.type === 'pic' &&
      (element as { data?: { isFlash?: boolean } } | null)?.data?.isFlash === true,
  );
  return hasFlash ? hit : null;
}

/**
 * 补拉失败/落空之后，这条消息还能不能再试。
 *
 * 三种结局：
 *   - `retry`：瞬时失败（SSO 未登记、网络抖动、**空响应**），放回队列；
 *   - `give-up`：服务端确实没有可补的内容（窗口里有消息但没有闪照元素），别再打；
 *   - `replace`：拿到了真元素，回填后不再试。
 */
export type FlashPhotoOutcome = 'retry' | 'give-up' | 'replace';

export function classifyFlashPhotoFetch(input: {
  ok: boolean;
  reason?: string;
  message?: string;
  /** 本次窗口服务端返回的条数。 */
  fetchedRows: number;
  /** 是否在返回的消息里找到了带闪照元素的那条。 */
  picked: boolean;
}): FlashPhotoOutcome {
  if (!input.ok) {
    return isTransientFlashPhotoFailure(input.reason ?? 'error', input.message ?? '')
      ? 'retry'
      : 'give-up';
  }
  if (input.picked) return 'replace';
  // **零条要当瞬时处理**：窗口精确到单条时，SSO 连接恰好在这一刻断开重连会拿到
  // 一个空响应（实测 response_len=66，同一毫秒 `sso read loop ended`），那不是
  // 「服务端没有这条」。以前这里一律判死，闪照就永远停在兜底文案了。
  if (input.fetchedRows === 0) return 'retry';
  return 'give-up';
}

/**
 * 补拉闪照失败是不是**瞬时**的 —— 是就放回队列等下一轮，不是就永久放弃。
 *
 * 踩过的坑：QQ 刚上线时 SSO 会话还没登记（Linux 要先提权读内存拿 a2/d2），
 * 这时候发包必定回「还没有登记 SSO 会话」。以前把这种失败当成定论，一条消息
 * 只试一次，于是这条闪照永远停在兜底文案 —— 哪怕几十秒后凭据已经齐了。
 */
export function isTransientFlashPhotoFailure(reason: string, message: string): boolean {
  // offline = 在线 QQ 没起来 / 完全离线模式；error = 其它（SSO 未登记、网络抖动等）。
  if (reason === 'offline') return true;
  // 只认 SSO 特有的措辞。别泛泛匹配「会话」—— 账号 / NT 序号不一致的报错里也有这两个
  // 字，那是永久失败，不能放进重试队列反复打。
  if (/SSO|setSsoSession/.test(message)) return true;
  return /网络|超时|timeout|连接|network|ECONN|ETIMEDOUT|EPIPE/i.test(message);
}
