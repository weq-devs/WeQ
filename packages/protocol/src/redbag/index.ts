/**
 * QQ PC 端红包：口令池 + `hb_pc_pre_pack`（下单出码）。
 *
 * 链路（Windows 9.9.35 抓包 + 静态确认）：
 *
 *   NodeIKernelMsgService::packRedBag
 *   └ RedBagWorker::PackRedBag
 *     ├ trpc.qqhb.hbpanel.Hongbao.SsoGetToken     口令池（口令红包选口令用）
 *     ├ OidbSvcTrpcTcp.0x102a_0                   取 tenpay.com 的 p_skey
 *     └ trpc.qqhb.qqhb_proxy.Handler.sso_handle   f1 = "hb_pc_pre_pack"
 *        { f5: { f1: 16B salt, f2: AES-128-CBC(明文) } }
 *
 * 服务端回包同样是 `{ 16B salt, 密文 }`，但放在 **f4**：解密后是一张二维码 PNG
 * （明文 f3.1）+ 领取 token（明文 f3.3）。也就是说 PC 端这一步只是**下单 + 拿码**，
 * 真正扣款走 tenpay 的 H5（p_skey 就写在明文 f1.3 里）。
 *
 * 明文里的三个枚举字段是五份样本对照出来的：`scene`(f4) 1=私聊/3=群、`kind`(f6)
 * 1=普通/32=口令、`split`(f7) 1=等额/2=拼手气。完整字段表见 `docs/develop/redbag.md`。
 *
 * 密钥派生 / 加解密在 `./crypto`，字段定义在 `./schemas`。只实现抓包验证过的这两条命令
 * （`hb_pc_grab` 等抢红包子命令没有样本，不臆造）。
 */

import { randomBytes } from 'node:crypto';
import { decode, encode } from '../protobuf';
import { FetchPskeyOidb } from '../oidb/fetch-pskey';
import type { OidbNative, RedBagSignNative, TrpcNative } from '../transport';
import { sendPacket, signRedBagRequest } from '../transport';
import { decryptRedBagPayload, encryptRedBagPayload, RED_BAG_SALT_LENGTH } from './crypto';
import {
  RED_BAG_KIND,
  RED_BAG_PACK_INFO,
  RED_BAG_DETAIL_CMD,
  RED_BAG_DETAIL_QUERY,
  RED_BAG_DETAIL_REQ,
  RED_BAG_DETAIL_RESP,
  RED_BAG_GRAB_CMD,
  RED_BAG_GRAB_QUERY,
  RED_BAG_GRAB_REQ,
  RED_BAG_GRAB_RESP,
  RED_BAG_PASSWORD_POOL_CMD,
  RED_BAG_PASSWORD_POOL_REQ,
  RED_BAG_PASSWORD_POOL_RESP,
  RED_BAG_PRE_PACK_CMD,
  RED_BAG_PRE_PACK_REQ,
  RED_BAG_PRE_PACK_RESP,
  RED_BAG_REQ_ENVELOPE,
  RED_BAG_RESP_ENVELOPE,
  RED_BAG_SCENE,
  RED_BAG_SENDER,
  RED_BAG_SPLIT,
  RED_BAG_SSO_HANDLE_CMD,
} from './schemas';

/** 取 p_skey 的域：红包付款主体是财付通。 */
export const RED_BAG_PSKEY_DOMAIN = 'tenpay.com';

/** 领取方：私聊（好友）还是群。对应 wire `f4 scene`。 */
export type RedBagPeerType = keyof typeof RED_BAG_SCENE;
/** 红包类型：普通 / 口令。对应 wire `f6 kind`。 */
export type RedBagKind = keyof typeof RED_BAG_KIND;
/** 金额分配：等额 / 拼手气。对应 wire `f7 split`。 */
export type RedBagSplit = keyof typeof RED_BAG_SPLIT;

// ───────────────────────── sso_handle 信封 ─────────────────────────

