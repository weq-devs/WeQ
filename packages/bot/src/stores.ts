/**
 * bot 侧的 store 实现（JSON 落盘），满足 AgentRuntime 的各 Sink 接口。
 * 数据落在产物的 data/ 目录；损坏原件拒绝加载，原子保存成功后才发布内存变更。
 *
 * 热路径内存约定（配合 BotJsonFile 的冻结发布）：
 * - 已发布数据整树冻结，读取返回「新数组 + 逐条浅拷贝」而不是整库 structuredClone：
 *   标量字段的修改对存储无害（与旧深拷贝语义一致），嵌套数组（记忆向量、关键词）
 *   共享冻结引用，原地改写会抛 TypeError 而不是静默污染存储。
 * - 写入用最小新鲜副本：只为「本次新增或变更的条目」构造新对象，未变更条目直接共享冻结引用，
 *   由 replace 的所有权转移 + 增量冻结完成发布。传入 replace / upsert / append 的新对象
 *   所有权移交存储，调用方不得保留引用再修改。
 */
import { createHash } from 'node:crypto';
import {
  keywordsOf,
  makeBaseRelation,
  applyRelationDelta,
  type AgentLabMemoryItem,
  type AgentLabPersonaNotes,
  type AgentLabRelation,
  type AgentLabRelationStore,
  type AgentLabMemberKind,
  type ConversationSink,
  type ConversationTurnLike,
  type MemorySink,
  type NotesSink,
  type UsageSink,
} from '@weq/agentlab';
import { BotJsonFile, isDictionary, isRecord, isStrings, isNumber, own } from './json_file';
import { openBucketed, type BucketedJsonDir } from './bucketed_store';

export const MAX_TURNS = 400;
export const MAX_MEMORIES = 200;

/**
 * 存储布局选项：
 * - `bucketed=true`：conversations / memories 改为「每键一个文件」的分桶目录
 *   （`<name>.json` → `<name>.d/`；旧单文件自动迁移并保留为 `.migrated`），
 *   写入只动单键文件、内存只驻留热桶（LRU）；
 * - 缺省 false：单文件布局（BotJsonFile），与历史行为完全一致。
 * 笔记 / 关系库体量小（每对端几十～几百字节），不分桶。
 */
export interface BotStoreOptions {
  bucketed?: boolean;
  /** 分桶模式的内存 LRU 桶数上限（默认 64；淘汰只丢内存副本，数据永远已落盘）。 */
  maxCachedBuckets?: number;
}

function bucketedDirOf(filePath: string): string {
  return `${filePath.replace(/\.json$/i, '')}.d`;
}

function isTurns(raw: unknown): raw is ConversationTurnLike[] {
  return (
    Array.isArray(raw) &&
    raw.every(
      (t) =>
        isRecord(t) &&
        (t.role === 'user' || t.role === 'assistant') &&
        typeof t.text === 'string' &&
        isNumber(t.ts),
    )
  );
}
/**
 * 冻结条目在发布前必然已通过校验（BotJsonFile 的发布不变量），重复 replace 时跳过昂贵的
 * 字段级扫描（向量 / 关键词逐项检查），把校验成本收敛到「本次新增 / 变更」的条目。
 * isRecord 前置保证原始值不会借 Object.isFrozen(非对象)=true 混过校验；
 * 调用方不得注入外部自行冻结的未校验数据。
 */
function isMemories(raw: unknown): raw is AgentLabMemoryItem[] {
  return (
    Array.isArray(raw) &&
    raw.every(
      (m) =>
        isRecord(m) &&
        (Object.isFrozen(m) ||
          (typeof m.id === 'string' &&
            typeof m.text === 'string' &&
            isStrings(m.keywords) &&
            isNumber(m.accessCount) &&
            isNumber(m.createdAt) &&
            isNumber(m.lastAccessedAt) &&
            (m.embedding === undefined ||
              (Array.isArray(m.embedding) && m.embedding.every(isNumber))) &&
            (m.aboutId === undefined || typeof m.aboutId === 'string') &&
            (m.aboutKind === undefined || m.aboutKind === 'user' || m.aboutKind === 'persona'))),
    )
  );
}
function isNotes(raw: unknown): raw is AgentLabPersonaNotes {
  return isRecord(raw) && isStrings(raw.corrections) && isStrings(raw.episodes);
}
interface NotesData {
  notes?: Record<string, AgentLabPersonaNotes>;
  reflected?: Record<string, number>;
}
function isNotesData(raw: unknown): raw is NotesData {
  return (
    isRecord(raw) &&
    Object.keys(raw).every((key) => key === 'notes' || key === 'reflected') &&
    (raw.notes === undefined || isDictionary(raw.notes, isNotes)) &&
    (raw.reflected === undefined ||
      isDictionary(raw.reflected, (n): n is number => isNumber(n) && n >= 0 && Number.isInteger(n)))
  );
}
function isRelation(raw: unknown): raw is AgentLabRelation {
  return (
    isRecord(raw) &&
    typeof raw.subjectPersonaId === 'string' &&
    typeof raw.objectId === 'string' &&
    (raw.objectKind === 'user' || raw.objectKind === 'persona') &&
    [
      raw.affinity,
      raw.familiarity,
      raw.mood,
      raw.interactionCount,
      raw.lastInteractAt,
      raw.updatedAt,
    ].every(isNumber)
  );
}

