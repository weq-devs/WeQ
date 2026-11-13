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
        label="查看时自动拉取缺失的消息"
        control={
          <Toggle
            label="查看时自动拉取缺失的消息"
            checked={automatic}
            disabled={!ready}
            onChange={(value) => void changePreference('autoFetchMissingMessages', value)}
          />
        }
      />
      {!automatic ? (
        <>
          <Row
            settingId="auto-fetch-missing-context"
            label="定位到缺失消息时自动拉取上下文"
            indent
            control={
              <Toggle
                label="定位到缺失消息时自动拉取上下文"
                checked={context}
                disabled={!ready}
                onChange={(value) => void changePreference('autoFetchMissingContext', value)}
              />
            }
          />
          {context ? (
            <Row
              settingId="missing-message-context-count"
              label="自动拉取上下文条数"
              indent
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
                    aria-label="自动拉取上下文条数"
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
