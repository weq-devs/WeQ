/**
 * Account-scoped router — only usable once `bootstrap.openAccount`
 * resolved. Every procedure asserts an account session is open and
 * throws otherwise.
 *
 * `bigint` fields (uin / msgId / msgSeq / sendTime) are stringified at the IPC
 * boundary (see `../serde.ts`). The renderer `BigInt(s)`-es seq values back for
 * cursor arithmetic; most other fields are displayed as text.
 *
 * Messages load as a *seq window* (see MsgService): `listLatest` for the newest
 * page, `listBefore` to page up, `listFrom` to re-read the loaded window live.
 */

import { z } from 'zod';
import { observable } from '@trpc/server/observable';
import { mkdir, writeFile } from 'node:fs/promises';
import { basename, dirname, extname, join } from 'node:path';
import { getAppContext, dbEventBus, type AccountServices } from '../../context/app_context';
import { procedure, router } from '../trpc';
import {
  clientKeyExpiryMs,
  toRenderElements,
  PRIVATE_PTT_RKEY_TYPE,
  GROUP_PTT_RKEY_TYPE,
  getVoiceModel,
  type AlbumMedia,
  type NewMessages,
  type DbChange,
} from '@weq/service';
import {
  buddyRequestToWire,
  buddyToWire,
  categoryToWire,
  c2cMsgToWire,
  forwardRecordToWire,
  groupBulletinToWire,
  groupMsgToWire,
  groupNotifyToWire,
  recentContactToWire,
  userProfileToWire,
  groupDetailToWire,
  groupEssenceToWire,
  groupNoticeToBulletinWire,
  groupMemberToWire,
  groupMemberLevelInfoToWire,
  msgSearchHitToWire,
  onlineStatusToWire,
  elementsToEditable,
  elementsFromEditable,
  type ChatMsgWire,
} from '../serde';

function requireServices(): AccountServices {
  const ctx = getAppContext();
  if (!ctx.services) {
    throw new Error('No account session open — call bootstrap.openAccount first.');
  }
  return ctx.services;
}

/** Wire payload pushed to the renderer when nt_msg.db gains new rows. */
export interface NewMessagesWire {
  messages: ChatMsgWire[];
}

type ChatKind = 'c2c' | 'group';

const convInput = z.object({
  kind: z.enum(['c2c', 'group']),
  /** Conversation key: peer uid (c2c) or group code (group). */
  conv: z.string().min(1),
});

const pageInput = z.object({
  limit: z.number().int().min(1).max(2000).default(100),
  offset: z.number().int().min(0).default(0),
});

const groupPageInput = pageInput.extend({
  groupCode: z.string().min(1),
});

const decryptDbInput = z.object({
  items: z
    .array(
      z.object({
        dbPath: z.string().min(1),
        name: z.string().optional(),
      }),
    )
    .min(1),
  outputDir: z.string().min(1),
  mode: z.enum(['fast', 'safe']),
  concurrency: z.number().int().min(1).max(6).optional(),
});

const groupAlbumInput = z.object({
  groupCode: z.string().min(1),
});

const groupAlbumMediaInput = groupAlbumInput.extend({
  albumId: z.string().min(1),
});

const albumSelectionInput = z.object({
  id: z.string().min(1),
  title: z.string().optional(),
});

const exportGroupAlbumsInput = groupAlbumInput.extend({
  outputDir: z.string().min(1),
  albums: z.array(albumSelectionInput).min(1),
  concurrency: z.number().int().min(1).max(8).optional(),
});

export interface GroupAlbumAccessState {
  qqOnline: boolean;
  qqPid: number | null;
  clientKeyValid: boolean;
  clientKeyExpiresAt: number | null;
  clientKeySecondsLeft: number;
}

export interface AlbumMediaWire extends AlbumMedia {
  previewUrl: string;
  originalUrl: string;
  fileName: string;
}

interface AlbumDownloadWork {
  albumId: string;
  albumTitle: string;
  url: string;
  targetPath: string;
  fileName: string;
}

export interface AlbumExportResult {
  outputDir: string;
  total: number;
  ok: number;
  failed: Array<{ albumId: string; albumTitle: string; fileName: string; url: string; error: string }>;
}

async function fetchLatest(kind: ChatKind, conv: string, limit: number): Promise<ChatMsgWire[]> {
  const msgs = requireServices().msgs;
  return kind === 'group'
    ? (await msgs.getGroupLatest(conv, limit)).map(groupMsgToWire)
    : (await msgs.getC2cLatest(conv, limit)).map(c2cMsgToWire);
}

async function fetchBefore(
  kind: ChatKind,
  conv: string,
  beforeSeq: bigint,
  limit: number,
): Promise<ChatMsgWire[]> {
  const msgs = requireServices().msgs;
  return kind === 'group'
    ? (await msgs.getGroupBefore(conv, beforeSeq, limit)).map(groupMsgToWire)
    : (await msgs.getC2cBefore(conv, beforeSeq, limit)).map(c2cMsgToWire);
}

