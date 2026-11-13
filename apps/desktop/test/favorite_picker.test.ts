import { act, createElement as h } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import {
  FavoritePickerTab,
  type PickerFavorite,
} from '../src/renderer/src/components/qq-actions/FavoritePickerTab';

const state = vi.hoisted(() => ({
  available: true,
  rows: [] as Array<{ emojiId: string; desc: string; position: number; local: unknown }>,
  mutation: vi.fn(async (_input: unknown) => ({ state: 'accepted' })),
  invalidate: vi.fn(async () => {}),
  save: vi.fn(),
  confirm: vi.fn(async () => true),
}));
const binding = { expectedAccountUin: '10001', expectedAccountConfigId: 'source-a' };
vi.mock('../src/renderer/src/trpc/client', () => ({
  client: {
    account: {
      qqActions: {
        favorites: { query: async () => state.rows },
        favorite: { mutate: (input: unknown) => state.mutation(input) },
      },
    },
  },
  trpc: {
    account: {
      qqActions: {
        favorites: {
          useQuery: () => ({ data: state.available ? state.rows : undefined, error: null }),
        },
      },
    },
    useUtils: () => ({ account: { qqActions: { favorites: { invalidate: state.invalidate } } } }),
  },
}));
vi.mock('../src/renderer/src/hooks/useQQAutoRefresh', () => ({ useQQAutoRefresh: () => ({}) }));
vi.mock('../src/renderer/src/components/MediaSaveControls', () => ({
  useMediaSave: () => ({ run: state.save, disabled: false, prompt: null }),
}));
vi.mock('../src/renderer/src/components/qq-actions/shared', () => ({
  withQQAccountScope: (component: unknown) => component,
  useQQAction: () => ({
    binding,
    available: state.available,
    disabled: !state.available,
    perform: async (
      run: (b: unknown) => Promise<unknown>,
      refresh: () => Promise<void>,
      warning?: string,
      options?: { readback?: () => Promise<boolean> },
    ) => {
      if (warning && !(await state.confirm())) return false;
      await run(binding);
      const ok = await options?.readback?.();
      await refresh();
      return ok;
    },
  }),
  ActionIcon: (props: { label: string; disabled?: boolean; onClick: () => void }) =>
    h('button', { 'aria-label': props.label, disabled: props.disabled, onClick: props.onClick }),
}));
vi.mock('../src/renderer/src/components/ConversationActionsMenu', () => ({
  ConversationActionsMenu: (props: {
    actions: Array<{ label: string; disabled?: boolean; action: () => void }>;
    onClose: () => void;
  }) =>
    h(
      'div',
      { role: 'menu' },
      props.actions.map((action) =>
        h(
          'button',
          {
            key: action.label,
            role: 'menuitem',
            disabled: action.disabled,
            onClick: () => {
              props.onClose();
              action.action();
            },
          },
          action.label,
        ),
      ),
    ),
}));
vi.mock('../src/renderer/src/components/Dialog', () => ({
  Modal: (props: { children: unknown }) => h('div', { role: 'dialog' }, props.children as never),
}));

const favorite: PickerFavorite = {
  id: 'local-a',
  hash: 'a'.repeat(32),
  scope: 'personal',
  bucket: '',
  oriFile: 'aaaaaa.png',
  thumbFile: 'aaaaaa-thumb.png',
  original: { scope: 'personal', bucket: '', file: 'aaaaaa.png' },
};
let host: HTMLDivElement;
let root: ReturnType<typeof createRoot>;
const changed = vi.fn(async () => {}),
  select = vi.fn();
beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  state.available = true;
  state.rows = [{ emojiId: 'online-a', desc: '原备注', position: 2, local: favorite }];
  vi.clearAllMocks();
  state.confirm.mockResolvedValue(true);
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
});
afterEach(() => {
  act(() => root.unmount());
  host.remove();
  vi.unstubAllGlobals();
});
function render() {
  act(() =>
    root.render(
      h(FavoritePickerTab, {
        favorites: [favorite],
        loading: false,
        onSelect: select,
        onChanged: changed,
      }),
    ),
  );
}
function openMenu(keyboard = false) {
  const cell = host.querySelector('button[aria-haspopup="menu"]')!;
  act(() =>
    cell.dispatchEvent(
      keyboard
        ? new KeyboardEvent('keydown', { bubbles: true, key: 'F10', shiftKey: true })
        : new MouseEvent('contextmenu', { bubbles: true, clientX: 20, clientY: 30 }),
    ),
  );
}
function button(text: string) {
  return [...host.querySelectorAll<HTMLButtonElement>('button')].find(
    (item) => item.textContent === text || item.getAttribute('aria-label') === text,
  )!;
}

it('右键不选中表情，四项菜单使用原图保存，普通点击仍选取', async () => {
  render();
  openMenu();
  expect([...host.querySelectorAll('[role="menuitem"]')].map((item) => item.textContent)).toEqual([
    '删除',
    '备注',
    '移到最前',
    '保存',
  ]);
  expect(select).not.toHaveBeenCalled();
  await act(async () => button('保存').click());
  expect(state.save).toHaveBeenCalledWith({
    kind: 'url',
    url: expect.stringContaining('file=aaaaaa.png'),
    name: '原备注',
  });
  act(() => host.querySelector<HTMLButtonElement>('[aria-haspopup="menu"]')!.click());
  expect(select).toHaveBeenCalledOnce();
});
it('删除取消不提交，确认后使用远端 emojiId 并刷新列表', async () => {
  render();
  openMenu();
  state.confirm.mockResolvedValueOnce(false);
  await act(async () => button('删除').click());
  expect(state.mutation).not.toHaveBeenCalled();
  openMenu();
  state.mutation.mockImplementationOnce(async () => {
    state.rows = [];
    return { state: 'accepted' };
  });
  await act(async () => button('删除').click());
  expect(state.mutation).toHaveBeenCalledWith({
    ...binding,
    action: 'delete',
    emojiId: 'online-a',
  });
  expect(changed).toHaveBeenCalledOnce();
});
it('键盘菜单可移到最前，第一项禁用该操作', async () => {
  render();
  openMenu(true);
  await act(async () => button('移到最前').click());
  expect(state.mutation).toHaveBeenCalledWith({
    ...binding,
    action: 'move',
    emojiId: 'online-a',
    position: 1,
  });
  state.rows[0]!.position = 1;
  render();
  openMenu();
  expect(button('移到最前').disabled).toBe(true);
});
it('备注使用在线备注且允许清空，提交读回后关闭编辑框', async () => {
  render();
  openMenu();
  act(() => button('备注').click());
  const input = host.querySelector<HTMLInputElement>('input')!;
  expect(input.value).toBe('原备注');
  act(() => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, '');
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
  state.rows[0]!.desc = '';
  await act(async () =>
    host
      .querySelector('form')!
      .dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })),
  );
  expect(state.mutation).toHaveBeenCalledWith({
    ...binding,
    action: 'rename',
    emojiId: 'online-a',
    desc: '',
  });
  expect(host.querySelector('[role="dialog"]')).toBeNull();
});
it('离线保持选取和保存，禁止三个在线写操作', async () => {
  state.available = false;
  render();
  openMenu();
  expect(['删除', '备注', '移到最前'].every((name) => button(name).disabled)).toBe(true);
  expect(button('保存').disabled).toBe(false);
  expect(host.querySelector('img')?.src).toContain('thumb');
});
it('在线顺序与成员优先于旧本地列表，删除项不再出现在选择器', () => {
  state.rows = [];
  render();
  expect(host.querySelector('[aria-haspopup="menu"]')).toBeNull();
});
