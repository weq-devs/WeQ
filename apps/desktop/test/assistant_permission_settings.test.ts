import { act, createElement as h, Fragment } from 'react';
import { createRoot } from 'react-dom/client';
import { mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { expect, it, vi } from 'vitest';
import { AssistantSettings } from '../src/renderer/src/views/agentlab/AssistantPanel';
import { DialogHost, useDialog } from '../src/renderer/src/components/Dialog';

const f = vi.hoisted(() => ({
  config: { permissionMode: 'sandbox' as const },
  save: vi.fn(async (_input: unknown) => ({})),
  invalidate: vi.fn(async () => {}),
}));
vi.mock('../src/renderer/src/trpc/client', () => ({
  trpc: {
    useUtils: () => ({
      account: { getAssistantConfig: { invalidate: f.invalidate, setData: () => {} } },
      bootstrap: { getSettings: { invalidate: async () => {} } },
    }),
    account: {
      getAssistantConfig: { useQuery: () => ({ data: f.config }) },
      setAssistantConfig: { useMutation: () => ({ mutateAsync: f.save, isLoading: false }) },
    },
    // 设置面板里的模型选择与图片偏好会读取服务商、默认模型和共享设置。
    bootstrap: {
      listAgentLabProviders: { useQuery: () => ({ data: [] }) },
      getAgentLabDefaultModel: { useQuery: () => ({ data: undefined }) },
      getSettings: { useQuery: () => ({ data: { aiImages: {} } }) },
      setAiImagePreference: {
        useMutation: () => ({ mutateAsync: async () => ({}), isLoading: false }),
      },
    },
  },
  client: {},
}));

function capture(name: string) {
  const output = process.env.WEQ_PERMISSION_LAYOUT_DIR;
  if (!output) return;
  mkdirSync(output, { recursive: true });
  for (const option of document.querySelectorAll('option'))
    option.toggleAttribute('selected', option.selected);
  const links = ['index.css', 'agentlab-workspace.css', 'dialog-layout.css']
    .map((file) => `<link rel="stylesheet" href="/@fs${resolve('src/renderer/src/styles', file)}">`)
    .join('');
  writeFileSync(
    resolve(output, `${name}.html`),
    `<!doctype html><html lang="zh-CN" data-theme="light"><meta charset="utf-8">${links}<style>body{margin:0;background:var(--background);font-family:system-ui}*,*::before,*::after{box-sizing:border-box}</style><body>${document.body.innerHTML}</body></html>`,
  );
}

it('requires the real warning confirmation before persisting unrestricted permission', async () => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  const onClose = vi.fn();
  try {
    act(() => root.render(h(Fragment, {}, h(AssistantSettings, { onClose }), h(DialogHost))));
    expect(
      [...document.querySelectorAll('[aria-label="思考等级"] option')].map(
        (option) => option.textContent,
      ),
    ).toEqual(['不指定', 'low', 'medium', 'high']);
    // 权限模式在「提示与工具」分区，标题也改成了「运行模式」。
    act(() =>
      [...document.querySelectorAll<HTMLButtonElement>('.weq-cvs-nav-item')]
        .find((button) => button.textContent?.trim() === '提示与工具')!
        .click(),
    );
    const mode = document.querySelector<HTMLSelectElement>('[aria-label="运行模式"]')!;
    expect(mode.value).toBe('sandbox');
    capture('sandbox-settings');
    // 设置页改为选择即保存，不再有「保存」按钮；升级到任意权限必须先确认警告。
    act(() => {
      mode.value = 'unrestricted';
      mode.dispatchEvent(new Event('change', { bubbles: true }));
    });
    await act(async () => {});
    expect(f.save).not.toHaveBeenCalled();
    expect(useDialog.getState().current?.title).toBe('开启任意权限？');
    expect(document.body.textContent).toContain('修改外部文件');
    capture('unrestricted-warning');
    await act(async () =>
      document.querySelector<HTMLButtonElement>('.weq-dialog-foot .weq-action-soft')!.click(),
    );
    expect(f.save).not.toHaveBeenCalled();
    // 取消后回到沙箱态再选一次，确认通过才真正落库。
    act(() =>
      [...document.querySelectorAll<HTMLButtonElement>('.weq-cvs-nav-item')]
        .find((button) => button.textContent?.trim() === '模型与生成')!
        .click(),
    );
    act(() =>
      [...document.querySelectorAll<HTMLButtonElement>('.weq-cvs-nav-item')]
        .find((button) => button.textContent?.trim() === '提示与工具')!
        .click(),
    );
    const retry = document.querySelector<HTMLSelectElement>('[aria-label="运行模式"]')!;
    act(() => {
      retry.value = 'unrestricted';
      retry.dispatchEvent(new Event('change', { bubbles: true }));
    });
    await act(async () => {});
    await act(async () =>
      document.querySelector<HTMLButtonElement>('.weq-dialog-foot .weq-action-primary')!.click(),
    );
    expect(f.save).toHaveBeenCalledWith(
      expect.objectContaining({ permissionMode: 'unrestricted', confirmUnrestricted: true }),
    );
    expect(useDialog.getState().current).toBeNull();
  } finally {
    act(() => root.unmount());
    host.remove();
    useDialog.getState().close();
    vi.unstubAllGlobals();
  }
});
