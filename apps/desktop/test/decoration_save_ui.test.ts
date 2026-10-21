import { act, createElement as h } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import type { ExportSavePolicy } from '@weq/service';
import {
  DecorationSaveControls,
  useDecorationSave,
} from '../src/renderer/src/components/DecorationSaveControls';
const state = vi.hoisted(() => ({
  web: false,
  current: true,
  prepare: vi.fn(
    async (_intent?: ExportSavePolicy, _output?: unknown): Promise<ExportSavePolicy | null> => ({
      mode: 'before',
      directory: 'chosen',
    }),
  ),
  mutate: vi.fn(
    async (
      _input: unknown,
    ): Promise<
      | { mode: 'task'; taskId: string }
      | { mode: 'cancelled' }
      | { mode: 'browser'; downloadId: string; name: string }
    > => ({ mode: 'task', taskId: 'fixture' }),
  ),
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
    policy: { mode: 'preset', directory: '/saved' },
    prepareSave: state.prepare,
    isCurrent: () => state.current,
  }),
}));
vi.mock('../src/renderer/src/components/Toast', () => ({ useToast: () => state.toast }));
vi.mock('../src/renderer/src/trpc/client', () => ({
  client: { account: { dressup: { saveMsgDecoration: { mutate: state.mutate } } } },
}));
const ids = { bubbleId: 0, fontId: 11, widgetId: 0, kind: 'font' as const };
function Harness() {
  const save = useDecorationSave();
  return h(DecorationSaveControls, {
    className: 'weq-dress-save',
    title: '另存为合成字体',
    busy: Boolean(save.savingKey),
    disabled: save.disabled,
    onSave: (intent, browser) => void save.run(ids, 'font:11', intent, browser),
  });
}
const cleanup: Array<() => void> = [];
beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  state.web = false;
  state.current = true;
  state.prepare.mockClear();
  state.toast.mockClear();
  state.mutate.mockReset().mockResolvedValue({ mode: 'task', taskId: 'fixture' });
});
afterEach(() => {
  for (const fn of cleanup.splice(0)) fn();
  vi.unstubAllGlobals();
});
async function mount() {
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  await act(async () => root.render(h(Harness)));
  const layout = process.env.WEQ_DECORATION_LAYOUT;
  if (layout) {
    mkdirSync(layout, { recursive: true });
    const styles = ['index.css', 'dressup.css', 'export-save-actions.css', 'decoration-save.css']
      .map(
        (file) => `<link rel="stylesheet" href="/@fs${resolve('src/renderer/src/styles', file)}">`,
      )
      .join('');
    writeFileSync(
      resolve(layout, state.web ? 'decoration-web.html' : 'decoration-desktop.html'),
      `<!doctype html><html lang="zh-CN"><meta charset="utf-8">${styles}<style>html,body{margin:0;background:var(--background);font-family:system-ui}*,*::before,*::after{box-sizing:border-box}.test-card{width:180px;margin:16px 0 16px 16px;border:1px solid var(--weq-border-subtle)}.test-card h3{font-size:14px;padding:10px;color:var(--weq-fg-primary)}.test-message{width:min(640px,calc(100% - 32px));margin:16px;padding:16px;border:1px solid var(--weq-border-subtle)}</style><body><div class="test-card"><h3>合成字体</h3><div class="weq-dress-card-actions"><button class="weq-dress-use">使用</button>${host.innerHTML}</div></div><div class="test-message"><div class="weq-decoration-card-titlebar"><strong style="color:var(--weq-fg-primary)">消息装扮</strong>${host.innerHTML.replaceAll('weq-dress-save', 'weq-decoration-card-save-all')}</div></div></body></html>`,
    );
  }
  cleanup.push(() => {
    act(() => root.unmount());
    host.remove();
  });
  return host;
}
it('桌面偏好传给后端，由真实产物决定原生选择器格式', async () => {
  const host = await mount();
  await act(async () =>
    host.querySelector<HTMLButtonElement>('[aria-label="另存为合成字体"]')!.click(),
  );
  expect(state.mutate).toHaveBeenCalledWith({
    ...ids,
    expectedAccountUin: '10001',
    expectedAccountConfigId: 'source-a',
    savePolicy: { mode: 'preset', directory: '/saved' },
    browserDownload: false,
  });
  expect(state.prepare).not.toHaveBeenCalled();
  expect(state.toast.mock.calls[0]![0].tone).toBe('info');
});
it('本次另存使用 before，不修改默认偏好；取消不冒称成功', async () => {
  const host = await mount();
  state.mutate.mockResolvedValueOnce({ mode: 'cancelled' });
  act(() => host.querySelector<HTMLButtonElement>('[aria-label="本次保存选项"]')!.click());
  await act(async () =>
    [...document.querySelectorAll<HTMLButtonElement>('[role="menuitem"]')]
      .find((item) => item.textContent === '另存到…')!
      .click(),
  );
  expect(state.mutate.mock.calls[0]![0]).toMatchObject({ savePolicy: { mode: 'before' } });
  expect(state.toast).not.toHaveBeenCalled();
});
it('Web 服务器保存选择公共目录，浏览器下载不准备服务器路径', async () => {
  state.web = true;
  const host = await mount();
  await act(async () =>
    host.querySelector<HTMLButtonElement>('[aria-label="另存为合成字体"]')!.click(),
  );
  expect(state.prepare).toHaveBeenCalledWith(undefined, { kind: 'bundle', name: '装扮资源' });
  expect(state.mutate.mock.calls[0]![0]).toMatchObject({
    savePolicy: { mode: 'before', directory: 'chosen' },
  });
  state.prepare.mockClear();
  state.mutate.mockResolvedValueOnce({
    mode: 'browser',
    downloadId: 'fixture-download',
    name: 'fixture.ttf',
  });
  const click = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {});
  try {
    await act(async () =>
      host.querySelector<HTMLButtonElement>('[aria-label="下载到浏览器"]')!.click(),
    );
    expect(click).toHaveBeenCalledOnce();
    expect(state.prepare).not.toHaveBeenCalled();
  } finally {
    click.mockRestore();
  }
});
it('晚到回执不提示新来源已保存', async () => {
  const host = await mount();
  state.mutate.mockImplementationOnce(async () => {
    state.current = false;
    return { mode: 'task', taskId: 'old' };
  });
  await act(async () =>
    host.querySelector<HTMLButtonElement>('[aria-label="另存为合成字体"]')!.click(),
  );
  expect(state.toast).not.toHaveBeenCalled();
});
