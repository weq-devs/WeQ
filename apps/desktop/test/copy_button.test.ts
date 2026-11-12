import { act, createElement as h } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CopyButton } from '../src/renderer/src/components/CopyButton';
import { useToast } from '../src/renderer/src/components/Toast';
import { ContactRow } from '../src/renderer/src/components/contactProfile/ContactRow';

let close = () => {};
const writeText = vi.fn(async (_text: string) => {});
beforeEach(() => {
  vi.useFakeTimers();
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  vi.stubGlobal('navigator', { clipboard: { writeText } });
  vi.spyOn(window.navigator.clipboard, 'writeText').mockImplementation(writeText);
  useToast.setState({ toasts: [], leaving: [], seq: 0 });
});
afterEach(() => {
  close();
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  writeText.mockReset();
  Reflect.deleteProperty(document, 'execCommand');
});
function mount(text = 'u_fixture') {
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  const render = (value: string) =>
    act(() => root.render(h(CopyButton, { text: value }, '复制 UID')));
  render(text);
  close = () => {
    act(() => root.unmount());
    host.remove();
  };
  return { host, render, click: () => act(async () => host.querySelector('button')!.click()) };
}

describe('统一复制反馈', () => {
  it('等待写入成功后提示，并自动退场；连续点击重新计时', async () => {
    let resolve!: () => void;
    writeText.mockImplementationOnce(() => new Promise<void>((done) => (resolve = done)));
    const f = mount();
    await f.click();
    expect(f.host.querySelector('[role="status"]')).toBeNull();
    await act(async () => resolve());
    expect(f.host.querySelector('[role="status"]')?.textContent).toBe('已复制');
    expect(writeText).toHaveBeenCalledWith('u_fixture');
    act(() => vi.advanceTimersByTime(1200));
    await f.click();
    act(() => vi.advanceTimersByTime(1200));
    expect(f.host.querySelector('[role="status"]')).not.toBeNull();
    act(() => vi.advanceTimersByTime(600));
    expect(f.host.querySelector('[role="status"]')).toBeNull();
  });

  it('写入失败或内容为空不提示成功', async () => {
    writeText.mockRejectedValue(new Error('blocked'));
    const f = mount();
    await f.click();
    expect(f.host.querySelector('[role="status"]')).toBeNull();
    expect(useToast.getState().toasts.at(-1)?.title).toBe('复制失败');
    f.render('');
    await f.click();
    expect(writeText).toHaveBeenCalledTimes(1);
    expect(f.host.querySelector('[role="status"]')).toBeNull();
  });

  it('原生复制回退成功也提示，后一次失败不沿用成功提示', async () => {
    const exec = vi.fn(() => true);
    Object.defineProperty(document, 'execCommand', { value: exec, configurable: true });
    const f = mount();
    await f.click();
    expect(exec).toHaveBeenCalledWith('copy');
    expect(writeText).not.toHaveBeenCalled();
    expect(document.querySelector('textarea')).toBeNull();
    expect(f.host.querySelector('[role="status"]')?.textContent).toBe('已复制');
    exec.mockReturnValue(false);
    writeText.mockRejectedValueOnce(new Error('blocked'));
    await f.click();
    expect(f.host.querySelector('[role="status"]')).toBeNull();
  });

  it('NT UID、邮箱等可复制资料行接入同一提示', async () => {
    const host = document.createElement('div');
    document.body.append(host);
    const root = createRoot(host);
    close = () => {
      act(() => root.unmount());
      host.remove();
    };
    act(() =>
      root.render(h(ContactRow, { label: 'NT UID', value: 'u_fixture', copyValue: 'u_fixture' })),
    );
    await act(async () => host.querySelector('button')!.click());
    expect(writeText).toHaveBeenCalledWith('u_fixture');
    expect(host.querySelector('[role="status"]')?.textContent).toBe('已复制');
  });

  it('内容变化清理旧提示，卸载后不更新反馈', async () => {
    const f = mount();
    await f.click();
    f.render('different');
    expect(f.host.querySelector('[role="status"]')).toBeNull();
    let resolve!: () => void;
    writeText.mockImplementationOnce(() => new Promise<void>((done) => (resolve = done)));
    await f.click();
    close();
    close = () => {};
    await act(async () => resolve());
    expect(vi.getTimerCount()).toBe(0);
  });
});
