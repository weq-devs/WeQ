/**
 * MessageSendService —— 往群聊 / 私聊**发消息**（MessageSvc.PbSendMsg + 媒体上传）。
 *
 * 与 FlashTransferService / PeerStatsService 同构：nt 绑定与在线 pid 在账号
 * bootstrap 时注入，这里只负责把「业务参数」翻译成协议参数。QQ 离线、原生失败
 * 原样上抛，由调用方（MCP 工具 / IPC）转成用户提示。
 *
 * 三层能力，粒度从粗到细：
 *   - {@link sendText}     文本（可带 @ 与引用回复）；
 *   - {@link sendMedia}    图片 / 语音 / 视频（先上传 NTV2，见 @weq/protocol 的 highway）；
 *   - {@link sendElements} 逃生舱：直接给元素数组（表情 / 商城表情 / markdown / xml /
 *                          ark 卡片 / 合并转发 / 窗口抖动 / raw …）。
 *
 * 目标 `targetId` 的三种写法都收：
 *   - 群聊：群号；
 *   - 私聊：**QQ 号**（走本地 uid 目录补 uid）或 **uid**（反查 QQ 号）。
 *
 * 私聊的 uid 解析有两档宽松度：
 *   - 纯文本消息**不强制**要 uid（routingHead.c2c 只给 uin 也能发出去）——
 *     没聊过天的陌生人也能发第一条；
 *   - 媒体消息**必须**有 uid（NTV2 上传与 PbSendMsg 都按 uid 认人，SnowLuma 同），
 *     本地目录里查不到就如实报错并给出拿 uid 的办法，而不是发一条发不出去的消息。
 */
import type { AccountSession } from '@weq/account';
import type { NtHelperBinding } from '@weq/native';
import {
  sendContactArk,
  sendForward as protocolSendForward,
  sendGroupFile,
  sendMessage,
  sendPrivateFile,
  SendAiVoice,
  SendLocationArk,
  type ContactArkKind,
  type MediaSource,
  type PttWaveformSource,
  type SendDress,
  type SendElement,
  type SendForwardParams as ProtocolSendForwardParams,
  type SendMediaUploadReport,
  type SendMessageReceipt,
  type SendScene,
} from '@weq/protocol';
import { getLogger } from '../common/logger';

const logger = getLogger().child({ scope: 'message-send' });

/**
 * 转发 @weq/protocol 的元素相关类型：调用方（MCP 工具 / IPC）只依赖 @weq/service，
 * 不必自己加一条对 @weq/protocol 的依赖（与 media_url.ts 转发 GroupFileDownload 同）。
 */
export type {
  MediaSource,
  PttWaveformSource,
  SendDress,
  SendElement,
  SendMediaUploadReport,
  SendScene,
} from '@weq/protocol';

/** 发送目标类型。 */
export type SendPeerType = 'c2c' | 'group';

/** 目标解析结果（`uid` 可能为空：纯文本私聊不强制）。 */
export interface ResolvedSendTarget {
  peerType: SendPeerType;
  scene: SendScene;
  /** 群号 / 私聊对端 QQ 号（数字）。 */
  uin: number;
  /** 私聊对端 uid；本地目录查不到时为 ''。 */
  uid: string;
  /** 回显用：调用方给的原值。 */
  targetId: string;
}

export interface SendTextParams {
  peerType: SendPeerType;
  /** 群号 / QQ 号 / uid（字符串或数字）。 */
  targetId: string | number;
  text: string;
  /**
   * 随这条消息一起带出的装扮（气泡 / 字体 / 挂件）。缺省不带。
   *
   * ⚠️ 真机实测过：服务端不采信客户端自报的装扮（result=0 但落库装扮全 0），
   * 传了也不会改变收端看到的装扮。见 @weq/protocol 的 SendDress。
   */
  dress?: SendDress;
  /** @ 谁：QQ 号或 uid；命中不了会如实报错（不会假装 @ 上了）。 */
  at?: (string | number)[];
  /** 引用回复：被引用消息的群内/会话内 seq（`msgSeq`）。 */
  replyToMsgSeq?: number;
  /** 引用回复的对端 QQ 号（可选，带上更稳）。 */
  replyToSenderUin?: number;
  /** 被引用消息的时间（Unix 秒，可选）。 */
  replyToMsgTime?: number;
}

export interface SendWindowShakeParams {
  /** 私聊对端：QQ 号或 uid（窗口抖动不支持群聊 / 群临时会话）。 */
  targetId: string | number;
}

/**
 * AI 声聊（TTS）发送参数。
 *
 * ⚠️ `0x929b_0` **本身就是一次发送** —— 服务端按 `text` + `voiceId` 合成语音后直接
 * 落到 `groupId` 那个群里，不需要我们再拼一条 ptt 元素手动发一遍（见
 * `@weq/protocol` 的 `SendAiVoice` 与 docs/develop/ai-voice.md）。所以这里只收
 * 「群号 / 声线 / 文字」，没有第二步。
 */
export interface SendAiVoiceParams {
  /** 目标**群号**（AI 声聊只支持群聊；私聊会把 uin 当群号查不到）。 */
  groupId: string | number;
  /** 声线 id（目录里的 `lucy-voice-*`；服务端按 id 查声线，不存在则报错）。 */
  voiceId: string;
  /** 要合成的文字。 */
  text: string;
}

