/**
 * 两个「用户手输 URL 规范化」函数的单测 —— sse_push 的推送地址与 rkey_server
 * 的 NapCat 地址。用户输入五花八门（缺协议 / 尾斜杠 / 带路径带 hash），规范化
 * 是这两个功能的入口第一道防线，值得钉死。
 */

import { describe, expect, it } from 'vitest';
import { normalizeSsePushUrl } from '../src/account/sse_push';
import { normalizeNapcatBaseUrl } from '../src/account/rkey_server';

describe('normalizeSsePushUrl', () => {
  it('补协议 + 去尾斜杠', () => {
    expect(normalizeSsePushUrl('example.com/hook')).toBe('http://example.com/hook');
    expect(normalizeSsePushUrl('https://example.com/')).toBe('https://example.com');
  });

  it('去 hash，保留 query 与 path', () => {
    expect(normalizeSsePushUrl('http://a.com/p?x=1#frag')).toBe('http://a.com/p?x=1');
  });

  it.each([
    ['空串', ''],
    ['纯空白', '   '],
    ['ftp 协议', 'ftp://a.com'],
    ['垃圾', ':::'],
  ])('%s → 空串', (_label, input) => {
    expect(normalizeSsePushUrl(input)).toBe('');
  });
});

describe('normalizeNapcatBaseUrl', () => {
  it('剥掉结尾的 /get_rkey_server（带或不带斜杠）', () => {
    expect(normalizeNapcatBaseUrl('http://a.com/get_rkey_server')).toBe('http://a.com');
    expect(normalizeNapcatBaseUrl('http://a.com/get_rkey_server/')).toBe('http://a.com');
  });

  it('补协议 + 去尾斜杠 + 去首尾空白', () => {
    expect(normalizeNapcatBaseUrl('  a.com  ')).toBe('http://a.com');
    expect(normalizeNapcatBaseUrl('http://a.com/')).toBe('http://a.com');
  });

  it('保留非端点路径', () => {
    expect(normalizeNapcatBaseUrl('http://a.com/api')).toBe('http://a.com/api');
  });

  it('空串 → 空串', () => {
    expect(normalizeNapcatBaseUrl('')).toBe('');
  });
});
