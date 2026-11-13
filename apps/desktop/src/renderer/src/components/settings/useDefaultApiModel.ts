import type { AgentLabModelCapability } from '@weq/agentlab';
import type { inferRouterOutputs } from '@trpc/server';
import type { AppRouter } from '../../../../shared/router';
import { trpc } from '../../trpc/client';
import { useTabActive } from '../RetainedTabs';

export const DEFAULT_API_MODEL_LABELS = {
  chat: '默认聊天模型',
  vision: '默认视觉模型',
  embedding: '默认向量模型',
} as const;

type DefaultModelQuery = (
  input: undefined,
  options: {
    enabled: boolean;
    refetchOnWindowFocus: false;
    staleTime: number;
    refetchOnMount: 'always';
  },
) => {
  data: inferRouterOutputs<AppRouter>['bootstrap']['getAgentLabDefaultModel'] | undefined;
  error: { message: string } | null;
  isFetching: boolean;
  refetch: () => unknown;
};

export function useDefaultApiModel(capability: AgentLabModelCapability = 'chat', enabled = true) {
  const active = useTabActive();
  const useQuery: DefaultModelQuery =
    capability === 'chat'
      ? trpc.bootstrap.getAgentLabDefaultModel.useQuery
      : capability === 'vision'
        ? trpc.bootstrap.getDefaultVisionModel.useQuery
        : trpc.bootstrap.getDefaultEmbeddingModel.useQuery;
  return useQuery(undefined, {
    enabled: active && enabled,
    refetchOnWindowFocus: false,
    staleTime: 0,
    refetchOnMount: 'always',
  });
}
