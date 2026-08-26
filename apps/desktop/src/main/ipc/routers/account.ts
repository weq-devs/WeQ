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
import { randomUUID } from 'node:crypto';
import { basename, dirname, extname, join } from 'node:path';
import {
  getAppContext,
  requireBootstrap,
  dbEventBus,
  type AccountServices,
} from '../../context/app_context';
import { sampleHitokoto } from '../../hitokoto';
import { resolveResource } from '../../resource';
import { procedure, router } from '../trpc';
import { dbExplorerRouter } from './db_explorer';
import { antiRecallRouter } from './anti_recall';
import { avatarResourceRouter } from './avatar_resource';
import { sysEmojiRouter } from './sys_emoji';
import { marketEmojiRouter } from './market_emoji';
import { customEmojiRouter } from './custom_emoji';
import { relatedEmojiRouter } from './related_emoji';
import { fileResourceRouter } from './file_resource';
import { mediaResourceRouter } from './media_resource';
import { resourceCleanupRouter } from './resource_cleanup';
import { dressupRouter } from './dressup';
import { mutualMarkRouter } from './mutual_mark';
import { assistantBus, type AssistantStreamEvent } from '../../mcp/assistant_bus';
import { validateMcpConfig } from '../../mcp/external';
import { groupChatBus, type GroupChatStreamEvent } from '../../mcp/agentlab_group_bus';
import {
  clientKeyExpiryMs,
  buildPtlogin2JumpUrl,
  parseClientKeyJson,
  toRenderElements,
  PRIVATE_PTT_RKEY_TYPE,
  GROUP_PTT_RKEY_TYPE,
  getHost,
  getVoiceModel,
  buildBotExport,
  probeBotWebUi,
  downloadUrlToFile,
  checkAccountDatabaseHealth,
  collectDbDamageFeedback,
  findLatestDbHealthReport,
  writeDbHealthReport,
  type AlbumMedia,
  type AlbumMediaPage,
  type NewMessages,
  type DbChange,
  type RenderC2cMsg,
  type RenderGroupMsg,
} from '@weq/service';
import {
  buddyRequestToWire,
  botProfileToWire,
  buddyToWire,
  categoryToWire,
  c2cMsgToWire,
  collectionItemToWire,
  forwardRecordToWire,
  groupBulletinToWire,
  groupMsgToWire,
  groupNotifyToWire,
  recentContactToWire,
  recentContactTopToWire,
  hiddenSessionToWire,
  deletedSessionToWire,
  officialAccountSummaryToWire,
  serviceAccountSummaryToWire,
  userProfileToWire,
  groupDetailToWire,
  groupEssenceToWire,
  groupNoticeToBulletinWire,
  groupMemberToWire,
  groupMemberLevelInfoToWire,
  groupExtToWire,
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

function requireScheduler(): import('@weq/service').ExportScheduler {
  const ctx = getAppContext();
  if (!ctx.scheduler) {
    throw new Error('No account session open — call bootstrap.openAccount first.');
  }
  return ctx.scheduler;
}

/** 会话类型判定（首页门面用；兼容字符串枚举与数字）。 */
function chatKindOf(chatType: unknown): 'c2c' | 'group' | null {
  const s = String(chatType).toUpperCase();
  if (s.includes('C2C') || s === '1') return 'c2c';
  if (s.includes('GROUP') || s === '2') return 'group';
  return null;
}

/**
 * 一条消息 → 纯文本，仅接受 text/at/face；出现任何媒体/卡片/引用等即返回 null
 * （整条丢弃）。首页「虚拟聊天流」只滚动展示轻量文字气泡，媒体一律排除。
 */
function plainTextLine(
  elements: readonly { type?: string; data?: { textContent?: unknown; faceText?: unknown } }[],
): string | null {
  const parts: string[] = [];
  for (const el of elements ?? []) {
    if (el.type === 'text' || el.type === 'at') {
      parts.push(String(el.data?.textContent ?? ''));
    } else if (el.type === 'face') {
      const t = String(el.data?.faceText ?? '').trim();
      parts.push(t ? `[${t}]` : '');
    } else {
      return null; // 图片/语音/视频/文件/卡片/引用… → 丢弃整条
    }
  }
  const text = parts.join('').replace(/\s+/g, ' ').trim();
  return text || null;
}

/** Fisher–Yates 就地洗牌（主进程内允许 Math.random）。 */
function shuffleInPlace<T>(arr: T[]): void {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [arr[i], arr[j]] = [arr[j]!, arr[i]!];
  }
}

/**
 * 首页门面：从**私聊**会话里抽一批「别人发来的」纯文本短句，带对方昵称/QQ 号
 * （前端据 QQ 号取头像），去重后洗牌返回。刻意加随机：
 *   - 会话先洗牌再取子集（不局限于最近几个）；
 *   - 每个会话多读一些历史再随机挑（不总是最新那几条）；
 * 配合前端「每次进首页都重新请求」，做到每次打开都换一批。
 * 只留 text/face、按可读长度筛选、剔除链接、剔除自己发的。
 */
async function sampleHomeChatLines(
  limit: number,
): Promise<Array<{ text: string; uin: string; name: string }>> {
  const svc = requireServices();
  const selfUin = (await svc.profile.getSelfProfile())?.uin ?? -1n;
  const contacts = await svc.recentContacts.getRecentContact(200);
  const c2c = contacts.filter((c) => chatKindOf(c.chatType) === 'c2c');
  shuffleInPlace(c2c);
  const picked = c2c.slice(0, 24);

  const perConv = await Promise.all(
    picked.map(async (c) => {
      try {
        // 多读一点历史，给随机挑选更大的样本空间（一次查询开销不大）。
        const rows = await svc.msgs.getC2cLatest(c.targetUid, 120);
        return { c, rows };
      } catch {
        return { c, rows: [] as Awaited<ReturnType<typeof svc.msgs.getC2cLatest>> };
      }
    }),
  );

  const seen = new Set<string>();
  const pool: Array<{ text: string; uin: string; name: string }> = [];
  for (const { c, rows } of perConv) {
    const name = c.targetRemark || c.targetDisplayName || c.senderNick || String(c.targetUin);
    const uin = c.targetUin ? String(c.targetUin) : '';
    for (const r of rows) {
      if (r.senderUin === selfUin) continue; // 只保留别人发的
      const text = plainTextLine(r.elements as never);
      if (!text) continue;
      const len = [...text].length;
      if (len < 3 || len > 28) continue;
      if (/https?:\/\//i.test(text)) continue;
      if (seen.has(text)) continue;
      seen.add(text);
      pool.push({ text, uin, name });
    }
  }

  shuffleInPlace(pool);
  return pool.slice(0, limit);
}

const agentLabModelRef = z.object({ providerId: z.string().min(1), model: z.string().min(1) });
const agentLabModels = z.object({
  chat: agentLabModelRef,
  embedding: agentLabModelRef.optional(),
  vision: agentLabModelRef.optional(),
  voiceClone: agentLabModelRef.optional(),
});

/**
 * 进行中的助手任务：runId → AbortController。chatWithAssistant 建、结束时清；
 * abortAssistantRun 据此掐断（用户点「停止」）。模块级单例，与 assistantBus 同层。
 */
const activeAssistantRuns = new Map<string, AbortController>();

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
  /** 「自动注入 QQ（完整功能）」总闸——关闭即完全离线模式，在线功能不可用。 */
  injectEnabled: boolean;
  clientKeyValid: boolean;
  clientKeyExpiresAt: number | null;
  clientKeySecondsLeft: number;
}

export interface AlbumMediaWire extends AlbumMedia {
  kind: 'image' | 'video';
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
  failed: Array<{
    albumId: string;
    albumTitle: string;
    fileName: string;
    url: string;
    error: string;
  }>;
}

// ---- 群文件 (OIDB 0x6D8_1 列表 / 0x6D6_2 下载直链) ----

const groupFileInput = z.object({
  groupCode: z.string().min(1),
  /** 目录:根目录 '/',子目录传 folderId。 */
  folderId: z.string().optional(),
});

const groupFileDownloadInput = z.object({
  groupCode: z.string().min(1),
  fileId: z.string().min(1),
  fileName: z.string().optional(),
  busId: z.number().int().optional(),
});

const exportGroupFilesInput = z.object({
  groupCode: z.string().min(1),
  outputDir: z.string().min(1),
  /** 省略则递归导出全群文件(含子文件夹,保留目录结构)。 */
  files: z
    .array(
      z.object({
        fileId: z.string().min(1),
        fileName: z.string().min(1),
        busId: z.number().int().optional(),
        /** 相对根目录的文件夹路径段,用于在输出目录里重建目录树。 */
        path: z.array(z.string()).optional(),
      }),
    )
    .optional(),
  concurrency: z.number().int().min(1).max(8).optional(),
});

const flashListFilesInput = z.object({
  filesetId: z.string().min(1),
  parentId: z.string().optional().default(''),
  zipFileId: z.string().optional().default(''),
});

const flashSelectionSchema = z.object({
  filesetId: z.string().min(1),
  fileId: z.string().min(1),
  physicalId: z.string().optional().default(''),
  name: z.string().min(1),
  fileSize: z.number().optional().default(0),
  path: z.string().min(1),
  isDir: z.boolean().optional().default(false),
  isZipContent: z.boolean().optional().default(false),
  zipFileId: z.string().optional().default(''),
});

interface GroupFileDownloadWork {
  fileId: string;
  fileName: string;
  busId: number;
  targetPath: string;
}

export interface GroupFileExportResult {
  outputDir: string;
  total: number;
  ok: number;
  failed: Array<{ fileId: string; fileName: string; error: string }>;
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
    injectEnabled: getAppContext().bootstrap?.userConfig.getSettings().autoInjectQq ?? true,
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
  if (!state.injectEnabled) {
    throw new Error('已开启完全离线模式（自动注入 QQ 已关闭），该功能需要在线 QQ 实例。');
  }
}

function requireFreshClientKeyForAlbum(services = requireServices()): void {
  const state = albumAccessState(services);
  if (!state.qqOnline) {
    throw new Error('需要先登录该账号的 QQ 客户端。');
  }
  if (!state.injectEnabled) {
    throw new Error('已开启完全离线模式（自动注入 QQ 已关闭），群相册等在线功能不可用。');
  }
  if (!state.clientKeyValid) {
    throw new Error(
      'ClientKey 未获取或已过期，请确认 QQ 在线且已开启「自动注入 QQ（完整功能）」。',
    );
  }
}

/**
 * 仅要求在线 QQ 实例（不要求注入 / ClientKey）—— 走 Web CGI 的接口用：
 * qzone.qq.com / qun.qq.com 的 p_skey 可经 ptlogin2 本地快速登录兜底获取。
 */
