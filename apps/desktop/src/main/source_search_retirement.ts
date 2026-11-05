import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { resolveNtHelperPath } from '@weq/native';
import { runOwnedChild } from '@weq/service';
import type { UnifiedSearchServiceOptions } from '@weq/service';
import { resolveChildWorkerPath } from './worker_path';
import { sourceSearchCommand } from './source_search_disk_guard';
import {
  searchRetirementRequest,
  searchRetirementResponse,
} from './source_search_retirement_protocol';

export function createSearchIndexRetirement(
  root: string,
): NonNullable<UnifiedSearchServiceOptions['retireSearchIndex']> {
  return async (source, sourcePath, signal) => {
    const worker = resolveChildWorkerPath(
      'sourceSearchRetirementWorker.mjs',
      dirname(fileURLToPath(import.meta.url)),
    );
    const request = searchRetirementRequest.parse({
      root,
      table: source === 'group' ? 'group_msg_fts' : 'buddy_msg_fts',
      sourcePath,
    });
    const nativeRoot = dirname(dirname(dirname(resolveNtHelperPath())));
    const command = sourceSearchCommand(process.execPath, [worker], [root, sourcePath]);
    const result = await runOwnedChild(command.executable, command.args, {
      input: JSON.stringify(request),
      signal,
      timeoutMs: 30000,
      maxOutputBytes: 65536,
      env: { ...process.env, ELECTRON_RUN_AS_NODE: '1', WEQ_NATIVE_DIR: nativeRoot },
    });
    if (result.code !== 0 || result.signal) return false;
    const response = searchRetirementResponse.parse(JSON.parse(result.stdout));
    return (
      response.status === 'retired' ||
      response.status === 'absent' ||
      response.status === 'unrecognized'
    );
  };
}
