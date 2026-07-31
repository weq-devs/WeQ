import type { Conversation, Message } from '../im-template/template/types';

interface GrayTipRevokeMessageProps {
  element: {
    type: 'grayTipRevoke';
    data?: {
      recallSenderUid?: string;
      recallRevokeUid?: string;
      recallSenderNick?: string;
      recallRevokeNick?: string;
      recallDisplayText?: string;
    };
  };
  /** Present in real chat (chatPane) so we can resolve uids → nicks. Absent in
   *  contexts that don't thread it through — we then fall back to nick fields. */
  conversation?: Conversation;
  message?: Message;
}

/** Resolve a `u_`-prefixed uid to a display nick via the conversation. */
function resolveUidNick(uid: string | undefined, conversation?: Conversation): string {
  if (!uid) return '';
  if (conversation?.type === 'group') {
    const member = conversation.members.find((m) => m.id === uid);
    if (member?.displayName) return member.displayName;
  }
  if (conversation?.type === 'direct' && conversation.otherUser) {
    const other = conversation.otherUser;
    if (other.id === uid || other.identityValue === uid) return other.displayName;
  }
  return '';
}

export function GrayTipRevokeMessage({ element, conversation }: GrayTipRevokeMessageProps) {
  const {
    recallSenderUid,
    recallRevokeUid,
    recallSenderNick,
    recallRevokeNick,
    recallDisplayText,
  } = element.data || {};

  const senderName = resolveUidNick(recallSenderUid, conversation) || recallSenderNick || '某成员';

  // Compare by uid (robust vs nick), resolve both names.
  const revokerName = resolveUidNick(recallRevokeUid, conversation) || recallRevokeNick || '管理员';
  const isSamePerson = recallSenderUid
    ? recallSenderUid === recallRevokeUid
    : recallSenderNick === recallRevokeNick;

  return (
    <div className="weq-graytip text-center text-xs py-2">
      {isSamePerson ? (
        <>
          <span className="weq-graytip-accent">{senderName}</span>
          <span className="px-1">撤回了一条消息</span>
          {recallDisplayText && <span className="weq-graytip-muted">{recallDisplayText}</span>}
        </>
      ) : (
        <>
          <span className="weq-graytip-accent">{revokerName}</span>
          <span className="px-1">撤回了一条群成员</span>
          <span className="weq-graytip-accent px-1">{senderName}</span>
          <span className="px-1">的消息</span>
        </>
      )}
    </div>
  );
}
