import { afterEach, expect, it, vi } from 'vitest';
import {
  ConversationFirstPage,
  firstPageKey,
  type FirstPageTarget,
} from '../src/renderer/src/lib/conversationFirstPage';
import type { MessagePageStage } from '../src/shared/message_read';

type Row = { msgSeq: string };
const target = (conv: string): FirstPageTarget => ({ kind: 'group', conv, limit: 25 });
const row = (msgSeq: string) => ({ msgSeq });
afterEach(() => vi.useRealTimers());
function fixture() {
  vi.useFakeTimers();
  const cached = new Set<string>();
  let version = 0;
  const reads: {
    target: FirstPageTarget;
    stage: (value: MessagePageStage<Row>) => void;
    error: (error: unknown) => void;
    stop: ReturnType<typeof vi.fn>;
  }[] = [];
  const store = vi.fn((value: FirstPageTarget) => {
    cached.add(firstPageKey(value));
  });
  const promote = vi.fn();
  const cancel = vi.fn();
  const loader = new ConversationFirstPage<Row>({
    owner: 'synthetic-owner',
    fresh: (value) => cached.has(firstPageKey(value)),
    valid: () => true,
    version: () => version,
    store,
    promote,
    cancel,
    subscribe(value, _window, _prefetch, stage, error) {
      const read = { target: value, stage, error, stop: vi.fn() };
      reads.push(read);
      return read.stop;
    },
  });
  return {
    loader,
    reads,
    store,
    promote,
    cancel,
    change: () => {
      version++;
    },
  };
}
it('未打开会话的在途预取被点击接用，立即交付已有正文，不重复读取', async () => {
  const f = fixture();
  f.loader.activate(true, '');
  f.loader.setVisible([target('a'), target('b'), target('c'), target('d')]);
  await vi.advanceTimersByTimeAsync(300);
  expect(f.reads).toHaveLength(1);
  f.reads[0]!.stage({ rows: [row('2'), row('1')], complete: false });
  const show = vi.fn();
  const result = f.loader.read(target('a'), show);
  expect(show).toHaveBeenCalledWith([row('2'), row('1')]);
  expect(f.promote).toHaveBeenCalledOnce();
  expect(f.reads).toHaveLength(1);
  f.reads[0]!.stage({ rows: [row('3'), row('2')], complete: true });
  expect(await result).toEqual([row('3'), row('2')]);
  expect(f.store).toHaveBeenCalledOnce();
  f.loader.dispose();
});
it('可见目标再多也只预取三个，单个在途；来源版本改变后不把旧结果存入缓存', async () => {
  const f = fixture();
  f.loader.activate(true, '');
  f.loader.setVisible(Array.from({ length: 100 }, (_, i) => target(String(i))));
  for (let i = 0; i < 3; i++) {
    await vi.advanceTimersByTimeAsync(300);
    expect(f.reads).toHaveLength(i + 1);
    f.reads[i]!.stage({ rows: [row('1')], complete: true });
    await Promise.resolve();
  }
  await vi.advanceTimersByTimeAsync(1000);
  expect(f.reads).toHaveLength(3);
  f.loader.hint(target('new'));
  await vi.advanceTimersByTimeAsync(80);
  f.change();
  f.reads[3]!.stage({ rows: [row('2')], complete: true });
  expect(f.store).toHaveBeenCalledTimes(3);
  f.loader.dispose();
});
it('悬停目标优先，切换会话和销毁取消旧读取，迟到数据不覆盖新窗口', async () => {
  const f = fixture();
  f.loader.activate(true, '');
  f.loader.setVisible([target('a')]);
  await vi.advanceTimersByTimeAsync(300);
  f.loader.hint(target('b'));
  await vi.advanceTimersByTimeAsync(80);
  expect(f.reads[0]!.stop).toHaveBeenCalledOnce();
  const shown = vi.fn();
  const old = f.loader.read(target('b'), shown);
  const failure = expect(old).rejects.toMatchObject({ name: 'AbortError' });
  f.loader.activate(true, 'group:c');
  await failure;
  f.reads[1]!.stage({ rows: [row('99')], complete: true });
  expect(shown).not.toHaveBeenCalled();
  expect(f.store).not.toHaveBeenCalled();
  f.loader.dispose();
  await vi.advanceTimersByTimeAsync(1000);
  expect(f.reads).toHaveLength(2);
});
it('复用本地正文收尾，连接中断能够结束在途读取并允许调用方回退', async () => {
  const f = fixture();
  const page = f.loader.read(target('a'), vi.fn());
  f.reads[0]!.stage({ rows: [row('1')], complete: false });
  f.reads[0]!.stage({ rows: [], complete: true, reuseLocal: true });
  expect(await page).toEqual([row('1')]);
  await Promise.resolve();
  const next = f.loader.read(target('b'), vi.fn());
  const rejected = expect(next).rejects.toMatchObject({ name: 'AbortError' });
  f.loader.interrupt();
  await rejected;
  f.loader.dispose();
});
