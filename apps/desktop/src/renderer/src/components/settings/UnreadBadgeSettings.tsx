import { BellDot, Menu, PanelLeft } from 'lucide-react';
import {
  AGGREGATE_BADGE_SETTINGS,
  CONTACT_NAVIGATION_BADGE_SETTING,
  CONTACT_REQUEST_BADGE_SETTING,
  CONTACT_UNREAD_COUNT_LABEL,
  MENU_BADGE_SETTINGS,
} from '@weq/service/client-preferences';
import { Card, Row, SectionHeader } from './controls';
import { SharedDisplayToggle } from './SharedDisplayToggle';
import { MailNotificationSettings } from './MailNotificationSettings';
import { SETTINGS_PAGE_LABELS } from './navigation';

export function BadgeSettingRow(
  props: Parameters<typeof SharedDisplayToggle>[0] & { settingId: string; desc?: string },
) {
  const { settingId, desc, ...toggle } = props;
  return (
    <Row
      settingId={settingId}
      label={toggle.label}
      desc={desc}
      control={<SharedDisplayToggle {...toggle} />}
    />
  );
}

export function ConversationListBadgeRows() {
  return (
    <>
      <BadgeSettingRow
        name="showInteractionBadge"
        settingId="conversation-interaction-badge"
        label="会话互动红点"
        desc="仅提示已读位置之后未查看的互动；有未读数字时优先显示数字。"
        fallback={false}
      />
      {AGGREGATE_BADGE_SETTINGS.map(([, key, id, label]) => (
        <BadgeSettingRow
          key={key}
          name={key}
          settingId={id}
          label={label}
          fallback={key !== 'showGroupAssistantMessageCount'}
        />
      ))}
    </>
  );
}

export function ContactAppearanceSettings() {
  const [name, settingId, label] = CONTACT_REQUEST_BADGE_SETTING;
  return (
    <div className="weq-set">
      <SectionHeader title={SETTINGS_PAGE_LABELS.contacts} page="contacts" />
      <Card icon={<BellDot size={15} strokeWidth={1.8} />} resetId="contact-badges">
        <BadgeSettingRow
          name={name}
          settingId={settingId}
          label={label}
          desc="在联系人页的好友通知和群通知入口显示未读角标。"
          fallback={true}
        />
        <BadgeSettingRow
          name="showContactUnreadCount"
          settingId="contact-unread-count"
          label={CONTACT_UNREAD_COUNT_LABEL}
          desc="在好友和群聊列表的对应会话旁显示未读消息数量。"
          fallback={false}
        />
      </Card>
    </div>
  );
}

export function MainNavigationSettings() {
  const [name, settingId, label] = CONTACT_NAVIGATION_BADGE_SETTING;
  return (
    <div className="weq-set">
      <SectionHeader title={SETTINGS_PAGE_LABELS['main-navigation']} page="main-navigation" />
      <Card icon={<PanelLeft size={15} strokeWidth={1.8} />} resetId="navigation-badges">
        <BadgeSettingRow
          name="showMessageUnreadBadge"
          settingId="message-unread-badge"
          label="消息导航未读角标"
          fallback={true}
        />
        <BadgeSettingRow
          name={name}
          settingId={settingId}
          label={label}
          desc="将联系人页的好友通知和群通知角标汇总到主导航。"
        />
        <MailNotificationSettings kind="unread" />
      </Card>
      <Card icon={<Menu size={15} strokeWidth={1.8} />} resetId="menu-badges">
        {MENU_BADGE_SETTINGS.map(([name, settingId, label]) => (
          <BadgeSettingRow key={name} name={name} settingId={settingId} label={label} fallback />
        ))}
      </Card>
    </div>
  );
}
