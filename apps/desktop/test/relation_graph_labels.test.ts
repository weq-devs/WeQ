// @vitest-environment node
import { describe, expect, it } from 'vitest';
import {
  graphLabelVisible,
  indexGraphHit,
  GRAPH_LABEL_MIN_SCREEN_RADIUS,
} from '../src/renderer/src/components/relationGraph/graphRender';
import { physicsFixture } from './support/relation-physics-fixtures';
import {
  graphEdgePixelRatio,
  GPU_EDGE_CSS_PIXEL_THRESHOLD,
} from '../src/renderer/src/components/relationGraph/graphEdgeGpu';

describe('关系图屏幕尺寸标签', () => {
  it('Worker 提前更新坐标时，命中仍使用用户已看到的画面', () => {
    const nodes = physicsFixture(4, 'star').nodes.slice(0, 2);
    const positions = new Float64Array([0, 0, 100, 0]);
    nodes[0]!.x = 500;
    nodes[1]!.x = 0;
    const hit = indexGraphHit(nodes, positions);
    expect(hit(0, 0)).toBe(nodes[0]);
    expect(hit(100, 0)).toBe(nodes[1]);
    expect(hit(500, 0)).toBeNull();
  });
  it('只有密集远景连线使用 CSS 像素，近景恢复屏幕像素比', () => {
    expect(graphEdgePixelRatio(GPU_EDGE_CSS_PIXEL_THRESHOLD - 1, 0.3, 2)).toBe(2);
    expect(graphEdgePixelRatio(GPU_EDGE_CSS_PIXEL_THRESHOLD, 0.3, 2)).toBe(1);
    expect(graphEdgePixelRatio(GPU_EDGE_CSS_PIXEL_THRESHOLD, 1, 2)).toBe(2);
    expect(graphEdgePixelRatio(GPU_EDGE_CSS_PIXEL_THRESHOLD, 0.3, 0.75)).toBe(0.75);
  });
  it('缩小后不因原始半径大或属于焦点邻居就铺满不可读标签', () => {
    for (const neighbour of [false, true])
      expect(graphLabelVisible({ kind: 'person', radius: 24 }, 0.3, false, neighbour)).toBe(false);
  });
  it('自身和当前焦点始终可读', () => {
    expect(graphLabelVisible({ kind: 'self', radius: 24 }, 0.02, false, false)).toBe(true);
    expect(graphLabelVisible({ kind: 'person', radius: 10 }, 0.02, true, false)).toBe(true);
  });
  it('放大后沿用重要节点、邻居和近景的显示规则', () => {
    expect(graphLabelVisible({ kind: 'person', radius: 24 }, 1, false, false)).toBe(true);
    expect(graphLabelVisible({ kind: 'person', radius: 10 }, 2, false, false)).toBe(true);
    expect(
      graphLabelVisible({ kind: 'person', radius: GRAPH_LABEL_MIN_SCREEN_RADIUS }, 1, false, true),
    ).toBe(true);
    expect(graphLabelVisible({ kind: 'person', radius: 16 }, 1, false, false)).toBe(false);
  });
});