async function fetchAfter(
  kind: ChatKind,
  conv: string,
  afterSeq: bigint,
  limit: number,
): Promise<ChatMsgWire[]> {
  const msgs = requireServices().msgs;
  return kind === 'group'
    ? (await msgs.getGroupAfter(conv, afterSeq, limit)).map(groupMsgToWire)
    : (await msgs.getC2cAfter(conv, afterSeq, limit)).map(c2cMsgToWire);
}

async function fetchFrom(
  kind: ChatKind,
  conv: string,
  sinceSeq: bigint,
  limit: number,
): Promise<ChatMsgWire[]> {
  const msgs = requireServices().msgs;
  return kind === 'group'
    ? (await msgs.getGroupFrom(conv, sinceSeq, limit)).map(groupMsgToWire)
    : (await msgs.getC2cFrom(conv, sinceSeq, limit)).map(c2cMsgToWire);
}

function albumAccessState(services = requireServices()): GroupAlbumAccessState {
  const record = services.accountConfig.getRecord();
  const expiresAt = record?.clientKey ? clientKeyExpiryMs(record.clientKey) : null;
  const secondsLeft = expiresAt ? Math.max(0, Math.floor((expiresAt - Date.now()) / 1000)) : 0;
  return {
    qqOnline: Boolean(record?.qqOnline && record.qqPid),
    qqPid: record?.qqPid ?? null,
    clientKeyValid: Boolean(expiresAt && expiresAt > Date.now()),
    clientKeyExpiresAt: expiresAt,
    clientKeySecondsLeft: secondsLeft,
  };
}

function requireQqOnlineForAlbum(services = requireServices()): void {
  const state = albumAccessState(services);
  if (!state.qqOnline) {
    throw new Error('需要先登录该账号的 QQ 客户端。');
  }
}

function requireFreshClientKeyForAlbum(services = requireServices()): void {
  const state = albumAccessState(services);
  if (!state.qqOnline) {
    throw new Error('需要先登录该账号的 QQ 客户端。');
  }
  if (!state.clientKeyValid) {
    throw new Error('ClientKey 未获取或已过期，请在设置中开启自动获取 ClientKey 并等待刷新。');
  }
}

async function listGroupBulletinsWithWebFallback(
  services: AccountServices,
  input: z.infer<typeof groupPageInput>,
): Promise<ReturnType<typeof groupBulletinToWire>[]> {
  const localWindow = (
    await services.groupInfo.getGroupBulletins(
      BigInt(input.groupCode),
      input.limit + input.offset,
      0,
    )
  ).map(groupBulletinToWire);
  const localPage = localWindow.slice(input.offset, input.offset + input.limit);

  const state = albumAccessState(services);
  if (!state.qqOnline || !state.clientKeyValid) return localPage;

  try {
    const webNotices = await services.webQuery.getGroupNotice(input.groupCode);
    const merged = localWindow.slice();
    const seenFids = new Set(merged.map((item) => item.fid).filter(Boolean));
    for (const notice of webNotices) {
      if (notice.noticeId && seenFids.has(notice.noticeId)) continue;
      if (notice.noticeId) seenFids.add(notice.noticeId);
      merged.push(groupNoticeToBulletinWire(notice, input.groupCode));
    }
    return merged.sort(compareBulletinWireDesc).slice(input.offset, input.offset + input.limit);
  } catch {
    return localPage;
  }
}

function compareBulletinWireDesc(
  a: ReturnType<typeof groupBulletinToWire>,
  b: ReturnType<typeof groupBulletinToWire>,
): number {
  return Number(toSafeBigint(b.ctime || b.msgTime) - toSafeBigint(a.ctime || a.msgTime));
}

function toSafeBigint(value: string | undefined): bigint {
  try {
    return BigInt(value || '0');
  } catch {
    return 0n;
  }
}

function mediaUrls(media: AlbumMedia): { previewUrl: string; originalUrl: string; fileName: string } {
  const image = media.image;
  if (!image) return { previewUrl: '', originalUrl: '', fileName: '' };
  const urls = image.photoUrls
    .map((entry) => entry.url)
    .filter((entry): entry is NonNullable<typeof entry> => {
      if (!entry?.url) return false;
      return !isAlbumPlaceholderUrl(entry.url);
    });
  const sorted = urls
    .slice()
    .sort((a, b) => (b.width || 0) * (b.height || 0) - (a.width || 0) * (a.height || 0));
  const defaultUrl = image.defaultUrl && !isAlbumPlaceholderUrl(image.defaultUrl.url) ? image.defaultUrl.url : '';
  const previewUrl = defaultUrl || sorted[sorted.length - 1]?.url || sorted[0]?.url || '';
  const originalUrl = sorted[0]?.url || defaultUrl || '';
  return { previewUrl, originalUrl, fileName: image.name || '' };
}

function mediaToWire(media: AlbumMedia): AlbumMediaWire {
  return { ...media, ...mediaUrls(media) };
}

function isAlbumPlaceholderUrl(url: string): boolean {
  try {
    const parsed = new URL(url);
    const path = parsed.pathname.toLowerCase();
    return parsed.hostname.toLowerCase() === 'imgcache.qq.com' && path.endsWith('/no.gif');
  } catch {
    return /imgcache\.qq\.com\/.*\/no\.gif/i.test(url);
  }
}

