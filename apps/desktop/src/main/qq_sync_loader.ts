import { pathToFileURL } from 'node:url';
import { verifyQqSync } from '@weq/native/qq-sync.mjs';
import type { HostBridge } from '@weq/service';

export interface QqSyncRuntime {
  enqueue: NonNullable<HostBridge['syncPrivateTextSent']>;
  stop(): Promise<void>;
}

interface QqSyncModule {
  startQqSync(options: {
    root: string;
    report(event: Record<string, unknown>): void;
  }): QqSyncRuntime;
}

/** 私仓运行产物先校验，再按文件 URL 加载。 */
export async function loadQqSync(root: string): Promise<QqSyncModule> {
  return import(pathToFileURL(verifyQqSync(root)).href);
}
