import type { ReactNode } from 'react';
import { create } from 'zustand';
import { useToast } from '../components/Toast';

export const useConnectionTestTasks = create<{ running: ReadonlySet<string> }>(() => ({
  running: new Set(),
}));

export function connectionTestKey(kind: 'llm' | 'tts' | 'rkey' | 'sse', id: string): string {
  return JSON.stringify([kind, id]);
}

type TestResult = {
  detail?: ReactNode;
  action?: { label: string; run: () => void };
};

/** 只保存非敏感任务身份；输入快照由调用方捕获，不依赖编辑器的挂载状态。 */
export async function runConnectionTest(
  key: string,
  label: string,
  run: () => Promise<TestResult>,
): Promise<void> {
  if (useConnectionTestTasks.getState().running.has(key)) return;
  useConnectionTestTasks.setState((state) => ({ running: new Set(state.running).add(key) }));
  const toast = useToast.getState();
  const id = toast.push({
    tone: 'info',
    loading: true,
    title: `正在测试连接 · ${label}`,
    ttl: 0,
    dismissible: false,
  });
  try {
    const result = await run();
    toast.update(id, {
      tone: 'success',
      durationKind: 'success',
      loading: false,
      dismissible: true,
      title: `测试通过 · ${label}`,
      detail: result.detail,
      action: result.action,
    });
  } catch (error) {
    toast.update(id, {
      tone: 'error',
      durationKind: 'failure',
      loading: false,
      dismissible: true,
      title: `测试失败 · ${label}`,
      detail: error instanceof Error ? error.message : String(error),
    });
  } finally {
    useConnectionTestTasks.setState((state) => {
      const running = new Set(state.running);
      running.delete(key);
      return { running };
    });
  }
}
