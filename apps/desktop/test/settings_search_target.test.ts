import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  findSettingElement,
  revealSetting,
} from '../src/renderer/src/components/settings/searchTarget';

afterEach(() => {
  document.body.replaceChildren();
  vi.unstubAllGlobals();
});

describe('稳定设置项定位', () => {
  it('稳定 ID 优先于重名或旧标签，展开包含它的折叠区域但不触发操作', () => {
    const root = document.createElement('div');
    const wrong = document.createElement('h3');
    wrong.textContent = '旧标签';
    const outer = document.createElement('details');
    const inner = document.createElement('details');
    const entry = document.createElement('button');
    entry.dataset.settingId = 'fixture-option';
    entry.textContent = '新标签';
    entry.onclick = vi.fn();
    inner.append(entry);
    outer.append(inner);
    root.append(wrong, outer);
    document.body.append(root);
    const target = { item: '旧标签', settingId: 'fixture-option' };
    expect(findSettingElement(root, target)).toBe(entry);
    const cleanup = revealSetting(root, target);
    expect(outer.open).toBe(true);
    expect(inner.open).toBe(true);
    expect(document.activeElement).toBe(entry);
    expect(entry.onclick).not.toHaveBeenCalled();
    cleanup();
    expect(entry.hasAttribute('data-search-highlight')).toBe(false);
    expect(entry.hasAttribute('tabindex')).toBe(false);
  });

  it('条件不可用时定位带原因的摘要，后续异步变化不会把焦点抢走', async () => {
    const root = document.createElement('div');
    document.body.append(root);
    const cleanup = revealSetting(root, { settingId: 'conditional-option' });
    const summary = document.createElement('p');
    summary.dataset.settingId = 'conditional-option';
    summary.textContent = '当前来源不可用';
    root.append(summary);
    await new Promise<void>((resolve) => queueMicrotask(resolve));
    expect(summary.dataset.searchHighlight).toBe('true');
    const other = document.createElement('button');
    root.append(other);
    other.focus();
    summary.textContent = '状态已更新';
    await new Promise<void>((resolve) => queueMicrotask(resolve));
    expect(document.activeElement).toBe(other);
    cleanup();
  });
  it('禁用入口高亮不执行，焦点落到可用的所在行并恢复临时 tabindex', () => {
    const root = document.createElement('div'),
      row = document.createElement('div'),
      button = document.createElement('button');
    row.className = 'weq-set-row';
    button.disabled = true;
    button.dataset.settingId = 'disabled-action';
    button.onclick = vi.fn();
    row.append(button);
    root.append(row);
    document.body.append(root);
    const cleanup = revealSetting(root, { settingId: 'disabled-action' });
    expect(document.activeElement).toBe(row);
    expect(button.dataset.searchHighlight).toBe('true');
    expect(button.onclick).not.toHaveBeenCalled();
    cleanup();
    expect(row.hasAttribute('tabindex')).toBe(false);
  });
  it('按钮内的稳定标签定位到按钮本身，保留原键盘顺序且不激活', () => {
    const root = document.createElement('div'),
      button = document.createElement('button'),
      label = document.createElement('span');
    button.tabIndex = 0;
    button.onclick = vi.fn();
    label.dataset.settingId = 'button-label';
    button.append(label);
    root.append(button);
    document.body.append(root);
    const cleanup = revealSetting(root, { settingId: 'button-label' });
    expect(document.activeElement).toBe(button);
    expect(button.tabIndex).toBe(0);
    expect(button.onclick).not.toHaveBeenCalled();
    button.tabIndex = -1;
    cleanup();
    expect(button.tabIndex).toBe(-1);
    expect(label.hasAttribute('tabindex')).toBe(false);
  });
});
