/**
 * 解码器：把一条消息的原始 protobuf 字节直接映射成业务需要的简化结构，
 * 不再保留 PUSH_MSG_BODY 的完整 proto 树，只保留：
 *   head      msgType / subType / c2cCmd / msgId / sequence / timestamp
 *   sender    发送者 uin / uid
 *   session   会话 uin / uid（群聊=群号，私聊=对方）
 *   elements  元素列表（按 ELEM schema 解码，装扮/发送者信息 elem 已剔除；
 *             text/at/face 元素提升为 codec 风格 { kind, ... }）
 *   dress     装扮：bubble / font / widget（font 优先 font1，回退 font2 字节交换转换）
 */

import { inflateSync } from 'node:zlib';
import { decode } from '../protobuf';
import { ELEM, FACE_COMMON_PB, FACE_ELEM, FILE_TRANS_TOP, INLINE_KEYBOARD_PB, MARKDOWN_COMMON_PB, PIC_COMMON_PB, PTT_COMMON_PB, PUSH_MSG_BODY, REPLY_PB_RESERVE, TEXT_PB_RESERVE, VIDEO_COMMON_PB } from './schemas';

export interface DecodedDress {
  /** 气泡 itemId，无则为 0（elem tag 9.1）。 */
  bubble: number;
  /** 字体 itemId：优先 font1（generalFlags tag 19.56），回退 font2 字节交换转换（tag 19.15）。 */
  font: number;
  /** 挂件 itemId，无则为 0（generalFlags tag 17）。 */
  widget: number;
}

/** 41531 式回退字体：低 16 位字节序交换后才是真实 font_id。 */
function decodeFallbackFontId(stored: number): number {
  if (!stored) return 0;
  return ((stored & 0xff) << 8) | ((stored >>> 8) & 0xff);
}

/**
 * TEXT_ELEM.pbReserve（tag 12）里 @ 消息的目标 uin（field 4）/ uid（field 9）。
 * 只有 uid 没有 uin 的 @ 元素是服务端重复项（带 uin 的紧随其后），直接从源头丢弃。
 */
function atMarkerOf(
  pbReserve: unknown,
): { uin: number; uid: string } | { uid: string } | undefined {
  if (!(pbReserve instanceof Uint8Array) || pbReserve.length === 0) return undefined;
  try {
    const pb = decode(TEXT_PB_RESERVE, pbReserve) as { fromUin?: number; atTargetUid?: string };
    if (!pb.atTargetUid) return undefined;
    return pb.fromUin ? { uin: pb.fromUin, uid: pb.atTargetUid } : { uid: pb.atTargetUid };
  } catch {
    return undefined;
  }
}

/**
 * 把老 wire 的 TEXT_ELEM 提升成 codec 风格元素（str → textContent）：
 * pbReserve 里同时带目标 uin + uid 的拆成 kind='at'；只有 uid 的重复项直接丢弃。
 */
function liftTextElem(text: Record<string, unknown>): Record<string, unknown> | undefined {
  const marker = atMarkerOf(text.pbReserve);
  if (marker !== undefined && !('uin' in marker)) return undefined;
  const isAt = marker !== undefined;
  const out: Record<string, unknown> = { kind: isAt ? 'at' : 'text', textContent: text.str ?? '' };
  if (isAt) out.atTargetUid = marker.uid;
  return out;
}

/**
 * 把老 wire 的 Face 元素提升成 codec 风格元素：只保留 faceId / faceText /
 * AniStickerId / diceValue / superEmojiFlag1（tag 4=1 视为超级表情），其余字段一律丢掉。
 */
/**
 * 把老 wire 的 MARKET_FACE 提升成 codec 风格 mface 元素：
 * 只保留 marketEmoticonId / emojiPackId / encryptKey / previewWidth / previewHeight。
 */
function liftMfaceElem(market: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = { kind: 'mface' };
  if (market.marketEmoticonId !== undefined) out.marketEmoticonId = market.marketEmoticonId;
  if (market.emojiPackId !== undefined) out.emojiPackId = market.emojiPackId;
  if (market.encryptKey !== undefined) out.encryptKey = market.encryptKey;
  if (market.previewWidth !== undefined) out.previewWidth = market.previewWidth;
  if (market.previewHeight !== undefined) out.previewHeight = market.previewHeight;
  return out;
}

