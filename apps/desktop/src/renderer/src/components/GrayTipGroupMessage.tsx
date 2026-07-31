import { TipGroupElementType } from '@weq/codec';
import type { Conversation, GroupMember, Message } from '../im-template/template/types';
import { displayUserName } from '../im-template/template/user';

interface GrayTipGroupMessageProps {
  element: {
    type: 'grayTipGroup';
    data?: {
      groupTipType?: number;
      user1Nick?: string;
      user1GroupNick?: string;
      user2Nick?: string;
      user2GroupNick?: string;
      groupTipGroupName?: string;
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

/** 灰条外壳，所有分支共用同一套居中样式。 */
function Tip({ children }: { children: React.ReactNode }) {
  return <div className="weq-graytip text-center text-gray-500 text-xs py-2">{children}</div>;
}

function Name({ children }: { children: React.ReactNode }) {
  return <span className="text-blue-500">{children}</span>;
}

export function GrayTipGroupMessage({ element, conversation, message }: GrayTipGroupMessageProps) {
  const {
    groupTipType,
    user1Nick,
    user1GroupNick,
    user2Nick,
    user2GroupNick,
    groupTipGroupName,
    muteInfo,
  } = element.data || {};
  const user1Display = user1GroupNick || user1Nick;
  const user2Display = user2GroupNick || user2Nick;

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

  switch (groupTipType) {
    case TipGroupElementType.KMEMBERADD:
      if (!user1Display) return null;
      return (
        <Tip>
          <Name>{user1Display}</Name>
          <span className="px-1">加入了群聊</span>
        </Tip>
      );

    case TipGroupElementType.KDISBANDED:
      return (
        <Tip>
          <span>该群已被群主解散</span>
        </Tip>
      );

    // 被移出群聊。user1/user2 都指向操作者，被移出的是本账号。
    case TipGroupElementType.KQUITTE:
      if (!user1Display) return null;
      return (
        <Tip>
          <Name>{user1Display}</Name>
          <span className="px-1">已将你移出群聊</span>
        </Tip>
      );

    case TipGroupElementType.KCREATED:
      return (
        <Tip>
          {user1Display ? <Name>{user1Display}</Name> : null}
          <span className="px-1">创建了群聊{groupTipGroupName ? ` ${groupTipGroupName}` : ''}</span>
        </Tip>
      );

    case TipGroupElementType.KGROUPNAMEMODIFIED:
      return (
        <Tip>
          {user1Display ? <Name>{user1Display}</Name> : null}
          <span className="px-1">修改群名为</span>
          <Name>{groupTipGroupName || '新群名'}</Name>
        </Tip>
      );

    case TipGroupElementType.KBLOCK:
    case TipGroupElementType.KUNBLOCK: {
      const action = groupTipType === TipGroupElementType.KBLOCK ? '加入了黑名单' : '移出了黑名单';
      return (
        <Tip>
          {user1Display ? <Name>{user1Display}</Name> : null}
          <span className="px-1">将</span>
          <Name>{user2Display || '某成员'}</Name>
          <span className="px-1">{action}</span>
        </Tip>
      );
    }

    // 禁言。操作者 / 被禁言者都在 muteInfo 里，duration=0 表示解除。
    case TipGroupElementType.KSHUTUP: {
      if (!muteInfo) return null;
      const duration = muteInfo.duration || 0;
      const operatorUid = muteInfo.operator?.uid;
      const operatorMember = operatorUid ? memberMap.get(operatorUid) : null;
      const operatorNick = operatorMember
        ? displayUserName(operatorMember)
        : user1GroupNick || operatorUid;

      const targetUid = muteInfo.mutedUser?.uid;
      const targetMember = targetUid ? memberMap.get(targetUid) : null;
      const targetNick =
        muteInfo.mutedUser?.groupNick ||
        (targetMember ? displayUserName(targetMember) : targetUid ? user2GroupNick : null);

      if (!targetNick) {
        return (
          <Tip>
            <Name>{operatorNick}</Name>
            <span> {duration > 0 ? '开启' : '关闭'}了全员禁言</span>
          </Tip>
        );
      }
      return duration > 0 ? (
        <Tip>
          <Name>{targetNick}</Name>
          <span> 被 </span>
          <Name>{operatorNick}</Name>
          <span> 禁言了{formatMuteDuration(duration)}</span>
        </Tip>
      ) : (
        <Tip>
          <Name>{operatorNick}</Name>
          <span> 结束了 </span>
          <Name>{targetNick}</Name>
          <span> 的禁言</span>
        </Tip>
      );
    }

    case TipGroupElementType.KBERECYCLED:
      return (
        <Tip>
          <span>该群因违规被回收</span>
        </Tip>
      );

    case TipGroupElementType.KDISBANDORBERECYCLED:
      return (
        <Tip>
          <span>该群已被解散或回收</span>
        </Tip>
      );

    default:
      return null;
  }
}
