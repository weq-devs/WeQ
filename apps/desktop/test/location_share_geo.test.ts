/**
 * 位置共享的地理换算单测。
 *
 * 只测纯函数（摇杆 → 经纬度增量、多人视野拟合），不碰 React / DOM ——
 * 这两个函数出错的表现是「摇杆方向反了」「看全部时有人跑出画面」，
 * 在界面上很难一眼看出来，值得钉住。
 */

import { describe, expect, it } from 'vitest';
import { offsetLatLng } from '../src/renderer/src/im-template/template/locationShareJoystick';
import { fitView } from '../src/renderer/src/im-template/template/locationShareMap';

describe('offsetLatLng', () => {
  it('向北 111.32 米约等于 +0.001 度纬度', () => {
    const next = offsetLatLng(30, 104, 111.32, 0);
    expect(next.latitude).toBeCloseTo(30.001, 5);
    expect(next.longitude).toBeCloseTo(104, 6);
  });

  it('向东同样距离时，经度增量随纬度放大（高纬更「窄」）', () => {
    const low = offsetLatLng(0, 0, 0, 1000);
    const high = offsetLatLng(60, 0, 0, 1000);
    // 纬度越高，同样的东向距离对应的经度变化越大。
    expect(high.longitude).toBeGreaterThan(low.longitude);
    // 赤道上 1000 米 ≈ 0.00898 度。
    expect(low.longitude).toBeCloseTo(1000 / 111320, 6);
  });

  it('纬度被夹在 ±85 度内（Web Mercator 可渲染范围）', () => {
    const next = offsetLatLng(84, 0, 1_000_000, 0);
    expect(next.latitude).toBeLessThanOrEqual(85);
  });

  it('经度跨 180 度时回绕到 [-180, 180)', () => {
    const next = offsetLatLng(0, 179.999, 0, 10_000);
    expect(next.longitude).toBeGreaterThanOrEqual(-180);
    expect(next.longitude).toBeLessThan(180);
  });
});

describe('fitView', () => {
  const SIZE = { width: 400, height: 300 };

  it('空列表返回 null', () => {
    expect(fitView([], SIZE)).toBeNull();
  });

  it('单个点给一个较近的缩放级别', () => {
    const view = fitView([{ longitude: 104, latitude: 30 }], SIZE);
    expect(view).not.toBeNull();
    expect(view!.lng).toBeCloseTo(104, 4);
    expect(view!.lat).toBeCloseTo(30, 4);
    expect(view!.zoom).toBe(16);
  });

  it('两个点都被收进视野（中心在两点中间）', () => {
    const points = [
      { longitude: 104.0, latitude: 30.0 },
      { longitude: 104.02, latitude: 30.02 },
    ];
    const view = fitView(points, SIZE)!;
    expect(view.lng).toBeCloseTo(104.01, 3);
    expect(view.lat).toBeCloseTo(30.01, 3);
    // 缩放要够大才能同时看到这两点（约 2km 跨度）。
    expect(view.zoom).toBeGreaterThan(10);
    expect(view.zoom).toBeLessThanOrEqual(18);
  });

  it('点越分散，缩放越小', () => {
    const tight = fitView(
      [
        { longitude: 104, latitude: 30 },
        { longitude: 104.001, latitude: 30.001 },
      ],
      SIZE,
    )!;
    const wide = fitView(
      [
        { longitude: 104, latitude: 30 },
        { longitude: 105, latitude: 31 },
      ],
      SIZE,
    )!;
    expect(wide.zoom).toBeLessThan(tight.zoom);
  });

  it('尺寸为 0 时返回 null（还没测量出容器）', () => {
    expect(fitView([{ longitude: 104, latitude: 30 }], { width: 0, height: 0 })).toBeNull();
  });
});
