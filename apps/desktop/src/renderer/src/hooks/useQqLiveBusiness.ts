import { useEffect, useRef, useState } from 'react';
import { client, trpc } from '../trpc/client';
import { essenceSource, useQQEssence } from '../state/qqEssence';
import { useStableCallback } from './useStableCallback';
import type { QQWriteBinding } from './useQQWriteSession';

export function useQqLiveBusiness(binding: QQWriteBinding | null, peer: string, selfUid: string) {
  const utils = trpc.useUtils();
  const uin = binding?.expectedAccountUin;
  const configId = binding?.expectedAccountConfigId;
  const source = essenceSource(binding);
  const [typing, setTyping] = useState<{ source: string; uid: string; speaking: boolean }>();
  const typingRef = useRef(typing);
  const activePeer = useStableCallback(() => peer);
  const currentUser = useStableCallback(() => selfUid);
  const queryUtils = useStableCallback(() => utils);

  useEffect(() => {
    if (!uin || !configId) return;
    const binding = { expectedAccountUin: uin, expectedAccountConfigId: configId };
    let active = true;
    let typingExpiry: ReturnType<typeof setTimeout> | undefined;
    let refreshTimer: ReturnType<typeof setTimeout> | undefined;
    const refresh = new Map<string, () => void>();
    const queueRefresh = (key: string, operation: () => void) => {
      refresh.set(key, operation);
      if (refreshTimer) return;
      refreshTimer = setTimeout(() => {
        refreshTimer = undefined;
        if (active) for (const operation of refresh.values()) operation();
        refresh.clear();
      }, 500);
    };
    const clearTyping = () => {
      clearTimeout(typingExpiry);
      if (typingRef.current?.source !== source) return;
      typingRef.current = undefined;
      setTyping(undefined);
    };
    const sub = client.account.onQqLiveBusiness.subscribe(binding, {
      onData(batch) {
        if (!active) return;
        if ('disconnected' in batch) {
          clearTyping();
          return;
        }
        const utils = queryUtils();
        for (const event of batch.events) {
          switch (event.kind) {
            case 'input-status': {
              if (event.uid !== activePeer() || event.expiresAt <= Date.now()) break;
              clearTimeout(typingExpiry);
              const next = { source, uid: event.uid, speaking: event.speaking };
              typingRef.current = next;
              setTyping(next);
              typingExpiry = setTimeout(clearTyping, event.expiresAt - Date.now());
              break;
            }
            case 'friend-request':
              queueRefresh('friend-request', () => {
                void utils.account.listBuddyRequests.invalidate();
                void utils.account.qqActions.requestInbox.invalidate({
                  ...binding,
                  kind: 'friend',
                });
                void utils.account.qqActions.requestInbox.invalidate({
                  ...binding,
                  kind: 'doubtFriend',
                });
              });
              break;
            case 'friend-add':
              queueRefresh('friend-directory', () => {
                void utils.account.listBuddies.invalidate();
                void utils.account.listBuddyRequests.invalidate();
              });
              queueRefresh(`friend:${event.uid}`, () => {
                void utils.account.getProfile.invalidate({ uid: event.uid });
                void utils.account.getProfilesByUids.invalidate(binding, {
                  predicate(query) {
                    const key = query.queryKey[1] as { input?: { uids?: string[] } } | undefined;
                    return key?.input?.uids?.includes(event.uid) === true;
                  },
                });
              });
              break;
            case 'group-request':
              queueRefresh(
                'group-request',
                () => void utils.account.listGroupNotifies.invalidate(),
              );
              break;
            case 'group-mute': {
              const groupId = Number(event.groupCode);
              const group = { ...binding, groupId };
              if (event.uid && event.uid === currentUser()) {
                utils.account.qqActions.groupPermissions.setData(group, (row) => {
                  if (!row) return row;
                  return {
                    ...row,
                    muteUntil: event.duration ? Math.floor(event.at / 1000) + event.duration : null,
                  };
                });
              }
              if (!event.uid || event.uid === currentUser()) {
                queueRefresh(
                  `permissions:${groupId}`,
                  () => void utils.account.qqActions.groupPermissions.invalidate(group),
                );
              }
              if (event.uid) {
                const member = { ...group, uid: event.uid };
                utils.account.qqWrite.memberDetails.setData(
                  member,
                  (row) =>
                    row && {
                      ...row,
                      muteUntil: event.duration ? Math.floor(event.at / 1000) + event.duration : 0,
                    },
                );
                queueRefresh(
                  `member:${groupId}:${event.uid}`,
                  () => void utils.account.qqWrite.memberDetails.invalidate(member),
                );
              }
              break;
            }
            case 'group-essence': {
              useQQEssence
                .getState()
                .observe(
                  source,
                  Number(event.groupCode),
                  Number(event.sequence),
                  event.active,
                  event.at,
                );
              queueRefresh(`essence:${event.groupCode}`, () => {
                const group = { groupCode: event.groupCode };
                void utils.account.listGroupEssenceSeqs.invalidate(group);
                void utils.account.listGroupEssenceMessages.invalidate({ ...binding, ...group });
                void utils.account.getGroupEssencePageSequences.invalidate({
                  ...binding,
                  ...group,
                });
                void utils.account.getGroupEssencePageWithContent.invalidate({
                  ...binding,
                  ...group,
                });
              });
              break;
            }
          }
        }
      },
      onError: clearTyping,
    });
    return () => {
      active = false;
      clearTimeout(refreshTimer);
      clearTyping();
      sub.unsubscribe();
    };
  }, [uin, configId, source, queryUtils, activePeer, currentUser]);

  useEffect(() => {
    if (!typingRef.current || typingRef.current.uid === peer) return;
    typingRef.current = undefined;
    setTyping(undefined);
  }, [peer]);

  if (!typing || typing.source !== source || typing.uid !== peer) return;
  return typing.speaking ? '对方正在讲话…' : '对方正在输入…';
}
