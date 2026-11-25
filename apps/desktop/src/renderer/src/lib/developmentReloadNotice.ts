import { useToast } from '../components/Toast.shared';
import {
  DEVELOPMENT_RELOAD_APPLY,
  DEVELOPMENT_RELOAD_DISMISS,
  DEVELOPMENT_RELOAD_QUERY,
  DEVELOPMENT_RELOAD_STATUS,
  type DevelopmentReloadStatus,
} from '../../../shared/development_reload';

export interface DevelopmentReloadChannel {
  on(event: string, listener: (status: DevelopmentReloadStatus | null) => void): void;
  off(event: string, listener: (status: DevelopmentReloadStatus | null) => void): void;
  send(event: string, data?: unknown): void;
}

export interface DevelopmentReloadNoticeState {
  status?: DevelopmentReloadStatus | null;
  toastId?: number;
  applying?: boolean;
}

/** 状态放在 hot.data 中，重连、模块热替换与连续构建不复活已关闭的同批横幅。 */
export function installDevelopmentReloadNotice(
  channel: DevelopmentReloadChannel,
  state: DevelopmentReloadNoticeState,
  remoteNotice?: (id: string) => void,
): () => void {
  const receive = (status: DevelopmentReloadStatus | null) => {
    if (remoteNotice) {
      if (status?.ready) remoteNotice(status.id);
      return;
    }
    const previous = state.status;
    state.status = status;
    state.applying = false;
    const toast = useToast.getState();
    if (!status || status.dismissed) {
      toast.resolve('development-reload');
      return;
    }
    const label = status.restart ? '重启应用' : '重载界面';
    const input = {
      appWide: true,
      tone: 'info' as const,
      title: status.ready
        ? status.restart
          ? '开发更新已就绪，点击重启'
          : '界面更新已就绪，点击重载'
        : '开发更新尚未就绪，等待构建成功',
      durationKind: 'long' as const,
      ttl: 0,
      source: null,
      onManualDismiss: () => channel.send(DEVELOPMENT_RELOAD_DISMISS, { id: status.id }),
      action: status.ready
        ? {
            label,
            icon: 'reload' as const,
            keepOpen: true,
            run: () => {
              if (!state.status?.ready || state.applying) return;
              state.applying = true;
              channel.send(DEVELOPMENT_RELOAD_APPLY, { id: state.status.id });
            },
          }
        : undefined,
    };
    if (previous?.id !== status.id)
      state.toastId = toast.push({ ...input, key: 'development-reload' });
    else if (state.toastId !== undefined) toast.update(state.toastId, input);
  };
  channel.on(DEVELOPMENT_RELOAD_STATUS, receive);
  // Remote 重载只更换当前文档，不会清除 Vite 上一批状态；缓存版本另由本机网关核对。
  if (!remoteNotice) channel.send(DEVELOPMENT_RELOAD_QUERY);
  return () => channel.off(DEVELOPMENT_RELOAD_STATUS, receive);
}
