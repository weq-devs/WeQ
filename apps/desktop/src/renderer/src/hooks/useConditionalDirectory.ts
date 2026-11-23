import {
  useQuery,
  useQueryClient,
  type QueryKey,
  type UseQueryOptions,
} from '@tanstack/react-query';
import type { ConditionalDirectory } from '../../../shared/content_version';
import type { QQWriteBinding } from './useQQWriteSession';
import { readDirectory } from '../lib/conditionalCache';

export function useConditionalDirectory<T extends object>(
  key: QueryKey,
  name: ConditionalDirectory,
  binding: QQWriteBinding | null,
  load: () => Promise<T>,
  options: Pick<
    UseQueryOptions<T, Error>,
    | 'enabled'
    | 'staleTime'
    | 'refetchOnMount'
    | 'refetchOnWindowFocus'
    | 'refetchOnReconnect'
    | 'keepPreviousData'
  >,
  page?: { limit: number },
) {
  const cache = useQueryClient();
  return useQuery<T, Error>({
    ...options,
    queryKey: key,
    queryFn: () => readDirectory(name, binding, cache.getQueryData<T>(key), load, page),
  });
}
