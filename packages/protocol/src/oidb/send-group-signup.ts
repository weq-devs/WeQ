// OIDB 0x921b_0 —— 发送「群报名」/「群收集表」卡片。
//
// 由真机抓包（2026-10-03）逆向得到：外层是通用 OIDB 信封（native 负责
// command/subCommand 包裹），`body` 里再套一层请求：
//
//   body:
//     f1  request      { … 见下 … }
//     f12 fixed=1      （外层 body 的常量；实测恒为 1）
//
//   request（字段号与抓包逐字节对齐）：
//     f1  empty        （空 message，实测恒出现为 `0A 00`）
//     f2  groupCode    uint64  群号
//     f3  title        string  标题
//     f4  detail       string  详情正文
//     f5  fixed=0      （显式上 wire 的 0）
//     f6  deadline     uint32  报名截止时间（unix 秒，UTC）。缺席 = 不截止
//     f7  image        { f1 width, f2 height, f3 url, f4 md5 }  附带图片（可选）
//     f8  maxCount     uint32  报名人数上限（可调）
//     f9  signupMethod uint32  1 = 直接报名，2 = 上传图片
//     f10 fixed=200    （实测恒为 200，疑为平台默认/上限）
//     f11 fixed=0
//     f12 fixed=0
//     f13 extra        { f1 0, f2 "", f3 "" }  空结构，实测恒出现
//     f14/f15/f16 fixed=0
//
// 抓包样例（群号 673646675）：
//   - 样例1「找搭子」直接报名：f8=14, f9=1, deadline=1791561600（2026-10-10 00:00 CST）
//   - 样例2「图片收集」上传图片：f8=1,  f9=2, deadline=1791043200（2026-10-04 00:00 CST），
//     f7 = { width:1125, height:660, url:vfiles…png, md5:df35… }
//
// 注意 f10 在两张抓包里恒为 200，而用户可调的报名上限是 f8 —— 所以 maxCount 写 f8、
// f10 固定 200，两者不是同一个字段。
//
// 回包：
//   - 成功 ack 尚未抓到，按空 ack 处理（与 SendPoke / SetReaction 一样，deserialize 返回 void）。
//   - 失败**不是**空 ack。PC/Linux 端发这条命令会被服务端在 OIDB 外层直接拒掉；
//     绕开 native 的 status 检查、直接读 hook 的 control pipe，抓到的原始返回是一个
//     完整的 OidbBase 信封（2026-10-03 真机）：
//
//       command=37403(0x921b)  subCommand=0  errorCode=319
//       errorMsg = "[oidb] rule type not match appid,https://iwiki.woa.com/..."
//       body     = trpc-sso 头 + "qq-i18n-tip-msg: 登录态白名单校验失败"
//
//     ⚠️ native 的 `run_oidb_ex` 在 `reply.status != 0` 时直接 Err（只保留 status + msg，
//     body 被丢掉），所以 TS 侧拿不到结构化的 errorCode/body。这与图文 Ark 的
//     901501(`rule type not match appid`) 是同一类「平台规则不匹配」缺口，**不是**字段拼错。
//     详见 docs/develop/group-signup.md。

import { message } from '../protobuf';
import type { OidbNative } from '../transport';
import { invokeOidb, type OidbSpec } from './invoke';

/** 附带图片（f7）：URL + md5 + 宽高。 */
const SIGNUP_IMAGE = message([
  { name: 'width', tag: 1, type: 'uint32' },
  { name: 'height', tag: 2, type: 'uint32' },
  { name: 'url', tag: 3, type: 'string' },
  { name: 'md5', tag: 4, type: 'string' },
]);

/** 尾部空结构（f13）：抓包恒为 `{1:0, 2:"", 3:""}`，三个字段都要显式上 wire。 */
const SIGNUP_EXTRA = message([
  { name: 'field1', tag: 1, type: 'uint32', force: true },
  { name: 'field2', tag: 2, type: 'string', force: true },
  { name: 'field3', tag: 3, type: 'string', force: true },
]);

/** 空 message：f1 用，抓包里恒出现为 `0A 00`。 */
const EMPTY = message([]);

/** request（body.f1）。 */
const SIGNUP_REQUEST = message([
  { name: 'field1', tag: 1, type: EMPTY },
  { name: 'groupCode', tag: 2, type: 'uint64' },
  { name: 'title', tag: 3, type: 'string' },
  { name: 'detail', tag: 4, type: 'string' },
  { name: 'field5', tag: 5, type: 'uint32', force: true },
  { name: 'deadline', tag: 6, type: 'uint32' },
  { name: 'image', tag: 7, type: SIGNUP_IMAGE },
  { name: 'maxCount', tag: 8, type: 'uint32' },
  { name: 'signupMethod', tag: 9, type: 'uint32' },
  { name: 'field10', tag: 10, type: 'uint32' },
  { name: 'field11', tag: 11, type: 'uint32', force: true },
  { name: 'field12', tag: 12, type: 'uint32', force: true },
  { name: 'extra', tag: 13, type: SIGNUP_EXTRA },
  { name: 'field14', tag: 14, type: 'uint32', force: true },
  { name: 'field15', tag: 15, type: 'uint32', force: true },
  { name: 'field16', tag: 16, type: 'uint32', force: true },
]);

