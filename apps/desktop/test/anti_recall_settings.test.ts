import { act, createElement as h, useState, useSyncExternalStore } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AntiRecallDialog } from '../src/renderer/src/components/AntiRecallDialog';
import { DialogHost, useDialog } from '../src/renderer/src/components/Dialog';
import { useAppLock } from '../src/renderer/src/state/lock';

const fixture = vi.hoisted(() => ({
  status: {
    enabled: true,
    mode: 'selected',
    notifyEnabled: true,
    qqRunning: true,
    installed: ['fixture'],
    targets: [{ kind: 'group', id: '20001' }],
    notifyTargets: ['group:20001'],
  },
  staticPc: false,
  listeners: new Set<() => void>(),
  saves: vi.fn(),
  queryOptions: new Map<string, { enabled?: boolean }>(),
  recordsError: false,
  currentSource: true,
  freshSnapshots: false,
  emptyConversations: false,
}));
vi.mock('../src/renderer/src/trpc/client', () => {
  const proxy = (path: string[] = []): unknown =>
    new Proxy(() => proxy(path), {
      get: (_target, key) => {
        if (key === 'useQuery')
          return (_input: unknown, options: { enabled?: boolean }) => {
            const name = path.at(-1)!;
            fixture.queryOptions.set(name, options);
            const status = useSyncExternalStore(
              (listener) => {
                fixture.listeners.add(listener);
                return () => fixture.listeners.delete(listener);
              },
              () => fixture.status,
            );
            return {
              data:
                name === 'getStatus'
                  ? fixture.freshSnapshots
                    ? {
                        ...status,
                        targets: status.targets.map((target) => ({ ...target })),
                        notifyTargets: [...status.notifyTargets],
                      }
                    : status
                  : name === 'getAccountConfig'
                    ? { static: fixture.staticPc, mobile: false }
                    : name === 'listConversationsWithCount'
                      ? fixture.emptyConversations
                        ? []
                        : [
                            {
                              chatType: 'GROUP',
                              targetUid: '20001',
                              targetUin: '20001',
                              targetDisplayName: '合成群',
                              messageCount: 3,
                            },
                          ]
                      : name === 'listRecallConversations'
                        ? fixture.recordsError
                          ? undefined
                          : [{ kind: 'group', conv: '20001', count: 2, lastTs: 1 }]
                        : undefined,
              error:
                name === 'listRecallConversations' && fixture.recordsError
                  ? new Error('合成目录读取失败')
                  : null,
              isLoading: false,
              isFetching: false,
              refetch: vi.fn(),
            };
          };
        if (key === 'useMutation')
          return () => ({
            isLoading: false,
            mutateAsync: async (input: object) => {
              const pending = fixture.saves(path.at(-1), input);
              if (pending) return pending;
              return {
                ...fixture.status,
                ...(path.at(-1) === 'setTargets'
                  ? { targets: Reflect.get(input, 'targets') }
                  : path.at(-1) === 'setNotify'
                    ? {
                        notifyTargets:
                          Reflect.get(input, 'targets') ?? fixture.status.notifyTargets,
                      }
                    : input),
              };
            },
          });
        if (key === 'setData')
          return (_input: unknown, value: typeof fixture.status) => {
            fixture.status = value;
            for (const notify of fixture.listeners) notify();
          };
        return proxy([...path, String(key)]);
      },
    });
  return { trpc: proxy(), client: proxy() };
});

beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  fixture.saves.mockReset();
  fixture.recordsError = false;
  fixture.staticPc = false;
  fixture.currentSource = true;
  fixture.freshSnapshots = false;
  fixture.emptyConversations = false;
  fixture.queryOptions.clear();
  fixture.status = {
    enabled: true,
    mode: 'selected',
    notifyEnabled: true,
    qqRunning: true,
    installed: ['fixture'],
    targets: [{ kind: 'group', id: '20001' }],
    notifyTargets: ['group:20001'],
  };
});
afterEach(() => {
  useAppLock.setState({ locked: false });
  useDialog.setState({ current: null });
  vi.unstubAllGlobals();
});
function mount() {
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  const close = vi.fn();
  function View() {
    const [details, setDetails] = useState(false);
    return h(
      'div',
      null,
      h('input', { 'aria-label': '底层设置草稿', defaultValue: '保留' }),
      h(AntiRecallDialog, {
        embedded: true,
        onClose: close,
        onOpenRecalls: () => setDetails(true),
        onCloseRecalls: () => setDetails(false),
        isCurrentSource: () => fixture.currentSource,
        recallDetails: details ? h('input', { 'aria-label': '合成撤回消息筛选' }) : null,
      }),
      h(DialogHost),
    );
  }
  const render = () => act(() => root.render(h(View)));
  render();
  return {
    host,
    close,
    render,
    dispose: () => {
      act(() => root.unmount());
      host.remove();
    },
  };
}
const click = (name: string) =>
  act(() =>
    [...document.querySelectorAll<HTMLButtonElement>('button')]
      .find(
        (button) =>
          button.textContent?.trim() === name || button.getAttribute('aria-label') === name,
      )!
      .click(),
  );

