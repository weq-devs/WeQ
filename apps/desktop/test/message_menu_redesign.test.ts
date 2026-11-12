import { act, createElement as h } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { MessageContextMenu } from '../src/renderer/src/im-template/template/messageContextMenu';
import { canRepeatMessage, repeatTarget } from '../src/renderer/src/lib/messageRepeat';
import { createTemplateDemoData } from './support/templateDemoData';
import { messageForwardTarget } from '../src/renderer/src/lib/messageForwardTarget';

const message = {
  ...createTemplateDemoData().messages[0]!,
  qqElements: [{ type: 'text', data: { textContent: '完整正文' } }],
};
let host: HTMLDivElement;
let root: ReturnType<typeof createRoot>;
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

it('不适用动作不占位；暂时禁用的动作仍可聚焦且不能执行', async () => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  const repeat = vi.fn();
  await act(async () =>
    root.render(
      h(MessageContextMenu, {
        state: { message, x: 10, y: 10 },
        onCopy: vi.fn(),
        showReactions: false,
        onRepeat: repeat,
        repeatBlockedReason: 'QQ 未在线',
      }),
    ),
  );
  expect(host.querySelector('[aria-label="设为群待办"]')).toBeNull();
  expect(host.querySelector('[aria-label="导出"]')).toBeNull();
  const button = host.querySelector<HTMLButtonElement>('[aria-label="+1"]')!;
  expect(button.disabled).toBe(false);
  expect(button.getAttribute('aria-disabled')).toBe('true');
  button.focus();
  expect(document.activeElement).toBe(button);
  button.click();
  expect(repeat).not.toHaveBeenCalled();
});

it('手动重发保留内容，自动重复提示仍将撤回、删除视为隔断', () => {
  for (const flags of [{ recall: {} }, { deletedKind: 'weq' }, { source: 'roaming' as const }]) {
    const retained = { ...message, ...flags };
    expect(canRepeatMessage(retained)).toBe(true);
    if ('recall' in flags || 'deletedKind' in flags)
      expect(repeatTarget([retained, retained], true)).toBeNull();
  }
  expect(canRepeatMessage({ ...message, optimistic: 'sending' })).toBe(false);
  expect(canRepeatMessage({ ...message, qqElements: [{ type: 'unknown', data: {} }] })).toBe(false);
});

it('混合内容按实际命中的记录或媒体确定导出目标，不猜测多卡消息', () => {
  const mixed = {
    ...message,
    qqElements: [
      { type: 'multiMsg', data: { resId: 'first' } },
      { type: 'pic', data: { fileName: 'image.png' } },
      { type: 'multiMsg', data: { resId: 'second' } },
    ],
  };
  const card = document.createElement('button');
  card.dataset.forwardResId = 'second';
  expect(messageForwardTarget(mixed, card)).toEqual({ elementIndex: 2, resId: 'second' });
  const image = document.createElement('span');
  image.dataset.messageMediaKey = 'image';
  expect(messageForwardTarget(mixed, image)).toBeUndefined();
  expect(messageForwardTarget(mixed)).toBeUndefined();
});

it('另存为与在文件夹中显示同时存在，未适用的装扮入口不出现', async () => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  await act(async () =>
    root.render(
      h(MessageContextMenu, {
        state: { message, x: 10, y: 10 },
        onCopy: vi.fn(),
        onSaveMedia: vi.fn(),
        revealAction: h('button', { type: 'button' }, '在文件夹中显示'),
      }),
    ),
  );
  expect(host.textContent).toContain('在文件夹中显示');
  expect(host.querySelector('.message-save-action button')).not.toBeNull();
  expect(host.querySelector('[aria-label="查看装扮"]')).toBeNull();
});
