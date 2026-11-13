import { act, createElement as h } from 'react';
import { createRoot } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { afterEach, expect, it, vi } from 'vitest';
import { ContactFieldHistoryProvider } from '../src/renderer/src/components/contactProfile/ContactFieldHistory';
import { ContactRow } from '../src/renderer/src/components/contactProfile/ContactRow';
type Row = { id: number; first_at: number; last_at: number; value: unknown };
type Page = { rows: Row[]; nextBefore: number | null };
const rpc = vi.hoisted(() => ({
  summary: vi.fn(async () => ({ fields: ['photos'], pending: false })),
  versions: vi.fn<(input: { before?: number }) => Promise<Page>>(),
  version: vi.fn<() => Promise<{ value: unknown; observedValue?: unknown }>>(),
}));
vi.mock('../src/renderer/src/components/MediaSaveControls', () => ({
  MediaSourceSave: () => null,
}));
vi.mock('../src/renderer/src/hooks/useQQWriteSession', () => ({
  useQQWriteSession: () => ({
    binding: { expectedAccountUin: '10001', expectedAccountConfigId: 'fixture' },
  }),
}));
vi.mock('../src/renderer/src/trpc/client', () => ({
  client: {
    account: {
      contactMetrics: {
        history: {
          fieldSummary: { query: rpc.summary },
          fieldVersions: { query: rpc.versions },
          version: { query: rpc.version },
        },
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
  vi.resetAllMocks();
  rpc.summary.mockResolvedValue({ fields: ['photos'], pending: false });
});
const row = (id: number, value: unknown): Row => ({
  id,
  value,
  first_at: id * 1000,
  last_at: id * 1000,
});
async function settle() {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 30));
  });
}
async function open() {
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host),
    cache = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  opened.push({ root, cache });
  await act(async () =>
    root.render(
      h(
        QueryClientProvider,
        { client: cache },
        h(
          ContactFieldHistoryProvider,
          { entity: 'friend:u_peer' },
          h(ContactRow, { label: '精选照片', value: '当前照片' }),
        ),
      ),
    ),
  );
  await settle();
  await settle();
  await act(async () =>
    host.querySelector<HTMLButtonElement>('[aria-label="显示精选照片历史"]')!.click(),
  );
  await settle();
  await settle();
  return document.querySelector<HTMLElement>('.weq-field-history-dialog')!;
}
it('照片旧索引按绑定账号、实体与原始版本补回图片；只使用本次返回的照片', async () => {
  rpc.versions.mockResolvedValue({ rows: [row(3, [{ photoId: 'old' }])], nextBefore: null });
  rpc.version.mockResolvedValue({
    value: {
      extInfo: {
        album: [{ photoId: 'other', urls: [{ url: 'https://example.invalid/other.png' }] }],
      },
    },
    observedValue: {
      extInfo: { album: [{ photoId: 'old', urls: [{ url: 'https://example.invalid/old.png' }] }] },
    },
  });
  const dialog = await open();
  expect(rpc.version).toHaveBeenCalledWith({
    entity: 'friend:u_peer',
    id: 3,
    expectedAccountUin: '10001',
    expectedAccountConfigId: 'fixture',
  });
  expect(dialog.querySelector('img')?.src).toContain(
    encodeURIComponent('https://example.invalid/old.png'),
  );
  expect(dialog.querySelector('img')?.src).not.toContain('other.png');
});
it('原始版本补齐失败仍显示照片引用，不使整页历史失败', async () => {
  rpc.versions.mockResolvedValue({ rows: [row(3, [{ photoId: 'old' }])], nextBefore: null });
  rpc.version.mockRejectedValue(new Error('原版本不可用'));
  const dialog = await open();
  expect(dialog.textContent).toContain('仅保存照片引用 old');
  expect(dialog.textContent).not.toContain('历史读取失败');
});
it('后续分页失败保留已加载记录，重试成功后向前追加', async () => {
  rpc.versions
    .mockResolvedValueOnce({ rows: [row(3, [{ photoId: 'newer' }])], nextBefore: 3 })
    .mockRejectedValueOnce(new Error('分页失败'))
    .mockResolvedValueOnce({ rows: [row(2, [{ photoId: 'older' }])], nextBefore: null });
  rpc.version.mockResolvedValue({ value: {} });
  const dialog = await open();
  await act(async () =>
    [...dialog.querySelectorAll<HTMLButtonElement>('button')]
      .find((button) => button.textContent === '加载更多')!
      .click(),
  );
  await settle();
  await settle();
  expect(dialog.textContent).toContain('后续历史读取失败，已加载记录保留');
  expect(dialog.textContent).toContain('仅保存照片引用 newer');
  await act(async () =>
    [...dialog.querySelectorAll<HTMLButtonElement>('button')]
      .find((button) => button.textContent === '重试加载')!
      .click(),
  );
  await settle();
  await settle();
  expect(dialog.textContent).toContain('仅保存照片引用 older');
  expect(dialog.querySelectorAll('.weq-field-records > li')).toHaveLength(2);
});
