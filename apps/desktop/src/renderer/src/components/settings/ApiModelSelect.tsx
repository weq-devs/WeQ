import type { AgentLabModelRef } from '@weq/agentlab';
import { trpc } from '../../trpc/client';

export function ApiModelSelect({
  value,
  onChange,
  label,
  disabled = false,
  capability = 'chat',
  emptyLabel = '未选择',
  required = false,
}: {
  value: AgentLabModelRef | null;
  onChange: (value: AgentLabModelRef | null) => void;
  label: string;
  disabled?: boolean;
  capability?: 'chat' | 'embedding' | 'vision';
  emptyLabel?: string;
  required?: boolean;
}) {
  const providers = trpc.bootstrap.listAgentLabProviders.useQuery(undefined, {
    refetchOnWindowFocus: false,
  });
  const groups = (providers.data ?? [])
    .map((provider) => ({
      ...provider,
      models: provider.models.filter((model) => model.capabilities?.includes(capability) !== false),
    }))
    .filter((provider) => provider.models.length > 0);
  const key = (ref: AgentLabModelRef) => JSON.stringify([ref.providerId, ref.model]);
  const options = groups.flatMap((provider) =>
    provider.models.map((model) => ({ providerId: provider.id, model: model.id })),
  );
  const missing = value && !options.some((option) => key(option) === key(value));
  return (
    <select
      className="weq-set-input"
      aria-label={label}
      value={value ? key(value) : ''}
      disabled={disabled || providers.isLoading}
      onChange={(event) =>
        onChange(options.find((option) => key(option) === event.target.value) ?? null)
      }
    >
      <option value="" disabled={required}>
        {emptyLabel}
      </option>
      {missing && value ? (
        <option value={key(value)}>
          已保存但不可用：{value.providerId} · {value.model}
        </option>
      ) : null}
      {groups.map((provider) => (
        <optgroup key={provider.id} label={provider.name}>
          {provider.models.map((model) => (
            <option key={model.id} value={key({ providerId: provider.id, model: model.id })}>
              {model.label || model.id}
            </option>
          ))}
        </optgroup>
      ))}
    </select>
  );
}
