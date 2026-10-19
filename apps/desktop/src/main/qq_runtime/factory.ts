import { randomBytes, randomUUID } from 'node:crypto';
import { hostname, release } from 'node:os';
import { realpath } from 'node:fs/promises';
import { dirname, join, relative } from 'node:path';
import { darwinAccountDirName, type Platform } from '@weq/platform';
import { resolveNtHelperPath } from '@weq/native';
import {
  ManagedQQSsoSession,
  QQRuntimeManager,
  accountConfigId,
  claimManagedQQProcess,
  type QQRuntimeDependencies,
} from '@weq/service';
import { resolveChildWorkerPath } from '../worker_path';
import { discoverManagedQQInstallation } from './installation';
import { createQQKernelProcessBackend } from './process_backend';
import type { ManagedQQAccountSource } from './managed_account';

export interface DesktopQQRuntimeOptions {
  platform: Platform;
  dataRoot: string;
  moduleDir: string;
  resourcesPath?: string;
  execPath?: string;
  inspectExternal: QQRuntimeDependencies['inspectExternal'];
  onObserverError?: QQRuntimeDependencies['onObserverError'];
  openAccount?(source: ManagedQQAccountSource): Promise<{ database: boolean; push: boolean }>;
  expectedConfigId?(): string | null;
}

/** 路径由主进程提供；渲染进程不能指定要载入的原生模块或启动程序。 */
export function createDesktopQQRuntime(options: DesktopQQRuntimeOptions): QQRuntimeManager {
  return new QQRuntimeManager({
    createId: randomUUID,
    inspectExternal: options.inspectExternal,
    onObserverError: options.onObserverError,
    createManaged: async ({ instanceId, expectedUin, signal }) => {
      const expectedConfigId = options.expectedConfigId?.() ?? null;
      const installation = await discoverManagedQQInstallation(options.platform);
      const worker = resolveChildWorkerPath(
        'qqKernelWorker.mjs',
        options.moduleDir,
        options.resourcesPath,
      );
      let session: ManagedQQSsoSession | null = null;
      const releaseSession = async () => {
        const previous = session;
        await previous?.close();
        if (session === previous) session = null;
      };
      const backend = await createQQKernelProcessBackend(
        {
          instanceId,
          nonce: randomBytes(32).toString('hex'),
          wrapperPath: installation.wrapperPath,
          dataRoot: options.dataRoot,
          ntHelperPath: resolveNtHelperPath(),
          client: installation.client,
          device: { hostName: hostname(), osVersion: release() },
          ...(expectedUin ? { expectedUin } : {}),
        },
        worker,
        options.execPath,
        signal,
        {
          release: releaseSession,
          accept: async ({ pid, uin, uid, guid, material }, current) => {
            await releaseSession();
            if (current.aborted) return false;
            session = new ManagedQQSsoSession(options.platform.native.ntHelper, {
              pid,
              wrapperPath: installation.wrapperPath,
              majorPath: installation.majorPath,
              identity: {
                uin,
                uid,
                guid,
                subAppId: Number(installation.client.appId),
                clientVersion: installation.client.version,
              },
            });
            return session.register(material, current);
          },
          ...(options.openAccount
            ? {
                openDatabase: async ({ pid, uin, uid, guid, dbPath, dbKey }, current) => {
                  if (current.aborted || !session?.isReady())
                    return { database: false, push: false };
                  const [root, database] = await Promise.all([
                    realpath(options.dataRoot),
                    realpath(dbPath),
                  ]);
                  const path = relative(root, database);
                  if (
                    expectedConfigId &&
                    accountConfigId(uin, dirname(dirname(database))) !== expectedConfigId
                  )
                    throw new Error('托管数据源与选定配置不匹配');
                  if (
                    path !== join('nt_db', 'nt_msg.db') &&
                    path !== join(darwinAccountDirName(uid), 'nt_db', 'nt_msg.db')
                  )
                    throw new Error('托管数据库归属不匹配');
                  const verified = await options.platform.native.ntHelper.testDatabaseKey(
                    database,
                    dbKey,
                  );
                  if (current.aborted || !session?.isReady())
                    return { database: false, push: false };
                  if (
                    !verified.success ||
                    !verified.pageHmacAlgorithm ||
                    !verified.kdfHmacAlgorithm
                  )
                    throw new Error('托管数据库密钥验证失败');
                  return options.openAccount!({
                    instanceId,
                    pid,
                    uin,
                    uid,
                    guid,
                    dataRoot: root,
                    dbPath: database,
                    dbKey,
                    algo: {
                      pageHmacAlgorithm: verified.pageHmacAlgorithm,
                      kdfHmacAlgorithm: verified.kdfHmacAlgorithm,
                    },
                    wrapperPath: installation.wrapperPath,
                    majorPath: installation.majorPath,
                    version: installation.client.version,
                    signal: current,
                    isSsoReady: () => session?.isReady() === true,
                  });
                },
              }
            : {}),
        },
      );
      if (backend.isRunning()) {
        try {
          const releaseOwnership = claimManagedQQProcess(
            options.platform.native.ntHelper,
            backend.pid,
            () => session?.readTransportMaterial() ?? null,
          );
          backend.subscribe((event) => {
            if (event.type === 'exit') releaseOwnership();
          });
        } catch (error) {
          await backend.close();
          throw error;
        }
      }
      return backend;
    },
  });
}
