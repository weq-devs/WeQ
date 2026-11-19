// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { bubbleMetrics } from '../src/renderer/src/lib/dressSkin';

describe('手机装扮气泡的内容与图像几何分离', () => {
  it.each([
    { left: 76, right: 51, top: 49, bottom: 62 },
    { left: 63, right: 63, top: 55, bottom: 55 },
    { left: 1, right: 1, top: 1, bottom: 1 },
  ])('正文使用普通装扮分支留白，不随切片改变：%j', (slice) => {
    const metrics = bubbleMetrics({
      itemId: 1,
      slice,
      imageSize: { w: 128, h: 112 },
      textColor: '#111',
      localFile: null,
    });
    // APK padding.a$b：水平 10+12dp、竖直 8+9dp。
    expect([metrics.topPad, metrics.rightPad, metrics.bottomPad]).toEqual(['17px', '22px', '17px']);
  });

  it('图像仍按 density/2 映射缩放，完整端点独立控制固定区', () => {
    const metrics = bubbleMetrics({
      itemId: 149,
      slice: { left: 76, right: 51, top: 49, bottom: 62 },
      imageSize: { w: 128, h: 112 },
      textColor: '#111',
      localFile: null,
    });
    expect(metrics.slice).toBe('49 51 62 76 fill');
    expect(metrics.width).toBe('24.5px 25.5px 31px 38px');
    expect(metrics.minWidth).toBe('63.5px');
    expect(metrics.minHeight).toBe('55.5px');
  });
});
