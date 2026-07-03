/**
 * bot 侧的 store 实现（JSON 落盘），满足 AgentRuntime 的各 Sink 接口。
 * 数据落在产物的 data/ 目录，**重启不丢**记忆/关系/对话历史。
 *
 * TODO(技术债)：与 service 的 JSON store（agentlab_memory/notes/conversation/relation_store）逻辑重复，
 * 未来可把它们下沉到 @weq/agentlab 共用（唯一障碍：ConversationStore 的 steps 依赖 service 的 AssistantStep，需泛化）。
 */
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
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

const MAX_TURNS = 400;
const MAX_MEMORIES = 200;

function loadJson<T>(filePath: string, fallback: T): T {
  try {
    if (!existsSync(filePath)) return fallback;
    return JSON.parse(readFileSync(filePath, 'utf-8')) as T;
  } catch {
    return fallback;
  }
}

function saveJson(filePath: string, data: unknown): void {
  try {
    mkdirSync(dirname(filePath), { recursive: true });
    writeFileSync(filePath, JSON.stringify(data), 'utf-8');
  } catch {
    /* 落盘失败不阻断聊天 */
  }
}

export class JsonConversationStore implements ConversationSink {
  private readonly data: Record<string, ConversationTurnLike[]>;
  constructor(private readonly filePath: string) {
    this.data = loadJson<Record<string, ConversationTurnLike[]>>(filePath, {});
  }
  get(agentId: string): ConversationTurnLike[] {
    return this.data[agentId] ?? [];
  }
  append(agentId: string, turns: ConversationTurnLike[]): void {
    const next = [...(this.data[agentId] ?? []), ...turns];
    this.data[agentId] = next.length > MAX_TURNS ? next.slice(next.length - MAX_TURNS) : next;
    saveJson(this.filePath, this.data);
  }
}

export class JsonMemoryStore implements MemorySink {
  private readonly data: Record<string, AgentLabMemoryItem[]>;
  constructor(private readonly filePath: string) {
    this.data = loadJson<Record<string, AgentLabMemoryItem[]>>(filePath, {});
  }
  get(personaId: string): AgentLabMemoryItem[] {
    return this.data[personaId] ?? [];
  }
  getAbout(personaId: string, aboutIds: string[], includeUntagged = false): AgentLabMemoryItem[] {
    const ids = new Set(aboutIds);
    return (this.data[personaId] ?? []).filter((m) => (m.aboutId ? ids.has(m.aboutId) : includeUntagged));
  }
  touch(personaId: string, ids: string[], now: number): void {
    if (ids.length === 0) return;
    const idSet = new Set(ids);
    let changed = false;
    for (const m of this.data[personaId] ?? []) {
      if (idSet.has(m.id)) {
        m.accessCount += 1;
        m.lastAccessedAt = now;
        changed = true;
      }
    }
    if (changed) saveJson(this.filePath, this.data);
  }
  add(
    personaId: string,
    texts: string[],
    now: number,
    about?: { aboutId: string; aboutKind: 'user' | 'persona' },
    embeddings?: Array<number[] | undefined>,
  ): void {
    const cur = this.data[personaId] ?? [];
    const seen = new Set(cur.map((m) => `${m.aboutId ?? ''} ${m.text}`));
    let added = 0;
    texts.forEach((raw, i) => {
      const t = raw.trim();
      const key = `${about?.aboutId ?? ''} ${t}`;
      if (!t || seen.has(key)) return;
      seen.add(key);
      const emb = embeddings?.[i];
      cur.push({
        id: createHash('sha1').update(`${personaId}|${t}|${now + i}`).digest('hex').slice(0, 16),
        text: t,
        keywords: keywordsOf(t),
        ...(emb && emb.length > 0 ? { embedding: emb } : {}),
        ...(about ? { aboutId: about.aboutId, aboutKind: about.aboutKind } : {}),
        accessCount: 0,
        createdAt: now,
        lastAccessedAt: now,
      });
      added += 1;
    });
    this.data[personaId] = cur.slice(-MAX_MEMORIES);
    if (added > 0) saveJson(this.filePath, this.data);
  }
}

export class JsonNotesStore implements NotesSink {
  private readonly notes: Record<string, AgentLabPersonaNotes>;
  private readonly reflected: Record<string, number>;
  constructor(private readonly filePath: string) {
    const loaded = loadJson<{ notes?: Record<string, AgentLabPersonaNotes>; reflected?: Record<string, number> }>(
      filePath,
      {},
    );
    this.notes = loaded.notes ?? {};
    this.reflected = loaded.reflected ?? {};
  }
  get(personaId: string): AgentLabPersonaNotes {
    return this.notes[personaId] ?? { corrections: [], episodes: [] };
  }
  getReflectedCount(personaId: string): number {
    return this.reflected[personaId] ?? 0;
  }
  setReflectedCount(personaId: string, count: number): void {
    this.reflected[personaId] = count;
    this.persist();
  }
  add(personaId: string, corrections: string[], episode: string): void {
    const cur = this.get(personaId);
    this.notes[personaId] = {
      corrections: Array.from(new Set([...cur.corrections, ...corrections])).slice(-20),
      episodes: (episode ? [...cur.episodes, episode] : cur.episodes).slice(-8),
    };
    this.persist();
  }
  private persist(): void {
    saveJson(this.filePath, { notes: this.notes, reflected: this.reflected });
  }
}

/** 克隆体对群友的关系态（JSON 落盘，M3 群聊用，重启保持）。 */
export class JsonRelationStore implements AgentLabRelationStore {
  private readonly data: Record<string, AgentLabRelation>;
  constructor(private readonly filePath: string) {
    this.data = loadJson<Record<string, AgentLabRelation>>(filePath, {});
  }
  private key(subjectPersonaId: string, objectId: string): string {
    return `${subjectPersonaId} ${objectId}`;
  }
  get(subjectPersonaId: string, objectId: string): AgentLabRelation | null {
    return this.data[this.key(subjectPersonaId, objectId)] ?? null;
  }
  listForSubject(subjectPersonaId: string): AgentLabRelation[] {
    return Object.values(this.data).filter((r) => r.subjectPersonaId === subjectPersonaId);
  }
  upsert(relation: AgentLabRelation): void {
    this.data[this.key(relation.subjectPersonaId, relation.objectId)] = relation;
    saveJson(this.filePath, this.data);
  }
  applyDelta(
    subjectPersonaId: string,
    objectId: string,
    objectKind: AgentLabMemberKind,
    delta: { affinity?: number; familiarity?: number; mood?: number },
    now: number,
  ): AgentLabRelation {
    const base =
      this.get(subjectPersonaId, objectId) ?? makeBaseRelation(subjectPersonaId, objectId, objectKind, now);
    const next = applyRelationDelta(base, delta, now);
    this.upsert(next);
    return next;
  }
}

/** bot 不统计 token（自己看厂商后台即可）；保留接口便于将来接账。 */
export class NoopUsageStore implements UsageSink {
  record(): void {
    /* no-op */
  }
}
