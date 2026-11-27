// @vitest-environment node
import { beforeEach, expect, it, vi } from 'vitest';
import { useToast } from '../src/renderer/src/components/Toast.shared';
import {
  connectionTestKey,
  runConnectionTest,
  useConnectionTestTasks,
} from '../src/renderer/src/lib/connectionTestTask';

beforeEach(() => {
  useToast.setState({ toasts: [], leaving: [] });
  useConnectionTestTasks.setState({ running: new Set(), results: new Map() });
});

it('相同配置只执行一次测试，结果回到原配置行', async () => {
  let finish!: (result: { detail: string }) => void;
  const run = vi.fn(
    () =>
      new Promise<{ detail: string }>((resolve) => {
        finish = resolve;
      }),
  );
  const key = connectionTestKey('llm', 'fixture');
  const pending = runConnectionTest(key, '合成提供方', run);
  expect(useConnectionTestTasks.getState().running.has(key)).toBe(true);
  await runConnectionTest(key, '重复点击', run);
  expect(run).toHaveBeenCalledOnce();
  finish({ detail: '合成正常回复' });
  await pending;
  expect(useConnectionTestTasks.getState().running.has(key)).toBe(false);
  expect(useConnectionTestTasks.getState().results.get(key)).toMatchObject({
    failed: false,
    detail: '合成正常回复',
  });
  expect(useToast.getState().toasts).toEqual([]);
});

it('同 ID 不同类型的结果互不覆盖，语音样例仍可播放', async () => {
  const play = vi.fn();
  const tts = connectionTestKey('tts', 'a');
  const rkey = connectionTestKey('rkey', 'a');
  await Promise.all([
    runConnectionTest(tts, '合成语音', async () => ({
      action: { label: '播放样例语音', run: play },
    })),
    runConnectionTest(rkey, '合成 RKEY', async () => {
      throw Error('合成错误');
    }),
  ]);
  const { results, running } = useConnectionTestTasks.getState();
  expect(running.size).toBe(0);
  expect(results.get(rkey)).toMatchObject({ failed: true, detail: '合成错误' });
  expect(results.get(tts)).toMatchObject({ failed: false });
  results.get(tts)?.action?.run();
  expect(play).toHaveBeenCalledOnce();
  expect(useToast.getState().toasts).toEqual([]);
});
