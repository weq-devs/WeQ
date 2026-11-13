// @vitest-environment node
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { AgentLabStore, AgentRuntime } from '@weq/agentlab';
import type { AccountSession } from '@weq/account';
import { AgentLabService } from '../src/account/agentlab';
import { ConversationStore } from '../src/account/agentlab_conversation';
import { CloneConversationRuns } from '../src/account/agentlab_runs';
import { captureGeneratedContent } from '../src/account/generated_content';
import { makeBackupPersona } from './fixtures/backup_persona';

const roots: string[] = [];
afterEach(() => {
  vi.restoreAllMocks();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'weq-long-term-'));
  roots.push(root);
  const persona = makeBackupPersona();
  const store = new AgentLabStore(root);
  store.savePersona({ persona, pairs: [] });
  const session = { context: { uin: persona.ownerId } } as unknown as AccountSession;
  const open = () =>
    new AgentLabService(session, root, () => ({
      baseUrl: 'https://synthetic.invalid',
      apiKey: 'synthetic',
      model: 'synthetic',
    }));
  return { root, persona, store, open };
}

it('将主桶、所有旧分会话及孤立桶按时间完整合并，重开和追加不裁剪历史', () => {
  const f = fixture();
  const turn = (index: number) => ({
    id: `m-${index}`,
    role: 'user',
    text: `合成 ${index}`,
    ts: index,
  });
  const rows = Array.from({ length: 720 }, (_, index) => turn(index));
  writeFileSync(
    join(f.root, 'conversations.json'),
    JSON.stringify({
      [f.persona.id]: rows.filter((_, index) => index % 3 === 0),
      [`${f.persona.id}:old`]: rows.filter((_, index) => index % 3 === 1),
      [`${f.persona.id}:orphan`]: rows.filter((_, index) => index % 3 === 2),
      assistant: [{ role: 'user', text: '独立助手', ts: 1 }],
    }),
  );
  writeFileSync(
    join(f.root, 'sessions.json'),
    JSON.stringify({
      [f.persona.id]: [{ id: 'old', title: '旧标题', createdAt: 1, updatedAt: 2 }],
    }),
  );
  const service = f.open();
  const merged = service.getConversation(f.persona.id);
  expect(merged).toHaveLength(rows.length);
  expect(merged.map((row) => row.id)).toEqual(rows.map((row) => row.id));
  expect(merged[1]).toMatchObject({ sourceSessionId: 'old', sourceSessionTitle: '旧标题' });
  expect(merged[2]).toMatchObject({ sourceSessionId: 'orphan', sourceSessionTitle: 'orphan' });
  expect(service.listPersonaSessions(f.persona.id)).toEqual([]);
  expect(service.getPersonaSessionConversation(f.persona.id, 'old')).toEqual(merged);
  const restarted = f.open();
  expect(restarted.getConversation(f.persona.id)).toEqual(merged);
  const conversations = new ConversationStore(join(f.root, 'conversations.json'));
  conversations.mergeOwner(f.persona.id, new Map());
  conversations.append(f.persona.id, [{ role: 'assistant', text: '继续长期对话', ts: 900 }]);
  expect(conversations.get(f.persona.id)).toHaveLength(rows.length + 1);
  expect(conversations.get('assistant')[0]?.text).toBe('独立助手');
});

it('群合并保留全部消息和来源，超过旧条数上限仍可继续写入', async () => {
  const f = fixture();
  const rows = Array.from({ length: 2200 }, (_, index) => ({
    id: `g-${index}`,
    groupId: 'g',
    senderId: f.persona.ownerId,
    senderKind: 'user',
    text: `群合成 ${index}`,
    ts: index,
  }));
  writeFileSync(
    join(f.root, 'groups.json'),
    JSON.stringify({
      groups: {
        g: { id: 'g', name: '合成群', ownerId: f.persona.ownerId, createdAt: 1, updatedAt: 2 },
      },
      members: { g: [] },
      messages: { g: rows.filter((_, index) => index % 2 === 0) },
    }),
  );
  writeFileSync(
    join(f.root, 'group_session_messages.json'),
    JSON.stringify({
      'g:old': rows.filter((_, index) => index % 2 === 1),
    }),
  );
  writeFileSync(
    join(f.root, 'sessions.json'),
    JSON.stringify({
      'group:g': [{ id: 'old', title: '原群对话', createdAt: 1, updatedAt: 2 }],
    }),
  );
  const service = f.open();
  expect(service.getGroupMessages('g').map((row) => row.id)).toEqual(rows.map((row) => row.id));
  expect(service.getGroupMessages('g')[1]).toMatchObject({
    sourceSessionId: 'old',
    sourceSessionTitle: '原群对话',
  });
  expect(service.listGroupSessions('g')).toEqual([]);
  await service.sendGroupMessage({ groupId: 'g', text: '新消息', sessionId: 'old' }, () => {});
  expect(service.getGroupMessages('g')).toHaveLength(rows.length + 1);
  expect(f.open().getGroupMessages('g')).toHaveLength(rows.length + 1);
  expect(JSON.parse(readFileSync(join(f.root, 'group_session_messages.json'), 'utf8'))).toEqual({});
});

