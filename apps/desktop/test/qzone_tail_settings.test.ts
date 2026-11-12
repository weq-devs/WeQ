import { act, createElement as h, type ButtonHTMLAttributes, type ReactNode } from 'react';
import { createRoot } from 'react-dom/client';
import { beforeEach, expect, it, vi } from 'vitest';
import { mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { QzoneTailSettings } from '../src/renderer/src/components/qq-actions/QzoneTailSettings';

const state = vi.hoisted(() => ({
  query: vi.fn(),
  save: vi.fn(async (_input: unknown) => ({ state: 'accepted' })),
  rows: [
    { id: '', label: '不展示', selected: true, editable: false },
    { id: 'device', label: '合成设备尾巴', selected: false, editable: false },
  ],
}));
vi.mock('../src/renderer/src/trpc/client', () => ({
  trpc: {
    account: {
      qzone: {
        tails: {
          useQuery: (input: unknown, options: { enabled: boolean }) => {
            state.query(input, options.enabled);
            return {
              data: options.enabled ? state.rows : undefined,
              isFetching: false,
              error: null,
              refetch: async () => ({
                data: state.rows.map((row) => ({ ...row, selected: row.id === 'device' })),
                error: null,
              }),
            };
          },
        },
      },
      qqActions: { qzoneTail: { useMutation: () => ({ mutateAsync: state.save }) } },
    },
  },
}));
vi.mock('../src/renderer/src/components/qq-actions/shared', () => ({
  withQQAccountScope: (Component: unknown) => Component,
  ActionFeedback: () => null,
  ActionIcon: ({
    label,
    children,
    ...props
  }: { label: string; children: ReactNode } & ButtonHTMLAttributes<HTMLButtonElement>) =>
    h('button', { ...props, 'aria-label': label }, children),
  useQQAction: () => ({
    available: true,
    disabled: false,
    pending: false,
    binding: { expectedAccountUin: '10001' },
    perform: async (
      run: (binding: object) => Promise<unknown>,
      _refresh: unknown,
      _warning: unknown,
      options: { readback: () => Promise<boolean> },
    ) => {
      await run({ expectedAccountUin: '10001', expectedAccountConfigId: 'fixture' });
      return options.readback();
    },
  }),
}));
beforeEach(() => {
  state.query.mockClear();
  state.save.mockClear();
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
});
it('尾巴按需读取，query 身份稳定，选择后只保存一次并读回', async () => {
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  try {
    await act(async () => root.render(h(QzoneTailSettings)));
    expect(state.query.mock.calls.at(-1)?.[1]).toBe(false);
    expect(host.querySelector('select')).toBeNull();
    await act(async () =>
      host.querySelector<HTMLButtonElement>('[aria-label="读取手机尾巴"]')!.click(),
    );
    expect(state.query.mock.calls.at(-1)?.[1]).toBe(true);
    const requestId = (state.query.mock.calls.at(-1)![0] as { requestId: string }).requestId;
    const select = host.querySelector('select')!;
    expect(select.value).toBe(JSON.stringify(''));
    await act(async () => {
      select.value = JSON.stringify('device');
      select.dispatchEvent(new Event('change', { bubbles: true }));
    });
    expect((state.query.mock.calls.at(-1)![0] as { requestId: string }).requestId).toBe(requestId);
    const directory = process.env.WEQ_QZONE_FEEDBACK_LAYOUT;
    if (directory) {
      mkdirSync(directory, { recursive: true });
      const links = [
        'index',
        'settings-controls',
        'settings-query',
        'settings-responsive',
        'qq-actions',
        'qq-write',
        'qzone-tail',
      ]
        .map(
          (name) =>
            `<link rel="stylesheet" href="/@fs${resolve('src/renderer/src/styles', `${name}.css`)}">`,
        )
        .join('');
      writeFileSync(
        resolve(directory, 'qzone-tail.html'),
        `<!doctype html><html lang="zh-CN"><meta charset="utf-8">${links}<style>body{margin:0;padding:16px;background:var(--background);color:var(--foreground)}*,*::before,*::after{box-sizing:border-box}main{max-width:680px}</style><main class="weq-set">${host.innerHTML}</main></html>`,
      );
    }
    await act(async () =>
      host.querySelector<HTMLButtonElement>('[aria-label="保存手机尾巴"]')!.click(),
    );
    expect(state.save).toHaveBeenCalledOnce();
    expect(state.save).toHaveBeenCalledWith({
      expectedAccountUin: '10001',
      expectedAccountConfigId: 'fixture',
      id: 'device',
    });
  } finally {
    act(() => root.unmount());
    host.remove();
    vi.unstubAllGlobals();
  }
});
