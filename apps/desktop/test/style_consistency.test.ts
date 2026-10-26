import { createElement as h } from 'react';
import { readFileSync } from 'node:fs';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import { QqArk } from '../src/renderer/src/components/ark/QqArk';
import { GrayTipXmlMessage } from '../src/renderer/src/components/GrayTipXmlMessage';
import { GrayTipFileRecvMessage } from '../src/renderer/src/components/GrayTipFileRecvMessage';
import { GrayTipTempSessionMessage } from '../src/renderer/src/components/GrayTipTempSessionMessage';

vi.mock('../src/renderer/src/trpc/client', () => ({
  client: {},
  trpc: { account: { listAllGroups: { useQuery: () => ({ data: [] }) } } },
}));

function ark(app: string, view: string, payload: Record<string, unknown>) {
  const host = document.createElement('div');
  host.innerHTML = renderToStaticMarkup(h(QqArk, { arkData: { app, meta: { [view]: payload } } }));
  return host;
}

describe('消息内容的主题一致性', () => {
  it('共享样式不再引用未定义的旧表面和辅助文字变量', () => {
    const css = readFileSync('src/renderer/src/styles/index.css', 'utf8');
    expect(css).not.toMatch(/--weq-(?:bg-secondary|bg-tertiary|fg-tertiary)\b/);
  });

  it.each([undefined, '#000000', '#ffffff', '#ff0000'])(
    '安全提醒的原始颜色 %s 不覆盖正文主题色',
    (color) => {
      const host = ark('com.tencent.security.message', 'message', {
        title: '合成提醒',
        details: [{ detail_title1: '合成标签', detail_content1: '合成详情', detail_color1: color }],
      });
      const detail = [...host.querySelectorAll('div')].find(
        (node) => node.textContent === '合成详情',
      );
      expect(detail?.getAttribute('style')).toContain('color:var(--weq-fg-primary)');
      expect(host.textContent).toContain('合成标签');
    },
  );

  it.each([
    [
      'com.tencent.template.public',
      'plainText',
      { operations: [{ label1: '打开', jumpUrl1: 'https://example.invalid/' }] },
    ],
    [
      'com.tencent.public.subscribe.standard',
      'message',
      { operationText1: '打开', operationJump1: 'https://example.invalid/' },
    ],
    [
      'com.tencent.security.message',
      'message',
      { links: [{ link_title1: '打开', link_url1: 'https://example.invalid/' }] },
    ],
  ] as const)('%s / %s 的操作和分隔线不保留固定浅色', (app, view, payload) => {
    const host = ark(app, view, payload);
    const action = [...host.querySelectorAll('div')].find(
      (node) => node.textContent === '打开' && node.style.cursor === 'pointer',
    );
    expect(action?.getAttribute('style')).toContain('var(--weq-accent-ink');
    expect(action?.parentElement?.getAttribute('style')).toContain('var(--weq-border-subtle)');
  });

  it('XML、文件及临时会话灰条共用强调色类，原文不变', () => {
    for (const html of [
      renderToStaticMarkup(
        h(GrayTipXmlMessage, {
          element: {
            type: 'grayTipXml',
            data: { grayTipXmlContent: '<gtip><url txt="合成链接"/></gtip>' },
          },
        }),
      ),
      renderToStaticMarkup(
        h(GrayTipFileRecvMessage, {
          element: { type: 'grayTipFileRecv', data: { fileName: '合成文件.txt', fileSize: 1024 } },
        }),
      ),
      renderToStaticMarkup(
        h(GrayTipTempSessionMessage, {
          element: { type: 'grayTipTempSession', data: { tempSessionGroupCode: '123456' } },
        }),
      ),
    ]) {
      const host = document.createElement('div');
      host.innerHTML = html;
      expect(host.querySelector('.weq-graytip-accent')).not.toBeNull();
      expect(host.querySelector('.text-blue-500, .text-gray-500')).toBeNull();
      expect(host.textContent?.length).toBeGreaterThan(0);
    }
  });
});
