import { FolderSearch } from 'lucide-react';
import { trpc, client } from '../trpc/client';
import type { MessageMediaTarget } from '../../../shared/message_media';
import type { QQWriteBinding } from '../hooks/useQQWriteSession';
import { useToast } from './Toast';

export function MessageMediaRevealAction({
  target,
  binding,
  onClose,
}: {
  target: MessageMediaTarget;
  binding: QQWriteBinding | null;
  onClose: () => void;
}) {
  const input = { ...binding, target };
  const local = trpc.account.mediaResource.messageLocalAvailable.useQuery(input, {
    enabled: Boolean(binding),
    staleTime: 0,
    retry: false,
    refetchInterval: (available) => (available ? false : 2000),
  });
  const push = useToast((state) => state.push);
  const reason = !binding
    ? '账号信息尚未就绪'
    : local.isLoading
      ? '正在查找本地文件'
      : local.error
        ? '本地文件查询失败'
        : !local.data
          ? '尚无本地文件'
          : '';
  return (
    <button
      type="button"
      aria-label="在文件夹中显示"
      title={`${reason || '在文件夹中显示'}：${target.label}`}
      disabled={Boolean(reason)}
      onClick={() => {
        onClose();
        void client.account.mediaResource.revealMessageMedia.mutate(input).catch((error: unknown) =>
          push({
            tone: 'error',
            title: '无法定位文件',
            detail: error instanceof Error ? error.message : String(error),
          }),
        );
      }}
    >
      <FolderSearch size={17} />
      <span>在文件夹中显示</span>
    </button>
  );
}