export class JsonConversationStore implements ConversationSink {
  private readonly file: BotJsonFile<Record<string, ConversationTurnLike[]>> | null;
  private readonly buckets: BucketedJsonDir<ConversationTurnLike[]> | null;
  constructor(filePath: string, opts: BotStoreOptions = {}) {
    const validWhole = (raw: unknown): raw is Record<string, ConversationTurnLike[]> =>
      isDictionary(raw, isTurns);
    if (opts.bucketed) {
      this.file = null;
      this.buckets = openBucketed(filePath, bucketedDirOf(filePath), validWhole, isTurns, {
        maxBuckets: opts.maxCachedBuckets,
      });
    } else {
      this.buckets = null;
      this.file = new BotJsonFile(filePath, () => ({}), validWhole);
    }
  }
  private readBucket(agentId: string): ConversationTurnLike[] {
    if (this.buckets) return this.buckets.get(agentId) ?? [];
    return own(this.file!.data, agentId) ?? [];
  }
  private writeBucket(agentId: string, turns: ConversationTurnLike[]): void {
    if (this.buckets) {
      this.buckets.set(agentId, turns);
      return;
    }
    this.file!.replace({ ...this.file!.data, [agentId]: turns });
  }
  private allKeys(): string[] {
    return this.buckets ? this.buckets.keys() : Object.keys(this.file!.data);
  }
  get(agentId: string): ConversationTurnLike[] {
    return this.readBucket(agentId).map((t) => ({ ...t }));
  }
  getAll(prefix: string): ConversationTurnLike[] {
    const prefixWithColon = `${prefix}:`;
    const out: ConversationTurnLike[] = [];
    for (const key of this.allKeys()) {
      if (key === prefix || key.startsWith(prefixWithColon)) {
        for (const t of this.readBucket(key)) out.push({ ...t });
      }
    }
    return out.sort((a, b) => a.ts - b.ts);
  }
  /** `turns` 的所有权移交给存储（发布后随整树冻结）；调用方不得保留引用再修改。 */
  append(agentId: string, turns: ConversationTurnLike[]): void {
    const prev = this.readBucket(agentId);
    this.writeBucket(agentId, [...prev, ...turns].slice(-MAX_TURNS));
  }
}

export class JsonMemoryStore implements MemorySink {
  private readonly file: BotJsonFile<Record<string, AgentLabMemoryItem[]>> | null;
  private readonly buckets: BucketedJsonDir<AgentLabMemoryItem[]> | null;
  constructor(filePath: string, opts: BotStoreOptions = {}) {
    const validWhole = (raw: unknown): raw is Record<string, AgentLabMemoryItem[]> =>
      isDictionary(raw, isMemories);
    if (opts.bucketed) {
      this.file = null;
      this.buckets = openBucketed(filePath, bucketedDirOf(filePath), validWhole, isMemories, {
        maxBuckets: opts.maxCachedBuckets,
      });
    } else {
      this.buckets = null;
      this.file = new BotJsonFile(filePath, () => ({}), validWhole);
    }
  }
  private readScope(personaId: string): AgentLabMemoryItem[] {
    if (this.buckets) return this.buckets.get(personaId) ?? [];
    return own(this.file!.data, personaId) ?? [];
  }
  private writeScope(personaId: string, items: AgentLabMemoryItem[]): void {
    if (this.buckets) {
      this.buckets.set(personaId, items);
      return;
    }
    this.file!.replace({ ...this.file!.data, [personaId]: items });
  }
  get(personaId: string): AgentLabMemoryItem[] {
    // 浅拷贝条目：embedding / keywords 数组共享冻结引用（消费端只读，改写会显式抛错）。
    return this.readScope(personaId).map((m) => ({ ...m }));
  }
  getAbout(personaId: string, aboutIds: string[], includeUntagged = false): AgentLabMemoryItem[] {
    const ids = new Set(aboutIds);
    return this.readScope(personaId)
      .filter((m) => (m.aboutId ? ids.has(m.aboutId) : includeUntagged))
      .map((m) => ({ ...m }));
  }
  touch(personaId: string, ids: string[], now: number): void {
    if (ids.length === 0) return;
    const cur = this.readScope(personaId);
    if (cur.length === 0) return;
    const idSet = new Set(ids);
    let changed = false;
    // 只为命中的条目构造新对象；未命中条目共享冻结引用，避免整库（含向量）深拷贝。
    const next = cur.map((m) => {
      if (!idSet.has(m.id)) return m;
      changed = true;
      return { ...m, accessCount: m.accessCount + 1, lastAccessedAt: now };
    });
    if (changed) this.writeScope(personaId, next);
  }
  add(
    personaId: string,
    texts: string[],
    now: number,
    about?: { aboutId: string; aboutKind: 'user' | 'persona' },
    embeddings?: Array<number[] | undefined>,
  ): void {
    const cur = this.readScope(personaId);
    const seen = new Set(cur.map((m) => `${m.aboutId ?? ''} ${m.text}`));
    const fresh: AgentLabMemoryItem[] = [];
    texts.forEach((raw, i) => {
      const t = raw.trim();
      const key = `${about?.aboutId ?? ''} ${t}`;
      if (!t || seen.has(key)) return;
      seen.add(key);
      const emb = embeddings?.[i];
      fresh.push({
        id: createHash('sha1')
          .update(`${personaId}|${t}|${now + i}`)
          .digest('hex')
          .slice(0, 16),
        text: t,
        keywords: keywordsOf(t),
        ...(emb && emb.length > 0 ? { embedding: emb } : {}),
        ...(about ? { aboutId: about.aboutId, aboutKind: about.aboutKind } : {}),
        accessCount: 0,
        createdAt: now,
        lastAccessedAt: now,
      });
    });
    if (fresh.length > 0) this.writeScope(personaId, [...cur, ...fresh].slice(-MAX_MEMORIES));
  }
}

