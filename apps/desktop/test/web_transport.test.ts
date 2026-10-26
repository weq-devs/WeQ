import { expect, it, vi } from 'vitest';
import { useWebConnection } from '../src/renderer/src/state/webConnection';

const mocks = vi.hoisted(() => ({
  socket: vi.fn(),
  batch: vi.fn(),
  split: vi.fn(),
}));
vi.mock('@trpc/client', () => ({
  createWSClient: mocks.socket,
  httpBatchLink: mocks.batch,
  httpLink: vi.fn(),
  splitLink: mocks.split,
  wsLink: vi.fn(),
}));

it('传输层通过实际连接回调报告恢复，并限制 HTTP 批次 URL 长度', async () => {
  useWebConnection.setState({ status: 'connecting', connectedBefore: false, recovery: 0 });
  const { createLinks } = await import('../src/renderer/src/trpc/transport.web');
  const options = mocks.socket.mock.calls[0]![0];
  expect(options.url).toMatch(/\/trpc-ws$/);
  options.onOpen();
  expect(useWebConnection.getState().status).toBe('connected');
  options.onClose({ code: 1006 });
  expect(useWebConnection.getState().status).toBe('reconnecting');
  options.onOpen();
  expect(useWebConnection.getState().recovery).toBe(1);
  createLinks();
  expect(mocks.batch.mock.calls[0]![0]).toMatchObject({ url: '/trpc', maxURLLength: 2048 });
  const { condition } = mocks.split.mock.calls.at(-1)![0];
  expect(condition({ type: 'subscription' })).toBe(true);
  expect(condition({ type: 'mutation' })).toBe(false);
  expect(condition({ type: 'query' })).toBe(false);
});
