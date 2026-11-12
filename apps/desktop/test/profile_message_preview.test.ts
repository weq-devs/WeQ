import { beforeEach, expect, it, vi } from 'vitest';
import { readProfilePreviewPage } from '../src/renderer/src/lib/profileMessagePreview';

const api = vi.hoisted(() => ({
  browseConversation: { query: vi.fn() },
  listLatest: { query: vi.fn() },
  listBefore: { query: vi.fn() },
}));
vi.mock('../src/renderer/src/trpc/client', () => ({ client: { account: api } }));
beforeEach(() => vi.clearAllMocks());

it('本群发言按成员筛选并保留完整消息，短页仍遵从服务端 hasMore 和行号游标', async () => {
  const row = {
    msgId: '9',
    msgSeq: '70',
    elements: [{ elementType: 2, picElement: { fileName: 'fixture.png' } }],
    decoration: { bubbleId: 1 },
  };
  const cursor = { time: 100, rowId: '92' };
  api.browseConversation.query.mockResolvedValueOnce({
    items: [row, { ...row, msgId: '8' }],
    hasMore: true,
    cursor,
  });
  const first = await readProfilePreviewPage({ kind: 'group', conv: '10003', sender: 'u_fixture' });
  expect(first).toEqual({ rows: [{ ...row, msgId: '8' }, row], cursor, hasMore: true });
  expect(api.browseConversation.query).toHaveBeenLastCalledWith({
    kind: 'group',
    conv: '10003',
    filter: { sender: 'u_fixture' },
    cursor: undefined,
    limit: 50,
  });
  api.browseConversation.query.mockResolvedValueOnce({
    items: [],
    hasMore: true,
    cursor: { time: 90, rowId: '12' },
  });
  const next = await readProfilePreviewPage({
    kind: 'group',
    conv: '10003',
    sender: 'u_fixture',
    cursor: first.cursor,
    beforeSeq: '70',
  });
  expect(api.browseConversation.query).toHaveBeenLastCalledWith({
    kind: 'group',
    conv: '10003',
    filter: { sender: 'u_fixture' },
    cursor,
    limit: 50,
  });
  expect(next.hasMore).toBe(true);
  expect(next.cursor).toEqual({ time: 90, rowId: '12' });
  expect(api.listLatest.query).not.toHaveBeenCalled();
  expect(api.listBefore.query).not.toHaveBeenCalled();
});

it('普通预览仍使用最新页和 seq 向前翻页，不混入成员筛选游标', async () => {
  api.listLatest.query.mockResolvedValueOnce(
    Array.from({ length: 50 }, (_, index) => ({ msgId: String(50 - index) })),
  );
  const first = await readProfilePreviewPage({ kind: 'c2c', conv: 'u_fixture' });
  expect(first.rows[0]?.msgId).toBe('1');
  expect(first.hasMore).toBe(true);
  api.listBefore.query.mockResolvedValueOnce([{ msgId: '0' }]);
  expect(await readProfilePreviewPage({ kind: 'c2c', conv: 'u_fixture', beforeSeq: '1' })).toEqual({
    rows: [{ msgId: '0' }],
    hasMore: false,
    cursor: undefined,
  });
  expect(api.listBefore.query).toHaveBeenCalledWith({
    kind: 'c2c',
    conv: 'u_fixture',
    beforeSeq: '1',
    limit: 50,
  });
  expect(api.browseConversation.query).not.toHaveBeenCalled();
});

it('预览失败交给共用界面重试，不换成未筛选的群消息', async () => {
  api.browseConversation.query.mockRejectedValueOnce(new Error('fixture failure'));
  await expect(
    readProfilePreviewPage({ kind: 'group', conv: '10003', sender: 'u_fixture' }),
  ).rejects.toThrow('fixture failure');
  expect(api.listLatest.query).not.toHaveBeenCalled();
});
