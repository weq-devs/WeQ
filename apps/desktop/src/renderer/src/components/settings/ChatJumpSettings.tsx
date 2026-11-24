import type { ChatJumpMode } from '@weq/service/client-preferences';
import { findSettingDefinition } from '@weq/service/settings-catalog';
import {
  changePreference,
  preferenceValue,
  readingPositionJumpMode,
  useClientPreferences,
} from '../../lib/clientPreferences';
import { useMobileWebLayout } from '../../hooks/useMobileWebViewport';
import { FormSelect } from '../FormSelect';
import { SegmentedControl } from '../SegmentedControl';
import { Row } from './controls';
import { SharedDisplayToggle } from './SharedDisplayToggle';

const options = [
  { value: 'off', label: '不显示' },
  { value: 'entry', label: '仅首次提示' },
  { value: 'keep', label: '切回后仍提示' },
] as const;
const separateModes = [
  ['firstUnreadJumpMode', 'first-unread-jump-mode'],
  ['importantJumpMode', 'important-jump-mode'],
] as const;
const readingMode = ['readingPositionJumpMode', 'show-reading-position-button'] as const;
const combinedMode = ['combinedChatJumpMode', 'combined-chat-jump-mode'] as const;
const mergeId = 'merge-chat-jump-buttons';

function ChatJumpModeRow({
  mode,
}: {
  mode: (typeof separateModes)[number] | typeof readingMode | typeof combinedMode;
}) {
  useClientPreferences((state) => state.tick);
  const compact = useMobileWebLayout();
  const [name, settingId] = mode;
  const label = findSettingDefinition(settingId)?.label ?? settingId;
  const value =
    name === 'readingPositionJumpMode' ? readingPositionJumpMode() : preferenceValue(name);
  const save = (next: ChatJumpMode) => void changePreference(name, next);
  return (
    <Row
      settingId={settingId}
      control={
        compact ? (
          <FormSelect
            className="weq-set-input weq-chat-jump-select"
            aria-label={label}
            value={value}
            onChange={(event) => {
              const option = options.find(({ value }) => value === event.target.value);
              if (option) save(option.value);
            }}
          >
            {options.map(({ value, label }) => (
              <option key={value} value={value}>
                {label}
              </option>
            ))}
          </FormSelect>
        ) : (
          <SegmentedControl<ChatJumpMode>
            label={label}
            options={options}
            value={value}
            onChange={save}
          />
        )
      }
    />
  );
}

export function ReadingPositionJumpSetting() {
  return <ChatJumpModeRow mode={readingMode} />;
}

export function ChatJumpSettings() {
  useClientPreferences((state) => state.tick);
  const merged = preferenceValue('mergeChatJumpButtons');
  const modes = merged ? [combinedMode] : [...separateModes];
  return (
    <>
      <Row
        settingId={mergeId}
        control={
          <span
            data-setting-fallback={
              merged ? separateModes.map(([, id]) => id).join(' ') : combinedMode[1]
            }
          >
            <SharedDisplayToggle
              name="mergeChatJumpButtons"
              label={findSettingDefinition(mergeId)?.label ?? mergeId}
            />
          </span>
        }
      />
      {modes.map((mode) => (
        <ChatJumpModeRow key={mode[0]} mode={mode} />
      ))}
    </>
  );
}
