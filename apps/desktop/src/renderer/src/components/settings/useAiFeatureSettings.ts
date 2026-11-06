import { createContext, useRef } from 'react';
import { trpc } from '../../trpc/client';
import { useDialog } from '../Dialog';
import { useTabActive } from '../RetainedTabs';

/** 三项功能共用账号配置，但只提交本次修改的字段。 */
export function useAiFeatureSettings(title: string) {
  const active = useTabActive();
  const status = trpc.account.intentSense.getStatus.useQuery(undefined, {
    enabled: active,
    refetchOnWindowFocus: false,
    staleTime: 0,
    refetchOnMount: 'always',
  });
  const save = trpc.account.intentSense.setConfig.useMutation();
  const utils = trpc.useUtils();
  const showError = useDialog((s) => s.showError);
  const saving = useRef(false);
  const disabled = !active || !status.data || !!status.error || status.isLoading || save.isLoading;

  function refreshResults() {
    void utils.account.intentSense.listMessageAnalyses.invalidate();
    void utils.account.intentSense.getSuggestions.invalidate();
    void utils.account.intentSense.getProfile.invalidate();
  }

  async function patch(input: Parameters<typeof save.mutateAsync>[0]): Promise<void> {
    if (disabled || saving.current) return;
    saving.current = true;
    try {
      const next = await save.mutateAsync(input);
      utils.account.intentSense.getStatus.setData(undefined, next);
      refreshResults();
    } catch (error) {
      showError(`${title}设置失败`, error instanceof Error ? error.message : String(error));
      void status.refetch();
    } finally {
      saving.current = false;
    }
  }

  return { active, status, disabled, patch, refreshResults };
}

export const AiFeatureSettingsContext = createContext<ReturnType<
  typeof useAiFeatureSettings
> | null>(null);
