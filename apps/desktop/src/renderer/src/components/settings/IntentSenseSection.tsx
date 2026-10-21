/**
 * 设置 → 模型与识别 → 意图感知。
 *
 * 只管**全局**配置（按账号落盘在 `intent_sense/<configId>/config.json`）：
 *   • 总开关（乐观写：服务层落盘后立即返回期望状态，直接写查询缓存）。
 *   • 引擎选择：API（复用 agentlab provider，下拉选 provider + 模型）或
 *     本地模型（Laya / QWeQ-NineBird ONNX，~600MB 按需下载，支持 hf-mirror 镜像；
 *     下载完成可拉起 worker —— 状态实时反映在 localAvailable/engineReady）。
 *   • 回复建议开关（API 生成／本地意图候选）与两套独立上文条数。
 *   • 分析缓存清理。
 *
 * 单会话粒度的开关在会话头部的「会话设置」里（ConversationSettingsDialog）。
 */

import { useEffect, useState, type ReactElement } from 'react';
import { BrainCircuit, RotateCcw, Save } from 'lucide-react';
import {
  DEFAULT_ANALYSIS_CONTEXT_MESSAGES,
  DEFAULT_SUGGESTION_CONTEXT_MESSAGES,
  MAX_INTENT_CONTEXT_MESSAGES,
  isIntentContextCount,
} from '@weq/service/intent-context';
import { trpc } from '../../trpc/client';
import { useDialog } from '../Dialog';
import { Card, Row, SectionHeader, Toggle } from './controls';
import '../../styles/intent-sense.css';

interface ProviderModelWire {
  id: string;
  label?: string;
  capabilities?: string[];
}

interface ProviderWire {
  id: string;
  name: string;
  baseUrl: string;
  models: ProviderModelWire[];
}