/** AI 声聊发送结果（JSON 安全）。合成即发送，所以回执就是这次发送的结果。 */
export interface SendAiVoiceOutcome {
  ok: boolean;
  groupId: string;
  voiceId: string;
  text: string;
  /** 内层返回码（实测成功恒为 1）。 */
  retCode: number;
  /** 合成音频的文件 md5（32 位 hex）；服务端拒绝时不出现。 */
  fileHash?: string;
  /** 合成音频的文件名（实测形如 `<md5>.amr`）。 */
  fileName?: string;
  /** 合成音频字节数。 */
  fileSize?: number;
  hint?: string;
}

/**
 * 窗口抖动的 `POKE_EXTRA.type`。真机抓包与 SnowLuma / Napcat 一致，恒为 1。
 */
const WINDOW_SHAKE_SUB_TYPE = 1;

export interface SendMediaParams {
  peerType: SendPeerType;
  targetId: string | number;
  kind: 'image' | 'record' | 'video';
  /** 随这条消息一起带出的装扮；⚠️ 服务端不收，见 SendDress。缺省不带。 */
  dress?: SendDress;
  /** 图片/视频：本地路径或字节；语音：SILK 字节或路径。 */
  source: MediaSource;
  /** 图片：0 普通 / 1 动画表情。 */
  subType?: number;
  /** 图片：收端摘要（缺省 [图片] / [动画表情]）。 */
  summary?: string;
  /** 图片/视频：像素尺寸（缺省按文件探测；视频群聊必须给，否则安卓端显示「文件已过期」）。 */
  width?: number;
  height?: number;
  /** 图片：NTV2 picFormat（缺省按文件头探测）。 */
  picFormat?: number;
  /** 语音：时长（秒）——收端气泡宽度与时长文案靠它，写 0 会显示 00:00。 */
  durationSec?: number;
  /** 语音：波形来源（给原始 WAV 就出真条，不给则由协议层合成一条）。 */
  waveform?: PttWaveformSource;
  /** 视频：封面（不给则按 width/height 合成一张纯色 PNG）。 */
  thumb?: MediaSource;
  /** 收端显示的文件名（图片/视频；缺省按 md5 + 扩展名）。 */
  fileName?: string;
}

export interface SendElementsParams {
  peerType: SendPeerType;
  targetId: string | number;
  /** 至少一个元素；媒体元素会自动走上传（需 uid）。 */
  elements: SendElement[];
  /** 随这条消息一起带出的装扮；⚠️ 服务端不收，见 SendDress。缺省不带。 */
  dress?: SendDress;
}

// ───────────────────────────── Ark 卡片 ─────────────────────────────
//
// 三条通路，落点不同，返回值也不同，别混用：
//   - {@link MessageSendService.sendArkCard}     任意 ark JSON → lightApp 元素（PbSendMsg）；
//   - {@link MessageSendService.sendContactCard} 推荐好友 / 推荐群 → 先取卡再发元素；
//   - {@link MessageSendService.sendLocationCard} 位置卡片 → trpc LocationArk.SsoSendMessage。

/** 任意 ark 卡片（`{ kind:'ark', arkData }` 元素）的发送参数。 */
export interface SendArkCardParams {
  peerType: SendPeerType;
  /** 群号 / QQ 号（或 uid）。 */
  targetId: string | number;
  /** 一段 ark JSON；原样编成 lightApp 元素下发。非空且必须是能 parse 的 JSON。 */
  arkData: string;
}

/** 推荐好友 / 推荐群的发送参数。 */
export interface SendContactCardParams {
  /** 卡片发到哪。 */
  peerType: SendPeerType;
  /** 发送目标：群号 / 对方 QQ 号。 */
  targetId: string | number;
  /** 卡片推荐什么：`'qq'` = 好友，`'group'` = 群。 */
  kind: ContactArkKind;
  /** 被推荐的好友 QQ 号 / 群号（**不是**发送目标）。 */
  contactId: number;
  /** 推荐好友时的手机号；缺省由协议层写占位 `'-'`。 */
  phoneNumber?: string;
}

/** 推荐卡片的发送结果（JSON 安全）。 */
export interface SendContactCardOutcome {
  ok: boolean;
  peerType: SendPeerType;
  targetId: string;
  scene: SendScene;
  kind: ContactArkKind;
  /** 被推荐的好友 QQ 号 / 群号（回显）。 */
  contactId: number;
  /** 服务端生成的卡片 JSON —— 发出去的就是这一份。 */
  arkJson: string;
  /** 服务端 result（0 = 接受）。 */
  result: number;
  errMsg: string;
  /**
   * 这条消息的客户端 `random`（发送请求里那个字段，服务端原样回显）。
   *
   * 这是给前端的乐观卡片对账用的**主键**：它发送前就已知、回执里带回、写进本地库
   * 的 40002、并被服务端历史 / 漫游原样保留。别用 msgId（雪花 id，服务端才分配）
   * 或 seq（会话内序号，私聊本地库与服务端漫游还是两套编号）。
   */
  random: number;
  /** 群内 seq（群聊回执）。仅作辅助判据；对账请用 {@link random}。 */
  groupSequence: number;
  /** 会话级 seq（私聊回执）。仅作辅助判据；对账请用 {@link random}。 */
  privateSequence: number;
  /** 服务端时间戳（秒）。 */
  timestamp: number;
  hint?: string;
}

/** 位置卡片的发送参数。 */
export interface SendLocationCardParams {
  peerType: SendPeerType;
  targetId: string | number;
  /** 详细地址（街道）—— 卡片正文里那行小字。 */
  address: string;
  /** 地址第一行（省市区）。 */
  region: string;
  /** 纬度，十进制度字符串（如 `'31.763573'`）。 */
  latitude: string;
  /** 经度，十进制度字符串（如 `'104.736101'`）。 */
  longitude: string;
}

