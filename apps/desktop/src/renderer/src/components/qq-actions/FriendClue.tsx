import {
  CalendarDays,
  ArrowLeftRight,
  MapPin,
  MessageSquare,
  RefreshCw,
  UsersRound,
} from 'lucide-react';
import { trpc } from '../../trpc/client';
import { useQQWriteSession } from '../../hooks/useQQWriteSession';
import { ProfileRow } from '../../im-template/template/profilePanes';
import { withQQAccountScope } from './shared';

const dateFormat = new Intl.DateTimeFormat('zh-CN', {
  timeZone: 'Asia/Shanghai',
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
});

function FriendClueBody({ uid }: { uid: string }) {
  const session = useQQWriteSession(`friend-clue:${uid}`);
  const enabled = session.available && /^u_[A-Za-z0-9_-]+$/.test(uid);
  const query = trpc.account.qqWrite.friendClue.useQuery(
    { ...session.binding!, uid },
    { enabled, retry: false, staleTime: 60000, refetchOnWindowFocus: false },
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
        action={
          <button
            type="button"
            className="weq-profile-row-copy"
            title="重新读取好友线索"
            aria-label="重新读取好友线索"
            disabled={!enabled || pending}
            onClick={() => void query.refetch()}
          >
            <RefreshCw size={12} />
          </button>
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
          <ProfileRow
            sensitive
            multiline
            icon={<MapPin size={13} />}
            label="添加来源"
            value={data.source || '未知'}
          />
          {data.sourceGroupCode && (
            <ProfileRow
              sensitive
              mono
              icon={<UsersRound size={13} />}
              label="来源群号"
              value={data.sourceGroupCode}
            />
          )}
          <ProfileRow
            sensitive
            multiline
            icon={<MessageSquare size={13} />}
            label="验证消息"
            value={
              data.verificationMessage === null ? '未知' : data.verificationMessage || '无验证消息'
            }
          />
        </>
      )}
    </>
  );
}

export const FriendClue = withQQAccountScope(FriendClueBody);
