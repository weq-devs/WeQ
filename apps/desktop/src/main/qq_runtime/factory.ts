import { randomBytes, randomUUID } from 'node:crypto';
import { hostname, release } from 'node:os';
import type { Platform } from '@weq/platform';
import { QQRuntimeManager, type QQRuntimeDependencies } from '@weq/service';
import { resolveChildWorkerPath } from '../worker_path';
import { discoverManagedQQInstallation } from './installation';
import { createQQKernelProcessBackend } from './process_backend';

export interface DesktopQQRuntimeOptions {
  platform: Platform;
  dataRoot: string;
  moduleDir: string;
  resourcesPath?: string;
  execPath?: string;
  inspectExternal: QQRuntimeDependencies['inspectExternal'];
  onObserverError?: QQRuntimeDependencies['onObserverError'];
}

/** 路径由主进程提供；渲染进程不能指定要载入的原生模块或启动程序。 */
export function createDesktopQQRuntime(options: DesktopQQRuntimeOptions): QQRuntimeManager {
  return new QQRuntimeManager({
    createId: randomUUID,
    inspectExternal: options.inspectExternal,
    onObserverError: options.onObserverError,
    createManaged: async ({ instanceId, expectedUin, signal }) => {
      const installation = await discoverManagedQQInstallation(options.platform);
      const worker = resolveChildWorkerPath(
        'qqKernelWorker.mjs',
        options.moduleDir,
        options.resourcesPath,
      );
      return createQQKernelProcessBackend(
        {
          instanceId,
          nonce: randomBytes(32).toString('hex'),
          wrapperPath: installation.wrapperPath,
          dataRoot: options.dataRoot,
          client: installation.client,
          device: { hostName: hostname(), osVersion: release() },
          ...(expectedUin ? { expectedUin } : {}),
        },
        worker,
        options.execPath,
        signal,
      );
    },
  });
}
