import {
  createReadStream,
  existsSync,
  openSync,
  closeSync,
  writeSync,
  fsyncSync,
  truncateSync,
  statSync,
} from 'node:fs';
import { createInterface } from 'node:readline';
import { createHash } from 'node:crypto';
import { sequenceCoverage } from './sequence_coverage';
import type { RenderGroupMsg, RenderC2cMsg } from '../msg';
import { messageSelectionKey } from '../message_filter';

type Message = RenderGroupMsg | RenderC2cMsg;
const transient = new Set(['elementId', 'isSender', 'localPath', 'exportPath', 'forwardMessages']);
function normalized(value: unknown): unknown {
  if (typeof value === 'bigint') return String(value);
  if (!value || typeof value !== 'object') return value;
  if (Array.isArray(value)) return value.map(normalized);
  if (ArrayBuffer.isView(value))
    return Array.from(new Uint8Array(value.buffer, value.byteOffset, value.byteLength));
  const record = value as Record<string, unknown>;
  if (record.type === 'Buffer' && Array.isArray(record.data)) return record.data;
  return Object.fromEntries(
    Object.keys(record)
      .filter((key) => !transient.has(key))
      .sort()
      .map((key) => [key, normalized(record[key])]),
  );
}
function contentHash(row: Message): string {
  return createHash('sha256')
    .update(
      JSON.stringify({
        sendTime: String(row.sendTime),
        senderUin: String(row.senderUin),
        senderUid: row.senderUid,
        elements: normalized(row.elements),
      }),
    )
    .digest('hex');
}

/** 消息确认写入后才交给格式器；正文格式可重建，消息断点不依赖源库的 mtime。 */
export class MessageJournal {
  sealed = false;
  count = 0;
  readonly conflicts = { count: 0, messageIds: [] as string[] };
  sourceCompared = false;
  private sequences = new Set<bigint>();

  mergeWarnings(kind: 'group' | 'c2c', conv: string) {
    const coverage = sequenceCoverage(
      { seqs: [...this.sequences], below: null, above: null },
      [],
      kind,
      conv,
    );
    return {
      conflictingMessages: this.conflicts.count,
      conflictMessageIds: this.conflicts.messageIds,
      sequenceGapCount: coverage.rangeCount,
      sequenceGaps: coverage.ranges,
      basis: coverage.basis,
      ...(this.sourceCompared
        ? {
            contentComparisonScope:
              'logical message time, sender and render body; excludes cache-only forward expansion, local paths and element identifiers',
          }
        : {}),
    };
  }

  async inspectWarnings(kind: 'group' | 'c2c', conv: string) {
    if (this.count === 0)
      for await (const row of this.replay<Message>())
        if (row.msgSeq > 0n) this.sequences.add(row.msgSeq);
    return this.mergeWarnings(kind, conv);
  }

  constructor(
    readonly path: string,
    private readonly signal?: AbortSignal,
    private readonly exactSelection = false,
  ) {}

  async *replay<T extends Message>(): AsyncGenerator<T> {
    if (!existsSync(this.path)) return;
    const stream = createReadStream(this.path);
    const lines = createInterface({ input: stream, crlfDelay: Infinity });
    let bytes = 0;
    const length = statSync(this.path).size;
    try {
      for await (const line of lines) {
        this.signal?.throwIfAborted();
        // 每条记录都有换行提交标记；断电留下的尾行不算已确认消息。
        const size = Buffer.byteLength(line) + 1;
        if (bytes + size > length) break;
        const row = JSON.parse(line, (_key, value) =>
          value && typeof value === 'object' && typeof value.$weqBigInt === 'string'
            ? BigInt(value.$weqBigInt)
            : value,
        ) as T;
        bytes += size;
        yield row;
      }
    } finally {
      lines.close();
      stream.destroy();
    }
  }

  async *capture<T extends Message>(
    source: AsyncGenerator<T>,
    prepare?: (row: T) => Promise<void>,
  ): AsyncGenerator<T> {
    const seen = new Map<string, string>();
    const replayOnly = this.sealed;
    const collectSequences = !replayOnly || this.sequences.size === 0;
    let committed = 0;
    this.count = 0;
    for await (const row of this.replay<T>()) {
      if (!replayOnly) {
        seen.set(this.identity(row), contentHash(row));
        committed += Buffer.byteLength(this.serialize(row));
      }
      if (collectSequences && row.msgSeq > 0n) this.sequences.add(row.msgSeq);
      this.count++;
      yield row;
    }
    if (replayOnly) return;
    if (existsSync(this.path)) truncateSync(this.path, committed);
    const fd = openSync(this.path, 'a');
    try {
      this.sourceCompared = true;
      for await (const row of source) {
        this.signal?.throwIfAborted();
        const key = this.identity(row);
        const digest = contentHash(row);
        const existing = seen.get(key);
        if (existing) {
          if (existing !== digest) {
            this.conflicts.count++;
            if (this.conflicts.messageIds.length < 50)
              this.conflicts.messageIds.push(String(row.msgId));
          }
          continue;
        }
        await prepare?.(row);
        const bytes = Buffer.from(this.serialize(row));
        for (let offset = 0; offset < bytes.length; ) {
          const written = writeSync(fd, bytes, offset, bytes.length - offset);
          if (!written) throw new Error('消息断点写入未取得进展。');
          offset += written;
        }
        seen.set(key, digest);
        if (row.msgSeq > 0n) this.sequences.add(row.msgSeq);
        this.count++;
        yield row;
      }
      this.sealed = true;
    } finally {
      try {
        fsyncSync(fd);
      } finally {
        closeSync(fd);
      }
      await source.return(undefined);
    }
  }

  private serialize(row: Message): string {
    return `${JSON.stringify(row, (_key, value) => (typeof value === 'bigint' ? { $weqBigInt: String(value) } : value))}\n`;
  }

  private identity(row: Message): string {
    return (this.exactSelection ? messageSelectionKey(row) : null) ?? row.msgId.toString();
  }
}
