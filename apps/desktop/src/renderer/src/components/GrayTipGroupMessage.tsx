import type { Conversation, GroupMember, Message } from '../im-template/template/types';
import { displayUserName } from '../im-template/template/user';

interface GrayTipGroupMessageProps {
  element: {
    type: 'grayTipGroup';
    data?: {
      groupTipType?: number;
      user1GroupNick?: string;
      user2GroupNick?: string;
      muteInfo?: {
        operator?: { uid?: string };
        mutedUser?: { uid?: string; groupNick?: string };
        timestamp?: bigint;
        duration?: number;
      };
    };
  };
  conversation: Conversation;
  message: Message;
}

function formatMuteDuration(seconds: number): string {
  if (seconds === 0) return '';
  const days = Math.floor(seconds / 86400);
  const hours = Math.floor((seconds % 86400) / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);

  if (days > 0) return `${days}天`;
  if (hours > 0) return `${hours}小时`;
  return `${minutes}分钟`;
}

export function GrayTipGroupMessage({ element, conversation, message }: GrayTipGroupMessageProps) {
  const { groupTipType, user1GroupNick, user2GroupNick, muteInfo } = element.data || {};

  // 构建成员映射
  const memberMap = new Map<string, GroupMember>();
  if (message.sender) {
    memberMap.set(message.sender.id, message.sender as GroupMember);
    if (message.sender.identityValue) {
      memberMap.set(message.sender.identityValue, message.sender as GroupMember);
    }
  }
  if (conversation.type === 'group') {
    conversation.members.forEach((m) => {
      memberMap.set(m.id, m);
      if (m.identityValue) {
        memberMap.set(m.identityValue, m);
      }
    });
  }

  // 加入群聊
  if (groupTipType === 1 && user1GroupNick) {
    return (
      <div className="text-center text-gray-500 text-xs py-2">
        <span className="text-blue-500">{user1GroupNick}</span>
        <span className="px-1">加入了群聊</span>
      </div>
    );
  }

  // 禁言相关 (groupTipType === 8)
  if (groupTipType === 8 && muteInfo) {
    const duration = muteInfo.duration || 0;
    const operatorUid = muteInfo.operator?.uid;
    const operatorMember = operatorUid ? memberMap.get(operatorUid) : null;
    const operatorNick = operatorMember ? displayUserName(operatorMember) : (user1GroupNick || operatorUid);

    const targetUid = muteInfo.mutedUser?.uid;
    const targetNick = muteInfo.mutedUser?.groupNick ||
                       (targetUid ? (memberMap.get(targetUid) ? displayUserName(memberMap.get(targetUid)!) : user2GroupNick) : null);

    if (targetNick) {
      // 个人禁言
      if (duration > 0) {
        return (
          <div className="text-center text-gray-500 text-xs py-2">
            <span className="text-blue-500">{targetNick}</span>
            <span> 被 </span>
            <span className="text-blue-500">{operatorNick}</span>
            <span> 禁言了{formatMuteDuration(duration)}</span>
          </div>
        );
      } else {
        return (
          <div className="text-center text-gray-500 text-xs py-2">
            <span className="text-blue-500">{operatorNick}</span>
            <span> 结束了 </span>
            <span className="text-blue-500">{targetNick}</span>
            <span> 的禁言</span>
          </div>
        );
      }
    } else {
      // 全员禁言
      return (
        <div className="text-center text-gray-500 text-xs py-2">
          <span className="text-blue-500">{operatorNick}</span>
          <span> {duration > 0 ? '开启' : '关闭'}了全员禁言</span>
        </div>
      );
    }
  }

  return null;
}
