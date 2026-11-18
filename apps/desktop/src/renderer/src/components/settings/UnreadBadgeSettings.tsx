import { BellDot } from 'lucide-react';
import { AGGREGATE_BADGE_SETTINGS, ENTRY_BADGE_SETTINGS } from '@weq/service/client-preferences';
import { Card, Row } from './controls';
import { SharedDisplayToggle } from './SharedDisplayToggle';
import { MailNotificationSettings } from './MailNotificationSettings';
import '../../styles/unread-badge-settings.css';

export function BadgeSettingRow(
  props: Parameters<typeof SharedDisplayToggle>[0] & { settingId: string },
) {
  const { settingId, ...toggle } = props;
  return (
    <Row settingId={settingId} label={toggle.label} control={<SharedDisplayToggle {...toggle} />} />
  );
}

export function AggregateBadgeRows() {
  return (
    <>
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

export function EntryBadgeRows({ kind }: { kind: 'requests' | 'tasks' | 'updates' }) {
  return (
    <>
      {ENTRY_BADGE_SETTINGS.filter(([key]) =>
        kind === 'requests'
          ? key === 'showContactRequestBadge'
          : kind === 'updates'
            ? key === 'showUpdateBadge'
            : key === 'showTaskRunningBadge' || key === 'showTaskResultBadge',
      ).map(([key, id, label]) => (
        <BadgeSettingRow key={key} name={key} settingId={id} label={label} fallback={true} />
      ))}
    </>
  );
}

export function ContactBadgeRows() {
  return (
    <>
      <EntryBadgeRows kind="requests" />
      <BadgeSettingRow
        name="showContactUnreadCount"
        settingId="contact-unread-count"
        label="好友与群聊"
        fallback={false}
      />
    </>
  );
}

export function UnreadBadgeSettings() {
  return (
    <Card
      title="未读角标"
      icon={<BellDot size={15} />}
      resetId="notification-badges"
      settingId="notification-badges"
    >
      <h4 className="weq-badge-group-title">系统应用图标</h4>
      <BadgeSettingRow
        name="applicationBadge"
        settingId="application-unread-badge"
        label="应用图标未读角标"
        fallback={true}
      />
      <h4 className="weq-badge-group-title">主导航</h4>
      <BadgeSettingRow
        name="showMessageUnreadBadge"
        settingId="message-unread-badge"
        label="消息导航未读角标"
        fallback={true}
      />
      <MailNotificationSettings kind="unread" />
      <h4 className="weq-badge-group-title">会话列表常规视图</h4>
      <AggregateBadgeRows />
      <h4 className="weq-badge-group-title">联系人页</h4>
      <ContactBadgeRows />
      <h4 className="weq-badge-group-title">菜单</h4>
      <EntryBadgeRows kind="tasks" />
      <EntryBadgeRows kind="updates" />
    </Card>
  );
}
