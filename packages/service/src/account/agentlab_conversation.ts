/**
 * 与克隆体 / WeQ 助手的对话持久化（按账号隔离，落 JSON）。
 *
 * 注意：这不是 QQ 聊天记录，而是「我们和 agent 的对话」——刷新/重开不丢，
 * 也为未来导出 bot client 持续积累。按 agentId（personaId 或 'assistant'）分桶。
 */

import type { AssistantStep } from './assistant';
import { createHash, randomUUID } from 'node:crypto';
import { JsonStore } from '../common/json_store';
import { hasCloneMessageIdCollision, uniqueCloneMessageIds } from './clone_message_identity';

export interface ConversationTurn {
  /** 历史数据可缺省；通过 ConversationStore 读取后始终有稳定身份。 */
  id?: string;
  role: 'user' | 'assistant';
  text: string;
  ts: number;
  /** 合并前的会话来源；null 表示旧版主对话。 */
  sourceSessionId?: string | null;
  sourceSessionTitle?: string;
  sourceMessageId?: string;
  /** assistant 回合用到的工具名（WeQ 助手）。 */
  toolsUsed?: string[];
  /** assistant 回合的多轮思考/工具调用过程（WeQ 助手），用于刷新后回放折叠历史。 */
  steps?: AssistantStep[];
}

/** 单个 agent 最多保留的回合数（防文件无限增长）。 */
export const MAX_CONVERSATION_TURNS = 400;

export class ConversationStore {
  private readonly store: JsonStore<Record<string, ConversationTurn[]>>;
  private readonly unbounded = new Set<string>();

  constructor(filePath: string) {
    this.store = new JsonStore(filePath, () => ({}), {
      normalize: (raw) =>
        raw && typeof raw === 'object' ? (raw as Record<string, ConversationTurn[]>) : {},
    });
  }

  get(agentId: string): Array<ConversationTurn & { id: string }> {
    return (this.store.data[agentId] ?? []).map((turn, index) => ({
      ...turn,
      // 旧记录只读时不写盘；下次追加/补全时一并持久化，之后不随裁剪或正文变化。
      id:
        turn.id ||
        `legacy-${createHash('sha256')
          .update(JSON.stringify([agentId, index, turn.role, turn.ts, turn.text]))
          .digest('hex')}`,
    }));
  }

  /**
   * 合并某前缀下所有桶的对话（旧版单桶 `prefix` + 多会话桶 `${prefix}:${sessionId}`），
   * 按 ts 排序。供记忆蒸馏 / 反思读取「该克隆体的全部对话」。
   */
  getAll(prefix: string): ConversationTurn[] {
    const prefixWithColon = `${prefix}:`;
    const out: ConversationTurn[] = [];
    for (const key of Object.keys(this.store.data)) {
      if (key === prefix || key.startsWith(prefixWithColon)) {
        out.push(...this.get(key));
      }
    }
    return out.sort((a, b) => a.ts - b.ts);
  }

  /** 在同一个原子文件内合并旧分会话；身份、时间及来源都保持不变。 */
  mergeOwner(agentId: string, titles: ReadonlyMap<string, string>): void {
    this.store.assertReadable();
    if (this.unbounded.has(agentId)) return;
    const keys = Object.keys(this.store.data).filter((key) => key.startsWith(`${agentId}:`));
    if (!keys.length) {
      const current = this.get(agentId);
      if (hasCloneMessageIdCollision(current)) {
        this.store.replace(
          {
            ...this.store.data,
            [agentId]: uniqueCloneMessageIds(
              agentId,
              current.map((turn) => ({
                ...turn,
                sourceSessionId: turn.sourceSessionId === undefined ? null : turn.sourceSessionId,
                sourceSessionTitle: turn.sourceSessionTitle ?? '原始对话',
              })),
            ),
          },
          true,
        );
      }
      this.unbounded.add(agentId);
      return;
    }
    const merged = [
      ...this.get(agentId).map((turn) => ({
        ...turn,
        sourceSessionId: turn.sourceSessionId === undefined ? null : turn.sourceSessionId,
        sourceSessionTitle: turn.sourceSessionTitle ?? '原始对话',
      })),
      ...keys.flatMap((key) => {
        const sessionId = key.slice(agentId.length + 1);
        return this.get(key).map((turn) => ({
          ...turn,
          sourceSessionId: turn.sourceSessionId ?? sessionId,
          sourceSessionTitle: turn.sourceSessionTitle ?? titles.get(sessionId) ?? sessionId,
        }));
      }),
    ].sort((a, b) => a.ts - b.ts);
    const next = { ...this.store.data, [agentId]: uniqueCloneMessageIds(agentId, merged) };
    for (const key of keys) delete next[key];
    this.store.replace(next, true);
    this.unbounded.add(agentId);
  }

  clearOwner(agentId: string): void {
    const next = { ...this.store.data };
    for (const key of Object.keys(next)) {
      if (key === agentId || key.startsWith(`${agentId}:`)) delete next[key];
    }
    this.store.replace(next, true);
    this.unbounded.delete(agentId);
  }

  append(agentId: string, turns: ConversationTurn[]): void {
    const cur = this.get(agentId);
    const next = [...cur, ...turns.map((turn) => ({ ...turn, id: randomUUID() }))];
    this.store.data[agentId] =
      !this.unbounded.has(agentId) && next.length > MAX_CONVERSATION_TURNS
        ? next.slice(next.length - MAX_CONVERSATION_TURNS)
        : next;
    this.store.save();
  }

  /**
   * 原地补全/替换某桶**最后一条** assistant 回合（断点续答收尾用：把中断时留下的
   * 半截答复替换成完整版，而不是追加一条重复的）。不存在 assistant 末尾则忽略。
   * `patch.steps` 会**追加**到已有 steps（保留中断前的过程记录）。
   */
  patchLastAssistant(
    agentId: string,
    patch: Pick<ConversationTurn, 'text'> &
      Partial<Pick<ConversationTurn, 'steps' | 'toolsUsed' | 'ts'>>,
  ): void {
    const cur = this.get(agentId);
    if (!cur || cur.length === 0) return;
    const last = cur[cur.length - 1];
    if (last?.role !== 'assistant') return;
    cur[cur.length - 1] = {
      ...last,
      text: patch.text,
      ts: patch.ts ?? last.ts,
      steps: [...(last.steps ?? []), ...(patch.steps ?? [])],
      toolsUsed: patch.toolsUsed ?? last.toolsUsed,
    };
    this.store.data[agentId] = cur;
    this.store.save();
  }

  clear(agentId: string): void {
    delete this.store.data[agentId];
    this.store.save();
  }
}