export interface RedBagPacketView {
  /** 上行（我们发出去 / 抓包 SEND）还是下行。 */
  direction: 'request' | 'response';
  /** 上行的子命令，例如 `hb_pc_pre_pack`（下行没有这个字段）。 */
  cmd?: string;
  /** 下行状态码，成功是字符串 `"0"`。 */
  code?: string;
  /** 下行状态文案，抓包 `"success"`。 */
  message?: string;
  /** 本包 16 字节 salt。 */
  salt: Uint8Array;
  /** AES-128-CBC 密文（未剥 PKCS#7）。 */
  body: Uint8Array;
  /** 解密后的明文 protobuf。 */
  plain: Uint8Array;
}

/**
 * 加密一段明文并套上 `sso_handle` 上行信封。
 *
 * ⚠️ `subCmd` 是**信封 f1**（例如 `hb_pc_pre_pack`），不是 SSO 传输层那个
 * `trpc.qqhb.qqhb_proxy.Handler.sso_handle` —— 后者交给 `sendPacket`。
 *
 * `salt` 缺省现随机生成；显式传入可以复现历史抓包（同 salt + 同明文 ⇒ 同密文）。
 */
export function encodeSsoHandleRequest(
  subCmd: string,
  plain: Uint8Array,
  salt?: Uint8Array,
): Uint8Array {
  const { salt: useSalt, body } = encryptRedBagPayload(plain, salt);
  return encode(RED_BAG_REQ_ENVELOPE, { cmd: subCmd, blob: { salt: useSalt, body } });
}

/**
 * 解开一个 `sso_handle` 包（上行 / 下行自动识别）并解密出明文。
 *
 * 上行的加密壳在 f5、下行在 f4，所以先用两个 schema 各试一次即可判定方向。
 */
export function decodeSsoHandlePacket(bytes: Uint8Array): RedBagPacketView {
  const request = decode(RED_BAG_REQ_ENVELOPE, bytes);
  const reqBlob = request.blob as { salt: Uint8Array; body: Uint8Array } | undefined;
  if (reqBlob) {
    return {
      direction: 'request',
      cmd: String(request.cmd ?? ''),
      salt: reqBlob.salt,
      body: reqBlob.body,
      plain: decryptRedBagPayload(reqBlob.salt, reqBlob.body),
    };
  }
  const response = decode(RED_BAG_RESP_ENVELOPE, bytes);
  const respBlob = response.blob as { salt: Uint8Array; body: Uint8Array } | undefined;
  if (!respBlob) {
    throw new Error('不是 sso_handle 红包包：既没有上行 f5 加密壳，也没有下行 f4 加密壳。');
  }
  return {
    direction: 'response',
    code: String(response.code ?? ''),
    message: String(response.message ?? ''),
    salt: respBlob.salt,
    body: respBlob.body,
    plain: decryptRedBagPayload(respBlob.salt, respBlob.body),
  };
}

/**
 * 请求签名的**待签字节**：`sender` 与 `pack` 两条子消息的 protobuf 字节**直接拼接**。
 *
 * 不是外层消息的序列化结果 —— 没有外层 tag / 长度前缀。签名算法本体在原生产物里，
 * 这里只负责凑出它要吃的字节。
 */
function redBagSignInput(body: Record<string, unknown>): Uint8Array {
  const sender = encode(RED_BAG_SENDER, body.sender as Record<string, unknown>);
  const pack = encode(RED_BAG_PACK_INFO, body.pack as Record<string, unknown>);
  const joined = new Uint8Array(sender.length + pack.length);
  joined.set(sender, 0);
  joined.set(pack, sender.length);
  return joined;
}

// ───────────────────────── hb_pc_pre_pack ─────────────────────────

