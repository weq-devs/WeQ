import type { AgentLabModelRef } from '@weq/agentlab';
import { trpc } from '../../trpc/client';
import { providerDisplayLabels } from '../../lib/providerDisplayLabels';
import { QueryError } from './controls';

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
  const groupLabels = providerDisplayLabels(providers.data ?? []);
  const options = groups.flatMap((provider) =>
    provider.models.map((model) => ({ providerId: provider.id, model: model.id })),
  );
  const missing = value && !options.some((option) => key(option) === key(value));
  return (
    <div className="weq-api-model-field">
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
            {providers.isLoading || providers.error ? '已保存' : '已保存但不可用'}：
            {value.providerId} · {value.model}
          </option>
        ) : null}
        {groups.map((provider) => (
          <optgroup key={provider.id} label={groupLabels.get(provider.id)}>
            {provider.models.map((model) => (
              <option key={model.id} value={key({ providerId: provider.id, model: model.id })}>
                {model.label || model.id}
                {groups.length > 1 ? ` · ${groupLabels.get(provider.id)}` : ''}
              </option>
            ))}
          </optgroup>
        ))}
      </select>
      {providers.error ? (
        <QueryError
          message={`模型列表读取失败：${providers.error.message}`}
          retryLabel="重新读取模型列表"
          retrying={providers.isFetching}
          onRetry={() => void providers.refetch()}
        />
      ) : null}
    </div>
  );
}