/**
 * 位置卡片的发送结果。
 *
 * ⚠️ 该协议的**响应格式还没抓到样本**（见 `@weq/protocol` 的 send-location-ark），
 * 所以这里只能如实报告「请求已发出 + 回包多少字节」，**不能**断言业务成功。
 * `ok` 的含义是「没有传输层异常」，不是「对方收到了卡片」。
 */
export interface SendLocationCardOutcome {
  ok: boolean;
  peerType: SendPeerType;
  targetId: string;
  scene: SendScene;
  address: string;
  region: string;
  latitude: string;
  longitude: string;
  /** 服务端回包字节数（解析不出业务结果，只用于排查）。 */
  responseBytes: number;
  hint: string;
}

/**
 * 合并转发里的一条子消息（节点）。
 *
 * 元素写法与 `send_rich_message` 完全一样（`@weq/protocol` 的 `SendElement`），
 * 所以「把收到的消息原样再转发」可以把解码出来的元素直接塞进来。
 */
export interface SendForwardNodeInput {
  /** 发送者 QQ 号；缺省自己。 */
  userUin?: number;
  /** 发送者昵称；缺省 QQ 号。 */
  nickname?: string;
  elements: SendElement[];
  /** 显示时间（Unix 秒）；缺省当前时间。 */
  time?: number;
  /**
   * 该节点自己的装扮（气泡 / 字体 / 挂件），可选。
   *
   * 字体两个 wire 槽位都能给：`fontId` 与 `fontId2` 都传**真实 itemId**，
   * 协议层自动换算（tag 56 原样 / tag 15 字节交换）。
   */
  dress?: SendDress;
  /** 该节点本身是一段嵌套转发。 */
  innerForward?: SendForwardNodeInput[];
}

/** 发「合并转发 / 聊天记录」的参数。 */
export interface SendForwardMessageParams {
  peerType: SendPeerType;
  /** 群号（群聊）或 QQ 号 / uid（私聊）。 */
  targetId: string | number;
  /** 转发内容（至少一个节点）。 */
  nodes: SendForwardNodeInput[];
}

/** 发合并转发的回执（两步：先上传内容拿 resId，再发卡片）。 */
export interface SendForwardOutcome {
  ok: boolean;
  peerType: SendPeerType;
  targetId: string;
  uid?: string;
  scene: SendScene;
  /** 服务端签发的长消息 id（卡片里的 `resid`）。 */
  resId: string;
  /** 嵌套层数（1 = 只有最外层）。 */
  levels: number;
  /** 发卡片那一步的回执（`MessageSvc.PbSendMsg`）。 */
  card: SendMessageOutcome;
  hint?: string;
}

/**
 * 文件发送参数（群文件 / 私聊文件）。
 *
 * 与图片/语音/视频不同，文件走的是**另一条管线**（老 OIDB + highway 裸帧）：
 * 群文件申请 0x6D6_0 → highway 71 → 发布 0x6D9_4；私聊文件申请 0xE37_1700 →
 * highway 95 → finalize 0xE37_800 → PbSendMsg（`trans0x211` 路由）。所以它不是
 * `sendMedia` 的一个 kind，而是独立入口，也不需要 `source` 的字节形式（一律按路径流式读）。
 */
export interface SendFileParams {
  peerType: SendPeerType;
  targetId: string | number;
  /** 本机文件路径（群/私聊文件都按路径流式上传，进内存的都是分块）。 */
  path: string;
  /** 收端显示的文件名；缺省取路径 basename。 */
  fileName?: string;
  /** 群文件目录；缺省 `/`（私聊忽略）。 */
  folderId?: string;
}

/** 文件发送结果（JSON 安全）。 */
export interface SendFileOutcome {
  ok: boolean;
  peerType: SendPeerType;
  targetId: string;
  uid?: string;
  scene: SendScene;
  kind: 'file';
  /** 服务端文件 id（群文件 `fileId` / 私聊 `uuid`）。 */
  fileId: string;
  /** 私聊文件的 `fileAddon`（下载路由要用）。 */
  fileHash?: string;
  fileName: string;
  fileSize: number;
  md5Hex: string;
  /** 服务端已按 md5 持有该文件——**秒传**，一个字节都没传。 */
  fastUpload: boolean;
  /** 是否真的发出去了：群聊看是否发布成气泡，私聊看 PbSendMsg 回执。 */
  sent: boolean;
  /** 私聊：`0xE37_800` finalize 是否成功（失败只是少 field6，不影响下载）。 */
  finalized?: boolean;
  /** 私聊回执：服务端 result（0 = 接受）。 */
  result?: number;
  errMsg?: string;
  /** 客户端 `random`；私聊文件也是同一条 `PbSendMsg` 回执。 */
  random?: number;
  privateSequence?: number;
  timestamp?: number;
  hint?: string;
}
/** 归一化后的发送结果（JSON 安全：全部是 number / string / boolean）。 */
export interface SendMessageOutcome {
  ok: boolean;
  peerType: SendPeerType;
  /** 回显目标（群号 / QQ 号，私聊的 uid 单独给）。 */
  targetId: string;
  uid?: string;
  scene: SendScene;
  result: number;
  errMsg: string;
  /**
   * 这条消息的客户端 `random`（发送请求里的字段，服务端回显、也写进本地库 40002）。
   *
   * 前端用它给乐观消息对账 —— 这是唯一「发送前已知 + 回执带回 + 库里同名 + 服务端
   * 历史原样保留」的标识。msgId 是服务端雪花 id（对不上），seq 私聊本地库与漫游还是
   * 两套编号，都不能当对账键。
   */
  random: number;
  /** 群内 seq（群聊）。仅作辅助判据；对账请用 {@link random}。 */
  groupSequence: number;
  /** 会话级 seq（私聊）。仅作辅助判据；对账请用 {@link random}。 */
  privateSequence: number;
  timestamp: number;
  /**
   * 媒体消息：每个媒体元素的上传结果（非媒体消息不出现）。
   *
   * `fastUpload: true` = 服务端已按 md5 持有该资源，走的是**秒传**（一个字节都没传）。
   * 排查「发出去但收端说已过期」时先看这里：没有秒传却仍过期，就是上传本身的问题。
   */
  uploads?: SendMediaUploadReport[];
  /** 人读提示：失败原因 / 成功备注。 */
  hint?: string;
}

