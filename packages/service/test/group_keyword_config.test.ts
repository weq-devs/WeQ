/**
 * 群关键词提醒规则的**按账号落盘**、归一化、以及旧版全局配置的一次性迁移。
 *
 * 规则过去存在全局 settings（`settings.groupKeyword.rules`，与账号无关），两个号加
 * 同一个群时会互相串。现在按账号存进 `config/accounts/<configId>.json`。这一层保证：
 *   - 归一化丢弃空关键词 / 去重 / 非数字群号，兼容旧的群级 memberUids 格式；
 *   - `setGroupKeywordRules` 写回账号记录，重启后仍在；
 *   - 不同账号互不干扰（同群号也是各存各的）；
 *   - 升级时旧的全局规则被复制进已存账号并清掉旧键。
 */

import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { Platform } from '@weq/platform';
import { AccountConfigService, accountConfigId } from '../src/account/user_config';
import { UserConfigService } from '../src/bootstrap/user_config';
import { normalizeGroupKeywordRules } from '../src/account/group_keyword';

const roots: string[] = [];
function tmpDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'weq-gk-cfg-'));
  roots.push(dir);
  return dir;
}
afterEach(() => {
  for (const r of roots) rmSync(r, { recursive: true, force: true });
  roots.length = 0;
});

function fakePlatform(root: string): Platform {
  return { kind: 'linux', appDataRoot: () => root } as unknown as Platform;
}

/** 建一个已 save 过的账号配置服务（记录已 seed，后续 patch 才有落点）。 */
function accountSvc(dir: string, uin: string, dataDir: string): AccountConfigService {
  const session = {
    context: { uin, dbKey: 'k', algos: {} },
  } as unknown as ConstructorParameters<typeof AccountConfigService>[0];
  const s = new AccountConfigService(session, dir);
  s.save({ dataDir });
  return s;
}

describe('UserConfigService 设备 guid / a1 同步', () => {
  it('rotateAccountGuids 把所有账号记录换成新 guid，并作废旧 a1 payload', () => {
    const dir = tmpDir();
    const a = accountSvc(dir, '111', '/data/111');
    const b = accountSvc(dir, '222', '/data/222');
    a.setGuid('old'.repeat(10));
    a.setA1Payload('aa'.repeat(8));
    b.setGuid('old'.repeat(10));
    b.setA1Payload('bb'.repeat(8));

    const svc = new UserConfigService(fakePlatform(dir));
    const next = 'cd'.repeat(16);
    svc.rotateAccountGuids(next);

    const records = svc.listAccountConfigs();
    expect(records.map((r) => r.guid)).toEqual([next, next]);
    // 旧 guid 解出来的 a1 payload 已经失效 —— 必须清掉，不能留在盘上。
    expect(records.every((r) => r.a1Payload === undefined)).toBe(true);
  });

  it('clearAccountA1Payload 只清命中的那个账号', () => {
    const dir = tmpDir();
    const a = accountSvc(dir, '111', '/data/111');
    const b = accountSvc(dir, '222', '/data/222');
    a.setA1Payload('aa'.repeat(8));
    b.setA1Payload('bb'.repeat(8));

    const svc = new UserConfigService(fakePlatform(dir));
    svc.clearAccountA1Payload('111');

    const byUin = new Map(svc.listAccountConfigs().map((r) => [r.uin, r]));
    expect(byUin.get('111')?.a1Payload).toBeUndefined();
    expect(byUin.get('222')?.a1Payload).toBe('bb'.repeat(8));
  });

  it('rotateAccountGuids 在没有账号记录目录时静默跳过（不抛）', () => {
    const dir = tmpDir();
    const svc = new UserConfigService(fakePlatform(dir));
    expect(() => svc.rotateAccountGuids('ab'.repeat(16))).not.toThrow();
    expect(svc.listAccountConfigs()).toEqual([]);
  });
});

