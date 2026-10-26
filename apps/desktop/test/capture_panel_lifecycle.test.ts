import { act, createElement } from 'react';
import { createRoot } from 'react-dom/client';
import { Window as HappyWindow } from 'happy-dom';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { CaptureBatchWire } from '../src/main/capture_protocol';
import { CapturePanel, CAPTURE_SPLIT_STEP } from '../src/renderer/src/components/CapturePanel';
import { RenderDocumentContext } from '../src/renderer/src/lib/renderDocument';
import { TabActivity } from '../src/renderer/src/components/RetainedTabs';

const f = vi.hoisted(() => ({
  handle: {
    pid: 42,
    sessionId: 'synthetic-lease',
    iface: 'synthetic0',
    port: 'tcp',
    linktype: 1,
    elevated: false,
    hasD2Key: true,
  },
  start: vi.fn(),
  stop: vi.fn(),
  poll: vi.fn(),
  support: vi.fn(),
  export: vi.fn(),
  external: vi.fn(),
  copy: vi.fn(),
  push: vi.fn(() => 1),
  update: vi.fn(),
}));
vi.mock('../src/renderer/src/trpc/client', () => ({
  client: {
    wonderfulTools: {
      captureStart: { mutate: f.start },
      captureStop: { mutate: f.stop },
      capturePoll: { query: f.poll },
      captureSupport: { query: f.support },
      captureExport: { mutate: f.export },
    },
    help: { openExternal: { mutate: f.external } },
  },
}));
vi.mock('../src/renderer/src/components/Toast', () => ({
  useToast: { getState: () => ({ push: f.push, update: f.update }) },
}));

const pending: Array<(batch: CaptureBatchWire) => void> = [];
const cleanups: Array<() => void> = [];
const empty: CaptureBatchWire = { frames: [], dropped: 0, nextCursor: 1 };
const frames: CaptureBatchWire = {
  frames: [
    {
      cursor: 1,
      ts: 1,
      direction: 'c2s',
      proto: 1,
      encryptType: 0,
      seq: 7,
      cmd: 'Synthetic.Frame',
      rawHex: '00'.repeat(80),
      plainHex: '0801',
      bodyHex: '0801',
    },
  ],
  dropped: 0,
  nextCursor: 2,
};

beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  f.start.mockReset().mockResolvedValue(f.handle);
  f.stop.mockReset().mockResolvedValue(null);
  f.support.mockReset().mockResolvedValue({
    available: true,
    backend: 'synthetic',
    elevated: false,
    hint: '',
    platform: 'linux',
  });
  f.poll
    .mockReset()
    .mockImplementation(() => new Promise<CaptureBatchWire>((resolve) => pending.push(resolve)));
  f.export.mockReset();
  f.external.mockReset().mockResolvedValue(true);
  f.copy.mockReset().mockResolvedValue(undefined);
  f.push.mockClear();
  f.update.mockClear();
});
afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) cleanup();
  await act(async () => {
    for (const resolve of pending.splice(0)) resolve(empty);
  });
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

function mount(width = 1024) {
  const popup = new HappyWindow({ width, height: 780 });
  const owner = popup.document as unknown as Document;
  Object.defineProperty(popup.navigator, 'clipboard', {
    configurable: true,
    value: { writeText: f.copy },
  });
  const host = owner.createElement('div');
  owner.body.append(host);
  const root = createRoot(host);
  let closed = false;
  const render = (active = true) =>
    act(() =>
      root.render(
        createElement(
          RenderDocumentContext.Provider,
          { value: owner },
          createElement(
            TabActivity,
            { active },
            createElement(CapturePanel, {
              accounts: [{ uin: '10001', name: '合成账号', avatarUrl: '', pid: f.handle.pid }],
            }),
          ),
        ),
      ),
    );
  const close = () => {
    if (closed) return;
    closed = true;
    act(() => root.unmount());
    host.remove();
  };
  cleanups.push(() => {
    close();
    popup.close();
  });
  render();
  const button = (title: string) =>
    host.querySelector<HTMLButtonElement>(`button[title="${title}"]`)!;
  const start = () =>
    act(async () => {
      button('开始抓包').click();
    });
  return { popup, owner, host, root, render, close, button, start };
}

