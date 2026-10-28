/**
 * bot 存储热路径的内存契约回归：
 * 冻结发布、增量冻结、读拷贝语义、热路径零 structuredClone、容量上限。
 * 合成数据，不碰真实 QQ 数据库、不联网。
 */
import * as fs from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { BotJsonFile, deepFreeze, isRecord } from '../src/json_file';
import {
  JsonConversationStore,
  JsonMemoryStore,
  JsonNotesStore,
  JsonRelationStore,
} from '../src/stores';

const roots: string[] = [];
function storePath(name: string): string {
  const root = fs.mkdtempSync(join(tmpdir(), 'weq-bot-hotpath-'));
  roots.push(root);
  return join(root, name);
}
afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

const turn = (text: string, ts: number) => ({ role: 'user' as const, text, ts });

/** 统计一段同步逻辑里 globalThis.structuredClone 的调用次数。 */
function countClones(run: () => void): number {
  const original = globalThis.structuredClone;
  let calls = 0;
  globalThis.structuredClone = ((value: unknown) => {
    calls += 1;
    return original(value);
  }) as typeof structuredClone;
  try {
    run();
  } finally {
    globalThis.structuredClone = original;
  }
  return calls;
}

describe('BotJsonFile 冻结发布', () => {
  it('发布数据整树冻结，原地改写抛错而不是静默污染', () => {
    const file = new BotJsonFile<{ a?: Array<{ b: number }> }>(
      storePath('f.json'),
      () => ({}),
      isRecord,
    );
    file.replace({ a: [{ b: 1 }] });
    expect(Object.isFrozen(file.data)).toBe(true);
    expect(Object.isFrozen(file.data.a)).toBe(true);
    expect(Object.isFrozen(file.data.a?.[0])).toBe(true);
    expect(() => {
      (file.data as { a?: Array<{ b: number }> }).a = [];
    }).toThrow(TypeError);
    expect(() => {
      if (file.data.a) file.data.a[0]!.b = 2;
    }).toThrow(TypeError);
  });

  it('加载既有文件同样冻结发布', () => {
    const path = storePath('f.json');
    fs.writeFileSync(path, JSON.stringify({ a: [{ b: 1 }] }));
    const file = new BotJsonFile<{ a?: Array<{ b: number }> }>(path, () => ({}), isRecord);
    expect(Object.isFrozen(file.data.a?.[0])).toBe(true);
  });

  it('增量 replace 不复制未变更子树（共享冻结引用）', () => {
    const file = new BotJsonFile<{ a?: unknown[]; b?: unknown[] }>(
      storePath('f.json'),
      () => ({}),
      isRecord,
    );
    file.replace({ a: [{ x: 1 }] });
    const publishedA = file.data.a;
    file.replace({ ...file.data, b: [{ y: 2 }] });
    // 未变更的 a 子树是同一个已冻结对象：证明没有整库深拷贝。
    expect(file.data.a).toBe(publishedA);
    expect(Object.isFrozen(file.data.b?.[0])).toBe(true);
  });

  it('deepFreeze 幂等且跳过已冻结子树', () => {
    const shared = deepFreeze({ deep: { value: 1 } });
    const wrapper = deepFreeze({ shared, fresh: [1, 2] });
    expect(wrapper.shared).toBe(shared);
    expect(Object.isFrozen(wrapper.fresh)).toBe(true);
  });
});

