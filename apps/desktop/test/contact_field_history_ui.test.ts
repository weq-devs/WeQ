import { act, createElement as h } from 'react';
import { createRoot } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { afterEach, expect, it, vi } from 'vitest';
import { ContactFieldHistoryProvider } from '../src/renderer/src/components/contactProfile/ContactFieldHistory';
import { ContactRow } from '../src/renderer/src/components/contactProfile/ContactRow';
import { Modal } from '../src/renderer/src/components/Dialog';
import { OverlayLayer } from '../src/renderer/src/components/OverlayLayer';
const rpc = vi.hoisted(() => ({
  summary: vi.fn(async () => ({ fields: ['company'], pending: false })),
  versions: vi.fn(async () => ({
    rows: [{ id: 1, first_at: 100, last_at: 200, value: '旧公司' }],
    nextBefore: null,
  })),
}));
vi.mock('../src/renderer/src/hooks/useQQWriteSession', () => ({
  useQQWriteSession: () => ({
    binding: { expectedAccountUin: '10001', expectedAccountConfigId: 'source' },
  }),
}));
vi.mock('../src/renderer/src/trpc/client', () => ({
  client: {
    account: {
      contactMetrics: {
        history: { fieldSummary: { query: rpc.summary }, fieldVersions: { query: rpc.versions } },
      },
    },
  },
}));
const opened: Array<{ root: ReturnType<typeof createRoot>; cache: QueryClient }> = [];
afterEach(() => {
  for (const { root, cache } of opened.splice(0)) {
    act(() => root.unmount());
    cache.clear();
  }
  document.body.innerHTML = '';
  vi.clearAllMocks();
});
it('仅变化项目旁显示历史，未打开不读版本，弹窗只显示该项目', async () => {
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  const cache = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  opened.push({ root, cache });
  await act(async () => {
    root.render(
      h(
        QueryClientProvider,
        { client: cache },
        h(
          ContactFieldHistoryProvider,
          { entity: 'friend:u_peer' },
          h(ContactRow, { label: '公司', value: '当前公司' }),
          h(ContactRow, { label: '邮箱', value: 'mail@example.invalid' }),
        ),
      ),
    );
    await new Promise((r) => setTimeout(r, 20));
  });
  await act(async () => {
    await new Promise((r) => setTimeout(r, 20));
  });
  expect(host.querySelector('[aria-label="显示公司历史"]')).not.toBeNull();
  expect(host.querySelector('[aria-label="显示邮箱历史"]')).toBeNull();
  expect(rpc.versions).not.toHaveBeenCalled();
  await act(async () => {
    host.querySelector<HTMLButtonElement>('[aria-label="显示公司历史"]')!.click();
    await new Promise((r) => setTimeout(r, 20));
  });
  await act(async () => {
    await new Promise((r) => setTimeout(r, 20));
  });
  const dialog = document.querySelector('[role="dialog"]')!;
  expect(dialog.getAttribute('aria-modal')).toBeNull();
  expect(dialog.textContent).toContain('旧公司');
  expect(dialog.textContent).not.toContain('邮箱');
  expect(rpc.versions).toHaveBeenCalledWith(
    expect.objectContaining({
      entity: 'friend:u_peer',
      field: 'company',
      expectedAccountConfigId: 'source',
    }),
  );
});
it('当前项目为空但确有历史时保留该项目和历史按钮，不复制占位文本', async () => {
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  const cache = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  opened.push({ root, cache });
  await act(async () => {
    root.render(
      h(
        QueryClientProvider,
        { client: cache },
        h(
          ContactFieldHistoryProvider,
          { entity: 'friend:u_empty' },
          h(ContactRow, { label: '公司', value: '', copyValue: '' }),
          h(ContactRow, { label: '邮箱', value: '' }),
        ),
      ),
    );
    await new Promise((r) => setTimeout(r, 20));
  });
  await act(async () => {
    await new Promise((r) => setTimeout(r, 20));
  });
  expect(host.textContent).toContain('暂无当前资料');
  expect(host.querySelector('[aria-label="显示公司历史"]')).not.toBeNull();
  expect(host.textContent).not.toContain('邮箱');
  expect(host.querySelectorAll('button')).toHaveLength(1);
});
it.each(['modal', 'overlay'] as const)('嵌套 %s 中的其他对象不继承宿主历史按钮', async (kind) => {
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  const cache = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  opened.push({ root, cache });
  const foreign = h(
    'div',
    { 'data-foreign': true },
    h(ContactRow, { label: '公司', value: '其他对象公司' }),
  );
  await act(async () => {
    root.render(
      h(
        QueryClientProvider,
        { client: cache },
        h(
          ContactFieldHistoryProvider,
          { entity: 'friend:u_host' },
          h(ContactRow, { label: '公司', value: '宿主公司' }),
          kind === 'modal'
            ? h(Modal, { title: '其他对象', presentation: 'popover' }, foreign)
            : h(OverlayLayer, { presentation: 'popover' }, foreign),
        ),
      ),
    );
    await new Promise((r) => setTimeout(r, 20));
  });
  await act(async () => {
    await new Promise((r) => setTimeout(r, 20));
  });
  expect(host.querySelector('[aria-label="显示公司历史"]')).not.toBeNull();
  expect(document.querySelector('[data-foreign] [aria-label="显示公司历史"]')).toBeNull();
});