/** 需要上传的元素类型（媒体消息必须带 uid）。 */
function elementsNeedUpload(elements: readonly SendElement[]): boolean {
  return elements.some((e) => e.kind === 'image' || e.kind === 'record' || e.kind === 'video');
}

export class MessageSendService {
  constructor(
    private readonly nt: Pick<NtHelperBinding, 'sendPacket' | 'sendOidbPacket'>,
    private readonly session: AccountSession,
    private readonly resolvePid: () => number,
  ) {}

  /** 自己账号的 uin（highway 帧头与路由都用它）。 */
  private selfUin(): string {
    const uin = this.session.context.uin;
    const text = uin === undefined || uin === null ? '' : String(uin);
    if (text === '' || text === '0') throw new Error('当前会话拿不到自己的 QQ 号，无法发消息。');
    return text;
  }

  /**
   * 解析目标。群聊要纯数字群号；私聊收 QQ 号或 uid（非纯数字按 uid 处理）。
   * `requireUid` 为 true 时（媒体消息）查不到 uid 直接报错。
   */
  resolveTarget(
    input: string | number,
    peerType: SendPeerType,
    requireUid: boolean,
  ): ResolvedSendTarget {
    const text = String(input).trim();
    if (!text) throw new Error('目标不能为空。');

    if (peerType === 'group') {
      if (!/^\d+$/.test(text)) throw new Error(`群聊目标是群号（纯数字），收到「${text}」。`);
      const group = Number(text);
      if (!Number.isSafeInteger(group) || group <= 0) throw new Error(`群号不合法：${text}`);
      return { peerType, scene: 'group', uin: group, uid: '', targetId: text };
    }

    // 私聊：非纯数字 = uid
    if (!/^\d+$/.test(text)) {
      const uin = this.session.uidMap.uinByUid(text);
      if (!uin) {
        throw new Error(
          `本地 uid 目录里没有 uid「${text}」。可以用 find_contact / search_buddies 拿准确 uid，或直接传 QQ 号。`,
        );
      }
      return { peerType, scene: 'c2c', uin: Number(uin), uid: text, targetId: String(uin) };
    }

    const uin = Number(text);
    if (!Number.isSafeInteger(uin) || uin <= 0) throw new Error(`QQ 号不合法：${text}`);
    const uid = this.session.uidMap.uidByUin(BigInt(uin)) ?? '';
    if (!uid && requireUid) {
      throw new Error(
        `本地 uid 目录里没有 QQ ${text} 的 uid。媒体消息必须带 uid（服务端只认 uid）：` +
          '先和 TA 有过一次会话（uid 会进 nt_uid_mapping_table），或用 find_contact 拿到 uid 后直接传 uid。',
      );
    }
    return { peerType, scene: 'c2c', uin, uid, targetId: text };
  }

  /** 文本消息（可带 @ / 引用回复）。 */
  async sendText(params: SendTextParams): Promise<SendMessageOutcome> {
    const text = params.text ?? '';
    if (!text.trim()) throw new Error('消息文本不能为空。');
    return this.sendElements({
      peerType: params.peerType,
      targetId: params.targetId,
      elements: buildTextElements(params),
      ...(params.dress ? { dress: params.dress } : {}),
    });
  }

  /**
   * 窗口抖动（私聊消息里的 `commonElem serviceType=2`）。
   *
   * 与「戳一戳」（OIDB 0xED3_1，见 InteractionService）不是一回事：这条是
   * `MessageSvc.PbSendMsg` 里的一条**私聊消息**，服务端只接受私聊场景，且这个元素
   * 必须独占一条消息 —— 所以这里把 peerType 固定成 c2c、元素固定成单枚 poke，
   * 调用方不可能拼出「群聊抖动」或「抖动 + 正文」这种必被服务端拒绝的组合。
   */
  async sendWindowShake(params: SendWindowShakeParams): Promise<SendMessageOutcome> {
    return this.sendElements({
      peerType: 'c2c',
      targetId: params.targetId,
      elements: [{ kind: 'poke', subType: WINDOW_SHAKE_SUB_TYPE }],
    });
  }

