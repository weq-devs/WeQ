import { useLayoutEffect, useRef } from 'react';

/** 事件型 Context 只随数据变化通知；回调保持引用并转发至最新已提交实现。 */
export function useEventContextValue<T extends object>(value: T): T {
  const committed = useRef(value);
  const events = useRef(new Map<keyof T, unknown>());
  const previous = useRef<T | undefined>(undefined);
  useLayoutEffect(() => {
    committed.current = value;
  });
  const next = { ...value };
  const keys = Reflect.ownKeys(value) as (keyof T)[];
  for (const key of keys) {
    if (typeof value[key] !== 'function') continue;
    if (!events.current.has(key))
      events.current.set(key, (...args: unknown[]) => {
        const callback = committed.current[key];
        if (typeof callback === 'function') return Reflect.apply(callback, undefined, args);
      });
    next[key] = events.current.get(key) as T[keyof T];
  }
  const old = previous.current;
  if (
    old &&
    Reflect.ownKeys(old).length === keys.length &&
    keys.every((key) => Object.is(old[key], next[key]))
  )
    return old;
  previous.current = next;
  return next;
}
