import { useContext, useId, useState } from 'react';
import { UsersRound, UserRound, X, RefreshCw } from 'lucide-react';
import { trpc } from '../../trpc/client';
import { useQQWriteSession } from '../../hooks/useQQWriteSession';
import { Modal } from '../Dialog';
import { withQQAccountScope } from './shared';
import { GroupAvatar } from '../exportAvatars';
import { GroupProfileDialog, ProfileRow } from '../../im-template/template/profilePanes';
import { ConversationDirectoryContext } from '../../lib/conversationDirectory';
import { avatarFromGroupCode } from '../../lib/avatarResolver';
import { sharedGroupConversation } from '../ark/groupShareCard';
import { ChatNavigationContext } from '../../lib/chatNavigation';
import '../../styles/common-relationships.css';

function CommonRelationshipsBody({ uin, onNavigate }: { uin: string; onNavigate?: () => void }) {
  const session = useQQWriteSession(`common-relationships:${uin}`, true);
  const directory = useContext(ConversationDirectoryContext);
  const openChat = useContext(ChatNavigationContext);
  const titleId = useId();
  const [open, setOpen] = useState(false);
  const [selectedCode, setSelectedCode] = useState<string | null>(null);
  const query = trpc.account.qqWrite.commonRelationships.useQuery(
    { ...session.binding!, target: uin },
    {
      enabled:
        session.available &&
        /^[1-9]\d{4,9}$/.test(uin) &&
        uin !== session.binding?.expectedAccountUin,
      retry: false,
      staleTime: 60000,
      refetchOnWindowFocus: false,
    },
  );
  const selected = query.data?.groups?.find((group) => group.groupCode === selectedCode);
  const known = directory?.real?.find(
    (conversation) => conversation.type === 'group' && conversation.id === selectedCode,
  );
  const conversation =
    known?.type === 'group'
      ? known
      : selected
        ? sharedGroupConversation({
            code: selected.groupCode,
            name: selected.name || selected.groupCode,
            avatar: avatarFromGroupCode(selected.groupCode) ?? '',
          })
        : undefined;
  if (uin === session.binding?.expectedAccountUin) return null;
  return (
    <>
      <ProfileRow
        icon={<UserRound size={13} />}
        label="共同好友"
        value={String(query.data?.friendCount ?? (query.isFetching ? '…' : '未知'))}
        mono
        action={
          query.error || query.data?.friendError || query.data?.groupError ? (
            <button
              className="weq-profile-row-copy"
              type="button"
              title="重新读取共同关系"
              aria-label="重新读取共同关系"
              disabled={query.isFetching}
              onClick={() => void query.refetch()}
            >
              <RefreshCw size={12} />
            </button>
          ) : undefined
        }
      />
      <div className="weq-profile-row">
        <span className="weq-profile-row-label">
          <UsersRound size={13} />
          共同群
        </span>
        <button
          type="button"
          className="weq-contact-value"
          disabled={!query.data?.groups}
          onClick={() => setOpen(true)}
          title="查看共同群列表"
          aria-label="查看共同群列表"
        >
          {String(query.data?.groups?.length ?? (query.isFetching ? '…' : '未知'))}
        </button>
      </div>
      {open && (
        <Modal
          centered
          width={420}
          title="共同群"
          labelledBy={titleId}
          onClose={() => {
            setOpen(false);
            setSelectedCode(null);
          }}
          className="weq-common-groups-dialog"
        >
          <header className="weq-common-groups-header">
            <h3 id={titleId}>
              共同群 <span className="weq-number">{query.data?.groups?.length ?? 0}</span>
            </h3>
            <button
              className="weq-common-groups-close"
              type="button"
              title="关闭"
              aria-label="关闭"
              onClick={() => {
                setOpen(false);
                setSelectedCode(null);
              }}
            >
              <X size={18} />
            </button>
          </header>
          {!query.data?.groups?.length && <p className="weq-common-groups-empty">暂无共同群</p>}
          <ul className="weq-common-groups-list">
            {query.data?.groups?.map((group) => (
              <li key={group.groupCode}>
                <button
                  type="button"
                  className="weq-common-group-avatar weq-common-group-target"
                  title={`查看 ${group.name || group.groupCode} 的群名片`}
                  aria-label={`查看 ${group.name || group.groupCode} 的群名片`}
                  onClick={() => setSelectedCode(group.groupCode)}
                >
                  <GroupAvatar code={group.groupCode} size={40} />
                  <span className="weq-common-group-info">
                    <strong title={group.name || group.groupCode}>
                      {group.name || group.groupCode}
                    </strong>
                    <small>
                      群号 <span className="weq-number">{group.groupCode}</span>
                    </small>
                  </span>
                </button>
              </li>
            ))}
          </ul>
          {selected && (
            <GroupProfileDialog
              key={selected.groupCode}
              conversation={conversation}
              detailsKnown={known?.type === 'group'}
              onClose={() => setSelectedCode(null)}
              onOpenChat={
                openChat && conversation
                  ? () => {
                      setSelectedCode(null);
                      setOpen(false);
                      onNavigate?.();
                      openChat({ kind: 'group', conversation });
                    }
                  : undefined
              }
            />
          )}
        </Modal>
      )}
    </>
  );
}
export const CommonRelationships = withQQAccountScope(CommonRelationshipsBody);
