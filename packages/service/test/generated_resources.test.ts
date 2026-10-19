import {
  mkdtempSync,
  readFileSync,
  writeFileSync,
  mkdirSync,
  rmSync,
  existsSync,
  readdirSync,
} from 'node:fs';
import { join, relative } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, expect, it } from 'vitest';
import {
  discoverGeneratedResources,
  resolveGeneratedResource,
} from '../src/account/export/generated_resources';
import type { GeneratedContentSnapshot } from '../src/account/generated_content';
import { ExportTaskManager } from '../src/account/export/task_manager';
import type { MsgService } from '../src/account/msg';

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
function snapshot(kind: 'persona' | 'group' | 'assistant' = 'persona'): GeneratedContentSnapshot {
  return {
    origin: 'local-generated',
    target: { kind, ownerId: kind === 'assistant' ? 'assistant' : 'owner', sessionId: 'session' },
    title: '合成对话',
    sessionTitle: '合成会话',
    capturedAt: 1,
    messages: [],
  };
}
function root() {
  const dir = mkdtempSync(join(tmpdir(), 'weq-generated-assets-'));
  roots.push(dir);
  return dir;
}
async function wait(manager: ExportTaskManager, id: string) {
  for (
    let i = 0;
    i < 400 &&
    !['completed', 'failed', 'cancelled', 'paused'].includes(manager.getTask(id)!.status);
    i++
  )
    await new Promise((resolve) => setTimeout(resolve, 10));
  expect(manager.getTask(id)?.error).toBeUndefined();
  return manager.getTask(id)!;
}

it('只识别持久记录中的媒体标记与附件步骤，同一资源合并消息身份，不猜模型文本里的文件路径', () => {
  const clone = snapshot('group');
  clone.messages = [
    {
      id: 'a',
      senderId: 'persona-a',
      senderKind: 'persona',
      text: '[[sticker:abcd]] [[voice:abcd.wav]]',
      ts: 1,
    },
    { id: 'b', senderId: 'persona-a', senderKind: 'persona', text: '[[sticker:abcd]]', ts: 2 },
    { id: 'c', senderId: 'persona-b', senderKind: 'persona', text: '[[sticker:abcd]]', ts: 3 },
  ];
  const refs = discoverGeneratedResources(clone);
  expect(refs).toHaveLength(3);
  expect(
    refs.find((ref) => ref.kind === 'sticker' && ref.ownerId === 'persona-a')?.messageIds,
  ).toEqual(['a', 'b']);
  const assistant = snapshot('assistant');
  assistant.messages = [
    {
      id: 'x',
      text: '/private/not-an-attachment.txt [[voice:abcd.wav]]',
      ts: 1,
      steps: [
        { kind: 'artifact', artifact: { id: 'report.html', name: '合成报告.html', kind: 'html' } },
        { kind: 'tool_result', result: { path: '/private/not-an-attachment.txt' } },
      ],
    },
  ];
  expect(discoverGeneratedResources(assistant)).toMatchObject([
    { kind: 'artifact', id: 'report.html', artifactKind: 'html', messageIds: ['x'] },
  ]);
});

