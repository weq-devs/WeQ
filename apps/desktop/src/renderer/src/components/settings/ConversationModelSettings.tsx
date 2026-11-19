import { FormSelect } from '../FormSelect';
import type { ReactNode } from 'react';
import type { AgentLabModelSelection } from '@weq/agentlab/model-selection';
import { AiImagePreferenceSetting } from './AiImageSettings';
import { ApiModelSelect } from './ApiModelSelect';
import { Row } from './controls';
import { useConversationModels } from './useConversationModels';
import '../../styles/conversation-model-settings.css';

export function ConversationModelSettings({
  feature,
  model,
  effort,
  onModelChange,
  onEffortChange,
  disabled,
  children,
}: {
  feature: 'assistant' | 'cloneChat';
  model: AgentLabModelSelection;
  effort: string;
  onModelChange: (value: AgentLabModelSelection) => void;
  onEffortChange: (value: string) => void;
  disabled?: boolean;
  children?: ReactNode;
}) {
  const assistant = feature === 'assistant';
  const { findModel } = useConversationModels();
  const selectedModel = findModel(model);
  const declared = selectedModel?.reasoningEfforts;
  const efforts = [...new Set(['off', ...(declared ?? [])])];
  const storedEffort = !efforts.includes(effort);
  const usesStoredEffort = assistant && selectedModel && declared === undefined;
  const label = assistant ? '默认思考强度' : '思考强度';

  return (
    <div className="weq-conversation-model-settings">
      <Row
        settingId={assistant ? 'weq-assistant-default-model' : undefined}
        label={assistant ? '默认聊天模型' : '聊天模型'}
        desc={assistant ? '会话未单独选模型时使用。' : '私聊和群聊共用。'}
        control={
          <ApiModelSelect
            label={assistant ? '默认聊天模型' : '聊天模型'}
            value={model}
            disabled={disabled}
            onChange={(next) => {
              if (next) onModelChange(next);
            }}
          />
        }
      />
      <Row
        settingId={assistant ? 'weq-assistant-default-effort' : undefined}
        label={label}
        desc={
          selectedModel && efforts.length === 1 && !(storedEffort && usesStoredEffort)
            ? '此模型未配置可选档位。'
            : undefined
        }
        control={
          <FormSelect
            className="weq-set-input"
            aria-label={label}
            value={effort}
            onChange={(event) => onEffortChange(event.target.value)}
            disabled={disabled || (efforts.length === 1 && !storedEffort)}
          >
            {efforts.map((value) => (
              <option value={value} key={value}>
                {value === 'off' ? '跟随模型' : value}
              </option>
            ))}
            {storedEffort ? (
              <option value={effort} disabled>
                {effort}（{usesStoredEffort || !selectedModel ? '已保存' : '当前不适用'}）
              </option>
            ) : null}
          </FormSelect>
        }
      />
      <AiImagePreferenceSetting
        feature={feature}
        desc={assistant ? undefined : '所有克隆会话共用。'}
      />
      {children}
    </div>
  );
}
