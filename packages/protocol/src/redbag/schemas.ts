/**
 * PC 端红包（`hb_pc_pre_pack` + 口令池）的 protobuf schema。
 *
 * 全部来自**真机抓包解密后的真实数据**（五份样本见 `docs/develop/redbag.md` 与
 * `test/redbag.test.ts`），不是从二进制猜的 tag。
 *
 *   上行 `trpc.qqhb.qqhb_proxy.Handler.sso_handle`
 *     f1 = "hb_pc_pre_pack"
 *     f5 = { f1: <16B salt>, f2: <AES-128-CBC 密文> }
 *     明文：
 *       f1  sender { f1: 自己 uin, f2: 10, f3: tenpay p_skey }
 *       f3  pack   { f1: 个数, f2: 总额(分), f3: 领取方, f4: 场景,
 *                    f5: 祝福语/口令, f6: 红包类型, f7: 金额分配,
 *                    f8: 自己昵称, f10: 0 }
 *       f101: <16B>  请求签名（算法在 nt_helper 的 `signRedBagRequest`，见 `./index`）
 *
 *   下行
 *     f1 = "0"（字符串，不是 varint）、f2 = "success"、f4 = { salt, 密文 }
 *     明文：f1 = 0、f2 = "ok"、f3 = { 二维码 PNG, 边长, token }、f101 = <16B>（服务端另给，
 *           与请求的 f101 不相等）
 *
 * 三个「枚举」字段是从五份样本对照出来的（`f6` / `f7` 一度以为是不变的 1）：
 *
 *   f4 scene  1 = 私聊、3 = 群
 *   f6 kind   1 = 普通红包、32 = 口令红包
 *   f7 split  1 = 等额、2 = 拼手气
 */

import { message } from '../protobuf';

/** `sso_handle` 的 trpc 命令字。 */
export const RED_BAG_SSO_HANDLE_CMD = 'trpc.qqhb.qqhb_proxy.Handler.sso_handle';

/** `hb_pc_pre_pack`：PC 端「预打包」——下单并下发二维码 + 领取 token。 */
export const RED_BAG_PRE_PACK_CMD = 'hb_pc_pre_pack';

/** 口令池命令：拉一批候选口令给口令红包用。 */
export const RED_BAG_PASSWORD_POOL_CMD = 'trpc.qqhb.hbpanel.Hongbao.SsoGetToken';

/** `hb_pc_detail`：查一个红包的领取明细（不领取，只读）。 */
export const RED_BAG_DETAIL_CMD = 'hb_pc_detail';

/** `hb_pc_grab`：抢红包（点开并领取）。 */
export const RED_BAG_GRAB_CMD = 'hb_pc_grab';

/** `f4 scene` 的取值：领取方是私聊还是群。 */
export const RED_BAG_SCENE = { c2c: 1, group: 3 } as const;

/** `f6 kind` 的取值：普通红包 / 口令红包。 */
export const RED_BAG_KIND = { normal: 1, password: 32 } as const;

/** `f7 split` 的取值：等额（固定金额）/ 拼手气（随机金额）。 */
export const RED_BAG_SPLIT = { equal: 1, lucky: 2 } as const;

/** 加密壳：一个 16 字节 salt + 用它派生的 AES-128-CBC 密文。 */
export const RED_BAG_BLOB = message([
  { name: 'salt', tag: 1, type: 'bytes' },
  { name: 'body', tag: 2, type: 'bytes' },
]);

/** 上行信封：`f1` 是子命令，`f5` 是加密壳。 */
export const RED_BAG_REQ_ENVELOPE = message([
  { name: 'cmd', tag: 1, type: 'string' },
  { name: 'blob', tag: 5, type: RED_BAG_BLOB },
]);