  /**
   * AI 声聊（TTS）：`0x929b_0` 把「文字 + 声线」交给服务端合成，**合成即发送**到群里，
   * 不需要第二步（见 {@link SendAiVoiceParams}）。只支持群聊。
   *
   * 服务端拒绝（声线不存在 / 文字不合规等）由 OIDB 直接抛错，这里原样上抛；成功时如实
   * 给出合成音频的文件信息，便于日后再排查「发出去了但收端说没声音」。
   */
  async sendAiVoice(params: SendAiVoiceParams): Promise<SendAiVoiceOutcome> {
    const groupText = String(params.groupId).trim();
    if (!/^\d+$/.test(groupText)) {
      throw new Error(`AI 声聊只支持群聊，目标是群号（纯数字），收到「${groupText}」。`);
    }
    const groupCode = Number(groupText);
    if (!Number.isSafeInteger(groupCode) || groupCode <= 0) {
      throw new Error(`群号不合法：${groupText}`);
    }
    const voiceId = params.voiceId?.trim() ?? '';
    if (!voiceId) throw new Error('AI 声聊的声线 id 不能为空。');
    const text = params.text ?? '';
    if (!text.trim()) throw new Error('AI 声聊的合成文字不能为空。');

    const pid = this.resolvePid();
    const result = await SendAiVoice.invoke(this.nt, pid, { groupCode, voiceId, text });
    const info = result.audio?.node?.fileInfo;
    const ok = SendAiVoice.isOk(result);
    logger.info(ok ? `AI 声聊已合成并发送: ${voiceId}` : `AI 声聊返回 retCode=${result.retCode}`, {
      event: 'send-ai-voice',
      groupId: groupText,
      voiceId,
      retCode: result.retCode,
      fileHash: info?.fileHash,
    });
    return {
      ok,
      groupId: groupText,
      voiceId,
      text,
      retCode: result.retCode,
      ...(info
        ? { fileHash: info.fileHash, fileName: info.fileName, fileSize: info.fileSize }
        : {}),
      ...(ok
        ? {}
        : { hint: `服务端返回 retCode=${result.retCode}（成功应为 1），语音可能没有发出去。` }),
    };
  }

  /** 图片 / 语音 / 视频（自动上传 NTV2）。 */
  async sendMedia(params: SendMediaParams): Promise<SendMessageOutcome> {
    const element = buildMediaElement(params);
    return this.sendElements({
      peerType: params.peerType,
      targetId: params.targetId,
      elements: [element],
      ...(params.dress ? { dress: params.dress } : {}),
    });
  }

  /**
   * 文件（群文件 / 私聊文件）。
   *
   * 私聊文件必须能解析出 uid（路由与 FileExtra 都要），拿不到就如实报错 ——
   * 与媒体消息同一套理由。
   */
  async sendFile(params: SendFileParams): Promise<SendFileOutcome> {
    const filePath = params.path?.trim();
    if (!filePath) throw new Error('文件路径不能为空。');
    const target = this.resolveTarget(params.targetId, params.peerType, params.peerType === 'c2c');
    const pid = this.resolvePid();
    const selfUin = this.selfUin();
    const log = (message: string): void => logger.info(message, { event: 'file-upload' });
    const fileName = params.fileName?.trim();

    if (target.scene === 'group') {
      const result = await sendGroupFile(this.nt, pid, {
        groupId: target.uin,
        filePath,
        selfUin,
        ...(fileName ? { fileName } : {}),
        ...(params.folderId?.trim() ? { folderId: params.folderId } : {}),
        log,
      });
      logger.info(
        result.fastUpload
          ? `群文件秒传命中（服务端已有同 md5 资源，未上传字节）: ${result.fileName}`
          : `群文件已上传并发布: ${result.fileName}`,
        {
          event: 'file-upload-summary',
          scene: 'group',
          md5: result.md5Hex,
          fileSize: result.fileSize,
          fastUpload: result.fastUpload,
        },
      );
      return {
        ok: result.published,
        peerType: target.peerType,
        targetId: target.targetId,
        scene: 'group',
        kind: 'file',
        fileId: result.fileId,
        fileName: result.fileName,
        fileSize: result.fileSize,
        md5Hex: result.md5Hex,
        fastUpload: result.fastUpload,
        sent: result.published,
        hint: result.published
          ? `已上传到群文件并发布（fileId=${result.fileId}）`
          : `已上传到群文件但未发布（fileId=${result.fileId}）`,
      };
    }

    if (!target.uid) {
      throw new Error(
        `本地 uid 目录里没有 QQ ${target.targetId} 的 uid。私聊文件必须带 uid` +
          '（路由与 FileExtra 都按 uid 认人）：先和 TA 有过一次会话，或用 find_contact 拿 uid 后直接传 uid。',
      );
    }
    const selfUid = this.session.uidMap.uidByUin(BigInt(selfUin)) ?? '';
    if (!selfUid) {
      throw new Error('本地 uid 目录里没有自己的 uid，无法发私聊文件（重新登录一次通常就好了）。');
    }

    const result = await sendPrivateFile(this.nt, pid, {
      userUid: target.uid,
      selfUid,
      filePath,
      selfUin,
      ...(fileName ? { fileName } : {}),
      log,
    });
    logger.info(
      result.fastUpload
        ? `私聊文件秒传命中（未上传字节）: ${result.fileName}`
        : `私聊文件已上传: ${result.fileName}`,
      {
        event: 'file-upload-summary',
        scene: 'c2c',
        md5: result.md5Hex,
        fileSize: result.fileSize,
        fastUpload: result.fastUpload,
        finalized: result.finalized,
      },
    );

    const receipt = result.receipt;
    return {
      ok: result.sent,
      peerType: target.peerType,
      targetId: target.targetId,
      uid: target.uid,
      scene: 'c2c',
      kind: 'file',
      fileId: result.fileId,
      fileHash: result.fileHash,
      fileName: result.fileName,
      fileSize: result.fileSize,
      md5Hex: result.md5Hex,
      fastUpload: result.fastUpload,
      sent: result.sent,
      finalized: result.finalized,
      ...(receipt
        ? {
            result: receipt.result,
            errMsg: receipt.errMsg,
            random: receipt.random,
            privateSequence: receipt.privateSequence,
            timestamp: receipt.timestamp,
          }
        : {}),
      ...(result.finalized
        ? {}
        : { hint: 'finalize（0xE37_800）失败，已按不带 field6 的版本发出；文件本身仍可下载。' }),
    };
  }

