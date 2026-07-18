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

/**
 * True when this revoke gray-tip is a "placeholder empty message" — the row that
 * sits ABOVE a recall callback for a message whose content isn't in the local
 * DB (QQ backfills it on view). Its tell is an EMPTY `recallRevokeUid`: a real
 * recall tip always carries the revoker's uid, a placeholder does not.
 * Exported so the band wrapper (chatPane) can decide whether to show the
 * "本地暂无内容" hint for the whole run.
 */
export function isPlaceholderRevoke(element: { data?: { recallRevokeUid?: string } }): boolean {
  return !element.data?.recallRevokeUid;
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
  const { recallSenderUid, recallRevokeUid, recallSenderNick, recallRevokeNick, recallDisplayText } =
    element.data || {};

  const senderName = resolveUidNick(recallSenderUid, conversation) || recallSenderNick || '某成员';

  // Placeholder empty message: no revoker uid → the recalled message content
  // isn't in the local DB. Render "{sender} 撤回了一条消息" (sender resolved from
  // recallSenderUid). The surrounding band conveys the "no local content"
  // meaning via its liquid fill + hint, so we don't repeat it per-row.
  if (isPlaceholderRevoke({ data: { recallRevokeUid } })) {
    return (
      <div className="weq-graytip text-center text-xs py-2">
        <span className="weq-graytip-accent">{senderName}</span>
        <span className="px-1">撤回了一条消息</span>
      </div>
    );
  }

  // Real recall tip: compare by uid (robust vs nick), resolve both names.
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
