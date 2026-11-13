/**
 * 关系态存储的 JSON 实现（AgentLabRelationStore port，按账号隔离）。
 *
 * 每条 = 「克隆体 subject 看成员 object」的主观关系（affinity/familiarity/mood）。
 * 纯逻辑（初值/clamp/增量/情绪衰减）复用 @weq/agentlab 的 relation.ts，这里只管存取。
 * 读取时惰性做 mood 时间衰减，避免定时任务。
 *
 * M1 先兑现；SQLite 后端就是把这张 map 换成一张 relations 表，接口不变。
 */

import {
  applyRelationDelta,
  clampRelation,
  decayMood,
  makeBaseRelation,
  type AgentLabMemberKind,
  type AgentLabRelation,
  type AgentLabRelationStore,
} from '@weq/agentlab';
import { JsonStore } from '../common/json_store';

export class JsonRelationStore implements AgentLabRelationStore {
  /** key = `${subjectPersonaId}\x00${objectId}` */
  private readonly store: JsonStore<Record<string, AgentLabRelation>>;
  private readonly now: () => number;

  constructor(filePath: string, now: () => number = () => Date.now()) {
    this.now = now;
    this.store = new JsonStore(filePath, () => ({}), {
      normalize: (raw) =>
        raw && typeof raw === 'object' ? (raw as Record<string, AgentLabRelation>) : {},
    });
  }

  private get data(): Record<string, AgentLabRelation> {
    return this.store.data;
  }

  private set data(next: Record<string, AgentLabRelation>) {
    this.store.data = next;
  }

  private key(subjectPersonaId: string, objectId: string): string {
    return `${subjectPersonaId}\x00${objectId}`;
  }

  /** 读出时惰性衰减 mood（不落盘，落盘发生在 upsert/applyDelta）。 */
  private withDecay(rel: AgentLabRelation): AgentLabRelation {
    const decayed = decayMood(rel.mood, this.now() - rel.updatedAt);
    return decayed === rel.mood ? rel : { ...rel, mood: decayed };
  }

  get(subjectPersonaId: string, objectId: string): AgentLabRelation | null {
    const rel = this.data[this.key(subjectPersonaId, objectId)];
    return rel ? this.withDecay(rel) : null;
  }

  listForSubject(subjectPersonaId: string): AgentLabRelation[] {
    return Object.values(this.data)
      .filter((r) => r.subjectPersonaId === subjectPersonaId)
      .map((r) => this.withDecay(r));
  }

  deletePersona(personaId: string): void {
    const next = Object.fromEntries(
      Object.entries(this.data).filter(
        ([, relation]) =>
          relation.subjectPersonaId !== personaId && relation.objectId !== personaId,
      ),
    );
    this.store.replace(next, true);
  }

  upsert(relation: AgentLabRelation): void {
    this.data[this.key(relation.subjectPersonaId, relation.objectId)] = clampRelation(relation);
    this.persist();
  }

  applyDelta(
    subjectPersonaId: string,
    objectId: string,
    objectKind: AgentLabMemberKind,
    delta: { affinity?: number; familiarity?: number; mood?: number },
    now: number,
  ): AgentLabRelation {
    const k = this.key(subjectPersonaId, objectId);
    const existing = this.data[k];
    // 施加增量前先把已存的 mood 衰减到「现在」，再叠 delta，避免旧情绪不回落。
    const base = existing
      ? { ...existing, mood: decayMood(existing.mood, now - existing.updatedAt) }
      : makeBaseRelation(subjectPersonaId, objectId, objectKind, now);
    const next = applyRelationDelta(base, delta, now);
    this.data[k] = next;
    this.persist();
    return next;
  }

  private persist(): void {
    this.store.save();
  }
}
