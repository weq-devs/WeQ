import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { openLink, soleLink, splitLinks } from '../src/renderer/src/lib/linkify';
import { renderDefaultMessageContent } from '../src/renderer/src/im-template/template/messageRenderers';

const target = vi.hoisted(() => ({ web: true, external: vi.fn() }));
vi.mock('../src/renderer/src/lib/target.shared', () => ({
  get IS_WEB() {
    return target.web;
  },
}));
vi.mock('../src/renderer/src/trpc/client', () => ({
  client: { help: { openExternal: { mutate: target.external } } },
}));

const links = (text: string) => splitLinks(text).filter((part) => part.kind === 'link');

beforeEach(() => {
  target.web = true;
  target.external.mockReset().mockResolvedValue({ ok: true });
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('聊天链接识别', () => {
  it('识别裸域名、子域名、路径、查询与片段，原文不变并补 HTTPS', () => {
    const text = 'h3cof6.com sub.h3cof6.com/path?q=weq#chat';
    expect(links(text)).toEqual([
      { kind: 'link', text: 'h3cof6.com', href: 'https://h3cof6.com' },
      {
        kind: 'link',
        text: 'sub.h3cof6.com/path?q=weq#chat',
        href: 'https://sub.h3cof6.com/path?q=weq#chat',
      },
    ]);
    expect(
      splitLinks(text)
        .map((part) => part.text)
        .join(''),
    ).toBe(text);
  });

  it('保留完整 HTTP(S) 与 www 地址，支持短域名与大写写法', () => {
    expect(links('http://whatisthis.h3cof6.com HTTPS://EXAMPLE.COM www.h3cof6.com a.cn')).toEqual([
      { kind: 'link', text: 'http://whatisthis.h3cof6.com', href: 'http://whatisthis.h3cof6.com' },
      { kind: 'link', text: 'HTTPS://EXAMPLE.COM', href: 'HTTPS://EXAMPLE.COM' },
      { kind: 'link', text: 'www.h3cof6.com', href: 'https://www.h3cof6.com' },
      { kind: 'link', text: 'a.cn', href: 'https://a.cn' },
    ]);
  });

  it('中文标点和引号留在链接外，保留 URL 中成对的括号', () => {
    const text = '看这里：h3cof6.com，或“example.com/path”。(https://example.com/wiki/WeQ_(app))';
    expect(links(text).map((part) => part.text)).toEqual([
      'h3cof6.com',
      'example.com/path',
      'https://example.com/wiki/WeQ_(app)',
    ]);
    expect(
      splitLinks(text)
        .map((part) => part.text)
        .join(''),
    ).toBe(text);
  });

  it.each([
    '',
    '没有链接',
    'user@h3cof6.com',
    'mailto:user@h3cof6.com',
    '2.7.0 v2.7.0 192.168.1.1',
    'main.ts package.json report.pdf image.png README.md',
    'foo_example.com example.com_suffix example.comx',
    'ftp://example.com/file file://example.com/path javascript:example.com',
    '//example.com/path',
  ])('不把邮件、版本、文件名或非 HTTP 协议识别成链接：%s', (text) => {
    expect(links(text)).toEqual([]);
    expect(
      splitLinks(text)
        .map((part) => part.text)
        .join(''),
    ).toBe(text);
  });

  it('soleLink 复用裸域名规则，只接受整段恰好一条链接', () => {
    expect(soleLink(' h3cof6.com/path ')).toBe('https://h3cof6.com/path');
    expect(soleLink('看 h3cof6.com')).toBeNull();
    expect(soleLink('h3cof6.com example.com')).toBeNull();
    expect(soleLink('user@example.com')).toBeNull();
    expect(soleLink('')).toBeNull();
  });
});

describe('聊天链接打开', () => {
  it('Web 链接立即在当前设备打开，非 HTTP(S) 不打开', async () => {
    const open = vi.spyOn(window, 'open').mockReturnValue(null);
    const opened = openLink('https://h3cof6.com');
    expect(open).toHaveBeenCalledWith('https://h3cof6.com/', '_blank', 'noopener,noreferrer');
    expect(await opened).toBe(true);
    for (const url of [
      'file:///tmp/test',
      'javascript:alert(1)',
      'mailto:a@example.com',
      'not a url',
    ])
      expect(await openLink(url)).toBe(false);
    expect(open).toHaveBeenCalledTimes(1);
    expect(target.external).not.toHaveBeenCalled();
  });

  it('桌面端通过已有宿主入口打开，不依赖新窗口', async () => {
    target.web = false;
    const open = vi.spyOn(window, 'open');
    expect(await openLink('https://example.com/path')).toBe(true);
    expect(target.external).toHaveBeenCalledWith({ url: 'https://example.com/path' });
    expect(open).not.toHaveBeenCalled();
    target.external.mockResolvedValueOnce({ ok: false, error: '无法打开浏览器' });
    expect(await openLink('https://example.com/path')).toBe(false);
    target.external.mockRejectedValueOnce(new Error('宿主不可用'));
    expect(await openLink('https://example.com/path')).toBe(false);
  });

  it('安装包与压缩包继续确认，取消时不打开', async () => {
    const open = vi.spyOn(window, 'open').mockReturnValue(null);
    const confirm = vi.spyOn(window, 'confirm').mockReturnValue(false);
    expect(await openLink('https://example.com/weq.zip')).toBe(false);
    expect(confirm).toHaveBeenCalledOnce();
    expect(open).not.toHaveBeenCalled();
    confirm.mockReturnValue(true);
    expect(await openLink('https://example.com/weq.exe')).toBe(true);
    expect(open).toHaveBeenCalledOnce();
  });

  it('文件名含无效百分号编码时仍可确认打开', async () => {
    vi.spyOn(window, 'open').mockReturnValue(null);
    vi.spyOn(window, 'confirm').mockReturnValue(true);
    expect(await openLink('https://example.com/100%.zip')).toBe(true);
  });

  it('没有 QQ 元素的普通消息保留正文和换行，点击裸域名可打开', async () => {
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    const open = vi.spyOn(window, 'open').mockReturnValue(null);
    const host = document.createElement('div');
    document.body.append(host);
    const root = createRoot(host);
    const body = '看这里：example.com/path，\nhttps://example.org 结束';
    try {
      act(() =>
        root.render(
          renderDefaultMessageContent({
            id: 'plain-link',
            conversationId: 'fixture',
            senderId: 'sender',
            createdAt: '2026-11-17T00:00:00Z',
            body,
          }),
        ),
      );
      expect(host.textContent).toBe(body);
      const link = [...host.querySelectorAll('button')].find(
        (button) => button.textContent === 'example.com/path',
      );
      expect(link).toBeDefined();
      await act(async () => link!.click());
      expect(open).toHaveBeenCalledWith(
        'https://example.com/path',
        '_blank',
        'noopener,noreferrer',
      );
    } finally {
      act(() => root.unmount());
      host.remove();
    }
  });
});
