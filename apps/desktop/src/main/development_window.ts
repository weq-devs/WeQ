import { writeFileAtomic } from '@weq/service/atomic-write';
import { openControl } from './desktop_services/control';

export async function publishDevelopmentWindow(
  path: string,
  openWindow: () => Promise<boolean>,
): Promise<() => void> {
  const control = await openControl((method) => {
    if (method !== 'new-window') throw new Error('未知开发启动操作。');
    return openWindow();
  });
  try {
    await writeFileAtomic(path, JSON.stringify(control.endpoint));
  } catch (error) {
    control.close();
    throw error;
  }
  return control.close;
}
