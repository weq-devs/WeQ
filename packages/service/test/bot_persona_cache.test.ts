/**
 * CachedAgentLabStore（persona 读穿缓存）的行为契约：
 * 命中同一冻结对象、外部改写 / savePersona / deletePersona / 文件消失时失效、
 * listPersonas 保持可变新鲜对象、非法 id 走父类报错。
 * 合成数据，不碰真实 QQ 数据库、不联网。
 */
import * as fs from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { CachedAgentLabStore } from '../../bot/src/persona_cache';

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

interface Fixture {
  dir: string;
  path: string;
  store: CachedAgentLabStore;
}

function fixture(name = 'p1', pairsCount = 2): Fixture {
  const dir = fs.mkdtempSync(join(tmpdir(), 'weq-persona-cache-'));
  roots.push(dir);
  const pairs = Array.from({ length: pairsCount }, (_, i) => ({
    prompt: `问${i}`,
    answer: `答${i}`,
    keywords: [`kw${i}`],
  }));
  const record = {
    persona: {
      id: name,
      name: '合成克隆体',
      sourceKind: 'c2c',
      sourceId: 'u1',
      updatedAt: 1,
      models: { chat: { providerId: 'prov', model: 'deepseek-chat' } },
    },
    pairs,
  };
  const path = join(dir, `${name}.json`);
  fs.writeFileSync(path, JSON.stringify(record));
  return { dir, path, store: new CachedAgentLabStore(dir) };
}

/** 显式拨动 mtime，规避文件系统时间粒度差异（同尺寸改写也能可靠失效）。 */
function backdate(path: string, seconds = 5): void {
  const t = new Date(Date.now() - seconds * 1000);
  fs.utimesSync(path, t, t);
}

describe('CachedAgentLabStore', () => {
  it('未变时命中缓存：返回同一冻结对象，改写抛错', () => {
    const { store } = fixture();
    const a = store.getPersona('p1');
    const b = store.getPersona('p1');
    expect(a).not.toBeNull();
    expect(b).toBe(a);
    expect(Object.isFrozen(b!.persona)).toBe(true);
    expect(Object.isFrozen(b!.pairs[0])).toBe(true);
    expect(b!.pairs).toHaveLength(2);
    expect(() => {
      (b!.persona as { name: string }).name = '外部改写';
    }).toThrow(TypeError);
  });

  it('外部改写（尺寸变化）后失效并读到新内容', () => {
    const { store, path } = fixture();
    const before = store.getPersona('p1')!;
    const raw = JSON.parse(fs.readFileSync(path, 'utf8'));
    raw.persona.name = '改名后的克隆体';
    raw.pairs.push({ prompt: '问新', answer: '答新', keywords: [] });
    fs.writeFileSync(path, JSON.stringify(raw));
    backdate(path);
    const after = store.getPersona('p1')!;
    expect(after).not.toBe(before);
    expect(after.persona.name).toBe('改名后的克隆体');
    expect(after.pairs).toHaveLength(3);
  });

  it('同尺寸改写靠 mtime 失效', () => {
    const { store, path } = fixture();
    store.getPersona('p1');
    const sizeBefore = fs.statSync(path).size;
    const raw = JSON.parse(fs.readFileSync(path, 'utf8'));
    raw.persona.name = '名字五字长'; // 与「合成克隆体」同为 5 个 CJK 字符：文件尺寸不变
    fs.writeFileSync(path, JSON.stringify(raw));
    expect(fs.statSync(path).size).toBe(sizeBefore); // 测试前提：尺寸确实没变
    backdate(path);
    expect(store.getPersona('p1')!.persona.name).toBe('名字五字长');
  });

  it('savePersona 与 deletePersona 使缓存失效', () => {
    const { store } = fixture();
    const first = store.getPersona('p1')!;
    store.savePersona({
      persona: { ...first.persona, name: '保存后的名字' },
      pairs: first.pairs,
    });
    const second = store.getPersona('p1')!;
    expect(second).not.toBe(first);
    expect(second.persona.name).toBe('保存后的名字');
    expect(store.deletePersona('p1')).toBe(true);
    expect(store.getPersona('p1')).toBeNull();
  });

  it('外部删除文件后返回 null，不抛错也不返回旧缓存', () => {
    const { store, path } = fixture();
    expect(store.getPersona('p1')).not.toBeNull();
    fs.rmSync(path);
    expect(store.getPersona('p1')).toBeNull();
  });

  it('不存在的 id 返回 null；非法 id 仍由父类报错', () => {
    const { store } = fixture();
    expect(store.getPersona('nobody')).toBeNull();
    expect(() => store.getPersona('../evil')).toThrow();
    expect(() => store.getPersona('a/b')).toThrow();
  });

  it('listPersonas 不缓存：返回可变新鲜对象（boot 回填依赖可写）', () => {
    const { store } = fixture();
    const [persona] = store.listPersonas();
    expect(persona).toBeDefined();
    expect(Object.isFrozen(persona)).toBe(false);
    persona!.name = '可变';
    const again = store.listPersonas();
    expect(again[0]!.name).toBe('合成克隆体'); // 不受上一次改写影响
  });

  it('缓存不跨 id 串数据', () => {
    const dir = fs.mkdtempSync(join(tmpdir(), 'weq-persona-cache-'));
    roots.push(dir);
    for (const id of ['pa', 'pb']) {
      fs.writeFileSync(
        join(dir, `${id}.json`),
        JSON.stringify({
          persona: { id, name: id, updatedAt: 1, models: {} },
          pairs: [],
        }),
      );
    }
    const store = new CachedAgentLabStore(dir);
    expect(store.getPersona('pa')!.persona.name).toBe('pa');
    expect(store.getPersona('pb')!.persona.name).toBe('pb');
    expect(store.getPersona('pa')!.persona.name).toBe('pa');
  });
});