describe('normalizeGroupKeywordRules', () => {
  it('丢弃空关键词 / 非字符串，去重并 trim（新格式：每个词带自己的成员范围）', () => {
    expect(
      normalizeGroupKeywordRules({
        '123': {
          keywords: [
            { keyword: '  报名  ', memberUids: ['u_a', 'u_a', ''] },
            { keyword: '', memberUids: [] },
            { keyword: '报名', memberUids: ['u_b'] },
            5,
          ],
        },
      }),
    ).toEqual({ '123': { keywords: [{ keyword: '报名', memberUids: ['u_a'] }] } });
  });

  it('旧格式（群级 memberUids + 裸字符串关键词）迁移到每个词', () => {
    expect(
      normalizeGroupKeywordRules({
        '123': { keywords: ['报名', '签到'], memberUids: ['u_a', 'u_a', ''] },
      }),
    ).toEqual({
      '123': {
        keywords: [
          { keyword: '报名', memberUids: ['u_a'] },
          { keyword: '签到', memberUids: ['u_a'] },
        ],
      },
    });
  });

  it('非数字群号 / 空关键词的群整条丢弃', () => {
    expect(
      normalizeGroupKeywordRules({
        u_abc: { keywords: [{ keyword: 'x', memberUids: [] }] },
        '456': { keywords: [{ keyword: '   ', memberUids: [] }] },
      }),
    ).toEqual({});
  });

  it('非对象输入返回空表', () => {
    expect(normalizeGroupKeywordRules(null)).toEqual({});
    expect(normalizeGroupKeywordRules('nope')).toEqual({});
  });
});

describe('AccountConfigService 群关键词规则落盘（按账号）', () => {
  it('setGroupKeywordRules 后重启仍在', () => {
    const dir = tmpDir();
    const s = accountSvc(dir, '1707889225', '/tmp/data-a');
    s.setGroupKeywordRules({ '123': { keywords: [{ keyword: '报名', memberUids: ['u_a'] }] } });

    // 重新打开同一账号（新的 service 实例，模拟重启）。
    const restarted = accountSvc(dir, '1707889225', '/tmp/data-a');
    expect(restarted.getGroupKeywordRules()).toEqual({
      '123': { keywords: [{ keyword: '报名', memberUids: ['u_a'] }] },
    });
  });

  it('从未配置过返回 {}（不是 null 语义上等价于该账号不提醒）', () => {
    const dir = tmpDir();
    const s = accountSvc(dir, '1707889225', '/tmp/data-a');
    expect(s.getGroupKeywordRules()).toEqual({});
  });

  it('不同账号互不干扰：同一个群号各存各的', () => {
    const dir = tmpDir();
    const a = accountSvc(dir, '10001', '/tmp/data-a');
    const b = accountSvc(dir, '10002', '/tmp/data-b');
    a.setGroupKeywordRules({ '123': { keywords: [{ keyword: '甲方', memberUids: [] }] } });
    b.setGroupKeywordRules({ '123': { keywords: [{ keyword: '乙方', memberUids: [] }] } });

    expect(accountSvc(dir, '10001', '/tmp/data-a').getGroupKeywordRules()).toEqual({
      '123': { keywords: [{ keyword: '甲方', memberUids: [] }] },
    });
    expect(accountSvc(dir, '10002', '/tmp/data-b').getGroupKeywordRules()).toEqual({
      '123': { keywords: [{ keyword: '乙方', memberUids: [] }] },
    });
  });

  it('清空关键词 = 该账号不再提醒（空表落盘，不回退到别的账号）', () => {
    const dir = tmpDir();
    const s = accountSvc(dir, '1707889225', '/tmp/data-a');
    s.setGroupKeywordRules({ '1': { keywords: [{ keyword: 'a', memberUids: [] }] } });
    s.setGroupKeywordRules({});
    expect(accountSvc(dir, '1707889225', '/tmp/data-a').getGroupKeywordRules()).toEqual({});
  });

  it('写回账号记录文件（config/accounts/<configId>.json 的 groupKeyword 字段）', () => {
    const dir = tmpDir();
    const s = accountSvc(dir, '1707889225', '/tmp/data-a');
    s.setGroupKeywordRules({ '1': { keywords: [{ keyword: 'a', memberUids: [] }] } });
    const file = join(
      dir,
      'config',
      'accounts',
      `${accountConfigId('1707889225', '/tmp/data-a')}.json`,
    );
    expect(JSON.parse(readFileSync(file, 'utf-8')).groupKeyword).toEqual({
      '1': { keywords: [{ keyword: 'a', memberUids: [] }] },
    });
  });
});

