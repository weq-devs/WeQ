import { MousePointerClick } from 'lucide-react';
import { SegmentedControl } from '../SegmentedControl';
import { Card, Row, Toggle } from './controls';
import { ApiModelRow } from './ApiModelSelect';
import { AiFeatureSettingsLayout } from './AiFeatureSettingsLayout';
import { IntentTuningPanel } from './IntentTuningPanel';
import { useAiFeatureSettings } from './useAiFeatureSettings';
import { SuggestionFallbackPanel } from './SuggestionFallbackPanel';

export function ReplySuggestionsSection() {
  const settings = useAiFeatureSettings('推荐回复');
  const { status, disabled, patch } = settings;
  const s = status.data;
  return (
    <AiFeatureSettingsLayout
      imageFeature="suggestions"
      settings={settings}
      title="推荐回复"
      error={status.error}
      retrying={status.isFetching}
      onRetry={() => void status.refetch()}
      basic={
        <>
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
          <Row
            settingId="suggestions-mode"
            label="模式"
            control={
              <SegmentedControl
                label="推荐回复模式"
                value={s ? (s.suggestionMode ?? 'auto') : null}
                disabled={disabled}
                onChange={(suggestionMode) => void patch({ suggestionMode })}
                options={[
                  { value: 'auto', label: '自动' },
                  { value: 'manual', label: '手动' },
                ]}
              />
            }
          />
        </>
      }
      model={
        <ApiModelRow
          settingId="suggestions-model"
          label="推荐回复 API 模型"
          value={s?.suggestionProviderRef ?? null}
          disabled={disabled}
          lastError={s?.lastSuggestionApiError}
          onChange={(suggestionProviderRef) => void patch({ suggestionProviderRef })}
        />
      }
    >
      {(inactive) => (
        <>
          <Card
            title="触发方式"
            settingId="suggestions-advanced"
            icon={<MousePointerClick size={15} strokeWidth={1.8} />}
          >
            <Row
              settingId="suggestions-after-self"
              label="自己发送后推荐回复"
              control={
                <Toggle
                  label="自己发送后推荐回复"
                  checked={s?.suggestAfterSelf === true}
                  disabled={disabled || inactive || s?.suggestionMode === 'manual'}
                  onChange={(suggestAfterSelf) => void patch({ suggestAfterSelf })}
                />
              }
            />
          </Card>
          <IntentTuningPanel
            group="suggestions"
            beforeCache={<SuggestionFallbackPanel settings={settings} />}
          />
        </>
      )}
    </AiFeatureSettingsLayout>
  );
}
