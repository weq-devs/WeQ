import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type Dispatch,
  type ReactNode,
  type SetStateAction,
} from 'react';
import type { z } from 'zod';
import superjson from 'superjson';
import { pageSnapshots } from '../lib/pageSnapshots';
import { PageDataCache } from '../lib/pageDataCache';
import { useToast } from './Toast';

const SnapshotContext = createContext<{
  key: string;
  fallback: Map<string, unknown>;
  data: PageDataCache;
} | null>(null);

export function usePageDataCache() {
  const context = useContext(SnapshotContext);
  return useMemo(
    () => ({
      read<T>(name: string): T | undefined {
        return context?.data.get<T>(JSON.stringify([context.key, name]));
      },
      write(name: string, value: unknown): void {
        context?.data.put(JSON.stringify([context.key, name]), value);
      },
    }),
    [context],
  );
}

export function usePageSnapshotKey(name: string): string | null {
  const scope = useContext(SnapshotContext);
  return scope ? JSON.stringify([scope.key, name]) : null;
}

export function PageSnapshots({
  scope,
  children,
  resetOnMount = false,
}: {
  scope: string | null;
  children: ReactNode;
  resetOnMount?: boolean;
}) {
  const [preparedScope, setPreparedScope] = useState<string | null>(null);
  const needsReset = Boolean(scope && resetOnMount && preparedScope !== scope);
  useLayoutEffect(() => {
    if (!scope || !needsReset) return;
    try {
      pageSnapshots.resetScope(scope);
    } catch {
      useToast.getState().push({
        tone: 'error',
        title: '页面现场重置失败',
        detail: '请检查本机存储，部分页面可能仍保留上次的操作位置。',
      });
    }
    setPreparedScope(scope);
  }, [scope, needsReset]);
  const context = useMemo(
    () =>
      scope
        ? { key: scope, fallback: new Map<string, unknown>(), data: new PageDataCache() }
        : null,
    [scope],
  );
  // 提交后再清除旧现场，子页面在清除完成前不挂载，也不影响被取消的并发渲染。
  return (
    <SnapshotContext.Provider value={context}>
      {needsReset ? null : children}
    </SnapshotContext.Provider>
  );
}

export function PageSnapshotsFallback({ scope, children }: { scope: string; children: ReactNode }) {
  const parent = useContext(SnapshotContext);
  return parent ? children : <PageSnapshots scope={scope}>{children}</PageSnapshots>;
}

export function PageSnapshotScope({ name, children }: { name: string; children: ReactNode }) {
  const parent = useContext(SnapshotContext);
  const context = useMemo(
    () =>
      parent
        ? { key: JSON.stringify([parent.key, name]), fallback: parent.fallback, data: parent.data }
        : null,
    [parent, name],
  );
  return <SnapshotContext.Provider value={context}>{children}</SnapshotContext.Provider>;
}

/** 服务端读回相同值后清除草稿标记，不能清掉期间新输入的值。 */
export function usePageDraftConfirmation(name: string, value: unknown) {
  const key = usePageSnapshotKey(name);
  const fallback = useContext(SnapshotContext)?.fallback;
  const encoded = value === undefined ? undefined : superjson.stringify(value);
  // 其它 effect 也可能刚把输入与服务端对齐，因此每次提交后都复核一次。
  useEffect(() => {
    if (!key || encoded === undefined) return;
    try {
      pageSnapshots.confirm(key, superjson.parse<unknown>(encoded));
      if (fallback?.has(key) && superjson.stringify(fallback.get(key)) === encoded)
        fallback.delete(key);
    } catch {
      /* 读回不覆盖损坏原件，也不丢弃尚未确认的输入。 */
    }
  });
}

export function usePageState<T>(
  name: string,
  initial: T | (() => T),
  schema: z.ZodType<T>,
  draft = false,
  enabled = true,
): [T, Dispatch<SetStateAction<T>>] {
  const scopedKey = usePageSnapshotKey(name);
  const fallback = useContext(SnapshotContext)?.fallback;
  const key = enabled ? scopedKey : null;
  const reported = useRef(false);
  const report = useCallback(() => {
    if (reported.current) return;
    reported.current = true;
    useToast.getState().push({
      tone: 'error',
      title: '页面现场保存失败',
      detail: '请检查本机存储；尚未提交的修改请先保存。',
    });
  }, []);
  const load = () => {
    if (key) {
      try {
        if (fallback?.has(key)) return schema.parse(fallback.get(key));
        const saved = pageSnapshots.read(key, schema, draft);
        if (saved !== undefined) return saved;
      } catch {
        // 损坏原件保留，直到用户下一次明确修改此字段。
      }
    }
    return typeof initial === 'function' ? (initial as () => T)() : initial;
  };
  const [stored, update] = useState(() => ({ key, value: load() }));
  let state = stored.value;
  if (stored.key !== key) {
    state = load();
    update({ key, value: state });
  }
  const current = useRef(state);
  const latestKey = useRef(key);
  const validator = useRef(schema);
  useLayoutEffect(() => {
    current.current = state;
    latestKey.current = key;
    validator.current = schema;
  });
  const mounted = useRef(true);
  useLayoutEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  const set = useCallback<Dispatch<SetStateAction<T>>>(
    (action) => {
      if (!mounted.current || latestKey.current !== key) return;
      const value =
        typeof action === 'function' ? (action as (previous: T) => T)(current.current) : action;
      if (Object.is(value, current.current)) return;
      current.current = value;
      if (key) {
        try {
          pageSnapshots.write(key, validator.current.parse(value), draft);
          fallback?.delete(key);
        } catch {
          fallback?.set(key, value);
          report();
        }
      }
      update({ key, value });
    },
    [key, report, draft, fallback],
  );
  return [state, set];
}
