/**
 * 输入框工具栏「弹射表情」按钮弹出的面板（QQ 表情弹射 / FACEBUBBLE）。
 *
 * **只做前端** —— 本模块不碰任何协议，也不负责真正下发：面板把「系统表情 +
 * 弹射个数」编成一枚 `emojiBounce` 元素 token 交回上层（`onSend`），发不发得出去、
 * 怎么发由 chatPane 那一侧决定（和 linkCardPanel / aiVoicePanel 一个套路）。
 *
 * 三件事在这里落地：
 *   1. **只给系统表情**（`base_sys_emoji_table` 里非 unicode 的那部分）：弹射的是
 *      表情图本身，字符表情没有图可弹，所以 unicode 那些组整组不出现；
 *   2. **个数 1 – 2147483647**：真机实测 QQ 按 **int32** 读这个字段（见
 *      `@weqbot/protocol` 的 send-elements 注释：`2^31` 回绕成负数、`2^32` 变 0，
 *      0 与负数是**静默不弹**），所以面板把上界钉在 int32 上限，不让人白填一个
 *      发出去什么都不发生的数；
 *   3. **预览**：左边就是这条消息在聊天窗口里的样子 —— 表情 + 右下角 ×N 角标
 *      （跟 `QqEmojiBounce` 渲染器一致），右侧是数量控件。
 *
 * ⚠️ 元素用的是**收侧 codec 形状**（`emojiBounceId` / `emojiBounceTextSummary`…），
 * 与草稿里其它元素同一套字段；将来把发送接上时，协议层要把它翻成
 * `@weqbot/protocol` 的 `SendEmojiBounceElement`（`faceId` / `count` / `name`）。
 */

import { elementToToken } from './draftElements';

/**
 * 弹射个数上限 —— QQ 把 `count` 当 **int32** 读，`2^31` 起回绕成负数（收端静默
 * 不弹），所以面板只允许到 int32 上限。
 */
export const BOUNCE_COUNT_MAX = 2147483647;

export type BounceEmojiDraft = {
  /** 小黄脸 faceId（与系统表情目录同一套 id）。 */
  faceId: number;
  /** 表情名，**不带**方括号（如 `笑哭`）—— 真机样本的 `name` 就是这个形状。 */
  name: string;
  /** 弹射个数（1 – {@link BOUNCE_COUNT_MAX}）。 */
  count: number;
};

/**
 * 草稿 → codec 元素（`kind: 'emojiBounce'`）。
 *
 * 字段与 `docs/database/nt_msg/elements/emoji-bounce.md` 一一对应：
 *   - 52132 `emojiBounceId` / 52134 `emojiBounceName`；
 *   - 52138 `emojiBounceTextSummary` 是**带个数的文本总结**（真机样本
 *     「你弹射了3个[大笑]」），`QqEmojiBounce` 就是从它里面读 ×N 角标的；
 *   - 52139 `emojiBouncePcText` 给桌面端兜底显示；
 *   - 52137 `emojiBounceDetail` 冗余一份名字与总结。
 */
export function bounceEmojiElement(draft: BounceEmojiDraft): Record<string, unknown> {
  const count = Math.min(Math.max(Math.trunc(draft.count) || 1, 1), BOUNCE_COUNT_MAX);
  const name = draft.name.trim();
  const summary = `你弹射了${count}个[${name}]`;
  return {
    kind: 'emojiBounce',
    emojiBounceId: draft.faceId,
    emojiBounceFlag52133: false,
    emojiBounceName: name,
    emojiBounceDetail: { flag52142: 0, name, textSummary: summary },
    emojiBounceTextSummary: summary,
    emojiBouncePcText: summary,
  };
}

/** 草稿 → 元素 token（chatPane 的 extraTokens 直接吃）。 */
export function bounceEmojiToken(draft: BounceEmojiDraft): string {
  return elementToToken(bounceEmojiElement(draft));
}
