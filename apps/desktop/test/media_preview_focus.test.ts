import { act, createElement as h } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { Modal } from '../src/renderer/src/components/Dialog';
import { MediaPreviewShell } from '../src/renderer/src/components/MediaPreviewShell';
import { OcrTextPanel } from '../src/renderer/src/components/OcrTextPanel';

let host: HTMLDivElement;
let root: Root;
beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
});
afterEach(() => {
  act(() => root.unmount());
  host.remove();
  vi.unstubAllGlobals();
});

function preview(upper = false) {
  act(() =>
    root.render(
      h(
        MediaPreviewShell,
        {
          title: '合成图片',
          onClose: vi.fn(),
          footer: h('button', { type: 'button', 'aria-label': '复制图片' }, '复制'),
        },
        h(OcrTextPanel, { blocks: [], onExit: vi.fn() }),
        upper &&
          h(
            Modal,
            { onClose: vi.fn() },
            h('button', { type: 'button', 'aria-label': '上层首项' }, '首项'),
            h('button', { type: 'button', 'aria-label': '上层末项' }, '末项'),
          ),
      ),
    ),
  );
}
function button(label: string) {
  return document.querySelector<HTMLButtonElement>(`[aria-label="${label}"]`)!;
}
function tab(shiftKey = false) {
  const event = new KeyboardEvent('keydown', {
    key: 'Tab',
    shiftKey,
    bubbles: true,
    cancelable: true,
  });
  act(() => document.activeElement!.dispatchEvent(event));
  return event;
}

it.each([false, true])('OCR 打开时媒体预览仍循环 Tab，反向：%s', (reverse) => {
  preview();
  act(() => button(reverse ? '关闭预览' : '复制图片').focus());
  expect(tab(reverse).defaultPrevented).toBe(true);
  expect(document.activeElement).toBe(button(reverse ? '复制图片' : '关闭预览'));
});

it('OCR 打开时 Tab 可从背景焦点回到媒体预览', () => {
  preview();
  host.tabIndex = 0;
  act(() => host.focus());
  expect(tab().defaultPrevented).toBe(true);
  expect(document.activeElement).toBe(button('关闭预览'));
});

it.each([false, true])('OCR 上方业务弹窗独立循环 Tab，反向：%s', (reverse) => {
  preview();
  preview(true);
  act(() => button(reverse ? '上层首项' : '上层末项').focus());
  expect(tab(reverse).defaultPrevented).toBe(true);
  expect(document.activeElement).toBe(button(reverse ? '上层末项' : '上层首项'));
});
