import { act, createElement as h } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, expect, it, vi } from 'vitest';
import { FriendClue } from '../src/renderer/src/components/qq-actions/FriendClue';
import { ConversationDirectoryContext } from '../src/renderer/src/lib/conversationDirectory';
import { sharedGroupConversation } from '../src/renderer/src/components/ark/groupShareCard';
import type { FriendClue as Clue } from '@weq/protocol';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

const state = vi.hoisted(() => ({
  available: true,
  fetching: false,
  error: false,
  data: null as (Clue & { uid: string }) | null,
  query: vi.fn(),
  groupQuery: vi.fn(),
  groupData: { groupId: 12345, name: '接口真实群名', memberCount: 23, maxMemberCount: 200 } as {
    groupId: number;
    name: string;
    memberCount: number;
    maxMemberCount: number;
  } | null,
  groupError: false,
}));
vi.mock('../src/renderer/src/components/qq-actions/shared', () => ({
  withQQAccountScope: (component: unknown) => component,
}));
vi.mock('../src/renderer/src/hooks/useQQWriteSession', () => ({
  useQQWriteSession: () => ({
    available: state.available,
    binding: { expectedAccountUin: '10001', expectedAccountConfigId: 'source-a' },
  }),
}));
vi.mock('../src/renderer/src/trpc/client', () => ({
  trpc: {
    account: {
      qqActions: {
        groupJoinSettings: {
          useQuery: (...args: unknown[]) => {
            state.groupQuery(...args);
            return { data: state.groupData, error: state.groupError, isFetching: false };
          },
        },
      },
      qqWrite: {
        friendClue: {
          useQuery: (...args: unknown[]) => {
            state.query(...args);
            return {
              data: state.data,
              error: state.error ? new Error('失败') : null,
              isFetching: state.fetching,
            };
          },
        },
      },
    },
  },
}));

function render(known = false) {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  const conversation = sharedGroupConversation({ code: '12345', name: '旧缓存群名', avatar: '' });
  conversation.group.memberCount = 23;
  conversation.group.announcement = '真实群公告';
  const update = (uid = 'u_peer') =>
    act(() =>
      root.render(
        h(
          ConversationDirectoryContext.Provider,
          {
            value: {
              real: known ? [conversation] : [],
              virtual: [],
              onVirtual: vi.fn(),
              onCreate: vi.fn(),
            },
          },
          h(FriendClue, { uid }),
        ),
      ),
    );
  update();
  return {
    host,
    update,
    close: () => {
      act(() => root.unmount());
      host.remove();
    },
  };
}
function data(): Clue & { uid: string } {
  return {
    uid: 'u_peer',
    targetUin: '10002',
    addedAt: 1704038400,
    direction: 'outgoing',
    rawDirection: 2,
    source: '线索接口返回的群名',
    sourceGroupCode: '12345',
    canOpenSourceGroup: true,
    verificationMessage: '你好\n问题1:名字',
  };
}
afterEach(() => {
  state.available = true;
  state.fetching = false;
  state.error = false;
  state.data = null;
  state.groupData = { groupId: 12345, name: '接口真实群名', memberCount: 23, maxMemberCount: 200 };
  state.groupError = false;
  vi.clearAllMocks();
  vi.unstubAllGlobals();
});

