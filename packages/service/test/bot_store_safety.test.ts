import * as fs from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import {
  JsonConversationStore,
  JsonMemoryStore,
  JsonNotesStore,
  JsonRelationStore,
} from '../../bot/src/stores';

vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof fs>();
  return {
    ...actual,
    writeFileSync: vi.fn(actual.writeFileSync),
    fsyncSync: vi.fn(actual.fsyncSync),
    renameSync: vi.fn(actual.renameSync),
  };
});

const roots: string[] = [];
afterEach(() => {
  vi.restoreAllMocks();
  vi.mocked(fs.writeFileSync).mockReset().mockImplementation(originalWrite);
  vi.mocked(fs.fsyncSync).mockReset().mockImplementation(originalSync);
  vi.mocked(fs.renameSync).mockReset().mockImplementation(originalRename);
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});
const originalWrite = vi.mocked(fs.writeFileSync).getMockImplementation()!;
const originalSync = vi.mocked(fs.fsyncSync).getMockImplementation()!;
const originalRename = vi.mocked(fs.renameSync).getMockImplementation()!;
function path() {
  const root = fs.mkdtempSync(join(tmpdir(), 'weq-bot-store-'));
  roots.push(root);
  return join(root, 'store.json');
}
const turn = { role: 'user' as const, text: '合成消息', ts: 1 };

it.each([JsonConversationStore, JsonMemoryStore, JsonNotesStore, JsonRelationStore])(
  '%s 保留损坏原件并明确拒绝加载',
  (Store) => {
    for (const raw of ['{broken', 'null', '[]', '{"bad":42}']) {
      const file = path();
      fs.writeFileSync(file, raw);
      expect(() => new Store(file)).toThrow();
      expect(fs.readFileSync(file, 'utf8')).toBe(raw);
    }
  },
);

it.each(['writeFileSync', 'fsyncSync', 'renameSync'] as const)(
  '%s 失败不发布内存变更、不损坏原件且清理临时文件',
  (operation) => {
    const file = path();
    const store = new JsonConversationStore(file);
    store.append('persona', [turn]);
    const before = fs.readFileSync(file, 'utf8');
    const operations = {
      writeFileSync: fs.writeFileSync,
      fsyncSync: fs.fsyncSync,
      renameSync: fs.renameSync,
    };
    vi.mocked(operations[operation]).mockImplementationOnce(() => {
      throw Object.assign(new Error('合成磁盘故障'), { code: 'ENOSPC' });
    });
    expect(() => store.append('persona', [{ ...turn, text: '未保存' }])).toThrow();
    expect(store.get('persona')).toEqual([turn]);
    expect(fs.readFileSync(file, 'utf8')).toBe(before);
    expect(new JsonConversationStore(file).get('persona')).toEqual([turn]);
    expect(fs.readdirSync(join(file, '..'))).toEqual(['store.json']);
  },
);

it('临时文件只写一部分后失败仍保留完整原件；不可读目录不当作空库', () => {
  const file = path();
  const store = new JsonConversationStore(file);
  store.append('p', [turn]);
  const before = fs.readFileSync(file, 'utf8');
  vi.mocked(fs.writeFileSync).mockImplementationOnce((target) => {
    originalWrite(target, '{partial');
    throw Object.assign(new Error('合成权限故障'), { code: 'EACCES' });
  });
  expect(() => store.append('p', [turn])).toThrow();
  expect(fs.readFileSync(file, 'utf8')).toBe(before);
  expect(store.get('p')).toEqual([turn]);
  expect(fs.readdirSync(join(file, '..'))).toEqual(['store.json']);
  const directory = path();
  fs.mkdirSync(directory);
  expect(() => new JsonConversationStore(directory)).toThrow(/原件已保留/);
});

it('记忆、笔记和关系写失败也保持最后持久化状态', () => {
  const memories = new JsonMemoryStore(path());
  memories.add('p', ['已保存'], 1);
  const before = memories.get('p');
  vi.mocked(fs.renameSync).mockImplementationOnce(() => {
    throw new Error('故障');
  });
  expect(() => memories.touch('p', [before[0]!.id], 2)).toThrow();
  expect(memories.get('p')).toEqual(before);
  vi.mocked(fs.renameSync).mockImplementationOnce(() => {
    throw new Error('故障');
  });
  expect(() => memories.add('p', ['未保存'], 2)).toThrow();
  expect(memories.get('p')).toEqual(before);
  const notes = new JsonNotesStore(path());
  notes.add('p', ['原纠正'], '原摘要');
  vi.mocked(fs.renameSync).mockImplementationOnce(() => {
    throw new Error('故障');
  });
  expect(() => notes.add('p', ['未保存'], '未保存')).toThrow();
  expect(notes.get('p')).toEqual({ corrections: ['原纠正'], episodes: ['原摘要'] });
  vi.mocked(fs.renameSync).mockImplementationOnce(() => {
    throw new Error('故障');
  });
  expect(() => notes.setReflectedCount('p', 8)).toThrow();
  expect(notes.getReflectedCount('p')).toBe(0);
  const relations = new JsonRelationStore(path());
  const relation = relations.applyDelta('p', 'user', 'user', { familiarity: 2 }, 1);
  vi.mocked(fs.renameSync).mockImplementationOnce(() => {
    throw new Error('故障');
  });
  expect(() => relations.applyDelta('p', 'user', 'user', { familiarity: 2 }, 2)).toThrow();
  expect(relations.get('p', 'user')).toEqual(relation);
});

it('返回值不可绕过持久化，特殊键与重启正常往返', () => {
  const file = path();
  const store = new JsonConversationStore(file);
  store.append('__proto__', [turn]);
  store.get('__proto__')[0]!.text = '外部修改';
  expect(store.get('__proto__')).toEqual([turn]);
  expect(new JsonConversationStore(file).get('__proto__')).toEqual([turn]);
  expect(store.get('constructor')).toEqual([]);
});
