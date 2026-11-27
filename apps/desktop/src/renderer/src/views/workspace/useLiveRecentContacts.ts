import { useEffect, useMemo, useState } from 'react';
import { ChatType } from '@weq/codec';
import type { QqLivePeer } from '../../../../shared/qq_live_business';
import { messageElementsPreview } from '../../lib/conversationPreview';
import { recentContactPreviewIsBehind } from '../../lib/recentContacts';
import { useStableCallback } from '../../hooks/useStableCallback';
import type { MessageWire, RecentContactWire } from './types';

const PENDING_CONTACT_MS = 30_000;
type PendingContact = { row: RecentContactWire; expiresAt: number };

export function useLiveRecentContacts(nativeRows: RecentContactWire[], scope: string) {
  const [pending, setPending] = useState<{ scope: string; rows: Map<string, PendingContact> }>();
  const nativeIds = useMemo(() => new Set(nativeRows.map((row) => row.targetUid)), [nativeRows]);
  const active = pending?.scope === scope ? pending : undefined;
  const rows = useMemo(() => {
    if (!active?.rows.size) return nativeRows;
    return [
      ...nativeRows,
      ...[...active.rows.values()]
        .filter(({ row }) => !nativeIds.has(row.targetUid))
        .map(({ row }) => row),
    ];
  }, [active, nativeIds, nativeRows]);

  useEffect(() => {
    if (!active?.rows.size) return;
    const prune = () => {
      setPending((current) => {
        if (current !== active) return current;
        const now = Date.now();
        const rows = new Map(
          [...current.rows].filter(([uid, row]) => !nativeIds.has(uid) && row.expiresAt > now),
        );
        return rows.size === current.rows.size ? current : { scope, rows };
      });
    };
    if ([...active.rows.keys()].some((uid) => nativeIds.has(uid))) {
      prune();
      return;
    }
    const next = Math.min(...[...active.rows.values()].map(({ expiresAt }) => expiresAt));
    const timer = setTimeout(prune, Math.max(0, next - Date.now()));
    return () => clearTimeout(timer);
  }, [active, nativeIds, scope]);

  const observe = useStableCallback(
    (kind: 'c2c' | 'group', uid: string, peer: QqLivePeer, message: MessageWire) => {
      if (!scope || nativeIds.has(uid)) return;
      const tempSourceGroupCode = /^\d+$/.test(peer.tempSourceGroupCode ?? '')
        ? peer.tempSourceGroupCode!
        : '0';
      const chatType =
        kind === 'group'
          ? ChatType.KCHATTYPEGROUP
          : peer.temporary
            ? tempSourceGroupCode === '0'
              ? ChatType.KCHATTYPETEMPC2CFROMUNKNOWN
              : ChatType.KCHATTYPETEMPC2CFROMGROUP
            : ChatType.KCHATTYPEC2C;
      const row: RecentContactWire = {
        chatType,
        targetUid: uid,
        targetUin: peer.peerUin || (kind === 'group' ? uid : ''),
        targetDisplayName: peer.peerName ?? '',
        senderUid: message.senderUid,
        msgSeq: message.msgSeq,
        sendTime: message.sendTime,
        preview: messageElementsPreview(message.elements),
        topTime: '0',
        pinned: false,
        senderDisplayName: '',
        senderNick: '',
        senderRemark: '',
        targetAvatar: '',
        targetRemark: '',
        targetGroupNick: '',
        notifyLevel: 0,
        tempSourceGroupCode,
      };
      setPending((current) => {
        const rows = new Map(current?.scope === scope ? current.rows : []);
        const old = rows.get(uid)?.row;
        if (old && !recentContactPreviewIsBehind(old, message)) return current;
        rows.delete(uid);
        rows.set(uid, { row, expiresAt: Date.now() + PENDING_CONTACT_MS });
        while (rows.size > 256) rows.delete(rows.keys().next().value!);
        return { scope, rows };
      });
    },
  );
  return { rows, observe };
}
