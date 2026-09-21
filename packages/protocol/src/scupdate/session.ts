// scupdate 请求的公共部分:客户端身份(comm)与响应状态检查。
//
// SyncVCR 与 GetUrl 共用同一个 SSO 命令和同一份 comm,所以抽出来避免两处各拼一遍。

import {
  APP_ID_PC_QQ,
  FROM_PC_DRESS,
  OSVER_PC_WINDOWS,
  PLAT_ANDROID_QQ,
  PLAT_PC_QQ,
  QVER_ANDROID,
} from './schemas';

const UTF8 = new TextEncoder();
const UTF8_DECODE = new TextDecoder();

/**
 * 随包上报的客户端身份。字段全部可选,缺的按 {@link PC_QQ_CLIENT} 的形状补。
 *
 * 装扮虽然是移动端功能,但桌面 NTQQ 自己也发这套包(`plat=111`),服务端两种平台号
 * 都受理、返回完全一致(2026-09-21 实测),所以 WeQ 直接以桌面端身份发,不再伪装成手Q。
 * 想要手Q 形状就整套传 {@link ANDROID_QQ_CLIENT}。
 */
export interface ScUpdateClient {
  /** 平台号:{@link PLAT_PC_QQ} 或 {@link PLAT_ANDROID_QQ}。 */
  plat?: number;
  /** 客户端版本字符串。PC 端留空串,手Q 传 apk 内硬编码的版本。 */
  qver?: string;
  /** 系统版本。安卓侧传 `Build.VERSION.SDK_INT`,PC 端留空串。 */
  osrelease?: string;
  /** 网络类型,1 = WIFI。 */
  network?: number;
  /** 调用来源标记,仅用于服务端埋点。 */
  from?: string;
  /** 持久游标。PC 端每次都带(抓包值 1.44e12 量级,看着像账号/安装态的时间基准)。 */
  cookie?: number | string;
  /** 业务 appid。PC 端填 {@link APP_ID_PC_QQ}。 */
  appid?: number;
  /** 账号 uid。PC 端填 0 —— 鉴权靠 SSO 登录态,不看这个字段。 */
  uid?: number | string;
  /** 强制刷新标记。PC 端填 1,手Q 填 2。 */
  force?: number;
  /** PC 独有的系统版本字段(comm tag 10),如 {@link OSVER_PC_WINDOWS};留空则不出现。 */
  osver?: string;
}

/**
 * 桌面 NTQQ 的身份 —— WeQ 的默认。取自 2026-09-21 的真实抓包。
 *
 * `cookie` 故意不写死:真机上那是客户端自己维护的状态(与 SyncVCR 的 seq 同源、每次
 * 递增),编一个常量毫无意义,而服务端并不校验(实测不带也完全正常)。
 */
export const PC_QQ_CLIENT: ScUpdateClient = {
  plat: PLAT_PC_QQ,
  qver: '',
  osrelease: '',
  network: 1,
  from: FROM_PC_DRESS,
  appid: APP_ID_PC_QQ,
  uid: 0,
  force: 1,
  osver: OSVER_PC_WINDOWS,
};

/**
 * 手Q(Android)身份。只留给批量抓取脚本复现历史行为 —— 资源与 PC 身份无关,
 * 日常链路一律走 PC。
 */
export const ANDROID_QQ_CLIENT: ScUpdateClient = {
  plat: PLAT_ANDROID_QQ,
  qver: QVER_ANDROID,
  osrelease: '33',
  network: 1,
  from: 'WeQ',
  force: 2,
};

/** 组装 `SCUpdateReqComm`。`client` 即完整身份,字段缺省按 PC 形状补。 */
export function buildReqComm(client: ScUpdateClient = PC_QQ_CLIENT): Record<string, unknown> {
  return {
    plat: client.plat ?? PLAT_PC_QQ,
    qver: UTF8.encode(client.qver ?? ''),
    osrelease: UTF8.encode(client.osrelease ?? ''),
    network: client.network ?? 1,
    from: UTF8.encode(client.from ?? FROM_PC_DRESS),
    ...(client.cookie !== undefined ? { cookie: client.cookie } : {}),
    ...(client.appid !== undefined ? { appid: client.appid } : {}),
    ...(client.uid !== undefined ? { uid: client.uid } : {}),
    force: client.force ?? 1,
    // osver 与 ext 成对出现(PC 抓包里 ext 恒为空串),没有 osver 就两个都不发。
    ...(client.osver !== undefined
      ? { osver: UTF8.encode(client.osver), ext: new Uint8Array(0) }
      : {}),
  };
}

/** 服务端返回的业务层状态。 */
export interface ScUpdateStatus {
  ret: number;
  msg: string;
  /** 服务端建议的下次轮询间隔(秒)。 */
  polltime: number;
}

export class ScUpdateError extends Error {
  constructor(
    readonly ret: number,
    readonly serverMsg: string,
  ) {
    super(`scupdate 业务层拒绝: ret=${ret} msg="${serverMsg}"`);
    this.name = 'ScUpdateError';
  }
}

/**
 * 读出 `SCUpdateRsp` 的业务层状态,`ret != 0` 时抛 {@link ScUpdateError}。
 * 正常时服务端回 `ret=0` / `msg="操作成功"`。
 */
export function readRspStatus(rsp: Record<string, unknown>): ScUpdateStatus {
  const ret = Number(rsp.ret ?? 0);
  const msgBytes = rsp.msg as Uint8Array | undefined;
  const msg = msgBytes?.length ? UTF8_DECODE.decode(msgBytes) : '';
  if (ret !== 0) throw new ScUpdateError(ret, msg);

  const comm = rsp.comm as Record<string, unknown> | undefined;
  return { ret, msg, polltime: Number(comm?.polltime ?? 0) };
}