  /**
   * 元素数组直发（逃生舱）。
   *
   * 含媒体元素时要求能解析出 uid（`resolveTarget(..., true)`），上传上下文由本服务
   * 组装（nt / pid / 自己 uin），调用方不用管。
   */
  async sendElements(params: SendElementsParams): Promise<SendMessageOutcome> {
    if (!Array.isArray(params.elements) || params.elements.length === 0) {
      throw new Error('消息至少需要一个元素。');
    }
    const needUpload = elementsNeedUpload(params.elements);
    const target = this.resolveTarget(params.targetId, params.peerType, needUpload);
    const pid = this.resolvePid();

    const uploads: SendMediaUploadReport[] = [];
    const receipt = await sendMessage(this.nt, pid, {
      ...(target.scene === 'group' ? { groupId: target.uin } : { userUin: target.uin }),
      // 纯文本私聊允许没有 uid（陌生人第一句）；有就带上（新版客户端以 uid 为准）。
      ...(target.scene === 'c2c' && target.uid ? { userUid: target.uid } : {}),
      elements: params.elements,
      // 装扮（气泡 / 字体 / 挂件）：不传就不写，请求字节与以前逐字节一致。
      ...(params.dress ? { dress: params.dress } : {}),
      ...(needUpload
        ? {
            media: {
              nt: this.nt,
              pid,
              uin: this.selfUin(),
              // 上传链路（会话节点 / 每块 highway 回帧）写进账号日志：真机排查
              // 「上传成功但收端说过期」时，这是唯一能看到服务端态度的地方。
              log: (message: string) => logger.info(message, { event: 'media-upload' }),
            },
          }
        : {}),
      // 秒传命中在服务层也记一笔：下次再做同类排查，日志里能直接看出「有没有传字节」。
      ...(needUpload
        ? {
            onUpload: (report: SendMediaUploadReport) => {
              uploads.push(report);
              logger.info(
                report.fastUpload
                  ? `媒体秒传命中（服务端已有同 md5 资源，未上传字节）: ${report.fileName}`
                  : `媒体已上传: ${report.fileName}`,
                {
                  event: 'media-upload-summary',
                  kind: report.kind,
                  md5: report.md5Hex,
                  fileSize: report.fileSize,
                  fastUpload: report.fastUpload,
                },
              );
            },
          }
        : {}),
    });

    const outcome = toOutcome(receipt, target, uploads);
    if (!outcome.ok) {
      logger.warn('send message rejected', {
        event: 'send-message-rejected',
        peerType: target.peerType,
        targetId: target.targetId,
        result: outcome.result,
        errMsg: outcome.errMsg,
        scene: outcome.scene,
      });
    }
    return outcome;
  }

  /**
   * 发一张**任意 ark 卡片**：把一段 ark JSON 编成 `lightApp` 元素（`{kind:'ark'}`）
   * 走常规 `MessageSvc.PbSendMsg`。
   *
   * 与 {@link sendLocationCard} / 图文卡片（0xdc2_34）不同，这条路不依赖任何
   * 平台规则（没有 appId 白名单），所以 PC / Linux 端也能正常下发 —— 「推荐好友」
   * 这类服务端生成的卡与自定义卡片都用它。
   */
  async sendArkCard(params: SendArkCardParams): Promise<SendMessageOutcome> {
    return this.sendElements({
      peerType: params.peerType,
      targetId: params.targetId,
      elements: [{ kind: 'ark', arkData: requireArkJson(params.arkData) }],
    });
  }

  /**
   * 发「推荐好友 / 推荐群」卡片（两步：0x12b6_0 / 0x8b7_5 取卡 → 发元素）。
   *
   * `targetId` 是**发到哪**（当前会话），`contactId` 是**推荐谁**，别填反。
   * 取到空卡会抛错（服务端没给出卡片时不发一张空白卡）；发送被服务端拒绝不抛，
   * 如实放进 `result` / `errMsg`，调用方必须检查 `ok`。
   */
  async sendContactCard(params: SendContactCardParams): Promise<SendContactCardOutcome> {
    const target = this.resolveTarget(params.targetId, params.peerType, false);
    const pid = this.resolvePid();
    const phoneNumber = params.phoneNumber?.trim();
    const result = await sendContactArk(this.nt, pid, {
      peerType: target.peerType,
      targetId: target.uin,
      kind: params.kind,
      contactId: params.contactId,
      ...(phoneNumber ? { phoneNumber } : {}),
      ...(target.scene === 'c2c' && target.uid ? { userUid: target.uid } : {}),
    });
    const receipt = result.receipt;
    return {
      ok: receipt.ok,
      peerType: target.peerType,
      targetId: target.targetId,
      scene: target.scene,
      kind: result.kind,
      contactId: result.contactId,
      arkJson: result.arkJson,
      result: receipt.result,
      errMsg: receipt.errMsg,
      random: receipt.random,
      groupSequence: receipt.groupSequence,
      privateSequence: receipt.privateSequence,
      timestamp: receipt.timestamp,
      ...(receipt.ok
        ? {}
        : {
            hint:
              `服务端拒绝了下发（result=${receipt.result}）${receipt.errMsg ? `：${receipt.errMsg}` : '。'}` +
              '推荐卡片是 lightApp 元素，正常不该被拒；先确认被推荐的好友 / 群对当前账号可见。',
          }),
    };
  }

