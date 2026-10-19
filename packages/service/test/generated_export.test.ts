import { mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import {
  captureGeneratedContent,
  listGeneratedConversations,
  type GeneratedContentTarget,
} from '../src/account/generated_content';
import type { GeneratedSearchSources } from '../src/account/generated_search';
import { ExportTaskManager } from '../src/account/export/task_manager';
import type { MsgService } from '../src/account/msg';
import { writeGeneratedContent } from '../src/account/export/generated_export';

const roots: string[] = [];
afterEach(() => {
  for (const dir of roots.splice(0)) rmSync(dir, { recursive: true, force: true });
});
function fixture() {
  const messages = [1, 2, 3].map((id) => ({
    id: `m${id}`,
    role: 'assistant' as const,
    text: `fixture-${id}`,
    ts: id * 1000,
    steps: [{ kind: 'text', text: `步骤${id}` }],
  }));
  const get = vi.fn(() => messages);
  const sources: GeneratedSearchSources = {
    agentLab: {
      listPersonas: () => [{ id: 'persona-fixture', name: '合成克隆体' }],
      listGroups: () => [{ id: 'group-fixture', name: '合成克隆群' }],
      listPersonaSessions: () => [{ id: 's', title: '合成私聊' }],
      listGroupSessions: () => [{ id: 's', title: '合成群聊' }],
      getConversation: get,
      getPersonaSessionConversation: get,
      getGroupMessages: get,
      getGroupSessionConversation: get,
    },
    assistant: { listSessions: () => [{ id: 's', title: '合成助手对话' }], getConversation: get },
  };
  return { messages, sources, get };
}
const targets: GeneratedContentTarget[] = [
  { kind: 'persona', ownerId: 'persona-fixture', sessionId: 's' },
  { kind: 'persona', ownerId: 'persona-fixture', sessionId: null },
  { kind: 'group', ownerId: 'group-fixture', sessionId: 's' },
  { kind: 'group', ownerId: 'group-fixture', sessionId: null },
  { kind: 'assistant', ownerId: 'assistant', sessionId: 's' },
];
it('表格区分 null 旧版身份与名称恰为 legacy 的真实会话', async () => {
  const f = fixture();
  const root = mkdtempSync(join(tmpdir(), 'weq-generated-identity-'));
  roots.push(root);
  const snapshot = captureGeneratedContent(
    f.sources,
    { kind: 'persona', ownerId: 'persona-fixture', sessionId: null },
    ['m1'],
  );
  await writeGeneratedContent(snapshot, 'txt', join(root, 'old.txt'));
  snapshot.target.sessionId = 'legacy';
  await writeGeneratedContent(snapshot, 'txt', join(root, 'session.txt'));
  expect(readFileSync(join(root, 'old.txt'), 'utf8')).toContain('会话身份: \n旧版记录: true');
  expect(readFileSync(join(root, 'session.txt'), 'utf8')).toContain(
    '会话身份: legacy\n旧版记录: false',
  );
});
it.each(targets)('生成内容 $kind/$sessionId 按对象与会话读取，精确快照不随原件修改', (target) => {
  const f = fixture();
  const ids = ['m1', 'm3', 'm1'];
  const snapshot = captureGeneratedContent(f.sources, target, ids);
  f.messages[0]!.text = 'changed';
  f.messages[0]!.steps[0]!.text = 'changed';
  ids.push('m2');
  target.ownerId += '-changed';
  expect(snapshot.origin).toBe('local-generated');
  expect(snapshot.selectedIds).toEqual(['m1', 'm3']);
  expect(snapshot.messages.map((row) => row.text)).toEqual(['fixture-1', 'fixture-3']);
  expect(snapshot.messages[0]!.steps).toEqual([{ kind: 'text', text: '步骤1' }]);
});
it('未持久化或删除的身份明确失败，空集合不变成整场对话', () => {
  const f = fixture();
  const target: GeneratedContentTarget = {
    kind: 'assistant',
    ownerId: 'assistant',
    sessionId: 's',
  };
  expect(captureGeneratedContent(f.sources, target, []).messages).toEqual([]);
  expect(() => captureGeneratedContent(f.sources, target, ['missing'])).toThrow(
    '不存在或尚未持久化',
  );
  expect(() => captureGeneratedContent(f.sources, { ...target, sessionId: null })).toThrow(
    '不存在',
  );
  expect(() => captureGeneratedContent(f.sources, { ...target, ownerId: 'wrong' })).toThrow(
    '不存在',
  );
  expect(listGeneratedConversations(f.sources)).toHaveLength(5);
});
it('实际生成内容任务写多格式、自动保存和恢复快照，不读 QQ 消息或调用模型', async () => {
  const f = fixture();
  const root = mkdtempSync(join(tmpdir(), 'weq-generated-export-'));
  roots.push(root);
  const snapshot = captureGeneratedContent(
    f.sources,
    { kind: 'assistant', ownerId: 'assistant', sessionId: 's' },
    ['m1', 'm3'],
  );
  const manager = new ExportTaskManager({} as MsgService, join(root, 'cache'));
  mkdirSync(join(root, 'saved'));
  const id = await manager.startTask({
    kind: 'c2c',
    conv: 'local-generated',
    name: '本地生成对话',
    format: 'json',
    formats: ['json', 'jsonl', 'csv', 'txt', 'xlsx'],
    total: 2,
    generated: snapshot,
    savePolicy: { mode: 'before', directory: join(root, 'saved') },
  });
  snapshot.messages[0]!.text = 'changed-after-submit';
  for (
    let i = 0;
    i < 400 &&
    manager.getTask(id)?.status !== 'failed' &&
    !['saved', 'failed'].includes(manager.getTask(id)?.save?.status ?? '');
    i++
  )
    await new Promise((resolve) => setTimeout(resolve, 10));
  const task = manager.getTask(id)!;
  expect(task.error).toBeUndefined();
  expect(task.save?.status).toBe('saved');
  expect(task.current).toBe(2);
  expect(task.formatCounts).toEqual({ json: 2, jsonl: 2, csv: 2, txt: 2, xlsx: 2 });
  const json = JSON.parse(readFileSync(task.filePath!, 'utf8'));
  expect(json.schema).toBe('weq-generated-content/1');
  expect(json.origin).toBe('local-generated');
  expect(json.messages.map((row: { id: string }) => row.id)).toEqual(['m1', 'm3']);
  expect(json.messages[0].text).toBe('fixture-1');
  const restored = new ExportTaskManager({} as MsgService, join(root, 'cache')).getTask(id)!;
  expect(restored.generated?.selectedIds).toEqual(['m1', 'm3']);
  expect(manager.listTasks()[0]?.generated?.messageCount).toBe(2);
  expect(manager.listTasks()[0]?.generated).not.toHaveProperty('messages');
  expect(JSON.parse(readFileSync(task.reportPath!, 'utf8')).generated.target.kind).toBe(
    'assistant',
  );
});

it('暂停后可在新管理器按同一份快照重新执行，不重新读取生成来源', async () => {
  const f = fixture();
  const root = mkdtempSync(join(tmpdir(), 'weq-generated-resume-'));
  roots.push(root);
  const manager = new ExportTaskManager({} as MsgService, root);
  let paused = false;
  manager.on('progress', (event) => {
    if (!paused && event.status === 'running') {
      paused = true;
      manager.pauseTask(event.taskId);
    }
  });
  const snapshot = captureGeneratedContent(
    f.sources,
    { kind: 'assistant', ownerId: 'assistant', sessionId: 's' },
    ['m3'],
  );
  const id = await manager.startTask({
    kind: 'c2c',
    conv: 'local-generated',
    name: '合成恢复',
    format: 'json',
    total: 1,
    generated: snapshot,
  });
  for (let i = 0; i < 400 && !manager.listTasks()[0]?.canResume; i++)
    await new Promise((resolve) => setTimeout(resolve, 10));
  expect(manager.getTask(id)?.status).toBe('paused');
  expect(manager.listTasks()[0]?.resumeMode).toBe('restart');
  f.messages.length = 0;
  const restored = new ExportTaskManager({} as MsgService, root);
  expect(restored.resumeTask(id)).toBe(true);
  for (let i = 0; i < 400 && !['completed', 'failed'].includes(restored.getTask(id)!.status); i++)
    await new Promise((resolve) => setTimeout(resolve, 10));
  expect(restored.getTask(id)?.error).toBeUndefined();
  expect(JSON.parse(readFileSync(restored.getTask(id)!.filePath!, 'utf8')).messages[0].text).toBe(
    'fixture-3',
  );
});
