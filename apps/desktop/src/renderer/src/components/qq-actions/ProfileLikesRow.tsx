import { ThumbsUp } from 'lucide-react';
import { trpc } from '../../trpc/client';
import { ProfileLikeAction } from './ProfileLikeAction';
import '../../styles/profile-like.css';

/** 与生日等资料共用行样式；累计获赞不代表当前账号今天还能发送的次数。 */
export function ProfileLikesRow({ uid, uin, name }: { uid: string; uin: string; name: string }) {
  const valid = /^u_[A-Za-z0-9_-]+$/.test(uid) && /^[1-9]\d{4,19}$/.test(uin);
  const stats = trpc.account.dressup.peerStats.useQuery(
    { uin, uid },
    { enabled: valid, retry: false, refetchOnWindowFocus: false, staleTime: 5 * 60_000 },
  );
  if (!valid) return null;
  const count = stats.data?.likeCount;
  const value =
    typeof count === 'number' && Number.isSafeInteger(count) && count >= 0
      ? count.toLocaleString('zh-CN')
      : stats.isLoading
        ? '读取中…'
        : '暂不可用';
  return (
    <div className="weq-profile-row weq-profile-likes-row">
      <span className="weq-profile-row-label">
        <ThumbsUp size={13} />
        获赞
      </span>
      <span className="weq-profile-row-value">
        <strong className="weq-number" title="资料卡累计获赞">
          {value}
        </strong>
        <ProfileLikeAction uid={uid} uin={uin} name={name} />
      </span>
    </div>
  );
}
