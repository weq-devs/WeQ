import { act, createElement as h, type ReactNode } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { TitleBar } from '../src/renderer/src/im-template/template/TitleBar';
import type { User } from '../src/renderer/src/im-template/template/types';

const state = vi.hoisted(() => ({
  status: { uid: 'u_self', type: 10, typeName: '在线', subType: 0, displayStatus: '在线' } as {
    uid: string;
    type: number;
    typeName: string;
    subType: number;
    displayStatus: string;
  } | null,
  query: vi.fn(),
}));
vi.mock('../src/renderer/src/components/Dialog', () => ({
  Modal: ({ children }: { children: ReactNode }) => children,
}));
vi.mock('../src/renderer/src/components/settings/SelfQQControls', () => ({
  SelfQQControls: () => null,
}));
vi.mock('../src/renderer/src/trpc/client', () => ({
  trpc: {
    account: {
      getOnlineStatus: {
        useQuery: (input: unknown, options: unknown) => {
          state.query(input, options);
          return { data: state.status };
        },
      },
    },
  },
}));
let cleanup = () => {};
function fixture() {
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  const user: User = {
    id: 'self',
    uid: 'u_self',
    identityLabel: 'UIN',
    identityValue: '10001',
    username: '自己',
    displayName: '昵称',
    avatarUrl: null,
    signature: '个性签名',
  };
  const render = () => act(() => root.render(h(TitleBar, { user: { ...user } })));
  cleanup = () => {
    act(() => root.unmount());
    host.remove();
  };
  render();
  return { host, user, render };
}
beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  state.status = { uid: 'u_self', type: 10, typeName: '在线', subType: 0, displayStatus: '在线' };
  state.query.mockClear();
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('标题栏在线状态', () => {
  it('在昵称与签名之间显示本人状态，并定期刷新本地记录', () => {
    const f = fixture();
    const nick = f.host.querySelector('.app-title-bar-nick')!;
    expect(nick.nextElementSibling?.classList.contains('weq-title-online-status')).toBe(true);
    expect(nick.nextElementSibling?.textContent).toBe('在线');
    expect(nick.nextElementSibling?.nextElementSibling?.textContent).toBe('个性签名');
    expect(state.query).toHaveBeenCalledWith(
      { uid: 'u_self' },
      expect.objectContaining({ refetchInterval: 15_000, refetchOnMount: 'always' }),
    );
  });
  it('扩展状态沿用现有图标和完整文案，更新后同步显示', () => {
    const f = fixture();
    state.status = {
      uid: 'u_self',
      type: 10,
      typeName: '在线',
      subType: 1018,
      displayStatus: '在线 - 学习中',
    };
    f.render();
    expect(f.host.querySelector('.weq-title-online-status img')?.getAttribute('src')).toContain(
      'study_3x.png',
    );
    expect(f.host.querySelector('.weq-title-online-status')?.getAttribute('title')).toBe(
      '在线 - 学习中',
    );
    state.status = { uid: 'u_self', type: 70, typeName: '勿扰', subType: 0, displayStatus: '勿扰' };
    f.render();
    expect(f.host.querySelector('.weq-title-online-status')?.textContent).toBe('勿扰');
  });
  it('缺失、未知或属于其他账号的状态不冒充本人在线，未加载 UID 不查询', () => {
    const f = fixture();
    for (const status of [
      null,
      { uid: 'u_other', type: 10, typeName: '在线', subType: 0, displayStatus: '在线' },
      { uid: 'u_self', type: 999, typeName: '未知', subType: 0, displayStatus: '未知' },
    ]) {
      state.status = status;
      f.render();
      expect(f.host.querySelector('.weq-title-online-status')).toBeNull();
    }
    state.query.mockClear();
    f.user.uid = undefined;
    f.render();
    expect(state.query).not.toHaveBeenCalled();
  });
});
