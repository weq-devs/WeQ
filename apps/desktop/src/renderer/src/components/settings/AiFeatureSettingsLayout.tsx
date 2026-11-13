import { BrainCircuit, Settings2 } from 'lucide-react';
import type { ReactNode } from 'react';
import { useTabActive } from '../RetainedTabs';
import { Card, QueryError, SectionHeader } from './controls';
import { AiFeatureSettingsContext, type useAiFeatureSettings } from './useAiFeatureSettings';
import '../../styles/model-settings.css';
import type { AiImageFeature } from '@weq/agentlab';
import { AiImagePreferenceSetting } from './AiImageSettings';

export function AiFeatureSettingsLayout({
  title,
  error,
  retrying,
  onRetry,
  basic,
  model,
  children,
  settings,
  imageFeature,
}: {
  title: string;
  error?: { message: string } | null;
  retrying?: boolean;
  onRetry: () => void;
  basic: ReactNode;
  model: ReactNode;
  children: (inactive: boolean) => ReactNode;
  settings: ReturnType<typeof useAiFeatureSettings>;
  imageFeature?: AiImageFeature;
}) {
  const active = useTabActive();
  return (
    <div className="weq-set">
      <SectionHeader title={title} icon={<BrainCircuit size={18} strokeWidth={1.8} />} />
      {error ? (
        <QueryError
          message={error.message}
          retryLabel={`重新读取${title}设置`}
          retrying={retrying}
          onRetry={onRetry}
        />
      ) : null}
      <Card title="功能与模型" icon={<Settings2 size={15} strokeWidth={1.8} />}>
        {basic}
        {model}
        {imageFeature ? <AiImagePreferenceSetting feature={imageFeature} /> : null}
      </Card>
      <AiFeatureSettingsContext.Provider value={settings}>
        {children(!active)}
      </AiFeatureSettingsContext.Provider>
    </div>
  );
}
