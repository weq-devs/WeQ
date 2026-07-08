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
import { getAppContext, dbEventBus, type AccountServices } from '../../context/app_context';
import { sampleHitokoto } from '../../hitokoto';
import { resolveResource } from '../../resource';
import { dialog } from 'electron';
import { procedure, router } from '../trpc';
import { assistantBus, type AssistantStreamEvent } from '../../mcp/assistant_bus';
import { groupChatBus, type GroupChatStreamEvent } from '../../mcp/agentlab_group_bus';
import {
  clientKeyExpiryMs,
  toRenderElements,
  PRIVATE_PTT_RKEY_TYPE,
  GROUP_PTT_RKEY_TYPE,
  getVoiceModel,
  buildBotExport,
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
        history: z.array(
          z.object({
            role: z.enum(['user', 'assistant']),
            text: z.string().min(1),
          }),
        ).default([]),
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
      for (const m of [persona.models.chat, persona.models.embedding, persona.models.vision, input.visionModel]) {
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
        ? [cfg.getTtsProvider(persona.voice.providerId)].filter((t): t is NonNullable<typeof t> => t !== null)
        : [];

      // 定位预打包引擎。
      const botMjs = resolveResource('bot-runtime', 'bot.mjs');
      if (!botMjs) throw new Error('找不到 bot 引擎 bot.mjs（开发环境请先运行 pnpm build:bot）');

      // 选输出位置。
      const picked = await dialog.showOpenDialog({
        title: '选择导出位置',
        properties: ['openDirectory', 'createDirectory'],
      });
      if (picked.canceled || !picked.filePaths[0]) return { canceled: true as const };
      const safeName = (persona.name || 'clone').replace(/[^\w一-龥-]+/g, '_').slice(0, 40) || 'clone';
      const outDir = join(picked.filePaths[0], `${safeName}-bot`);

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
        features: { voice: input.voice ?? false, groupChat: input.groupChat ?? false, groupReplyMode: input.groupReplyMode ?? 'llm' },
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
      const { probeBotWebUi, openBotWebUiWindow } = await import('../../bot_webui_window');
      const reachable = await probeBotWebUi(base + '/');
      if (!reachable) return { opened: false as const, needUrl: true as const, defaultUrl: info.url };
      const persona = svc.getPersona(input.personaId);
      await openBotWebUiWindow(base, info.key, persona?.name);
      return { opened: true as const, needUrl: false as const };
    }),

  // ── 克隆体群聊（M2 群骨架）─────────────────────────────────────────────

  createAgentLabGroup: procedure
    .input(z.object({ name: z.string().min(1), personaIds: z.array(z.string().min(1)).min(1) }))
    .mutation(({ input }) => {
      return requireServices().agentLab.createGroup({ name: input.name, personaIds: input.personaIds });
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
          groupChatBus.emit('event', { groupRunId, groupId, kind: 'done' } satisfies GroupChatStreamEvent),
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
      }),
    )
    .mutation(({ input }) => {
      return requireServices().agentLab.updatePersona(input.personaId, {
        name: input.name,
        customPrompt: input.customPrompt,
        voiceCloneEnabled: input.voiceCloneEnabled,
        voice: input.voice,
        willing: input.willing,
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
        mcpServers: z.string().optional(),
      }),
    )
    .mutation(({ input }) => {
      return requireServices().assistant.setConfig({
        model: input.model,
        customPrompt: input.customPrompt,
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
      void assistant
        .chat(input.sessionId, input.text, (step) => assistantBus.emit('step', { runId, step } satisfies AssistantStreamEvent))
        .catch(() => {});
      return { runId };
    }),

  /**
   * 查看助手写的报告文件。HTML → 在隔离窗口里用本地 Tailwind 运行时渲染；
   * markdown / text → 交给系统默认程序打开。id 的路径安全由 service.artifactInfo 校验。
   */
  openAssistantArtifact: procedure
    .input(z.object({ id: z.string().min(1) }))
    .mutation(async ({ input }) => {
      const { path, kind } = requireServices().assistant.artifactInfo(input.id);
      if (kind === 'html') {
        const { openReportWindow } = await import('../../report_window');
        await openReportWindow(path);
      } else {
        const { shell } = await import('electron');
        const err = await shell.openPath(path);
        if (err) throw new Error(err);
      }
      return true;
    }),

  /** 把助手写的报告文件另存到用户选定位置（复用 saveExportFile 范式）。 */
  saveAssistantArtifact: procedure
    .input(z.object({ id: z.string().min(1), name: z.string().min(1) }))
    .mutation(async ({ input }) => {
      const { path } = requireServices().assistant.artifactInfo(input.id);
      const { dialog } = await import('electron');
      const { copyFileSync } = await import('node:fs');
      const ext = extname(input.name).replace(/^\./, '') || 'html';
      const result = await dialog.showSaveDialog({
        defaultPath: input.name,
        filters: [{ name: 'Report', extensions: [ext] }],
      });
      if (result.canceled || !result.filePath) return false;
      copyFileSync(path, result.filePath);
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

  /** Recent conversations (recent_contact_v3_table), newest first. */
  listRecentContacts: procedure.query(async () => {
    const contacts = await requireServices().recentContacts.getRecentContact(200);
    return contacts.map(recentContactToWire);
  }),

  /** 首页门面：随机一言若干（打字机轮播用；已按句长筛过）。 */
  sampleHitokoto: procedure
    .input(z.object({ count: z.number().int().min(1).max(80).default(30) }).optional())
    .query(({ input }) => sampleHitokoto(input?.count ?? 30)),

  /** 首页门面：私聊纯文本短句池（装饰性「虚拟聊天流」用）。 */
  sampleChatLines: procedure
    .input(z.object({ limit: z.number().int().min(1).max(160).default(80) }).optional())
    .query(({ input }) => sampleHomeChatLines(input?.limit ?? 80)),

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
    // 数据线（我的手机/我的电脑）消息在 dataline_msg_table，单独计数。
    const datalineUids = contacts.filter(c => String(c.chatType).includes('DATALINE')).map(c => c.targetUid);

    const account = getAppContext().account;
    const [groupCounts, c2cCounts, datalineCounts] = await Promise.all([
      account?.groupMsgs.countByGroups(groupCodes) ?? Promise.resolve({} as Record<string, number>),
      account?.c2cMsgs.countByUids(c2cUids) ?? Promise.resolve({} as Record<string, number>),
      account?.datalineMsgs.countByUids(datalineUids) ?? Promise.resolve({} as Record<string, number>),
    ]);

    return contacts.map(c => {
      const t = String(c.chatType);
      const messageCount = t.includes('GROUP')
        ? (groupCounts[c.targetUid] ?? 0)
        : t.includes('DATALINE')
          ? (datalineCounts[c.targetUid] ?? 0)
          : (c2cCounts[c.targetUid] ?? 0);
      return { ...recentContactToWire(c), messageCount };
    });
  }),

  /** Start an export task. */
  startExport: procedure
    .input(z.object({
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
    }))
    .mutation(async ({ input }) => {
      return requireServices().exportManager.startTask(input);
    }),

  /**
   * Start a friend-QZone (说说) export. Requires an online QQ (the web CGI needs
   * this account's skey/pskey). `conv` carries the friend's uin. Media = 配图.
   */
  startQzoneExport: procedure
    .input(z.object({
      targetUin: z.string().min(1),
      name: z.string().min(1),
      format: z.enum(['json', 'txt']),
      downloadMedia: z.boolean(),
      range: z.object({ start: z.number().nullable(), end: z.number().nullable() }).optional(),
    }))
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

  // ---- scheduled exports ----
  // All schedule templates are persisted by ExportScheduler in
  // cacheDir/export/<configId>/schedules.json. CRUD below is a thin proxy; the
  // scheduler itself is the source of truth for fire-time / nextRunAt / history.

  listSchedules: procedure.query(() => {
    return requireScheduler().list();
  }),

  createSchedule: procedure
    .input(z.object({
      name: z.string().min(1),
      format: z.enum(['json', 'jsonl', 'txt', 'csv', 'xlsx', 'html']),
      conversations: z.array(z.object({
        id: z.string().min(1),
        name: z.string().min(1),
        kind: z.enum(['group', 'c2c']),
        total: z.number().int().min(0),
      })).min(1),
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
    }))
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
    .input(z.object({
      id: z.string().min(1),
      patch: z.object({
        name: z.string().min(1).optional(),
        format: z.enum(['json', 'jsonl', 'txt', 'csv', 'xlsx', 'html']).optional(),
        conversations: z.array(z.object({
          id: z.string().min(1),
          name: z.string().min(1),
          kind: z.enum(['group', 'c2c']),
          total: z.number().int().min(0),
        })).min(1).optional(),
        chatlab: z.boolean().optional(),
        schedule: z.object({
          mode: z.enum(['daily', 'interval']),
          time: z.string(),
          intervalHours: z.number().int().min(1).max(168),
        }).optional(),
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
        }).optional(),
        enabled: z.boolean().optional(),
      }),
    }))
    .mutation(({ input }) => {
      return requireScheduler().update(input.id, input.patch);
    }),

  setScheduleEnabled: procedure
    .input(z.object({ id: z.string().min(1), enabled: z.boolean() }))
    .mutation(({ input }) => {
      return requireScheduler().setEnabled(input.id, input.enabled);
    }),

  deleteSchedule: procedure
    .input(z.object({ id: z.string().min(1) }))
    .mutation(({ input }) => {
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
    .input(z.object({
      sourcePath: z.string().min(1),
      defaultName: z.string().min(1),
      format: z.enum(['json', 'jsonl', 'txt', 'csv', 'xlsx', 'html']),
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
      const { shell } = await import('electron');
      const err = await shell.openPath(path);
      if (err) throw new Error(err);
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
      const { dialog } = await import('electron');
      if (task.bundleDir) {
        const { existsSync, cpSync } = await import('node:fs');
        if (!existsSync(task.bundleDir)) return false;
        const result = await dialog.showOpenDialog({
          title: '选择导出保存文件夹',
          properties: ['openDirectory', 'createDirectory'],
        });
        if (result.canceled || result.filePaths.length === 0) return false;
        const dest = join(result.filePaths[0]!, sanitizePathSegment(task.name, task.id));
        cpSync(task.bundleDir, dest, { recursive: true });
        return true;
      }
      if (!task.filePath) return false;
      const { copyFileSync } = await import('node:fs');
      const result = await dialog.showSaveDialog({
        defaultPath: `${task.name}.${task.format}`,
        filters: [{ name: 'Export', extensions: [task.format] }],
      });
      if (result.canceled || !result.filePath) return false;
      copyFileSync(task.filePath, result.filePath);
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
