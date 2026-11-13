// @vitest-environment node
import { describe, expect, it, vi } from 'vitest';
import type { Platform } from '@weq/platform';
import { resolveSignerWrapper } from '../src/main/context/signer_target';

function fixture(kind = 'darwin') {
  const qqWrapperNodePath = vi.fn((pid?: number) =>
    pid === 42 ? '/hot-update/wrapper.node' : '/installed/wrapper.node',
  );
  const resolveQqPid = vi.fn(() => 42);
  const resolveQqPidAsync = vi.fn(async () => 42 as number | null);
  return {
    platform: { kind, qqWrapperNodePath, resolveQqPid, resolveQqPidAsync } as unknown as Platform,
    qqWrapperNodePath,
    resolveQqPid,
    resolveQqPidAsync,
  };
}
describe('签名预热目标', () => {
  it('macOS 启动还没有账号时不预加载安装目录的 wrapper', async () => {
    const f = fixture();
    expect(await resolveSignerWrapper(f.platform)).toBeNull();
    expect(f.qqWrapperNodePath).not.toHaveBeenCalled();
  });
  it('macOS 使用账号实际 QQ 进程中的热更新模块，而非安装目录的旧版本', async () => {
    const f = fixture();
    expect(await resolveSignerWrapper(f.platform, 'fixture')).toBe('/hot-update/wrapper.node');
    expect(f.resolveQqPidAsync).toHaveBeenCalledWith('fixture');
    expect(f.qqWrapperNodePath).toHaveBeenCalledTimes(1);
    expect(f.qqWrapperNodePath).toHaveBeenCalledWith(42);
  });
  it('离线、模块未知及进程探测失败均不回退加载安装版本', async () => {
    const f = fixture();
    f.resolveQqPidAsync.mockResolvedValueOnce(null);
    expect(await resolveSignerWrapper(f.platform, 'fixture')).toBeNull();
    expect(f.qqWrapperNodePath).not.toHaveBeenCalled();
    const error = new Error('module unknown');
    f.qqWrapperNodePath.mockImplementationOnce(() => {
      throw error;
    });
    await expect(resolveSignerWrapper(f.platform, 'fixture')).rejects.toBe(error);
    f.resolveQqPidAsync.mockRejectedValueOnce(error);
    await expect(resolveSignerWrapper(f.platform, 'fixture')).rejects.toBe(error);
  });
  it('同步进程探测兼容路径仍使用 PID，其他平台保留安装模块预热', async () => {
    const f = fixture();
    f.platform.resolveQqPidAsync = undefined;
    expect(await resolveSignerWrapper(f.platform, 'fixture')).toBe('/hot-update/wrapper.node');
    expect(f.resolveQqPid).toHaveBeenCalledWith('fixture');
    for (const kind of ['win32', 'linux']) {
      const other = fixture(kind);
      expect(await resolveSignerWrapper(other.platform)).toBe('/installed/wrapper.node');
      expect(other.resolveQqPidAsync).not.toHaveBeenCalled();
    }
  });
});
