import { ThumbsUp } from 'lucide-react';
import { useContactStats } from '../../hooks/useContactCard';
import { ProfileLikeAction } from './ProfileLikeAction';
import { ContactRow } from '../contactProfile/ContactRow';
import '../../styles/profile-like.css';

/** 与生日等资料共用行样式；累计获赞不代表当前账号今天还能发送的次数。 */
export function ProfileLikesRow({ uid, uin, name }: { uid: string; uin: string; name: string }) {
  const valid = /^u_[A-Za-z0-9_-]+$/.test(uid) && /^[1-9]\d{4,19}$/.test(uin);
  const stats = useContactStats(uin, uid, 'likeCount', valid);
  if (!valid) return null;
  const count = stats.data?.likeCount;
  if (count === null) return null;
  const value =
    typeof count === 'number' && Number.isSafeInteger(count) && count >= 0
      ? count.toLocaleString('zh-CN')
      : stats.isLoading
        ? '读取中…'
        : '暂不可用';
  return (
    <ContactRow label="获赞" icon={<ThumbsUp size={13} />} valueClassName="weq-profile-likes-row">
      <strong className="weq-number" title="资料卡累计获赞">
        {value}
      </strong>
      <ProfileLikeAction uid={uid} uin={uin} name={name} />
    </ContactRow>
  );
}
