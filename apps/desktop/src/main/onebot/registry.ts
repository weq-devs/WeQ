import { z } from 'zod';
import { JsonStore } from '@weq/service';
import { appendFileSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import type { BridgeMessage } from './server';

const locationSchema = z.object({
  conv: z.string(),
  msgId: z.string().optional(),
  msgSeq: z.number().int().nonnegative(),
  clientSeq: z.number().int().nonnegative(),
  random: z.number().int().nonnegative(),
});
export type MessageLocation = z.infer<typeof locationSchema>;
const entrySchema = z.object({
  id: z.number().int().min(-2147483647).max(-1),
  key: z.string(),
  peerType: z.enum(['c2c', 'group']),
  targetId: z.string(),
  senderUin: z.number(),
  nickname: z.string(),
  time: z.number(),
  sequence: z.number(),
  location: locationSchema.optional(),
  fileId: z.string().optional(),
  fileName: z.string().optional(),
  fileSize: z.number().optional(),
  forwardId: z.string().optional(),
  registeredAt: z.number(),
  revision: z.number().int().nonnegative().default(0),
});
const stateSchema = z.object({
  next: z.number().int().min(-2147483648).max(-1),
  entries: z.array(entrySchema).max(8192),
  revision: z.number().int().nonnegative().default(0),
});
type Entry = z.infer<typeof entrySchema>;

/** 仅保存身份元数据；过期 ID 不再分配给另一条消息。 */
export class MessageRegistry {
  private readonly entries = new Map<number, Entry>();
  private readonly aliases = new Map<string, number>();
  private readonly quotes = new Map<string, Set<number>>();
  private next = -1;
  private reserved = -1;
  private readonly store?: JsonStore<z.infer<typeof stateSchema>>;
  private timer?: ReturnType<typeof setTimeout>;
  private lastPrune = 0;
  private revision = 0;
  private readonly pending = new Map<number, Entry>();
  private readonly journalPath?: string;
  private journalBytes = 0;
  private journalRecords = 0;
  private persistenceError: unknown;

  constructor(path?: string) {
    if (path) {
      this.store = new JsonStore(path, () => ({ next: -1, entries: [], revision: 0 }), {
        strict: true,
        normalize: (raw) => stateSchema.parse(raw),
      });
      this.next = this.store.data.next;
      this.reserved = this.next;
      this.revision = this.store.data.revision;
      for (const entry of this.store.data.entries) {
        if (this.entries.has(entry.id) || entry.id <= this.next)
          throw new Error('OneBot 消息索引 ID 无效');
        this.entries.set(entry.id, entry);
      }
      this.journalPath = `${path}.journal`;
      try {
        this.journalBytes = statSync(this.journalPath).size;
        if (this.journalBytes > 8 * 1024 * 1024)
          throw new Error('OneBot 消息索引日志超过上限，原件保留');
        const content = readFileSync(this.journalPath, 'utf8');
        const lines = content.split('\n');
        // 仅忽略意外退出留下的未完成尾行，完整行损坏必须保留原件并报错。
        lines.pop();
        for (const line of lines) {
          if (!line) continue;
          const entry = entrySchema.parse(JSON.parse(line));
          this.journalRecords++;
          if (entry.id <= this.next) throw new Error('OneBot 日志的消息 ID 无效');
          if (entry.revision <= this.store.data.revision) continue;
          if (entry.revision <= this.revision) throw new Error('OneBot 索引日志次序无效');
          this.revision = entry.revision;
          this.entries.delete(entry.id);
          this.entries.set(entry.id, entry);
        }
        if (!content.endsWith('\n') && content.length) {
          // 先提交已确认的完整日志，避免下一次 append 与残尾拼成伪记录。
          this.checkpoint();
        }
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      }
      for (const [id, entry] of this.entries) {
        for (const key of this.keys(entry)) this.aliases.set(key, id);
        this.addQuote(entry, id);
      }
      this.prune();
    }
  }

  private keys(msg: Omit<BridgeMessage, 'message'>): string[] {
    const prefix = `${msg.peerType}:${msg.targetId}:${msg.senderUin}`;
    return [
      ...(msg.location?.msgId ? [`msg:${prefix}:${msg.location.msgId}`] : []),
      ...(msg.location?.random ? [`random:${prefix}:${msg.location.random}:${msg.time}`] : []),
      `key:${prefix}:${msg.key}`,
    ];
  }

  private quoteKey(msg: Omit<BridgeMessage, 'message'>): string | undefined {
    const sequence =
      msg.peerType === 'group'
        ? msg.location?.msgSeq || msg.sequence
        : msg.location?.clientSeq || msg.sequence;
    return sequence > 0
      ? `${msg.peerType}:${msg.targetId}:${msg.senderUin}:${sequence}:${msg.time}`
      : undefined;
  }

  private addQuote(msg: Omit<BridgeMessage, 'message'>, id: number): void {
    const key = this.quoteKey(msg);
    if (!key) return;
    const candidates = this.quotes.get(key) ?? new Set<number>();
    candidates.add(id);
    this.quotes.set(key, candidates);
  }

  find(msg: Omit<BridgeMessage, 'message'>): number | undefined {
    for (const key of this.keys(msg)) {
      const found = this.aliases.get(key);
      if (found !== undefined) return found;
    }
    const key = this.quoteKey(msg);
    const candidates = key ? this.quotes.get(key) : undefined;
    if (candidates?.size !== 1) return undefined;
    const candidate = candidates.values().next().value!;
    const previous = this.entries.get(candidate);
    // seq/time 只是引用候选，不能合并两条已有真实身份的消息。
    if (
      (msg.location?.msgId || msg.location?.random) &&
      (previous?.location?.msgId || previous?.location?.random)
    )
      return undefined;
    return candidate;
  }

  remember(msg: BridgeMessage): number {
    let id = this.find(msg);
    if (id === undefined) {
      if (this.next < -2147483647) throw new Error('OneBot 消息 ID 已用尽');
      // 先落盘预留一批 ID；进程意外退出也不会把旧 ID 发给新消息。
      if (this.store && this.next === this.reserved) {
        const previous = this.reserved;
        this.reserved = Math.max(-2147483648, this.next - 4096);
        try {
          this.checkpoint();
        } catch (error) {
          this.reserved = previous;
          throw error;
        }
      }
      id = this.next--;
    }
    const old = this.entries.get(id);
    const { message: _message, ...metadata } = msg;
    const loc = msg.location ?? old?.location;
    const entry: Entry = {
      ...old,
      ...metadata,
      id,
      registeredAt: Date.now(),
      revision: ++this.revision,
      location: loc
        ? {
            ...loc,
            msgId: msg.location?.msgId ?? old?.location?.msgId,
            msgSeq: msg.location?.msgSeq || old?.location?.msgSeq || 0,
            clientSeq: msg.location?.clientSeq || old?.location?.clientSeq || 0,
            random: msg.location?.random || old?.location?.random || 0,
          }
        : undefined,
    };
    this.entries.delete(id);
    this.entries.set(id, entry);
    this.pending.set(id, entry);
    this.addQuote(entry, id);
    // 登记完整身份后仍保留已发出的引用占位别名。
    for (const key of this.keys(entry)) this.aliases.set(key, id);
    for (const key of this.keys(msg)) this.aliases.set(key, id);
    this.prune();
    if (this.store && !this.timer) {
      this.timer = setTimeout(() => {
        try {
          this.flush();
        } catch (error) {
          this.persistenceError = error;
          console.error('OneBot 消息索引保存失败', error);
        }
      }, 250);
      this.timer.unref();
    }
    return id;
  }

  get(id: number): BridgeMessage | undefined {
    const entry = this.entries.get(id);
    if (!entry || entry.registeredAt < Date.now() - 30 * 86400 * 1000) return undefined;
    const { id: _id, registeredAt: _registeredAt, revision: _revision, ...msg } = entry;
    return { ...msg, message: [] };
  }

  forward(id: string): BridgeMessage | undefined {
    for (const [key, entry] of this.entries) if (entry.forwardId === id) return this.get(key);
    return undefined;
  }

  private prune(): void {
    const now = Date.now();
    if (this.entries.size <= 8192 && now - this.lastPrune < 60000) return;
    this.lastPrune = now;
    for (const [id, entry] of this.entries) {
      if (this.entries.size <= 8192 && entry.registeredAt >= now - 30 * 86400 * 1000) continue;
      this.entries.delete(id);
    }
    for (const [key, id] of this.aliases) if (!this.entries.has(id)) this.aliases.delete(key);
    for (const [key, candidates] of this.quotes) {
      for (const id of candidates) if (!this.entries.has(id)) candidates.delete(id);
      if (!candidates.size) this.quotes.delete(key);
    }
  }

  flush(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
    if (!this.store || !this.journalPath || !this.pending.size) return;
    if (this.persistenceError) {
      this.checkpoint();
      return;
    }
    const entries = [...this.pending.values()]
      .filter((entry) => this.entries.has(entry.id))
      .sort((a, b) => a.revision - b.revision);
    const body = entries.map((entry) => `${JSON.stringify(entry)}\n`).join('');
    try {
      appendFileSync(this.journalPath, body, { mode: 0o600 });
      this.pending.clear();
      this.journalBytes += Buffer.byteLength(body);
      this.journalRecords += entries.length;
      if (this.journalRecords >= 1024 || this.journalBytes >= 2 * 1024 * 1024) this.checkpoint();
      this.persistenceError = undefined;
    } catch (error) {
      this.persistenceError = error;
      throw error;
    }
  }

  get healthy(): boolean {
    return !this.persistenceError;
  }

  private checkpoint(): void {
    if (!this.store || !this.journalPath) return;
    this.prune();
    try {
      this.store.replace({
        next: this.reserved,
        revision: this.revision,
        entries: [...this.entries.values()],
      });
      writeFileSync(this.journalPath, '', { mode: 0o600 });
      this.pending.clear();
      this.journalBytes = 0;
      this.journalRecords = 0;
      this.persistenceError = undefined;
    } catch (error) {
      this.persistenceError = error;
      throw error;
    }
  }
}
