/**
 * 虚拟摇杆 —— 拖动改变自己的位置（模拟「走动」）。
 *
 * 只负责「方向 + 强度」的采集与展示，**不含任何坐标换算**：调用方按
 * `onMove(dx, dy)` 收到的单位向量（长度 0..1）乘以当前速度档位，换算成经纬度增量。
 * 这样摇杆与地图/协议解耦，也方便单测。
 *
 * 交互：
 *   - 按住并拖动 → 手柄跟手，输出归一化向量；
 *   - 松手 → 手柄弹回中心，输出 (0,0)（停止移动）；
 *   - 键盘方向键也支持（可访问性，按住即持续移动）。
 *
 * 用 Pointer Events 而不是鼠标事件：触摸屏 / 触控笔 / 鼠标一套代码。
 */

/** 摇杆速度档位（米/秒）。越靠后越快，用于模拟步行 / 骑行 / 开车。 */
export const JOYSTICK_SPEEDS = [
  { id: 'walk', label: '步行', metersPerSecond: 1.4 },
  { id: 'run', label: '跑步', metersPerSecond: 4 },
  { id: 'bike', label: '骑行', metersPerSecond: 8 },
  { id: 'car', label: '驾车', metersPerSecond: 22 },
] as const;

/**
 * 经纬度按「米」偏移。
 *
 * 纬度每度约 111320 米；经度随纬度收缩（乘 cos）。这是**球面近似**，在几公里的
 * 尺度上与真实距离的误差可以忽略，且不需要引入大地测量库。
 */
export function offsetLatLng(
  latitude: number,
  longitude: number,
  northMeters: number,
  eastMeters: number,
): { latitude: number; longitude: number } {
  const latRad = (latitude * Math.PI) / 180;
  const nextLat = latitude + northMeters / 111320;
  const cos = Math.cos(latRad);
  // 极点附近 cos 趋近 0，经度会爆炸 —— 夹一个下限（约 ±89.99°）。
  const nextLng = longitude + eastMeters / (111320 * Math.max(0.0001, Math.abs(cos)));
  return {
    latitude: Math.max(-85, Math.min(85, nextLat)),
    longitude: ((((nextLng + 180) % 360) + 360) % 360) - 180,
  };
}
