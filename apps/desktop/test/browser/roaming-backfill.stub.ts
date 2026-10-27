import { useState } from 'react';

export const submissions: unknown[] = [];
function usePlan(callbacks: { onSuccess?: () => void }) {
  const [isLoading, setLoading] = useState(false);
  return {
    isLoading,
    mutate: (input: unknown) => {
      submissions.push(input);
      setLoading(true);
      setTimeout(() => {
        setLoading(false);
        callbacks.onSuccess?.();
      }, 100);
    },
  };
}
const proxy = (path: string[] = []): unknown =>
  new Proxy(() => proxy(path), {
    get: (_target, key) => {
      const name = path.at(-1);
      if (key === 'useQuery')
        return () => ({
          data:
            name === 'list'
              ? { historyVersion: 2, supportsImmediateStart: true, jobs: [], online: true }
              : name === 'exportCalendar'
                ? [{ day: '2026-10-28', count: 100 }]
                : [],
          isLoading: false,
        });
      if (key === 'useMutation') return name === 'plan' ? usePlan : () => ({ isLoading: false });
      if (key === 'invalidate') return async () => undefined;
      return proxy([...path, String(key)]);
    },
  });
export const trpc = proxy();
export const client = proxy();