it('关闭与卸载只停止自己持有的抓包会话，停止请求带回会话 ID', async () => {
  const page = mount();
  await page.start();
  expect(f.poll).toHaveBeenCalledWith(
    expect.objectContaining({ pid: f.handle.pid, sessionId: f.handle.sessionId }),
  );
  act(() => page.popup.dispatchEvent(new page.popup.Event('unload')));
  expect(f.stop).toHaveBeenCalledWith({ pid: f.handle.pid, sessionId: f.handle.sessionId });
  page.close();
  expect(f.stop).toHaveBeenCalledOnce();
});

it('窄子窗口使用上下分栏，拖动与键盘均按高度调整而不读取主窗口宽度', async () => {
  const page = mount(320);
  await act(async () => {});
  const separator = page.host.querySelector<HTMLElement>('[role="separator"]')!;
  const split = page.host.querySelector<HTMLElement>('.weq-cap-split')!;
  expect(split.classList.contains('is-stacked')).toBe(true);
  expect(separator.getAttribute('aria-orientation')).toBe('horizontal');
  const initial = Number(separator.getAttribute('aria-valuenow'));
  act(() =>
    separator.dispatchEvent(
      new page.popup.KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }),
    ),
  );
  expect(Number(separator.getAttribute('aria-valuenow'))).toBe(
    initial + Math.round(CAPTURE_SPLIT_STEP * 100),
  );
  Object.defineProperty(split, 'getBoundingClientRect', {
    value: () => ({ top: 100, left: 40, width: 320, height: 400 }),
  });
  Object.defineProperty(separator, 'setPointerCapture', { configurable: true, value: vi.fn() });
  act(() =>
    separator.dispatchEvent(
      new page.popup.PointerEvent('pointerdown', { pointerId: 1, bubbles: true }),
    ),
  );
  act(() =>
    page.popup.dispatchEvent(
      new page.popup.PointerEvent('pointermove', { pointerId: 1, clientX: 40, clientY: 300 }),
    ),
  );
  expect(separator.getAttribute('aria-valuenow')).toBe('50');
  act(() => page.popup.dispatchEvent(new page.popup.PointerEvent('pointerup', { pointerId: 1 })));
  expect(split.classList.contains('is-dragging')).toBe(false);
  act(() =>
    separator.dispatchEvent(
      new page.popup.KeyboardEvent('keydown', { key: 'Home', bubbles: true }),
    ),
  );
  expect(separator.getAttribute('aria-valuenow')).toBe(separator.getAttribute('aria-valuemin'));
  act(() =>
    separator.dispatchEvent(new page.popup.KeyboardEvent('keydown', { key: 'End', bubbles: true })),
  );
  expect(separator.getAttribute('aria-valuenow')).toBe(separator.getAttribute('aria-valuemax'));
  expect(f.start).not.toHaveBeenCalled();
});

it('窗口关闭后才返回的启动句柄立即释放，不更新已卸载界面', async () => {
  let finish!: (handle: typeof f.handle) => void;
  f.start.mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        finish = resolve;
      }),
  );
  const page = mount();
  await page.start();
  expect(f.start).toHaveBeenCalledOnce();
  expect(page.host.querySelector('select')!.disabled).toBe(true);
  page.close();
  await act(async () => finish(f.handle));
  expect(f.stop).toHaveBeenCalledWith({ pid: f.handle.pid, sessionId: f.handle.sessionId });
  expect(f.poll).not.toHaveBeenCalled();
});

it('开始前的能力查询迟到时，锁屏或隐藏不能继续触发抓包授权', async () => {
  const waiting: Array<(value: { available: boolean; platform: string }) => void> = [];
  f.support.mockImplementation(() => new Promise((resolve) => waiting.push(resolve)));
  const page = mount();
  await page.start();
  expect(waiting.length).toBeGreaterThan(0);
  page.render(false);
  await act(async () => {
    for (const finish of waiting) finish({ available: true, platform: 'linux' });
  });
  expect(f.start).not.toHaveBeenCalled();
  expect(f.poll).not.toHaveBeenCalled();
});