function liftFaceElem(face: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = { kind: 'face' };
  // 老 wire 直出的 Elem.face 用 index 存 faceId（im_msg_body.proto message Face），
  // 骰子/超级表情（commonElem 37）用 faceId，两者都收进来。
  const faceId = face.faceId ?? face.index;
  if (faceId !== undefined) out.faceId = faceId;
  if (face.faceText !== undefined) out.faceText = face.faceText;
  if (face.AniStickerId !== undefined) out.AniStickerId = face.AniStickerId;
  if (face.diceValue !== undefined) out.diceValue = face.diceValue;
  if (face.superEmojiFlag1 === 1) out.superEmojiFlag1 = face.superEmojiFlag1;
  // 老 wire 不下发 NT 的 subType(45003)，前端靠它区分内联小黄脸(1/2)和贴纸(3+)。
  // 这里按字段派生：骰子/超级表情 -> 3(SUPER_EMOJI)，其余经典表情 -> 1。
  out.subType = face.superEmojiFlag1 === 1 || face.diceValue !== undefined ? 3 : 1;
  return out;
}

/**
 * 把 commonElem(serviceType=48) 的 pbElem 提升成 codec 风格 pic 元素：
 * 只保留 fileName / fileToken / originalUrl / imgWidth / imgHeight / imgType。
 */
function liftPicElem(pb: Record<string, unknown>): Record<string, unknown> {
  const file = pb.file as Record<string, unknown> | undefined;
  const body = file?.body as Record<string, unknown> | undefined;
  const info = body?.info as Record<string, unknown> | undefined;
  const typeWrap = info?.imgType as Record<string, unknown> | undefined;
  const url = file?.url as Record<string, unknown> | undefined;
  const out: Record<string, unknown> = { kind: 'pic' };
  if (info?.fileName !== undefined) out.fileName = info.fileName;
  if (body?.fileToken !== undefined) out.fileToken = body.fileToken;
  if (url?.originalUrl !== undefined) out.originalUrl = url.originalUrl;
  if (info?.imgWidth !== undefined) out.imgWidth = info.imgWidth;
  if (info?.imgHeight !== undefined) out.imgHeight = info.imgHeight;
  if (typeWrap?.imgType !== undefined) out.imgType = typeWrap.imgType;
  return out;
}

/**
 * 把 commonElem(serviceType=48, businessType=21) 的 pbElem 提升成 codec 风格 video 元素：
 * 第 0 项取 fileName/fileToken/videoWidth/videoHeight/videoDuration，
 * 第 1 项的 fileToken 作为 videoToken（封面缩略图）。
 *
 * 已知缺口（下次补）：正常消息的视频 OIDB 请求会带 videoExt（channelParams=45862 /
 * videoFlag45421=45421 / videoFlag45863=45863）与 storeId（fileFlag45415=45415）；
 * 旧 wire 的 VIDEO_COMMON_PB 没声明这些 tag，缺失消息窗口的原片补全因此缺 video
 * 扩展块。若实测旧 wire 带对应字段，把 tag 补进 schema 与本函数即可。
 */
function liftVideoElem(pb: Record<string, unknown>): Record<string, unknown> {
  const files = (pb.files as Record<string, unknown>[] | undefined) ?? [];
  const video = files[0] as Record<string, unknown> | undefined;
  const thumb = files[1] as Record<string, unknown> | undefined;
  const videoBody = video?.body as Record<string, unknown> | undefined;
  const info = videoBody?.info as Record<string, unknown> | undefined;
  const thumbBody = thumb?.body as Record<string, unknown> | undefined;
  const out: Record<string, unknown> = { kind: 'video' };
  if (info?.fileName !== undefined) out.fileName = info.fileName;
  if (videoBody?.fileToken !== undefined) out.fileToken = videoBody.fileToken;
  if (info?.videoWidth !== undefined) out.videoWidth = info.videoWidth;
  if (info?.videoHeight !== undefined) out.videoHeight = info.videoHeight;
  if (info?.videoDuration !== undefined) out.videoDuration = info.videoDuration;
  if (thumbBody?.fileToken !== undefined) out.videoToken = thumbBody.fileToken;
  return out;
}
/**
 * 把 commonElem(serviceType=48, businessType=22) 的 pbElem 提升成 codec 风格 ptt 元素：
 * 只保留 fileName / fileToken / pttDuration / waveform。
 */
