import { describe, expect, it, vi } from 'vitest';
import {
  MobileBackStack,
  shouldCompleteMobileSwipe,
} from '../src/renderer/src/lib/mobileNavigation';

describe('移动导航层级', () => {
  it('弹层优先，其次设置分类、工作区页面，最后会话父页面；一次只退一层', () => {
    const stack = new MobileBackStack();
    const calls: string[] = [];
    for (const [id, priority] of [
      ['category', 30],
      ['page', 20],
      ['chat', 10],
      ['dialog', 100],
    ] as const) {
      stack.register({ id, priority, back: () => calls.push(id) });
    }
    expect(stack.back()).toBe(true);
    expect(calls).toEqual(['dialog']);
    expect(stack.size).toBe(3);
    while (stack.back()) {}
    expect(calls).toEqual(['dialog', 'category', 'page', 'chat']);
  });

  it('多级详情按进入顺序逐级恢复，切换根标签后不再返回旧详情', () => {
    const stack = new MobileBackStack();
    let page = '消息';
    for (const next of ['聊天', '资料', '群资料']) {
      const previous = page;
      stack.register({
        id: next,
        priority: 10,
        back: () => {
          page = previous;
        },
      });
      page = next;
    }
    stack.back();
    expect(page).toBe('资料');
    stack.back();
    expect(page).toBe('聊天');
    stack.clear();
    expect(stack.back()).toBe(false);
    expect(stack.size).toBe(0);
  });

  it('草稿确认尚未关闭页面时，保留返回入口；取消后仍能再次返回', () => {
    const stack = new MobileBackStack();
    const confirm = vi.fn();
    const remove = stack.register({ id: 'settings', priority: 20, retained: true, back: confirm });
    stack.back();
    expect(stack.size).toBe(1);
    stack.back();
    expect(confirm).toHaveBeenCalledTimes(2);
    remove();
    expect(stack.back()).toBe(false);
  });

  it('页面替换登记不重复，卸载只移除自己的层', () => {
    const stack = new MobileBackStack();
    stack.register({ id: 'page', priority: 20, back: vi.fn() });
    stack.register({ id: 'page', priority: 20, back: vi.fn() });
    const remove = stack.register({ id: 'dialog', priority: 100, back: vi.fn() });
    expect(stack.size).toBe(2);
    remove();
    expect(stack.top?.id).toBe('page');
  });
});

it.each([
  [15, 100, 390, false],
  [50, 500, 390, false],
  [120, 500, 390, true],
  [50, 80, 390, true],
  [100, 500, 320, true],
])('侧滑位移 %s、耗时 %s、屏宽 %s 时是否返回：%s', (distance, elapsed, width, expected) => {
  expect(shouldCompleteMobileSwipe(distance as number, elapsed as number, width as number)).toBe(
    expected,
  );
});