it.each([true, false])(
  '来源名称严格使用线索接口原文，点开后才读取真实群名片（本地收录 %s）',
  (known) => {
    state.data = data();
    const f = render(known);
    try {
      expect(f.host.textContent).toContain('添加时间2024/01/01');
      expect(f.host.textContent).toContain('我添加对方');
      expect(f.host.textContent).toContain('线索接口返回的群名');
      expect(f.host.textContent).not.toContain('接口真实群名');
      expect(f.host.textContent).not.toContain('旧缓存群名');
      expect(state.groupQuery.mock.calls.at(-1)?.[1]).toMatchObject({ enabled: false });
      expect(f.host.textContent).not.toContain('来源群号');
      const source = f.host.querySelector<HTMLButtonElement>('[aria-label="查看来源群名片"]')!;
      expect(source.querySelector('img')?.src).toContain('12345');
      act(() => source.click());
      expect(state.groupQuery.mock.calls.at(-1)?.[1]).toMatchObject({ enabled: true });
      const dialog = document.querySelector('[aria-label="群资料"]')!;
      expect(dialog.querySelector('.weq-profile-name')?.textContent).toBe('接口真实群名');
      expect(dialog.textContent).toContain('12345');
      expect(dialog.textContent).not.toContain('旧缓存群名');
      expect(source.textContent).toBe('线索接口返回的群名');
      if (known) {
        expect(dialog.textContent).toContain('真实群公告');
        expect(dialog.textContent).toContain('23');
      } else {
        expect(dialog.querySelector('.weq-profile-members')?.textContent).toContain('23');
        expect(dialog.querySelector('.weq-profile-list')).toBeNull();
      }
      act(() => dialog.querySelector<HTMLButtonElement>('[aria-label="关闭"]')!.click());
      expect(document.querySelector('[aria-label="群资料"]')).toBeNull();
      expect(f.host.textContent).toContain('你好\n问题1:名字');
      expect(f.host.querySelector('[aria-label="重新读取好友线索"]')).toBeNull();
      expect(state.query.mock.calls.at(-1)?.[1]).toMatchObject({ retry: 2, retryDelay: 1000 });
    } finally {
      f.close();
    }
  },
);
it('非群来源保留接口原文，不查询群资料', () => {
  state.data = { ...data(), source: '通过 QQ 号搜索', sourceGroupCode: null };
  const f = render();
  try {
    expect(f.host.textContent).toContain('通过 QQ 号搜索');
    expect(state.groupQuery).not.toHaveBeenCalled();
  } finally {
    f.close();
  }
});
it('线索接口缺失来源时显示未知，不用群资料或本地群名替换', () => {
  state.data = { ...data(), source: null };
  const f = render(true);
  try {
    expect(f.host.querySelector('.weq-friend-source-group')?.textContent).toBe('未知');
    expect(state.groupQuery.mock.calls.at(-1)?.[1]).toMatchObject({ enabled: false });
  } finally {
    f.close();
  }
});
it('群资料失败或返回其他群时不展示错误群名，切换好友关闭已打开名片', () => {
  state.data = data();
  state.groupData = { ...state.groupData!, groupId: 99999, name: '错误群名' };
  const f = render();
  try {
    expect(f.host.textContent).not.toContain('错误群名');
    expect(f.host.textContent).toContain('线索接口返回的群名');
    state.groupData = { ...state.groupData!, groupId: 12345 };
    state.groupError = true;
    f.update();
    expect(f.host.textContent).not.toContain('错误群名');
    expect(f.host.textContent).toContain('线索接口返回的群名');
    state.groupError = false;
    state.groupData.name = '接口真实群名';
    f.update();
    act(() => f.host.querySelector<HTMLButtonElement>('[aria-label="查看来源群名片"]')!.click());
    f.update('u_other');
    expect(document.querySelector('[aria-label="群资料"]')).toBeNull();
  } finally {
    f.close();
  }
});
it('未知不冒称被动添加，显式空验证显示无消息', () => {
  state.data = {
    ...data(),
    addedAt: null,
    direction: null,
    rawDirection: 9,
    source: null,
    verificationMessage: '',
  };
  const f = render();
  try {
    expect(f.host.textContent).not.toContain('对方添加我');
    expect(f.host.textContent).toContain('添加方向未知');
    expect(f.host.textContent).toContain('无验证消息');
  } finally {
    f.close();
  }
});
it('离线、失败、读取中不展示旧结果，无刷新按钮，失败使用有界自动重试', () => {
  state.data = data();
  state.available = false;
  const f = render();
  try {
    expect(f.host.textContent).toContain('暂不可读取');
    expect(f.host.textContent).not.toContain('线索接口返回的群名');
    expect(f.host.querySelector('button')).toBeNull();
    expect(state.query.mock.calls.at(-1)?.[1]).toMatchObject({
      enabled: false,
      retry: 2,
      retryDelay: 1000,
      refetchOnWindowFocus: false,
    });
    state.available = true;
    state.error = true;
    f.update();
    expect(f.host.textContent).toContain('读取失败');
    expect(f.host.textContent).not.toContain('线索接口返回的群名');
    state.data = null;
    state.error = false;
    state.fetching = true;
    f.update();
    expect(f.host.textContent).toContain('读取中');
    expect(f.host.querySelector('button')).toBeNull();
  } finally {
    f.close();
  }
});
it('切换目标不显示上一个 UID 的数据', () => {
  state.data = data();
  const f = render();
  try {
    f.update('u_other');
    expect(f.host.textContent).not.toContain('线索接口返回的群名');
    expect(state.query.mock.calls.at(-1)?.[0]).toMatchObject({ uid: 'u_other' });
  } finally {
    f.close();
  }
});

it('导出真实资料行排版夹具用于深浅色及窄屏核验', () => {
  const output = process.env.WEQ_FRIEND_CLUE_QA;
  if (!output) return;
  mkdirSync(output, { recursive: true });
  const styles = ['index.css', 'appearance.css', 'contact-profile.css', 'friend-clue.css']
    .map((file) => readFileSync(resolve('src/renderer/src/styles', file), 'utf8'))
    .join('\n');
  for (const mode of ['normal', 'long', 'unknown', 'error']) {
    state.groupData = {
      groupId: 12345,
      name: mode === 'long' ? '接口返回的超长真实群名称'.repeat(12) : '接口真实群名',
      memberCount: 23,
      maxMemberCount: 200,
    };
    state.data = {
      ...data(),
      ...(mode === 'long'
        ? {
            source: '通过共同群聊添加'.repeat(12),
            verificationMessage:
              '问题1:请填写申请原因\n回答:'.repeat(20) + 'long_verification_message_'.repeat(30),
          }
        : {}),
      ...(mode === 'unknown'
        ? {
            addedAt: null,
            direction: null,
            source: null,
            sourceGroupCode: null,
            verificationMessage: null,
          }
        : {}),
    };
    state.error = mode === 'error';
    const f = render();
    try {
      act(() => f.host.querySelector('img')?.dispatchEvent(new Event('error')));
      writeFileSync(
        resolve(output, `${mode}.html`),
        `<!doctype html><html data-theme="light"><meta name="viewport" content="width=device-width,initial-scale=1"><meta charset="utf-8"><style>${styles}</style><style>*,*::before,*::after{box-sizing:border-box}body{margin:0;padding:16px;background:var(--weq-chat-bg);font-family:system-ui}.weq-contact-profile-content{max-width:440px;margin:auto;background:var(--weq-bg-surface);padding:16px}</style><body><section class="weq-contact-profile-content">${f.host.innerHTML}</section></body></html>`,
      );
    } finally {
      f.close();
    }
  }
});
