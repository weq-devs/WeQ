// @vitest-environment node
/**
 * 采集节拍：必须按**固定时间轴**排程，不能「做完一帧再等一个周期」。
 *
 * ## 这条测试钉住的真机 bug
 *
 * 2026-10-28 抓包（`/tmp` 下那通 65 秒的 P2P 通话）实测我们上行：
 *
 * | 项 | 实测 | 目标 |
 * | --- | --- | --- |
 * | 帧间隔 p50 | 99 ms | 83 ms（12 fps） |
 * | 平均 | 104 ms（9.6 fps） | |
 * | >120 ms 的断档 | 33 次，累计 7.0 秒 | |
 *
 * 对端只有 7.5~10 fps 可看 → 「画面特别卡」。
 *
 * 根因是旧写法把 `setTimeout(1000/fps)` 排在 `captureOnce()` **之后**，实际周期
 * = 周期 + 采集耗时 + 抖动，误差逐帧累积。改成 `nextAt += period` 的绝对时刻
 * 排程后，长期平均帧率才是目标值。
 *
 * 这里不跑真实的 canvas / mediaDevices：只把排程算法抽出来验算，避免依赖
 * happy-dom 的定时器精度。
 */

import { describe, expect, it } from 'vitest';

/**
 * 复刻 `useVideoCapture` 里的排程算法。
 *
 * `nextAt` 是**绝对时刻**，每帧推进一个周期；落后超过一个周期时对齐到当前时刻
 * （不补发积压）。
 */
function simulateCadence(options: {
  fps: number;
  /** 每帧耗时（ms）。 */
  frameCost: number;
  frames: number;
  /** 每帧的实际触发抖动（ms）。 */
  jitter?: number;
}) {
  const period = 1000 / options.fps;
  const jitter = options.jitter ?? 0;
  let now = 0;
  let nextAt = period;
  const fires: number[] = [];
  for (let i = 0; i < options.frames; i++) {
    const nowAtFire = now + jitter * (i % 3);
    if (nowAtFire - nextAt > period) nextAt = nowAtFire;
    const delay = Math.max(0, nextAt - nowAtFire);
    // 定时器到点：时间推进到触发时刻，然后跑一帧。
    const fireAt = nowAtFire + delay;
    fires.push(fireAt);
    now = fireAt + options.frameCost;
    nextAt += period;
  }
  return fires;
}

/** 用触发时刻算相邻间隔（秒）。 */
function intervals(fires: number[]): number[] {
  const out: number[] = [];
  for (let i = 1; i < fires.length; i++) out.push((fires[i]! - fires[i - 1]!) / 1000);
  return out;
}

describe('采集节拍：固定时间轴', () => {
  it('有采集耗时也不掉帧（12 fps 下平均间隔接近 83 ms）', () => {
    // 每帧采集耗 8 ms，正是实测的 drawImage + getImageData + I420 量级。
    const fires = simulateCadence({ fps: 12, frameCost: 8, frames: 120 });
    const iv = intervals(fires);
    const avg = iv.reduce((a, b) => a + b, 0) / iv.length;
    // 关键：平均间隔应当就是 1/12 秒。旧写法会变成 8ms + 83ms = 91ms 起。
    expect(avg * 1000).toBeCloseTo(1000 / 12, 0);
    // 120 帧（10 秒）里不应该出现明显掉帧。
    const slow = iv.filter((x) => x * 1000 > (1000 / 12) * 1.5);
    expect(slow).toHaveLength(0);
  });

  it('旧写法（做完再等一个周期）会累积漂移 —— 对照组', () => {
    // 复刻旧实现：每帧「先做 frameCost，再从此刻起等 period」。
    const period = 1000 / 12;
    const fires: number[] = [];
    let now = 0;
    for (let i = 0; i < 120; i++) {
      fires.push(now);
      now += 8; // 采集耗时
      now += period; // 再等一个周期
    }
    const iv = intervals(fires);
    const avg = iv.reduce((a, b) => a + b, 0) / iv.length;
    // 旧写法平均间隔 = 83 + 8 = 91 ms → 11.0 fps，与真机实测的 99 ms 同向。
    expect(avg * 1000).toBeGreaterThan(85);
    expect(1000 / (avg * 1000)).toBeLessThan(12);
  });

  it('定时器抖动不会累积（长期平均仍是目标帧率）', () => {
    const fires = simulateCadence({ fps: 15, frameCost: 5, frames: 300, jitter: 2 });
    const iv = intervals(fires);
    const avg = iv.reduce((a, b) => a + b, 0) / iv.length;
    // 绝对时刻排程会把抖动吃掉，不会一帧一帧往后漂。
    expect(avg * 1000).toBeCloseTo(1000 / 15, 0);
  });

  it('落后超过一个周期时不补发积压（实时优先，宁可丢帧）', () => {
    // 第 10 帧主线程被长任务卡了 500ms：应当直接对齐到当前时刻，
    // 而不是连发一串帧把积压追回来。
    const period = 1000 / 12;
    let now = 0;
    let nextAt = period;
    const fireTimes: number[] = [];
    for (let i = 0; i < 20; i++) {
      const stall = i === 10 ? 500 : 0;
      now += stall;
      if (now - nextAt > period) nextAt = now;
      fireTimes.push(nextAt);
      now = nextAt + 8;
      nextAt += period;
    }
    // 卡顿之后应当只多发一帧（下一次排程），而不是补发 500/83 ≈ 6 帧。
    expect(fireTimes).toHaveLength(20);
    // 卡顿后的间隙不该出现「一帧接一帧」的突发。
    for (let i = 12; i < fireTimes.length; i++) {
      expect(fireTimes[i]! - fireTimes[i - 1]!).toBeGreaterThanOrEqual(period - 1e-6);
    }
  });
});
