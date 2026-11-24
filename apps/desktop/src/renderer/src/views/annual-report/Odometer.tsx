import type { CSSProperties, ReactElement } from 'react';
import { usePrefersReducedMotion } from './Odometer.shared';

/**
 * 机械里程表式数字。每一位是一条 0-9 的独立数字轮，进场时整条轮子从 0 转到
 * 目标位，高位先落定、低位后落定 —— 这是报告开篇「巨大数字」的主角动画，
 * 比单纯的数值 count-up 更有质感（数位宽度全程不变，不会抖动排版）。
 *
 * 只在 `active` 为真（该页是 deck 当前页）时开始转动，翻走再翻回会重播。
 * `prefers-reduced-motion` 下退化为静态文本。
 */

/** 落定前多转几圈，纯粹为了手感。 */
const LOOPS = 2;
const REEL = Array.from({ length: (LOOPS + 1) * 10 }, (_, i) => i % 10).join('\n');
const formatNumber = new Intl.NumberFormat('en-US');
/** 每个数字的高度系数（与 CSS 中 .weq-od-reel > span 的 height 保持一致） */
const DIGIT_HEIGHT = 1.2;

export function Odometer({
  value,
  active,
  durationMs = 1500,
  stagger = 85,
  className,
}: {
  value: number;
  active: boolean;
  /** 单个数字轮的滚动时长。 */
  durationMs?: number;
  /** 相邻数位的落定间隔，从最高位往低位递增。 */
  stagger?: number;
  className?: string;
}): ReactElement {
  const text = formatNumber.format(Math.max(0, Math.round(value)));
  const reduce = usePrefersReducedMotion();
  const cls = className ? `weq-od ${className}` : 'weq-od';
  if (!active || reduce) {
    return <span className={cls}>{text}</span>;
  }

  const chars = [...text];
  return (
    <span className={cls} role="text" aria-label={text}>
      {chars.map((char, position) => {
        if (!/\d/.test(char)) {
          return (
            // biome-ignore lint/suspicious/noArrayIndexKey: 数位按位置渲染,位置即稳定键
            <span className="weq-od-sep" key={position} aria-hidden>
              {char}
            </span>
          );
        }
        const target = LOOPS * 10 + Number(char);
        return (
          // biome-ignore lint/suspicious/noArrayIndexKey: 数位按位置渲染,位置即稳定键
          <span className="weq-od-digit" key={position} aria-hidden>
            <span
              className="weq-od-reel"
              style={
                {
                  '--rp-reel-end': `-${target * DIGIT_HEIGHT}em`,
                  animationDuration: `${durationMs}ms`,
                  animationDelay: `${position * stagger}ms`,
                } as CSSProperties
              }
            >
              {REEL}
            </span>
          </span>
        );
      })}
    </span>
  );
}
