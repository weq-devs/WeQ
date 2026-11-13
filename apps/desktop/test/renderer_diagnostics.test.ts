import { describe, expect, it } from 'vitest';
import {
  normalizeRendererSample,
  normalizeDevelopmentSample,
} from '../src/shared/renderer_diagnostics';

describe('共享诊断字段投影', () => {
  it('开发缓存字段保留原始数值单位，过滤非数值和未知分类，缺测不冒充零', () => {
    const sample = normalizeDevelopmentSample({
      caches: { images: { count: 1, size: 2048, liveSize: Infinity }, secret: 'private' },
      animations: -1,
      documentVisible: 'true',
    });
    expect(sample).toMatchObject({
      caches: {
        images: { count: 1, sizeBytes: 2048, liveSizeBytes: null },
        fonts: { count: null },
      },
      animations: null,
      runningAnimations: null,
      documentVisible: null,
    });
    expect(Object.keys(sample.caches)).toHaveLength(6);
    expect(JSON.stringify(sample)).not.toMatch(/secret|"private"/);
    expect(normalizeDevelopmentSample(null).caches.images).toMatchObject({ count: null });
  });

  it('只接受数值白名单，监听器数量未知而不是零', () => {
    const sample = normalizeRendererSample({
      jsHeapUsedBytes: 500,
      domNodes: 12,
      token: 'secret',
      externalBytes: Infinity,
      blinkAllocatedKB: -1,
      resources: {
        retainedBytes: 1024,
        pinnedImages: 3,
        totalPendingImages: 5,
        token: 'secret',
        reservedBytes: Infinity,
      },
    });
    expect(sample).toMatchObject({
      jsHeapUsedBytes: 500,
      domNodes: 12,
      externalBytes: null,
      blinkAllocatedKB: null,
      eventListeners: null,
    });
    expect(JSON.stringify(sample)).not.toContain('secret');
    expect(sample.resources).toMatchObject({
      retainedBytes: 1024,
      pinnedImages: 3,
      totalPendingImages: 5,
      reservedBytes: null,
    });
    expect(normalizeRendererSample(null).jsHeapUsedBytes).toBeNull();
  });
});