function liftPttElem(pb: Record<string, unknown>): Record<string, unknown> {
  const file = pb.file as Record<string, unknown> | undefined;
  const body = file?.body as Record<string, unknown> | undefined;
  const info = body?.info as Record<string, unknown> | undefined;
  const extra = pb.extra as Record<string, unknown> | undefined;
  const meta = extra?.meta as Record<string, unknown> | undefined;
  const wave = meta?.wave as Record<string, unknown> | undefined;
  const out: Record<string, unknown> = { kind: 'ptt' };
  if (info?.fileName !== undefined) out.fileName = info.fileName;
  if (body?.fileToken !== undefined) out.fileToken = body.fileToken;
  if (info?.pttDuration !== undefined) out.pttDuration = info.pttDuration;
  if (wave?.waveform !== undefined) out.waveform = wave.waveform;
  return out;
}

/**
 * 把 transElem(elemType=24) 的 elemValue 提升成 codec 风格 file 元素：
 * 只保留 fileName / fileSize / fileToken。
 *
 * 已知缺口（下次补）：私聊文件下载（OIDB 0xE37_1200）除 fileToken（fileUuid）外还
 * 需要 fileHash（正常路径 = transferFlag45504 / md5Bytes2 / md5Bytes）。旧 wire 的
 * FILE_TRANS_INFO 字段 7/8/9 目前未保留，若其中是 md5/fileHash，补进 schema 与
 * 本函数后缺失消息窗口的私聊文件才能走通。
 */
/**
 * transElem(elemType=24) 的 elemValue 实测带 3 字节多余头（01 00 93）。
 * 正常 protobuf 首字节是合法 tag（field>=1、wire 为 0/1/2/5），据此判断是否需要跳过前缀，
 * 避免误伤干净数据。
 */
function fileElemValueOffset(elemValue: Uint8Array): number {
  if (elemValue.length === 0) return 0;
  const tag = elemValue[0]!;
  const wire = tag & 0x07;
  const field = tag >>> 3;
  const valid = field !== 0 && (wire === 0 || wire === 1 || wire === 2 || wire === 5);
  return valid ? 0 : 3;
}

/**
 * 把 commonElem(serviceType=45) 的 pbElem 提升成 codec 风格 markdown 元素：
 * 只保留 markdownContent / markdownTextSummary / fileSetId（闪传时才有）。
 */
function liftMarkdownElem(pb: Record<string, unknown>): Record<string, unknown> {
  const flash = pb.flashTransferInfo as Record<string, unknown> | undefined;
  const out: Record<string, unknown> = { kind: 'markdown' };
  if (pb.markdownContent !== undefined) out.markdownContent = pb.markdownContent;
  if (pb.markdownTextSummary !== undefined) out.markdownTextSummary = pb.markdownTextSummary;
  // 与 codec 命名对齐：闪传信息挂在 flashTransferInfo 下（前端 QqMessageContent 靠
  // data.flashTransferInfo 识别闪传卡片并传给 QqFlashTransfer），而不是平铺 fileSetId。
  if (flash?.fileSetId !== undefined) out.flashTransferInfo = { fileSetId: flash.fileSetId };
  return out;
}

/** 解压老 wire 常见载荷：首个字节是标志位，之后是 zlib 流（multiMsg 的 xml / ark 的 json）。 */
function inflatePayload(raw: Uint8Array): string | undefined {
  if (raw.length <= 2) return undefined;
  for (const start of [1, 0]) {
    try {
      return inflateSync(raw.subarray(start)).toString('utf8');
    } catch {
      // try next offset
    }
  }
  return undefined;
}

/**
 * 把 richMsg(serviceId=35) 的合并转发提升成 codec 风格 multiMsg 元素：
 * 只保留 xmlContent（由 template1 解压得到）。
 */
