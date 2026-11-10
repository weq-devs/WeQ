import { BrainCircuit } from 'lucide-react';
import { useState, type ReactNode } from 'react';
import { TabActivity, useTabActive } from '../RetainedTabs';
import { Card, QueryError, SectionHeader } from './controls';
import { AiFeatureSettingsContext, type useAiFeatureSettings } from './useAiFeatureSettings';
import '../../styles/model-settings.css';

export function AiFeatureSettingsLayout({
  title,
  advancedId,
  error,
  retrying,
  onRetry,
  basic,
  model,
  resources,
  children,
  settings,
}: {
  title: string;
  advancedId: string;
  error?: { message: string } | null;
  retrying?: boolean;
  onRetry: () => void;
  basic: ReactNode;
  model: ReactNode;
  resources?: ReactNode;
  children: (inactive: boolean) => ReactNode;
  settings: ReturnType<typeof useAiFeatureSettings>;
}) {
  const active = useTabActive();
  const [advancedOpen, setAdvancedOpen] = useState(false);
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
      <Card title="基础">{basic}</Card>
      <Card title="模型">{model}</Card>
      {resources}
      <details
        className="weq-model-advanced"
        data-snapshot-skip-details
        onToggle={(event) => setAdvancedOpen(event.currentTarget.open)}
      >
        <summary data-setting-id={advancedId}>高级设置</summary>
        <TabActivity active={active && advancedOpen}>
          <AiFeatureSettingsContext.Provider value={settings}>
            <div className="weq-ai-settings-advanced">{children(!active || !advancedOpen)}</div>
          </AiFeatureSettingsContext.Provider>
        </TabActivity>
      </details>
    </div>
  );
}