export interface RedBagPrePackParams {
  /** 发红包的 QQ 号（明文 f1.1）。 */
  uin: number | bigint | string;
  /** tenpay.com 的 p_skey（明文 f1.3），由 {@link fetchTenpayPsKey} 取。 */
  pskey: string;
  /** 领取方是私聊（`c2c`）还是群（`group`）。 */
  peerType: RedBagPeerType;
  /** 领取方：私聊传好友 QQ 号，群聊传群号（明文 f3.3）。 */
  recvUin: number | bigint | string;
  /** 红包个数。（明文 f3.1） */
  totalNum: number;
  /** 总金额，单位**分**（0.03 元传 3）。（明文 f3.2） */
  totalAmount: number;
  /** 红包类型：缺省 `normal`；给了 {@link password} 就默认按 `password` 走。 */
  kind?: RedBagKind;
  /** 金额分配：缺省「普通红包 = 等额、口令红包 = 拼手气」（口令红包只能是拼手气）。 */
  split?: RedBagSplit;
  /** 普通红包的祝福语（明文 f3.5）。 */
  wishing?: string;
  /** 口令红包的口令（也是明文 f3.5，和祝福语同一个字段）。可从口令池里选。 */
  password?: string;
  /** 发红包者自己的昵称（明文 f3.8）。缺省不发这个字段（proto3 空串省略）。 */
  nickname?: string;
  /**
   * 明文 f101 的 16 字节：**请求签名**。
   *
   * 缺省由 {@link RedBagPrePack.invoke} 交给原生产物现算 —— 调用方一般不用管；
   * 显式传入只用于复现历史抓包（`test/redbag.test.ts` 的黄金样本）。
   */
  nonce?: Uint8Array;
  /** 明文 f1.2，五份抓包恒为 10。 */
  senderChannel?: number;
  /** 明文 f3.10，五份抓包恒为 0。 */
  qrcodeFlag?: number;
}

export interface RedBagPrePackResult {
  /** 下行 f1，字符串 `"0"` 表示成功。 */
  code: string;
  /** 下行 f2，抓包 `"success"`。 */
  message: string;
  /** 明文 f1，抓包 0。 */
  bizCode: number;
  /** 明文 f2，抓包 `"ok"`。 */
  bizMessage: string;
  /** 二维码 PNG 字节（明文 f3.1，抓包 1077B / 206×206 / 1bit 调色板）。 */
  qrcode?: Uint8Array;
  /** 明文 f3.2，抓包 300。 */
  qrcodeSize?: number;
  /** 明文 f3.3，32 位 hex 字符串。 */
  qrcodeToken?: string;
  /** 明文 f101，服务端生成；**不等于**请求里那个 nonce。 */
  nonce?: Uint8Array;
  /** 解密后的完整明文，字段有漂移时用它对账。 */
  plain: Uint8Array;
}

/** 取 `tenpay.com` 的 p_skey（OIDB `0x102a_0`）。 */
export function fetchTenpayPsKey(nt: OidbNative, pid: number): Promise<string> {
  return FetchPskeyOidb.invoke(nt, pid, RED_BAG_PSKEY_DOMAIN);
}

function requireUint(value: number, field: string): void {
  if (!Number.isInteger(value) || value < 0) {
    throw new Error(`红包 ${field} 必须是非负整数，收到 ${String(value)}`);
  }
}

export namespace RedBagPrePack {
  export const command = RED_BAG_SSO_HANDLE_CMD;
  export const cmd = RED_BAG_PRE_PACK_CMD;
  export const reqSchema = RED_BAG_PRE_PACK_REQ;
  export const respSchema = RED_BAG_PRE_PACK_RESP;

  export type Params = RedBagPrePackParams;
  export type Result = RedBagPrePackResult;

  /** 校验 + 把枚举翻成 wire 值 + 填默认值（默认值取自抓包固定项）。 */
  export const serialize = (p: Params): Record<string, unknown> => {
    if (!p.pskey) throw new Error('红包 pre_pack 需要 tenpay.com 的 p_skey');
    requireUint(p.totalNum, 'totalNum');
    requireUint(p.totalAmount, 'totalAmount');
    if (p.totalNum === 0) throw new Error('红包 totalNum 不能为 0');

    if (p.peerType !== 'c2c' && p.peerType !== 'group') {
      throw new Error(`红包 peerType 只能是 c2c 或 group，收到 ${String(p.peerType)}`);
    }
    // 给了口令就默认是口令红包，省得调用方必须同时传 kind。
    const kind: RedBagKind = p.kind ?? (p.password ? 'password' : 'normal');
    const split: RedBagSplit = p.split ?? (kind === 'password' ? 'lucky' : 'equal');
    const text = kind === 'password' ? (p.password ?? p.wishing) : p.wishing;
    if (kind === 'password' && !text) {
      throw new Error('口令红包需要口令：传 password（或 wishing）。');
    }

    const nonce = p.nonce ?? new Uint8Array(randomBytes(16));
    if (nonce.length !== 16) throw new Error(`红包 nonce 必须是 16 字节，收到 ${nonce.length}`);

    return {
      sender: {
        uin: p.uin,
        channel: p.senderChannel ?? 10,
        pskey: p.pskey,
      },
      pack: {
        totalNum: p.totalNum,
        totalAmount: p.totalAmount,
        recvUin: p.recvUin,
        scene: RED_BAG_SCENE[p.peerType],
        wishing: text ?? '',
        kind: RED_BAG_KIND[kind],
        split: RED_BAG_SPLIT[split],
        nickname: p.nickname ?? '',
        qrcodeFlag: p.qrcodeFlag ?? 0,
      },
      nonce,
    };
  };

