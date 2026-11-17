import { join } from 'node:path';
import type { ExportCheckpoint } from './checkpoint';
import type { ContactsExportDeps } from './contacts_export';
import type { CollectionExportDeps } from './collection_export';
import type { QzoneExportDeps } from './qzone_export';

export function checkpointContacts(
  source: ContactsExportDeps,
  checkpoint: ExportCheckpoint,
): ContactsExportDeps {
  return {
    ...source,
    listBuddies: (...args) =>
      checkpoint.run(['buddies', ...args], () => source.listBuddies(...args)),
    listCategories: () => checkpoint.run('categories', () => source.listCategories()),
    profilesByUids: (uids) => checkpoint.run(['profiles', uids], () => source.profilesByUids(uids)),
    listGroupMembers: (...args) =>
      checkpoint.run(['members', ...args], () => source.listGroupMembers(...args)),
    groupOwnerUid: (group) => checkpoint.run(['owner', group], () => source.groupOwnerUid(group)),
    ...(source.listGroups
      ? {
          listGroups: (...args: Parameters<NonNullable<ContactsExportDeps['listGroups']>>) =>
            checkpoint.run(['groups', ...args], () => source.listGroups!(...args)),
        }
      : {}),
    ...(source.groupByCode
      ? {
          groupByCode: (group: string) =>
            checkpoint.run(['group', group], () => source.groupByCode!(group)),
        }
      : {}),
  };
}

export function checkpointCollection(
  source: CollectionExportDeps,
  checkpoint: ExportCheckpoint,
): CollectionExportDeps {
  return {
    ...source,
    listCollections: (...args) =>
      checkpoint.run(['collections', ...args], () => source.listCollections(...args)),
    ...(source.syncHistory
      ? {
          syncHistory: (signal?: AbortSignal) =>
            checkpoint.run('collection-history', () => source.syncHistory!(signal)),
        }
      : {}),
    ...(source.fetchDetails
      ? {
          fetchDetails: (...args: Parameters<NonNullable<CollectionExportDeps['fetchDetails']>>) =>
            checkpoint.run(['collection-details', args[0]], () => source.fetchDetails!(...args)),
        }
      : {}),
    ...(source.downloadOriginalFiles
      ? {
          downloadOriginalFiles: (
            ...args: Parameters<NonNullable<CollectionExportDeps['downloadOriginalFiles']>>
          ) =>
            checkpoint.run(
              ['collection-originals', args[0]],
              () => source.downloadOriginalFiles!(...args),
              undefined,
              (value) => value.failed === 0,
            ),
        }
      : {}),
    ...(source.exportCachedMedia
      ? {
          exportCachedMedia: (
            ...args: Parameters<NonNullable<CollectionExportDeps['exportCachedMedia']>>
          ) =>
            checkpoint.run(
              ['collection-media', args[0]],
              () => source.exportCachedMedia!(...args),
              (entries) =>
                entries.flatMap((entry) => (entry.file ? [join(args[1], entry.file)] : [])),
              (entries) => entries.every((entry) => Boolean(entry.file)),
            ),
        }
      : {}),
  };
}

export function checkpointQzone(
  source: QzoneExportDeps,
  checkpoint: ExportCheckpoint,
  revalidatePages = false,
): QzoneExportDeps {
  return {
    ...source,
    fetchMsgList: (...args) =>
      revalidatePages
        ? source.fetchMsgList(...args)
        : checkpoint.run(['qzone-page', ...args.slice(0, 3)], () => source.fetchMsgList(...args)),
    ...(source.fetchPostDetail
      ? {
          fetchPostDetail: (...args: Parameters<NonNullable<QzoneExportDeps['fetchPostDetail']>>) =>
            checkpoint.run(['qzone-detail', args[0], args[1]], () =>
              source.fetchPostDetail!(...args),
            ),
        }
      : {}),
    ...(source.fetchPostImages
      ? {
          fetchPostImages: (...args: Parameters<NonNullable<QzoneExportDeps['fetchPostImages']>>) =>
            checkpoint.run(['qzone-images', args[0], args[1]], () =>
              source.fetchPostImages!(...args),
            ),
        }
      : {}),
    ...(source.fetchInteractions
      ? {
          fetchInteractions: (
            ...args: Parameters<NonNullable<QzoneExportDeps['fetchInteractions']>>
          ) =>
            checkpoint.run(['qzone-interactions', args[0], args[1]], () =>
              source.fetchInteractions!(...args),
            ),
        }
      : {}),
    ...(source.fetchLikes
      ? {
          fetchLikes: (...args: Parameters<NonNullable<QzoneExportDeps['fetchLikes']>>) =>
            checkpoint.run(['qzone-likes', args[0], args[1]], () => source.fetchLikes!(...args)),
        }
      : {}),
    ...(source.fetchLikesResult
      ? {
          fetchLikesResult: (
            ...args: Parameters<NonNullable<QzoneExportDeps['fetchLikesResult']>>
          ) =>
            checkpoint.run(['qzone-likes-result', args[0], args[1]], () =>
              source.fetchLikesResult!(...args),
            ),
        }
      : {}),
    ...(source.fetchAlbumPage
      ? {
          fetchAlbumPage: (...args: Parameters<NonNullable<QzoneExportDeps['fetchAlbumPage']>>) =>
            checkpoint.run(['qzone-album-page', args[0], args[1]], () =>
              source.fetchAlbumPage!(...args),
            ),
        }
      : {}),
    ...(source.fetchAlbumPhotos
      ? {
          fetchAlbumPhotos: (
            ...args: Parameters<NonNullable<QzoneExportDeps['fetchAlbumPhotos']>>
          ) =>
            checkpoint.run(['qzone-album-photos', ...args], () =>
              source.fetchAlbumPhotos!(...args),
            ),
        }
      : {}),
    ...(source.fetchAlbumVideo
      ? {
          fetchAlbumVideo: (...args: Parameters<NonNullable<QzoneExportDeps['fetchAlbumVideo']>>) =>
            checkpoint.run(['qzone-album-video', ...args], () => source.fetchAlbumVideo!(...args)),
        }
      : {}),
  };
}
