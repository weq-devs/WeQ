import { createContext, useEffect, useRef } from 'react';
import { trpc } from '../../trpc/client';
import { useDialog } from '../Dialog';
import { useTabActive } from '../RetainedTabs';
import { usePageSnapshotKey } from '../PageSnapshots';

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
  const saving = useRef<Promise<void>>(Promise.resolve());
  const lastQueued = useRef('');
  const source = usePageSnapshotKey('ai-settings-source');
  const currentSource = useRef(source);
  currentSource.current = source;
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  const disabled = !active || !status.data || !!status.error || status.isLoading;

  function refreshResults() {
    void utils.account.intentSense.listMessageAnalyses.invalidate();
    void utils.account.intentSense.getSuggestions.invalidate();
    void utils.account.intentSense.getProfile.invalidate();
  }

  async function patch(
    input: Parameters<typeof save.mutateAsync>[0],
    inline = false,
  ): Promise<void> {
    if (disabled) {
      if (inline) throw new Error('设置尚未就绪');
      return;
    }
    const signature = `${source ?? ''}:${JSON.stringify(input)}`;
    if (signature === lastQueued.current) return saving.current;
    lastQueued.current = signature;
    const operation = saving.current
      .catch(() => {})
      .then(async () => {
        if (!mounted.current || currentSource.current !== source)
          throw new Error('设置目标已关闭或切换');
        const next = await save.mutateAsync(input);
        if (!mounted.current || currentSource.current !== source) return;
        utils.account.intentSense.getStatus.setData(undefined, next);
        refreshResults();
      });
    saving.current = operation;
    try {
      await operation;
    } catch (error) {
      if (inline) throw error;
      if (!mounted.current || currentSource.current !== source) return;
      showError(`${title}设置失败`, error instanceof Error ? error.message : String(error));
      void status.refetch();
    } finally {
      if (lastQueued.current === signature) lastQueued.current = '';
    }
  }

  return { active, status, disabled, patch, refreshResults };
}

export const AiFeatureSettingsContext = createContext<ReturnType<
  typeof useAiFeatureSettings
> | null>(null);
