import {
  isDefaultModelSelection,
  type AgentLabModelSelection,
} from '@weq/agentlab/model-selection';
import { trpc } from '../../trpc/client';
import { useTabActive } from '../RetainedTabs.shared';

export function useConversationModels() {
  const active = useTabActive();
  const providers = trpc.bootstrap.listAgentLabProviders.useQuery(undefined, {
    enabled: active,
    refetchOnWindowFocus: false,
  });
  const defaults = trpc.bootstrap.getAgentLabDefaultModel.useQuery(undefined, {
    enabled: active,
    refetchOnWindowFocus: false,
  });
  const findModel = (model: AgentLabModelSelection | null | undefined) => {
    const ref = !model || isDefaultModelSelection(model) ? defaults.data?.ref : model;
    return (
      ref &&
      providers.data
        ?.find((provider) => provider.id === ref.providerId)
        ?.models.find(
          (item) => item.id === ref.model && item.capabilities?.includes('chat') !== false,
        )
    );
  };
  return { providers, findModel };
}