  /**
   * 发一张**位置卡片**（trpc `qq_lbs_ark.LocationArk.SsoSendMessage`）。
   *
   * 私聊 / 群聊同一条命令字，靠 `peerType` 区分（0 = 私聊，1 = 群聊）。经纬度是
   * **十进制度字符串**，与卡片上给用户看的地址是两套东西：地址 / 省市区由调用方
   * 提供（前端可让用户自己写了改），这里只做非空与范围校验。
   */
  async sendLocationCard(params: SendLocationCardParams): Promise<SendLocationCardOutcome> {
    const address = params.address?.trim() ?? '';
    const region = params.region?.trim() ?? '';
    if (!address) throw new Error('位置卡片的详细地址不能为空。');
    if (!region) throw new Error('位置卡片的省市区不能为空。');
    const latitude = decimalCoordinate(params.latitude, 'latitude', 90);
    const longitude = decimalCoordinate(params.longitude, 'longitude', 180);

    const target = this.resolveTarget(params.targetId, params.peerType, false);
    const pid = this.resolvePid();
    const reply = await SendLocationArk.invoke(this.nt, pid, {
      targetUin: target.uin,
      peerType: target.scene === 'group' ? 1 : 0,
      address,
      region,
      latitude,
      longitude,
    });
    logger.info('location ark request sent', {
      event: 'send-location-ark',
      scene: target.scene,
      targetId: target.targetId,
      responseBytes: reply.byteLength,
    });
    return {
      ok: true,
      peerType: target.peerType,
      targetId: target.targetId,
      scene: target.scene,
      address,
      region,
      latitude,
      longitude,
      responseBytes: reply.byteLength,
      hint:
        '位置卡片请求已发出。该协议的响应格式还没抓到样本，无法从回包确认业务结果 —— ' +
        '请以对方会话里是否出现位置卡片为准。',
    };
  }

  /**
   * 发「合并转发 / 聊天记录」—— 两步：
   *
   *   1. `SsoSendLongMsg` 上传内容拿到 `resId`（节点含媒体时顺带做 NTV2 上传）；
   *   2. 发一张 `{ kind: 'forward', resId }` 卡片（走常规 PbSendMsg）。
   *
   * 目标是私聊时，`resId` 的 uid 槽位用**自己**的 uid；节点里含图片 / 语音 / 视频
   * 还需要对方的 uid（上传场景），本地目录查不到就如实报错。
   */
  async sendForward(params: SendForwardMessageParams): Promise<SendForwardOutcome> {
    if (!Array.isArray(params.nodes) || params.nodes.length === 0) {
      throw new Error('合并转发至少需要一个节点（nodes 不能为空）。');
    }
    const needUpload = nodesNeedUpload(params.nodes);
    const target = this.resolveTarget(params.targetId, params.peerType, needUpload);
    const pid = this.resolvePid();
    const selfUin = this.selfUin();
    const selfUid = this.session.uidMap.uidByUin(BigInt(selfUin)) ?? '';
    if (!selfUid) {
      throw new Error('本地 uid 目录里没有自己的 uid，无法发合并转发（重新登录一次通常就好了）。');
    }

    const upload = await protocolSendForward(this.nt, pid, {
      ...(target.scene === 'group' ? { groupId: target.uin } : { userUin: target.uin }),
      ...(target.scene !== 'group' && target.uid ? { userUid: target.uid } : {}),
      selfUin,
      selfUid,
      nodes: params.nodes as ProtocolSendForwardParams['nodes'],
      log: (message: string) => logger.info(message, { event: 'forward-upload' }),
    });
    logger.info(`合并转发内容已上传: resId=${upload.resId} levels=${upload.levels.length}`, {
      event: 'forward-upload-summary',
      scene: upload.scene,
      targetId: target.targetId,
      levels: upload.levels.length,
    });

    // 第二步：发卡片。收端点开它才会按 resId 拉回上面那段内容。
    // 卡片要带上 source / summary / news（前 4 行的「昵称: 内容摘要」）——缺了
    // 这些收端就只剩一个标题，没有预览行（协议层由 sendForward 算好，见 upload.card）。
    const card = await this.sendElements({
      peerType: params.peerType,
      targetId: params.targetId,
      elements: [{ kind: 'forward', resId: upload.resId, ...upload.card }],
    });
    return {
      ok: card.ok,
      peerType: target.peerType,
      targetId: target.targetId,
      ...(target.uid ? { uid: target.uid } : {}),
      scene: upload.scene,
      resId: upload.resId,
      levels: upload.levels.length,
      card,
      hint: card.ok
        ? `聊天记录已发送（resId=${upload.resId}，共 ${upload.levels.length} 层）。`
        : '聊天记录内容已上传成功，但承载它的卡片没发出去 —— 内容在服务端，收端看不到，重发即可。',
    };
  }
}

/**
 * 节点（含嵌套层）里是否有需要上传的元素。
 *
 * 图片 / 语音 / 视频走 NTV2（所以要能解析出对方 uid）；文件走独立的文件管线，
 * 私聊时同样需要 uid（上传与路由都按 uid 认人），所以一并计入。
 */
function nodesNeedUpload(nodes: readonly SendForwardNodeInput[]): boolean {
  for (const node of nodes) {
    if (
      node.elements.some(
        (element) =>
          element.kind === 'image' ||
          element.kind === 'record' ||
          element.kind === 'video' ||
          element.kind === 'file',
      )
    ) {
      return true;
    }
    if (node.innerForward && nodesNeedUpload(node.innerForward)) return true;
  }
  return false;
}

// ───────────────────────────── 参数校验（纯函数，便于单测） ─────────────────────────────

