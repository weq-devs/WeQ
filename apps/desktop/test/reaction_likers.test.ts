import { act, createElement as h } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { ReactionLikersPanel } from '../src/renderer/src/components/ReactionLikersPanel';
import { ProfileNavigationContext } from '../src/renderer/src/lib/profileNavigation';

const rpc = vi.hoisted(() => ({ query: vi.fn(), next: vi.fn() }));
vi.mock('../src/renderer/src/trpc/client', () => ({
  trpc: {
    account: {
      getSelfProfile: { useQuery: () => ({ data: { uin: '10001' } }) },
      messageReactionUsers: { useInfiniteQuery: rpc.query },
    },
  },
}));
vi.mock('../src/renderer/src/hooks/useAvatarUrl', () => ({ useAvatarUrl: () => null }));

const person = {
  uid: 'u_peer',
  uin: '10001',
  card: '群名片',
  remark: '好友备注',
  nick: '账号昵称',
  avatarUrl: '',
};
const cleanups: Array<() => void> = [];
beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  rpc.query.mockReturnValue({
    data: { pages: [{ items: [person] }] },
    hasNextPage: false,
    fetchNextPage: rpc.next,
  });
});
afterEach(() => {
  for (const cleanup of cleanups.splice(0)) cleanup();
  vi.clearAllMocks();
  vi.unstubAllGlobals();
});

function fixture() {
  const open = vi.fn();
  const close = vi.fn();
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  act(() =>
    root.render(
      h(
        ProfileNavigationContext.Provider,
        { value: open },
        h(ReactionLikersPanel, {
          anchor: { x: 100, y: 100 },
          groupId: '12345',
          sequence: 42,
          emojiId: '76',
          emojiLabel: '赞',
          icon: h('span', null, '赞'),
          setNum: 1,
          onPointerEnter: vi.fn(),
          onPointerLeave: vi.fn(),
          onClose: close,
        }),
      ),
    ),
  );
  cleanups.push(() => {
    act(() => root.unmount());
    host.remove();
  });
  return { panel: document.querySelector<HTMLElement>('.reaction-likers')!, open, close };
}

describe('贴表情名单', () => {
  it('长昵称仍保留独立的头像与 QQ 号', () => {
    const longName = '用于检查窄窗口的很长群名片'.repeat(5);
    rpc.query.mockReturnValue({
      data: { pages: [{ items: [person, { ...person, uin: '10002', card: longName }] }] },
    });
    const { panel } = fixture();
    expect(panel.querySelectorAll('.reaction-likers-name')[1]?.textContent).toBe(longName);
    expect(panel.querySelectorAll('.weq-profile-avatar-button')).toHaveLength(2);
    const output = process.env.WEQ_REACTION_LAYOUT_DIR;
    if (!output) return;
    const css = [
      'src/renderer/src/styles/index.css',
      'src/renderer/src/styles/profile-avatar.css',
      'src/renderer/src/im-template/styles/emoji.css',
    ]
      .map((file) => readFileSync(resolve(file), 'utf8'))
      .join('\n');
    mkdirSync(output, { recursive: true });
    writeFileSync(
      resolve(output, 'reaction-likers.html'),
      `<!doctype html><html lang="zh-CN" data-theme="light"><meta charset="utf-8"><style>${css}</style><style>*,*::before,*::after{box-sizing:border-box}body{font-family:system-ui;background:var(--weq-bg-surface);color:var(--weq-fg-primary)}</style><body>${panel.outerHTML}</body></html>`,
    );
  });

  it.each([
    { fields: {}, expected: '群名片' },
    { fields: { card: '  ' }, expected: '好友备注' },
    { fields: { card: '', remark: '  ' }, expected: '账号昵称' },
    { fields: { card: '', remark: '', nick: '' }, expected: '10001' },
  ])('昵称遵从群内优先级：$expected', ({ fields, expected }) => {
    rpc.query.mockReturnValue({ data: { pages: [{ items: [{ ...person, ...fields }] }] } });
    const { panel } = fixture();
    expect(panel.querySelector('.reaction-likers-name')?.textContent).toBe(expected);
    expect(panel.querySelector('.reaction-likers-row')?.getAttribute('title')).toContain(expected);
    expect(panel.querySelector('.reaction-likers-tag')?.textContent).toBe('我');
  });

  it.each(['u_peer', ''])('头像可查看名片，保留 QQ 号与来源群（UID=%s）', (uid) => {
    rpc.query.mockReturnValue({ data: { pages: [{ items: [{ ...person, uid }] }] } });
    const { panel, open, close } = fixture();
    const button = panel.querySelector<HTMLButtonElement>('[aria-label="查看 群名片 的名片"]')!;
    expect(button).not.toBeNull();
    act(() =>
      button.dispatchEvent(
        new MouseEvent('click', {
          bubbles: true,
          detail: 1,
          clientX: 120,
          clientY: 140,
        }),
      ),
    );
    expect(open).toHaveBeenCalledWith(
      expect.objectContaining({ id: uid, identityValue: '10001', displayName: '群名片' }),
      { x: 120, y: 140 },
      { code: '12345', name: '' },
    );
    expect(close).not.toHaveBeenCalled();
  });

  it('多页按 QQ 号去重且继续分页，非法身份不提供无效名片按钮', () => {
    rpc.query.mockReturnValue({
      data: { pages: [{ items: [person] }, { items: [person, { ...person, uid: '', uin: '0' }] }] },
      hasNextPage: true,
      fetchNextPage: rpc.next,
    });
    const { panel } = fixture();
    expect(panel.querySelectorAll('.reaction-likers-row')).toHaveLength(2);
    expect(panel.querySelectorAll('.weq-profile-avatar-button')).toHaveLength(1);
    act(() =>
      panel
        .querySelector('.reaction-likers-body')!
        .dispatchEvent(new Event('scroll', { bubbles: true })),
    );
    expect(rpc.next).toHaveBeenCalledOnce();
  });
});
