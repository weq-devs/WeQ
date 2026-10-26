// @ts-nocheck
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

import { useCallback, useEffect, useRef, useState } from 'react';
import type { KeyboardEvent as ReactKeyboardEvent, PointerEvent as ReactPointerEvent } from 'react';
import { cn } from './classNames';

/** 手柄相对底座中心的位移上限（占底座半径的比例）。 */
const THUMB_TRAVEL = 0.62;

export function LocationShareJoystick({
  onMove,
  disabled,
}: {
  /** 归一化方向向量；长度 0 表示停止。 */
  onMove: (dx: number, dy: number) => void;
  disabled?: boolean;
}) {
  const baseRef = useRef<HTMLDivElement | null>(null);
  const pointerRef = useRef<number | null>(null);
  /** 手柄当前偏移（-1..1 的归一化坐标，y 向下为正，与屏幕一致）。 */
  const [offset, setOffset] = useState({ x: 0, y: 0 });

  const emit = useCallback(
    (x: number, y: number) => {
      setOffset({ x, y });
      onMove(x, y);
    },
    [onMove],
  );

  const compute = useCallback((clientX: number, clientY: number) => {
    const base = baseRef.current;
    if (!base) return { x: 0, y: 0 };
    const rect = base.getBoundingClientRect();
    const radius = rect.width / 2;
    // 相对底座中心的位移，归一化到 [-1, 1]。
    let dx = (clientX - (rect.left + radius)) / radius;
    let dy = (clientY - (rect.top + radius)) / radius;
    const len = Math.hypot(dx, dy);
    if (len > 1) {
      dx /= len;
      dy /= len;
    }
    return { x: dx, y: dy };
  }, []);

  function handlePointerDown(event: ReactPointerEvent<HTMLDivElement>): void {
    if (disabled) return;
    pointerRef.current = event.pointerId;
    event.currentTarget.setPointerCapture(event.pointerId);
    const next = compute(event.clientX, event.clientY);
    emit(next.x, next.y);
  }

  function handlePointerMove(event: ReactPointerEvent<HTMLDivElement>): void {
    if (pointerRef.current !== event.pointerId) return;
    const next = compute(event.clientX, event.clientY);
    emit(next.x, next.y);
  }

  function handlePointerUp(event: ReactPointerEvent<HTMLDivElement>): void {
    if (pointerRef.current !== event.pointerId) return;
    pointerRef.current = null;
    emit(0, 0);
  }

  // 键盘：方向键按住持续移动，松开归零。上下左右可组合（同时按 = 斜向）。
  const keysRef = useRef(new Set<string>());

  const applyKeys = useCallback(() => {
    const keys = keysRef.current;
    let x = 0;
    let y = 0;
    if (keys.has('ArrowLeft')) x -= 1;
    if (keys.has('ArrowRight')) x += 1;
    if (keys.has('ArrowUp')) y -= 1;
    if (keys.has('ArrowDown')) y += 1;
    const len = Math.hypot(x, y);
    emit(len > 1 ? x / len : x, len > 1 ? y / len : y);
  }, [emit]);

  function handleKeyDown(event: ReactKeyboardEvent<HTMLDivElement>): void {
    if (disabled) return;
    if (!event.key.startsWith('Arrow')) return;
    event.preventDefault();
    keysRef.current.add(event.key);
    applyKeys();
  }

  function handleKeyUp(event: ReactKeyboardEvent<HTMLDivElement>): void {
    if (!event.key.startsWith('Arrow')) return;
    keysRef.current.delete(event.key);
    applyKeys();
  }

  // 失焦时清空按键，避免「切窗口后自己一直走」。
  useEffect(() => {
    const reset = (): void => {
      if (!keysRef.current.size) return;
      keysRef.current.clear();
      emit(0, 0);
    };
    window.addEventListener('blur', reset);
    return () => window.removeEventListener('blur', reset);
  }, [emit]);

  const thumbLeft = `${50 + offset.x * THUMB_TRAVEL * 50}%`;
  const thumbTop = `${50 + offset.y * THUMB_TRAVEL * 50}%`;

  return (
    <div
      className={cn('lbs-joystick', disabled && 'is-disabled')}
      ref={baseRef}
      role="slider"
      aria-label="移动摇杆"
      aria-valuetext={offset.x || offset.y ? '移动中' : '停止'}
      tabIndex={disabled ? -1 : 0}
      onPointerDown={handlePointerDown}
      onPointerMove={handlePointerMove}
      onPointerUp={handlePointerUp}
      onPointerCancel={handlePointerUp}
      onKeyDown={handleKeyDown}
      onKeyUp={handleKeyUp}
    >
      <span className={cn('lbs-joystick-ring')} aria-hidden />
      <span
        className={cn('lbs-joystick-thumb')}
        style={{ left: thumbLeft, top: thumbTop }}
        aria-hidden
      />
    </div>
  );
}

/** 摇杆速度档位（米/秒）。越靠后越快，用于模拟步行 / 骑行 / 开车。 */
export const JOYSTICK_SPEEDS = [
  { id: 'walk', label: '步行', metersPerSecond: 1.4 },
  { id: 'run', label: '跑步', metersPerSecond: 4 },
  { id: 'bike', label: '骑行', metersPerSecond: 8 },
  { id: 'car', label: '驾车', metersPerSecond: 22 },
] as const;

export type JoystickSpeedId = (typeof JOYSTICK_SPEEDS)[number]['id'];

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
