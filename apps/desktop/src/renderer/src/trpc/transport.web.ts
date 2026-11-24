/**
 * tRPC transport — browser build.
 *
 * Queries and mutations go over HTTP; the 14 subscriptions ride a single
 * WebSocket (tRPC v10 has no SSE link). `splitLink` routes by operation type.
 *
 * Browsers reload to show login on expiry; Remote verifies the device in place.
 */

import {
  createWSClient,
  httpLink,
  splitLink,
  wsLink,
  unstable_httpBatchStreamLink,
  type TRPCLink,
} from '@trpc/client';
import { observable } from '@trpc/server/observable';
import type { AppRouter } from '../../../shared/router';
import { useWebConnection } from '../state/webConnection';
import { networkClientId } from '../lib/networkClientId';
import { HTTP_BATCH_MAX_URL_LENGTH } from '../lib/unreadRequests';
import { fetchRpcWithDeadline } from './httpDeadline';
import { prepareRpcBatchResponse } from './httpBatchStream';
import { remoteWorkspaceCheckPending } from '../lib/remoteWorkspaceCheck';
import { isRemoteClient } from '../lib/remoteClient';
import { remoteCacheLink } from './remoteCacheLink';
import {
  accountGatewayPath,
  accountGatewayUnscopedPath,
  resumeRemoteAccount,
} from '../lib/accountGateway';

function sessionExpired() {
  if (isRemoteClient()) window.weqRemoteShell?.connectionFailed?.();
  else location.reload();
}

function checkAccountSelection(response: Response) {
  if (response.headers.get('x-weq-account-selection') === 'required') {
    resumeRemoteAccount();
    throw new Error('正在打开账号选择');
  }
}

function checkCachedWorkspace(input: RequestInfo | URL) {
  if (!remoteWorkspaceCheckPending()) return;
  const path = accountGatewayUnscopedPath(
    new URL(input instanceof Request ? input.url : input, location.href).pathname,
  );
  if (
    !/^\/trpc\/(?:startup\.snapshot|bootstrap\.backup[A-Za-z]+|clientState\.restoreLegacyPreferences)$/.test(
      path,
    )
  )
    throw new Error('正在连接电脑，本机缓存可继续浏览');
}

const wsProtocol = location.protocol === 'https:' ? 'wss:' : 'ws:';

const wsClient = createWSClient({
  url: `${wsProtocol}//${location.host}${accountGatewayPath('/trpc-ws')}`,
  onOpen: () => useWebConnection.getState().connected(),
  onClose: () => useWebConnection.getState().disconnected(),
});

const independentReads = new Set([
  'startup.snapshot',
  'account.listRecentContacts',
  // 完整群目录单独返回，避免大响应拖住首批的会话摘要和未读。
  'account.listAllGroups',
  'account.listAssistantSessions',
  // 可见行按需补全不能等待同批完整目录或在线接口。
  'account.getProfilesByUids',
  'account.getGroupMembersByUids',
  'account.getGroupDetail',
  // 任务轮询与按需日志不能等待同批的 QQ / 数据库慢查询。
  'account.getAccountConfig', // 后台任务必须先确认账号和数据源。
  'backgroundTasks.list',
  'backgroundTasks.details',
  'backgroundTasks.logs',
  'backgroundTasks.contactFailures',
  'account.calendarOverview.task',
  'account.listExportTasks',
  'account.roamingBackfill.list',
  'account.flashListDownloadTasks',
  'account.flashViewDownloads',
  'account.flashDownloadTaskLogs',
  'account.searchQuick',
  'account.searchSlow',
  'account.listLatest',
  'account.listBefore',
  'account.listAfter',
  'account.listFrom',
  'remoteCache.messages',
  'account.cancelMessageRead',
  'account.cancelSidebarSearch',
  'account.promoteMessageRead',
  // 本地气泡查询不能被同批次中的字体/挂件下载拖住。
  'account.dressup.resolveMsgDecoration',
  // 表情面板不能等待同批的其他查询，系统目录也不和收藏合批。
  'account.emojiPanel.catalog',
  'account.emojiPanel.favorites',
  'account.qqActions.qzoneSpaceProfile',
]);

