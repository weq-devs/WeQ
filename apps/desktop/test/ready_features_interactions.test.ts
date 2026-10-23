import { act, createElement as h, useEffect, type ReactNode } from 'react';
import { createRoot } from 'react-dom/client';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { QzoneFriendPermissions } from '../src/renderer/src/components/qq-actions/QzoneFriendPermissions';
import { QqAvatar } from '../src/renderer/src/components/QqAvatar';
import { EditableSelfProfile } from '../src/renderer/src/components/settings/EditableSelfProfile';
import { GroupAlbumManagement } from '../src/renderer/src/components/qq-actions/GroupAlbumManagement';
import { QQExactLookup } from '../src/renderer/src/components/QQExactLookup';
import { CommonRelationships } from '../src/renderer/src/components/qq-actions/CommonRelationships';
import { ContactList } from '../src/renderer/src/im-template/template/conversationLists';
import { FriendDirectoryContext } from '../src/renderer/src/components/FriendDirectoryControls';
import { ConversationDirectoryContext } from '../src/renderer/src/lib/conversationDirectory';
import { sharedGroupConversation } from '../src/renderer/src/components/ark/groupShareCard';
import {
  ContentSelectionProvider,
  useContentMultiSelect,
} from '../src/renderer/src/state/contentSelection';
import { useViewState } from '../src/renderer/src/state/view';
import type { QQWriteBinding, QQWriteOutcome } from '../src/renderer/src/hooks/useQQWriteSession';

