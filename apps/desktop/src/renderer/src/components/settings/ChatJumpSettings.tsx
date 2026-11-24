import type { ChatJumpMode } from '@weq/service/client-preferences';
import {
  changePreference,
  preferenceValue,
  readingPositionJumpMode,
  useClientPreferences,
} from '../../lib/clientPreferences';
import { SegmentedControl } from '../SegmentedControl';
import { Row } from './controls';
import { SharedDisplayToggle } from './SharedDisplayToggle';

const options = [
  { value: 'off', label: '关闭' },
  { value: 'entry', label: '仅本次进入' },
  { value: 'keep', label: '切换后保留' },
] as const;
const separateModes = [
  ['firstUnreadJumpMode', 'first-unread-jump-mode', '首条未读'],
  ['importantJumpMode', 'important-jump-mode', '重要消息'],
] as const;
const readingMode = [
  'readingPositionJumpMode',
  'show-reading-position-button',
  '上次阅读位置',
] as const;
const combinedMode = [
  'combinedChatJumpMode',
  'combined-chat-jump-mode',
  '合并后的未读跳转',
] as const;

export function ChatJumpSettings({
  automaticReadingPosition,
}: {
  automaticReadingPosition: boolean;
}) {
  useClientPreferences((state) => state.tick);
  const merged = preferenceValue('mergeChatJumpButtons');
  const modes = merged ? [combinedMode] : [...separateModes];
  const visibleModes = automaticReadingPosition ? modes : [...modes, readingMode];
  return (
    <>
      <Row
        label="合并未读跳转按钮"
        settingId="merge-chat-jump-buttons"
        control={
          <span
            data-setting-fallback={
              merged ? separateModes.map(([, id]) => id).join(' ') : combinedMode[1]
            }
          >
            <SharedDisplayToggle name="mergeChatJumpButtons" label="合并未读跳转按钮" />
          </span>
        }
      />
      {visibleModes.map(([name, settingId, label]) => (
        <Row
          key={name}
          label={label}
          settingId={settingId}
          indent
          control={
            <SegmentedControl<ChatJumpMode>
              label={label}
              options={options}
              value={
                name === 'readingPositionJumpMode'
                  ? readingPositionJumpMode()
                  : preferenceValue(name)
              }
              onChange={(value) => void changePreference(name, value)}
            />
          }
        />
      ))}
    </>
  );
}
