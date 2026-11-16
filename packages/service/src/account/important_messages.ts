import type { HighlightKind, UnreadInfoSnapshot, UnreadInfoTarget } from '@weq/db';
import { JsonStore } from '../common/json_store';
import { writeFileAtomic } from '../common/atomic_write';

interface ImportantMessage extends UnreadInfoTarget {
  msgSeq: string;
  senderUid: string;
  sendTime: string;
  reasons: { kind: HighlightKind; rawKind: number; text: string }[];
}
const kinds = new Set<HighlightKind>([
  'atMe',
  'atAll',
  'replyMe',
  'specialCare',
  'groupKeyword',
  'newFile',
  'groupAnnouncement',
  'redPacket',
  'unknown',
]);
const sequence = (value: unknown): value is string =>
  typeof value === 'string' && /^[1-9]\d{0,19}$/.test(value);

/** 提醒索引与阅读水位分开保存；只观察 QQ 小表，不扫描消息历史。 */
export class ImportantMessageStore {
  private readonly file?: JsonStore<ImportantMessage[]>;
  private readonly rows = new Map<string, ImportantMessage>();
  private revision = 0;
  private savedRevision = 0;
  private writing?: Promise<void>;

  constructor(private readonly path?: string) {
    this.file = path ? new JsonStore(path, () => [], { normalize: storedMessages }) : undefined;
    for (const row of this.file?.data ?? []) this.rows.set(this.key(row), row);
  }

  private key(row: UnreadInfoTarget & { msgSeq: string }): string {
    return `${row.chatType}_${row.uid}:${row.msgSeq}`;
  }

  observe(snapshot: UnreadInfoSnapshot): void {
    if (snapshot.chatType !== 2 || snapshot.readError) return;
    for (const hit of snapshot.highlights ?? []) {
      if (!Number.isSafeInteger(hit.msgSeq) || hit.msgSeq <= 0) continue;
      const msgSeq = String(hit.msgSeq);
      const key = this.key({ ...snapshot, msgSeq });
      let row = this.rows.get(key);
      if (!row) {
        row = {
          chatType: snapshot.chatType,
          uid: snapshot.uid,
          msgSeq,
          senderUid: hit.senderUid,
          sendTime: String(hit.sendTime),
          reasons: [],
        };
        this.rows.set(key, row);
      }
      const reason = { kind: hit.kind, rawKind: hit.rawKind, text: hit.text.slice(0, 512) };
      const prior = row.reasons.find(
        (item) => item.rawKind === reason.rawKind && item.text === reason.text,
      );
      if (!prior) {
        row.reasons.push(reason);
        this.revision++;
      }
    }
  }

  list(
    input: UnreadInfoTarget & {
      kind?: HighlightKind;
      unreadOnly?: boolean;
      readSeq?: string;
      before?: string;
      limit: number;
    },
  ) {
    this.file?.assertReadable();
    const floor = BigInt(input.readSeq ?? '0');
    const rows = [...this.rows.values()]
      .filter(
        (row) =>
          row.chatType === input.chatType &&
          row.uid === input.uid &&
          (!input.before || BigInt(row.msgSeq) < BigInt(input.before)) &&
          (!input.kind || row.reasons.some((reason) => reason.kind === input.kind)) &&
          (!input.unreadOnly || (input.readSeq !== undefined && BigInt(row.msgSeq) > floor)),
      )
      .sort((a, b) => (BigInt(a.msgSeq) > BigInt(b.msgSeq) ? -1 : 1));
    const items = rows.slice(0, input.limit).map((row) => ({
      ...row,
      reasons: row.reasons.map((reason) => ({ ...reason })),
      unread: input.readSeq !== undefined && BigInt(row.msgSeq) > floor,
    }));
    return { items, nextBefore: rows.length > input.limit ? items.at(-1)!.msgSeq : null };
  }

  async flush(): Promise<void> {
    this.file?.assertReadable();
    if (!this.path) return;
    const requested = this.revision;
    while (this.savedRevision < requested) {
      if (!this.writing) {
        this.writing = Promise.resolve()
          .then(async () => {
            const revision = this.revision;
            await writeFileAtomic(this.path!, JSON.stringify([...this.rows.values()]));
            this.savedRevision = revision;
          })
          .finally(() => {
            this.writing = undefined;
          });
      }
      await this.writing;
    }
  }
}

function storedMessages(raw: unknown): ImportantMessage[] {
  if (!Array.isArray(raw)) throw new Error('重要消息记录格式错误，原文件已保留');
  return raw.map((value: unknown) => {
    if (!value || typeof value !== 'object') throw new Error('重要消息记录损坏');
    const row = value as Partial<ImportantMessage>;
    if (
      !Number.isSafeInteger(row.chatType) ||
      typeof row.uid !== 'string' ||
      !row.uid ||
      !sequence(row.msgSeq) ||
      typeof row.senderUid !== 'string' ||
      typeof row.sendTime !== 'string' ||
      !/^\d+$/.test(row.sendTime) ||
      !Array.isArray(row.reasons) ||
      !row.reasons.length ||
      !row.reasons.every(
        (reason) =>
          reason &&
          kinds.has(reason.kind) &&
          Number.isSafeInteger(reason.rawKind) &&
          typeof reason.text === 'string',
      )
    )
      throw new Error('重要消息记录损坏，原文件已保留');
    return row as ImportantMessage;
  });
}