interface StatusWire {
  enabled: boolean;
  engine: 'api' | 'local';
  providerRef: { providerId: string; model: string } | null;
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

export function IntentSenseSection(): ReactElement {
  const showError = useDialog((s) => s.showError);
  const utils = trpc.useUtils();

  const status = trpc.account.intentSense.getStatus.useQuery(undefined, {
    refetchOnWindowFocus: false,
    staleTime: 0,
    refetchOnMount: 'always',
  });
  // provider 目录走独立的 listAgentLabProviders：设置 → 模型配置保存后会 invalidate
  // 它，而 getSettings 不会 —— 用后者会出现「刚加的 provider 在这里看不到」。
  const providers = trpc.bootstrap.listAgentLabProviders.useQuery(undefined, {
    refetchOnWindowFocus: false,
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
  const providerList = ((providers.data ?? []) as ProviderWire[]).filter(
    (p) => p.models.length > 0,
  );
  const local = localEngine.data as LocalEngineWire | undefined;
  const savedAnalysis = s?.analysisContextMessages ?? DEFAULT_ANALYSIS_CONTEXT_MESSAGES;
  const savedSuggestion = s?.suggestionContextMessages ?? DEFAULT_SUGGESTION_CONTEXT_MESSAGES;
  const contextReady =
    isIntentContextCount(s?.analysisContextMessages) &&
    isIntentContextCount(s?.suggestionContextMessages);
  const [analysisCount, setAnalysisCount] = useState(String(savedAnalysis));
  const [suggestionCount, setSuggestionCount] = useState(String(savedSuggestion));
  useEffect(() => {
    if (!contextReady) return;
    setAnalysisCount(String(savedAnalysis));
    setSuggestionCount(String(savedSuggestion));
  }, [contextReady, savedAnalysis, savedSuggestion]);
  const analysisNumber = Number(analysisCount);
  const suggestionNumber = Number(suggestionCount);
  const contextValid =
    analysisCount.trim() !== '' &&
    suggestionCount.trim() !== '' &&
    isIntentContextCount(analysisNumber) &&
    isIntentContextCount(suggestionNumber);
  const contextDirty = analysisNumber !== savedAnalysis || suggestionNumber !== savedSuggestion;

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

  return (
    <div className="weq-set">
      <SectionHeader
        icon={<BrainCircuit size={18} strokeWidth={1.8} />}
        title="意图感知"
        desc="逐条分析消息的意图与情绪，并聚合成对方的互动画像（好感度 / MBTI / 互动风格）。推断结果仅供娱乐参考；API 引擎会把消息文本发送给你配置的服务商，本地引擎完全离线。单会话的开关在会话头部的「会话设置」里。"
      />

      <Card title="基础">
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
        <Row
          label="回复建议"
          desc={
            s?.engine === 'api'
              ? '在输入框上方生成 3 条候选回复（API 生成，离线时自动回落本地意图候选）。'
              : '基于对方最新消息的意图与情绪，在输入框上方推荐 3 条候选回复。'
          }
          control={
            <Toggle
              checked={!!s?.suggestionsEnabled}
              disabled={
                status.isLoading ||
                !s?.enabled ||
                (s?.engine === 'api' ? !s?.apiConfigured : !local?.modelDownloaded)
              }
              onChange={(next) => void patch({ suggestionsEnabled: next })}
              label="回复建议"
            />
          }
        />
        <Row
          label="自己发送后分析"
          control={
            <Toggle
              label="自己发送后分析"
              checked={s?.analyzeAfterSelf !== false}
              disabled={status.isLoading || setConfig.isLoading}
              onChange={(next) => void patch({ analyzeAfterSelf: next })}
            />
          }
        />
        <Row
          label="自己发送后推荐回复"
          control={
            <Toggle
              label="自己发送后推荐回复"
              checked={s?.suggestAfterSelf === true}
              disabled={status.isLoading || setConfig.isLoading}
              onChange={(next) => void patch({ suggestAfterSelf: next })}
            />
          }
        />
        <Row
          label="分析缓存"
          desc={clearedHint ?? '切换引擎或更新模型后，可一键清空历史分析缓存并重新识别。'}
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
      </Card>

      <Card title="上文范围">
        <form
          onSubmit={(event) => {
            event.preventDefault();
            if (!contextReady || !contextValid || !contextDirty || setConfig.isLoading) return;
            void patch({
              analysisContextMessages: analysisNumber,
              suggestionContextMessages: suggestionNumber,
            });
          }}
        >
          <Row
            label="意图分析上文（条）"
            desc={`0–${MAX_INTENT_CONTEXT_MESSAGES} 条，不含当前消息；仍受对话时效窗口限制。`}
            control={
              <input
                type="number"
                className="weq-set-input"
                aria-label="意图分析上文条数"
                min={0}
                max={MAX_INTENT_CONTEXT_MESSAGES}
                step={1}
                required
                value={analysisCount}
                disabled={!contextReady || setConfig.isLoading}
                onChange={(event) => setAnalysisCount(event.target.value)}
                style={{ width: 96 }}
              />
            }
          />
          <Row
            label="推荐回复上文（条）"
            desc={`0–${MAX_INTENT_CONTEXT_MESSAGES} 条，不含最新消息；0 表示仅使用最新消息。`}
            control={
              <input
                type="number"
                className="weq-set-input"
                aria-label="推荐回复上文条数"
                min={0}
                max={MAX_INTENT_CONTEXT_MESSAGES}
                step={1}
                required
                value={suggestionCount}
                disabled={!contextReady || setConfig.isLoading}
                onChange={(event) => setSuggestionCount(event.target.value)}
                style={{ width: 96 }}
              />
            }
          />
          <Row
            label={
              contextReady ? '上文设置' : status.isLoading ? '读取中…' : '当前主进程未加载上文设置'
            }
            control={
              <button
                type="submit"
                className="weq-set-btn"
                disabled={!contextReady || !contextValid || !contextDirty || setConfig.isLoading}
              >
                <Save size={14} />
                保存
              </button>
            }
          />
        </form>
      </Card>

      <Card title="引擎">
        <Row
          label="API（OpenAI 兼容）"
          desc="引用「API 与用量 → API 配置」中的服务商与模型。"
          control={
            <Toggle
              checked={s?.engine === 'api'}
              disabled={status.isLoading}
              onChange={() => void patch({ engine: 'api' })}
              label="使用 API 引擎"
            />
          }
        />
        {s?.engine === 'api' ? (
          <Row
            label="Provider / 模型"
            desc={
              providerList.length === 0
                ? '尚未配置服务商，请到「API 与用量 → API 配置」添加。'
                : s.lastApiError
                  ? `最近一次 API 调用失败：${s.lastApiError}（请检查接口地址或网络连通性）`
                  : s.apiConfigured
                    ? undefined
                    : '当前选择不可用。'
            }
            control={
              <select
                className="weq-int-select"
                value={s.providerRef ? `${s.providerRef.providerId}::${s.providerRef.model}` : ''}
                disabled={providerList.length === 0}
                onChange={(e) => {
                  const [providerId, model] = e.target.value.split('::');
                  if (!providerId || !model) {
                    void patch({ providerRef: null });
                  } else {
                    void patch({ providerRef: { providerId, model } });
                  }
                }}
              >
                <option value="">未选择</option>
                {providerList.map((p) =>
                  p.models.map((m) => (
                    <option key={`${p.id}::${m.id}`} value={`${p.id}::${m.id}`}>
                      {p.name} · {m.label ?? m.id}
                    </option>
                  )),
                )}
              </select>
            }
          />
        ) : null}
        <Row
          label={
            local?.modelDir?.includes('QWeQ-NineBird')
              ? '本地模型（QWeQ-NineBird 自研微调 ONNX）'
              : '本地模型（Laya 多语言 ONNX）'
          }
          desc={
            local?.available === false
              ? '仅桌面版可用。'
              : local?.engineReady
                ? '本地模型已就绪（按需后台运行）。'
                : local?.modelDownloaded
                  ? '引用共享本地模型，分析时按需启动。'
                  : '尚未就绪，请到「本地模型 → 意图模型」管理资源。'
          }
          control={
            <Toggle
              checked={s?.engine === 'local'}
              disabled={status.isLoading || !local?.available || !local?.modelDownloaded}
              onChange={() => void patch({ engine: 'local' })}
              label="使用本地引擎"
            />
          }
          indent
        />
      </Card>

      <p className="weq-set-note">
        意图与画像均为模型推断，好感度 / MBTI 仅供娱乐参考；API
        引擎会把消息文本发送给你配置的服务商。
      </p>
    </div>
  );
}