it('不同子会话的相同消息 ID 不丢内容，重开后可分别精确选择和导出', () => {
  const f = fixture();
  const row = { id: 'same-id', role: 'user', text: '同一时刻的原文', ts: 1 };
  writeFileSync(
    join(f.root, 'conversations.json'),
    JSON.stringify({
      [f.persona.id]: [row, { ...row, id: 'stable-id', ts: 2 }],
      [`${f.persona.id}:one`]: [row],
      [`${f.persona.id}:two`]: [{ ...row, text: '另一个来源的不同原文' }],
    }),
  );
  const service = f.open();
  const merged = service.getConversation(f.persona.id);
  expect(merged).toHaveLength(4);
  expect(new Set(merged.map((message) => message.id)).size).toBe(4);
  expect(merged.find((message) => message.id === 'stable-id')).toBeDefined();
  expect(merged.filter((message) => message.sourceMessageId === 'same-id')).toHaveLength(3);
  expect(f.open().getConversation(f.persona.id)).toEqual(merged);
  for (const message of merged) {
    const snapshot = captureGeneratedContent(
      {
        agentLab: service,
        assistant: { listSessions: () => [], getConversation: () => [] },
      },
      { kind: 'persona', ownerId: f.persona.id, sessionId: null },
      [message.id!],
    );
    expect(snapshot.messages).toEqual([message]);
  }
});

it('没有子桶的旧主对话也修正冲突身份，重复读取不会重编号', () => {
  const f = fixture();
  const turn = { id: 'same-main', role: 'user', text: '重复身份的原文', ts: 1 };
  writeFileSync(
    join(f.root, 'conversations.json'),
    JSON.stringify({ [f.persona.id]: [turn, turn] }),
  );
  writeFileSync(
    join(f.root, 'groups.json'),
    JSON.stringify({
      groups: {
        g: { id: 'g', name: '合成群', ownerId: f.persona.ownerId, createdAt: 1, updatedAt: 2 },
      },
      members: { g: [] },
      messages: {
        g: [1, 2].map(() => ({
          id: 'same-main',
          groupId: 'g',
          senderId: f.persona.ownerId,
          senderKind: 'user',
          text: '群原文',
          ts: 1,
        })),
      },
    }),
  );
  const service = f.open();
  const privateRows = service.getConversation(f.persona.id);
  const groupRows = service.getGroupMessages('g');
  expect(new Set(privateRows.map((row) => row.id)).size).toBe(2);
  expect(new Set(groupRows.map((row) => row.id)).size).toBe(2);
  expect(service.getConversation(f.persona.id)).toEqual(privateRows);
  expect(service.getGroupMessages('g')).toEqual(groupRows);
  expect(f.open().getConversation(f.persona.id)).toEqual(privateRows);
  expect(f.open().getGroupMessages('g')).toEqual(groupRows);
});

it('群消息冲突身份及同来源引用稳定，迁移收尾重试不会再次导入或丢掉相同原文', () => {
  const f = fixture();
  const message = {
    id: 'same-id',
    groupId: 'g',
    senderId: f.persona.ownerId,
    senderKind: 'user',
    text: '原文相同',
    ts: 1,
  };
  const source = {
    'g:one': [message, message],
    'g:two': [
      message,
      { ...message, id: 'reply-id', text: '同来源引用', ts: 2, replyToId: 'same-id' },
    ],
  };
  writeFileSync(
    join(f.root, 'groups.json'),
    JSON.stringify({
      groups: {
        g: { id: 'g', name: '合成群', ownerId: f.persona.ownerId, createdAt: 1, updatedAt: 2 },
      },
      members: { g: [] },
      messages: { g: [message] },
    }),
  );
  writeFileSync(join(f.root, 'group_session_messages.json'), JSON.stringify(source));
  const service = f.open();
  const merged = service.getGroupMessages('g');
  expect(merged).toHaveLength(5);
  expect(new Set(merged.map((row) => row.id)).size).toBe(5);
  const secondSessionMessage = merged.find(
    (row) => row.sourceSessionId === 'two' && row.sourceMessageId === 'same-id',
  )!;
  const reply = merged.find((row) => row.id === 'reply-id')!;
  expect(reply.replyToId).toBe(secondSessionMessage.id);
  expect(reply.sourceReplyToId).toBe('same-id');
  writeFileSync(join(f.root, 'group_session_messages.json'), JSON.stringify(source));
  expect(f.open().getGroupMessages('g')).toEqual(merged);
  for (const row of merged) {
    const snapshot = captureGeneratedContent(
      {
        agentLab: service,
        assistant: { listSessions: () => [], getConversation: () => [] },
      },
      { kind: 'group', ownerId: 'g', sessionId: null },
      [row.id],
    );
    expect(snapshot.messages).toEqual([row]);
  }
});

