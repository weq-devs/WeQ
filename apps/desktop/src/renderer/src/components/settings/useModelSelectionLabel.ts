import { useCallback } from 'react';
import type { AgentLabModelCapability } from '@weq/agentlab';
import type { AgentLabModelSelection } from '@weq/agentlab/model-selection';
import { isDefaultModelSelection } from '@weq/agentlab/model-selection';
import { useDefaultApiModel } from './useDefaultApiModel';

export function useModelSelectionLabel(capability: AgentLabModelCapability = 'chat') {
  const current = useDefaultApiModel(capability);
  return useCallback(
    (value: AgentLabModelSelection | null | undefined, empty?: string) => {
      if (!value && empty !== undefined) return empty;
      if (value && !isDefaultModelSelection(value)) return value.model;
      if (current.error) return '默认（当前：读取失败）';
      if (!current.data) return '默认（当前：读取中）';
      if (!current.data.ref) return '默认（当前：未配置）';
      return `默认（当前：${current.data.ref.model}${current.data.available ? '' : '（不可用）'}）`;
    },
    [current.data, current.error],
  );
}
