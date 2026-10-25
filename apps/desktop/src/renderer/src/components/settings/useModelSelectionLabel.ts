import { useCallback } from 'react';
import type { AgentLabModelSelection } from '@weq/agentlab/model-selection';
import { isDefaultModelSelection } from '@weq/agentlab/model-selection';
import { trpc } from '../../trpc/client';
import { useTabActive } from '../RetainedTabs';

export function useModelSelectionLabel() {
  const active = useTabActive();
  const current = trpc.bootstrap.getAgentLabDefaultModel.useQuery(undefined, {
    enabled: active,
    refetchOnWindowFocus: false,
  });
  return useCallback(
    (value: AgentLabModelSelection | null | undefined, empty = '未选择模型') => {
      if (!value) return empty;
      if (!isDefaultModelSelection(value)) return value.model;
      if (current.error) return '默认：读取失败';
      if (!current.data) return '默认：读取中';
      if (!current.data.ref) return '默认：未配置';
      return `默认：${current.data.ref.model}${current.data.available ? '' : '（不可用）'}`;
    },
    [current.data, current.error],
  );
}