function liftMultiMsgElem(rich: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = { kind: 'multiMsg' };
  const raw = rich.template1 as Uint8Array | undefined;
  if (raw) {
    const xml = inflatePayload(raw);
    if (xml !== undefined) out.xmlContent = xml;
  }
  return out;
}

/**
 * 把 lightApp 的 ark 卡片提升成 codec 风格 ark 元素：
 * 只保留 arkData（由 data 解压得到的 JSON 字符串）。
 */
/**
 * 把 elem(tag=24) 的钱包/红包提升成 codec 风格 wallet 元素：
 * 只保留 redbagTitle / openPrompt / subTitle / skinId / walletDesignatedUin。
 */
/** 单个键盘按钮：只保留 buttonId / label / visitedLabel / style / action / actionType。 */
function liftKeyboardButton(btn: Record<string, unknown>): Record<string, unknown> {
  const label = btn.labelInfo as Record<string, unknown> | undefined;
  const action = btn.actionInfo as Record<string, unknown> | undefined;
  const actionType = action?.actionType as Record<string, unknown> | undefined;
  const out: Record<string, unknown> = {};
  if (btn.buttonId !== undefined) out.buttonId = btn.buttonId;
  if (label?.label !== undefined) out.label = label.label;
  if (label?.visitedLabel !== undefined) out.visitedLabel = label.visitedLabel;
  if (label?.style !== undefined) out.style = label.style;
  if (action?.action !== undefined) out.action = action.action;
  if (actionType?.actionType !== undefined) out.actionType = actionType.actionType;
  return out;
}

/**
 * 把 commonElem(serviceType=46) 的 pbElem 提升成 codec 风格 inlineKeyboard 元素：
 * 只保留 keyboardRows（单行 buttons）和 keyboardBotAppId。
 */
function liftInlineKeyboardElem(pb: Record<string, unknown>): Record<string, unknown> {
  const group = pb.group as Record<string, unknown> | undefined;
  const buttonsWrap = group?.buttons as Record<string, unknown> | undefined;
  const buttons = (buttonsWrap?.buttons as Record<string, unknown>[] | undefined) ?? [];
  const out: Record<string, unknown> = { kind: 'inlineKeyboard' };
  if (buttons.length > 0) {
    out.keyboardRows = [{ buttons: buttons.map(liftKeyboardButton) }];
  }
  if (group?.keyboardBotAppId !== undefined) out.keyboardBotAppId = Number(group.keyboardBotAppId);
  return out;
}

function liftWalletElem(wallet: Record<string, unknown>): Record<string, unknown> {
  const body = wallet.body as Record<string, unknown> | undefined;
  const detail = body?.detail as Record<string, unknown> | undefined;
  const skin = detail?.skin as Record<string, unknown> | undefined;
  const out: Record<string, unknown> = { kind: 'wallet' };
  // 老 wire 不下发 walletRedbagType(48412)，涉及钱的字段卡得严、拿不到，
  // 前端只能按普通红包回退渲染（QqWallet 在 redbagType 缺失时走 normal_bag）。
  // 字段名对齐 codec：详情挂在 walletDetail 下，skinId 放 receiptList.skinId
  // （与 QqMessageContent 的读取位置一致）。
  const walletDetail: Record<string, unknown> = {};
  if (detail?.redbagTitle !== undefined) walletDetail.redbagTitle = detail.redbagTitle;
  if (detail?.openPrompt !== undefined) walletDetail.openPrompt = detail.openPrompt;
  if (detail?.subTitle !== undefined) walletDetail.subTitle = detail.subTitle;
  if (skin?.skinId !== undefined) walletDetail.receiptList = { skinId: skin.skinId };
  if (Object.keys(walletDetail).length > 0) out.walletDetail = walletDetail;
  if (body?.walletDesignatedUin !== undefined) out.walletDesignatedUin = Number(body.walletDesignatedUin);
  return out;
}

function liftArkElem(light: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = { kind: 'ark' };
  const raw = light.data as Uint8Array | undefined;
  if (raw) {
    const json = inflatePayload(raw);
    if (json !== undefined) out.arkData = json;
  }
  return out;
}