  /** 解析解密后的明文响应。 */
  export const deserialize = (plain: Uint8Array): Result => {
    const body = decode(RED_BAG_PRE_PACK_RESP, plain);
    const qrcode = body.qrcode as { image?: Uint8Array; size?: number; token?: string } | undefined;
    return {
      code: '',
      message: '',
      bizCode: Number(body.code ?? 0),
      bizMessage: String(body.message ?? ''),
      ...(qrcode?.image ? { qrcode: qrcode.image } : {}),
      ...(qrcode?.size !== undefined ? { qrcodeSize: Number(qrcode.size) } : {}),
      ...(qrcode?.token ? { qrcodeToken: qrcode.token } : {}),
      ...(body.nonce ? { nonce: body.nonce as Uint8Array } : {}),
      plain,
    };
  };

  /**
   * 发一条 `hb_pc_pre_pack` 并解出二维码 / token。
   *
   * ⚠️ 明文 `f101` 是**请求签名**，服务端会校验：不带它（或乱填）会回
   * `66201015 数据检查失败`、二维码为空。签名算法在原生产物里 —— 这里只把
   * 「待签字节」递进 `signRedBagRequest`，拿回的 16 字节填进 `f101`。
   *
   * 传了 {@link Params.nonce} 就跳过签名（仅用于复现抓包）。若服务端仍拒绝，这里
   * **如实返回**失败码与原始明文，不假装成功。
   */
  export const invoke = async (
    nt: TrpcNative & RedBagSignNative,
    pid: number,
    params: Params,
  ): Promise<Result> => {
    const body = serialize(params);
    const nonce = params.nonce ?? signRedBagRequest(nt, redBagSignInput(body));
    const reqBytes = encode(reqSchema, { ...body, nonce });
    const envelope = encodeSsoHandleRequest(cmd, reqBytes);
    const replyBytes = await sendPacket(nt, pid, command, envelope);
    const packet = decodeSsoHandlePacket(replyBytes);
    if (packet.direction !== 'response') {
      throw new Error('红包 pre_pack 回包不是 sso_handle 下行信封。');
    }
    const result = deserialize(packet.plain);
    return { ...result, code: packet.code ?? '', message: packet.message ?? '' };
  };
}

/** 一把梭：取 p_skey → `hb_pc_pre_pack`。 */
export async function prePackRedBag(
  nt: OidbNative & TrpcNative & RedBagSignNative,
  pid: number,
  params: Omit<RedBagPrePackParams, 'pskey'> & { pskey?: string },
): Promise<RedBagPrePackResult> {
  const pskey = params.pskey ?? (await fetchTenpayPsKey(nt, pid));
  return RedBagPrePack.invoke(nt, pid, { ...params, pskey });
}

// ───────────────────────── 口令池 ─────────────────────────

/** 口令红包的候选口令（`trpc.qqhb.hbpanel.Hongbao.SsoGetToken`）。 */
export namespace RedBagPasswordPool {
  export const command = RED_BAG_PASSWORD_POOL_CMD;
  export const reqSchema = RED_BAG_PASSWORD_POOL_REQ;
  export const respSchema = RED_BAG_PASSWORD_POOL_RESP;

  /** 请求就是 2 字节 `10 00`（f2 = 0）；抓包里没有任何别的字段。 */
  export const serialize = (): Record<string, unknown> => ({ type: 0 });

  /** 解析出候选口令列表（服务端返回顺序即抓包顺序）。 */
  export const deserialize = (body: Record<string, unknown>): string[] =>
    ((body.passwords as string[] | undefined) ?? []).filter((s) => s !== '');

