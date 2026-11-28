import { compareMessageOrder } from '@weq/codec';

export interface TimelineRow {
  sourceFormat?: 'native' | 'protocol';
  sendTime?: string;
  msgRandom?: string;
  localSent?: boolean;
  sentFromWeq?: true;
  livePush?: true;
  senderUid?: string;
  elements?: readonly unknown[];
  msgId: string;
  msgSeq: string;
  source?: 'roaming';
  ntSeqVerified?: boolean;
  recall?: { revokeUid: string; sameSender: boolean; recallTs: number; retained?: true };
}

export function timelineSeq(value: string): bigint | null {
  try {
    const seq = BigInt(value);
    return seq > 0n ? seq : null;
  } catch {
    return null;
  }
}

/** Server history IDs can be client randoms, not local snowflake IDs. */
export function timelineRowKey(row: TimelineRow): string {
  return row.source === 'roaming'
    ? `roaming:${row.sourceFormat ? `${row.sourceFormat}:` : ''}${row.msgSeq}:${row.msgId}`
    : row.msgId;
}

export function timelineMessageIdentity(row: TimelineRow): string | null {
  return row.msgRandom && row.msgRandom !== '0' && row.senderUid
    ? `${row.msgSeq}:${row.msgRandom}:${row.senderUid}`
    : null;
}

export function verifiedTimelineIdentity(kind: 'c2c' | 'group', row: TimelineRow): string | null {
  return (kind === 'group' || row.ntSeqVerified === true) && timelineSeq(row.msgSeq) !== null
    ? timelineMessageIdentity(row)
    : null;
}

export function voiceFileHash(data: {
  fileName?: unknown;
  md5?: unknown;
  md5Bytes?: unknown;
}): string {
  for (const hash of [data.md5, data.md5Bytes]) {
    if (typeof hash === 'string' && /^[a-f0-9]{32}$/i.test(hash)) return hash.toLowerCase();
  }
  return /^([a-f0-9]{32})\.amr$/i.exec(String(data.fileName ?? ''))?.[1]?.toLowerCase() ?? '';
}

/** 旧版语音转写可能改过 QQ 的 random，用原音频核对这类发送缓存。 */
export function sentVoiceIdentity(row: TimelineRow): string | null {
  if (!row.senderUid || !row.sendTime || row.elements?.length !== 1) return null;
  const element = row.elements[0] as { type?: string; data?: Record<string, unknown> } | null;
  if (element?.type !== 'ptt' || !element.data) return null;
  const hash = voiceFileHash(element.data);
  return hash ? `${row.msgSeq}:${row.sendTime}:${row.senderUid}:${hash}` : null;
}

/** Fill the currently loaded window without extending it or re-anchoring history to latest. */
export function mergeRoamingWindow<T extends TimelineRow>(
  kind: 'c2c' | 'group',
  local: T[],
  cached: T[],
): T[] {
  const first = local.find((row) => timelineSeq(row.msgSeq) !== null);
  const last = local.findLast((row) => timelineSeq(row.msgSeq) !== null);
  if (!first || !last) return local;
  const incoming = cached.filter((row) => {
    const seq = timelineSeq(row.msgSeq);
    return seq !== null && seq >= BigInt(first.msgSeq) && seq <= BigInt(last.msgSeq);
  });
  return incoming.length ? mergeRoamingTimeline(kind, local, incoming) : local;
}

function uniqueBodies<T extends TimelineRow>(rows: T[], seqs: ReadonlySet<string>) {
  const unique = new Map<string, T | null>();
  for (const row of rows) {
    if (!seqs.has(row.msgSeq) || !row.elements?.length) continue;
    if (
      row.elements.some((element) => {
        const type = (element as { type?: unknown } | null)?.type;
        return typeof type === 'string' && type.startsWith('grayTip');
      })
    )
      continue;
    const keys = row.senderUid ? [row.msgSeq, `${row.msgSeq}:${row.senderUid}`] : [row.msgSeq];
    for (const key of keys) {
      if (!unique.has(key)) unique.set(key, row);
      else if (unique.get(key)?.msgId !== row.msgId) unique.set(key, null);
    }
  }
  return unique;
}

/** 同序号多条正文时先按发送者消歧，双边各只有一条时允许发送者缺失。 */
function matchUniqueBody<T extends TimelineRow>(
  row: T,
  own: ReadonlyMap<string, T | null>,
  other: ReadonlyMap<string, T | null>,
): T | undefined {
  if (row.senderUid) {
    const key = `${row.msgSeq}:${row.senderUid}`;
    const match = other.get(key);
    if (match && own.get(key)?.msgId === row.msgId) return match;
  }
  const match = other.get(row.msgSeq);
  if (
    match &&
    own.get(row.msgSeq)?.msgId === row.msgId &&
    (!row.senderUid || !match.senderUid || row.senderUid === match.senderUid)
  )
    return match;
}

