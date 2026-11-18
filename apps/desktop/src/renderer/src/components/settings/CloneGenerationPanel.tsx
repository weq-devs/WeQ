import { useState } from 'react';
import type { AgentLabModelSelection } from '@weq/agentlab/model-selection';
import { normalizeCloneGeneration, type AgentLabGenerationConfig } from '@weq/agentlab/generation';
import { Row, Toggle } from './controls';
import { ConversationModelSettings } from './ConversationModelSettings';
import { useCloneSettingsSection } from '../../views/agentlab/cloneSettingsDraft';

export function CloneGenerationPanel({
  persona,
}: {
  persona: {
    models?: { chat?: AgentLabModelSelection };
    generation?: AgentLabGenerationConfig;
  };
}) {
  const [model, setModel] = useState<AgentLabModelSelection>(
    persona.models?.chat ?? { useDefault: true },
  );
  const [generation, setGeneration] = useState<AgentLabGenerationConfig>(() =>
    normalizeCloneGeneration(persona.generation),
  );
  useCloneSettingsSection('chat-model', model, { chatModel: model });
  useCloneSettingsSection('generation', generation, { generation });

  const change = (patch: Partial<AgentLabGenerationConfig>) =>
    setGeneration((current) => ({ ...current, ...patch }));
  return (
    <ConversationModelSettings
      feature="cloneChat"
      model={model}
      effort={generation.reasoningEffort ?? 'off'}
      onModelChange={setModel}
      onEffortChange={(reasoningEffort) => change({ reasoningEffort })}
    >
      <Row
        label="检索训练样本"
        desc="按当前话题查找相关问答与表达风格。"
        control={
          <Toggle
            label="检索训练样本"
            checked={generation.useTrainingSamples !== false}
            onChange={(useTrainingSamples) => change({ useTrainingSamples })}
          />
        }
      />
      <Row
        label="引用长期记忆"
        desc="只影响生成回复，不改变已有记忆。"
        control={
          <Toggle
            label="引用长期记忆"
            checked={generation.useLongTermMemory !== false}
            onChange={(useLongTermMemory) => change({ useLongTermMemory })}
          />
        }
      />
    </ConversationModelSettings>
  );
}
