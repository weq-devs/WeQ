import { act, createElement as h } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Conversation } from '../src/renderer/src/im-template/template/types';
import { useRecalledMessages } from '../src/renderer/src/hooks/useRecalledMessages';
import { useAppLock } from '../src/renderer/src/state/lock';

const conversation = { id: 'u_fixture', type: 'direct' } as Conversation;
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}
afterEach(() => {
  useAppLock.setState({ locked: false });
  vi.unstubAllGlobals();
});

function fixture() {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  const source = { current: 'same-qq:source-a' };
  const load = vi.fn<(conv: Conversation) => Promise<string[]>>();
  let api!: ReturnType<typeof useRecalledMessages<string>>;
  function View({ scope }: { scope: string }) {
    api = useRecalledMessages(scope, source, load);
    return h('div', null, api.rows.join(','));
  }
  const render = () => act(() => root.render(h(View, { scope: source.current })));
  render();
  return {
    host,
    source,
    load,
    render,
    api: () => api,
    dispose: () => {
      act(() => root.unmount());
      host.remove();
    },
  };
}

describe('撤回记录读取与来源生命周期', () => {
  it('目录返回、重开及更换会话后只接收最新请求，不让旧 finally 清掉加载状态', async () => {
    const f = fixture();
    const first = deferred<string[]>(),
      second = deferred<string[]>();
    f.load.mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise);
    try {
      act(() => {
        void f.api().open(conversation, 'settings');
      });
      act(() => f.api().close('settings'));
      act(() => {
        void f.api().open(conversation, 'settings');
      });
      await act(async () => first.resolve(['旧结果']));
      expect(f.api().rows).toEqual([]);
      expect(f.api().loading).toBe(true);
      await act(async () => second.resolve(['新结果']));
      expect(f.api().rows).toEqual(['新结果']);
      expect(f.api().loading).toBe(false);
    } finally {
      f.dispose();
    }
  });
  it('同 QQ 号不同来源不共用结果，旧回调不能打开或关闭新来源的记录', async () => {
    const f = fixture();
    const pending = deferred<string[]>();
    f.load.mockReturnValueOnce(pending.promise).mockResolvedValue(['新来源']);
    try {
      const old = f.api();
      act(() => {
        void old.open(conversation, 'settings');
      });
      f.source.current = 'same-qq:source-b';
      f.render();
      await act(async () => pending.resolve(['旧来源']));
      expect(f.api().conversation).toBeNull();
      await act(async () => f.api().open(conversation));
      act(() => {
        old.close();
        old.open(conversation);
      });
      expect(f.api().rows).toEqual(['新来源']);
      expect(f.load).toHaveBeenCalledTimes(2);
      f.source.current = 'same-qq:source-a';
      f.render();
      await act(async () => f.api().open(conversation));
      act(() => {
        old.close();
        void old.open(conversation);
      });
      expect(f.api().rows).toEqual(['新来源']);
      expect(f.load).toHaveBeenCalledTimes(3);
    } finally {
      f.dispose();
    }
  });
  it('实时来源已变化但 React 尚未重绘时也拒绝回填；锁屏和卸载清理在途读取', async () => {
    const f = fixture();
    const pending = deferred<string[]>();
    f.load.mockReturnValue(pending.promise);
    try {
      act(() => {
        void f.api().open(conversation, 'settings');
      });
      f.source.current = 'same-qq:source-b';
      await act(async () => pending.resolve(['旧结果']));
      f.render();
      expect(f.api().rows).toEqual([]);
      f.load.mockResolvedValue(['可见记录']);
      await act(async () => f.api().open(conversation));
      act(() => useAppLock.setState({ locked: true }));
      expect(f.api().conversation).toBeNull();
      expect(f.api().rows).toEqual([]);
      act(() => {
        void f.api().open(conversation);
      });
      expect(f.load).toHaveBeenCalledTimes(2);
    } finally {
      f.dispose();
    }
  });
  it('失败保留错误与重试，不假装空记录；设置来源的关闭不能关掉会话入口', async () => {
    const f = fixture();
    f.load.mockRejectedValueOnce(new Error('合成读取失败')).mockResolvedValue(['重试成功']);
    try {
      await act(async () => f.api().open(conversation));
      expect(f.api().error).toBe('合成读取失败');
      await act(async () => f.api().retry());
      expect(f.api().rows).toEqual(['重试成功']);
      expect(f.api().error).toBeNull();
      act(() => f.api().close('settings'));
      expect(f.api().conversation).toBe(conversation);
    } finally {
      f.dispose();
    }
  });
  it('卸载后的回调不能再发起读取，旧在途完成后也不恢复组件', async () => {
    const f = fixture(),
      pending = deferred<string[]>();
    f.load.mockReturnValue(pending.promise);
    act(() => {
      void f.api().open(conversation);
    });
    const old = f.api();
    f.dispose();
    await act(async () => {
      pending.resolve(['卸载后的结果']);
      await old.open(conversation);
    });
    expect(f.load).toHaveBeenCalledTimes(1);
    expect(f.host.isConnected).toBe(false);
  });
});
