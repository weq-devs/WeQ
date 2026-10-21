import { act, createElement } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { useExportCollections } from '../src/renderer/src/hooks/useExportCollections';

const rpc = vi.hoisted(() => ({ query: vi.fn() }));
vi.mock('../src/renderer/src/trpc/client', () => ({
  client: { account: { listCollections: { query: rpc.query } } },
}));
const page = { items: [], hasMore: false };
function deferred() {
  let resolve!: (value: typeof page) => void;
  const promise = new Promise<typeof page>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
function mount() {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  let result!: ReturnType<typeof useExportCollections>;
  function Harness({ enabled, account }: { enabled: boolean; account: string }) {
    result = useExportCollections(enabled, account);
    return null;
  }
  return {
    get result() {
      return result;
    },
    render(enabled: boolean, account = 'a') {
      act(() => root.render(createElement(Harness, { enabled, account })));
    },
    close() {
      act(() => root.unmount());
      host.remove();
    },
  };
}
afterEach(() => {
  vi.resetAllMocks();
  vi.unstubAllGlobals();
});
describe('收藏导出加载生命周期', () => {
  it('首次加载途中切走再回来会重新加载，旧响应不覆盖新一轮', async () => {
    const late = deferred();
    rpc.query.mockReturnValueOnce(late.promise).mockResolvedValue(page);
    const f = mount();
    try {
      f.render(true);
      f.render(false);
      f.render(true);
      await act(async () => {});
      expect(f.result.loading).toBe(false);
      expect(rpc.query).toHaveBeenCalledTimes(3);
      await act(async () => {
        late.resolve(page);
      });
      expect(rpc.query).toHaveBeenCalledTimes(3);
      expect(f.result.error).toBe(false);
    } finally {
      f.close();
    }
  });
  it('本地失败仍尝试网络，两者失败可重试，账号切换不接收旧响应', async () => {
    rpc.query.mockRejectedValue(new Error('合成失败'));
    const f = mount();
    try {
      f.render(true);
      await act(async () => {});
      expect(f.result.error).toBe(true);
      expect(f.result.loading).toBe(false);
      const old = deferred();
      rpc.query.mockReturnValueOnce(old.promise).mockResolvedValue(page);
      await act(async () => {
        f.result.retry();
      });
      f.render(true, 'b');
      await act(async () => {});
      expect(f.result.error).toBe(false);
      await act(async () => {
        old.resolve(page);
      });
      expect(f.result.loading).toBe(false);
    } finally {
      f.close();
    }
  });
});
