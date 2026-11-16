import {
  changePreference,
  preferenceValue,
  useClientPreferences,
} from '../../lib/clientPreferences';
import { trpc } from '../../trpc/client';
import { useTabActive } from '../RetainedTabs';
import { Row } from './controls';
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
      ['showGroupMemberLevel', 'group-message-level', '等级', true],
      ['showGroupMemberTitle', 'group-message-title', '头衔或身份', true],
      ['showGroupMemberName', 'group-message-name', '昵称或备注', true],
    ],
  },
  {
    label: '消息元数据',
    options: [
      ['showMessageSeq', 'message-seq', '消息序号（seq）', false],
      ['showMessageDate', 'message-date', '日期', false],
      ['showMessageTime', 'message-time', '时间', false],
    ],
  },
] as const;

export function MessageDisplayOptions() {
  const active = useTabActive();
  const settings = trpc.bootstrap.getSettings.useQuery(undefined, { enabled: active });
  useClientPreferences((state) => state.tick);
  return groups.map((group) => (
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
  ));
}