it('实际多格式包复制选中资源一次，保留原记录并以相对路径标明缺失，不拷贝未选文件', async () => {
  const dir = root();
  const voice = join(dir, 'source.wav'),
    sticker = join(dir, 'source.png');
  writeFileSync(voice, 'synthetic-voice');
  writeFileSync(sticker, 'synthetic-sticker');
  const input = snapshot();
  input.messages = [
    { id: 'a', text: '[[voice:abcd.wav]] [[sticker:abcd]]', ts: 1 },
    { id: 'c', text: '[[voice:missing.wav]]', ts: 3 },
  ];
  const resolved: string[] = [];
  const manager = new ExportTaskManager({} as MsgService, join(dir, 'cache'), {
    generatedResource: (ref) => {
      resolved.push(ref.id);
      return ref.id === 'missing.wav' ? null : { filePath: ref.kind === 'voice' ? voice : sticker };
    },
  });
  const id = await manager.startTask({
    kind: 'c2c',
    conv: 'generated',
    name: '合成',
    format: 'json',
    formats: ['json', 'jsonl', 'txt', 'csv', 'xlsx'],
    total: 2,
    generated: input,
    savePolicy: { mode: 'before', directory: join(dir, 'saved') },
  });
  await wait(manager, id);
  for (let i = 0; i < 400 && manager.getTask(id)?.save?.status !== 'saved'; i++)
    await new Promise((resolve) => setTimeout(resolve, 10));
  const task = manager.getTask(id)!;
  expect(task.save?.status).toBe('saved');
  expect(resolved).toEqual(['abcd.wav', 'abcd', 'missing.wav']);
  const manifest = JSON.parse(
    readFileSync(join(task.bundleDir!, 'generated-resources.json'), 'utf8'),
  );
  expect(manifest.complete).toBe(false);
  expect(
    manifest.entries.filter((entry: { status: string }) => entry.status === 'copied'),
  ).toHaveLength(2);
  expect(
    manifest.entries.find((entry: { id: string }) => entry.id === 'missing.wav'),
  ).toMatchObject({ status: 'missing', messageIds: ['c'] });
  for (const entry of manifest.entries.filter(
    (entry: { status: string }) => entry.status === 'copied',
  )) {
    expect(entry.path).not.toContain(dir);
    expect(readFileSync(join(task.bundleDir!, entry.path), 'utf8')).toMatch(/^synthetic-/);
    expect(readFileSync(join(task.save!.path!, entry.path), 'utf8')).toMatch(/^synthetic-/);
  }
  const json = JSON.parse(readFileSync(task.filePath!, 'utf8'));
  expect(json.messages).toEqual(input.messages);
  expect(json.resources).toEqual(manifest);
  const lines = readFileSync(task.filePath!.replace(/\.json$/, '.jsonl'), 'utf8')
    .trim()
    .split('\n')
    .map((line) => JSON.parse(line));
  expect(lines[0].resources.complete).toBe(true);
  expect(lines[1].resources.complete).toBe(false);
  expect(readFileSync(task.filePath!.replace(/\.json$/, '.txt'), 'utf8')).toContain('resources/');
  expect(manager.listTasks()[0]).not.toHaveProperty('generatedResourceCache');
  expect(manager.listTasks()[0]).not.toHaveProperty('generatedResourceReport');
  expect(manager.listTasks()[0]?.generatedResources).toEqual({ total: 3, copied: 2, missing: 1 });
  expect(task.stages.find((stage) => stage.key === 'media')?.failures).toEqual([
    expect.objectContaining({ fileName: 'missing.wav', error: expect.stringContaining('不存在') }),
  ]);
});

it('助手附件目录使用现有校验保存链路，保留内部相对资源和同名不同身份的附件', async () => {
  const dir = root(),
    source = join(dir, 'source');
  mkdirSync(source);
  writeFileSync(join(source, 'index.html'), '<img src="image.png">');
  writeFileSync(join(source, 'image.png'), 'synthetic-image');
  const input = snapshot('assistant');
  input.messages = [
    {
      id: 'a',
      text: '附件',
      ts: 1,
      steps: ['one', 'two'].map((id) => ({
        kind: 'artifact',
        artifact: { id, name: '同名导出', kind: 'export' },
      })),
    },
  ];
  const manager = new ExportTaskManager({} as MsgService, join(dir, 'cache'), {
    generatedResource: () => ({ bundleDir: source }),
  });
  const id = await manager.startTask({
    kind: 'c2c',
    conv: 'generated',
    name: '助手',
    format: 'json',
    total: 1,
    generated: input,
  });
  const task = await wait(manager, id);
  const manifest = JSON.parse(
    readFileSync(join(task.bundleDir!, 'generated-resources.json'), 'utf8'),
  );
  expect(manifest.complete).toBe(true);
  expect(new Set(manifest.entries.map((entry: { path: string }) => entry.path)).size).toBe(2);
  for (const entry of manifest.entries)
    expect(readFileSync(join(task.bundleDir!, entry.path, 'image.png'), 'utf8')).toBe(
      'synthetic-image',
    );
  expect(relative(dir, task.bundleDir!)).not.toMatch(/^\.\./);
});

it('暂停后从持久资源快照恢复，原文件被删除也不重新查源；完成后不留重复私有副本', async () => {
  const dir = root(),
    source = join(dir, 'source.wav'),
    cache = join(dir, 'cache');
  writeFileSync(source, 'original-synthetic-voice');
  const input = snapshot();
  input.messages = [{ id: 'a', text: '[[voice:abcd.wav]]', ts: 1 }];
  const manager = new ExportTaskManager({} as MsgService, cache, {
    generatedResource: () => ({ filePath: source }),
  });
  let paused = false;
  manager.on('progress', (event) => {
    if (!paused && manager.getTask(event.taskId)?.generatedResourceCache?.[0]?.snapshot) {
      paused = true;
      manager.pauseTask(event.taskId);
    }
  });
  const id = await manager.startTask({
    kind: 'c2c',
    conv: 'generated',
    name: '合成恢复',
    format: 'json',
    total: 1,
    generated: input,
  });
  for (let i = 0; i < 400 && !manager.listTasks()[0]?.canResume; i++)
    await new Promise((resolve) => setTimeout(resolve, 10));
  expect(manager.getTask(id)?.status).toBe('paused');
  rmSync(source);
  const restored = new ExportTaskManager({} as MsgService, cache, {
    generatedResource: () => {
      throw new Error('不应回读原件');
    },
  });
  expect(restored.resumeTask(id)).toBe(true);
  const task = await wait(restored, id);
  const entry = task.generatedResourceReport!.entries[0]!;
  expect(entry.status).toBe('copied');
  expect(readFileSync(join(task.bundleDir!, entry.path!), 'utf8')).toBe('original-synthetic-voice');
  expect(readdirSync(cache).some((name) => name.startsWith('generated-resources-'))).toBe(false);
});

