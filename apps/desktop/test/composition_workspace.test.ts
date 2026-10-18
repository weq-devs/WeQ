import { act, createElement, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Window as HappyWindow, Storage } from 'happy-dom';
import { useAppLock } from '../src/renderer/src/state/lock';
import {
  backupComposition,
  acknowledgeCompositionBackup,
  readCompositionBackups,
} from '../src/renderer/src/components/mergeForward/workspaceRecovery';
import { CompositionWorkspace } from '../src/renderer/src/components/mergeForward/CompositionWorkspace';
import {
  appendCompositionNodes,
  COMPOSITION_DRAG_TYPE,
  compositionMessages,
  insertCompositionEntry,
  compositionRecords,
  moveCompositionNode,
} from '../src/renderer/src/components/mergeForward/workspaceModel';
import {
  coerceDraft,
  draftToSendNodes,
  type MfDraft,
} from '../src/renderer/src/components/mergeForward/model';
import { RenderDocumentContext, USER_ACTIVITY_EVENT } from '../src/renderer/src/lib/renderDocument';
import { Modal } from '../src/renderer/src/components/Dialog';
import { MsgDressEditor } from '../src/renderer/src/components/mergeForward/MsgDressEditor';
import { useMultiSelection } from '../src/renderer/src/hooks/useMultiSelection';
import {
  useCompositionWindow,
  mirrorCompositionStyles,
} from '../src/renderer/src/hooks/useCompositionWindow';
import { compositionPopupOptions } from '../src/main/composition_window';

const fixture = vi.hoisted(() => ({
  material: [] as unknown[],
  history: [] as unknown[],
  writes: [] as unknown[],
  legacy: [] as unknown[],
  current: [] as MfDraft[],
  fail: false,
  defer: false,
  pending: [] as Array<() => void>,
  fetching: false,
  configId: 'fixture-account',
}));
vi.mock('../src/renderer/src/trpc/client', async () => {
  const { useState } = await import('react');
  const query = (name: string, input?: { kind?: string }) => {
    if (name === 'getAccountConfig') return { uin: '10001', configId: fixture.configId };
    if (name === 'archiveList')
      return input?.kind === 'history' ? fixture.history : fixture.material;
    if (name === 'workspaceDrafts') return { current: fixture.current, legacy: fixture.legacy };
    return undefined;
  };
  const mutate = async (name: string, input: unknown) => {
    fixture.writes.push({ name, input });
    if (fixture.fail) throw new Error('合成落盘失败');
    const data = input as { kind: 'material' | 'history'; draft: MfDraft; id?: string };
    if (name === 'workspaceSave') {
      if (fixture.defer) await new Promise<void>((resolve) => fixture.pending.push(resolve));
      fixture.current = [
        ...fixture.current.filter((item) => item.id !== data.draft.id),
        structuredClone(data.draft),
      ];
      return data.draft;
    }
    if (name === 'workspaceRemove') {
      fixture.current = fixture.current.filter((item) => item.id !== data.id);
      fixture.history = fixture.history.filter((item) => (item as MfDraft).id !== data.id);
      fixture.legacy = fixture.legacy.filter((item) => (item as MfDraft).id !== data.id);
      return;
    }
    if (name === 'archiveAppend') {
      const result = {
        ...structuredClone(data.draft),
        id: `entry-${fixture.writes.length}`,
        kind: data.kind,
        sourceDraftId: data.draft.id,
      };
      fixture[data.kind].push(result);
      return result;
    }
    if (name === 'archiveRemove') {
      fixture[data.kind] = fixture[data.kind].filter(
        (item) => (item as { id: string }).id !== data.id,
      );
      return true;
    }
    return undefined;
  };
  const proxy = (path: string[] = []): unknown =>
    new Proxy(() => undefined, {
      get: (_target, key) => {
        const name = path.at(-1)!;
        if (key === 'useQuery')
          return (input?: { kind?: string }) => {
            const [, refresh] = useState(0);
            return {
              data: query(name, input),
              isLoading: false,
              isFetching: name === 'getAccountConfig' && fixture.fetching,
              isError: false,
              refetch: async () => {
                refresh((value) => value + 1);
                return { data: query(name, input) };
              },
            };
          };
        if (key === 'mutate') return (input: unknown) => mutate(name, input);
        return proxy([...path, String(key)]);
      },
    });
  return { trpc: proxy(), client: proxy() };
});