/** 下行信封：`f1`/`f2` 是字符串状态，`f4` 是加密壳。 */
export const RED_BAG_RESP_ENVELOPE = message([
  { name: 'code', tag: 1, type: 'string' },
  { name: 'message', tag: 2, type: 'string' },
  { name: 'blob', tag: 4, type: RED_BAG_BLOB },
]);

/** 明文请求里的发送者 + 凭据（`f1`）。 */
export const RED_BAG_SENDER = message([
  { name: 'uin', tag: 1, type: 'uint64' },
  /** 五份抓包恒为 10，含义未定（客户端平台 / 入口号？）。 */
  { name: 'channel', tag: 2, type: 'uint32' },
  /** tenpay.com 的 p_skey，由 OIDB `0x102a_0` 取（见 `../oidb/fetch-pskey`）。 */
  { name: 'pskey', tag: 3, type: 'string' },
]);

/** 明文请求里的红包参数（`f3`）。 */
export const RED_BAG_PACK_INFO = message([
  { name: 'totalNum', tag: 1, type: 'uint32' },
  /** 总金额，单位**分**（0.03 元 → 3）。 */
  { name: 'totalAmount', tag: 2, type: 'uint32' },
  { name: 'recvUin', tag: 3, type: 'uint64' },
  /** `RED_BAG_SCENE`：1 = 私聊、3 = 群。 */
  { name: 'scene', tag: 4, type: 'uint32' },
  /** 普通红包 = 祝福语；口令红包 = **口令本身**（可从口令池里选）。 */
  { name: 'wishing', tag: 5, type: 'string' },
  /** `RED_BAG_KIND`：1 = 普通、32 = 口令。 */
  { name: 'kind', tag: 6, type: 'uint32' },
  /** `RED_BAG_SPLIT`：1 = 等额、2 = 拼手气。 */
  { name: 'split', tag: 7, type: 'uint32' },
  /** 发红包者自己的昵称（五份抓包都是同一个号发的 → 恒为同一串）。 */
  { name: 'nickname', tag: 8, type: 'string' },
  // 五份抓包都是 0，但值为 0 也上 wire（`50 00`），所以编码时 force，
  // 否则复现不出原始字节。
  { name: 'qrcodeFlag', tag: 10, type: 'uint32', force: true },
]);

/** `hb_pc_pre_pack` 的明文请求。 */
export const RED_BAG_PRE_PACK_REQ = message([
  { name: 'sender', tag: 1, type: RED_BAG_SENDER },
  { name: 'pack', tag: 3, type: RED_BAG_PACK_INFO },
  /**
   * 16 字节**请求签名**。不随 salt 变，随 pskey 与全部 pack 字段变 —— 服务端会校验，
   * 对不上就回 `66201015 数据检查失败`。算法只在原生产物里（`signRedBagRequest`）。
   */
  { name: 'nonce', tag: 101, type: 'bytes' },
]);

/** 明文响应里的二维码（`f3`）。 */
export const RED_BAG_QRCODE = message([
  { name: 'image', tag: 1, type: 'bytes' },
  /** 抓包 300：二维码边长（像素），与 PNG 里的 206×206 不是一回事。 */
  { name: 'size', tag: 2, type: 'uint32' },
  { name: 'token', tag: 3, type: 'string' },
]);

/** `hb_pc_pre_pack` 的明文响应。 */
export const RED_BAG_PRE_PACK_RESP = message([
  { name: 'code', tag: 1, type: 'uint32' },
  { name: 'message', tag: 2, type: 'string' },
  { name: 'qrcode', tag: 3, type: RED_BAG_QRCODE },
  { name: 'nonce', tag: 101, type: 'bytes' },
]);

// ───────────────────────── 口令池（SsoGetToken）─────────────────────────

/** 口令池请求：抓包里就 2 字节 `10 00`（f2 = 0）。 */
export const RED_BAG_PASSWORD_POOL_REQ = message([
  { name: 'type', tag: 2, type: 'uint32', force: true },
]);

