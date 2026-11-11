import {
  occupationText,
  bloodTypeText,
  chineseZodiacText,
  profileTimeText,
} from '@weq/protocol/profile-values';
import { BriefcaseBusiness, Droplet, UserRound } from 'lucide-react';
import { ProfileRow } from '../im-template/template/profilePanes';
import type { ProfileExtInfo } from '../im-template/template/types';
import '../styles/profile-cache.css';

export function ProfileCacheFields({ extInfo }: { extInfo?: ProfileExtInfo | null }) {
  const fields = [
    { label: '职业', value: occupationText(extInfo?.occupation), Icon: BriefcaseBusiness },
    { label: '血型', value: bloodTypeText(extInfo?.bloodType), Icon: Droplet },
    { label: '生肖', value: chineseZodiacText(extInfo?.zodiac), Icon: UserRound },
  ];
  return fields.map(({ label, value, Icon }) =>
    value ? (
      <ProfileRow key={label} sensitive icon={<Icon size={13} />} label={label} value={value} />
    ) : null,
  );
}

export function SignatureUpdated({
  signature,
  sigUpdateTime,
}: {
  signature?: string | null;
  sigUpdateTime?: number;
}) {
  const time = signature?.trim() ? profileTimeText(sigUpdateTime) : null;
  return time ? (
    <small className="text-muted-foreground weq-signature-updated" data-privacy-sensitive>
      签名更新于 <time>{time}</time>
      <span>（北京时间）</span>
    </small>
  ) : null;
}
