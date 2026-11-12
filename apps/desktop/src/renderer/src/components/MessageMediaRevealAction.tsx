import { FolderSearch } from 'lucide-react';
import { MessageMenuButton } from './MessageMenuButton';
import { trpc, client } from '../trpc/client';
import type { MessageMediaTarget } from '../../../shared/message_media';
import {
  MESSAGE_MEDIA_LOCATION_LABELS,
  messageMediaLocationMissing,
} from '../../../shared/message_media';
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
  const local = trpc.account.mediaResource.messageLocations.useQuery(input, {
    enabled: Boolean(binding),
    staleTime: 0,
    retry: false,
    refetchInterval: 2000,
  });
  const push = useToast((state) => state.push);
  if (!binding || !local.data?.length) return null;
  return (
    <>
      {local.data.map((location) => {
        const label = MESSAGE_MEDIA_LOCATION_LABELS[location.kind];
        const reason = !location.available ? messageMediaLocationMissing(location.kind) : '';
        return (
          <MessageMenuButton
            key={location.key}
            type="button"
            aria-label={label}
            title={`${reason || label}：${target.label}`}
            onClick={() => {
              onClose();
              void client.account.mediaResource.revealMessageMedia
                .mutate({ ...input, location: { kind: location.kind, key: location.key } })
                .catch((error: unknown) =>
                  push({
                    tone: 'error',
                    title: error instanceof Error ? error.message : String(error),
                  }),
                );
            }}
          >
            <FolderSearch size={17} />
            <span>{label}</span>
          </MessageMenuButton>
        );
      })}
    </>
  );
}