function requireOnlineQqForWeb(services = requireServices()): void {
  const state = albumAccessState(services);
  if (!state.qqOnline) {
    throw new Error('需要先登录该账号的 QQ 客户端。');
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
  // 仅要求在线：qun.qq.com 的 skey/pskey 可由 pt_login 兜底，无需注入与 ClientKey。
  if (!state.qqOnline) return localPage;

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

function bestUrls(
  entries: Array<{ url: { url: string; width: number; height: number } | null }>,
): Array<{ url: string; width: number; height: number }> {
  return entries
    .map((entry) => entry.url)
    .filter((entry): entry is NonNullable<typeof entry> => {
      if (!entry?.url) return false;
      return !isAlbumPlaceholderUrl(entry.url);
    })
    .slice()
    .sort((a, b) => (b.width || 0) * (b.height || 0) - (a.width || 0) * (a.height || 0));
}

function imageUrls(image: NonNullable<AlbumMedia['image']>): {
  previewUrl: string;
  originalUrl: string;
} {
  const sorted = bestUrls(image.photoUrls);
  const defaultUrl =
    image.defaultUrl && !isAlbumPlaceholderUrl(image.defaultUrl.url) ? image.defaultUrl.url : '';
  return {
    previewUrl: defaultUrl || sorted[sorted.length - 1]?.url || sorted[0]?.url || '',
    originalUrl: sorted[0]?.url || defaultUrl || '',
  };
}

function mediaUrls(media: AlbumMedia): Omit<AlbumMediaWire, keyof AlbumMedia> {
  const video = media.video;
  if (video) {
    // 视频卡片显示封面图,下载/播放取最高码率的那路;videoUrl 为空时回退到顶层 url。
    const cover = video.cover ? imageUrls(video.cover) : { previewUrl: '', originalUrl: '' };
    const streams = bestUrls(video.videoUrls);
    const src =
      streams[0]?.url || (video.url && !isAlbumPlaceholderUrl(video.url) ? video.url : '');
    return {
      kind: 'video',
      previewUrl: cover.previewUrl || cover.originalUrl,
      originalUrl: src,
      fileName: video.id || '',
    };
  }

  const image = media.image;
  if (!image) return { kind: 'image', previewUrl: '', originalUrl: '', fileName: '' };
  return { kind: 'image', ...imageUrls(image), fileName: image.name || '' };
}

function mediaToWire(media: AlbumMedia): AlbumMediaWire {
  return { ...media, ...mediaUrls(media) };
}

function albumMediaKey(media: AlbumMediaWire): string {
  const image = media.image;
  if (image?.lloc) return `img:${image.lloc}`;
  const video = media.video;
  if (video?.id) return `vid:${video.id}`;
  return `url:${media.originalUrl || media.previewUrl}`;
}

/**
 * 群相册末页的 nextAttachInfo 依然是非空游标（指向本页最后一条的
 * batch_id/lloc），拿它翻页服务端会原样重发本页。解析游标确认已到结尾。
 */
interface AlbumNextAttachInfo {
  Loc?: { batch_id?: number | string; lloc?: string };
  Lloc?: string;
}

function attachInfoAtEnd(page: AlbumMediaPage, nextAttachInfo: string): boolean {
  const last = page.mediaList[page.mediaList.length - 1];
  if (!last) return false;
  let info: AlbumNextAttachInfo | null = null;
  try {
    info = JSON.parse(nextAttachInfo) as AlbumNextAttachInfo | null;
  } catch {
    return false;
  }
  const loc = info?.Loc;
  if (loc?.batch_id != null && last.batchId && String(loc.batch_id) === last.batchId) {
    return true;
  }
  const lastLloc = last.image?.lloc || last.video?.cover?.lloc || '';
  if (lastLloc && (loc?.lloc === lastLloc || info?.Lloc === lastLloc)) {
    return true;
  }
  return false;
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
  const seenKeys = new Set<string>();
  const seenAttachInfo = new Set<string>();
  let attachInfo = '';
  for (let guard = 0; guard < 100; guard += 1) {
    const page = await services.groupAlbumMedia.getMediaList(groupCode, albumId, attachInfo);
    for (const wire of page.mediaList
      .map(mediaToWire)
      .filter((media) => media.originalUrl || media.previewUrl)) {
      const key = albumMediaKey(wire);
      if (seenKeys.has(key)) continue;
      seenKeys.add(key);
      out.push(wire);
    }
    const next = page.nextAttachInfo || '';
    if (!next || seenAttachInfo.has(next) || attachInfoAtEnd(page, next)) break;
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
    // biome-ignore lint/suspicious/noControlCharactersInRegex: 有意剔除文件名中的控制字符
    .replace(/[<>:"/\\|?*\x00-\x1f]/g, '_')
    .replace(/\s+/g, ' ')
    .replace(/[. ]+$/g, '')
    .slice(0, 120)
    .trim();
  const name = cleaned || fallback;
  return /^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/i.test(name) ? `_${name}` : name;
}

function filenameFromUrl(url: string, fallback: string, index: number, defaultExt: string): string {
  let name = fallback;
  if (!name) {
    try {
      name = decodeURIComponent(basename(new URL(url).pathname));
    } catch {
      name = '';
    }
  }
  const safe = sanitizePathSegment(
    name,
    `photo-${String(index + 1).padStart(4, '0')}${defaultExt}`,
  );
  return extname(safe) ? safe : `${safe}${defaultExt}`;
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
      const fileName = uniqueFilename(
        filenameFromUrl(url, item.fileName, index, item.kind === 'video' ? '.mp4' : '.jpg'),
        used,
      );
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

async function exportGroupFiles(
  services: AccountServices,
  input: z.infer<typeof exportGroupFilesInput>,
): Promise<GroupFileExportResult> {
  requireQqOnlineForAlbum(services);

  // 没给具体文件就递归整个群,path 用来在输出目录里重建文件夹结构。
  const targets =
    input.files ??
    (await services.groupFile.listRecursive(Number(input.groupCode))).map((f) => ({
      fileId: f.fileId,
      fileName: f.fileName,
      busId: f.busId,
      path: f.path,
    }));

  const work: GroupFileDownloadWork[] = [];
  // 同名去重按目录分桶 —— 不同子文件夹下的同名文件本来就不冲突。
  const usedByDir = new Map<string, Set<string>>();
  targets.forEach((file, index) => {
    const segments = (file.path ?? []).map((seg, i) => sanitizePathSegment(seg, `folder-${i + 1}`));
    const dir = join(input.outputDir, ...segments);
    const used = usedByDir.get(dir) ?? new Set<string>();
    usedByDir.set(dir, used);
    const fileName = uniqueFilename(
      sanitizePathSegment(file.fileName, `file-${String(index + 1).padStart(4, '0')}`),
      used,
    );
    work.push({
      fileId: file.fileId,
      fileName,
      busId: file.busId ?? 102,
      targetPath: join(dir, fileName),
    });
  });

  const failed: GroupFileExportResult['failed'] = [];
  let ok = 0;
  await mkdir(input.outputDir, { recursive: true });
  await runWithConcurrency(work, input.concurrency ?? 4, async (item) => {
    try {
      // 直链有时效,逐个文件在下载前才换取。
      const url = await services.mediaUrl.getGroupFileUrl(
        Number(input.groupCode),
        item.fileId,
        item.busId,
        item.fileName,
      );
      const outcome = await downloadUrlToFile(url, item.targetPath);
      if (!outcome.ok) throw new Error(outcome.reason);
      ok += 1;
    } catch (e) {
      failed.push({
        fileId: item.fileId,
        fileName: item.fileName,
        error: e instanceof Error ? e.message : String(e),
      });
    }
  });

  return { outputDir: input.outputDir, total: work.length, ok, failed };
}

export const accountRouter = router({
  // ---- database explorer (SQLiteStudio-style browse / query / edit) ----
  dbExplorer: dbExplorerRouter,
  // ---- 防撤回（拦截 QQ 撤回的 SQL 触发器 + 按会话选择）----
  antiRecall: antiRecallRouter,
  // ---- local avatar cache browser (nt_data/avatar/*) ----
  avatarResource: avatarResourceRouter,
  // ---- built-in system emoji resource browser ----
  sysEmoji: sysEmojiRouter,
  // ---- market-face (store sticker) cache browser ----
  marketEmoji: marketEmojiRouter,
  // ---- custom-emoji (received + personal) cache browser ----
  customEmoji: customEmojiRouter,
  // ---- related-emoji (keyword → gif) cache browser ----
  relatedEmoji: relatedEmojiRouter,
  // ---- File 目录 (nt_data/File/Ori) + 下载文件 (file_assistant.db) browser ----
  fileResource: fileResourceRouter,
  // ---- 图片墙 / QQ空间 / 图片 / 视频 local media cache browser ----
  mediaResource: mediaResourceRouter,
  // ---- nt_data 资源清理释放 (本地资源整理 → 清理释放) ----
  resourceCleanup: resourceCleanupRouter,
  // ---- 个性装扮（气泡九宫格 / 聊天字体）----
  dressup: dressupRouter,
  // ---- 好友/群友互动标识（任务 / 惊喜 / 限定 / 幸运字符）----
  mutualMark: mutualMarkRouter,

  // ---- agent lab ----

  listAgentLabPersonas: procedure.query(() => {
    return requireServices().agentLab.listPersonas();
  }),

  getAgentLabPersona: procedure
    .input(z.object({ personaId: z.string().min(1) }))
    .query(({ input }) => {
      return requireServices().agentLab.getPersona(input.personaId);
    }),

  getAgentLabPersonaDetail: procedure
    .input(z.object({ personaId: z.string().min(1) }))
    .query(({ input }) => {
      return requireServices().agentLab.getPersonaDetail(input.personaId);
    }),

  buildAgentLabFromC2c: procedure
    .input(
      z.object({
        personaId: z.string().min(1),
        name: z.string().optional(),
        models: agentLabModels,
        customPrompt: z.string().optional(),
        targetUid: z.string().min(1),
        title: z.string().optional(),
        // 总消息上限（默认 C2C_CORPUS_CAP）；一般不由前端指定。
        limit: z.number().int().min(20).max(20000).optional(),
        // 语料模式：private 纯私聊不回退；group 私聊不足时群补采。默认 group。
        mode: z.enum(['private', 'group']).optional(),
      }),
    )
    .mutation(async ({ input }) => {
      return requireServices().agentLab.buildFromC2c({
        personaId: input.personaId,
        name: input.name,
        models: input.models,
        customPrompt: input.customPrompt,
        targetUid: input.targetUid,
        title: input.title,
        limit: input.limit,
        mode: input.mode,
      });
    }),

  /** Subscribe to AgentLab clone-build progress (drives the build progress bar). */
  onAgentLabBuildProgress: procedure.subscription(() => {
    return observable<import('@weq/service').AgentLabBuildProgress>((emit) => {
      const svc = requireServices().agentLab;
      const handler = (p: import('@weq/service').AgentLabBuildProgress): void => emit.next(p);
      svc.on('build-progress', handler);
      return () => {
        svc.off('build-progress', handler);
      };
    });
  }),

  chatWithAgentLabPersona: procedure
    .input(
      z.object({
        personaId: z.string().min(1),
        text: z.string().min(1),
        history: z
          .array(
            z.object({
              role: z.enum(['user', 'assistant']),
              text: z.string().min(1),
            }),
          )
          .default([]),
      }),
    )
    .mutation(async ({ input }) => {
      return requireServices().agentLab.chat({
        personaId: input.personaId,
        text: input.text,
        history: input.history,
      });
    }),

  deleteAgentLabPersona: procedure
    .input(z.object({ personaId: z.string().min(1) }))
    .mutation(({ input }) => {
      return requireServices().agentLab.deletePersona(input.personaId);
    }),

  /** 导出克隆体为独立 OneBot bot（napcat/snowluma）产物文件夹。 */
  exportAgentLabPersona: procedure
    .input(
      z.object({
        personaId: z.string().min(1),
        adapterType: z.enum(['napcat', 'snowluma']),
        wsUrl: z.string().min(1),
        token: z.string().optional(),
        selfId: z.string().min(1),
        voice: z.boolean().optional(),
        groupChat: z.boolean().optional(),
        groupReplyMode: z.enum(['llm', 'heuristic']).optional(),
        webuiPort: z.number().int().min(1).max(65535).optional(),
        // 可选图像模型：写进导出 persona 的 models.vision，供 bot 解析上传的新表情。
        visionModel: agentLabModelRef.optional(),
      }),
    )
    .mutation(async ({ input }) => {
      const ctx = getAppContext();
      const svc = ctx.services?.agentLab;
      const cfg = ctx.bootstrap?.agentLabConfig;
      if (!svc || !cfg) throw new Error('账号未就绪');
      const record = svc.getPersonaRecord(input.personaId);
      if (!record) throw new Error('找不到克隆体');
      const { persona } = record;

      // 抽 persona 用到的 LLM providers（chat/embedding/vision，去重）。
      // 导出弹窗显式指定的图像模型也并进来（即使克隆时没用 vision，也能让 bot 具备解析新表情的能力）。
      const llmIds = new Set<string>();
      for (const m of [
        persona.models.chat,
        persona.models.embedding,
        persona.models.vision,
        input.visionModel,
      ]) {
        if (m?.providerId) llmIds.add(m.providerId);
      }
      const llmProviders: Array<{ id: string; baseUrl: string; apiKey: string }> = [];
      for (const id of llmIds) {
        const p = cfg.getProvider(id);
        if (!p) throw new Error(`缺少 LLM provider 配置：${id}（请先在设置里配置该厂商）`);
        llmProviders.push({ id: p.id, baseUrl: p.baseUrl, apiKey: p.apiKey });
      }
      // 抽 TTS provider（若绑了语音克隆）。
      const ttsProviders = persona.voice?.providerId
        ? [cfg.getTtsProvider(persona.voice.providerId)].filter(
            (t): t is NonNullable<typeof t> => t !== null,
          )
        : [];

      // 定位预打包引擎。
      const botMjs = resolveResource('bot-runtime', 'bot.mjs');
      if (!botMjs) throw new Error('找不到 bot 引擎 bot.mjs（开发环境请先运行 pnpm build:bot）');

      // 选输出位置。
      const pickedDir = await getHost().pickDirectory({ title: '选择导出位置' });
      if (!pickedDir) return { canceled: true as const };
      const safeName =
        (persona.name || 'clone').replace(/[^\w一-龥-]+/g, '_').slice(0, 40) || 'clone';
      const outDir = join(pickedDir, `${safeName}-bot`);

      const result = await buildBotExport({
        outDir,
        botRuntimeMjs: botMjs,
        persona,
        pairs: record.pairs,
        agentlabRoot: svc.assetRoot,
        llmProviders,
        ttsProviders,
        adapter: { type: input.adapterType, wsUrl: input.wsUrl, token: input.token },
        selfId: input.selfId,
        features: {
          voice: input.voice ?? false,
          groupChat: input.groupChat ?? false,
          groupReplyMode: input.groupReplyMode ?? 'llm',
        },
        webuiPort: input.webuiPort,
        visionModel: input.visionModel,
      });
      // 记录 id → WebUI 访问信息，导出后在设置页可查密钥 / 一键打开控制台。
      svc.recordExport(input.personaId, {
        key: result.webui.key,
        id: result.webui.id,
        port: result.webui.port,
        url: result.webui.url,
        outDir: result.outDir,
        exportedAt: Date.now(),
      });
      return { canceled: false as const, ...result };
    }),

  /** 查某克隆体最近一次导出的 WebUI 访问信息（密钥/端口/url；没导出过则 null）。 */
  getAgentLabExportInfo: procedure
    .input(z.object({ personaId: z.string().min(1) }))
    .query(({ input }) => {
      return requireServices().agentLab.getExportInfo(input.personaId) ?? null;
    }),

  /**
   * 打开某克隆体导出 bot 的 WebUI 控制台窗口（用存储的密钥自动登录）。
   * 先探活默认地址（或用户传入的 url）；不可达则返回 { needUrl: true } 让前端提示输入地址。
   */
  openBotWebUi: procedure
    .input(z.object({ personaId: z.string().min(1), url: z.string().optional() }))
    .mutation(async ({ input }) => {
      const svc = requireServices().agentLab;
      const info = svc.getExportInfo(input.personaId);
      if (!info) throw new Error('这个克隆体还没有导出过，请先导出机器人。');
      const base = (input.url?.trim() || info.url).replace(/\/+$/, '');
      const reachable = await probeBotWebUi(`${base}/`);
      if (!reachable)
        return { opened: false as const, needUrl: true as const, defaultUrl: info.url };
      const persona = svc.getPersona(input.personaId);
      const opened = await getHost().openBotConsole({
        url: base,
        key: info.key,
        title: persona?.name,
      });
      return {
        opened: true as const,
        needUrl: false as const,
        openUrl: opened?.url ?? null,
      };
    }),

  // ── 克隆体群聊（M2 群骨架）─────────────────────────────────────────────

  createAgentLabGroup: procedure
    .input(z.object({ name: z.string().min(1), personaIds: z.array(z.string().min(1)).min(1) }))
    .mutation(({ input }) => {
      return requireServices().agentLab.createGroup({
        name: input.name,
        personaIds: input.personaIds,
      });
    }),

  listAgentLabGroups: procedure.query(() => {
    return requireServices().agentLab.listGroups();
  }),

  getAgentLabGroupDetail: procedure
    .input(z.object({ groupId: z.string().min(1) }))
    .query(({ input }) => {
      return requireServices().agentLab.getGroupDetail(input.groupId);
    }),

  renameAgentLabGroup: procedure
    .input(z.object({ groupId: z.string().min(1), name: z.string().min(1) }))
    .mutation(({ input }) => {
      requireServices().agentLab.renameGroup(input.groupId, input.name);
      return true;
    }),

  deleteAgentLabGroup: procedure
    .input(z.object({ groupId: z.string().min(1) }))
    .mutation(({ input }) => {
      requireServices().agentLab.deleteGroup(input.groupId);
      return true;
    }),

  addAgentLabGroupMember: procedure
    .input(z.object({ groupId: z.string().min(1), personaId: z.string().min(1) }))
    .mutation(({ input }) => {
      requireServices().agentLab.addGroupMember(input.groupId, input.personaId);
      return true;
    }),

  removeAgentLabGroupMember: procedure
    .input(z.object({ groupId: z.string().min(1), memberId: z.string().min(1) }))
    .mutation(({ input }) => {
      requireServices().agentLab.removeGroupMember(input.groupId, input.memberId);
      return true;
    }),

  getAgentLabGroupConversation: procedure
    .input(z.object({ groupId: z.string().min(1) }))
    .query(({ input }) => {
      return requireServices().agentLab.getGroupMessages(input.groupId);
    }),

  clearAgentLabGroupConversation: procedure
    .input(z.object({ groupId: z.string().min(1) }))
    .mutation(({ input }) => {
      requireServices().agentLab.clearGroupMessages(input.groupId);
      return true;
    }),

  /**
   * 启动一轮群聊（非阻塞）。立即返回 groupRunId；用户那条 + 每个克隆体的每条回复
   * 通过 `onGroupChatEvent` 逐条流式推送。镜像 chatWithAssistant 的范式。
   */
  sendAgentLabGroupMessage: procedure
    .input(
      z.object({
        groupId: z.string().min(1),
        text: z.string().min(1),
        mentions: z.array(z.string().min(1)).default([]),
      }),
    )
    .mutation(({ input }) => {
      const svc = requireServices().agentLab;
      const groupRunId = randomUUID();
      const groupId = input.groupId;
      void svc
        .sendGroupMessage({ groupId, text: input.text, mentions: input.mentions }, (message) =>
          groupChatBus.emit('event', {
            groupRunId,
            groupId,
            kind: 'message',
            message,
          } satisfies GroupChatStreamEvent),
        )
        .then(() =>
          groupChatBus.emit('event', {
            groupRunId,
            groupId,
            kind: 'done',
          } satisfies GroupChatStreamEvent),
        )
        .catch((err: unknown) =>
          groupChatBus.emit('event', {
            groupRunId,
            groupId,
            kind: 'error',
            message: err instanceof Error ? err.message : String(err),
          } satisfies GroupChatStreamEvent),
        );
      return { groupRunId };
    }),

  /** 群聊过程流（每条群消息 / 收尾 / 出错）。 */
  onGroupChatEvent: procedure.subscription(() => {
    return observable<GroupChatStreamEvent>((emit) => {
      const handler = (e: GroupChatStreamEvent): void => emit.next(e);
      groupChatBus.on('event', handler);
      return () => {
        groupChatBus.off('event', handler);
      };
    });
  }),

  updateAgentLabPersona: procedure
    .input(
      z.object({
        personaId: z.string().min(1),
        name: z.string().optional(),
        customPrompt: z.string().optional(),
        voiceCloneEnabled: z.boolean().optional(),
        voice: z
          .object({
            providerId: z.string().min(1),
            mode: z.enum(['clone', 'preset']),
            voice: z.string().optional(),
          })
          .nullable()
          .optional(),
        willing: z
          .object({
            gatePrivate: z.boolean().optional(),
            level: z.number().int().min(0).max(100).optional(),
            mustReplyOnMention: z.boolean().optional(),
          })
          .nullable()
          .optional(),
        typo: z
          .object({
            enabled: z.boolean().optional(),
            intensity: z.number().min(0).max(1).optional(),
          })
          .nullable()
          .optional(),
      }),
    )
    .mutation(({ input }) => {
      return requireServices().agentLab.updatePersona(input.personaId, {
        name: input.name,
        customPrompt: input.customPrompt,
        voiceCloneEnabled: input.voiceCloneEnabled,
        voice: input.voice,
        willing: input.willing,
        typo: input.typo,
      });
    }),

  /** AgentLab token 用量统计（主页图表）。 */
  getAgentLabTokenStats: procedure.query(() => {
    return requireServices().agentLab.getTokenStats();
  }),

  /** 系统表情清单（faceId + 外显文字），前端把克隆体回复里的 /捂脸 渲染成表情图。 */
  getSystemFaces: procedure.query(() => {
    return requireServices().emoji.listSystemFaces();
  }),

  /** 与某克隆体的持久化对话历史。 */
  getAgentLabConversation: procedure
    .input(z.object({ personaId: z.string().min(1) }))
    .query(({ input }) => {
      return requireServices().agentLab.getConversation(input.personaId);
    }),

  clearAgentLabConversation: procedure
    .input(z.object({ personaId: z.string().min(1) }))
    .mutation(({ input }) => {
      requireServices().agentLab.clearConversation(input.personaId);
      return true;
    }),

  /** 克隆体对「对方」的记忆（灯箱「记忆 / 画像」用）。 */
  getAgentLabMemories: procedure
    .input(z.object({ personaId: z.string().min(1) }))
    .query(({ input }) => {
      return requireServices().agentLab.getMemories(input.personaId);
    }),

  forgetAgentLabMemory: procedure
    .input(z.object({ personaId: z.string().min(1), memoryId: z.string().min(1) }))
    .mutation(({ input }) => {
      requireServices().agentLab.forgetMemory(input.personaId, input.memoryId);
      return true;
    }),

  clearAgentLabMemories: procedure
    .input(z.object({ personaId: z.string().min(1) }))
    .mutation(({ input }) => {
      requireServices().agentLab.clearMemories(input.personaId);
      return true;
    }),

  // ── WeQ 助手 ──────────────────────────────────────────────────────────────
  getAssistantConfig: procedure.query(() => {
    return requireServices().assistant.getConfig();
  }),

  setAssistantConfig: procedure
    .input(
      z.object({
        model: agentLabModelRef.optional(),
        customPrompt: z.string().optional(),
        reasoningEffort: z.enum(['off', 'low', 'medium', 'high']).optional(),
        mcpServers: z.string().optional(),
      }),
    )
    .mutation(({ input }) => {
      // MCP 配置若是 JSON 写法但语法有误：显式保存路径上严格校验、抛可读错误（前端 dialog.error 弹出），
      // 而不是像 parseMcpConfig 那样静默当空处理——避免用户粘错 JSON 后完全无感。
      if (input.mcpServers !== undefined) validateMcpConfig(input.mcpServers);
      return requireServices().assistant.setConfig({
        model: input.model,
        customPrompt: input.customPrompt,
        reasoningEffort: input.reasoningEffort,
        mcpServers: input.mcpServers,
      });
    }),

  /** WeQ 助手的会话列表（最近活跃倒序）。 */
  listAssistantSessions: procedure.query(() => {
    return requireServices().assistant.listSessions();
  }),

  /** 新建一个空会话，返回会话元数据（标题首轮对话后自动总结）。 */
  createAssistantSession: procedure.mutation(() => {
    return requireServices().assistant.createSession();
  }),

  /** 删除一个会话（含其对话内容）。 */
  deleteAssistantSession: procedure
    .input(z.object({ sessionId: z.string().min(1) }))
    .mutation(({ input }) => {
      requireServices().assistant.deleteSession(input.sessionId);
      return true;
    }),

  /** 重命名会话。 */
  renameAssistantSession: procedure
    .input(z.object({ sessionId: z.string().min(1), title: z.string() }))
    .mutation(({ input }) => {
      requireServices().assistant.renameSession(input.sessionId, input.title);
      return true;
    }),

  getAssistantConversation: procedure
    .input(z.object({ sessionId: z.string().min(1) }))
    .query(({ input }) => {
      return requireServices().assistant.getConversation(input.sessionId);
    }),

  clearAssistantConversation: procedure
    .input(z.object({ sessionId: z.string().min(1) }))
    .mutation(({ input }) => {
      requireServices().assistant.clearConversation(input.sessionId);
      return true;
    }),

  /**
   * 启动一轮助手任务（非阻塞）。立即返回 runId；每一步思考/工具调用/最终答复
   * 通过 `onAssistantEvent` 流式推送（镜像 update.download / onProgress）。
   * chat() 内部已把异常先 emit 成 `error` step 再抛出，故这里吞掉 rejection。
   */
  chatWithAssistant: procedure
    .input(z.object({ sessionId: z.string().min(1), text: z.string().min(1) }))
    .mutation(({ input }) => {
      const assistant = requireServices().assistant;
      const runId = randomUUID();
      // 每轮任务挂一个 AbortController，供 abortAssistantRun 按 runId 掐断（用户点「停止」）。
      const ac = new AbortController();
      activeAssistantRuns.set(runId, ac);
      void assistant
        .chat(
          input.sessionId,
          input.text,
          (step) => assistantBus.emit('step', { runId, step } satisfies AssistantStreamEvent),
          ac.signal,
        )
        .catch(() => {})
        .finally(() => activeAssistantRuns.delete(runId));
      return { runId };
    }),

  /** 取消一轮进行中的助手任务：掐断在途 LLM 请求 + 让 chat() 在轮次边界尽早收尾（emit `aborted`）。 */
  abortAssistantRun: procedure
    .input(z.object({ runId: z.string().min(1) }))
    .mutation(({ input }) => {
      activeAssistantRuns.get(input.runId)?.abort();
      return true;
    }),

  /**
   * 查看助手写的报告文件。HTML → 在隔离窗口里用本地 Tailwind 运行时渲染；
   * markdown / text → 交给系统默认程序打开。id 的路径安全由 service.artifactInfo 校验。
   */
  openAssistantArtifact: procedure
    .input(z.object({ id: z.string().min(1) }))
    .mutation(async ({ input }) => {
      const { path, kind } = requireServices().assistant.artifactInfo(input.id);
      const host = getHost();
      const opened = kind === 'html' ? await host.openHtmlReport(path) : null;
      if (kind !== 'html') await host.revealPath(path);
      return { ok: true as const, openUrl: opened?.url ?? null };
    }),

  /** 把助手写的报告文件另存到用户选定位置（复用 saveExportFile 范式）。 */
  saveAssistantArtifact: procedure
    .input(z.object({ id: z.string().min(1), name: z.string().min(1) }))
    .mutation(async ({ input }) => {
      const { path } = requireServices().assistant.artifactInfo(input.id);
      const { copyFileSync } = await import('node:fs');
      const ext = extname(input.name).replace(/^\./, '') || 'html';
      const target = await getHost().pickSaveTarget({
        defaultName: input.name,
        extension: ext,
      });
      if (!target) return false;
      copyFileSync(path, target.path);
      return true;
    }),

  /** 助手任务的过程流（thinking / tool_call / tool_result / artifact / final / error）。 */
  onAssistantEvent: procedure.subscription(() => {
    return observable<AssistantStreamEvent>((emit) => {
      const handler = (e: AssistantStreamEvent): void => emit.next(e);
      assistantBus.on('step', handler);
      return () => {
        assistantBus.off('step', handler);
      };
    });
  }),

  /**
   * Recent conversations (recent_contact_v3_table), newest first, paginated.
   * Official (103) / service (118) rows are excluded before the limit 鈥?they
   * surface as separate merged entries, so they must not consume main-list
   * window slots. `cursor` is the row offset; `nextCursor` is null at the end.
   */
  listRecentContacts: procedure
    .input(
      z
        .object({
          limit: z.number().int().min(1).max(500).default(200),
          cursor: z.number().int().min(0).default(0),
        })
        .default({}),
    )
    .query(async ({ input }) => {
      const svc = requireServices().recentContacts;
      // 103 = 公众号, 118 = 服务号 (see @weq/codec chat_kind).
      const excludeChatTypes = [103, 118];
      const [items, total] = await Promise.all([
        svc.getRecentContact(input.limit, input.cursor, { excludeChatTypes }),
        svc.countRecentContact({ excludeChatTypes }),
      ]);
      const next = input.cursor + items.length < total ? input.cursor + items.length : undefined;
      return { items: items.map(recentContactToWire), total, nextCursor: next };
    }),

  /** 置顶会话（recent_contact_top_table），最近置顶的在前。 */
  listTopContacts: procedure.query(async () => {
    const tops = await requireServices().recentContacts.getTopContacts();
    return tops.map(recentContactTopToWire);
  }),

  /**
   * 隐藏会话（hidden_session_storage_table_v1）—— 已解析出的最后消息时间/预览，
   * 供前端并入会话列表统一渲染、排序。
   */
  listHiddenSessions: procedure.query(async () => {
    const hidden = await requireServices().hiddenSessions.listHiddenSessions();
    return hidden.map(hiddenSessionToWire);
  }),

  /**
   * 删除的会话（recent_contact_delete_storage）—— 已解析出的最后消息时间/预览，
   * 供前端在删除会话合并入口中显示。
   */
  listDeletedSessions: procedure.query(async () => {
    const deleted = await requireServices().deletedSessions.listDeletedSessions();
    return deleted.map(deletedSessionToWire);
  }),

  /**
   * 官方号会话列表（chatType=103）—— 仅 ARK 消息,按最新消息时间排序。
   */
  listOfficialAccounts: procedure.query(async () => {
    const summaries = await requireServices().officialAccount.listAccounts();
    return summaries.map(officialAccountSummaryToWire);
  }),

  /**
   * 服务号会话列表（chatType=118，service_assistant_contact 表）—— 仅 ARK 消息，
   * 按最新消息时间排序。
   */
  listServiceAccounts: procedure.query(async () => {
    const summaries = await requireServices().serviceAccount.listAccounts();
    return summaries.map(serviceAccountSummaryToWire);
  }),

  /** 公众号单个会话 ARK 消息流（最近 limit 条）。 */
  listOfficialAccountArkFeed: procedure
    .input(
      z.object({
        peerUid: z.string().min(1),
        limit: z.number().int().min(1).max(500).default(100),
      }),
    )
    .query(async ({ input }) => {
      const msgs = await requireServices().officialAccount.listArkFeed(input.peerUid, input.limit);
      return msgs.map(c2cMsgToWire);
    }),

  /** 服务号单个会话 ARK 消息流（最近 limit 条）。 */
  listServiceAccountArkFeed: procedure
    .input(
      z.object({ appId: z.string().min(1), limit: z.number().int().min(1).max(500).default(100) }),
    )
    .query(async ({ input }) => {
      const msgs = await requireServices().serviceAccount.listArkFeed(
        BigInt(input.appId),
        input.limit,
      );
      return msgs.map(c2cMsgToWire);
    }),

  /** 首页门面：随机一言若干（打字机轮播用；已按句长筛过）。 */
  sampleHitokoto: procedure
    .input(z.object({ count: z.number().int().min(1).max(80).default(30) }).optional())
    .query(({ input }) => sampleHitokoto(input?.count ?? 30)),

  /** 首页个性装扮快照（从账号 config 读，bootstrap 阶段在线注入后写入）。 */
  getHomeDress: procedure.query(() => {
    return requireServices().accountConfig.getRecord()?.homeDress ?? null;
  }),

  /** 首页门面：私聊纯文本短句池（装饰性「虚拟聊天流」用）。 */
  sampleChatLines: procedure
    .input(z.object({ limit: z.number().int().min(1).max(160).default(80) }).optional())
    .query(({ input }) => sampleHomeChatLines(input?.limit ?? 80)),

  /** Get unread message count for a conversation. */
  getUnreadInfo: procedure
    .input(z.object({ chatType: z.number().int(), uid: z.string().min(1) }))
    .query(async ({ input }) => {
      const result = await requireServices().unreadInfo.getUnreadInfo(input.chatType, input.uid);
      if (!result) return null;
      return {
        msgSeq: result.msgSeq?.toString(),
        // 提醒高亮（特别关心 / @我 / …）。各类别一条，seq 保留供上层使用。
        highlights: result.highlights?.map((h) => ({
          kind: h.kind,
          rawKind: h.rawKind,
          msgSeq: h.msgSeq.toString(),
          senderUid: h.senderUid,
          sendTime: h.sendTime.toString(),
        })),
      };
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
    .query(({ input }) =>
      fetchBefore(input.kind, input.conv, BigInt(input.beforeSeq), input.limit),
    ),

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
      // 账号身份用 configId（uin + 数据目录哈希），不能用 uin —— 同一个 QQ 号
      // 可能同时有在线账号和静态账号，只看 uin 会把它们认成一个。
      configId: record.configId,
      uin: record.uin,
      dbKey: record.dbKey,
      algos: record.algos ?? {},
      dataDir: record.dataDir ?? null,
      qqOnline: record.qqOnline ?? false,
      qqPid: record.qqPid ?? null,
      rkeys: record.rkeys ?? [],
      rkeyUpdatedAt: record.rkeyUpdatedAt ?? null,
      clientKey: record.clientKey ?? null,
      // 静态账号：渲染层据此收窄本地资源页、置灰实时消息/防撤回，并展示
      // 「关联本机媒体目录」。nativeMediaDir 为 null 表示本机没有同账号目录。
      static: record.static ?? false,
      mobile: record.mobile ?? false,
      nativeMediaDir: record.nativeMediaDir ?? null,
      nativeMediaEnabled: record.nativeMediaEnabled ?? true,
    };
  }),

  /**
   * 静态账号「关联本机原生目录」开关。关掉后所有媒体目录解析为 null，聊天里的
   * 图片/语音自动回落到 CDN 补全。立即生效，无需重开账号。
   */
  setNativeMediaEnabled: procedure
    .input(z.object({ enabled: z.boolean() }))
    .mutation(({ input }) => {
      requireServices().accountConfig.setNativeMediaEnabled(input.enabled);
      return input.enabled;
    }),

  /** List QQ buddies from profile_info.db. Omit input to fetch all (used by AgentLab). */
  listBuddies: procedure.input(pageInput.optional()).query(async ({ input }) => {
    const buddies = await requireServices().profile.listBuddies(input?.limit, input?.offset ?? 0);
    return buddies.map(buddyToWire);
  }),

  /** List QQ buddy categories. */
  listCategories: procedure.query(async () => {
    const categories = await requireServices().profile.listCategories();
    return categories.map(categoryToWire);
  }),

  /** List QQ buddy request notifications. */
  listBuddyRequests: procedure.input(pageInput.optional()).query(async ({ input }) => {
    const page = input ?? { limit: 100, offset: 0 };
    const requests = await requireServices().profile.listBuddyRequests(page.limit, page.offset);
    return requests.map(buddyRequestToWire);
  }),

  /** List group notifications. */
  listGroupNotifies: procedure.input(pageInput.optional()).query(async ({ input }) => {
    const page = input ?? { limit: 100, offset: 0 };
    const notifies = await requireServices().groupInfo.listGroupNotifies(page.limit, page.offset);
    return notifies.map(groupNotifyToWire);
  }),

  /** Get detailed profile by NT uid. */
  getProfile: procedure.input(z.object({ uid: z.string().min(1) })).query(async ({ input }) => {
    const profile = await requireServices().profile.getProfile(input.uid);
    return profile ? userProfileToWire(profile) : null;
  }),

  /**
   * The uids of every bot with a cached profile. The renderer fetches this
   * once and uses it to badge bots in member / contact / conversation lists.
   */
  botUids: procedure.query(async () => {
    return [...(await requireServices().profile.botUids())];
  }),

  /**
   * A bot's own profile (简介 / 指令列表 / 欢迎语). Null when QQ has never
   * cached that bot's card — callers fall back to the regular profile.
   */
  getBotProfile: procedure.input(z.object({ uid: z.string().min(1) })).query(async ({ input }) => {
    const profile = await requireServices().profile.getBotProfile(input.uid);
    return profile ? botProfileToWire(profile) : null;
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
  listProfiles: procedure.input(pageInput.optional()).query(async ({ input }) => {
    const page = input ?? { limit: 100, offset: 0 };
    const profiles = await requireServices().profile.listProfiles(page.limit, page.offset);
    return profiles.map(userProfileToWire);
  }),

  /**
   * List ALL friends ordered by intimacy (高→低), paginated. Backs the "好友亲密度
   * 排行" lightbox — the payload is already IPC-safe (uin is a string). Includes
   * every friend, not just those sharing groups with me.
   */
  listFriendsByIntimacy: procedure.input(pageInput.optional()).query(async ({ input }) => {
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

  /** Get extended group metadata (活跃度 / 幸运字符 / 群主 uin 等). */
  getGroupExt: procedure
    .input(z.object({ groupCode: z.string().min(1) }))
    .query(async ({ input }) => {
      const ext = await requireServices().groupInfo.getGroupExt(BigInt(input.groupCode));
      return ext ? groupExtToWire(ext) : null;
    }),

  /** List ext metadata for all groups (活跃度排行等场景). */
  listAllGroupsExt: procedure.input(pageInput.optional()).query(async ({ input }) => {
    const page = input ?? { limit: 500, offset: 0 };
    const list = await requireServices().groupInfo.listAllGroupsExt(page.limit, page.offset);
    return list.map(groupExtToWire);
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
  listAllGroups: procedure.input(pageInput.optional()).query(async ({ input }) => {
    const page = input ?? { limit: 100, offset: 0 };
    const groups = await requireServices().groupInfo.listAllGroups(page.limit, page.offset);
    return groups.map(groupDetailToWire);
  }),

  /** List group announcements. */
  listGroupBulletins: procedure.input(groupPageInput).query(async ({ input }) => {
    return listGroupBulletinsWithWebFallback(requireServices(), input);
  }),

  /** List group essence messages. */
  listGroupEssenceMessages: procedure.input(groupPageInput).query(async ({ input }) => {
    const essence = await requireServices().groupInfo.getEssenceMessages(
      BigInt(input.groupCode),
      input.limit,
      input.offset,
    );
    return essence.map(groupEssenceToWire);
  }),

  /** Get group essence messages with full content from Web API. */
  getGroupEssenceWithContent: procedure
    .input(
      z.object({
        groupCode: z.string().min(1),
        pageStart: z.number().int().min(0).optional(),
        pageLimit: z.number().int().min(1).max(100).optional(),
      }),
    )
    .query(async ({ input }) => {
      const messages = await requireServices().groupInfo.getEssenceMessagesWithContent(
        input.groupCode,
        input.pageStart ?? 0,
        input.pageLimit ?? 50,
      );
      return messages.map((msg) => ({
        groupCode: input.groupCode,
        msgSeq: msg.msgSeq,
        msgRandom: msg.msgRandom,
        senderUin: msg.senderUin,
        senderNick: msg.senderNick,
        senderTime: msg.senderTime,
        operatorUin: msg.operatorUin,
        operatorNick: msg.operatorNick,
        timestamp: msg.operatorTime,
        content: msg.content,
        canRemove: msg.canRemove,
        setStatus: 1, // Web API 返回的都是已设置的
      }));
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

  /** Batch-resolve group members by uin (QQ number). Used for group-receipt payer lookup. */
  getGroupMembersByUins: procedure
    .input(
      z.object({
        groupCode: z.string().min(1),
        uins: z.array(z.string().min(1)).min(1).max(200),
      }),
    )
    .query(async ({ input }) => {
      const members = await requireServices().groupInfo.getMembersByUins(
        BigInt(input.groupCode),
        input.uins.map((u) => BigInt(u)),
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

  getGroupMessageRanking: procedure
    .input(
      z.object({
        groupCode: z.string().min(1),
        limit: z.number().int().min(1).max(100).optional(),
        startTime: z.number().int().optional(),
        endTime: z.number().int().optional(),
      }),
    )
    .query(async ({ input }) => {
      return requireServices().groupInfo.getGroupMessageRanking(
        BigInt(input.groupCode),
        input.limit ?? 20,
        input.startTime,
        input.endTime,
      );
    }),

  /** 24-hour activity distribution for a group. */
  getGroupActiveHours: procedure
    .input(
      z.object({
        groupCode: z.string().min(1),
        startTime: z.number().int().optional(),
        endTime: z.number().int().optional(),
      }),
    )
    .query(async ({ input }) => {
      return requireServices().groupInfo.getGroupActiveHours(
        BigInt(input.groupCode),
        input.startTime,
        input.endTime,
      );
    }),

  /** Detailed per-member analytics for a group. */
  getGroupMemberAnalytics: procedure
    .input(
      z.object({
        groupCode: z.string().min(1),
        memberUid: z.string().min(1),
        startTime: z.number().int().optional(),
        endTime: z.number().int().optional(),
      }),
    )
    .query(async ({ input }) => {
      return requireServices().groupInfo.getGroupMemberAnalytics(
        BigInt(input.groupCode),
        input.memberUid,
        input.startTime,
        input.endTime,
      );
    }),

  /** Per-day message counts for a group (drives the contribution heatmap 绿墙). */
  getGroupDailyActivity: procedure
    .input(
      z.object({
        groupCode: z.string().min(1),
        startTime: z.number().int().optional(),
        endTime: z.number().int().optional(),
      }),
    )
    .query(async ({ input }) => {
      return requireServices().groupInfo.getGroupDailyActivity(
        BigInt(input.groupCode),
        input.startTime,
        input.endTime,
      );
    }),

  /** Group-wide word cloud (segmented word frequencies, top N). */
  getGroupWordCloud: procedure
    .input(
      z.object({
        groupCode: z.string().min(1),
        limit: z.number().int().min(1).max(400).optional(),
        startTime: z.number().int().optional(),
        endTime: z.number().int().optional(),
      }),
    )
    .query(async ({ input }) => {
      return requireServices().groupInfo.getGroupWordCloud(
        BigInt(input.groupCode),
        input.limit ?? 150,
        input.startTime,
        input.endTime,
      );
    }),

  /** Full one-on-one (private chat) analytics for a single peer. */
  getBuddyAnalytics: procedure
    .input(z.object({ peerUid: z.string().min(1) }))
    .query(async ({ input }) => {
      return requireServices().buddyAnalytics.getBuddyAnalytics(input.peerUid);
    }),

  /** Get formatted online status for a user. */
  getOnlineStatus: procedure
    .input(z.object({ uid: z.string().min(1) }))
    .query(async ({ input }) => {
      const status = await requireServices().onlineStatus.getOnlineStatus(input.uid);
      return status ? onlineStatusToWire(status) : null;
    }),

  /** Unified sidebar search — fast categories (conversations / friends / group members). */
  searchQuick: procedure
    .input(
      z.object({
        keyword: z.string().trim().min(1),
        limit: z.number().int().min(1).max(20).default(3),
      }),
    )
    .query(async ({ input }) => {
      return requireServices().unifiedSearch.quickSearch(input.keyword, input.limit);
    }),

  /** Unified sidebar search — slow categories (chat records / files). */
  searchSlow: procedure
    .input(
      z.object({
        keyword: z.string().trim().min(1),
        limit: z.number().int().min(1).max(20).default(3),
      }),
    )
    .query(async ({ input }) => {
      return requireServices().unifiedSearch.slowSearch(input.keyword, input.limit);
    }),

  /** Full paginated results for a search category (the "more" modal). */
  searchMore: procedure
    .input(
      z.object({
        category: z.enum(['conversation', 'friend', 'groupMember', 'chatRecord', 'file']),
        keyword: z.string().trim().min(1),
        offset: z.number().int().min(0).default(0),
        limit: z.number().int().min(1).max(100).default(20),
      }),
    )
    .query(async ({ input }) => {
      return requireServices().unifiedSearch.moreSearch(
        input.category,
        input.keyword,
        input.offset,
        input.limit,
      );
    }),

  /** Messages of one conversation matching a keyword (chat-record modal). */
  searchConversationRecords: procedure
    .input(
      z.object({
        source: z.enum(['buddy', 'group']),
        conv: z.string().min(1),
        keyword: z.string().trim().min(1),
        offset: z.number().int().min(0).default(0),
        limit: z.number().int().min(1).max(100).default(20),
      }),
    )
    .query(async ({ input }) => {
      return requireServices().unifiedSearch.conversationRecords(
        input.source,
        input.conv,
        input.keyword,
        input.offset,
        input.limit,
      );
    }),
  /** Get merged-forward / quote-reply cache for one message. */
  getForwardMessages: procedure
    .input(
      z.object({
        kind: z.enum(['c2c', 'group']),
        msgId: z.string().min(1),
        /**
         * Optional server resource id of the merged forward. When the local
         * 40900 cache misses (gap messages are never stored locally), the
         * router falls back to SsoRecvLongMsg over the live QQ connection.
         */
        resId: z.string().optional(),
      }),
    )
    .query(async ({ input }) => {
      const service = requireServices().forwardMsgs;
      const records =
        input.kind === 'group'
          ? await service.getGroupForward(BigInt(input.msgId))
          : await service.getC2cForward(BigInt(input.msgId));
      if (records.length === 0 && input.resId) {
        // 40900 缓存为空 -> 走协议在线拉取。要求 QQ 在线且未开「完全离线模式」。
        const state = albumAccessState();
        if (!state.qqOnline || !state.injectEnabled) {
          throw new Error('QQ 未在线或处于完全离线模式，无法拉取合并转发');
        }
        return await service.fetchRemote(input.resId);
      }
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
   * Delete one message the way QQ does: rewrite 40011/40012 to (1,1) in place.
   * The row stays in its conversation (rendered under a "deleted" overlay);
   * the original type columns are remembered per account for restore.
   */
  deleteMessage: procedure
    .input(
      z.object({
        msgId: z.string().min(1),
        kind: z.enum(['c2c', 'group']),
        conv: z.string().min(1),
      }),
    )
    .mutation(async ({ input }) => {
      return requireServices().msgs.deleteMessage(BigInt(input.msgId), input.kind, input.conv);
    }),

  /** Restore a WeQ-deleted message (write the original 40011/40012 back). */
  restoreMessage: procedure
    .input(z.object({ msgId: z.string().min(1) }))
    .mutation(async ({ input }) => {
      return requireServices().msgs.restoreMessage(BigInt(input.msgId));
    }),

  /**
   * The msgIds WeQ deleted in one conversation — drives the in-chat translucent
   * overlay without refetching message content.
   */
  deletedMsgIds: procedure
    .input(z.object({ kind: z.enum(['c2c', 'group']), conv: z.string().min(1) }))
    .query(({ input }): string[] => {
      return requireServices().msgs.getDeletedMsgIds(input.kind, input.conv);
    }),

  /**
   * List the WeQ-deleted (restorable) messages of one conversation,
   * newest-first, serialized like any other message page so the renderer can
   * reuse its chat bubbles in the "删除列表" panel.
   */
  deletedMessages: procedure
    .input(z.object({ kind: z.enum(['c2c', 'group']), conv: z.string().min(1) }))
    .query(async ({ input }): Promise<ChatMsgWire[]> => {
      const msgs = requireServices().msgs;
      const rows = await msgs.getDeletedMessages(input.kind, input.conv);
      return input.kind === 'group'
        ? (rows as RenderGroupMsg[]).map(groupMsgToWire)
        : (rows as RenderC2cMsg[]).map(c2cMsgToWire);
    }),

  /**
   * List the recalled messages of one conversation (newest-recall-first) — the
   * ones the anti-recall trigger caught and logged. Their original content is
   * intact (the trigger cancelled QQ's recall in place), so they serialize like
   * any other message page, each carrying its `recall` marker (who/when), for
   * the "撤回列表" panel. Empty when anti-recall was never enabled here.
   */
  recalledMessages: procedure
    .input(z.object({ kind: z.enum(['c2c', 'group']), conv: z.string().min(1) }))
    .query(async ({ input }): Promise<ChatMsgWire[]> => {
      const msgs = requireServices().msgs;
      const rows = await msgs.getRecalledMessages(input.kind, input.conv);
      return input.kind === 'group'
        ? (rows as RenderGroupMsg[]).map(groupMsgToWire)
        : (rows as RenderC2cMsg[]).map(c2cMsgToWire);
    }),

  /**
   * 读本机漫游缓存中 [startSeq, endSeq] 的缺失消息（按 seq 升序，不联网）。
   * 前端打开「缺失消息」弹窗前先探一下缓存：有命中就不强制要求 QQ 在线，
   * 弹窗内直接展示已缓存的部分；其余再由 fetchGapMessages 联网补齐并入库。
   */
  cachedGapMessages: procedure
    .input(
      z.object({
        kind: z.enum(['c2c', 'group']),
        conv: z.string().min(1),
        startSeq: z.number().int().min(0),
        endSeq: z.number().int().min(0),
      }),
    )
    .query(async ({ input }) => {
      return requireServices().gapHistory.cached(
        input.kind,
        input.conv,
        input.startSeq,
        input.endSeq,
      );
    }),

  /**
   * 拉取聊天时间线中缺失的远端消息（按 seq 窗口，含端点）。分页契约：
   * 首次传整个缺口起始（占位条上一条消息的 seq + 1），之后把返回的
   * nextStartSeq 原样作为下一次的 startSeq，每页向更新方向推 30 个 seq，
   * 直到 nextStartSeq 为 null。依赖在线 QQ 发包，离线 / 完全离线模式由服务层
   * 判定并返回 { ok: false, reason: 'offline' }；空窗不停止（QQ 漫游覆盖从
   * 最新向前连续，缺口最旧端可能未覆盖），由调用方决定首屏空窗如何提示。
   * 已拉到的消息会全部写入本机漫游缓存（按账号一个库），下次命中缓存直接返回。
   */
  fetchGapMessages: procedure
    .input(
      z.object({
        kind: z.enum(['c2c', 'group']),
        conv: z.string().min(1),
        startSeq: z.number().int().min(0),
        endSeq: z.number().int().min(0),
      }),
    )
    .query(async ({ input }) => {
      return requireServices().gapHistory.fetch(
        input.kind,
        input.conv,
        input.startSeq,
        input.endSeq,
      );
    }),

  /**
   * Field descriptors for the compose form — required/optional/type per
   * authorable element kind, derived from the codec Zod schemas.
   */
  composeElementSpecs: procedure.query(() => requireServices().msgs.getComposeSpecs()),

  /**
   * Insert a brand-new message into a conversation (c2c peer uid or group code).
   * `elements` is the authored array in editable wire form (bytes as
   * `{ type:'Buffer', data }`); it is byte-decoded here and validated in the
   * service. Returns the new `{ msgId, msgSeq }` as strings, or null if the
   * conversation had no message to clone as a template.
   */
  insertMessage: procedure
    .input(
      z.object({
        kind: z.enum(['c2c', 'group']),
        conv: z.string().min(1),
        senderUid: z.string().min(1),
        senderUin: z.string().min(1),
        elements: z.array(z.any()).min(1),
        sendTime: z.number().int().positive().optional(),
      }),
    )
    .mutation(async ({ input }) => {
      const elements = elementsFromEditable(input.elements);
      const svc = requireServices().msgs;
      const payload = {
        senderUid: input.senderUid,
        senderUin: input.senderUin,
        elements,
        sendTime: input.sendTime,
      };
      const res =
        input.kind === 'group'
          ? await svc.insertGroupMessage(input.conv, payload)
          : await svc.insertC2cMessage(input.conv, payload);
      if (!res) return null;
      return { msgId: res.msgId.toString(), msgSeq: res.msgSeq.toString() };
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
    return getHost().pickDirectory({ title: '选择解密保存文件夹' });
  }),

  /** Bulk decrypt selected databases into the chosen folder. */
  decryptDatabases: procedure.input(decryptDbInput).mutation(async ({ input }) => {
    return requireServices().dbDecrypt.decryptDatabases(input);
  }),

  // ---- 外部站点跳转（QQ 空间 / QQ 频道，网页版用） ----

  /**
   * A one-shot ptlogin2 jump URL that lands on QQ 空间 / QQ 频道 already logged in.
   *
   * 桌面版用 `<webview>` + 手工种 cookie；浏览器里两条路都走不通（对方站点禁 iframe，
   * 且我们无法跨站写 cookie）。所以改把跳转 URL 交给浏览器开新标签：302 链在浏览器
   * 里跑完，cookie 落进浏览器自己的 jar，等价于用户手动登录了一次。
   *
   * URL 里带着 clientKey，属于一次性凭据 —— 只在点击时现取，不缓存不落库。
   */
  getExternalSiteUrl: procedure
    .input(z.object({ site: z.enum(['qzone', 'channel']) }))
    .mutation(async ({ input }) => {
      const ctx = getAppContext();
      const services = requireServices();
      const uin = ctx.account?.context.uin;
      const nt = ctx.platform?.native.ntHelper;
      const record = services.accountConfig.getRecord();
      const landing =
        input.site === 'qzone'
          ? `https://user.qzone.qq.com/${uin}/infocenter?loginfrom=31`
          : 'https://pd.qq.com/';

      // 没有在线 QQ（或处于完全离线模式）就没有 clientKey 可换 —— 退回裸地址，
      // 用户自己在浏览器里登录。
      const offlineMode = ctx.bootstrap?.userConfig.getSettings().autoInjectQq === false;
      if (!uin || !nt || !record?.qqOnline || !record.qqPid || offlineMode) {
        return { url: landing, autoLogin: false };
      }
      try {
        const ck = parseClientKeyJson(await nt.fetchClientKey(record.qqPid));
        if (!ck) return { url: landing, autoLogin: false };
        return { url: buildPtlogin2JumpUrl(ck, String(uin), landing), autoLogin: true };
      } catch {
        return { url: landing, autoLogin: false };
      }
    }),

  // ---- QQ 闪传分享链接 ----

  /**
   * 用闪传卡片的 filesetId 换一次分享链接（OIDB 0x93d3_1，需在线 QQ 发包）。
   * 失败不 throw —— 返回结构化结果，让前端区分「QQ 未在线」/「换取失败」。
   */
  getFlashShareLink: procedure
    .input(z.object({ fileSetId: z.string().min(1) }))
    .mutation(
      async ({
        input,
      }): Promise<
        | { ok: true; shareUrl: string }
        | { ok: false; reason: 'offline' | 'error'; message?: string }
      > => {
        const ctx = getAppContext();
        const services = requireServices();
        const uin = ctx.account?.context.uin;
        const nt = ctx.platform?.native.ntHelper;
        const record = services.accountConfig.getRecord();
        const offlineMode = ctx.bootstrap?.userConfig.getSettings().autoInjectQq === false;
        if (!uin || !nt || !record?.qqOnline || !record.qqPid || offlineMode) {
          if (offlineMode) {
            return {
              ok: false,
              reason: 'offline',
              message: '已开启完全离线模式（自动注入 QQ 已关闭），闪传分享需要在线 QQ。',
            };
          }
          return { ok: false, reason: 'offline' };
        }
        try {
          await ctx.bootstrap?.injectHook.ensure(record.qqPid, uin);
          const shareUrl = await services.flashTransfer.getShareLink(input.fileSetId);
          if (!shareUrl) {
            return { ok: false, reason: 'error', message: '没有拿到分享链接（文件可能已过期）' };
          }
          return { ok: true, shareUrl };
        } catch (error) {
          return {
            ok: false,
            reason: 'error',
            message: error instanceof Error ? error.message : String(error),
          };
        }
      },
    ),
  // ---- 闪传文件浏览 / 下载（匿名 HTTP2RPC，不需 QQ 在线）----

  /** 拉一个闪传目录（普通 / 压缩包内部）的完整文件列表。 */
  flashListFiles: procedure.input(flashListFilesInput).query(async ({ input }) => {
    const svc = requireServices().flashTransferFiles;
    return svc.listFiles(input.filesetId, input.parentId, input.zipFileId);
  }),

  /** 把勾选条目解析成下载任务并入队（目录解析在调用内完成，下载后台并发跑）。 */
  flashStartDownloads: procedure
    .input(
      z.object({
        filesetName: z.string().optional().default(''),
        selections: z.array(flashSelectionSchema).min(1),
      }),
    )
    .mutation(async ({ input }) => {
      const svc = requireServices().flashTransferFiles;
      const filesetId = input.selections[0]!.filesetId;
      return svc.downloads.start(input.filesetName, filesetId, input.selections);
    }),

  /** 全部下载任务（含历史，新在前）。 */
  flashListDownloadTasks: procedure.query(() => {
    return requireServices().flashTransferFiles.downloads.list();
  }),

  /** 取消单个下载任务（进行中的会中断下载）。 */
  flashCancelDownloadTask: procedure
    .input(z.object({ taskId: z.string().min(1) }))
    .mutation(async ({ input }) => {
      return requireServices().flashTransferFiles.downloads.cancel(input.taskId);
    }),

  /** 清掉已结束（完成 / 失败 / 取消）的任务，进行中的保留。 */
  flashClearDownloadTasks: procedure.mutation(async () => {
    return requireServices().flashTransferFiles.downloads.clearFinished();
  }),

  /** 在系统文件管理器里打开闪传下载根目录。 */
  flashRevealDownloadDir: procedure.mutation(async () => {
    const dir = requireServices().flashTransferFiles.downloads.rootDir;
    await getHost().revealPath(dir);
    return { ok: true };
  }),

  /** 订阅单个下载任务的状态 / 进度变化。 */
  onFlashDownloadProgress: procedure.subscription(() => {
    return observable<import('@weq/service').FlashDownloadTask>((emit) => {
      const manager = requireServices().flashTransferFiles.downloads;
      const handler = (task: import('@weq/service').FlashDownloadTask) => emit.next(task);
      manager.on('task', handler);
      return () => {
        manager.off('task', handler);
      };
    });
  }),
  // ---- group album ----

  /** List group albums via Qzone web CGI. Requires online QQ (pt_login can mint p_skey). */
  listGroupAlbums: procedure.input(groupAlbumInput).query(async ({ input }) => {
    const services = requireServices();
    // qzone.qq.com 的 p_skey 可由 ptlogin2 本地快速登录兜底，无需注入 / ClientKey。
    requireOnlineQqForWeb(services);
    return services.webQuery.getGroupAlbumList(input.groupCode);
  }),

  /** List all media for one group album. Requires the saved online QQ pid. */
  listGroupAlbumMedia: procedure.input(groupAlbumMediaInput).query(async ({ input }) => {
    const services = requireServices();
    requireQqOnlineForAlbum(services);
    return collectAlbumMedia(services, input.groupCode, input.albumId);
  }),

  /** Folder dialog for group album export output. */
  pickGroupAlbumExportDir: procedure.mutation(async () => {
    return getHost().pickDirectory({ title: '选择群相册保存文件夹' });
  }),

  /** Enumerate selected albums first, then concurrently download all media. */
  exportGroupAlbums: procedure.input(exportGroupAlbumsInput).mutation(async ({ input }) => {
    return exportGroupAlbums(requireServices(), input);
  }),

  // ---- 群文件 ----

  /** 列出群文件某个目录下的文件+子文件夹 (OIDB 0x6D8_1)。需要在线的 QQ 进程。 */
  listGroupFiles: procedure.input(groupFileInput).query(async ({ input }) => {
    const services = requireServices();
    requireQqOnlineForAlbum(services);
    return services.groupFile.list(Number(input.groupCode), input.folderId ?? '/');
  }),

  /** 换取单个群文件的下载直链 (OIDB 0x6D6_2)。链接有时效,点一次取一次。 */
  getGroupFileUrl: procedure.input(groupFileDownloadInput).mutation(async ({ input }) => {
    const services = requireServices();
    requireQqOnlineForAlbum(services);
    return services.mediaUrl.getGroupFileUrl(
      Number(input.groupCode),
      input.fileId,
      input.busId ?? 102,
      input.fileName ?? '',
    );
  }),

  /** Folder dialog for group file export output. */
  pickGroupFileExportDir: procedure.mutation(async () => {
    return getHost().pickDirectory({ title: '选择群文件保存文件夹' });
  }),

  /** 并发下载选中的群文件;不传 files 则递归导出全群并保留目录结构。 */
  exportGroupFiles: procedure.input(exportGroupFilesInput).mutation(async ({ input }) => {
    return exportGroupFiles(requireServices(), input);
  }),

  // ---- 收藏 (QQ favorites / collection.db) ----

  /**
   * One page of collected items, newest-collected first, projected to the
   * IPC wire shape (bigint → string, byte blobs dropped). `hasMore` lets the
   * renderer page through everything.
   *
   * `source` picks the backing path: `db` reads only the local collection.db
   * (instant), `network` only the weiyun collector (fresh but slow, and null
   * when no p_skey), `auto` keeps the original network-first-then-db behaviour.
   * The renderer paints `db` first and swaps in `network` when it arrives.
   */
  listCollections: procedure
    .input(
      z
        .object({
          limit: z.number().int().min(1).max(200).optional(),
          offset: z.number().int().min(0).optional(),
          source: z.enum(['auto', 'db', 'network']).optional(),
        })
        .optional(),
    )
    .query(async ({ input }) => {
      const svc = requireServices().collection;
      const limit = input?.limit ?? 50;
      const offset = input?.offset ?? 0;
      // 完全离线模式（自动注入 QQ 关闭）：网络同步需要 weiyun p_skey（在线实例），
      // 一律回退本地 collection.db，避免白打一次网络 + 凭证换取。
      const offlineMode =
        getAppContext().bootstrap?.userConfig.getSettings().autoInjectQq === false;
      const source = offlineMode ? 'db' : (input?.source ?? 'auto');
      const page =
        source === 'db'
          ? await svc.listCollectionsFromDb(limit, offset)
          : source === 'network'
            ? await svc.listCollectionsFromNetwork(limit, offset)
            : await svc.listCollections(limit, offset);
      if (!page) return null;
      return {
        offset: page.offset,
        limit: page.limit,
        hasMore: page.hasMore,
        source: page.source,
        items: page.items.map(collectionItemToWire),
      };
    }),

  /** Total number of collected items (0 when collection.db was never created). */
  countCollections: procedure.query(async () => {
    return requireServices().collection.countCollections();
  }),

  // ---- export ----

  /** List conversations with message counts (batch query). */
  listConversationsWithCount: procedure.query(async () => {
    const services = requireServices();
    // 空 targetUid 的系统/占位会话既不能当消息分区键，也不是可导出目标 —— 直接剔除。
    const contacts = (await services.recentContacts.getRecentContact(200)).filter(
      (c) => c.targetUid,
    );

    // 分类是收集查询集和计数分流的唯一依据，两处必须共用，否则会出现
    // 「归到 c2c 计数、却没被 countByUids 查过」的会话恒显示 0 条 —— 公众号
    // (KCHATTYPETEMPPUBLICACCOUNT=103) 等枚举名不含 'C2C' 的临时会话就是这样：
    // 消息其实在 c2c_msg_table，只是没进查询集。dataline 走独立表单独计数，
    // 其余一切都按 c2c 归类（能查到就显示真实条数，查不到才是 0）。
    const kindOf = (chatType: string | number): 'group' | 'dataline' | 'c2c' => {
      const t = String(chatType);
      if (t.includes('GROUP')) return 'group';
      if (t.includes('DATALINE')) return 'dataline';
      return 'c2c';
    };

    const groupCodes = contacts
      .filter((c) => kindOf(c.chatType) === 'group')
      .map((c) => c.targetUid);
    const c2cUids = contacts.filter((c) => kindOf(c.chatType) === 'c2c').map((c) => c.targetUid);
    const datalineUids = contacts
      .filter((c) => kindOf(c.chatType) === 'dataline')
      .map((c) => c.targetUid);

    const account = getAppContext().account;
    const [groupCounts, c2cCounts, datalineCounts] = await Promise.all([
      account?.groupMsgs.countByGroups(groupCodes) ?? Promise.resolve({} as Record<string, number>),
      account?.c2cMsgs.countByUids(c2cUids) ?? Promise.resolve({} as Record<string, number>),
      account?.datalineMsgs.countByUids(datalineUids) ??
        Promise.resolve({} as Record<string, number>),
    ]);

    return contacts.map((c) => {
      const kind = kindOf(c.chatType);
      const messageCount =
        kind === 'group'
          ? (groupCounts[c.targetUid] ?? 0)
          : kind === 'dataline'
            ? (datalineCounts[c.targetUid] ?? 0)
            : (c2cCounts[c.targetUid] ?? 0);
      return { ...recentContactToWire(c), messageCount };
    });
  }),

  /** Start an export task. */
  startExport: procedure
    .input(
      z.object({
        kind: z.enum(['group', 'c2c']),
        conv: z.string().min(1),
        name: z.string().min(1),
        format: z.enum(['json', 'jsonl', 'txt', 'csv', 'xlsx', 'html']),
        total: z.number().int().min(0),
        /** Also export every sender's avatar into an avatars/ subfolder. */
        exportAvatar: z.boolean().optional(),
        /** ChatLab interchange format (json/jsonl carry ChatLab structure). */
        chatlab: z.boolean().optional(),
        /** Media export: copy local media into media/ and CDN-complete images. */
        media: z
          .object({
            exportMedia: z.boolean(),
            completeMedia: z.boolean(),
            downloadVideo: z.boolean(),
            downloadFile: z.boolean(),
            transcribeVoice: z.boolean(),
          })
          .optional(),
        /** Inclusive send-time window (unix seconds); null bound = open-ended. */
        range: z.object({ start: z.number().nullable(), end: z.number().nullable() }).optional(),
      }),
    )
    .mutation(async ({ input }) => {
      return requireServices().exportManager.startTask(input);
    }),

  /**
   * Start a friend-QZone (说说) export. Requires an online QQ (the web CGI needs
   * this account's skey/pskey). `conv` carries the friend's uin. Media = 配图.
   */
  startQzoneExport: procedure
    .input(
      z.object({
        targetUin: z.string().min(1),
        name: z.string().min(1),
        format: z.enum(['json', 'txt']),
        downloadMedia: z.boolean(),
        range: z.object({ start: z.number().nullable(), end: z.number().nullable() }).optional(),
      }),
    )
    .mutation(async ({ input }) => {
      const services = requireServices();
      requireQqOnlineForAlbum(services); // 硬性要求：在线 QQ 实例
      return services.exportManager.startTask({
        qzone: true,
        kind: 'c2c',
        conv: input.targetUin,
        name: input.name,
        format: input.format,
        total: 0,
        media: {
          exportMedia: input.downloadMedia,
          completeMedia: false,
          downloadVideo: false,
          downloadFile: false,
          transcribeVoice: false,
        },
        ...(input.range ? { range: input.range } : {}),
      });
    }),

  /**
   * Start a contacts export — 好友列表（scope='friends'，可按分组过滤）或某群的
   * 成员列表（scope='group'，`groupCode` 必填）。走本地资料库，无需在线 QQ。
   * 好友支持 vcard；群成员不支持 vcard。
   */
  startContactsExport: procedure
    .input(
      z.object({
        scope: z.enum(['friends', 'group']),
        groupCode: z.string().optional(),
        name: z.string().min(1),
        format: z.enum(['json', 'csv', 'xlsx', 'txt', 'vcard']),
        exportAvatar: z.boolean().optional(),
        categoryIds: z.array(z.number().int()).optional(),
      }),
    )
    .mutation(async ({ input }) => {
      if (input.scope === 'group' && !input.groupCode) {
        throw new Error('导出群成员需要指定群号。');
      }
      // vcard 仅好友可用；群成员传 vcard 时回退到 csv。
      const format = input.scope === 'group' && input.format === 'vcard' ? 'csv' : input.format;
      return requireServices().exportManager.startTask({
        contacts: {
          scope: input.scope,
          ...(input.categoryIds ? { categoryIds: input.categoryIds } : {}),
        },
        kind: 'c2c',
        conv: input.scope === 'group' ? input.groupCode! : '',
        name: input.name,
        format,
        total: 0,
        exportAvatar: input.exportAvatar ?? false,
      });
    }),

  /**
   * Start a collection (收藏) export — 走本地收藏库，无需在线 QQ。全部或按类型
   * (`kinds`) 过滤，导出为 json/csv/xlsx/txt 表格。
   */
  startCollectionExport: procedure
    .input(
      z.object({
        name: z.string().min(1),
        format: z.enum(['json', 'csv', 'xlsx', 'txt']),
        kinds: z.array(z.string()).optional(),
      }),
    )
    .mutation(async ({ input }) => {
      return requireServices().exportManager.startTask({
        collection: { ...(input.kinds?.length ? { kinds: input.kinds } : {}) },
        kind: 'c2c',
        conv: '',
        name: input.name,
        format: input.format,
        total: 0,
      });
    }),

  /**
   * Force a one-shot rkey harvest from the online QQ for the open account — the
   * explicit "立即重新获取 rkey" before a media-completing export. Returns true
   * when fresh rkeys were stored. 完全离线模式（自动注入 QQ 关闭）下直接返回 false。
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
    return observable<import('@weq/service').TaskProgress>((emit) => {
      const handler = (progress: import('@weq/service').TaskProgress) => emit.next(progress);
      requireServices().exportManager.on('progress', handler);
      return () => {
        requireServices().exportManager.off('progress', handler);
      };
    });
  }),

  // ---- scheduled exports ----
  // All schedule templates are persisted by ExportScheduler in
  // cacheDir/export/<configId>/schedules.json. CRUD below is a thin proxy; the
  // scheduler itself is the source of truth for fire-time / nextRunAt / history.

  listSchedules: procedure.query(() => {
    return requireScheduler().list();
  }),

  createSchedule: procedure
    .input(
      z.object({
        name: z.string().min(1),
        format: z.enum(['json', 'jsonl', 'txt', 'csv', 'xlsx', 'html']),
        conversations: z
          .array(
            z.object({
              id: z.string().min(1),
              name: z.string().min(1),
              kind: z.enum(['group', 'c2c']),
              total: z.number().int().min(0),
            }),
          )
          .min(1),
        chatlab: z.boolean().optional(),
        schedule: z.object({
          mode: z.enum(['daily', 'interval']),
          time: z.string(),
          intervalHours: z.number().int().min(1).max(168),
        }),
        options: z.object({
          range: z.object({
            preset: z.enum(['all', 'today', '7d', '30d', '1y', 'custom']),
            start: z.number().nullable(),
            end: z.number().nullable(),
          }),
          exportMedia: z.boolean(),
          exportAvatar: z.boolean(),
          completeMedia: z.boolean(),
          downloadVideo: z.boolean(),
          downloadFile: z.boolean(),
          transcribeVoice: z.boolean(),
        }),
        enabled: z.boolean().default(true),
      }),
    )
    .mutation(({ input }) => {
      // Map renderer-facing `name` (template label) to the manager's ScheduleInput.
      // (ScheduleInput reuses `name` as the export filename stem; the renderer
      // sends the user-chosen label here too — keeping it as-is means a fresh
      // export per trigger produces `<label>.<fmt>`.)
      return requireScheduler().create({
        name: input.name,
        format: input.format,
        conversations: input.conversations,
        ...(input.chatlab ? { chatlab: true } : {}),
        schedule: input.schedule,
        options: input.options,
        enabled: input.enabled,
      });
    }),

  updateSchedule: procedure
    .input(
      z.object({
        id: z.string().min(1),
        patch: z.object({
          name: z.string().min(1).optional(),
          format: z.enum(['json', 'jsonl', 'txt', 'csv', 'xlsx', 'html']).optional(),
          conversations: z
            .array(
              z.object({
                id: z.string().min(1),
                name: z.string().min(1),
                kind: z.enum(['group', 'c2c']),
                total: z.number().int().min(0),
              }),
            )
            .min(1)
            .optional(),
          chatlab: z.boolean().optional(),
          schedule: z
            .object({
              mode: z.enum(['daily', 'interval']),
              time: z.string(),
              intervalHours: z.number().int().min(1).max(168),
            })
            .optional(),
          options: z
            .object({
              range: z.object({
                preset: z.enum(['all', 'today', '7d', '30d', '1y', 'custom']),
                start: z.number().nullable(),
                end: z.number().nullable(),
              }),
              exportMedia: z.boolean(),
              exportAvatar: z.boolean(),
              completeMedia: z.boolean(),
              downloadVideo: z.boolean(),
              downloadFile: z.boolean(),
              transcribeVoice: z.boolean(),
            })
            .optional(),
          enabled: z.boolean().optional(),
        }),
      }),
    )
    .mutation(({ input }) => {
      return requireScheduler().update(input.id, input.patch);
    }),

  setScheduleEnabled: procedure
    .input(z.object({ id: z.string().min(1), enabled: z.boolean() }))
    .mutation(({ input }) => {
      return requireScheduler().setEnabled(input.id, input.enabled);
    }),

  deleteSchedule: procedure.input(z.object({ id: z.string().min(1) })).mutation(({ input }) => {
    return requireScheduler().delete(input.id);
  }),

  /** Fire a schedule immediately, without disturbing its `nextRunAt`. Returns
   *  the task ids generated so the UI can immediately `refetchTasks()`. */
  runScheduleNow: procedure
    .input(z.object({ id: z.string().min(1) }))
    .mutation(async ({ input }) => {
      return requireScheduler().runNow(input.id);
    }),

  /** Save exported file to user-selected location. */
  saveExportFile: procedure
    .input(
      z.object({
        sourcePath: z.string().min(1),
        defaultName: z.string().min(1),
        format: z.enum(['json', 'jsonl', 'txt', 'csv', 'xlsx', 'html']),
      }),
    )
    .mutation(async ({ input }) => {
      const { copyFileSync, mkdirSync } = await import('node:fs');
      const defaultDir = requireBootstrap().userConfig.getSettings().defaultExportDir;
      if (defaultDir) {
        // 已配置默认保存目录：免弹窗直接拷贝到 <默认目录>/<文件名>。
        const dest = join(defaultDir, sanitizePathSegment(input.defaultName, 'export'));
        mkdirSync(dirname(dest), { recursive: true });
        copyFileSync(input.sourcePath, dest);
        return true;
      }
      const target = await getHost().pickSaveTarget({
        defaultName: input.defaultName,
        extension: input.format,
      });
      if (!target) return false;
      copyFileSync(input.sourcePath, target.path);
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
      const { existsSync, cpSync, mkdirSync } = await import('node:fs');
      if (!existsSync(task.bundleDir)) return false;
      const defaultDir = requireBootstrap().userConfig.getSettings().defaultExportDir;
      if (defaultDir) {
        // 已配置默认保存目录：免弹窗把整个 bundle 拷到 <默认目录>/<任务名>/。
        const dest = join(defaultDir, sanitizePathSegment(task.name, task.id));
        mkdirSync(dirname(dest), { recursive: true });
        cpSync(task.bundleDir, dest, { recursive: true });
        return true;
      }
      const picked = await getHost().pickDirectory({ title: '选择导出保存文件夹' });
      if (!picked) return false;
      const dest = join(picked, sanitizePathSegment(task.name, task.id));
      cpSync(task.bundleDir, dest, { recursive: true });
      return true;
    }),

  /**
   * 打开助手导出工具产出的结果（卡片「打开」）。单文件→系统默认程序；
   * bundle 目录→文件管理器。taskId 即 AssistantArtifact.id。
   */
  openAssistantExport: procedure
    .input(z.object({ taskId: z.string().min(1) }))
    .mutation(async ({ input }) => {
      const task = requireServices().exportManager.getTask(input.taskId);
      const path = task?.bundleDir || task?.filePath;
      if (!path) throw new Error('导出结果不存在（可能已被清理）。');
      await getHost().revealPath(path);
      return true;
    }),

  /**
   * 另存助手导出结果（卡片「另存为」）。bundle 目录→选文件夹整目录拷贝；
   * 单文件→保存对话框复制。镜像 saveExportBundle / saveExportFile。
   */
  saveAssistantExport: procedure
    .input(z.object({ taskId: z.string().min(1) }))
    .mutation(async ({ input }) => {
      const task = requireServices().exportManager.getTask(input.taskId);
      if (!task) throw new Error('导出结果不存在（可能已被清理）。');
      const host = getHost();
      if (task.bundleDir) {
        const { existsSync, cpSync } = await import('node:fs');
        if (!existsSync(task.bundleDir)) return false;
        const picked = await host.pickDirectory({ title: '选择导出保存文件夹' });
        if (!picked) return false;
        const dest = join(picked, sanitizePathSegment(task.name, task.id));
        cpSync(task.bundleDir, dest, { recursive: true });
        return true;
      }
      if (!task.filePath) return false;
      const { copyFileSync } = await import('node:fs');
      const target = await host.pickSaveTarget({
        defaultName: `${task.name}.${task.format}`,
        extension: task.format,
      });
      if (!target) return false;
      copyFileSync(task.filePath, target.path);
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
   *
   * On success the text is written back onto the element's `pttTranscript`
   * (wire tag 45923) when `msgId` is supplied — the same field QQ's own 转文字
   * fills in, so the result survives a reload and QQ itself shows it.
   */
  transcribeVoice: procedure
    .input(
      z.object({
        t: z.number(),
        name: z.string(),
        token: z.string().default(''),
        msgId: z.string().default(''),
      }),
    )
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
      const text = result.text ?? '';
      if (input.msgId) {
        // Best-effort: a failed back-write must not lose the text we just got.
        await services.msgs
          .setPttTranscript(BigInt(input.msgId), input.name, text)
          .catch(() => false);
      }
      return { success: true, text };
    }),

  /** 数据库损坏反馈：打包日志/settings.db/密钥算法配置/检查报告到缓存目录，并打开文件夹 + GitHub/QQ。 */
  collectDbDamageFeedback: procedure
    .input(z.object({ target: z.enum(['github', 'qqgroup']) }))
    .mutation(
      async ({
        input,
      }): Promise<{
        ok: boolean;
        folder?: string;
        files?: string[];
        errors?: string[];
        openError?: string | null;
      }> => {
        const ctx = getAppContext();
        const session = ctx.account;
        const boot = ctx.bootstrap;
        const platform = ctx.platform;
        if (!boot) return { ok: false, errors: ['原生组件未就绪'] };
        if (!session) return { ok: false, errors: ['未打开账号'] };
        if (!platform) return { ok: false, errors: ['原生组件未就绪'] };

        const uin = session.context.uin;
        const dbDir = platform.ntDbDir(uin) ?? dirname(session.msgDbPath);
        // 复用日志目录里最新一份检查报告；没有的话现场重查并生成一份。
        let reportPath = findLatestDbHealthReport();
        if (!reportPath) {
          try {
            const failures = await checkAccountDatabaseHealth(session, platform);
            reportPath = writeDbHealthReport({ failures, uin, dbDir });
          } catch (e) {
            reportPath = writeDbHealthReport({
              failures: [],
              uin,
              dbDir,
              checkError: e instanceof Error ? e.message : String(e),
            });
          }
        }

        const result = collectDbDamageFeedback({
          uin,
          dbKey: session.context.dbKey,
          algos: session.context.algos,
          dbDir,
          cacheDir: boot.userConfig.cacheBaseDir(),
          reportPath,
        });

        // 打开文件夹 + 默认浏览器（GitHub）或 QQ 深链接（交流群）。
        let openError: string | null = null;
        try {
          await getHost().revealPath(result.folder);
        } catch (e) {
          openError = e instanceof Error ? e.message : String(e);
        }
        const openExternal = async (url: string, label: string): Promise<void> => {
          try {
            await getHost().openExternal(url);
          } catch (e) {
            openError =
              (openError ? `${openError}；` : '') +
              `${label}：${e instanceof Error ? e.message : String(e)}`;
          }
        };
        if (input.target === 'github') {
          await openExternal('https://github.com/H3CoF6/WeQ/issues', '打开 GitHub 失败');
        } else {
          await openExternal(
            'tencent://ntqq-open/?subCmd=flashTransfer&action=openTransPage&actionParams={"fileSetId":"","allChecked":"","selectedItems":"","sourceType":"share"}',
            '唤起 QQ 失败',
          );
        }

        return {
          ok: true,
          folder: result.folder,
          files: result.files,
          errors: result.errors,
          openError,
        };
      },
    ),
});
