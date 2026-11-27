import type { ReactNode } from 'react';
import { create } from 'zustand';

type TestResult = {
  detail?: ReactNode;
  action?: { label: string; run: () => void };
};
type CompletedTest = TestResult & { label: string; failed: boolean };

export const useConnectionTestTasks = create<{
  running: ReadonlySet<string>;
  results: ReadonlyMap<string, CompletedTest>;
}>(() => ({
  running: new Set(),
  results: new Map(),
}));

export function connectionTestKey(kind: 'llm' | 'tts' | 'rkey' | 'sse', id: string): string {
  return JSON.stringify([kind, id]);
}

/** 同一配置的测试由原操作行显示，离开编辑器后仍能查看本次结果。 */
export async function runConnectionTest(
  key: string,
  label: string,
  run: () => Promise<TestResult>,
): Promise<void> {
  if (useConnectionTestTasks.getState().running.has(key)) return;
  useConnectionTestTasks.setState((state) => ({ running: new Set(state.running).add(key) }));
  let result: CompletedTest;
  try {
    result = { ...(await run()), label, failed: false };
  } catch (error) {
    result = {
      label,
      failed: true,
      detail: error instanceof Error ? error.message : String(error),
    };
  }
  useConnectionTestTasks.setState((state) => {
    const running = new Set(state.running);
    running.delete(key);
    const results = new Map(state.results);
    results.delete(key);
    results.set(key, result);
    if (results.size > 64) results.delete(results.keys().next().value!);
    return { running, results };
  });
}
