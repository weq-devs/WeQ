import { useState } from 'react';
import type { AgentLabModelCapability } from '@weq/agentlab';
import type { AgentLabModelRef } from '@weq/agentlab/model-selection';
import { isDefaultModelSelection } from '@weq/agentlab/model-selection';
import { trpc } from '../../trpc/client';
import { ApiModelSelect } from './ApiModelSelect';
import { QueryError, Row } from './controls';
import { DEFAULT_API_MODEL_LABELS, useDefaultApiModel } from './useDefaultApiModel';

export function DefaultApiModelRow({
  capability = 'chat',
}: {
  capability?: AgentLabModelCapability;
}) {
  const utils = trpc.useUtils();
  const status = useDefaultApiModel(capability);
  const mutation =
    capability === 'chat'
      ? trpc.bootstrap.setAgentLabDefaultModel
      : capability === 'vision'
        ? trpc.bootstrap.setDefaultVisionModel
        : trpc.bootstrap.setDefaultEmbeddingModel;
  const save = mutation.useMutation();
  const label = DEFAULT_API_MODEL_LABELS[capability];
  const [error, setError] = useState<string | null>(null);

  async function onChange(ref: AgentLabModelRef | null) {
    setError(null);
    try {
      const next = await save.mutateAsync({ ref });
      const cache =
        capability === 'chat'
          ? utils.bootstrap.getAgentLabDefaultModel
          : capability === 'vision'
            ? utils.bootstrap.getDefaultVisionModel
            : utils.bootstrap.getDefaultEmbeddingModel;
      cache.setData(undefined, next);
      await utils.bootstrap.getSettings.invalidate();
      await utils.account.intentSense.getStatus.invalidate();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : `${label}保存失败`);
    }
  }

  return (
    <>
      <Row
        settingId={capability === 'chat' ? 'llm-default-model' : `llm-default-${capability}-model`}
        label={label}
        control={
          <ApiModelSelect
            allowDefault={false}
            capability={capability}
            label={label}
            value={status.data?.ref ?? null}
            emptyLabel={`未设置${label}`}
            disabled={!status.data || !!status.error || save.isLoading}
            onChange={(ref) => {
              if (!isDefaultModelSelection(ref)) void onChange(ref);
            }}
          />
        }
      />
      {status.error ? (
        <QueryError
          message={`${label}读取失败：${status.error.message}`}
          retryLabel={`重新读取${label}`}
          retrying={status.isFetching}
          onRetry={() => void status.refetch()}
        />
      ) : null}
      {status.data?.ref && !status.data.available && status.data.error ? (
        <p className="weq-set-note" role="alert">
          {status.data.error}
        </p>
      ) : null}
      {error ? (
        <p className="weq-set-note" role="alert">
          {error}
        </p>
      ) : null}
    </>
  );
}
