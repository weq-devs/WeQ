import { describe, expect, it, vi } from 'vitest';
import type { NtHelperBinding } from '@weq/native';
import { createDirectAttachHook } from '../src/bootstrap/attach';

const material = { a2: '0011', d2: '2233', d2Key: '44'.repeat(16) };
describe('直接读取与权限助手回退', () => {
  it('直接读取成功时不访问特权助手', async () => {
    const fallback = vi.fn();
    const nt = { scanSessionMaterial: vi.fn(async () => material) } as unknown as NtHelperBinding;
    const hook = createDirectAttachHook(nt, fallback);
    expect(await hook.ensure(123, 'synthetic')).toEqual(material);
    expect(fallback).not.toHaveBeenCalled();
  });
  it('读取被拒后使用助手，并复用现有完整物料缓存', async () => {
    const fallback = vi.fn(async () => material);
    const nt = {
      scanSessionMaterial: vi.fn(async () => {
        throw new Error('access denied');
      }),
    } as unknown as NtHelperBinding;
    const hook = createDirectAttachHook(nt, fallback);
    await hook.ensure(123, 'synthetic');
    await hook.ensure(123, 'synthetic');
    expect(fallback).toHaveBeenCalledOnce();
    expect(nt.scanSessionMaterial).toHaveBeenCalledOnce();
  });
  it('没有长期授权时保留原始失败，不伪造可用物料', async () => {
    const failure = new Error('original failure');
    const nt = {
      scanSessionMaterial: vi.fn(async () => {
        throw failure;
      }),
    } as unknown as NtHelperBinding;
    await expect(
      createDirectAttachHook(nt, async () => null).ensure(123, 'synthetic'),
    ).rejects.toBe(failure);
  });
});
