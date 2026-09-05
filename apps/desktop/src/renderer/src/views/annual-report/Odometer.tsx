import { useEffect, useMemo, useState, type ReactElement } from 'react';

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
const REEL = Array.from({ length: (LOOPS + 1) * 10 }, (_, i) => i % 10);

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
  const text = useMemo(
    () => new Intl.NumberFormat('en-US').format(Math.max(0, Math.round(value))),
    [value],
  );
  const reduce = usePrefersReducedMotion();
  const [rolled, setRolled] = useState(false);

  useEffect(() => {
    if (!active) {
      setRolled(false);
      return undefined;
    }
    const raf = requestAnimationFrame(() => setRolled(true));
    return () => cancelAnimationFrame(raf);
  }, [active]);

  const cls = className ? `weq-od ${className}` : 'weq-od';
  if (reduce) {
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
        const target = rolled ? LOOPS * 10 + Number(char) : 0;
        return (
          // biome-ignore lint/suspicious/noArrayIndexKey: 数位按位置渲染,位置即稳定键
          <span className="weq-od-digit" key={position} aria-hidden>
            <span
              className="weq-od-reel"
              style={{
                transform: `translateY(-${target}em)`,
                transitionDuration: `${durationMs}ms`,
                transitionDelay: `${position * stagger}ms`,
              }}
            >
              {REEL.map((digit, index) => (
                // biome-ignore lint/suspicious/noArrayIndexKey: 固定长度的 0-9 数字轮
                <span key={index}>{digit}</span>
              ))}
            </span>
          </span>
        );
      })}
    </span>
  );
}

/** 系统「减少动态效果」偏好，随设置变化实时更新。 */
export function usePrefersReducedMotion(): boolean {
  const [reduce, setReduce] = useState(
    () => window.matchMedia('(prefers-reduced-motion: reduce)').matches,
  );
  useEffect(() => {
    const query = window.matchMedia('(prefers-reduced-motion: reduce)');
    const onChange = (): void => setReduce(query.matches);
    query.addEventListener('change', onChange);
    return () => query.removeEventListener('change', onChange);
  }, []);
  return reduce;
}
