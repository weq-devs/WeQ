import { useEffect, useMemo, useState } from 'react';
import { specialFallbackKind } from '@weqbot/protocol/message-fallbacks';
import { client } from '../../trpc/client';
import type { QQWriteBinding } from '../../hooks/useQQWriteSession';
import { isTransientMessageBackfillFailure } from '../../lib/flashPhoto';
import {
  loadMessageElementPatches,
  saveMessageElementPatches,
  type MessageElementPatch,
} from '../../lib/messageElementPatchStore';
import type { MessageWire } from './types';

type FetchResult = Awaited<ReturnType<typeof client.account.fetchGapMessages.query>>;
const MAX_ATTEMPTS = 3;
const RETRY_DELAY_MS = 1500;

export function messageFallbackKind(row: MessageWire) {
  if (row.recall || row.deletedKind || row.elements.length !== 1) return;
  const element = row.elements[0] as { type?: string; data?: { textContent?: unknown } } | null;
  const text = element?.data?.textContent;
  if (element?.type === 'text' && typeof text === 'string') return specialFallbackKind(text);
}

export function useMessageElementPatches(
  rows: readonly MessageWire[],
  kind: 'c2c' | 'group' | undefined,
  conv: string | undefined,
  binding: QQWriteBinding | null,
  online: boolean,
) {
  const account = binding?.expectedAccountUin;
  const config = binding?.expectedAccountConfigId;
  const key =
    account && config && kind && conv ? JSON.stringify([account, config, kind, conv]) : '';
  const session = useMemo(() => {
    const saved = loadMessageElementPatches(key);
    return {
      patches: saved.patches,
      dead: new Set(saved.dead),
      attempts: new Map<string, number>(),
      offlineChecked: new Set<string>(),
      inFlight: new Map<string, Promise<FetchResult | undefined>>(),
    };
  }, [key]);
  const [updated, setUpdated] = useState<{
    session: typeof session;
    patches: Record<string, MessageElementPatch>;
  }>();

  useEffect(() => {
    if (!key || !kind || !conv || !account || !config) return;
    if (!online) session.attempts.clear();
    else session.offlineChecked.clear();

    const candidates = rows.flatMap((row) => {
      const type = messageFallbackKind(row);
      if (!type || !/^[1-9]\d*$/.test(row.sendTime) || !/^[1-9]\d*$/.test(row.msgSeq)) return [];
      const seq = Number(row.msgSeq);
      if (!Number.isSafeInteger(seq) || seq > 0xffffffff) return [];
      const { msgId, senderUid, senderUin, sendTime } = row;
      return [{ msgId, seq, lookup: { type, senderUid, senderUin, sendTime } }];
    });
    if (candidates.length === 0) return;

    let active = true;
    let retryTimer: ReturnType<typeof setTimeout> | undefined;
    const persist = () =>
      saveMessageElementPatches(key, { patches: session.patches, dead: [...session.dead] });
    const run = async () => {
      let retry = false;
      // 串行处理当前窗口。单条失败先让其余消息补完，再重试。
      for (const { msgId, seq, lookup } of candidates) {
        if (!active) return;
        const attempts = session.attempts.get(msgId) ?? 0;
        if (
          session.patches[msgId] ||
          (online
            ? session.dead.has(msgId) || attempts >= MAX_ATTEMPTS
            : session.offlineChecked.has(msgId))
        )
          continue;
        const requestKey = `${online}:${msgId}`;
        let request = session.inFlight.get(requestKey);
        if (!request) {
          request = client.account.fetchGapMessages
            .query({
              kind,
              conv,
              startSeq: seq,
              endSeq: seq,
              cacheOnly: !online,
              specialMessage: lookup,
              expectedAccountUin: account,
              expectedAccountConfigId: config,
            })
            .catch(() => undefined)
            .finally(() => session.inFlight.delete(requestKey));
          session.inFlight.set(requestKey, request);
        }
        const result = await request;
        if (!active) return;
        if (online) session.attempts.set(msgId, attempts + 1);
        else session.offlineChecked.add(msgId);
        const message = result?.ok && result.messages.length === 1 ? result.messages[0] : undefined;
        if (message) {
          session.patches = {
            ...session.patches,
            [msgId]: { elements: message.elements, sourceFormat: message.sourceFormat },
          };
          persist();
          setUpdated({ session, patches: session.patches });
        } else if (!online) continue;
        else if (
          result &&
          !result.ok &&
          !isTransientMessageBackfillFailure(result.reason, result.message)
        ) {
          session.dead.add(msgId);
          persist();
        } else if (attempts + 1 < MAX_ATTEMPTS) {
          retry = true;
        }
      }
      if (retry && active) retryTimer = setTimeout(() => void run(), RETRY_DELAY_MS);
    };
    void run();
    return () => {
      active = false;
      clearTimeout(retryTimer);
    };
  }, [account, config, conv, key, kind, online, rows, session]);

  return updated?.session === session ? updated.patches : session.patches;
}
