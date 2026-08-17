// 登录流程结束后顺带取 p_skey —— quick / qr 两条 loader 共用。
//
// session.init + startNT 之后 TipOffService 才可用；调用方需要先等 otel 就绪
// （或至少等到 startNT 返回）再进来，否则 getPskey 会打在半初始化的 session 上。
//
// 拿不到不是致命错误：dbkey 才是登录流程的主产物，pskey 只是顺路收的（vip.qq.com
// 用来查个性装扮）。所以这里从不抛异常，一律以 { success:false, error } 返回。

import type { NodeIQQNTWrapperSessionInstance } from './wrapper-types';

/** 首页装扮走 zb.vip.qq.com，故默认只要这一个域。 */
export const DEFAULT_PSKEY_DOMAINS = ['vip.qq.com'];

export interface PskeyResult {
    success: boolean;
    /** 域 → p_skey。success 为 true 时非空。 */
    pskey?: Record<string, string>;
    error?: string;
}

/**
 * 取指定域的 p_skey。`nocache=true` 强制向服务器要新的，避免拿到过期票据。
 */
export async function collectPskey(
    session: NodeIQQNTWrapperSessionInstance,
    domains: string[] = DEFAULT_PSKEY_DOMAINS,
): Promise<PskeyResult> {
    try {
        const ck = await session.getTipOffService().getPskey(domains, true);
        if (!ck.domainPskeyMap) {
            return { success: false, error: 'getPskey 没有返回 domainPskeyMap' };
        }
        const pskey = Object.fromEntries(ck.domainPskeyMap);
        if (Object.keys(pskey).length === 0) {
            return { success: false, error: 'domainPskeyMap 为空' };
        }
        return { success: true, pskey };
    } catch (e) {
        return { success: false, error: String(e) };
    }
}
