import { act, createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { createRoot } from 'react-dom/client';
import { describe, expect, it, vi } from 'vitest';
import { MessageBubble } from '../src/renderer/src/im-template/template/messageBubble';
import { createTemplateDemoData } from '../src/renderer/src/im-template/template/demoData';
import { AvatarOrb } from '../src/renderer/src/components/dressPieces';
import { cachedAvatarUrl, refreshAvatarUrl } from '../src/renderer/src/lib/avatarCache';
import { setPreferCdnFlag } from '../src/renderer/src/lib/cdn';

vi.mock('../src/renderer/src/trpc/client', () => {
  const proxy = (): unknown =>
    new Proxy(() => undefined, {
      get: (_target, key) => {
        if (key === 'useQuery') return () => ({ data: undefined, isLoading: false });
        if (key === 'useMutation') return () => ({ mutate: () => undefined, isLoading: false });
        return proxy();
      },
    });
  return { trpc: proxy(), client: proxy() };
});

describe('主页头像', () => {
  it('CDN 直连模式按 reload 复核且释放自己创建的 Blob URL', async () => {
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    const fetch = vi.fn(
      async () => new Response('synthetic-image', { headers: { 'Content-Type': 'image/png' } }),
    );
    vi.stubGlobal('fetch', fetch);
    vi.spyOn(URL, 'createObjectURL').mockReturnValue('blob:synthetic-refresh');
    const revoke = vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => {});
    setPreferCdnFlag(true);
    const host = document.createElement('div');
    document.body.append(host);
    const root = createRoot(host);
    try {
      await act(async () => {
        root.render(
          createElement(AvatarOrb, {
            avatarUrl: 'https://thirdqq.qlogo.cn/g?nk=10001&s=0',
            nickname: '测试用户',
            widgetUrl: '',
            refreshOnFocus: true,
          }),
        );
      });
      expect(fetch).toHaveBeenCalledWith(
        'https://thirdqq.qlogo.cn/g?nk=10001&s=0',
        expect.objectContaining({ cache: 'reload' }),
      );
      expect(host.querySelector('img')?.src).toBe('blob:synthetic-refresh');
      await act(async () => {
        root.unmount();
      });
      expect(revoke).toHaveBeenCalledWith('blob:synthetic-refresh');
    } finally {
      await act(async () => {
        root.unmount();
      });
      host.remove();
      setPreferCdnFlag(false);
      vi.restoreAllMocks();
      vi.unstubAllGlobals();
    }
  });
  it('刷新只改变桥 URL，不污染 CDN 来源、data URL 或缓存身份', () => {
    const source = 'https://thirdqq.qlogo.cn/g?b=sdk&s=0&nk=10001';
    const wrapped = cachedAvatarUrl(source)!;
    expect(new URL(refreshAvatarUrl(wrapped, 2)!).searchParams.get('fb')).toBe(source);
    expect(refreshAvatarUrl('data:image/png;base64,test', 2)).toBe('data:image/png;base64,test');
    expect(refreshAvatarUrl('/_media/avatar?uin=10001', 2)).toContain('_weq_avatar_refresh=2');
  });
  it('与其余头像共用本地优先链路，不直接固定在 CDN 缓存', () => {
    const url = 'https://thirdqq.qlogo.cn/g?b=sdk&s=0&nk=10001';
    const html = renderToStaticMarkup(
      createElement(AvatarOrb, { avatarUrl: url, nickname: '测试用户', widgetUrl: '' }),
    );
    const doc = new DOMParser().parseFromString(html, 'text/html');
    expect(doc.querySelector('.weq-orb-img')?.getAttribute('src')).toBe(cachedAvatarUrl(url));
  });
  it('主页重新聚焦后重读头像桥，失败可恢复，换账号后不残留旧头像', async () => {
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    const host = document.createElement('div');
    document.body.append(host);
    const root = createRoot(host);
    const props = {
      avatarUrl: 'https://thirdqq.qlogo.cn/g?nk=10001&s=0',
      nickname: '测试用户',
      widgetUrl: '',
      refreshOnFocus: true,
    };
    try {
      await act(async () => {
        root.render(createElement(AvatarOrb, props));
      });
      const first = host.querySelector('img')!.src;
      await act(async () => {
        host.querySelector('img')!.dispatchEvent(new Event('error'));
      });
      expect(host.querySelector('.weq-orb-fallback')).not.toBeNull();
      await act(async () => {
        window.dispatchEvent(new Event('focus'));
      });
      expect(host.querySelector('img')!.src).not.toBe(first);
      await act(async () => {
        root.render(
          createElement(AvatarOrb, {
            ...props,
            avatarUrl: 'https://thirdqq.qlogo.cn/g?nk=10002&s=0',
          }),
        );
      });
      expect(new URL(host.querySelector('img')!.src).searchParams.get('uin')).toBe('10002');
    } finally {
      await act(async () => {
        root.unmount();
      });
      host.remove();
      vi.unstubAllGlobals();
    }
  });
});

describe('发送状态', () => {
  const demo = createTemplateDemoData();
  const conversation = demo.conversations.find((item) => item.type === 'group')!;
  function bubble(
    state: 'sending' | 'sent' | 'failed',
    rejected = false,
    onDismissUnsent?: () => void,
  ) {
    return renderToStaticMarkup(
      createElement(MessageBubble, {
        message: {
          ...demo.messages[0]!,
          optimistic: state,
          optimisticRejected: rejected,
        },
        conversation,
        sender: demo.user,
        mine: true,
        senderName: '测试用户',
        onContextMenu: () => {},
        onLongPress: () => {},
        ...(onDismissUnsent ? { onDismissUnsent } : {}),
      }),
    );
  }
  it('正常已发送不再显示下方状态', () => {
    expect(bubble('sent')).not.toContain('已发送');
    expect(bubble('sent')).not.toContain('weq-msg-optimistic-tag');
  });
  it('发送中只在消息旁显示转圈，不占下方一行', () => {
    expect(bubble('sending')).toContain('weq-message-sending');
    expect(bubble('sending')).not.toContain('weq-msg-optimistic-tag');
  });
  it('失败和疑似静默拒收仍保留下方提示', () => {
    expect(bubble('failed')).toContain('发送失败');
    expect(bubble('sent', true)).toContain('可能未送达');
  });
  it('未送达占位在状态条旁给出一键移除按钮', () => {
    const html = bubble('sent', true, () => {});
    expect(html).toContain('weq-msg-dismiss-unsent');
    expect(html).toContain('移除');
  });
  it('只有未送达占位才有移除按钮：失败占位与正常已发送都没有', () => {
    expect(bubble('failed', false, () => {})).not.toContain('weq-msg-dismiss-unsent');
    expect(bubble('sent', false, () => {})).not.toContain('weq-msg-dismiss-unsent');
    // 宿主没接这个回调时（只读视图）不渲染按钮，避免点了没反应。
    expect(bubble('sent', true)).not.toContain('weq-msg-dismiss-unsent');
  });
});