  /**
   * 拉一批候选口令。抓包样本是 9 条中文短句（`docs/develop/redbag.md`）。
   *
   * 挑哪条由调用方决定 —— 把它填进 `RedBagPrePackParams.password` 即可发口令红包。
   */
  export const invoke = async (nt: TrpcNative, pid: number): Promise<string[]> => {
    const bytes = encode(reqSchema, serialize());
    const replyBytes = await sendPacket(nt, pid, command, bytes);
    return deserialize(decode(respSchema, replyBytes));
  };
}

/** 本包 salt 的长度常量，导出给调用方做校验 / 展示。 */
export const RED_BAG_SALT_BYTES = RED_BAG_SALT_LENGTH;

// ───────────────── hb_pc_detail / hb_pc_grab ─────────────────
//
// 查领取记录（detail）与抢红包（grab）与 pre_pack 共用同一套 sso_handle 信封、
// salt 派生和 f101 签名，只是把 pack 子消息换成「定位哪一个红包」。样本见
// `packages/protocol/test/redbag.test.ts` 的黄金样本注释。

/** 一条领取记录。 */
export interface RedBagClaim {
  /** 领取人 QQ 号。 */
  uin: string;
  /** 领取人当时的昵称。 */
  nickname: string;
  /** 领取到的金额，单位**分**。 */
  amount: number;
  /** 领取时间（unix 秒）。 */
  claimTime: number;
}

/** 红包概况（detail / grab 响应共用）。 */
export interface RedBagDetailSummary {
  readonly senderUin?: string;
  readonly senderNickname?: string;
  /** 祝福语；口令红包则是口令本身。 */
  readonly wishing?: string;
  /** 红包总个数。 */
  readonly totalNum?: number;
  /** 总金额，单位**分**。 */
  readonly totalAmount?: number;
  /** 金额分配：1 = 等额、2 = 拼手气。 */
  readonly split?: number;
  /** 已领取人数。 */
  readonly claimedCount?: number;
  /** 红包过期时间（unix 秒）。 */
  readonly expireTime?: number;
}

/** `hb_pc_detail` 的结果：概况 + 领取列表。 */
export interface RedBagDetailResult {
  /** 下行 f1，字符串 `"0"` 表示成功。 */
  code: string;
  /** 下行 f2，抓包 `"success"`。 */
  message: string;
  /** 明文 f1，抓包 0 表示业务成功。 */
  bizCode: number;
  /** 明文 f2，抓包 `"ok"`。 */
  bizMessage: string;
  readonly summary?: RedBagDetailSummary;
  /** 全部领取记录（含首抢）；服务端顺序即返回顺序。 */
  claims: RedBagClaim[];
  /** 解密后的完整明文，字段有漂移时用它对账。 */
  plain: Uint8Array;
}

/** `hb_pc_grab` 的结果：抢到的这一份 + 概况。 */
export interface RedBagGrabResult {
  code: string;
  message: string;
  bizCode: number;
  bizMessage: string;
  readonly summary?: RedBagDetailSummary;
  /** 本次抢到的记录（服务端按请求者自己去重，所以只回这一条）。 */
  readonly claim?: RedBagClaim;
  plain: Uint8Array;
}

/** detail / grab 共用的定位参数（来自消息里的 wallet 元素）。 */
export interface RedBagLocateParams {
  /** 请求者自己的 QQ 号（明文 f1.1 的 sender.uin）。 */
  uin: number | bigint | string;
  /** `tenpay.com` 的 p_skey（明文 f1.3）。 */
  pskey: string;
  /** 红包订单号 / nonce（32 位 hex），来自消息 tag 48451。 */
  orderId: string;
  /** 32 字节 packetId，来自消息 tag 48417.f2（hex 或字节都行）。 */
  packetId: string | Uint8Array;
  /** 领取方：私聊 = 对方 uin，群 = 群号。 */
  peerUin: number | bigint | string;
  /** pack.f7：私聊 0 / 群 1。 */
  scene: number;
  /** 明文 f101；缺省现算，显式传入只用于复现抓包。 */
  nonce?: Uint8Array;
  /** 明文 f1.2，抓包恒为 10。 */
  senderChannel?: number;
}