async function collectAlbumMedia(
  services: AccountServices,
  groupCode: string,
  albumId: string,
): Promise<AlbumMediaWire[]> {
  const out: AlbumMediaWire[] = [];
  const seenAttachInfo = new Set<string>();
  let attachInfo = '';
  for (let guard = 0; guard < 100; guard += 1) {
    const page = await services.groupAlbumMedia.getMediaList(groupCode, albumId, attachInfo);
    out.push(...page.mediaList.map(mediaToWire).filter((media) => media.originalUrl || media.previewUrl));
    const next = page.nextAttachInfo || '';
    if (!next || seenAttachInfo.has(next)) break;
    seenAttachInfo.add(next);
    attachInfo = next;
  }
  return out;
}

function pickAlbumDownloadUrl(media: AlbumMediaWire): string {
  return media.originalUrl || media.previewUrl;
}

function sanitizePathSegment(value: string | undefined, fallback: string): string {
  const raw = (value || fallback).trim();
  const cleaned = raw
    .replace(/[<>:"/\\|?*\x00-\x1f]/g, '_')
    .replace(/\s+/g, ' ')
    .replace(/[. ]+$/g, '')
    .slice(0, 120)
    .trim();
  const name = cleaned || fallback;
  return /^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/i.test(name) ? `_${name}` : name;
}

function filenameFromUrl(url: string, fallback: string, index: number): string {
  let name = fallback;
  if (!name) {
    try {
      name = decodeURIComponent(basename(new URL(url).pathname));
    } catch {
      name = '';
    }
  }
  const safe = sanitizePathSegment(name, `photo-${String(index + 1).padStart(4, '0')}.jpg`);
  return extname(safe) ? safe : `${safe}.jpg`;
}

function uniqueFilename(name: string, used: Set<string>): string {
  if (!used.has(name.toLowerCase())) {
    used.add(name.toLowerCase());
    return name;
  }
  const ext = extname(name);
  const base = ext ? name.slice(0, -ext.length) : name;
  for (let i = 2; ; i += 1) {
    const next = `${base}-${i}${ext}`;
    const key = next.toLowerCase();
    if (!used.has(key)) {
      used.add(key);
      return next;
    }
  }
}

async function downloadAlbumUrl(url: string, targetPath: string): Promise<void> {
  const res = await fetch(url);
  if (!res.ok) {
    throw new Error(`HTTP ${res.status}`);
  }
  const bytes = Buffer.from(await res.arrayBuffer());
  if (bytes.length === 0) {
    throw new Error('empty response');
  }
  await writeFile(targetPath, bytes);
}

async function runWithConcurrency<T>(
  items: T[],
  concurrency: number,
  worker: (item: T) => Promise<void>,
): Promise<void> {
  let next = 0;
  async function run(): Promise<void> {
    for (;;) {
      const index = next;
      next += 1;
      if (index >= items.length) return;
      await worker(items[index]!);
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, run));
}

async function exportGroupAlbums(
  services: AccountServices,
  input: z.infer<typeof exportGroupAlbumsInput>,
): Promise<AlbumExportResult> {
  requireFreshClientKeyForAlbum(services);
  const work: AlbumDownloadWork[] = [];
  for (const album of input.albums) {
    const albumTitle = sanitizePathSegment(album.title, album.id);
    const albumDir = join(input.outputDir, albumTitle);
    const used = new Set<string>();
    const media = await collectAlbumMedia(services, input.groupCode, album.id);
    media.forEach((item, index) => {
      const url = pickAlbumDownloadUrl(item);
      if (!url) return;
      const fileName = uniqueFilename(filenameFromUrl(url, item.fileName, index), used);
      work.push({
        albumId: album.id,
        albumTitle,
        url,
        fileName,
        targetPath: join(albumDir, fileName),
      });
    });
  }

  const failed: AlbumExportResult['failed'] = [];
  let ok = 0;
  await mkdir(input.outputDir, { recursive: true });
  await runWithConcurrency(work, input.concurrency ?? 4, async (item) => {
    try {
      await mkdir(dirname(item.targetPath), { recursive: true });
      await downloadAlbumUrl(item.url, item.targetPath);
      ok += 1;
    } catch (e) {
      failed.push({
        albumId: item.albumId,
        albumTitle: item.albumTitle,
        fileName: item.fileName,
        url: item.url,
        error: e instanceof Error ? e.message : String(e),
      });
    }
  });

  return { outputDir: input.outputDir, total: work.length, ok, failed };
}

export const accountRouter = router({
  /** Recent conversations (recent_contact_v3_table), newest first. */
  listRecentContacts: procedure.query(async () => {
    const contacts = await requireServices().recentContacts.getRecentContact(200);
    return contacts.map(recentContactToWire);
  }),

  /** Get unread message count for a conversation. */
  getUnreadInfo: procedure
    .input(z.object({ chatType: z.number().int(), uid: z.string().min(1) }))
    .query(async ({ input }) => {
      const result = await requireServices().unreadInfo.getUnreadInfo(input.chatType, input.uid);
      return result ? { msgSeq: result.msgSeq?.toString() } : null;
    }),

  /** Newest page of a conversation (open / switch-into), newest-first. */
  listLatest: procedure
    .input(convInput.extend({ limit: z.number().int().min(1).max(200).default(50) }))
    .query(({ input }) => fetchLatest(input.kind, input.conv, input.limit)),

  /** The page just older than `beforeSeq` (scroll up), newest-first. */
  listBefore: procedure
    .input(
      convInput.extend({
        beforeSeq: z.string().min(1),
        limit: z.number().int().min(1).max(200).default(50),
      }),
    )
    .query(({ input }) => fetchBefore(input.kind, input.conv, BigInt(input.beforeSeq), input.limit)),

  /** The page just newer than `afterSeq` (scroll down / jump context), oldest-first. */
  listAfter: procedure
    .input(
      convInput.extend({
        afterSeq: z.string().min(1),
        limit: z.number().int().min(1).max(200).default(50),
      }),
    )
    .query(({ input }) => fetchAfter(input.kind, input.conv, BigInt(input.afterSeq), input.limit)),

  /** Re-read everything with seq >= `sinceSeq` (live refresh of the window). */
  listFrom: procedure
    .input(
      convInput.extend({
        sinceSeq: z.string().min(1),
        limit: z.number().int().min(1).max(1000).default(500),
      }),
    )
    .query(({ input }) => fetchFrom(input.kind, input.conv, BigInt(input.sinceSeq), input.limit)),

  /** Get detailed profile for the currently logged-in user. */
  getSelfProfile: procedure.query(async () => {
    const profile = await requireServices().profile.getSelfProfile();
    return profile ? userProfileToWire(profile) : null;
  }),

  /**
   * The persisted config record for the OPEN account — dbKey / algo / data dir
   * plus the live online state and harvested download rkeys. Backs 设置 → 账号
   * 信息. The payload is already IPC-safe (no bigint), so it ships as-is.
   * Returns null if the record hasn't been written yet.
   */
  getAccountConfig: procedure.query(() => {
    const record = requireServices().accountConfig.getRecord();
    if (!record) return null;
    return {
      uin: record.uin,
      dbKey: record.dbKey,
      algo: record.algo,
      dataDir: record.dataDir ?? null,
      qqOnline: record.qqOnline ?? false,
      qqPid: record.qqPid ?? null,
      rkeys: record.rkeys ?? [],
      rkeyUpdatedAt: record.rkeyUpdatedAt ?? null,
      clientKey: record.clientKey ?? null,
    };
  }),

  /** List QQ buddies from profile_info.db. */
  listBuddies: procedure
    .input(pageInput.optional())
    .query(async ({ input }) => {
      const page = input ?? { limit: 200, offset: 0 };
      const buddies = await requireServices().profile.listBuddies(page.limit, page.offset);
      return buddies.map(buddyToWire);
    }),

  /** List QQ buddy categories. */
  listCategories: procedure.query(async () => {
    const categories = await requireServices().profile.listCategories();
    return categories.map(categoryToWire);
  }),

  /** List QQ buddy request notifications. */
  listBuddyRequests: procedure
    .input(pageInput.optional())
    .query(async ({ input }) => {
      const page = input ?? { limit: 100, offset: 0 };
      const requests = await requireServices().profile.listBuddyRequests(page.limit, page.offset);
      return requests.map(buddyRequestToWire);
    }),

  /** List group notifications. */
  listGroupNotifies: procedure
    .input(pageInput.optional())
    .query(async ({ input }) => {
      const page = input ?? { limit: 100, offset: 0 };
      const notifies = await requireServices().groupInfo.listGroupNotifies(page.limit, page.offset);
      return notifies.map(groupNotifyToWire);
    }),

  /** Get detailed profile by NT uid. */
  getProfile: procedure
    .input(z.object({ uid: z.string().min(1) }))
    .query(async ({ input }) => {
      const profile = await requireServices().profile.getProfile(input.uid);
      return profile ? userProfileToWire(profile) : null;
    }),

  /** Get detailed profile by QQ uin. */
  getProfileByUin: procedure
    .input(z.object({ uin: z.string().min(1) }))
    .query(async ({ input }) => {
      const profile = await requireServices().profile.getProfileByUin(BigInt(input.uin));
      return profile ? userProfileToWire(profile) : null;
    }),

  /** Batch-resolve nicknames by uid → { uid: nick } (cached profiles only). */
  getNicksByUids: procedure
    .input(z.object({ uids: z.array(z.string().min(1)).min(1).max(50) }))
    .query(async ({ input }) => {
      return requireServices().profile.nicksByUids(input.uids);
    }),

  /**
   * Batch-resolve full profiles by uid (cached profiles only). Lets the
   * renderer fill many buddy / notify profiles in one round-trip instead of
   * one query per uid.
   */
  getProfilesByUids: procedure
    .input(z.object({ uids: z.array(z.string().min(1)).min(1).max(200) }))
    .query(async ({ input }) => {
      const profiles = await requireServices().profile.profilesByUids(input.uids);
      return profiles.map(userProfileToWire);
    }),

  /** List cached user profiles. */
  listProfiles: procedure
    .input(pageInput.optional())
    .query(async ({ input }) => {
      const page = input ?? { limit: 100, offset: 0 };
      const profiles = await requireServices().profile.listProfiles(page.limit, page.offset);
      return profiles.map(userProfileToWire);
    }),

  /**
   * List ALL friends ordered by intimacy (高→低), paginated. Backs the "好友亲密度
   * 排行" lightbox — the payload is already IPC-safe (uin is a string). Includes
   * every friend, not just those sharing groups with me.
   */
  listFriendsByIntimacy: procedure
    .input(pageInput.optional())
    .query(async ({ input }) => {
      const page = input ?? { limit: 100, offset: 0 };
      return requireServices().profile.listFriendsByIntimacy(page.limit, page.offset);
    }),

  /** Get group metadata and latest announcement. */
  getGroupDetail: procedure
    .input(z.object({ groupCode: z.string().min(1) }))
    .query(async ({ input }) => {
      const detail = await requireServices().groupInfo.getGroupDetail(BigInt(input.groupCode));
      return detail ? groupDetailToWire(detail) : null;
    }),

  /**
   * Relation graph: everyone sharing ≥2 of my groups, with profile intimacy /
   * friend status. Heavy on first call (scans all group membership once), then
   * served from the per-session cache. Pass `force: true` to rebuild. The
   * payload is already IPC-safe (uin / group codes are strings).
   */
  getRelationGraph: procedure
    .input(z.object({ force: z.boolean().optional() }).optional())
    .query(async ({ input }) => {
      return requireServices().groupInfo.getRelationGraph({ force: input?.force });
    }),

  /** List all groups from group_info.db. */
  listAllGroups: procedure
    .input(pageInput.optional())
    .query(async ({ input }) => {
      const page = input ?? { limit: 100, offset: 0 };
      const groups = await requireServices().groupInfo.listAllGroups(page.limit, page.offset);
      return groups.map(groupDetailToWire);
    }),

  /** List group announcements. */
  listGroupBulletins: procedure
    .input(groupPageInput)
    .query(async ({ input }) => {
      return listGroupBulletinsWithWebFallback(requireServices(), input);
    }),

  /** List group essence messages. */
  listGroupEssenceMessages: procedure
    .input(groupPageInput)
    .query(async ({ input }) => {
      const essence = await requireServices().groupInfo.getEssenceMessages(
        BigInt(input.groupCode),
        input.limit,
        input.offset,
      );
      return essence.map(groupEssenceToWire);
    }),

  /** Get group member level definitions. */
  getGroupMemberLevelInfo: procedure
    .input(z.object({ groupCode: z.string().min(1) }))
    .query(async ({ input }) => {
      const info = await requireServices().groupInfo.getMemberLevelInfo(BigInt(input.groupCode));
      return info ? groupMemberLevelInfoToWire(info) : null;
    }),

  /** List members of a group. */
  listGroupMembers: procedure
    .input(
      z.object({
        groupCode: z.string().min(1),
        limit: z.number().int().min(1).max(300).optional(),
        offset: z.number().int().min(0).optional(),
      }),
    )
    .query(async ({ input }) => {
      const members = await requireServices().groupInfo.listMembersInGroup(
        BigInt(input.groupCode),
        input.limit ?? 100,
        input.offset ?? 0,
      );
      return members.map(groupMemberToWire);
    }),

  /**
   * List a group's members ordered by member level (高→低), paginated. Backs
   * the "群成员等级排行" lightbox (one query per scrolled page, never per member).
   */
  listGroupMembersByLevel: procedure
    .input(
      z.object({
        groupCode: z.string().min(1),
        limit: z.number().int().min(1).max(300).optional(),
        offset: z.number().int().min(0).optional(),
      }),
    )
    .query(async ({ input }) => {
      const members = await requireServices().groupInfo.listMembersByLevel(
        BigInt(input.groupCode),
        input.limit ?? 100,
        input.offset ?? 0,
      );
      return members.map(groupMemberToWire);
    }),

  /**
   * Batch-resolve group members by uid. Lets the renderer fill in display
   * names for message senders that fall outside the loaded member page,
   * without blocking on a full member fetch.
   */
  getGroupMembersByUids: procedure
    .input(
      z.object({
        groupCode: z.string().min(1),
        uids: z.array(z.string().min(1)).min(1).max(200),
      }),
    )
    .query(async ({ input }) => {
      const members = await requireServices().groupInfo.getMembersByUids(
        BigInt(input.groupCode),
        input.uids,
      );
      return members.map(groupMemberToWire);
    }),

  /** List groups a specific user belongs to. */
  listUserGroups: procedure
    .input(
      z.object({
        uid: z.string().min(1),
        limit: z.number().int().min(1).max(300).optional(),
        offset: z.number().int().min(0).optional(),
      }),
    )
    .query(async ({ input }) => {
      const groups = await requireServices().groupInfo.listUserGroups(
        input.uid,
        input.limit ?? 100,
        input.offset ?? 0,
      );
      return groups.map(groupMemberToWire);
    }),

  /** Get formatted online status for a user. */
  getOnlineStatus: procedure
    .input(z.object({ uid: z.string().min(1) }))
    .query(async ({ input }) => {
      const status = await requireServices().onlineStatus.getOnlineStatus(input.uid);
      return status ? onlineStatusToWire(status) : null;
    }),

  /** Search message FTS indexes. */
  searchMessages: procedure
    .input(
      z.object({
        scope: z.enum(['all', 'buddy', 'group', 'files']).default('all'),
        keyword: z.string().trim().min(1),
        limit: z.number().int().min(1).max(100).default(20),
      }),
    )
    .query(async ({ input }) => {
      const search = requireServices().msgSearch;
      const hits =
        input.scope === 'buddy'
          ? await search.searchBuddy(input.keyword, input.limit)
          : input.scope === 'group'
            ? await search.searchGroup(input.keyword, input.limit)
            : input.scope === 'files'
              ? await search.searchFiles(input.keyword, input.limit)
              : [
                  ...(await search.searchBuddy(input.keyword, input.limit)),
                  ...(await search.searchGroup(input.keyword, input.limit)),
                ]
                  .sort((a, b) => Number(b.sendTime - a.sendTime))
                  .slice(0, input.limit);
      return hits.map(msgSearchHitToWire);
    }),

  /** Search within the open conversation. */
  searchConversationMessages: procedure
    .input(
      convInput.extend({
        keyword: z.string().trim().min(1),
        limit: z.number().int().min(1).max(100).default(20),
      }),
    )
    .query(async ({ input }) => {
      const search = requireServices().msgSearch;
      const hits =
        input.kind === 'group'
          ? await search.searchInGroupConversation(input.conv, input.keyword, input.limit)
          : await search.searchInBuddyConversation(input.conv, input.keyword, input.limit);
      return hits.map(msgSearchHitToWire);
    }),

  /** Get merged-forward / quote-reply cache for one message. */
  getForwardMessages: procedure
    .input(z.object({ kind: z.enum(['c2c', 'group']), msgId: z.string().min(1) }))
    .query(async ({ input }) => {
      const service = requireServices().forwardMsgs;
      const records =
        input.kind === 'group'
          ? await service.getGroupForward(BigInt(input.msgId))
          : await service.getC2cForward(BigInt(input.msgId));
      return records.map(forwardRecordToWire);
    }),

  /** Get un-filtered raw elements for one message (for editing). */
  getRawElements: procedure
    .input(z.object({ msgId: z.string().min(1) }))
    .query(async ({ input }) => {
      const result = await requireServices().msgs.getRawElements(BigInt(input.msgId));
      if (!result) return null;
      // Bytes (Node Buffers) → `{ type:'Buffer', data }` so superjson can ship
      // them and the editor can round-trip them; bigints → strings.
      return { kind: result.kind, elements: elementsToEditable(result.elements) };
    }),

  /** Update elements for one message (back-write to 40800). */
  updateElements: procedure
    .input(z.object({ msgId: z.string().min(1), elements: z.array(z.any()) }))
    .mutation(async ({ input }) => {
      // Reverse the editable wire form: `{ type:'Buffer', data }` → Uint8Array.
      const elements = elementsFromEditable(input.elements);
      return requireServices().msgs.updateElements(BigInt(input.msgId), elements);
    }),

  /**
   * Live "nt_msg.db changed" ping (debounced). Carries no payload beyond a
   * timestamp — the renderer responds by re-reading the open conversation's
   * loaded seq window. This is what makes group inserts, recalls and sticker
   * reactions show up without the (unreliable for groups) msgId delta.
   */
  onDbChanged: procedure.subscription(() => {
    return observable<{ at: number }>((emit) => {
      const handler = (file: DbChange): void => {
        emit.next({ at: file.at });
      };
      dbEventBus.on('changed', handler);
      return () => {
        dbEventBus.off('changed', handler);
      };
    });
  }),

  /**
   * Live push of newly-inserted messages (rowid-delta). Reserved for unread /
   * popup notifications — the open conversation is kept fresh by `onDbChanged`,
   * not this. Fires only when new rows actually landed.
   */
  onNewMessages: procedure.subscription(() => {
    return observable<NewMessagesWire>((emit) => {
      const handler = (change: NewMessages): void => {
        const messages: ChatMsgWire[] = [
          ...change.c2c.map((m) => c2cMsgToWire({ ...m, elements: toRenderElements(m.elements) })),
          ...change.group.map((m) =>
            groupMsgToWire({ ...m, elements: toRenderElements(m.elements) }),
          ),
        ];
        emit.next({ messages });
      };
      dbEventBus.on('new', handler);
      return () => {
        dbEventBus.off('new', handler);
      };
    });
  }),

  /** Live prerequisites for group album list/media/export. */
  getGroupAlbumAccessState: procedure.query(() => {
    return albumAccessState();
  }),

  // ---- database decrypt ----

  /** List encrypted `*.db` files under the open account's nt_db directory. */
  listDatabases: procedure.query(() => {
    return requireServices().dbDecrypt.listDatabases();
  }),

  /** True when QQ currently reports this account as logged in. */
  isQqLoggedIn: procedure.query(() => {
    return requireServices().dbDecrypt.isQqLoggedIn();
  }),

  /** Folder dialog for decrypted database output. */
  pickDecryptOutputDir: procedure.mutation(async () => {
    const { dialog } = await import('electron');
    const result = await dialog.showOpenDialog({
      title: '选择解密保存文件夹',
      properties: ['openDirectory', 'createDirectory'],
    });
    if (result.canceled || result.filePaths.length === 0) return null;
    return result.filePaths[0] ?? null;
  }),

  /** Bulk decrypt selected databases into the chosen folder. */
  decryptDatabases: procedure
    .input(decryptDbInput)
    .mutation(async ({ input }) => {
      return requireServices().dbDecrypt.decryptDatabases(input);
    }),

  // ---- group album ----

  /** List group albums via Qzone web CGI. Requires online QQ + fresh ClientKey. */
  listGroupAlbums: procedure
    .input(groupAlbumInput)
    .query(async ({ input }) => {
      const services = requireServices();
      requireFreshClientKeyForAlbum(services);
      return services.webQuery.getGroupAlbumList(input.groupCode);
    }),

  /** List all media for one group album. Requires the saved online QQ pid. */
  listGroupAlbumMedia: procedure
    .input(groupAlbumMediaInput)
    .query(async ({ input }) => {
      const services = requireServices();
      requireQqOnlineForAlbum(services);
      return collectAlbumMedia(services, input.groupCode, input.albumId);
    }),

  /** Folder dialog for group album export output. */
  pickGroupAlbumExportDir: procedure.mutation(async () => {
    const { dialog } = await import('electron');
    const result = await dialog.showOpenDialog({
      title: '选择群相册保存文件夹',
      properties: ['openDirectory', 'createDirectory'],
    });
    if (result.canceled || result.filePaths.length === 0) return null;
    return result.filePaths[0] ?? null;
  }),

  /** Enumerate selected albums first, then concurrently download all media. */
  exportGroupAlbums: procedure
    .input(exportGroupAlbumsInput)
    .mutation(async ({ input }) => {
      return exportGroupAlbums(requireServices(), input);
    }),

  // ---- export ----

  /** List conversations with message counts (batch query). */
  listConversationsWithCount: procedure.query(async () => {
    const services = requireServices();
    const contacts = await services.recentContacts.getRecentContact(200);

    const groupCodes = contacts.filter(c => String(c.chatType).includes('GROUP')).map(c => c.targetUid);
    const c2cUids = contacts.filter(c => String(c.chatType).includes('C2C')).map(c => c.targetUid);

    const [groupCounts, c2cCounts] = await Promise.all([
      getAppContext().account?.groupMsgs.countByGroups(groupCodes) ?? Promise.resolve({} as Record<string, number>),
      getAppContext().account?.c2cMsgs.countByUids(c2cUids) ?? Promise.resolve({} as Record<string, number>),
    ]);

    return contacts.map(c => ({
      ...recentContactToWire(c),
      messageCount: String(c.chatType).includes('GROUP') ? (groupCounts[c.targetUid] ?? 0) : (c2cCounts[c.targetUid] ?? 0),
    }));
  }),

  /** Start an export task. */
  startExport: procedure
    .input(z.object({
      kind: z.enum(['group', 'c2c']),
      conv: z.string().min(1),
      name: z.string().min(1),
      format: z.enum(['json', 'jsonl', 'txt', 'csv', 'xlsx']),
      total: z.number().int().min(0),
      /** Also export every sender's avatar into an avatars/ subfolder. */
      exportAvatar: z.boolean().optional(),
      /** Media export: copy local media into media/ and CDN-complete images. */
      media: z
        .object({
          exportMedia: z.boolean(),
          completeMedia: z.boolean(),
          downloadVideo: z.boolean(),
          downloadFile: z.boolean(),
        })
        .optional(),
      /** Inclusive send-time window (unix seconds); null bound = open-ended. */
      range: z.object({ start: z.number().nullable(), end: z.number().nullable() }).optional(),
    }))
    .mutation(async ({ input }) => {
      return requireServices().exportManager.startTask(input);
    }),

  /**
   * Force a one-shot rkey harvest from the online QQ for the open account — the
   * explicit "立即重新获取 rkey" before a media-completing export. Returns true
   * when fresh rkeys were stored.
   */
  refreshRkeys: procedure.mutation(() => {
    return getAppContext().refreshRkeysNow();
  }),

  /** List all export tasks. */
  listExportTasks: procedure.query(() => {
    return requireServices().exportManager.listTasks();
  }),

  /** Pause a running task. */
  pauseExportTask: procedure
    .input(z.object({ taskId: z.string().min(1) }))
    .mutation(({ input }) => {
      return requireServices().exportManager.pauseTask(input.taskId);
    }),

  /** Cancel a task. */
  cancelExportTask: procedure
    .input(z.object({ taskId: z.string().min(1) }))
    .mutation(({ input }) => {
      return requireServices().exportManager.cancelTask(input.taskId);
    }),

  /** Delete a task. */
  deleteExportTask: procedure
    .input(z.object({ taskId: z.string().min(1) }))
    .mutation(({ input }) => {
      return requireServices().exportManager.deleteTask(input.taskId);
    }),

  /** Subscribe to export task progress. */
  onExportProgress: procedure.subscription(() => {
    return observable<any>((emit) => {
      const handler = (progress: any) => emit.next(progress);
      requireServices().exportManager.on('progress', handler);
      return () => {
        requireServices().exportManager.off('progress', handler);
      };
    });
  }),

  /** Save exported file to user-selected location. */
  saveExportFile: procedure
    .input(z.object({
      sourcePath: z.string().min(1),
      defaultName: z.string().min(1),
      format: z.enum(['json', 'jsonl', 'txt', 'csv', 'xlsx']),
    }))
    .mutation(async ({ input }) => {
      const { dialog } = await import('electron');
      const { copyFileSync } = await import('fs');
      const result = await dialog.showSaveDialog({
        defaultPath: input.defaultName,
        filters: [{ name: 'Export', extensions: [input.format] }],
      });
      if (result.canceled || !result.filePath) return false;
      copyFileSync(input.sourcePath, result.filePath);
      return true;
    }),

  /**
   * Save an avatar-bundle task (message file + avatars/) to a user-picked
   * folder. Copies the whole cache bundle into `<chosen>/<name>/`. Returns false
   * if the task has no bundle or the user cancels.
   */
  saveExportBundle: procedure
    .input(z.object({ taskId: z.string().min(1) }))
    .mutation(async ({ input }) => {
      const task = requireServices().exportManager.getTask(input.taskId);
      if (!task?.bundleDir) return false;
      const { existsSync, cpSync } = await import('node:fs');
      if (!existsSync(task.bundleDir)) return false;
      const { dialog } = await import('electron');
      const result = await dialog.showOpenDialog({
        title: '选择导出保存文件夹',
        properties: ['openDirectory', 'createDirectory'],
      });
      if (result.canceled || result.filePaths.length === 0) return false;
      const dest = join(result.filePaths[0]!, sanitizePathSegment(task.name, task.id));
      cpSync(task.bundleDir, dest, { recursive: true });
      return true;
    }),

  // ---- voice transcription (语音转文字) ----

  /**
   * Transcribe a voice (ptt) message to text. Inputs mirror what the renderer
   * already has for the `weq-media://ptt` request (sendTime ms / fileName /
   * fileToken). Resolves the silk on disk (or downloads it via rkey, same as
   * the media protocol), decodes to 16 kHz WAV, and runs the selected model in
   * the forked sherpa-onnx worker.
   *
   * Returns `{ success:false, error }` for every failure mode (no model chosen,
   * model not downloaded, silk missing, decode/engine error) so the bubble can
   * show a friendly message instead of throwing.
   */
  transcribeVoice: procedure
    .input(z.object({ t: z.number(), name: z.string(), token: z.string().default('') }))
    .mutation(async ({ input }): Promise<{ success: boolean; text?: string; error?: string }> => {
      const ctx = getAppContext();
      const boot = ctx.bootstrap;
      const services = ctx.services;
      if (!boot) return { success: false, error: '原生组件未就绪' };
      if (!services) return { success: false, error: '未打开账号' };

      const modelId = boot.userConfig.getSettings().voiceTranscribe.modelId;
      if (!modelId) return { success: false, error: '未选择转录模型' };
      const model = getVoiceModel(modelId);
      if (!model) return { success: false, error: '转录模型不存在' };

      const status = boot.voiceTranscribe.getModelStatus(modelId);
      if (!status?.downloaded) return { success: false, error: '转录模型未下载' };

      // Locate the silk on disk; fall back to an rkey-backed CDN download (same
      // path the ptt media protocol uses).
      const { source } = await services.fileSearch.findFile(input.t, input.name, 'ptt');
      let silk = source;
      if (!silk && input.token) {
        silk = await services.mediaDownload.download(input.token, {
          ext: '.silk',
          rkeyTypes: [PRIVATE_PTT_RKEY_TYPE, GROUP_PTT_RKEY_TYPE],
        });
      }
      if (!silk) return { success: false, error: '未找到语音文件' };

      const { decodeSilkToWav16kBuffer } = await import('../../voice');
      const wav = await decodeSilkToWav16kBuffer(silk);
      if (!wav) return { success: false, error: '语音解码失败' };

      const paths = boot.voiceTranscribe.resolveModelPaths(modelId);
      if (!paths.model || !paths.tokens) return { success: false, error: '模型文件缺失' };

      const { transcribeWav } = await import('../../transcribe/engine');
      const result = await transcribeWav(
        wav,
        { model: paths.model, tokens: paths.tokens },
        { engine: model.engine, languages: model.languages },
      );
      if (!result.success) return { success: false, error: result.error ?? '识别失败' };
      return { success: true, text: result.text ?? '' };
    }),
});
