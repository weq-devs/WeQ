import { act, createElement as h, Fragment } from 'react';
import { createRoot } from 'react-dom/client';
import { mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { expect, it, vi } from 'vitest';
import { AssistantSettings } from '../src/renderer/src/views/agentlab/AssistantPanel';
import { DialogHost, useDialog } from '../src/renderer/src/components/Dialog';
import type { AssistantConfig } from '@weq/service';

const f = vi.hoisted(() => ({
  config: { permissionMode: 'sandbox' } as AssistantConfig,
  save: vi.fn(async (_input: unknown) => ({})),
  invalidate: vi.fn(async () => {}),
}));
vi.mock('../src/renderer/src/trpc/client', () => ({
  trpc: {
    useUtils: () => ({
      account: {
        getAssistantConfig: {
          invalidate: f.invalidate,
          setData: (_key: unknown, next: AssistantConfig) => {
            f.config = next;
          },
        },
      },
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
    const mode = document.querySelector<HTMLElement>('[aria-label="运行模式"]')!;
    expect(mode.querySelector('[aria-checked="true"]')?.textContent).toBe('沙箱模式');
    capture('sandbox-settings');
    // 设置页改为选择即保存，不再有「保存」按钮；升级到任意权限必须先确认警告。
    act(() => {
      [...mode.querySelectorAll('button')]
        .find((button) => button.textContent === '任意权限')!
        .click();
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
    const retry = document.querySelector<HTMLElement>('[aria-label="运行模式"]')!;
    act(() => {
      [...retry.querySelectorAll('button')]
        .find((button) => button.textContent === '任意权限')!
        .click();
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

it('选择保存失败仍保留当前选择，重试成功后才清除失败状态', async () => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  f.config = { permissionMode: 'sandbox', reasoningEffort: 'off' };
  f.save.mockImplementation(async (patch) => ({ ...f.config, ...(patch as AssistantConfig) }));
  f.save.mockRejectedValueOnce(new Error('合成保存失败'));
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  try {
    await act(async () => root.render(h(AssistantSettings, { onClose: () => {} })));
    const effort = document.querySelector<HTMLSelectElement>('[aria-label="思考等级"]')!;
    await act(async () => {
      effort.value = 'high';
      effort.dispatchEvent(new Event('change', { bubbles: true }));
    });
    expect(effort.value).toBe('high');
    expect(document.body.textContent).toContain('合成保存失败');
    await act(async () =>
      [...document.querySelectorAll<HTMLButtonElement>('button')]
        .find((button) => button.textContent === '重试保存')!
        .click(),
    );
    expect(effort.value).toBe('high');
    expect(document.body.textContent).not.toContain('合成保存失败');
    f.save.mockRejectedValueOnce(new Error('第二次合成失败'));
    await act(async () => {
      effort.value = 'medium';
      effort.dispatchEvent(new Event('change', { bubbles: true }));
    });
    await act(async () =>
      [...document.querySelectorAll<HTMLButtonElement>('.weq-cvs-nav-item')]
        .find((button) => button.textContent === '运行中发送')!
        .click(),
    );
    await act(async () =>
      [...document.querySelectorAll<HTMLButtonElement>('[aria-label="运行中默认发送方式"] button')]
        .find((button) => button.textContent === '排队发送')!
        .click(),
    );
    expect(f.save).toHaveBeenLastCalledWith(
      expect.objectContaining({ reasoningEffort: 'medium', sendMode: 'queue' }),
    );
    expect(document.body.textContent).not.toContain('第二次合成失败');
  } finally {
    act(() => root.unmount());
    host.remove();
    vi.unstubAllGlobals();
  }
});
