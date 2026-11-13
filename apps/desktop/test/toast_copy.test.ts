import { act, createElement } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { version } from '../package.json';
import { ToastHost, useToast } from '../src/renderer/src/components/Toast';

let cleanup = () => {};
let writeText = vi.fn(async (_text: string) => {});

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date('2026-11-13T04:05:06Z'));
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  writeText = vi.fn(async (_text: string) => {});
  vi.spyOn(navigator, 'clipboard', 'get').mockReturnValue({ writeText } as Clipboard);
  useToast.setState({
    toasts: [],
    leaving: [],
    seq: 0,
    durations: { successSeconds: -1, failureSeconds: -1 },
  });
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

function mount() {
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  act(() => root.render(createElement(ToastHost)));
  cleanup = () => {
    act(() => root.unmount());
    host.remove();
  };
  return host;
}

async function copy(host: HTMLElement) {
  const button = host.querySelector<HTMLButtonElement>('.weq-toast-copy');
  expect(button).not.toBeNull();
  await act(async () => button!.click());
  return writeText.mock.calls[0]?.[0] ?? '';
}

describe('横幅复制错误信息', () => {
  it('包含标题、完整详情、发生时间、版本和环境，复制时间不覆盖发生时间', async () => {
    const detail = `E_TIMEOUT\n${'完整错误详情'.repeat(500)}\n    at request (rpc.ts:42)`;
    useToast.getState().push({
      tone: 'error',
      title: '更新群资料失败',
      detail: createElement('pre', null, detail),
    });
    const host = mount();
    expect(host.querySelector('.weq-toast-copy')?.textContent).toBe('复制错误信息');
    expect(host.querySelector('.weq-toast-copy')?.getAttribute('aria-label')).toBe('复制错误信息');
    vi.setSystemTime(new Date('2026-11-13T04:10:00Z'));
    const text = await copy(host);
    expect(text).toContain('更新群资料失败');
    expect(text).toContain(detail);
    expect(text).toContain('2026-11-13 12:05:06');
    expect(text).toContain('北京时间');
    expect(text).toContain(version);
    expect(text).toContain(navigator.userAgent);
    expect(host.querySelector('.weq-toast-copy')?.textContent).toBe('已复制');
  });

  it('没有详情的错误仍然可以展开并复制', async () => {
    useToast.getState().push({ tone: 'error', message: '连接已断开' });
    const host = mount();
    expect(host.querySelector('[aria-label="展开详情"]')).not.toBeNull();
    expect(await copy(host)).toContain('连接已断开');
  });

  it('警告兼容旧 title/message，替换同一横幅时使用新错误时间与内容', async () => {
    const id = useToast.getState().push({ tone: 'info', title: '正在读取' });
    vi.setSystemTime(new Date('2026-11-13T04:06:07Z'));
    useToast.getState().update(id, { tone: 'warning', title: '读取失败', detail: '服务不可用' });
    const host = mount();
    const text = await copy(host);
    expect(text).toContain('2026-11-13 12:06:07');
    expect(text).toContain('服务不可用');
    expect(text).not.toContain('正在读取');
    act(() =>
      useToast
        .getState()
        .push({ key: 'legacy', tone: 'warning', title: '旧调用', message: '原因' }),
    );
    expect(host.textContent).toContain('原因');
  });

  it('普通通知使用复制信息文案，仍复制标题与详情', async () => {
    useToast.getState().push({ tone: 'success', title: '导出完成', detail: '已导出 20 条' });
    const host = mount();
    expect(host.querySelector('.weq-toast-copy')?.textContent).toBe('复制信息');
    const text = await copy(host);
    expect(text).toContain('导出完成');
    expect(text).toContain('已导出 20 条');
  });

  it('保留结构化详情中的换行和段落，不把错误内容粘成一行', async () => {
    useToast.getState().push({
      tone: 'error',
      title: '读取失败',
      detail: createElement(
        'div',
        null,
        createElement('p', null, '请求超时', createElement('br'), '请稍后重试'),
        createElement('p', null, '错误码：E_TIMEOUT'),
      ),
    });
    expect(await copy(mount())).toContain('请求超时\n请稍后重试\n错误码：E_TIMEOUT');
  });
});
