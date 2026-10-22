import { beforeEach, expect, it, vi } from 'vitest';
import { useToast } from '../src/renderer/src/components/Toast';
import {
  connectionTestKey,
  runConnectionTest,
  useConnectionTestTasks,
} from '../src/renderer/src/lib/connectionTestTask';

beforeEach(() => {
  useToast.setState({
    toasts: [],
    leaving: [],
    seq: 0,
    durations: { successSeconds: 2, failureSeconds: 5 },
  });
  useConnectionTestTasks.setState({ running: new Set() });
});

it('进行中常驻横幅，同一目标防重复，完成后原地按成功设置计时', async () => {
  let finish!: (result: { detail: string }) => void;
  const run = vi.fn(
    () =>
      new Promise<{ detail: string }>((resolve) => {
        finish = resolve;
      }),
  );
  const key = connectionTestKey('llm', 'synthetic-a');
  const pending = runConnectionTest(key, '合成提供方 · 合成模型', run);
  expect(useConnectionTestTasks.getState().running.has(key)).toBe(true);
  const initial = useToast.getState().toasts[0]!;
  expect(initial).toMatchObject({ loading: true, ttl: 0, dismissible: false });
  await runConnectionTest(key, '重复点击', run);
  expect(run).toHaveBeenCalledOnce();
  expect(useToast.getState().toasts).toHaveLength(1);
  finish({ detail: '合成正常回复' });
  await pending;
  expect(useToast.getState().toasts[0]).toMatchObject({
    id: initial.id,
    tone: 'success',
    loading: false,
    durationKind: 'success',
    ttl: 2000,
    dismissible: true,
    detail: '合成正常回复',
  });
  expect(useConnectionTestTasks.getState().running.size).toBe(0);
});

it.each([Error('合成 HTTP 400'), '合成传输错误'])(
  '异常 %s 只更新失败横幅并释放任务，不抛未处理拒绝',
  async (error) => {
    await expect(
      runConnectionTest(connectionTestKey('tts', 'synthetic-a'), '合成语音', async () => {
        throw error;
      }),
    ).resolves.toBeUndefined();
    expect(useToast.getState().toasts[0]).toMatchObject({
      tone: 'error',
      loading: false,
      durationKind: 'failure',
      ttl: 5000,
      detail: error instanceof Error ? error.message : error,
    });
    expect(useConnectionTestTasks.getState().running.size).toBe(0);
  },
);

it('不同提供方与同 ID 不同类型并发，各自结果和横幅互不覆盖', async () => {
  const resolve: Array<(result: { detail: string }) => void> = [];
  const keys = [
    connectionTestKey('llm', 'a'),
    connectionTestKey('llm', 'b'),
    connectionTestKey('tts', 'a'),
  ];
  const tasks = keys.map((key, index) =>
    runConnectionTest(
      key,
      `合成任务 ${index}`,
      () =>
        new Promise((done) => {
          resolve.push(done);
        }),
    ),
  );
  expect(useConnectionTestTasks.getState().running.size).toBe(3);
  resolve[1]!({ detail: 'B 先完成' });
  await tasks[1];
  expect(useConnectionTestTasks.getState().running.has(keys[0]!)).toBe(true);
  expect(useToast.getState().toasts.map((toast) => toast.loading)).toEqual([true, false, true]);
  resolve[0]!({ detail: 'A 完成' });
  resolve[2]!({ detail: '语音完成' });
  await Promise.all(tasks);
  expect(useToast.getState().toasts.map((toast) => toast.detail)).toEqual([
    'A 完成',
    'B 先完成',
    '语音完成',
  ]);
  expect(useConnectionTestTasks.getState().running.size).toBe(0);
});

it('失败不自动关闭时沿用失败偏好，成功任务保留结果操作', async () => {
  useToast.getState().setDurations({ successSeconds: 3, failureSeconds: -1 });
  const play = vi.fn();
  await runConnectionTest(connectionTestKey('tts', 'a'), '合成语音', async () => ({
    detail: '已生成',
    action: { label: '播放样例语音', run: play },
  }));
  useToast.getState().toasts[0]!.action!.run();
  expect(play).toHaveBeenCalledOnce();
  await runConnectionTest(connectionTestKey('rkey', 'a'), '合成 RKEY', async () => {
    throw Error('合成失败');
  });
  expect(useToast.getState().toasts[1]).toMatchObject({ tone: 'error', ttl: 0, dismissible: true });
});
