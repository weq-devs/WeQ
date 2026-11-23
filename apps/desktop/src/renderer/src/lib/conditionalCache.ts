import { contentVersion, type ConditionalDirectory } from '../../../shared/content_version';
import type { QQWriteBinding } from '../hooks/useQQWriteSession';
import { client } from '../trpc/client';
import { IS_WEB } from './target.shared';

export function cacheProcedureUnsupported(error: unknown): boolean {
  return (error as { data?: { code?: string } } | undefined)?.data?.code === 'NOT_FOUND';
}

export async function readDirectory<T extends object>(
  name: ConditionalDirectory,
  binding: QQWriteBinding | null,
  previous: T | undefined,
  load: () => Promise<T>,
  page?: { limit?: number; cursor?: number },
): Promise<T> {
  if (!IS_WEB || !binding || !previous) return load();
  try {
    const result = await client.remoteCache.directory.query({
      ...binding,
      ...page,
      name,
      knownVersion: contentVersion(previous),
    });
    // The host dispatches by the same allowlisted procedure name as `load`.
    return result.unchanged ? previous : (result.data as T);
  } catch (error) {
    if (!cacheProcedureUnsupported(error)) throw error;
    return load();
  }
}