const state = vi.hoisted(() => ({
  config: 'source-a',
  permissionFailure: false,
  albumConfirmed: false,
  permissions: {
    blocked: [] as Array<{ uin: string; name: string }>,
    hidden: [] as Array<{ uin: string; name: string }>,
  },
  writes: vi.fn(async (_name: string, _input: unknown) => ({ state: 'unconfirmed' as const })),
  reads: vi.fn(),
  special: vi.fn(async () => true),
  confirm: true,
  errors: {} as Record<string, string>,
  commonGroups: [{ groupCode: '123', name: '合成共同群' }],
  searchFriends: [
    { uid: 'u_peer', uin: '10002', nick: '合成好友', remark: '好友备注' },
    { uid: 'u_self', uin: '10001', nick: '自己', remark: '' },
  ],
}));
vi.mock('../src/renderer/src/components/Dialog', () => ({
  Modal: ({ children }: { children: ReactNode }) => h('div', { role: 'dialog' }, children),
  useDialog: () => async () => state.confirm,
}));
vi.mock('../src/renderer/src/components/OverlayLayer', () => ({
  OverlayLayer: ({ children }: { children: ReactNode }) => children,
}));
vi.mock('../src/renderer/src/hooks/useFriendSpecialCare', () => ({
  useFriendSpecialCare: () => ({ enabled: false, disabled: false, change: state.special }),
}));
vi.mock('../src/renderer/src/hooks/useQQWriteSession', () => ({
  useQQWriteSession: () => ({
    binding: { expectedAccountUin: '10001', expectedAccountConfigId: state.config },
    available: true,
    busy: false,
    result: null,
    run: async (
      action: (b: QQWriteBinding) => Promise<QQWriteOutcome>,
      refresh?: () => Promise<unknown>,
      options?: { readback?: () => Promise<boolean> },
    ) => {
      try {
        await action({ expectedAccountUin: '10001', expectedAccountConfigId: state.config });
        const confirmed = options?.readback ? await options.readback() : false;
        await refresh?.();
        return confirmed;
      } catch {
        return false;
      }
    },
  }),
}));
vi.mock('../src/renderer/src/trpc/client', () => {
  const albums = () =>
    state.albumConfirmed
      ? [{ id: 'new-album', title: '新相册', desc: '草稿', createUin: 10001 }]
      : [];
  return {
    client: {
      account: {
        listGroupAlbums: { query: async () => albums() },
        qqActions: {
          albumManagement: { mutate: (input: unknown) => state.writes('album', input) },
        },
      },
    },
    trpc: {
      account: {
        searchQuick: {
          useQuery: () => ({
            data: { friends: state.searchFriends },
            isFetching: false,
            error: null,
          }),
        },
        getAccountConfig: { useQuery: () => ({ data: { uin: '10001', configId: state.config } }) },
        qqActions: {
          qzoneFriendPermissionList: {
            useQuery: ({ kind }: { kind: 'blocked' | 'hidden' }) => ({
              data: state.permissions[kind],
              error:
                kind === 'hidden' && state.permissionFailure ? new Error('合成读取失败') : null,
              refetch: async () => ({ data: state.permissions[kind] }),
            }),
          },
          qzoneFriendPermission: {
            useMutation: () => ({
              mutateAsync: (input: unknown) => state.writes('permission', input),
            }),
          },
        },
        qqWrite: {
          editableSelfProfile: {
            useQuery: () => ({
              data: {
                birthday: '2000-02-29',
                email: 'synthetic@example.invalid',
                school: '合成学校',
                profession: 13,
                region: null,
                hometown: null,
                errors: state.errors,
              },
              refetch: async () => ({}),
            }),
          },
          profileRegions: {
            useQuery: () => ({
              data: { regions: [], professions: [{ value: 13, label: '学生' }] },
            }),
          },
          editSelfProfile: {
            useMutation: () => ({
              mutateAsync: (input: unknown) => state.writes('profile', input),
            }),
          },
          exactProfile: {
            useQuery: (input: { kind: string; target: string }, options: { enabled: boolean }) => {
              if (options.enabled) state.reads(input);
              return {
                data: options.enabled
                  ? {
                      kind: input.kind,
                      id: input.target,
                      name: '合成资料',
                      level: 10,
                      category: null,
                    }
                  : undefined,
                refetch: async () => ({}),
              };
            },
          },
          commonRelationships: {
            useQuery: () => ({
              data: { friendCount: 3, groups: state.commonGroups },
            }),
          },
        },
      },
    },
  };
});
const cleanup: Array<() => void> = [];
beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  useViewState.setState({ openedUin: '10001' });
  state.config = 'source-a';
  state.permissionFailure = false;
  state.confirm = true;
  state.albumConfirmed = false;
  state.permissions = { blocked: [], hidden: [] };
  state.errors = {};
  state.commonGroups = [{ groupCode: '123', name: '合成共同群' }];
  state.writes.mockClear();
  state.reads.mockClear();
});
afterEach(() => {
  for (const dispose of cleanup.splice(0)) dispose();
  useViewState.setState({ openedUin: null });
  vi.unstubAllGlobals();
});
function mount(render: () => ReactNode) {
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  const update = () => act(() => root.render(render()));
  update();
  cleanup.push(() => {
    act(() => root.unmount());
    host.remove();
  });
  return { host, update };
}
function setValue(node: HTMLInputElement | HTMLTextAreaElement, value: string) {
  act(() => {
    Object.getOwnPropertyDescriptor(
      node instanceof HTMLTextAreaElement
        ? HTMLTextAreaElement.prototype
        : HTMLInputElement.prototype,
      'value',
    )!.set!.call(node, value);
    node.dispatchEvent(new Event('input', { bubbles: true }));
  });
}
function capturePermissions(host: HTMLElement, name: string) {
  const output = process.env.WEQ_PERMISSION_LAYOUT_DIR;
  if (!output) return;
  mkdirSync(output, { recursive: true });
  const snapshot = host.cloneNode(true) as HTMLElement;
  for (const image of snapshot.querySelectorAll('img'))
    image.outerHTML = renderToStaticMarkup(h(QqAvatar, { size: 24 }));
  const css = [
    'index.css',
    'settings-controls.css',
    'settings-query.css',
    'qq-actions.css',
    'qzone-permissions.css',
  ]
    .map((file) => readFileSync(resolve('src/renderer/src/styles', file), 'utf8'))
    .join('\n');
  writeFileSync(
    resolve(output, `${name}.html`),
    `<!doctype html><html lang="zh-CN" data-theme="light"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><style>${css}\n*{box-sizing:border-box}body{margin:0;padding:24px;font-family:system-ui;background:var(--weq-bg-surface);color:var(--weq-fg-primary)}main{max-width:680px;margin:auto}</style><body><main class="weq-set">${snapshot.innerHTML}</main></body></html>`,
  );
}
describe('可接入功能交互回归', () => {
  it('空间一个名单失败不阻断另一个开关，失败项不能显示成已关闭', () => {
    state.permissionFailure = true;
    const f = mount(() => h(QzoneFriendPermissions, { targetUin: '10002' }));
    const toggles = [
      ...f.host.querySelectorAll<HTMLButtonElement>('[role="switch"], [role="checkbox"]'),
    ];
    expect(toggles).toHaveLength(2);
    expect(toggles[0]!.disabled).toBe(false);
    expect(toggles[1]!.disabled).toBe(true);
    expect(f.host.textContent).toContain('合成读取失败');
  });
  it('空间名单使用头像与昵称排列，不再逐人显示开关；移除只更新对应名单', async () => {
    state.permissions.blocked = [{ uin: '10002', name: '合成好友' }];
    const f = mount(() => h(QzoneFriendPermissions));
    expect(f.host.querySelector('[role="switch"]')).toBeNull();
    expect(f.host.querySelector('.weq-qzone-permission-users img')).not.toBeNull();
    expect(f.host.querySelector('.weq-qzone-permission-users')?.textContent).toContain('合成好友');
    const remove = f.host.querySelector<HTMLButtonElement>(
      '[aria-label^="从不让 ta 看我的空间移除"]',
    )!;
    state.writes.mockImplementationOnce(async () => {
      state.permissions.blocked = [];
      return { state: 'unconfirmed' };
    });
    await act(async () => remove.click());
    expect(state.writes).toHaveBeenCalledWith('permission', {
      expectedAccountUin: '10001',
      expectedAccountConfigId: 'source-a',
      kind: 'blocked',
      targetUin: '10002',
      enabled: false,
    });
    f.update();
    expect(f.host.querySelector('[aria-label^="从不让 ta 看我的空间移除"]')).toBeNull();
  });
  it('空间名单取消移除不提交，长昵称与号码兜底仍可辨认', async () => {
    state.permissions.blocked = [
      { uin: '10002', name: '合成好友' },
      { uin: '10003', name: '很长很长的好友昵称用于检查换行和省略号显示' },
      { uin: '10004', name: '' },
      { uin: '10005', name: '另一位好友' },
    ];
    state.confirm = false;
    const f = mount(() => h(QzoneFriendPermissions));
    capturePermissions(f.host, 'lists');
    await act(async () =>
      f.host.querySelector<HTMLButtonElement>('[aria-label^="从不让 ta 看我的空间移除"]')!.click(),
    );
    expect(state.writes).not.toHaveBeenCalled();
    expect(f.host.textContent).toContain('10004');
    await act(async () =>
      f.host.querySelector<HTMLButtonElement>('[aria-label="添加到不看 ta 的空间"]')!.click(),
    );
    setValue(f.host.querySelector('input')!, '合成');
    capturePermissions(f.host, 'adding');
  });
  it('空间名单可搜索添加好友，读回未确认时保留输入，确认后收起', async () => {
    const f = mount(() => h(QzoneFriendPermissions));
    await act(async () =>
      f.host.querySelector<HTMLButtonElement>('[aria-label="添加到不看 ta 的空间"]')!.click(),
    );
    setValue(f.host.querySelector('input')!, '合成');
    expect(f.host.querySelector('.weq-qzone-permission-candidates')?.textContent).not.toContain(
      '自己',
    );
    const add = () => f.host.querySelector<HTMLButtonElement>('[title="添加 好友备注"]')!;
    await act(async () => add().click());
    expect(f.host.querySelector('input')?.value).toBe('合成');
    state.writes.mockImplementationOnce(async () => {
      state.permissions.hidden = [{ uin: '10002', name: '合成好友' }];
      return { state: 'unconfirmed' };
    });
    await act(async () => add().click());
    expect(state.writes).toHaveBeenLastCalledWith('permission', {
      expectedAccountUin: '10001',
      expectedAccountConfigId: 'source-a',
      kind: 'hidden',
      targetUin: '10002',
      enabled: true,
    });
    expect(f.host.querySelector('input')).toBeNull();
  });
  it('空间名单拒绝重复、本人和无效号码，直接输入 QQ 号可添加；切数据源清空草稿', async () => {
    state.permissions.blocked = [{ uin: '10002', name: '已添加' }];
    const f = mount(() => h(QzoneFriendPermissions));
    await act(async () =>
      f.host.querySelector<HTMLButtonElement>('[aria-label="添加到不让 ta 看我的空间"]')!.click(),
    );
    for (const value of ['10001', '10002', '00003', '12', '1234567890123']) {
      setValue(f.host.querySelector('input')!, value);
      expect(f.host.querySelector<HTMLButtonElement>('[aria-label="添加此 QQ 号"]')!.disabled).toBe(
        true,
      );
      expect(f.host.querySelector('[title="添加 好友备注"]')).toBeNull();
    }
    setValue(f.host.querySelector('input')!, '10003');
    await act(async () =>
      f.host
        .querySelector('form')!
        .dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })),
    );
    expect(state.writes).toHaveBeenCalledWith(
      'permission',
      expect.objectContaining({ kind: 'blocked', targetUin: '10003', enabled: true }),
    );
    expect(f.host.querySelector('input')?.value).toBe('10003');
    state.config = 'source-b';
    f.update();
    expect(f.host.querySelector('input')).toBeNull();
  });
  it('空间名单读取失败不冒充空名单，禁用添加与移除，但不阻断另一名单', () => {
    state.permissionFailure = true;
    state.permissions.hidden = [{ uin: '10002', name: '缓存好友' }];
    const f = mount(() => h(QzoneFriendPermissions));
    expect(
      f.host.querySelector<HTMLButtonElement>('[aria-label="添加到不让 ta 看我的空间"]')!.disabled,
    ).toBe(false);
    expect(
      f.host.querySelector<HTMLButtonElement>('[aria-label="添加到不看 ta 的空间"]')!.disabled,
    ).toBe(true);
    expect(
      f.host.querySelector<HTMLButtonElement>('[aria-label^="从不看 ta 的空间移除"]')!.disabled,
    ).toBe(true);
    expect(f.host.textContent).toContain('缓存好友');
    expect(f.host.textContent).toContain('合成读取失败');
  });
  it('资料按字段隔离读取失败，邮箱失败时生日仍可保存', () => {
    state.errors = { email: '邮箱读取失败' };
    const f = mount(() => h(EditableSelfProfile));
    expect(f.host.querySelector<HTMLButtonElement>('[aria-label="保存生日"]')!.disabled).toBe(
      false,
    );
    expect(f.host.querySelector<HTMLButtonElement>('[aria-label="保存邮箱"]')!.disabled).toBe(true);
  });
  it('职业选择即提交单字段，保留生日等文本编辑的保存按钮', async () => {
    const f = mount(() => h(EditableSelfProfile));
    expect(f.host.querySelector('[aria-label="保存职业"]')).toBeNull();
    const select = f.host.querySelector<HTMLSelectElement>('[aria-label="职业"]')!;
    await act(async () => {
      select.value = '13';
      select.dispatchEvent(new Event('change', { bubbles: true }));
    });
    expect(state.writes).toHaveBeenCalledOnce();
    expect(state.writes).toHaveBeenCalledWith('profile', {
      expectedAccountUin: '10001',
      expectedAccountConfigId: 'source-a',
      patch: { profession: 13 },
    });
    expect(f.host.querySelector('[aria-label="保存生日"]')).not.toBeNull();
  });
  it('相册未确认时保留草稿与弹窗，不把已有同名相册误当成新增成功', async () => {
    const changed = vi.fn();
    const f = mount(() => h(GroupAlbumManagement, { groupCode: '123', onChanged: changed }));
    await act(async () =>
      f.host.querySelector<HTMLButtonElement>('[aria-label="新建相册"]')!.click(),
    );
    setValue(f.host.querySelector('input')!, '新相册');
    setValue(f.host.querySelector('textarea')!, '草稿');
    await act(async () =>
      f.host
        .querySelector('form')!
        .dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })),
    );
    expect(f.host.querySelector('textarea')!.value).toBe('草稿');
    expect(changed).not.toHaveBeenCalled();
    state.albumConfirmed = true;
    await act(async () =>
      f.host
        .querySelector('form')!
        .dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })),
    );
    // 新建的读回必须出现本次新增 ID；已有同名相册不能误判为新建成功。
    expect(changed).not.toHaveBeenCalled();
  });
  it('新建相册读回本次新增 ID 后才关闭编辑器', async () => {
    const changed = vi.fn();
    const f = mount(() => h(GroupAlbumManagement, { groupCode: '123', onChanged: changed }));
    await act(async () =>
      f.host.querySelector<HTMLButtonElement>('[aria-label="新建相册"]')!.click(),
    );
    setValue(f.host.querySelector('input')!, '新相册');
    setValue(f.host.querySelector('textarea')!, '草稿');
    state.writes.mockImplementationOnce(async () => {
      state.albumConfirmed = true;
      return { state: 'unconfirmed' };
    });
    await act(async () =>
      f.host
        .querySelector('form')!
        .dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })),
    );
    expect(changed).toHaveBeenCalledOnce();
    expect(f.host.querySelector('form')).toBeNull();
  });
  it('相册编辑切数据源后不保留旧草稿', async () => {
    const f = mount(() => h(GroupAlbumManagement, { groupCode: '123', onChanged: vi.fn() }));
    await act(async () =>
      f.host.querySelector<HTMLButtonElement>('[aria-label="新建相册"]')!.click(),
    );
    setValue(f.host.querySelector('input')!, '旧来源');
    state.config = 'source-b';
    f.update();
    expect(f.host.querySelector('form')).toBeNull();
  });
  it.each(['user', 'group'] as const)(
    '独立号码搜索 %s 只在提交后读取，结果不冒充添加成功',
    async (kind) => {
      const f = mount(() => h(QQExactLookup, { kind, onClose: vi.fn() }));
      expect(f.host.querySelector('[role="tablist"]')).toBeNull();
      expect(f.host.querySelector('h3')?.textContent).toBe(
        kind === 'user' ? 'QQ 号搜索' : '群号搜索',
      );
      setValue(f.host.querySelector('input')!, '10002');
      expect(state.reads).not.toHaveBeenCalled();
      await act(async () =>
        f.host
          .querySelector('form')!
          .dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })),
      );
      expect(state.reads).toHaveBeenCalledWith(expect.objectContaining({ kind, target: '10002' }));
      expect(f.host.textContent).toContain('合成资料');
      expect(f.host.textContent).not.toContain('添加成功');
    },
  );
  it('名片直接展示共同数量，列表需要手动打开，不额外显示完整性标签', async () => {
    const f = mount(() => h(CommonRelationships, { uin: '10002' }));
    const rows = [...f.host.querySelectorAll('.weq-profile-row')];
    expect(rows.map((row) => row.querySelector('.weq-profile-row-label')?.textContent)).toEqual([
      '共同好友',
      '共同群',
    ]);
    expect(rows.map((row) => row.querySelector('strong')?.textContent)).toEqual(['3', '1']);
    expect(f.host.textContent).not.toContain('合成共同群');
    await act(async () =>
      [...f.host.querySelectorAll('button')]
        .find((node) => node.title === '查看共同群列表')!
        .click(),
    );
    expect(f.host.textContent).toContain('合成共同群');
    expect(f.host.textContent).not.toContain('不完整');
  });
  it('共同群头像打开对应群名片，关闭名片后仍保留列表', async () => {
    const f = mount(() => h(CommonRelationships, { uin: '10002' }));
    await act(async () =>
      f.host.querySelector<HTMLButtonElement>('[title="查看共同群列表"]')!.click(),
    );
    const avatar = f.host.querySelector<HTMLButtonElement>(
      '[aria-label="查看 合成共同群 的群名片"]',
    );
    expect(avatar).not.toBeNull();
    await act(async () => avatar!.click());
    expect(f.host.querySelector('[aria-label="群资料"]')?.textContent).toContain('合成共同群');
    expect(f.host.querySelector('[aria-label="群资料"]')?.textContent).toContain('123');
    expect(f.host.querySelector('[aria-label="群资料"]')?.textContent).not.toContain('群成员');
    await act(async () =>
      f.host.querySelector<HTMLButtonElement>('[aria-label="群资料"] [aria-label="关闭"]')!.click(),
    );
    expect(f.host.querySelector('[aria-label="群资料"]')).toBeNull();
    expect(f.host.querySelector('[aria-label="查看 合成共同群 的群名片"]')).not.toBeNull();
  });
  it('共同群优先复用已收录的群资料，不显示伪造的零成员信息', async () => {
    const conversation = sharedGroupConversation({ code: '123', name: '已收录的群', avatar: '' });
    conversation.group.memberCount = 42;
    conversation.group.announcement = '已有的群公告';
    const f = mount(() =>
      h(
        ConversationDirectoryContext.Provider,
        {
          value: {
            virtual: [],
            real: [conversation],
            onVirtual: vi.fn(),
            onCreate: vi.fn(),
          },
        },
        h(CommonRelationships, { uin: '10002' }),
      ),
    );
    await act(async () =>
      f.host.querySelector<HTMLButtonElement>('[title="查看共同群列表"]')!.click(),
    );
    await act(async () =>
      f.host.querySelector<HTMLButtonElement>('[aria-label="查看 合成共同群 的群名片"]')!.click(),
    );
    const profile = f.host.querySelector('[aria-label="群资料"]')!;
    expect(profile.textContent).toContain('已收录的群');
    expect(profile.querySelector('.weq-profile-members-head strong')?.textContent).toBe('42');
    expect(profile.textContent).toContain('已有的群公告');
  });
  it('空共同群保留零数量和空态，切换数据源后关闭旧列表', async () => {
    state.commonGroups = [];
    const f = mount(() => h(CommonRelationships, { uin: '10002' }));
    const trigger = f.host.querySelector<HTMLButtonElement>('[title="查看共同群列表"]')!;
    expect(trigger.disabled).toBe(false);
    await act(async () => trigger.click());
    expect(f.host.textContent).toContain('暂无共同群');
    state.config = 'source-b';
    f.update();
    expect(f.host.querySelector('[role="dialog"]')).toBeNull();
  });
  it('联系人菜单保留分析、备注、导出、漫游和特别关心，排除已读与置顶', async () => {
    const contact = {
      id: 'u_a',
      identityLabel: 'QQ',
      identityValue: '10002',
      username: 'u_a',
      displayName: '合成好友',
      kind: 'human',
      categoryId: 0,
    };
    const f = mount(() =>
      h(
        ContentSelectionProvider,
        null,
        h(
          ConversationDirectoryContext.Provider,
          {
            value: {
              virtual: [],
              onVirtual: vi.fn(),
              onCreate: vi.fn(),
              onAnalyze: vi.fn(),
              onEditRemark: vi.fn(),
              onRoaming: vi.fn(),
            },
          },
          h(ContactList, { contacts: [contact], activeContactId: null, onSelect: vi.fn() }),
        ),
      ),
    );
    await act(async () => f.host.querySelector<HTMLButtonElement>('.contact-cat-header')!.click());
    await act(async () =>
      f.host
        .querySelector('.contact-cat-row')!
        .dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, clientX: 30, clientY: 40 })),
    );
    const labels = [...f.host.querySelectorAll('[role="menuitem"]')].map(
      (node) => node.textContent,
    );
    for (const label of ['分析', '修改好友备注', '导出', '拉取漫游消息', '特别关心'])
      expect(labels).toContain(label);
    expect(labels.some((label) => /置顶|已读|未读/.test(label ?? ''))).toBe(false);
  });
  it('多选好友拖拽带上完整选区，分组排序不能越过特殊分组', async () => {
    function Selected() {
      const { setSelectionMode, setSelectedIds } = useContentMultiSelect({
        kind: 'contacts',
        container: 'friends',
      });
      useEffect(() => {
        setSelectionMode(true);
        setSelectedIds(new Set(['u_a', 'u_b']));
      }, [setSelectionMode, setSelectedIds]);
      return null;
    }
    const move = vi.fn(),
      sort = vi.fn();
    const contacts = ['a', 'b'].map((id, index) => ({
      id: `u_${id}`,
      identityLabel: 'QQ',
      identityValue: `1000${index + 2}`,
      username: id,
      displayName: `合成好友${id}`,
      kind: 'human',
      categoryId: index ? 5 : 0,
    }));
    const categories = [
      { id: 0, name: '默认', buddyCount: 1, sortOrder: 0 },
      { id: 5, name: '同学', buddyCount: 1, sortOrder: 1 },
    ];
    const f = mount(() =>
      h(
        ContentSelectionProvider,
        null,
        h(Selected),
        h(
          FriendDirectoryContext.Provider,
          {
            value: {
              categories,
              assignments: new Map(),
              busy: false,
              available: true,
              create: vi.fn(),
              edit: vi.fn(),
              move,
              sort,
            },
          },
          h(ContactList, {
            contacts,
            specialSections: [{ id: 'special:care', name: '特别关心', items: [] }],
            activeContactId: null,
            onSelect: vi.fn(),
          }),
        ),
      ),
    );
    const headers = [...f.host.querySelectorAll<HTMLButtonElement>('.contact-cat-header')];
    const special = headers.find((node) => node.textContent?.includes('特别关心'))!;
    const normal = headers.find((node) => node.textContent?.includes('默认'))!;
    const other = headers.find((node) => node.textContent?.includes('同学'))!;
    expect(headers.every((node) => node.getAttribute('aria-expanded') === 'false')).toBe(true);
    expect(f.host.querySelector('.contact-cat-row')).toBeNull();
    await act(async () => normal.click());
    expect(other.getAttribute('aria-expanded')).toBe('false');
    expect(normal.getAttribute('aria-expanded')).toBe('true');
    await act(async () =>
      f.host
        .querySelector('.contact-cat-row')!
        .dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, clientX: 30, clientY: 40 })),
    );
    const moveEntry = [...f.host.querySelectorAll<HTMLButtonElement>('[role="menuitem"]')].find(
      (node) => node.textContent === '移动分组',
    );
    expect(moveEntry).toBeDefined();
    await act(async () => moveEntry!.click());
    expect(move).toHaveBeenCalledWith(['u_a', 'u_b']);
    move.mockClear();
    expect(special.getAttribute('draggable')).not.toBe('true');
    const transfer = { effectAllowed: 'move', dropEffect: 'move', setData: vi.fn() };
    const drag = (node: HTMLElement, type: string, clientY = 0) => {
      const event = new MouseEvent(type, { bubbles: true, cancelable: true, clientY });
      Object.defineProperty(event, 'dataTransfer', { value: transfer });
      node.dispatchEvent(event);
    };
    await act(async () => {
      drag(f.host.querySelector('.contact-cat-row')!, 'dragstart');
      drag(other, 'drop');
    });
    expect(move).toHaveBeenCalledWith(['u_a', 'u_b'], 5);
    move.mockClear();
    const otherGroup = other.parentElement!;
    vi.spyOn(otherGroup, 'getBoundingClientRect').mockReturnValue({
      top: 100,
      height: 100,
    } as DOMRect);
    await act(async () => other.click());
    const insideRow = otherGroup.querySelector<HTMLElement>('.contact-cat-row')!;
    expect(insideRow).not.toBeNull();
    await act(async () => {
      drag(f.host.querySelector('.contact-cat-row')!, 'dragstart');
      drag(insideRow, 'dragover', 170);
    });
    expect(otherGroup.classList.contains('is-contact-drop-target')).toBe(true);
    expect(otherGroup.dataset.dropPosition).toBeUndefined();
    await act(async () => drag(insideRow, 'drop', 170));
    expect(move).toHaveBeenCalledWith(['u_a', 'u_b'], 5);
    expect(otherGroup.classList.contains('is-contact-drop-target')).toBe(false);
    await act(async () => {
      drag(normal, 'dragstart');
      drag(special, 'drop');
    });
    expect(sort).not.toHaveBeenCalled();
    await act(async () => {
      drag(normal, 'dragstart');
      drag(insideRow, 'dragover', 120);
    });
    expect(otherGroup.dataset.dropPosition).toBe('before');
    expect(otherGroup.classList.contains('is-contact-drop-target')).toBe(false);
    expect(other.style.outline).toBe('');
    await act(async () => drag(insideRow, 'dragover', 180));
    expect(otherGroup.dataset.dropPosition).toBe('after');
    await act(async () => drag(insideRow, 'drop', 180));
    expect(sort).toHaveBeenCalledWith(0, 5, 'after');
    expect(otherGroup.dataset.dropPosition).toBeUndefined();
    await act(async () => {
      drag(normal, 'dragstart');
      drag(other, 'dragover', 110);
    });
    expect(otherGroup.dataset.dropPosition).toBe('before');
    await act(async () => drag(normal, 'dragend'));
    expect(otherGroup.dataset.dropPosition).toBeUndefined();
    await act(async () => normal.click());
    expect(normal.getAttribute('aria-expanded')).toBe('false');
    expect(other.getAttribute('aria-expanded')).toBe('true');
  });
});
