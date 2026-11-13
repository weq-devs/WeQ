import { act, createElement as h } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { QQProfileField } from '../src/renderer/src/components/QQProfileField';
import { ProfileInlineField } from '../src/renderer/src/components/ProfileInlineField';
import { copyTextToClipboard } from '../src/renderer/src/im-template/template/clipboard';

vi.mock('../src/renderer/src/im-template/template/clipboard', () => ({
  copyTextToClipboard: vi.fn(async () => true),
}));

const mock = vi.hoisted(() => ({
  binding: { expectedAccountUin: '10001', expectedAccountConfigId: 'source' },
  online: true,
  friend: true,
  role: 'owner',
  remark: '旧备注',
  groupName: '原群名',
  categoryId: 1,
  fail: false,
  readError: false,
  confirm: true,
  reads: vi.fn(),
  writes: vi.fn(),
  invalidate: vi.fn(),
}));
vi.mock('../src/renderer/src/hooks/useQQWriteSession', () => ({
  useQQWriteSession: () => ({
    binding: mock.binding,
    available: mock.online,
    busy: false,
    result: null,
    run: async (action, _refresh, options) => {
      try {
        await action(mock.binding);
        return await options.readback();
      } catch {
        return false;
      }
    },
  }),
}));
vi.mock('../src/renderer/src/trpc/client', () => {
  const data = (name: string) => {
    if (name === 'peerState')
      return {
        friend: mock.friend,
        role: mock.role,
        remark: mock.remark,
        groupName: mock.groupName,
      };
    if (name === 'friendRemarkState') return { remark: mock.remark };
    return {
      categories: [
        { id: 1, name: '朋友' },
        { id: 2, name: '同学' },
      ],
      friends: [{ uid: 'u_peer', categoryId: mock.categoryId }],
    };
  };
  const query = (name: string) => ({
    useQuery: (input, options) => {
      if (options.enabled) mock.reads(name, input);
      return {
        data: options.enabled && !mock.readError ? data(name) : undefined,
        error: options.enabled && mock.readError ? new Error('合成读取失败') : null,
        isFetching: false,
        refetch: async () => ({ data: data(name), error: null }),
      };
    },
  });
  const mutation = (name: string) => ({
    useMutation: () => ({
      mutateAsync: async (input) => {
        mock.writes(name, input);
        if (mock.fail) throw new Error('合成写入失败');
        if (mock.confirm) {
          if (name === 'friendRemark' || name === 'groupRemark') mock.remark = input.remark;
          if (name === 'groupName') mock.groupName = input.name;
          if (name === 'friendCategory') mock.categoryId = input.categoryId;
        }
        return { state: 'accepted' };
      },
    }),
  });
  return {
    trpc: {
      useUtils: () => ({ account: { listCategories: { invalidate: mock.invalidate } } }),
      account: {
        qqWrite: {
          peerState: query('peerState'),
          friendRemarkState: query('friendRemarkState'),
          friendRoster: query('friendRoster'),
          friendRemark: mutation('friendRemark'),
          groupRemark: mutation('groupRemark'),
          groupName: mutation('groupName'),
          friendCategory: mutation('friendCategory'),
        },
      },
    },
  };
});

let root: Root;
let host: HTMLDivElement;
let cache: QueryClient;
function render(
  field: 'friendRemark' | 'groupRemark' | 'groupName' | 'friendCategory' = 'friendRemark',
  initial = '旧备注',
  inline = false,
) {
  act(() =>
    root.render(
      h(
        QueryClientProvider,
        { client: cache },
        h(QQProfileField, {
          field,
          target: field.startsWith('group') ? '20001' : 'u_peer',
          initial,
          inline,
        }),
      ),
    ),
  );
}
const button = (label: string) => host.querySelector<HTMLButtonElement>(`[aria-label="${label}"]`)!;
async function click(label: string) {
  await act(async () => button(label).click());
}
async function fill(value: string) {
  await act(async () => {
    const input = host.querySelector('input')!;
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, value);
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
}
beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  Object.assign(mock, {
    binding: { expectedAccountUin: '10001', expectedAccountConfigId: 'source' },
    online: true,
    friend: true,
    role: 'owner',
    remark: '旧备注',
    groupName: '原群名',
    categoryId: 1,
    fail: false,
    readError: false,
    confirm: true,
  });
  vi.clearAllMocks();
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
  cache = new QueryClient();
});
afterEach(() => {
  act(() => root.unmount());
  host.remove();
  cache.clear();
  vi.unstubAllGlobals();
});

