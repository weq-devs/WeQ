import { act, createElement as h } from 'react';
import { createRoot } from 'react-dom/client';
import { Storage } from 'happy-dom';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ConversationList } from '../src/renderer/src/im-template/template/conversationLists';
import { createTemplateDemoData } from '../src/renderer/src/im-template/template/demoData';
import { ConversationDirectoryContext } from '../src/renderer/src/lib/conversationDirectory';
import {
  ContentSelectionProvider,
  useContentExportRequest,
} from '../src/renderer/src/state/contentSelection';
import { RoamingBackfillPanel } from '../src/renderer/src/components/RoamingBackfillPanel';

const fixture = vi.hoisted(() => ({ plan: vi.fn(), contacts: vi.fn() }));
vi.mock('../src/renderer/src/trpc/client', () => ({
  trpc: {
    useUtils: () => ({ account: { roamingBackfill: { list: { invalidate: vi.fn() } } } }),
    account: {
      listConversationsWithCount: { useQuery: fixture.contacts },
      roamingBackfill: {
        list: { useQuery: () => ({ data: { historyVersion: 2, jobs: [], online: true } }) },
        plan: { useMutation: () => ({ mutate: fixture.plan }) },
        start: { useMutation: () => ({}) },
        pause: { useMutation: () => ({}) },
        cancel: { useMutation: () => ({}) },
        remove: { useMutation: () => ({}) },
      },
    },
  },
}));
afterEach(() => {
  vi.clearAllMocks();
  vi.unstubAllGlobals();
});

function mount(element: Parameters<ReturnType<typeof createRoot>['render']>[0]) {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  vi.stubGlobal('localStorage', new Storage());
  fixture.contacts.mockReturnValue({ data: [] });
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  act(() => root.render(element));
  return {
    host,
    render: (next: typeof element) => act(() => root.render(next)),
    close: () => {
      act(() => root.unmount());
      host.remove();
    },
  };
}
const button = (host: HTMLElement, label: string) =>
  host.querySelector<HTMLButtonElement>(`[aria-label="${label}"]`)!;

describe('会话底部多选栏', () => {
  it('保留顶部搜索，空选禁用操作，混选不静默过滤，操作后保留选区', () => {
    const base = createTemplateDemoData().conversations.find((row) => row.type === 'group')!;
    const group = { ...base, id: '10001', group: { ...base.group, id: '10001', name: '合成群聊' } };
    const roaming = vi.fn();
    function Probe() {
      return h('output', null, JSON.stringify(useContentExportRequest()));
    }
    const f = mount(
      h(
        ContentSelectionProvider,
        null,
        h(
          ConversationDirectoryContext.Provider,
          {
            value: {
              real: [group],
              virtual: [
                {
                  id: 'virtual:fixture',
                  kind: 'persona',
                  ownerId: 'fixture',
                  name: '合成虚拟会话',
                },
              ],
              onVirtual: vi.fn(),
              onCreate: vi.fn(),
              onRoaming: roaming,
            },
          },
          h(ConversationList, {
            conversations: [group],
            activeConversationId: null,
            preferences: {},
            drafts: {},
            onSelect: vi.fn(),
          }),
        ),
        h(Probe),
      ),
    );
    try {
      expect(f.host.querySelector('[aria-label="会话多选操作"]')).toBeNull();
      act(() => button(f.host, '多选会话').click());
      expect(button(f.host, '搜索会话')).not.toBeNull();
      expect(button(f.host, '拉取所选会话漫游消息').disabled).toBe(true);
      act(() => f.host.querySelector<HTMLButtonElement>('[data-conversation-id="10001"]')!.click());
      expect(button(f.host, '拉取所选会话漫游消息').disabled).toBe(false);
      act(() => button(f.host, '拉取所选会话漫游消息').click());
      expect(roaming).toHaveBeenCalledWith([{ kind: 'group', conv: '10001', name: '合成群聊' }]);
      act(() => button(f.host, '导出所选会话').click());
      expect(JSON.parse(f.host.querySelector('output')!.textContent!).selection.scope.ids).toEqual([
        '10001',
      ]);
      expect(f.host.querySelectorAll('.is-multiselected')).toHaveLength(1);
      act(() => button(f.host, '全选当前结果').click());
      expect(button(f.host, '拉取所选会话漫游消息').disabled).toBe(true);
      expect(button(f.host, '拉取所选会话漫游消息').title).toContain('不支持');
      expect(button(f.host, '导出所选会话').disabled).toBe(true);
      act(() => button(f.host, '取消全选当前结果').click());
      expect(f.host.querySelectorAll('.is-multiselected')).toHaveLength(0);
      expect(f.host.querySelector('[aria-label="会话多选操作"]')).not.toBeNull();
      expect(button(f.host, '全选当前结果')).not.toBeNull();
      expect(button(f.host, '导出所选会话').disabled).toBe(true);
      act(() => button(f.host, '全选当前结果').click());
      expect(f.host.querySelectorAll('.is-multiselected')).toHaveLength(2);
      act(() => button(f.host, '退出多选').click());
      expect(f.host.querySelector('[aria-label="会话多选操作"]')).toBeNull();
    } finally {
      f.close();
    }
  });
});