it('同一毫秒发送相同群消息时，首次推送就使用不同的持久身份', async () => {
  const f = fixture();
  const service = f.open();
  const { group } = service.createGroup({ name: '合成空群', personaIds: [] });
  vi.spyOn(Date, 'now').mockReturnValue(1000);
  const ids: string[] = [];
  await service.sendGroupMessage({ groupId: group.id, text: '相同正文' }, (message) =>
    ids.push(message.id),
  );
  await service.sendGroupMessage({ groupId: group.id, text: '相同正文' }, (message) =>
    ids.push(message.id),
  );
  expect(new Set(ids).size).toBe(2);
  expect(service.getGroupMessages(group.id).map((message) => message.id)).toEqual(ids);
});

it('目标原件损坏时不清理旧桶或会话元数据', () => {
  const f = fixture();
  writeFileSync(join(f.root, 'groups.json'), '{damaged');
  const source = JSON.stringify({
    'g:s': [{ id: 'm', groupId: 'g', senderId: 'u', senderKind: 'user', text: '保留原件', ts: 1 }],
  });
  writeFileSync(join(f.root, 'group_session_messages.json'), source);
  expect(() => f.open().getGroupMessages('g')).toThrow();
  expect(readFileSync(join(f.root, 'group_session_messages.json'), 'utf8')).toBe(source);
  expect(readFileSync(join(f.root, 'groups.json'), 'utf8')).toBe('{damaged');
});

it('永久删除只停止选中的角色，并等待读取或写入结束后才移除数据', async () => {
  const f = fixture();
  const other = { ...f.persona, id: 'unselected-clone' };
  f.store.savePersona({ persona: other, pairs: [] });
  const signals = new Map<string, AbortSignal>();
  const releases = new Map<string, () => void>();
  vi.spyOn(AgentRuntime.prototype, 'generatePersonaTurns').mockImplementation(
    (persona, _pairs, options) => {
      const signal = options.chatEndpoint.signal!;
      signals.set(persona.id, signal);
      return new Promise<never>((_resolve, reject) => {
        releases.set(persona.id, () => reject(new Error('合成完成')));
      });
    },
  );
  const service = f.open();
  const selected = service
    .chat({ personaId: f.persona.id, text: '开始', history: [] })
    .catch(() => undefined);
  const unselected = service
    .chat({ personaId: other.id, text: '继续', history: [] })
    .catch(() => undefined);
  await vi.waitFor(() => expect(signals.size).toBe(2));
  const deleting = service.deletePersona(f.persona.id);
  expect(signals.get(f.persona.id)?.aborted).toBe(true);
  expect(signals.get(other.id)?.aborted).toBe(false);
  expect(existsSync(join(f.root, `${f.persona.id}.json`))).toBe(true);
  releases.get(f.persona.id)!();
  expect(await deleting).toBe(true);
  expect(existsSync(join(f.root, `${f.persona.id}.json`))).toBe(false);
  expect(existsSync(join(f.root, `${other.id}.json`))).toBe(true);
  expect(signals.get(other.id)?.aborted).toBe(false);
  releases.get(other.id)!();
  await Promise.all([selected, unselected]);
});

it('运行登记先封住选中对象的新请求，等待其派生写入且不停止同群其他克隆', async () => {
  const runs = new CloneConversationRuns();
  const group = { kind: 'group', id: 'g' } as const;
  const selected = { kind: 'persona', id: 'one' } as const;
  const other = { kind: 'persona', id: 'two' } as const;
  let releaseSelected!: () => void;
  let releaseOther!: () => void;
  let selectedSignal!: AbortSignal;
  let otherSignal!: AbortSignal;
  const pendingSelected = runs.start([group, selected], (signal) => {
    selectedSignal = signal;
    return new Promise<void>((resolve) => {
      releaseSelected = resolve;
    });
  });
  const pendingOther = runs.start([group, other], (signal) => {
    otherSignal = signal;
    return new Promise<void>((resolve) => {
      releaseOther = resolve;
    });
  });
  await Promise.resolve();
  const remove = vi.fn();
  const deleting = runs.stopAndDelete(selected, remove);
  expect(selectedSignal.aborted).toBe(true);
  expect(otherSignal.aborted).toBe(false);
  await expect(runs.start([selected], async () => {})).rejects.toThrow('正在永久删除');
  expect(remove).not.toHaveBeenCalled();
  releaseSelected();
  await deleting;
  expect(remove).toHaveBeenCalledOnce();
  expect(otherSignal.aborted).toBe(false);
  releaseOther();
  await Promise.all([pendingSelected, pendingOther]);
  expect(runs.list()).toEqual([]);
});
