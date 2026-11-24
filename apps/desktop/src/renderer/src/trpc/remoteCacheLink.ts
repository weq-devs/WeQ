import type { TRPCLink } from '@trpc/client';
import { observable } from '@trpc/server/observable';
import type { AppRouter } from '../../../shared/router';
import superjson from 'superjson';
import {
  getRemoteCacheRecord,
  putRemoteCacheRecord,
  remoteDataCacheAccount,
  remoteDataCacheOffline,
  remoteDataCacheStatus,
} from '../lib/remoteDataCache';
import { isRemoteClient } from '../lib/remoteClient';

const accountReads = new Set([
  'listLatest',
  'listBefore',
  'listAfter',
  'listFrom',
  'searchQuick',
  'searchSlow',
  'searchHistory',
  'searchMore',
  'searchGroupMembers',
  'searchConversationRecords',
  'searchReadonlyConversation',
  'getForwardMessages',
  'listRecentContacts',
  'listRecentContactTargets',
  'listTopContacts',
  'listAllGroups',
  'getGroupMembersByUids',
  'getGroupDetail',
  'getProfilesByUids',
  'listBuddies',
  'listCategories',
  'listProfiles',
  'getSelfProfile',
  'listHiddenSessions',
  'listDeletedSessions',
  'listOfficialAccounts',
  'listServiceAccounts',
  'guildDirectListSessions',
  'guildDirectLatest',
  'guildDirectBefore',
  'guildDirectAfter',
  'guildDirectAround',
  'readonlyConversationPage',
  'listOfficialAccountArkFeed',
  'listServiceAccountArkFeed',
  'getSystemFaces',
  'getHomeDress',
  'listBuddyRequests',
  'listGroupNotifies',
  'listCollections',
  'countCollections',
  'collectionDetail',
  'localCollectionItem',
  'listImportantGroupMessages',
  'listGroupEssenceMessages',
  'listGroupFiles',
  'listGroupAlbums',
  'listGroupAlbumBrowse',
  'listGroupAlbumMedia',
  'getGroupAlbumFeed',
]);
const cacheablePaths = new Set([
  'account.emojiPanel.overview',
  'account.emojiPanel.catalog',
  'account.emojiPanel.favorites',
  'account.emojiPanel.marketPackages',
  'account.emojiPanel.marketPackDetail',
  'account.emojiPanel.relatedGifs',
  'account.emojiPanel.customEmojiRecent',
  'account.emojiPanel.recentReactions',
  'account.emojiPanel.showEmojiCatalog',
  'account.marketEmoji.searchCatalog',
  'account.qqActions.favorites',
  'account.qqActions.qzoneHome',
  'account.qqActions.qzoneSpaceProfile',
  'account.dressup.resolveMsgDecoration',
  'mail.status',
  'mail.folders',
  'mail.list',
  'mail.image',
]);
const transientFields = new Set(['readWindow', 'searchWindow', 'requestId', 'clientId']);

function cachePath(path: string) {
  return (
    cacheablePaths.has(path) ||
    (path.startsWith('account.') && accountReads.has(path.slice('account.'.length))) ||
    path.startsWith('account.qzone.') ||
    path.startsWith('account.qzonePublic.')
  );
}

function keyFor(path: string, input: unknown, account: string) {
  // 分页游标、QQ 号、版本和查询筛选仍参与键；取消/调度标识每次进入页面都会变。
  const normalized =
    input && typeof input === 'object' && !Array.isArray(input)
      ? Object.fromEntries(
          Object.entries(input)
            .filter(([field]) => !transientFields.has(field))
            .sort(([a], [b]) => a.localeCompare(b)),
        )
      : input;
  return superjson.stringify(['query', account, path, normalized]);
}

export const remoteCacheLink: TRPCLink<AppRouter> =
  () =>
  ({ op, next }) => {
    const account = remoteDataCacheAccount();
    if (op.type !== 'query' || !account || !isRemoteClient() || !cachePath(op.path))
      return next(op);
    const input = op.input as
      | { expectedAccountUin?: unknown; expectedAccountConfigId?: unknown; selfUin?: unknown }
      | undefined;
    const [uin, configId] = JSON.parse(account) as [string, string];
    if (
      (input?.expectedAccountUin !== undefined && input.expectedAccountUin !== uin) ||
      (input?.expectedAccountConfigId !== undefined &&
        input.expectedAccountConfigId !== configId) ||
      (input?.selfUin !== undefined && input.selfUin !== uin)
    )
      return next(op);
    const key = keyFor(op.path, op.input, account);
    return observable((observer) => {
      let cancelled = false;
      let subscription: ReturnType<ReturnType<typeof next>['subscribe']> | undefined;
      const available = remoteDataCacheStatus();
      let local: Promise<{ data: unknown } | undefined> | undefined;
      const readLocal = () => (local ??= getRemoteCacheRecord<{ data: unknown }>(key));
      const deliver = (cached: { data: unknown } | undefined) => {
        if (!cached || cancelled || remoteDataCacheAccount() !== account) return false;
        observer.next({ result: { data: cached.data } });
        observer.complete();
        return true;
      };
      void (async () => {
        if (remoteDataCacheOffline() && deliver(await readLocal())) return;
        if (cancelled) return;
        subscription = next(op).subscribe({
          next(result) {
            observer.next(result);
            if ('data' in result.result) {
              const data = result.result.data;
              void available
                .then((status) => {
                  if (status && remoteDataCacheAccount() === account)
                    return putRemoteCacheRecord(key, { data }, status);
                })
                .catch(() => {});
            }
          },
          error(error) {
            const response = error.meta?.response;
            const status = response instanceof Response ? response.status : undefined;
            const denied =
              status === 401 ||
              status === 403 ||
              status === 409 ||
              error.data?.code === 'UNAUTHORIZED' ||
              error.data?.code === 'FORBIDDEN';
            if (
              !denied &&
              (remoteDataCacheOffline() ||
                status === 502 ||
                status === 503 ||
                status === 504 ||
                (!status && !error.data))
            ) {
              void readLocal().then((cached) => {
                if (!deliver(cached) && !cancelled) observer.error(error);
              });
            } else observer.error(error);
          },
          complete: () => observer.complete(),
        });
      })();
      return () => {
        cancelled = true;
        subscription?.unsubscribe();
      };
    });
  };