describe('旧版全局群关键词配置的一次性迁移', () => {
  /** 造一份旧版 config.json：规则在 settings.groupKeyword.rules 里。 */
  function seedLegacyGlobal(dir: string, rules: unknown): void {
    mkdirSync(dir, { recursive: true });
    const settings = {
      realtimeEnabled: false,
      groupKeyword: { rules },
    };
    writeFileSync(join(dir, 'config.json'), JSON.stringify({ settings }, null, 2));
  }

  /** 直接造一个账号记录文件（不走 service，避免顺带写 settings）。 */
  function seedAccount(dir: string, uin: string, dataDir: string): string {
    const accountsDir = join(dir, 'config', 'accounts');
    mkdirSync(accountsDir, { recursive: true });
    const configId = accountConfigId(uin, dataDir);
    writeFileSync(
      join(accountsDir, `${configId}.json`),
      JSON.stringify({ configId, uin, dataDir, dbKey: '', algos: {}, lastLoginAt: 1 }, null, 2),
    );
    return configId;
  }

  it('把旧全局规则复制进已存账号，并清掉 settings 里的旧键', () => {
    const dir = tmpDir();
    const configId = seedAccount(dir, '10001', '/tmp/data-a');
    seedLegacyGlobal(dir, { '123': { keywords: [{ keyword: '报名', memberUids: ['u_a'] }] } });

    new UserConfigService(fakePlatform(dir)); // 构造即触发迁移

    const rec = JSON.parse(
      readFileSync(join(dir, 'config', 'accounts', `${configId}.json`), 'utf-8'),
    );
    expect(rec.groupKeyword).toEqual({
      '123': { keywords: [{ keyword: '报名', memberUids: ['u_a'] }] },
    });
    // 旧键被清掉（settings 里不再有 groupKeyword），其它偏好保持。
    const cfg = JSON.parse(readFileSync(join(dir, 'config.json'), 'utf-8'));
    expect(cfg.settings.groupKeyword).toBeUndefined();
    expect(cfg.settings.realtimeEnabled).toBe(false);
  });

  it('已经按账号配过的账号不被旧全局值覆盖', () => {
    const dir = tmpDir();
    const configId = seedAccount(dir, '10001', '/tmp/data-a');
    const file = join(dir, 'config', 'accounts', `${configId}.json`);
    const rec = JSON.parse(readFileSync(file, 'utf-8'));
    rec.groupKeyword = { '999': { keywords: [{ keyword: '账号自己的', memberUids: [] }] } };
    writeFileSync(file, JSON.stringify(rec, null, 2));
    seedLegacyGlobal(dir, { '123': { keywords: [{ keyword: '全局旧值', memberUids: [] }] } });

    new UserConfigService(fakePlatform(dir));

    expect(JSON.parse(readFileSync(file, 'utf-8')).groupKeyword).toEqual({
      '999': { keywords: [{ keyword: '账号自己的', memberUids: [] }] },
    });
  });

  it('旧键存在但为空时不改任何账号，只清键', () => {
    const dir = tmpDir();
    const configId = seedAccount(dir, '10001', '/tmp/data-a');
    seedLegacyGlobal(dir, {});

    new UserConfigService(fakePlatform(dir));

    expect(
      JSON.parse(readFileSync(join(dir, 'config', 'accounts', `${configId}.json`), 'utf-8'))
        .groupKeyword,
    ).toBeUndefined();
    expect(
      JSON.parse(readFileSync(join(dir, 'config.json'), 'utf-8')).settings.groupKeyword,
    ).toBeUndefined();
  });

  it('没有旧键时是 no-op（settings 原样保留）', () => {
    const dir = tmpDir();
    const svc = new UserConfigService(fakePlatform(dir));
    svc.setSettings({ realtimeEnabled: false });
    expect(new UserConfigService(fakePlatform(dir)).getSettings().realtimeEnabled).toBe(false);
  });
});