describe('漫游目标范围', () => {
  it.each([
    [{ kind: 'c2c' as const, conv: 'u_fixture', name: '合成好友' }],
    [
      { kind: 'c2c' as const, conv: 'u_fixture', name: '合成好友' },
      { kind: 'group' as const, conv: '10001', name: '合成群聊' },
    ],
  ])('固定目标不再展示全库选择器，扫描只使用入口快照 %#', (...targets) => {
    const f = mount(h(RoamingBackfillPanel, { initialTargets: targets, targetMode: 'fixed' }));
    try {
      expect(fixture.contacts).toHaveBeenCalledWith(
        undefined,
        expect.objectContaining({ enabled: false }),
      );
      expect(f.host.querySelector('[aria-label="搜索补全会话"]')).toBeNull();
      expect(f.host.querySelectorAll('.weq-roaming-scope input[type="checkbox"]')).toHaveLength(1);
      expect(f.host.textContent).toContain(targets[0]!.name);
      const selectText = new KeyboardEvent('keydown', {
        key: 'a',
        ctrlKey: true,
        bubbles: true,
        cancelable: true,
      });
      act(() => f.host.querySelector('.weq-roaming-scope strong')!.dispatchEvent(selectText));
      expect(selectText.defaultPrevented).toBe(false);
      const scan = [...f.host.querySelectorAll('button')].find((node) =>
        node.textContent?.includes('扫描候选缺口'),
      )!;
      act(() => scan.click());
      expect(fixture.plan).toHaveBeenCalledWith(expect.objectContaining({ targets }));
    } finally {
      f.close();
    }
  });

  it('全局入口保留会话选择，空选不能扫描', () => {
    const f = mount(h(RoamingBackfillPanel));
    try {
      expect(fixture.contacts).toHaveBeenCalledWith(
        undefined,
        expect.objectContaining({ enabled: true }),
      );
      expect(f.host.querySelector('[aria-label="搜索补全会话"]')).not.toBeNull();
      expect(
        [...f.host.querySelectorAll('button')].find((node) =>
          node.textContent?.includes('扫描候选缺口'),
        )!.disabled,
      ).toBe(true);
    } finally {
      f.close();
    }
  });

  it('固定范围不随上游选区或目标对象变化，非法目标不退回全库选择', () => {
    const target = { kind: 'c2c' as const, conv: 'u_fixture', name: '合成好友' };
    const f = mount(h(RoamingBackfillPanel, { initialTargets: [target], targetMode: 'fixed' }));
    try {
      target.conv = 'u_changed';
      f.render(
        h(RoamingBackfillPanel, {
          initialTargets: [target, { kind: 'group', conv: '10001', name: '后来选择' }],
          targetMode: 'fixed',
        }),
      );
      const scan = [...f.host.querySelectorAll('button')].find((node) =>
        node.textContent?.includes('扫描候选缺口'),
      )!;
      act(() => scan.click());
      expect(fixture.plan).toHaveBeenCalledWith(
        expect.objectContaining({
          targets: [{ kind: 'c2c', conv: 'u_fixture', name: '合成好友' }],
        }),
      );
    } finally {
      f.close();
    }
    const invalid = mount(
      h(RoamingBackfillPanel, {
        initialTargets: [{ kind: 'c2c', conv: 'dataline', name: '合成设备' }],
        targetMode: 'fixed',
      }),
    );
    try {
      expect(invalid.host.querySelector('[role="alert"]')?.textContent).toContain('不支持');
      expect(invalid.host.querySelector('[aria-label="搜索补全会话"]')).toBeNull();
      expect(
        [...invalid.host.querySelectorAll('button')].find((node) =>
          node.textContent?.includes('扫描候选缺口'),
        )!.disabled,
      ).toBe(true);
    } finally {
      invalid.close();
    }
  });
});
