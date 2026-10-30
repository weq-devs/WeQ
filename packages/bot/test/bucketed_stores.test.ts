/**
 * 分桶存储行为契约：
 * 往返一致、hex 文件名兼容特殊键、legacy 迁移、损坏桶拒绝、LRU 淘汰后数据不丢、冻结语义。
 * 合成数据，不碰真实 QQ 数据库、不联网。
 */
import * as fs from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { bucketFileName, bucketKeyOf } from '../src/bucketed_store';
import { JsonConversationStore, JsonMemoryStore } from '../src/stores';

const roots: string[] = [];
function dirPath(name: string): string {
  const root = fs.mkdtempSync(join(tmpdir(), 'weq-bot-bucketed-'));
  roots.push(root);
  return join(root, name);
}
afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

const turn = (text: string, ts: number) => ({ role: 'user' as const, text, ts });
const BUCKETED = { bucketed: true };

describe('分桶存储', () => {
  it('会话往返与 400 截断（桶模式与单文件模式行为一致）', () => {
    const bucketed = new JsonConversationStore(dirPath('conversations.json'), BUCKETED);
    const legacy = new JsonConversationStore(dirPath('legacy.json'));
    for (const store of [bucketed, legacy]) {
      store.append('bot-scope-v1/abc:session1', [turn('第一条', 1)]);
      store.append('bot-scope-v1/abc:session1', [turn('第二条', 2)]);
      expect(store.get('bot-scope-v1/abc:session1')).toEqual([
        turn('第一条', 1),
        turn('第二条', 2),
      ]);
      expect(store.get('不存在')).toEqual([]);
    }
    const many = Array.from({ length: 410 }, (_, i) => turn(`t${i}`, i));
    bucketed.append('cap', many);
    const kept = bucketed.get('cap');
    expect(kept).toHaveLength(400);
    expect(kept[0]).toEqual(turn('t10', 10));
  });

  it('特殊键（含 / 与 :）落成 hex 文件名并可逆', () => {
    const key = 'bot-scope-v1/9f8e:sess-1';
    expect(bucketKeyOf(bucketFileName(key))).toBe(key);
    const path = dirPath('conversations.json');
    const store = new JsonConversationStore(path, BUCKETED);
    store.append(key, [turn('你好', 1)]);
    const files = fs.readdirSync(join(path.replace(/\.json$/, '') + '.d'));
    expect(files).toEqual([bucketFileName(key)]);
    expect(store.get(key)).toEqual([turn('你好', 1)]);
  });

  it('legacy 单文件自动迁移：数据完整、原件保留为 .migrated', () => {
    const path = dirPath('memories.json');
    const legacyData = {
      'bot-scope-v1/aaa': [
        {
          id: 'm1',
          text: '旧记忆',
          keywords: ['旧'],
          accessCount: 3,
          createdAt: 1,
          lastAccessedAt: 2,
          aboutId: 'u1',
          aboutKind: 'user',
        },
      ],
      'bot-scope-v1/bbb': [],
    };
    fs.writeFileSync(path, JSON.stringify(legacyData));
    const store = new JsonMemoryStore(path, BUCKETED);
    expect(store.get('bot-scope-v1/aaa')[0]?.text).toBe('旧记忆');
    expect(store.get('bot-scope-v1/aaa')[0]?.accessCount).toBe(3);
    expect(store.get('bot-scope-v1/bbb')).toEqual([]);
    expect(fs.existsSync(path)).toBe(false);
    expect(fs.existsSync(`${path}.migrated`)).toBe(true);
    expect(fs.readdirSync(`${path.replace(/\.json$/, '')}.d`)).toHaveLength(2);
    // 迁移后写入走桶文件
    store.touch('bot-scope-v1/aaa', ['m1'], 9);
    expect(store.get('bot-scope-v1/aaa')[0]?.lastAccessedAt).toBe(9);
  });

  it('迁移可重入：目录半迁移且旧文件仍在时以旧文件为准重拆', () => {
    const path = dirPath('conversations.json');
    fs.writeFileSync(path, JSON.stringify({ k1: [turn('a', 1)], k2: [turn('b', 2)] }));
    const bucketDir = path.replace(/\.json$/, '') + '.d';
    fs.mkdirSync(bucketDir, { recursive: true });
    fs.writeFileSync(join(bucketDir, bucketFileName('k1')), '{"半迁移":true}');
    const store = new JsonConversationStore(path, BUCKETED);
    expect(store.get('k1')).toEqual([turn('a', 1)]); // 以旧文件为准覆盖
    expect(store.get('k2')).toEqual([turn('b', 2)]);
    expect(fs.existsSync(`${path}.migrated`)).toBe(true);
  });

  it('损坏桶文件拒绝加载并保留原件，不波及其它键', () => {
    const path = dirPath('conversations.json');
    const store = new JsonConversationStore(path, BUCKETED);
    store.append('good', [turn('正常', 1)]);
    store.append('bad', [turn('将损坏', 2)]);
    const bucketDir = path.replace(/\.json$/, '') + '.d';
    const badFile = join(bucketDir, bucketFileName('bad'));
    fs.writeFileSync(badFile, '{broken');
    const reopened = new JsonConversationStore(path, BUCKETED);
    expect(reopened.get('good')).toEqual([turn('正常', 1)]);
    expect(() => reopened.get('bad')).toThrow(/原件已保留/);
    expect(fs.readFileSync(badFile, 'utf8')).toBe('{broken');
  });

  it('LRU 淘汰只丢内存副本：数据从磁盘完整读回', () => {
    const path = dirPath('memories.json');
    const store = new JsonMemoryStore(path, { bucketed: true, maxCachedBuckets: 2 });
    store.add('s1', ['记忆一'], 1);
    store.add('s2', ['记忆二'], 2);
    store.add('s3', ['记忆三'], 3); // 触发淘汰 s1
    expect(store.get('s1')[0]?.text).toBe('记忆一'); // 从磁盘读回
    expect(store.get('s2')[0]?.text).toBe('记忆二');
    expect(store.get('s3')[0]?.text).toBe('记忆三');
  });

  it('桶模式保持冻结语义与读拷贝契约', () => {
    const store = new JsonMemoryStore(dirPath('memories.json'), BUCKETED);
    store.add('s', ['带向量的记忆'], 1, undefined, [[0.5, 0.25]]);
    const items = store.get('s');
    items[0]!.accessCount = 99; // 标量改动无害（与旧语义一致）
    expect(store.get('s')[0]!.accessCount).toBe(0);
    expect(Object.isFrozen(items[0]!.embedding)).toBe(true);
    expect(() => {
      items[0]!.embedding![0] = 1;
    }).toThrow(TypeError);
  });

  it('缺省（无 opts）仍是单文件布局，不产生 .d 目录', () => {
    const path = dirPath('conversations.json');
    const store = new JsonConversationStore(path);
    store.append('k', [turn('单文件', 1)]);
    expect(fs.existsSync(path)).toBe(true);
    expect(fs.existsSync(path.replace(/\.json$/, '') + '.d')).toBe(false);
    expect(JSON.parse(fs.readFileSync(path, 'utf8')).k).toHaveLength(1);
  });
});
