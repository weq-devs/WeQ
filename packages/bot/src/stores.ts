/**
 * bot 侧的 store 实现，满足 AgentRuntime 的各 Sink 接口。
 *
 * M1：内存实现，够验证私聊文本闭环（bot 长驻，运行期内存足够）。
 * TODO(M4)：换成 JSON 落盘（重启保持记忆/关系），或把 service 的 store 实现下沉到 @weq/agentlab 共用。
 */
import { createHash } from 'node:crypto';
import {
  keywordsOf,
  makeBaseRelation,
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

export class InMemoryConversationStore implements ConversationSink {
  private readonly data = new Map<string, ConversationTurnLike[]>();
  get(agentId: string): ConversationTurnLike[] {
    return this.data.get(agentId) ?? [];
  }
  append(agentId: string, turns: ConversationTurnLike[]): void {
    const next = [...(this.data.get(agentId) ?? []), ...turns];
    this.data.set(agentId, next.length > MAX_TURNS ? next.slice(next.length - MAX_TURNS) : next);
  }
}

export class InMemoryMemoryStore implements MemorySink {
  private readonly data = new Map<string, AgentLabMemoryItem[]>();
  get(personaId: string): AgentLabMemoryItem[] {
    return this.data.get(personaId) ?? [];
  }
  touch(personaId: string, ids: string[], now: number): void {
    if (ids.length === 0) return;
    const idSet = new Set(ids);
    for (const m of this.data.get(personaId) ?? []) {
      if (idSet.has(m.id)) {
        m.accessCount += 1;
        m.lastAccessedAt = now;
      }
    }
  }
  add(
    personaId: string,
    texts: string[],
    now: number,
    about?: { aboutId: string; aboutKind: 'user' | 'persona' },
    embeddings?: Array<number[] | undefined>,
  ): void {
    const cur = this.data.get(personaId) ?? [];
    const seen = new Set(cur.map((m) => `${m.aboutId ?? ''} ${m.text}`));
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
    });
    this.data.set(personaId, cur.slice(-MAX_MEMORIES));
  }
}

export class InMemoryNotesStore implements NotesSink {
  private readonly notes = new Map<string, AgentLabPersonaNotes>();
  private readonly reflected = new Map<string, number>();
  get(personaId: string): AgentLabPersonaNotes {
    return this.notes.get(personaId) ?? { corrections: [], episodes: [] };
  }
  getReflectedCount(personaId: string): number {
    return this.reflected.get(personaId) ?? 0;
  }
  setReflectedCount(personaId: string, count: number): void {
    this.reflected.set(personaId, count);
  }
  add(personaId: string, corrections: string[], episode: string): void {
    const cur = this.get(personaId);
    const next: AgentLabPersonaNotes = {
      corrections: Array.from(new Set([...cur.corrections, ...corrections])).slice(-20),
      episodes: (episode ? [...cur.episodes, episode] : cur.episodes).slice(-8),
    };
    this.notes.set(personaId, next);
  }
}

/** M1 不统计 token（bot 自己看厂商后台即可）；保留接口便于将来接账。 */
export class NoopUsageStore implements UsageSink {
  record(): void {
    /* no-op */
  }
}

/** M1 私聊不走关系（gatePrivate 默认关）；M3 群聊再换真实实现。 */
export class StubRelationStore implements AgentLabRelationStore {
  get(): AgentLabRelation | null {
    return null;
  }
  listForSubject(): AgentLabRelation[] {
    return [];
  }
  upsert(): void {
    /* no-op */
  }
  applyDelta(
    subjectPersonaId: string,
    objectId: string,
    objectKind: AgentLabMemberKind,
    _delta: { affinity?: number; familiarity?: number; mood?: number },
    now: number,
  ): AgentLabRelation {
    return makeBaseRelation(subjectPersonaId, objectId, objectKind, now);
  }
}
