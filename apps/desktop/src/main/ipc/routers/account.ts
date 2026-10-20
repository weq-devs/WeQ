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
import { SEARCH_CATEGORIES, saveExportOutput, exportOutputFileName } from '@weq/service';
import {
  exportDownloadName,
  exportAccountBindingInput,
  exportSavePolicyInput,
  saveCompletedExportTask,
} from './export_save';
import { mergeRoamingTimeline } from '../../../shared/roaming_timeline';
import {
  PROJECT_GROUP_CODE,
  PROJECT_GROUP_NAME,
  PROJECT_GROUP_SHARE_URL,
} from '../../../shared/project_groups';
import { observable } from '@trpc/server/observable';
import { mkdir, stat, lstat, unlink, writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { tmpdir } from 'node:os';
import { basename, dirname, extname, join } from 'node:path';
import {
  getAppContext,
  closeSalvageConnections,
  dbEventBus,
  type AccountServices,
  type RoamingCacheChange,
} from '../../context/app_context';
import { onlineTranscriber } from '../../online_transcribe';
import type { QuarantinedTable } from '@weq/native';
import type { SalvageLedgerEntry } from '@weq/db';
import { classifyChatType, ProtoMsg } from '@weq/codec';
import { WalletFlag48417Wire } from '@weq/codec/proto/msg/element';
import { detectThumbType, type OcrBlock } from '@weq/protocol';

/** 48417 的嵌套块解码器（红包定位：orderId + packetId）。 */
const walletFlag48417Wire = new ProtoMsg(WalletFlag48417Wire);
import { sampleHitokoto } from '../../hitokoto';
import type { TranscribeResult } from '../../transcribe/engine';
import {
  resolveLocalOcrModel,
  resolveLocalOcrFilterModel,
  runLocalOcr,
  type LocalOcrModel,
} from '../../ocr/local';
import { resolveResource } from '../../resource';
import { procedure, router } from '../trpc';
import { createQQWriteRouter } from './qq_write';
import { createQQActionsRouter } from './qq_actions';
import { dbExplorerRouter } from './db_explorer';
import { annualReportRouter } from './annual_report';
import { antiRecallRouter } from './anti_recall';
import { intentSenseRouter } from './intent_sense';
import { avatarResourceRouter } from './avatar_resource';
import { sysEmojiRouter } from './sys_emoji';
import { marketEmojiRouter } from './market_emoji';
import { customEmojiRouter } from './custom_emoji';
import { relatedEmojiRouter } from './related_emoji';
import { emojiPanelRouter } from './emoji_panel';
import { emojiPackRouter } from './emoji_export';
import { fileResourceRouter } from './file_resource';
import { mediaResourceRouter } from './media_resource';
import { resourceCleanupRouter } from './resource_cleanup';
import { dressupRouter } from './dressup';
import { qzoneRouter } from './qzone';
import { mutualMarkRouter } from './mutual_mark';
import {
  assistantBus,
  activeAssistantRuns,
  type AssistantStreamEvent,
} from '../../mcp/assistant_bus';
import { validateMcpConfig } from '../../mcp/external';
import { groupChatBus, type GroupChatStreamEvent } from '../../mcp/agentlab_group_bus';
import {
  clientKeyExpiryMs,
  captureGeneratedContent,
  listGeneratedConversations,
  GENERATED_EXPORT_FORMATS,
  buildGroupWpaDeepLink,
  resolveGroupShareAuthKey,
  toRenderElements,
  PRIVATE_PTT_RKEY_TYPE,
  GROUP_PTT_RKEY_TYPE,
  COMPOSE_IMAGE_EXTENSIONS,
  getHost,
  assertDestinationCapacity,
  getVoiceModel,
  buildBotExport,
  probeBotWebUi,
  downloadUrlToFile,
  checkAccountDatabaseHealth,
  collectDbDamageFeedback,
  findLatestDbHealthReport,
  writeDbHealthReport,
  ocrCacheFor,
  localOcrBlocker,
  type AlbumMedia,
  type AlbumMediaPage,
  type NewMessages,
  type DbChange,
  type OcrResultCache,
  type RenderC2cMsg,
  type RenderGroupMsg,
  type GapFetchedMessage,
} from '@weq/service';
import {
  buddyRequestToWire,
  botProfileToWire,
  buddyToWire,
  categoryToWire,
  c2cMsgToWire,
  collectionDetailToWire,
  collectionItemToWire,
  forwardRecordToWire,
  groupBulletinToWire,
  groupTodoToWire,
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
  guildDirectSessionToWire,
  guildDirectMsgToWire,
  type ChatMsgWire,
} from '../serde';

/**
 * 闪传封面图大小上限（1 MB）。
 *
 * 与前端提示一致；协议侧本身没有硬限制，但缩略图过大会把整条 fileset 的首包拖长
 * （封面是**发送前**同步上传的），所以在这里设一道闸。
 */
const FLASH_COVER_MAX_BYTES = 1024 * 1024;

function requireServices(): AccountServices {
  const ctx = getAppContext();
  if (!ctx.services) {
    throw new Error('No account session open — call bootstrap.openAccount first.');
  }
  return ctx.services;
}

function requireExpectedAccount(expected?: string, expectedConfigId?: string): AccountServices {
  const ctx = getAppContext();
  if (expected && String(ctx.account?.context.uin ?? '') !== expected)
    throw new Error('账号已切换，已停止操作');
  if (expectedConfigId && ctx.services?.accountConfig.getRecord()?.configId !== expectedConfigId)
    throw new Error('账号数据源已切换，已停止操作');
  return requireServices();
}

function requireScheduler(): import('@weq/service').ExportScheduler {
  const ctx = getAppContext();
  if (!ctx.scheduler) {
    throw new Error('No account session open — call bootstrap.openAccount first.');
  }
  return ctx.scheduler;
}

/**
 * 会话类型判定（首页门面用；兼容字符串枚举与数字）。
 *
 * 走 codec 的严格分类而不是 `includes('C2C'/'GROUP')`：临时会话枚举名与群聊
 * 枚举名互相包含（如 KCHATTYPETEMPC2CFROMGROUP 同时含 C2C 与 GROUP），子串
 * 判会按判断顺序出错。这里只认真正落在 c2c_msg_table 的 direct 类（含 1 / 99 /
 * 100 / 101）；dataline / service / official 各有独立数据源，返回 null 排除。
 */
function chatKindOf(chatType: unknown): 'c2c' | 'group' | null {
  const kind = classifyChatType(chatType as string | number);
  if (kind === 'direct') return 'c2c';
  if (kind === 'group') return 'group';
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

/** In-flight collection detail syncs, cancelled by their explicit stop endpoint. */
const activeCollectionDetailSyncs = new Map<string, AbortController>();

/** Wire payload pushed to the renderer when nt_msg.db gains new rows. */
export interface NewMessagesWire {
  messages: ChatMsgWire[];
}

type ChatKind = 'c2c' | 'group';

const exactMessageIdsInput = z
  .array(z.string().regex(/^(?:roaming:(?:(?:native|protocol):)?\d+:)?-?\d+$/))
  .optional();

const generatedTargetInput = z.object({
  kind: z.enum(['persona', 'group', 'assistant']),
  ownerId: z.string().min(1),
  sessionId: z.string().min(1).nullable(),
});
const generatedAccountInput = z.object({
  expectedAccountUin: z.string().min(1),
  expectedAccountConfigId: z.string().min(1),
});

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

const essenceContentInput = z.object({
  groupCode: z.string().min(1),
  pageStart: z.number().int().min(0).optional(),
  pageLimit: z.number().int().min(1).max(100).optional(),
});

function essenceContentToWire(
  groupCode: string,
  msg: Awaited<ReturnType<AccountServices['groupInfo']['getEssenceMessagesWithContent']>>[number],
) {
  return {
    groupCode,
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
    setStatus: 1,
  };
}

const analyticsRangeInput = z
  .object({
    messageIds: z.array(z.string().regex(/^-?\d+$/)).optional(),
    startTime: z.number().int().safe().nonnegative().optional(),
    endTime: z.number().int().safe().nonnegative().optional(),
    expectedAccountUin: z.string().min(1).optional(),
    expectedAccountConfigId: z.string().min(1).optional(),
  })
  .refine(
    (range) =>
      range.startTime === undefined ||
      range.endTime === undefined ||
      range.startTime <= range.endTime,
    { message: '分析开始时间不能晚于结束时间。' },
  );

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
  expectedAccountUin: z.string().min(1).optional(),
});

const groupAlbumInput = z.object({
  groupCode: z.string().min(1),
});

/** 个人空间相册列表入参：hostUin = 该空间的 QQ 号（自己或好友）。 */
const qzoneAlbumListInput = z.object({
  hostUin: z.string().min(1),
});

/** 相册内媒体分页入参：topicId = 相册列表里的 album.id。 */
const qzoneAlbumMediaInput = z.object({
  hostUin: z.string().min(1),
  topicId: z.string().min(1),
  pageStart: z.number().int().min(0).optional().default(0),
  pageNum: z.number().int().min(1).max(100).optional().default(30),
});

/** 相册视频本体入参：picKey = 媒体列表里的 lloc/sloc。 */
const qzoneAlbumVideoUrlInput = z.object({
  hostUin: z.string().min(1),
  topicId: z.string().min(1),
  picKey: z.string().min(1),
});

/** 待导出的相册媒体条目（多选下载用，对齐 QzoneAlbumPhoto wire）。 */
const qzoneAlbumMediaItemInput = z.object({
  id: z.string().min(1),
  name: z.string().optional(),
  url: z.string().min(1),
  isVideo: z.boolean().optional(),
  picKey: z.string().optional(),
});

const exportQzoneAlbumMediaInput = z.object({
  hostUin: z.string().min(1),
  topicId: z.string().min(1),
  outputDir: z.string().min(1),
  items: z.array(qzoneAlbumMediaItemInput).min(1),
  concurrency: z.number().int().min(1).max(8).optional(),
});
/** 导出装扮资源（气泡 / 字体 / 挂件），缺省不导出。 */
const dressInput = z
  .object({
    bubble: z.boolean(),
    font: z.boolean(),
    widget: z.boolean(),
  })
  .optional();

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

/** 加群引导弹窗的推荐动作（见 `getGroupJoinState`）。 */
export type GroupJoinMode = 'inject' | 'deeplink' | 'browser';

/** 加群引导弹窗的全部前置状态（`account.getGroupJoinState` 的返回）。 */
export interface GroupJoinState {
  groupCode: string;
  groupName: string;
  /** 分享短链（二维码内容 / 浏览器兜底打开的地址）。 */
  shareUrl: string;
  /**
   * 本地群列表里是否已有这个群。**为真时渲染层直接不弹** —— 已在群里就没有引导的
   * 余地了，只有不在群里才谈得上选哪种加群方式（所以此时 `mode` 无意义）。
   */
  inGroup: boolean;
  /** 推荐动作，弹窗按钮照着它渲染。 */
  mode: GroupJoinMode;
  qqOnline: boolean;
  attachEnabled: boolean;
  hasA2: boolean;
  hasD2: boolean;
  hasD2Key: boolean;
  hasGuid: boolean;
}

/** `account.joinProjectGroup` 的结果：实际走了哪条路 + 关键物料。 */
export interface GroupJoinResult {
  action: 'inject' | 'deeplink' | 'browser';
  groupCode: string;
  /** deeplink / browser 时实际打开的链接。 */
  link?: string;
}

