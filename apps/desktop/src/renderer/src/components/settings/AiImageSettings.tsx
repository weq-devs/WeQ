import { useState } from 'react';
import type { AiImageFeature, AiImageMode } from '@weq/agentlab';
import { trpc } from '../../trpc/client';
import { useTabActive } from '../RetainedTabs';
import { Row } from './controls';
import { DefaultApiModelRow } from './DefaultApiModelRow';
import { SegmentedControl } from '../SegmentedControl';

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
          <SegmentedControl<AiImageMode>
            label={`${featureLabels[feature]} 图片处理偏好`}
            value={settings.data?.aiImages?.[feature] ?? (required ? 'vision' : 'placeholder')}
            disabled={!settings.data || save.isLoading}
            onChange={(mode) => void change(mode)}
            options={[
              ...(required
                ? []
                : [
                    {
                      value: 'placeholder' as const,
                      label: '文字占位',
                      title: '不识别图片内容，只显示占位文字',
                    },
                  ]),
              { value: 'ocr' as const, label: 'OCR', title: '识别图片里的文字' },
              { value: 'vision' as const, label: '视觉模型', title: '交给视觉模型理解图片' },
            ]}
          />
        }
      />
      {error || settings.error ? <p role="alert">{error || settings.error?.message}</p> : null}
    </>
  );
}

export function DefaultVisionModelRow() {
  return <DefaultApiModelRow capability="vision" />;
}
