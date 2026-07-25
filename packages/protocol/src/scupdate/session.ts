// scupdate 请求的公共部分:客户端标识(comm)与响应状态检查。
//
// SyncVCR 与 GetUrl 共用同一个 SSO 命令和同一份 comm,所以抽出来避免两处各拼一遍。

import { PLAT_ANDROID_QQ, QVER_ANDROID } from './schemas';

const UTF8 = new TextEncoder();
const UTF8_DECODE = new TextDecoder();

/**
 * 随包上报的客户端身份。
 *
 * 默认全部伪装成 Android 手Q —— 个性装扮是移动端功能,`plat` 必须是 109,桌面端
 * 平台号不被 scupdate 后端受理。实测服务端不校验发起端真实平台,照抄即可。
 */
export interface ScUpdateClient {
  /** 平台号,默认 109(Android QQ)。 */
  plat?: number;
  /** 客户端版本,默认 `8.8.17.5770`。 */
  qver?: string;
  /** 系统版本,安卓侧传的是 `Build.VERSION.SDK_INT`。 */
  osrelease?: string;
  /** 网络类型,1 = WIFI。 */
  network?: number;
  /** 调用来源标记,仅用于服务端埋点。 */
  from?: string;
}

/** 组装 `SCUpdateReqComm`。 */
export function buildReqComm(client: ScUpdateClient = {}): Record<string, unknown> {
  return {
    plat: client.plat ?? PLAT_ANDROID_QQ,
    qver: UTF8.encode(client.qver ?? QVER_ANDROID),
    osrelease: UTF8.encode(client.osrelease ?? '33'),
    network: client.network ?? 1,
    from: UTF8.encode(client.from ?? 'WeQ'),
    // 手Q 在请求未显式指定时填 2。
    force: 2,
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
