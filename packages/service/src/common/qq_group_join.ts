/**
 * QQ 群「分享码 → authKey → 深链接」转换工具。
 *
 * 加群链路里会出现三种表示，本模块是它们之间**唯一**的转换口，避免各处各写一遍：
 *
 *   1. 分享短链   `https://qm.qq.com/q/<code>`
 *        → 302 到 `https://qun.qq.com/universal-share/share?ac=1&authKey=…&busi_data=…`
 *        其中 `busi_data` = base64(JSON{groupCode, token, uin})，`authKey` 是配套鉴权串。
 *   2. 深链接     `tencent://groupwpa/?subcmd=all&param=<hex(JSON)>`
 *        `param` = hex(JSON{groupUin, timeStamp, authKey, auth})。由 QQ 客户端解析后
 *        直接拉起加群页 —— 用户不在群里、也不想走 WeQ 发包时的兜底入口。
 *   3. 入群申请   OIDB 0x11ec_1 的 f5 `authKey`。**就是上面那个 authKey**：
 *        64 个 ASCII 字符的 base64（解出 48 字节），服务端按值校验，无效值会把流程
 *        降级成短信安全验证（见 `@weq/protocol` 的 SendGroupJoinRequest）。
 *
 * 抓包样例（2026-10-15，群 1090396070）：
 *   param = 7B2267726F757055696E223A…2261757468223A22227D
 *          → {"groupUin":"1090396070","timeStamp":1780106550742,
 *             "authKey":"7TfVVhoZbcEMDbtVEYqhs3yX8ZO7L3zhHj4YDClvclWJ+tM2OPiblA+VUwKmZLcq",
 *             "auth":""}
 *
 * 全模块**零依赖、不用 Buffer**（TextEncoder / Uint8Array 实现 hex + base64），
 * 所以主进程与渲染层都能直接引 —— 走 `@weq/service/qq-group-join` 子路径导出。
 * 只有 {@link resolveGroupShareAuthKey} 走网络（纯 HTTP 读 302，不需要 QQ 凭据、
 * 也不需要账号登录），其余全是纯函数，可离线单测。
 */

/** `tencent://groupwpa/` 的固定子命令（加群页）。 */
export const GROUP_WPA_SUBCMD = 'all';

/** 深链接 `param` 解出来的 JSON 结构（字段名与 QQ 客户端逐字对齐）。 */
export interface GroupWpaParam {
  /** 群号（十进制字符串）。 */
  groupUin: string;
  /** 毫秒时间戳。 */
  timeStamp: number;
  /** 分享码换来的鉴权串（64 字符 base64）。 */
  authKey: string;
  /** 附加鉴权字段，实测恒为空串。 */
  auth: string;
}

/** 分享短链 302 后 `Location` 里解析出来的目标。 */
export interface GroupShareTarget {
  /** 群号（十进制字符串）。 */
  groupCode: string;
  /** 入群鉴权串（64 字符 base64），即深链接 / 入群申请要的那个。 */
  authKey: string;
  /** 分享者的 QQ 号。 */
  uin: string;
  /** 分享 token（QQ 客户端侧校验用，WeQ 不消费）。 */
  token: string;
  /** 分享类型，实测恒为 `5`。 */
  svctype: string;
  /** 页面模板 id，实测恒为 `h5_group_info`。 */
  tempid: string;
}

/** UTF-8 文本 → 大写 hex（QQ 客户端自己拼的 `param` 就是大写，抓包逐字对齐）。 */
function utf8ToHex(text: string): string {
  const bytes = new TextEncoder().encode(text);
  let out = '';
  for (const byte of bytes) out += byte.toString(16).padStart(2, '0');
  return out.toUpperCase();
}

/** hex → UTF-8 文本。奇数长度 / 含非 hex 字符时抛错。 */
function hexToUtf8(hex: string): string {
  const clean = hex.trim();
  if (clean.length === 0 || clean.length % 2 !== 0 || !/^[0-9a-fA-F]+$/.test(clean)) {
    throw new Error(`不是合法的十六进制串：${hex.slice(0, 40)}…`);
  }
  const bytes = new Uint8Array(clean.length / 2);
  for (let i = 0; i < bytes.length; i++) {
    bytes[i] = Number.parseInt(clean.slice(i * 2, i * 2 + 2), 16);
  }
  return new TextDecoder().decode(bytes);
}

/** base64 / base64url → UTF-8 文本（容错：去空白、补 `=`、归一化 urlsafe 字符）。 */
export function decodeBase64Utf8(value: string): string {
  const normalized = value.trim().replace(/\s+/g, '').replace(/-/g, '+').replace(/_/g, '/');
  const padded = normalized + '='.repeat((4 - (normalized.length % 4)) % 4);
  // atob / TextDecoder 在 Node 22 与浏览器里都在（Node 16+ 起 atob 是全局的）。
  const binary = atob(padded);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return new TextDecoder().decode(bytes);
}

/** 把 `param` 的 JSON 结构编成十六进制串（深链接要的那一段）。 */
export function encodeGroupWpaParam(param: GroupWpaParam): string {
  const json = JSON.stringify({
    groupUin: String(param.groupUin),
    timeStamp: param.timeStamp,
    authKey: param.authKey,
    auth: param.auth ?? '',
  });
  return utf8ToHex(json);
}

