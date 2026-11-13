import { afterEach, describe, expect, it, vi } from 'vitest';
import { openLink, soleLink, splitLinks } from '../src/renderer/src/lib/linkify';

const links = (text: string) => splitLinks(text).filter((part) => part.kind === 'link');

afterEach(() => vi.restoreAllMocks());

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
  it('普通链接交给系统浏览器，非 HTTP(S) 不打开', () => {
    const open = vi.spyOn(window, 'open').mockReturnValue(null);
    expect(openLink('https://h3cof6.com')).toBe(true);
    expect(open).toHaveBeenCalledWith('https://h3cof6.com/', '_blank', 'noopener,noreferrer');
    for (const url of [
      'file:///tmp/test',
      'javascript:alert(1)',
      'mailto:a@example.com',
      'not a url',
    ])
      expect(openLink(url)).toBe(false);
    expect(open).toHaveBeenCalledTimes(1);
  });

  it('安装包与压缩包继续确认，取消时不打开', () => {
    const open = vi.spyOn(window, 'open').mockReturnValue(null);
    const confirm = vi.spyOn(window, 'confirm').mockReturnValue(false);
    expect(openLink('https://example.com/weq.zip')).toBe(false);
    expect(confirm).toHaveBeenCalledOnce();
    expect(open).not.toHaveBeenCalled();
    confirm.mockReturnValue(true);
    expect(openLink('https://example.com/weq.exe')).toBe(true);
    expect(open).toHaveBeenCalledOnce();
  });
});
