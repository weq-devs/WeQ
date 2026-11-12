import { useContext, useState, type ReactNode } from 'react';
import { GroupProfileDialog } from '../im-template/template/profilePanes';
import { ConversationDirectoryContext } from '../lib/conversationDirectory';
import { sharedGroupConversation } from './ark/groupShareCard';
import '../styles/profile-avatar.css';
import '../styles/identity-links.css';

export function GroupProfileIdentity({
  code,
  name,
  avatarUrl,
  enabled = true,
  children,
}: {
  code: string;
  name: string;
  avatarUrl?: string | null;
  enabled?: boolean;
  children: ReactNode;
}) {
  const [anchor, setAnchor] = useState<HTMLButtonElement | null>(null);
  const directory = useContext(ConversationDirectoryContext);
  const known = directory?.real?.find((row) => row.type === 'group' && row.id === code);
  const conversation =
    known?.type === 'group'
      ? known
      : sharedGroupConversation({ code, name, avatar: avatarUrl || '' });
  if (!enabled || !/^[1-9]\d{0,19}$/.test(code))
    return <span className="weq-identity-link">{children}</span>;
  return (
    <>
      <button
        type="button"
        className="weq-profile-avatar-button weq-identity-link"
        aria-label={`查看 ${name || code} 的群名片`}
        title={`查看 ${name || code} 的群名片`}
        onClick={(event) => {
          event.stopPropagation();
          setAnchor(event.currentTarget);
        }}
      >
        {children}
      </button>
      {anchor ? (
        <GroupProfileDialog
          anchor={anchor}
          conversation={conversation}
          detailsKnown={known?.type === 'group'}
          onClose={() => setAnchor(null)}
        />
      ) : null}
    </>
  );
}
