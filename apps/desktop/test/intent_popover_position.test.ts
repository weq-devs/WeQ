import { describe, expect, it } from 'vitest';
import { intentPopoverPosition } from '../src/renderer/src/lib/intentPopoverPosition';

describe('意图小浮窗避让', () => {
  const viewport = { width: 390, height: 600 };
  const area = { left: 0, right: 390, bottom: 400 };
  it('底部消息的浮窗翻到上方，不侵入建议栏与输入区', () => {
    const position = intentPopoverPosition(
      { left: 20, right: 180, top: 340, bottom: 380 },
      { width: 220, height: 132 },
      viewport,
      area,
    );
    expect(position.top).toBe(202);
    expect(position.top + 132).toBeLessThan(area.bottom);
  });
  it('有下方空间时沿用下方，并按实际高度而非估算高度计算', () => {
    expect(
      intentPopoverPosition(
        { left: 20, right: 180, top: 100, bottom: 130 },
        { width: 220, height: 30 },
        viewport,
        area,
      ).top,
    ).toBe(136);
  });
  it('我方右对齐，并钳在聊天与视口左右边界内', () => {
    const position = intentPopoverPosition(
      { left: 300, right: 385, top: 100, bottom: 130 },
      { width: 220, height: 132 },
      viewport,
      area,
      true,
    );
    expect(position.left).toBe(158);
    expect(position.left + 220).toBeLessThanOrEqual(378);
  });
  it('窄屏和高输入栏限制浮层尺寸，不产生负坐标', () => {
    const position = intentPopoverPosition(
      { left: 5, right: 100, top: 25, bottom: 45 },
      { width: 260, height: 132 },
      { width: 180, height: 240 },
      { left: 0, right: 180, bottom: 100 },
    );
    expect(position.left).toBeGreaterThanOrEqual(12);
    expect(position.top).toBeGreaterThanOrEqual(12);
    expect(position.maxWidth).toBe(156);
    expect(position.top + Math.min(132, position.maxHeight)).toBeLessThanOrEqual(94);
  });
});