/** body：f1 = request，f12 固定 1。 */
const SIGNUP_BODY = message([
  { name: 'request', tag: 1, type: SIGNUP_REQUEST },
  { name: 'field12', tag: 12, type: 'uint32' },
]);

/** 回包：尚未抓到，按空 ack 处理。 */
const SIGNUP_RESP = message([]);

export interface SendGroupSignupImage {
  /** 图片直链（抓包来自 vfiles.gtimg.cn，任意可访问 URL 即可，服务端按 URL + md5 取图）。 */
  url: string;
  /** 32 位小写 hex md5。 */
  md5: string;
  /** 像素宽（拿不到可给 0）。 */
  width: number;
  /** 像素高（拿不到可给 0）。 */
  height: number;
}

export interface SendGroupSignupParams {
  /** 目标群号。 */
  groupCode: number;
  /** 标题（如「找搭子」「图片收集」）。 */
  title: string;
  /** 详情正文。 */
  detail: string;
  /** 报名截止时间（unix 秒，UTC）。不填 = 不截止（字段缺席）。 */
  deadline?: number;
  /** 报名方式：1 = 直接报名（默认），2 = 上传图片。 */
  method?: 1 | 2;
  /** 报名人数上限（f8）。默认 200。 */
  maxCount?: number;
  /** 附带图片（可选）。 */
  image?: SendGroupSignupImage;
}

/** 报名方式：直接报名（默认）。 */
export const SIGNUP_METHOD_DIRECT = 1;
/** 报名方式：上传图片。 */
export const SIGNUP_METHOD_IMAGE = 2;
/** f10 的固定值（实测恒为 200）。 */
export const SIGNUP_FIELD10_DEFAULT = 200;
/** 报名人数上限默认值。 */
export const SIGNUP_MAX_COUNT_DEFAULT = 200;

export namespace SendGroupSignup {
  /** SSO 命令 OidbSvcTrpcTcp.0x921b_0。 */
  export const command = 0x921b;
  export const subCommand = 0;
  export const reqSchema = SIGNUP_BODY;
  export const respSchema = SIGNUP_RESP;

  export type Params = SendGroupSignupParams;

  export const serialize = (p: SendGroupSignupParams): Record<string, unknown> => {
    if (!Number.isSafeInteger(p.groupCode) || p.groupCode <= 0) {
      throw new Error(`groupCode 必须是正整数，收到 ${String(p.groupCode)}`);
    }
    if (!p.title) throw new Error('title（标题）不能为空');
    if (!p.detail) throw new Error('detail（详情）不能为空');
    const method = p.method ?? SIGNUP_METHOD_DIRECT;
    if (method !== SIGNUP_METHOD_DIRECT && method !== SIGNUP_METHOD_IMAGE) {
      throw new Error(`method 只能是 1（直接报名）或 2（上传图片），收到 ${String(method)}`);
    }
    const maxCount = p.maxCount ?? SIGNUP_MAX_COUNT_DEFAULT;
    if (!Number.isSafeInteger(maxCount) || maxCount <= 0) {
      throw new Error(`maxCount 必须是正整数，收到 ${String(maxCount)}`);
    }
    if (p.image && (!p.image.url || !p.image.md5)) {
      throw new Error('image 需要同时提供 url 与 md5');
    }
    return {
      request: {
        field1: {},
        groupCode: p.groupCode,
        title: p.title,
        detail: p.detail,
        field5: 0,
        ...(p.deadline && p.deadline > 0 ? { deadline: p.deadline } : {}),
        ...(p.image
          ? {
              image: {
                width: p.image.width,
                height: p.image.height,
                url: p.image.url,
                md5: p.image.md5,
              },
            }
          : {}),
        maxCount,
        signupMethod: method,
        field10: SIGNUP_FIELD10_DEFAULT,
        field11: 0,
        field12: 0,
        extra: { field1: 0, field2: '', field3: '' },
        field14: 0,
        field15: 0,
        field16: 0,
      },
      field12: 1,
    };
  };

  /**
   * 成功 ack 无字段可解（回包结构尚未抓到）。
   *
   * 注意：**失败不会走到这里** —— 服务端拒绝时 native 的 `run_oidb_ex` 会在
   * `reply.status != 0` 处直接抛错（原始 body 被丢），所以不存在「解出空对象就当成功」
   * 的静默路径。见文件头注释与 docs/develop/group-signup.md。
   */
  export const deserialize = (_body: Record<string, unknown>): void => {};

  /** 发一条群报名卡片。需要已注入的在线 QQ 进程。 */
  export const invoke = (
    nt: OidbNative,
    pid: number,
    params: SendGroupSignupParams,
  ): Promise<void> =>
    invokeOidb(nt, pid, SendGroupSignup as OidbSpec<SendGroupSignupParams, void>, params);
}
