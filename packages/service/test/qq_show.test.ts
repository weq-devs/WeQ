import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  ChatQqShowService,
  DEFAULT_QQ_SHOW_CACHE_DAYS,
  type QqShowResolved,
} from '../src/account/qq_show';

const DAY = 24 * 60 * 60 * 1000;

let dir: string;
let storePath: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'weq-qqshow-'));
  storePath = join(dir, 'qqshow.json');
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function harness(options: {
  fetchShow: (uin: string) => Promise<QqShowResolved>;
  now?: () => number;
  ttlDays?: () => number;
  concurrency?: number;
}) {
  return new ChatQqShowService({
    storePath,
    fetchShow: options.fetchShow,
    now: options.now,
    ttlDays: options.ttlDays ?? (() => DEFAULT_QQ_SHOW_CACHE_DAYS),
    concurrency: options.concurrency,
  });
}

const show = (uin: string): QqShowResolved => ({
  hasShow: true,
  url: `https://images.qqshow.gtimg.com/images/${uin}/102.png`,
});

describe('ChatQqShowService', () => {
  it('并发不超过 3、同一 uin 只查一次，并缓存无 QQ 秀的结果', async () => {
    let running = 0;
    let peak = 0;
    const calls: string[] = [];
    const service = harness({
      fetchShow: async (uin) => {
        calls.push(uin);
        running += 1;
        peak = Math.max(peak, running);
        await new Promise((resolve) => setTimeout(resolve, 5));
        running -= 1;
        return uin === '20002' ? { hasShow: false, url: '' } : show(uin);
      },
    });

    const result = await service.resolve([
      '10001',
      '10001',
      '10002',
      '10003',
      '10004',
      '10005',
      '20002',
      'not-a-uin',
    ]);

    expect(peak).toBeLessThanOrEqual(3);
    expect(calls.slice().sort()).toEqual(['10001', '10002', '10003', '10004', '10005', '20002']);
    expect(result['10001']).toEqual(show('10001'));
    expect(result['20002']).toEqual({ hasShow: false, url: '' });
    expect(result['not-a-uin']).toBeUndefined();

    // 第二次全命中缓存，不再联网。
    calls.length = 0;
    const again = await service.resolve(['10001', '20002']);
    expect(calls).toEqual([]);
    expect(again['10001']).toEqual(show('10001'));
    expect(again['20002']).toEqual({ hasShow: false, url: '' });
  });

  it('映射落盘并可在新实例中读取，过期后重新查询', async () => {
    let now = Date.UTC(2026, 9, 1);
    let calls = 0;
    const first = harness({
      now: () => now,
      fetchShow: async (uin) => {
        calls += 1;
        return show(uin);
      },
    });
    await first.resolve(['30001']);
    expect(calls).toBe(1);

    const saved = JSON.parse(readFileSync(storePath, 'utf-8')) as {
      entries: Record<string, { url: string }>;
    };
    expect(saved.entries['30001']?.url).toBe(show('30001').url);

    const reopened = harness({
      now: () => now,
      fetchShow: async () => {
        calls += 1;
        return { hasShow: false, url: '' };
      },
    });
    expect(reopened.cached('30001')).toEqual(show('30001'));

    // 默认 14 天：第 13 天仍命中，第 15 天重新查询。
    now += 13 * DAY;
    expect(reopened.cached('30001')).toEqual(show('30001'));
    now += 2 * DAY;
    expect(reopened.cached('30001')).toBeNull();

    const refreshed = await reopened.resolve(['30001']);
    expect(calls).toBe(2);
    expect(refreshed['30001']).toEqual({ hasShow: false, url: '' });
  });

  it('有效期按设置读取，缩短后立即生效', async () => {
    let now = Date.UTC(2026, 9, 1);
    let days = 14;
    const service = harness({
      now: () => now,
      ttlDays: () => days,
      fetchShow: async (uin) => show(uin),
    });
    await service.resolve(['40001']);
    now += 2 * DAY;
    expect(service.cached('40001')).not.toBeNull();
    days = 1;
    expect(service.cached('40001')).toBeNull();
  });

  it('查询失败不清掉旧记录，过期记录仍可兜底', async () => {
    let now = Date.UTC(2026, 9, 1);
    let fail = false;
    const service = harness({
      now: () => now,
      ttlDays: () => 1,
      fetchShow: async (uin) => {
        if (fail) throw new Error('QQ 离线');
        return show(uin);
      },
    });
    await service.resolve(['50001']);

    now += 2 * DAY;
    fail = true;
    const stale = await service.resolve(['50001']);
    expect(stale['50001']).toEqual(show('50001'));
    expect(await service.resolveOne('50001')).toEqual(show('50001'));

    // 未缓存过的 uin 失败后不出现在结果里，也不写坏记录。
    const missing = await service.resolve(['50002']);
    expect(missing['50002']).toBeUndefined();
    await expect(service.resolveOne('50002')).rejects.toThrow('QQ 离线');
  });
});