function toPacketBytes(packetId: string | Uint8Array): Uint8Array {
  if (packetId instanceof Uint8Array) return packetId;
  const clean = packetId.replace(/^0x/i, '').replace(/[^0-9a-fA-F]/g, '');
  if (clean.length % 2 !== 0) throw new Error(`红包 packetId hex 长度必须是偶数：${packetId}`);
  return Uint8Array.from((clean.match(/../g) ?? []).map((pair) => Number.parseInt(pair, 16)));
}

/** 把一条解码出来的 claim 记录整理成结果形状。 */
function toClaim(raw: Record<string, unknown> | undefined): RedBagClaim | undefined {
  if (!raw) return undefined;
  const uin = raw.uin as bigint | number | undefined;
  if (uin === undefined) return undefined;
  return {
    uin: String(uin),
    nickname: String(raw.nickname ?? ''),
    amount: Number(raw.amount ?? 0),
    claimTime: Number(raw.claimTime ?? 0),
  };
}

function toSummary(raw: Record<string, unknown> | undefined): RedBagDetailSummary | undefined {
  if (!raw) return undefined;
  const out: Record<string, unknown> = {};
  if (raw.senderUin !== undefined) out.senderUin = String(raw.senderUin);
  if (raw.senderNickname !== undefined) out.senderNickname = String(raw.senderNickname);
  if (raw.wishing !== undefined) out.wishing = String(raw.wishing);
  for (const key of ['totalNum', 'totalAmount', 'split', 'claimedCount'] as const) {
    if (raw[key] !== undefined) out[key] = Number(raw[key]);
  }
  if (raw.expireTime !== undefined) out.expireTime = Number(raw.expireTime);
  return out as RedBagDetailSummary;
}

/** detail 的 sender + query 拼出的「待签字节」（与 pre_pack 同一套）。 */
function locateSignInput(
  sender: Record<string, unknown>,
  query: Record<string, unknown>,
  schema: typeof RED_BAG_DETAIL_QUERY,
): Uint8Array {
  const a = encode(RED_BAG_SENDER, sender);
  const b = encode(schema, query);
  const joined = new Uint8Array(a.length + b.length);
  joined.set(a, 0);
  joined.set(b, a.length);
  return joined;
}

/** 解开一条 detail / grab 的回包并校验方向。 */
function decodeLocateReply(
  replyBytes: Uint8Array,
  what: string,
): { code: string; message: string; plain: Uint8Array } {
  const packet = decodeSsoHandlePacket(replyBytes);
  if (packet.direction !== 'response') {
    throw new Error(`红包 ${what} 回包不是 sso_handle 下行信封。`);
  }
  return { code: packet.code ?? '', message: packet.message ?? '', plain: packet.plain };
}

/** 查一个红包的领取明细（`hb_pc_detail`）。 */
export namespace RedBagDetail {
  export const command = RED_BAG_SSO_HANDLE_CMD;
  export const cmd = RED_BAG_DETAIL_CMD;
  export const reqSchema = RED_BAG_DETAIL_REQ;
  export const respSchema = RED_BAG_DETAIL_RESP;

  export type Params = RedBagLocateParams;
  export type Result = RedBagDetailResult;

  export const serialize = (p: Params): Record<string, unknown> => {
    if (!p.pskey) throw new Error('红包 detail 需要 tenpay.com 的 p_skey');
    if (!p.orderId) throw new Error('红包 detail 需要 orderId（消息 tag 48451）');
    const nonce = p.nonce ?? new Uint8Array(randomBytes(16));
    if (nonce.length !== 16) throw new Error(`红包 nonce 必须是 16 字节，收到 ${nonce.length}`);
    return {
      sender: { uin: p.uin, channel: p.senderChannel ?? 10, pskey: p.pskey },
      query: {
        orderId: p.orderId,
        packetId: toPacketBytes(p.packetId),
        peerUin: p.peerUin,
        sceneFlag: p.scene,
        flag8: 0,
        flag9: 20,
      },
      nonce,
    };
  };

