import { act, createElement as h } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  FriendNotesForm,
  FriendNotesEditor,
} from '../src/renderer/src/components/FriendNotesEditor';
import type { useQQWriteSession } from '../src/renderer/src/hooks/useQQWriteSession';

const query = vi.hoisted(() => ({ enabled: false, error: null as Error | null }));
vi.mock('../src/renderer/src/trpc/client', () => ({
  trpc: {
    account: {
      qqWrite: {
        friendNotesState: {
          useQuery: (_input: unknown, options: { enabled: boolean }) => {
            query.enabled = options.enabled;
            return { error: query.error };
          },
        },
        friendNotes: { useMutation: () => ({ mutateAsync: vi.fn() }) },
      },
    },
  },
}));
const cleanups: Array<() => void> = [];
beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  query.enabled = false;
  query.error = null;
});
afterEach(() => {
  for (const cleanup of cleanups.splice(0)) cleanup();
  vi.unstubAllGlobals();
});
function render(node: ReturnType<typeof h>) {
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  act(() => root.render(node));
  cleanups.push(() => {
    act(() => root.unmount());
    host.remove();
  });
  return host;
}
function input(host: HTMLElement, label: string, value: string) {
  const element = host.querySelector<HTMLInputElement | HTMLTextAreaElement>(
    `[aria-label="${label}"]`,
  )!;
  act(() => {
    const prototype =
      element instanceof HTMLTextAreaElement
        ? HTMLTextAreaElement.prototype
        : HTMLInputElement.prototype;
    Object.getOwnPropertyDescriptor(prototype, 'value')!.set!.call(element, value);
    element.dispatchEvent(new Event('input', { bubbles: true }));
  });
}
describe('我的备注资料编辑器', () => {
  it('独立标注自己添加的备注，展开前不请求；读取失败不显示空表单', () => {
    const session: ReturnType<typeof useQQWriteSession> = {
      binding: { expectedAccountUin: '10001', expectedAccountConfigId: 'source' },
      available: true,
      busy: false,
      result: null,
      run: vi.fn(async () => true),
    };
    query.error = new Error('我的好友备注资料读取失败（151）');
    const host = render(h(FriendNotesEditor, { uid: 'u_peer', session, onDirtyChange: vi.fn() }));
    expect(query.enabled).toBe(false);
    act(() => host.querySelector<HTMLButtonElement>('[aria-expanded]')!.click());
    expect(query.enabled).toBe(true);
    expect(host.textContent).toContain('我为好友添加的备注，不是好友公开资料');
    expect(host.querySelector('[role="alert"]')!.textContent).toContain('151');
    expect(host.querySelector('input')).toBeNull();
  });
  it('多条电话和多行描述按项保存，可删除清空，禁用时不提交', async () => {
    const save = vi.fn(async () => true);
    const dirty = vi.fn();
    const host = render(
      h(FriendNotesForm, {
        initial: {
          company: '公司备注',
          phones: ['1', '2'],
          descriptions: ['原说明'],
          revision: 'revision',
        },
        disabled: false,
        onDirtyChange: dirty,
        onSave: save,
      }),
    );
    input(host, '我备注的电话 2', '3');
    input(host, '我备注的描述 1', '第一行\n第二行');
    expect(dirty).toHaveBeenLastCalledWith(true);
    await act(async () =>
      host
        .querySelector('form')!
        .dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })),
    );
    expect(save).toHaveBeenCalledWith({
      company: '公司备注',
      phones: ['1', '3'],
      descriptions: ['第一行\n第二行'],
    });
    act(() => host.querySelector<HTMLButtonElement>('[aria-label="删除我备注的电话 2"]')!.click());
    act(() => host.querySelector<HTMLButtonElement>('[aria-label="删除我备注的电话 1"]')!.click());
    act(() => host.querySelector<HTMLButtonElement>('[aria-label="删除我备注的描述 1"]')!.click());
    await act(async () =>
      host
        .querySelector('form')!
        .dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })),
    );
    expect(save).toHaveBeenLastCalledWith({ company: '公司备注', phones: [], descriptions: [] });
    const locked = render(
      h(FriendNotesForm, {
        initial: { company: '', phones: [], descriptions: [], revision: '' },
        disabled: true,
        onDirtyChange: vi.fn(),
        onSave: save,
      }),
    );
    expect(
      [...locked.querySelectorAll('input, button')].every(
        (node) =>
          (node as HTMLInputElement).disabled || Boolean(node.closest('fieldset[disabled]')),
      ),
    ).toBe(true);
  });
});