/** 口令池响应：`f1` 是 repeated 候选口令；f2 / f3 抓包都是 0（显式 `10 00 18 00`）。 */
export const RED_BAG_PASSWORD_POOL_RESP = message([
  { name: 'passwords', tag: 1, type: 'string', repeated: true },
  { name: 'flag2', tag: 2, type: 'uint32' },
  { name: 'flag3', tag: 3, type: 'uint32' },
]);

// ─────────────────── hb_pc_detail / hb_pc_grab ───────────────────
//
// 两条命令与 pre_pack 共用同一套 `sso_handle` 信封、salt 派生与 f101 签名，只是
// pack 子消息换成「定位哪一个红包」的参数。样本：
//
//   私聊 detail   `/tmp/bag_datail.log`（单领取人）
//   群  detail   `/tmp/group_detail.log`（两个领取人）
//   私聊 grab     `/tmp/bag_grab.log`
//   群  grab     `/tmp/group_grab.log`（后面还跟一条 0x5cf_11 上报）
//
// 明细响应里那句「领取列表」是 f3.4（repeated），f3.3 是**首个**领取人（首抢），
// 所以只有一个领取人时两者逐字节相同 —— `bag_datail.log` 正是这种情形。

/** detail 的 `f3`：定位红包（`f1` 订单号 + `f2` packetId + `f6` 会话）。 */
export const RED_BAG_DETAIL_QUERY = message([
  /** 红包订单号 / nonce（32 位 hex 字符串），来自消息 tag 48451。 */
  { name: 'orderId', tag: 1, type: 'string' },
  /** 32 字节 packetId（tag 48417.2），十六进制原样搬过来。 */
  { name: 'packetId', tag: 2, type: 'bytes' },
  /** 领取方：私聊 = 对方 uin，群 = 群号。 */
  { name: 'peerUin', tag: 6, type: 'uint64' },
  /** 私聊 0 / 群 1（detail 与 grab 一致，样本齐全）。 */
  { name: 'sceneFlag', tag: 7, type: 'uint32' },
  /** 抓包恒 0。 */
  { name: 'flag8', tag: 8, type: 'uint32', force: true },
  /** 抓包恒 20。 */
  { name: 'flag9', tag: 9, type: 'uint32' },
]);

/** grab 的 `f3`：在 detail 的基础上多几项（昵称、第二串 id、两个开关）。 */
export const RED_BAG_GRAB_QUERY = message([
  { name: 'orderId', tag: 1, type: 'string' },
  { name: 'packetId', tag: 2, type: 'bytes' },
  /** 领取者昵称（抓包写的是自己）。 */
  { name: 'nickname', tag: 4, type: 'string' },
  { name: 'peerUin', tag: 6, type: 'uint64' },
  /** 与 detail 同一个 scene：私聊 0 / 群 1。 */
  { name: 'flag7', tag: 7, type: 'uint32' },
  /** 第二串 32 位 hex id（tag 48418）。 */
  { name: 'token', tag: 9, type: 'string' },
  { name: 'flag10', tag: 10, type: 'uint32', force: true },
  { name: 'flag11', tag: 11, type: 'uint32' },
]);

/** 明细里的一条领取记录。 */
export const RED_BAG_CLAIM = message([
  { name: 'uin', tag: 2, type: 'uint64' },
  { name: 'nickname', tag: 3, type: 'string' },
  /** 领取金额，单位**分**（群样本两人 7 + 3 = 总额 10）。 */
  { name: 'amount', tag: 4, type: 'uint32' },
  /** 领取时间（unix 秒）。 */
  { name: 'claimTime', tag: 5, type: 'uint64' },
]);

