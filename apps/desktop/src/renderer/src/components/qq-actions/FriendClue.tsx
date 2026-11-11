import { CalendarDays, ArrowLeftRight, MapPin, MessageSquare } from 'lucide-react';
import { useContext, useState } from 'react';
import { trpc } from '../../trpc/client';
import { useQQWriteSession } from '../../hooks/useQQWriteSession';
import { GroupProfileDialog, ProfileRow } from '../../im-template/template/profilePanes';
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
  const session = useQQWriteSession(`friend-clue-group:${code}`);
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
      <div className="weq-profile-row">
        <span className="weq-profile-row-label">
          <MapPin size={13} />
          添加来源
        </span>
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
      </div>
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
  const session = useQQWriteSession(`friend-clue:${uid}`);
  const enabled = session.available && /^u_[A-Za-z0-9_-]+$/.test(uid);
  const query = trpc.account.qqWrite.friendClue.useQuery(
    { ...session.binding!, uid },
    { enabled, retry: 2, retryDelay: 1000, staleTime: 60000, refetchOnWindowFocus: false },
  );
  const data = enabled && query.data?.uid === uid && !query.error ? query.data : null;
  const pending = query.isFetching;
  const empty = !session.available
    ? '暂不可读取'
    : pending
      ? '读取中'
      : query.error
        ? '读取失败'
        : '未知';
  return (
    <>
      <ProfileRow
        sensitive
        icon={<CalendarDays size={13} />}
        label="添加时间"
        value={
          data ? (data.addedAt === null ? '未知' : dateFormat.format(data.addedAt * 1000)) : empty
        }
      />
      {data && (
        <>
          <ProfileRow
            sensitive
            icon={<ArrowLeftRight size={13} />}
            label="添加方向"
            value={
              data.direction === 'outgoing'
                ? '我添加对方'
                : data.direction === 'incoming'
                  ? '对方添加我'
                  : '未知'
            }
          />
          {data.sourceGroupCode ? (
            <SourceGroup
              key={`${uid}:${data.sourceGroupCode}`}
              code={data.sourceGroupCode}
              source={data.source}
            />
          ) : (
            <ProfileRow
              sensitive
              icon={<MapPin size={13} />}
              label="添加来源"
              value={data.source || '未知'}
            />
          )}
          <div className="weq-profile-row">
            <span className="weq-profile-row-label">
              <MessageSquare size={13} />
              验证消息
            </span>
            <p className="weq-profile-row-text weq-friend-verification" data-privacy-sensitive>
              {data.verificationMessage === null
                ? '未知'
                : data.verificationMessage || '无验证消息'}
            </p>
          </div>
        </>
      )}
    </>
  );
}

export const FriendClue = withQQAccountScope(FriendClueBody);
