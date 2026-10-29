import { BackgroundTaskRegistry, type BackgroundTask } from '../shared/background_task';

export const backgroundTasks = new BackgroundTaskRegistry();

export function taskError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export async function runBackgroundTask<T>(
  input: Pick<BackgroundTask, 'kind' | 'name' | 'scope'>,
  work: (id: string) => Promise<T> | T,
  result: (
    value: T,
  ) => Partial<Pick<BackgroundTask, 'status' | 'statusLabel' | 'note' | 'details'>> = () => ({}),
): Promise<T> {
  const id = backgroundTasks.start(input);
  try {
    const value = await work(id);
    const { status = 'completed', ...patch } = result(value);
    backgroundTasks.finish(id, status === 'running' ? 'paused' : status, patch);
    return value;
  } catch (error) {
    backgroundTasks.finish(id, 'failed', { note: taskError(error) });
    backgroundTasks.setActions(id, []);
    throw error;
  }
}