function liftFileElem(pb: Record<string, unknown>): Record<string, unknown> {
  const item = pb.file as Record<string, unknown> | undefined;
  const info = item?.info as Record<string, unknown> | undefined;
  const out: Record<string, unknown> = { kind: 'file' };
  if (info?.fileName !== undefined) out.fileName = info.fileName;
  if (info?.fileSize !== undefined) out.fileSize = info.fileSize;
  if (info?.fileToken !== undefined) out.fileToken = info.fileToken;
  return out;
}

/**
 * 把老 wire 的 srcMsg（REPLY_ELEMENT）提升成 codec 风格 reply 元素：
 * origMsgSeq / origMsgIndex 都取 tag 1，origSenderUid 取 pbReserve(8).6，
 * origElements 来自 tag 5（逐条解码并提升成 codec 风格）。
 */
function liftReplyElem(src: Record<string, unknown>): Record<string, unknown> {
  const seqs = (src.origMsgSeq as number[] | undefined) ?? [];
  const seq = seqs[0];
  const pb = src.pbReserve as Uint8Array | undefined;
  let origSenderUid: string | undefined;
  if (pb && pb.length > 0) {
    try {
      origSenderUid = (decode(REPLY_PB_RESERVE, pb) as { origSenderUid?: string }).origSenderUid;
    } catch {
      origSenderUid = undefined;
    }
  }
  const rawElems = (src.origElementsRaw as Uint8Array[] | undefined) ?? [];
  const origElements = rawElems
    .map((raw) => {
      try {
        return liftElem(decode(ELEM, raw) as Record<string, unknown>, null);
      } catch {
        return undefined;
      }
    })
    .filter((el): el is Record<string, unknown> => el !== undefined);
  const out: Record<string, unknown> = { kind: 'reply' };
  if (seq !== undefined) {
    out.origMsgSeq = seq;
    out.origMsgIndex = seq;
  }
  if (src.origSenderUin !== undefined) out.origSenderUin = Number(src.origSenderUin);
  if (src.origMsgTime !== undefined) out.origMsgTime = src.origMsgTime;
  if (origSenderUid !== undefined) out.origSenderUid = origSenderUid;
  if (origElements.length > 0) out.origElements = origElements;
  return out;
}

/**
 * 把单个 ELEM 提升成 codec 风格元素；装扮（generalFlags/bubble）和
 * extraInfo 只在本层消费/丢弃，返回 undefined 表示不进入 elements。
 */
