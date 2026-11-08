/**
 * `qq_version_catalog` —— 版本清单的纯逻辑。
 *
 * 这些规则最容易出错的点是**版本号比较**和**CDN 灰度导致的版本倒退**：
 * 官网配置在多个边缘节点上不是一起更新的，同一个 URL 可能这次返回 `9.9.37`、
 * 下次返回 `9.9.36`。直接覆盖会让 `latest.json` 每晚抖动。
 */
import { describe, expect, it } from 'vitest';
import {
  compareVersions,
  diffLatest,
  mergeLatest,
  registerPending,
  type LatestFile,
  type SupportedFile,
} from '../src/bootstrap/qq_version_catalog';

function latest(versions: Record<string, { version: string; url?: string | null }>): LatestFile {
  const out: LatestFile['versions'] = {};
  for (const [key, value] of Object.entries(versions)) {
    out[key] = { version: value.version, url: value.url ?? null, updateDate: '2026-11-03' };
  }
  return { fetchedAt: '2026-11-08T00:00:00Z', source: 'test', versions: out };
}

describe('compareVersions', () => {
  it('按数字段比较，不是字符串比较', () => {
    expect(compareVersions('9.9.37', '9.9.36')).toBeGreaterThan(0);
    // 字符串比较会认为 '3.2.9' > '3.2.35'，这是错的。
    expect(compareVersions('3.2.35', '3.2.9')).toBeGreaterThan(0);
    expect(compareVersions('7.0.3', '7.0.3')).toBe(0);
    expect(compareVersions('7.0.2', '7.0.3')).toBeLessThan(0);
  });

  it('段数不同时缺失段按 0 处理', () => {
    expect(compareVersions('9.9', '9.9.0')).toBe(0);
    expect(compareVersions('9.9.1', '9.9')).toBeGreaterThan(0);
  });

  it('空值不抛错', () => {
    expect(compareVersions(null, undefined)).toBe(0);
    expect(compareVersions('', '0')).toBe(0);
  });
});

describe('diffLatest', () => {
  it('首次抓取全部算新增', () => {
    const changes = diffLatest(null, latest({ 'linux-x64': { version: '3.2.35' } }));
    expect(changes).toEqual([{ key: 'linux-x64', from: null, to: '3.2.35', kind: 'upgrade' }]);
  });

  it('区分升级、倒退与仅 URL 变化', () => {
    const previous = latest({
      'linux-x64': { version: '3.2.34', url: 'old' },
      'windows-x64': { version: '9.9.37', url: 'same' },
      'macos-x64': { version: '7.0.2', url: 'a' },
    });
    const next = latest({
      'linux-x64': { version: '3.2.35', url: 'new' },
      // CDN 灰度：官网这次返回了更旧的版本。
      'windows-x64': { version: '9.9.36', url: 'same' },
      'macos-x64': { version: '7.0.2', url: 'b' },
    });
    expect(diffLatest(previous, next)).toEqual([
      { key: 'linux-x64', from: '3.2.34', to: '3.2.35', kind: 'upgrade' },
      { key: 'windows-x64', from: '9.9.37', to: '9.9.36', kind: 'regression' },
      { key: 'macos-x64', from: '7.0.2', to: '7.0.2', kind: 'url' },
    ]);
  });
});

describe('mergeLatest', () => {
  it('版本倒退时保留已记录的版本，并留下说明', () => {
    const previous = latest({ 'windows-x64': { version: '9.9.37', url: 'new' } });
    const fetched = latest({ 'windows-x64': { version: '9.9.36', url: 'old' } });
    const merged = mergeLatest(previous, fetched);
    expect(merged.versions['windows-x64'].version).toBe('9.9.37');
    expect(merged.versions['windows-x64'].url).toBe('new');
    expect(merged.versions['windows-x64'].stale).toContain('9.9.36');
  });

  it('正常升级照常覆盖', () => {
    const previous = latest({ 'linux-x64': { version: '3.2.34' } });
    const fetched = latest({ 'linux-x64': { version: '3.2.35' } });
    expect(mergeLatest(previous, fetched).versions['linux-x64'].version).toBe('3.2.35');
  });

  it('内容没变时保留旧的 fetchedAt（脚本据此避免空提交）', () => {
    // mergeLatest 本身不碰 fetchedAt；这条锁的是「调用方该怎么做」的契约：
    // 没有变化时应当沿用 previous.fetchedAt。
    const previous = latest({ 'linux-x64': { version: '3.2.35' } });
    const fetched = {
      ...latest({ 'linux-x64': { version: '3.2.35' } }),
      fetchedAt: '2026-11-09T00:00:00Z',
    };
    expect(diffLatest(previous, fetched)).toEqual([]);
    const merged = mergeLatest(previous, fetched);
    expect(merged.versions['linux-x64'].version).toBe('3.2.35');
  });

  it('没有历史记录时原样采用', () => {
    const fetched = latest({ 'macos-arm64': { version: '7.0.3' } });
    expect(mergeLatest(null, fetched).versions['macos-arm64'].version).toBe('7.0.3');
  });
});

describe('registerPending', () => {
  it('只登记没验证过、也没登记过的版本', () => {
    const supported: SupportedFile = {
      platforms: { 'linux-x64': [{ version: '3.2.34', verifiedAt: 'x', sign: { ok: true } }] },
      pending: [],
    };
    const next = latest({
      'linux-x64': { version: '3.2.35', url: 'u35' },
      'windows-x64': { version: '9.9.37', url: 'u37' },
      'macos-x64': { version: '7.0.2', url: 'u702' },
    });
    const result = registerPending(supported, next);
    expect(result.pending.map((p) => `${p.platform}:${p.version}`)).toEqual([
      'linux-x64:3.2.35',
      'windows-x64:9.9.37',
      'macos-x64:7.0.2',
    ]);
  });

  it('已登记过的 pending 不重复添加', () => {
    const supported: SupportedFile = {
      platforms: {},
      pending: [{ platform: 'linux-x64', version: '3.2.35', url: 'u', discoveredAt: 'old' }],
    };
    const result = registerPending(supported, latest({ 'linux-x64': { version: '3.2.35' } }));
    expect(result.pending).toHaveLength(1);
    expect(result.pending[0].discoveredAt).toBe('old');
  });

  it('同平台验证过该版本时跳过（即使 pending 里没有）', () => {
    const supported: SupportedFile = {
      platforms: { 'linux-x64': [{ version: '3.2.35', verifiedAt: 'x', sign: { ok: true } }] },
      pending: [],
    };
    const result = registerPending(supported, latest({ 'linux-x64': { version: '3.2.35' } }));
    expect(result.pending).toEqual([]);
  });
});
