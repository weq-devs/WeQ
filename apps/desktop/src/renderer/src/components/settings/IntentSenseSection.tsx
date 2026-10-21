/**
 * 设置 → 模型与识别 → 意图感知。
 *
 * 功能开关与 API 引用按账号保存，本地模型资源全局共享。
 * 重要开关和模型选择直接呈现，业务参数集中在底部高级设置。
 */

import { useState, type ReactElement } from 'react';
import { BrainCircuit, RotateCcw } from 'lucide-react';
import { trpc } from '../../trpc/client';
import { useDialog } from '../Dialog';
import { Card, Row, SectionHeader, Toggle } from './controls';
import { IntentModelsSection } from './IntentModelsSection';
import { ApiModelSelect } from './ApiModelSelect';
import { IntentTuningPanel } from './IntentTuningPanel';
import '../../styles/intent-sense.css';
import '../../styles/model-settings.css';

interface StatusWire {
  enabled: boolean;
  engine: 'api' | 'local';
  providerRef: { providerId: string; model: string } | null;
  suggestionProviderRef: { providerId: string; model: string } | null;
  suggestionApiConfigured: boolean;
  lastSuggestionApiError?: string | null;
  suggestionsEnabled: boolean;
  analyzeAfterSelf: boolean;
  suggestAfterSelf: boolean;
  analysisContextMessages: number;
  suggestionContextMessages: number;
  hfMirror: boolean;
  apiConfigured: boolean;
  localAvailable: boolean;
  localReady?: boolean;
  lastApiError?: string | null;
}

interface LocalEngineWire {
  available: boolean;
  modelDownloaded: boolean;
  engineReady: boolean;
  modelDir: string;
  downloading: boolean;
}

