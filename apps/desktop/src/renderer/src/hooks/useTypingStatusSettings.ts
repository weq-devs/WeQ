import { useRef } from 'react';
import { trpc } from '../trpc/client';
import { useTabActive } from '../components/RetainedTabs.shared';
import { useToastApi } from '../components/Toast.shared';
import { notificationSource } from '../lib/notificationNavigation.shared';
import type {
  TypingStatusConversation,
  TypingStatusMode,
  TypingStatusSettings,
} from '@weq/service';

/** 设置页与输入框共用缓存，保存成功后立即同步所有已挂载的广播逻辑。 */
export function useTypingStatusSettings() {
  const notificationToast = useToastApi();
  const active = useTabActive();
  const query = trpc.bootstrap.getTypingStatusSettings.useQuery(undefined, {
    enabled: active,
    staleTime: 0,
    refetchOnMount: 'always',
  });
  const modes = trpc.bootstrap.setTypingStatusMode.useMutation();
  const hidden = trpc.bootstrap.setTypingStatusHidden.useMutation();
  const utils = trpc.useUtils();
  const saving = useRef(false);
  const busy = modes.isLoading || hidden.isLoading;
  async function save(action: () => Promise<TypingStatusSettings>) {
    if (saving.current) return;
    saving.current = true;
    try {
      const next = await action();
      // 避免保存前发出的旧查询在稍后覆盖新设置，尤其是切换范围时。
      await utils.bootstrap.getTypingStatusSettings.cancel();
      utils.bootstrap.getTypingStatusSettings.setData(undefined, next);
      await utils.bootstrap.getSettings.invalidate();
    } catch (error) {
      notificationToast.push({
        tone: 'error',
        title: '保存输入状态设置失败',
        source: notificationSource(
          {
            kind: 'app',
            target: { kind: 'setting', section: 'chat-interaction', settingId: 'typing-status' },
          },
          '返回输入状态设置',
          null,
        ),
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
    setMode: (mode: TypingStatusMode) => save(() => modes.mutateAsync({ mode })),
    setHidden: (
      hiddenList: TypingStatusConversation[],
      binding?: { expectedAccountUin: string; expectedAccountConfigId: string },
    ) => save(() => hidden.mutateAsync({ hidden: hiddenList, ...binding })),
  };
}
