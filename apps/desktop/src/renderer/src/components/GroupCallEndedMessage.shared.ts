/**
 * 群通话「已结束」灰条 (CALL element, elementType=21, subType=16/25).
 *
 * 群聊和私聊的通话记录结构完全不同：私聊一条消息就是整通电话的最终状态（接通 /
 * 未接 / 拒绝），群聊则拆成两条独立消息 —— 「XXX 发起了语音通话」（callMethod=
 * 1/2，40020 是发起人）和「语音通话已结束」（callMethod=0，40020 为空），中间没
 * 有任何状态。
 *
 * 发起那条有正常的发送人，仍走气泡（QqCall）；结束这条谁也不属于，套气泡会凭空
 * 多出一个发送者，所以画成居中灰条。
 */

/** CALL subType：群通话/群课堂结束。见 packages/codec/src/element/types.ts。 */
const GROUP_VOICE_ENDED = 16;
export const GROUP_VIDEO_ENDED = 25;
export const GROUP_CLASSROOM_ENDED = 29;

export const GROUP_CALL_ENDED_SUBTYPES = new Set<number>([
  GROUP_VOICE_ENDED,
  GROUP_VIDEO_ENDED,
  GROUP_CLASSROOM_ENDED,
]);
