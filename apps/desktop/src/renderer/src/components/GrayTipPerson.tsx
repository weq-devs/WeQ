import type { Conversation, Message, User } from '../im-template/template/types';
import { grayTipProfileTarget } from '../lib/grayTipProfile';
import { ProfileAvatar } from './ProfileAvatar';
import '../styles/gray-tip-profile.css';

export function GrayTipPerson({
  identities,
  name,
  conversation,
  message,
  user,
}: {
  identities: readonly unknown[];
  name: string;
  conversation?: Conversation;
  message?: Message;
  user?: User;
}) {
  if (!name) return null;
  return (
    <span className="weq-graytip-person weq-graytip-accent">
      <ProfileAvatar target={grayTipProfileTarget(identities, name, conversation, message, user)}>
        {name}
      </ProfileAvatar>
    </span>
  );
}
