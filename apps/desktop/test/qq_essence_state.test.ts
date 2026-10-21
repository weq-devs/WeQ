import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  essenceActive,
  essenceKey,
  essenceSequences,
  essenceSource,
  essenceRefreshInterval,
  ESSENCE_RECEIPT_TTL,
  useQQEssence,
} from '../src/renderer/src/state/qqEssence';

const source = essenceSource({ expectedAccountUin: '10001', expectedAccountConfigId: 'source-a' });
const target = { groupId: 123, sequence: 42, random: 77 };
const key = essenceKey(source, 123, 42);
afterEach(() => {
  useQQEssence.setState({ receipts: {} });
  vi.useRealTimers();
});
function receive(enable: boolean) {
  const operation = useQQEssence.getState().begin(source, target)!;
  useQQEssence.getState().finish(key, operation, enable, { state: 'accepted' });
}
describe('精华操作共享回执', () => {
  it('容量有界，达到上限不驱逐在途锁，有完成项时优先回收它', () => {
    const store = useQQEssence.getState();
    const operations = Array.from({ length: 256 }, (_, sequence) =>
      store.begin(source, { ...target, sequence: sequence + 1 }),
    );
    expect(store.begin(source, { ...target, sequence: 999 })).toBeNull();
    const firstKey = essenceKey(source, 123, 1);
    expect(useQQEssence.getState().receipts[firstKey].pending).toBe(operations[0]);
    store.finish(firstKey, operations[0]!, true, { state: 'accepted' });
    expect(store.begin(source, { ...target, sequence: 999 })).not.toBeNull();
    expect(Object.keys(useQQEssence.getState().receipts)).toHaveLength(256);
    expect(useQQEssence.getState().receipts[firstKey]).toBeUndefined();
  });
  it('回读逐渐退避，一分钟后停止，其他群不启动轮询', () => {
    vi.useFakeTimers();
    vi.setSystemTime(1000);
    receive(true);
    const receipts = useQQEssence.getState().receipts;
    expect(essenceRefreshInterval(receipts, source, 123, 1000)).toBe(1000);
    expect(essenceRefreshInterval(receipts, source, 123, 5000)).toBe(2000);
    expect(essenceRefreshInterval(receipts, source, 123, 16_000)).toBe(5000);
    expect(essenceRefreshInterval(receipts, source, 123, 40_000)).toBe(10_000);
    expect(essenceRefreshInterval(receipts, source, 123, 1000 + ESSENCE_RECEIPT_TTL)).toBe(false);
    expect(essenceRefreshInterval(receipts, source, 456, 1000)).toBe(false);
  });
  it('只有受理或确认才翻转，等待和不确定结果不覆盖读取状态', () => {
    const store = useQQEssence.getState();
    const operation = store.begin(source, target)!;
    expect(essenceActive(useQQEssence.getState().receipts, source, 123, 42, true)).toBe(true);
    store.finish(key, operation, false, { state: 'unconfirmed' });
    expect(essenceActive(useQQEssence.getState().receipts, source, 123, 42, true)).toBe(true);
    receive(false);
    expect(essenceSequences(useQQEssence.getState().receipts, source, 123, ['42', '43'])).toEqual([
      '43',
    ]);
    receive(true);
    expect(essenceSequences(useQQEssence.getState().receipts, source, 123, [])).toEqual(['42']);
  });
  it('同一消息只允许一个在途操作，过期回调不能结束下一次操作', () => {
    const store = useQQEssence.getState();
    const first = store.begin(source, target)!;
    expect(store.begin(source, target)).toBeNull();
    store.finish(key, first);
    const next = store.begin(source, target)!;
    store.finish(key, first, false, { state: 'accepted' });
    expect(useQQEssence.getState().receipts[key].pending).toBe(next);
  });
  it('同号不同配置、群或序号互不串用，重试失败保留上次回执', () => {
    receive(true);
    const other = essenceSource({
      expectedAccountUin: '10001',
      expectedAccountConfigId: 'source-b',
    });
    const receipts = useQQEssence.getState().receipts;
    expect(essenceActive(receipts, other, 123, 42, false)).toBe(false);
    expect(essenceActive(receipts, source, 456, 42, false)).toBe(false);
    expect(essenceActive(receipts, source, 123, 43, false)).toBe(false);
    const retry = useQQEssence.getState().begin(source, target)!;
    useQQEssence.getState().finish(key, retry);
    expect(essenceActive(useQQEssence.getState().receipts, source, 123, 42, false)).toBe(true);
  });
  it('仅本地与在线均完成写后回读且一致才消除回执，旧缓存不确认', () => {
    vi.useFakeTimers();
    vi.setSystemTime(1000);
    receive(false);
    const store = useQQEssence.getState();
    store.reconcile(source, 123, [], 999, [], 999);
    expect(useQQEssence.getState().receipts[key]).toBeDefined();
    store.reconcile(source, 123, [], 1001, ['42'], 1001);
    expect(useQQEssence.getState().receipts[key]).toBeDefined();
    store.reconcile(source, 123, [], 1001, [], 1001);
    expect(useQQEssence.getState().receipts[key]).toBeUndefined();
  });
  it('回执有界过期，之后恢复读取结果；在途锁不被回收', () => {
    vi.useFakeTimers();
    vi.setSystemTime(1000);
    receive(false);
    const pending = useQQEssence.getState().begin(source, { ...target, sequence: 43 });
    vi.setSystemTime(1000 + ESSENCE_RECEIPT_TTL);
    expect(essenceActive(useQQEssence.getState().receipts, source, 123, 42, true)).toBe(true);
    useQQEssence.getState().reconcile(source, 123, [], 0, [], 0);
    expect(useQQEssence.getState().receipts[key]).toBeUndefined();
    expect(useQQEssence.getState().receipts[essenceKey(source, 123, 43)].pending).toBe(pending);
  });
});
