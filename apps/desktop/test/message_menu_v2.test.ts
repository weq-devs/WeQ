import { act, createElement, type ComponentProps } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { MessageContextMenu } from '../src/renderer/src/im-template/template/messageContextMenu';
import { createTemplateDemoData } from '../src/renderer/src/im-template/template/demoData';
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
function render(props: Partial<ComponentProps<typeof MessageContextMenu>> = {}) {
  act(() =>
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
  [...host.querySelectorAll<HTMLButtonElement>(`${selector} button`)].map(
    (button) => button.getAttribute('aria-label') || button.textContent,
  );

it('文字主菜单顺序固定，扩展动作位于指定三行', () => {
  render({
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
  const names = (row: Element) =>
    [...row.querySelectorAll('button')].map(
      (button) => button.getAttribute('aria-label') || button.textContent,
    );
  expect(names(rows[0]!)).toEqual(['另存为']);
  expect(names(rows[1]!)).toEqual(['+1', '撤回', '设为精华', '设为群待办']);
  expect(names(rows[2]!)).toEqual(['添加到素材库', '导出', '意图感知', '查看装扮']);
  expect(names(rows[3]!)).toEqual(['显示原文', '在文件夹中显示', '修改本地记录', '本地删除']);
  expect(document.activeElement?.textContent).toBe('复制');
});

it('添加到表情占用显示切换位置；禁用与批量文案保留', () => {
  const recall = vi.fn();
  render({
    favoriteEmojiAction: slot('添加到表情'),
    onRecall: recall,
    recallCount: 3,
    recallBlockedReason: '正在处理',
    onExport: vi.fn(),
    exportLabel: '导出所选消息',
  });
  expect(labels('.message-action-row')).not.toContain('显示 Markdown');
  expect(labels('.message-action-row')).toContain('添加到表情');
  const button = host.querySelector<HTMLButtonElement>('[aria-label="撤回所选 3 条消息"]')!;
  expect(button.disabled).toBe(true);
  expect(button.title).toBe('正在处理');
});

it('方向键在三行按钮间移动，Esc 关闭并归还焦点', () => {
  const close = vi.fn();
  const origin = document.createElement('button');
  document.body.append(origin);
  render({
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

it('快捷回应显示选中态，再次点击发出取消，更多仍可进入', () => {
  const set = vi.fn(),
    more = vi.fn();
  render({
    state: {
      message: { ...message, setEmojiList: [{ emojiId: '76', isSelfSet: true, setNum: 1 }] },
      x: 10,
      y: 10,
    },
    onReact: more,
    onSetReaction: set,
  });
  const selected = host.querySelector<HTMLButtonElement>('[aria-pressed="true"]')!;
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

it('操作结果保留在菜单内，但不占用图标网格', () => {
  render({
    essenceAction: createElement(QQWriteResult, { result: { text: '合成失败原因', error: true } }),
  });
  expect(host.querySelector('.message-menu-feedback [role="alert"]')?.textContent).toBe(
    '合成失败原因',
  );
  expect(host.querySelector('.message-action-row [role="alert"]')).toBeNull();
});
