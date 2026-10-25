import { describe, expect, it, vi } from 'vitest';
vi.mock('../src/renderer/src/trpc/client', () => ({ trpc: {} }));
import { boundTagPosition } from '../src/renderer/src/components/dressPieces';

describe('主页标签环边界', () => {
  it('入场或缩窗时将超出边界的标签沿原方向收回', () => {
    expect(boundTagPosition(180, 240, 100)).toEqual({ x: 60, y: 80 });
    expect(boundTagPosition(-180, -240, 50)).toEqual({ x: -30, y: -40 });
  });
  it('边界内不改位置，不启用边界时保留其他个性主页的原行为', () => {
    expect(boundTagPosition(30, 40, 100)).toEqual({ x: 30, y: 40 });
    expect(boundTagPosition(180, 240)).toEqual({ x: 180, y: 240 });
    expect(boundTagPosition(0, 0, 0)).toEqual({ x: 0, y: 0 });
  });
});