const self = { uid: 'u_fixture', uin: '10001', name: '合成作者' };
const initial: MfDraft = {
  id: 'source',
  title: '合成样本',
  createdAt: 1,
  updatedAt: 1,
  nodes: [
    {
      id: 'n1',
      sender: self,
      time: 1,
      sourceMsgId: 'source-message',
      segs: [{ t: 'text', id: 's1', text: '合成正文' }],
    },
  ],
};
beforeEach(() => {
  vi.stubGlobal('localStorage', new Storage());
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
  useAppLock.getState().unlock();
  for (let index = window.localStorage.length - 1; index >= 0; index--) {
    const key = window.localStorage.key(index);
    if (key?.startsWith('weq:composition-recovery:')) window.localStorage.removeItem(key);
  }
  fixture.material = [];
  fixture.history = [];
  fixture.legacy = [];
  fixture.current = [];
  fixture.writes = [];
  fixture.fail = false;
  fixture.defer = false;
  fixture.pending = [];
  fixture.fetching = false;
  fixture.configId = 'fixture-account';
  vi.unstubAllGlobals();
});
function mount(element: Parameters<ReturnType<typeof createRoot>['render']>[0]) {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  act(() => root.render(element));
  return {
    host,
    root,
    close: () => {
      act(() => root.unmount());
      host.remove();
    },
  };
}
function button(host: ParentNode, name: string) {
  const found = [...host.querySelectorAll<HTMLButtonElement>('button')].find(
    (item) => item.getAttribute('aria-label') === name || item.title === name,
  );
  if (!found) throw new Error(`按钮不存在：${name}`);
  return found;
}

