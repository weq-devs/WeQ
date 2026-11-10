import { useState } from 'react';
import { Eye, MousePointerClick, RotateCcw, Database } from 'lucide-react';
import { trpc } from '../../trpc/client';
import { useDialog } from '../Dialog';
import { SegmentedControl } from '../SegmentedControl';
import { Card, Row, Toggle } from './controls';
import { IntentModelsSection } from './IntentModelsSection';
import { ApiModelRow } from './ApiModelSelect';
import { IntentTuningPanel } from './IntentTuningPanel';
import { AiFeatureSettingsLayout } from './AiFeatureSettingsLayout';
import { useAiFeatureSettings } from './useAiFeatureSettings';
import '../../styles/intent-sense.css';

export function IntentSenseSection() {
  const settings = useAiFeatureSettings('意图感知');
  const { active, status, disabled, patch, refreshResults } = settings;
  const s = status.data;
  const local = trpc.bootstrap.getLocalEngine.useQuery(undefined, {
    enabled: active,
    refetchOnWindowFocus: false,
    staleTime: 0,
    refetchOnMount: 'always',
  });
  const clearCache = trpc.account.intentSense.clearCache.useMutation();
  const utils = trpc.useUtils();
  const showError = useDialog((s) => s.showError);
  const [clearedHint, setClearedHint] = useState<string | null>(null);

  async function onClearCache() {
    try {
      const res = await clearCache.mutateAsync();
      setClearedHint(`已清除 (${res.clearedFiles} 个会话)`);
      void utils.account.intentSense.getStatus.invalidate();
      refreshResults();
    } catch (error) {
      showError('清空缓存失败', error instanceof Error ? error.message : String(error));
    }
  }

  return (
    <AiFeatureSettingsLayout
      settings={settings}
      title="意图感知"
      advancedId="intent-advanced"
      error={status.error}
      retrying={status.isFetching}
      onRetry={() => void status.refetch()}
      basic={
        <Row
          settingId="intent-enabled"
          label="启用意图感知"
          desc="分析聊天消息的意图与情绪。"
          control={
            <Toggle
              label="启用意图感知"
              checked={s?.enabled ?? false}
              indeterminate={!s}
              disabled={disabled}
              onChange={(enabled) => void patch({ enabled })}
            />
          }
        />
      }
      model={
        <>
          <Row
            settingId="intent-engine"
            label="运行方式"
            control={
              <SegmentedControl
                label="意图感知运行方式"
                value={s?.engine ?? null}
                disabled={disabled}
                onChange={(engine) => void patch({ engine })}
                options={[
                  { value: 'api', label: 'API 模型' },
                  { value: 'local', label: '本地模型', disabled: !local.data?.available },
                ]}
              />
            }
          />
          {s?.engine === 'api' ? (
            <ApiModelRow
              settingId="intent-api-model"
              label="意图感知 API 模型"
              value={s.providerRef}
              disabled={disabled}
              lastError={s.lastApiError}
              onChange={(providerRef) => void patch({ providerRef })}
            />
          ) : (
            <p className="weq-set-note" data-setting-id="intent-api-model">
              API 模型：{s ? '当前使用本地模型。' : '运行方式待确认。'}
            </p>
          )}
        </>
      }
      resources={
        s?.engine === 'local' ? (
          <IntentModelsSection embedded />
        ) : !s ? (
          <p className="weq-set-note" data-setting-id="intent-model-resources">
            尚未取得运行方式，本地模型资源状态待确认。
          </p>
        ) : null
      }
    >
      {(inactive) => (
        <>
          <Card title="显示方式" icon={<Eye size={15} strokeWidth={1.8} />}>
            <Row
              settingId="intent-persistent-display"
              label="常驻显示"
              control={
                <Toggle
                  label="常驻显示"
                  checked={s?.persistentDisplay !== false}
                  indeterminate={!s}
                  disabled={disabled || inactive}
                  onChange={(persistentDisplay) => void patch({ persistentDisplay })}
                />
              }
            />
            <Row
              settingId="intent-hover-display"
              label="悬停显示"
              control={
                <Toggle
                  label="悬停显示"
                  checked={s?.hoverDisplay !== false}
                  indeterminate={!s}
                  disabled={disabled || inactive}
                  onChange={(hoverDisplay) => void patch({ hoverDisplay })}
                />
              }
            />
          </Card>
          <Card title="触发方式" icon={<MousePointerClick size={15} strokeWidth={1.8} />}>
            <Row
              settingId="intent-after-self"
              label="自己发送后分析"
              control={
                <Toggle
                  label="自己发送后分析"
                  checked={s?.analyzeAfterSelf !== false}
                  indeterminate={!s}
                  disabled={disabled || inactive}
                  onChange={(analyzeAfterSelf) => void patch({ analyzeAfterSelf })}
                />
              }
            />
          </Card>
          <IntentTuningPanel group="analysis" />
          <IntentTuningPanel group="advanced" />
          <Card title="缓存管理" icon={<Database size={15} strokeWidth={1.8} />}>
            <Row
              settingId="intent-cache"
              label="意图与推荐缓存"
              desc={clearedHint ?? '清除当前账号的意图分析与推荐回复缓存，不影响互动画像。'}
              control={
                <button
                  type="button"
                  className="weq-set-btn"
                  disabled={disabled || inactive || clearCache.isLoading}
                  onClick={() => void onClearCache()}
                >
                  <RotateCcw size={14} />
                  <span>清空并重算</span>
                </button>
              }
            />
          </Card>
          {s?.engine === 'api' ? <IntentModelsSection embedded /> : null}
        </>
      )}
    </AiFeatureSettingsLayout>
  );
}
