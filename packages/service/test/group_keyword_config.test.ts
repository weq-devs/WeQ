/**
 * 群关键词提醒规则的**落盘**与归一化。用户最关心的「重启后还在不在」就靠这一层：
 *   - setSettings 写回 settings.groupKeyword.rules → 下次 new UserConfigService 读得到；
 *   - 归一化丢弃空关键词 / 去重 / 非数字群号；
 *   - 其它群的规则不会被顺带弄丢（整份 rules 写回，但内容保持一致）。
 */

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { Platform } from '@weq/platform';
import { UserConfigService, normalizeGroupKeywordRules } from '../src/bootstrap/user_config';

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

describe('normalizeGroupKeywordRules', () => {
  it('丢弃空关键词 / 非字符串，去重并 trim', () => {
    expect(
      normalizeGroupKeywordRules({
        '123': { keywords: ['  报名  ', '', '报名', 5, '报名'], memberUids: ['u_a', 'u_a', ''] },
      }),
    ).toEqual({ '123': { keywords: ['报名'], memberUids: ['u_a'] } });
  });

  it('非数字群号 / 空关键词的群整条丢弃', () => {
    expect(
      normalizeGroupKeywordRules({
        u_abc: { keywords: ['x'], memberUids: [] },
        '456': { keywords: ['   '], memberUids: [] },
      }),
    ).toEqual({});
  });

  it('非对象输入返回空表', () => {
    expect(normalizeGroupKeywordRules(null)).toEqual({});
    expect(normalizeGroupKeywordRules('nope')).toEqual({});
  });
});

describe('UserConfigService 群关键词规则落盘', () => {
  it('setSettings 后重启仍在', () => {
    const dir = tmpDir();
    const service = new UserConfigService(fakePlatform(dir));
    service.setSettings({
      groupKeyword: { rules: { '123': { keywords: ['报名'], memberUids: ['u_a'] } } },
    });

    const restarted = new UserConfigService(fakePlatform(dir));
    expect(restarted.getSettings().groupKeyword.rules).toEqual({
      '123': { keywords: ['报名'], memberUids: ['u_a'] },
    });
  });

  it('写一个群不会弄丢另一个群', () => {
    const dir = tmpDir();
    const service = new UserConfigService(fakePlatform(dir));
    service.setSettings({
      groupKeyword: {
        rules: {
          '1': { keywords: ['a'], memberUids: [] },
          '2': { keywords: ['b'], memberUids: ['u_x'] },
        },
      },
    });
    // 前端总是整份 rules 写回；这里模拟只改 1，把 2 原样带上。
    service.setSettings({
      groupKeyword: {
        rules: {
          '1': { keywords: ['a', 'c'], memberUids: [] },
          '2': { keywords: ['b'], memberUids: ['u_x'] },
        },
      },
    });
    expect(new UserConfigService(fakePlatform(dir)).getSettings().groupKeyword.rules).toEqual({
      '1': { keywords: ['a', 'c'], memberUids: [] },
      '2': { keywords: ['b'], memberUids: ['u_x'] },
    });
  });

  it('清空关键词 = 删除该群规则', () => {
    const dir = tmpDir();
    const service = new UserConfigService(fakePlatform(dir));
    service.setSettings({
      groupKeyword: { rules: { '1': { keywords: ['a'], memberUids: [] } } },
    });
    service.setSettings({ groupKeyword: { rules: {} } });
    expect(new UserConfigService(fakePlatform(dir)).getSettings().groupKeyword.rules).toEqual({});
  });
});