  export const deserialize = (plain: Uint8Array): Result => {
    const body = decode(RED_BAG_DETAIL_RESP, plain);
    const detail = body.body as Record<string, unknown> | undefined;
    const claims = ((detail?.claims as Record<string, unknown>[] | undefined) ?? [])
      .map(toClaim)
      .filter((c): c is RedBagClaim => c !== undefined);
    return {
      code: '',
      message: '',
      bizCode: Number(body.code ?? 0),
      bizMessage: String(body.message ?? ''),
      ...(toSummary(detail?.summary as Record<string, unknown> | undefined)
        ? { summary: toSummary(detail?.summary as Record<string, unknown> | undefined) }
        : {}),
      claims,
      plain,
    };
  };

  export const invoke = async (
    nt: TrpcNative & RedBagSignNative,
    pid: number,
    params: Params,
  ): Promise<Result> => {
    const body = serialize(params);
    const nonce =
      params.nonce ??
      signRedBagRequest(
        nt,
        locateSignInput(
          body.sender as Record<string, unknown>,
          body.query as Record<string, unknown>,
          RED_BAG_DETAIL_QUERY,
        ),
      );
    const reqBytes = encode(reqSchema, { ...body, nonce });
    const replyBytes = await sendPacket(nt, pid, command, encodeSsoHandleRequest(cmd, reqBytes));
    const reply = decodeLocateReply(replyBytes, 'detail');
    return { ...deserialize(reply.plain), code: reply.code, message: reply.message };
  };
}

/** 抢红包（`hb_pc_grab`）。 */
export namespace RedBagGrab {
  export const command = RED_BAG_SSO_HANDLE_CMD;
  export const cmd = RED_BAG_GRAB_CMD;
  export const reqSchema = RED_BAG_GRAB_REQ;
  export const respSchema = RED_BAG_GRAB_RESP;

  /** grab 比 detail 多一个领取者昵称（抓包写的是自己）。 */
  export type Params = RedBagLocateParams & { nickname?: string; token?: string };
  export type Result = RedBagGrabResult;

  export const serialize = (p: Params): Record<string, unknown> => {
    if (!p.pskey) throw new Error('红包 grab 需要 tenpay.com 的 p_skey');
    if (!p.orderId) throw new Error('红包 grab 需要 orderId（消息 tag 48451）');
    const nonce = p.nonce ?? new Uint8Array(randomBytes(16));
    if (nonce.length !== 16) throw new Error(`红包 nonce 必须是 16 字节，收到 ${nonce.length}`);
    return {
      sender: { uin: p.uin, channel: p.senderChannel ?? 10, pskey: p.pskey },
      query: {
        orderId: p.orderId,
        packetId: toPacketBytes(p.packetId),
        nickname: p.nickname ?? '',
        peerUin: p.peerUin,
        flag7: p.scene,
        token: p.token ?? '',
        flag10: 0,
        flag11: 1,
      },
      nonce,
    };
  };

  export const deserialize = (plain: Uint8Array): Result => {
    const body = decode(RED_BAG_GRAB_RESP, plain);
    const detail = body.body as Record<string, unknown> | undefined;
    return {
      code: '',
      message: '',
      bizCode: Number(body.code ?? 0),
      bizMessage: String(body.message ?? ''),
      ...(toSummary(detail?.summary as Record<string, unknown> | undefined)
        ? { summary: toSummary(detail?.summary as Record<string, unknown> | undefined) }
        : {}),
      ...(toClaim(detail?.claim as Record<string, unknown> | undefined)
        ? { claim: toClaim(detail?.claim as Record<string, unknown> | undefined) }
        : {}),
      plain,
    };
  };

  export const invoke = async (
    nt: TrpcNative & RedBagSignNative,
    pid: number,
    params: Params,
  ): Promise<Result> => {
    const body = serialize(params);
    const nonce =
      params.nonce ??
      signRedBagRequest(
        nt,
        locateSignInput(
          body.sender as Record<string, unknown>,
          body.query as Record<string, unknown>,
          RED_BAG_GRAB_QUERY,
        ),
      );
    const reqBytes = encode(reqSchema, { ...body, nonce });
    const replyBytes = await sendPacket(nt, pid, command, encodeSsoHandleRequest(cmd, reqBytes));
    const reply = decodeLocateReply(replyBytes, 'grab');
    return { ...deserialize(reply.plain), code: reply.code, message: reply.message };
  };
}
