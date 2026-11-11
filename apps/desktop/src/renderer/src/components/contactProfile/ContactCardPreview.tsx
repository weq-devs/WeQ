import {
  CONTACT_CARD_FIELDS,
  CONTACT_GROUP_FIELDS,
  type ContactCardSettings,
} from '@weq/service/contact-card';
import { Avatar } from '../../im-template/template/primitives';
const samples: Record<string, string> = {
  signature: '把平常的小事认真记下来。',
  signatureUpdated: '2026/11/11 12:00',
  gender: '女',
  age: '23 岁',
  birthday: '5 月 12 日',
  constellation: '金牛座',
  region: '中国 · 福建 · 厦门',
  school: '示例大学 · 本科',
  labels: '阅读  摄影  音乐',
  status: '正在听音乐',
  common: '共同好友 3 · 共同群 2',
  category: '朋友',
  relations: '挚友',
  privileges: '超级会员',
  level: '32',
  qid: 'sample-person',
  company: '示例公司',
  groupLevel: 'Lv.8 · 活跃成员',
  joinedAt: '2024/09/01',
  lastSpeakAt: '2026/11/11',
  energy: '831',
  likes: '128',
  occupation: '设计师',
  zodiac: '马',
  bloodType: 'O 型',
  intimacy: '120',
  marks: '友谊的小船',
  uid: 'u_sample',
  description: '周末喜欢去海边拍照。',
  email: 'sample@example.invalid',
  friendClue: '我添加对方 · 群聊',
  notes: '我备注的公司 · 同学',
};
export function ContactCardPreview({ settings }: { settings: ContactCardSettings }) {
  return (
    <section className="weq-contact-card-preview" aria-label="名片预览">
      <div className="weq-profile-hero">
        <span className="weq-profile-avatar">
          <Avatar name="示例联系人" seed="sample" avatarUrl={null} />
        </span>
        <strong className="weq-profile-name">示例联系人</strong>
        <span>好友 · QQ 10002</span>
        <small>备注 小林</small>
      </div>
      <div className="weq-profile-list">
        {[...settings.order, ...settings.groupOrder]
          .filter((key) => settings.visible[key] && Boolean(samples[key]))
          .map((key) => {
            const label = [...CONTACT_CARD_FIELDS, ...CONTACT_GROUP_FIELDS].find(
              ([id]) => id === key,
            )?.[1];
            return (
              <div key={key} className="weq-profile-row">
                <span className="weq-profile-row-label">{label}</span>
                <span className="weq-profile-row-value">{samples[key]}</span>
              </div>
            );
          })}
      </div>
      <button type="button" disabled className="weq-profile-perhome">
        查看消息
      </button>
    </section>
  );
}
