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

/** 每个群最多保留的消息条数（超出丢最旧的，防无限增长）。 */
const MAX_MESSAGES_PER_GROUP = 2000;

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
    delete this.data.groups[id];
    delete this.data.members[id];
    delete this.data.messages[id];
    this.persist();
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
    // 超容量丢最旧的（数组尾部是最新）。
    this.data.messages[message.groupId] =
      cur.length > MAX_MESSAGES_PER_GROUP ? cur.slice(cur.length - MAX_MESSAGES_PER_GROUP) : cur;
    this.persist();
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
