import type { ReactNode } from 'react';
import { RotateCcw } from 'lucide-react';
import type { AgentLabModelSelection } from '@weq/agentlab/model-selection';
import { AiImagePreferenceSetting } from './AiImageSettings';
import { ApiModelSelect } from './ApiModelSelect';
import { Row } from './controls';
import { useConversationModels } from './useConversationModels';
import '../../styles/conversation-model-settings.css';

const EFFORT_LABELS = new Map([
  ['off', '跟随模型'],
  ['none', '关闭思考'],
  ['minimal', '最小'],
  ['low', '低'],
  ['medium', '中'],
  ['high', '高'],
  ['xhigh', '极高'],
  ['max', '最高'],
]);

export function ConversationModelSettings({
  feature,
  model,
  effort,
  history,
  onModelChange,
  onEffortChange,
  disabled,
  children,
}: {
  feature: 'assistant' | 'cloneChat';
  model: AgentLabModelSelection;
  effort: string;
  history: {
    value: number;
    standard: number;
    extended: number;
    onChange: (value: number) => void;
  };
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
  const effortLabel = EFFORT_LABELS.get(effort) ?? effort;
  const usesStoredEffort = assistant && selectedModel && declared === undefined;
  const label = assistant ? '默认思考强度' : '思考强度';

  const historyOptions = [
    { value: 0, label: '不带入' },
    { value: history.standard, label: `标准（${history.standard} 条）` },
    { value: history.extended, label: `更多（${history.extended} 条）` },
  ];
  if (!historyOptions.some((option) => option.value === history.value))
    historyOptions.push({ value: history.value, label: `原设置（${history.value} 条）` });

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
          <select
            className="weq-set-input"
            aria-label={label}
            value={effort}
            onChange={(event) => onEffortChange(event.target.value)}
            disabled={disabled || (efforts.length === 1 && !storedEffort)}
          >
            {efforts.map((value) => (
              <option value={value} key={value}>
                {EFFORT_LABELS.get(value) ?? value}
              </option>
            ))}
            {storedEffort ? (
              <option value={effort} disabled>
                {effortLabel}（{usesStoredEffort || !selectedModel ? '已保存' : '当前不适用'}）
              </option>
            ) : null}
          </select>
        }
      />
      <AiImagePreferenceSetting
        feature={feature}
        desc={assistant ? undefined : '所有克隆会话共用。'}
      />
      <Row
        settingId={assistant ? 'weq-assistant-historyMessages' : undefined}
        label="对话上下文"
        desc="带入最近消息，保留原记录。"
        control={
          <select
            className="weq-set-input"
            aria-label="对话上下文"
            value={history.value}
            onChange={(event) => history.onChange(Number(event.target.value))}
            disabled={disabled}
          >
            {historyOptions.map(({ value, label }) => (
              <option key={value} value={value}>
                {label}
              </option>
            ))}
          </select>
        }
      />
      {children}
    </div>
  );
}

export function LegacyModelOverrides({
  fields,
  onReset,
  disabled,
}: {
  fields: string[];
  onReset: () => void;
  disabled?: boolean;
}) {
  if (!fields.length) return null;
  return (
    <Row
      label="旧版自定义参数"
      desc={fields.join('、')}
      control={
        <button
          className="weq-set-btn"
          type="button"
          aria-label="旧版参数恢复自动"
          disabled={disabled}
          onClick={onReset}
        >
          <RotateCcw size={14} aria-hidden />
          恢复自动
        </button>
      }
    />
  );
}
