import { useCallback, useRef, useState } from 'react';
import { Check, ChevronDown } from 'lucide-react';
import type { AssistantConfig, AssistantSessionGeneration } from '@weq/service';
import {
  isDefaultModelSelection,
  modelSelectionKey,
  type AgentLabModelSelection,
} from '@weq/agentlab/model-selection';
import { ConversationActionsMenu } from '../../components/ConversationActionsMenu';
import { providerDisplayLabels } from '../../lib/providerDisplayLabels';
import { trpc } from '../../trpc/client';

const OFF = 'off';
const DEFAULT_EFFORTS = ['low', 'medium', 'high'];

function useAssistantModels() {
  const providers = trpc.bootstrap.listAgentLabProviders.useQuery();
  const defaults = trpc.bootstrap.getAgentLabDefaultModel.useQuery();
  const findModel = (model: AgentLabModelSelection | null | undefined) => {
    const ref = !model || isDefaultModelSelection(model) ? defaults.data?.ref : model;
    return (
      ref &&
      providers.data
        ?.find((provider) => provider.id === ref.providerId)
        ?.models.find((item) => item.id === ref.model)
    );
  };
  return { providers, findModel };
}

function effortLabel(effort: string) {
  return effort === OFF ? '不指定' : effort;
}

function effortValues(declared: string[] | undefined, selected: string) {
  return [...new Set([OFF, ...(declared ?? DEFAULT_EFFORTS), ...(selected ? [selected] : [])])];
}

export function AssistantEffortSelect({
  model,
  value,
  label,
  onChange,
  disabled,
}: {
  model?: AgentLabModelSelection;
  value: string;
  label: string;
  onChange: (value: string) => void;
  disabled: boolean;
}) {
  const { findModel } = useAssistantModels();
  return (
    <select
      className="weq-set-input"
      aria-label={label}
      value={value}
      onChange={(event) => onChange(event.target.value)}
      disabled={disabled}
    >
      {effortValues(findModel(model)?.reasoningEfforts, value).map((effort) => (
        <option value={effort} key={effort}>
          {effortLabel(effort)}
        </option>
      ))}
    </select>
  );
}

function InlineChoice({
  label,
  scopeLabel,
  value,
  summary,
  options,
  onChange,
  disabled,
}: {
  label: string;
  scopeLabel: string;
  value: string;
  summary: string;
  options: { value: string; label: string }[];
  onChange: (value: string) => void;
  disabled: boolean;
}) {
  const trigger = useRef<HTMLButtonElement>(null);
  const [point, setPoint] = useState<{ x: number; y: number } | null>(null);
  const close = useCallback(() => {
    setPoint(null);
    trigger.current?.focus({ preventScroll: true });
  }, []);
  const open = () => {
    const rect = trigger.current?.getBoundingClientRect();
    if (rect) setPoint({ x: rect.right, y: rect.top - 4 });
  };
  return (
    <div className="weq-assistant-parameter">
      <span>{label}</span>
      <button
        ref={trigger}
        type="button"
        className="weq-assistant-parameter-trigger"
        aria-label={`${scopeLabel}：${summary}`}
        title={`${scopeLabel}：${summary}`}
        aria-haspopup="menu"
        aria-expanded={point !== null}
        disabled={disabled}
        onClick={open}
        onKeyDown={(event) => {
          if (event.key !== 'ArrowUp' && event.key !== 'ArrowDown') return;
          event.preventDefault();
          open();
        }}
      >
        <span>{summary}</span>
        <ChevronDown size={13} aria-hidden />
      </button>
      {point ? (
        <ConversationActionsMenu
          {...point}
          label={scopeLabel}
          dropdown="above"
          onClose={close}
          actions={options.map((option) => ({
            label: option.label,
            checked: option.value === value,
            icon: (
              <Check
                size={14}
                aria-hidden
                style={{ visibility: option.value === value ? 'visible' : 'hidden' }}
              />
            ),
            action: () => onChange(option.value),
          }))}
        />
      ) : null}
    </div>
  );
}

export function AssistantGenerationControls({
  defaults,
  selection,
  disabled,
  onChange,
}: {
  defaults?: AssistantConfig;
  selection: AssistantSessionGeneration;
  disabled: boolean;
  onChange: (patch: AssistantSessionGeneration) => void;
}) {
  const { findModel, providers } = useAssistantModels();
  const defaultModel = findModel(defaults?.model);
  const defaultLabel = defaultModel?.label || defaultModel?.id;
  const model = selection.model ?? defaults?.model;
  const declared = findModel(model)?.reasoningEfforts;
  const requestedEffort = defaults?.reasoningEffort ?? OFF;
  const inheritedEffort =
    selection.model && declared && !declared.includes(requestedEffort) ? OFF : requestedEffort;
  const effort = selection.reasoningEffort ?? '';
  const chosenKey = modelSelectionKey(selection.model);
  const labels = providerDisplayLabels(providers.data ?? []);
  const models = (providers.data ?? []).flatMap((provider) =>
    provider.models
      .filter((item) => item.capabilities.includes('chat'))
      .map((item) => ({
        ref: { providerId: provider.id, model: item.id },
        label: `${item.label || item.id} · ${labels.get(provider.id) ?? provider.name}`,
        summary: item.label || item.id,
      })),
  );
  const chosen = models.find((item) => modelSelectionKey(item.ref) === chosenKey);
  const modelOptions = [
    { value: '', label: defaultLabel ? `跟随默认（${defaultLabel}）` : '跟随默认' },
    ...models.map((item) => ({ value: modelSelectionKey(item.ref), label: item.label })),
  ];
  const selectedModel =
    selection.model && !isDefaultModelSelection(selection.model)
      ? selection.model.model
      : undefined;
  if (selectedModel && !chosen)
    modelOptions.push({ value: chosenKey, label: `${selectedModel}（不可用）` });
  return (
    <div className="weq-assistant-generation-tools">
      <InlineChoice
        label="模型"
        scopeLabel="本会话模型"
        value={chosenKey}
        summary={chosen?.summary ?? selectedModel ?? defaultLabel ?? '跟随默认'}
        options={modelOptions}
        disabled={disabled || providers.isLoading}
        onChange={(value) => {
          if (value === chosenKey) return;
          const next = models.find((item) => modelSelectionKey(item.ref) === value)?.ref ?? null;
          const supported = findModel(next ?? defaults?.model)?.reasoningEfforts;
          onChange({
            model: next,
            ...(effort && effort !== OFF && supported && !supported.includes(effort)
              ? { reasoningEffort: null }
              : {}),
          });
        }}
      />
      <InlineChoice
        label="思考"
        scopeLabel="本会话思考强度"
        value={effort}
        summary={effortLabel(effort || inheritedEffort)}
        options={[
          { value: '', label: `跟随默认（${effortLabel(inheritedEffort)}）` },
          ...effortValues(declared, effort).map((value) => ({ value, label: effortLabel(value) })),
        ]}
        disabled={disabled}
        onChange={(value) => {
          if (value !== effort) onChange({ reasoningEffort: value || null });
        }}
      />
    </div>
  );
}
