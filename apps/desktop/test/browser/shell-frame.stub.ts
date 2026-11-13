// 外壳框架 harness 的 tRPC 替身：只提供渲染所需的最小数据，不联网。
import { trpc as homeStub } from './home-backdrop.stub';

const noop = () => Promise.resolve({});
const queryStub = () => ({
  data: undefined,
  isLoading: false,
  isFetched: true,
  isFetching: false,
  isError: false,
  isSuccess: true,
  error: null,
  refetch: noop,
});
const leaf: Record<string, unknown> = {
  useQuery: queryStub,
  useQueries: () => [],
  useInfiniteQuery: queryStub,
  useMutation: () => ({ mutate: noop, mutateAsync: noop, isLoading: false, isPending: false }),
  useUtils: () => util,
  useSubscription: () => ({ unsubscribe: noop }),
  invalidate: noop,
  refetch: noop,
  fetch: noop,
  setData: noop,
  getData: () => undefined,
};

/** 未知路径一律返回可继续链式访问的假 query/mutation。 */
function deep(node: Record<string, unknown>): Record<string, unknown> {
  return new Proxy(node, {
    get(target, key) {
      if (key in target) {
        const value = target[key];
        return value && typeof value === 'object' ? deep(value as Record<string, unknown>) : value;
      }
      return deep(leaf);
    },
  });
}

const util = deep({});
const trpc = deep({ ...homeStub, useUtils: () => util });
(trpc as unknown as { useUtils: () => typeof util }).useUtils = () => util;

export { trpc };

/** 任何 mutate / subscribe 都视作空操作，外壳只关心布局。 */
export const client = deep({});
