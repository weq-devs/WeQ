import { act, createElement } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createTemplateDemoData } from '../src/renderer/src/im-template/template/demoData';
import { messageFavoriteEmojiUrl } from '../src/renderer/src/lib/messageFavoriteEmoji';
import { MessageFavoriteEmojiAction } from '../src/renderer/src/components/qq-actions/MessageFavoriteEmojiAction';
import type { Message } from '../src/renderer/src/im-template/template/types';

const state = vi.hoisted(() => ({
  disabled: false,
  pending: false,
  perform: vi.fn(),
  mutate: vi.fn(),
  query: vi.fn(),
  favorites: vi.fn(),
  overview: vi.fn(),
}));
const binding = { expectedAccountUin: '10001', expectedAccountConfigId: 'source-a' };
vi.mock('../src/renderer/src/components/qq-actions/shared', () => ({
  useQQAction: () => ({
    available: !state.disabled,
    disabled: state.disabled || state.pending,
    pending: state.pending,
    binding: { expectedAccountUin: '10001', expectedAccountConfigId: 'source-a' },
    perform: state.perform,
  }),
}));
vi.mock('../src/renderer/src/trpc/client', () => ({
  client: {
    account: {
      qqActions: {
        favoriteFromMedia: { mutate: state.mutate },
        favoriteIds: { query: state.query },
      },
    },
  },
  trpc: {
    useUtils: () => ({
      account: {
        qqActions: { favorites: { invalidate: state.favorites } },
        emojiPanel: { overview: { invalidate: state.overview } },
      },
    }),
  },
}));
const base = createTemplateDemoData().messages[0]!;
const picture = (name: string, subType = 1) => ({
  type: 'pic',
  data: { fileName: name, fileToken: `token-${name}`, subType },
});
afterEach(() => {
  vi.resetAllMocks();
  vi.unstubAllGlobals();
  state.disabled = state.pending = false;
});

describe('添加到表情目标', () => {
  it.each([0, 1])('单张 pic subType=%s 的空白／键盘入口使用原媒体协议', (subType) => {
    const url = messageFavoriteEmojiUrl({ ...base, qqElements: [picture('a.gif', subType)] });
    expect(url).toContain('pic?');
    expect(url).toContain(`recv=${subType}`);
    expect(url).not.toContain('thumb');
  });

  it('多图消息精确选择第二张；不从当前预览 src 推断原件', () => {
    const message = { ...base, qqElements: [picture('a.gif'), picture('b.gif')] };
    const wrap = document.createElement('span');
    wrap.dataset.favoriteEmojiSource = 'weq-media://pic?name=b.gif';
    const img = document.createElement('img');
    img.src = 'https://example.com/thumbnail.png';
    wrap.append(img);
    expect(messageFavoriteEmojiUrl(message, img)).toBe(wrap.dataset.favoriteEmojiSource);
    expect(messageFavoriteEmojiUrl(message)).toBeUndefined();
  });

  it('商城表情使用 pack/hash，右键角标也命中同一表情', () => {
    const message = {
      ...base,
      qqElements: [{ type: 'mface', data: { emojiPackId: 1, marketEmoticonIdHex: 'abc' } }],
    };
    expect(messageFavoriteEmojiUrl(message)).toContain('mface?pack=1&hash=abc');
    const wrap = document.createElement('button');
    wrap.dataset.favoriteEmojiSource = 'weq-media://mface?pack=1&hash=abc';
    const badge = document.createElement('span');
    wrap.append(badge);
    expect(messageFavoriteEmojiUrl(message, badge)).toBe(wrap.dataset.favoriteEmojiSource);
  });

  it.each([
    [{ type: 'face', data: { faceId: 1 } }],
    [{ type: 'text', data: { textContent: '正文' } }],
    [{ type: 'pic', data: { isFlash: true } }],
    [{ type: 'pic', data: { fileToken: '/old-flash-token' } }],
  ])('系统表情、文本、闪照不提供入口', (...qqElements) => {
    expect(messageFavoriteEmojiUrl({ ...base, qqElements } as Message)).toBeUndefined();
  });

  it('点击内联小表情不能误收藏旁边的图片', () => {
    expect(
      messageFavoriteEmojiUrl(
        { ...base, qqElements: [picture('a.gif')] },
        document.createElement('img'),
      ),
    ).toBeUndefined();
  });
});

describe('添加到表情按钮', () => {
  it('绑定账号提交、精确读回 ID 并刷新列表；失败不关闭菜单', async () => {
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    const host = document.createElement('div');
    const root = createRoot(host);
    const close = vi.fn();
    const url = 'weq-media://pic?token=a';
    state.mutate.mockResolvedValue({ state: 'accepted', emojiId: 'expected-id' });
    state.query.mockResolvedValue(['unrelated-id']);
    state.perform.mockImplementation(async (write, refresh, _warning, options) => {
      await write(binding);
      expect(await options.readback()).toBe(false);
      state.query.mockResolvedValue(['expected-id']);
      expect(await options.readback()).toBe(true);
      expect(options.readbackSuccessText).toBe('已添加到表情');
      await refresh();
      return true;
    });
    try {
      await act(async () =>
        root.render(createElement(MessageFavoriteEmojiAction, { url, onClose: close })),
      );
      await act(async () => host.querySelector('button')!.click());
      expect(state.mutate).toHaveBeenCalledWith({ ...binding, url });
      expect(state.favorites).toHaveBeenCalledOnce();
      expect(state.overview).toHaveBeenCalledOnce();
      expect(close).toHaveBeenCalledOnce();
      state.perform.mockResolvedValue(false);
      await act(async () => host.querySelector('button')!.click());
      expect(close).toHaveBeenCalledOnce();
      state.disabled = true;
      await act(async () =>
        root.render(createElement(MessageFavoriteEmojiAction, { url, onClose: close })),
      );
      expect(host.querySelector('button')!.disabled).toBe(true);
      expect(host.querySelector('button')!.title).toContain('QQ 在线');
      state.disabled = false;
      state.pending = true;
      await act(async () =>
        root.render(createElement(MessageFavoriteEmojiAction, { url, onClose: close })),
      );
      expect(host.querySelector('button')!.disabled).toBe(true);
      expect(host.textContent).toBe('添加到表情');
      expect(host.querySelector('button')!.getAttribute('aria-busy')).toBe('true');
    } finally {
      await act(async () => root.unmount());
    }
  });
});
