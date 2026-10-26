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
    useUtils: () => ({ account: { getAssistantConfig: { invalidate: f.invalidate } } }),
    account: {
      getAssistantConfig: { useQuery: () => ({ data: f.config }) },
      setAssistantConfig: { useMutation: () => ({ mutateAsync: f.save, isLoading: false }) },
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
    const mode = document.querySelector<HTMLSelectElement>('[aria-label="权限模式"]')!;
    expect(mode.value).toBe('sandbox');
    capture('sandbox-settings');
    act(() => {
      mode.value = 'unrestricted';
      mode.dispatchEvent(new Event('change', { bubbles: true }));
    });
    const save = [...document.querySelectorAll<HTMLButtonElement>('button')].find(
      (button) => button.textContent?.trim() === '保存',
    )!;
    await act(async () => save.click());
    expect(f.save).not.toHaveBeenCalled();
    expect(useDialog.getState().current?.title).toBe('开启任意权限？');
    expect(document.body.textContent).toContain('删除 WeQ 目录之外的文件');
    capture('unrestricted-warning');
    await act(async () =>
      document.querySelector<HTMLButtonElement>('.weq-dialog-foot .weq-action-soft')!.click(),
    );
    expect(f.save).not.toHaveBeenCalled();
    await act(async () => save.click());
    await act(async () =>
      document.querySelector<HTMLButtonElement>('.weq-dialog-foot .weq-action-primary')!.click(),
    );
    expect(f.save).toHaveBeenCalledWith(
      expect.objectContaining({ permissionMode: 'unrestricted', confirmUnrestricted: true }),
    );
    expect(onClose).toHaveBeenCalledOnce();
  } finally {
    act(() => root.unmount());
    host.remove();
    useDialog.getState().close();
    vi.unstubAllGlobals();
  }
});