it('Npcap 引导显示在抓包子窗口，确认前不打开网站或开始抓包', async () => {
  f.support.mockResolvedValue({
    available: false,
    backend: 'synthetic',
    elevated: false,
    hint: 'synthetic missing',
    platform: 'win32',
  });
  const page = mount();
  await page.start();
  expect(page.owner.body.textContent).toContain('需要 Npcap');
  expect(document.body.textContent).not.toContain('需要 Npcap');
  expect(f.start).not.toHaveBeenCalled();
  expect(f.external).not.toHaveBeenCalled();
  const open = [...page.owner.querySelectorAll<HTMLButtonElement>('button')].find((button) =>
    button.textContent?.includes('打开官网'),
  )!;
  await act(async () => open.click());
  expect(f.external).toHaveBeenCalledWith({ url: 'https://npcap.com/#download' });
  expect(page.owner.body.textContent).not.toContain('需要 Npcap');
});

it('锁屏/隐藏暂停轮询并丢弃迟到帧，重新激活继续同一会话', async () => {
  const page = mount();
  await page.start();
  page.render(false);
  await act(async () => pending.shift()!(frames));
  expect(page.host.textContent).not.toContain('Synthetic.Frame');
  expect(f.stop).not.toHaveBeenCalled();
  const before = f.poll.mock.calls.length;
  page.render(true);
  expect(f.poll.mock.calls.length).toBeGreaterThan(before);
  page.close();
  expect(f.stop).toHaveBeenCalledOnce();
});

it('导出菜单和 Escape 留在子文档，复制使用子窗口剪贴板并清理反馈定时器', async () => {
  f.poll.mockResolvedValueOnce(frames);
  const page = mount();
  const clear = vi.spyOn(page.popup, 'clearTimeout');
  const timer = vi.spyOn(page.popup, 'setTimeout');
  await page.start();
  act(() => page.button('导出当前列表（按过滤条件）为 JSON / JSONL 文件').click());
  expect(page.owner.querySelector('[role="menu"][aria-label="导出格式"]')).not.toBeNull();
  expect(document.querySelector('[aria-label="导出格式"]')).toBeNull();
  page.render(false);
  expect(page.owner.querySelector('[aria-label="导出格式"]')).toBeNull();
  page.render(true);
  act(() => page.button('导出当前列表（按过滤条件）为 JSON / JSONL 文件').click());
  act(() =>
    page.owner.dispatchEvent(
      new page.popup.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }),
    ),
  );
  expect(page.owner.querySelector('[aria-label="导出格式"]')).toBeNull();
  const raw = [...page.host.querySelectorAll<HTMLButtonElement>('button')].find(
    (button) => button.getAttribute('role') === 'tab' && button.textContent?.startsWith('原始数据'),
  )!;
  act(() => raw.click());
  await act(async () => page.button('复制 hex').click());
  expect(f.copy).toHaveBeenCalledOnce();
  expect(f.copy).toHaveBeenCalledWith(frames.frames[0]!.rawHex);
  const index = timer.mock.calls.findIndex((call) => call[1] === 1400);
  expect(index).toBeGreaterThanOrEqual(0);
  const id = timer.mock.results[index]!.value;
  page.close();
  expect(clear).toHaveBeenCalledWith(id);
});

it('旧窗口关闭后的导出完成不在新来源触发下载或披露旧路径', async () => {
  f.poll.mockResolvedValueOnce(frames);
  let finish!: (result: unknown) => void;
  f.export.mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        finish = resolve;
      }),
  );
  const page = mount();
  await page.start();
  act(() => page.button('导出当前列表（按过滤条件）为 JSON / JSONL 文件').click());
  const json = page.owner.querySelector<HTMLButtonElement>('[role="menuitem"]')!;
  await act(async () => json.click());
  page.close();
  const parentCreate = vi.spyOn(document, 'createElement');
  const childCreate = vi.spyOn(page.owner, 'createElement');
  await act(async () =>
    finish({
      saved: true,
      downloadId: 'synthetic-file',
      path: '/synthetic/private/capture.json',
      frames: 1,
      bytes: 80,
    }),
  );
  expect(parentCreate.mock.calls.some(([tag]) => tag === 'a')).toBe(false);
  expect(childCreate.mock.calls.some(([tag]) => tag === 'a')).toBe(false);
  expect(f.update.mock.calls.at(-1)?.[1].detail).toBeUndefined();
});