describe('页内防撤回摘要与按需工具', () => {
  it('同值状态更换数组引用不会反复重建选择或导致无限渲染', () => {
    fixture.freshSnapshots = true;
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    const f = mount();
    try {
      f.render();
      f.render();
      expect(error).not.toHaveBeenCalled();
    } finally {
      f.dispose();
      error.mockRestore();
    }
  });
  it('已保存但不在近期列表的群选择不会在保存时误写成私聊', async () => {
    fixture.emptyConversations = true;
    const f = mount();
    try {
      click('编辑保护会话');
      await act(async () => click('保存选择'));
      expect(fixture.saves).toHaveBeenCalledWith('setTargets', {
        targets: [{ kind: 'group', id: '20001' }],
      });
    } finally {
      f.dispose();
    }
  });
  it('没有旧页签和大型列表，直接展示两类开关与摘要，初始不读会话/记录目录', () => {
    const f = mount();
    try {
      expect(f.host.querySelector('[role="tablist"]')).toBeNull();
      expect(f.host.querySelector('[aria-label="启用防撤回"]')).not.toBeNull();
      expect(f.host.querySelector('[aria-label="撤回时通知我"]')).not.toBeNull();
      expect(f.host.querySelector('.weq-set-picker')).toBeNull();
      expect(fixture.queryOptions.get('listConversationsWithCount')?.enabled).toBe(false);
      expect(fixture.queryOptions.get('listRecallConversations')?.enabled).toBe(false);
      expect(f.host.textContent).toContain('重启 QQ');
    } finally {
      f.dispose();
    }
  });
  it('目录和详情在同一模态切换，返回保留目录，Escape 关闭后归还焦点与设置草稿', () => {
    const f = mount();
    try {
      const draft = f.host.querySelector('input')!;
      const trigger = [...f.host.querySelectorAll<HTMLButtonElement>('button')].find(
        (button) => button.textContent === '查看撤回记录',
      )!;
      act(() => {
        draft.value = '未保存';
        trigger.focus();
        trigger.click();
      });
      const modal = document.querySelector('.weq-tool-modal');
      expect(modal).not.toBeNull();
      const directory = document.querySelector<HTMLElement>('.weq-ar-directory')!;
      act(() => {
        directory.scrollTop = 83;
        directory.dispatchEvent(new Event('scroll', { bubbles: true }));
      });
      act(() => document.querySelector<HTMLButtonElement>('.weq-ar-record')!.click());
      expect(document.querySelectorAll('.weq-tool-modal')).toHaveLength(1);
      expect(document.querySelector('.weq-tool-modal')).toBe(modal);
      expect(document.querySelector('[aria-label="合成撤回消息筛选"]')).not.toBeNull();
      expect(document.activeElement?.getAttribute('aria-label')).toBe('合成撤回消息筛选');
      click('返回会话目录');
      expect(document.querySelector('.weq-ar-record')).not.toBeNull();
      expect(directory.scrollTop).toBe(83);
      expect(document.activeElement?.className).toBe('weq-ar-record');
      act(() =>
        document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })),
      );
      expect(document.querySelector('.weq-tool-modal')).toBeNull();
      expect(f.close).not.toHaveBeenCalled();
      expect(draft.value).toBe('未保存');
      expect(document.activeElement).toBe(trigger);
    } finally {
      f.dispose();
    }
  });
  it('保护和通知选择均可搜索、多选并保存，未保存关闭必须确认', async () => {
    const f = mount();
    try {
      click('编辑保护会话');
      click('清空');
      act(() =>
        document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })),
      );
      expect(useDialog.getState().current?.title).toBe('放弃未保存的修改？');
      await act(async () => click('继续编辑'));
      expect(document.querySelector('.weq-tool-modal')).not.toBeNull();
      await act(async () => click('保存选择'));
      expect(fixture.saves).toHaveBeenCalledWith('setTargets', { targets: [] });
      click('关闭');
      click('编辑通知会话');
      click('清空');
      await act(async () => click('保存选择'));
      expect(fixture.saves).toHaveBeenCalledWith(
        'setNotify',
        expect.objectContaining({ targets: expect.any(Array) }),
      );
    } finally {
      f.dispose();
    }
  });
  it('静态 PC 快照限制、读取错误和锁屏都不能误当空记录或保留敏感工具', () => {
    fixture.staticPc = true;
    fixture.recordsError = true;
    const f = mount();
    try {
      expect(f.host.querySelector<HTMLButtonElement>('[aria-label="启用防撤回"]')!.disabled).toBe(
        true,
      );
      expect(f.host.textContent).toContain('离线快照');
      click('查看撤回记录');
      expect(document.querySelector('.weq-tool-modal [role="alert"]')?.textContent).toContain(
        '合成目录读取失败',
      );
      act(() => useAppLock.setState({ locked: true }));
      expect(document.querySelector('.weq-tool-modal')).toBeNull();
    } finally {
      f.dispose();
    }
  });
  it('来源变化后不发起旧动作，已有操作的迟到返回也不覆盖新来源状态', async () => {
    const f = mount();
    let resolve!: (value: typeof fixture.status) => void;
    fixture.saves.mockReturnValueOnce(
      new Promise<typeof fixture.status>((yes) => {
        resolve = yes;
      }),
    );
    try {
      const original = fixture.status;
      click('启用防撤回');
      expect(fixture.saves).toHaveBeenCalledTimes(1);
      fixture.currentSource = false;
      await act(async () => resolve({ ...original, enabled: false }));
      expect(fixture.status).toBe(original);
      click('启用防撤回');
      expect(fixture.saves).toHaveBeenCalledTimes(1);
    } finally {
      f.dispose();
    }
  });
});
