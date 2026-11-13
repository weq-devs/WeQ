import type { inferRouterInputs } from '@trpc/server';
import superjson from 'superjson';
import type { AppRouter } from '../../../shared/router';
import { UNREAD_BATCH_SIZE } from './unreadRefresh';

export const HTTP_BATCH_MAX_URL_LENGTH = 2048;
export type UnreadRequest = inferRouterInputs<AppRouter>['account']['getUnreadInfos'];

/** tRPC v10 按完整输入拆请求，不会继续拆单次查询内的 targets。 */
export function unreadRequestBatches(input: UnreadRequest, web: boolean): UnreadRequest[] {
  const batches: UnreadRequest[] = [];
  const fits = (targets: UnreadRequest['targets']) => {
    if (targets.length > UNREAD_BATCH_SIZE) return false;
    if (!web) return true;
    // 与当前 httpBatchLink 的单请求编码一致；实际传输回归验证这份长度契约。
    const encoded = encodeURIComponent(
      JSON.stringify({ 0: superjson.serialize({ ...input, targets }) }),
    );
    return (
      '/trpc/account.getUnreadInfos?batch=1&input='.length + encoded.length <=
      HTTP_BATCH_MAX_URL_LENGTH
    );
  };
  let targets: UnreadRequest['targets'] = [];
  for (const target of input.targets) {
    const next = [...targets, target];
    if (fits(next)) {
      targets = next;
      continue;
    }
    if (targets.length) batches.push({ ...input, targets });
    targets = [target];
    if (!fits(targets)) throw new Error('未读查询的单个会话参数超过传输长度上限');
  }
  if (targets.length) batches.push({ ...input, targets });
  return batches;
}
