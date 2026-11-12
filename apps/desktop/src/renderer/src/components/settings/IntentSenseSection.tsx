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
import { useViewState } from '../../state/view';
import '../../styles/intent-sense.css';

export function IntentSenseSection() {
  const settings = useAiFeatureSettings('意图感知');
  const hasAccount = Boolean(useViewState((state) => state.openedUin));
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
      error={status.error}
      retrying={status.isFetching}
      onRetry={() => void status.refetch()}
      basic={
        <>
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
          <Row
            settingId="intent-mode"
            label="模式"
            control={
              <SegmentedControl
                label="意图感知模式"
                value={s ? (s.analysisMode ?? 'auto') : null}
                disabled={disabled}
                onChange={(analysisMode) => void patch({ analysisMode })}
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
        <>
          <Row
            settingId="intent-engine"
            label="运行方式"
            control={
              <span
                data-setting-fallback={
                  s?.engine === 'local'
                    ? 'intent-api-model'
                    : s?.engine === 'api'
                      ? 'intent-model-resources'
                      : undefined
                }
              >
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
              </span>
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
          ) : null}
          {s?.engine === 'local' ? <IntentModelsSection /> : null}
        </>
      }
    >
      {(inactive) => (
        <>
          <Card
            title="显示方式"
            settingId="intent-advanced"
            icon={<Eye size={15} strokeWidth={1.8} />}
          >
            <Row
              settingId="intent-loading-animation"
              label="批量分析时显示胶囊动画"
              control={
                <Toggle
                  label="批量分析时显示胶囊动画"
                  checked={s?.loadingAnimation !== false}
                  indeterminate={!s}
                  disabled={disabled || inactive}
                  onChange={(loadingAnimation) => void patch({ loadingAnimation })}
                />
              }
            />
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
                  disabled={disabled || inactive || s?.analysisMode === 'manual'}
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
                  disabled={disabled || inactive || !hasAccount || clearCache.isLoading}
                  onClick={() => void onClearCache()}
                >
                  <RotateCcw size={14} />
                  <span>清空并重算</span>
                </button>
              }
            />
          </Card>
        </>
      )}
    </AiFeatureSettingsLayout>
  );
}
