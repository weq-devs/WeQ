// @vitest-environment jsdom
import { act, createElement as h, type ReactNode } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { GroupBugDialog } from '../src/renderer/src/components/GroupBugDialog';
import { TabActivity } from '../src/renderer/src/components/RetainedTabs';

const rpc = vi.hoisted(() => ({ list: vi.fn(), write: vi.fn() }));
vi.mock('../src/renderer/src/trpc/client', () => ({
  trpc: {
    bootstrap: {
      getVersionInfo: { useQuery: () => ({ data: { app: 'fixture' }, isLoading: false }) },
    },
  },
  client: {
    groupFeedback: {
      listIssues: { query: rpc.list },
      submitNewBug: { mutate: rpc.write },
      submitIssueArk: { mutate: rpc.write },
    },
  },
}));
vi.mock('../src/renderer/src/components/Dialog', () => ({
  Modal: ({ children }: { children: ReactNode }) => children,
  useDialog: (selector: (value: { showError: () => void }) => unknown) =>
    selector({ showError() {} }),
}));
vi.mock('../src/renderer/src/components/Toast', () => ({
  useToast: (selector: (value: { push: () => void }) => unknown) => selector({ push() {} }),
}));
vi.mock('../src/renderer/src/state/theme', () => ({
  useThemeStore: (selector: (value: { resolved: string }) => unknown) =>
    selector({ resolved: 'light' }),
}));
vi.mock('streamdown', () => ({ Streamdown: () => null }));
vi.mock('../src/renderer/src/views/agentlab/shikiHighlighter', () => ({
  shikiCodeHighlighter: {},
}));
vi.mock('../src/renderer/src/components/ui/iconPicker', () => ({
  IconPicker: ({
    value,
    options,
    onChange,
  }: {
    value: string;
    options: { value: string; label: string }[];
    onChange: (value: string) => void;
  }) =>
    h(
      'select',
      {
        value,
        'aria-label': '选择 issue/PR',
        onChange: (event) => onChange(event.currentTarget.value),
      },
      options.map((option) =>
        h('option', { key: option.value, value: option.value }, option.label),
      ),
    ),
}));

const items = [
  { number: 1, title: '合成一', url: '', kind: 'issue' },
  { number: 2, title: '合成二', url: '', kind: 'pr' },
];
let close: (() => void) | undefined;
beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  rpc.list.mockReset().mockResolvedValue({ ok: true, items });
  rpc.write.mockReset();
});
afterEach(() => {
  close?.();
  close = undefined;
  vi.unstubAllGlobals();
});

it('进入已有事项自动加载，前台更新保留选择，读取失败保留列表且不发送反馈', async () => {
  let active = true;
  const host = document.createElement('div');
  const root = createRoot(host);
  const render = () =>
    act(async () =>
      root.render(
        h(
          TabActivity,
          { active },
          h(GroupBugDialog, { groupId: '12345', groupName: '合成群', onClose() {} }),
        ),
      ),
    );
  close = () => act(() => root.unmount());
  await render();
  expect(rpc.list).not.toHaveBeenCalled();
  await act(async () => host.querySelectorAll<HTMLButtonElement>('[role="tab"]')[1]!.click());
  expect(rpc.list).toHaveBeenCalledTimes(1);
  const picker = () => host.querySelector<HTMLSelectElement>('[aria-label="选择 issue/PR"]')!;
  act(() => {
    picker().value = '2';
    picker().dispatchEvent(new Event('change', { bubbles: true }));
  });
  active = false;
  await render();
  rpc.list.mockResolvedValue({ ok: true, items: [...items].reverse() });
  active = true;
  await render();
  expect(rpc.list).toHaveBeenCalledTimes(2);
  expect(picker().value).toBe('2');
  active = false;
  await render();
  rpc.list.mockResolvedValue({ ok: false, message: '合成读取失败' });
  active = true;
  await render();
  expect(host.textContent).toContain('合成读取失败');
  expect(picker().value).toBe('2');
  expect(rpc.write).not.toHaveBeenCalled();
});
