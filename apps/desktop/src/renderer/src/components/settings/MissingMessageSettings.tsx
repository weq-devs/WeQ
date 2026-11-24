import {
  changePreference,
  preferenceValue,
  useClientPreferences,
} from '../../lib/clientPreferences';
import { AutoSave } from './AutoSave';
import { Row, Toggle } from './controls';
import { useNumericSettingDraft } from './useNumericSettingDraft';

export function MissingMessageSettings() {
  const ready = useClientPreferences((state) => state.ready);
  useClientPreferences((state) => state.tick);
  const automatic = preferenceValue('autoFetchMissingMessages');
  const context = preferenceValue('autoFetchMissingContext');
  const count = preferenceValue('missingMessageContextCount');
  const [draft, setDraft] = useNumericSettingDraft(
    'missing-context-count',
    ready ? count : undefined,
    count,
  );
  const value = draft.trim() ? Number(draft) : '';
  const valid = typeof value === 'number' && Number.isInteger(value) && value >= 1 && value <= 500;
  return (
    <>
      <Row
        settingId="auto-fetch-missing-messages"
        control={
          <span
            data-setting-fallback={
              automatic ? 'auto-fetch-missing-context missing-message-context-count' : undefined
            }
          >
            <Toggle
              label="看到缺口时自动补全"
              checked={automatic}
              disabled={!ready}
              onChange={(value) => void changePreference('autoFetchMissingMessages', value)}
            />
          </span>
        }
      />
      {!automatic ? (
        <>
          <Row
            settingId="auto-fetch-missing-context"
            control={
              <span data-setting-fallback={!context ? 'missing-message-context-count' : undefined}>
                <Toggle
                  label="跳转到缺失消息时补全附近记录"
                  checked={context}
                  disabled={!ready}
                  onChange={(value) => void changePreference('autoFetchMissingContext', value)}
                />
              </span>
            }
          />
          {context ? (
            <Row
              settingId="missing-message-context-count"
              indent
              desc="目标前后的总条数，不含目标本身。"
              control={
                <AutoSave
                  value={value}
                  saved={count}
                  ready={ready}
                  valid={valid}
                  save={async (value) => {
                    if (!(await changePreference('missingMessageContextCount', Number(value))))
                      throw new Error('上下文条数未保存，请重试');
                  }}
                  reset={() => setDraft(String(count))}
                >
                  <input
                    className="weq-set-input weq-set-input-sm"
                    type="number"
                    min={1}
                    max={500}
                    step={1}
                    value={draft}
                    aria-label="补全附近消息的条数"
                    aria-invalid={!valid}
                    disabled={!ready}
                    onChange={(event) => setDraft(event.target.value)}
                  />
                </AutoSave>
              }
            />
          ) : null}
        </>
      ) : null}
    </>
  );
}
