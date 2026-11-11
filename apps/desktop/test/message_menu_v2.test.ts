import { act, createElement, type ComponentProps } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { MessageContextMenu } from '../src/renderer/src/im-template/template/messageContextMenu';
import { createTemplateDemoData } from './support/templateDemoData';
import { QQWriteResult } from '../src/renderer/src/components/QQWriteControls';
import {
  messageMediaKey,
  messageMediaTarget,
  messageMediaSaveSource,
} from '../src/renderer/src/lib/messageMediaTarget';
import {
  quickReactions,
  DEFAULT_REACTIONS,
  reactionItems,
} from '../src/renderer/src/lib/reactionItems';

const message = {
  ...createTemplateDemoData().messages[0]!,
  qqElements: [{ type: 'text', data: { textContent: '**hello**' } }],
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
async function render(props: Partial<ComponentProps<typeof MessageContextMenu>> = {}) {
  await act(async () =>
    root.render(
      createElement(MessageContextMenu, {
        state: { message, x: 10, y: 10 },
        onCopy: vi.fn(),
        ...props,
      }),
    ),
  );
}
const slot = (name: string) =>
  createElement('button', { type: 'button', title: name }, createElement('span', null, name));
const labels = (selector: string) =>
  [...host.querySelectorAll<HTMLButtonElement>(`${selector} button`)]
    .filter(
      (button) =>
        !button.classList.contains('message-action-fallback') ||
        !button.closest('.message-action-slot')?.querySelector('.message-action-content button'),
    )
    .filter((button) => {
      const file = button.closest('.message-file-action');
      if (!file) return true;
      const reveal = file.querySelector<HTMLButtonElement>('.message-reveal-action button');
      return reveal && (!reveal.disabled || !file.hasAttribute('data-has-save'))
        ? button === reveal
        : !button.closest('.message-reveal-action');
    })
    .map((button) => button.getAttribute('aria-label') || button.textContent);

it('文字主菜单顺序固定，扩展动作位于指定三行', async () => {
  await render({
    onForward: vi.fn(),
    onMultiSelect: vi.fn(),
    onReply: vi.fn(),
    onRepeat: vi.fn(),
    onRecall: vi.fn(),
    essenceAction: slot('设为精华'),
    todoAction: slot('设为群待办'),
    onAddToComposition: vi.fn(),
    onExport: vi.fn(),
    intentAction: slot('意图感知'),
    state: { message: { ...message, decoration: { bubbleId: 1 } }, x: 10, y: 10 },
    onViewDecoration: vi.fn(),
    revealAction: slot('在文件夹中显示'),
    onEditRaw: vi.fn(),
    onDelete: vi.fn(),
    onSaveMedia: vi.fn(),
  });
  expect(labels('.message-menu-main')).toEqual(['复制', '转发', '多选', '引用']);
  const rows = [...host.querySelectorAll('.message-action-row')];
  expect(rows).toHaveLength(3);
  expect(labels('.message-action-row')).toEqual([
    '+1',
    '撤回',
    '设为精华',
    '设为群待办',
    '添加到素材库',
    '导出',
    '意图感知',
    '查看装扮',
    '显示原文',
    '在文件夹中显示',
    '修改本地记录',
    '本地删除',
  ]);
  expect(document.activeElement?.textContent).toBe('复制');
});

it('文字直接显示切换，不打开内容子菜单；禁用与批量文案保留', async () => {
  const recall = vi.fn();
  await render({
    favoriteEmojiAction: slot('添加到表情'),
    onRecall: recall,
    recallCount: 3,
    recallBlockedReason: '正在处理',
    onExport: vi.fn(),
    exportLabel: '导出所选消息',
  });
  expect(labels('.message-action-row')).toContain('显示原文');
  expect(host.querySelector('[data-submenu-panel]')).toBeNull();
  expect(labels('.message-action-row')).not.toContain('添加到表情');
  const button = host.querySelector<HTMLButtonElement>('[aria-label="撤回所选 3 条消息"]')!;
  expect(button.disabled).toBe(true);
  expect(button.title).toBe('正在处理');
});

it('缺失动作与异步返回空内容均保留固定格位并禁用，不挤占相邻操作', async () => {
  const Empty = () => null;
  await render({ essenceAction: createElement(Empty), todoAction: createElement(Empty) });
  expect(labels('.message-menu-main')).toHaveLength(4);
  expect(labels('.message-action-row')).toHaveLength(12);
  for (const label of [
    '转发',
    '多选',
    '引用',
    '+1',
    '撤回',
    '设为精华',
    '设为群待办',
    '导出',
    '意图感知',
    '查看装扮',
    '另存为',
    '修改本地记录',
    '本地删除',
  ]) {
    expect(host.querySelector<HTMLButtonElement>(`[aria-label="${label}"]`)?.disabled).toBe(true);
  }
});

it('文件保存为直达动作，Esc 直接关闭菜单', async () => {
  const save = vi.fn();
  const close = vi.fn();
  await render({ onSaveMedia: save, onClose: close });
  act(() => host.querySelector<HTMLButtonElement>('[aria-label="另存为"]')!.click());
  expect(save).toHaveBeenCalledOnce();
  act(() =>
    host
      .querySelector('.message-menu-primary')!
      .dispatchEvent(new KeyboardEvent('keydown', { bubbles: true, key: 'Escape' })),
  );
  expect(close).toHaveBeenCalledOnce();
});

it('文件下载后同一格从另存为切换为定位，文件消失后恢复保存', async () => {
  const save = vi.fn();
  await render({
    onSaveMedia: save,
    revealAction: createElement('button', { disabled: true }, '在文件夹中显示'),
  });
  expect(labels('.message-action-row')).toContain('另存为');
  expect(labels('.message-action-row')).not.toContain('在文件夹中显示');
  await render({
    onSaveMedia: save,
    revealAction: createElement('button', null, '在文件夹中显示'),
  });
  expect(labels('.message-action-row')).toContain('在文件夹中显示');
  expect(labels('.message-action-row')).not.toContain('另存为');
  await render({ onSaveMedia: save, revealAction: null });
  expect(labels('.message-action-row')).toContain('另存为');
  expect(labels('.message-action-row')).toHaveLength(12);
});

it('混合消息按右键命中的媒体选择内容操作，不强制将整条消息当成纯文本', async () => {
  const mixed = {
    ...message,
    qqElements: [
      ...message.qqElements,
      { type: 'pic', data: { fileName: 'one.png' } },
      { type: 'ptt', data: { fileName: 'voice.amr', pttTranscript: '已转写' } },
    ],
  };
  const target = messageMediaTarget(mixed)!;
  await render({
    state: { message: mixed, x: 10, y: 10, mediaTarget: target },
    favoriteEmojiAction: slot('添加到表情'),
  });
  expect(labels('.message-action-row')).toContain('添加到表情');
  const element = document.createElement('span');
  element.dataset.messageMediaKey = messageMediaKey(mixed.qqElements[2]!);
  await render({
    state: { message: mixed, x: 10, y: 10, mediaTarget: messageMediaTarget(mixed, element) },
  });
  expect(labels('.message-action-row')).toContain('转换为文字');
  expect(labels('.message-action-row')).not.toContain('添加到表情');
});

it('方向键在三行按钮间移动，Esc 关闭并归还焦点', async () => {
  const close = vi.fn();
  const origin = document.createElement('button');
  document.body.append(origin);
  await render({
    state: { message, x: 10, y: 10, originElement: origin },
    onForward: vi.fn(),
    onMultiSelect: vi.fn(),
    onReply: vi.fn(),
    onRepeat: vi.fn(),
    onRecall: vi.fn(),
    onAddToComposition: vi.fn(),
    onExport: vi.fn(),
    onClose: close,
  });
  const press = (key: string) =>
    act(() =>
      document.activeElement?.dispatchEvent(new KeyboardEvent('keydown', { bubbles: true, key })),
    );
  press('ArrowRight');
  expect(document.activeElement?.textContent).toBe('转发');
  press('ArrowDown');
  expect(document.activeElement?.textContent).toBe('引用');
  press('ArrowLeft');
  expect(document.activeElement?.textContent).toBe('多选');
  press('ArrowDown');
  expect(document.activeElement?.getAttribute('aria-label')).toBe('+1');
  press('ArrowRight');
  expect(document.activeElement?.getAttribute('aria-label')).toBe('撤回');
  press('ArrowDown');
  expect(document.activeElement?.getAttribute('aria-label')).toBe('导出');
  press('Escape');
  expect(close).toHaveBeenCalledOnce();
  expect(document.activeElement).toBe(origin);
  origin.remove();
});

it('快捷回应显示选中态，再次点击发出取消，更多仍可进入', async () => {
  const set = vi.fn(),
    more = vi.fn();
  await render({
    state: {
      message: { ...message, setEmojiList: [{ emojiId: '76', isSelfSet: true, setNum: 1 }] },
      x: 10,
      y: 10,
    },
    onReact: more,
    onSetReaction: set,
  });
  const selected = host.querySelector<HTMLButtonElement>('[aria-pressed="true"]')!;
  expect(host.querySelectorAll('.message-reaction-strip button[aria-pressed]')).toHaveLength(4);
  expect(host.querySelectorAll('.message-reaction-strip button')).toHaveLength(5);
  act(() => selected.click());
  expect(set.mock.calls[0]?.slice(1)).toEqual(['76', false]);
  act(() => host.querySelector<HTMLButtonElement>('[aria-label="更多表情"]')!.click());
  expect(more).toHaveBeenCalledOnce();
});

it('媒体显式命中优先，无命中回退第一项，文件保存保持原有定位参数', () => {
  const first = { type: 'pic', data: { fileName: 'one.png', fileToken: 'one' } };
  const second = { type: 'file', data: { fileName: 'two.zip', fileToken: 'two' } };
  const row = { ...message, msgId: '123', qqElements: [first, second] };
  const element = document.createElement('span');
  element.dataset.messageMediaKey = messageMediaKey(second);
  expect(messageMediaTarget(row)?.name).toBe('one.png');
  const target = messageMediaTarget(row, element)!;
  expect(target.name).toBe('two.zip');
  expect(messageMediaSaveSource(target)).toEqual({
    kind: 'chat-file',
    msgId: '123',
    name: 'two.zip',
    token: 'two',
    conv: message.conversationId,
  });
  expect(target.favoriteUrl).toBeUndefined();
});

it('最近回应去重排序且默认补齐；字符表情保留 Unicode 类型', () => {
  const catalog = reactionItems([
    { unicode: true, items: [{ id: 'laugh', desc: '笑', glyph: '😀' }] },
  ]);
  const quick = quickReactions([catalog[0]!.code, '76', '76', 'invalid'], catalog);
  expect(quick).toHaveLength(6);
  expect(quick[0]?.item.glyph).toBe('😀');
  expect(new Set(quick.map((item) => item.code)).size).toBe(6);
  expect(quickReactions([], [])).toEqual(DEFAULT_REACTIONS);
});

it('操作结果保留在菜单内，但不占用图标网格', async () => {
  await render({
    essenceAction: createElement(QQWriteResult, { result: { text: '合成失败原因', error: true } }),
  });
  expect(host.querySelector('.message-menu-feedback [role="alert"]')?.textContent).toBe(
    '合成失败原因',
  );
  expect(host.querySelector('.message-action-row [role="alert"]')).toBeNull();
});