describe('Json store 读拷贝语义', () => {
  it('会话读取返回独立副本：改标量无害、改数组不影响存储', () => {
    const store = new JsonConversationStore(storePath('conversations.json'));
    store.append('p', [turn('原始', 1)]);
    const first = store.get('p');
    first[0]!.text = '外部修改';
    first.push(turn('外部追加', 2));
    first.sort(() => -1);
    expect(store.get('p')).toEqual([turn('原始', 1)]);
    expect(store.get('p')).not.toBe(first);
  });

  it('记忆条目为浅拷贝：标量可改（无害），共享的向量与关键词已冻结', () => {
    const store = new JsonMemoryStore(storePath('memories.json'));
    store.add('p', ['记住这句话'], 1, undefined, [[0.5, 0.25]]);
    const items = store.get('p');
    expect(items).toHaveLength(1);
    items[0]!.accessCount = 99; // 与旧深拷贝语义一致：改了也不影响存储
    expect(store.get('p')[0]!.accessCount).toBe(0);
    expect(Object.isFrozen(items[0]!.embedding)).toBe(true);
    expect(() => {
      items[0]!.embedding![0] = 1;
    }).toThrow(TypeError);
    expect(() => {
      items[0]!.keywords.push('污染');
    }).toThrow(TypeError);
  });

  it('关系态读取与 applyDelta 返回脱钩副本', () => {
    const store = new JsonRelationStore(storePath('relations.json'));
    const applied = store.applyDelta('p', 'u', 'user', { familiarity: 2 }, 5);
    applied.familiarity = 100;
    const got = store.get('p', 'u');
    expect(got?.familiarity).toBe(12); // 中性初值 10 + 2
    got!.affinity = 0;
    expect(store.get('p', 'u')?.affinity).toBe(50);
    expect(store.listForSubject('p')).toEqual([store.get('p', 'u')]);
  });

  it('原始值条目不能借「冻结跳过」混过校验', () => {
    // Object.isFrozen(非对象) 恒为 true：校验必须先用 isRecord 挡住原始值。
    const memPath = storePath('memories.json');
    fs.writeFileSync(memPath, JSON.stringify({ p: [42, 'x', null] }));
    expect(() => new JsonMemoryStore(memPath)).toThrow(/结构无效/);
    const convPath = storePath('conversations.json');
    fs.writeFileSync(convPath, JSON.stringify({ p: [1, 2] }));
    expect(() => new JsonConversationStore(convPath)).toThrow(/结构无效/);
  });

  it('touch 只更新命中条目；未命中不重写文件', () => {
    const path = storePath('memories.json');
    const store = new JsonMemoryStore(path);
    store.add('p', ['甲', '乙'], 1);
    const ids = store.get('p').map((m) => m.id);
    const before = fs.readFileSync(path, 'utf8');
    store.touch('p', ['不存在的id'], 2);
    expect(fs.readFileSync(path, 'utf8')).toBe(before);
    store.touch('p', [ids[0]!], 3);
    const after = store.get('p');
    expect(after.find((m) => m.id === ids[0])?.accessCount).toBe(1);
    expect(after.find((m) => m.id === ids[0])?.lastAccessedAt).toBe(3);
    expect(after.find((m) => m.id === ids[1])?.accessCount).toBe(0);
  });
});

describe('热路径分配回归', () => {
  it('一轮消息的存储操作零 structuredClone', () => {
    const conversations = new JsonConversationStore(storePath('conversations.json'));
    const memories = new JsonMemoryStore(storePath('memories.json'));
    const notes = new JsonNotesStore(storePath('notes.json'));
    const relations = new JsonRelationStore(storePath('relations.json'));
    memories.add('p', ['既有记忆'], 1, { aboutId: 'u', aboutKind: 'user' }, [[0.1, 0.2]]);
    const id = memories.get('p')[0]!.id;
    const clones = countClones(() => {
      // 模拟一条命中记忆的已回复私聊消息的完整存储路径
      memories.get('p');
      memories.getAbout('p', ['u'], true);
      notes.get('p');
      relations.get('p', 'u');
      conversations.get('p');
      conversations.getAll('p');
      conversations.append('p', [turn('用户', 2), { role: 'assistant', text: '回复', ts: 2 }]);
      memories.touch('p', [id], 2);
      relations.applyDelta('p', 'u', 'user', { familiarity: 2 }, 2);
      notes.add('p', ['纠正'], '一段经历');
      notes.setReflectedCount('p', 2);
    });
    expect(clones).toBe(0);
  });
});

describe('容量上限保持', () => {
  it('会话按 MAX_TURNS=400 截断，保留最新', () => {
    const store = new JsonConversationStore(storePath('conversations.json'));
    const many = Array.from({ length: 410 }, (_, i) => turn(`t${i}`, i));
    store.append('p', many);
    const kept = store.get('p');
    expect(kept).toHaveLength(400);
    expect(kept[0]).toEqual(turn('t10', 10));
    expect(kept[399]).toEqual(turn('t409', 409));
  });

  it('记忆按 MAX_MEMORIES=200 截断且去重', () => {
    const store = new JsonMemoryStore(storePath('memories.json'));
    const texts = Array.from({ length: 210 }, (_, i) => `记忆${i}`);
    store.add('p', texts, 1);
    store.add('p', ['记忆209', '记忆208'], 2); // 重复文本不新增
    const items = store.get('p');
    expect(items).toHaveLength(200);
    expect(items[0]!.text).toBe('记忆10');
    expect(items[199]!.text).toBe('记忆209');
  });

  it('笔记纠正去重截 20、经历截 8', () => {
    const store = new JsonNotesStore(storePath('notes.json'));
    store.add(
      'p',
      Array.from({ length: 25 }, (_, i) => `c${i}`),
      'e0',
    );
    for (let i = 1; i <= 10; i++) store.add('p', ['c24'], `e${i}`);
    const notes = store.get('p');
    expect(notes.corrections).toHaveLength(20);
    expect(notes.corrections[0]).toBe('c5');
    expect(notes.episodes).toHaveLength(8);
    expect(notes.episodes[7]).toBe('e10');
  });
});
