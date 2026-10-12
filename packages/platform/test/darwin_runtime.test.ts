import { describe, expect, it, vi } from 'vitest';
import type { NativeBundle } from '@weq/native';
import { createDarwinPlatform } from '../src/darwin';

describe('Darwin running QQ native modules', () => {
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
