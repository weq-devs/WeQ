/**
 * bot 侧的 store 实现（JSON 落盘），满足 AgentRuntime 的各 Sink 接口。
 * 数据落在产物的 data/ 目录；损坏原件拒绝加载，原子保存成功后才发布内存变更。
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

const MAX_TURNS = 400;
const MAX_MEMORIES = 200;

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
function isMemories(raw: unknown): raw is AgentLabMemoryItem[] {
  return (
    Array.isArray(raw) &&
    raw.every(
      (m) =>
        isRecord(m) &&
        typeof m.id === 'string' &&
        typeof m.text === 'string' &&
        isStrings(m.keywords) &&
        isNumber(m.accessCount) &&
        isNumber(m.createdAt) &&
        isNumber(m.lastAccessedAt) &&
        (m.embedding === undefined ||
          (Array.isArray(m.embedding) && m.embedding.every(isNumber))) &&
        (m.aboutId === undefined || typeof m.aboutId === 'string') &&
        (m.aboutKind === undefined || m.aboutKind === 'user' || m.aboutKind === 'persona'),
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
  private readonly file: BotJsonFile<Record<string, ConversationTurnLike[]>>;
  constructor(filePath: string) {
    this.file = new BotJsonFile(
      filePath,
      () => ({}),
      (raw): raw is Record<string, ConversationTurnLike[]> => isDictionary(raw, isTurns),
    );
  }
  get(agentId: string): ConversationTurnLike[] {
    return structuredClone(own(this.file.data, agentId) ?? []);
  }
  getAll(prefix: string): ConversationTurnLike[] {
    const prefixWithColon = `${prefix}:`;
    const out: ConversationTurnLike[] = [];
    for (const key of Object.keys(this.file.data)) {
      if (key === prefix || key.startsWith(prefixWithColon)) out.push(...this.get(key));
    }
    return out.sort((a, b) => a.ts - b.ts);
  }
  append(agentId: string, turns: ConversationTurnLike[]): void {
    const next = [...this.get(agentId), ...turns];
    this.file.replace({ ...this.file.data, [agentId]: next.slice(-MAX_TURNS) });
  }
}

export class JsonMemoryStore implements MemorySink {
  private readonly file: BotJsonFile<Record<string, AgentLabMemoryItem[]>>;
  constructor(filePath: string) {
    this.file = new BotJsonFile(
      filePath,
      () => ({}),
      (raw): raw is Record<string, AgentLabMemoryItem[]> => isDictionary(raw, isMemories),
    );
  }
  get(personaId: string): AgentLabMemoryItem[] {
    return structuredClone(own(this.file.data, personaId) ?? []);
  }
  getAbout(personaId: string, aboutIds: string[], includeUntagged = false): AgentLabMemoryItem[] {
    const ids = new Set(aboutIds);
    return this.get(personaId).filter((m) => (m.aboutId ? ids.has(m.aboutId) : includeUntagged));
  }
  touch(personaId: string, ids: string[], now: number): void {
    if (ids.length === 0) return;
    const idSet = new Set(ids);
    let changed = false;
    const next = this.get(personaId);
    for (const m of next) {
      if (idSet.has(m.id)) {
        m.accessCount += 1;
        m.lastAccessedAt = now;
        changed = true;
      }
    }
    if (changed) this.file.replace({ ...this.file.data, [personaId]: next });
  }
  add(
    personaId: string,
    texts: string[],
    now: number,
    about?: { aboutId: string; aboutKind: 'user' | 'persona' },
    embeddings?: Array<number[] | undefined>,
  ): void {
    const cur = this.get(personaId);
    const seen = new Set(cur.map((m) => `${m.aboutId ?? ''} ${m.text}`));
    let added = 0;
    texts.forEach((raw, i) => {
      const t = raw.trim();
      const key = `${about?.aboutId ?? ''} ${t}`;
      if (!t || seen.has(key)) return;
      seen.add(key);
      const emb = embeddings?.[i];
      cur.push({
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
      added += 1;
    });
    if (added > 0) this.file.replace({ ...this.file.data, [personaId]: cur.slice(-MAX_MEMORIES) });
  }
}

export class JsonNotesStore implements NotesSink {
  private readonly file: BotJsonFile<NotesData>;
  constructor(filePath: string) {
    this.file = new BotJsonFile(filePath, () => ({}), isNotesData);
  }
  get(personaId: string): AgentLabPersonaNotes {
    return structuredClone(
      own(this.file.data.notes ?? {}, personaId) ?? { corrections: [], episodes: [] },
    );
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
    const cur = this.get(personaId);
    const next = {
      corrections: Array.from(new Set([...cur.corrections, ...corrections])).slice(-20),
      episodes: (episode ? [...cur.episodes, episode] : cur.episodes).slice(-8),
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
    return structuredClone(own(this.file.data, this.key(subjectPersonaId, objectId)) ?? null);
  }
  listForSubject(subjectPersonaId: string): AgentLabRelation[] {
    return structuredClone(
      Object.values(this.file.data).filter((r) => r.subjectPersonaId === subjectPersonaId),
    );
  }
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
      this.get(subjectPersonaId, objectId) ??
      makeBaseRelation(subjectPersonaId, objectId, objectKind, now);
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