describe('合成工作窗口', () => {
  it('消息按插入落点移动，保留身份和内容，不复制节点', () => {
    const nodes = ['a', 'b', 'c'].map((id) => ({ ...initial.nodes[0]!, id }));
    expect(moveCompositionNode(nodes, 'a', 3).map((node) => node.id)).toEqual(['b', 'c', 'a']);
    expect(moveCompositionNode(nodes, 'c', 0).map((node) => node.id)).toEqual(['c', 'a', 'b']);
    expect(moveCompositionNode(nodes, 'b', 2)).toBe(nodes);
    expect(moveCompositionNode(nodes, 'missing', 0)).toBe(nodes);
    expect(moveCompositionNode(nodes, 'a', 3)[2]).toBe(nodes[0]);
    expect(nodes.map((node) => node.id)).toEqual(['a', 'b', 'c']);
  });

  it('打开、新建和仅展开编辑器不显示或保存空记录，输入后才出现', async () => {
    vi.useFakeTimers();
    const f = mount(
      createElement(CompositionWorkspace, {
        popup: null,
        fallback: true,
        onClose: vi.fn(),
        onPopOut: vi.fn(),
        self,
        targets: [],
        sendAvailable: false,
        onForward: vi.fn(),
        onSend: vi.fn(),
      }),
    );
    try {
      expect(f.host.querySelectorAll('.weq-composition-entry')).toHaveLength(0);
      await act(async () => button(f.host, '新建合成记录').click());
      act(() => f.host.querySelector<HTMLButtonElement>('.weq-mf-add')!.click());
      await act(async () => vi.advanceTimersByTimeAsync(301));
      expect(f.host.querySelectorAll('.weq-composition-entry')).toHaveLength(0);
      expect(fixture.writes).toHaveLength(0);
      const input = f.host.querySelector<HTMLInputElement>('[aria-label="聊天记录标题"]')!;
      act(() => {
        Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(
          input,
          '新标题',
        );
        input.dispatchEvent(new Event('input', { bubbles: true }));
      });
      expect(f.host.querySelector('.weq-composition-entry-title')?.textContent).toBe('新标题');
      await act(async () => vi.advanceTimersByTimeAsync(301));
      expect(fixture.current).toHaveLength(1);
    } finally {
      f.close();
    }
  });
  it('恢复副本优先于同身份旧历史，按最近编辑时间排列', () => {
    const newer = { ...initial, title: '恢复中的记录', updatedAt: 20 };
    const other = { ...initial, id: 'other', updatedAt: 30 };
    expect(compositionRecords([newer], [initial, other])).toEqual([other, newer]);
  });

  it('拖拽消息到首尾后自动保存新顺序，取消拖拽不改顺序', async () => {
    vi.useFakeTimers();
    const f = mount(
      createElement(CompositionWorkspace, {
        popup: null,
        fallback: true,
        onClose: vi.fn(),
        onPopOut: vi.fn(),
        self,
        targets: [],
        sendAvailable: false,
        onForward: vi.fn(),
        onSend: vi.fn(),
        incoming: [
          {
            id: 'ordered',
            draft: {
              ...initial,
              nodes: ['甲', '乙', '丙'].map((text, index) => ({
                ...initial.nodes[0]!,
                id: `node-${index}`,
                segs: [{ t: 'text', id: `seg-${index}`, text }],
              })),
            },
          },
        ],
      }),
    );
    const slots = () => [...f.host.querySelectorAll<HTMLElement>('[data-composition-index]')];
    const drag = (from: number, to: number, after: boolean, cancel = false) => {
      const handle = slots()[from]!.querySelector<HTMLButtonElement>(
        '[aria-label="拖拽消息排序"]',
      )!;
      const target = slots()[to]!;
      const transfer = new DataTransfer();
      const dispatch = (element: Element, name: string) => {
        const event = new MouseEvent(name, {
          bubbles: true,
          cancelable: true,
          clientY: after ? 10 : 0,
        });
        Object.defineProperty(event, 'dataTransfer', { value: transfer });
        act(() => element.dispatchEvent(event));
      };
      dispatch(handle, 'dragstart');
      dispatch(target, 'dragover');
      expect(f.host.querySelector('.weq-composition-drop-line')).not.toBeNull();
      if (!cancel) dispatch(target, 'drop');
      dispatch(handle, 'dragend');
    };
    try {
      drag(0, 2, true);
      expect(slots().map((slot) => slot.textContent)).toEqual([
        expect.stringContaining('乙'),
        expect.stringContaining('丙'),
        expect.stringContaining('甲'),
      ]);
      drag(2, 0, false);
      drag(0, 2, true, true);
      await act(async () => vi.advanceTimersByTimeAsync(301));
      expect(fixture.current[0]?.nodes.map((node) => node.segs[0])).toMatchObject([
        { text: '甲' },
        { text: '乙' },
        { text: '丙' },
      ]);
      expect(new Set(fixture.current[0]?.nodes.map((node) => node.id)).size).toBe(3);
      expect(f.host.querySelector('.weq-composition-drop-line')).toBeNull();
    } finally {
      f.close();
    }
  });

  it('逐条发送中的嵌套记录仍走合并转发，不退成聊天记录占位文字', async () => {
    const decorated = {
      ...initial,
      nodes: [{ ...initial.nodes[0]!, decoration: { bubbleId: 123, fontId: 0, widgetId: 0 } }],
    };
    const nested = insertCompositionEntry(
      { ...initial, id: 'target', nodes: [] },
      decorated,
      'history',
    );
    fixture.current = [nested];
    const forward = vi.fn();
    const send = vi.fn();
    const f = mount(
      createElement(CompositionWorkspace, {
        popup: null,
        fallback: true,
        onClose: vi.fn(),
        onPopOut: vi.fn(),
        self,
        targets: [{ id: 'peer', name: '样本目标', kind: 'c2c', conv: 'u_peer', avatarUrl: null }],
        sendAvailable: true,
        onForward: forward,
        onSend: send,
      }),
    );
    try {
      await act(async () =>
        [...f.host.querySelectorAll<HTMLButtonElement>('.weq-composition-entry-title')]
          .find((item) => item.textContent === initial.title)!
          .click(),
      );
      await act(async () => button(f.host, '逐条发送当前合成').click());
      act(() => document.querySelector<HTMLButtonElement>('.weq-mf-target')!.click());
      await act(async () =>
        document
          .querySelector<HTMLButtonElement>('.weq-sequential-forward .weq-action-primary')!
          .click(),
      );
      expect(send).not.toHaveBeenCalled();
      expect(forward).toHaveBeenCalledOnce();
      expect(forward.mock.calls[0]![0].nodes[0]).toMatchObject({
        sender: { name: self.name },
        segs: [{ t: 'text', text: '合成正文' }],
        decoration: { bubbleId: 123 },
      });
      expect(draftToSendNodes(nested)[0]?.innerForward?.[0]?.dress).toMatchObject({
        bubbleId: 123,
      });
    } finally {
      f.close();
    }
  });
  it('合成记录按落点嵌套复制，禁止自身与间接循环，支持展开插入', () => {
    const target = { ...initial, id: 'target' };
    const nested = insertCompositionEntry(target, initial, 'history', 0);
    expect(nested.nodes).toHaveLength(2);
    expect(nested.nodes[0]?.segs[0]).toMatchObject({ t: 'node', nickname: self.name });
    expect(nested.nodes[1]).toEqual(target.nodes[0]);
    expect(() => insertCompositionEntry(target, target, 'history', 0)).toThrow('循环');
    expect(() => insertCompositionEntry(initial, nested, 'history', 0)).toThrow('循环');
    const flat = insertCompositionEntry(target, initial, 'history', 0, true);
    expect(flat.nodes[0]?.segs[0]).toMatchObject({ t: 'text', text: '合成正文' });
    expect(flat.nodes[0]?.id).not.toBe(initial.nodes[0]?.id);
    expect(initial.nodes).toHaveLength(1);
  });

  it('装扮编辑与商城在发起的子窗口打开，Escape 逐层返回并恢复焦点', async () => {
    const popup = new HappyWindow();
    const owner = popup.document as unknown as Document;
    const trigger = owner.createElement('button');
    owner.body.append(trigger);
    trigger.focus();
    const close = vi.fn();
    const f = mount(
      createElement(
        RenderDocumentContext.Provider,
        { value: owner },
        createElement(MsgDressEditor, { decoration: undefined, onChange: vi.fn(), onClose: close }),
      ),
    );
    try {
      expect(document.querySelector('[aria-label="编辑装扮"]')).toBeNull();
      expect(owner.querySelector('[aria-label="编辑装扮"]')).not.toBeNull();
      act(() => owner.querySelector<HTMLButtonElement>('.weq-mf-dress-mall')!.click());
      expect(owner.querySelector('[aria-label="选择装扮"]')).not.toBeNull();
      act(() =>
        owner.dispatchEvent(new popup.KeyboardEvent('keydown', { key: 'Escape', bubbles: true })),
      );
      expect(owner.querySelector('[aria-label="选择装扮"]')).toBeNull();
      expect(close).not.toHaveBeenCalled();
      act(() =>
        owner.dispatchEvent(new popup.KeyboardEvent('keydown', { key: 'Escape', bubbles: true })),
      );
      expect(close).toHaveBeenCalledOnce();
    } finally {
      f.close();
      await act(async () => {
        await Promise.resolve();
      });
      expect(owner.activeElement).toBe(trigger);
      popup.close();
    }
  });
  it('等待当前账号配置刷新后才绑定，不采用同号旧缓存的数据源身份', async () => {
    fixture.fetching = true;
    fixture.configId = 'cached-old-source';
    const props = {
      popup: null,
      fallback: true,
      onClose: vi.fn(),
      onPopOut: vi.fn(),
      self,
      targets: [],
      sendAvailable: false,
      onForward: vi.fn(),
      onSend: vi.fn(),
    };
    const f = mount(createElement(CompositionWorkspace, props));
    try {
      expect(f.host.querySelector('.weq-composition-editor')).toBeNull();
      fixture.fetching = false;
      fixture.configId = 'fixture-account';
      act(() => f.root.render(createElement(CompositionWorkspace, { ...props })));
      await act(async () => button(f.host, '新建合成记录').click());
      act(() => f.host.querySelector<HTMLButtonElement>('.weq-mf-add')!.click());
      act(() => button(f.host, '给这条消息添加一段内容').click());
      act(() =>
        [...document.querySelectorAll<HTMLButtonElement>('.weq-mf-add-item')]
          .find((item) => item.textContent === '文本')!
          .click(),
      );
      await act(async () => button(f.host, '关闭合成窗口').click());
      expect(
        (fixture.writes.at(-1) as { input: { expectedAccountConfigId: string } }).input
          .expectedAccountConfigId,
      ).toBe('fixture-account');
    } finally {
      f.close();
    }
  });

  it('编辑后撤销到相同内容时，旧保存回执也不能提前移除最新恢复副本', async () => {
    vi.useFakeTimers();
    fixture.defer = true;
    const f = mount(
      createElement(CompositionWorkspace, {
        popup: null,
        fallback: true,
        onClose: vi.fn(),
        onPopOut: vi.fn(),
        self,
        targets: [],
        sendAvailable: false,
        incoming: [{ id: 'source', draft: initial }],
        onForward: vi.fn(),
        onSend: vi.fn(),
      }),
    );
    try {
      await act(async () => vi.advanceTimersByTimeAsync(301));
      const input = f.host.querySelector<HTMLInputElement>('[aria-label="聊天记录标题"]')!;
      const title = (value: string) =>
        act(() => {
          Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(
            input,
            value,
          );
          input.dispatchEvent(new Event('input', { bubbles: true }));
        });
      title('中间版本');
      await act(async () => vi.advanceTimersByTimeAsync(301));
      title('');
      await act(async () => vi.advanceTimersByTimeAsync(301));
      await act(async () => fixture.pending.shift()!());
      expect(
        readCompositionBackups({
          expectedAccountUin: self.uin,
          expectedAccountConfigId: 'fixture-account',
        }).drafts,
      ).toHaveLength(1);
      await act(async () => fixture.pending.shift()!());
      await act(async () => fixture.pending.shift()!());
      expect(
        readCompositionBackups({
          expectedAccountUin: self.uin,
          expectedAccountConfigId: 'fixture-account',
        }).drafts,
      ).toHaveLength(0);
    } finally {
      fixture.defer = false;
      await act(async () => {
        for (const resume of fixture.pending.splice(0)) resume();
      });
      f.close();
    }
  });
  it('本机备份按数据源隔离，旧回执不清除新内容，损坏备份原样保留', () => {
    const binding = { expectedAccountUin: self.uin, expectedAccountConfigId: 'fixture-account' };
    const storage = new Storage();
    backupComposition(binding, initial, storage);
    const newer = { ...initial, title: '后续修改' };
    backupComposition(binding, newer, storage);
    acknowledgeCompositionBackup(binding, initial, storage);
    expect(readCompositionBackups(binding, storage).drafts[0]?.title).toBe('后续修改');
    expect(
      readCompositionBackups({ ...binding, expectedAccountConfigId: 'other' }, storage).drafts,
    ).toEqual([]);
    acknowledgeCompositionBackup(binding, newer, storage);
    expect(storage.length).toBe(0);
    const node = initial.nodes[0]!;
    backupComposition(binding, initial, storage);
    storage.setItem(
      storage.key(0)!,
      JSON.stringify({
        ...initial,
        nodes: [
          {
            time: node.time,
            segs: node.segs,
            id: node.id,
            sender: node.sender,
            sourceMsgId: node.sourceMsgId,
          },
        ],
      }),
    );
    acknowledgeCompositionBackup(binding, initial, storage);
    expect(storage.length).toBe(0);
    backupComposition(binding, initial, storage);
    const key = storage.key(0)!;
    storage.setItem(key, '{broken');
    expect(readCompositionBackups(binding, storage).damaged).toBe(1);
    expect(storage.getItem(key)).toBe('{broken');
  });

  it('尚未确认的逐条文本也写入本机草稿，锁定应用关闭工作窗', () => {
    vi.useFakeTimers();
    const close = vi.fn();
    const f = mount(
      createElement(CompositionWorkspace, {
        popup: null,
        fallback: true,
        onClose: close,
        onPopOut: vi.fn(),
        self,
        targets: [],
        sendAvailable: false,
        onForward: vi.fn(),
        onSend: vi.fn(),
      }),
    );
    try {
      act(() => f.host.querySelector<HTMLButtonElement>('.weq-mf-add')!.click());
      act(() => button(f.host, '给这条消息添加一段内容').click());
      act(() =>
        [...document.querySelectorAll<HTMLButtonElement>('.weq-mf-add-item')]
          .find((item) => item.textContent === '文本')!
          .click(),
      );
      const input = f.host.querySelector<HTMLTextAreaElement>('textarea[placeholder="文本内容"]')!;
      act(() => {
        Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!.call(
          input,
          '尚未确认的草稿正文',
        );
        input.dispatchEvent(new Event('input', { bubbles: true }));
      });
      const result = readCompositionBackups({
        expectedAccountUin: self.uin,
        expectedAccountConfigId: 'fixture-account',
      });
      expect(result.drafts[0]?.nodes[0]?.segs[0]).toMatchObject({
        t: 'text',
        text: '尚未确认的草稿正文',
      });
      act(() => useAppLock.getState().lock());
      expect(close).toHaveBeenCalledOnce();
      expect(f.host.querySelector('.weq-composition-workspace')).toBeNull();
    } finally {
      f.close();
    }
  });
  it('同一批到达的多次添加不互相覆盖，重渲染不会重复追加', () => {
    const handled = vi.fn();
    const props = {
      popup: null,
      fallback: true,
      onClose: vi.fn(),
      onPopOut: vi.fn(),
      self,
      targets: [],
      sendAvailable: false,
      incoming: [
        { id: 'first', draft: initial },
        { id: 'second', draft: initial },
      ],
      onRequestsHandled: handled,
      onForward: vi.fn(),
      onSend: vi.fn(),
    };
    const f = mount(createElement(CompositionWorkspace, props));
    try {
      expect(f.host.querySelector('.weq-composition-actions')?.textContent).toContain('2 条');
      expect(handled).toHaveBeenCalledWith(['first', 'second']);
      act(() => f.root.render(createElement(CompositionWorkspace, { ...props })));
      expect(f.host.querySelector('.weq-composition-actions')?.textContent).toContain('2 条');
    } finally {
      f.close();
    }
  });

  it('原生只放行应用自有空白窗口，不开放远程页或 Node 权限', () => {
    expect(compositionPopupOptions('https://example.invalid', 'weq-compose')).toBeNull();
    expect(compositionPopupOptions('about:blank', 'other-window')).toBeNull();
    expect(compositionPopupOptions('about:blank', 'weq-compose')?.webPreferences).toMatchObject({
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true,
    });
    expect(
      compositionPopupOptions('about:blank', 'weq-compose')?.webPreferences?.preload,
    ).toBeUndefined();
  });
  it('记录自动保存且不另建历史，现有消息只追加一次，保存失败阻止关闭', async () => {
    const props = {
      popup: null,
      fallback: true,
      onClose: vi.fn(),
      onPopOut: vi.fn(),
      self,
      targets: [],
      sendAvailable: false,
      incoming: [{ id: 'request', draft: initial }],
      onForward: vi.fn(),
      onSend: vi.fn(),
    };
    const f = mount(createElement(CompositionWorkspace, props));
    try {
      expect(f.host.querySelectorAll('[role="tab"]')).toHaveLength(2);
      expect(f.host.querySelector('[aria-label="聊天记录标题"]')).not.toBeNull();
      await act(async () => button(f.host, '保存到素材库').click());
      expect(fixture.material).toHaveLength(1);
      act(() => f.root.render(createElement(CompositionWorkspace, { ...props })));
      expect(f.host.querySelector('.weq-composition-actions')?.textContent).toContain('1 条');
      expect(f.host.querySelector('[aria-label="已保存草稿"]')).toBeNull();
      expect(f.host.querySelector('[aria-label="保存合成记录"]')).toBeNull();
      await act(async () => button(f.host, '新建合成记录').click());
      expect(fixture.current).toHaveLength(1);
      expect(fixture.history).toHaveLength(0);
      act(() =>
        [...f.host.querySelectorAll<HTMLButtonElement>('[role="tab"]')]
          .find((item) => item.textContent === '合成记录')!
          .click(),
      );
      expect(f.host.querySelector('[role="tabpanel"]')?.textContent).toContain('合成正文');
      await act(async () =>
        [...f.host.querySelectorAll<HTMLButtonElement>('.weq-composition-entry-title')]
          .find((item) => item.textContent === '合成作者的聊天记录')!
          .click(),
      );
      const recordId = fixture.current[0]!.id;
      fixture.fail = true;
      await act(async () => button(f.host, '关闭合成窗口').click());
      expect(f.host.querySelector('[role="alert"]')?.textContent).toContain('合成落盘失败');
      expect(f.host.querySelector('.weq-composition-canvas')?.textContent).toContain('合成正文');
      expect((fixture.writes.at(-1) as { input: { draft: MfDraft } }).input.draft.id).toBe(
        recordId,
      );
      expect(
        fixture.writes.every(
          (write) =>
            (write as { input: { expectedAccountConfigId: string } }).input
              .expectedAccountConfigId === 'fixture-account',
        ),
      ).toBe(true);
    } finally {
      f.close();
    }
  });

  it('拖入素材复制稳定身份，未授权的外来拖放不能注入节点', async () => {
    fixture.material = [
      { ...initial, id: 'material-fixture', kind: 'material', sourceDraftId: initial.id },
    ];
    const f = mount(
      createElement(CompositionWorkspace, {
        popup: null,
        fallback: true,
        onClose: vi.fn(),
        onPopOut: vi.fn(),
        self,
        targets: [],
        sendAvailable: false,
        onForward: vi.fn(),
        onSend: vi.fn(),
      }),
    );
    try {
      act(() =>
        [...f.host.querySelectorAll<HTMLButtonElement>('[role="tab"]')]
          .find((item) => item.textContent === '素材库')!
          .click(),
      );
      const editor = f.host.querySelector('.weq-composition-editor')!;
      const drop = (id: string) => {
        const transfer = new DataTransfer();
        transfer.setData(COMPOSITION_DRAG_TYPE, JSON.stringify({ kind: 'material', id }));
        const event = new Event('drop', { bubbles: true });
        Object.defineProperty(event, 'dataTransfer', { value: transfer });
        act(() => editor.dispatchEvent(event));
      };
      drop('material-fixture');
      expect(f.host.querySelector('.weq-composition-actions')?.textContent).toContain('1 条');
      drop('foreign');
      expect(f.host.querySelector('[role="alert"]')?.textContent).toContain('素材已不存在');
      expect(f.host.querySelector('.weq-composition-actions')?.textContent).toContain('1 条');
    } finally {
      f.close();
    }
  });

  it('独立窗口同步样式但不复制脚本，菜单与键盘多选留在子文档', () => {
    const popup = new HappyWindow();
    const cleanup = mirrorCompositionStyles(document, popup.document as unknown as Document);
    const contextDocument = popup.document as unknown as Document;
    const f = mount(
      createElement(
        RenderDocumentContext.Provider,
        { value: contextDocument },
        createElement(Modal, { onClose: vi.fn() }, '合成窗口菜单'),
      ),
    );
    try {
      expect(contextDocument.querySelector('[role="dialog"]')?.textContent).toContain(
        '合成窗口菜单',
      );
      expect(document.querySelector('[role="dialog"]')).toBeNull();
      expect(contextDocument.querySelector('script')).toBeNull();
    } finally {
      f.close();
      cleanup();
      popup.close();
    }
    function Group() {
      const [selected, setSelected] = useState(new Set<string>());
      const multi = useMultiSelection({ ids: ['a', 'b'], selected, onChange: setSelected });
      return createElement(
        'div',
        multi.rootProps,
        ...['a', 'b'].map((id) =>
          createElement(
            'button',
            { key: id, ...multi.itemProps(id), 'aria-pressed': selected.has(id) },
            id,
          ),
        ),
      );
    }
    const child = new HappyWindow();
    const host = child.document.createElement('div');
    child.document.body.append(host);
    const root = createRoot(host as unknown as Element);
    act(() =>
      root.render(
        createElement(
          RenderDocumentContext.Provider,
          { value: child.document as unknown as Document },
          createElement(Group),
        ),
      ),
    );
    try {
      const first = host.querySelector('button')!;
      act(() => first.focus());
      act(() =>
        first.dispatchEvent(
          new child.KeyboardEvent('keydown', { bubbles: true, ctrlKey: true, key: 'a' }),
        ),
      );
      expect(host.querySelectorAll('[aria-pressed="true"]')).toHaveLength(2);
    } finally {
      act(() => root.unmount());
      child.close();
    }
  });

  it('弹窗被阻止时提供非模态回退，打开的自有窗口在卸载时关闭', () => {
    let state: ReturnType<typeof useCompositionWindow>;
    function Harness() {
      state = useCompositionWindow();
      return createElement('button', { onClick: state.open }, '打开');
    }
    const open = vi.spyOn(window, 'open').mockReturnValue(null);
    const f = mount(createElement(Harness));
    act(() => f.host.querySelector('button')!.click());
    expect(state!.fallback).toBe(true);
    const popup = new HappyWindow();
    open.mockReturnValue(popup as unknown as Window);
    act(() => f.host.querySelector('button')!.click());
    expect(state!.fallback).toBe(false);
    const activity = vi.fn();
    window.addEventListener(USER_ACTIVITY_EVENT, activity);
    popup.dispatchEvent(new popup.KeyboardEvent('keydown', { key: 'a' }));
    expect(activity).toHaveBeenCalledOnce();
    window.removeEventListener(USER_ACTIVITY_EVENT, activity);
    const close = vi.spyOn(popup, 'close');
    f.close();
    expect(close).toHaveBeenCalled();
    popup.close();
  });

  it('重复加入有独立节点/分段身份，旧草稿的渲染元素不会丢正文', () => {
    const result = appendCompositionNodes(initial, initial.nodes);
    expect(result.nodes[0]?.id).not.toBe(result.nodes[1]?.id);
    expect(result.nodes[1]?.sourceMsgId).toBe('source-message');
    expect(result.nodes[0]?.segs[0]?.id).not.toBe(result.nodes[1]?.segs[0]?.id);
    expect(initial.nodes).toHaveLength(1);
    const legacy = coerceDraft({
      ...initial,
      nodes: [
        { ...initial.nodes[0]!, segs: [{ type: 'text', data: { textContent: '旧版正文' } }] },
      ],
    });
    expect(legacy.nodes[0]?.segs[0]).toMatchObject({ t: 'text', text: '旧版正文' });
    expect(compositionMessages(legacy)[0]?.body).toContain('旧版正文');
  });
});
