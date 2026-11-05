import { act, createElement as h } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, expect, it, vi } from 'vitest';
import { FriendClue } from '../src/renderer/src/components/qq-actions/FriendClue';
import type { FriendClue as Clue } from '@weq/protocol';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

const state = vi.hoisted(() => ({
  available: true,
  fetching: false,
  error: false,
  data: null as (Clue & { uid: string }) | null,
  query: vi.fn(),
  refetch: vi.fn(),
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
      qqWrite: {
        friendClue: {
          useQuery: (...args: unknown[]) => {
            state.query(...args);
            return {
              data: state.data,
              error: state.error ? new Error('失败') : null,
              isFetching: state.fetching,
              refetch: state.refetch,
            };
          },
        },
      },
    },
  },
}));

function render() {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  const update = (uid = 'u_peer') => act(() => root.render(h(FriendClue, { uid })));
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
    source: '通过群聊',
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
  vi.clearAllMocks();
  vi.unstubAllGlobals();
});

it('展示北京时间日期、方向、来源群号及完整验证消息，刷新按钮可重读', () => {
  state.data = data();
  const f = render();
  try {
    expect(f.host.textContent).toContain('添加时间2024/01/01');
    expect(f.host.textContent).toContain('我添加对方');
    expect(f.host.textContent).toContain('通过群聊');
    expect(f.host.textContent).toContain('来源群号12345');
    expect(f.host.textContent).toContain('你好\n问题1:名字');
    act(() => f.host.querySelector<HTMLButtonElement>('button')!.click());
    expect(state.refetch).toHaveBeenCalledOnce();
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
it('离线、失败、读取中不展示旧结果，离线和在途禁用刷新', () => {
  state.data = data();
  state.available = false;
  const f = render();
  try {
    expect(f.host.textContent).toContain('暂不可读取');
    expect(f.host.textContent).not.toContain('通过群聊');
    expect(f.host.querySelector('button')!.disabled).toBe(true);
    expect(state.query.mock.calls.at(-1)?.[1]).toMatchObject({
      enabled: false,
      retry: false,
      refetchOnWindowFocus: false,
    });
    state.available = true;
    state.error = true;
    f.update();
    expect(f.host.textContent).toContain('读取失败');
    expect(f.host.textContent).not.toContain('通过群聊');
    state.data = null;
    state.error = false;
    state.fetching = true;
    f.update();
    expect(f.host.textContent).toContain('读取中');
    expect(f.host.querySelector('button')!.disabled).toBe(true);
  } finally {
    f.close();
  }
});
it('切换目标不显示上一个 UID 的数据', () => {
  state.data = data();
  const f = render();
  try {
    f.update('u_other');
    expect(f.host.textContent).not.toContain('通过群聊');
    expect(state.query.mock.calls.at(-1)?.[0]).toMatchObject({ uid: 'u_other' });
  } finally {
    f.close();
  }
});

it('导出真实资料行排版夹具用于深浅色及窄屏核验', () => {
  const output = process.env.WEQ_FRIEND_CLUE_QA;
  if (!output) return;
  mkdirSync(output, { recursive: true });
  const styles = ['index.css', 'appearance.css', 'contact-profile.css']
    .map((file) => readFileSync(resolve('src/renderer/src/styles', file), 'utf8'))
    .join('\n');
  for (const mode of ['normal', 'long', 'unknown', 'error']) {
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
        ? { addedAt: null, direction: null, source: null, verificationMessage: null }
        : {}),
    };
    state.error = mode === 'error';
    const f = render();
    try {
      writeFileSync(
        resolve(output, `${mode}.html`),
        `<!doctype html><html data-theme="light"><meta name="viewport" content="width=device-width,initial-scale=1"><meta charset="utf-8"><style>${styles}</style><style>*,*::before,*::after{box-sizing:border-box}body{margin:0;padding:16px;background:var(--weq-chat-bg);font-family:system-ui}.weq-contact-profile-content{max-width:440px;margin:auto;background:var(--weq-bg-surface);padding:16px}</style><body><section class="weq-contact-profile-content">${f.host.innerHTML}</section></body></html>`,
      );
    } finally {
      f.close();
    }
  }
});