/** {@link encodeGroupWpaParam} 的逆运算；结构不对时抛错。 */
export function decodeGroupWpaParam(hex: string): GroupWpaParam {
  let raw: unknown;
  try {
    raw = JSON.parse(hexToUtf8(hex));
  } catch (error) {
    throw new Error(
      `param 不是合法的 hex(JSON)：${error instanceof Error ? error.message : String(error)}`,
    );
  }
  if (!raw || typeof raw !== 'object') throw new Error('param 解析结果不是对象');
  const item = raw as Partial<GroupWpaParam>;
  if (typeof item.groupUin !== 'string' || item.groupUin === '') {
    throw new Error('param 缺少 groupUin');
  }
  if (typeof item.authKey !== 'string' || item.authKey === '') {
    throw new Error('param 缺少 authKey');
  }
  return {
    groupUin: item.groupUin,
    timeStamp: Number(item.timeStamp ?? 0),
    authKey: item.authKey,
    auth: item.auth ?? '',
  };
}

/**
 * 构造 `tencent://groupwpa/` 深链接。`timeStamp` 缺省取当前毫秒 —— 它是签发时刻，
 * 抄抓包里的旧值会失效，所以调用方通常不用传。
 */
export function buildGroupWpaDeepLink(input: {
  /** 群号，十进制串或数字。 */
  groupUin: string | number;
  /** 分享码换来的 authKey。 */
  authKey: string;
  /** 毫秒时间戳；缺省 = 现在。 */
  timeStamp?: number;
  /** 附加鉴权字段；缺省空串（与抓包一致）。 */
  auth?: string;
}): string {
  const groupUin = String(input.groupUin).trim();
  if (!/^\d+$/.test(groupUin)) throw new Error(`groupUin 必须是纯数字群号：${groupUin}`);
  if (!input.authKey) throw new Error('authKey 不能为空');
  const param = encodeGroupWpaParam({
    groupUin,
    timeStamp: input.timeStamp ?? Date.now(),
    authKey: input.authKey,
    auth: input.auth ?? '',
  });
  return `tencent://groupwpa/?subcmd=${GROUP_WPA_SUBCMD}&param=${param}`;
}

/**
 * 解析分享页 URL（302 的 `Location`，或直接就是 `qun.qq.com/universal-share/share`）
 * → {@link GroupShareTarget}。不是 QQ 群分享页时返回 `null`。
 *
 * 注意 `authKey` 在 query 里是**百分号编码**的（base64 里的 `+` / `/` / `=` 会被转义），
 * 这里用 `URLSearchParams` 取值，它已经帮我们解过码。
 */
export function parseGroupShareLocation(location: string): GroupShareTarget | null {
  let url: URL;
  try {
    url = new URL(location.trim());
  } catch {
    return null;
  }
  const authKey = url.searchParams.get('authKey') ?? '';
  const busiData = url.searchParams.get('busi_data') ?? '';
  if (!authKey || !busiData) return null;

  let payload: unknown;
  try {
    payload = JSON.parse(decodeBase64Utf8(busiData));
  } catch {
    return null;
  }
  if (!payload || typeof payload !== 'object') return null;
  const item = payload as { groupCode?: unknown; token?: unknown; uin?: unknown };
  const groupCode = String(item.groupCode ?? '').trim();
  if (!/^\d+$/.test(groupCode)) return null;

  return {
    groupCode,
    authKey,
    uin: String(item.uin ?? ''),
    token: String(item.token ?? ''),
    svctype: url.searchParams.get('svctype') ?? '',
    tempid: url.searchParams.get('tempid') ?? '',
  };
}

/** {@link resolveGroupShareAuthKey} 的依赖注入口（单测传假的 fetch）。 */
export interface GroupShareResolveOptions {
  /** 覆盖 fetch 实现（单测用）。 */
  fetchImpl?: typeof fetch;
  /** 请求超时（毫秒），缺省 10s。 */
  timeoutMs?: number;
  /** 外部取消信号（与超时叠加）。 */
  signal?: AbortSignal;
}

/** 拼接超时与外部取消信号（两者都在时任一触发即中止）。 */
function withTimeout(timeoutMs: number, external?: AbortSignal): AbortSignal {
  const timeout = AbortSignal.timeout(timeoutMs);
  return external ? AbortSignal.any([timeout, external]) : timeout;
}

/**
 * 分享短链 → authKey。**只读一次 HTTP 302**：拿到的 `authKey` 既能发入群申请
 * （OIDB 0x11ec_1），也能拼 `tencent://groupwpa/` 深链接。
 *
 * 手动跟 redirect（`redirect: 'manual'`）是刻意的：Node 的 fetch 会把 302 原样返回
 * 并暴露 `Location`，这样才能顺手把 `busi_data`（群号 / 分享者）一起解出来。若目标
 * 直接返回 2xx（短链已展开 / 站点变更），退回解析 `response.url`。
 *
 * `authKey` 与分享者绑定且有实效，**不要缓存**：每次加群都重新换一次。
 */
export async function resolveGroupShareAuthKey(
  shareUrl: string,
  options: GroupShareResolveOptions = {},
): Promise<GroupShareTarget> {
  const fetchImpl = options.fetchImpl ?? fetch;
  const response = await fetchImpl(shareUrl, {
    redirect: 'manual',
    signal: withTimeout(options.timeoutMs ?? 10_000, options.signal),
    headers: { 'user-agent': 'Mozilla/5.0 (WeQ)' },
  });

  const location = response.headers.get('location');
  const target = location ? parseGroupShareLocation(location) : null;
  if (target) return target;

  const byFinalUrl = parseGroupShareLocation(response.url);
  if (byFinalUrl) return byFinalUrl;

  throw new Error(
    `分享链接里没有解析出 authKey（HTTP ${response.status}）：${location ?? response.url}`,
  );
}
