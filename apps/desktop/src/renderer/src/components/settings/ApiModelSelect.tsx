import type { AgentLabModelSelection } from '@weq/agentlab/model-selection';
import { isDefaultModelSelection, modelSelectionKey } from '@weq/agentlab/model-selection';
import { trpc } from '../../trpc/client';
import { useTabActive } from '../RetainedTabs';
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
  allowDefault = false,
}: {
  value: AgentLabModelSelection | null;
  onChange: (value: AgentLabModelSelection | null) => void;
  label: string;
  disabled?: boolean;
  capability?: 'chat' | 'embedding' | 'vision';
  emptyLabel?: string;
  required?: boolean;
  allowDefault?: boolean;
}) {
  const active = useTabActive();
  const providers = trpc.bootstrap.listAgentLabProviders.useQuery(undefined, {
    enabled: active,
    refetchOnWindowFocus: false,
  });
  const defaultModel = trpc.bootstrap.getAgentLabDefaultModel.useQuery(undefined, {
    enabled: active && allowDefault,
    refetchOnWindowFocus: false,
  });
  const groups = (providers.data ?? [])
    .map((provider) => ({
      ...provider,
      models: provider.models.filter((model) => model.capabilities?.includes(capability) !== false),
    }))
    .filter((provider) => provider.models.length > 0);
  const key = modelSelectionKey;
  const groupLabels = providerDisplayLabels(providers.data ?? []);
  const options = groups.flatMap((provider) =>
    provider.models.map((model) => ({ providerId: provider.id, model: model.id })),
  );
  const inherited = isDefaultModelSelection(value);
  const missing = value && !inherited && !options.some((option) => key(option) === key(value));
  const defaultRef = defaultModel.data?.ref;
  const defaultLabel = defaultModel.error
    ? '读取失败'
    : !defaultRef
      ? '未配置'
      : `${defaultRef.model}${defaultModel.data?.available && options.some((option) => key(option) === key(defaultRef)) ? '' : '（不可用）'}`;
  return (
    <div className="weq-api-model-field">
      <select
        className="weq-set-input"
        aria-label={label}
        title={
          inherited
            ? `默认：${defaultLabel}`
            : value && !isDefaultModelSelection(value)
              ? value.model
              : emptyLabel
        }
        value={key(value)}
        disabled={disabled || providers.isLoading}
        onChange={(event) =>
          onChange(
            allowDefault && event.target.value === key({ useDefault: true })
              ? { useDefault: true }
              : (options.find((option) => key(option) === event.target.value) ?? null),
          )
        }
      >
        <option value="" disabled={required}>
          {emptyLabel}
        </option>
        {allowDefault || inherited ? (
          <option value={key({ useDefault: true })}>默认：{defaultLabel}</option>
        ) : null}
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
      {allowDefault && defaultModel.error ? (
        <QueryError
          message={`默认模型读取失败：${defaultModel.error.message}`}
          retryLabel="重新读取默认模型"
          retrying={defaultModel.isFetching}
          onRetry={() => void defaultModel.refetch()}
        />
      ) : null}
    </div>
  );
}
