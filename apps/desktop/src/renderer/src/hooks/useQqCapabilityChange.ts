import { useRef, useState } from 'react';
import type { QqCapabilityMode } from '@weq/service/qq-capability-mode';
import { useDialog } from '../components/Dialog.shared';
import { trpc } from '../trpc/client';

export function useQqCapabilityChange(mode: QqCapabilityMode | undefined) {
  const confirm = useDialog((state) => state.confirm);
  const utils = trpc.useUtils();
  const change = trpc.bootstrap.setQqCapabilityMode.useMutation();
  const pending = useRef(false);
  const [changing, setChanging] = useState(false);
  const [error, setError] = useState('');

  async function select(next: QqCapabilityMode, retry = false) {
    if (!mode || pending.current || (mode === next && !retry)) return;
    pending.current = true;
    setChanging(true);
    setError('');
    try {
      let result = await change.mutateAsync({ mode: next });
      if (result.status === 'confirm-disconnect') {
        const accepted = await confirm(
          '关闭 QQ 代理',
          '关闭后，正在使用代理的 QQ 连接会断开。请先在 QQ 登录窗口的「网络设置」中恢复直连。',
          { okLabel: '关闭代理' },
        );
        if (!accepted) return;
        result = await change.mutateAsync({ mode: next, disconnectProxy: true });
      }
      if (result.status === 'saved' && result.proxyError) setError(result.proxyError);
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : String(failure));
    } finally {
      try {
        await Promise.all([
          utils.bootstrap.getSettings.invalidate(),
          utils.bootstrap.getFullModeState.invalidate(),
          utils.account.getGroupAlbumAccessState.invalidate(),
          utils.bootstrap.getQqClientSyncStatus.invalidate(),
        ]);
      } finally {
        pending.current = false;
        setChanging(false);
      }
    }
  }

  return { changing, error, select };
}