function liftElem(elem: Record<string, unknown>, dress: DecodedDress | null): Record<string, unknown> | undefined {
  const gf = elem.generalFlags as
    | { widgetId?: number; font?: { fontId1?: number; fontId2?: number } }
    | undefined;
  if (gf) {
    if (dress) {
      dress.widget = gf.widgetId ?? dress.widget;
      const font1 = gf.font?.fontId1 ?? 0;
      const font2 = gf.font?.fontId2 ?? 0;
      dress.font = font1 !== 0 ? font1 : decodeFallbackFontId(font2);
    }
    return undefined;
  }
  const bubble = elem.bubble as { id?: number } | undefined;
  if (bubble) {
    if (dress) dress.bubble = bubble.id ?? dress.bubble;
    return undefined;
  }
  if (elem.extraInfo) return undefined;
  const text = elem.text as Record<string, unknown> | undefined;
  if (text) return liftTextElem(text);
  const face = elem.face as Record<string, unknown> | undefined;
  if (face) return liftFaceElem(face);
  const market = elem.marketFace as Record<string, unknown> | undefined;
  if (market) return liftMfaceElem(market);
  const common = elem.commonElem as
    | { serviceType?: number; businessType?: number; pbElem?: Uint8Array }
    | undefined;
  if (common?.serviceType === 33 && common.pbElem) {
    return liftFaceElem(decode(FACE_COMMON_PB, common.pbElem) as Record<string, unknown>);
  }
  if (common?.serviceType === 37 && common.pbElem) {
    return liftFaceElem(decode(FACE_ELEM, common.pbElem) as Record<string, unknown>);
  }
  // 普通聊天图片 businessType=20；合并转发（SsoRecvLongMsg）里的图片实测是 10，两者都收。
  if (common?.serviceType === 48 && (common.businessType === 20 || common.businessType === 10) && common.pbElem) {
    return liftPicElem(decode(PIC_COMMON_PB, common.pbElem) as Record<string, unknown>);
  }
  if (common?.serviceType === 48 && common.businessType === 21 && common.pbElem) {
    return liftVideoElem(decode(VIDEO_COMMON_PB, common.pbElem) as Record<string, unknown>);
  }
  if (common?.serviceType === 48 && common.businessType === 22 && common.pbElem) {
    return liftPttElem(decode(PTT_COMMON_PB, common.pbElem) as Record<string, unknown>);
  }
  if (common?.serviceType === 45 && common.pbElem) {
    return liftMarkdownElem(decode(MARKDOWN_COMMON_PB, common.pbElem) as Record<string, unknown>);
  }
  if (common?.serviceType === 46 && common.pbElem) {
    return liftInlineKeyboardElem(decode(INLINE_KEYBOARD_PB, common.pbElem) as Record<string, unknown>);
  }
  const trans = elem.transElem as
    | { elemType?: number; elemValue?: Uint8Array }
    | undefined;
  if (trans?.elemType === 24 && trans.elemValue) {
    return liftFileElem(
      decode(FILE_TRANS_TOP, trans.elemValue.subarray(fileElemValueOffset(trans.elemValue))) as Record<string, unknown>,
    );
  }
  const reply = elem.replyElement as Record<string, unknown> | undefined;
  if (reply) return liftReplyElem(reply);
  const rich = elem.richMsg as { serviceId?: number; template1?: Uint8Array } | undefined;
  if (rich?.serviceId === 35 && rich.template1) return liftMultiMsgElem(rich);
  const light = elem.lightApp as { data?: Uint8Array } | undefined;
  if (light?.data) return liftArkElem(light);
  const wallet = elem.wallet as Record<string, unknown> | undefined;
  if (wallet) return liftWalletElem(wallet);
  // 未适配的未知元素类型直接丢弃，不再原样输出。
  return undefined;
}
export interface DecodedMessage {
  head: {
    msgType: number;
    subType: number;
    c2cCmd: number;
    msgId: number;
    sequence: number;
    timestamp: number;
  };
  sender: { uin: number; uid: string };
  session: { uin: number; uid: string };
  elements: Record<string, unknown>[];
  dress: DecodedDress;
}

/** 把原始消息字节解码成简化 Message。 */
export function decodeMessage(bytes: Uint8Array): DecodedMessage {
  const raw = decode(PUSH_MSG_BODY, bytes) as {
    responseHead?: {
      fromUin?: number;
      fromUid?: string;
      toUin?: number;
      toUid?: string;
      grp?: { groupUin?: number };
    };
    contentHead?: {
      msgType?: number;
      subType?: number;
      c2cCmd?: number;
      msgId?: number;
      sequence?: number;
      timestamp?: number;
    };
    body?: { richText?: { elems?: Record<string, unknown>[] } };
  };

  const head = raw.contentHead ?? {};
  const sender = raw.responseHead ?? {};
  const grp = raw.responseHead?.grp ?? {};
  const elems = raw.body?.richText?.elems ?? [];

  // 装扮和元素无关：散落在 elems 里的装扮 elem 只用于聚合 dress，不进 elements。
  const dress: DecodedDress = { bubble: 0, font: 0, widget: 0 };
  const elements: Record<string, unknown>[] = [];
  for (const elem of elems) {
    const lifted = liftElem(elem, dress);
    if (lifted !== undefined) elements.push(lifted);
  }

  return {
    head: {
      msgType: head.msgType ?? 0,
      subType: head.subType ?? 0,
      c2cCmd: head.c2cCmd ?? 0,
      msgId: head.msgId ?? 0,
      sequence: head.sequence ?? 0,
      timestamp: head.timestamp ?? 0,
    },
    sender: { uin: sender.fromUin ?? 0, uid: sender.fromUid ?? '' },
    session: { uin: grp.groupUin ?? sender.toUin ?? 0, uid: sender.toUid ?? '' },
    elements,
    dress,
  };
}
