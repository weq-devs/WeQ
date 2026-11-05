import { describe, expect, it } from 'vitest';
import { canReuseSessionMaterial, isCompleteSessionMaterial } from '../src/common/session_material';

const complete = {
  a2: 'aabb',
  d2: 'ccdd',
  d2Key: 'ee'.repeat(16),
  secToken: 'g0Re+NHuibp5',
};

describe('会话物料完整性', () => {
  it('只校验发包必需的三项，不因缺 secToken 判为不可用', () => {
    expect(isCompleteSessionMaterial(complete)).toBe(true);
    // SecToken 是「有更好」的附加项：没有它签名只是退化成旧行为。
    expect(isCompleteSessionMaterial({ ...complete, secToken: undefined })).toBe(true);
  });

  it.each([
    ['缺 a2', { ...complete, a2: undefined }],
    ['a2 不是偶数位 hex', { ...complete, a2: 'a' }],
    ['d2 非 hex', { ...complete, d2: 'not-hex' }],
    ['d2Key 过短', { ...complete, d2Key: 'cc' }],
    ['d2Key 非 hex', { ...complete, d2Key: 'zz'.repeat(16) }],
  ])('发包必需项不满足时判为不可用：%s', (_, value) => {
    expect(isCompleteSessionMaterial(value)).toBe(false);
  });
});

describe('本地物料复用判据', () => {
  it('缺 secToken 的老物料不复用，触发一次重扫', () => {
    // 升级前存下的物料：a2/d2/d2key 齐全但没有 secToken。
    // 照旧复用会让需要签名的命令一直带空 token，直到 QQ 重启才自愈。
    expect(canReuseSessionMaterial({ ...complete, secToken: undefined })).toBe(false);
    expect(canReuseSessionMaterial({ ...complete, secToken: '' })).toBe(false);
    expect(canReuseSessionMaterial({ ...complete })).toBe(true);
  });

  it('发包必需项不完整时同样不复用', () => {
    expect(canReuseSessionMaterial({ ...complete, a2: undefined })).toBe(false);
    expect(canReuseSessionMaterial(null)).toBe(false);
    expect(canReuseSessionMaterial(undefined)).toBe(false);
  });
});
