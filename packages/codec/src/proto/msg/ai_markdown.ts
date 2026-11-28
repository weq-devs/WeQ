/**
 * AI 助手（小Q）markdown 的卡片与流式元数据。
 *
 * 这些字段都挂在 MARKDOWN 元素（elementType=14）的同一个 wire 结构里，
 * 与 QQ 闪传共用 tag 48707。闪传用的是另一套嵌套结构，按本文件解出来
 * 全是空值。AI 助手有阶段、卡片或推送等元数据。
 *
 * 实测样本：`ai_assistant_msg_table` 全部消息（docs/database/nt_msg/ai-assistant.md）。
 */

import { ProtoField, ScalarType } from '../../core';

/**
 * `48707` 的嵌套结构。
 *
 * 一条 AI 回复在 40800 里是**多个** MARKDOWN 元素拼成的流式片段：
 *   - `phase = 'reasoning_content'`：思考阶段标记，`cardPayload` / `metaJson`
 *     实测全空，**没有正文**，渲染时直接丢弃；
 *   - `phase = 'content'` 或阶段为空：正文片段，文本在 48701；
 *   - `phase = 'agent_end'`：收尾，`metaJson` 是整条回复的摘要与权限元数据。
 */
export const AiMarkdownWire = {
  /**
   * 卡片定义表（JSON 文本）。键是 markdown 正文里
   * `[](qagent://markdown/node?type=…&id=…)` 占位符的 id，值是卡片对象：
   * `type: 'qui'`（结构化卡片）/ `'quser'`（用户卡）/ `'qlink'`（外链）。
   */
  cardPayload: ProtoField(52960, ScalarType.STRING, { optional: true }),
  /** 阶段标记：`reasoning_content` / `content` / `agent_end`。 */
  phase: ProtoField(52961, ScalarType.STRING, { optional: true }),
  /** 小 JSON：`chitChatRoundId` / `auth_denied` / `text_brief` / `push_info` 等。 */
  metaJson: ProtoField(52962, ScalarType.STRING, { optional: true }),
  flag52963: ProtoField(52963, ScalarType.UINT32, { optional: true }),
  flag52964: ProtoField(52964, ScalarType.UINT32, { optional: true }),
};

/**
 * 推荐消息 / 操作栏里单个按钮的动作码（tag 48770）。
 *
 * 与机器人内联键盘（elementType=17）共用 48751/48753 的行/按钮结构，
 * 但这两类元素的按钮没有 `action` 字符串，真正的动作在 `actionCode`：
 *   操作栏（44）：4=重新生成、7=复制、1=喜欢、2=不喜欢、6=分享
 *   推荐（43）：`actionCode` 为 0，点击后发送同条按钮的 `label` 文本。
 */
export const AiButtonActionWire = {
  /** 动作码。 */
  actionCode: ProtoField(48780, ScalarType.UINT32, { optional: true }),
  flag48781: ProtoField(48781, ScalarType.UINT32, { optional: true }),
};

/** 推荐/操作栏按钮里的提示元数据（tag 48773）。 */
export const AiButtonHintWire = {
  hintSource: ProtoField(48782, ScalarType.UINT32, { optional: true }),
  buildTag: ProtoField(48783, ScalarType.STRING, { optional: true }),
  hintJson: ProtoField(48784, ScalarType.STRING, { optional: true }),
};

/** 推荐消息外层（tag 48796）的 JSON 文本，含 screen_id / trigger。 */
export const AI_RECOMMENDED_FLAG_TAG = 48796;
/** 操作栏/推荐消息共用的外层标志（tag 48794），观测为空。 */
export const AI_ACTION_BAR_FLAG_TAG = 48794;
