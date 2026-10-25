import { useCallback, useLayoutEffect, useRef } from 'react';

/** 行级事件保持引用，调用时仍使用当前会话和最新状态。缺省能力不暴露事件入口。 */
export function useStableCallback<Args extends unknown[], Result>(
  callback: ((...args: Args) => Result) | undefined,
) {
  const current = useRef(callback);
  useLayoutEffect(() => {
    current.current = callback;
  });
  const stable = useCallback((...args: Args) => current.current?.(...args), []);
  return callback ? (stable as (...args: Args) => Result) : undefined;
}
