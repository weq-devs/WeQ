/**
 * 一条消息在**聊天时间线**里的完整渲染单元 —— 聊天区、转发窗口、合成转发预览
 * 三处共用同一份实现。
 *
 * 为什么要有这一层：主面板画一条消息其实是三层组装，而不是「一个消息体组件」——
 *
 *   chatPane        → 灰条分流（撤回 / 戳一戳 / 群提示 / 群通话结束 / QQ动态）
 *   MessageBubble   → 气泡外壳（头像 / 昵称 / 徽章 / 贴表情 / 精华 / 撤回标签 / 删除面纱）
 *   qqMessageRenderer → QqMessageContent（消息体：文本 / 媒体 / 卡片 / 合并转发…）
 *
 * 合并转发窗口与合成转发编辑器此前只复用最里层那一层，于是凡是落在前两层里的元素
 * （灰条、动态卡、群通话结束…）在那边要么空白、要么退化成难看的普通气泡。把前两层
 * 抽到这里之后，三处的差异只剩「谁提供 sender / 谁处理右键菜单」这类宿主参数。
 *
 * 刻意不做的事：这里不查库、不发请求、不碰 proto。它只根据已经拿到的 `Message`
 * 决定「画成灰条还是画成气泡」。
 */

import { GROUP_CALL_ENDED_SUBTYPES } from '../../components/GroupCallEndedMessage.shared';

/**
 * 画成**居中灰条**（不套气泡、不显示头像昵称）的元素 kind。
 *
 * 群通话 / 群课堂的「已结束」（CALL 元素，subType 16/25/29）也算：那条消息的发送者
 * 是空的，套气泡会凭空多出一个发送者，所以走灰条；发起那条有正常发送人，仍走气泡。
 */
export const GRAY_TIP_KINDS: string[] = [
  'grayTipPoke',
  'grayTipRevoke',
  'grayTipGroup',
  'grayTipXml',
  'grayTipFileRecv',
  'grayTipTempSession',
  'qqDynamic',
];

/** 一条消息携带的元素（模板层叫 qqElements，转发窗口用 elements）。 */
export function messageElements(
  message: unknown,
): { type?: string; data?: Record<string, unknown> }[] {
  const raw =
    (message as { qqElements?: unknown[] })?.qqElements ??
    (message as { elements?: unknown[] })?.elements ??
    [];
  return Array.isArray(raw) ? (raw as { type?: string; data?: Record<string, unknown> }[]) : [];
}

export interface GrayTipMatch {
  kind: string;
  el: { type?: string; data?: Record<string, unknown> };
}

/**
 * 这条消息该不该画成灰条、画成哪一种。
 *
 * 返回 null = 普通消息，走气泡。判断顺序与旧的 chatPane 内联实现完全一致（按
 * {@link GRAY_TIP_KINDS} 的顺序取第一个命中的元素），所以聊天区行为不变。
 */
export function grayTipOf(message: unknown): GrayTipMatch | null {
  const els = messageElements(message);
  for (const kind of GRAY_TIP_KINDS) {
    const el = els.find((e) => e?.type === kind);
    if (el) return { kind, el };
  }
  const callEnded = els.find(
    (e) => e?.type === 'call' && GROUP_CALL_ENDED_SUBTYPES.has(Number(e?.data?.subType)),
  );
  if (callEnded) return { kind: 'groupCallEnded', el: callEnded };
  return null;
}
