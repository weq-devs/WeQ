import { useState } from 'react';
import type { AgentLabModelSelection } from '@weq/agentlab/model-selection';
import {
  CLONE_GENERATION,
  normalizeCloneGeneration,
  type AgentLabGenerationConfig,
} from '@weq/agentlab/generation';
import { Row, Toggle } from './controls';
import { ConversationModelSettings, LegacyModelOverrides } from './ConversationModelSettings';
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
  const [generation, setGeneration] = useState(() => normalizeCloneGeneration(persona.generation));
  useCloneSettingsSection('chat-model', model, { chatModel: model });
  useCloneSettingsSection('generation', generation, { generation });

  const change = (patch: Partial<AgentLabGenerationConfig>) =>
    setGeneration((current) => ({ ...current, ...patch }));
  const overrideLabels = [
    ...(generation.temperature === null ? [] : ['温度']),
    ...(generation.maxOutputTokens === 0 ? [] : ['输出上限']),
  ];

  return (
    <ConversationModelSettings
      feature="cloneChat"
      model={model}
      effort={generation.reasoningEffort ?? 'off'}
      onModelChange={setModel}
      onEffortChange={(reasoningEffort) => change({ reasoningEffort })}
      history={{
        value: generation.historyMessages,
        standard: CLONE_GENERATION.historyMessages.default,
        extended: 24,
        onChange: (historyMessages) => change({ historyMessages }),
      }}
    >
      <Row
        label="检索训练样本"
        desc="按当前话题查找相关问答与表达风格。"
        control={
          <Toggle
            label="检索训练样本"
            checked={generation.pairExamples > 0 || generation.expressionItems > 0}
            onChange={(on) =>
              change({
                pairExamples: on ? CLONE_GENERATION.pairExamples.default : 0,
                expressionItems: on ? CLONE_GENERATION.expressionItems.default : 0,
              })
            }
          />
        }
      />
      <Row
        label="引用长期记忆"
        desc="只影响生成回复，不改变已有记忆。"
        control={
          <Toggle
            label="引用长期记忆"
            checked={generation.memoryItems > 0}
            onChange={(on) =>
              change({ memoryItems: on ? CLONE_GENERATION.memoryItems.default : 0 })
            }
          />
        }
      />
      <LegacyModelOverrides
        fields={overrideLabels}
        onReset={() => change({ temperature: null, maxOutputTokens: 0 })}
      />
    </ConversationModelSettings>
  );
}