// 首屏的摘要、未读和设置共用一批，并保留大输入的 URL 长度限制。
const conversationBatchedReads = new Set([
  'account.getUnreadInfos',
  'account.listRecentContactTargets',
  'account.listTopContacts',
  'account.listConversationDraftTimes',
  'clientState.snapshot',
  'clientState.accountSnapshot',
]);

// 聚合入口与首屏摘要分别合批，完整联系人和 QQ 在线查询不占用这两批。
const aggregateDirectoryReads = new Set([
  'account.listHiddenSessions',
  'account.listDeletedSessions',
  'account.listOfficialAccounts',
  'account.listServiceAccounts',
  'account.guildDirectListSessions',
  'account.listAgentLabPersonas',
  'account.listAgentLabGroups',
]);

const directoryName = (operation: { path: string; input: unknown }): string => {
  const { path, input } = operation;
  if (path !== 'remoteCache.directory') return path;
  const name = (input as { name?: unknown } | undefined)?.name;
  return typeof name === 'string' ? `account.${name}` : path;
};

export function createLinks(): TRPCLink<AppRouter>[] {
  const httpOptions = {
    headers: () => ({ 'x-weq-client-id': networkClientId }),
    url: accountGatewayPath('/trpc'),
    async fetch(input: RequestInfo | URL, init?: RequestInit) {
      checkCachedWorkspace(input);
      const res = await fetchRpcWithDeadline(input, init);
      checkAccountSelection(res);
      if (res.status === 401) sessionExpired();
      return res;
    },
  };
  const batchOptions = {
    ...httpOptions,
    maxURLLength: HTTP_BATCH_MAX_URL_LENGTH,
    // 流内字符串可能包含 U+FEFF，分块解码时也要保留。
    textDecoder: new TextDecoder('utf-8', { ignoreBOM: true }),
    async fetch(input: RequestInfo | URL, init?: RequestInit) {
      return prepareRpcBatchResponse(await httpOptions.fetch(input, init), input);
    },
  };
  const expiredBatches = new WeakSet<Response>();
  const readBatch = (): TRPCLink<AppRouter> => (runtime) => {
    const request = unstable_httpBatchStreamLink<AppRouter>(batchOptions)(runtime);
    return (operation) =>
      observable((observer) =>
        request(operation).subscribe({
          next: (value) => observer.next(value),
          error: (error) => {
            // 流式响应先送出 200，稍后的鉴权错误仍按原会话失效流程处理。
            const response = error.meta?.response;
            if (
              error.data?.code === 'UNAUTHORIZED' &&
              response instanceof Response &&
              response.status === 200 &&
              !expiredBatches.has(response)
            ) {
              expiredBatches.add(response);
              sessionExpired();
            }
            observer.error(error);
          },
          complete: () => observer.complete(),
        }),
      );
  };
  const reads = splitLink<AppRouter>({
    condition: (op) =>
      independentReads.has(directoryName(op)) ||
      // 空间读取有独立的请求与取消生命周期，单个外部接口挂起时让其他页面和本地读取先返回。
      op.path.startsWith('account.qzone.') ||
      op.path.startsWith('account.qzonePublic.'),
    true: httpLink(httpOptions),
    false: splitLink({
      condition: (op) => conversationBatchedReads.has(directoryName(op)),
      true: readBatch(),
      false: splitLink({
        condition: (op) => aggregateDirectoryReads.has(directoryName(op)),
        true: readBatch(),
        false: readBatch(),
      }),
    }),
  });
  return [
    remoteCacheLink,
    splitLink({
      condition: (op) => op.type === 'subscription',
      true: wsLink({ client: wsClient }),
      false: splitLink({
        condition: (op) => op.type === 'mutation',
        true: httpLink({
          ...httpOptions,
          async fetch(input, init) {
            checkCachedWorkspace(input);
            const res = await fetchRpcWithDeadline(input, init, true);
            checkAccountSelection(res);
            if (res.status === 401) sessionExpired();
            return res;
          },
        }),
        false: reads,
      }),
    }),
  ];
}
