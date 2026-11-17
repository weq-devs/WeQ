import { EmptyState } from './EmptyState';
import '../styles/profile-empty.css';

/** 占位不引用资料正文，避免未选择联系人时加载整套名片功能。 */
export function ContactProfilePane() {
  return (
    <section className="contact-profile-empty weq-contact-reserved">
      <EmptyState title="联系人" body="在左侧选择联系人，查看资料卡片。" />
    </section>
  );
}

export function GroupProfilePane() {
  return (
    <section className="contact-profile-empty weq-contact-reserved">
      <EmptyState title="群聊" body="在左侧选择群聊，查看群资料。" />
    </section>
  );
}
