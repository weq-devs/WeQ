import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { client } from '../trpc/client';
import {
  type ConversationInteraction,
  interactionBannerPrefix,
} from '../../../shared/conversation_interaction';
import { useToast } from '../components/Toast.shared';

type Binding = { expectedAccountUin: string; expectedAccountConfigId?: string };

export function useConversationInteractionBadges(
  binding: Binding | null | undefined,
  enabled: boolean,
) {
  const uin = binding?.expectedAccountUin;
  const configId = binding?.expectedAccountConfigId;
  const scope = enabled && uin && configId ? JSON.stringify([uin, configId]) : '';
  const [snapshot, setSnapshot] = useState<{ scope: string; events: ConversationInteraction[] }>();
  const inFlight = useRef({ scope, ids: new Set<string>() });
  if (inFlight.current.scope !== scope) inFlight.current = { scope, ids: new Set() };

  useEffect(() => {
    if (!scope || !uin || !configId) return;
    let active = true;
    let seen: ReadonlySet<string> = new Set();
    const prefix = interactionBannerPrefix(uin, configId);
    const closeReadBanners = (toast: ReturnType<typeof useToast.getState>) => {
      for (const { id, key } of toast.toasts)
        if (key?.startsWith(prefix) && seen.has(key.slice(prefix.length))) toast.dismiss(id);
    };
    const sub = client.account.interactionBadges.state.subscribe(
      { expectedAccountUin: uin, expectedAccountConfigId: configId },
      {
        onData: ({ pending, seen: acknowledged }) => {
          if (!active) return;
          seen = new Set(acknowledged);
          closeReadBanners(useToast.getState());
          setSnapshot({ scope, events: pending });
        },
      },
    );
    const stopBanners = useToast.subscribe((state, previous) => {
      if (state.toasts !== previous.toasts) closeReadBanners(state);
    });
    return () => {
      active = false;
      stopBanners();
      sub.unsubscribe();
    };
  }, [scope, uin, configId]);

  const byConversation = useMemo(() => {
    const result = new Map<string, ConversationInteraction[]>();
    if (!scope || snapshot?.scope !== scope) return result;
    for (const event of snapshot.events) {
      const key = `${event.kind}:${event.conv}`;
      const previous = result.get(key);
      if (previous) previous.push(event);
      else result.set(key, [event]);
    }
    return result;
  }, [snapshot, scope]);

  const acknowledge = useCallback(
    (visibleIds: string[]) => {
      if (!scope || !uin || !configId) return;
      const pending = inFlight.current.ids;
      const ids = [...new Set(visibleIds)].filter((id) => !pending.has(id));
      for (let offset = 0; offset < ids.length; offset += 128) {
        const batch = ids.slice(offset, offset + 128);
        for (const id of batch) pending.add(id);
        void client.account.interactionBadges.acknowledge
          .mutate({
            expectedAccountUin: uin,
            expectedAccountConfigId: configId,
            ids: batch,
          })
          .catch(() => {})
          .finally(() => {
            for (const id of batch) pending.delete(id);
          });
      }
    },
    [scope, uin, configId],
  );

  return { byConversation, acknowledge };
}
