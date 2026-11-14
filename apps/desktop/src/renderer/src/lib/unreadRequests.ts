import type { inferRouterInputs } from '@trpc/server';
import type { AppRouter } from '../../../shared/router';
import { UNREAD_BATCH_SIZE } from './unreadRefresh';
import { queryInputBatches } from './queryInputBatches';

export { HTTP_BATCH_MAX_URL_LENGTH } from './queryInputBatches';
export type UnreadRequest = inferRouterInputs<AppRouter>['account']['getUnreadInfos'];

/** tRPC v10 按完整输入拆请求，不会继续拆单次查询内的 targets。 */
export function unreadRequestBatches(input: UnreadRequest, web: boolean): UnreadRequest[] {
  return queryInputBatches(
    'account.getUnreadInfos',
    input.targets,
    (targets) => ({ ...input, targets }),
    web,
    UNREAD_BATCH_SIZE,
  );
}