export class JsonNotesStore implements NotesSink {
  private readonly file: BotJsonFile<NotesData>;
  constructor(filePath: string) {
    this.file = new BotJsonFile(filePath, () => ({}), isNotesData);
  }
  get(personaId: string): AgentLabPersonaNotes {
    const notes = own(this.file.data.notes ?? {}, personaId);
    return notes
      ? { corrections: [...notes.corrections], episodes: [...notes.episodes] }
      : { corrections: [], episodes: [] };
  }
  getReflectedCount(personaId: string): number {
    return own(this.file.data.reflected ?? {}, personaId) ?? 0;
  }
  setReflectedCount(personaId: string, count: number): void {
    this.file.replace({
      ...this.file.data,
      reflected: { ...this.file.data.reflected, [personaId]: count },
    });
  }
  add(personaId: string, corrections: string[], episode: string): void {
    const cur = own(this.file.data.notes ?? {}, personaId);
    const next: AgentLabPersonaNotes = {
      corrections: Array.from(new Set([...(cur?.corrections ?? []), ...corrections])).slice(-20),
      episodes: (episode ? [...(cur?.episodes ?? []), episode] : [...(cur?.episodes ?? [])]).slice(
        -8,
      ),
    };
    this.file.replace({ ...this.file.data, notes: { ...this.file.data.notes, [personaId]: next } });
  }
}

/** 克隆体对群友的关系态（JSON 落盘，M3 群聊用，重启保持）。 */
export class JsonRelationStore implements AgentLabRelationStore {
  private readonly file: BotJsonFile<Record<string, AgentLabRelation>>;
  constructor(filePath: string) {
    this.file = new BotJsonFile(
      filePath,
      () => ({}),
      (raw): raw is Record<string, AgentLabRelation> => isDictionary(raw, isRelation),
    );
  }
  private key(subjectPersonaId: string, objectId: string): string {
    return `${subjectPersonaId} ${objectId}`;
  }
  get(subjectPersonaId: string, objectId: string): AgentLabRelation | null {
    const rel = own(this.file.data, this.key(subjectPersonaId, objectId));
    // 字段全是原始值：浅拷贝即是完整副本。
    return rel ? { ...rel } : null;
  }
  listForSubject(subjectPersonaId: string): AgentLabRelation[] {
    return Object.values(this.file.data)
      .filter((r) => r.subjectPersonaId === subjectPersonaId)
      .map((r) => ({ ...r }));
  }
  /** `relation` 的所有权移交给存储（发布后随整树冻结）；调用方不得保留引用再修改。 */
  upsert(relation: AgentLabRelation): void {
    this.file.replace({
      ...this.file.data,
      [this.key(relation.subjectPersonaId, relation.objectId)]: relation,
    });
  }
  applyDelta(
    subjectPersonaId: string,
    objectId: string,
    objectKind: AgentLabMemberKind,
    delta: { affinity?: number; familiarity?: number; mood?: number },
    now: number,
  ): AgentLabRelation {
    const base =
      own(this.file.data, this.key(subjectPersonaId, objectId)) ??
      makeBaseRelation(subjectPersonaId, objectId, objectKind, now);
    const next = applyRelationDelta(base, delta, now);
    this.upsert(next);
    // 与旧实现一致：返回脱钩副本（发布对象已随整树冻结，不外泄）。
    return { ...next };
  }
}

/** bot 不统计 token（自己看厂商后台即可）；保留接口便于将来接账。 */
export class NoopUsageStore implements UsageSink {
  record(): void {
    /* no-op */
  }
}
