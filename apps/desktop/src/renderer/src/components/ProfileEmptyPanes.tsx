import { Waypoints } from 'lucide-react';
import { EmptyState } from './EmptyState';
import '../styles/profile-empty.css';

/** 占位不引用资料正文，避免未选择联系人时加载整套名片功能。 */
export function ContactProfilePane({ onOpenOverview }: { onOpenOverview?: () => void }) {
  return (
    <section className="contact-profile-empty weq-contact-reserved">
      <EmptyState title="联系人" body="在左侧选择联系人，查看资料卡片。" />
      <ContactOverviewAction onOpen={onOpenOverview} />
    </section>
  );
}

export function GroupProfilePane({ onOpenOverview }: { onOpenOverview?: () => void }) {
  return (
    <section className="contact-profile-empty weq-contact-reserved">
      <EmptyState title="群聊" body="在左侧选择群聊，查看群资料。" />
      <ContactOverviewAction onOpen={onOpenOverview} />
    </section>
  );
}

function ContactOverviewAction({ onOpen }: { onOpen?: () => void }) {
  return onOpen ? (
    <button className="weq-profile-perhome" type="button" onClick={onOpen}>
      <Waypoints size={15} />
      群交集
    </button>
  ) : null;
}
