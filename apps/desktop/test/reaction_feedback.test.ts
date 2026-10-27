import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { SetEmojiReactions } from '../src/renderer/src/components/SetEmojiReactions';
import type { ReactionInteraction } from '../src/renderer/src/components/SetEmojiReactions';

vi.mock('../src/renderer/src/components/FaceEmoji', () => ({
  FaceEmoji: () => createElement('span', { className: 'face-emoji' }),
}));

const list = [
  { emojiId: '14', setNum: 12, isSelfSet: true },
  { emojiId: '76', setNum: 2, isSelfSet: false },
];

function render(pending?: ReactionInteraction['pending']) {
  return new DOMParser().parseFromString(
    renderToStaticMarkup(
      createElement(SetEmojiReactions, {
        list,
        groupId: '12345',
        sequence: 42,
        interaction: { onChange: vi.fn(), busy: Boolean(pending), pending },
      }),
    ),
    'text/html',
  );
}

describe('贴表情请求反馈', () => {
  it.each([
    { code: '76', isSet: true, label: '正在贴表情' },
    { code: '14', isSet: false, label: '正在撤回表情回应' },
  ])('仅在目标表情的数字处显示 $label', ({ code, isSet, label }) => {
    const doc = render({ code, isSet });
    const pending = doc.querySelector('button[aria-busy="true"]');
    expect(pending?.getAttribute('aria-label')).toBe(`${label} ${code}`);
    expect(pending?.querySelector('.msg-reaction-count [role="status"]')).not.toBeNull();
    expect(doc.querySelectorAll('.msg-reaction-count [role="status"]')).toHaveLength(1);
    expect(doc.querySelectorAll('button:disabled')).toHaveLength(2);
    expect(doc.querySelector('.msg-reaction-count-value')?.textContent).toBe('12');
  });

  it('首次贴的新表情显示临时加载项，不篡改原始列表', () => {
    const doc = render({ code: '99', isSet: true });
    expect(doc.querySelectorAll('.msg-reaction')).toHaveLength(3);
    expect(
      doc.querySelector('[aria-busy="true"] .msg-reaction-count [role="status"]'),
    ).not.toBeNull();
    expect(doc.querySelector('[aria-busy="true"]')?.classList.contains('is-self')).toBe(false);
    expect(list).toHaveLength(2);
  });

  it('没有既有回应时也能显示首次贴表情的加载反馈', () => {
    const html = renderToStaticMarkup(
      createElement(SetEmojiReactions, {
        list: [],
        groupId: '12345',
        sequence: 42,
        interaction: { onChange: vi.fn(), busy: true, pending: { code: '99', isSet: true } },
      }),
    );
    expect(html).toContain('正在贴表情 99');
  });

  it('请求结束恢复数字，移除临时项与加载状态', () => {
    const doc = render();
    expect(doc.querySelector('[aria-busy="true"]')).toBeNull();
    expect(doc.querySelectorAll('.msg-reaction')).toHaveLength(2);
    expect(doc.querySelector('.msg-reaction-count')?.textContent).toBe('12');
    expect(doc.querySelector('button:disabled')).toBeNull();
  });

  it('同步期间读回空列表，撤回目标及其他已有表情仍留在原位', () => {
    const html = renderToStaticMarkup(
      createElement(SetEmojiReactions, {
        list: [],
        groupId: '12345',
        sequence: 42,
        interaction: {
          onChange: vi.fn(),
          busy: true,
          pending: { code: '14', isSet: false, snapshot: list },
        },
      }),
    );
    const doc = new DOMParser().parseFromString(html, 'text/html');
    expect(doc.querySelectorAll('.msg-reaction')).toHaveLength(2);
    expect(doc.querySelector('[aria-busy="true"]')?.getAttribute('aria-label')).toBe(
      '正在撤回表情回应 14',
    );
  });

  it('可导出离线反馈样本供浏览器核对布局', () => {
    const output = process.env.WEQ_REACTION_FEEDBACK_DIR;
    if (!output) return;
    const css = [
      'src/renderer/src/styles/index.css',
      'src/renderer/src/im-template/styles/emoji.css',
      'src/renderer/src/styles/message-metadata.css',
      'src/renderer/src/styles/reaction-feedback.css',
    ]
      .map((file) => readFileSync(resolve(file), 'utf8'))
      .join('\n');
    const samples = [
      undefined,
      { code: '76', isSet: true },
      { code: '14', isSet: false },
      { code: '99', isSet: true },
    ];
    const html = samples
      .map((pending) => `<section>${render(pending).body.innerHTML}</section>`)
      .join('');
    mkdirSync(output, { recursive: true });
    writeFileSync(
      resolve(output, 'feedback.html'),
      `<!doctype html><html lang="zh-CN" data-theme="light"><meta charset="utf-8"><style>${css}</style><style>body{padding:24px;background:var(--weq-chat-bg,var(--background));color:var(--foreground);font-family:system-ui}section{margin-bottom:24px}.face-emoji{display:inline-block;background:var(--weq-accent-effective);border-radius:50%}</style><body>${html}</body></html>`,
    );
  });
});
