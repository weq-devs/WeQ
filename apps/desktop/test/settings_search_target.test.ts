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
});