/**
 * ark 卡片载荷校验：非空 + 必须是能 parse 的 JSON。
 *
 * 收端按 JSON 解析 `lightApp.data`，塞一段非法 JSON 只会在对面显示一张空卡 ——
 * 与其发出去，不如在这里报错。
 */
export function requireArkJson(value: string): string {
  const text = typeof value === 'string' ? value.trim() : '';
  if (!text) throw new Error('ark 卡片内容不能为空。');
  try {
    JSON.parse(text);
  } catch {
    throw new Error('ark 卡片内容必须是一段合法的 JSON 文本。');
  }
  return text;
}

/** 十进制度字符串校验（返回原字符串的 trim 结果，保留调用方的精度写法）。 */
export function decimalCoordinate(value: string, what: string, limit: number): string {
  const text = typeof value === 'string' ? value.trim() : '';
  const num = Number(text);
  if (!text || !Number.isFinite(num)) {
    throw new Error(`位置卡片的 ${what} 必须是十进制度数字符串，收到「${String(value)}」。`);
  }
  if (Math.abs(num) > limit) {
    throw new Error(`位置卡片的 ${what} 超出范围（±${limit}），收到 ${text}。`);
  }
  return text;
}

// ───────────────────────── 元素组装（纯函数，便于单测） ─────────────────────────

/**
 * 文本 + @ + 引用 → 元素数组。
 *
 * @ 是「文本 elem + pbReserve 带目标」的组合：所以每个 @ 生成一个独立 at 元素，
 * 后面接正文；@ 与正文之间补一个空格，避免连在一起被客户端当成一个词。
 */
export function buildTextElements(params: SendTextParams): SendElement[] {
  const elements: SendElement[] = [];
  if (params.replyToMsgSeq !== undefined) {
    elements.push({
      kind: 'reply',
      origMsgSeq: params.replyToMsgSeq,
      ...(params.replyToSenderUin !== undefined ? { origSenderUin: params.replyToSenderUin } : {}),
      ...(params.replyToMsgTime !== undefined ? { origMsgTime: params.replyToMsgTime } : {}),
    });
  }
  let mentioned = 0;
  for (const target of params.at ?? []) {
    const text = String(target).trim();
    if (!text) continue;
    // 纯数字当 QQ 号（显示 `@uin`），其余当 uid（`all` 也是 uid 槽位 = @全体成员）。
    elements.push(
      /^\d+$/.test(text)
        ? { kind: 'at', atTargetUin: Number(text) }
        : { kind: 'at', atTargetUid: text },
    );
    mentioned += 1;
  }
  // 只在有 @ 时补一个空格：否则「@张三」会和正文粘成一个词。引用不需要空格。
  if (mentioned > 0) elements.push({ kind: 'text', textContent: ' ' });
  elements.push({ kind: 'text', textContent: params.text });
  return elements;
}

/** 媒体参数 → 元素（字段名与协议层 `SendElement` 对齐）。 */
export function buildMediaElement(params: SendMediaParams): SendElement {
  switch (params.kind) {
    case 'image':
      return {
        kind: 'image',
        source: params.source,
        ...(params.fileName !== undefined ? { fileName: params.fileName } : {}),
        ...(params.subType !== undefined ? { subType: params.subType } : {}),
        ...(params.summary !== undefined ? { summary: params.summary } : {}),
        ...(params.width !== undefined ? { width: params.width } : {}),
        ...(params.height !== undefined ? { height: params.height } : {}),
        ...(params.picFormat !== undefined ? { picFormat: params.picFormat } : {}),
      };
    case 'record':
      return {
        kind: 'record',
        source: params.source,
        ...(params.durationSec !== undefined ? { duration: params.durationSec } : {}),
        ...(params.waveform ? { waveform: params.waveform } : {}),
        ...(params.fileName !== undefined ? { fileName: params.fileName } : {}),
      };
    case 'video':
      return {
        kind: 'video',
        source: params.source,
        ...(params.thumb !== undefined ? { thumb: params.thumb } : {}),
        ...(params.width !== undefined ? { width: params.width } : {}),
        ...(params.height !== undefined ? { height: params.height } : {}),
        ...(params.durationSec !== undefined ? { duration: params.durationSec } : {}),
        ...(params.fileName !== undefined ? { fileName: params.fileName } : {}),
      };
    default: {
      const unknown = params as { kind?: unknown };
      throw new Error(`不支持的媒体类型：${String(unknown.kind)}（支持 image / record / video）`);
    }
  }
}

/** 协议回执 → 服务层归一化结果（bigint / bytes 一律不外泄）。 */
export function toOutcome(
  receipt: SendMessageReceipt,
  target: ResolvedSendTarget,
  uploads: SendMediaUploadReport[] = [],
): SendMessageOutcome {
  return {
    ok: receipt.ok,
    peerType: target.peerType,
    targetId: target.targetId,
    ...(target.uid ? { uid: target.uid } : {}),
    scene: receipt.scene,
    result: receipt.result,
    errMsg: receipt.errMsg,
    random: receipt.random,
    groupSequence: receipt.groupSequence,
    privateSequence: receipt.privateSequence,
    timestamp: receipt.timestamp,
    ...(uploads.length > 0 ? { uploads } : {}),
    ...(receipt.ok
      ? {}
      : {
          hint:
            `服务端拒绝了下发（result=${receipt.result}）${receipt.errMsg ? `：${receipt.errMsg}` : '。'}` +
            '常见 result：79 = 场景/参数不符（如把窗口抖动发进群、库没开），0 = 正常。',
        }),
  };
}
