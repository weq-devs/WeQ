import { act, createElement as h } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { ExportSavePolicy } from '@weq/service';
import { MarketImageSave } from '../src/renderer/src/components/MarketImageSave';
import { mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

const state = vi.hoisted(() => ({
  current: true,
  web: false,
  prepare: vi.fn(
    async (_intent?: ExportSavePolicy, _output?: unknown): Promise<ExportSavePolicy | null> => ({
      mode: 'after',
    }),
  ),
  start: vi.fn(async (_input: unknown) => 'task'),
  download: vi.fn(async (_input: unknown) => ({ url: '/download/fixture' })),
  toast: vi.fn(),
}));
vi.mock('../src/renderer/src/lib/target', () => ({
  get IS_WEB() {
    return state.web;
  },
}));
vi.mock('../src/renderer/src/hooks/useExportSavePolicy', () => ({
  useExportSavePolicy: () => ({
    binding: { expectedAccountUin: '10001', expectedAccountConfigId: 'source-a' },
    settings: { isLoading: false },
    prepareSave: state.prepare,
    isCurrent: () => state.current,
  }),
}));
vi.mock('../src/renderer/src/components/Toast', () => ({ useToast: () => state.toast }));
vi.mock('../src/renderer/src/trpc/client', () => ({
  client: {
    account: {
      marketEmoji: {
        startImageSave: { mutate: state.start },
        downloadImage: { mutate: state.download },
      },
    },
  },
}));
const cleanup: Array<() => void> = [];
beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  state.current = true;
  state.web = false;
  state.prepare.mockReset().mockResolvedValue({ mode: 'after' });
  state.start.mockClear();
  state.download.mockClear();
  state.toast.mockClear();
});
afterEach(() => {
  for (const fn of cleanup.splice(0)) fn();
  vi.unstubAllGlobals();
});
async function mount() {
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  await act(async () =>
    root.render(h(MarketImageSave, { packId: '123', hash: 'abcdef', name: '合成表情' })),
  );
  cleanup.push(() => {
    act(() => root.unmount());
    host.remove();
  });
  return host;
}
it('主按钮使用公共偏好和单张 GIF 形态，不退出浏览', async () => {
  const host = await mount();
  await act(async () => host.querySelector<HTMLButtonElement>('[aria-label="保存表情"]')!.click());
  expect(state.prepare).toHaveBeenCalledWith(undefined, {
    kind: 'file',
    name: '合成表情',
    format: 'gif',
  });
  expect(state.start).toHaveBeenCalledWith({
    expectedAccountUin: '10001',
    expectedAccountConfigId: 'source-a',
    packId: '123',
    hash: 'abcdef',
    name: '合成表情',
    savePolicy: { mode: 'after' },
  });
  expect(host.querySelector('[aria-label="保存表情"]')).not.toBeNull();
  const layout = process.env.WEQ_MARKET_LAYOUT;
  if (layout) {
    mkdirSync(layout, { recursive: true });
    const styles = ['index.css', 'export-save-actions.css', 'market-image-save.css']
      .map(
        (file) => `<link rel="stylesheet" href="/@fs${resolve('src/renderer/src/styles', file)}">`,
      )
      .join('');
    writeFileSync(
      resolve(layout, 'market-save.html'),
      `<!doctype html><html lang="zh-CN"><meta charset="utf-8">${styles}<style>body{margin:0;padding:16px;background:var(--background);font-family:system-ui}*,*::before,*::after{box-sizing:border-box}</style><body><div class="weq-mface-lb-panel weq-mface-detail"><div class="weq-mface-lb-head"><button class="weq-mface-detail-back">返回整组</button><span class="weq-mface-lb-title">合成的长名称表情测试文本</span><span class="weq-mface-lb-count">1 / 20</span>${host.innerHTML}</div></div></body></html>`,
    );
  }
});
it('本次另存取消不建任务，不更改默认保存偏好', async () => {
  const host = await mount();
  state.prepare.mockResolvedValueOnce(null);
  act(() => host.querySelector<HTMLButtonElement>('[aria-label="本次保存选项"]')!.click());
  await act(async () =>
    [...document.querySelectorAll<HTMLButtonElement>('[role="menuitem"]')]
      .find((item) => item.textContent === '另存到…')!
      .click(),
  );
  expect(state.prepare.mock.calls[0]![0]).toEqual({ mode: 'before' });
  expect(state.start).not.toHaveBeenCalled();
});
it('准备期间切换来源，不创建旧目标的任务', async () => {
  const host = await mount();
  state.prepare.mockImplementationOnce(async () => {
    state.current = false;
    return { mode: 'after' };
  });
  await act(async () => host.querySelector<HTMLButtonElement>('[aria-label="保存表情"]')!.click());
  expect(state.start).not.toHaveBeenCalled();
});
it('Web 本机下载不准备服务器位置，不创建保存任务', async () => {
  state.web = true;
  const host = await mount();
  const click = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {});
  try {
    await act(async () =>
      host.querySelector<HTMLButtonElement>('[aria-label="下载到浏览器"]')!.click(),
    );
    expect(state.download).toHaveBeenCalledOnce();
    expect(click).toHaveBeenCalledOnce();
    expect(state.prepare).not.toHaveBeenCalled();
    expect(state.start).not.toHaveBeenCalled();
  } finally {
    click.mockRestore();
  }
});
