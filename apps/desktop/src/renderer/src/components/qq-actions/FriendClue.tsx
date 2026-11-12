import { useContext, useState } from 'react';
import { trpc } from '../../trpc/client';
import { useQQWriteSession } from '../../hooks/useQQWriteSession';
import { GroupProfileDialog } from '../../im-template/template/profilePanes';
import { ContactRow } from '../contactProfile/ContactRow';
import { ConversationDirectoryContext } from '../../lib/conversationDirectory';
import { avatarFromGroupCode } from '../../lib/avatarResolver';
import { GroupAvatar } from '../exportAvatars';
import { sharedGroupConversation } from '../ark/groupShareCard';
import { withQQAccountScope } from './shared';
import '../../styles/friend-clue.css';

const dateFormat = new Intl.DateTimeFormat('zh-CN', {
  timeZone: 'Asia/Shanghai',
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
  second: '2-digit',
  hourCycle: 'h23',
});

export function SourceGroup({
  code,
  source,
  directoryLink = false,
}: {
  code: string;
  source: string | null;
  directoryLink?: boolean;
}) {
  const session = useQQWriteSession(`friend-clue-group:${code}`, true);
  const directory = useContext(ConversationDirectoryContext);
  const [anchor, setAnchor] = useState<HTMLButtonElement | null>(null);
  const groupId = Number(code);
  const query = trpc.account.qqActions.groupJoinSettings.useQuery(
    { ...session.binding!, groupId },
    {
      enabled:
        Boolean(anchor) &&
        session.available &&
        Number.isInteger(groupId) &&
        groupId > 0 &&
        groupId <= 0xffffffff,
      retry: 2,
      retryDelay: 1000,
      staleTime: 60000,
      refetchOnWindowFocus: false,
    },
  );
  const info = !query.error && query.data?.groupId === groupId ? query.data : null;
  const known = directory?.real?.find((item) => item.type === 'group' && item.id === code);
  const name = info?.name || (known?.type === 'group' ? known.group.name : null);
  const label = directoryLink ? name || code : source || '未知';
  const conversation =
    known?.type === 'group'
      ? { ...known, group: { ...known.group, name: name || code } }
      : sharedGroupConversation({
          code,
          name: name || code,
          avatar: avatarFromGroupCode(code) ?? '',
        });
  if (info) {
    conversation.group.memberCount = info.memberCount ?? conversation.group.memberCount;
    conversation.group.maxMemberCount = info.maxMemberCount ?? conversation.group.maxMemberCount;
  }
  return (
    <>
      <ContactRow label="添加来源" historyField="sourceGroup">
        <button
          className="weq-friend-source-group"
          type="button"
          title="查看来源群名片"
          aria-label="查看来源群名片"
          data-privacy-sensitive
          onClick={(event) => setAnchor(event.currentTarget)}
        >
          <GroupAvatar code={code} size={24} />
          <span title={label}>{label}</span>
        </button>
      </ContactRow>
      {anchor && (
        <GroupProfileDialog
          conversation={conversation}
          anchor={anchor}
          detailsKnown={known?.type === 'group'}
          memberCountKnown={info?.memberCount != null || known?.type === 'group'}
          onClose={() => setAnchor(null)}
        />
      )}
    </>
  );
}

function FriendClueBody({ uid }: { uid: string }) {
  const session = useQQWriteSession(`friend-clue:${uid}`, true);
  const enabled = session.available && /^u_[A-Za-z0-9_-]+$/.test(uid);
  const query = trpc.account.qqWrite.friendClue.useQuery(
    { ...session.binding!, uid },
    { enabled, retry: 2, retryDelay: 1000, staleTime: 60000, refetchOnWindowFocus: false },
  );
  const data = query.data?.uid === uid ? query.data : null;
  const pending = query.isFetching;
  const empty = !session.available
    ? '暂不可读取'
    : pending
      ? '读取中'
      : query.error
        ? '读取失败'
        : null;
  return (
    <>
      <ContactRow
        label="添加时间"
        value={
          data ? (data.addedAt === null ? null : dateFormat.format(data.addedAt * 1000)) : empty
        }
      />
      {data && (
        <>
          <ContactRow
            label="添加方向"
            value={
              data.direction === 'outgoing'
                ? '我添加对方'
                : data.direction === 'incoming'
                  ? '对方添加我'
                  : null
            }
          />
          {data.sourceGroupCode ? (
            <SourceGroup
              key={`${uid}:${data.sourceGroupCode}`}
              code={data.sourceGroupCode}
              source={data.source}
            />
          ) : (
            <ContactRow label="添加来源" value={data.source} />
          )}
          <ContactRow label="验证消息" value={data.verificationMessage} />
        </>
      )}
    </>
  );
}

export const FriendClue = withQQAccountScope(FriendClueBody);