/** 同身份撤回副本优先显示原文，普通缓存补齐缺口，并保留同序号的其他灰条。 */
export function mergeRoamingTimeline<T extends TimelineRow>(
  kind: 'c2c' | 'group',
  local: T[],
  cached: T[],
  options: { descending?: boolean; limit?: number; min?: bigint; max?: bigint } = {},
): T[] {
  const identity = timelineMessageIdentity;
  const recordKey = (row: T) => `${row.msgSeq}:${row.msgId}`;
  const allCached = [...local.filter((row) => row.source === 'roaming'), ...cached];
  const recalled = allCached.filter((row) => {
    const seq = timelineSeq(row.msgSeq);
    return (
      row.recall &&
      seq !== null &&
      (kind !== 'c2c' || row.ntSeqVerified === true) &&
      (options.min === undefined || seq >= options.min) &&
      (options.max === undefined || seq <= options.max)
    );
  });
  const retained = recalled.filter((row) => row.recall?.retained);
  const sentCopies = new Set<T>();
  const retainedFromWeq = new Set<string>();
  if (retained.length) {
    // 防撤回存档用 QQ 记录 ID，WeQ 发送缓存可能用 random 作 ID。
    const retainedSeqs = new Set(retained.map((row) => row.msgSeq));
    const sent = allCached.filter(
      (row) =>
        row.localSent &&
        !row.recall?.retained &&
        retainedSeqs.has(row.msgSeq) &&
        (kind === 'group' || row.ntSeqVerified === true),
    );
    const retainedByIdentity = new Map(retained.map((row) => [identity(row), row]));
    const retainedBodies = uniqueBodies(retained, retainedSeqs);
    const sentBodies = uniqueBodies(sent, retainedSeqs);
    for (const row of sent) {
      const key = identity(row);
      const match =
        (key && retainedByIdentity.get(key)) || matchUniqueBody(row, sentBodies, retainedBodies);
      if (!match) continue;
      sentCopies.add(row);
      retainedFromWeq.add(recordKey(match));
    }
  }
  const cachedRows = sentCopies.size ? allCached.filter((row) => !sentCopies.has(row)) : allCached;
  const protectedRows = sentCopies.size ? recalled.filter((row) => !sentCopies.has(row)) : recalled;
  const protectedIds = new Set([...protectedRows, ...sentCopies].map(recordKey));
  const protectedKeys = new Set([...protectedRows, ...sentCopies].map(identity).filter(Boolean));
  let result = local.filter(
    (row) =>
      row.source !== 'roaming' &&
      !protectedKeys.has(identity(row)) &&
      !protectedIds.has(recordKey(row)),
  );
  if (protectedRows.length && result.length) {
    const protectedSeqs = new Set(protectedRows.map((row) => row.msgSeq));
    const localBodies = uniqueBodies(
      local.filter((row) => row.source !== 'roaming'),
      protectedSeqs,
    );
    const protectedBodies = uniqueBodies(protectedRows, protectedSeqs);
    result = result.filter((row) => !matchUniqueBody(row, localBodies, protectedBodies));
  }
  const localSeqs = new Set(result.map((row) => row.msgSeq));
  const localIds = new Set(result.map((row) => row.msgId));
  const localIdentities = new Set(result.map(identity).filter(Boolean));
  const localVoices = new Set(result.map(sentVoiceIdentity).filter(Boolean));
  const nativeRandoms = new Set(
    [...local, ...cached]
      .filter((row) => row.sourceFormat && row.msgRandom && row.msgRandom !== '0')
      .map((row) => `${row.msgSeq}:${row.msgRandom}:${row.senderUid ?? ''}`),
  );
  const added = new Set<string>();
  const candidates = [...protectedRows, ...cachedRows].filter(
    (row) => row.recall || !protectedKeys.has(identity(row)),
  );
  const sentIdentities = new Set<string>();
  const syncedIdentities = new Set<string>();
  const historyIdentities = new Set<string>();
  for (const row of candidates) {
    const key = verifiedTimelineIdentity(kind, row);
    if (!key) continue;
    if (row.localSent || row.sentFromWeq) sentIdentities.add(key);
    if (row.localSent || !row.sourceFormat) continue;
    syncedIdentities.add(key);
    if (!row.livePush) historyIdentities.add(key);
  }
  for (const row of candidates) {
    const seq = timelineSeq(row.msgSeq);
    const key = identity(row);
    const addedKey = row.sourceFormat || row.recall?.retained ? recordKey(row) : row.msgSeq;
    if (
      seq === null ||
      (row.localSent && key !== null && syncedIdentities.has(key)) ||
      (row.livePush && key !== null && historyIdentities.has(key)) ||
      (kind === 'c2c' && row.ntSeqVerified !== true) ||
      (options.min !== undefined && seq < options.min) ||
      (options.max !== undefined && seq > options.max) ||
      (!row.recall &&
        (row.sourceFormat
          ? localIds.has(row.msgId) ||
            (row.sourceFormat === 'protocol' &&
              (localIdentities.has(key) ||
                (row.localSent && localVoices.has(sentVoiceIdentity(row)))))
          : localSeqs.has(row.msgSeq) ||
            nativeRandoms.has(
              `${row.msgSeq}:${row.msgRandom || row.msgId}:${row.senderUid ?? ''}`,
            ))) ||
      added.has(addedKey)
    )
      continue;
    added.add(addedKey);
    result.push({
      ...row,
      source: 'roaming',
      ...(!row.localSent &&
      !row.sentFromWeq &&
      (retainedFromWeq.has(recordKey(row)) || (key !== null && sentIdentities.has(key)))
        ? { sentFromWeq: true }
        : {}),
    });
  }
  result.sort((a, b) => {
    const order = compareMessageOrder(a, b);
    return options.descending ? -order : order;
  });
  return options.limit === undefined ? result : result.slice(0, options.limit);
}
