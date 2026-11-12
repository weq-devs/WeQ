import { trpc } from '../../../trpc/client';
import { PROFILE_QUERY_OPTIONS, type ProfilePerson } from '../../../hooks/useContactCard';
import { useQQWriteSession } from '../../../hooks/useQQWriteSession';
import { ContactIdentity } from '../../contactProfile/ContactContent';
import { ContactContent } from '../../contactProfile/ContactContent';
import type { ContactCardSettings } from '@weq/service/contact-card';

/**
 * 设置页的实时预览：拿本人资料走**真实名片组件**渲染，不再伪造「示例联系人」。
 *
 * 数据来源固定为 `account.getSelfProfile`（当前登录账号），拿不到就显示骨架 + 一句说明，
 * 任何情况下都不虚构联系人、学校或 QQ 号。
 */
export function ContactCardPreview({ settings }: { settings: ContactCardSettings }) {
  const session = useQQWriteSession('contact-card-preview', true);
  const self = trpc.account.getSelfProfile.useQuery(undefined, {
    ...PROFILE_QUERY_OPTIONS,
    staleTime: 30_000,
    refetchOnWindowFocus: false,
  });
  const data = self.data;
  const uin = data?.uin ?? '';
  if (!data || !uin)
    return (
      <div className="weq-contact-preview-skeleton" role="status">
        <span className="weq-contact-preview-skeleton-avatar" aria-hidden />
        <span className="weq-contact-preview-skeleton-lines" aria-hidden>
          <i />
          <i />
        </span>
        <p>读取本人资料后在这里预览名片</p>
      </div>
    );
  const person: ProfilePerson = {
    id: data.uid || `self:${uin}`,
    uid: data.uid,
    identityLabel: 'QQ',
    identityValue: uin,
    username: data.nick || uin,
    displayName: data.nick || uin,
    nick: data.nick ?? '',
    remark: data.remark,
    avatarUrl: data.avatarUrl || null,
    signature: data.signature,
    gender: data.gender,
    age: data.age,
    birthYear: data.birthYear,
    birthMonth: data.birthMonth,
    birthDay: data.birthDay,
    qid: data.qid,
    customStatus:
      typeof data.customStatus === 'string' ? data.customStatus : (data.customStatus?.desc ?? ''),
    extInfo: data.extInfo,
    extRelation: data.extRelation,
    sigUpdateTime: data.sigUpdateTime,
    createdAt: '',
    kind: 'human',
  };
  return (
    <div
      className="weq-contact-card-preview weq-contact-preview-live"
      aria-label="名片预览（我的名片）"
      data-preview-uid={session.binding?.expectedAccountUin ?? uin}
    >
      <ContactIdentity person={person} settings={settings} />
      <ContactContent person={person} settings={settings} preview />
    </div>
  );
}
