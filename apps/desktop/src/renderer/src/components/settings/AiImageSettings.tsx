import { useState } from 'react';
import type { AiImageFeature, AiImageMode } from '@weq/agentlab';
import { isDefaultModelSelection } from '@weq/agentlab/model-selection';
import { trpc } from '../../trpc/client';
import { useTabActive } from '../RetainedTabs';
import { Row } from './controls';
import { ApiModelSelect } from './ApiModelSelect';

const featureLabels: Record<AiImageFeature, string> = {
  assistant: 'WeQ 助手',
  cloneChat: '克隆聊天',
  cloneTraining: '克隆训练',
  intent: '意图感知',
  suggestions: '推荐回复',
  profile: '互动画像',
};

export function AiImagePreferenceSetting({ feature }: { feature: AiImageFeature }) {
  const active = useTabActive();
  const settings = trpc.bootstrap.getSettings.useQuery(undefined, {
    enabled: active,
    staleTime: 0,
  });
  const save = trpc.bootstrap.setAiImagePreference.useMutation();
  const utils = trpc.useUtils();
  const [error, setError] = useState('');
  const required = feature === 'assistant' || feature === 'cloneChat';
  async function change(mode: AiImageMode) {
    setError('');
    try {
      await save.mutateAsync({ feature, mode });
      await utils.bootstrap.getSettings.invalidate();
      await utils.account.intentSense.getStatus.invalidate();
    } catch (error) {
      setError(error instanceof Error ? error.message : String(error));
    }
  }
  return (
    <>
      <Row
        settingId={`ai-images-${feature}`}
        label="图片处理偏好"
        desc={feature === 'cloneChat' ? '所有克隆体与连接本宿主的各端共用。' : undefined}
        control={
          <select
            aria-label={`${featureLabels[feature]} 图片处理偏好`}
            value={settings.data?.aiImages?.[feature] ?? (required ? 'vision' : 'placeholder')}
            disabled={!settings.data || save.isLoading}
            onChange={(event) => void change(event.target.value as AiImageMode)}
          >
            {!required ? <option value="placeholder">文字占位</option> : null}
            <option value="ocr">OCR</option>
            <option value="vision">视觉模型</option>
          </select>
        }
      />
      {error || settings.error ? <p role="alert">{error || settings.error?.message}</p> : null}
    </>
  );
}

export function DefaultVisionModelRow() {
  const active = useTabActive();
  const status = trpc.bootstrap.getDefaultVisionModel.useQuery(undefined, {
    enabled: active,
    staleTime: 0,
  });
  const save = trpc.bootstrap.setDefaultVisionModel.useMutation();
  const utils = trpc.useUtils();
  const [error, setError] = useState('');
  return (
    <>
      <Row
        settingId="llm-default-vision-model"
        label="默认视觉模型"
        control={
          <ApiModelSelect
            capability="vision"
            label="默认视觉模型"
            allowDefault={false}
            allowEmpty
            value={status.data?.ref ?? null}
            disabled={!status.data || save.isLoading}
            onChange={async (ref) => {
              if (isDefaultModelSelection(ref)) return;
              setError('');
              try {
                await save.mutateAsync({ ref });
                await Promise.all([
                  utils.bootstrap.getDefaultVisionModel.invalidate(),
                  utils.bootstrap.getSettings.invalidate(),
                  utils.account.intentSense.getStatus.invalidate(),
                ]);
              } catch (error) {
                setError(error instanceof Error ? error.message : String(error));
              }
            }}
          />
        }
      />
      {error || status.error || status.data?.error ? (
        <p role="alert">{error || status.error?.message || status.data?.error}</p>
      ) : null}
    </>
  );
}
