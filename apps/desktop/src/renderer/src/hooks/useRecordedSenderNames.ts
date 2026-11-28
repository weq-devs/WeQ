import { useEffect, useRef, useState } from 'react';
import { client } from '../trpc/client';
import type { QQWriteBinding } from './useQQWriteSession';

type StoredName = Awaited<
  ReturnType<typeof client.account.recordedGroupSenderNames.query>
>[number]['sender'];
type WindowRow = { msgId: string; source?: string };
type Snapshot = { scope: string; names: ReadonlyMap<string, StoredName | null> };
const EMPTY_ROWS: readonly WindowRow[] = [];

export function useRecordedSenderNames(
  target: { kind: 'group' | 'c2c'; conv: string } | null,
  binding: QQWriteBinding | null | undefined,
  rows: readonly WindowRow[],
) {
  const uin = binding?.expectedAccountUin;
  const configId = binding?.expectedAccountConfigId;
  const kind = target?.kind;
  const conv = target?.conv;
  const scope = kind && conv && uin && configId ? JSON.stringify([uin, configId, kind, conv]) : '';
  const activeRows = scope ? rows : EMPTY_ROWS;
  const cache = useRef<Snapshot>(undefined);
  const [snapshot, setSnapshot] = useState<Snapshot>();

  useEffect(() => {
    if (!scope || !kind || !conv || !uin || !configId) {
      if (cache.current) {
        cache.current = undefined;
        setSnapshot(undefined);
      }
      return;
    }
    const names = new Map(cache.current?.scope === scope ? cache.current.names : undefined);
    const ids = [
      ...new Set(
        activeRows.flatMap((row) =>
          row.source !== 'roaming' && /^-?\d{1,20}$/.test(row.msgId) ? [row.msgId] : [],
        ),
      ),
    ];
    const visible = new Set(ids);
    for (const id of names.keys()) if (!visible.has(id)) names.delete(id);
    const missing = ids.filter((id) => !names.has(id));
    if (!missing.length) {
      cache.current = { scope, names };
      return;
    }
    const controller = new AbortController();
    const read = async () => {
      for (let offset = 0; offset < missing.length; offset += 200) {
        const batch = missing.slice(offset, offset + 200);
        const input = {
          expectedAccountUin: uin,
          expectedAccountConfigId: configId,
          msgIds: batch,
        };
        const options = { signal: controller.signal };
        const result =
          kind === 'group'
            ? await client.account.recordedGroupSenderNames.query(
                { ...input, groupCode: conv },
                options,
              )
            : await client.account.recordedC2cSenderNames.query(
                { ...input, peerUid: conv },
                options,
              );
        if (controller.signal.aborted) return;
        for (const id of batch) names.set(id, null);
        for (const { msgId, sender } of result) names.set(msgId, sender);
        cache.current = { scope, names };
        if (result.length) setSnapshot({ scope, names: new Map(names) });
      }
    };
    void read().catch((error: unknown) => {
      if (!controller.signal.aborted) console.warn('[消息] 读取历史称呼失败', error);
    });
    return () => controller.abort();
  }, [scope, kind, conv, uin, configId, activeRows]);

  return scope && snapshot?.scope === scope ? snapshot.names : undefined;
}
