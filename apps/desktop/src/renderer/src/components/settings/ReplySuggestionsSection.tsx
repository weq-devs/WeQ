import { Card, Row, Toggle } from './controls';
import { ApiModelRow } from './ApiModelSelect';
import { AiFeatureSettingsLayout } from './AiFeatureSettingsLayout';
import { IntentTuningPanel } from './IntentTuningPanel';
import { useAiFeatureSettings } from './useAiFeatureSettings';

export function ReplySuggestionsSection() {
  const settings = useAiFeatureSettings('推荐回复');
  const { status, disabled, patch } = settings;
  const s = status.data;
  return (
    <AiFeatureSettingsLayout
      settings={settings}
      title="推荐回复"
      advancedId="suggestions-advanced"
      error={status.error}
      retrying={status.isFetching}
      onRetry={() => void status.refetch()}
      basic={
        <Row
          settingId="suggestions-enabled"
          label="启用推荐回复"
          desc="候选只会填入草稿，不会自动发送。"
          control={
            <Toggle
              label="启用推荐回复"
              checked={s?.suggestionsEnabled ?? false}
              disabled={disabled}
              onChange={(suggestionsEnabled) => void patch({ suggestionsEnabled })}
            />
          }
        />
      }
      model={
        <>
          <ApiModelRow
            settingId="suggestions-model"
            label="推荐回复 API 模型"
            value={s?.suggestionProviderRef ?? null}
            disabled={disabled}
            lastError={s?.lastSuggestionApiError}
            onChange={(suggestionProviderRef) => void patch({ suggestionProviderRef })}
          />
          <p className="weq-set-note">未选择 API 模型或调用不可用时，仅提供规则候选。</p>
        </>
      }
    >
      {(inactive) => (
        <>
          <Card title="触发方式">
            <Row
              settingId="suggestions-after-self"
              label="自己发送后推荐回复"
              control={
                <Toggle
                  label="自己发送后推荐回复"
                  checked={s?.suggestAfterSelf === true}
                  disabled={disabled || inactive}
                  onChange={(suggestAfterSelf) => void patch({ suggestAfterSelf })}
                />
              }
            />
          </Card>
          <IntentTuningPanel group="suggestions" />
        </>
      )}
    </AiFeatureSettingsLayout>
  );
}