/** 明细里的红包概况（`f3.2`）。 */
export const RED_BAG_DETAIL_SUMMARY = message([
  { name: 'senderUin', tag: 2, type: 'uint64' },
  { name: 'senderNickname', tag: 3, type: 'string' },
  /** 祝福语 / 口令。 */
  { name: 'wishing', tag: 4, type: 'string' },
  { name: 'totalNum', tag: 5, type: 'uint32' },
  /** 总金额，单位**分**。 */
  { name: 'totalAmount', tag: 6, type: 'uint32' },
  /** 金额分配：1 = 等额、2 = 拼手气（与 pre_pack 的 f7 一致）。 */
  { name: 'split', tag: 7, type: 'uint32' },
  /**
   * 领取方场景：1 = 私聊、2 = 群。
   *
   * ⚠️ 这个 tag 曾按 `claimedCount`（已领取人数）解析 —— 那是误判：群详情的 f8
   * 恒为 2，恰好与「群样本里 2 人领取」撞上，于是被当成了人数。真机对照已证伪：
   * 同群一个「只 1 人领取」的红包照样回 2，而真正的领取人数在 tag 16。
   */
  { name: 'scene', tag: 8, type: 'uint32' },
  { name: 'flag9', tag: 9, type: 'uint32' },
  { name: 'expireTime', tag: 11, type: 'uint64' },
  { name: 'flag15', tag: 15, type: 'uint32' },
  /** 已领取人数（与领取列表长度一一对应）。 */
  { name: 'claimedCount', tag: 16, type: 'uint32' },
  /** 已领取金额合计，单位**分**（等于领取列表金额之和）。 */
  { name: 'claimedAmount', tag: 17, type: 'uint32' },
  { name: 'flag18', tag: 18, type: 'uint64' },
]);

/** 明细响应正文（`f3`）：概况 + 首抢 + **repeated 领取列表**。 */
export const RED_BAG_DETAIL_BODY = message([
  { name: 'summary', tag: 2, type: RED_BAG_DETAIL_SUMMARY },
  { name: 'firstClaim', tag: 3, type: RED_BAG_CLAIM },
  { name: 'claims', tag: 4, type: RED_BAG_CLAIM, repeated: true },
]);

/** `hb_pc_detail` 明文请求：与 pre_pack 同构，`f3` 换成定位参数。 */
export const RED_BAG_DETAIL_REQ = message([
  { name: 'sender', tag: 1, type: RED_BAG_SENDER },
  { name: 'query', tag: 3, type: RED_BAG_DETAIL_QUERY },
  { name: 'nonce', tag: 101, type: 'bytes' },
]);

/** `hb_pc_detail` 明文响应。 */
export const RED_BAG_DETAIL_RESP = message([
  { name: 'code', tag: 1, type: 'uint32' },
  { name: 'message', tag: 2, type: 'string' },
  { name: 'body', tag: 3, type: RED_BAG_DETAIL_BODY },
  { name: 'nonce', tag: 101, type: 'bytes' },
]);

/** `hb_pc_grab` 明文请求。 */
export const RED_BAG_GRAB_REQ = message([
  { name: 'sender', tag: 1, type: RED_BAG_SENDER },
  { name: 'query', tag: 3, type: RED_BAG_GRAB_QUERY },
  { name: 'nonce', tag: 101, type: 'bytes' },
]);

/** 抢红包响应正文（`f3`）：多一个 `f1` 状态位，领取列表退化成单条 `f3`。 */
export const RED_BAG_GRAB_BODY = message([
  { name: 'flag1', tag: 1, type: 'uint32' },
  { name: 'summary', tag: 2, type: RED_BAG_DETAIL_SUMMARY },
  { name: 'claim', tag: 3, type: RED_BAG_CLAIM },
]);

/** `hb_pc_grab` 明文响应。 */
export const RED_BAG_GRAB_RESP = message([
  { name: 'code', tag: 1, type: 'uint32' },
  { name: 'message', tag: 2, type: 'string' },
  { name: 'body', tag: 3, type: RED_BAG_GRAB_BODY },
  { name: 'nonce', tag: 101, type: 'bytes' },
]);
