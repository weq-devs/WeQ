import { useState } from 'react';
import type { AgentLabModelRef } from '@weq/agentlab';
import { trpc } from '../../trpc/client';
import { useTabActive } from '../RetainedTabs';
import { ApiModelSelect } from './ApiModelSelect';
import { QueryError, Row } from './controls';

export function DefaultApiModelRow() {
  const active = useTabActive();
  const utils = trpc.useUtils();
  const status = trpc.bootstrap.getAgentLabDefaultModel.useQuery(undefined, {
    enabled: active,
    refetchOnWindowFocus: false,
    staleTime: 0,
    refetchOnMount: 'always',
  });
  const save = trpc.bootstrap.setAgentLabDefaultModel.useMutation();
  const [error, setError] = useState<string | null>(null);

  async function onChange(ref: AgentLabModelRef | null) {
    setError(null);
    try {
      const next = await save.mutateAsync({ ref });
      utils.bootstrap.getAgentLabDefaultModel.setData(undefined, next);
      await utils.bootstrap.getSettings.invalidate();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : '默认模型保存失败');
    }
  }

  return (
    <>
      <Row
        settingId="llm-default-model"
        label="默认模型"
        control={
          <ApiModelSelect
            label="LLM 默认模型"
            value={status.data?.ref ?? null}
            emptyLabel="未设置默认模型"
            disabled={!status.data || !!status.error || save.isLoading}
            onChange={(ref) => void onChange(ref)}
          />
        }
      />
      {status.error ? (
        <QueryError
          message={`默认模型读取失败：${status.error.message}`}
          retryLabel="重新读取默认模型"
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