export interface GroupAlbumAccessState {
  qqOnline: boolean;
  qqPid: number | null;
  /** 「自动读取 QQ 内存（完整功能）」总闸——关闭即完全离线模式，在线功能不可用。 */
  attachEnabled: boolean;
  /**
   * 本地账号配置里的会话物料是否齐全（a2 / d2 / d2key）。发包要拿它做 TEA 加密，
   * 缺任一项都发不出去，所以发送按钮按它前置置灰。
   */
  hasA2: boolean;
  hasD2: boolean;
  hasD2Key: boolean;
  /** 本地是否已解析出设备 guid（服务端认设备的依据，缺了会被拒绝）。 */
  hasGuid: boolean;
  clientKeyValid: boolean;
  clientKeyExpiresAt: number | null;
  clientKeySecondsLeft: number;
  /**
   * 本地 OCR 识别模型的 id —— 已选且已下载时非空。在线那条腿不可用（QQ 离线 /
   * 物料不全）时，灯箱的 OCR 按钮就靠它活着；两条腿都没有才置灰。
   */
  ocrLocalModelId: string | null;
  /**
   * 本地筛图模型（只判断「图里有没有文字」）的 id —— 已选且已下载时非空。
   * 导出面板据此显示「预筛选已就绪 / 去下载」，并决定要不要带 `ocrPrefilter`。
   */
  ocrFilterModelId: string | null;
  /**
   * **本机能不能跑本地识别引擎**：能跑为 null，跑不了是给人看的原因（如 macOS Intel
   * 上游没发 onnxruntime 二进制）。与那两个 id 的区别：这是平台能力，跟模型下没下好无关。
   * 灯箱的置灰提示据此说人话（否则 Intel Mac 上会一直劝用户「去下个本地模型」）。
   */
  ocrLocalBlocker: string | null;
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

export interface QzoneAlbumMediaExportResult {
  outputDir: string;
  total: number;
  ok: number;
  failed: Array<{
    name: string;
    fileName: string;
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

function roamingMsgToWire(row: GapFetchedMessage): ChatMsgWire {
  const { nativeRaw: _nativeRaw, protocolRaw: _protocolRaw, ...wire } = row;
  return { ...wire, source: 'roaming', msgRandom: row.msgRandom ?? '' };
}

/** Merge an offline cache page using the same cursor and ordering as the local page. */
async function withRoamingHistory(
  services: AccountServices,
  kind: ChatKind,
  conv: string,
  rows: ChatMsgWire[],
  limit: number,
  min = 1n,
  max = 0xffffffffn,
  descending = true,
): Promise<ChatMsgWire[]> {
  try {
    const cached = await services.gapHistory.cachedTimeline(
      kind,
      conv,
      Number(min < 1n ? 1n : min),
      Number(max > 0xffffffffn ? 0xffffffffn : max),
      limit,
      descending,
    );
    return mergeRoamingTimeline<ChatMsgWire>(kind, rows, cached.map(roamingMsgToWire), {
      min,
      max,
      limit,
      descending,
    });
  } catch {
    // Cache failure must never prevent reading the original QQ history.
    return rows;
  }
}

async function fetchLatest(kind: ChatKind, conv: string, limit: number): Promise<ChatMsgWire[]> {
  const services = requireServices();
  const msgs = services.msgs;
  const rows =
    kind === 'group'
      ? (await msgs.getGroupLatest(conv, limit)).map(groupMsgToWire)
      : (await msgs.getC2cLatest(conv, limit)).map(c2cMsgToWire);
  return withRoamingHistory(services, kind, conv, rows, limit);
}

async function fetchBefore(
  kind: ChatKind,
  conv: string,
  beforeSeq: bigint,
  limit: number,
): Promise<ChatMsgWire[]> {
  const services = requireServices();
  const msgs = services.msgs;
  const rows =
    kind === 'group'
      ? (await msgs.getGroupBefore(conv, beforeSeq, limit)).map(groupMsgToWire)
      : (await msgs.getC2cBefore(conv, beforeSeq, limit)).map(c2cMsgToWire);
  return withRoamingHistory(services, kind, conv, rows, limit, 1n, beforeSeq - 1n);
}

async function fetchAfter(
  kind: ChatKind,
  conv: string,
  afterSeq: bigint,
  limit: number,
): Promise<ChatMsgWire[]> {
  const services = requireServices();
  const msgs = services.msgs;
  const rows =
    kind === 'group'
      ? (await msgs.getGroupAfter(conv, afterSeq, limit)).map(groupMsgToWire)
      : (await msgs.getC2cAfter(conv, afterSeq, limit)).map(c2cMsgToWire);
  return withRoamingHistory(services, kind, conv, rows, limit, afterSeq + 1n, 0xffffffffn, false);
}

async function fetchFrom(
  kind: ChatKind,
  conv: string,
  sinceSeq: bigint,
  limit: number,
): Promise<ChatMsgWire[]> {
  const services = requireServices();
  const msgs = services.msgs;
  const rows =
    kind === 'group'
      ? (await msgs.getGroupFrom(conv, sinceSeq, limit)).map(groupMsgToWire)
      : (await msgs.getC2cFrom(conv, sinceSeq, limit)).map(c2cMsgToWire);
  return withRoamingHistory(services, kind, conv, rows, limit, sinceSeq);
}

function albumAccessState(services = requireServices()): GroupAlbumAccessState {
  const record = services.accountConfig.getRecord();
  const session = record?.session;
  const expiresAt = record?.clientKey ? clientKeyExpiryMs(record.clientKey) : null;
  const secondsLeft = expiresAt ? Math.max(0, Math.floor((expiresAt - Date.now()) / 1000)) : 0;
  return {
    qqOnline: Boolean(record?.qqOnline && record.qqPid),
    qqPid: record?.qqPid ?? null,
    attachEnabled: getAppContext().bootstrap?.userConfig.getSettings().autoAttachQq ?? true,
    hasA2: Boolean(session?.a2),
    hasD2: Boolean(session?.d2),
    hasD2Key: Boolean(session?.d2Key),
    hasGuid: Boolean(record?.guid),
    clientKeyValid: Boolean(expiresAt && expiresAt > Date.now()),
    clientKeyExpiresAt: expiresAt,
    clientKeySecondsLeft: secondsLeft,
    // 本地 OCR 那条腿的可用性：设置里选了识别模型且文件下好了才有值。渲染层拿它决定
    // OCR 按钮能不能点（在线那条腿不可用时，本地模型就是唯一的出路）。
    ocrLocalModelId: resolveLocalOcrModel()?.modelId ?? null,
    // 筛图模型只看检测网络（1.7 MB 那份），与识别模型是两个独立的设置项。
    ocrFilterModelId: resolveLocalOcrFilterModel()?.modelId ?? null,
    // 平台能力（与模型状态无关）：本机没有可用的推理引擎时两个 id 必然是 null，
    // 渲染层用这句话代替「去下个本地模型」的提示。
    ocrLocalBlocker: localOcrBlocker(),
  };
}

function requireQqOnlineForAlbum(services = requireServices()): void {
  const state = albumAccessState(services);
  if (!state.qqOnline) {
    throw new Error('需要先登录该账号的 QQ 客户端。');
  }
  if (!state.attachEnabled) {
    throw new Error('已开启完全离线模式（自动读取 QQ 内存 已关闭），该功能需要在线 QQ 实例。');
  }
}

/**
 * 聊天图片文字识别的**在线那条腿**（OIDB 0xe07_0）能不能走，口径与渲染层的「发送键」
 * 完全一致：QQ 在线 + 未开完全离线模式 + 发包凭据（a2 / d2 / d2key / guid）齐全 ——
 * 这条链路既要借在线 QQ 的进程发包，又要现签一条媒体下载 rkey，缺任一项都跑不动。
 *
 * 能走返回 null；不能走返回**给人看的原因**（渲染层拿它当置灰提示，router 拿它当报错）。
 */
function ocrOnlineBlocker(services = requireServices()): string | null {
  const state = albumAccessState(services);
  if (!state.qqOnline) return '需要先登录该账号的 QQ 客户端才能识别文字。';
  if (!state.attachEnabled) {
    return '已开启完全离线模式（自动读取 QQ 内存 已关闭），该功能需要在线 QQ 实例。';
  }
  if (!state.hasA2 || !state.hasD2 || !state.hasD2Key || !state.hasGuid) {
    return '本机账号物料不全（a2 / d2 / d2key / guid），暂时发不了包。';
  }
  return null;
}

/** 在线那条腿现在能不能走。 */
function canOcrOnline(services = requireServices()): boolean {
  return ocrOnlineBlocker(services) === null;
}

/**
 * 识别结果缓存：与导出批量识别、MCP 工具共用同一份（内容寻址，`<缓存根>/ocr/`）。
 * 灯箱里识别过的图，导出直接命中；反过来也一样。
 */
function ocrResultCache(): OcrResultCache {
  return ocrCacheFor(getAppContext().bootstrap!.userConfig.cacheDir('ocr'));
}

/**
 * 一次识别结果 → 缓存条目。缓存写失败**绝不能**影响这次调用，所以整条链吞错。
 *
 * `variant` 记的是「我们识别的是哪一份像素」：在线那条腿用的是元素里记的宽高（原图），
 * 本地那条腿读的是媒体协议给的那张（可能是缩略图，尺寸按回包的自报值）。
 */
async function cacheOcrText(
  md5: string | undefined,
  producer: string,
  result: {
    text?: string;
    blocks: OcrBlock[];
    imageWidth: number;
    imageHeight: number;
    elapsedMs?: number;
    modelId?: string;
    lang?: string;
    variant?: 'original' | 'thumb' | 'downloaded' | 'unknown';
  },
): Promise<void> {
  if (!md5) return;
  const cache = ocrResultCache();
  const key = cache.keyFor(md5);
  if (!key) return;
  const text = (result.text ?? result.blocks.map((b) => b.text).join('\n')).trim();
  await cache
    .putText(key, producer, {
      text,
      ...(result.blocks.length > 0 ? { blocks: result.blocks } : {}),
      frame: {
        width: result.imageWidth,
        height: result.imageHeight,
        variant: result.variant ?? 'unknown',
      },
      ...(result.modelId ? { modelId: result.modelId } : {}),
      ...(result.lang ? { lang: result.lang } : {}),
      ...(result.elapsedMs !== undefined ? { elapsedMs: result.elapsedMs } : {}),
      ids: { elementMd5: md5 },
    })
    .catch(() => undefined);
}

/**
 * 灯箱「识别文字」的返回形状（在线 / 本地 / 缓存三条路共用一套字段）。
 *
 * `blocks` 的坐标与 `imageWidth × imageHeight` 同系 —— 那是**被识别那张图**的像素尺寸
 * （本地那条腿可能读到缩略图），渲染层必须按它换算，别用元素里记的宽高。
 */
export interface ChatOcrLightboxResult {
  status: string;
  srcLang: string;
  blocks: OcrBlock[];
  imageWidth: number;
  imageHeight: number;
  sessionId: string;
  source: 'oidb' | 'local';
  /** 本地那条腿用的模型 id。 */
  modelId?: string;
  /** 本地那条腿的推理耗时（缓存命中时是当初那次的时间）。 */
  elapsedMs?: number;
  /** 结果直接来自本机缓存：这次没有重新识别（在线 / 本地都不用跑）。 */
  cached?: boolean;
}

/**
 * 走本地模型识别灯箱里那张图。只解决「像素 → 文字」，取图复用媒体协议那条链
 * （见 `main/ocr/local.ts`）；结果整成与在线版同构的 blocks，前端不用区分来源。
 */
async function recognizeOcrLocally(
  input: { src?: string },
  model: LocalOcrModel,
): Promise<ChatOcrLightboxResult & { source: 'local'; modelId: string }> {
  if (!input.src) throw new Error('本地识别需要图片地址，这张图取不到本体。');
  const result = await runLocalOcr(input.src, model);
  return {
    status: 'succ',
    srcLang: 'local',
    blocks: result.blocks,
    imageWidth: result.imageWidth,
    imageHeight: result.imageHeight,
    sessionId: '',
    source: 'local',
    modelId: result.modelId,
    elapsedMs: result.elapsedMs,
  };
}

function requireFreshClientKeyForAlbum(services = requireServices()): void {
  const state = albumAccessState(services);
  if (!state.qqOnline) {
    throw new Error('需要先登录该账号的 QQ 客户端。');
  }
  if (!state.attachEnabled) {
    throw new Error('已开启完全离线模式（自动读取 QQ 内存 已关闭），群相册等在线功能不可用。');
  }
  if (!state.clientKeyValid) {
    throw new Error(
      'ClientKey 未获取或已过期，请确认 QQ 在线且已开启「自动读取 QQ 内存（完整功能）」。',
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

/** detail / grab 共用的定位入参。 */
const redbagLocateInput = z.object({
  msgId: z.string().min(1).describe('红包消息的 msgId（查 40001 得到）'),
  kind: z.enum(['c2c', 'group']).describe('会话类型'),
  conv: z.string().min(1).describe('私聊为对方 uid，群聊为群号'),
});

/**
 * 从一条红包消息本体里凑出定位参数 —— detail / grab 共用。
 *
 * 字段全在消息里，不依赖数据库外的任何缓存：
 *   - 48417 = `{2: packetId, 3: orderId}`（嵌套块，按 BYTES 收，这里自己解）；
 *   - 48418 = 领取 token（grab 才用得到）；
 *   - 私聊的 peerUin 要拿 conv（对方 uid）查 uid→uin 映射，群聊直接用群号。
 */
async function resolveRedBagTarget(
  services: ReturnType<typeof requireServices>,
  input: { msgId: string; kind: 'c2c' | 'group'; conv: string },
): Promise<{ orderId: string; packetId: string; token: string; peerUin: string }> {
  const id = /^\d+$/.test(input.msgId) ? BigInt(input.msgId) : null;
  if (id === null) throw new Error(`msgId 无效：${input.msgId}`);

  const raw = await services.msgs.getRawElements(id);
  if (!raw) throw new Error('找不到这条消息（可能已被清理）。');
  const wallet = raw.elements.find((el) => el.kind === 'wallet') as
    | { walletFlag48417?: Uint8Array; walletFlag48418?: string }
    | undefined;
  if (!wallet?.walletFlag48417) throw new Error('这条消息不是红包（缺少 48417）。');

  let orderId = '';
  let packetId = '';
  try {
    const decoded = walletFlag48417Wire.decode(wallet.walletFlag48417);
    orderId = decoded.orderId ?? '';
    packetId = decoded.packetId ? Buffer.from(decoded.packetId).toString('hex') : '';
  } catch {
    throw new Error('这个红包的 48417 结构无法解析。');
  }
  if (!orderId || !packetId) throw new Error('这个红包缺少订单号或 packetId。');

  // peerUin = 这个红包的**领取方**（recvUin）：群红包是群号；私聊红包是「谁被发了
  // 这个红包」—— 自己收到的 = 自己 uin，自己发出去的 = 对方 uin。
  //
  // ⚠️ 私聊不能直接传会话对端：服务端会把它当成另一个红包定位参数，回
  // `109020052 红包已失效`（真机复现过）。方向由该消息的发送者判断。
  let peerUin: string;
  if (input.kind === 'group') {
    peerUin = input.conv;
  } else {
    const peerUinFromConv = String(getAppContext().account?.uidMap.uinByUid(input.conv) ?? '');
    const selfUin = String((await services.profile.getSelfProfile())?.uin ?? '');
    const msg = await services.msgs.getC2cMessageById(input.conv, id);
    const sentBySelf = selfUin !== '' && msg !== null && String(msg.senderUin) === selfUin;
    peerUin = sentBySelf ? peerUinFromConv : selfUin || peerUinFromConv;
  }
  if (!peerUin) throw new Error('解析不出红包的领取方 QQ 号。');

  return { orderId, packetId, token: wallet.walletFlag48418 ?? '', peerUin };
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
  signal?: AbortSignal,
): Promise<AlbumMediaWire[]> {
  const out: AlbumMediaWire[] = [];
  const seenKeys = new Set<string>();
  const seenAttachInfo = new Set<string>();
  let attachInfo = '';
  for (let guard = 0; guard < 100; guard += 1) {
    signal?.throwIfAborted();
    const page = await services.groupAlbumMedia.getMediaList(groupCode, albumId, attachInfo);
    signal?.throwIfAborted();
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

async function downloadAlbumUrl(
  url: string,
  targetPath: string,
  signal?: AbortSignal,
): Promise<void> {
  const outcome = await downloadUrlToFile(url, targetPath, { signal });
  if (!outcome.ok) throw new Error(outcome.reason);
}

async function runWithConcurrency<T>(
  items: T[],
  concurrency: number,
  worker: (item: T) => Promise<void>,
  signal?: AbortSignal,
): Promise<void> {
  let next = 0;
  async function run(): Promise<void> {
    for (;;) {
      signal?.throwIfAborted();
      const index = next;
      next += 1;
      if (index >= items.length) return;
      await worker(items[index]!);
    }
  }
  const results = await Promise.allSettled(
    Array.from({ length: Math.min(concurrency, items.length) }, run),
  );
  const failure = results.find((result) => result.status === 'rejected');
  if (failure?.status === 'rejected') throw failure.reason;
}

async function exportGroupAlbums(
  services: AccountServices,
  input: z.infer<typeof exportGroupAlbumsInput>,
  context?: { signal: AbortSignal; progress(current: number, total: number): void },
): Promise<AlbumExportResult> {
  requireFreshClientKeyForAlbum(services);
  const work: AlbumDownloadWork[] = [];
  const albumNames = new Set<string>();
  for (const album of input.albums) {
    context?.signal.throwIfAborted();
    const albumTitle = uniqueFilename(sanitizePathSegment(album.title, album.id), albumNames);
    const albumDir = join(input.outputDir, albumTitle);
    const used = new Set<string>();
    const media = await collectAlbumMedia(services, input.groupCode, album.id, context?.signal);
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
  await runWithConcurrency(
    work,
    input.concurrency ?? 4,
    async (item) => {
      try {
        await mkdir(dirname(item.targetPath), { recursive: true });
        await downloadAlbumUrl(item.url, item.targetPath, context?.signal);
        ok += 1;
      } catch (e) {
        context?.signal.throwIfAborted();
        failed.push({
          albumId: item.albumId,
          albumTitle: item.albumTitle,
          fileName: item.fileName,
          url: item.url,
          error: e instanceof Error ? e.message : String(e),
        });
      }
      context?.progress(ok, work.length);
    },
    context?.signal,
  );

  return { outputDir: input.outputDir, total: work.length, ok, failed };
}

/**
 * 并发下载选中的个人空间相册媒体到 `outputDir`。与 {@link exportGroupAlbums}
 * 共用同一套下载工具函数；区别是个人相册列表只给视频封面，下载视频前按
 * picKey 现取 mp4 本体（签名会过期），取不到则回退封面图。
 */
async function exportQzoneAlbumMedia(
  services: AccountServices,
  input: z.infer<typeof exportQzoneAlbumMediaInput>,
): Promise<QzoneAlbumMediaExportResult> {
  requireOnlineQqForWeb(services);

  const work: Array<{
    isVideo: boolean;
    url: string;
    picKey: string;
    targetPath: string;
  }> = [];
  const used = new Set<string>();
  input.items.forEach((item, index) => {
    const fileName = uniqueFilename(
      filenameFromUrl(item.url, item.name ?? '', index, item.isVideo ? '.mp4' : '.jpg'),
      used,
    );
    work.push({
      isVideo: Boolean(item.isVideo),
      url: item.url,
      picKey: item.picKey ?? '',
      targetPath: join(input.outputDir, fileName),
    });
  });

  const failed: QzoneAlbumMediaExportResult['failed'] = [];
  let ok = 0;
  await mkdir(input.outputDir, { recursive: true });
  await runWithConcurrency(work, input.concurrency ?? 4, async (item) => {
    try {
      let url = item.url;
      if (item.isVideo && item.picKey) {
        try {
          const mp4 = await services.webQuery.getQzoneAlbumVideoUrl(
            input.hostUin,
            input.topicId,
            item.picKey,
          );
          if (mp4) url = mp4;
        } catch {
          // 本体取不到就下封面图，不中断整个任务。
        }
      }
      await mkdir(dirname(item.targetPath), { recursive: true });
      await downloadAlbumUrl(url, item.targetPath);
      ok += 1;
    } catch (e) {
      failed.push({
        name: item.url,
        fileName: basename(item.targetPath),
        error: e instanceof Error ? e.message : String(e),
      });
    }
  });

  return { outputDir: input.outputDir, total: work.length, ok, failed };
}

async function exportGroupFiles(
  services: AccountServices,
  input: z.infer<typeof exportGroupFilesInput>,
  context?: { signal: AbortSignal; progress(current: number, total: number): void },
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
  await runWithConcurrency(
    work,
    input.concurrency ?? 4,
    async (item) => {
      try {
        // 直链有时效,逐个文件在下载前才换取。
        const url = await services.mediaUrl.getGroupFileUrl(
          Number(input.groupCode),
          item.fileId,
          item.busId,
          item.fileName,
        );
        context?.signal.throwIfAborted();
        const outcome = await downloadUrlToFile(url, item.targetPath, { signal: context?.signal });
        if (!outcome.ok) throw new Error(outcome.reason);
        ok += 1;
      } catch (e) {
        context?.signal.throwIfAborted();
        failed.push({
          fileId: item.fileId,
          fileName: item.fileName,
          error: e instanceof Error ? e.message : String(e),
        });
      }
      context?.progress(ok, work.length);
    },
    context?.signal,
  );

  return { outputDir: input.outputDir, total: work.length, ok, failed };
}

/**
 * 合并转发媒体段选本机文件时的文件框配置。
 *
 * 只做「选择」：媒体在发送时真实上传（NTV2 / 文件管线），所以这里列扩展名是为了
 * 让用户少挑错文件，不参与任何落盘 / 转码。`file` 不限扩展名。
 */
const PICK_SEND_FILE_SPEC: Record<
  'image' | 'record' | 'video' | 'file',
  { title: string; extensions: string[] }
> = {
  image: { title: '选择一张图片', extensions: [...COMPOSE_IMAGE_EXTENSIONS] },
  record: {
    title: '选择语音文件',
    extensions: ['silk', 'slk', 'amr', 'wav', 'mp3', 'm4a', 'ogg', 'aac'],
  },
  video: { title: '选择视频文件', extensions: ['mp4', 'mov', 'm4v', 'mkv', 'webm', 'avi'] },
  file: { title: '选择文件', extensions: [] },
};

function unreadInfoToWire(
  row: Awaited<ReturnType<AccountServices['unreadInfo']['getUnreadInfos']>>[number],
) {
  return {
    uid: row.uid,
    chatType: row.chatType,
    latestSeq: row.latestSeq,
    unreadCount: row.unreadCount,
    readSeq: row.readSeq,
    readError: row.readError ?? false,
    msgSeq: row.msgSeq?.toString(),
    highlights: row.highlights?.map((h) => ({
      kind: h.kind,
      rawKind: h.rawKind,
      msgSeq: h.msgSeq.toString(),
      senderUid: h.senderUid,
      sendTime: h.sendTime.toString(),
      text: h.text,
    })),
  };
}

export const accountRouter = router({
  qqActions: createQQActionsRouter((input) => {
    const services = requireExpectedAccount(
      input.expectedAccountUin,
      input.expectedAccountConfigId,
    );
    requireQqOnlineForAlbum(services);
    return services;
  }),
  qqWrite: createQQWriteRouter(
    (input) => {
      const services = requireExpectedAccount(
        input.expectedAccountUin,
        input.expectedAccountConfigId,
      );
      requireQqOnlineForAlbum(services);
      return services;
    },
    (input) => requireExpectedAccount(input.expectedAccountUin, input.expectedAccountConfigId),
  ),
  // ---- database explorer (SQLiteStudio-style browse / query / edit) ----
  dbExplorer: dbExplorerRouter,
  // ---- 年度报告（manifest-first, account-scoped）----
  annualReport: annualReportRouter,
  // ---- 防撤回（拦截 QQ 撤回的 SQL 触发器 + 按会话选择）----
  antiRecall: antiRecallRouter,
  // ---- 意图感知（消息意图/情绪分析 + 对方画像 + 回复建议）----
  intentSense: intentSenseRouter,
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
  // ---- 消息输入框表情面板（系统/字符/最近/收藏/商城/GIF）----
  emojiPanel: emojiPanelRouter,
  // ---- 导出中心 · 导出表情包（自己的 / 收到的）----
  emojiPack: emojiPackRouter,
  // ---- File 目录 (nt_data/File/Ori) + 下载文件 (file_assistant.db) browser ----
  fileResource: fileResourceRouter,
  // ---- 图片墙 / QQ空间 / 图片 / 视频 local media cache browser ----
  mediaResource: mediaResourceRouter,
  // ---- nt_data 资源清理释放 (本地资源整理 → 清理释放) ----
  resourceCleanup: resourceCleanupRouter,
  // ---- 个性装扮（气泡九宫格 / 聊天字体）----
  dressup: dressupRouter,
  qzone: qzoneRouter,
  // ---- 好友/群友互动标识（任务 / 惊喜 / 限定 / 幸运字符）----
  mutualMark: mutualMarkRouter,

  // ---- agent lab ----

  /**
   * 克隆体列表。顺带把 c2c 克隆体的 sourceId(uid) 解析成 sourceUin 一起下发：
   * 渲染端拿 uin 才能拼头像 URL，而「uid → uin」此前只能靠好友资料的批量查询，
   * 那条链路一旦失败（例如好友数超过单次 IPC 上限），所有克隆体头像都会回落成
   * 默认灰头像。这里补一个不依赖好友表的兜底来源。
   */
  listAgentLabPersonas: procedure.query(async () => {
    const services = requireServices();
    const personas = services.agentLab.listPersonas();
    const uids = [
      ...new Set(
        personas.filter((p) => p.sourceKind === 'c2c' && p.sourceId).map((p) => p.sourceId),
      ),
    ];
    const uinByUid = new Map<string, string>();
    if (uids.length > 0) {
      try {
        for (const profile of await services.profile.profilesByUids(uids)) {
          if (profile.uin > 0n) uinByUid.set(profile.uid, profile.uin.toString());
        }
      } catch (error) {
        console.error('[agentlab] resolve sourceUin failed', error);
      }
    }
    return personas.map((persona) => ({
      ...persona,
      sourceUin: uinByUid.get(persona.sourceId) ?? '',
    }));
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
        // 让克隆体自己起名（仅训练使用，不改前端展示名）。默认关闭。
        autoName: z.boolean().optional(),
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
        autoName: input.autoName,
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
        sessionId: z.string().optional(),
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
        sessionId: input.sessionId,
      });
    }),

  /** 克隆体会话（好友克隆多会话）列表，最近活跃倒序。 */
  listAgentLabPersonaSessions: procedure
    .input(z.object({ personaId: z.string().min(1) }))
    .query(({ input }) => {
      return requireServices().agentLab.listPersonaSessions(input.personaId);
    }),

  /** 新建一个克隆体会话（空对话，标题待首条消息生成）。 */
  createAgentLabPersonaSession: procedure
    .input(z.object({ personaId: z.string().min(1) }))
    .mutation(({ input }) => {
      return requireServices().agentLab.createPersonaSession(input.personaId);
    }),

  /** 删除克隆体会话（含其对话内容）。 */
  deleteAgentLabPersonaSession: procedure
    .input(z.object({ personaId: z.string().min(1), sessionId: z.string().min(1) }))
    .mutation(({ input }) => {
      requireServices().agentLab.deletePersonaSession(input.personaId, input.sessionId);
      return true;
    }),

  /** 某克隆体会话的对话历史。 */
  getAgentLabPersonaSessionConversation: procedure
    .input(z.object({ personaId: z.string().min(1), sessionId: z.string().min(1) }))
    .query(({ input }) => {
      return requireServices().agentLab.getPersonaSessionConversation(
        input.personaId,
        input.sessionId,
      );
    }),

  /** 群聊会话（多会话）列表，最近活跃倒序。 */
  listAgentLabGroupSessions: procedure
    .input(z.object({ groupId: z.string().min(1) }))
    .query(({ input }) => {
      return requireServices().agentLab.listGroupSessions(input.groupId);
    }),

  /** 新建一个群聊会话（空对话，标题待首条消息生成）。 */
  createAgentLabGroupSession: procedure
    .input(z.object({ groupId: z.string().min(1) }))
    .mutation(({ input }) => {
      return requireServices().agentLab.createGroupSession(input.groupId);
    }),

  /** 删除群聊会话（含其消息记录）。 */
  deleteAgentLabGroupSession: procedure
    .input(z.object({ groupId: z.string().min(1), sessionId: z.string().min(1) }))
    .mutation(({ input }) => {
      requireServices().agentLab.deleteGroupSession(input.groupId, input.sessionId);
      return true;
    }),

  /** 某群聊会话的消息记录。 */
  getAgentLabGroupSessionConversation: procedure
    .input(z.object({ groupId: z.string().min(1), sessionId: z.string().min(1) }))
    .query(({ input }) => {
      return requireServices().agentLab.getGroupSessionConversation(input.groupId, input.sessionId);
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
    .input(z.object({ groupId: z.string().min(1), sessionId: z.string().optional() }))
    .query(({ input }) => {
      return requireServices().agentLab.getGroupMessages(input.groupId, undefined, input.sessionId);
    }),

  clearAgentLabGroupConversation: procedure
    .input(z.object({ groupId: z.string().min(1), sessionId: z.string().optional() }))
    .mutation(({ input }) => {
      requireServices().agentLab.clearGroupMessages(input.groupId, input.sessionId);
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
        sessionId: z.string().optional(),
      }),
    )
    .mutation(({ input }) => {
      const svc = requireServices().agentLab;
      const groupRunId = randomUUID();
      const groupId = input.groupId;
      void svc
        .sendGroupMessage(
          { groupId, text: input.text, mentions: input.mentions, sessionId: input.sessionId },
          (message) =>
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
   * 该会话是否有「可继续的任务」（上次中断留下的断点快照）。前端据此显示「继续回答」入口，
   * 也覆盖进程重启后恢复的场景——快照在磁盘上，重启不丢。
   */
  getAssistantResumeState: procedure
    .input(z.object({ sessionId: z.string().min(1) }))
    .query(({ input }) => {
      return requireServices().assistant.getResumeState(input.sessionId);
    }),

  /**
   * 断点续答：从该会话上次中断（停止/异常/进程退出）的位置继续任务，已完成的工具调用
   * 与其结果原样保留，不重查。与 chatWithAssistant 相同的非阻塞 + 事件流范式。
   */
  resumeAssistantRun: procedure
    .input(z.object({ sessionId: z.string().min(1) }))
    .mutation(({ input }) => {
      const assistant = requireServices().assistant;
      const runId = randomUUID();
      const ac = new AbortController();
      activeAssistantRuns.set(runId, ac);
      void assistant
        .resumeAssistantRun(
          input.sessionId,
          (step) => assistantBus.emit('step', { runId, step } satisfies AssistantStreamEvent),
          ac.signal,
        )
        .catch(() => {})
        .finally(() => activeAssistantRuns.delete(runId));
      return { runId };
    }),

  /**
   * 查看助手写的报告文件。HTML → 在隔离窗口里用本地 Tailwind 运行时渲染；
   * markdown / text → 交给系统默认程序打开。id 的路径安全由 service.artifactInfo 校验。
   */
  openAssistantArtifact: procedure
    .input(exportAccountBindingInput.extend({ id: z.string().min(1) }))
    .mutation(async ({ input }) => {
      const { path, kind } = requireExpectedAccount(
        input.expectedAccountUin,
        input.expectedAccountConfigId,
      ).assistant.artifactInfo(input.id);
      const host = getHost();
      const opened = kind === 'html' ? await host.openHtmlReport(path) : null;
      if (kind !== 'html') await host.revealPath(path);
      return { ok: true as const, openUrl: opened?.url ?? null };
    }),

  startAssistantArtifactSave: procedure
    .input(
      generatedAccountInput.extend({
        id: z.string().min(1),
        name: z.string().min(1),
        savePolicy: exportSavePolicyInput.optional(),
      }),
    )
    .mutation(async ({ input }) => {
      const services = requireExpectedAccount(
        input.expectedAccountUin,
        input.expectedAccountConfigId,
      );
      const source = services.assistant.artifactInfo(input.id);
      const extension = extname(source.path).slice(1);
      const name = input.name.replace(/\.[^.]+$/, '') || '助手报告';
      const output = { kind: 'file' as const, name, extension };
      const fileName = exportOutputFileName(output);
      return services.exportManager.startResourceExport({
        kind: 'assistant-artifact',
        name,
        output,
        savePolicy: input.savePolicy,
        run: async (context) => {
          if (
            requireExpectedAccount(input.expectedAccountUin, input.expectedAccountConfigId) !==
            services
          )
            throw new Error('账号或数据源已切换，请重新选择报告。');
          context.signal.throwIfAborted();
          const current = services.assistant.artifactInfo(input.id);
          if (current.path !== source.path) throw new Error('报告来源已改变，请重新选择。');
          await saveExportOutput(
            { name, filePath: source.path },
            { filePath: join(context.directory, fileName) },
            context.signal,
          );
          return { total: 1, ok: 1, failed: [], fileName };
        },
      });
    }),

  assistantArtifactDownload: procedure
    .input(generatedAccountInput.extend({ id: z.string().min(1), name: z.string().min(1) }))
    .mutation(({ input }) => {
      const source = requireExpectedAccount(
        input.expectedAccountUin,
        input.expectedAccountConfigId,
      ).assistant.artifactInfo(input.id);
      const name = exportOutputFileName({
        kind: 'file',
        name: input.name.replace(/\.[^.]+$/, ''),
        extension: extname(source.path).slice(1) || 'html',
      });
      return getHost().registerDownload?.(source.path, name, 'file') ?? null;
    }),

  /** 兼容旧报告卡片的显式另存，验证来源并无覆盖发布。 */
  saveAssistantArtifact: procedure
    .input(exportAccountBindingInput.extend({ id: z.string().min(1), name: z.string().min(1) }))
    .mutation(async ({ input }) => {
      const services = requireExpectedAccount(
        input.expectedAccountUin,
        input.expectedAccountConfigId,
      );
      const { path } = services.assistant.artifactInfo(input.id);
      const ext = extname(path).slice(1) || 'html';
      const target = await getHost().pickSaveTarget({
        defaultName: exportOutputFileName({
          kind: 'file',
          name: input.name.replace(/\.[^.]+$/, ''),
          extension: ext,
        }),
        extension: ext,
      });
      if (!target) return false;
      if (
        requireExpectedAccount(input.expectedAccountUin, input.expectedAccountConfigId) !== services
      )
        throw new Error('账号数据源已切换，已取消保存。');
      await saveExportOutput({ name: input.name, filePath: path }, { filePath: target.path });
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
          limit: z.union([z.literal(-1), z.number().int().min(1).max(500)]).default(200),
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
   * 会话草稿（draft_storage_table_v1）—— 整表读。这张表只有几行，无需分页。
   * `elements` 是按 40800 全量解析的正文（文本 / @ / 表情 / 图片 / 视频 / 文件 /
   * markdown / ark / 引用…… 都在里面），交给前端按模板的 message 结构渲染。
   */
  listDrafts: procedure.query(async () => {
    const drafts = await requireServices().drafts.listDrafts();
    return drafts.map((d) => ({
      storageKey: d.storageKey,
      chatType: d.chatType,
      targetUid: d.targetUid,
      sendTime: d.sendTime.toString(),
      elements: elementsToEditable(d.elements),
    }));
  }),

  /**
   * 有草稿的会话 → 草稿时间（`recent_contact_v3_table."41108"`，unix 秒）。
   *
   * 单独开一个轻量 query，是为了让**会话列表排序**在 `onDbChanged` 时能跟手：
   * 输入框里的草稿正文由 `drafts` state 本地承载、不需要每次重读，但排序要在
   * 每次库变化时都刷新。这里只跑一条几行的 SELECT，不去重读 / 重解整张草稿表
   * （`listDrafts` 会解 `43002` 的 protobuf，代价大得多）。
   */
  listConversationDraftTimes: procedure.query(async () => {
    const map = await requireServices().recentContacts.listDraftTimes();
    return [...map].map(([targetUid, draftTime]) => ({
      targetUid,
      draftTime: draftTime.toString(),
    }));
  }),

  /**
   * 写/清一份草稿。**只在离开会话、离开消息页、应用退出这类时刻调用** ——
   * 产品决定不做逐字写、也不做本地兜底：写不进 QQ 库就按没草稿处理。
   *
   * `elements` 为空 = 清掉该会话的草稿（QQ 清空输入框后也是这么做的）。
   */
  saveDraft: procedure
    .input(
      z.object({
        kind: z.enum(['c2c', 'group']),
        targetUid: z.string().min(1),
        elements: z.array(z.any()),
      }),
    )
    .mutation(async ({ input }) => {
      await requireServices().drafts.saveDraft({
        kind: input.kind,
        targetUid: input.targetUid,
        elements: elementsFromEditable(input.elements),
      });
      return true;
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

  getUnreadInfos: procedure
    .input(
      z.object({
        expectedAccountUin: z.string().min(1),
        targets: z
          .array(
            z.object({ chatType: z.union([z.literal(1), z.literal(2)]), uid: z.string().min(1) }),
          )
          .max(256),
      }),
    )
    .query(async ({ input }) => {
      const rows = await requireExpectedAccount(input.expectedAccountUin).unreadInfo.getUnreadInfos(
        input.targets,
      );
      return rows.map(unreadInfoToWire);
    }),

  setConversationReadState: procedure
    .input(
      z.object({
        expectedAccountUin: z.string().min(1),
        targets: z
          .array(
            z.object({
              chatType: z.union([z.literal(1), z.literal(2)]),
              uid: z.string().min(1),
            }),
          )
          .min(1)
          .max(4096),
        unread: z.boolean(),
      }),
    )
    .mutation(async ({ input }) => {
      const result = await requireExpectedAccount(input.expectedAccountUin).unreadInfo.setReadState(
        input.targets,
        input.unread,
      );
      return { undoToken: result.undoToken, rows: result.rows.map(unreadInfoToWire) };
    }),

  undoConversationReadState: procedure
    .input(z.object({ expectedAccountUin: z.string().min(1), undoToken: z.string().uuid() }))
    .mutation(async ({ input }) => {
      const result = await requireExpectedAccount(
        input.expectedAccountUin,
      ).unreadInfo.undoReadState(input.undoToken);
      return { restored: result.restored, rows: result.rows.map(unreadInfoToWire) };
    }),

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
          // 群提醒词时是命中的关键词；其它类别为 QQ 存的预览文本（常为空）。
          text: h.text,
        })),
      };
    }),

  /**
   * 把一个会话标记为已读（抬高 msg_unread_info_table 的已读 seq，并清掉
   * 提醒高亮组）。会话打开时调用，让红点消失、也避免下次进入重复弹跳转。
   * 同时持久化 WeQ 本地阅读位置；离线目录只更新本地位置。
   */
  markConversationRead: procedure
    .input(
      z.object({
        chatType: z.number().int(),
        uid: z.string().min(1),
        latestSeq: z.string().optional(),
        expectedAccountUin: z.string().min(1).optional(),
      }),
    )
    .mutation(async ({ input }) => {
      // 静态账号（离线快照）的库是死的，QQ 不会读 —— 写进去只是自欺欺人。
      // Android 备份是可写快照，照常放行（与防撤回同一套判定）。
      const ctx = getAppContext();
      if (ctx.accountIsStatic && !ctx.accountIsAndroidBackup) {
        const changed = await requireExpectedAccount(
          input.expectedAccountUin,
        ).unreadInfo.markLocalRead(input.chatType, input.uid, input.latestSeq);
        return { changed, report: { state: 'unavailable' as const } };
      }
      return requireExpectedAccount(input.expectedAccountUin).unreadInfo.markReadAndReport(
        input.chatType,
        input.uid,
        input.latestSeq,
      );
    }),

  getReadReportStatus: procedure.query(() => requireServices().unreadInfo.getReadReportStatus()),

  /** Newest page of a conversation (open / switch-into), newest-first. */
  conversationCalendar: procedure
    .input(convInput)
    .query(({ input }) => requireServices().msgs.calendar(input.kind, input.conv)),

  exportCalendar: procedure
    .input(z.object({ targets: z.array(convInput) }))
    .query(async ({ input }) => {
      const days = new Map<string, number>();
      const seen = new Set<string>();
      const msgs = requireServices().msgs;
      for (const target of input.targets) {
        const key = `${target.kind}:${target.conv}`;
        if (seen.has(key)) continue;
        seen.add(key);
        for (const row of await msgs.calendar(target.kind, target.conv))
          days.set(row.day, (days.get(row.day) ?? 0) + row.count);
      }
      return [...days]
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([day, count]) => ({ day, count }));
    }),

  conversationBoundary: procedure
    .input(
      convInput.extend({
        newest: z.boolean().default(false),
        start: z.number().int().nonnegative().optional(),
        end: z.number().int().nonnegative().optional(),
      }),
    )
    .query(({ input }) =>
      requireServices().msgs.boundary(input.kind, input.conv, input.newest, {
        start: input.start,
        end: input.end,
      }),
    ),

  browseConversation: procedure
    .input(
      convInput.extend({
        filter: z.object({
          start: z.number().int().nonnegative().optional(),
          end: z.number().int().nonnegative().optional(),
          sender: z.string().max(128).optional(),
          keyword: z.string().max(512).optional(),
          category: z
            .enum(['text', 'image', 'video', 'voice', 'file', 'emoji', 'system', 'other'])
            .optional(),
        }),
        cursor: z.object({ time: z.number().int(), rowId: z.string().regex(/^-?\d+$/) }).optional(),
        limit: z.number().int().min(1).max(100).default(30),
      }),
    )
    .query(async ({ input }) => {
      if (
        input.filter.start !== undefined &&
        input.filter.end !== undefined &&
        input.filter.start > input.filter.end
      )
        throw new Error('开始日期不能晚于结束日期。');
      const result = await requireServices().msgs.browse(
        input.kind,
        input.conv,
        input.filter,
        input.cursor,
        input.limit,
      );
      return {
        ...result,
        items: result.items.map((m) => ({
          ...(input.kind === 'group'
            ? groupMsgToWire(m as RenderGroupMsg)
            : c2cMsgToWire(m as RenderC2cMsg)),
          senderName: m.senderName,
          content: m.content,
        })),
      };
    }),

  listLatest: procedure
    .input(convInput.extend({ limit: z.number().int().min(1).max(200).default(50) }))
    .query(({ input }) => fetchLatest(input.kind, input.conv, input.limit)),

  resolveReplySeq: procedure
    .input(
      z.object({
        conv: z.string().min(1),
        clientSeq: z.string().regex(/^[1-9]\d*$/),
        senderUin: z
          .string()
          .regex(/^[1-9]\d*$/)
          .optional(),
        sendTime: z
          .string()
          .regex(/^[1-9]\d*$/)
          .optional(),
      }),
    )
    .query(async ({ input }) => {
      const services = requireServices();
      const seq = await services.msgs.resolveC2cReplySeq(
        input.conv,
        BigInt(input.clientSeq),
        input.senderUin ? BigInt(input.senderUin) : undefined,
        input.sendTime ? BigInt(input.sendTime) : undefined,
      );
      return (
        seq?.toString() ??
        services.gapHistory.resolveReplySeq(
          input.conv,
          input.clientSeq,
          input.senderUin,
          input.sendTime,
        )
      );
    }),

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

  /**
   * QQ 频道私聊会话列表（direct_node_list_table）。只读会话表，绝不回扫
   * guild_msg_table 补全；40051 最新消息预览一并返回。
   */
  guildDirectListSessions: procedure.query(async () => {
    const sessions = await requireServices().guildDirect.listSessions();
    return sessions.map(guildDirectSessionToWire);
  }),

  /** 频道私聊最新 N 条消息（seq 大到小）。nodeId = 会话 40027。 */
  guildDirectLatest: procedure
    .input(
      z.object({
        nodeId: z.string().min(1),
        stablePaging: z.boolean().optional(),
        limit: z.number().int().min(1).max(200).default(50),
      }),
    )
    .query(async ({ input }) => {
      const guild = requireServices().guildDirect;
      const msgs = await (input.stablePaging
        ? guild.getStableLatest(input.nodeId, input.limit)
        : guild.getLatest(input.nodeId, input.limit));
      return msgs.map(guildDirectMsgToWire);
    }),

  guildDirectAround: procedure
    .input(
      z.object({
        nodeId: z.string().regex(/^-?\d+$/),
        msgId: z.string().regex(/^-?\d+$/),
        msgSeq: z.string().regex(/^-?\d+$/),
      }),
    )
    .query(async ({ input }) => {
      const guild = requireServices().guildDirect;
      const result = await guild.aroundMessage(input.nodeId, input.msgId);
      return { ...result, items: result.items.map(guildDirectMsgToWire) };
    }),

  /** 比 beforeSeq 更旧的一页频道私聊消息（向上滚动），返回仍为 seq 大到小。 */
  guildDirectBefore: procedure
    .input(
      z.object({
        nodeId: z.string().min(1),
        beforeSeq: z.string().min(1),
        beforeMsgId: z
          .string()
          .regex(/^-?\d+$/)
          .optional(),
        limit: z.number().int().min(1).max(200).default(50),
      }),
    )
    .query(async ({ input }) => {
      const guild = requireServices().guildDirect;
      const msgs = await (input.beforeMsgId !== undefined
        ? guild.getBeforeMessage(input.nodeId, input.beforeMsgId, input.limit)
        : guild.getBefore(input.nodeId, BigInt(input.beforeSeq), input.limit));
      return msgs.map(guildDirectMsgToWire);
    }),

  /** 生成记录读取与导出均绑定账号及数据源，不将旧草稿用于新账号。 */
  generatedConversations: procedure.input(generatedAccountInput).query(({ input }) => {
    const services = requireExpectedAccount(
      input.expectedAccountUin,
      input.expectedAccountConfigId,
    );
    return listGeneratedConversations({
      agentLab: services.agentLab,
      assistant: services.assistant,
    });
  }),

  generatedConversation: procedure
    .input(generatedAccountInput.extend({ target: generatedTargetInput }))
    .query(({ input }) => {
      const services = requireExpectedAccount(
        input.expectedAccountUin,
        input.expectedAccountConfigId,
      );
      return captureGeneratedContent(
        { agentLab: services.agentLab, assistant: services.assistant },
        input.target,
      );
    }),

  startGeneratedExport: procedure
    .input(
      generatedAccountInput.extend({
        target: generatedTargetInput,
        messageIds: z.array(z.string().min(1)).optional(),
        formats: z.array(z.enum(GENERATED_EXPORT_FORMATS)).min(1),
        savePolicy: exportSavePolicyInput.optional(),
      }),
    )
    .mutation(({ input }) => {
      const services = requireExpectedAccount(
        input.expectedAccountUin,
        input.expectedAccountConfigId,
      );
      const snapshot = captureGeneratedContent(
        { agentLab: services.agentLab, assistant: services.assistant },
        input.target,
        input.messageIds,
      );
      return services.exportManager.startTask({
        kind: 'c2c',
        conv: 'local-generated',
        name: `${snapshot.title}_${snapshot.sessionTitle}`,
        format: input.formats[0]!,
        formats: input.formats,
        total: snapshot.messages.length,
        generated: snapshot,
        savePolicy: input.savePolicy,
      });
    }),

  /** 频道私聊走 guild_msg.db 与通用多格式管线，但始终禁止漫游消息补全。 */
  guildDirectStartExport: procedure
    .input(
      z.object({
        ...exportAccountBindingInput.shape,
        savePolicy: exportSavePolicyInput.optional(),
        /** 会话 40027 node id（消息分页键）。 */
        nodeId: z.string().min(1),
        messageIds: z.array(z.string().regex(/^-?\d+$/)).optional(),
        /** 任务显示名（对方昵称）。 */
        name: z.string().min(1),
        format: z.enum(['json', 'jsonl', 'txt', 'csv', 'xlsx', 'html']),
        /** 多格式导出：一次任务产出多个文件进同一 bundle（媒体只带一份）。 */
        formats: z.array(z.enum(['json', 'jsonl', 'txt', 'csv', 'xlsx', 'html'])).optional(),
        /** Also export every sender's avatar into an avatars/ subfolder. */
        exportAvatar: z.boolean().optional(),
        /** ChatLab interchange format (json/jsonl carry ChatLab structure). */
        chatlab: z.boolean().optional(),
        /** 导出装扮资源（气泡 / 字体 / 挂件，只导出会话实际用到的款）。 */
        dress: dressInput,
        /** Media export: copy local media into media/ and CDN-complete images. */
        media: z
          .object({
            exportMedia: z.boolean(),
            completeMessages: z.boolean(),
            completeMedia: z.boolean(),
            downloadVideo: z.boolean(),
            downloadFile: z.boolean(),
            downloadPtt: z.boolean(),
            transcribeVoice: z.boolean(),
            /** 在线转写：优先向 QQ 服务端要文本，漏包 / 过期回退本地模型（需 QQ 在线）。 */
            onlineTranscribe: z.boolean().optional(),
            /** 在线转写并发请求数（默认 5）。 */
            onlineConcurrency: z.number().int().min(1).max(32).optional(),
            /** 图片文字识别（自动 OCR）：写 ocr.json + 回写消息文件。 */
            ocrImages: z.boolean().optional(),
            /** 在线识别（0xe07_0）；不开启就是纯本地识别。 */
            onlineOcr: z.boolean().optional(),
            /** 在线识别并发（默认 5）。 */
            onlineOcrConcurrency: z.number().int().min(1).max(32).optional(),
            /** 是否已下好筛图模型（渲染层判定；false 时跳过预筛选阶段）。 */
            ocrPrefilter: z.boolean().optional(),
            /** 导出媒体时按类别筛选（图片 / 语音 / 视频 / 文件 / QQ 系统表情）。 */
            mediaKinds: z
              .object({
                image: z.boolean(),
                voice: z.boolean(),
                video: z.boolean(),
                file: z.boolean(),
                sysface: z.boolean(),
              })
              .optional(),
            /** 下载本地未缓存的装扮资源。 */
            completeDress: z.boolean().optional(),
          })
          .optional(),
        /** Inclusive send-time window (unix seconds); null bound = open-ended. */
        range: z.object({ start: z.number().nullable(), end: z.number().nullable() }).optional(),
      }),
    )
    .mutation(async ({ input }) => {
      const services = requireExpectedAccount(
        input.expectedAccountUin,
        input.expectedAccountConfigId,
      );
      const guild = await services.guildDirect.buildExportMeta(input.nodeId);
      const messageIds =
        input.messageIds === undefined ? undefined : [...new Set(input.messageIds)];
      const total = messageIds?.length ?? (await services.guildDirect.countMessages(input.nodeId));
      if (
        requireExpectedAccount(input.expectedAccountUin, input.expectedAccountConfigId) !== services
      )
        throw new Error('账号数据源已切换，已停止创建频道导出任务。');
      return services.exportManager.startTask({
        kind: 'c2c',
        conv: guild.peerTinyId,
        savePolicy: input.savePolicy,
        name: input.name,
        format: input.format,
        ...(input.formats?.length ? { formats: input.formats } : {}),
        total,
        ...(messageIds !== undefined ? { filter: { messageIds } } : {}),
        ...(input.exportAvatar ? { exportAvatar: true } : {}),
        ...(input.chatlab ? { chatlab: true } : {}),
        ...(input.dress ? { dress: input.dress } : {}),
        // 频道私聊不支持漫游消息：不论前端怎么勾，补全始终关闭。
        ...(input.media ? { media: { ...input.media, completeMessages: false } } : {}),
        ...(input.range && messageIds === undefined ? { range: input.range } : {}),
        guild,
      });
    }),

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
      // 会话物料（a2 / d2 / d2key）+ 设备身份，供 设置 → 账号基础 展示。
      // a1 是 login.db 解出来的 TGTGT payload；guid 与登录无关，单独一档。
      // 渲染层默认打码，眼睛按需展开 —— 与 dbKey 同款交互。
      a1: record.a1Payload ?? null,
      guid: record.guid ?? null,
      session: record.session ?? null,
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

  specialCare: procedure
    .input(z.object({ selfUin: z.string().regex(/^[1-9]\d{4,19}$/) }))
    .query(async ({ input }) => {
      const services = requireServices();
      if (String(getAppContext().account?.context.uin) !== input.selfUin)
        throw new Error('账号已切换，请重新读取特别关心。');
      requireOnlineQqForWeb(services);
      const result = await services.webQuery.getSpecialCare();
      if (getAppContext().services !== services)
        throw new Error('账号已切换，请重新读取特别关心。');
      return result;
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
  botUids: procedure
    .input(z.object({ refresh: z.boolean().optional() }).optional())
    .query(async ({ input }) => {
      return [...(await requireServices().profile.botUids(input?.refresh))];
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
    const service = requireServices().groupInfo;
    const [groups, directory] = await Promise.all([
      service.listAllGroups(page.limit, page.offset),
      service.listGroupDirectory(),
    ]);
    const byCode = new Map(directory.map((entry) => [entry.groupCode, entry]));
    return groups.map((group) => ({
      ...groupDetailToWire(group),
      directory: byCode.get(String(group.groupCode)) ?? null,
    }));
  }),

  /** List group announcements. */
  listGroupBulletins: procedure.input(groupPageInput).query(async ({ input }) => {
    return listGroupBulletinsWithWebFallback(requireServices(), input);
  }),

  /**
   * 群待办（本地 `group_todo_top_banner` + 原消息 element）。
   *
   * 表不存在 / 这个群没有待办 → 空数组，不报错。`groupCode` 省略则取全部群的
   * 当前待办（给「所有群的待办」这类总览用）。
   */
  listGroupTodos: procedure
    .input(z.object({ groupCode: z.string().min(1).optional() }))
    .query(async ({ input }) => {
      const todos = await requireServices().groupInfo.getGroupTodos(
        input.groupCode === undefined ? undefined : BigInt(input.groupCode),
      );
      return todos.map(groupTodoToWire);
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

  /**
   * 取某个群全部当前为精华的消息 seq（仅查本地数据库，不联网）。
   * 返回 string[] 以便与渲染层 Message.msgSeq 直接匹配。
   */
  listGroupEssenceSeqs: procedure
    .input(z.object({ groupCode: z.string().min(1) }))
    .query(async ({ input }) => {
      const seqs = await requireServices().groupInfo.getEssenceSeqs(BigInt(input.groupCode));
      return seqs.map(String);
    }),

  /** Get group essence messages with full content from Web API. */
  getGroupEssenceWithContent: procedure.input(essenceContentInput).query(async ({ input }) => {
    const messages = await requireServices().groupInfo.getEssenceMessagesWithContent(
      input.groupCode,
      input.pageStart ?? 0,
      input.pageLimit ?? 50,
    );
    return messages.map((msg) => essenceContentToWire(input.groupCode, msg));
  }),

  /** 保留成功／失败与服务端完整分页证据，旧数组接口继续兼容。 */
  getGroupEssencePageWithContent: procedure.input(essenceContentInput).query(async ({ input }) => {
    const page = await requireServices().groupInfo.getEssencePageWithContent(
      input.groupCode,
      input.pageStart ?? 0,
      input.pageLimit ?? 50,
    );
    return {
      complete: page.complete,
      messages: page.messages.map((msg) => essenceContentToWire(input.groupCode, msg)),
    };
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
   * List a group's **已退群** members (group_member3 64016 = 1). Backs the chat
   * page's 「已退群成员」list — no protocol involved, reads the local table only.
   */
  listGroupLeftMembers: procedure
    .input(
      z.object({
        groupCode: z.string().min(1),
        limit: z.number().int().min(1).max(300).optional(),
        offset: z.number().int().min(0).optional(),
      }),
    )
    .query(async ({ input }) => {
      const members = await requireServices().groupInfo.listLeftMembersInGroup(
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

  /**
   * Search ONE group's members by nick / group card / QQ number.
   *
   * The 群资料面板 used to filter only the member pages it had already paged
   * in, so a member on a later page could not be found until every earlier page
   * had been fetched. The match now runs server-side over the whole group, and
   * LIMIT/OFFSET pages the matches for the panel's infinite scroll.
   */
  searchGroupMembers: procedure
    .input(
      z.object({
        groupCode: z.string().min(1),
        keyword: z.string().trim().min(1),
        limit: z.number().int().min(1).max(200).default(30),
        offset: z.number().int().min(0).default(0),
      }),
    )
    .query(async ({ input }) => {
      const { items, total } = await requireServices().groupInfo.searchMembersInGroup(
        BigInt(input.groupCode),
        input.keyword,
        input.limit,
        input.offset,
      );
      return { members: items.map(groupMemberToWire), total };
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

  /** 分析目录按打开工具时的账号分派，包含名册外的本地记录。 */
  analysisPeerDirectory: procedure
    .input(z.object({ expectedAccountUin: z.string().min(1) }))
    .query(({ input }) =>
      requireExpectedAccount(input.expectedAccountUin).buddyAnalytics.listAnalysisPeers(),
    ),
  analysisGroupDirectory: procedure
    .input(z.object({ expectedAccountUin: z.string().min(1) }))
    .query(({ input }) =>
      requireExpectedAccount(input.expectedAccountUin).groupInfo.listAnalysisGroups(),
    ),
  analysisMemberDirectory: procedure
    .input(
      z.object({
        groupCode: z.string().regex(/^[1-9]\d*$/),
        expectedAccountUin: z.string().min(1),
      }),
    )
    .query(({ input }) =>
      requireExpectedAccount(input.expectedAccountUin).groupInfo.listAnalysisMembers(
        BigInt(input.groupCode),
      ),
    ),

  /** Detailed per-member analytics for a group. */
  getGroupMemberAnalytics: procedure
    .input(
      z
        .object({
          groupCode: z.string().min(1),
          memberUid: z.string(),
          memberUin: z
            .string()
            .regex(/^[1-9]\d*$/)
            .optional(),
        })
        .and(analyticsRangeInput)
        .refine((input) => Boolean(input.memberUid || input.memberUin), '成员身份不能为空。'),
    )
    .query(async ({ input }) => {
      return requireExpectedAccount(
        input.expectedAccountUin,
        input.expectedAccountConfigId,
      ).groupInfo.getGroupMemberAnalytics(
        BigInt(input.groupCode),
        input.memberUid,
        input.startTime,
        input.endTime,
        input.memberUin,
        input.messageIds,
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

  /**
   * 群聊分析的一站式聚合 —— 排行 / 活跃时段 / 每日热力图 / 词云在**一次**表扫描里
   * 全部算完。前端曾经并发拉四个接口，那是同一张表扫四遍；群历史越长这个差距越大。
   */
  getGroupStatsReport: procedure
    .input(
      z
        .object({
          groupCode: z.string().min(1),
          rankingLimit: z.number().int().min(1).max(100).optional(),
          wordLimit: z.number().int().min(1).max(400).optional(),
          recentYear: z.boolean().optional(),
          skipTimeline: z.boolean().optional(),
        })
        .and(analyticsRangeInput),
    )
    .query(async ({ input }) => {
      return requireExpectedAccount(
        input.expectedAccountUin,
        input.expectedAccountConfigId,
      ).groupInfo.getGroupStatsReport(BigInt(input.groupCode), {
        rankingLimit: input.rankingLimit,
        wordLimit: input.wordLimit,
        startTime: input.startTime,
        endTime: input.endTime,
        recentYear: input.recentYear,
        skipTimeline: input.skipTimeline,
        messageIds: input.messageIds,
      });
    }),

  /**
   * 入群批次分析：三小时内入群人数达到 max(3, 群总人数 ÷ 20) 就算一个批次。
   * 只读成员表 + 一条按发送者聚合的 SQL，不扫消息正文。
   */
  getGroupJoinBatches: procedure
    .input(z.object({ groupCode: z.string().min(1) }).and(analyticsRangeInput))
    .query(async ({ input }) => {
      return requireExpectedAccount(
        input.expectedAccountUin,
        input.expectedAccountConfigId,
      ).groupInfo.getGroupJoinBatches(BigInt(input.groupCode), input);
    }),

  /**
   * 小团体分析：按 5 分钟间隔把群消息切成会话，算两两之间的拉力，返回一张力图。
   * 扫描只读发送者 + 时间（不解码正文）。
   */
  getGroupConversationGraph: procedure
    .input(
      z
        .object({
          groupCode: z.string().min(1),
          windowSeconds: z.number().int().min(30).max(3600).optional(),
          maxEdges: z.number().int().min(20).max(2000).optional(),
        })
        .and(analyticsRangeInput),
    )
    .query(async ({ input }) => {
      return requireExpectedAccount(
        input.expectedAccountUin,
        input.expectedAccountConfigId,
      ).groupInfo.getGroupConversationGraph(BigInt(input.groupCode), {
        windowSeconds: input.windowSeconds,
        maxEdges: input.maxEdges,
        messageIds: input.messageIds,
        startTime: input.startTime,
        endTime: input.endTime,
      });
    }),

  /** Full one-on-one (private chat) analytics for a single peer. */
  getBuddyAnalytics: procedure
    .input(
      z
        .object({ peerUid: z.string().min(1), recentYear: z.boolean().optional() })
        .and(analyticsRangeInput),
    )
    .query(async ({ input }) => {
      return requireExpectedAccount(
        input.expectedAccountUin,
        input.expectedAccountConfigId,
      ).buddyAnalytics.getBuddyAnalytics(input.peerUid, input);
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
        categories: z.array(z.enum(SEARCH_CATEGORIES)).optional(),
      }),
    )
    .query(async ({ input }) => {
      return requireServices().unifiedSearch.quickSearch(
        input.keyword,
        input.limit,
        input.categories,
      );
    }),

  /** Unified sidebar search — slow categories (chat records / files). */
  searchSlow: procedure
    .input(
      z.object({
        keyword: z.string().trim().min(1),
        limit: z.number().int().min(1).max(20).default(3),
        categories: z.array(z.enum(SEARCH_CATEGORIES)).optional(),
      }),
    )
    .query(async ({ input }) => {
      return requireServices().unifiedSearch.slowSearch(
        input.keyword,
        input.limit,
        input.categories,
      );
    }),

  /**
   * QQ 自己的「最近搜索」（nt_msg.db 的 search_history 表）——搜索框空着、刚点开
   * 时下拉里显示的那一份，最近搜过的在最前。只读、只有几行。
   */
  searchHistory: procedure
    .input(z.object({ limit: z.number().int().min(1).max(50).default(20) }).default({}))
    .query(async ({ input }) => {
      return requireServices().unifiedSearch.searchHistory(input.limit);
    }),

  /** Full paginated results for a search category (the "more" modal). */
  searchMore: procedure
    .input(
      z.object({
        category: z.enum(SEARCH_CATEGORIES),
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
      // msgId 未必是真实消息 id —— 乐观渲染的合并转发用的是 `optimistic-<uuid>`
      // 这种本地占位 id（它还没被 QQ 同步回来，库里根本没有这一行）。直接
      // `BigInt()` 会抛「Cannot convert ... to a BigInt」。所以先做安全解析：
      // 不是正整数就当缓存未命中，交给下面的 resId 远程拉取（真发出去的卡片
      // 带服务端签发的 resId，点开就能拉到内容）。
      const msgId = /^\d+$/.test(input.msgId) ? BigInt(input.msgId) : null;
      const records =
        msgId === null || msgId <= 0n
          ? []
          : input.kind === 'group'
            ? await service.getGroupForward(msgId)
            : await service.getC2cForward(msgId);
      if (records.length === 0 && input.resId) {
        // 40900 缓存为空 -> 走协议在线拉取。要求 QQ 在线且未开「完全离线模式」。
        const state = albumAccessState();
        if (!state.qqOnline || !state.attachEnabled) {
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
      const rows = await requireServices().gapHistory.cached(
        input.kind,
        input.conv,
        input.startSeq,
        input.endSeq,
      );
      return rows.map(roamingMsgToWire);
    }),

  roamingBackfill: router({
    list: procedure.query(() => {
      const services = requireServices();
      const access = albumAccessState(services);
      return {
        jobs: services.roamingBackfill.list(),
        activeId: services.roamingBackfill.running(),
        scanning: services.roamingBackfill.scanning(),
        historyVersion: 2,
        onlineAllowed: access.attachEnabled,
        online: access.qqOnline && access.attachEnabled,
      };
    }),
    plan: procedure
      .input(
        z.object({
          transport: z.literal('sso').default('sso'),
          targets: z
            .array(
              z.object({
                kind: z.enum(['group', 'c2c']),
                conv: z.string().min(1),
                name: z.string().min(1).max(300),
              }),
            )
            .min(1),
          range: z
            .object({
              start: z.number().int().nonnegative().optional(),
              end: z.number().int().nonnegative().optional(),
            })
            .optional(),
          beforeOldest: z.boolean().default(false),
          intervalMs: z.number().int().min(500).max(60000).default(500),
        }),
      )
      .mutation(({ input }) => {
        const services = requireServices();
        return services.roamingBackfill.plan(input);
      }),
    start: procedure
      .input(z.object({ id: z.string().uuid(), retryRemaining: z.boolean().default(false) }))
      .mutation(({ input }) =>
        requireServices().roamingBackfill.start(input.id, input.retryRemaining),
      ),
    pause: procedure
      .input(z.object({ id: z.string().uuid() }))
      .mutation(({ input }) => requireServices().roamingBackfill.pause(input.id)),
    cancel: procedure
      .input(z.object({ id: z.string().uuid() }))
      .mutation(({ input }) => requireServices().roamingBackfill.pause(input.id, true)),
    remove: procedure.input(z.object({ id: z.string().uuid() })).mutation(({ input }) => {
      requireServices().roamingBackfill.remove(input.id);
      return true;
    }),
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
      const result = await requireServices().gapHistory.fetch(
        input.kind,
        input.conv,
        input.startSeq,
        input.endSeq,
      );
      return result.ok ? { ...result, messages: result.messages.map(roamingMsgToWire) } : result;
    }),

  /**
   * Field descriptors for the compose form — required/optional/type per
   * authorable element kind, derived from the codec Zod schemas.
   */
  composeElementSpecs: procedure.query(() => requireServices().msgs.getComposeSpecs()),

  /**
   * 新增消息用图：打系统文件框选一张**本机图片**，拷进 QQ 的图片缓存，返回可直接插进
   * 消息的 pic 元素。
   *
   * 取代了旧的「从会话已有消息里挑一张图」—— 那条路只能发别人发过的图。图片按 QQ 自己的
   * 规则落成 `nt_data/Pic/<当月>/Ori/<md5>.<ext>`，聊天渲染（`weq-media://pic` 按发送时间
   * + 文件名找图）因此天然认得它。返回的 `sendTime` **必须**原样写进 `insertMessage`，
   * 否则两边月份对不上就找不到图。
   *
   * `sendTime` 用来**锁定月份**：同一条消息里已经选过图时，调用方把上一张的 `sendTime`
   * 传回来，新图就落到同一个月目录里 —— 否则两张图跨了月末月初，消息只有一个时间戳，
   * 必然有一张按月份找不到。
   *
   * 用户在文件框里点取消时返回 null（不是失败）。
   */
  pickComposeImage: procedure
    .input(z.object({ sendTime: z.number().int().positive().optional() }))
    .mutation(async ({ input }) => {
      const picked = await getHost().pickFile({
        title: '选择一张图片',
        extensions: [...COMPOSE_IMAGE_EXTENSIONS],
      });
      if (!picked) return null;
      const staged = await requireServices().composeImage.stage(picked, input.sendTime);
      return {
        sendTime: staged.sendTime,
        element: elementsToEditable(staged.element),
        preview: staged.preview,
      };
    }),

  /**
   * 合并转发（合成聊天记录）发送：打系统文件框选本机媒体给草稿里的媒体段用。
   *
   * 只负责「拿到一个本机绝对路径」—— 媒体在**发送时真实上传**（见 sendForward /
   * send-elements 的 NTV2 上传），所以这里刻意不落任何缓存、不改动文件。用户取消
   * 文件框时返回 null。文件服务器不接受的上传问题在发送时报错。
   */
  pickSendFile: procedure
    .input(z.object({ kind: z.enum(['image', 'record', 'video', 'file']) }))
    .mutation(async ({ input }) => {
      const spec = PICK_SEND_FILE_SPEC[input.kind];
      const picked = await getHost().pickFile({ title: spec.title, extensions: spec.extensions });
      if (!picked) return null;
      // 登记为「可预览」路径：它在上传前不在 nt_data 里，渲染层的本地预览图 /
      // 音频要经 weq-media://localfile 取字节（见 FileResourceService.resolveLocalFile）。
      requireServices().fileResource.trustPath(picked);
      const info = await stat(picked).catch(() => null);
      return { path: picked, fileName: basename(picked), size: info?.size ?? 0 };
    }),

  /**
   * 发「合并转发 / 聊天记录」—— 两步：SsoSendLongMsg 上传拿 resId，再发承载它的卡片。
   *
   * 节点里的媒体（图片 / 语音 / 视频）在**发送时真实上传**：渲染层给的是本机绝对
   * 路径，服务层按目标场景做 NTV2 上传。需要 QQ 在线且未开完全离线模式。
   * `nodes` 的形状见 @weq/service 的 `SendForwardNodeInput`（含嵌套 `innerForward`）。
   */
  sendForward: procedure
    .input(
      z.object({
        expectedAccountUin: z.string().min(1).optional(),
        expectedAccountConfigId: z.string().min(1).optional(),
        peerType: z.enum(['c2c', 'group']),
        targetId: z.string().min(1),
        nodes: z.array(z.any()).min(1),
      }),
    )
    .mutation(async ({ input }) => {
      const services = requireExpectedAccount(
        input.expectedAccountUin,
        input.expectedAccountConfigId,
      );
      requireQqOnlineForAlbum();
      return services.messageSend.sendForward({
        peerType: input.peerType,
        targetId: input.targetId,
        nodes: input.nodes as never,
      });
    }),

  /**
   * 戳一戳（OIDB 0xED3_1）：群聊里戳某个成员，或私聊戳对方，会话里留下一条
   * 「戳一戳」灰条。**不是消息**，需要在线且已注入的 QQ 实例发包。
   * `targetId` = 群号 / 私聊对方 QQ 号；`targetUin` 仅群聊里有意义（被戳成员 QQ 号）。
   */
  sendPoke: procedure
    .input(
      z.object({
        peerType: z.enum(['c2c', 'group']),
        targetId: z.string().min(1),
        targetUin: z.string().min(1).optional(),
      }),
    )
    .mutation(async ({ input }) => {
      requireQqOnlineForAlbum();
      await requireServices().interaction.sendPoke({
        peerType: input.peerType,
        targetId: input.targetId,
        ...(input.targetUin ? { targetUin: input.targetUin } : {}),
      });
      return { ok: true };
    }),

  /**
   * 给某条**群消息**贴 / 撤表情回应（OIDB 0x9082_1/2）。同样需要在线的已读取 QQ 内存。
   * `code` 1–3 位 = QQ 小黄脸 id，更长 = Unicode 码点（协议层按长度自动分 type）。
   */
  setMessageReaction: procedure
    .input(
      z.object({
        groupId: z.union([z.string().min(1), z.number().int().positive()]),
        sequence: z.number().int().nonnegative(),
        code: z.string().min(1),
        isSet: z.boolean().default(true),
      }),
    )
    .mutation(async ({ input }) => {
      requireQqOnlineForAlbum();
      await requireServices().interaction.setMessageReaction({
        groupId: input.groupId,
        sequence: input.sequence,
        code: input.code,
        isSet: input.isSet,
      });
      return { ok: true };
    }),

  /**
   * 查某条**群消息**上某个表情的回应人名单（OIDB 0x9083_1，可分页）。
   *
   * 本地 40062 列只有计数（`reactions[]` 的 `setNum`），名单只能实时问服务端，所以
   * 这条需要在线已注入的 QQ；离线 / 风控失败会把错误原样上抛，**不吞成空列表** ——
   * 渲染侧要把它显示成「需要 QQ 在线」而不是「没人贴」。
   *
   * 分页沿用仓库的 cursor 约定：`nextCursor` 是服务端的续传 cookie，为空 / 末页给 null。
   */
  messageReactionUsers: procedure
    .input(
      z.object({
        groupId: z.union([z.string().min(1), z.number().int().positive()]),
        sequence: z.number().int().nonnegative(),
        emojiId: z.string().min(1),
        emojiType: z.number().int().positive().optional(),
        count: z.number().int().positive().max(200).default(30),
        cursor: z.string().default(''),
      }),
    )
    .query(async ({ input }) => {
      requireQqOnlineForAlbum();
      const page = await requireServices().interaction.getMessageReactionUsers({
        groupId: input.groupId,
        sequence: input.sequence,
        emojiId: input.emojiId,
        ...(input.emojiType !== undefined ? { emojiType: input.emojiType } : {}),
        count: input.count,
        ...(input.cursor ? { cookie: input.cursor } : {}),
      });
      return {
        items: page.users,
        nextCursor: page.isLast || !page.cookie ? null : page.cookie,
      };
    }),

  /**
   * 撤回一条消息（SsoGroupRecallMsg / SsoC2CRecallMsg）。
   *
   * 权限（2 分钟窗口 / 群主管理员越级）由服务端判定，这里只要求在线已注入的 QQ。
   * **不做任何本地写库** —— 防撤回触发器等 QQ 同步回来自证，前端只看 toast。
   */
  recallMessage: procedure
    .input(
      z.object({
        kind: z.enum(['c2c', 'group']),
        conv: z.string().min(1),
        sequence: z.number().int().positive(),
        random: z.number().int().nonnegative().optional(),
        timestamp: z.number().int().nonnegative().optional(),
        clientSequence: z.number().int().nonnegative().optional(),
      }),
    )
    .mutation(async ({ input }) => {
      requireQqOnlineForAlbum();
      await requireServices().groupModeration.recallMessage({
        kind: input.kind,
        conv: input.conv,
        sequence: input.sequence,
        ...(input.random !== undefined ? { random: input.random } : {}),
        ...(input.timestamp !== undefined ? { timestamp: input.timestamp } : {}),
        ...(input.clientSequence !== undefined ? { clientSequence: input.clientSequence } : {}),
      });
      return { ok: true };
    }),

  /** 设置群成员群名片（0x8FC_3）。给自己改 = 改自己的群昵称。 */
  setGroupMemberCard: procedure
    .input(
      z.object({
        groupId: z.union([z.string().min(1), z.number().int().positive()]),
        targetUid: z.string().min(1),
        card: z.string(),
      }),
    )
    .mutation(async ({ input }) => {
      requireQqOnlineForAlbum();
      await requireServices().groupModeration.setMemberCard({
        groupId: input.groupId,
        targetUid: input.targetUid,
        card: input.card,
      });
      return { ok: true };
    }),

  /** 踢出群成员（0x8A0_1，群主 / 管理员）。 */
  kickGroupMember: procedure
    .input(
      z.object({
        groupId: z.union([z.string().min(1), z.number().int().positive()]),
        targetUid: z.string().min(1),
        reject: z.boolean().optional(),
        reason: z.string().optional(),
      }),
    )
    .mutation(async ({ input }) => {
      requireQqOnlineForAlbum();
      await requireServices().groupModeration.kickMember({
        groupId: input.groupId,
        targetUid: input.targetUid,
        ...(input.reject !== undefined ? { reject: input.reject } : {}),
        ...(input.reason ? { reason: input.reason } : {}),
      });
      return { ok: true };
    }),

  /** 禁言群成员（0x1253_1，群主 / 管理员）。duration 秒，0 = 解除禁言。 */
  muteGroupMember: procedure
    .input(
      z.object({
        groupId: z.union([z.string().min(1), z.number().int().positive()]),
        targetUid: z.string().min(1),
        duration: z.number().int().nonnegative(),
      }),
    )
    .mutation(async ({ input }) => {
      requireQqOnlineForAlbum();
      await requireServices().groupModeration.muteMember({
        groupId: input.groupId,
        targetUid: input.targetUid,
        duration: input.duration,
      });
      return { ok: true };
    }),

  /** 设置 / 取消群管理员（0x1096_1，仅群主）。 */
  setGroupAdmin: procedure
    .input(
      z.object({
        groupId: z.union([z.string().min(1), z.number().int().positive()]),
        targetUid: z.string().min(1),
        enable: z.boolean(),
      }),
    )
    .mutation(async ({ input }) => {
      requireQqOnlineForAlbum();
      await requireServices().groupModeration.setAdmin({
        groupId: input.groupId,
        targetUid: input.targetUid,
        enable: input.enable,
      });
      return { ok: true };
    }),

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

  /** Committed cache rows, scoped to this exact account session; no unread writes. */
  onRoamingMessages: procedure.subscription(() => {
    requireServices();
    const session = getAppContext().account;
    return observable<{ kind: 'group' | 'c2c'; conv: string; messages: ChatMsgWire[] }>((emit) => {
      const handler = (change: RoamingCacheChange) => {
        if (change.session !== session || getAppContext().account !== session) return;
        emit.next({
          kind: change.kind,
          conv: change.conv,
          messages: change.messages.map(roamingMsgToWire),
        });
      };
      dbEventBus.on('roaming', handler);
      return () => {
        dbEventBus.off('roaming', handler);
      };
    });
  }),

  /** Live DB-change ping; the renderer re-reads its original message window. */
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

  /**
   * 聊天图片文字识别 —— 识别聊天里出现过的图片上的文字。
   *
   * 两条腿，**在线优先**：
   *
   *   1. **在线**（OIDB 0xe07_0）：QQ 在线 + 未开完全离线 + a2/d2/d2key/guid 齐全时走它
   *      （见 {@link ocrOnlineBlocker}）。入参就是图片元素自己的信息：`fileToken` 用来
   *      现签一条 CDN 直链，宽高既是随行元数据、也是回包坐标系的基准。
   *   2. **本地模型**：上面那些条件缺一项、或者在线那条路失败（图过期 / 服务端取不到），
   *      就用设置里下好的本地识别模型跑（`onnxruntime` + PP-OCR，见 `main/ocr/`）。
   *      它要的是**图本体**，所以 `src`（灯箱正在显示的那张图的地址）得一起传进来。
   *
   * 两条腿都不可用时按钮就该是灰的（渲染层按 `getGroupAlbumAccessState` 判定）；
   * 真走到了这一步再报错。返回值带 `source`，前端据此在结果上标「在线 / 本地」。
   */
  ocrChatImage: procedure
    .input(
      z.object({
        peerType: z.enum(['c2c', 'group']),
        fileToken: z.string().min(1),
        width: z.number().int().positive(),
        height: z.number().int().positive(),
        md5: z.string().optional(),
        fileSize: z.number().int().nonnegative().optional(),
        /** 灯箱正在显示的图片地址（本地模型那条腿取图用）。 */
        src: z.string().optional(),
      }),
    )
    .mutation(async ({ input }): Promise<ChatOcrLightboxResult> => {
      const services = requireServices();
      const local = resolveLocalOcrModel();
      const online = canOcrOnline(services);
      // 缓存命中就一步都不用跑：灯箱连点、导出刚跑过、甚至过期图（服务端取不到、
      // 本机也没本体）都能立刻出结果。键是图片 md5，和导出 / MCP 完全同一套。
      const cacheKey = input.md5 ? ocrResultCache().keyFor(input.md5) : null;
      if (cacheKey) {
        const hit = await ocrResultCache()
          .getText(cacheKey)
          .catch(() => null);
        if (hit) {
          return {
            status: 'succ',
            srcLang: hit.lang ?? (hit.source === 'local' ? 'local' : 'zh'),
            blocks: hit.blocks ?? [],
            imageWidth: hit.frame.width,
            imageHeight: hit.frame.height,
            sessionId: '',
            source: hit.source,
            ...(hit.modelId ? { modelId: hit.modelId } : {}),
            ...(hit.elapsedMs !== undefined ? { elapsedMs: hit.elapsedMs } : {}),
            cached: true as const,
          };
        }
      }
      if (!online && !local) {
        // 平台能力优先：没有引擎的机器（如 macOS Intel）只能走在线，别劝人家去下模型。
        throw new Error(
          localOcrBlocker() ?? '识别文字需要在线 QQ，或先在「设置 → 图片识别」里下好本地识别模型。',
        );
      }

      if (online) {
        try {
          const result = await services.chatImageOcr.recognize(input);
          await cacheOcrText(input.md5, 'oidb', {
            text: result.blocks.map((b) => b.text).join('\n'),
            blocks: result.blocks,
            imageWidth: result.imageWidth,
            imageHeight: result.imageHeight,
            lang: result.srcLang,
            variant: 'original',
          });
          return { ...result, source: 'oidb' as const };
        } catch (error) {
          // 服务层抛的都是给人看的中文短句；兜底再包一层，避免渲染层收到空 message。
          const message =
            error instanceof Error && error.message ? error.message : '文字识别失败，请稍后重试。';
          if (!local) throw new Error(message);
          try {
            const localResult = await recognizeOcrLocally(input, local);
            await cacheOcrText(input.md5, `local:${localResult.modelId}`, {
              text: localResult.blocks.map((b) => b.text).join('\n'),
              blocks: localResult.blocks,
              imageWidth: localResult.imageWidth,
              imageHeight: localResult.imageHeight,
              modelId: localResult.modelId,
              elapsedMs: localResult.elapsedMs,
            });
            return localResult;
          } catch (localError) {
            // 两条腿都折了：主线是在线那条的报错（用户更可能因此有动作），本地这条附在后面。
            const localMessage =
              localError instanceof Error && localError.message
                ? localError.message
                : '本地模型也没识别成功';
            throw new Error(`${message}（本地模型：${localMessage}）`);
          }
        }
      }

      // 在线不可用（QQ 离线 / 未开自动读取 / 物料不全）→ 本地模型兜底。
      try {
        const localResult = await recognizeOcrLocally(input, local!);
        await cacheOcrText(input.md5, `local:${localResult.modelId}`, {
          text: localResult.blocks.map((b) => b.text).join('\n'),
          blocks: localResult.blocks,
          imageWidth: localResult.imageWidth,
          imageHeight: localResult.imageHeight,
          modelId: localResult.modelId,
          elapsedMs: localResult.elapsedMs,
        });
        return localResult;
      } catch (error) {
        throw new Error(
          error instanceof Error && error.message ? error.message : '本地识别失败，请稍后重试。',
        );
      }
    }),

  /**
   * 结果缓存里有没有这张图（灯箱的 OCR 按钮门禁用）。
   *
   * 「QQ 离线 + 没下本地模型 + 服务端副本已过期」的图本来只能置灰，但只要**以前**识别过
   * （灯箱、导出、MCP 哪一条都算），结果就还在本机 —— 这时按钮照样能点，直接给缓存。
   */
  ocrCacheLookup: procedure.input(z.object({ md5: z.string().min(1) })).query(async ({ input }) => {
    const cache = ocrResultCache();
    const key = cache.keyFor(input.md5);
    if (!key)
      return { hit: false, source: null as 'oidb' | 'local' | null, at: null as number | null };
    const hit = await cache.getText(key).catch(() => null);
    return hit
      ? { hit: true, source: hit.source, at: hit.at }
      : { hit: false, source: null as 'oidb' | 'local' | null, at: null as number | null };
  }),

  // ---- 加入交流群引导（分享码 → authKey → 入群申请 / 深链接 / 浏览器） ----

  /**
   * 加群引导弹窗的**全部前置状态**，一次查询拿齐：
   *   - `inGroup`：本地群列表（`group_list`）里有没有这个群 → 决定是否还要引导加群；
   *   - qqOnline / attachEnabled / 物料齐全度（a2 / d2 / d2key / guid）→ 决定走哪条路；
   *   - 群名 / 头像 / 分享链接（常量，不查库）。
   *
   * `mode` 是给前端的**推荐动作**，同一份状态只在这里判一次，弹窗按钮照着它渲染：
   *   - `inject`     —— 在线 + 物料齐 → 换 authKey 后直接发入群申请；
   *   - `deeplink`   —— 在线但物料缺 → 拉起 QQ 深链接，让 QQ 客户端自己发；
   *   - `browser`    —— QQ 不在线 → 浏览器打开分享页扫码加群。
   *
   * 注意 `inGroup`：为真时渲染层**整个弹窗都不显示**，`mode` 只是照常在算（不消费）。
   */
  getGroupJoinState: procedure.query(async (): Promise<GroupJoinState> => {
    const state = albumAccessState();
    let inGroup = false;
    try {
      const directory = await requireServices().groupInfo.listGroupDirectory();
      inGroup = directory.some((entry) => entry.groupCode === PROJECT_GROUP_CODE);
    } catch {
      // 群列表读不出来（库损坏 / 权限）不该挡住引导 —— 当作「不在群里」。
    }
    const canInject =
      state.qqOnline &&
      state.attachEnabled &&
      state.hasA2 &&
      state.hasD2 &&
      state.hasD2Key &&
      state.hasGuid;
    const mode: GroupJoinMode = !state.qqOnline ? 'browser' : canInject ? 'inject' : 'deeplink';
    return {
      groupCode: PROJECT_GROUP_CODE,
      groupName: PROJECT_GROUP_NAME,
      shareUrl: PROJECT_GROUP_SHARE_URL,
      inGroup,
      mode,
      qqOnline: state.qqOnline,
      attachEnabled: state.attachEnabled,
      hasA2: state.hasA2,
      hasD2: state.hasD2,
      hasD2Key: state.hasD2Key,
      hasGuid: state.hasGuid,
    };
  }),

  /**
   * 执行加群引导的**推荐动作**（按 `getGroupJoinState().mode`）：
   *   - `inject`    ：换 authKey → 发入群申请（OIDB 0x11ec_1），成功即结束；
   *   - `deeplink`  ：换 authKey → 拼 `tencent://groupwpa/` 深链接 → 交给系统拉起 QQ；
   *   - `browser`   ：用系统浏览器打开分享页（手机 QQ 扫码加群）。
   *
   * 不处理「已在群里」：那种情况下渲染层根本不显示弹窗，也就不会调到这里。
   *
   * 返回 `action` 说明实际走了哪条路，前端据此给不同文案（「已发送申请」/「已唤起 QQ」…）。
   * authKey 每次重新换（与分享者绑定、有实效），**不缓存**。
   */
  joinProjectGroup: procedure.mutation(async (): Promise<GroupJoinResult> => {
    const state = albumAccessState();
    if (state.qqOnline && state.attachEnabled) {
      const target = await resolveGroupShareAuthKey(PROJECT_GROUP_SHARE_URL);
      const canInject = state.hasA2 && state.hasD2 && state.hasD2Key && state.hasGuid;
      if (canInject) {
        await requireServices().interaction.sendGroupJoinRequest({
          groupCode: target.groupCode,
          authKey: target.authKey,
        });
        return { action: 'inject', groupCode: target.groupCode };
      }
      const deepLink = buildGroupWpaDeepLink({
        groupUin: target.groupCode,
        authKey: target.authKey,
      });
      await getHost().openExternal(deepLink);
      return { action: 'deeplink', groupCode: target.groupCode, link: deepLink };
    }
    await getHost().openExternal(PROJECT_GROUP_SHARE_URL);
    return { action: 'browser', groupCode: PROJECT_GROUP_CODE, link: PROJECT_GROUP_SHARE_URL };
  }),

  /**
   * 在线转写（语音转文字，QQ 服务端 ASR）是否已 arm。
   *
   * 导出灯箱点「开启在线转录」时 arm：起一个网卡抓包会话（Linux 走提权子进程，
   * Windows 检查 Npcap），导出转录阶段据此发 `pttTrans` 请求并归集异步 push。
   */
  onlineTranscribeStatus: procedure.query(() => ({
    armed: onlineTranscriber.isArmed(),
    uin: onlineTranscriber.armedUin(),
  })),

  /**
   * arm 在线转写抓包会话。前置：QQ 在线 + 未开启完全离线模式（attach 总控）+ 抓包
   * 后端可用（Windows 缺 Npcap 会抛引导文案）。失败原样抛出给前端展示。
   */
  onlineTranscribeArm: procedure
    .input(z.object({ uin: z.string().min(1).optional() }).optional())
    .mutation(async ({ input }) => {
      const state = albumAccessState();
      if (!state.qqOnline) throw new Error('需要先登录该账号的 QQ 客户端。');
      if (!state.attachEnabled) {
        throw new Error('已开启完全离线模式（自动读取 QQ 内存 已关闭），无法开启在线转写。');
      }
      const uin = input?.uin ?? String(getAppContext().account?.context.uin ?? '');
      if (!uin) throw new Error('尚未打开账号，无法开启在线转写。');
      return { ok: true, ...(await onlineTranscriber.arm(uin)) };
    }),

  /** 停掉在线转写的抓包会话（导出结束 / 关闭开关时调用，幂等）。 */
  onlineTranscribeDisarm: procedure.mutation(async () => {
    await onlineTranscriber.disarm();
    return { ok: true };
  }),

  /**
   * 私聊「窗口抖动」—— 一条独立的消息，不跟正文 / 引用一起发。
   *
   * 走 `MessageSvc.PbSendMsg` 的 `poke` 元素（`commonElem serviceType=2`），
   * 见 `MessageSendService.sendWindowShake`。**群聊没有这个能力**（服务端只认私聊），
   * 所以这里不收 peerType，目标一律按私聊解析。
   */
  sendWindowShake: procedure
    .input(z.object({ targetId: z.string().min(1) }))
    .mutation(async ({ input }) => {
      requireQqOnlineForAlbum();
      return requireServices().messageSend.sendWindowShake({ targetId: input.targetId });
    }),

  /**
   * 发消息主链路：一条消息的元素数组。
   *
   * 文本 / @ / 表情 / 超级表情 / 商城表情 / 引用 / 窗口抖动 / 弹射表情，以及
   * **图片 / 语音 / 视频**（媒体元素在服务层真实上传 NTV2）都走这里。
   * 元素形状见 @weq/service 的 `SendElement`：媒体元素的 `source` 是本机绝对路径
   * （优先）或字节（剪贴板等无路径来源）。字节以 `{ type:'Buffer', data }` 过 IPC，
   * 这里用 `elementsFromEditable` 还原成 Uint8Array。
   *
   * `tempGroupCode` 只在「群里发起的临时会话」里给（会话行的 60001 来源群号）：给了
   * 就走 `routingHead.grpTmp` 而不是 c2c —— 见 `MessageSendService` 的 `GroupTempSource`。
   */
  sendElements: procedure
    .input(
      z.object({
        peerType: z.enum(['c2c', 'group']),
        targetId: z.string().min(1),
        expectedAccountUin: z.string().min(1).optional(),
        expectedAccountConfigId: z.string().min(1).optional(),
        tempGroupCode: z.string().min(1).optional(),
        elements: z.array(z.any()).min(1),
        dress: z.any().optional(),
      }),
    )
    .mutation(async ({ input }) => {
      const services = requireExpectedAccount(
        input.expectedAccountUin,
        input.expectedAccountConfigId,
      );
      requireQqOnlineForAlbum(services);
      return services.messageSend.sendElements({
        peerType: input.peerType,
        targetId: input.targetId,
        ...(input.tempGroupCode ? { tempGroupCode: input.tempGroupCode } : {}),
        elements: elementsFromEditable(input.elements) as never,
        ...(input.dress ? { dress: input.dress as never } : {}),
      });
    }),

  /**
   * 发文件（群文件 / 私聊文件）。文件走的是独立管线（老 OIDB + highway 裸帧），
   * 不是媒体元素，所以单开一条 route —— 渲染层给本机**绝对路径**（`webUtils.getPathForFile`）。
   */
  sendFile: procedure
    .input(
      z.object({
        peerType: z.enum(['c2c', 'group']),
        targetId: z.string().min(1),
        expectedAccountUin: z.string().min(1).optional(),
        expectedAccountConfigId: z.string().min(1).optional(),
        path: z.string().min(1),
        fileName: z.string().min(1).optional(),
        folderId: z.string().optional(),
      }),
    )
    .mutation(async ({ input }) => {
      const services = requireExpectedAccount(
        input.expectedAccountUin,
        input.expectedAccountConfigId,
      );
      requireQqOnlineForAlbum(services);
      return services.messageSend.sendFile({
        peerType: input.peerType,
        targetId: input.targetId,
        path: input.path,
        ...(input.fileName ? { fileName: input.fileName } : {}),
        ...(input.folderId ? { folderId: input.folderId } : {}),
      });
    }),

  /**
   * 发语音（录制 / 本机 TTS）。
   *
   * 渲染层录的是 webm/opus，浏览器能解但不是 QQ 要的 SILK；主进程的 `encodeFileToSilk`
   * 只认 WAV / SILK。所以渲染层先用 WebAudio 把录音解成 24 kHz WAV（见 composerSend 的
   * `decodeRecordingToWav`），这里再把这份 WAV 落成临时文件、转 SILK、连同真实波形发送。
   *
   * `wav` 是 IPC 安全的 `{ type:'Buffer', data }` 盒子（`elementsFromEditable` 还原）。
   *
   * `tempGroupCode` 同 `sendElements`：群临时会话里给来源群号，走 grpTmp 路由。
   */
  sendVoice: procedure
    .input(
      z.object({
        peerType: z.enum(['c2c', 'group']),
        targetId: z.string().min(1),
        tempGroupCode: z.string().min(1).optional(),
        wav: z.any(),
        durationSec: z.number().min(0).max(3600).optional(),
        fileName: z.string().min(1).optional(),
        /** 变声标记（协议已实现的 `extBizInfo.ptt.changeVoice`）。 */
        voiceChanged: z.boolean().optional(),
      }),
    )
    .mutation(async ({ input }) => {
      requireQqOnlineForAlbum();
      const wav = elementsFromEditable(input.wav) as Uint8Array;
      if (!(wav instanceof Uint8Array) || wav.byteLength === 0) {
        throw new Error('语音数据为空，无法发送。');
      }
      // 临时文件：`encodeFileToSilk` 按路径读；放系统临时目录，转完即删。
      const tempPath = join(tmpdir(), `weq-voice-${randomUUID()}.wav`);
      await writeFile(tempPath, wav);
      try {
        // 动态 import：voice.ts 依赖 app_context，静态引入会把 wasm 拉进启动路径。
        const { encodeFileToSilk } = await import('../../voice');
        const silk = await encodeFileToSilk(tempPath);
        return requireServices().messageSend.sendMedia({
          peerType: input.peerType,
          targetId: input.targetId,
          ...(input.tempGroupCode ? { tempGroupCode: input.tempGroupCode } : {}),
          kind: 'record',
          source: silk.silk,
          durationSec: input.durationSec ?? silk.durationSec,
          ...(silk.wav ? { waveform: { wav: silk.wav } } : {}),
          ...(input.fileName ? { fileName: input.fileName } : {}),
          ...(input.voiceChanged ? { voiceChanged: true } : {}),
        });
      } finally {
        await unlink(tempPath).catch(() => undefined);
      }
    }),

  /**
   * 闪传（fileset）：把一组本地文件 + 可选封面发成一条闪传消息。
   *
   * 与语音 / 文件同一条输入框入口，但走的是 fileset 管线（不是普通消息元素）：
   * 申请 → commit/complete → **封面传完** → 0x93d7 发消息 → **立刻返回**。只有主文件
   * 字节在后台继续传，所以这个 mutation 不会被大文件拖住；封面必须排在发消息前，
   * 否则对端卡片只会显示默认封面（实机抓包见 FlashTransferService）。
   * 返回 `{ filesetUuid, shareUrl }`，前端拿 uuid 做乐观条目的对账签名。
   *
   * `coverBase64` 有两种来源：默认封面是渲染层用 canvas 拼的 **PNG**（封面图要从
   * `resources/fileicon` 拼，合成放在渲染层——主进程没有 canvas）；用户自定义封面是
   * **原图直通**（渲染层只校验大小与格式，不重绘不压缩），可能是 PNG 或 JPEG。
   * 这里只做大小与落盘，格式由协议层按 magic 探测。
   */
  sendFlashTransfer: procedure
    .input(
      z.object({
        peerType: z.enum(['c2c', 'group']),
        targetId: z.string().min(1),
        files: z
          .array(z.object({ path: z.string().min(1), name: z.string().optional() }))
          .min(1)
          .max(200),
        /** fileset 标题（卡片名）；缺省由服务层按文件名 / 数量拼。 */
        name: z.string().max(120).optional(),
        /** 封面 PNG（可带 `data:image/png;base64,` 前缀），≤ 1 MB。 */
        coverBase64: z.string().optional(),
      }),
    )
    .mutation(async ({ input }) => {
      requireQqOnlineForAlbum();
      const services = requireServices();
      const record = services.accountConfig.getRecord();

      let coverPath: string | null = null;
      if (input.coverBase64) {
        const bytes = Buffer.from(input.coverBase64.replace(/^data:[^,]*,/, ''), 'base64');
        if (bytes.byteLength === 0) throw new Error('封面图数据为空。');
        if (bytes.byteLength > FLASH_COVER_MAX_BYTES) {
          throw new Error(`封面图不能超过 ${FLASH_COVER_MAX_BYTES / 1024 / 1024} MB。`);
        }
        // 用户封面直通后可能是 PNG 也可能是 JPEG：按 magic 探测，落盘用对应扩展名
        // （协议层的 prepareThumbnail 也只认这两种，扩展名不影响上传，但可读性好些）。
        const type = detectThumbType(new Uint8Array(bytes));
        if (type === null) throw new Error('封面只支持 PNG / JPEG 图片。');
        coverPath = join(tmpdir(), `weq-flash-cover-${randomUUID()}.${type}`);
        await writeFile(coverPath, bytes);
      }

      const uploads = services.flashTransfer.sendFlashTransfer({
        files: input.files,
        peerType: input.peerType,
        targetId: input.targetId,
        ...(input.name?.trim() ? { name: input.name.trim() } : {}),
        ...(coverPath ? { thumbPath: coverPath } : {}),
        uploader: {
          uin: record?.uin ?? '',
          nickname: record?.displayName ?? '',
          uid: record?.uid ?? '',
        },
      });

      try {
        const result = await uploads;
        // 后台上传（封面 + 主文件）还在用这个临时封面文件：等它跑完（成败都算）再删。
        if (coverPath) {
          const path = coverPath;
          void result.uploaded.finally(() => unlink(path).catch(() => undefined));
        }
        return { filesetUuid: result.filesetUuid, shareUrl: result.shareUrl };
      } catch (err) {
        // 发消息就失败了：后台上传根本没启动，直接删临时封面。
        if (coverPath) await unlink(coverPath).catch(() => undefined);
        throw err;
      }
    }),

  /**
   * AI 声聊（TTS）：`0x929b_0` 合成即发送（只支持群聊），**没有第二步** ——
   * 不要再拼一条 ptt 元素手动发。见 `MessageSendService.sendAiVoice`。
   */
  sendAiVoice: procedure
    .input(
      z.object({ groupId: z.string().min(1), voiceId: z.string().min(1), text: z.string().min(1) }),
    )
    .mutation(async ({ input }) => {
      requireQqOnlineForAlbum();
      return requireServices().messageSend.sendAiVoice(input);
    }),

  // ---- Ark 卡片（输入框「Ark 卡片」面板）----

  /**
   * 发一张**任意 ark 卡片**：`arkData` 是一段 ark JSON，服务层原样编成 lightApp
   * 元素（`{kind:'ark'}`）走常规 `MessageSvc.PbSendMsg`。
   *
   * 这条路不依赖任何平台下发规则（没有 appId 白名单），所以 PC / Linux 端也能发 ——
   * 面板里只有「自定义 JSON」那一栏用它。输入框的「图文」**不再**自己拼 ark JSON，
   * 改走 {@link sendTuwenArk}（服务端下发的 0xdc2_34，与群反馈的 GitHub issue/PR
   * 卡片同一条路）。
   *
   * `targetId` = 当前会话：群聊给群号，私聊给对方 QQ 号（或 uid）。
   */
  sendArkCard: procedure
    .input(
      z.object({
        peerType: z.enum(['c2c', 'group']),
        targetId: z.string().min(1),
        arkData: z.string().min(1).max(200_000),
      }),
    )
    .mutation(async ({ input }) => {
      requireQqOnlineForAlbum();
      return requireServices().messageSend.sendArkCard(input);
    }),

  /**
   * 发一张**图文 Ark 卡片**（OIDB 0xdc2_34）：服务端按标题 / 描述 / 跳转链接 /
   * 预览图生成卡片直接下发 —— 与群反馈的 GitHub issue/PR 卡片（`submitIssueArk`）
   * 是**同一条路**。
   *
   * 与 {@link sendArkCard} 的区别：那条是把**客户端自己拼的 ark JSON** 当 `lightApp`
   * 元素发出去（「自定义 JSON」那栏用），输入框的「图文」不再走它。返回值里的 `ok`
   * 取自服务端的**业务 result** —— OIDB 外层 errorCode=0 也可能根本没下发出去
   * （见 `docs/develop/ark-send.md`），不要把「调用了」当「发成功」。
   */
  sendTuwenArk: procedure
    .input(
      z.object({
        peerType: z.enum(['c2c', 'group']),
        /** 私聊 = 对方 QQ 号，群聊 = 群号（都是纯数字）。 */
        targetId: z.string().regex(/^\d+$/),
        title: z.string().min(1).max(80),
        desc: z.string().max(200).optional(),
        jumpUrl: z.string().url().max(512),
        previewUrl: z.string().max(512).optional(),
      }),
    )
    .mutation(async ({ input }) => {
      requireQqOnlineForAlbum();
      const targetId = Number(input.targetId);
      if (!Number.isSafeInteger(targetId) || targetId <= 0) {
        throw new Error(`图文卡片的目标不合法：${input.targetId}`);
      }
      const result = await requireServices().flashTransfer.sendTuwenArk({
        targetId,
        peerType: input.peerType === 'group' ? 1 : 0,
        title: input.title.trim(),
        desc: (input.desc ?? '').trim(),
        jumpUrl: input.jumpUrl.trim(),
        previewUrl: (input.previewUrl ?? '').trim(),
      });
      const ok = result.errorCode === 0;
      return {
        ok,
        errorCode: result.errorCode,
        errMsg: result.errorMessage,
        ...(ok
          ? {}
          : {
              hint:
                `服务端拒绝下发（errorCode=${result.errorCode}）：${result.errorMessage}` +
                (result.detail?.message ? `；${result.detail.message}` : ''),
            }),
      };
    }),

  /**
   * 发「推荐好友 / 推荐群」卡片：服务端先按 `contactId` 生成 ark JSON（0x12b6_0 /
   * 0x8b7_5），再作为元素发到 `targetId` 那个会话。
   *
   * `kind` = 卡片推荐**什么**（`qq` 好友 / `group` 群），`contactId` = 被推荐的
   * QQ 号 / 群号；别与 `targetId`（发到哪）填反。
   */
  sendContactArkCard: procedure
    .input(
      z.object({
        peerType: z.enum(['c2c', 'group']),
        targetId: z.string().min(1),
        kind: z.enum(['qq', 'group']),
        contactId: z.number().int().positive(),
        phoneNumber: z.string().optional(),
      }),
    )
    .mutation(async ({ input }) => {
      requireQqOnlineForAlbum();
      return requireServices().messageSend.sendContactCard(input);
    }),

  /**
   * 发一张**群报名 / 群收集表**卡片（OIDB 0x921b_0）。
   *
   * 与其它 Ark 卡片不同：它**以群号寻址**（不走当前会话那条发消息通路），所以
   * `groupCode` 是字段本身。附带图片只收 `imageUrl` 直链，服务层会请求一次算出
   * md5 / 宽高（见 `InteractionService.sendGroupSignup`）。
   *
   * ⚠️ 已知缺口：PC/Linux 端会被服务端在 OIDB 外层以 `319 [oidb] rule type not
   * match appid` 拒绝（与图文 Ark 的 901501 同源），服务层会把错误翻译成人话再抛。
   */
  sendGroupSignup: procedure
    .input(
      z.object({
        groupCode: z.string().regex(/^\d+$/),
        title: z.string().min(1).max(100),
        detail: z.string().min(1).max(4000),
        deadline: z.number().int().positive().optional(),
        method: z.enum(['direct', 'image']).default('direct'),
        maxCount: z.number().int().positive().max(200).default(200),
        imageUrl: z.string().url().optional(),
      }),
    )
    .mutation(async ({ input }) => {
      requireQqOnlineForAlbum();
      const result = await requireServices().interaction.sendGroupSignup({
        groupCode: input.groupCode,
        title: input.title.trim(),
        detail: input.detail.trim(),
        ...(input.deadline ? { deadline: input.deadline } : {}),
        method: input.method === 'image' ? 2 : 1,
        maxCount: input.maxCount,
        ...(input.imageUrl ? { imageUrl: input.imageUrl } : {}),
      });
      return { ok: true as const, ...(result.image ? { image: result.image } : {}) };
    }),

  /**
   * 发一张**位置卡片**（trpc `LocationArk.SsoSendMessage`）。
   *
   * 经纬度是十进制度**字符串**；`region`（省市区）与 `address`（详细地址）由调用方
   * 给出 —— 地图组件不做逆地理（没有安全密钥），地址是用户自己填 / 改的。
   * 返回值里的 `hint` 会如实说明「响应无法判定业务结果」，不要当它是成功回执。
   */
  sendLocationArkCard: procedure
    .input(
      z.object({
        peerType: z.enum(['c2c', 'group']),
        targetId: z.string().min(1),
        address: z.string().min(1),
        region: z.string().min(1),
        latitude: z.string().min(1),
        longitude: z.string().min(1),
      }),
    )
    .mutation(async ({ input }) => {
      requireQqOnlineForAlbum();
      return requireServices().messageSend.sendLocationCard(input);
    }),

  /**
   * 位置卡片面板的**地点搜索**（腾讯位置服务「关键词输入提示」）。
   *
   * 纯公网只读查询，**不需要 QQ 在线**。结果已归一化成面板要的形状：
   * `region` 是拼好的省市区（直辖市去重），`address` 是**去掉省市区前缀**的详细
   * 地址 —— 两者正好对应位置卡片的两个字段，点一条就能把卡片填好。
   */
  lbsSuggestPlaces: procedure
    .input(
      z.object({
        keyword: z.string().min(1),
        /** 当前地图中心，用于按距离排序（latitude 在前，别写反）。 */
        latitude: z.number().optional(),
        longitude: z.number().optional(),
        region: z.string().optional(),
        limit: z.number().int().min(1).max(20).optional(),
      }),
    )
    .query(({ input }) =>
      requireServices().lbs.suggestPlaces({
        keyword: input.keyword,
        ...(input.latitude !== undefined ? { latitude: input.latitude } : {}),
        ...(input.longitude !== undefined ? { longitude: input.longitude } : {}),
        ...(input.region ? { region: input.region } : {}),
        ...(input.limit !== undefined ? { limit: input.limit } : {}),
      }),
    ),

  /**
   * 位置卡片面板的**逆地址解析**：地图上点一下 → 「地点名称 + 省市区 + 详细地址」。
   *
   * `poi_options=policy=5`（位置共享场景）在服务层写死 —— 这正是发位置卡片干的事。
   * 同样不需要 QQ 在线；结果是**建议值**，面板里用户可以改。
   */
  lbsReverseGeocode: procedure
    .input(z.object({ latitude: z.number(), longitude: z.number() }))
    .query(({ input }) =>
      requireServices().lbs.reverseGeocode({
        latitude: input.latitude,
        longitude: input.longitude,
      }),
    ),

  // ---- database decrypt ----

  /** List encrypted `*.db` files under the open account's nt_db directory. */
  listDatabases: procedure.query(() => {
    return requireServices().dbDecrypt.listDatabases();
  }),

  /** True when QQ currently reports this account as logged in. */
  isQqLoggedIn: procedure.input(exportAccountBindingInput.optional()).query(({ input }) => {
    return requireExpectedAccount(
      input?.expectedAccountUin,
      input?.expectedAccountConfigId,
    ).dbDecrypt.isQqLoggedIn();
  }),

  /** Folder dialog for decrypted database output. */
  pickDecryptOutputDir: procedure.mutation(async () => {
    return getHost().pickDirectory({ title: '选择解密保存文件夹' });
  }),

  /** Bulk decrypt selected databases into the chosen folder. */
  decryptDatabases: procedure.input(decryptDbInput).mutation(async ({ input }) => {
    const results = await requireExpectedAccount(
      input.expectedAccountUin,
    ).dbDecrypt.decryptDatabases(input);
    const host = getHost();
    return results.map((result) => {
      const download = result.ok
        ? host.registerDownload?.(result.outPath, result.name, 'file')
        : undefined;
      return { ...result, ...(download ? { downloadUrl: download.url } : {}) };
    });
  }),

  startDatabasePlainExport: procedure
    .input(
      generatedAccountInput.extend({
        dbPaths: z.array(z.string().min(1)).min(1),
        mode: z.enum(['safe', 'fast']),
        savePolicy: exportSavePolicyInput.optional(),
      }),
    )
    .mutation(async ({ input }) => {
      const services = requireExpectedAccount(
        input.expectedAccountUin,
        input.expectedAccountConfigId,
      );
      const listed = await services.dbDecrypt.listDatabases();
      if (
        requireExpectedAccount(input.expectedAccountUin, input.expectedAccountConfigId) !== services
      )
        throw new Error('账号或数据源已切换，请重新选择数据库。');
      const allowed = new Map(listed.map((db) => [db.path, db]));
      const names = new Set<string>();
      const items = [...new Set(input.dbPaths)].map((path) => {
        const db = allowed.get(path);
        if (!db) throw new Error('数据库不在当前账号目录下，请刷新后重选。');
        return {
          dbPath: db.path,
          name: uniqueFilename(sanitizePathSegment(db.name, 'database.db'), names),
        };
      });
      const single = items.length === 1;
      const name = single ? items[0]!.name.replace(/\.db$/i, '') : '数据库明文';
      return services.exportManager.startResourceExport({
        name,
        kind: 'database',
        savePolicy: input.savePolicy,
        ...(single ? { output: { kind: 'file' as const, name, extension: 'db' } } : {}),
        run: async (context) => {
          if (
            requireExpectedAccount(input.expectedAccountUin, input.expectedAccountConfigId) !==
            services
          )
            throw new Error('账号或数据源已切换，请重新选择数据库。');
          context.signal.throwIfAborted();
          assertDestinationCapacity(
            join(context.directory, 'database'),
            items.map((item) => item.dbPath),
          );
          const receipts = await services.dbDecrypt.decryptDatabases({
            items,
            outputDir: context.directory,
            mode: input.mode,
            concurrency: 3,
            signal: context.signal,
            onProgress: context.progress,
          });
          context.signal.throwIfAborted();
          const failed: Array<{ fileName: string; error: string }> = [];
          let ok = 0;
          for (const receipt of receipts) {
            if (dirname(receipt.outPath) !== context.directory)
              throw new Error('解密器返回了不属于本次任务的输出位置。');
            const info = await lstat(receipt.outPath).catch(() => null);
            if (receipt.ok && info?.isFile() && info.size > 0) ok += 1;
            else {
              await unlink(receipt.outPath).catch((error) => {
                if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
              });
              failed.push({
                fileName: receipt.name,
                error: receipt.error || '解密器没有生成有效文件。',
              });
            }
          }
          return {
            total: items.length,
            ok,
            failed,
            ...(single && ok === 1 ? { fileName: basename(receipts[0]!.outPath) } : {}),
          };
        },
      });
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
      const offlineMode = ctx.bootstrap?.userConfig.getSettings().autoAttachQq === false;
      if (!uin || !nt || !record?.qqOnline || !record.qqPid || offlineMode) {
        return { url: landing, autoLogin: false };
      }
      try {
        const result = await nt.ptFetchJumpUrl(record.qqPid, String(uin), landing);
        if (!result.success || !result.url) return { url: landing, autoLogin: false };
        return { url: result.url, autoLogin: true };
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
        const offlineMode = ctx.bootstrap?.userConfig.getSettings().autoAttachQq === false;
        if (!uin || !nt || !record?.qqOnline || !record.qqPid || offlineMode) {
          if (offlineMode) {
            return {
              ok: false,
              reason: 'offline',
              message: '已开启完全离线模式（自动读取 QQ 内存 已关闭），闪传分享需要在线 QQ。',
            };
          }
          return { ok: false, reason: 'offline' };
        }
        try {
          await ctx.bootstrap?.attachHook.ensure(record.qqPid, uin);
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

  /**
   * 查一个红包的领取明细（`hb_pc_detail`）。
   *
   * 与「发消息」同条件：需要**在线且已注入**的 QQ —— 红包包走 hook 上的
   * `sendPacket`（`tenpay.com` 的 p_skey 只是请求体里的一个字段，光有票据发不出去）。
   * p_skey 按域缓存在 `RedBagService` 里，重复点击不会每次都打 OIDB。
   */
  redbagDetail: procedure.input(redbagLocateInput).query(async ({ input }) => {
    const services = requireServices();
    requireQqOnlineForAlbum(services);
    const pid = services.accountConfig.getRecord()?.qqPid;
    if (!pid) throw new Error('需要先登录该账号的 QQ 客户端。');
    const target = await resolveRedBagTarget(services, input);
    return services.redbag.detail({ ...target, peerType: input.kind }, pid);
  }),

  /**
   * 抢一个红包（`hb_pc_grab`）—— **真的会扣钱 / 记一笔领取**。
   *
   * 只有红包卡片上没有自己的领取记录时前端才会走到这里；成功回包里带的就是
   * 自己抢到的那一份（金额 + 时间），所以灯箱直接从「查看领取记录」切到
   * 「你领取到了 ¥x.xx」。
   *
   * 前置条件与 {@link redbagDetail} 完全一致：在线 + 已注入（走 hook 发包）。
   */
  redbagGrab: procedure.input(redbagLocateInput).mutation(async ({ input }) => {
    const services = requireServices();
    requireQqOnlineForAlbum(services);
    const pid = services.accountConfig.getRecord()?.qqPid;
    if (!pid) throw new Error('需要先登录该账号的 QQ 客户端。');
    const target = await resolveRedBagTarget(services, input);
    return services.redbag.grab({ ...target, peerType: input.kind }, pid);
  }),

  /**
   * 发一个红包（`hb_pc_pre_pack`）—— **只下单出码，不扣钱**。
   *
   * 前置条件与 {@link redbagDetail} 完全一致（在线 + 已注入，走 hook 发包）。返回的
   * 是这一单的**二维码 PNG（base64）**，前端在灯箱里展示；真正付款由手机 QQ 完成
   * （QQ 会用当前账号直接拉起支付页），扫码只是回退。
   *
   * `conv`：群聊传群号，私聊传对方 uid（会话 id）或 QQ 号 —— 私聊这里要的是**对方
   * QQ 号**（recvUin），uid 会先查 uid→uin 映射。
   */
  redbagSend: procedure
    .input(
      z.object({
        kind: z.enum(['c2c', 'group']).describe('会话类型'),
        conv: z.string().min(1).describe('私聊为对方 uid / QQ 号，群聊为群号'),
        totalNum: z.number().int().min(1).max(100).describe('红包个数'),
        totalAmount: z.number().int().min(1).describe('总金额，单位分'),
        lucky: z.boolean().describe('是否拼手气（false = 普通等额）'),
        password: z.string().max(60).optional().describe('口令红包的口令'),
        wishing: z.string().max(60).optional().describe('普通红包的祝福语'),
      }),
    )
    .mutation(async ({ input }) => {
      const services = requireServices();
      requireQqOnlineForAlbum(services);
      const pid = services.accountConfig.getRecord()?.qqPid;
      if (!pid) throw new Error('需要先登录该账号的 QQ 客户端。');

      let recvUin: string;
      if (input.kind === 'group') {
        recvUin = input.conv;
      } else if (/^\d+$/.test(input.conv)) {
        recvUin = input.conv;
      } else {
        recvUin = String(getAppContext().account?.uidMap.uinByUid(input.conv) ?? '');
      }
      if (!recvUin) throw new Error('解析不出红包的领取方 QQ 号。');

      return services.redbag.send(
        {
          peerType: input.kind,
          recvUin,
          totalNum: input.totalNum,
          totalAmount: input.totalAmount,
          lucky: input.lucky,
          ...(input.password ? { password: input.password } : {}),
          ...(input.wishing ? { wishing: input.wishing } : {}),
        },
        pid,
      );
    }),

  /** 口令红包的候选口令池（`SsoGetToken`）。需要在线且已注入的 QQ。 */
  redbagPasswords: procedure.query(async () => {
    const services = requireServices();
    requireQqOnlineForAlbum(services);
    const pid = services.accountConfig.getRecord()?.qqPid;
    if (!pid) throw new Error('需要先登录该账号的 QQ 客户端。');
    return services.redbag.passwords(pid);
  }),

  /** List group albums via Qzone web CGI. Requires online QQ (pt_login can mint p_skey). */
  listGroupAlbums: procedure.input(groupAlbumInput).query(async ({ input }) => {
    const services = requireServices();
    // qzone.qq.com 的 p_skey 可由 ptlogin2 本地快速登录兜底，无需注入 / ClientKey。
    requireOnlineQqForWeb(services);
    const albums = await services.webQuery.getGroupAlbumList(input.groupCode);
    services.contentSearch?.remember(
      albums.map((album) => ({
        target: { kind: 'groupAlbum', groupCode: input.groupCode, albumId: album.id },
        title: album.title,
        content: album.desc,
        sourceName: `群 ${input.groupCode}`,
        time: 0,
      })),
    );
    return albums;
  }),

  /** List all media for one group album. Requires the saved online QQ pid. */
  listGroupAlbumMedia: procedure.input(groupAlbumMediaInput).query(async ({ input }) => {
    const services = requireServices();
    requireQqOnlineForAlbum(services);
    return collectAlbumMedia(services, input.groupCode, input.albumId);
  }),

  // ---- 个人空间相册（QQ 空间 · 空间相册查看器）----

  /**
   * 某个 QQ 空间（自己或好友）的相册列表。走 qzone web cgi，需要在线 QQ ——
   * p_skey 可由 ptlogin2 本地快速登录兜底，无需注入 / ClientKey。
   */
  qzoneAlbumList: procedure.input(qzoneAlbumListInput).query(async ({ input }) => {
    const services = requireServices();
    requireOnlineQqForWeb(services);
    return services.webQuery.getQzoneAlbums(input.hostUin);
  }),

  /**
   * 某个相册内的媒体（照片 / 视频）列表，分页。`topicId` = 相册列表里的
   * `album.id`；`pageStart` 偏移 + `pageNum` 页大小支持深翻。同样需要在线 QQ。
   */
  qzoneAlbumMedia: procedure.input(qzoneAlbumMediaInput).query(async ({ input }) => {
    const services = requireServices();
    requireOnlineQqForWeb(services);
    return services.webQuery.getQzoneAlbumPhotos(
      input.hostUin,
      input.topicId,
      input.pageStart,
      input.pageNum,
    );
  }),

  /** 相册视频本体 mp4 URL（列表只给封面，播放/下载前按 picKey 现取）。 */
  qzoneAlbumVideoUrl: procedure.input(qzoneAlbumVideoUrlInput).query(async ({ input }) => {
    const services = requireServices();
    requireOnlineQqForWeb(services);
    return services.webQuery.getQzoneAlbumVideoUrl(input.hostUin, input.topicId, input.picKey);
  }),

  /** Folder dialog for qzone album media export output. */
  pickQzoneAlbumExportDir: procedure.mutation(async () => {
    return getHost().pickDirectory({ title: '选择空间相册保存文件夹' });
  }),

  /** 并发下载选中的空间相册媒体（照片原图 / 视频本体）到所选文件夹。 */
  exportQzoneAlbumMedia: procedure.input(exportQzoneAlbumMediaInput).mutation(async ({ input }) => {
    return exportQzoneAlbumMedia(requireServices(), input);
  }),

  /** Folder dialog for group album export output. */
  pickGroupAlbumExportDir: procedure.mutation(async () => {
    return getHost().pickDirectory({ title: '选择群相册保存文件夹' });
  }),

  /** Enumerate selected albums first, then concurrently download all media. */
  exportGroupAlbums: procedure.input(exportGroupAlbumsInput).mutation(async ({ input }) => {
    return exportGroupAlbums(requireServices(), input);
  }),

  startGroupAlbumExport: procedure
    .input(
      exportGroupAlbumsInput
        .omit({ outputDir: true })
        .merge(exportAccountBindingInput)
        .extend({ name: z.string().min(1), savePolicy: exportSavePolicyInput.optional() }),
    )
    .mutation(async ({ input }) => {
      const services = requireExpectedAccount(
        input.expectedAccountUin,
        input.expectedAccountConfigId,
      );
      requireFreshClientKeyForAlbum(services);
      const selected = structuredClone(input);
      return services.exportManager.startResourceExport({
        kind: 'group-albums',
        name: selected.name,
        savePolicy: selected.savePolicy,
        run: async (context) => {
          if (
            requireExpectedAccount(
              selected.expectedAccountUin,
              selected.expectedAccountConfigId,
            ) !== services
          )
            throw new Error('账号或数据源已切换，请重新选择资源。');
          return exportGroupAlbums(
            services,
            { ...selected, outputDir: context.directory },
            context,
          );
        },
      });
    }),

  // ---- 群文件 ----

  /** 列出群文件某个目录下的文件+子文件夹 (OIDB 0x6D8_1)。需要在线的 QQ 进程。 */
  listGroupFiles: procedure.input(groupFileInput).query(async ({ input }) => {
    const services = requireServices();
    requireQqOnlineForAlbum(services);
    const listing = await services.groupFile.list(Number(input.groupCode), input.folderId ?? '/');
    services.contentSearch?.remember(
      listing.files.map((file) => ({
        target: {
          kind: 'groupFile',
          groupCode: input.groupCode,
          folderId: listing.targetDirectory,
          fileId: file.fileId,
        },
        title: file.fileName,
        content: file.uploaderName,
        sourceName: `群 ${input.groupCode} · ${listing.targetDirectory === '/' ? '根目录' : listing.targetDirectory}`,
        time: file.uploadedTime,
      })),
    );
    return listing;
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

  startGroupFileExport: procedure
    .input(
      exportGroupFilesInput
        .omit({ outputDir: true })
        .merge(exportAccountBindingInput)
        .extend({ name: z.string().min(1), savePolicy: exportSavePolicyInput.optional() }),
    )
    .mutation(async ({ input }) => {
      const services = requireExpectedAccount(
        input.expectedAccountUin,
        input.expectedAccountConfigId,
      );
      requireQqOnlineForAlbum(services);
      const selected = structuredClone(input);
      return services.exportManager.startResourceExport({
        kind: 'group-files',
        name: selected.name,
        savePolicy: selected.savePolicy,
        run: async (context) => {
          if (
            requireExpectedAccount(
              selected.expectedAccountUin,
              selected.expectedAccountConfigId,
            ) !== services
          )
            throw new Error('账号或数据源已切换，请重新选择资源。');
          return exportGroupFiles(services, { ...selected, outputDir: context.directory }, context);
        },
      });
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
      // 完全离线模式（自动读取 QQ 内存 关闭）：网络同步需要 weiyun p_skey（在线实例），
      // 一律回退本地 collection.db，避免白打一次网络 + 凭证换取。
      const offlineMode =
        getAppContext().bootstrap?.userConfig.getSettings().autoAttachQq === false;
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

  collectionDetail: procedure
    .input(z.object({ cid: z.string().min(1).max(512) }))
    .query(async ({ input }) => {
      const service = requireServices().collection;
      const content = await service.readCachedContent(input.cid);
      if (content) return collectionDetailToWire(input.cid, content);
      const item = await service.readCachedDetail(input.cid);
      return item ? collectionItemToWire(item) : null;
    }),

  localCollectionItem: procedure
    .input(z.object({ cid: z.string().min(1).max(512) }))
    .query(async ({ input }) => {
      const item = await requireServices().collection.readLocalItem(input.cid);
      return item ? collectionItemToWire(item) : null;
    }),

  /** Pull one bounded operation-20001 batch and persist it in the account cache. */
  syncCollectionDetails: procedure
    .input(
      z.object({
        requestId: z.string().min(1).max(128),
        cids: z.array(z.string().min(1).max(256)).min(1).max(20),
        force: z.boolean().optional(),
      }),
    )
    .mutation(async ({ input }) => {
      if (activeCollectionDetailSyncs.has(input.requestId)) {
        throw new Error('收藏详情同步任务已在运行。');
      }
      const controller = new AbortController();
      activeCollectionDetailSyncs.set(input.requestId, controller);
      try {
        const details = await requireServices().collection.fetchDetails(input.cids, {
          force: input.force,
          signal: controller.signal,
        });
        return details.map((detail) => collectionDetailToWire(detail.cid, detail.content));
      } finally {
        if (activeCollectionDetailSyncs.get(input.requestId) === controller) {
          activeCollectionDetailSyncs.delete(input.requestId);
        }
      }
    }),

  cancelCollectionDetailSync: procedure
    .input(z.object({ requestId: z.string().min(1).max(128) }))
    .mutation(({ input }) => {
      const controller = activeCollectionDetailSyncs.get(input.requestId);
      controller?.abort(new Error('收藏详情同步已取消。'));
      return { cancelled: Boolean(controller) };
    }),

  downloadCollectionMedia: procedure
    .input(z.object({ cid: z.string().min(1).max(256), requestId: z.string().min(1).max(128) }))
    .mutation(async ({ input }) => {
      if (activeCollectionDetailSyncs.has(input.requestId))
        throw new Error('收藏附件下载已在运行。');
      const controller = new AbortController();
      activeCollectionDetailSyncs.set(input.requestId, controller);
      const collection = requireServices().collection;
      const host = getHost();
      try {
        const receipts = await collection.downloadMedia(input.cid, {
          signal: controller.signal,
          inspectImage: host.inspectCollectionImage?.bind(host),
        });
        return receipts.map((receipt) => ({
          id: receipt.reference.id,
          name: receipt.reference.name,
          kind: receipt.reference.kind,
          state: receipt.state,
          role: receipt.role,
          bytes: receipt.bytes,
          md5Matches: receipt.md5Matches,
          sizeMatches: receipt.sizeMatches,
          imageDecoded: receipt.imageDecoded,
          error: receipt.error,
        }));
      } finally {
        activeCollectionDetailSyncs.delete(input.requestId);
      }
    }),

  revealCollectionMedia: procedure.mutation(async () => {
    const dir = requireServices().collection.mediaCacheDirectory();
    await mkdir(dir, { recursive: true });
    await getHost().revealInFolder(dir);
    return { ok: true };
  }),

  saveCollectionMedia: procedure
    .input(z.object({ id: z.string().regex(/^[a-f0-9]{64}$/) }))
    .mutation(async ({ input }) => {
      const service = requireServices().collection;
      const name = await service.cachedMediaName(input.id);
      const target = await getHost().pickSaveTarget({
        defaultName: name,
        extension: extname(name).slice(1),
      });
      if (!target) return null;
      await service.saveMediaAs(input.id, target.path);
      return { downloadId: target.downloadId, name };
    }),

  // ---- export ----

  /** List conversations with message counts (batch query). */
  listConversationsWithCount: procedure.query(async () => {
    const services = requireServices();
    // 空 targetUid 的系统/占位会话既不能当消息分区键，也不是可导出目标 —— 直接剔除。
    // SQLite 的 LIMIT -1 读取全部会话；计数分批，避免超过绑定参数上限。
    const contacts = (await services.recentContacts.getRecentContact(-1)).filter(
      (c) => c.targetUid,
    );

    // 分类是收集查询集和计数分流的唯一依据，两处必须共用，否则会出现
    // 「归到 c2c 计数、却没被 countByUids 查过」的会话恒显示 0 条 —— 公众号
    // (KCHATTYPETEMPPUBLICACCOUNT=103) 等枚举名不含 'C2C' 的临时会话就是这样：
    // 消息其实在 c2c_msg_table，只是没进查询集。dataline 走独立表单独计数，
    // 其余一切都按 c2c 归类（能查到就显示真实条数，查不到才是 0）。
    //
    // 用 codec 的 classifyChatType 严格分类，不能按子串猜：群聊发起的临时会话
    // KCHATTYPETEMPC2CFROMGROUP（100）名字里含 'GROUP'，按子串判会被丢进 group
    // 查询集，而它的消息其实在 c2c_msg_table —— 于是恒显示 0 条、类型显示成
    // 群聊、导出走群消息表导空。
    const kindOf = (chatType: string | number): 'group' | 'dataline' | 'c2c' => {
      const kind = classifyChatType(chatType);
      if (kind === 'group') return 'group';
      if (kind === 'dataline') return 'dataline';
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
    async function countBatches(
      ids: string[],
      fetch: (batch: string[]) => Promise<Record<string, number>>,
    ) {
      const counts: Record<string, number> = {};
      for (let offset = 0; offset < ids.length; offset += 500) {
        Object.assign(counts, await fetch(ids.slice(offset, offset + 500)));
      }
      return counts;
    }
    const [groupCounts, c2cCounts, datalineCounts] = await Promise.all([
      countBatches(
        groupCodes,
        (batch) => account?.groupMsgs.countByGroups(batch) ?? Promise.resolve({}),
      ),
      countBatches(c2cUids, (batch) => account?.c2cMsgs.countByUids(batch) ?? Promise.resolve({})),
      countBatches(
        datalineUids,
        (batch) => account?.datalineMsgs.countByUids(batch) ?? Promise.resolve({}),
      ),
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
        ...exportAccountBindingInput.shape,
        savePolicy: exportSavePolicyInput.optional(),
        kind: z.enum(['group', 'c2c']),
        conv: z.string().min(1),
        name: z.string().min(1),
        format: z.enum(['json', 'jsonl', 'txt', 'csv', 'xlsx', 'html']),
        /** 多格式导出：一次任务产出多个文件进同一 bundle（媒体只带一份）。 */
        formats: z.array(z.enum(['json', 'jsonl', 'txt', 'csv', 'xlsx', 'html'])).optional(),
        total: z.number().int().min(0),
        /** Also export every sender's avatar into an avatars/ subfolder. */
        exportAvatar: z.boolean().optional(),
        /** ChatLab interchange format (json/jsonl carry ChatLab structure). */
        chatlab: z.boolean().optional(),
        /** 导出装扮资源（气泡 / 字体 / 挂件，只导出会话实际用到的款）。 */
        dress: dressInput,
        /** Media export: copy local media into media/ and CDN-complete images. */
        media: z
          .object({
            exportMedia: z.boolean(),
            completeMessages: z.boolean(),
            completeMedia: z.boolean(),
            downloadVideo: z.boolean(),
            downloadFile: z.boolean(),
            downloadPtt: z.boolean(),
            transcribeVoice: z.boolean(),
            /** 在线转写：优先向 QQ 服务端要文本，漏包 / 过期回退本地模型（需 QQ 在线）。 */
            onlineTranscribe: z.boolean().optional(),
            /** 在线转写并发请求数（默认 5）。 */
            onlineConcurrency: z.number().int().min(1).max(32).optional(),
            /** 图片文字识别（自动 OCR）：写 ocr.json + 回写消息文件。 */
            ocrImages: z.boolean().optional(),
            /** 在线识别（0xe07_0）；不开启就是纯本地识别。 */
            onlineOcr: z.boolean().optional(),
            /** 在线识别并发（默认 5）。 */
            onlineOcrConcurrency: z.number().int().min(1).max(32).optional(),
            /** 是否已下好筛图模型（渲染层判定；false 时跳过预筛选阶段）。 */
            ocrPrefilter: z.boolean().optional(),
            /** 导出媒体时按类别筛选（图片 / 语音 / 视频 / 文件 / QQ 系统表情）。 */
            mediaKinds: z
              .object({
                image: z.boolean(),
                voice: z.boolean(),
                video: z.boolean(),
                file: z.boolean(),
                sysface: z.boolean(),
              })
              .optional(),
            /** 下载本地未缓存的装扮资源。 */
            completeDress: z.boolean().optional(),
          })
          .optional(),
        /** Inclusive send-time window (unix seconds); null bound = open-ended. */
        range: z.object({ start: z.number().nullable(), end: z.number().nullable() }).optional(),
        filter: z
          .object({
            messageIds: exactMessageIdsInput,
            sender: z.string().max(128).optional(),
            keyword: z.string().max(512).optional(),
            category: z
              .enum(['text', 'image', 'video', 'voice', 'file', 'emoji', 'system', 'other'])
              .optional(),
          })
          .optional(),
      }),
    )
    .mutation(async ({ input }) => {
      return requireExpectedAccount(
        input.expectedAccountUin,
        input.expectedAccountConfigId,
      ).exportManager.startTask(input);
    }),

  /**
   * Start a QZone (说说) export — 目标可以是好友或自己（`conv` 承载目标 uin）。
   * Requires an online QQ (the web CGI needs this account's skey/pskey).
   * Media = 配图。HTML 格式会强制下载配图（task_manager 内保证）。
   */
  startQzoneExport: procedure
    .input(
      z.object({
        savePolicy: exportSavePolicyInput.optional(),
        targetUin: z.string().min(1),
        tids: z.array(z.string().trim().min(1).max(512)).optional(),
        expectedAccountUin: z.string().min(1).optional(),
        expectedAccountConfigId: z.string().min(1).optional(),
        name: z.string().min(1),
        format: z.enum(['json', 'txt', 'html']),
        /** 多格式导出：json / txt / html 一次任务全出。 */
        formats: z.array(z.enum(['json', 'txt', 'html'])).optional(),
        /** 补全互动：按 tid 拉取评论 + 点赞（空间动态页 HTML 解析，best-effort，需在线 QQ）。 */
        includeInteraction: z.boolean().optional(),
        downloadMedia: z.boolean(),
        range: z.object({ start: z.number().nullable(), end: z.number().nullable() }).optional(),
      }),
    )
    .mutation(async ({ input }) => {
      const services = requireExpectedAccount(
        input.expectedAccountUin,
        input.expectedAccountConfigId,
      );
      requireQqOnlineForAlbum(services); // 硬性要求：在线 QQ 实例
      const tids = input.tids === undefined ? undefined : [...new Set(input.tids)];
      return services.exportManager.startTask({
        qzone: true,
        ...(tids !== undefined ? { qzoneTids: tids } : {}),
        savePolicy: input.savePolicy,
        kind: 'c2c',
        conv: input.targetUin,
        name: input.name,
        format: input.format,
        ...(input.formats?.length ? { formats: input.formats } : {}),
        ...(input.includeInteraction ? { qzoneInteractions: true } : {}),
        total: tids?.length ?? 0,
        media: {
          exportMedia: input.downloadMedia,
          completeMessages: false,
          completeMedia: false,
          downloadVideo: false,
          downloadFile: false,
          downloadPtt: false,
          transcribeVoice: false,
        },
        ...(input.range && tids === undefined ? { range: input.range } : {}),
      });
    }),

  /**
   * 名单导出：好友（friends）、群成员（group，groupCode 必填）、群聊（groups）。
   * 走本地资料库，无需在线 QQ；只有好友名单支持 vcard，群聊目录不下载联系人头像。
   */
  startContactsExport: procedure
    .input(
      z.object({
        savePolicy: exportSavePolicyInput.optional(),
        scope: z.enum(['friends', 'group', 'groups']),
        expectedAccountUin: z.string().min(1).optional(),
        expectedAccountConfigId: z.string().min(1).optional(),
        groupIds: z
          .array(z.string().regex(/^[1-9]\d*$/))
          .min(1)
          .optional(),
        groupCode: z.string().optional(),
        name: z.string().min(1),
        format: z.enum(['json', 'jsonl', 'csv', 'xlsx', 'txt', 'vcard']),
        /** 多格式导出：一次任务产出多个表文件（头像只带一份）。 */
        formats: z.array(z.enum(['json', 'jsonl', 'csv', 'xlsx', 'txt', 'vcard'])).optional(),
        exportAvatar: z.boolean().optional(),
        categoryIds: z.array(z.number().int()).optional(),
        uids: z.array(z.string().min(1)).min(1).optional(),
      }),
    )
    .mutation(async ({ input }) => {
      if (input.scope === 'group' && !input.groupCode) {
        throw new Error('导出群成员需要指定群号。');
      }
      if (
        input.scope === 'groups' &&
        (input.exportAvatar || input.uids || input.categoryIds || input.groupCode)
      )
        throw new Error('群聊名单导出不接受联系人范围或头像下载选项。');
      if (input.scope !== 'groups' && input.groupIds)
        throw new Error('群号列表仅用于群聊名单导出。');
      // vcard 仅好友可用；群成员传 vcard 时回退到 csv。
      const format = input.scope !== 'friends' && input.format === 'vcard' ? 'csv' : input.format;
      const formats = (input.formats ?? [input.format]).map((f) =>
        input.scope !== 'friends' && f === 'vcard' ? 'csv' : f,
      ) as Array<'json' | 'jsonl' | 'csv' | 'xlsx' | 'txt' | 'vcard'>;
      return requireExpectedAccount(
        input.expectedAccountUin,
        input.expectedAccountConfigId,
      ).exportManager.startTask({
        contacts: {
          scope: input.scope,
          ...(input.categoryIds ? { categoryIds: input.categoryIds } : {}),
          ...(input.uids ? { uids: input.uids } : {}),
          ...(input.groupIds ? { groupIds: input.groupIds } : {}),
        },
        kind: 'c2c',
        savePolicy: input.savePolicy,
        conv: input.scope === 'group' ? input.groupCode! : '',
        name: input.name,
        format,
        formats,
        total: 0,
        exportAvatar: input.exportAvatar ?? false,
      });
    }),

  contactsExportPreview: procedure
    .input(
      z.discriminatedUnion('scope', [
        z.object({ scope: z.literal('friends') }),
        z.object({ scope: z.literal('group'), groupCode: z.string().min(1) }),
      ]),
    )
    .query(async ({ input }) => {
      const services = requireServices();
      if (input.scope === 'friends') return services.profile.listExportFriends();
      return services.groupInfo.listExportMembers(BigInt(input.groupCode));
    }),

  exportGroupDirectory: procedure.query(() => requireServices().groupInfo.listExportGroups()),

  /**
   * Start a collection (收藏) export — 走本地收藏库，无需在线 QQ。全部或按类型
   * (`kinds`) 过滤，导出为 json/csv/xlsx/txt 表格。
   */
  startCollectionExport: procedure
    .input(
      z.object({
        ...exportAccountBindingInput.shape,
        savePolicy: exportSavePolicyInput.optional(),
        name: z.string().min(1),
        format: z.enum(['json', 'csv', 'xlsx', 'txt']),
        kinds: z.array(z.string()).optional(),
        cids: z.array(z.string().min(1)).min(1).optional(),
      }),
    )
    .mutation(async ({ input }) => {
      return requireExpectedAccount(
        input.expectedAccountUin,
        input.expectedAccountConfigId,
      ).exportManager.startTask({
        collection: {
          ...(input.kinds?.length ? { kinds: input.kinds } : {}),
          ...(input.cids ? { cids: input.cids } : {}),
        },
        kind: 'c2c',
        savePolicy: input.savePolicy,
        conv: '',
        name: input.name,
        format: input.format,
        total: 0,
      });
    }),

  /**
   * Force a one-shot rkey harvest from the online QQ for the open account — the
   * explicit "立即重新获取 rkey" before a media-completing export. Returns true
   * when fresh rkeys were stored. 完全离线模式（自动读取 QQ 内存 关闭）下直接返回 false。
   */
  refreshRkeys: procedure.mutation(() => {
    return getAppContext().refreshRkeysNow();
  }),

  /** List all export tasks. */
  exportPreflight: procedure
    .input(
      z.object({
        kind: z.enum(['group', 'c2c']),
        conv: z.string().min(1),
        range: z
          .object({ start: z.number().int().nullable(), end: z.number().int().nullable() })
          .optional(),
        filter: z
          .object({
            messageIds: exactMessageIdsInput,
            sender: z.string().max(128).optional(),
            keyword: z.string().max(512).optional(),
            category: z
              .enum(['text', 'image', 'video', 'voice', 'file', 'emoji', 'system', 'other'])
              .optional(),
          })
          .optional(),
        formats: z.array(z.enum(['json', 'jsonl', 'txt', 'csv', 'xlsx', 'html'])).optional(),
        exportMedia: z.boolean().optional(),
      }),
    )
    .query(({ input }) => requireServices().exportManager.preflight(input)),

  listExportTasks: procedure.query(() => {
    return requireServices().exportManager.listTasks();
  }),

  saveExportTaskOutput: procedure
    .input(
      z.object({
        taskId: z.string().min(1),
        directory: z.string().min(1).optional(),
        filePath: z.string().min(1).optional(),
        uniqueFileName: z.boolean().optional(),
        expectedAccountUin: z.string().min(1).optional(),
        expectedAccountConfigId: z.string().min(1).optional(),
      }),
    )
    .mutation(async ({ input }) => {
      const services = requireExpectedAccount(
        input.expectedAccountUin,
        input.expectedAccountConfigId,
      );
      return saveCompletedExportTask(
        services.exportManager,
        input.taskId,
        getHost,
        {
          directory: input.directory,
          filePath: input.filePath,
          uniqueFileName: input.uniqueFileName,
        },
        () => {
          if (
            requireExpectedAccount(input.expectedAccountUin, input.expectedAccountConfigId) !==
            services
          )
            throw new Error('账号数据源已切换，已取消保存。');
        },
      );
    }),

  getExportOutputReceipt: procedure
    .input(generatedAccountInput.extend({ taskId: z.string().min(1) }))
    .query(({ input }) => {
      const task = requireExpectedAccount(
        input.expectedAccountUin,
        input.expectedAccountConfigId,
      ).exportManager.getTask(input.taskId);
      if (!task) return null;
      return {
        id: task.id,
        name: task.name,
        status: task.status,
        error: task.error,
        save: task.save,
        output: task.bundleDir
          ? { kind: 'directory' as const }
          : task.filePath
            ? {
                kind: 'file' as const,
                name: task.name,
                extension:
                  task.resource?.output?.extension ??
                  (extname(task.filePath).slice(1) || task.format),
              }
            : null,
      };
    }),

  openSavedExportOutput: procedure
    .input(
      z.object({
        taskId: z.string().min(1),
        reveal: z.boolean().default(false),
        expectedAccountUin: z.string().min(1).optional(),
        expectedAccountConfigId: z.string().min(1).optional(),
      }),
    )
    .mutation(async ({ input }) => {
      const task = requireExpectedAccount(
        input.expectedAccountUin,
        input.expectedAccountConfigId,
      ).exportManager.getTask(input.taskId);
      const host = getHost();
      if (!host.canReveal) throw new Error('服务器保存位置不能在当前浏览器中打开。');
      if (!task?.save?.path) throw new Error('任务尚未保存到指定位置。');
      if (input.reveal) await host.revealInFolder(task.save.path);
      else await host.revealPath(task.save.path);
      return true;
    }),

  exportTaskDownload: procedure
    .input(exportAccountBindingInput.extend({ taskId: z.string().min(1) }))
    .mutation(({ input }) => {
      const task = requireExpectedAccount(
        input.expectedAccountUin,
        input.expectedAccountConfigId,
      ).exportManager.getTask(input.taskId);
      if (task?.status !== 'completed') throw new Error('导出结果尚未完成。');
      const path = task.bundleDir || task.filePath;
      if (!path) throw new Error('导出结果不存在。');
      const register = getHost().registerDownload;
      if (!register) return null;
      const name = exportDownloadName(task);
      return register(path, name, task.bundleDir ? 'directory' : 'file');
    }),

  /** Pause a running task. */
  pauseExportTask: procedure
    .input(z.object({ taskId: z.string().min(1) }))
    .mutation(({ input }) => {
      return requireServices().exportManager.pauseTask(input.taskId);
    }),

  /** Cancel a task. */
  revealExportReport: procedure
    .input(z.object({ taskId: z.string().min(1) }))
    .mutation(async ({ input }) => {
      const task = requireServices().exportManager.getTask(input.taskId);
      if (!task?.reportPath) throw new Error('完整性报告尚未生成。');
      await getHost().revealPath(task.reportPath);
      return true;
    }),

  resumeExportTask: procedure
    .input(z.object({ taskId: z.string().min(1) }))
    .mutation(({ input }) => requireServices().exportManager.resumeTask(input.taskId)),

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
      const manager = requireServices().exportManager;
      const handler = (progress: import('@weq/service').TaskProgress) => emit.next(progress);
      manager.on('progress', handler);
      return () => {
        manager.off('progress', handler);
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
        ...exportAccountBindingInput.shape,
        name: z.string().min(1),
        format: z.enum(['json', 'jsonl', 'txt', 'csv', 'xlsx', 'html']),
        /** 灯箱多选的导出格式（媒体只带一份；缺省 = [format]）。 */
        formats: z.array(z.enum(['json', 'jsonl', 'txt', 'csv', 'xlsx', 'html'])).optional(),
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
          completeMessages: z.boolean(),
          exportAvatar: z.boolean(),
          completeMedia: z.boolean(),
          downloadVideo: z.boolean(),
          downloadFile: z.boolean(),
          downloadPtt: z.boolean(),
          transcribeVoice: z.boolean(),
          dress: dressInput,
          mediaKinds: z
            .object({
              image: z.boolean(),
              voice: z.boolean(),
              video: z.boolean(),
              file: z.boolean(),
              sysface: z.boolean(),
            })
            .optional(),
          completeDress: z.boolean().optional(),
          autoSave: z.boolean().optional(),
          savePolicy: exportSavePolicyInput.optional(),
        }),
        enabled: z.boolean().default(true),
      }),
    )
    .mutation(({ input }) => {
      requireExpectedAccount(input.expectedAccountUin, input.expectedAccountConfigId);
      // Map renderer-facing `name` (template label) to the manager's ScheduleInput.
      // (ScheduleInput reuses `name` as the export filename stem; the renderer
      // sends the user-chosen label here too — keeping it as-is means a fresh
      // export per trigger produces `<label>.<fmt>`.)
      return requireScheduler().create({
        name: input.name,
        format: input.format,
        ...(input.formats ? { formats: input.formats } : {}),
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
          formats: z.array(z.enum(['json', 'jsonl', 'txt', 'csv', 'xlsx', 'html'])).optional(),
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
              completeMessages: z.boolean(),
              exportAvatar: z.boolean(),
              completeMedia: z.boolean(),
              downloadVideo: z.boolean(),
              downloadFile: z.boolean(),
              downloadPtt: z.boolean(),
              transcribeVoice: z.boolean(),
              dress: dressInput,
              mediaKinds: z
                .object({
                  image: z.boolean(),
                  voice: z.boolean(),
                  video: z.boolean(),
                  file: z.boolean(),
                  sysface: z.boolean(),
                })
                .optional(),
              completeDress: z.boolean().optional(),
              autoSave: z.boolean().optional(),
              savePolicy: exportSavePolicyInput.optional(),
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

  /** 兼容旧单文件另存，只接受已知任务的完整单文件结果。 */
  saveExportFile: procedure
    .input(
      exportAccountBindingInput.extend({
        sourcePath: z.string().min(1),
        defaultName: z.string().min(1),
        format: z.enum(['json', 'jsonl', 'txt', 'csv', 'xlsx', 'html']),
      }),
    )
    .mutation(async ({ input }) => {
      const services = requireExpectedAccount(
        input.expectedAccountUin,
        input.expectedAccountConfigId,
      );
      const task = services.exportManager
        .listTasks()
        .find((task) => task.filePath === input.sourcePath);
      if (!task || task.bundleDir) throw new Error('单文件导出结果不存在或需要保存完整资源包。');
      const extension =
        task.resource?.output?.extension || extname(input.sourcePath).slice(1) || task.format;
      const target = await getHost().pickSaveTarget({
        defaultName: exportOutputFileName({
          kind: 'file',
          name: input.defaultName.replace(/\.[^.]+$/, ''),
          extension,
        }),
        extension,
      });
      if (!target) return false;
      await saveCompletedExportTask(
        services.exportManager,
        task.id,
        getHost,
        { filePath: target.path },
        () => {
          if (
            requireExpectedAccount(input.expectedAccountUin, input.expectedAccountConfigId) !==
            services
          )
            throw new Error('账号数据源已切换，已取消保存。');
        },
      );
      return true;
    }),

  /**
   * 兼容旧整包另存：复用任务保存，不合并已有目录；取消或没有资源包时返回 false。
   */
  saveExportBundle: procedure
    .input(exportAccountBindingInput.extend({ taskId: z.string().min(1) }))
    .mutation(async ({ input }) => {
      const services = requireExpectedAccount(
        input.expectedAccountUin,
        input.expectedAccountConfigId,
      );
      const task = services.exportManager.getTask(input.taskId);
      if (!task?.bundleDir) return false;
      return Boolean(
        await saveCompletedExportTask(services.exportManager, task.id, getHost, {}, () => {
          if (
            requireExpectedAccount(input.expectedAccountUin, input.expectedAccountConfigId) !==
            services
          )
            throw new Error('账号数据源已切换，已取消保存。');
        }),
      );
    }),

  /**
   * 打开助手导出工具产出的结果（卡片「打开」）。单文件→系统默认程序；
   * bundle 目录→文件管理器。taskId 即 AssistantArtifact.id。
   */
  openAssistantExport: procedure
    .input(exportAccountBindingInput.extend({ taskId: z.string().min(1) }))
    .mutation(async ({ input }) => {
      const task = requireExpectedAccount(
        input.expectedAccountUin,
        input.expectedAccountConfigId,
      ).exportManager.getTask(input.taskId);
      const path = task?.bundleDir || task?.filePath;
      if (!path) throw new Error('导出结果不存在（可能已被清理）。');
      await getHost().revealPath(path);
      return true;
    }),

  /**
   * 兼容旧助手导出卡片的显式另存，文件／目录选择与保存回执共用统一管线。
   */
  saveAssistantExport: procedure
    .input(exportAccountBindingInput.extend({ taskId: z.string().min(1) }))
    .mutation(async ({ input }) => {
      const services = requireExpectedAccount(
        input.expectedAccountUin,
        input.expectedAccountConfigId,
      );
      return Boolean(
        await saveCompletedExportTask(services.exportManager, input.taskId, getHost, {}, () => {
          if (
            requireExpectedAccount(input.expectedAccountUin, input.expectedAccountConfigId) !==
            services
          )
            throw new Error('账号数据源已切换，已取消保存。');
        }),
      );
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
    .mutation(async ({ input }): Promise<TranscribeResult> => {
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
        // Only the TEXT goes back to the DB — `pttTranscript` (45923) is the
        // field QQ itself reads, so it must stay a plain string. Emotion and
        // events ride alongside in the response instead.
        await services.msgs
          .setPttTranscript(BigInt(input.msgId), input.name, text)
          .catch(() => false);
      }
      return {
        success: true,
        text,
        emotion: result.emotion ?? null,
        events: result.events ?? [],
      };
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

  /**
   * 当前账号的宽容（salvage）配置 + 降级账本。
   *
   * 账本按时间倒序取最新 50 条；只含 SQL 指纹，不含参数值。
   */
  getDbTolerance: procedure.query((): DbToleranceSnapshot => {
    const ctx = getAppContext();
    const tolerance = ctx.dbTolerance;
    if (!tolerance)
      return { level: 0, grantedAt: null, summary: EMPTY_SALVAGE_SUMMARY, entries: [] };
    const config = tolerance.getConfig();
    return {
      level: config.level,
      grantedAt: config.grantedAt ?? null,
      summary: tolerance.summary(),
      entries: [...tolerance.listEntries()].reverse().slice(0, 50),
    };
  }),

  /**
   * 授权/调整宽容级别（0 = 回到严格）。
   *
   * 只有用户的显式动作会调用它：没有自动降级，也不会因为某次查询失败就偷偷改级别。
   * 级别降回 0 时顺手释放 salvage 只读连接（严格连接不受影响）。
   */
  setDbToleranceLevel: procedure
    .input(z.object({ level: z.number().int().min(0).max(3), source: z.string().optional() }))
    .mutation(({ input }): { level: number; grantedAt: string | null; closedSalvage: number } => {
      const ctx = getAppContext();
      const tolerance = ctx.dbTolerance;
      if (!tolerance) throw new Error('未打开账号');
      const config = tolerance.setLevel(input.level, input.source ?? 'ipc');
      const closedSalvage = config.level === 0 ? closeSalvageConnections(ctx) : 0;
      return { level: config.level, grantedAt: config.grantedAt ?? null, closedSalvage };
    }),

  // 坏页扫描原本在这里（只能扫"当前打开的账号"）。它已经搬到 妙妙工具 → 数据库修复
  // 的 `client.dbRepair.scanBadPages`：那边对**任意账号**可用，而且与修复共用同一份
  // 实现（`@weq/service` 的 `bad_pages`），口径不会漂。设置页不再有扫描入口。

  /**
   * 当前进程内被 L3（整表放弃）隔离的表。
   *
   * 隔离是**进程内**的临时状态：条目有存活时间（默认 300 秒，到点自动失效重试），
   * 所以这里既不落盘也不参与“记住该账号”的设置。它存在的意义只有一个 ——
   * 让用户能看到“哪张表已经被放弃、为什么”，并且能手动让它再试一次。
   */
  listSalvageQuarantine: procedure.query((): QuarantinedTable[] => {
    const platform = getAppContext().platform;
    if (!platform) return [];
    try {
      return platform.native.ntHelper.listQuarantinedTables();
    } catch {
      // 原生侧不可用不应让设置页整个报错：隔离清单只是个只读的展示。
      return [];
    }
  }),

  /**
   * 把隔离记录清掉，让那些表**立刻**再试一次。
   *
   * 三个粒度与 native 一致：只给 `dbName` 清该库，再加 `table` 只清那一张，都不给全清。
   * `dbPath` 不接收渲染层传来的路径 —— 只能用于“当前确实被隔离的库”（路径由 native
   * 自己报回来，按文件名匹配），否则就变成了一个任意路径的写入接口。
   */
  clearSalvageQuarantine: procedure
    .input(z.object({ dbName: z.string().optional(), table: z.string().optional() }))
    .mutation(({ input }): { cleared: number; remaining: number } => {
      const platform = getAppContext().platform;
      if (!platform) return { cleared: 0, remaining: 0 };
      const helper = platform.native.ntHelper;
      let dbPath: string | undefined;
      if (input.dbName) {
        const entry = helper
          .listQuarantinedTables()
          .find((item) => basename(item.dbPath) === input.dbName);
        if (!entry) throw new Error(`${input.dbName} 当前没有被隔离的表`);
        dbPath = entry.dbPath;
      }
      const cleared = helper.clearQuarantinedTables(dbPath, input.table);
      return { cleared, remaining: helper.listQuarantinedTables().length };
    }),
});

// ── 数据库宽容（salvage）：IPC 边界的形状与辅助 ────────────────────────

/** 降级账本汇总。四种结局各自计数、**不合并** —— 它们在报告里的说法完全不同。 */
export interface SalvageSummary {
  total: number;
  /** 换了访问路径后拿到结果（**不丢数据**）。 */
  indexRetreat: number;
  /** 损坏且替代路径也救不回来（本次读取没有结果）。 */
  unrecoverable: number;
  /**
   * 分块扫描里跳过了若干区间：**拿到了结果但少了数据**。
   *
   * 这是唯一“看起来成功了、实际丢了东西”的一类，所以它必须独立计数，
   * 不能归到“救不回来”里 —— 后者用户至少知道要重试。
   */
  skipped: number;
  /** 该表已被 L3 整表放弃，本次压根没读。 */
  quarantined: number;
  databases: string[];
  lastAt: string | null;
}

/** 设置页 / 弹窗需要的全部宽容状态。 */
export interface DbToleranceSnapshot {
  level: number;
  grantedAt: string | null;
  summary: SalvageSummary;
  /** 最新 50 条账目（新→旧）。 */
  entries: SalvageLedgerEntry[];
}

export const EMPTY_SALVAGE_SUMMARY: SalvageSummary = {
  total: 0,
  indexRetreat: 0,
  unrecoverable: 0,
  skipped: 0,
  quarantined: 0,
  databases: [],
  lastAt: null,
};
