import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { compareMessageOrder } from '@weq/codec';
import { client } from '../trpc/client';
import {
  type ConversationInteraction,
  type ConversationInteractionSnapshot,
  interactionBannerPrefix,
} from '../../../shared/conversation_interaction';
import { useToast } from '../components/Toast.shared';
import { toMessageWire } from '../views/workspace/messageProjection';
import type { MessageWire } from '../views/workspace/types';

type Binding = { expectedAccountUin: string; expectedAccountConfigId?: string };

export function useConversationInteractionBadges(
  binding: Binding | null | undefined,
  enabled: boolean,
) {
  const uin = binding?.expectedAccountUin;
  const configId = binding?.expectedAccountConfigId;
  const scope = enabled && uin && configId ? JSON.stringify([uin, configId]) : '';
  const [snapshot, setSnapshot] = useState<ConversationInteractionSnapshot & { scope: string }>();
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
        onData: (next) => {
          if (!active) return;
          seen = new Set(next.seen);
          closeReadBanners(useToast.getState());
          setSnapshot({ scope, ...next });
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
    for (const event of snapshot.pending) {
      const key = `${event.kind}:${event.conv}`;
      const previous = result.get(key);
      if (previous) previous.push(event);
      else result.set(key, [event]);
    }
    return result;
  }, [snapshot, scope]);
  const badgeConversations = useMemo(
    () =>
      new Set(
        scope && snapshot?.scope === scope
          ? snapshot.badges.map(({ kind, conv }) => `${kind}:${conv}`)
          : [],
      ),
    [snapshot, scope],
  );

  const acknowledge = useCallback(
    (visibleIds: string[], bannerOnly = false) => {
      if (!scope || !uin || !configId) return;
      const pending = inFlight.current.ids;
      const requestKey = (id: string) => (bannerOnly ? `banner:${id}` : id);
      const ids = [...new Set(visibleIds)].filter((id) => !pending.has(requestKey(id)));
      for (let offset = 0; offset < ids.length; offset += 128) {
        const batch = ids.slice(offset, offset + 128);
        for (const id of batch) pending.add(requestKey(id));
        void client.account.interactionBadges.acknowledge
          .mutate({
            expectedAccountUin: uin,
            expectedAccountConfigId: configId,
            ids: batch,
            bannerOnly,
          })
          .catch(() => {})
          .finally(() => {
            for (const id of batch) pending.delete(requestKey(id));
          });
      }
    },
    [scope, uin, configId],
  );

  return { byConversation, badgeConversations, acknowledge };
}

const emptyRows: MessageWire[] = [];

// 真正的 0/NULL 序号不会被普通消息窗口的 seq 游标读到，单独补取，不改变分页水位。
export function useUnsequencedInteractionRows(
  binding: Binding | null | undefined,
  target: { kind: 'c2c' | 'group'; conv: string } | null,
  pending: readonly ConversationInteraction[] | undefined,
) {
  const uin = binding?.expectedAccountUin;
  const configId = binding?.expectedAccountConfigId;
  const kind = target?.kind;
  const conv = target?.conv;
  const scope = uin && configId && kind && conv ? JSON.stringify([uin, configId, kind, conv]) : '';
  const ids = pending
    ?.filter((event) => event.storedWithoutSeq)
    .map((event) => event.msgId)
    .join(',');
  const [snapshot, setSnapshot] = useState<{ scope: string; rows: MessageWire[] }>();
  useEffect(() => {
    if (!scope || !uin || !configId || !kind || !conv || !ids) return;
    let active = true;
    void client.account.interactionBadges.unsequencedRows
      .query({ kind, conv, expectedAccountUin: uin, expectedAccountConfigId: configId })
      .then((rows) => {
        if (!active || !rows.length) return;
        const fresh = rows.map(toMessageWire);
        setSnapshot((previous) => {
          const known = previous?.scope === scope ? previous.rows : [];
          return {
            scope,
            rows: [...new Map([...known, ...fresh].map((row) => [row.msgId, row])).values()].slice(
              -64,
            ),
          };
        });
      })
      .catch(() => {});
    return () => {
      active = false;
    };
  }, [scope, uin, configId, kind, conv, ids]);
  return snapshot?.scope === scope ? snapshot.rows : emptyRows;
}

export function mergeUnsequencedInteractionRows(
  rows: MessageWire[],
  unsequenced: MessageWire[],
): MessageWire[] {
  if (!unsequenced.length) return rows;
  const compare = (a: MessageWire, b: MessageWire) =>
    compareMessageOrder(
      { msgSeq: '0', sendTime: a.sendTime, msgId: a.msgId },
      { msgSeq: '0', sendTime: b.sendTime, msgId: b.msgId },
    );
  const existing = new Set(rows.map(({ msgId }) => msgId));
  const extras = unsequenced.filter((row) => !existing.has(row.msgId)).sort(compare);
  let i = 0;
  const result: MessageWire[] = [];
  for (const row of rows) {
    while (i < extras.length && compare(extras[i]!, row) < 0) result.push(extras[i++]!);
    result.push(row);
  }
  return [...result, ...extras.slice(i)];
}
