/**
 * 有效期折算的纯逻辑测试。
 *
 * 判定错了代价不对称：把「快过期」读成没问题 → 打包/发布时用了马上失效的构建，
 * 用户装上直接进不了主界面；把「还早」读成过期 → 无谓地拦住发布。
 *
 * 关键不变量：**这里不出现任何天数常量**。喂进去的时间戳说了算，
 * 30 天还是 45 天由 `.node` 自报的 `validitySecs` 决定。
 */

import { describe, expect, it } from 'vitest';
import {
  FRESH_MIN_REMAINING_RATIO,
  isStale,
  manifestValidity,
  validityOf,
  validityText,
} from '../validity.mjs';

const DAY = 86_400_000;
const NOW = Date.parse('2026-10-16T00:00:00.000Z');

describe('validityOf', () => {
  it('computes remaining ratio from the binary-reported window', () => {
    // 30 天窗口，走到第 24 天：剩 6 天 = 20%，正好不在「< 1/5」里。
    const v = validityOf(
      { buildTimeMs: NOW - 24 * DAY, expireTimeMs: NOW + 6 * DAY, validityMs: 30 * DAY },
      NOW,
    );
    expect(v.known).toBe(true);
    expect(v.expired).toBe(false);
    expect(v.remainingDays).toBeCloseTo(6);
    expect(v.totalDays).toBeCloseTo(30);
    expect(v.remainingRatio).toBeCloseTo(0.2);
    expect(isStale(v)).toBe(false);
  });

  it('flags stale once the remaining ratio drops below 1/5', () => {
    const v = validityOf(
      { buildTimeMs: NOW - 25 * DAY, expireTimeMs: NOW + 5 * DAY, validityMs: 30 * DAY },
      NOW,
    );
    expect(v.remainingRatio).toBeCloseTo(1 / 6);
    expect(isStale(v)).toBe(true);
  });

  it('scales with the window — a 45-day build is not stale at day 25', () => {
    // 同样「编好 25 天」，30 天窗口已经偏旧，45 天窗口还很宽裕。
    const v = validityOf(
      { buildTimeMs: NOW - 25 * DAY, expireTimeMs: NOW + 20 * DAY, validityMs: 45 * DAY },
      NOW,
    );
    expect(v.remainingRatio).toBeCloseTo(20 / 45);
    expect(isStale(v)).toBe(false);
  });

  it('reports expired at and past the deadline', () => {
    const v = validityOf(
      { buildTimeMs: NOW - 30 * DAY, expireTimeMs: NOW, validityMs: 30 * DAY },
      NOW,
    );
    expect(v.expired).toBe(true);
    expect(validityText(v)).toContain('已过期');
  });

  it('derives the window from build/expire when validityMs is absent', () => {
    const v = validityOf({ buildTimeMs: NOW - 10 * DAY, expireTimeMs: NOW + 20 * DAY }, NOW);
    expect(v.totalDays).toBeCloseTo(30);
    expect(v.remainingDays).toBeCloseTo(20);
  });

  it('is unknown-safe when nothing is provided', () => {
    const v = validityOf({}, NOW);
    expect(v.known).toBe(false);
    expect(v.expired).toBe(false);
    expect(v.remainingRatio).toBeUndefined();
    expect(isStale(v)).toBe(false);
    expect(validityText(v)).toBeNull();
  });
});

describe('manifestValidity', () => {
  const manifest = {
    builtAt: new Date(NOW - 20 * DAY).toISOString(),
    expiresAt: new Date(NOW + 10 * DAY).toISOString(),
  };

  it('prefers the binary-reported times over the manifest copy', () => {
    const v = manifestValidity(
      manifest,
      {
        buildTime: Math.floor((NOW - 3 * DAY) / 1000),
        expireTime: Math.floor((NOW + 27 * DAY) / 1000),
        validitySecs: 30 * 24 * 3600,
      },
      NOW,
    );
    expect(v.remainingDays).toBeCloseTo(27);
  });

  it('falls back to the manifest for older .node without getBuildInfo()', () => {
    const v = manifestValidity(manifest, undefined, NOW);
    expect(v.remainingDays).toBeCloseTo(10);
    expect(v.known).toBe(true);
  });

  it('stays unknown when neither side carries a deadline', () => {
    const v = manifestValidity({ builtAt: manifest.builtAt }, undefined, NOW);
    expect(v.known).toBe(false);
    expect(v.expired).toBe(false);
  });
});

describe('FRESH_MIN_REMAINING_RATIO', () => {
  it('is a ratio, not a fixed number of days', () => {
    expect(FRESH_MIN_REMAINING_RATIO).toBeGreaterThan(0);
    expect(FRESH_MIN_REMAINING_RATIO).toBeLessThan(1);
  });
});
