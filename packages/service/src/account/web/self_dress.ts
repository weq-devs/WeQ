/**
 * 自己的全部装扮 — `zb.vip.qq.com/trpc-proxy/.../GetNewStyleAppUsing`.
 *
 * 与 {@link ./friend_dress} 的区别:好友装扮走 SSR 页面,服务器对气泡(2)/字体(5)/
 * 头像(23) 只回默认款(要客户端带 id 才解析得出对方真值),所以那三类查他人拿不到。
 * 这个端点不带 targetUin —— 按 cookie 认人,只能查自己,但**气泡和字体是真值**。
 *
 * Auth: `uin/p_uin/p_skey` cookie(vip.qq.com 域)+ `g_tk = bkn(p_skey)`。
 * 请求/响应都是 JSON(不是 urlencoded),故手写 fetch 而非复用 webRequestJson。
 */

import { computeBkn, cookieHeader, type WebCredential } from './credential';
import { dressKind } from './dress_kind';

/** 一个「自己正在用」的装扮项。 */
export interface SelfDressItem {
  /** 装扮业务 id(QQ 会员的 appId,决定类别)。 */
  appId: number;
  /** 人类可读类别。 */
  kind: string;
  /** 装扮 id。 */
  itemId: number;
  /** 装扮名。 */
  name: string;
  /** 预览图 url。 */
  previewUrl: string;
}

export interface SelfDress {
  /** 查询用的账号(即本账号)。 */
  uin: string;
  /** 正在用的装扮项(已剔除空桶)。 */
  items: SelfDressItem[];
}

const ENDPOINT =
  'https://zb.vip.qq.com/trpc-proxy/qqva/qc_userinfo_server/QcUserinfoServer/GetNewStyleAppUsing';

/** 照 HAR 请求的 appId 集合 —— 服务端按这个列表分桶返回。 */
const QUERY_APP_IDS = [3, 2, 4, 8, 5, 15, 23, 26, 37, 17, 22, 352, 20];

/** 手 Q Android 的 UA(照 HAR;这个端点认 Dalvik UA,不是 webview UA)。 */
const DRESS_UA =
  'Dalvik/2.1.0 (Linux; U; Android 13; 2109119BC Build/TKQ1.221114.001) V1_AND_SQ_9.3.25_15220_YYB_D QQ/9.3.25.38950 NetType/4G WebP/0.4.1 AppId/537375289';

interface RawUsingItem {
  appId?: number;
  itemId?: number;
  name?: string;
  img?: string;
}

interface RawResponse {
  response?: { apps?: Record<string, { appId?: number; usingItems?: RawUsingItem[] }> };
  retCode?: number;
  error?: { code?: number; message?: string };
}

/**
 * 查本账号正在用的全部装扮(含好友装扮页拿不到的气泡/字体)。
 *
 * 注意桶 key 与项内 appId 可能不同:界面字体(305)混在 `apps["5"]` 桶里返回,
 * 故一律以项内 `appId` 为准。
 */
export async function getSelfDress(cred: WebCredential): Promise<SelfDress> {
  const res = await fetch(`${ENDPOINT}?g_tk=${computeBkn(cred.pskey)}`, {
    method: 'POST',
    headers: {
      Cookie: cookieHeader(cred),
      'Content-Type': 'application/json',
      'User-Agent': DRESS_UA,
      Referer: 'https://zb.vip.qq.com/kuikly/category/3760',
    },
    body: JSON.stringify({
      req: { appIds: QUERY_APP_IDS, loginInfo: { opplat: 2, qqVer: '9.3.25' } },
      options: {
        context: { businessType: 'qqgxh' },
        naming: { namespace: 'Production', env: 'formal' },
      },
    }),
  });
  if (!res.ok) {
    throw new Error(`self dress cgi ${res.status} ${res.statusText}`);
  }

  const data = (await res.json()) as RawResponse;
  if (data.retCode !== 0) {
    throw new Error(`self dress retCode=${data.retCode} ${data.error?.message ?? ''}`.trim());
  }

  const items: SelfDressItem[] = [];
  for (const bucket of Object.values(data.response?.apps ?? {})) {
    for (const r of bucket.usingItems ?? []) {
      const appId = r.appId ?? bucket.appId ?? 0;
      items.push({
        appId,
        kind: dressKind(appId),
        itemId: r.itemId ?? 0,
        name: r.name ?? '',
        previewUrl: r.img ?? '',
      });
    }
  }

  return { uin: cred.uin, items };
}
