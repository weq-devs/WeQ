/**
 * 群聊存储的 JSON 实现（AgentLabGroupStore port，按账号隔离，落单个 JSON）。
 *
 * M1「接口优先」：引擎只依赖 @weq/agentlab 的 AgentLabGroupStore 接口，这里给一个
 * 零基础风险的 JSON 后端先兑现群聊；等 better-sqlite3 的 electron-rebuild 确认后，
 * 再写一个同接口的 SQLite 后端替换，引擎与 service 上层都不用改。
 *
 * 沿用 agentlab_memory.ts / agentlab_notes.ts 的落盘范式：构造传文件路径，
 * 内存态 + 同步 persist，持久化失败不影响聊天本身。
 */

import type {
  AgentLabGroup,
  AgentLabGroupMember,
  AgentLabGroupMessage,
  AgentLabGroupStore,
} from '@weq/agentlab';
import { JsonStore } from '../common/json_store';
import {
  cloneHistoryOriginKey,
  hasCloneMessageIdCollision,
  uniqueCloneMessageIds,
} from './clone_message_identity';

interface GroupData {
  groups: Record<string, AgentLabGroup>;
  members: Record<string, AgentLabGroupMember[]>;
  messages: Record<string, AgentLabGroupMessage[]>;
}

export class JsonGroupStore implements AgentLabGroupStore {
  private readonly store: JsonStore<GroupData>;

  constructor(filePath: string) {
    this.store = new JsonStore(filePath, () => ({ groups: {}, members: {}, messages: {} }), {
      normalize: (raw): GroupData => {
        const parsed = (raw ?? {}) as { groups?: unknown; members?: unknown; messages?: unknown };
        return {
          groups:
            parsed.groups && typeof parsed.groups === 'object'
              ? (parsed.groups as GroupData['groups'])
              : {},
          members:
            parsed.members && typeof parsed.members === 'object'
              ? (parsed.members as GroupData['members'])
              : {},
          messages:
            parsed.messages && typeof parsed.messages === 'object'
              ? (parsed.messages as GroupData['messages'])
              : {},
        };
      },
    });
  }

  private get data(): GroupData {
    return this.store.data;
  }

  private set data(next: GroupData) {
    this.store.data = next;
  }

  createGroup(input: { id: string; name: string; ownerId: string; now: number }): AgentLabGroup {
    const group: AgentLabGroup = {
      id: input.id,
      name: input.name,
      ownerId: input.ownerId,
      createdAt: input.now,
      updatedAt: input.now,
    };
    this.data.groups[group.id] = group;
    this.data.members[group.id] ??= [];
    this.data.messages[group.id] ??= [];
    this.persist();
    return group;
  }

  listGroups(ownerId: string): AgentLabGroup[] {
    return Object.values(this.data.groups)
      .filter((g) => g.ownerId === ownerId)
      .sort((a, b) => b.updatedAt - a.updatedAt);
  }

  getGroup(id: string): AgentLabGroup | null {
    return this.data.groups[id] ?? null;
  }

  renameGroup(id: string, name: string, now: number): void {
    const group = this.data.groups[id];
    if (!group) return;
    group.name = name;
    group.updatedAt = now;
    this.persist();
  }

  deleteGroup(id: string): void {
    const groups = { ...this.data.groups };
    const members = { ...this.data.members };
    const messages = { ...this.data.messages };
    delete groups[id];
    delete members[id];
    delete messages[id];
    this.store.replace({ groups, members, messages }, true);
  }

  setMembers(groupId: string, members: AgentLabGroupMember[]): void {
    this.data.members[groupId] = members;
    this.persist();
  }

  listMembers(groupId: string): AgentLabGroupMember[] {
    return this.data.members[groupId] ?? [];
  }

  addMember(member: AgentLabGroupMember): void {
    const cur = this.data.members[member.groupId] ?? [];
    // 同 memberId 去重（重复加群幂等，保留最早 joinedAt）。
    if (cur.some((m) => m.memberId === member.memberId)) return;
    cur.push(member);
    this.data.members[member.groupId] = cur;
    this.persist();
  }

  removeMember(groupId: string, memberId: string): void {
    const cur = this.data.members[groupId];
    if (!cur) return;
    this.data.members[groupId] = cur.filter((m) => m.memberId !== memberId);
    this.persist();
  }

  appendMessage(message: AgentLabGroupMessage): void {
    const cur = this.data.messages[message.groupId] ?? [];
    cur.push(message);
    this.data.messages[message.groupId] = cur;
    this.persist();
  }

  patchImageAnalysis(
    groupId: string,
    messageId: string,
    imageContext: string,
    imageOutcomes: NonNullable<AgentLabGroupMessage['imageOutcomes']>,
  ): void {
    const messages = this.data.messages[groupId] ?? [];
    const index = messages.findIndex((message) => message.id === messageId);
    const current = messages[index];
    if (!current) return;
    const key = (outcomes: typeof imageOutcomes = []) =>
      JSON.stringify(
        outcomes.map(({ id, mode, status, text, notes }) => ({
          id,
          mode,
          status,
          text,
          fallback: notes.some((note) => note.includes('回退 OCR')),
        })),
      );
    if (current.imageContext === imageContext && key(current.imageOutcomes) === key(imageOutcomes))
      return;
    this.data.messages[groupId] = messages.map((message, offset) =>
      offset === index ? { ...message, imageContext, imageOutcomes } : message,
    );
    this.persist();
  }

  /** 先保存合并结果，再由调用方移除旧分桶；重复迁移按稳定消息身份幂等。 */
  mergeMessages(groupId: string, additions: AgentLabGroupMessage[]): void {
    this.store.assertReadable();
    if (!additions.length && !hasCloneMessageIdCollision(this.data.messages[groupId] ?? [])) return;
    const current = (this.data.messages[groupId] ?? []).map((message) => ({
      ...message,
      sourceSessionId: message.sourceSessionId === undefined ? null : message.sourceSessionId,
      sourceSessionTitle: message.sourceSessionTitle ?? '原始对话',
    }));
    const identities = new Map<string, number>();
    for (const message of current) {
      const key = cloneHistoryOriginKey(message);
      identities.set(key, (identities.get(key) ?? 0) + 1);
    }
    const imported = new Map<string, number>();
    const merged: AgentLabGroupMessage[] = [...current];
    for (const message of additions) {
      const identity = cloneHistoryOriginKey(message);
      const occurrence = (imported.get(identity) ?? 0) + 1;
      imported.set(identity, occurrence);
      if (occurrence > (identities.get(identity) ?? 0)) {
        merged.push(message);
      }
    }
    this.store.replace(
      {
        ...this.data,
        messages: {
          ...this.data.messages,
          [groupId]: uniqueCloneMessageIds(
            groupId,
            merged.sort((a, b) => a.ts - b.ts),
          ),
        },
      },
      true,
    );
  }

  listMessages(groupId: string, limit?: number): AgentLabGroupMessage[] {
    const cur = this.data.messages[groupId] ?? [];
    if (limit === undefined || limit >= cur.length) return [...cur];
    return cur.slice(cur.length - limit);
  }

  clearMessages(groupId: string): void {
    this.data.messages[groupId] = [];
    this.persist();
  }

  private persist(): void {
    this.store.save();
  }
}
