import { useRef } from 'react';
import { trpc } from '../trpc/client';
import { useToast } from '../components/Toast';
import type { TypingStatusOverride, TypingStatusSettings } from '@weq/service';

/** 设置页与输入框共用缓存，保存成功后立即同步所有已挂载的开关。 */
export function useTypingStatusSettings() {
  const query = trpc.bootstrap.getTypingStatusSettings.useQuery(undefined, {
    staleTime: 0,
    refetchOnMount: 'always',
  });
  const defaults = trpc.bootstrap.setTypingStatusDefault.useMutation();
  const overrides = trpc.bootstrap.setTypingStatusOverride.useMutation();
  const utils = trpc.useUtils();
  const saving = useRef(false);
  const busy = defaults.isLoading || overrides.isLoading;
  async function save(action: () => Promise<TypingStatusSettings>) {
    if (saving.current) return;
    saving.current = true;
    try {
      const next = await action();
      // 避免保存前发出的旧查询在稍后覆盖新开关，尤其是关闭广播时。
      await utils.bootstrap.getTypingStatusSettings.cancel();
      utils.bootstrap.getTypingStatusSettings.setData(undefined, next);
      await utils.bootstrap.getSettings.invalidate();
    } catch (error) {
      useToast.getState().push({
        tone: 'error',
        title: '保存输入状态设置失败',
        detail: error instanceof Error ? error.message : String(error),
      });
    } finally {
      saving.current = false;
    }
  }
  return {
    query,
    busy,
    disabled: !query.data || query.isError || busy,
    setDefault: (enabled: boolean) => save(() => defaults.mutateAsync({ enabled })),
    setOverride: (target: Omit<TypingStatusOverride, 'enabled'>, enabled: boolean | null) =>
      save(() => overrides.mutateAsync({ ...target, enabled })),
  };
}
