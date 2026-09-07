/**
 * WeQ 助手 ARK 卡片 helper 的离线单测。
 *
 * `buildArkJson` 产出的卡片会被 QQ 渲染层解析 —— coverUrl/url 必须指向
 * `localhost.weixin.qq.com`（QQ 拦 127.0.0.1）；`rewriteArkPort` 负责端口变化
 * （重启后随机端口）时把旧卡片里的 loopback 权威改写过来，兼容旧版
 * `127.0.0.1` 写法。坏输入原样返回，绝不抛 —— 卡片改写失败不该炸消息发送。
 */

import { describe, expect, it } from 'vitest';
import { buildArkJson, rewriteArkPort, type WeqTweetCard } from '../src/account/weq_assistant';

const card: WeqTweetCard = {
  title: '标题',
  contentText: '正文',
  coverPath: '/cover.png',
  pagePath: '/page',
  prompt: 'prompt',
};

describe('buildArkJson', () => {
  it('coverUrl/url 指向 loopback 别名 + 指定端口', () => {
    const ark = JSON.parse(buildArkJson(9123, 1757300000, card)) as {
      meta: { template3: { coverUrl: string; url: string; time: string; title: string } };
      prompt: string;
    };
    expect(ark.meta.template3.coverUrl).toBe('http://localhost.weixin.qq.com:9123/cover.png');
    expect(ark.meta.template3.url).toBe('http://localhost.weixin.qq.com:9123/page');
    expect(ark.meta.template3.time).toBe('1757300000');
    expect(ark.meta.template3.title).toBe('标题');
    expect(ark.prompt).toBe('prompt');
  });

  it('端口 0 也能拼（调用方约束，不在此校验）', () => {
    expect(buildArkJson(0, 1, card)).toContain(':0/');
  });
});

describe('rewriteArkPort', () => {
  it('改写 coverUrl 与 url 的端口', () => {
    const ark = buildArkJson(9123, 0, card);
    const rewritten = JSON.parse(rewriteArkPort(ark, 5555)) as {
      meta: { template3: { coverUrl: string; url: string } };
    };
    expect(rewritten.meta.template3.coverUrl).toBe('http://localhost.weixin.qq.com:5555/cover.png');
    expect(rewritten.meta.template3.url).toBe('http://localhost.weixin.qq.com:5555/page');
  });

  it('旧版 127.0.0.1 写法迁移到 QQ 安全域名', () => {
    const legacy = JSON.stringify({
      meta: {
        template3: { coverUrl: 'http://127.0.0.1:8000/c.png', url: 'http://127.0.0.1:8000/p' },
      },
    });
    const rewritten = JSON.parse(rewriteArkPort(legacy, 6000)) as {
      meta: { template3: { coverUrl: string; url: string } };
    };
    expect(rewritten.meta.template3.coverUrl).toBe('http://localhost.weixin.qq.com:6000/c.png');
    expect(rewritten.meta.template3.url).toBe('http://localhost.weixin.qq.com:6000/p');
  });

  it.each([
    ['非 JSON', 'not json'],
    ['缺 meta', '{"a":1}'],
  ])('%s → 原样返回（不抛）', (_label, junk) => {
    expect(rewriteArkPort(junk, 1234)).toBe(junk);
  });

  it('外部 URL 不被误改', () => {
    const ark = JSON.stringify({
      meta: { template3: { coverUrl: 'https://example.com:9123/x.png' } },
    });
    expect(rewriteArkPort(ark, 5555)).toBe(ark);
  });
});
