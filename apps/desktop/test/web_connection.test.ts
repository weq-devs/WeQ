import { beforeEach, expect, it } from 'vitest';
import { useWebConnection } from '../src/renderer/src/state/webConnection';

beforeEach(() => {
  useWebConnection.setState({ status: 'connecting', connectedBefore: false, recovery: 0 });
});

it('首次连接不触发补查，断线后重连只触发一次', () => {
  const { connected, disconnected } = useWebConnection.getState();
  connected();
  expect(useWebConnection.getState().recovery).toBe(0);
  disconnected();
  expect(useWebConnection.getState().status).toBe('reconnecting');
  disconnected();
  connected();
  connected();
  expect(useWebConnection.getState().recovery).toBe(1);
  expect(useWebConnection.getState().status).toBe('connected');
});

it('连接尚未成功时失败不算恢复', () => {
  const { connected, disconnected } = useWebConnection.getState();
  disconnected();
  expect(useWebConnection.getState().status).toBe('connecting');
  connected();
  expect(useWebConnection.getState().recovery).toBe(0);
});