export function IntentSenseSection({
  page = 'intent',
}: {
  page?: 'intent' | 'suggestions';
}): ReactElement {
  const suggestionsPage = page === 'suggestions';
  const showError = useDialog((s) => s.showError);
  const utils = trpc.useUtils();

  const status = trpc.account.intentSense.getStatus.useQuery(undefined, {
    refetchOnWindowFocus: false,
    staleTime: 0,
    refetchOnMount: 'always',
  });
  const localEngine = trpc.bootstrap.getLocalEngine.useQuery(undefined, {
    refetchOnWindowFocus: false,
    staleTime: 0,
    refetchOnMount: 'always',
    // 引擎状态会因下载/启动变化，订阅进度时顺手刷新。
  });
  const [clearedHint, setClearedHint] = useState<string | null>(null);

  const setConfig = trpc.account.intentSense.setConfig.useMutation();
  const clearCache = trpc.account.intentSense.clearCache.useMutation();

  const s = status.data as StatusWire | undefined;
  const local = localEngine.data as LocalEngineWire | undefined;

  type ConfigPatch = Parameters<typeof setConfig.mutateAsync>[0];

  async function patch(input: ConfigPatch): Promise<void> {
    try {
      const next = await setConfig.mutateAsync(input);
      utils.account.intentSense.getStatus.setData(undefined, next);
      void utils.account.intentSense.listMessageAnalyses.invalidate();
      void utils.account.intentSense.getSuggestions.invalidate();
      void utils.account.intentSense.getProfile.invalidate();
    } catch (e) {
      showError('意图感知设置失败', e instanceof Error ? e.message : String(e));
      void status.refetch();
    }
  }

  async function onClearCache(): Promise<void> {
    try {
      const res = await clearCache.mutateAsync();
      setClearedHint(`已清除 (${res.clearedFiles} 个会话)`);
      void utils.account.intentSense.getStatus.invalidate();
      void utils.account.intentSense.listMessageAnalyses.invalidate();
      void utils.account.intentSense.getSuggestions.invalidate();
      void utils.account.intentSense.getProfile.invalidate();
    } catch (e) {
      showError('清空缓存失败', e instanceof Error ? e.message : String(e));
    }
  }

  const modelControls = !suggestionsPage ? (
    <>
      <Card title="意图感知模型">
        <Row
          label="运行方式"
          control={
            <select
              className="weq-set-input"
              aria-label="意图感知运行方式"
              value={s?.engine ?? 'api'}
              disabled={status.isLoading || setConfig.isLoading}
              onChange={(event) => {
                const engine = event.target.value;
                if (engine === 'api' || engine === 'local') void patch({ engine });
              }}
            >
              <option value="api">API 模型</option>
              <option value="local" disabled={!local?.available}>
                本地离线模型
              </option>
            </select>
          }
        />
        {s?.engine === 'api' ? (
          <Row
            label="服务商与模型"
            desc={s.lastApiError ? `最近调用失败：${s.lastApiError}` : undefined}
            control={
              <ApiModelSelect
                label="意图感知 API 模型"
                value={s.providerRef}
                disabled={setConfig.isLoading}
                onChange={(providerRef) => void patch({ providerRef })}
              />
            }
          />
        ) : null}
      </Card>
      {s?.engine === 'local' ? <IntentModelsSection embedded /> : null}
    </>
  ) : null;

  return (
    <div className="weq-set">
      <SectionHeader
        icon={<BrainCircuit size={18} strokeWidth={1.8} />}
        title={suggestionsPage ? '推荐回复' : '意图感知'}
        desc={
          suggestionsPage
            ? '生成式推荐使用所选 API，候选不会自动发送。'
            : 'API 模型会将消息文本发送至所选服务商；本地模型在本机运行。推断结果仅供参考。'
        }
      />

      <Card title="基础">
        {!suggestionsPage ? (
          <Row
            label="启用意图感知"
            desc="分析在本机完成（本地模型）或发送给你配置的 API（云端引擎）。"
            control={
              <Toggle
                checked={!!s?.enabled}
                disabled={status.isLoading || setConfig.isLoading}
                onChange={(next) => void patch({ enabled: next })}
                label="启用意图感知"
              />
            }
          />
        ) : null}
        {suggestionsPage ? (
          <Row
            label="回复建议"
            desc={`所选 API 最多生成 ${status.data?.suggestionCount ?? 3} 条候选；不可用时只保留规则候选，不使用本地模型生成文字。`}
            control={
              <Toggle
                checked={!!s?.suggestionsEnabled}
                disabled={status.isLoading || setConfig.isLoading}
                onChange={(next) => void patch({ suggestionsEnabled: next })}
                label="回复建议"
              />
            }
          />
        ) : null}
        {suggestionsPage ? (
          <Row
            label="推荐回复 API 模型"
            desc={
              s?.lastSuggestionApiError ? `最近调用失败：${s.lastSuggestionApiError}` : undefined
            }
            control={
              <ApiModelSelect
                label="推荐回复 API 模型"
                value={s?.suggestionProviderRef ?? null}
                disabled={status.isLoading || setConfig.isLoading}
                onChange={(suggestionProviderRef) => void patch({ suggestionProviderRef })}
                emptyLabel="未选择（仅规则候选）"
              />
            }
          />
        ) : null}
      </Card>

      {modelControls}
      <details className="weq-model-advanced">
        <summary>高级设置</summary>
        <Card title="触发与缓存">
          {suggestionsPage ? (
            <Row
              label="自己发送后推荐回复"
              control={
                <Toggle
                  label="自己发送后推荐回复"
                  checked={s?.suggestAfterSelf === true}
                  disabled={status.isLoading || setConfig.isLoading}
                  onChange={(suggestAfterSelf) => void patch({ suggestAfterSelf })}
                />
              }
            />
          ) : (
            <>
              <Row
                label="自己发送后分析"
                control={
                  <Toggle
                    label="自己发送后分析"
                    checked={s?.analyzeAfterSelf !== false}
                    disabled={status.isLoading || setConfig.isLoading}
                    onChange={(analyzeAfterSelf) => void patch({ analyzeAfterSelf })}
                  />
                }
              />
              <Row
                label="分析缓存"
                desc={clearedHint ?? undefined}
                control={
                  <button
                    type="button"
                    className="weq-int-download-btn"
                    disabled={clearCache.isLoading}
                    onClick={() => void onClearCache()}
                  >
                    <RotateCcw size={13} />
                    <span>清空并重算</span>
                  </button>
                }
              />
            </>
          )}
        </Card>

        <IntentTuningPanel group={suggestionsPage ? 'suggestions' : 'analysis'} />
        {!suggestionsPage ? <IntentTuningPanel group="advanced" /> : null}
        {!suggestionsPage && s?.engine === 'api' ? <IntentModelsSection embedded /> : null}
      </details>

      <p className="weq-set-note">
        意图与画像均为模型推断，好感度 / MBTI 仅供娱乐参考；API
        引擎会把消息文本发送给你配置的服务商。
      </p>
    </div>
  );
}
