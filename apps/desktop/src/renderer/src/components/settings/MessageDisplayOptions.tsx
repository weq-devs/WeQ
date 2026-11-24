import { Monitor, UsersRound } from 'lucide-react';
import {
  changePreference,
  preferenceValue,
  useClientPreferences,
} from '../../lib/clientPreferences';
import { trpc } from '../../trpc/client';
import { useTabActive } from '../RetainedTabs.shared';
import { Card, Row } from './controls';
import { QqShowSettings } from './QqShowSettings';
import { SharedDisplayToggle } from './SharedDisplayToggle';
import '../../styles/message-display-settings.css';
import '../../styles/search-scope.css';

const groups = [
  {
    label: '个性装扮',
    options: [
      ['showAvatarPendant', 'avatar-pendant', '头像挂件', true],
      ['showMessageBubble', 'message-bubble', '消息气泡', true],
      ['showMessageFont', 'message-font', '消息字体', true],
    ],
  },
  {
    label: '群消息发送者',
    options: [
      ['showGroupMemberName', 'group-message-name', '昵称或备注', true],
      ['showGroupMemberLevel', 'group-message-level', '等级', true],
      ['showGroupMemberTitle', 'group-message-title', '头衔或身份', true],
    ],
  },
  {
    label: '消息元数据',
    options: [
      ['showMessageDate', 'message-date', '日期', false],
      ['showMessageTime', 'message-time', '时间', false],
      ['showMessageSeq', 'message-seq', '消息序号（seq）', false],
    ],
  },
] as const;

export function MessageDisplayOptions() {
  const active = useTabActive();
  const settings = trpc.bootstrap.getSettings.useQuery(undefined, { enabled: active });
  useClientPreferences((state) => state.tick);
  const renderGroup = (group: (typeof groups)[number]) => (
    <Row
      key={group.label}
      label={group.label}
      control={
        <div
          className="weq-search-scope weq-message-display-options"
          role="group"
          aria-label={group.label}
        >
          {group.options.map(([name, id, label, fallback]) => {
            const initial =
              name === 'showGroupMemberName' ||
              name === 'showGroupMemberLevel' ||
              name === 'showGroupMemberTitle'
                ? fallback
                : (settings.data?.[name] ??
                  (name === 'showMessageBubble' || name === 'showMessageFont'
                    ? (settings.data?.showMsgDecoration ?? fallback)
                    : fallback));
            const checked = preferenceValue(name, initial);
            return (
              <button
                key={name}
                type="button"
                data-setting-id={id}
                aria-pressed={checked}
                disabled={!settings.data}
                onClick={() => void changePreference(name, !checked)}
              >
                {label}
              </button>
            );
          })}
        </div>
      }
    />
  );
  return (
    <>
      <Card
        title="消息外观"
        icon={<Monitor size={15} />}
        settingId="custom-message-display"
        resetId="message-content"
      >
        <QqShowSettings />
        {renderGroup(groups[0])}
        <Row
          settingId="group-consecutive-messages"
          desc="同一人的连续发言只在组首显示头像和发送者信息。"
          control={<SharedDisplayToggle name="groupConsecutiveMessages" label="合并连续发言" />}
        />
      </Card>
      <Card title="发送者与消息信息" icon={<UsersRound size={15} />}>
        {renderGroup(groups[1])}
        {renderGroup(groups[2])}
      </Card>
    </>
  );
}
