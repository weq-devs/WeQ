/**
 * account/user_config 纯函数 + common/json_store 的离线单测（tmp 目录，不碰真实配置）。
 *
 * rkey/clientkey 过期计算是媒体下载补全和 web 凭证刷新的判断依据；accountConfigId
 * 是「同 uin 不同数据目录 = 两条记录」这个主键模型的落地；JsonStore 是十几个 store
 * 共用的读写底座 —— 都值得钉死。
 */

import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  accountConfigId,
  clientKeyExpiryMs,
  rkeyExpiryMs,
  type ClientKey,
  type DownloadRkey,
} from '../src/account/user_config';
import { JsonStore, readJsonFile, writeJsonFileAtomic } from '../src/common/json_store';

// ---- rkey / clientkey 过期 ----

describe('rkeyExpiryMs', () => {
  it('无 expiredAt：createTime + ttlSeconds', () => {
    const r: DownloadRkey = { rkey: '&rkey=CAQS', type: 10, ttlSeconds: 1800, createTime: 1000 };
    expect(rkeyExpiryMs(r)).toBe(2_800_000);
  });

  it('有 expiredAt：直接用它（外部 rkey 服务器只给绝对过期）', () => {
    const r: DownloadRkey = {
      rkey: '&rkey=x',
      type: 20,
      ttlSeconds: 1800,
      createTime: 1000,
      expiredAt: 9999,
    };
    expect(rkeyExpiryMs(r)).toBe(9_999_000);
  });

  it('expiredAt 为 0 时按实现直接采信（0 ≠ 缺省，调用方不该传 0）', () => {
    const r: DownloadRkey = {
      rkey: '&rkey=x',
      type: 10,
      ttlSeconds: 100,
      createTime: 50,
      expiredAt: 0,
    };
    expect(rkeyExpiryMs(r)).toBe(0);
  });
});

describe('clientKeyExpiryMs', () => {
  it('fetchedAt + ttlSeconds', () => {
    const c: ClientKey = {
      clientKey: 'ab12',
      keyIndex: '1',
      ttlSeconds: 1800,
      fetchedAt: 5_000_000,
    };
    expect(clientKeyExpiryMs(c)).toBe(6_800_000);
  });
});

// ---- accountConfigId ----

describe('accountConfigId', () => {
  it('无 dataDir → 裸 uin（兼容旧 <uin>.json）', () => {
    expect(accountConfigId('12345')).toBe('12345');
    expect(accountConfigId('12345', null)).toBe('12345');
  });

  it('有 dataDir → uin_短hash，同一 uin 不同目录得到不同 id', () => {
    const a = accountConfigId('12345', 'C:\\Tencent Files\\12345');
    const b = accountConfigId('12345', 'D:\\backup\\12345');
    expect(a).toMatch(/^12345_[0-9a-f]{8}$/);
    expect(a).not.toBe(b);
  });

  it('同目录稳定（trim + 小写归一）', () => {
    expect(accountConfigId('12345', 'C:\\Dir')).toBe(accountConfigId('12345', ' c:\\dir '));
  });
});

// ---- JsonStore / readJsonFile / writeJsonFileAtomic ----

const tmpRoots: string[] = [];
function tmpDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'weq-json-store-'));
  tmpRoots.push(dir);
  return dir;
}
afterEach(() => {
  for (const dir of tmpRoots) rmSync(dir, { recursive: true, force: true });
  tmpRoots.length = 0;
});

interface Shape {
  n: number;
}

describe('JsonStore', () => {
  it('文件缺失 → makeInitial', () => {
    const dir = tmpDir();
    const store = new JsonStore<Shape>(join(dir, 'nope.json'), () => ({ n: 0 }));
    expect(store.data).toEqual({ n: 0 });
  });

  it('save → 重开读回', () => {
    const dir = tmpDir();
    const path = join(dir, 's.json');
    const store = new JsonStore<Shape>(path, () => ({ n: 0 }));
    store.data = { n: 42 };
    store.save();
    expect(new JsonStore<Shape>(path, () => ({ n: 0 })).data).toEqual({ n: 42 });
  });

  it('损坏 JSON → 回落 initial（读永不抛）', () => {
    const dir = tmpDir();
    const path = join(dir, 'broken.json');
    writeFileSync(path, '{not json');
    expect(new JsonStore<Shape>(path, () => ({ n: -1 })).data).toEqual({ n: -1 });
  });

  it('normalize 抛错 → 回落 initial', () => {
    const dir = tmpDir();
    const path = join(dir, 'bad-shape.json');
    writeFileSync(path, '{"n":"not-a-number"}');
    const store = new JsonStore<Shape>(path, () => ({ n: 7 }), {
      normalize: (raw) => {
        const { n } = raw as Shape;
        if (typeof n !== 'number') throw new TypeError('bad n');
        return { n };
      },
    });
    expect(store.data).toEqual({ n: 7 });
  });

  it('normalize 合法值透传', () => {
    const dir = tmpDir();
    const path = join(dir, 'ok.json');
    writeFileSync(path, '{"n":3}');
    const store = new JsonStore<Shape>(path, () => ({ n: 0 }), {
      normalize: (raw) => raw as Shape,
    });
    expect(store.data).toEqual({ n: 3 });
  });

  it('pretty 选项落盘为缩进 JSON', () => {
    const dir = tmpDir();
    const path = join(dir, 'pretty.json');
    new JsonStore<Shape>(path, () => ({ n: 1 }), { pretty: true }).save();
    expect(readFileSync(path, 'utf-8')).toBe('{\n  "n": 1\n}');
  });

  it('save 写到不可写路径静默失败（不抛）', () => {
    // 目录路径当文件用 → rename 必失败；持久化失败不应影响主流程。
    const dir = tmpDir();
    expect(() => new JsonStore<Shape>(dir, () => ({ n: 1 })).save()).not.toThrow();
  });
});

describe('readJsonFile / writeJsonFileAtomic', () => {
  it('写 → 读 roundtrip；父目录懒建', () => {
    const dir = tmpDir();
    const path = join(dir, 'deep/nested/data.json');
    writeJsonFileAtomic(path, { a: [1, 2] });
    expect(readJsonFile(path)).toEqual({ a: [1, 2] });
  });

  it.each([
    ['缺失', null],
    ['损坏', 'garbage'],
  ])('%s → null', (_label, content) => {
    const dir = tmpDir();
    const path = join(dir, 'x.json');
    if (content !== null) writeFileSync(path, content);
    expect(readJsonFile(path)).toBeNull();
  });

  it('原子写：同目录不留 .tmp 残留', () => {
    const dir = tmpDir();
    const path = join(dir, 'f.json');
    writeJsonFileAtomic(path, {});
    const files = readdirSync(dir);
    expect(files).toEqual(['f.json']);
  });
});
