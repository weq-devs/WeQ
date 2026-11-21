import { BellDot } from 'lucide-react';
import {
  AGGREGATE_BADGE_SETTINGS,
  CONTACT_UNREAD_COUNT_LABEL,
  ENTRY_BADGE_SETTINGS,
} from '@weq/service/client-preferences';
import { Card, Row } from './controls';
import { SharedDisplayToggle } from './SharedDisplayToggle';
import { MailNotificationSettings } from './MailNotificationSettings';
import '../../styles/unread-badge-settings.css';

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

const entryBadgeGroups = {
  requests: ['showContactRequestBadge'],
  tasks: ['showTaskRunningBadge', 'showTaskResultBadge'],
  updates: ['showUpdateBadge'],
  announcements: ['showOfficialAnnouncementBadge'],
} as const satisfies Record<string, readonly (typeof ENTRY_BADGE_SETTINGS)[number][0][]>;

export function EntryBadgeRows({ kind }: { kind: keyof typeof entryBadgeGroups }) {
  const keys: readonly string[] = entryBadgeGroups[kind];
  return (
    <>
      {ENTRY_BADGE_SETTINGS.filter(([key]) => keys.includes(key)).map(([key, id, label]) => (
        <BadgeSettingRow
          key={key}
          name={key}
          settingId={id}
          label={label}
          desc={
            kind === 'requests' ? '在联系人导航及好友通知、群通知入口显示未读角标。' : undefined
          }
          fallback={true}
        />
      ))}
    </>
  );
}

function ContactBadgeRows() {
  return (
    <>
      <EntryBadgeRows kind="requests" />
      <BadgeSettingRow
        name="showContactUnreadCount"
        settingId="contact-unread-count"
        label={CONTACT_UNREAD_COUNT_LABEL}
        desc="在好友和群聊列表的对应会话旁显示未读消息数量。"
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
      <ConversationListBadgeRows />
      <h4 className="weq-badge-group-title">联系人页</h4>
      <ContactBadgeRows />
      <h4 className="weq-badge-group-title">菜单</h4>
      <EntryBadgeRows kind="tasks" />
      <EntryBadgeRows kind="updates" />
      <EntryBadgeRows kind="announcements" />
    </Card>
  );
}
