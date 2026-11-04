import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { SourceSearchQuery } from '@weq/db';
import { resolveNtHelperPath } from '@weq/native';
import { runOwnedChild } from '@weq/service';
import { sourceSearchRequest, sourceSearchResponse } from './source_search_protocol';
import { resolveChildWorkerPath } from './worker_path';

let running = 0;
/** 搜索 SQL 独立于主进程连接；超时和账号切换只取消本次拥有的进程。 */
export function createSourceSearchQuery(
  options: { workerPath?: string; executable?: string; nativeRoot?: string } = {},
): SourceSearchQuery {
  return async (target, sql, params, purpose, signal) => {
    signal?.throwIfAborted();
    if (running >= 4) throw new Error('搜索读取队列繁忙，请重试');
    const request = sourceSearchRequest.parse({
      target,
      sql,
      params: params.map((value) => (typeof value === 'bigint' ? String(value) : value)),
    });
    const worker =
      options.workerPath ??
      resolveChildWorkerPath('sourceSearchWorker.mjs', dirname(fileURLToPath(import.meta.url)));
    const nativeRoot = options.nativeRoot ?? dirname(dirname(dirname(resolveNtHelperPath())));
    running++;
    try {
      const result = await runOwnedChild(options.executable ?? process.execPath, [worker], {
        input: JSON.stringify(request),
        signal,
        timeoutMs: purpose === 'validation' ? 120000 : 10000,
        maxOutputBytes: 32 * 1024 * 1024,
        env: { ...process.env, ELECTRON_RUN_AS_NODE: '1', WEQ_NATIVE_DIR: nativeRoot },
      });
      if (result.signal) throw new Error('搜索读取进程已退出');
      const response = sourceSearchResponse.parse(JSON.parse(result.stdout));
      if (!response.ok) throw new Error(response.error);
      if (result.code !== 0) throw new Error('搜索读取进程异常退出');
      return response.rows;
    } finally {
      running--;
    }
  };
}
