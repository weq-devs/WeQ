import type { Conversation, Message, User } from '../im-template/template/types';
import { SELF_LABEL, isSelfIdentity, selfIdentityValues } from '../lib/selfIdentity';
import { displayUserName } from '../im-template/template/user';
import { GrayTipPerson } from './GrayTipPerson';

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
  user?: User;
}

export function GrayTipRevokeMessage({
  element,
  conversation,
  message,
  user,
}: GrayTipRevokeMessageProps) {
  const {
    recallSenderUid,
    recallRevokeUid,
    recallSenderNick,
    recallRevokeNick,
    recallDisplayText,
  } = element.data || {};

  const self = new Set(selfIdentityValues(user));
  const people =
    conversation?.type === 'group'
      ? conversation.members
      : conversation?.type === 'direct'
        ? [conversation.otherUser]
        : [];
  const candidates = message?.sender ? [...people, message.sender] : people;
  function resolve(uid?: string, nick?: string) {
    const value = uid?.trim() || '';
    if (isSelfIdentity(self, value)) return { identity: 'self', name: SELF_LABEL };
    const person = value
      ? candidates.find((person) => selfIdentityValues(person).includes(value))
      : undefined;
    if (person && selfIdentityValues(person).some((identity) => isSelfIdentity(self, identity)))
      return { identity: 'self', name: SELF_LABEL };
    return {
      identity: value ? person?.id || value : null,
      name: (person ? displayUserName(person) : '') || nick?.trim() || '某成员',
    };
  }
  const sender = resolve(recallSenderUid, recallSenderNick);
  const revoker = resolve(recallRevokeUid, recallRevokeNick);
  // 昵称和空字段都不是身份凭据，不能据此判定“自己撤回自己”。
  const knownPeople = sender.identity !== null && revoker.identity !== null;
  const samePerson = knownPeople && sender.identity === revoker.identity;

  return (
    <div className="weq-graytip text-center text-xs py-2">
      {samePerson || !knownPeople ? (
        <>
          <GrayTipPerson
            identities={[samePerson ? recallSenderUid : recallRevokeUid]}
            name={samePerson ? sender.name : revoker.name}
            conversation={conversation}
            message={message}
            user={user}
          />
          <span className="px-1">撤回了一条消息</span>
          {recallDisplayText && <span className="weq-graytip-muted">{recallDisplayText}</span>}
        </>
      ) : (
        <>
          <GrayTipPerson
            identities={[recallRevokeUid]}
            name={revoker.name}
            conversation={conversation}
            message={message}
            user={user}
          />
          <span className="px-1">
            {conversation?.type === 'group' ? '撤回了一条群成员' : '撤回了一条'}
          </span>
          <GrayTipPerson
            identities={[recallSenderUid]}
            name={sender.name}
            conversation={conversation}
            message={message}
            user={user}
          />
          <span className="px-1">的消息</span>
        </>
      )}
    </div>
  );
}