it('首屏不读写备注，点击后在原行编辑，取消不保存', async () => {
  render();
  expect(mock.reads).not.toHaveBeenCalled();
  const label = host.querySelector('.weq-profile-data-label');
  await click('编辑备注');
  expect(host.querySelector('.weq-profile-data-label')).toBe(label);
  expect(host.querySelector('.weq-member-inline-field label')).toBeNull();
  expect(host.querySelector('input')?.value).toBe('旧备注');
  expect(host.querySelector('[role="dialog"]')).toBeNull();
  await fill('未保存');
  await click('取消编辑备注');
  expect(host.querySelector('input')).toBeNull();
  expect(button('编辑备注').textContent).toBe('旧备注');
  expect(mock.writes).not.toHaveBeenCalled();
});
it.each(['friendRemark', 'groupRemark'] as const)(
  '%s 保存和清空使用绑定账号，读回后显示新值',
  async (field) => {
    render(field);
    await click('编辑备注');
    await fill('新备注');
    await click('保存备注');
    expect(button('编辑备注').textContent).toBe('新备注');
    expect(mock.writes).toHaveBeenLastCalledWith(
      field,
      expect.objectContaining({ ...mock.binding, remark: '新备注' }),
    );
    await click('编辑备注');
    await fill('');
    await click('保存备注');
    expect(button('编辑备注').textContent).toBe('添加备注');
  },
);
it.each(['failed', 'unconfirmed'])('写入 %s 时保留草稿，允许再次保存', async (mode) => {
  render();
  await click('编辑备注');
  await fill('保留输入');
  mock.fail = mode === 'failed';
  mock.confirm = mode !== 'unconfirmed';
  await click('保存备注');
  expect(host.querySelector('input')?.value).toBe('保留输入');
  mock.fail = false;
  mock.confirm = true;
  await click('保存备注');
  expect(button('编辑备注').textContent).toBe('保留输入');
});
it('切换账号或数据源立即丢弃旧编辑器与已保存显示值', async () => {
  render();
  await click('编辑备注');
  await fill('旧账号输入');
  mock.binding = { expectedAccountUin: '10004', expectedAccountConfigId: 'other' };
  render('friendRemark', '新账号备注');
  expect(host.querySelector('input')).toBeNull();
  expect(button('编辑备注').textContent).toBe('新账号备注');
  expect(mock.writes).not.toHaveBeenCalled();
});
it('离线已有内容为纯文本；读取失败有重试且不写入', async () => {
  mock.online = false;
  render();
  expect(button('编辑备注')).toBeNull();
  expect(host.textContent).toContain('旧备注');
  expect(host.querySelector('button')).toBeNull();
  mock.online = true;
  mock.readError = true;
  render();
  await click('编辑备注');
  expect(host.querySelector('[role="alert"]')?.textContent).toContain('合成读取失败');
  expect(host.querySelector('input')).toBeNull();
  expect(mock.writes).not.toHaveBeenCalled();
});
it('群名称拒绝空白，普通成员读回后不出现编辑框', async () => {
  render('groupName', '原群名');
  await click('编辑群名称');
  await fill('   ');
  expect(button('保存群名称').disabled).toBe(true);
  await fill('新群名');
  await click('保存群名称');
  expect(button('编辑群名称').textContent).toBe('新群名');
  mock.role = 'member';
  await click('编辑群名称');
  expect(host.querySelector('input')).toBeNull();
  expect(host.textContent).toContain('当前不能修改群名称');
});
it('群标题离线时为纯文本，恢复在线后原地编辑且不预读', async () => {
  mock.online = false;
  render('groupName', '原群名', true);
  expect(host.textContent).toContain('原群名');
  expect(host.querySelector('button')).toBeNull();
  expect(copyTextToClipboard).not.toHaveBeenCalled();
  expect(mock.reads).not.toHaveBeenCalled();
  expect(mock.writes).not.toHaveBeenCalled();
  mock.online = true;
  render('groupName', '原群名', true);
  expect(button('复制群名')).toBeNull();
  expect(mock.reads).not.toHaveBeenCalled();
  await click('编辑群名称');
  expect(host.querySelector('input')?.value).toBe('原群名');
});
it('好友分组原行下拉选择并核对所选分组', async () => {
  render('friendCategory', '朋友');
  await click('编辑好友分组');
  await act(async () => {
    const select = host.querySelector('select')!;
    select.value = '2';
    select.dispatchEvent(new Event('change', { bubbles: true }));
  });
  await click('保存好友分组');
  expect(mock.writes).toHaveBeenLastCalledWith('friendCategory', {
    ...mock.binding,
    uid: 'u_peer',
    categoryId: 2,
  });
  expect(button('编辑好友分组').textContent).toBe('同学');
  await click('编辑好友分组');
  await act(async () => {
    const select = host.querySelector('select')!;
    select.value = '0';
    select.dispatchEvent(new Event('change', { bubbles: true }));
  });
  await click('保存好友分组');
  expect(button('编辑好友分组').textContent).toBe('默认分组');
});
it('头部分组不渲染正文行，保存失败保留选择，取消后还原名称', async () => {
  render('friendCategory', '朋友', true);
  expect(host.querySelector('.weq-profile-data-row')).toBeNull();
  expect(mock.reads).not.toHaveBeenCalled();
  await click('编辑好友分组');
  expect(host.querySelector('.weq-profile-field-inline select')).not.toBeNull();
  await act(async () => {
    const select = host.querySelector('select')!;
    select.value = '2';
    select.dispatchEvent(new Event('change', { bubbles: true }));
  });
  mock.fail = true;
  await click('保存好友分组');
  expect(host.querySelector('select')?.value).toBe('2');
  await click('取消编辑好友分组');
  expect(button('编辑好友分组').textContent).toBe('朋友');
  mock.fail = false;
  await click('编辑好友分组');
  await act(async () => {
    const select = host.querySelector('select')!;
    select.value = '2';
    select.dispatchEvent(new Event('change', { bubbles: true }));
  });
  await click('保存好友分组');
  expect(button('编辑好友分组').textContent).toBe('同学');
  expect(host.querySelector('.weq-profile-data-row')).toBeNull();
});
it('群成员共用编辑器拒绝重复提交，失败保留文本', async () => {
  let finish!: (value: boolean) => void;
  const save = vi.fn(
    () =>
      new Promise<boolean>((resolve) => {
        finish = resolve;
      }),
  );
  act(() =>
    root.render(
      h(ProfileInlineField, {
        label: '群昵称',
        initial: '旧昵称',
        editable: true,
        disabled: false,
        initialEditing: true,
        onSave: save,
      }),
    ),
  );
  await fill('新昵称');
  await click('保存群昵称');
  expect(button('保存群昵称').disabled).toBe(true);
  await click('保存群昵称');
  expect(save).toHaveBeenCalledOnce();
  await act(async () => finish(false));
  expect(host.querySelector('input')?.value).toBe('新昵称');
});

it.each([false, true])('备注编辑及读取失败状态（%s）按 Esc 取消且不传给名片', async (readError) => {
  mock.readError = readError;
  render();
  await click('编辑备注');
  const close = vi.fn();
  document.addEventListener('keydown', close);
  try {
    const target = host.querySelector('input') ?? host.querySelector('[data-qq-action]')!;
    const event = new KeyboardEvent('keydown', {
      key: 'Escape',
      bubbles: true,
      cancelable: true,
    });
    act(() => target.dispatchEvent(event));
    expect(event.defaultPrevented).toBe(true);
    expect(button('编辑备注').textContent).toBe('旧备注');
    expect(host.querySelector('[data-qq-action]')).toBeNull();
    expect(mock.writes).not.toHaveBeenCalled();
    expect(close).not.toHaveBeenCalled();
  } finally {
    document.removeEventListener('keydown', close);
  }
});
