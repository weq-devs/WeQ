import { describe, expect, it, vi } from 'vitest';
import type { NativeBundle } from '@weq/native';
import { createDarwinPlatform } from '../src/darwin';

const asyncProbe = vi.hoisted(() => vi.fn());
vi.mock('../src/darwin/runtime_module_probe', () => ({ probeQqRuntimeModules: asyncProbe }));

describe('Darwin running QQ native modules', () => {
  it('异步准备映射后同步路径读取只用同一快照，过期后异步刷新', async () => {
    let now = 0;
    const clock = vi.spyOn(performance, 'now').mockImplementation(() => now);
    const resolveQqRuntimeModules = vi.fn(() => {
      throw new Error('不应同步扫描进程');
    });
    const platform = createDarwinPlatform({
      ntHelper: { resolveQqRuntimeModules },
    } as unknown as NativeBundle);
    asyncProbe.mockReset();
    asyncProbe.mockResolvedValueOnce({
      wrapperPath: '/fixture/one/wrapper.node',
      majorPath: '/fixture/one/major.node',
    });
    try {
      expect(platform.prepareQqRuntimeModules).toBeTypeOf('function');
      await platform.prepareQqRuntimeModules!(42);
      expect(platform.qqWrapperNodePath(42)).toBe('/fixture/one/wrapper.node');
      expect(platform.qqMajorNodePath(42)).toBe('/fixture/one/major.node');
      await platform.prepareQqRuntimeModules!(42);
      expect(asyncProbe).toHaveBeenCalledOnce();
      now = 5001;
      asyncProbe.mockResolvedValueOnce({
        wrapperPath: '/fixture/two/wrapper.node',
        majorPath: '/fixture/two/major.node',
      });
      await platform.prepareQqRuntimeModules!(42);
      expect(platform.qqMajorNodePath(42)).toBe('/fixture/two/major.node');
      expect(resolveQqRuntimeModules).not.toHaveBeenCalled();
    } finally {
      clock.mockRestore();
    }
  });
  it('uses the same mapped hot-update pair for metadata and signing', () => {
    const resolveQqRuntimeModules = vi.fn(() => ({
      wrapperPath: '/fixture/QQ/versions/7.0.2/wrapper.node',
      majorPath: '/fixture/QQ/versions/7.0.2/major.node',
    }));
    const platform = createDarwinPlatform({
      ntHelper: { resolveQqRuntimeModules },
    } as unknown as NativeBundle);
    expect(platform.qqWrapperNodePath(42)).toBe('/fixture/QQ/versions/7.0.2/wrapper.node');
    expect(platform.qqMajorNodePath(42)).toBe('/fixture/QQ/versions/7.0.2/major.node');
    expect(resolveQqRuntimeModules).toHaveBeenCalledTimes(1);
    expect(resolveQqRuntimeModules).toHaveBeenCalledWith(42);
  });

  it('keeps native paths scoped to the requested process', () => {
    const resolveQqRuntimeModules = vi.fn((pid: number) => ({
      wrapperPath: `/fixture/${pid}/wrapper.node`,
      majorPath: `/fixture/${pid}/major.node`,
    }));
    const platform = createDarwinPlatform({
      ntHelper: { resolveQqRuntimeModules },
    } as unknown as NativeBundle);
    expect(platform.qqWrapperNodePath(42)).toBe('/fixture/42/wrapper.node');
    expect(platform.qqMajorNodePath(43)).toBe('/fixture/43/major.node');
  });

  it('refuses to substitute an installed image for an ambiguous running process', () => {
    const resolveQqRuntimeModules = vi.fn(() => null);
    const platform = createDarwinPlatform({
      ntHelper: { resolveQqRuntimeModules },
    } as unknown as NativeBundle);
    expect(() => platform.qqWrapperNodePath(42)).toThrow('无法确认运行中 QQ');
    expect(() => platform.qqMajorNodePath(42)).toThrow('无法确认运行中 QQ');
  });
});