it('改动过的私有资源快照明确标成缺失，不回读原件掩盖校验失败', async () => {
  const dir = root(),
    source = join(dir, 'source.wav'),
    cache = join(dir, 'cache');
  writeFileSync(source, 'synthetic-original');
  const input = snapshot();
  input.messages = [{ id: 'a', text: '[[voice:abcd.wav]]', ts: 1 }];
  const manager = new ExportTaskManager({} as MsgService, cache, {
    generatedResource: () => ({ filePath: source }),
  });
  let paused = false;
  manager.on('progress', (event) => {
    if (!paused && manager.getTask(event.taskId)?.generatedResourceCache?.[0]?.snapshot) {
      paused = true;
      manager.pauseTask(event.taskId);
    }
  });
  const id = await manager.startTask({
    kind: 'c2c',
    conv: 'generated',
    name: '合成校验',
    format: 'json',
    total: 1,
    generated: input,
  });
  for (let i = 0; i < 400 && !manager.listTasks()[0]?.canResume; i++)
    await new Promise((resolve) => setTimeout(resolve, 10));
  const frozen = manager.getTask(id)!.generatedResourceCache![0]!.snapshot!;
  writeFileSync(join(frozen.directory, frozen.entry!), 'tampered');
  const restored = new ExportTaskManager({} as MsgService, cache, {
    generatedResource: () => {
      throw new Error('不应换用原件');
    },
  });
  restored.resumeTask(id);
  const task = await wait(restored, id);
  expect(task.generatedResourceReport?.complete).toBe(false);
  expect(task.generatedResourceReport?.entries[0]).toMatchObject({
    status: 'missing',
    error: expect.stringContaining('快照校验失败'),
  });
  expect(existsSync(frozen.directory)).toBe(true);
  expect(task.stages.find((stage) => stage.key === 'media')?.failed).toBe(1);
});

it('资源解析只走账号现有句柄，助手导出必须是已完成的任务', () => {
  const input = snapshot('assistant');
  input.messages = [
    {
      id: 'a',
      text: '',
      ts: 1,
      steps: [{ kind: 'artifact', artifact: { id: 'export-task', kind: 'export' } }],
    },
  ];
  const ref = discoverGeneratedResources(input)[0]!;
  const sources = {
    agentLab: { getAgentVoicePath: () => null, getStickerPath: () => null },
    assistant: { artifactInfo: () => ({ path: '/synthetic/report.html' }) },
    exportManager: { getTask: () => ({ status: 'running', bundleDir: '/synthetic/output' }) },
  };
  expect(resolveGeneratedResource(ref, sources)).toBeNull();
  expect(
    resolveGeneratedResource(ref, {
      ...sources,
      exportManager: { getTask: () => ({ status: 'completed', bundleDir: '/synthetic/output' }) },
    }),
  ).toMatchObject({ bundleDir: '/synthetic/output' });
});

it('旧版暂停任务恢复时补齐资源阶段，删除任务同时清理快照和独立报告', async () => {
  const dir = root(),
    cache = join(dir, 'cache');
  const input = snapshot();
  input.messages = [{ id: 'a', text: '[[voice:missing.wav]]', ts: 1 }];
  mkdirSync(cache);
  const id = 'legacy-generated';
  writeFileSync(join(cache, `report-${id}.json`), '{}');
  writeFileSync(
    join(cache, 'export_tasks.json'),
    JSON.stringify([
      {
        id,
        kind: 'c2c',
        conv: 'generated',
        name: '旧生成对话',
        format: 'json',
        generated: input,
        status: 'paused',
        current: 0,
        total: 1,
        progress: 0,
        createdAt: 1,
        updatedAt: 1,
        stages: [
          { key: 'message', label: '导出本地生成对话', status: 'pending', current: 0, total: 1 },
        ],
      },
    ]),
  );
  const manager = new ExportTaskManager({} as MsgService, cache);
  expect(manager.resumeTask(id)).toBe(true);
  const task = await wait(manager, id);
  expect(task.status).toBe('completed');
  expect(task.stages.find((stage) => stage.key === 'media')).toMatchObject({
    status: 'completed',
    total: 1,
    failed: 1,
  });
  expect(manager.deleteTask(id)).toBe(true);
  expect(existsSync(task.bundleDir!)).toBe(false);
  expect(existsSync(join(cache, `report-${id}.json`))).toBe(false);
});
