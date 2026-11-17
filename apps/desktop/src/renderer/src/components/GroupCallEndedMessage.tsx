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

import { Phone, Radio, Video } from 'lucide-react';
import { GROUP_VIDEO_ENDED, GROUP_CLASSROOM_ENDED } from './GroupCallEndedMessage.shared';

interface GroupCallEndedMessageProps {
  element: {
    type: 'call';
    data?: {
      subType?: number;
      callSummary?: string[];
    };
  };
}

export function GroupCallEndedMessage({ element }: GroupCallEndedMessageProps) {
  const { subType, callSummary } = element.data || {};
  const st = Number(subType);
  const Icon = st === GROUP_VIDEO_ENDED ? Video : st === GROUP_CLASSROOM_ENDED ? Radio : Phone;
  const fallback =
    st === GROUP_VIDEO_ENDED
      ? '视频通话已结束'
      : st === GROUP_CLASSROOM_ENDED
        ? '群课堂已结束'
        : '语音通话已结束';

  // QQ 自己写好的文案，拿不到就用 fallback。
  const summary = Array.isArray(callSummary)
    ? callSummary.filter((s) => typeof s === 'string' && s).join(' ')
    : '';

  return (
    <div className="weq-graytip weq-group-call text-center text-xs py-2">
      <Icon className="weq-group-call-icon" size={13} strokeWidth={2} aria-hidden />
      <span>{summary || fallback}</span>
    </div>
  );
}
