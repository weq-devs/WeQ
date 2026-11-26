import { join } from 'node:path';
import { setTimeout as pause } from 'node:timers/promises';
import { processIsAlive, readCache } from './dev-prepare.mjs';

export async function openRunningDevelopmentWindow(lock, { pid, windowSession }, log) {
  if (windowSession === null)
    throw new Error('WeQ 正在准备开发环境。准备完成后，请再次运行启动脚本。');
  if (typeof windowSession !== 'string' || !/^[a-f0-9-]{36}$/.test(windowSession))
    throw new Error('当前 WeQ 开发版由旧启动器启动。请退出开发版，再运行启动脚本一次。');

  const ownerPath = join(lock, 'owner.json');
  const endpointPath = join(lock, `window-${windowSession}.json`);
  const deadline = Date.now() + 20 * 60_000;
  let reportedWaiting = false;
  let callControl;
  while (Date.now() < deadline) {
    const owner = await readCache(ownerPath);
    if (owner?.pid !== pid || owner.windowSession !== windowSession || !processIsAlive(pid))
      throw new Error('WeQ 开发版已退出。请查看原启动窗口，或再次运行启动脚本。');

    const endpoint = await readCache(endpointPath);
    if (endpoint) {
      if (!callControl) {
        const { tsImport } = await import('tsx/esm/api');
        ({ callControl } = await tsImport(
          '../apps/desktop/src/main/desktop_services/control.ts',
          import.meta.url,
        ));
      }
      try {
        if ((await callControl(endpoint, 'new-window')) === true) {
          log('已打开新的 WeQ 账号选择窗口');
          return;
        }
      } catch (error) {
        // 仅在连接未建立时重试。已发送的请求可能已经创建窗口。
        if (error.cause?.code !== 'ECONNREFUSED')
          throw new Error(`无法新建 WeQ 窗口：${error.message}`, { cause: error });
      }
    }
    if (!reportedWaiting) {
      log('WeQ 正在启动，启动后会打开新窗口');
      reportedWaiting = true;
    }
    await pause(250);
  }
  throw new Error('等待 WeQ 开发版启动超时，请查看原启动窗口。');
}
